export const WORKBENCH_TYPES = Object.freeze(["execution", "migration"]);
export const STEP_STATUSES = Object.freeze(["pending", "running", "completed", "failed", "skipped"]);
export const EVENT_TYPES = Object.freeze([
  "session.created", "plan.updated", "step.started", "step.completed", "step.failed", "cursor.moved", "annotation.added",
  "trace.stream.started", "trace.event.appended", "trace.stream.completed", "trace.stream.failed"
]);
export const PROTOCOL_VERSION = "1.0";
export const TRACE_EVENT_KINDS = Object.freeze(["evaluation", "branch", "failure", "backtrack", "solution"]);
export const ADAPTER_CAPABILITIES = Object.freeze(["trace", "artifacts", "source-locations"]);
const STEP_RISKS = ["low", "medium", "high"];

export class ProtocolValidationError extends Error {
  constructor(documentType, issues) {
    const summary = issues.map(({ path, message }) => `${path}: ${message}`).join("; ");
    super(`Invalid ${documentType}: ${summary}`);
    this.name = "ProtocolValidationError";
    this.documentType = documentType;
    this.issues = issues;
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const issue = (issues, path, message) => issues.push({ path, message });
const escapePointerSegment = (value) => value.replaceAll("~", "~0").replaceAll("/", "~1");
const allowedKeys = (value, keys, path, issues) => {
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) issue(issues, `${path === "/" ? "" : path}/${escapePointerSegment(key)}`, "is not allowed");
  }
};

function requireObject(value, path, issues) {
  if (isObject(value)) return true;
  issue(issues, path, "must be an object");
  return false;
}

function requireString(value, path, issues) {
  if (typeof value === "string" && value.trim()) return true;
  issue(issues, path, "must be a non-empty string");
  return false;
}

function validateAction(action, path, issues) {
  if (!requireObject(action, path, issues)) return;
  allowedKeys(action, ["command", "cwd"], path, issues);
  if (!Array.isArray(action.command) || action.command.length === 0) {
    issue(issues, `${path}/command`, "must be a non-empty argv array");
  } else {
    action.command.forEach((argument, index) => {
      if (typeof argument !== "string") issue(issues, `${path}/command/${index}`, "must be a string");
    });
  }
  if (action.cwd !== undefined && typeof action.cwd !== "string") issue(issues, `${path}/cwd`, "must be a string");
}

function validateTraceItem(item, path, issues) {
  if (!requireObject(item, path, issues)) return;
  allowedKeys(item, ["id", "kind", "title", "explanation", "state"], path, issues);
  if (item.title !== undefined) requireString(item.title, `${path}/title`, issues);
  if (!requireObject(item.state, `${path}/state`, issues)) return;
  if (item.kind !== undefined && !TRACE_EVENT_KINDS.includes(item.kind)) {
    issue(issues, `${path}/kind`, `must be one of ${TRACE_EVENT_KINDS.join(", ")}`);
  }
}

function validateStep(step, path, issues) {
  if (!requireObject(step, path, issues)) return;
  allowedKeys(step, ["id", "title", "description", "expected", "risk", "dependsOn", "action", "traceState"], path, issues);
  if (step.id !== undefined) requireString(step.id, `${path}/id`, issues);
  requireString(step.title, `${path}/title`, issues);
  if (step.description !== undefined && typeof step.description !== "string") issue(issues, `${path}/description`, "must be a string");
  if (step.risk !== undefined && !STEP_RISKS.includes(step.risk)) {
    issue(issues, `${path}/risk`, `must be one of ${STEP_RISKS.join(", ")}`);
  }
  if (step.dependsOn !== undefined && !Array.isArray(step.dependsOn)) {
    issue(issues, `${path}/dependsOn`, "must be an array");
  } else {
    step.dependsOn?.forEach((dependency, index) => {
      if (typeof dependency !== "string") issue(issues, `${path}/dependsOn/${index}`, "must be a string");
    });
  }
  if (step.action !== undefined && step.action !== null) validateAction(step.action, `${path}/action`, issues);
  if (step.traceState !== undefined && step.traceState !== null) requireObject(step.traceState, `${path}/traceState`, issues);
}

function validateStepRelationships(steps, issues) {
  if (!Array.isArray(steps)) return;

  const stepIndexesById = new Map();
  steps.forEach((step, index) => {
    if (!isObject(step) || typeof step.id !== "string" || !step.id.trim()) return;
    const indexes = stepIndexesById.get(step.id);
    if (indexes) {
      indexes.push(index);
      issue(issues, `/steps/${index}/id`, "must be unique");
    } else {
      stepIndexesById.set(step.id, [index]);
    }
  });

  steps.forEach((step, stepIndex) => {
    if (!isObject(step) || !Array.isArray(step.dependsOn)) return;
    const seen = new Set();
    step.dependsOn.forEach((dependency, dependencyIndex) => {
      if (typeof dependency !== "string") return;
      const path = `/steps/${stepIndex}/dependsOn/${dependencyIndex}`;
      if (seen.has(dependency)) {
        issue(issues, path, "must be unique");
        return;
      }
      seen.add(dependency);
      const targetIndexes = stepIndexesById.get(dependency);
      if (typeof step.id === "string" && step.id.trim() && dependency === step.id && targetIndexes?.length === 1) {
        issue(issues, path, "must not reference the same step");
        return;
      }
      if (targetIndexes === undefined) {
        issue(issues, path, "must reference an existing step");
      } else if (targetIndexes.every((targetIndex) => targetIndex > stepIndex)) {
        issue(issues, path, "must reference an earlier step");
      }
    });
  });
}

function throwIssues(documentType, issues) {
  if (issues.length) throw new ProtocolValidationError(documentType, issues);
}

export function assertSessionInput(input) {
  const issues = [];
  if (!requireObject(input, "/", issues)) throwIssues("session", issues);
  allowedKeys(input, ["schemaVersion", "title", "workbench", "projectRoot", "metadata", "steps", "trace"], "/", issues);
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) issue(issues, "/schemaVersion", "must equal 1");
  requireString(input.title, "/title", issues);
  if (!WORKBENCH_TYPES.includes(input.workbench)) issue(issues, "/workbench", `must be one of ${WORKBENCH_TYPES.join(", ")}`);
  requireString(input.projectRoot, "/projectRoot", issues);
  if (input.metadata !== undefined) requireObject(input.metadata, "/metadata", issues);
  if (input.steps !== undefined && !Array.isArray(input.steps)) issue(issues, "/steps", "must be an array");
  if (Array.isArray(input.steps)) input.steps.forEach((step, index) => validateStep(step, `/steps/${index}`, issues));
  validateStepRelationships(input.steps, issues);
  if (input.trace !== undefined && !Array.isArray(input.trace)) issue(issues, "/trace", "must be an array");
  input.trace?.forEach((item, index) => validateTraceItem(item, `/trace/${index}`, issues));
  if (input.steps !== undefined && input.trace !== undefined) issue(issues, "/", "must contain either steps or trace, not both");
  throwIssues("session", issues);
  return input;
}

export function assertPlanInput(input) {
  const issues = [];
  if (!requireObject(input, "/", issues)) throwIssues("plan", issues);
  allowedKeys(input, ["steps"], "/", issues);
  if (!Array.isArray(input.steps)) {
    issue(issues, "/steps", "must be an array");
  } else {
    input.steps.forEach((step, index) => validateStep(step, `/steps/${index}`, issues));
  }
  validateStepRelationships(input.steps, issues);
  throwIssues("plan", issues);
  return input;
}

export function assertAdapterManifest(manifest) {
  const issues = [];
  if (!requireObject(manifest, "/", issues)) throwIssues("adapter manifest", issues);
  allowedKeys(manifest, ["id", "name", "version", "protocolVersion", "capabilities", "description"], "/", issues);
  requireString(manifest.id, "/id", issues);
  if (typeof manifest.id === "string" && !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(manifest.id)) issue(issues, "/id", "must use lowercase dot- or dash-separated segments");
  requireString(manifest.name, "/name", issues);
  requireString(manifest.version, "/version", issues);
  if (manifest.protocolVersion !== PROTOCOL_VERSION) issue(issues, "/protocolVersion", `must equal ${PROTOCOL_VERSION}`);
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    issue(issues, "/capabilities", "must be a non-empty array");
  } else {
    manifest.capabilities.forEach((capability, index) => {
      if (!ADAPTER_CAPABILITIES.includes(capability)) issue(issues, `/capabilities/${index}`, `unsupported capability: ${capability}`);
    });
    if (new Set(manifest.capabilities).size !== manifest.capabilities.length) issue(issues, "/capabilities", "must not contain duplicates");
  }
  throwIssues("adapter manifest", issues);
  return manifest;
}

export function assertTraceEvent(traceEvent) {
  const issues = [];
  if (!requireObject(traceEvent, "/", issues)) throwIssues("trace event", issues);
  allowedKeys(traceEvent, ["protocolVersion", "sessionId", "sequence", "kind", "title", "explanation", "state", "artifacts"], "/", issues);
  if (traceEvent.protocolVersion !== PROTOCOL_VERSION) issue(issues, "/protocolVersion", `must equal ${PROTOCOL_VERSION}`);
  requireString(traceEvent.sessionId, "/sessionId", issues);
  if (!Number.isInteger(traceEvent.sequence) || traceEvent.sequence < 0) issue(issues, "/sequence", "must be a non-negative integer");
  if (!TRACE_EVENT_KINDS.includes(traceEvent.kind)) issue(issues, "/kind", `must be one of ${TRACE_EVENT_KINDS.join(", ")}`);
  requireString(traceEvent.title, "/title", issues);
  requireObject(traceEvent.state, "/state", issues);
  if (traceEvent.artifacts !== undefined && !Array.isArray(traceEvent.artifacts)) {
    issue(issues, "/artifacts", "must be an array");
  } else {
    traceEvent.artifacts?.forEach((artifact, index) => {
      const path = `/artifacts/${index}`;
      if (!requireObject(artifact, path, issues)) return;
      allowedKeys(artifact, ["id", "type", "label", "uri", "data"], path, issues);
      requireString(artifact.id, `${path}/id`, issues);
      if (!["source", "log", "result", "diff", "custom"].includes(artifact.type)) issue(issues, `${path}/type`, "must be a supported artifact type");
      requireString(artifact.label, `${path}/label`, issues);
      if (artifact.uri !== undefined) requireString(artifact.uri, `${path}/uri`, issues);
    });
  }
  throwIssues("trace event", issues);
  return traceEvent;
}

export function publicSession(session) {
  const snapshot = structuredClone(session);
  snapshot.currentSnapshot = snapshot.snapshots[snapshot.cursor] ?? null;
  return snapshot;
}

export function assertWorkbench(value) {
  if (!WORKBENCH_TYPES.includes(value)) throw new Error(`Unsupported workbench: ${value}`);
  return value;
}
