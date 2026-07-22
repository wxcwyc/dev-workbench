import { randomUUID } from "node:crypto";
import { assertPlanInput, assertWorkbench, publicSession } from "../../protocol/src/index.js";

const timestamp = () => new Date().toISOString();
const event = (type, payload = {}) => ({ id: randomUUID(), type, at: timestamp(), ...payload });

function normalizeStep(step, index) {
  if (!step?.title?.trim()) throw new Error(`Step ${index + 1} requires a title`);
  return {
    id: step.id ?? `step-${String(index + 1).padStart(2, "0")}`,
    title: step.title.trim(), description: step.description?.trim() ?? "",
    action: step.action == null ? null : structuredClone(step.action),
    expected: step.expected == null ? null : structuredClone(step.expected),
    traceState: step.traceState == null ? null : structuredClone(step.traceState), traceKind: step.traceKind ?? null,
    artifacts: step.artifacts ?? [], adapterSequence: step.adapterSequence ?? null, status: "pending",
    startedAt: null, completedAt: null, error: null
  };
}

export class SessionEngine {
  create({ title, workbench, projectRoot, steps = [], metadata = {} }) {
    assertWorkbench(workbench);
    if (!title?.trim()) throw new Error("Session title is required");
    if (!projectRoot) throw new Error("projectRoot is required");
    const createdAt = timestamp();
    const session = {
      schemaVersion: 1, id: randomUUID(), title: title.trim(), workbench, projectRoot, metadata,
      status: "ready", cursor: -1, steps: steps.map(normalizeStep), snapshots: [], annotations: [], events: [],
      createdAt, updatedAt: createdAt
    };
    session.events.push(event("session.created", { workbench, stepCount: session.steps.length }));
    return session;
  }

  replacePlan(session, steps) {
    assertPlanInput({ steps });
    if (session.workbench !== "migration") throw new Error("Plan replacement requires a migration session");
    if (
      session.cursor !== -1
      || session.steps.some((step) => step.status !== "pending")
      || session.snapshots.length !== 0
      || session.annotations.length !== 0
    ) {
      throw new Error("Plan replacement requires a pristine migration session");
    }

    session.steps = steps.map(normalizeStep);
    session.status = "ready";
    session.events.push(event("plan.updated", { stepCount: session.steps.length }));
    this.touch(session);
    return publicSession(session);
  }

  nextRunnable(session) {
    return session.steps.findIndex((step) => ["pending", "failed"].includes(step.status));
  }

  startTraceStream(session) {
    if (session.workbench !== "execution") throw new Error("Trace events require an execution session");
    session.status = "running";
    session.events.push(event("trace.stream.started", { nextSequence: session.steps.length }));
    this.touch(session);
  }

  appendTraceEvent(session, traceEvent) {
    if (session.workbench !== "execution") throw new Error("Trace events require an execution session");
    const expectedSequence = session.steps.length;
    if (traceEvent.sessionId !== session.id) throw new Error(`Trace event sessionId must equal ${session.id}`);
    if (traceEvent.sequence !== expectedSequence) throw new Error(`Expected trace sequence ${expectedSequence}, received ${traceEvent.sequence}`);

    const followLatest = session.cursor === expectedSequence - 1;
    const capturedAt = timestamp();
    const step = normalizeStep({
      id: `trace-${traceEvent.sequence + 1}`,
      title: traceEvent.title,
      description: traceEvent.explanation,
      traceState: traceEvent.state,
      traceKind: traceEvent.kind,
      artifacts: traceEvent.artifacts,
      adapterSequence: traceEvent.sequence
    }, expectedSequence);
    Object.assign(step, { status: "completed", startedAt: capturedAt, completedAt: capturedAt });
    session.steps.push(step);
    session.snapshots[expectedSequence] = {
      trace: structuredClone(traceEvent.state), artifacts: structuredClone(traceEvent.artifacts ?? []),
      traceKind: traceEvent.kind, stepIndex: expectedSequence, capturedAt
    };
    if (followLatest) session.cursor = expectedSequence;
    session.events.push(event("trace.event.appended", {
      stepIndex: expectedSequence, stepId: step.id, sequence: traceEvent.sequence, kind: traceEvent.kind
    }));
    this.touch(session);
    return step;
  }

  finishTraceStream(session, error = null) {
    session.status = error ? "failed" : (session.steps.length ? "completed" : "ready");
    session.events.push(event(error ? "trace.stream.failed" : "trace.stream.completed", {
      eventCount: session.steps.length, ...(error ? { error: { name: error.name, message: error.message } } : {})
    }));
    this.touch(session);
  }

  startStep(session, index) {
    const step = this.requireStep(session, index);
    if (!["pending", "failed"].includes(step.status)) throw new Error(`Step ${index + 1} cannot run from ${step.status}`);
    Object.assign(step, { status: "running", startedAt: timestamp(), completedAt: null, error: null });
    session.status = "running";
    session.events.push(event("step.started", { stepIndex: index, stepId: step.id }));
    this.touch(session);
    return step;
  }

  completeStep(session, index, snapshot) {
    const step = this.requireStep(session, index);
    if (step.status !== "running") throw new Error(`Step ${index + 1} is not running`);
    Object.assign(step, { status: "completed", completedAt: timestamp() });
    session.snapshots[index] = { ...snapshot, stepIndex: index, capturedAt: timestamp() };
    session.cursor = index;
    session.status = session.steps.every((item) => ["completed", "skipped"].includes(item.status)) ? "completed" : "ready";
    session.events.push(event("step.completed", { stepIndex: index, stepId: step.id }));
    this.touch(session);
    return publicSession(session);
  }

  failStep(session, index, error) {
    const step = this.requireStep(session, index);
    Object.assign(step, { status: "failed", completedAt: timestamp(), error: { message: error.message, name: error.name } });
    session.status = "failed";
    session.events.push(event("step.failed", { stepIndex: index, stepId: step.id, error: step.error }));
    this.touch(session);
    return publicSession(session);
  }

  seek(session, index) {
    if (!Number.isInteger(index) || index < -1 || index >= session.steps.length) throw new Error("Invalid timeline position");
    if (index >= 0 && !session.snapshots[index] && !session.steps[index].traceState) throw new Error(`Step ${index + 1} has no recorded snapshot`);
    session.cursor = index;
    session.events.push(event("cursor.moved", { stepIndex: index }));
    this.touch(session);
    return publicSession(session);
  }

  annotate(session, { stepIndex, text }) {
    if (!text?.trim()) throw new Error("Annotation text is required");
    if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= session.steps.length) throw new Error("Invalid annotation step");
    const annotation = { id: randomUUID(), stepIndex, text: text.trim(), createdAt: timestamp() };
    session.annotations.push(annotation);
    session.events.push(event("annotation.added", { stepIndex, annotationId: annotation.id }));
    this.touch(session);
    return annotation;
  }

  requireStep(session, index) {
    if (!Number.isInteger(index) || !session.steps[index]) throw new Error(`Unknown step: ${index}`);
    return session.steps[index];
  }

  touch(session) { session.updatedAt = timestamp(); }
}
