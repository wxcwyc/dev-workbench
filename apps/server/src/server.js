import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { SessionEngine } from "../../../packages/execution-core/src/session-engine.js";
import { RecentProjectStore } from "../../../packages/execution-core/src/recent-project-store.js";
import { SessionStore } from "../../../packages/execution-core/src/session-store.js";
import { decodeNdjson } from "../../../packages/adapter-sdk/src/index.js";
import { ProtocolValidationError, assertSessionInput, assertTraceEvent, publicSession } from "../../../packages/protocol/src/index.js";
import { resolveProjectRoot } from "../../../packages/project-adapters/src/project-boundary.js";
import { runConfirmedCommand } from "../../../packages/project-adapters/src/command-runner.js";
import { inspectProject } from "../../../packages/project-adapters/src/project-inspector.js";
import { captureProjectSnapshot } from "../../../packages/project-adapters/src/snapshot.js";
import { manifest as prologManifest, prologAdapter } from "../../../packages/prolog-adapter/src/index.js";
import { allowedRoot, examplesRoot, port, projectRoot, stateRoot, webRoot } from "./config.js";

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

export async function createApp(options = {}) {
  const runtime = {
    allowedRoot: options.allowedRoot ?? allowedRoot,
    stateRoot: options.stateRoot ?? stateRoot,
    warn: options.warn ?? console.warn
  };
  const engine = new SessionEngine();
  const store = new SessionStore(runtime.stateRoot);
  const recentProjects = new RecentProjectStore(path.join(runtime.stateRoot, "..", "recent-projects.json"), { warn: runtime.warn });
  const events = new EventEmitter();
  const runningSessions = new Set();
  await store.initialize();

  const emit = (session) => events.emit(`session:${session.id}`, publicSession(session));
  const requireSession = async (id) => {
    const session = await store.get(id);
    if (!session) { const error = new Error("Session not found"); error.statusCode = 404; throw error; }
    return session;
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

  return http.createServer(async (request, response) => {
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
      if (request.method === "GET" && sessionMatch) return sendJson(response, 200, publicSession(await requireSession(sessionMatch[1])));

      const eventMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)\/events$/i);
      if (request.method === "GET" && eventMatch) {
        const session = await requireSession(eventMatch[1]);
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
        const send = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`);
        const listener = (value) => send(value);
        events.on(`session:${session.id}`, listener);
        const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15000);
        request.on("close", () => { clearInterval(heartbeat); events.off(`session:${session.id}`, listener); });
        send(publicSession(session));
        return;
      }

      const traceMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)\/trace$/i);
      if (request.method === "POST" && traceMatch) {
        requireTraceContentType(request);
        const id = traceMatch[1];
        if (runningSessions.has(id)) { const error = new Error("Session already has an active operation"); error.statusCode = 409; throw error; }
        const session = await requireSession(id);
        let accepted = 0;
        let started = false;
        runningSessions.add(id);
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
        } finally { runningSessions.delete(id); }
      }

      const seekMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)\/seek$/i);
      if (request.method === "POST" && seekMatch) {
        const session = await requireSession(seekMatch[1]);
        const body = await readJson(request);
        engine.seek(session, body.stepIndex);
        await store.save(session); emit(session);
        return sendJson(response, 200, publicSession(session));
      }

      const noteMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)\/annotations$/i);
      if (request.method === "POST" && noteMatch) {
        const session = await requireSession(noteMatch[1]);
        engine.annotate(session, await readJson(request));
        await store.save(session); emit(session);
        return sendJson(response, 201, publicSession(session));
      }

      const runMatch = pathname.match(/^\/api\/sessions\/([a-f0-9-]+)\/steps\/(\d+)\/run$/i);
      if (request.method === "POST" && runMatch) {
        const id = runMatch[1];
        if (runningSessions.has(id)) { const error = new Error("Session already has a running step"); error.statusCode = 409; throw error; }
        const body = await readJson(request);
        const session = await requireSession(id);
        const index = Number(runMatch[2]);
        if (index !== engine.nextRunnable(session)) throw new Error("Steps must run in plan order");
        const step = engine.requireStep(session, index);
        if (step.action && body.confirmed !== true) throw new Error("Command execution requires confirmed=true");
        runningSessions.add(id);
        try {
          engine.startStep(session, index); await store.save(session); emit(session);
          const baseline = index > 0 ? session.snapshots[index - 1] : await captureProjectSnapshot(session.projectRoot);
          const result = step.action ? await runConfirmedCommand(session.projectRoot, step.action) : null;
          const snapshot = step.traceState ? { trace: step.traceState } : await captureProjectSnapshot(session.projectRoot, baseline, result);
          engine.completeStep(session, index, snapshot); await store.save(session); emit(session);
          return sendJson(response, 200, publicSession(session));
        } catch (error) {
          engine.failStep(session, index, error); await store.save(session); emit(session);
          throw error;
        } finally { runningSessions.delete(id); }
      }

      if (request.method === "GET" && await serveStatic(response, pathname)) return;
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      const details = error instanceof ProtocolValidationError ? error.issues : undefined;
      sendJson(response, error.statusCode ?? 400, {
        error: error.message, ...(details ? { details } : {}),
        ...(Number.isInteger(error.accepted) ? { accepted: error.accepted } : {})
      });
    }
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const server = await createApp();
  server.listen(port, "127.0.0.1", () => console.log(`Dev Workbench: http://127.0.0.1:${port}`));
}
