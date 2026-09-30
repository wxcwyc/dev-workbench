import { randomUUID } from "node:crypto";
import {
  assertAnnotation,
  assertAttempt,
  assertPlanInput,
  assertWorkbench,
  assertWorkspace,
  publicSession
} from "../../protocol/src/index.js";

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

function isMigration(session) {
  return session.workbench === "migration";
}

function hasPreparedWorkspace(session) {
  return isMigration(session) && migrationRuntime(session).workspace != null;
}

function hasRecoverableStart(session, attemptIdentity) {
  return hasPreparedWorkspace(session) && attemptIdentity != null;
}

function migrationRuntime(session) {
  return {
    attempts: session.attempts ?? [],
    workspace: Object.hasOwn(session, "workspace") ? session.workspace : null
  };
}

function filesForAnnotationAttempt(attempt) {
  return Array.isArray(attempt?.snapshot?.files) ? attempt.snapshot.files : [];
}

function persistedLineCount(output) {
  if (output === "") return 0;
  const lines = output.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}

function cloneSnapshot(snapshot, index) {
  return { ...structuredClone(snapshot), stepIndex: index, capturedAt: timestamp() };
}

function applySessionState(session, candidate) {
  session.steps = candidate.steps;
  session.snapshots = candidate.snapshots;
  session.cursor = candidate.cursor;
  session.status = candidate.status;
  session.events = candidate.events;
  session.updatedAt = candidate.updatedAt;
  if (Object.hasOwn(candidate, "attempts")) session.attempts = candidate.attempts;
  if (Object.hasOwn(candidate, "workspace")) session.workspace = candidate.workspace;
}

function dependencyReady(session, step) {
  return runtimeStepFields(step).dependsOn.every((dependencyId) => (
    session.steps.some((candidate) => candidate.id === dependencyId && candidate.status === "completed")
  ));
}

function updatedWorkspace(workspace, currentCheckpointId) {
  if (workspace == null) return workspace;
  return assertWorkspace({
    ...structuredClone(workspace),
    currentCheckpointId
  });
}

function maxHistoricalAttempt(attempts, stepIndex) {
  let max = 0;
  for (const attempt of attempts) {
    if (attempt.stepIndex === stepIndex && attempt.attempt > max) max = attempt.attempt;
  }
  return max;
}

function acceptedReviewAt(events, stepIndex, attempt) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const entry = events[index];
    if (
      entry.type === "step.review.accepted"
      && entry.stepIndex === stepIndex
      && entry.attempt === attempt
    ) {
      return entry.at;
    }
  }
  return null;
}

function restoredAcceptedAttempt(attempts, stepIndex, boundaryAttemptIndex) {
  for (let index = boundaryAttemptIndex; index >= 0; index -= 1) {
    const attempt = attempts[index];
    if (attempt.stepIndex === stepIndex && attempt.status === "completed") return attempt;
  }
  return null;
}

function completedProjection(step, attempt, reviewedAt) {
  const runtime = runtimeStepFields(step);
  return {
    ...step,
    risk: runtime.risk,
    dependsOn: structuredClone(runtime.dependsOn),
    status: "completed",
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
    error: null,
    review: { decision: "accept", reviewedAt },
    attempt: attempt.attempt
  };
}

function pendingProjection(step, attempt = 0) {
  const runtime = runtimeStepFields(step);
  return {
    ...step,
    risk: runtime.risk,
    dependsOn: structuredClone(runtime.dependsOn),
    status: "pending",
    startedAt: null,
    completedAt: null,
    error: null,
    review: null,
    attempt
  };
}

function findMatchingAttempt(session, index) {
  if (!hasPreparedWorkspace(session)) return null;
  const step = session.steps[index];
  if (!step) return null;
  const { attempts, workspace } = migrationRuntime(session);
  for (let attemptIndex = attempts.length - 1; attemptIndex >= 0; attemptIndex -= 1) {
    const attempt = attempts[attemptIndex];
    if (attempt.stepIndex === index && attempt.attempt === step.attempt) {
      return { attempt, attemptIndex, attempts, workspace };
    }
  }
  return null;
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
    if (workbench === "migration") {
      session.attempts = [];
      session.workspace = null;
    }
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
      isMigration(session)
      && session.steps.some((step) => ["running", "awaiting_review"].includes(step.status))
    ) {
      return -1;
    }
    return session.steps.findIndex((step) => (
      ["pending", "failed", "cancelled"].includes(step.status)
      && (
        !isMigration(session)
        || dependencyReady(session, step)
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

  startStep(session, index, attemptIdentity = null) {
    const step = this.requireStep(session, index);
    const runtime = runtimeStepFields(step);
    if (!["pending", "failed", "cancelled"].includes(step.status)) throw new Error(`Step ${index + 1} cannot run from ${step.status}`);
    if (
      isMigration(session)
      && session.steps.some((candidate) => ["running", "awaiting_review"].includes(candidate.status))
    ) {
      throw new Error("Migration step is blocked while another step is running or awaiting review");
    }
    if (
      isMigration(session)
      && !dependencyReady(session, step)
    ) {
      throw new Error(`Step ${index + 1} has unmet dependencies`);
    }
    const attempt = runtime.attempt + 1;
    const startedAt = timestamp();
    const candidateStep = {
      ...step,
      ...runtime,
      status: "running",
      startedAt,
      completedAt: null,
      error: null,
      review: null,
      attempt
    };
    const steps = session.steps.slice();
    steps[index] = candidateStep;
    const events = [...session.events, event("step.started", { stepIndex: index, stepId: step.id, attempt })];
    const updatedAt = timestamp();

    if (!isMigration(session) || !hasRecoverableStart(session, attemptIdentity)) {
      const candidate = {
        ...session,
        steps,
        status: "running",
        events,
        updatedAt
      };
      const result = publicSession(candidate);
      session.steps = candidate.steps;
      session.status = candidate.status;
      session.events = candidate.events;
      session.updatedAt = candidate.updatedAt;
      return result.steps[index];
    }

    const runtimeState = migrationRuntime(session);
    const candidateAttempt = assertAttempt({
      id: attemptIdentity.id,
      stepIndex: index,
      attempt,
      status: "running",
      startedAt,
      baseline: structuredClone(attemptIdentity.baseline)
    });
    const candidate = {
      ...session,
      steps,
      attempts: [...runtimeState.attempts, candidateAttempt],
      workspace: runtimeState.workspace,
      status: "running",
      events,
      updatedAt
    };
    const result = publicSession(candidate);
    session.steps = candidate.steps;
    session.attempts = candidate.attempts;
    session.workspace = candidate.workspace;
    session.status = candidate.status;
    session.events = candidate.events;
    session.updatedAt = candidate.updatedAt;
    return result.steps[index];
  }

  completeStep(session, index, snapshot, resultIdentity = null) {
    const step = this.requireStep(session, index);
    if (step.status !== "running") throw new Error(`Step ${index + 1} is not running`);
    const completedAt = timestamp();
    const capturedSnapshot = cloneSnapshot(snapshot, index);
    const steps = session.steps.slice();
    const snapshots = session.snapshots.slice();
    snapshots[index] = capturedSnapshot;

    const recoverableAttempt = resultIdentity == null ? null : findMatchingAttempt(session, index);
    if (!isMigration(session) || recoverableAttempt == null) {
      const requiresReview = isMigration(session);
      const candidateStep = {
        ...step,
        status: requiresReview ? "awaiting_review" : "completed",
        completedAt
      };
      steps[index] = candidateStep;
      const candidate = {
        ...session,
        steps,
        snapshots,
        cursor: index,
        status: requiresReview
          ? "awaiting_review"
          : (steps.every((item) => ["completed", "skipped"].includes(item.status)) ? "completed" : "ready"),
        events: [
          ...session.events,
          event(
            requiresReview ? "step.awaiting_review" : "step.completed",
            { stepIndex: index, stepId: candidateStep.id, attempt: candidateStep.attempt }
          )
        ],
        updatedAt: timestamp()
      };
      const publicClone = publicSession(candidate);
      applySessionState(session, candidate);
      return publicClone;
    }

    const { attempt, attemptIndex, attempts, workspace } = this.requireAttempt(session, index, ["running"]);
    const candidateStep = { ...step, status: "awaiting_review", completedAt };
    const candidateAttempt = assertAttempt({
      ...structuredClone(attempt),
      status: "awaiting_review",
      completedAt,
      result: { ...structuredClone(resultIdentity), restorable: false },
      snapshot: structuredClone(snapshot)
    });
    const nextAttempts = attempts.slice();
    nextAttempts[attemptIndex] = candidateAttempt;
    steps[index] = candidateStep;
    const candidate = {
      ...session,
      steps,
      snapshots,
      attempts: nextAttempts,
      workspace,
      cursor: index,
      status: "awaiting_review",
      events: [
        ...session.events,
        event("step.awaiting_review", { stepIndex: index, stepId: candidateStep.id, attempt: candidateStep.attempt })
      ],
      updatedAt: timestamp()
    };
    const publicClone = publicSession(candidate);
    applySessionState(session, candidate);
    return publicClone;
  }

  failStep(session, index, error, snapshot = null, resultIdentity = null, evidenceError = null) {
    const step = this.requireStep(session, index);
    if (step.status !== "running") throw new Error(`Step ${index + 1} is not running`);
    if (evidenceError !== null && (snapshot !== null || resultIdentity !== null)) {
      throw new Error("evidenceError is mutually exclusive with result and snapshot evidence");
    }
    const completedAt = timestamp();
    const candidateStep = {
      ...step,
      status: "failed",
      completedAt,
      error: { message: error.message, name: error.name }
    };
    const steps = session.steps.slice();
    steps[index] = candidateStep;

    const matchingAttempt = findMatchingAttempt(session, index);
    if (evidenceError !== null) {
      if (!isMigration(session) || matchingAttempt == null) {
        throw new Error("evidenceError requires a running recoverable migration attempt");
      }
      const { attempt, attemptIndex, attempts, workspace } = this.requireAttempt(session, index, ["running"]);
      const candidateAttempt = assertAttempt({
        ...structuredClone(attempt),
        status: "failed",
        completedAt,
        evidenceError: structuredClone(evidenceError)
      });
      const nextAttempts = attempts.slice();
      nextAttempts[attemptIndex] = candidateAttempt;
      const candidate = {
        ...session,
        steps,
        attempts: nextAttempts,
        workspace,
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
      const publicClone = publicSession(candidate);
      applySessionState(session, candidate);
      return publicClone;
    }

    const recoverableAttempt = resultIdentity == null ? null : matchingAttempt;
    if (!isMigration(session) || recoverableAttempt == null) {
      let snapshots;
      if (snapshot !== null) {
        snapshots = session.snapshots.slice();
        snapshots[index] = cloneSnapshot(snapshot, index);
      }
      const candidate = {
        ...session,
        steps,
        ...(snapshot !== null ? { snapshots, cursor: index } : {}),
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
      const publicClone = publicSession(candidate);
      session.steps = candidate.steps;
      if (snapshot !== null) {
        session.snapshots = candidate.snapshots;
        session.cursor = candidate.cursor;
      }
      session.status = candidate.status;
      session.events = candidate.events;
      session.updatedAt = candidate.updatedAt;
      return publicClone;
    }

    const { attempt, attemptIndex, attempts, workspace } = this.requireAttempt(session, index, ["running"]);
    const snapshots = session.snapshots.slice();
    snapshots[index] = cloneSnapshot(snapshot, index);
    const candidateAttempt = assertAttempt({
      ...structuredClone(attempt),
      status: "failed",
      completedAt,
      result: { ...structuredClone(resultIdentity), restorable: false },
      snapshot: structuredClone(snapshot)
    });
    const nextAttempts = attempts.slice();
    nextAttempts[attemptIndex] = candidateAttempt;
    const candidate = {
      ...session,
      steps,
      snapshots,
      attempts: nextAttempts,
      workspace,
      cursor: index,
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
    const publicClone = publicSession(candidate);
    applySessionState(session, candidate);
    return publicClone;
  }

  cancelStep(session, index, attemptNumber, snapshot, resultIdentity, error = null) {
    if (!isMigration(session)) throw new Error("Step cancellation requires a migration session");
    const step = this.requireStep(session, index);
    if (step.status !== "running") throw new Error(`Step ${index + 1} is not running`);
    if (step.attempt !== attemptNumber) throw new Error(`Step ${index + 1} is running attempt ${step.attempt}, not ${attemptNumber}`);

    const { attempt, attemptIndex, attempts, workspace } = this.requireAttempt(session, index, ["running"]);
    const completedAt = timestamp();
    const capturedSnapshot = cloneSnapshot(snapshot, index);
    const candidateStep = {
      ...step,
      status: "cancelled",
      completedAt,
      error: error ? { message: error.message, name: error.name } : null
    };
    const steps = session.steps.slice();
    steps[index] = candidateStep;
    const snapshots = session.snapshots.slice();
    snapshots[index] = capturedSnapshot;
    const candidateAttempt = assertAttempt({
      ...structuredClone(attempt),
      status: "cancelled",
      completedAt,
      result: { ...structuredClone(resultIdentity), restorable: false },
      snapshot: structuredClone(snapshot)
    });
    const nextAttempts = attempts.slice();
    nextAttempts[attemptIndex] = candidateAttempt;
    const candidate = {
      ...session,
      steps,
      snapshots,
      attempts: nextAttempts,
      workspace,
      cursor: index,
      status: "failed",
      events: [
        ...session.events,
        event("step.cancelled", { stepIndex: index, stepId: candidateStep.id, attempt: candidateStep.attempt })
      ],
      updatedAt: timestamp()
    };
    const publicClone = publicSession(candidate);
    applySessionState(session, candidate);
    return publicClone;
  }

  reviewStep(session, index, decision) {
    const step = this.requireStep(session, index);
    if (!isMigration(session)) throw new Error("Step review requires a migration session");
    if (!["accept", "reject"].includes(decision)) throw new Error(`Unsupported review decision: ${decision}`);
    if (step.status !== "awaiting_review") throw new Error(`Step ${index + 1} is not awaiting review`);

    if (findMatchingAttempt(session, index) == null) {
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
      const publicClone = publicSession(candidate);
      session.steps = candidate.steps;
      session.status = candidate.status;
      session.events = candidate.events;
      session.updatedAt = candidate.updatedAt;
      return publicClone;
    }

    const { attempt, attemptIndex, attempts, workspace } = this.requireAttempt(session, index, ["awaiting_review"]);
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
    const candidateAttempt = assertAttempt({
      ...structuredClone(attempt),
      status: decision === "accept" ? "completed" : "failed",
      result: {
        ...structuredClone(attempt.result),
        restorable: decision === "accept"
      }
    });
    const nextAttempts = attempts.slice();
    nextAttempts[attemptIndex] = candidateAttempt;
    const candidate = {
      ...session,
      steps,
      attempts: nextAttempts,
      workspace: decision === "accept" ? updatedWorkspace(workspace, attempt.id) : workspace,
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
    const publicClone = publicSession(candidate);
    session.steps = candidate.steps;
    session.attempts = candidate.attempts;
    session.workspace = candidate.workspace;
    session.status = candidate.status;
    session.events = candidate.events;
    session.updatedAt = candidate.updatedAt;
    return publicClone;
  }

  restore(session, checkpointId) {
    if (!isMigration(session)) throw new Error("Workspace restore requires a migration session");
    if (session.steps.some((step) => ["running", "awaiting_review"].includes(step.status))) {
      throw new Error("Cannot restore while a migration step is active");
    }
    const { attempts, workspace } = migrationRuntime(session);
    if (workspace == null) throw new Error("Workspace restore requires a prepared workspace");

    let boundaryIndex = -1;
    let boundaryAttemptIndex = -1;
    if (checkpointId !== "initial") {
      const boundaryAttempt = attempts.find((attempt) => (
        attempt.id === checkpointId
        && attempt.status === "completed"
        && attempt.result?.restorable === true
      ));
      if (!boundaryAttempt) throw new Error(`Unknown restorable checkpoint: ${checkpointId}`);
      boundaryIndex = boundaryAttempt.stepIndex;
      boundaryAttemptIndex = attempts.indexOf(boundaryAttempt);
    }

    const steps = session.steps.map((step, stepIndex) => {
      const historicalAttempt = maxHistoricalAttempt(attempts, stepIndex);
      if (boundaryIndex === -1 || stepIndex > boundaryIndex) {
        return pendingProjection(step, historicalAttempt);
      }

      const acceptedAttempt = restoredAcceptedAttempt(attempts, stepIndex, boundaryAttemptIndex);
      if (!acceptedAttempt) return pendingProjection(step, historicalAttempt);
      return completedProjection(
        step,
        acceptedAttempt,
        acceptedReviewAt(session.events, stepIndex, acceptedAttempt.attempt) ?? acceptedAttempt.completedAt
      );
    });
    const status = steps.every((step) => ["completed", "skipped"].includes(step.status)) ? "completed" : "ready";
    const candidate = {
      ...session,
      steps,
      snapshots: session.snapshots.slice(),
      attempts,
      workspace: updatedWorkspace(workspace, checkpointId),
      cursor: boundaryIndex,
      status,
      events: [...session.events, event("workspace.restored", { checkpointId, stepIndex: boundaryIndex })],
      updatedAt: timestamp()
    };
    const publicClone = publicSession(candidate);
    applySessionState(session, candidate);
    return publicClone;
  }

  seek(session, index) {
    if (!Number.isInteger(index) || index < -1 || index >= session.steps.length) throw new Error("Invalid timeline position");
    if (index >= 0 && !session.snapshots[index] && !session.steps[index].traceState) throw new Error(`Step ${index + 1} has no recorded snapshot`);
    session.cursor = index;
    session.events.push(event("cursor.moved", { stepIndex: index }));
    this.touch(session);
    return publicSession(session);
  }

  annotate(session, input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Annotation must be an object");
    const inputKeys = ["stepIndex", "attemptId", "kind", "text", "tags", "target"];
    const unknownKey = Object.keys(input).find((key) => !inputKeys.includes(key));
    if (unknownKey) throw new Error(`Unknown annotation field: ${unknownKey}`);
    const { stepIndex, attemptId, kind = "note", text, tags = [], target } = input;
    if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= session.steps.length) throw new Error("Invalid annotation step");
    const annotation = {
      id: randomUUID(),
      stepIndex,
      kind,
      text: typeof text === "string" ? text.trim() : text,
      tags: structuredClone(tags),
      createdAt: timestamp()
    };
    if (attemptId !== undefined) annotation.attemptId = attemptId;
    if (target !== undefined) annotation.target = structuredClone(target);
    assertAnnotation(annotation);

    if (kind === "bookmark" && target == null) throw new Error("Bookmark target is required");
    let attempt = null;
    if (attemptId !== undefined) {
      attempt = migrationRuntime(session).attempts.find((candidate) => candidate.id === attemptId);
      if (!attempt || attempt.stepIndex !== stepIndex) throw new Error("Annotation attempt must belong to its step");
    }
    if (target != null) {
      if (!attempt?.snapshot) throw new Error("Annotation target requires persisted attempt evidence");
      if (["file", "diff"].includes(target.type)) {
        if (!filesForAnnotationAttempt(attempt).some((file) => file.path === target.path)) {
          throw new Error("Annotation path is not present in the attempt manifest");
        }
      } else if (target.type === "command") {
        const output = attempt.snapshot.command?.[target.stream];
        if (typeof output !== "string") throw new Error("Annotation command stream was not persisted");
        if (target.line !== undefined && target.line > persistedLineCount(output)) {
          throw new Error("Annotation command line is outside persisted output");
        }
      }
    }
    session.annotations.push(annotation);
    session.events.push(event("annotation.added", { stepIndex, annotationId: annotation.id, kind }));
    this.touch(session);
    return annotation;
  }

  requireStep(session, index) {
    if (!Number.isInteger(index) || !session.steps[index]) throw new Error(`Unknown step: ${index}`);
    return session.steps[index];
  }

  requireAttempt(session, index, statuses) {
    const step = this.requireStep(session, index);
    const { attempts, workspace } = migrationRuntime(session);
    for (let attemptIndex = attempts.length - 1; attemptIndex >= 0; attemptIndex -= 1) {
      const attempt = attempts[attemptIndex];
      if (attempt.stepIndex === index && attempt.attempt === step.attempt) {
        if (!statuses.includes(attempt.status)) {
          throw new Error(`Step ${index + 1} attempt ${step.attempt} is ${attempt.status}`);
        }
        return { attempt, attemptIndex, attempts, workspace };
      }
    }
    throw new Error(`Step ${index + 1} has no recorded attempt ${step.attempt}`);
  }

  touch(session) { session.updatedAt = timestamp(); }
}
