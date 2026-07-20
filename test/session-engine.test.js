import test from "node:test";
import assert from "node:assert/strict";
import { SessionEngine } from "../packages/execution-core/src/session-engine.js";
import { createTraceEvent } from "../packages/adapter-sdk/src/index.js";

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
