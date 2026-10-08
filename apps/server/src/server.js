import http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { SessionEngine } from "../../../packages/execution-core/src/session-engine.js";
import { RecentProjectStore } from "../../../packages/execution-core/src/recent-project-store.js";
import { SessionStore } from "../../../packages/execution-core/src/session-store.js";
import { TerminalBuffer } from "../../../packages/execution-core/src/terminal-buffer.js";
import { decodeNdjson } from "../../../packages/adapter-sdk/src/index.js";
import { ProtocolValidationError, assertPlanInput, assertSessionInput, assertTraceEvent, assertWorkspace, publicSession } from "../../../packages/protocol/src/index.js";
import { resolveCommandCwd, resolveProjectRoot } from "../../../packages/project-adapters/src/project-boundary.js";
import { runConfirmedCommand } from "../../../packages/project-adapters/src/command-runner.js";
import {
  GitWorkspaceError,
  createBaselineCheckpoint,
  createResultCheckpoint,
  disposeManagedWorkspace,
  inspectGitRepository,
  prepareManagedWorkspace,
  readCheckpointFileDiff,
  restoreCheckpoint,
  validateManagedWorkspace,
} from "../../../packages/project-adapters/src/git-adapter.js";
import { inspectProject } from "../../../packages/project-adapters/src/project-inspector.js";
import {
  captureProjectSnapshot,
  checkpointAttemptSnapshot,
} from "../../../packages/project-adapters/src/snapshot.js";
import { PreviewProcessSupervisor } from "../../../packages/project-adapters/src/preview-process-supervisor.js";
import { manifest as prologManifest, prologAdapter } from "../../../packages/prolog-adapter/src/index.js";
import { allowedRoot, examplesRoot, port, projectRoot, stateRoot, webRoot, workspaceRoot } from "./config.js";

const mimeTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": mimeTypes[".json"] });
  response.end(JSON.stringify(body));
}

function rejectRequest(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

function structuredError(message, statusCode, code, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.appCode = code;
  if (details !== undefined) error.details = details;
  return error;
}

function requireExactEmptyObject(body, message) {
  if (
    body === null
    || Array.isArray(body)
    || typeof body !== "object"
    || Object.keys(body).length !== 0
  ) {
    throw new Error(message);
  }
}

function exactDiffPath(search) {
  if (!search.startsWith("?") || search.slice(1).split("&").length !== 1) {
    rejectRequest("Diff query must contain exactly one path parameter", 400);
  }
  const [rawName, rawValue, ...extra] = search.slice(1).split("=");
  if (rawName !== "path" || rawValue === undefined || extra.length > 0) {
    rejectRequest("Diff query must contain exactly one path parameter", 400);
  }
  let filePath;
  try {
    filePath = decodeURIComponent(rawValue);
  } catch {
    rejectRequest("Diff path encoding is malformed", 400);
  }
  const segments = filePath.split("/");
  if (
    filePath === ""
    || filePath.includes("\0")
    || filePath.includes("\\")
    || path.posix.isAbsolute(filePath)
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    rejectRequest("Diff path is not safe", 400);
  }
  return filePath;
}

function validateRequestOrigin(request) {
  const host = request.headers.host;
  let serviceOrigin;
  try {
    serviceOrigin = new URL(`http://${host}`);
  } catch {
    rejectRequest("Invalid Host header", 403);
  }
  const hostname = serviceOrigin.hostname.toLowerCase();
  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  const authorityOnly = serviceOrigin.pathname === "/" && !serviceOrigin.search && !serviceOrigin.hash
    && !serviceOrigin.username && !serviceOrigin.password;
  const requestedPort = Number(serviceOrigin.port || 80);
  if (!host || !loopback || !authorityOnly || requestedPort !== request.socket.localPort) {
    rejectRequest("Host must match this loopback server and listening port", 403);
  }
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== serviceOrigin.origin) {
    rejectRequest("Origin must exactly match this service origin", 403);
  }
  return serviceOrigin;
}

function requireJsonContentType(request) {
  const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") rejectRequest("Request requires application/json", 415);
}

async function readJson(request, limit = 1024 * 1024) {
  requireJsonContentType(request);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) { const error = new Error("Request body exceeds 1 MB"); error.statusCode = 413; throw error; }
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function requireTraceContentType(request) {
  const contentType = request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
  if (contentType === "application/json" || contentType === "application/x-ndjson" || contentType === "application/ndjson") return contentType;
  rejectRequest("Trace ingestion requires application/json, application/x-ndjson, or application/ndjson", 415);
}

async function* readTraceEvents(request) {
  const contentType = requireTraceContentType(request);
  if (contentType === "application/x-ndjson" || contentType === "application/ndjson") {
    yield* decodeNdjson(request);
    return;
  }
  const body = await readJson(request);
  for (const value of Array.isArray(body) ? body : [body]) yield assertTraceEvent(value);
}

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(webRoot, requested);
  const relative = path.relative(webRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, { "content-type": mimeTypes[path.extname(filePath)] ?? "application/octet-stream" });
    response.end(content);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function traceSteps(trace) {
  return trace.map((item, index) => ({
    id: item.id ?? `trace-${index + 1}`,
    title: item.title ?? `Evaluation ${index + 1}`,
    description: item.explanation ?? "",
    traceState: item.state,
    traceKind: item.kind ?? "evaluation"
  }));
}

function executionProjectRoot(session) {
  return session.workspace?.executionRoot ?? session.projectRoot;
}

function normalizeWorkspace(workspace) {
  const {
    sessionId: _sessionId,
    currentCheckpointId = "initial",
    ...publicFields
  } = workspace;
  return assertWorkspace({
    ...publicFields,
    currentCheckpointId,
  });
}

async function validatePreparedWorkspace(session, workspace) {
  assertWorkspace(workspace);
  const inspection = await inspectGitRepository(session.projectRoot);
  const expectedExecutionRoot = await resolveCommandCwd(
    workspace.worktreeRoot,
    inspection.projectRelativePath,
  );
  const mismatches = [];
  for (const [field, expected] of Object.entries({
    projectRoot: inspection.projectRoot,
    repositoryRoot: inspection.repositoryRoot,
    projectRelativePath: inspection.projectRelativePath,
    commonGitDir: inspection.commonGitDir,
    baseOid: inspection.headOid,
  })) {
    if (workspace[field] !== expected) {
      mismatches.push({ field, expected, actual: workspace[field] ?? null });
    }
  }
  if (workspace.executionRoot !== expectedExecutionRoot) {
    mismatches.push({
      field: "executionRoot",
      expected: expectedExecutionRoot,
      actual: workspace.executionRoot ?? null,
    });
  }
  if (mismatches.length > 0) {
    throw structuredError(
      "Prepared workspace is no longer valid for this source repository",
      409,
      "workspace_invalid",
      mismatches,
    );
  }
}

export async function createApp(options = {}) {
  const runtime = {
    allowedRoot: options.allowedRoot ?? allowedRoot,
    stateRoot: options.stateRoot ?? stateRoot,
    workspaceRoot: options.workspaceRoot ?? workspaceRoot,
    warn: options.warn ?? console.warn
  };
  const engine = new SessionEngine();
  const store = new SessionStore(runtime.stateRoot);
  const runCommand = options.runCommand ?? runConfirmedCommand;
  const workspaceAdapter = {
    prepare: prepareManagedWorkspace,
    createBaseline: createBaselineCheckpoint,
    createResult: createResultCheckpoint,
    diff: readCheckpointFileDiff,
    restore: restoreCheckpoint,
    validate: async (preparedWorkspace, { session, sessionId }) => {
      await validateManagedWorkspace(preparedWorkspace, { sessionId });
      return validatePreparedWorkspace(session, preparedWorkspace);
    },
    dispose: disposeManagedWorkspace,
    ...options.workspaceAdapter,
  };
  const recoverableWorkspaceAdapter = options.workspaceAdapter == null
    || ["createBaseline", "createResult", "restore"].every((method) => (
      typeof options.workspaceAdapter?.[method] === "function"
    ));
  const terminal = options.terminal ?? new TerminalBuffer();
  const previews = options.previews ?? new PreviewProcessSupervisor({ terminal });
  const recentProjects = new RecentProjectStore(path.join(runtime.stateRoot, "..", "recent-projects.json"), { warn: runtime.warn });
  const events = new EventEmitter();
  const runningSessions = new Set();
  const restoringSessions = new Set();
  const activePreviewOperations = new Map();
  const activeStepControllers = new Map();
  const activeStepRequests = new Set();
  const activeSseStreams = new Set();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15000;
  let shuttingDown = false;
  await store.initialize();

  const emit = (session) => events.emit(`session:${session.id}`, publicSession(session));
  const claimSession = (id, message = "Session already has an active operation") => {
    if (runningSessions.has(id)) { const error = new Error(message); error.statusCode = 409; throw error; }
    runningSessions.add(id);
    return () => runningSessions.delete(id);
  };
  const claimPreviewOperation = (id) => {
    if (restoringSessions.has(id)) {
      throw structuredError(
        "Cannot change preview lifecycle while a restore is active",
        409,
        "operation_active",
      );
    }
    activePreviewOperations.set(id, (activePreviewOperations.get(id) ?? 0) + 1);
    return () => {
      const remaining = (activePreviewOperations.get(id) ?? 1) - 1;
      if (remaining > 0) activePreviewOperations.set(id, remaining);
      else activePreviewOperations.delete(id);
    };
  };
  const claimRestore = (id) => {
    const releaseSession = claimSession(id);
    if ((activePreviewOperations.get(id) ?? 0) > 0) {
      releaseSession();
      throw structuredError(
        "Cannot restore while a preview lifecycle operation is active",
        409,
        "preview_active",
      );
    }
    restoringSessions.add(id);
    return () => {
      restoringSessions.delete(id);
      releaseSession();
    };
  };
  const requireSession = async (id) => {
    const session = await store.get(id);
    if (!session) { const error = new Error("Session not found"); error.statusCode = 404; throw error; }
    return session;
  };
  const requireMigrationSession = async (id) => {
    const session = await requireSession(id);
    if (session.workbench !== "migration") rejectRequest("Preview runtime requires a Migration session", 400);
    return session;
  };
  const requirePreparedWorkspace = (session, message = "A prepared workspace is required for this operation") => {
    if (session.workspace == null) {
      throw structuredError(message, 409, "workspace_required");
    }
    return session.workspace;
  };
  const runtimeSnapshot = async (session) => ({
    ...await previews.snapshot(session),
    ...terminal.snapshot(session.id),
  });
  const activeAttempt = (id, index, attempt) => {
    const active = activeStepControllers.get(id);
    return active?.index === index && active.attempt === attempt ? active : null;
  };
  const checkpointTarget = (session, checkpointId) => {
    if (checkpointId === "initial") {
      const first = session.attempts?.[0]?.baseline;
      return first && first.oid === session.workspace?.baseOid
        ? { ...first, accepted: true }
        : null;
    }
    const attempt = session.attempts?.find((candidate) => (
      candidate.id === checkpointId
      && candidate.status === "completed"
      && candidate.result?.restorable === true
    ));
    return attempt ? { ...attempt.result, accepted: true } : null;
  };
  const requireExactRetryConfirmation = (body, session, previousAttempt) => {
    if (
      body?.confirmedRestore !== true
      || body.expectedAttemptId !== previousAttempt.id
      || body.expectedBaselineOid !== previousAttempt.baseline.oid
      || body.expectedExecutionRoot !== session.workspace.executionRoot
    ) {
      throw structuredError(
        "Retry requires exact baseline restore confirmation",
        409,
        "retry_confirmation_mismatch",
      );
    }
  };
  const reconciliationError = async (workspace, expectedOid) => {
    const observed = await inspectGitRepository(workspace.worktreeRoot)
      .then((inspection) => inspection.headOid)
      .catch(() => null);
    return structuredError(
      "Workspace changed but Session persistence failed; reconciliation is required",
      409,
      "reconciliation_required",
      { expected: expectedOid, observed },
    );
  };
  const errorEvidence = (error) => {
    const name = typeof error?.name === "string" && error.name.trim()
      ? error.name.slice(0, 128)
      : "Error";
    const message = typeof error?.message === "string" && error.message.trim()
      ? error.message.slice(0, 4096)
      : "Result checkpoint capture failed";
    const code = typeof error?.code === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(error.code)
      ? error.code
      : null;
    return { name, message, ...(code ? { code } : {}) };
  };
  const evidenceReconciliationError = async (
    workspace,
    { sessionId, attemptId, captureError, persistenceError = null },
  ) => {
    const observed = await inspectGitRepository(workspace.worktreeRoot)
      .then((inspection) => inspection.headOid)
      .catch(() => null);
    return structuredError(
      "Result evidence capture failed; reconciliation is required",
      409,
      "reconciliation_required",
      {
        expected: {
          ref: `refs/dev-workbench/checkpoints/${sessionId}/${attemptId}/result`,
          oid: null,
        },
        observed,
        captureError: {
          ...errorEvidence(captureError),
        },
        ...(persistenceError ? {
          persistenceError: {
            ...errorEvidence(persistenceError),
          },
        } : {}),
      },
    );
  };

  async function createSession(input) {
    assertSessionInput(input);
    const candidateRoot = path.isAbsolute(input.projectRoot)
      ? input.projectRoot
      : path.join(runtime.allowedRoot, input.projectRoot);
    const resolvedRoot = await resolveProjectRoot(candidateRoot, runtime.allowedRoot);
    const steps = input.trace ? traceSteps(input.trace) : input.steps ?? [];
    const session = engine.create({ ...input, projectRoot: resolvedRoot, steps });
    if (input.trace?.length) {
      for (let index = 0; index < session.steps.length; index += 1) {
        engine.startStep(session, index);
        engine.completeStep(session, index, { trace: session.steps[index].traceState });
      }
      engine.seek(session, 0);
    }
    await store.save(session);
    try {
      await recentProjects.record({ projectRoot: resolvedRoot, workbench: input.workbench });
    } catch (error) {
      runtime.warn(`Could not record recent project ${resolvedRoot}: ${error.message}`);
    }
    emit(session);
    return publicSession(session);
  }

  async function createExample(name) {
    if (!/^[a-z-]+$/.test(name)) throw new Error("Invalid example name");
    const input = JSON.parse(await fs.readFile(path.join(examplesRoot, name, "session.json"), "utf8"));
    input.projectRoot = path.join(examplesRoot, name);
    const session = await createSession(input);
    if (name !== "logic-trace") return session;

    const sourcePath = path.join(examplesRoot, name, input.metadata.sourceFile);
    const source = await fs.readFile(sourcePath, "utf8");
    const stored = await requireSession(session.id);
    engine.startTraceStream(stored); await store.save(stored); emit(stored);
    try {
      for await (const traceEvent of prologAdapter.run({
        sessionId: stored.id, source, sourcePath: input.metadata.sourceFile, query: input.metadata.query
      })) {
        engine.appendTraceEvent(stored, traceEvent); await store.save(stored); emit(stored);
      }
      engine.finishTraceStream(stored); await store.save(stored); emit(stored);
      return publicSession(stored);
    } catch (error) {
      engine.finishTraceStream(stored, error); await store.save(stored); emit(stored);
      throw error;
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, validateRequestOrigin(request));
      const pathname = url.pathname;
      if (request.method === "GET" && pathname === "/api/health") return sendJson(response, 200, { ok: true, version: "0.1.0", allowedRoot: runtime.allowedRoot });
      if (request.method === "GET" && pathname === "/api/adapters") return sendJson(response, 200, [prologManifest]);
      if (request.method === "GET" && pathname === "/api/projects/recent") {
        try {
          return sendJson(response, 200, await recentProjects.list());
        } catch (error) {
          runtime.warn(`Could not read recent projects ${recentProjects.filePath}: ${error.message}`);
          return sendJson(response, 200, []);
        }
      }
      if (request.method === "POST" && pathname === "/api/projects/inspect") {
        const body = await readJson(request);
        if (typeof body.projectRoot !== "string" || !body.projectRoot.trim()) throw new Error("projectRoot must be a non-empty string");
        const candidateRoot = path.isAbsolute(body.projectRoot)
          ? body.projectRoot
          : path.join(runtime.allowedRoot, body.projectRoot);
        const resolvedRoot = await resolveProjectRoot(candidateRoot, runtime.allowedRoot);
        return sendJson(response, 200, await inspectProject(resolvedRoot));
      }
      if (request.method === "GET" && pathname === "/api/sessions") {
        const sessions = await store.list();
        return sendJson(response, 200, sessions.map(({ snapshots, events: sessionEvents, ...session }) => ({ ...session, snapshotCount: snapshots.length, eventCount: sessionEvents.length })));
      }
      if (request.method === "POST" && pathname === "/api/sessions") return sendJson(response, 201, await createSession(await readJson(request)));

      const exampleMatch = pathname.match(/^\/api\/examples\/(logic-trace|migration-demo)$/);
      if (request.method === "POST" && exampleMatch) {
        requireJsonContentType(request);
        return sendJson(response, 201, await createExample(exampleMatch[1]));
      }

      const sessionMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)$/i);
      const workspacePrepareMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)\/workspace\/prepare$/i);
      const planMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)\/plan$/i);
      if (request.method === "PUT" && planMatch) {
        const id = planMatch[1];
        const release = claimSession(id);
        try {
          if (options.afterSessionClaim) await options.afterSessionClaim({ id, operation: "plan" });
          const body = await readJson(request);
          const session = await requireSession(id);
          assertPlanInput(body);
          engine.replacePlan(session, body.steps);
          await store.save(session); emit(session);
          return sendJson(response, 200, publicSession(session));
        } finally { release(); }
      }
      if (request.method === "GET" && sessionMatch) return sendJson(response, 200, publicSession(await requireSession(sessionMatch[1])));
      if (request.method === "POST" && workspacePrepareMatch) {
        const id = workspacePrepareMatch[1];
        const release = claimSession(id);
        try {
          if (options.afterSessionClaim) await options.afterSessionClaim({ id, operation: "workspace" });
          const body = await readJson(request);
          requireExactEmptyObject(body, "Workspace prepare body must be an empty object");
          const session = await requireMigrationSession(id);
          if (session.workspace != null) {
            await workspaceAdapter.validate(session.workspace, { session, sessionId: session.id });
            return sendJson(response, 200, publicSession(session));
          }
          const previousWorkspace = session.workspace;
          const previousEvents = session.events;
          const previousUpdatedAt = session.updatedAt;
          const preparedWorkspace = normalizeWorkspace(await workspaceAdapter.prepare({
            projectRoot: session.projectRoot,
            workspaceRoot: runtime.workspaceRoot,
            sessionId: session.id,
            ownershipToken: randomUUID(),
          }));
          session.workspace = preparedWorkspace;
          session.events = [...session.events, {
            id: randomUUID(),
            type: "workspace.prepared",
            at: new Date().toISOString(),
          }];
          session.updatedAt = new Date().toISOString();
          try {
            await store.save(session);
          } catch (error) {
            session.workspace = previousWorkspace;
            session.events = previousEvents;
            session.updatedAt = previousUpdatedAt;
            try {
              await workspaceAdapter.dispose(preparedWorkspace, { sessionId: session.id });
            } catch (disposeError) {
              error.cause ??= disposeError;
              runtime.warn(`Could not dispose unpersisted workspace for session ${id}: ${disposeError.message}`);
            }
            throw error;
          }
          emit(session);
          return sendJson(response, 200, publicSession(session));
        } finally { release(); }
      }

      const eventMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)\/events$/i);
      if (request.method === "GET" && eventMatch) {
        const session = await requireSession(eventMatch[1]);
        if (shuttingDown) rejectRequest("Server is shutting down", 503);
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
        const send = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
        const listener = (value) => send(value);
        events.on(`session:${session.id}`, listener);
        const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), heartbeatIntervalMs);
        let cleanedUp = false;
        const stream = { response, cleanup };
        function cleanup() {
          if (cleanedUp) return;
          cleanedUp = true;
          clearInterval(heartbeat);
          events.off(`session:${session.id}`, listener);
          activeSseStreams.delete(stream);
        }
        activeSseStreams.add(stream);
        response.once("close", cleanup);
        send(publicSession(session));
        return;
      }

      const diffMatch = pathname.match(
        /^\/api\/sessions\/([a-f0-9-]+)\/attempts\/([A-Za-z0-9._-]+)\/diff$/,
      );
      if (diffMatch) {
        if (request.method !== "GET") {
          response.setHeader("allow", "GET");
          return sendJson(response, 405, { error: "Method not allowed" });
        }
        const requestedPath = exactDiffPath(url.search);
        const session = await requireSession(diffMatch[1]);
        const attempt = session.attempts?.find((candidate) => candidate.id === diffMatch[2]);
        if (!attempt) throw structuredError("Attempt not found", 404, "attempt_not_found");
        if (!attempt.result || !attempt.snapshot?.files) {
          throw structuredError(
            "Attempt result evidence is unavailable",
            409,
            "missing_evidence",
            attempt.evidenceError,
          );
        }
        const file = attempt.snapshot.files.find((candidate) => candidate.path === requestedPath);
        if (!file) {
          throw structuredError("Path is not present in the attempt manifest", 404, "path_not_in_manifest");
        }
        const workspace = requirePreparedWorkspace(
          session,
          "A prepared workspace is required to read attempt evidence",
        );
        return sendJson(response, 200, await workspaceAdapter.diff(
          { ...workspace, sessionId: session.id },
          {
            sessionId: session.id,
            attemptId: attempt.id,
            baseline: attempt.baseline,
            result: attempt.result,
            file,
          },
        ));
      }

      const runtimeMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)\/runtime$/i);
      if (request.method === "GET" && runtimeMatch) {
        const session = await requireMigrationSession(runtimeMatch[1]);
        return sendJson(response, 200, await runtimeSnapshot(session));
      }

      const runtimeEventMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)\/runtime\/events$/i);
      if (request.method === "GET" && runtimeEventMatch) {
        const session = await requireMigrationSession(runtimeEventMatch[1]);
        if (shuttingDown) rejectRequest("Server is shutting down", 503);
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
        const send = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
        const pendingEvents = [];
        let snapshotSent = false;
        const sendIncremental = (value) => {
          if (snapshotSent) send(value);
          else pendingEvents.push(value);
        };
        const unsubscribePreview = previews.subscribe(session.id, sendIncremental);
        const unsubscribeTerminal = terminal.subscribe(session.id, sendIncremental);
        const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), heartbeatIntervalMs);
        let cleanedUp = false;
        const stream = { response, cleanup: null };
        const cleanup = () => {
          if (cleanedUp) return;
          cleanedUp = true;
          clearInterval(heartbeat);
          unsubscribePreview();
          unsubscribeTerminal();
          activeSseStreams.delete(stream);
        };
        stream.cleanup = cleanup;
        activeSseStreams.add(stream);
        response.once("close", cleanup);
        try {
          const snapshot = await runtimeSnapshot(session);
          send({ type: "runtime.snapshot", ...snapshot });
          snapshotSent = true;
          for (const event of pendingEvents) {
            const capturedTerminal = event.type === "terminal.output"
              && event.sequence <= snapshot.latestSequence;
            const capturedPreview = event.type === "preview.state"
              && Number.isInteger(event.sequence)
              && event.sequence <= snapshot[event.slot]?.latestSequence;
            if (!capturedTerminal && !capturedPreview) send(event);
          }
          pendingEvents.length = 0;
        } catch (error) {
          cleanup();
          throw error;
        }
        return;
      }

      const previewMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)\/previews\/(source|target)\/(start|stop|restart)$/);
      if (request.method === "POST" && previewMatch) {
        if (shuttingDown) rejectRequest("Server is shutting down", 503);
        const id = previewMatch[1];
        const slot = previewMatch[2];
        const action = previewMatch[3];
        const body = await readJson(request);
        requireExactEmptyObject(body, "Preview lifecycle body must be an empty object");
        const session = await requireMigrationSession(id);
        requirePreparedWorkspace(session, "A prepared workspace is required before preview lifecycle actions");
        const release = claimPreviewOperation(id);
        try {
          const result = action === "stop"
            ? await previews.stop(session.id, slot)
            : await previews[action](session, slot);
          return sendJson(response, 200, result);
        } finally {
          release();
        }
      }

      const traceMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)\/trace$/i);
      if (request.method === "POST" && traceMatch) {
        requireTraceContentType(request);
        const id = traceMatch[1];
        const release = claimSession(id);
        try {
          if (options.afterSessionClaim) await options.afterSessionClaim({ id, operation: "trace" });
          const session = await requireSession(id);
          let accepted = 0;
          let started = false;
          try {
            engine.startTraceStream(session); started = true; await store.save(session); emit(session);
            for await (const traceEvent of readTraceEvents(request)) {
              engine.appendTraceEvent(session, traceEvent);
              await store.save(session); emit(session);
              accepted += 1;
            }
            engine.finishTraceStream(session); await store.save(session); emit(session);
            return sendJson(response, 202, { accepted, nextSequence: session.steps.length, status: session.status });
          } catch (error) {
            if (started) { engine.finishTraceStream(session, error); await store.save(session); emit(session); }
            error.accepted = accepted;
            throw error;
          }
        } finally { release(); }
      }

      const seekMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)\/seek$/i);
      if (request.method === "POST" && seekMatch) {
        const id = seekMatch[1];
        const release = claimSession(id);
        try {
          if (options.afterSessionClaim) await options.afterSessionClaim({ id, operation: "seek" });
          const session = await requireSession(id);
          const body = await readJson(request);
          engine.seek(session, body.stepIndex);
          await store.save(session); emit(session);
          return sendJson(response, 200, publicSession(session));
        } finally { release(); }
      }

      const noteMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)\/annotations$/i);
      if (request.method === "POST" && noteMatch) {
        const id = noteMatch[1];
        const release = claimSession(id);
        try {
          if (options.afterSessionClaim) await options.afterSessionClaim({ id, operation: "annotation" });
          const session = await requireSession(id);
          engine.annotate(session, await readJson(request));
          await store.save(session); emit(session);
          return sendJson(response, 201, publicSession(session));
        } finally { release(); }
      }

      const reviewMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)\/steps\/(\d+)\/review$/i);
      if (request.method === "POST" && reviewMatch) {
        const id = reviewMatch[1];
        const release = claimSession(id);
        try {
          if (options.afterSessionClaim) await options.afterSessionClaim({ id, operation: "review" });
          const body = await readJson(request);
          if (
            body === null
            || Array.isArray(body)
            || typeof body !== "object"
            || Object.keys(body).length !== 1
            || !Object.hasOwn(body, "decision")
            || !["accept", "reject"].includes(body.decision)
          ) {
            throw new Error('Review body must be exactly {"decision":"accept"} or {"decision":"reject"}');
          }
          const session = await requireSession(id);
          const index = Number(reviewMatch[2]);
          if (body.decision === "accept" && session.workspace != null) {
            const step = engine.requireStep(session, index);
            const attempt = session.attempts?.find((candidate) => (
              candidate.stepIndex === index
              && candidate.attempt === step.attempt
              && candidate.status === "awaiting_review"
            ));
            if (attempt) {
              await workspaceAdapter.validate(session.workspace, { session, sessionId: session.id });
              const inspection = await inspectGitRepository(session.workspace.worktreeRoot);
              if (inspection.dirty.length > 0 || inspection.headOid !== attempt.result.oid) {
                throw structuredError(
                  "Recoverable result evidence no longer matches the managed worktree",
                  409,
                  "review_evidence_mismatch",
                  {
                    expected: attempt.result.oid,
                    observed: inspection.headOid,
                    dirty: inspection.dirty,
                  },
                );
              }
            }
          }
          engine.reviewStep(session, index, body.decision);
          await store.save(session); emit(session);
          return sendJson(response, 200, publicSession(session));
        } finally { release(); }
      }

      const cancelMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)\/steps\/(\d+)\/cancel$/i);
      if (request.method === "POST" && cancelMatch) {
        if (shuttingDown) {
          throw structuredError("Command attempt is already finishing", 409, "finishing");
        }
        const id = cancelMatch[1];
        const index = Number(cancelMatch[2]);
        const body = await readJson(request);
        if (
          body === null
          || Array.isArray(body)
          || typeof body !== "object"
          || Object.keys(body).length !== 1
          || !Number.isInteger(body.attempt)
          || body.attempt < 1
        ) {
          throw new Error('Cancel body must be exactly {"attempt":<positive integer>}');
        }
        const active = activeAttempt(id, index, body.attempt);
        if (!active) {
          throw structuredError("No matching active command attempt", 409, "attempt_not_active");
        }
        if (active.phase !== "running") {
          throw structuredError("Command attempt is already finishing", 409, "finishing");
        }
        active.phase = "cancelling";
        active.cancelReason = "user";
        active.controller.abort("user");
        return sendJson(response, 202, {
          status: "cancelling",
          stepIndex: index,
          attempt: body.attempt,
        });
      }

      const restoreMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)\/checkpoints\/([A-Za-z0-9._-]+)\/restore$/);
      if (request.method === "POST" && restoreMatch) {
        const id = restoreMatch[1];
        const checkpointId = restoreMatch[2];
        const release = claimRestore(id);
        try {
          if (options.afterSessionClaim) await options.afterSessionClaim({ id, operation: "restore" });
          const body = await readJson(request);
          if (
            body === null
            || Array.isArray(body)
            || typeof body !== "object"
            || Object.keys(body).length !== 3
            || body.confirmed !== true
            || typeof body.expectedOid !== "string"
            || typeof body.expectedExecutionRoot !== "string"
          ) {
            throw new Error("Restore requires confirmed, expectedOid, and expectedExecutionRoot");
          }
          const session = await requireMigrationSession(id);
          const workspace = requirePreparedWorkspace(session);
          if (activeStepControllers.has(id)) {
            throw structuredError("Cannot restore while a command is active", 409, "operation_active");
          }
          const previewState = await previews.snapshot(session);
          if (["source", "target"].some((slot) => (
            !["stopped", "unconfigured"].includes(previewState[slot]?.state)
          ))) {
            throw structuredError("Cannot restore while previews are active", 409, "preview_active");
          }
          const target = checkpointTarget(session, checkpointId);
          if (
            !target
            || target.oid !== body.expectedOid
            || workspace.executionRoot !== body.expectedExecutionRoot
          ) {
            throw structuredError("Restore target confirmation does not match", 409, "restore_confirmation_mismatch");
          }
          await workspaceAdapter.validate(workspace, { session, sessionId: session.id });
          await workspaceAdapter.restore(
            { ...workspace, sessionId: session.id },
            target,
          );
          engine.restore(session, checkpointId);
          try {
            await store.save(session);
          } catch (error) {
            throw await reconciliationError(workspace, target.oid);
          }
          emit(session);
          return sendJson(response, 200, publicSession(session));
        } finally { release(); }
      }

      const runMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)\/steps\/(\d+)\/run$/i);
      if (request.method === "POST" && runMatch) {
        if (shuttingDown) rejectRequest("Server is shutting down", 503);
        const id = runMatch[1];
        let finishStepRequest;
        const stepRequestDone = new Promise((resolve) => { finishStepRequest = resolve; });
        activeStepRequests.add(stepRequestDone);
        const finish = () => {
          activeStepRequests.delete(stepRequestDone);
          finishStepRequest();
        };
        response.once("finish", finish);
        response.once("close", finish);
        const release = claimSession(id, "Session already has a running step");
        try {
          if (options.afterSessionClaim) await options.afterSessionClaim({ id, operation: "run" });
          const body = await readJson(request);
          const session = await requireSession(id);
          const index = Number(runMatch[2]);
          if (index !== engine.nextRunnable(session)) throw new Error("Steps must run in plan order");
          const step = engine.requireStep(session, index);
          const projectExecutionRoot = executionProjectRoot(session);
          if (step.action && session.workbench === "migration") {
            requirePreparedWorkspace(session, "A prepared workspace is required before running migration actions");
          }
          if (step.risk === "high" && body.confirmedRisk !== true) throw new Error("High-risk execution requires confirmedRisk=true");
          if (step.action && body.confirmed !== true) throw new Error("Command execution requires confirmed=true");
          let baseline = null;
          let attemptId = null;
          let attemptNumber = null;
          let active = null;
          let finalCheckpoint = null;
          let checkpointCaptureError = null;
          try {
            const recoverable = Boolean(
              step.action
              && session.workbench === "migration"
              && session.workspace
              && recoverableWorkspaceAdapter
            );
            if (recoverable) {
              await workspaceAdapter.validate(session.workspace, { session, sessionId: session.id });
              const previousAttempt = [...session.attempts]
                .reverse()
                .find((candidate) => candidate.stepIndex === index);
              if (["failed", "cancelled"].includes(step.status)) {
                if (!previousAttempt) throw new Error("Retry baseline evidence is missing");
                requireExactRetryConfirmation(body, session, previousAttempt);
                await workspaceAdapter.restore(
                  { ...session.workspace, sessionId: session.id },
                  { ...previousAttempt.baseline, accepted: true },
                );
              }
              attemptId = `attempt-${session.attempts.length + 1}`;
              baseline = await workspaceAdapter.createBaseline(
                { ...session.workspace, sessionId: session.id },
                { sessionId: session.id, attemptId },
              );
              engine.startStep(session, index, { id: attemptId, baseline });
              attemptNumber = session.steps[index].attempt;
            } else {
              engine.startStep(session, index);
              baseline = index > 0 ? session.snapshots[index - 1] : await captureProjectSnapshot(projectExecutionRoot);
            }
            await store.save(session); emit(session);
            let result = null;
            if (step.action) {
              const controller = new AbortController();
              active = {
                controller,
                index,
                attempt: attemptNumber ?? session.steps[index].attempt,
                phase: "running",
                cancelReason: null,
              };
              activeStepControllers.set(id, active);
              if (shuttingDown) controller.abort("shutdown");
              try {
                result = await runCommand(projectExecutionRoot, step.action, {
                  signal: controller.signal,
                  onOutput: ({ stream, text }) => terminal.append(id, {
                    source: `step:${index}`,
                    stream,
                    text,
                  }),
                });
              } finally {
                active.phase = "finishing";
              }
            }
            if (attemptId) {
              try {
                finalCheckpoint = await workspaceAdapter.createResult(
                  { ...session.workspace, sessionId: session.id },
                  { sessionId: session.id, attemptId, baseline },
                );
              } catch (error) {
                checkpointCaptureError = error;
                throw error;
              }
              const snapshot = checkpointAttemptSnapshot(finalCheckpoint.files, result, {
                projectRelativePath: session.workspace.projectRelativePath,
              });
              engine.completeStep(session, index, snapshot, {
                oid: finalCheckpoint.oid,
                ref: finalCheckpoint.ref,
              });
            } else {
              const snapshot = step.traceState
                ? { trace: step.traceState }
                : await captureProjectSnapshot(projectExecutionRoot, baseline, result);
              engine.completeStep(session, index, snapshot);
            }
            await store.save(session); emit(session);
            return sendJson(response, 200, publicSession(session));
          } catch (error) {
            if (
              attemptId
              && finalCheckpoint
              && session.steps[index]?.status !== "running"
              && error.code !== "reconciliation_required"
            ) {
              throw await reconciliationError(session.workspace, finalCheckpoint.oid);
            }
            if (session.steps[index]?.status === "running") {
              if (error.name === "AbortError" && active?.cancelReason === "shutdown") {
                error.message = "Command aborted by server shutdown";
              }
              let snapshot = null;
              let resultCheckpoint = null;
              if (attemptId && checkpointCaptureError == null) {
                try {
                  active && (active.phase = "finishing");
                  resultCheckpoint = await workspaceAdapter.createResult(
                    { ...session.workspace, sessionId: session.id },
                    { sessionId: session.id, attemptId, baseline },
                  );
                  snapshot = checkpointAttemptSnapshot(resultCheckpoint.files, error.result ?? null, {
                    projectRelativePath: session.workspace.projectRelativePath,
                  });
                } catch (snapshotError) {
                  checkpointCaptureError = snapshotError;
                  runtime.warn(`Could not capture failed command snapshot for session ${id}: ${snapshotError.message}`);
                }
              } else if (error.result) {
                try {
                  snapshot = await captureProjectSnapshot(projectExecutionRoot, baseline, error.result);
                } catch (snapshotError) {
                  runtime.warn(`Could not capture failed command snapshot for session ${id}: ${snapshotError.message}`);
                }
              }
              if (attemptId && checkpointCaptureError) {
                const evidenceError = errorEvidence(checkpointCaptureError);
                const terminalError = Object.assign(new Error(evidenceError.message), {
                  name: evidenceError.name,
                });
                engine.failStep(
                  session,
                  index,
                  terminalError,
                  null,
                  null,
                  evidenceError,
                );
                let persistenceError = null;
                try {
                  await store.save(session);
                  emit(session);
                } catch (saveError) {
                  persistenceError = saveError;
                }
                throw await evidenceReconciliationError(session.workspace, {
                  sessionId: session.id,
                  attemptId,
                  captureError: checkpointCaptureError,
                  persistenceError,
                });
              }
              try {
                if (attemptId && resultCheckpoint) {
                  if (error.name === "AbortError" && active?.cancelReason === "user") {
                    engine.cancelStep(
                      session,
                      index,
                      attemptNumber,
                      snapshot,
                      { oid: resultCheckpoint.oid, ref: resultCheckpoint.ref },
                      error,
                    );
                  } else {
                    engine.failStep(
                      session,
                      index,
                      error,
                      snapshot,
                      { oid: resultCheckpoint.oid, ref: resultCheckpoint.ref },
                    );
                  }
                } else {
                  engine.failStep(session, index, error, snapshot);
                }
                try {
                  await store.save(session);
                } catch (saveError) {
                  if (resultCheckpoint) {
                    throw await reconciliationError(session.workspace, resultCheckpoint.oid);
                  }
                  throw saveError;
                }
                emit(session);
              } catch (failureError) {
                if (failureError.appCode === "reconciliation_required") throw failureError;
                runtime.warn(`Could not persist failed step for session ${id}: ${failureError.message}`);
              }
            }
            throw error;
          } finally {
            if (activeStepControllers.get(id) === active) activeStepControllers.delete(id);
          }
        } finally { release(); }
      }

      if (request.method === "GET" && await serveStatic(response, pathname)) return;
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const details = error instanceof ProtocolValidationError
        ? error.issues
        : error instanceof GitWorkspaceError
          ? error.diagnostics
          : error.details;
      const code = error.appCode ?? (error instanceof GitWorkspaceError ? error.code : undefined);
      sendJson(response, error.statusCode ?? 400, {
        error: error.message,
        ...(code ? { code } : {}),
        ...(details ? { details } : {}),
        ...(Number.isInteger(error.accepted) ? { accepted: error.accepted } : {})
      });
    }
  });

  const originalClose = server.close.bind(server);
  const closeCallbacks = [];
  let shutdownPromise = null;
  server.close = (callback) => {
    if (typeof callback === "function") closeCallbacks.push(callback);
    if (!shutdownPromise) {
      shuttingDown = true;
      for (const active of activeStepControllers.values()) {
        active.cancelReason = "shutdown";
        active.controller.abort("shutdown");
      }
      for (const stream of [...activeSseStreams]) {
        stream.cleanup();
        if (!stream.response.writableEnded) stream.response.end();
      }
      shutdownPromise = (async () => {
        await previews.stopAll();
        await Promise.all([...activeStepRequests]);
        await new Promise((resolve, reject) => {
          originalClose((error) => error ? reject(error) : resolve());
        });
      })();
      shutdownPromise.then(
        () => {
          for (const closeCallback of closeCallbacks.splice(0)) closeCallback();
        },
        (error) => {
          for (const closeCallback of closeCallbacks.splice(0)) closeCallback(error);
        },
      );
    }
    return server;
  };
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const server = await createApp();
  server.listen(port, "127.0.0.1", () => console.log(`Dev Workbench: http://127.0.0.1:${port}`));
  const closeForSignal = () => new Promise((resolve) => server.close(() => resolve()));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      await closeForSignal();
      process.exitCode = 0;
    });
  }
}
