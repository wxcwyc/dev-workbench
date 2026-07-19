import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { SessionEngine } from "../../../packages/execution-core/src/session-engine.js";
import { SessionStore } from "../../../packages/execution-core/src/session-store.js";
import { publicSession } from "../../../packages/protocol/src/index.js";
import { resolveProjectRoot } from "../../../packages/project-adapters/src/project-boundary.js";
import { runConfirmedCommand } from "../../../packages/project-adapters/src/command-runner.js";
import { captureProjectSnapshot } from "../../../packages/project-adapters/src/snapshot.js";
import { allowedRoot, examplesRoot, port, projectRoot, stateRoot, webRoot } from "./config.js";

const mimeTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": mimeTypes[".json"] });
  response.end(JSON.stringify(body));
}

async function readJson(request, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) { const error = new Error("Request body exceeds 1 MB"); error.statusCode = 413; throw error; }
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
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
    traceState: item.state
  }));
}

export async function createApp() {
  const engine = new SessionEngine();
  const store = new SessionStore(stateRoot);
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
    const resolvedRoot = await resolveProjectRoot(input.projectRoot, allowedRoot);
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
    emit(session);
    return publicSession(session);
  }

  async function createExample(name) {
    if (!/^[a-z-]+$/.test(name)) throw new Error("Invalid example name");
    const input = JSON.parse(await fs.readFile(path.join(examplesRoot, name, "session.json"), "utf8"));
    input.projectRoot = path.join(examplesRoot, name);
    return createSession(input);
  }

  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
      const pathname = url.pathname;
      if (request.method === "GET" && pathname === "/api/health") return sendJson(response, 200, { ok: true, version: "0.1.0", allowedRoot });
      if (request.method === "GET" && pathname === "/api/sessions") {
        const sessions = await store.list();
        return sendJson(response, 200, sessions.map(({ snapshots, events: sessionEvents, ...session }) => ({ ...session, snapshotCount: snapshots.length, eventCount: sessionEvents.length })));
      }
      if (request.method === "POST" && pathname === "/api/sessions") return sendJson(response, 201, await createSession(await readJson(request)));

      const exampleMatch = pathname.match(/^\/api\/examples\/(logic-trace|migration-demo)$/);
      if (request.method === "POST" && exampleMatch) return sendJson(response, 201, await createExample(exampleMatch[1]));

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
      sendJson(response, error.statusCode ?? 400, { error: error.message });
    }
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const server = await createApp();
  server.listen(port, "127.0.0.1", () => console.log(`Dev Workbench: http://127.0.0.1:${port}`));
}
