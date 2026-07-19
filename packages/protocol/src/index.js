export const WORKBENCH_TYPES = Object.freeze(["execution", "migration"]);
export const STEP_STATUSES = Object.freeze(["pending", "running", "completed", "failed", "skipped"]);
export const EVENT_TYPES = Object.freeze(["session.created", "step.started", "step.completed", "step.failed", "cursor.moved", "annotation.added"]);

export function publicSession(session) {
  const snapshot = structuredClone(session);
  snapshot.currentSnapshot = snapshot.snapshots[snapshot.cursor] ?? null;
  return snapshot;
}

export function assertWorkbench(value) {
  if (!WORKBENCH_TYPES.includes(value)) throw new Error(`Unsupported workbench: ${value}`);
  return value;
}
