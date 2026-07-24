import { randomUUID } from "node:crypto";
import { assertPlanInput, assertWorkbench, publicSession } from "../../protocol/src/index.js";

const timestamp = () => new Date().toISOString();
const event = (type, payload = {}) => ({ id: randomUUID(), type, at: timestamp(), ...payload });

function runtimeStepFields(step) {
  return {
    risk: step.risk ?? "low",
    dependsOn: step.dependsOn ?? [],
    attempt: step.attempt ?? 0,
    review: step.review ?? null
  };
}

function normalizeStep(step, index) {
  if (!step?.title?.trim()) throw new Error(`Step ${index + 1} requires a title`);
  const runtime = runtimeStepFields(step);
  return {
    id: step.id ?? randomUUID(),
    title: step.title.trim(), description: step.description?.trim() ?? "",
    risk: runtime.risk, dependsOn: structuredClone(runtime.dependsOn), attempt: 0,
    action: step.action == null ? null : structuredClone(step.action),
    expected: step.expected == null ? null : structuredClone(step.expected),
    traceState: step.traceState == null ? null : structuredClone(step.traceState), traceKind: step.traceKind ?? null,
    artifacts: step.artifacts ?? [], adapterSequence: step.adapterSequence ?? null, status: "pending",
    startedAt: null, completedAt: null, error: null, review: runtime.review
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

    const nextSteps = steps.map(normalizeStep);
    const updateEvent = event("plan.updated", { stepCount: nextSteps.length });
    const updatedAt = timestamp();
    const candidate = {
      ...session,
      steps: nextSteps,
      status: "ready",
      events: [...session.events, updateEvent],
      updatedAt
    };
    const result = publicSession(candidate);

    session.events.push(updateEvent);
    session.steps = nextSteps;
    session.status = "ready";
    session.updatedAt = updatedAt;
    return result;
  }

  nextRunnable(session) {
    if (
      session.workbench === "migration"
      && session.steps.some((step) => ["running", "awaiting_review"].includes(step.status))
    ) {
      return -1;
    }
    return session.steps.findIndex((step) => (
      ["pending", "failed"].includes(step.status)
      && (
        session.workbench !== "migration"
        || runtimeStepFields(step).dependsOn.every((dependencyId) => (
          session.steps.some((candidate) => candidate.id === dependencyId && candidate.status === "completed")
        ))
      )
    ));
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
    const runtime = runtimeStepFields(step);
    if (!["pending", "failed"].includes(step.status)) throw new Error(`Step ${index + 1} cannot run from ${step.status}`);
    if (
      session.workbench === "migration"
      && session.steps.some((candidate) => ["running", "awaiting_review"].includes(candidate.status))
    ) {
      throw new Error("Migration step is blocked while another step is running or awaiting review");
    }
    if (
      session.workbench === "migration"
      && !runtime.dependsOn.every((dependencyId) => (
        session.steps.some((candidate) => candidate.id === dependencyId && candidate.status === "completed")
      ))
    ) {
      throw new Error(`Step ${index + 1} has unmet dependencies`);
    }
    const attempt = runtime.attempt + 1;
    Object.assign(step, {
      ...runtime, status: "running", startedAt: timestamp(), completedAt: null, error: null, review: null, attempt
    });
    session.status = "running";
    session.events.push(event("step.started", { stepIndex: index, stepId: step.id, attempt }));
    this.touch(session);
    return step;
  }

  completeStep(session, index, snapshot) {
    const step = this.requireStep(session, index);
    if (step.status !== "running") throw new Error(`Step ${index + 1} is not running`);
    const completedAt = timestamp();
    const requiresReview = session.workbench === "migration";
    const candidateStep = {
      ...step,
      status: requiresReview ? "awaiting_review" : "completed",
      completedAt
    };
    const steps = session.steps.slice();
    steps[index] = candidateStep;
    const snapshots = session.snapshots.slice();
    snapshots[index] = { ...snapshot, stepIndex: index, capturedAt: timestamp() };
    const status = requiresReview
      ? "awaiting_review"
      : (steps.every((item) => ["completed", "skipped"].includes(item.status)) ? "completed" : "ready");
    const candidate = {
      ...session,
      steps,
      snapshots,
      cursor: index,
      status,
      events: [
        ...session.events,
        event(
          requiresReview ? "step.awaiting_review" : "step.completed",
          { stepIndex: index, stepId: candidateStep.id, attempt: candidateStep.attempt }
        )
      ],
      updatedAt: timestamp()
    };
    const result = publicSession(candidate);

    session.steps = candidate.steps;
    session.snapshots = candidate.snapshots;
    session.cursor = candidate.cursor;
    session.status = candidate.status;
    session.events = candidate.events;
    session.updatedAt = candidate.updatedAt;
    return result;
  }

  failStep(session, index, error) {
    const step = this.requireStep(session, index);
    if (step.status !== "running") throw new Error(`Step ${index + 1} is not running`);
    const candidateStep = {
      ...step,
      status: "failed",
      completedAt: timestamp(),
      error: { message: error.message, name: error.name }
    };
    const steps = session.steps.slice();
    steps[index] = candidateStep;
    const candidate = {
      ...session,
      steps,
      status: "failed",
      events: [
        ...session.events,
        event("step.failed", {
          stepIndex: index,
          stepId: candidateStep.id,
          attempt: candidateStep.attempt,
          error: candidateStep.error
        })
      ],
      updatedAt: timestamp()
    };
    const result = publicSession(candidate);

    session.steps = candidate.steps;
    session.status = candidate.status;
    session.events = candidate.events;
    session.updatedAt = candidate.updatedAt;
    return result;
  }

  reviewStep(session, index, decision) {
    const step = this.requireStep(session, index);
    if (session.workbench !== "migration") throw new Error("Step review requires a migration session");
    if (!["accept", "reject"].includes(decision)) throw new Error(`Unsupported review decision: ${decision}`);
    if (step.status !== "awaiting_review") throw new Error(`Step ${index + 1} is not awaiting review`);

    const reviewedAt = timestamp();
    const candidateStep = { ...step, review: { decision, reviewedAt } };
    const steps = session.steps.slice();
    steps[index] = candidateStep;
    let status;
    if (decision === "accept") {
      candidateStep.status = "completed";
      status = steps.every((item) => ["completed", "skipped"].includes(item.status))
        ? "completed"
        : "ready";
    } else {
      candidateStep.status = "failed";
      status = "failed";
    }
    const candidate = {
      ...session,
      steps,
      status,
      events: [
        ...session.events,
        event(
          decision === "accept" ? "step.review.accepted" : "step.review.rejected",
          { stepIndex: index, stepId: candidateStep.id, attempt: candidateStep.attempt }
        )
      ],
      updatedAt: timestamp()
    };
    const result = publicSession(candidate);

    session.steps = candidate.steps;
    session.status = candidate.status;
    session.events = candidate.events;
    session.updatedAt = candidate.updatedAt;
    return result;
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
