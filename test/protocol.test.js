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
    () => assertPlanInput({ steps: [{ title: "   ", action: { command: ["npm", 1] } }] }),
    (error) => error instanceof ProtocolValidationError
      && error.documentType === "plan"
      && error.issues.some((item) => item.path === "/steps/0/title")
      && error.issues.some((item) => item.path === "/steps/0/action/command/1")
  );
  assert.throws(
    () => assertPlanInput({ steps: [], extra: true }),
    (error) => error instanceof ProtocolValidationError
      && error.documentType === "plan"
      && error.issues.some((item) => item.path === "/extra")
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
