export const WORKBENCH_TYPES = Object.freeze(["execution", "migration"]);
export const STEP_STATUSES = Object.freeze(["pending", "running", "awaiting_review", "completed", "failed", "cancelled", "skipped"]);
export const EVENT_TYPES = Object.freeze([
  "session.created", "plan.updated", "step.started", "step.completed", "step.failed", "step.awaiting_review",
  "step.review.accepted", "step.review.rejected", "step.cancelled", "cursor.moved", "annotation.added",
  "workspace.prepared", "checkpoint.created", "workspace.restored",
  "trace.stream.started", "trace.event.appended", "trace.stream.completed", "trace.stream.failed"
]);
export const PROTOCOL_VERSION = "1.0";
export const TRACE_EVENT_KINDS = Object.freeze(["evaluation", "branch", "failure", "backtrack", "solution"]);
export const ADAPTER_CAPABILITIES = Object.freeze(["trace", "artifacts", "source-locations"]);
const STEP_RISKS = ["low", "medium", "high"];
const ATTEMPT_STATUSES = ["running", "awaiting_review", "completed", "failed", "cancelled"];
const FILE_STATUSES = ["added", "modified", "deleted", "renamed", "copied", "type-changed", "unmerged"];
const ANNOTATION_KINDS = ["note", "bookmark"];
const TARGET_TYPES = ["file", "diff", "command"];
const MAX_FILE_MANIFEST_ENTRIES = 1000;
const MAX_ANNOTATION_TAGS = 16;
const MAX_PATH_LENGTH = 4096;
const MAX_TAG_LENGTH = 64;
const MAX_ANNOTATION_TEXT_LENGTH = 10000;

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
const pointerChild = (path, key) => `${path === "/" ? "" : path}/${key}`;
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

function requireBoundedString(value, path, issues, maxLength) {
  if (!requireString(value, path, issues)) return false;
  if (value.length > maxLength) {
    issue(issues, path, `must be at most ${maxLength} characters`);
    return false;
  }
  return true;
}

function validateIdentifier(value, path, issues) {
  if (!requireBoundedString(value, path, issues, 128)) return;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,127})$/.test(value)) {
    issue(issues, path, "must use letters, numbers, dots, underscores, or dashes");
  }
}

function validateObjectId(value, path, issues) {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    issue(issues, path, "must be a full 40- or 64-character lowercase hexadecimal object ID");
  }
}

function validateAbsolutePath(value, path, issues) {
  if (!requireBoundedString(value, path, issues, MAX_PATH_LENGTH)) return false;
  const segments = value.slice(1).split("/");
  const valid = value.startsWith("/")
    && !value.includes("\0")
    && (value === "/" || (!value.endsWith("/") && segments.every((segment) => segment && segment !== "." && segment !== "..")));
  if (!valid) issue(issues, path, "must be a canonical absolute path");
  return valid;
}

function validateRelativePath(value, path, issues, { allowDot = false } = {}) {
  if (!requireBoundedString(value, path, issues, MAX_PATH_LENGTH)) return false;
  const segments = value.split("/");
  const valid = !(
    value.startsWith("/")
    || value.includes("\0")
    || (!allowDot && value === ".")
    || segments.some((segment) => segment === "" || segment === ".." || (segment === "." && value !== "."))
  );
  if (!valid) issue(issues, path, "must be a safe relative path");
  return valid;
}

function sameOrNestedPath(value, parent) {
  const normalizedValue = value.replace(/\/+$/, "");
  const normalizedParent = parent.replace(/\/+$/, "");
  return normalizedValue === normalizedParent || normalizedValue.startsWith(`${normalizedParent}/`);
}

function joinProjectPath(root, relativePath) {
  if (relativePath === ".") return root;
  return root === "/" ? `/${relativePath}` : `${root}/${relativePath}`;
}

function validateTimestamp(value, path, issues) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    issue(issues, path, "must be a valid timestamp");
  }
}

function validateCheckpointIdentity(value, path, issues, { allowRestorable = true, role } = {}) {
  if (!requireObject(value, path, issues)) return;
  allowedKeys(value, allowRestorable ? ["oid", "ref", "restorable"] : ["oid", "ref"], path, issues);
  validateObjectId(value.oid, pointerChild(path, "oid"), issues);
  const refMatch = typeof value.ref === "string"
    ? value.ref.match(/^refs\/dev-workbench\/checkpoints\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(?:baseline|result)$/)
    : null;
  if (
    !refMatch
    || refMatch.slice(1).some((segment) => segment.startsWith(".") || segment.endsWith(".") || segment.includes(".."))
  ) {
    issue(issues, pointerChild(path, "ref"), "must be a namespaced dev-workbench checkpoint ref");
  } else if (role !== undefined && !value.ref.endsWith(`/${role}`)) {
    issue(issues, pointerChild(path, "ref"), `must identify a ${role} checkpoint`);
  }
  if (allowRestorable && value.restorable !== undefined && typeof value.restorable !== "boolean") {
    issue(issues, pointerChild(path, "restorable"), "must be a boolean");
  }
}

function validateFileManifest(value, path, issues) {
  if (!Array.isArray(value)) {
    issue(issues, path, "must be an array");
    return;
  }
  if (value.length > MAX_FILE_MANIFEST_ENTRIES) {
    issue(issues, path, `must contain at most ${MAX_FILE_MANIFEST_ENTRIES} entries`);
    return;
  }
  value.forEach((entry, index) => {
    const entryPath = `${path === "/" ? "" : path}/${index}`;
    if (!requireObject(entry, entryPath, issues)) return;
    allowedKeys(entry, ["path", "oldPath", "status", "binary", "additions", "deletions"], entryPath, issues);
    validateRelativePath(entry.path, `${entryPath}/path`, issues);
    if (entry.oldPath !== null && entry.oldPath !== undefined) {
      validateRelativePath(entry.oldPath, `${entryPath}/oldPath`, issues);
    }
    if (!FILE_STATUSES.includes(entry.status)) {
      issue(issues, `${entryPath}/status`, `must be one of ${FILE_STATUSES.join(", ")}`);
    }
    if (typeof entry.binary !== "boolean") issue(issues, `${entryPath}/binary`, "must be a boolean");
    for (const key of ["additions", "deletions"]) {
      if (!Number.isInteger(entry[key]) || entry[key] < 0) {
        issue(issues, `${entryPath}/${key}`, "must be a non-negative integer");
      }
    }
  });
}

function validateAnnotationTarget(value, path, issues) {
  if (!requireObject(value, path, issues)) return;
  if (!TARGET_TYPES.includes(value.type)) {
    allowedKeys(value, ["type"], path, issues);
    issue(issues, `${path}/type`, `must be one of ${TARGET_TYPES.join(", ")}`);
    return;
  }
  if (value.type === "command") {
    allowedKeys(value, ["type", "stream", "line"], path, issues);
    if (!["stdout", "stderr"].includes(value.stream)) {
      issue(issues, `${path}/stream`, "must be one of stdout, stderr");
    }
  } else {
    allowedKeys(value, ["type", "path", "line"], path, issues);
    validateRelativePath(value.path, `${path}/path`, issues);
  }
  if (value.line !== undefined && (!Number.isInteger(value.line) || value.line < 1)) {
    issue(issues, `${path}/line`, "must be a positive integer");
  }
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

export function assertCheckpointIdentity(checkpoint) {
  const issues = [];
  validateCheckpointIdentity(checkpoint, "/", issues);
  throwIssues("checkpoint identity", issues);
  return checkpoint;
}

export function assertWorkspace(workspace) {
  const issues = [];
  if (!requireObject(workspace, "/", issues)) throwIssues("workspace", issues);
  allowedKeys(workspace, [
    "projectRoot", "repositoryRoot", "projectRelativePath", "commonGitDir", "worktreeRoot",
    "executionRoot", "baseOid", "ownershipToken", "currentCheckpointId"
  ], "/", issues);
  const validPaths = {};
  for (const key of ["projectRoot", "repositoryRoot", "commonGitDir", "worktreeRoot", "executionRoot"]) {
    validPaths[key] = validateAbsolutePath(workspace[key], `/${key}`, issues);
  }
  const validProjectRelativePath = validateRelativePath(
    workspace.projectRelativePath,
    "/projectRelativePath",
    issues,
    { allowDot: true }
  );
  validateObjectId(workspace.baseOid, "/baseOid", issues);
  validateIdentifier(workspace.ownershipToken, "/ownershipToken", issues);
  if (workspace.currentCheckpointId !== undefined && workspace.currentCheckpointId !== null) {
    validateIdentifier(workspace.currentCheckpointId, "/currentCheckpointId", issues);
  }
  if (validPaths.projectRoot && validPaths.repositoryRoot && validProjectRelativePath) {
    const expectedProjectRoot = joinProjectPath(workspace.repositoryRoot, workspace.projectRelativePath);
    if (workspace.projectRoot !== expectedProjectRoot) {
      issue(issues, "/projectRoot", "must equal repositoryRoot joined with projectRelativePath");
    }
  }
  if (validPaths.executionRoot && validPaths.worktreeRoot && validProjectRelativePath) {
    const expectedExecutionRoot = joinProjectPath(workspace.worktreeRoot, workspace.projectRelativePath);
    if (workspace.executionRoot !== expectedExecutionRoot) {
      issue(issues, "/executionRoot", "must equal worktreeRoot joined with projectRelativePath");
    }
  }
  if (
    typeof workspace.executionRoot === "string"
    && typeof workspace.projectRoot === "string"
    && workspace.executionRoot === workspace.projectRoot
  ) {
    issue(issues, "/executionRoot", "must be separate from projectRoot");
  }
  if (
    typeof workspace.worktreeRoot === "string"
    && typeof workspace.repositoryRoot === "string"
    && (sameOrNestedPath(workspace.worktreeRoot, workspace.repositoryRoot)
      || sameOrNestedPath(workspace.repositoryRoot, workspace.worktreeRoot))
  ) {
    issue(issues, "/worktreeRoot", "must be separate from repositoryRoot");
  }
  throwIssues("workspace", issues);
  return workspace;
}

export function assertFileManifest(files) {
  const issues = [];
  validateFileManifest(files, "/", issues);
  throwIssues("file manifest", issues);
  return files;
}

export function assertAttempt(attempt) {
  const issues = [];
  if (!requireObject(attempt, "/", issues)) throwIssues("attempt", issues);
  allowedKeys(attempt, [
    "id", "stepIndex", "attempt", "status", "startedAt", "completedAt", "baseline", "result", "snapshot",
    "evidenceError"
  ], "/", issues);
  validateIdentifier(attempt.id, "/id", issues);
  if (!Number.isInteger(attempt.stepIndex) || attempt.stepIndex < 0) {
    issue(issues, "/stepIndex", "must be a non-negative integer");
  }
  if (!Number.isInteger(attempt.attempt) || attempt.attempt < 1) {
    issue(issues, "/attempt", "must be a positive integer");
  }
  if (!ATTEMPT_STATUSES.includes(attempt.status)) {
    issue(issues, "/status", `must be one of ${ATTEMPT_STATUSES.join(", ")}`);
  }
  validateTimestamp(attempt.startedAt, "/startedAt", issues);
  if (attempt.completedAt !== undefined) validateTimestamp(attempt.completedAt, "/completedAt", issues);
  validateCheckpointIdentity(attempt.baseline, "/baseline", issues, { allowRestorable: false, role: "baseline" });
  if (attempt.result !== undefined && attempt.result !== null) {
    validateCheckpointIdentity(attempt.result, "/result", issues, { role: "result" });
  }
  if (attempt.snapshot !== undefined && attempt.snapshot !== null) {
    if (requireObject(attempt.snapshot, "/snapshot", issues)) {
      allowedKeys(attempt.snapshot, ["files", "command"], "/snapshot", issues);
      validateFileManifest(attempt.snapshot.files, "/snapshot/files", issues);
      if (
        attempt.snapshot.command !== undefined
        && attempt.snapshot.command !== null
        && !isObject(attempt.snapshot.command)
      ) {
        issue(issues, "/snapshot/command", "must be an object or null");
      }
    }
  }
  if (Object.hasOwn(attempt, "evidenceError")) {
    if (requireObject(attempt.evidenceError, "/evidenceError", issues)) {
      allowedKeys(attempt.evidenceError, ["name", "message", "code"], "/evidenceError", issues);
      requireBoundedString(attempt.evidenceError.name, "/evidenceError/name", issues, 128);
      requireBoundedString(attempt.evidenceError.message, "/evidenceError/message", issues, 4096);
      if (attempt.evidenceError.code !== undefined) {
        validateIdentifier(attempt.evidenceError.code, "/evidenceError/code", issues);
      }
    }
    if (attempt.status !== "failed") {
      issue(issues, "/evidenceError", "is allowed only for a failed attempt");
    }
  }
  const evidenceFailure = attempt.status === "failed"
    && Object.hasOwn(attempt, "evidenceError");
  if (attempt.status === "running") {
    for (const key of ["completedAt", "result", "snapshot", "evidenceError"]) {
      if (Object.hasOwn(attempt, key)) issue(issues, `/${key}`, "is not allowed while running");
    }
  } else if (evidenceFailure) {
    if (attempt.completedAt === undefined || attempt.completedAt === null) {
      issue(issues, "/completedAt", "is required after running");
    }
    for (const key of ["result", "snapshot"]) {
      if (Object.hasOwn(attempt, key)) {
        issue(issues, `/${key}`, "must be absent when evidence capture failed");
      }
    }
  } else if (ATTEMPT_STATUSES.includes(attempt.status)) {
    for (const key of ["completedAt", "result", "snapshot"]) {
      if (attempt[key] === undefined || attempt[key] === null) issue(issues, `/${key}`, "is required after running");
    }
    if (isObject(attempt.result)) {
      if (attempt.status === "completed" && attempt.result.restorable !== true) {
        issue(issues, "/result/restorable", "must be true for a completed attempt");
      } else if (attempt.status !== "completed" && attempt.result.restorable === true) {
        issue(issues, "/result/restorable", `must not be true for a ${attempt.status} attempt`);
      }
    }
  }
  throwIssues("attempt", issues);
  return attempt;
}

export function assertAnnotation(annotation) {
  const issues = [];
  if (!requireObject(annotation, "/", issues)) throwIssues("annotation", issues);
  allowedKeys(annotation, ["id", "stepIndex", "attemptId", "kind", "text", "tags", "target", "createdAt"], "/", issues);
  validateIdentifier(annotation.id, "/id", issues);
  if (!Number.isInteger(annotation.stepIndex) || annotation.stepIndex < 0) {
    issue(issues, "/stepIndex", "must be a non-negative integer");
  }
  if (annotation.attemptId !== undefined) validateIdentifier(annotation.attemptId, "/attemptId", issues);
  if (annotation.kind !== undefined && !ANNOTATION_KINDS.includes(annotation.kind)) {
    issue(issues, "/kind", `must be one of ${ANNOTATION_KINDS.join(", ")}`);
  }
  requireBoundedString(annotation.text, "/text", issues, MAX_ANNOTATION_TEXT_LENGTH);
  if (annotation.tags !== undefined) {
    if (!Array.isArray(annotation.tags)) {
      issue(issues, "/tags", "must be an array");
    } else if (annotation.tags.length > MAX_ANNOTATION_TAGS) {
      issue(issues, "/tags", `must contain at most ${MAX_ANNOTATION_TAGS} tags`);
    } else {
      const seen = new Set();
      annotation.tags.forEach((tag, index) => {
        const tagPath = `/tags/${index}`;
        requireBoundedString(tag, tagPath, issues, MAX_TAG_LENGTH);
        if (seen.has(tag)) issue(issues, tagPath, "must be unique");
        seen.add(tag);
      });
    }
  }
  if (annotation.target !== undefined && annotation.target !== null) {
    validateAnnotationTarget(annotation.target, "/target", issues);
    if (
      isObject(annotation.target)
      && TARGET_TYPES.includes(annotation.target.type)
      && annotation.attemptId === undefined
    ) {
      issue(issues, "/attemptId", "is required when target is present");
    }
  }
  if (annotation.createdAt !== undefined) validateTimestamp(annotation.createdAt, "/createdAt", issues);
  throwIssues("annotation", issues);
  return annotation;
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
