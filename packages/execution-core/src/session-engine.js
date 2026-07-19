import { randomUUID } from "node:crypto";
import { assertWorkbench, publicSession } from "../../protocol/src/index.js";

const timestamp = () => new Date().toISOString();
const event = (type, payload = {}) => ({ id: randomUUID(), type, at: timestamp(), ...payload });

function normalizeStep(step, index) {
  if (!step?.title?.trim()) throw new Error(`Step ${index + 1} requires a title`);
  return {
    id: step.id ?? `step-${String(index + 1).padStart(2, "0")}`,
    title: step.title.trim(), description: step.description?.trim() ?? "",
    action: step.action ?? null, expected: step.expected ?? null,
    traceState: step.traceState ?? null, status: "pending",
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

  nextRunnable(session) {
    return session.steps.findIndex((step) => ["pending", "failed"].includes(step.status));
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
