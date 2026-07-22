import test from "node:test";
import assert from "node:assert/strict";
import { SessionEngine } from "../packages/execution-core/src/session-engine.js";
import { createTraceEvent } from "../packages/adapter-sdk/src/index.js";
import { ProtocolValidationError } from "../packages/protocol/src/index.js";

test("execution session records immutable checkpoints, seeks and annotations", () => {
  const engine = new SessionEngine();
  const session = engine.create({
    title: "Trace",
    workbench: "execution",
    projectRoot: "/tmp/example",
    steps: [
      { title: "First", traceState: { stack: ["query"] } },
      { title: "Second", traceState: { stack: ["rule"] } }
    ]
  });
  engine.startStep(session, 0);
  engine.completeStep(session, 0, { trace: session.steps[0].traceState });
  engine.startStep(session, 1);
  engine.completeStep(session, 1, { trace: session.steps[1].traceState });
  engine.seek(session, 0);
  engine.annotate(session, { stepIndex: 0, text: "The query was created correctly." });

  assert.equal(session.cursor, 0);
  assert.equal(session.status, "completed");
  assert.deepEqual(session.snapshots[1].trace.stack, ["rule"]);
  assert.equal(session.annotations[0].stepIndex, 0);
  assert.equal(session.events.filter((event) => event.type === "step.completed").length, 2);
});

test("migration steps must execute in a valid state", () => {
  const engine = new SessionEngine();
  const session = engine.create({ title: "Migration", workbench: "migration", projectRoot: "/tmp/example", steps: [{ title: "Initialize" }] });
  engine.startStep(session, 0);
  assert.throws(() => engine.startStep(session, 0), /cannot run/);
  engine.failStep(session, 0, new Error("failed command"));
  assert.equal(engine.nextRunnable(session), 0);
});

test("streamed trace events append immutable snapshots in strict sequence", () => {
  const engine = new SessionEngine();
  const session = engine.create({ title: "Live trace", workbench: "execution", projectRoot: "/tmp/example" });
  engine.startTraceStream(session);
  engine.appendTraceEvent(session, createTraceEvent({
    sessionId: session.id, sequence: 0, kind: "branch", title: "Choose rule", state: { goals: ["parent(X, Y)"] }
  }));
  engine.finishTraceStream(session);

  assert.equal(session.status, "completed");
  assert.equal(session.cursor, 0);
  assert.equal(session.steps[0].traceKind, "branch");
  assert.deepEqual(session.snapshots[0].trace.goals, ["parent(X, Y)"]);
  assert.throws(() => engine.appendTraceEvent(session, createTraceEvent({
    sessionId: session.id, sequence: 2, title: "Out of order", state: {}
  })), /Expected trace sequence 1/);
});

test("streaming does not pull the cursor away from an older checkpoint", () => {
  const engine = new SessionEngine();
  const session = engine.create({ title: "Review trace", workbench: "execution", projectRoot: "/tmp/example" });
  for (let sequence = 0; sequence < 2; sequence += 1) {
    engine.appendTraceEvent(session, createTraceEvent({ sessionId: session.id, sequence, title: `Event ${sequence}`, state: { sequence } }));
  }
  engine.seek(session, 0);
  engine.appendTraceEvent(session, createTraceEvent({ sessionId: session.id, sequence: 2, title: "Event 2", state: { sequence: 2 } }));
  assert.equal(session.cursor, 0);
});

test("pristine migration sessions replace and normalize their plan", () => {
  const engine = new SessionEngine();
  const session = engine.create({
    title: "Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    steps: [{ title: "Old step" }]
  });
  session.updatedAt = "2000-01-01T00:00:00.000Z";
  const plan = [{
    id: "custom-step",
    title: "  Install dependency  ",
    description: "  Add the required package.  ",
    action: { command: ["npm", "install", "example"], cwd: "packages/app" },
    expected: { files: ["package.json"] },
    traceState: { phase: "planned" }
  }];
  const eventCount = session.events.length;

  const result = engine.replacePlan(session, plan);

  assert.equal(result.steps[0].title, "Install dependency");
  assert.equal(result.steps[0].description, "Add the required package.");
  assert.deepEqual(result.steps[0].action, plan[0].action);
  assert.deepEqual(result.steps[0].expected, plan[0].expected);
  assert.deepEqual(
    {
      status: result.steps[0].status,
      startedAt: result.steps[0].startedAt,
      completedAt: result.steps[0].completedAt,
      error: result.steps[0].error
    },
    { status: "pending", startedAt: null, completedAt: null, error: null }
  );
  assert.equal(session.status, "ready");
  assert.equal(session.events.length, eventCount + 1);
  assert.deepEqual(
    { type: session.events.at(-1).type, stepCount: session.events.at(-1).stepCount },
    { type: "plan.updated", stepCount: 1 }
  );
  assert.ok(session.updatedAt > "2000-01-01T00:00:00.000Z");

  plan[0].action.command.push("--save-dev");
  plan[0].expected.files.push("package-lock.json");
  assert.deepEqual(session.steps[0].action.command, ["npm", "install", "example"]);
  assert.deepEqual(session.steps[0].expected.files, ["package.json"]);
});

test("pristine migration sessions may replace their plan with no steps", () => {
  const engine = new SessionEngine();
  const session = engine.create({
    title: "Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    steps: [{ title: "Remove me" }]
  });

  const result = engine.replacePlan(session, []);

  assert.deepEqual(result.steps, []);
  assert.equal(session.events.at(-1).type, "plan.updated");
  assert.equal(session.events.at(-1).stepCount, 0);
});

test("plan replacement remains atomic when traceState cannot be cloned", () => {
  const engine = new SessionEngine();
  const session = engine.create({
    title: "Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    steps: [{ title: "Original step" }]
  });
  const before = structuredClone(session);

  assert.throws(
    () => engine.replacePlan(session, [{ title: "Replacement", traceState: { callback() {} } }]),
    /clone/i
  );
  assert.deepEqual(session, before);
});

test("plan replacement remains atomic when the public session cannot be cloned", () => {
  const metadata = { callback() {} };
  const engine = new SessionEngine();
  const session = engine.create({
    title: "Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    metadata,
    steps: [{ title: "Original step" }]
  });
  const steps = session.steps;
  const events = session.events;
  const before = {
    steps: structuredClone(session.steps),
    status: session.status,
    events: structuredClone(session.events),
    updatedAt: session.updatedAt
  };

  assert.throws(() => engine.replacePlan(session, [{ title: "Replacement" }]), /clone/i);
  assert.strictEqual(session.steps, steps);
  assert.deepEqual(session.steps, before.steps);
  assert.equal(session.status, before.status);
  assert.strictEqual(session.events, events);
  assert.deepEqual(session.events, before.events);
  assert.equal(session.updatedAt, before.updatedAt);
  assert.strictEqual(session.metadata, metadata);
});

function assertPlanReplacementRejectedWithoutMutation(session, message) {
  const engine = new SessionEngine();
  const before = structuredClone(session);
  assert.throws(() => engine.replacePlan(session, [{ title: "Replacement" }]), message);
  assert.deepEqual(session, before);
}

test("execution sessions reject plan replacement without mutation", () => {
  const engine = new SessionEngine();
  const session = engine.create({ title: "Trace", workbench: "execution", projectRoot: "/tmp/example" });
  assertPlanReplacementRejectedWithoutMutation(session, /migration/i);
});

test("migration sessions with an advanced cursor reject plan replacement without mutation", () => {
  const engine = new SessionEngine();
  const session = engine.create({ title: "Migration", workbench: "migration", projectRoot: "/tmp/example" });
  session.cursor = 0;
  assertPlanReplacementRejectedWithoutMutation(session, /pristine/i);
});

test("migration sessions with a non-pending step reject plan replacement without mutation", () => {
  const engine = new SessionEngine();
  const session = engine.create({
    title: "Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    steps: [{ title: "Started", status: "completed" }]
  });
  session.steps[0].status = "completed";
  assertPlanReplacementRejectedWithoutMutation(session, /pristine/i);
});

test("migration sessions with snapshots reject plan replacement without mutation", () => {
  const engine = new SessionEngine();
  const session = engine.create({ title: "Migration", workbench: "migration", projectRoot: "/tmp/example" });
  session.snapshots.push({ stepIndex: 0 });
  assertPlanReplacementRejectedWithoutMutation(session, /pristine/i);
});

test("migration sessions with annotations reject plan replacement without mutation", () => {
  const engine = new SessionEngine();
  const session = engine.create({ title: "Migration", workbench: "migration", projectRoot: "/tmp/example" });
  session.annotations.push({ stepIndex: 0, text: "Reviewed" });
  assertPlanReplacementRejectedWithoutMutation(session, /pristine/i);
});

test("malformed replacement steps fail protocol validation at /steps without mutation", () => {
  const engine = new SessionEngine();
  const session = engine.create({ title: "Migration", workbench: "migration", projectRoot: "/tmp/example" });
  const before = structuredClone(session);

  assert.throws(
    () => engine.replacePlan(session, [{ title: "   " }]),
    (error) => error instanceof ProtocolValidationError
      && error.issues.some(({ path }) => path.startsWith("/steps"))
  );
  assert.deepEqual(session, before);
});
