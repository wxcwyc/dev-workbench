import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { defineAdapter, createTraceEvent, decodeNdjson, encodeNdjson } from "../packages/adapter-sdk/src/index.js";
import {
  EVENT_TYPES,
  PROTOCOL_VERSION,
  STEP_STATUSES,
  ProtocolValidationError,
  assertAnnotation,
  assertAttempt,
  assertCheckpointIdentity,
  assertFileManifest,
  assertPlanInput,
  assertSessionInput,
  assertWorkspace
} from "../packages/protocol/src/index.js";

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

test("recoverable migration constants retain existing values and expose lifecycle additions", () => {
  for (const status of ["pending", "running", "awaiting_review", "completed", "failed", "skipped", "cancelled"]) {
    assert.ok(STEP_STATUSES.includes(status), status);
  }
  for (const eventType of [
    "session.created", "plan.updated", "step.started", "step.completed", "step.failed",
    "step.awaiting_review", "step.review.accepted", "step.review.rejected", "cursor.moved",
    "annotation.added", "workspace.prepared", "checkpoint.created", "workspace.restored",
    "step.cancelled"
  ]) {
    assert.ok(EVENT_TYPES.includes(eventType), eventType);
  }
});

test("snapshot schema documents canonical runtime fields and legacy aliases", async () => {
  const schema = JSON.parse(await fs.readFile(path.resolve("packages/protocol/schemas/v1/snapshot.schema.json"), "utf8"));

  assert.deepEqual(schema.properties.tree, { type: "array" });
  assert.deepEqual(schema.properties.treeChanges, { type: "array" });
  assert.deepEqual(schema.properties.files, { type: "array", deprecated: true });
  assert.deepEqual(schema.properties.changes, { type: "array", deprecated: true });
});

test("session input schema and validator reject runtime-owned evidence", async () => {
  const schema = JSON.parse(await fs.readFile(path.resolve("packages/protocol/schemas/v1/session.schema.json"), "utf8"));
  assert.equal(schema.properties.workspace, undefined);
  assert.equal(schema.properties.attempts, undefined);
  assert.equal(schema.additionalProperties, false);

  const base = { title: "Migration", workbench: "migration", projectRoot: "/source", steps: [] };
  for (const [key, value] of [["workspace", {}], ["attempts", []]]) {
    assert.throws(
      () => assertSessionInput({ ...base, [key]: value }),
      (error) => error instanceof ProtocolValidationError
        && error.documentType === "session"
        && error.issues.some((item) => item.path === `/${key}` && item.message === "is not allowed")
    );
  }
});

test("checkpoint and workspace validators accept separated source and execution identity", () => {
  const baseline = {
    oid: "a".repeat(40),
    ref: "refs/dev-workbench/checkpoints/session-1/attempt-1/baseline"
  };
  const workspace = {
    projectRoot: "/source/repository/app",
    repositoryRoot: "/source/repository",
    projectRelativePath: "app",
    commonGitDir: "/source/repository/.git",
    worktreeRoot: "/managed/session-1",
    executionRoot: "/managed/session-1/app",
    baseOid: "b".repeat(64),
    ownershipToken: "owner-1",
    currentCheckpointId: "attempt-1"
  };

  assert.equal(assertCheckpointIdentity(baseline), baseline);
  assert.equal(assertWorkspace(workspace), workspace);
});

test("checkpoint and workspace validators reject unsafe identities at precise paths", () => {
  const checkpointCases = [
    [{ oid: "abc", ref: "refs/dev-workbench/checkpoints/s/a/baseline" }, "/oid"],
    [{ oid: "a".repeat(40), ref: "refs/heads/main" }, "/ref"],
    [{ oid: "a".repeat(40), ref: "refs/dev-workbench/checkpoints/s/../baseline" }, "/ref"],
    [{ oid: "a".repeat(40), ref: "refs/dev-workbench/checkpoints/s/a/baseline", extra: true }, "/extra"]
  ];
  for (const [value, expectedPath] of checkpointCases) {
    assert.throws(
      () => assertCheckpointIdentity(value),
      (error) => error instanceof ProtocolValidationError
        && error.documentType === "checkpoint identity"
        && error.issues.some((item) => item.path === expectedPath)
    );
  }

  const valid = {
    projectRoot: "/source/repository/app",
    repositoryRoot: "/source/repository",
    projectRelativePath: "app",
    commonGitDir: "/source/repository/.git",
    worktreeRoot: "/managed/session-1",
    executionRoot: "/managed/session-1/app",
    baseOid: "a".repeat(40),
    ownershipToken: "owner-1"
  };
  const workspaceCases = [
    [{ ...valid, projectRelativePath: "../app" }, "/projectRelativePath"],
    [{ ...valid, executionRoot: "relative/app" }, "/executionRoot"],
    [{ ...valid, executionRoot: valid.projectRoot }, "/executionRoot"],
    [{ ...valid, worktreeRoot: valid.repositoryRoot }, "/worktreeRoot"],
    [{ ...valid, surprise: true }, "/surprise"]
  ];
  for (const [value, expectedPath] of workspaceCases) {
    assert.throws(
      () => assertWorkspace(value),
      (error) => error instanceof ProtocolValidationError
        && error.documentType === "workspace"
        && error.issues.some((item) => item.path === expectedPath)
    );
  }
});

test("attempt and file manifest validators accept bounded immutable evidence", () => {
  const files = [{
    path: "src/app.js",
    oldPath: null,
    status: "modified",
    binary: false,
    additions: 8,
    deletions: 3
  }];
  const attempt = {
    id: "attempt-1",
    stepIndex: 1,
    attempt: 2,
    status: "failed",
    startedAt: "2026-07-30T08:00:00.000Z",
    completedAt: "2026-07-30T08:00:03.000Z",
    baseline: {
      oid: "a".repeat(40),
      ref: "refs/dev-workbench/checkpoints/session-1/attempt-1/baseline"
    },
    result: {
      oid: "b".repeat(40),
      ref: "refs/dev-workbench/checkpoints/session-1/attempt-1/result",
      restorable: false
    },
    snapshot: { files, command: {} }
  };

  assert.equal(assertFileManifest(files), files);
  assert.equal(assertAttempt(attempt), attempt);
});

test("attempt and file manifest validators reject unknown, unsafe, and oversized evidence", () => {
  const validFile = {
    path: "src/app.js",
    oldPath: null,
    status: "modified",
    binary: false,
    additions: 1,
    deletions: 0
  };
  const invalidManifests = [
    [[{ ...validFile, path: "../secret" }], "/0/path"],
    [[{ ...validFile, status: "unknown" }], "/0/status"],
    [[{ ...validFile, additions: -1 }], "/0/additions"],
    [[{ ...validFile, extra: true }], "/0/extra"],
    [Array.from({ length: 1001 }, () => validFile), "/"]
  ];
  for (const [value, expectedPath] of invalidManifests) {
    assert.throws(
      () => assertFileManifest(value),
      (error) => error instanceof ProtocolValidationError
        && error.documentType === "file manifest"
        && error.issues.some((item) => item.path === expectedPath)
    );
  }

  const base = {
    id: "attempt-1",
    stepIndex: 0,
    attempt: 1,
    status: "running",
    startedAt: "2026-07-30T08:00:00.000Z",
    baseline: {
      oid: "a".repeat(40),
      ref: "refs/dev-workbench/checkpoints/session-1/attempt-1/baseline"
    }
  };
  const invalidAttempts = [
    [{ ...base, stepIndex: -1 }, "/stepIndex"],
    [{ ...base, attempt: 0 }, "/attempt"],
    [{ ...base, status: "pending" }, "/status"],
    [{ ...base, completedAt: "yesterday" }, "/completedAt"],
    [{
      ...base,
      baseline: {
        oid: "a".repeat(40),
        ref: "refs/dev-workbench/checkpoints/session-1/attempt-1/result"
      }
    }, "/baseline/ref"],
    [{
      ...base,
      result: {
        oid: "b".repeat(40),
        ref: "refs/dev-workbench/checkpoints/session-1/attempt-1/baseline",
        restorable: false
      }
    }, "/result/ref"],
    [{ ...base, result: { oid: "b".repeat(40), ref: "refs/heads/main", restorable: false } }, "/result/ref"],
    [{ ...base, extra: true }, "/extra"]
  ];
  for (const [value, expectedPath] of invalidAttempts) {
    assert.throws(
      () => assertAttempt(value),
      (error) => error instanceof ProtocolValidationError
        && error.documentType === "attempt"
        && error.issues.some((item) => item.path === expectedPath)
    );
  }
});

test("expanded annotation validator accepts legacy notes and durable evidence targets", () => {
  const legacy = {
    id: "note-1",
    stepIndex: 0,
    text: "Keep this",
    createdAt: "2026-07-30T08:05:00.000Z"
  };
  const annotations = [
    legacy,
    { ...legacy, kind: "note", tags: ["content", "migration"] },
    {
      ...legacy,
      attemptId: "attempt-1",
      kind: "bookmark",
      target: { type: "diff", path: "target/index.html", line: 12 }
    },
    {
      ...legacy,
      attemptId: "attempt-1",
      kind: "bookmark",
      target: { type: "command", stream: "stderr", line: 2 }
    }
  ];

  for (const annotation of annotations) assert.equal(assertAnnotation(annotation), annotation);
});

test("expanded annotation validator rejects unsafe targets, invalid lines, and oversized collections", () => {
  const base = {
    id: "note-1",
    stepIndex: 0,
    text: "Keep this",
    createdAt: "2026-07-30T08:05:00.000Z"
  };
  const cases = [
    [{ ...base, kind: "flag" }, "/kind"],
    [{ ...base, tags: ["same", "same"] }, "/tags/1"],
    [{ ...base, tags: Array.from({ length: 17 }, (_, index) => `tag-${index}`) }, "/tags"],
    [{ ...base, target: { type: "preview", sequence: 2 } }, "/target/type"],
    [{ ...base, target: { type: "diff", path: "../secret" } }, "/target/path"],
    [{ ...base, target: { type: "diff", path: "src/app.js", stream: "stdout" } }, "/target/stream"],
    [{ ...base, target: { type: "command", stream: "stdin" } }, "/target/stream"],
    [{ ...base, target: { type: "command", stream: "stdout", line: 0 } }, "/target/line"],
    [{ ...base, target: { type: "file", path: "src/app.js" } }, "/attemptId"],
    [{ ...base, unknown: true }, "/unknown"]
  ];
  for (const [value, expectedPath] of cases) {
    assert.throws(
      () => assertAnnotation(value),
      (error) => error instanceof ProtocolValidationError
        && error.documentType === "annotation"
        && error.issues.some((item) => item.path === expectedPath)
    );
  }
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
