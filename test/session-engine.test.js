import test from "node:test";
import assert from "node:assert/strict";
import { SessionEngine } from "../packages/execution-core/src/session-engine.js";
import { createTraceEvent } from "../packages/adapter-sdk/src/index.js";
import { EVENT_TYPES, ProtocolValidationError, STEP_STATUSES } from "../packages/protocol/src/index.js";

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

test("failed migration steps retain their command snapshot", () => {
  const engine = new SessionEngine();
  const session = engine.create({
    title: "Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    steps: [{ id: "install", title: "Install dependency" }]
  });
  engine.startStep(session, 0);
  const beforeFailure = new Date().toISOString();

  engine.failStep(session, 0, new Error("command failed"), {
    command: ["npm", "install", "example"],
    cwd: "/tmp/example"
  });

  assert.equal(session.steps[0].status, "failed");
  assert.deepEqual(session.steps[0].error, { name: "Error", message: "command failed" });
  assert.deepEqual(session.snapshots[0].command, ["npm", "install", "example"]);
  assert.equal(session.snapshots[0].stepIndex, 0);
  assert.ok(session.snapshots[0].capturedAt >= beforeFailure);
  assert.equal(session.cursor, 0);
  assert.equal(session.status, "failed");
  assert.equal(session.events.at(-1).type, "step.failed");
});

test("failStep without a snapshot preserves existing snapshots and cursor", () => {
  const engine = new SessionEngine();
  const session = engine.create({
    title: "Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    steps: [{ id: "install", title: "Install dependency" }]
  });
  session.snapshots.push({ command: ["npm", "view", "example"], stepIndex: 0 });
  session.cursor = 0;
  engine.startStep(session, 0);
  const snapshots = session.snapshots;
  const beforeSnapshots = structuredClone(session.snapshots);

  engine.failStep(session, 0, new Error("command failed"));

  assert.equal(session.steps[0].status, "failed");
  assert.deepEqual(session.snapshots, beforeSnapshots);
  assert.strictEqual(session.snapshots, snapshots);
  assert.equal(session.cursor, 0);
  assert.equal(session.events.at(-1).type, "step.failed");
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

test("migration steps receive stable metadata and runtime defaults", () => {
  const engine = new SessionEngine();
  const session = engine.create({
    title: "Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    steps: [{ title: "Generated metadata" }]
  });
  const step = session.steps[0];

  assert.match(step.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(step.risk, "low");
  assert.deepEqual(step.dependsOn, []);
  assert.equal(step.attempt, 0);
});

test("protocol constants expose migration review statuses and events", () => {
  assert.ok(STEP_STATUSES.includes("awaiting_review"));
  assert.ok(EVENT_TYPES.includes("step.awaiting_review"));
  assert.ok(EVENT_TYPES.includes("step.review.accepted"));
  assert.ok(EVENT_TYPES.includes("step.review.rejected"));
});

test("explicit migration metadata survives creation and plan replacement", () => {
  const engine = new SessionEngine();
  const explicit = [
    { id: "prepare", title: "Prepare", risk: "medium", dependsOn: [] },
    { id: "migrate", title: "Migrate", risk: "high", dependsOn: ["prepare"] }
  ];
  const created = engine.create({
    title: "Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    steps: explicit
  });

  assert.deepEqual(
    created.steps.map(({ id, risk, dependsOn, attempt }) => ({ id, risk, dependsOn, attempt })),
    [
      { id: "prepare", risk: "medium", dependsOn: [], attempt: 0 },
      { id: "migrate", risk: "high", dependsOn: ["prepare"], attempt: 0 }
    ]
  );

  const replacement = [
    { id: "inspect", title: "Inspect", risk: "low", dependsOn: [] },
    { id: "apply", title: "Apply", risk: "medium", dependsOn: ["inspect"] }
  ];
  engine.replacePlan(created, replacement);
  replacement[1].dependsOn.push("changed-after-replacement");

  assert.deepEqual(
    created.steps.map(({ id, risk, dependsOn, attempt }) => ({ id, risk, dependsOn, attempt })),
    [
      { id: "inspect", risk: "low", dependsOn: [], attempt: 0 },
      { id: "apply", risk: "medium", dependsOn: ["inspect"], attempt: 0 }
    ]
  );
});

test("migration start enforces dependencies before incrementing attempt", () => {
  const engine = new SessionEngine();
  const session = engine.create({
    title: "Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    steps: [
      { id: "prepare", title: "Prepare" },
      { id: "apply", title: "Apply", dependsOn: ["prepare"] }
    ]
  });
  const before = structuredClone(session);

  assert.throws(() => engine.startStep(session, 1), /depend/i);
  assert.deepEqual(session, before);

  engine.startStep(session, 0);
  assert.equal(session.steps[0].attempt, 1);
  assert.deepEqual(
    {
      type: session.events.at(-1).type,
      stepIndex: session.events.at(-1).stepIndex,
      stepId: session.events.at(-1).stepId,
      attempt: session.events.at(-1).attempt
    },
    { type: "step.started", stepIndex: 0, stepId: "prepare", attempt: 1 }
  );
});

test("migration completion records a snapshot and waits for review", () => {
  const engine = new SessionEngine();
  const session = engine.create({
    title: "Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    steps: [{ id: "apply", title: "Apply" }]
  });

  engine.startStep(session, 0);
  engine.completeStep(session, 0, { files: ["package.json"] });

  assert.equal(session.steps[0].status, "awaiting_review");
  assert.equal(session.status, "awaiting_review");
  assert.equal(session.cursor, 0);
  assert.deepEqual(session.snapshots[0].files, ["package.json"]);
  assert.deepEqual(
    {
      type: session.events.at(-1).type,
      stepIndex: session.events.at(-1).stepIndex,
      stepId: session.events.at(-1).stepId,
      attempt: session.events.at(-1).attempt
    },
    { type: "step.awaiting_review", stepIndex: 0, stepId: "apply", attempt: 1 }
  );
});

test("accepting migration reviews advances readiness and completes the final step", () => {
  const engine = new SessionEngine();
  const session = engine.create({
    title: "Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    steps: [
      { id: "prepare", title: "Prepare" },
      { id: "apply", title: "Apply", dependsOn: ["prepare"] }
    ]
  });

  engine.startStep(session, 0);
  engine.completeStep(session, 0, { files: ["first"] });
  engine.reviewStep(session, 0, "accept");

  assert.equal(session.steps[0].status, "completed");
  assert.equal(session.steps[0].review.decision, "accept");
  assert.equal(session.status, "ready");
  assert.equal(engine.nextRunnable(session), 1);
  assert.deepEqual(
    {
      type: session.events.at(-1).type,
      stepIndex: session.events.at(-1).stepIndex,
      stepId: session.events.at(-1).stepId,
      attempt: session.events.at(-1).attempt
    },
    { type: "step.review.accepted", stepIndex: 0, stepId: "prepare", attempt: 1 }
  );

  engine.startStep(session, 1);
  engine.completeStep(session, 1, { files: ["second"] });
  engine.reviewStep(session, 1, "accept");

  assert.equal(session.steps[1].status, "completed");
  assert.equal(session.status, "completed");
});

test("rejecting a migration review allows a clean retry with a higher attempt", () => {
  const engine = new SessionEngine();
  const session = engine.create({
    title: "Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    steps: [{ id: "apply", title: "Apply" }]
  });

  engine.startStep(session, 0);
  engine.completeStep(session, 0, { revision: 1 });
  engine.reviewStep(session, 0, "reject");

  assert.equal(session.steps[0].status, "failed");
  assert.equal(session.steps[0].review.decision, "reject");
  assert.equal(session.status, "failed");
  assert.equal(engine.nextRunnable(session), 0);
  assert.deepEqual(
    {
      type: session.events.at(-1).type,
      stepIndex: session.events.at(-1).stepIndex,
      stepId: session.events.at(-1).stepId,
      attempt: session.events.at(-1).attempt
    },
    { type: "step.review.rejected", stepIndex: 0, stepId: "apply", attempt: 1 }
  );

  engine.startStep(session, 0);

  assert.equal(session.steps[0].attempt, 2);
  assert.equal(session.steps[0].review, null);
  assert.equal(session.steps[0].error, null);
});

test("running and awaiting-review steps globally block migration readiness", () => {
  const engine = new SessionEngine();
  const session = engine.create({
    title: "Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    steps: [
      { id: "first", title: "First" },
      { id: "second", title: "Second" }
    ]
  });

  engine.startStep(session, 0);
  assert.equal(engine.nextRunnable(session), -1);
  const running = structuredClone(session);
  assert.throws(() => engine.startStep(session, 1), /running|blocked/i);
  assert.deepEqual(session, running);

  engine.completeStep(session, 0, {});
  assert.equal(engine.nextRunnable(session), -1);
  const awaitingReview = structuredClone(session);
  assert.throws(() => engine.startStep(session, 1), /review|blocked/i);
  assert.deepEqual(session, awaitingReview);
});

test("execution steps retain direct completion without a review gate", () => {
  const engine = new SessionEngine();
  const session = engine.create({
    title: "Execution",
    workbench: "execution",
    projectRoot: "/tmp/example",
    steps: [{ title: "Run" }]
  });

  engine.startStep(session, 0);
  engine.completeStep(session, 0, { trace: {} });

  assert.equal(session.steps[0].status, "completed");
  assert.equal(session.status, "completed");
  assert.equal(session.events.at(-1).type, "step.completed");
});

test("failed migration transitions leave the session unchanged", () => {
  const engine = new SessionEngine();
  const session = engine.create({
    title: "Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    steps: [{ id: "apply", title: "Apply" }]
  });

  for (const transition of [
    () => engine.completeStep(session, 0, {}),
    () => engine.failStep(session, 0, new Error("not running")),
    () => engine.reviewStep(session, 0, "accept"),
    () => engine.reviewStep(session, 0, "maybe")
  ]) {
    const before = structuredClone(session);
    assert.throws(transition);
    assert.deepEqual(session, before);
  }

  const execution = engine.create({
    title: "Execution",
    workbench: "execution",
    projectRoot: "/tmp/example",
    steps: [{ title: "Run" }]
  });
  engine.startStep(execution, 0);
  engine.completeStep(execution, 0, {});
  const beforeReview = structuredClone(execution);
  assert.throws(() => engine.reviewStep(execution, 0, "accept"), /migration/i);
  assert.deepEqual(execution, beforeReview);
});

test("legacy persisted migration steps are read without mutation and hydrated when started", () => {
  const engine = new SessionEngine();
  const session = engine.create({
    title: "Legacy Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    steps: [{ id: "legacy-step", title: "Legacy step" }]
  });
  delete session.steps[0].risk;
  delete session.steps[0].dependsOn;
  delete session.steps[0].attempt;
  delete session.steps[0].review;
  const beforeReadiness = structuredClone(session);

  assert.equal(engine.nextRunnable(session), 0);
  assert.deepEqual(session, beforeReadiness);

  engine.startStep(session, 0);
  assert.deepEqual(
    {
      risk: session.steps[0].risk,
      dependsOn: session.steps[0].dependsOn,
      attempt: session.steps[0].attempt,
      review: session.steps[0].review
    },
    { risk: "low", dependsOn: [], attempt: 1, review: null }
  );
  assert.deepEqual(
    {
      type: session.events.at(-1).type,
      stepId: session.events.at(-1).stepId,
      attempt: session.events.at(-1).attempt
    },
    { type: "step.started", stepId: "legacy-step", attempt: 1 }
  );

  engine.failStep(session, 0, new Error("legacy command failed"));
  assert.equal(session.events.at(-1).attempt, 1);
  engine.startStep(session, 0);
  assert.equal(session.steps[0].attempt, 2);
  assert.equal(session.events.at(-1).attempt, 2);
});

test("completeStep is atomic when reading the snapshot throws", () => {
  const engine = new SessionEngine();
  const session = engine.create({
    title: "Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    steps: [{ id: "apply", title: "Apply" }]
  });
  engine.startStep(session, 0);
  const refs = {
    steps: session.steps,
    step: session.steps[0],
    snapshots: session.snapshots,
    events: session.events,
    review: session.steps[0].review
  };
  const before = structuredClone(session);
  const snapshot = {};
  Object.defineProperty(snapshot, "files", {
    enumerable: true,
    get() {
      throw new Error("snapshot getter failed");
    }
  });

  assert.throws(() => engine.completeStep(session, 0, snapshot), /snapshot getter failed/);
  assert.deepEqual(session, before);
  assert.strictEqual(session.steps, refs.steps);
  assert.strictEqual(session.steps[0], refs.step);
  assert.strictEqual(session.snapshots, refs.snapshots);
  assert.strictEqual(session.events, refs.events);
  assert.strictEqual(session.steps[0].review, refs.review);

  engine.failStep(session, 0, new Error("snapshot capture failed"));
  assert.equal(session.steps[0].status, "failed");
});

test("failStep is atomic when reading the snapshot throws", () => {
  const engine = new SessionEngine();
  const session = engine.create({
    title: "Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    steps: [{ id: "apply", title: "Apply" }]
  });
  engine.startStep(session, 0);
  const refs = {
    steps: session.steps,
    step: session.steps[0],
    snapshots: session.snapshots,
    events: session.events
  };
  const before = structuredClone(session);
  const snapshot = {};
  Object.defineProperty(snapshot, "command", {
    enumerable: true,
    get() {
      throw new Error("snapshot getter failed");
    }
  });

  assert.throws(
    () => engine.failStep(session, 0, new Error("command failed"), snapshot),
    /snapshot getter failed/
  );
  assert.deepEqual(session, before);
  assert.strictEqual(session.steps, refs.steps);
  assert.strictEqual(session.steps[0], refs.step);
  assert.strictEqual(session.snapshots, refs.snapshots);
  assert.strictEqual(session.events, refs.events);
});

test("completeStep is atomic when its public result cannot be cloned", () => {
  const engine = new SessionEngine();
  const metadata = { callback() {} };
  const session = engine.create({
    title: "Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    metadata,
    steps: [{ id: "apply", title: "Apply" }]
  });
  engine.startStep(session, 0);
  const refs = {
    steps: session.steps,
    step: session.steps[0],
    snapshots: session.snapshots,
    events: session.events,
    metadata: session.metadata,
    review: session.steps[0].review
  };
  const before = {
    step: structuredClone(session.steps[0]),
    snapshots: structuredClone(session.snapshots),
    events: structuredClone(session.events),
    status: session.status,
    cursor: session.cursor,
    updatedAt: session.updatedAt
  };

  assert.throws(() => engine.completeStep(session, 0, { files: ["package.json"] }), /clone/i);
  assert.deepEqual(session.steps[0], before.step);
  assert.deepEqual(session.snapshots, before.snapshots);
  assert.deepEqual(session.events, before.events);
  assert.equal(session.status, before.status);
  assert.equal(session.cursor, before.cursor);
  assert.equal(session.updatedAt, before.updatedAt);
  assert.strictEqual(session.steps, refs.steps);
  assert.strictEqual(session.steps[0], refs.step);
  assert.strictEqual(session.snapshots, refs.snapshots);
  assert.strictEqual(session.events, refs.events);
  assert.strictEqual(session.metadata, refs.metadata);
  assert.strictEqual(session.steps[0].review, refs.review);
});

test("reviewStep is atomic when its public result cannot be cloned", () => {
  const engine = new SessionEngine();
  const session = engine.create({
    title: "Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    steps: [{ id: "apply", title: "Apply" }]
  });
  engine.startStep(session, 0);
  engine.completeStep(session, 0, { files: ["package.json"] });
  session.metadata = { callback() {} };
  const refs = {
    steps: session.steps,
    step: session.steps[0],
    snapshots: session.snapshots,
    snapshot: session.snapshots[0],
    events: session.events,
    metadata: session.metadata,
    review: session.steps[0].review
  };
  const before = {
    step: structuredClone(session.steps[0]),
    snapshots: structuredClone(session.snapshots),
    events: structuredClone(session.events),
    status: session.status,
    cursor: session.cursor,
    updatedAt: session.updatedAt
  };

  assert.throws(() => engine.reviewStep(session, 0, "accept"), /clone/i);
  assert.deepEqual(session.steps[0], before.step);
  assert.deepEqual(session.snapshots, before.snapshots);
  assert.deepEqual(session.events, before.events);
  assert.equal(session.status, before.status);
  assert.equal(session.cursor, before.cursor);
  assert.equal(session.updatedAt, before.updatedAt);
  assert.strictEqual(session.steps, refs.steps);
  assert.strictEqual(session.steps[0], refs.step);
  assert.strictEqual(session.snapshots, refs.snapshots);
  assert.strictEqual(session.snapshots[0], refs.snapshot);
  assert.strictEqual(session.events, refs.events);
  assert.strictEqual(session.metadata, refs.metadata);
  assert.strictEqual(session.steps[0].review, refs.review);
});

test("failStep is atomic when its public result cannot be cloned", () => {
  const engine = new SessionEngine();
  const metadata = { callback() {} };
  const session = engine.create({
    title: "Migration",
    workbench: "migration",
    projectRoot: "/tmp/example",
    metadata,
    steps: [{ id: "apply", title: "Apply" }]
  });
  engine.startStep(session, 0);
  const refs = {
    steps: session.steps,
    step: session.steps[0],
    snapshots: session.snapshots,
    events: session.events,
    metadata: session.metadata
  };
  const before = {
    step: structuredClone(session.steps[0]),
    snapshots: structuredClone(session.snapshots),
    events: structuredClone(session.events),
    status: session.status,
    cursor: session.cursor,
    updatedAt: session.updatedAt
  };

  assert.throws(
    () => engine.failStep(
      session,
      0,
      new Error("command failed"),
      { command: ["npm", "install", "example"], cwd: "/tmp/example" }
    ),
    /clone/i
  );
  assert.deepEqual(session.steps[0], before.step);
  assert.deepEqual(session.snapshots, before.snapshots);
  assert.deepEqual(session.events, before.events);
  assert.equal(session.status, before.status);
  assert.equal(session.cursor, before.cursor);
  assert.equal(session.updatedAt, before.updatedAt);
  assert.strictEqual(session.steps, refs.steps);
  assert.strictEqual(session.steps[0], refs.step);
  assert.strictEqual(session.snapshots, refs.snapshots);
  assert.strictEqual(session.events, refs.events);
  assert.strictEqual(session.metadata, refs.metadata);
});
