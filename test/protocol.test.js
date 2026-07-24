import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { defineAdapter, createTraceEvent, decodeNdjson, encodeNdjson } from "../packages/adapter-sdk/src/index.js";
import { EVENT_TYPES, PROTOCOL_VERSION, ProtocolValidationError, assertPlanInput, assertSessionInput } from "../packages/protocol/src/index.js";

const manifest = {
  id: "dev-workbench.test",
  name: "Test adapter",
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: ["trace"]
};

test("v1 JSON Schemas are parseable and use draft 2020-12", async () => {
  const schemaRoot = path.resolve("packages/protocol/schemas/v1");
  const files = await fs.readdir(schemaRoot);
  assert.deepEqual(files.sort(), [
    "adapter-manifest.schema.json", "artifact.schema.json", "plan.schema.json",
    "session.schema.json", "snapshot.schema.json", "step.schema.json", "trace-event.schema.json"
  ]);
  for (const file of files) {
    const schema = JSON.parse(await fs.readFile(path.join(schemaRoot, file), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.match(schema.$id, /\/v1\//);
  }
});

test("step schema matches the editable plan field contract", async () => {
  const schema = JSON.parse(await fs.readFile(path.resolve("packages/protocol/schemas/v1/step.schema.json"), "utf8"));

  assert.equal(schema.properties.id.pattern, "\\S");
  assert.equal(schema.properties.title.pattern, "\\S");
  assert.equal(schema.properties.description.type, "string");
  assert.deepEqual(schema.properties.risk, {
    type: "string",
    enum: ["low", "medium", "high"]
  });
  assert.deepEqual(schema.properties.dependsOn, {
    type: "array",
    items: { type: "string" },
    uniqueItems: true
  });
  assert.equal(schema.additionalProperties, false);
});

test("plan validation accepts steps and exposes the plan update event", () => {
  const input = {
    steps: [{
      title: "Install dependencies",
      description: "Install the target project's dependencies",
      expected: "Dependencies are installed",
      action: { command: ["npm", "install"], cwd: "." }
    }]
  };

  assert.equal(assertPlanInput(input), input);
  assert.ok(EVENT_TYPES.includes("plan.updated"));
});

test("session and plan validation accept migration step metadata", () => {
  const steps = [
    { id: "prepare-project", title: "Prepare project" },
    {
      id: "install-runtime",
      title: "Install runtime",
      risk: "high",
      dependsOn: ["prepare-project"]
    }
  ];
  const plan = { steps };
  const session = {
    title: "Runtime migration",
    workbench: "migration",
    projectRoot: "/tmp/project",
    steps
  };

  assert.equal(assertPlanInput(plan), plan);
  assert.equal(assertSessionInput(session), session);
});

test("session and plan validation reject invalid migration step metadata at precise paths", () => {
  const cases = [
    {
      name: "unsupported risk",
      steps: [{ id: "prepare", title: "Prepare", risk: "critical" }],
      path: "/steps/0/risk"
    },
    {
      name: "non-array dependencies",
      steps: [{ id: "prepare", title: "Prepare", dependsOn: "setup" }],
      path: "/steps/0/dependsOn"
    },
    {
      name: "non-string dependency",
      steps: [{ id: "prepare", title: "Prepare", dependsOn: [1] }],
      path: "/steps/0/dependsOn/0"
    },
    {
      name: "duplicate step IDs",
      steps: [{ id: "prepare", title: "Prepare" }, { id: "prepare", title: "Prepare again" }],
      path: "/steps/1/id"
    },
    {
      name: "duplicate dependency IDs",
      steps: [
        { id: "prepare", title: "Prepare" },
        { id: "install", title: "Install", dependsOn: ["prepare", "prepare"] }
      ],
      path: "/steps/1/dependsOn/1"
    },
    {
      name: "missing dependency target",
      steps: [
        { id: "prepare", title: "Prepare" },
        { id: "install", title: "Install", dependsOn: ["missing"] }
      ],
      path: "/steps/1/dependsOn/0"
    },
    {
      name: "self-dependency",
      steps: [{ id: "prepare", title: "Prepare", dependsOn: ["prepare"] }],
      path: "/steps/0/dependsOn/0"
    },
    {
      name: "dependency on a later step",
      steps: [
        { id: "prepare", title: "Prepare", dependsOn: ["install"] },
        { id: "install", title: "Install" }
      ],
      path: "/steps/0/dependsOn/0"
    }
  ];
  const validators = [
    ["plan", (steps) => assertPlanInput({ steps })],
    ["session", (steps) => assertSessionInput({
      title: "Runtime migration",
      workbench: "migration",
      projectRoot: "/tmp/project",
      steps
    })]
  ];

  for (const { name, steps, path } of cases) {
    for (const [documentType, validate] of validators) {
      assert.throws(
        () => validate(steps),
        (error) => error instanceof ProtocolValidationError
          && error.documentType === documentType
          && error.issues.some((item) => item.path === path),
        `${documentType}: ${name}`
      );
    }
  }
});

test("ambiguous step IDs report only the duplicate ID root cause", () => {
  const cases = [
    {
      name: "self relationship",
      steps: [
        { id: "a", title: "First" },
        { id: "a", title: "Second", dependsOn: ["a"] }
      ],
      expectedIssues: [{ path: "/steps/1/id", message: "must be unique" }]
    },
    {
      name: "missing relationship from an ambiguous step",
      steps: [
        { id: "a", title: "First" },
        { id: "a", title: "Second", dependsOn: ["missing"] }
      ],
      expectedIssues: [
        { path: "/steps/1/id", message: "must be unique" },
        { path: "/steps/1/dependsOn/0", message: "must reference an existing step" }
      ]
    },
    {
      name: "later relationship from an ambiguous step",
      steps: [
        { id: "a", title: "First" },
        { id: "a", title: "Second", dependsOn: ["later"] },
        { id: "later", title: "Later" }
      ],
      expectedIssues: [
        { path: "/steps/1/id", message: "must be unique" },
        { path: "/steps/1/dependsOn/0", message: "must reference an earlier step" }
      ]
    },
    {
      name: "all duplicate targets are later",
      steps: [
        { id: "source", title: "Source", dependsOn: ["a"] },
        { id: "a", title: "First target" },
        { id: "a", title: "Second target" }
      ],
      expectedIssues: [
        { path: "/steps/2/id", message: "must be unique" },
        { path: "/steps/0/dependsOn/0", message: "must reference an earlier step" }
      ]
    },
    {
      name: "all duplicate targets are earlier",
      steps: [
        { id: "a", title: "First target" },
        { id: "a", title: "Second target" },
        { id: "source", title: "Source", dependsOn: ["a"] }
      ],
      expectedIssues: [{ path: "/steps/1/id", message: "must be unique" }]
    },
    {
      name: "duplicate targets are before and after the source",
      steps: [
        { id: "a", title: "Earlier target" },
        { id: "source", title: "Source", dependsOn: ["a"] },
        { id: "a", title: "Later target" }
      ],
      expectedIssues: [{ path: "/steps/2/id", message: "must be unique" }]
    }
  ];

  for (const { name, steps, expectedIssues } of cases) {
    const validators = [
      ["plan", () => assertPlanInput({ steps })],
      ["session", () => assertSessionInput({
        title: "Runtime migration",
        workbench: "migration",
        projectRoot: "/tmp/project",
        steps
      })]
    ];
    for (const [documentType, validate] of validators) {
      assert.throws(
        validate,
        (error) => error instanceof ProtocolValidationError
          && error.documentType === documentType
          && assert.deepEqual(error.issues, expectedIssues) === undefined,
        `${documentType}: ${name}`
      );
    }
  }
});

test("invalid step IDs do not participate in self-reference checks", () => {
  for (const id of ["", "   "]) {
    const steps = [{ id, title: "Invalid ID", dependsOn: [id] }];
    const expectedIssues = [
      { path: "/steps/0/id", message: "must be a non-empty string" },
      { path: "/steps/0/dependsOn/0", message: "must reference an existing step" }
    ];
    const validators = [
      ["plan", () => assertPlanInput({ steps })],
      ["session", () => assertSessionInput({
        title: "Runtime migration",
        workbench: "migration",
        projectRoot: "/tmp/project",
        steps
      })]
    ];

    for (const [documentType, validate] of validators) {
      assert.throws(
        validate,
        (error) => error instanceof ProtocolValidationError
          && error.documentType === documentType
          && assert.deepEqual(error.issues, expectedIssues) === undefined,
        `${documentType}: ${JSON.stringify(id)}`
      );
    }
  }
});

test("plan validation reports precise JSON pointer paths", () => {
  for (const input of [{}, { steps: null }]) {
    assert.throws(
      () => assertPlanInput(input),
      (error) => error instanceof ProtocolValidationError
        && error.documentType === "plan"
        && error.issues.some((item) => item.path === "/steps")
    );
  }
  assert.throws(
    () => assertPlanInput({ steps: [{ id: "", title: "   ", description: 3, status: "pending", action: { command: ["npm", 1] } }] }),
    (error) => error instanceof ProtocolValidationError
      && error.documentType === "plan"
      && error.issues.some((item) => item.path === "/steps/0/id")
      && error.issues.some((item) => item.path === "/steps/0/title")
      && error.issues.some((item) => item.path === "/steps/0/description")
      && error.issues.some((item) => item.path === "/steps/0/status")
      && error.issues.some((item) => item.path === "/steps/0/action/command/1")
  );
  assert.throws(
    () => assertPlanInput({ steps: [], extra: true }),
    (error) => error instanceof ProtocolValidationError
      && error.documentType === "plan"
      && error.issues.some((item) => item.path === "/extra")
  );
});

test("plan validation escapes additional property JSON pointer segments", () => {
  assert.throws(
    () => assertPlanInput({ steps: [], "a/b": true, "x~y": true }),
    (error) => error instanceof ProtocolValidationError
      && error.documentType === "plan"
      && error.issues.some((item) => item.path === "/a~1b")
      && error.issues.some((item) => item.path === "/x~0y")
  );
});

test("session validation reports precise JSON pointer paths", () => {
  assert.throws(
    () => assertSessionInput({ title: "Import", workbench: "execution", projectRoot: "/tmp", trace: [{ state: null }] }),
    (error) => error instanceof ProtocolValidationError && error.issues.some((item) => item.path === "/trace/0/state")
  );
  assert.throws(
    () => assertSessionInput({ title: "Import", workbench: "execution", projectRoot: "/tmp", steps: [], typo: true }),
    (error) => error.issues.some((item) => item.path === "/typo")
  );
});

test("adapter SDK validates and streams NDJSON trace events", async () => {
  const adapter = defineAdapter(manifest, async function* ({ sessionId }) {
    yield createTraceEvent({ sessionId, sequence: 0, kind: "branch", title: "Choose rule", state: { goals: ["parent(X, Y)"] } });
  });
  const events = [];
  for await (const event of adapter.run({ sessionId: "session-1" })) events.push(event);
  assert.equal(events[0].kind, "branch");

  let output = "";
  for await (const line of encodeNdjson(events)) output += line;
  assert.deepEqual(JSON.parse(output), events[0]);

  const decoded = [];
  const chunks = [Buffer.from(output.slice(0, 17)), Buffer.from(`${output.slice(17)}\n`)];
  for await (const event of decodeNdjson(chunks)) decoded.push(event);
  assert.deepEqual(decoded, events);
});

test("adapter SDK rejects incompatible manifests and malformed events", async () => {
  assert.throws(() => defineAdapter({ ...manifest, protocolVersion: "2.0" }, () => []), /protocolVersion/);
  const adapter = defineAdapter(manifest, () => [{ protocolVersion: PROTOCOL_VERSION, sessionId: "s", sequence: -1 }]);
  await assert.rejects(async () => {
    for await (const ignored of adapter.run({})) void ignored;
  }, /sequence/);
  assert.throws(
    () => createTraceEvent({ sessionId: "s", sequence: 0, title: "Result", state: {}, artifacts: [{ id: "answer", type: "unknown", label: "Answer" }] }),
    /artifact type/
  );
});

test("NDJSON decoder identifies the malformed line after valid events", async () => {
  const valid = createTraceEvent({ sessionId: "s", sequence: 0, title: "Start", state: {} });
  const decoded = [];
  await assert.rejects(async () => {
    for await (const event of decodeNdjson([Buffer.from(`${JSON.stringify(valid)}\n{broken}\n`)])) decoded.push(event);
  }, /line 2/);
  assert.equal(decoded.length, 1);
});
