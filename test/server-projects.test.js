import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { promisify } from "node:util";

import { createApp } from "../apps/server/src/server.js";
import { TerminalBuffer } from "../packages/execution-core/src/terminal-buffer.js";
import {
  createBaselineCheckpoint,
  restoreCheckpoint,
} from "../packages/project-adapters/src/git-adapter.js";

const execFileAsync = promisify(execFile);

async function startTestApp(t, options = {}) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-server-projects-"));
  const allowedRoot = path.join(temporaryRoot, "allowed");
  const stateRoot = path.join(temporaryRoot, "state", "sessions");
  await fs.mkdir(allowedRoot, { recursive: true });
  const resolvedOptions = { ...options };
  if (typeof options.workspaceRoot === "function") {
    resolvedOptions.workspaceRoot = options.workspaceRoot({ temporaryRoot, allowedRoot, stateRoot });
  }

  let server;
  t.after(async () => {
    try {
      if (server?.listening) {
        await new Promise((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  server = await createApp({ allowedRoot, stateRoot, ...resolvedOptions });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    allowedRoot,
    server,
    stateRoot,
    temporaryRoot,
    url: `http://127.0.0.1:${port}`,
  };
}

class FakePreviewSupervisor {
  constructor() {
    this.listeners = new Map();
    this.calls = [];
    this.nextEventSequence = 1;
    this.states = {
      source: { state: "stopped", actualUrl: "http://127.0.0.1:4173/", latestSequence: 0 },
      target: { state: "running", actualUrl: "http://127.0.0.1:4174/", latestSequence: 0 },
    };
    this.stopAllCalls = 0;
  }

  async snapshot() {
    return structuredClone(this.states);
  }

  subscribe(sessionId, listener) {
    const listeners = this.listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  publish(sessionId, slot, state) {
    const sequence = this.nextEventSequence++;
    const sequencedState = { ...state, latestSequence: sequence };
    this.states[slot] = sequencedState;
    const event = {
      type: "preview.state",
      sessionId,
      slot,
      sequence,
      state: sequencedState,
    };
    for (const listener of this.listeners.get(sessionId) ?? []) listener(event);
    return structuredClone(event);
  }

  async start(session, slot) {
    this.calls.push(["start", session.id, slot]);
    return this.states[slot];
  }

  async stop(sessionId, slot) {
    this.calls.push(["stop", sessionId, slot]);
    return this.states[slot];
  }

  async restart(session, slot) {
    this.calls.push(["restart", session.id, slot]);
    return this.states[slot];
  }

  async stopAll() {
    this.stopAllCalls += 1;
  }
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function putJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function withTimeout(promise, label, timeoutMs = 2000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForCondition(predicate, label) {
  await withTimeout((async () => {
    while (!predicate()) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  })(), label);
}

function createSseReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async next() {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (data) return JSON.parse(data);
          continue;
        }

        const { value, done } = await reader.read();
        if (done) throw new Error("SSE stream ended before the next data event");
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}

async function requestRawJson(url, { headers = {} } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

async function makeSampleProject(allowedRoot) {
  const sampleRoot = path.join(allowedRoot, "sample");
  await fs.mkdir(path.join(sampleRoot, ".git"), { recursive: true });
  await fs.mkdir(path.join(sampleRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(sampleRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await fs.writeFile(path.join(sampleRoot, "package.json"), JSON.stringify({
    dependencies: { react: "latest" },
  }));
  await fs.writeFile(path.join(sampleRoot, "src", "index.ts"), "export const ready = true;\n");
  return fs.realpath(sampleRoot);
}

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

async function makeGitMigrationProject(allowedRoot) {
  const repositoryRoot = path.join(allowedRoot, "git-sample");
  const projectRoot = path.join(repositoryRoot, "app");
  await fs.mkdir(projectRoot, { recursive: true });
  await git(repositoryRoot, "init", "--quiet");
  await git(repositoryRoot, "config", "user.name", "Dev Workbench Test");
  await git(repositoryRoot, "config", "user.email", "test@dev-workbench.invalid");
  await fs.writeFile(path.join(repositoryRoot, ".gitignore"), "ignored.txt\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "keep.txt"), "before\n", "utf8");
  await fs.mkdir(path.join(projectRoot, "nested"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "nested", "entry.txt"), "nested\n", "utf8");
  await git(repositoryRoot, "add", ".");
  await git(repositoryRoot, "commit", "--quiet", "-m", "initial");
  return {
    repositoryRoot: await fs.realpath(repositoryRoot),
    projectRoot: await fs.realpath(projectRoot),
  };
}

async function sourceFingerprint(repositoryRoot) {
  return {
    head: await git(repositoryRoot, "rev-parse", "HEAD"),
    index: await fs.readFile(path.join(repositoryRoot, ".git", "index")),
    status: await git(repositoryRoot, "status", "--porcelain=v2", "--untracked-files=all"),
    keep: await fs.readFile(path.join(repositoryRoot, "app", "keep.txt")),
  };
}

function createSampleWorkspaceAdapter() {
  return {
    async prepare({ projectRoot, workspaceRoot, sessionId, ownershipToken }) {
      const canonicalProjectRoot = await fs.realpath(projectRoot);
      await fs.mkdir(workspaceRoot, { recursive: true });
      const worktreeRoot = path.join(workspaceRoot, sessionId);
      await fs.mkdir(worktreeRoot, { recursive: true });
      const executionRoot = await fs.realpath(worktreeRoot);
      return {
        sessionId,
        projectRoot: canonicalProjectRoot,
        repositoryRoot: canonicalProjectRoot,
        projectRelativePath: ".",
        commonGitDir: path.join(canonicalProjectRoot, ".git"),
        worktreeRoot: executionRoot,
        executionRoot,
        baseOid: "a".repeat(40),
        ownershipToken,
        currentCheckpointId: "initial",
      };
    },
    async validate() {},
    async dispose() {},
  };
}

async function prepareSessionWorkspace(app, sessionId) {
  const prepared = await postJson(`${app.url}/api/sessions/${sessionId}/workspace/prepare`, {});
  assert.equal(prepared.response.status, 200);
  return prepared.body;
}

function trackSessionMutations(t, sessionId) {
  const originalRename = fs.rename;
  const originalEmit = EventEmitter.prototype.emit;
  let saves = 0;
  let emits = 0;
  const operations = [];

  const trackedRename = async (...args) => {
    const result = await originalRename(...args);
    if (path.basename(args[1]) === `${sessionId}.json`) {
      saves += 1;
      operations.push("save");
    }
    return result;
  };
  const trackedEmit = function (eventName, ...args) {
    if (eventName === `session:${sessionId}`) {
      emits += 1;
      operations.push("emit");
    }
    return originalEmit.call(this, eventName, ...args);
  };
  fs.rename = trackedRename;
  EventEmitter.prototype.emit = trackedEmit;
  t.after(() => {
    if (fs.rename === trackedRename) fs.rename = originalRename;
    if (EventEmitter.prototype.emit === trackedEmit) EventEmitter.prototype.emit = originalEmit;
  });

  return {
    counts: () => ({ saves, emits }),
    operations: () => operations.slice(),
  };
}

test("POST /api/projects/inspect resolves a relative project and returns detected facts", async (t) => {
  const app = await startTestApp(t);
  const canonicalRoot = await makeSampleProject(app.allowedRoot);

  const { response, body } = await postJson(`${app.url}/api/projects/inspect`, {
    projectRoot: "sample",
  });

  assert.equal(response.status, 200);
  assert.equal(body.projectRoot, canonicalRoot);
  assert.equal(body.git, true);
  assert.equal(body.packageManager, "pnpm");
  assert.deepEqual(body.languages, ["TypeScript"]);
  assert.deepEqual(body.frameworks, ["React"]);
  assert.ok(body.evidence.includes("package.json"));
  assert.ok(body.evidence.includes("pnpm-lock.yaml"));
});

test("POST /api/projects/inspect rejects every allowed-root boundary escape", async (t) => {
  const app = await startTestApp(t);
  const outsideRoot = path.join(app.temporaryRoot, "outside");
  await fs.mkdir(outsideRoot);
  await fs.symlink(outsideRoot, path.join(app.allowedRoot, "outside-link"));

  for (const projectRoot of ["../outside", outsideRoot, "outside-link"]) {
    const { response, body } = await postJson(`${app.url}/api/projects/inspect`, { projectRoot });
    assert.equal(response.status, 400);
    assert.match(body.error, /inside allowed root/i);
  }
});

test("POST /api/projects/inspect accepts an in-root directory whose name starts with dots", async (t) => {
  const app = await startTestApp(t);
  const projectRoot = path.join(app.allowedRoot, "..valid");
  await fs.mkdir(projectRoot);

  const { response, body } = await postJson(`${app.url}/api/projects/inspect`, {
    projectRoot: "..valid",
  });

  assert.equal(response.status, 200);
  assert.equal(body.projectRoot, await fs.realpath(projectRoot));
});

test("POST /api/projects/inspect requires a non-empty project root", async (t) => {
  const app = await startTestApp(t);

  const { response, body } = await postJson(`${app.url}/api/projects/inspect`, {
    projectRoot: "",
  });

  assert.equal(response.status, 400);
  assert.match(body.error, /projectRoot must be a non-empty string/);
});

test("POST /api/sessions canonicalizes the project and records it as recent", async (t) => {
  const app = await startTestApp(t);
  const canonicalRoot = await makeSampleProject(app.allowedRoot);

  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Migration",
    workbench: "migration",
    projectRoot: "sample",
    steps: [],
  });

  assert.equal(created.response.status, 201);
  assert.equal(created.body.projectRoot, canonicalRoot);

  const response = await fetch(`${app.url}/api/projects/recent`);
  assert.equal(response.status, 200);
  const recent = await response.json();
  assert.equal(recent.length, 1);
  assert.equal(recent[0].projectRoot, canonicalRoot);
  assert.equal(recent[0].workbench, "migration");
  assert.equal(Number.isNaN(Date.parse(recent[0].lastUsedAt)), false);
});

test("GET /api/projects/recent degrades read failures to an empty list with a warning", async (t) => {
  const warnings = [];
  const app = await startTestApp(t, { warn: (message) => warnings.push(message) });
  await fs.mkdir(path.join(app.stateRoot, "..", "recent-projects.json"));

  const response = await fetch(`${app.url}/api/projects/recent`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not read recent projects/i);
  assert.match(warnings[0], /recent-projects\.json/i);
});

test("invalid imported steps report a JSON pointer and do not update recent projects", async (t) => {
  const app = await startTestApp(t);
  await makeSampleProject(app.allowedRoot);

  const invalid = await postJson(`${app.url}/api/sessions`, {
    title: "Invalid migration",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{}],
  });

  assert.equal(invalid.response.status, 400);
  assert.ok(invalid.body.details.some((issue) => issue.path === "/steps/0/title"));

  const response = await fetch(`${app.url}/api/projects/recent`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
});

test("project file roots are rejected and never recorded as recent", async (t) => {
  const app = await startTestApp(t);
  await fs.writeFile(path.join(app.allowedRoot, "project.txt"), "not a directory\n", "utf8");

  const inspected = await postJson(`${app.url}/api/projects/inspect`, {
    projectRoot: "project.txt",
  });
  assert.equal(inspected.response.status, 400);
  assert.match(inspected.body.error, /project root must be a directory/i);

  const created = await postJson(`${app.url}/api/sessions`, {
    title: "File-backed project",
    workbench: "migration",
    projectRoot: "project.txt",
    steps: [],
  });
  assert.equal(created.response.status, 400);
  assert.match(created.body.error, /project root must be a directory/i);

  const response = await fetch(`${app.url}/api/projects/recent`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
});

test("rejects non-loopback, DNS-rebinding, and wrong-port Host headers", async (t) => {
  const app = await startTestApp(t);
  const { port } = new URL(app.url);
  const rejectedHosts = [
    `attacker.example:${port}`,
    `127.0.0.1.attacker.example:${port}`,
    `localhost:${Number(port) + 1}`,
  ];

  for (const host of rejectedHosts) {
    const response = await requestRawJson(`${app.url}/api/health`, { headers: { host } });
    assert.equal(response.status, 403, host);
    assert.match(response.headers["content-type"], /^application\/json\b/);
    assert.match(response.body.error, /host/i);
  }
});

test("requires an exact same-origin Origin header when Origin is present", async (t) => {
  const app = await startTestApp(t);
  const { port } = new URL(app.url);

  const valid = await requestRawJson(`${app.url}/api/health`, {
    headers: { origin: app.url },
  });
  assert.equal(valid.status, 200);

  const localhostOrigin = `http://localhost:${port}`;
  const validLocalhost = await requestRawJson(`${app.url}/api/health`, {
    headers: { host: `localhost:${port}`, origin: localhostOrigin },
  });
  assert.equal(validLocalhost.status, 200);

  const crossOrigin = await requestRawJson(`${app.url}/api/health`, {
    headers: { origin: `http://attacker.example:${port}` },
  });
  assert.equal(crossOrigin.status, 403);
  assert.match(crossOrigin.body.error, /origin/i);
});

test("JSON mutation endpoints reject missing or incorrect content types without side effects", async (t) => {
  const app = await startTestApp(t);
  await makeSampleProject(app.allowedRoot);
  const input = {
    title: "Mutation media type",
    workbench: "migration",
    projectRoot: "sample",
    steps: [],
  };

  for (const options of [
    { body: Buffer.from(JSON.stringify(input)) },
    { headers: { "content-type": "text/plain" }, body: JSON.stringify(input) },
  ]) {
    const response = await fetch(`${app.url}/api/sessions`, { method: "POST", ...options });
    assert.equal(response.status, 415);
    assert.match(response.headers.get("content-type"), /^application\/json\b/);
    assert.match((await response.json()).error, /requires application\/json/i);
  }

  const sessionsBeforeValidRequest = await fetch(`${app.url}/api/sessions`);
  assert.deepEqual(await sessionsBeforeValidRequest.json(), []);

  const valid = await postJson(`${app.url}/api/sessions`, input);
  assert.equal(valid.response.status, 201);
});

test("trace rejects invalid content types before mutating the stored session", async (t) => {
  const app = await startTestApp(t);
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Trace media type",
    workbench: "execution",
    projectRoot: "sample",
    steps: [],
  });
  assert.equal(created.response.status, 201);
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  const before = await (await fetch(sessionUrl)).json();

  for (const options of [
    { body: Buffer.from("[]") },
    { headers: { "content-type": "text/plain" }, body: "[]" },
  ]) {
    const response = await fetch(`${sessionUrl}/trace`, { method: "POST", ...options });
    assert.equal(response.status, 415);
    assert.match((await response.json()).error, /trace ingestion requires application\/json/i);
    assert.deepEqual(await (await fetch(sessionUrl)).json(), before);
  }
});

test("trace accepts every supported content type with parameters", async (t) => {
  const app = await startTestApp(t);
  await makeSampleProject(app.allowedRoot);

  for (const contentType of [
    "application/json; charset=utf-8",
    "application/x-ndjson; charset=utf-8",
    "application/ndjson; charset=utf-8",
  ]) {
    const created = await postJson(`${app.url}/api/sessions`, {
      title: contentType,
      workbench: "execution",
      projectRoot: "sample",
      steps: [],
    });
    const response = await fetch(`${app.url}/api/sessions/${created.body.id}/trace`, {
      method: "POST",
      headers: { "content-type": contentType },
      body: contentType.startsWith("application/json") ? "[]" : "",
    });
    assert.equal(response.status, 202, contentType);
  }
});

test("PUT /api/sessions/:id/plan normalizes and persists replacement plans, including an empty plan", async (t) => {
  const app = await startTestApp(t);
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Editable migration",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ title: "Old step" }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;

  const replacement = await putJson(`${sessionUrl}/plan`, {
    steps: [{
      title: "  Install dependency  ",
      description: "  Add the required package.  ",
      action: { command: ["npm", "install", "example"], cwd: "packages/app" },
      expected: { files: ["package.json"] },
    }],
  });

  assert.equal(replacement.response.status, 200);
  assert.equal(replacement.body.steps[0].title, "Install dependency");
  assert.equal(replacement.body.steps[0].description, "Add the required package.");
  assert.deepEqual(replacement.body.steps[0].action, {
    command: ["npm", "install", "example"],
    cwd: "packages/app",
  });
  assert.deepEqual(replacement.body.steps[0].expected, { files: ["package.json"] });
  assert.equal(replacement.body.steps[0].status, "pending");
  assert.deepEqual(await (await fetch(sessionUrl)).json(), replacement.body);

  const emptied = await putJson(`${sessionUrl}/plan`, { steps: [] });
  assert.equal(emptied.response.status, 200);
  assert.deepEqual(emptied.body.steps, []);
  assert.deepEqual(await (await fetch(sessionUrl)).json(), emptied.body);
});

test("PUT /api/sessions/:id/plan broadcasts the persisted full session over SSE", async (t) => {
  const app = await startTestApp(t);
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Streamed migration",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ title: "Old step" }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  const streamAbort = new AbortController();
  t.after(() => streamAbort.abort());
  const streamResponse = await fetch(`${sessionUrl}/events`, { signal: streamAbort.signal });
  assert.equal(streamResponse.status, 200);
  const stream = createSseReader(streamResponse);
  t.after(() => stream.cancel());
  await withTimeout(stream.next(), "initial SSE session");

  const replacement = await putJson(`${sessionUrl}/plan`, {
    steps: [{ title: "New streamed step" }],
  });
  assert.equal(replacement.response.status, 200);
  const eventSession = await withTimeout(stream.next(), "updated SSE session");

  assert.deepEqual(eventSession, replacement.body);
  assert.equal(eventSession.steps[0].title, "New streamed step");
  assert.deepEqual(
    { type: eventSession.events.at(-1).type, stepCount: eventSession.events.at(-1).stepCount },
    { type: "plan.updated", stepCount: 1 },
  );
  await stream.cancel();
  streamAbort.abort();
});

test("PUT /api/sessions/:id/plan rejects non-pristine sessions without changing stored state", async (t) => {
  const app = await startTestApp(t, {
    workspaceAdapter: createSampleWorkspaceAdapter(),
    runCommand: async () => { throw new Error("intentional command failure"); },
  });
  await makeSampleProject(app.allowedRoot);

  const cases = [];
  const execution = await postJson(`${app.url}/api/sessions`, {
    title: "Execution",
    workbench: "execution",
    projectRoot: "sample",
    steps: [],
  });
  cases.push({ name: "execution", url: `${app.url}/api/sessions/${execution.body.id}` });

  const completed = await postJson(`${app.url}/api/sessions`, {
    title: "Completed migration",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ title: "Finish" }],
  });
  const completedUrl = `${app.url}/api/sessions/${completed.body.id}`;
  assert.equal((await postJson(`${completedUrl}/steps/0/run`, { confirmed: true })).response.status, 200);
  cases.push({ name: "completed", url: completedUrl });

  const failed = await postJson(`${app.url}/api/sessions`, {
    title: "Failed migration",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ title: "Fail", action: { command: ["never-run-for-test"] } }],
  });
  const failedUrl = `${app.url}/api/sessions/${failed.body.id}`;
  await prepareSessionWorkspace(app, failed.body.id);
  assert.equal((await postJson(`${failedUrl}/steps/0/run`, { confirmed: true })).response.status, 400);
  cases.push({ name: "failed", url: failedUrl });

  const annotated = await postJson(`${app.url}/api/sessions`, {
    title: "Annotated migration",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ title: "Review" }],
  });
  const annotatedUrl = `${app.url}/api/sessions/${annotated.body.id}`;
  assert.equal((await postJson(`${annotatedUrl}/annotations`, { stepIndex: 0, text: "Keep this" })).response.status, 201);
  cases.push({ name: "annotated", url: annotatedUrl });

  for (const { name, url } of cases) {
    const before = await (await fetch(url)).json();
    const replacement = await putJson(`${url}/plan`, { steps: [{ title: "Replacement" }] });
    assert.equal(replacement.response.status, 400, name);
    assert.deepEqual(await (await fetch(url)).json(), before, name);
  }
});

test("POST /api/sessions/:id/annotations keeps plain notes compatible and rejects unknown fields atomically", async (t) => {
  const app = await startTestApp(t);
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Annotations",
    workbench: "execution",
    projectRoot: "sample",
    steps: [{ title: "Inspect", traceState: { value: 1 } }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  const accepted = await postJson(`${sessionUrl}/annotations`, { stepIndex: 0, text: "  Plain note  " });
  assert.equal(accepted.response.status, 201);
  assert.deepEqual(
    { kind: accepted.body.annotations[0].kind, text: accepted.body.annotations[0].text, tags: accepted.body.annotations[0].tags },
    { kind: "note", text: "Plain note", tags: [] },
  );

  const before = await (await fetch(sessionUrl)).json();
  const rejected = await postJson(`${sessionUrl}/annotations`, { stepIndex: 0, text: "Bad", sequence: 4 });
  assert.equal(rejected.response.status, 400);
  assert.deepEqual(await (await fetch(sessionUrl)).json(), before);
});

test("PUT /api/sessions/:id/plan returns 409 during an active operation and never runs a command", async (t) => {
  let releaseCommand;
  let signalCommandStarted;
  const commandStarted = new Promise((resolve) => { signalCommandStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseCommand = resolve; });
  const commandResult = { command: ["deferred-test-command"], stdout: "", stderr: "", exitCode: 0 };
  t.after(() => releaseCommand(commandResult));
  let runCalls = 0;
  const app = await startTestApp(t, {
    workspaceAdapter: createSampleWorkspaceAdapter(),
    runCommand: async () => {
      runCalls += 1;
      signalCommandStarted();
      return blocked;
    },
  });
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Running migration",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ title: "Run", action: { command: ["deferred-test-command"] } }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  await prepareSessionWorkspace(app, created.body.id);
  let runRequest;
  let runResult;
  try {
    runRequest = postJson(`${sessionUrl}/steps/0/run`, { confirmed: true });
    await withTimeout(commandStarted, "deferred command start");
    const before = await (await fetch(sessionUrl)).json();

    const replacement = await putJson(`${sessionUrl}/plan`, {
      steps: [{ title: "Must not replace" }],
    });

    assert.equal(replacement.response.status, 409);
    assert.deepEqual(await (await fetch(sessionUrl)).json(), before);
    assert.equal(runCalls, 1);
  } finally {
    releaseCommand(commandResult);
    if (runRequest) runResult = await withTimeout(runRequest, "deferred run cleanup");
  }
  assert.equal(runResult.response.status, 200);
  assert.equal(runCalls, 1);
});

test("session mutation lock rejects concurrent plan, run, and annotation requests and releases after errors", async (t) => {
  let releasePlan;
  let signalPlanClaimed;
  const planClaimed = new Promise((resolve) => { signalPlanClaimed = resolve; });
  const blockedPlan = new Promise((resolve) => { releasePlan = resolve; });
  t.after(() => releasePlan());
  let planClaims = 0;
  const app = await startTestApp(t, {
    afterSessionClaim: ({ operation }) => {
      if (operation !== "plan" || planClaims++ > 0) return undefined;
      signalPlanClaimed();
      return blockedPlan;
    },
  });
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Locked migration",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ title: "Original" }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  let firstPlanRequest;
  let firstPlanResult;

  try {
    firstPlanRequest = putJson(`${sessionUrl}/plan`, { steps: [{ title: "First replacement" }] });
    await withTimeout(planClaimed, "first plan claim");

    const secondPlan = await putJson(`${sessionUrl}/plan`, { steps: [{ title: "Second replacement" }] });
    const run = await postJson(`${sessionUrl}/steps/0/run`, { confirmed: true });
    const annotation = await postJson(`${sessionUrl}/annotations`, { stepIndex: 0, text: "Concurrent note" });
    assert.equal(secondPlan.response.status, 409);
    assert.equal(run.response.status, 409);
    assert.equal(annotation.response.status, 409);

    releasePlan();
    firstPlanResult = await withTimeout(firstPlanRequest, "first plan completion");
  } finally {
    releasePlan();
    if (firstPlanRequest && !firstPlanResult) {
      await withTimeout(firstPlanRequest, "first plan cleanup").catch(() => {});
    }
  }

  assert.equal(firstPlanResult.response.status, 200);
  const invalid = await putJson(`${sessionUrl}/plan`, { steps: [{ title: "   " }] });
  assert.equal(invalid.response.status, 400);
  const afterInvalid = await putJson(`${sessionUrl}/plan`, { steps: [{ title: "After invalid" }] });
  assert.equal(afterInvalid.response.status, 200);
});

test("PUT /api/sessions/:id/plan reports protocol pointers and preserves invalid plans", async (t) => {
  const app = await startTestApp(t);
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Validated migration",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ title: "Original" }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  const before = await (await fetch(sessionUrl)).json();

  const invalid = await putJson(`${sessionUrl}/plan`, { steps: [{ title: "   " }] });

  assert.equal(invalid.response.status, 400);
  assert.ok(invalid.body.details.some((issue) => issue.path === "/steps/0/title"));
  assert.deepEqual(await (await fetch(sessionUrl)).json(), before);
});

test("PUT /api/sessions/:id/plan rejects unknown top-level fields without changing stored state", async (t) => {
  const app = await startTestApp(t);
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Strict plan input",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ title: "Original" }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  const before = await (await fetch(sessionUrl)).json();

  const invalid = await putJson(`${sessionUrl}/plan`, { steps: [], extra: true });

  assert.equal(invalid.response.status, 400);
  assert.ok(invalid.body.details.some((issue) => issue.path === "/extra"));
  assert.deepEqual(await (await fetch(sessionUrl)).json(), before);
});

test("PUT /api/sessions/:id/plan requires JSON content type without mutating the plan", async (t) => {
  const app = await startTestApp(t);
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Media type migration",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ title: "Original" }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  const before = await (await fetch(sessionUrl)).json();

  for (const options of [
    { body: Buffer.from(JSON.stringify({ steps: [] })) },
    { headers: { "content-type": "text/plain" }, body: JSON.stringify({ steps: [] }) },
  ]) {
    const response = await fetch(`${sessionUrl}/plan`, { method: "PUT", ...options });
    assert.equal(response.status, 415);
    assert.match((await response.json()).error, /requires application\/json/i);
    assert.deepEqual(await (await fetch(sessionUrl)).json(), before);
  }
});

test("GET /api/health reports the injected allowed root", async (t) => {
  const app = await startTestApp(t);

  const response = await fetch(`${app.url}/api/health`);

  assert.equal(response.status, 200);
  assert.equal((await response.json()).allowedRoot, app.allowedRoot);
});

test("successful Migration runs await review and persist their snapshot", async (t) => {
  const app = await startTestApp(t);
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Reviewable migration",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ id: "observe", title: "Observe", traceState: { phase: "ready" } }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;

  const run = await postJson(`${sessionUrl}/steps/0/run`, {});

  assert.equal(run.response.status, 200);
  assert.equal(run.body.status, "awaiting_review");
  assert.equal(run.body.steps[0].status, "awaiting_review");
  assert.equal(run.body.steps[0].attempt, 1);
  assert.deepEqual(run.body.currentSnapshot.trace, { phase: "ready" });
  const stored = JSON.parse(await fs.readFile(path.join(app.stateRoot, `${created.body.id}.json`), "utf8"));
  assert.deepEqual(stored.snapshots[0].trace, { phase: "ready" });
  assert.equal(stored.steps[0].status, "awaiting_review");
});

test("accept review saves and emits once, returns the full session, and completes the final step", async (t) => {
  const app = await startTestApp(t);
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Accepted migration",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ id: "final", title: "Final", traceState: { result: "ok" } }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  assert.equal((await postJson(`${sessionUrl}/steps/0/run`, {})).response.status, 200);
  const streamAbort = new AbortController();
  t.after(() => streamAbort.abort());
  const streamResponse = await fetch(`${sessionUrl}/events`, { signal: streamAbort.signal });
  assert.equal(streamResponse.status, 200);
  const stream = createSseReader(streamResponse);
  t.after(() => stream.cancel());
  await withTimeout(stream.next(), "initial accepted-review SSE session");
  const mutations = trackSessionMutations(t, created.body.id);
  const before = mutations.counts();
  const operationBaseline = mutations.operations().length;

  const reviewed = await postJson(`${sessionUrl}/steps/0/review`, { decision: "accept" });
  const eventSession = await withTimeout(stream.next(), "accepted-review SSE session");

  assert.equal(reviewed.response.status, 200);
  assert.deepEqual(mutations.counts(), { saves: before.saves + 1, emits: before.emits + 1 });
  assert.deepEqual(mutations.operations().slice(operationBaseline), ["save", "emit"]);
  assert.deepEqual(eventSession, reviewed.body);
  assert.equal(reviewed.body.status, "completed");
  assert.equal(reviewed.body.steps[0].status, "completed");
  assert.equal(reviewed.body.steps[0].review.decision, "accept");
  assert.deepEqual(reviewed.body.currentSnapshot.trace, { result: "ok" });
  assert.deepEqual(await (await fetch(sessionUrl)).json(), reviewed.body);
  await stream.cancel();
  streamAbort.abort();
});

test("reject review saves and emits once, returns the full session, and retry increments attempt", async (t) => {
  const app = await startTestApp(t);
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Rejected migration",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ id: "retry", title: "Retry", traceState: { result: "check" } }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  assert.equal((await postJson(`${sessionUrl}/steps/0/run`, {})).response.status, 200);
  const streamAbort = new AbortController();
  t.after(() => streamAbort.abort());
  const streamResponse = await fetch(`${sessionUrl}/events`, { signal: streamAbort.signal });
  assert.equal(streamResponse.status, 200);
  const stream = createSseReader(streamResponse);
  t.after(() => stream.cancel());
  await withTimeout(stream.next(), "initial rejected-review SSE session");
  const mutations = trackSessionMutations(t, created.body.id);
  const before = mutations.counts();
  const operationBaseline = mutations.operations().length;

  const reviewed = await postJson(`${sessionUrl}/steps/0/review`, { decision: "reject" });
  const eventSession = await withTimeout(stream.next(), "rejected-review SSE session");

  assert.equal(reviewed.response.status, 200);
  assert.deepEqual(mutations.counts(), { saves: before.saves + 1, emits: before.emits + 1 });
  assert.deepEqual(mutations.operations().slice(operationBaseline), ["save", "emit"]);
  assert.deepEqual(eventSession, reviewed.body);
  assert.equal(reviewed.body.status, "failed");
  assert.equal(reviewed.body.steps[0].status, "failed");
  assert.equal(reviewed.body.steps[0].review.decision, "reject");
  assert.deepEqual(await (await fetch(sessionUrl)).json(), reviewed.body);

  const retried = await postJson(`${sessionUrl}/steps/0/run`, {});
  assert.equal(retried.response.status, 200);
  assert.equal(retried.body.status, "awaiting_review");
  assert.equal(retried.body.steps[0].attempt, 2);
  assert.equal(retried.body.steps[0].review, null);
  await stream.cancel();
  streamAbort.abort();
});

test("review route accepts only the exact decision object and exact path", async (t) => {
  const app = await startTestApp(t);
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Strict review",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ title: "Review", traceState: { ready: true } }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  assert.equal((await postJson(`${sessionUrl}/steps/0/run`, {})).response.status, 200);
  const before = await (await fetch(sessionUrl)).json();

  for (const body of [
    null,
    [],
    {},
    { decision: "approve" },
    { decision: "accept", extra: true },
  ]) {
    const invalid = await postJson(`${sessionUrl}/steps/0/review`, body);
    assert.equal(invalid.response.status, 400, JSON.stringify(body));
    assert.deepEqual(await (await fetch(sessionUrl)).json(), before, JSON.stringify(body));
  }
  const inexact = await postJson(`${sessionUrl}/steps/0/review/extra`, { decision: "accept" });
  assert.equal(inexact.response.status, 404);
  assert.deepEqual(await (await fetch(sessionUrl)).json(), before);

  const accepted = await postJson(`${sessionUrl}/steps/0/review`, { decision: "accept" });
  assert.equal(accepted.response.status, 200);
});

test("dependency-blocked and out-of-order Migration runs do not mutate storage", async (t) => {
  const app = await startTestApp(t);
  await makeSampleProject(app.allowedRoot);

  for (const { title, steps } of [
    {
      title: "Dependency blocked",
      steps: [
        { id: "first", title: "First" },
        { id: "dependent", title: "Dependent", dependsOn: ["first"] },
      ],
    },
    {
      title: "Out of order",
      steps: [
        { id: "first", title: "First" },
        { id: "second", title: "Second" },
      ],
    },
  ]) {
    const created = await postJson(`${app.url}/api/sessions`, {
      title,
      workbench: "migration",
      projectRoot: "sample",
      steps,
    });
    const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
    const filePath = path.join(app.stateRoot, `${created.body.id}.json`);
    const before = await fs.readFile(filePath, "utf8");

    const run = await postJson(`${sessionUrl}/steps/1/run`, {});

    assert.equal(run.response.status, 400, title);
    assert.equal(await fs.readFile(filePath, "utf8"), before, title);
  }
});

test("high risk always requires confirmedRisk and commands additionally require confirmed before start", async (t) => {
  let commandCalls = 0;
  const app = await startTestApp(t, {
    workspaceAdapter: createSampleWorkspaceAdapter(),
    runCommand: async () => {
      commandCalls += 1;
      return { command: ["true"], stdout: "", stderr: "", exitCode: 0 };
    },
  });
  await makeSampleProject(app.allowedRoot);

  const observation = await postJson(`${app.url}/api/sessions`, {
    title: "High-risk observation",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ title: "Observe", risk: "high", traceState: { observed: true } }],
  });
  const observationUrl = `${app.url}/api/sessions/${observation.body.id}`;
  const observationBefore = await (await fetch(observationUrl)).json();
  const unconfirmedObservation = await postJson(`${observationUrl}/steps/0/run`, {});
  assert.equal(unconfirmedObservation.response.status, 400);
  assert.match(unconfirmedObservation.body.error, /confirmedRisk=true/);
  assert.deepEqual(await (await fetch(observationUrl)).json(), observationBefore);

  const command = await postJson(`${app.url}/api/sessions`, {
    title: "High-risk command",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ title: "Command", risk: "high", action: { command: ["true"] } }],
  });
  const commandUrl = `${app.url}/api/sessions/${command.body.id}`;
  await prepareSessionWorkspace(app, command.body.id);
  const commandBefore = await (await fetch(commandUrl)).json();
  const missingRisk = await postJson(`${commandUrl}/steps/0/run`, { confirmed: true });
  assert.equal(missingRisk.response.status, 400);
  assert.match(missingRisk.body.error, /confirmedRisk=true/);
  assert.deepEqual(await (await fetch(commandUrl)).json(), commandBefore);
  const missingCommand = await postJson(`${commandUrl}/steps/0/run`, { confirmedRisk: true });
  assert.equal(missingCommand.response.status, 400);
  assert.match(missingCommand.body.error, /confirmed=true/);
  assert.deepEqual(await (await fetch(commandUrl)).json(), commandBefore);
  assert.equal(commandCalls, 0);

  const confirmed = await postJson(`${commandUrl}/steps/0/run`, {
    confirmed: true,
    confirmedRisk: true,
  });
  assert.equal(confirmed.response.status, 200);
  assert.equal(commandCalls, 1);
});

test("workspace preparation is migration-only, requires an exact empty object, and gates real actions and previews", async (t) => {
  let runCalls = 0;
  const previews = new FakePreviewSupervisor();
  const app = await startTestApp(t, {
    previews,
    runCommand: async () => {
      runCalls += 1;
      return {
        command: ["ignored"],
        cwd: "/ignored",
        stdout: "",
        stderr: "",
        exitCode: 0,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    },
  });
  await makeSampleProject(app.allowedRoot);

  const migration = await postJson(`${app.url}/api/sessions`, {
    title: "Prepare migration",
    workbench: "migration",
    projectRoot: "sample",
    metadata: {
      previewServices: {
        source: { command: [process.execPath], port: 4101 },
      },
    },
    steps: [
      { title: "Trace only", traceState: { value: "ok" } },
      { title: "Real action", action: { command: [process.execPath, "-e", ""], cwd: "." } },
    ],
  });
  assert.equal(migration.response.status, 201);
  const migrationUrl = `${app.url}/api/sessions/${migration.body.id}`;

  for (const body of [null, [], { extra: true }]) {
    const invalid = await postJson(`${migrationUrl}/workspace/prepare`, body);
    assert.equal(invalid.response.status, 400);
    assert.match(invalid.body.error, /empty object/i);
  }

  const trace = await postJson(`${migrationUrl}/steps/0/run`, {});
  assert.equal(trace.response.status, 200);
  assert.equal(trace.body.steps[0].status, "awaiting_review");

  const preview = await postJson(`${migrationUrl}/previews/source/start`, {});
  assert.equal(preview.response.status, 409);
  assert.equal(preview.body.code, "workspace_required");
  assert.deepEqual(previews.calls, []);

  const reviewed = await postJson(`${migrationUrl}/steps/0/review`, { decision: "accept" });
  assert.equal(reviewed.response.status, 200);
  assert.equal(reviewed.body.steps[0].status, "completed");

  const action = await postJson(`${migrationUrl}/steps/1/run`, { confirmed: true });
  assert.equal(action.response.status, 409);
  assert.equal(action.body.code, "workspace_required");
  assert.equal(runCalls, 0);

  const execution = await postJson(`${app.url}/api/sessions`, {
    title: "Prepare execution",
    workbench: "execution",
    projectRoot: "sample",
    steps: [],
  });
  const wrongWorkbench = await postJson(
    `${app.url}/api/sessions/${execution.body.id}/workspace/prepare`,
    {},
  );
  assert.equal(wrongWorkbench.response.status, 400);
  assert.match(wrongWorkbench.body.error, /migration session/i);
});

test("workspace preparation persists once, emits once after save, and leaves the source repository unchanged", async (t) => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  t.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  const app = await startTestApp(t, { workspaceRoot: managedRoot });
  const project = await makeGitMigrationProject(app.allowedRoot);
  const fingerprintBefore = await sourceFingerprint(project.repositoryRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Managed workspace",
    workbench: "migration",
    projectRoot: "git-sample/app",
    steps: [{ title: "Review" }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  const mutations = trackSessionMutations(t, created.body.id);
  const streamAbort = new AbortController();
  t.after(() => streamAbort.abort());
  const streamResponse = await fetch(`${sessionUrl}/events`, { signal: streamAbort.signal });
  const stream = createSseReader(streamResponse);
  t.after(() => stream.cancel());
  await withTimeout(stream.next(), "initial prepared-workspace SSE session");

  const prepared = await postJson(`${sessionUrl}/workspace/prepare`, {});
  const eventSession = await withTimeout(stream.next(), "prepared workspace SSE session");

  assert.equal(prepared.response.status, 200);
  assert.deepEqual(eventSession, prepared.body);
  assert.deepEqual(mutations.operations(), ["save", "emit"]);
  assert.equal(prepared.body.projectRoot, project.projectRoot);
  assert.equal(prepared.body.workspace.projectRoot, project.projectRoot);
  assert.equal(prepared.body.workspace.repositoryRoot, project.repositoryRoot);
  assert.equal(prepared.body.workspace.projectRelativePath, "app");
  assert.equal(
    prepared.body.workspace.executionRoot,
    path.join(prepared.body.workspace.worktreeRoot, "app"),
  );
  assert.equal(prepared.body.workspace.baseOid, fingerprintBefore.head);
  assert.deepEqual(await (await fetch(sessionUrl)).json(), prepared.body);
  assert.deepEqual(await sourceFingerprint(project.repositoryRoot), fingerprintBefore);
  await stream.cancel();
  streamAbort.abort();
});

test("workspace preparation reports structured dirty diagnostics and never mutates source or session state", async (t) => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  t.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  const app = await startTestApp(t, { workspaceRoot: managedRoot });
  const project = await makeGitMigrationProject(app.allowedRoot);
  await fs.writeFile(path.join(project.projectRoot, "keep.txt"), "dirty\n", "utf8");
  const fingerprintBefore = await sourceFingerprint(project.repositoryRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Dirty workspace",
    workbench: "migration",
    projectRoot: "git-sample/app",
    steps: [],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  const mutations = trackSessionMutations(t, created.body.id);

  const prepared = await postJson(`${sessionUrl}/workspace/prepare`, {});

  assert.equal(prepared.response.status, 400);
  assert.equal(prepared.body.code, "source_dirty");
  assert.ok(prepared.body.details.some((item) => item.kind === "unstaged" && item.path === "app/keep.txt"));
  assert.equal(mutations.counts().saves, 0);
  assert.equal(mutations.counts().emits, 0);
  assert.equal((await (await fetch(sessionUrl)).json()).workspace, null);
  assert.deepEqual(await sourceFingerprint(project.repositoryRoot), fingerprintBefore);
  assert.deepEqual(await fs.readdir(managedRoot), []);
});

test("workspace preparation rejects overlapping managed roots and only reuses an exactly valid existing workspace", async (t) => {
  const overlapApp = await startTestApp(t, {
    workspaceRoot: ({ allowedRoot }) => path.join(allowedRoot, "git-sample", "managed"),
  });
  await makeGitMigrationProject(overlapApp.allowedRoot);
  const overlapSession = await postJson(`${overlapApp.url}/api/sessions`, {
    title: "Overlap workspace",
    workbench: "migration",
    projectRoot: "git-sample/app",
    steps: [],
  });
  const overlapPrepare = await postJson(
    `${overlapApp.url}/api/sessions/${overlapSession.body.id}/workspace/prepare`,
    {},
  );
  assert.equal(overlapPrepare.response.status, 400);
  assert.equal(overlapPrepare.body.code, "workspace_overlap");
  assert.equal((await (await fetch(`${overlapApp.url}/api/sessions/${overlapSession.body.id}`)).json()).workspace, null);

  let prepareCalls = 0;
  let validateCalls = 0;
  const validateSessionIds = [];
  const fakeWorkspace = {
    projectRoot: "/tmp/source/app",
    repositoryRoot: "/tmp/source",
    projectRelativePath: "app",
    commonGitDir: "/tmp/source/.git",
    worktreeRoot: "/tmp/managed/session-1",
    executionRoot: "/tmp/managed/session-1/app",
    baseOid: "a".repeat(40),
    ownershipToken: "owner-1",
    currentCheckpointId: "initial",
  };
  const app = await startTestApp(t, {
    workspaceAdapter: {
      prepare: async () => {
        prepareCalls += 1;
        return structuredClone(fakeWorkspace);
      },
      validate: async (_workspace, { sessionId }) => {
        validateCalls += 1;
        validateSessionIds.push(sessionId);
      },
    },
  });
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Idempotent prepare",
    workbench: "migration",
    projectRoot: "sample",
    steps: [],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;

  const first = await postJson(`${sessionUrl}/workspace/prepare`, {});
  const second = await postJson(`${sessionUrl}/workspace/prepare`, {});

  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.deepEqual(second.body, first.body);
  assert.equal(prepareCalls, 1);
  assert.equal(validateCalls, 1);
  assert.deepEqual(validateSessionIds, [created.body.id]);
});

test("workspace preparation rejects foreign persisted workspaces instead of reusing them idempotently", async (t) => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  t.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  const app = await startTestApp(t, { workspaceRoot: managedRoot });
  await makeGitMigrationProject(app.allowedRoot);

  const owner = await postJson(`${app.url}/api/sessions`, {
    title: "Owned workspace",
    workbench: "migration",
    projectRoot: "git-sample/app",
    steps: [],
  });
  const ownerWorkspace = await prepareSessionWorkspace(app, owner.body.id);
  const foreign = await postJson(`${app.url}/api/sessions`, {
    title: "Foreign workspace",
    workbench: "migration",
    projectRoot: "git-sample/app",
    steps: [],
  });
  const foreignPath = path.join(app.stateRoot, `${foreign.body.id}.json`);
  const persisted = JSON.parse(await fs.readFile(foreignPath, "utf8"));
  persisted.workspace = ownerWorkspace.workspace;
  await fs.writeFile(foreignPath, `${JSON.stringify(persisted, null, 2)}\n`);

  const prepared = await postJson(`${app.url}/api/sessions/${foreign.body.id}/workspace/prepare`, {});

  assert.equal(prepared.response.status, 400);
  assert.equal(prepared.body.code, "ownership_mismatch");
});

test("workspace preparation save failures dispose unpersisted fake workspaces exactly once without publishing", async (t) => {
  const fakeWorkspace = {
    projectRoot: "/tmp/source/app",
    repositoryRoot: "/tmp/source",
    projectRelativePath: "app",
    commonGitDir: "/tmp/source/.git",
    worktreeRoot: "/tmp/managed/session-1",
    executionRoot: "/tmp/managed/session-1/app",
    baseOid: "b".repeat(40),
    ownershipToken: "owner-2",
    currentCheckpointId: "initial",
  };
  let disposeCalls = 0;
  const disposeSessionIds = [];
  const app = await startTestApp(t, {
    workspaceAdapter: {
      prepare: async () => structuredClone(fakeWorkspace),
      validate: async () => {},
      dispose: async (_workspace, { sessionId }) => {
        disposeCalls += 1;
        disposeSessionIds.push(sessionId);
      },
    },
  });
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Prepare save failure",
    workbench: "migration",
    projectRoot: "sample",
    steps: [],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  const streamAbort = new AbortController();
  t.after(() => streamAbort.abort());
  const streamResponse = await fetch(`${sessionUrl}/events`, { signal: streamAbort.signal });
  const stream = createSseReader(streamResponse);
  t.after(() => stream.cancel());
  await withTimeout(stream.next(), "initial save-failure SSE session");

  const originalRename = fs.rename;
  fs.rename = async (...args) => {
    if (path.basename(args[1]) === `${created.body.id}.json`) {
      const error = new Error("simulated prepare save failure");
      error.code = "EACCES";
      throw error;
    }
    return originalRename(...args);
  };
  t.after(() => {
    if (fs.rename !== originalRename) fs.rename = originalRename;
  });

  const prepared = await postJson(`${sessionUrl}/workspace/prepare`, {});
  const timedOut = await Promise.race([
    stream.next().then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 150)),
  ]);

  assert.equal(prepared.response.status, 400);
  assert.match(prepared.body.error, /simulated prepare save failure/i);
  assert.equal(timedOut, true);
  assert.equal((await (await fetch(sessionUrl)).json()).workspace, null);
  assert.equal(disposeCalls, 1);
  assert.deepEqual(disposeSessionIds, [created.body.id]);
  await stream.cancel();
  streamAbort.abort();
});

test("workspace preparation save failures preserve the save error when cleanup also fails", async (t) => {
  const warnings = [];
  const app = await startTestApp(t, {
    warn: (message) => warnings.push(String(message)),
    workspaceAdapter: {
      prepare: async () => ({
        projectRoot: "/tmp/source/app",
        repositoryRoot: "/tmp/source",
        projectRelativePath: "app",
        commonGitDir: "/tmp/source/.git",
        worktreeRoot: "/tmp/managed/session-cleanup",
        executionRoot: "/tmp/managed/session-cleanup/app",
        baseOid: "c".repeat(40),
        ownershipToken: "owner-3",
        currentCheckpointId: "initial",
      }),
      validate: async () => {},
      dispose: async () => {
        throw new Error("simulated cleanup failure");
      },
    },
  });
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Prepare cleanup failure",
    workbench: "migration",
    projectRoot: "sample",
    steps: [],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;

  const originalRename = fs.rename;
  fs.rename = async (...args) => {
    if (path.basename(args[1]) === `${created.body.id}.json`) {
      const error = new Error("simulated prepare save failure");
      error.code = "EACCES";
      throw error;
    }
    return originalRename(...args);
  };
  t.after(() => {
    if (fs.rename !== originalRename) fs.rename = originalRename;
  });

  const prepared = await postJson(`${sessionUrl}/workspace/prepare`, {});

  assert.equal(prepared.response.status, 400);
  assert.match(prepared.body.error, /simulated prepare save failure/i);
  assert.equal((await (await fetch(sessionUrl)).json()).workspace, null);
  assert.ok(warnings.some((message) => /Could not dispose unpersisted workspace/.test(message)));
});

test("workspace preparation save failures remove unpersisted real managed worktrees", async (t) => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  t.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  const app = await startTestApp(t, { workspaceRoot: managedRoot });
  const project = await makeGitMigrationProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Real prepare save failure",
    workbench: "migration",
    projectRoot: "git-sample/app",
    steps: [],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  const expectedWorktreeRoot = path.join(managedRoot, created.body.id);

  const originalRename = fs.rename;
  fs.rename = async (...args) => {
    if (path.basename(args[1]) === `${created.body.id}.json`) {
      const error = new Error("simulated prepare save failure");
      error.code = "EACCES";
      throw error;
    }
    return originalRename(...args);
  };
  t.after(() => {
    if (fs.rename !== originalRename) fs.rename = originalRename;
  });

  const prepared = await postJson(`${sessionUrl}/workspace/prepare`, {});
  const registeredWorktrees = await git(project.repositoryRoot, "worktree", "list", "--porcelain");

  assert.equal(prepared.response.status, 400);
  assert.match(prepared.body.error, /simulated prepare save failure/i);
  assert.equal((await (await fetch(sessionUrl)).json()).workspace, null);
  await assert.rejects(fs.access(expectedWorktreeRoot), (error) => error?.code === "ENOENT");
  assert.ok(!registeredWorktrees.includes(expectedWorktreeRoot));
  assert.deepEqual(await fs.readdir(managedRoot), []);
});

test("prepared migration actions execute and snapshot from workspace.executionRoot while source identity stays unchanged", async (t) => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  t.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  let commandRoot = null;
  const app = await startTestApp(t, {
    workspaceRoot: managedRoot,
    runCommand: async (root, action) => {
      commandRoot = root;
      return {
        command: action.command,
        cwd: path.join(root, "nested"),
        stdout: "ok\n",
        stderr: "",
        exitCode: 0,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    },
  });
  const project = await makeGitMigrationProject(app.allowedRoot);
  const fingerprintBefore = await sourceFingerprint(project.repositoryRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Execution root run",
    workbench: "migration",
    projectRoot: "git-sample/app",
    steps: [{
      title: "Run in workspace",
      action: { command: [process.execPath, "-e", ""], cwd: "nested" },
    }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;

  const prepared = await postJson(`${sessionUrl}/workspace/prepare`, {});
  assert.equal(prepared.response.status, 200);

  const run = await postJson(`${sessionUrl}/steps/0/run`, { confirmed: true });
  const reviewed = await postJson(`${sessionUrl}/steps/0/review`, { decision: "accept" });

  assert.equal(run.response.status, 200);
  assert.equal(run.body.status, "awaiting_review");
  assert.equal(commandRoot, prepared.body.workspace.executionRoot);
  assert.equal(run.body.projectRoot, project.projectRoot);
  assert.equal(run.body.attempts.length, 1);
  assert.equal(run.body.attempts[0].status, "awaiting_review");
  assert.equal(run.body.attempts[0].result.restorable, false);
  assert.equal(run.body.workspace.currentCheckpointId, "initial");
  assert.equal(
    run.body.currentSnapshot.command.cwd,
    path.join(prepared.body.workspace.executionRoot, "nested"),
  );
  assert.equal(reviewed.response.status, 200);
  assert.equal(reviewed.body.status, "completed");
  assert.equal(reviewed.body.steps[0].status, "completed");
  assert.equal(reviewed.body.attempts.length, 1);
  assert.equal(reviewed.body.attempts[0].status, "completed");
  assert.equal(reviewed.body.attempts[0].result.restorable, true);
  assert.equal(reviewed.body.workspace.currentCheckpointId, reviewed.body.attempts[0].id);
  assert.equal(reviewed.body.projectRoot, project.projectRoot);
  assert.deepEqual(await sourceFingerprint(project.repositoryRoot), fingerprintBefore);
});

test("prepared migration command runs create immutable Git checkpoints and accept makes the result restorable", async (t) => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  t.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  const app = await startTestApp(t, { workspaceRoot: managedRoot });
  const project = await makeGitMigrationProject(app.allowedRoot);
  const fingerprintBefore = await sourceFingerprint(project.repositoryRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Checkpointed migration",
    workbench: "migration",
    projectRoot: "git-sample/app",
    steps: [{
      id: "checkpointed-run",
      title: "Checkpointed run",
      action: {
        command: [
          process.execPath,
          "-e",
          "const fs=require('node:fs');fs.writeFileSync('keep.txt','after\\n');fs.writeFileSync('added.txt','new\\n');",
        ],
      },
    }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  const prepared = await prepareSessionWorkspace(app, created.body.id);

  const run = await postJson(`${sessionUrl}/steps/0/run`, { confirmed: true });

  assert.equal(run.response.status, 200);
  assert.equal(run.body.status, "awaiting_review");
  assert.equal(run.body.steps[0].status, "awaiting_review");
  assert.equal(run.body.steps[0].attempt, 1);
  assert.equal(run.body.attempts.length, 1);
  assert.equal(run.body.attempts[0].id, "attempt-1");
  assert.equal(run.body.attempts[0].status, "awaiting_review");
  assert.equal(run.body.attempts[0].baseline.oid, prepared.workspace.baseOid);
  assert.equal(
    run.body.attempts[0].baseline.ref,
    `refs/dev-workbench/checkpoints/${created.body.id}/attempt-1/baseline`,
  );
  assert.equal(
    await git(project.repositoryRoot, "rev-parse", "--verify", run.body.attempts[0].baseline.ref),
    run.body.attempts[0].baseline.oid,
  );
  assert.equal(
    run.body.attempts[0].result.ref,
    `refs/dev-workbench/checkpoints/${created.body.id}/attempt-1/result`,
  );
  assert.equal(run.body.attempts[0].result.restorable, false);
  assert.equal(
    await git(project.repositoryRoot, "rev-parse", "--verify", run.body.attempts[0].result.ref),
    run.body.attempts[0].result.oid,
  );
  assert.deepEqual(
    run.body.attempts[0].snapshot.files.map(({ path, status }) => ({ path, status })),
    [
      { path: "added.txt", status: "added" },
      { path: "keep.txt", status: "modified" },
    ],
  );
  assert.equal(
    await git(prepared.workspace.worktreeRoot, "rev-parse", "HEAD"),
    run.body.attempts[0].result.oid,
  );
  assert.deepEqual(await sourceFingerprint(project.repositoryRoot), fingerprintBefore);

  const reviewed = await postJson(`${sessionUrl}/steps/0/review`, { decision: "accept" });

  assert.equal(reviewed.response.status, 200);
  assert.equal(reviewed.body.status, "completed");
  assert.equal(reviewed.body.steps[0].status, "completed");
  assert.equal(reviewed.body.steps[0].review.decision, "accept");
  assert.equal(reviewed.body.workspace.currentCheckpointId, "attempt-1");
  assert.equal(reviewed.body.attempts.length, 1);
  assert.equal(reviewed.body.attempts[0].status, "completed");
  assert.equal(reviewed.body.attempts[0].result.restorable, true);
  assert.equal(
    await git(prepared.workspace.worktreeRoot, "rev-parse", "HEAD"),
    reviewed.body.attempts[0].result.oid,
  );
  assert.deepEqual(await sourceFingerprint(project.repositoryRoot), fingerprintBefore);
});

test("lazy attempt diffs require exact owned manifest evidence and never enter Session JSON or SSE", async (t) => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  t.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  const app = await startTestApp(t, { workspaceRoot: managedRoot });
  await makeGitMigrationProject(app.allowedRoot);
  const sentinel = "FULL_PATCH_SENTINEL_DO_NOT_PERSIST";
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Lazy diff evidence",
    workbench: "migration",
    projectRoot: "git-sample/app",
    steps: [{
      title: "Change file",
      action: {
        command: [
          process.execPath,
          "-e",
          "const s=['FULL','PATCH','SENTINEL','DO','NOT','PERSIST'].join('_');require('node:fs').writeFileSync('keep.txt',s+'\\n世界\\n')",
        ],
      },
    }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  await prepareSessionWorkspace(app, created.body.id);
  const run = await postJson(`${sessionUrl}/steps/0/run`, { confirmed: true });
  const attempt = run.body.attempts[0];
  const endpoint = `${sessionUrl}/attempts/${attempt.id}/diff`;

  assert.doesNotMatch(JSON.stringify(run.body), new RegExp(sentinel));
  const eventResponse = await fetch(`${sessionUrl}/events`);
  const stream = createSseReader(eventResponse);
  t.after(() => stream.cancel());
  assert.doesNotMatch(JSON.stringify(await withTimeout(stream.next(), "diff SSE session")), new RegExp(sentinel));

  const response = await fetch(`${endpoint}?path=${encodeURIComponent("keep.txt")}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/json; charset=utf-8$/);
  const diff = await response.json();
  assert.equal(diff.status, "modified");
  assert.equal(diff.oldPath, "keep.txt");
  assert.equal(diff.newPath, "keep.txt");
  assert.equal(diff.old.text, "before\n");
  assert.equal(diff.new.text, `${sentinel}\n世界\n`);
  assert.equal(diff.binary, false);
  assert.equal(diff.truncated, false);
  assert.ok(diff.hunks.length > 0);

  const invalidUrls = [
    endpoint,
    `${endpoint}?path=keep.txt&extra=1`,
    `${endpoint}?path=keep.txt&path=keep.txt`,
    `${endpoint}?path=${encodeURIComponent("../keep.txt")}`,
    `${endpoint}?path=${encodeURIComponent("/keep.txt")}`,
    `${endpoint}?path=${encodeURIComponent("nested\\entry.txt")}`,
    `${endpoint}?path=missing.txt`,
    `${sessionUrl}/attempts/attempt-foreign/diff?path=keep.txt`,
  ];
  for (const url of invalidUrls) {
    const invalid = await fetch(url);
    assert.ok([400, 404].includes(invalid.status), `${invalid.status} for ${url}`);
    assert.match(invalid.headers.get("content-type"), /^application\/json/);
  }
  const malformed = await requestRawJson(`${endpoint}?path=%E0%A4%A`);
  assert.equal(malformed.status, 400);
  const unsupported = await fetch(`${endpoint}?path=keep.txt`, { method: "POST" });
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get("allow"), "GET");

  const rejected = await postJson(`${sessionUrl}/steps/0/review`, { decision: "reject" });
  assert.equal(rejected.response.status, 200);
  assert.equal(rejected.body.attempts[0].status, "failed");
  const rejectedDiff = await fetch(`${endpoint}?path=keep.txt`);
  assert.equal(rejectedDiff.status, 200);
  assert.equal((await rejectedDiff.json()).new.text, `${sentinel}\n世界\n`);

  const storedPath = path.join(app.stateRoot, `${created.body.id}.json`);
  const stored = JSON.parse(await fs.readFile(storedPath, "utf8"));
  stored.attempts[0].baseline.ref = `refs/dev-workbench/checkpoints/${created.body.id}/foreign/baseline`;
  await fs.writeFile(storedPath, `${JSON.stringify(stored)}\n`);
  const foreignRef = await fetch(`${endpoint}?path=keep.txt`);
  assert.equal(foreignRef.status, 400);
  assert.equal((await foreignRef.json()).code, "checkpoint_mismatch");
});

test("lazy attempt diffs report missing result evidence", async (t) => {
  const checkpointError = Object.assign(new Error("capture failed"), { code: "checkpoint_capture_failed" });
  const adapter = createSampleWorkspaceAdapter();
  adapter.createBaseline = async (_workspace, { sessionId, attemptId }) => ({
    oid: "a".repeat(40),
    ref: `refs/dev-workbench/checkpoints/${sessionId}/${attemptId}/baseline`,
  });
  adapter.createResult = async () => { throw checkpointError; };
  adapter.restore = async () => {};
  const app = await startTestApp(t, { workspaceAdapter: adapter });
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Missing diff evidence",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ title: "Run", action: { command: [process.execPath, "-e", ""] } }],
  });
  await prepareSessionWorkspace(app, created.body.id);
  await postJson(`${app.url}/api/sessions/${created.body.id}/steps/0/run`, { confirmed: true });
  const response = await fetch(
    `${app.url}/api/sessions/${created.body.id}/attempts/attempt-1/diff?path=file.txt`,
  );
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "missing_evidence");
});

test("accept rejects dirty or drifted recoverable result worktrees without persistence or publication", async (t) => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  t.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  const app = await startTestApp(t, { workspaceRoot: managedRoot });
  await makeGitMigrationProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Review result identity",
    workbench: "migration",
    projectRoot: "git-sample/app",
    steps: [{
      title: "Change",
      action: {
        command: [process.execPath, "-e", "require('node:fs').writeFileSync('keep.txt','result\\n')"],
      },
    }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  const prepared = await prepareSessionWorkspace(app, created.body.id);
  const run = await postJson(`${sessionUrl}/steps/0/run`, { confirmed: true });
  const before = structuredClone(run.body);
  const mutations = trackSessionMutations(t, created.body.id);

  await fs.writeFile(path.join(prepared.workspace.executionRoot, "keep.txt"), "dirty\n");
  const dirty = await postJson(`${sessionUrl}/steps/0/review`, { decision: "accept" });
  assert.equal(dirty.response.status, 409);
  assert.equal(dirty.body.code, "review_evidence_mismatch");
  assert.deepEqual(mutations.counts(), { saves: 0, emits: 0 });
  assert.deepEqual(await (await fetch(sessionUrl)).json(), before);

  await fs.writeFile(path.join(prepared.workspace.executionRoot, "keep.txt"), "result\n");
  await git(
    prepared.workspace.worktreeRoot,
    "checkout",
    "--detach",
    run.body.attempts[0].baseline.oid,
  );
  const drifted = await postJson(`${sessionUrl}/steps/0/review`, { decision: "accept" });
  assert.equal(drifted.response.status, 409);
  assert.equal(drifted.body.code, "review_evidence_mismatch");
  assert.deepEqual(mutations.counts(), { saves: 0, emits: 0 });
  const persisted = await (await fetch(sessionUrl)).json();
  assert.deepEqual(persisted, before);
  assert.equal(persisted.attempts[0].result.restorable, false);
  assert.equal(persisted.workspace.currentCheckpointId, "initial");
});

test("failed checkpointed attempts retain bounded partial evidence and retry restores the exact baseline first", async (t) => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  t.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  let commandCalls = 0;
  let retryStartedClean = false;
  const app = await startTestApp(t, {
    workspaceRoot: managedRoot,
    runCommand: async (root, action) => {
      commandCalls += 1;
      const partialPath = path.join(root, "partial.txt");
      if (commandCalls === 1) {
        await fs.writeFile(partialPath, "partial\n");
        const error = new Error("intentional checkpointed failure");
        error.result = {
          command: action.command,
          cwd: root,
          stdout: "x".repeat(70 * 1024),
          stderr: "failure-tail\n",
          exitCode: 2,
        };
        throw error;
      }
      retryStartedClean = await fs.access(partialPath).then(() => false, () => true);
      await fs.writeFile(path.join(root, "keep.txt"), "retry-success\n");
      return { command: action.command, cwd: root, stdout: "ok\n", stderr: "", exitCode: 0 };
    },
  });
  const project = await makeGitMigrationProject(app.allowedRoot);
  const fingerprintBefore = await sourceFingerprint(project.repositoryRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Retry exact baseline",
    workbench: "migration",
    projectRoot: "git-sample/app",
    steps: [{ title: "Retry", action: { command: ["fake-command"] } }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  const prepared = await prepareSessionWorkspace(app, created.body.id);

  const failedRun = await postJson(`${sessionUrl}/steps/0/run`, { confirmed: true });
  const failed = await (await fetch(sessionUrl)).json();

  assert.equal(failedRun.response.status, 400);
  assert.equal(failed.steps[0].status, "failed");
  assert.equal(failed.attempts[0].status, "failed");
  assert.equal(failed.attempts[0].result.restorable, false);
  assert.equal(failed.attempts[0].snapshot.command.stdout.length, 64 * 1024);
  assert.equal(failed.attempts[0].snapshot.command.stdoutTruncated, true);
  assert.deepEqual(
    failed.attempts[0].snapshot.files.map(({ path, status }) => ({ path, status })),
    [{ path: "partial.txt", status: "added" }],
  );
  const failedDiff = await fetch(
    `${sessionUrl}/attempts/${failed.attempts[0].id}/diff?path=partial.txt`,
  );
  assert.equal(failedDiff.status, 200);
  assert.equal((await failedDiff.json()).new.text, "partial\n");
  const stale = await postJson(`${sessionUrl}/steps/0/run`, {
    confirmed: true,
    confirmedRestore: true,
    expectedAttemptId: "attempt-stale",
    expectedBaselineOid: failed.attempts[0].baseline.oid,
    expectedExecutionRoot: prepared.workspace.executionRoot,
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, "retry_confirmation_mismatch");

  const retried = await postJson(`${sessionUrl}/steps/0/run`, {
    confirmed: true,
    confirmedRestore: true,
    expectedAttemptId: failed.attempts[0].id,
    expectedBaselineOid: failed.attempts[0].baseline.oid,
    expectedExecutionRoot: prepared.workspace.executionRoot,
  });

  assert.equal(retried.response.status, 200);
  assert.equal(retryStartedClean, true);
  assert.equal(retried.body.steps[0].attempt, 2);
  assert.equal(retried.body.attempts.length, 2);
  assert.equal(retried.body.attempts[0].status, "failed");
  assert.equal(retried.body.attempts[1].status, "awaiting_review");
  assert.equal(retried.body.attempts[1].baseline.oid, failed.attempts[0].baseline.oid);
  assert.deepEqual(await sourceFingerprint(project.repositoryRoot), fingerprintBefore);
});

test("cancel signals only the exact active generation and the owning run persists cancelled evidence", async (t) => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  t.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  let commandStarted = false;
  const app = await startTestApp(t, {
    workspaceRoot: managedRoot,
    runCommand: async (root, action, { signal, onOutput }) => {
      await fs.writeFile(path.join(root, "partial.txt"), "cancelled partial\n");
      onOutput({ stream: "stdout", text: "partial output\n" });
      commandStarted = true;
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          const error = Object.assign(new Error("Command aborted"), {
            name: "AbortError",
            result: {
              command: action.command,
              cwd: root,
              stdout: "partial output\n",
              stderr: "",
              exitCode: null,
            },
          });
          reject(error);
        }, { once: true });
      });
    },
  });
  await makeGitMigrationProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Cancelable attempt",
    workbench: "migration",
    projectRoot: "git-sample/app",
    steps: [{ title: "Long run", action: { command: ["fake-long-command"] } }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  await prepareSessionWorkspace(app, created.body.id);
  const runPromise = postJson(`${sessionUrl}/steps/0/run`, { confirmed: true });
  await waitForCondition(() => commandStarted, "checkpointed command start");

  const wrong = await postJson(`${sessionUrl}/steps/0/cancel`, { attempt: 2 });
  const cancelled = await postJson(`${sessionUrl}/steps/0/cancel`, { attempt: 1 });
  const repeated = await postJson(`${sessionUrl}/steps/0/cancel`, { attempt: 1 });
  const run = await runPromise;
  const persisted = await (await fetch(sessionUrl)).json();

  assert.equal(wrong.response.status, 409);
  assert.equal(wrong.body.code, "attempt_not_active");
  assert.equal(cancelled.response.status, 202);
  assert.deepEqual(cancelled.body, { status: "cancelling", stepIndex: 0, attempt: 1 });
  assert.equal(repeated.response.status, 409);
  assert.ok(["finishing", "attempt_not_active"].includes(repeated.body.code));
  assert.equal(run.response.status, 400);
  assert.equal(persisted.steps[0].status, "cancelled");
  assert.equal(persisted.attempts[0].status, "cancelled");
  assert.equal(persisted.attempts[0].snapshot.command.stdout, "partial output\n");
  assert.deepEqual(
    persisted.attempts[0].snapshot.files.map(({ path, status }) => ({ path, status })),
    [{ path: "partial.txt", status: "added" }],
  );
  const cancelledDiff = await fetch(
    `${sessionUrl}/attempts/${persisted.attempts[0].id}/diff?path=partial.txt`,
  );
  assert.equal(cancelledDiff.status, 200);
  assert.equal((await cancelledDiff.json()).new.text, "cancelled partial\n");
  const afterFinish = await postJson(`${sessionUrl}/steps/0/cancel`, { attempt: 1 });
  assert.equal(afterFinish.response.status, 409);
  assert.equal(afterFinish.body.code, "attempt_not_active");
});

test("restore requires exact accepted evidence, inactive previews, and reports persistence reconciliation", async (t) => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  t.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  const previews = new FakePreviewSupervisor();
  previews.states.source.state = "stopped";
  previews.states.target.state = "stopped";
  const app = await startTestApp(t, { workspaceRoot: managedRoot, previews });
  const project = await makeGitMigrationProject(app.allowedRoot);
  const fingerprintBefore = await sourceFingerprint(project.repositoryRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Restore accepted checkpoint",
    workbench: "migration",
    projectRoot: "git-sample/app",
    steps: [{
      title: "Change",
      action: {
        command: [process.execPath, "-e", "require('node:fs').writeFileSync('keep.txt','changed\\n')"],
      },
    }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  const prepared = await prepareSessionWorkspace(app, created.body.id);
  const run = await postJson(`${sessionUrl}/steps/0/run`, { confirmed: true });
  const accepted = await postJson(`${sessionUrl}/steps/0/review`, { decision: "accept" });

  const stale = await postJson(`${sessionUrl}/checkpoints/initial/restore`, {
    confirmed: true,
    expectedOid: "f".repeat(40),
    expectedExecutionRoot: prepared.workspace.executionRoot,
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, "restore_confirmation_mismatch");

  previews.states.target.state = "running";
  const previewActive = await postJson(`${sessionUrl}/checkpoints/initial/restore`, {
    confirmed: true,
    expectedOid: prepared.workspace.baseOid,
    expectedExecutionRoot: prepared.workspace.executionRoot,
  });
  assert.equal(previewActive.response.status, 409);
  assert.equal(previewActive.body.code, "preview_active");
  previews.states.target.state = "stopped";

  const restored = await postJson(`${sessionUrl}/checkpoints/initial/restore`, {
    confirmed: true,
    expectedOid: prepared.workspace.baseOid,
    expectedExecutionRoot: prepared.workspace.executionRoot,
  });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.workspace.currentCheckpointId, "initial");
  assert.equal(restored.body.steps[0].status, "pending");
  assert.equal(restored.body.attempts.length, 1);
  assert.deepEqual(restored.body.attempts, accepted.body.attempts);
  assert.equal(await fs.readFile(path.join(prepared.workspace.executionRoot, "keep.txt"), "utf8"), "before\n");
  assert.deepEqual(await sourceFingerprint(project.repositoryRoot), fingerprintBefore);

  await fs.writeFile(path.join(prepared.workspace.executionRoot, "keep.txt"), "dirty\n");
  const dirty = await postJson(`${sessionUrl}/checkpoints/${run.body.attempts[0].id}/restore`, {
    confirmed: true,
    expectedOid: run.body.attempts[0].result.oid,
    expectedExecutionRoot: prepared.workspace.executionRoot,
  });
  assert.equal(dirty.response.status, 400);
  assert.equal(dirty.body.code, "workspace_dirty");

  await fs.writeFile(path.join(prepared.workspace.executionRoot, "keep.txt"), "before\n");
  const sessionPath = path.join(app.stateRoot, `${created.body.id}.json`);
  const foreignSession = JSON.parse(await fs.readFile(sessionPath, "utf8"));
  foreignSession.workspace.ownershipToken = "foreign-owner";
  await fs.writeFile(sessionPath, `${JSON.stringify(foreignSession, null, 2)}\n`);
  const foreign = await postJson(`${sessionUrl}/checkpoints/${run.body.attempts[0].id}/restore`, {
    confirmed: true,
    expectedOid: run.body.attempts[0].result.oid,
    expectedExecutionRoot: prepared.workspace.executionRoot,
  });
  assert.equal(foreign.response.status, 400);
  assert.equal(foreign.body.code, "ownership_mismatch");
});

test("restore save failure reports the intended and observed checkpoint without a second Git mutation", async (t) => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  t.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  const app = await startTestApp(t, { workspaceRoot: managedRoot });
  await makeGitMigrationProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Restore reconciliation",
    workbench: "migration",
    projectRoot: "git-sample/app",
    steps: [{
      title: "Change",
      action: {
        command: [process.execPath, "-e", "require('node:fs').writeFileSync('keep.txt','changed\\n')"],
      },
    }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  const prepared = await prepareSessionWorkspace(app, created.body.id);
  await postJson(`${sessionUrl}/steps/0/run`, { confirmed: true });
  await postJson(`${sessionUrl}/steps/0/review`, { decision: "accept" });
  const originalRename = fs.rename;
  fs.rename = async (...args) => {
    if (path.basename(args[1]) === `${created.body.id}.json`) {
      throw new Error("simulated restore save failure");
    }
    return originalRename(...args);
  };
  t.after(() => {
    if (fs.rename !== originalRename) fs.rename = originalRename;
  });

  const restored = await postJson(`${sessionUrl}/checkpoints/initial/restore`, {
    confirmed: true,
    expectedOid: prepared.workspace.baseOid,
    expectedExecutionRoot: prepared.workspace.executionRoot,
  });

  assert.equal(restored.response.status, 409);
  assert.equal(restored.body.code, "reconciliation_required");
  assert.deepEqual(restored.body.details, {
    expected: prepared.workspace.baseOid,
    observed: prepared.workspace.baseOid,
  });
});

test("checkpointed run save failure reports result reconciliation after Git normalization", async (t) => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  t.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  let failNextSave = false;
  const app = await startTestApp(t, {
    workspaceRoot: managedRoot,
    runCommand: async (root, action) => {
      await fs.writeFile(path.join(root, "keep.txt"), "normalized result\n");
      failNextSave = true;
      return { command: action.command, cwd: root, stdout: "", stderr: "", exitCode: 0 };
    },
  });
  await makeGitMigrationProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Run reconciliation",
    workbench: "migration",
    projectRoot: "git-sample/app",
    steps: [{ title: "Change", action: { command: ["fake-command"] } }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  const prepared = await prepareSessionWorkspace(app, created.body.id);
  const originalRename = fs.rename;
  fs.rename = async (...args) => {
    if (failNextSave && path.basename(args[1]) === `${created.body.id}.json`) {
      failNextSave = false;
      throw new Error("simulated result save failure");
    }
    return originalRename(...args);
  };
  t.after(() => {
    if (fs.rename !== originalRename) fs.rename = originalRename;
  });

  const run = await postJson(`${sessionUrl}/steps/0/run`, { confirmed: true });
  const observed = await git(prepared.workspace.worktreeRoot, "rev-parse", "HEAD");

  assert.equal(run.response.status, 409);
  assert.equal(run.body.code, "reconciliation_required");
  assert.deepEqual(run.body.details, { expected: observed, observed });
  const persisted = await (await fetch(sessionUrl)).json();
  assert.equal(persisted.steps[0].status, "running");
  assert.equal(persisted.attempts[0].status, "running");
});

test("result checkpoint capture failure persists explicit evidence failure and returns reconciliation details", async (t) => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  t.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  let commandCalls = 0;
  const captureError = Object.assign(new Error("simulated result capture failure"), {
    name: "GitWorkspaceError",
    code: "checkpoint_capture_failed",
  });
  const app = await startTestApp(t, {
    workspaceRoot: managedRoot,
    workspaceAdapter: {
      createBaseline: createBaselineCheckpoint,
      createResult: async () => { throw captureError; },
      restore: restoreCheckpoint,
    },
    runCommand: async (root, action) => {
      commandCalls += 1;
      await fs.writeFile(path.join(root, "partial.txt"), "partial\n");
      throw Object.assign(new Error("simulated command failure"), {
        result: {
          command: action.command,
          cwd: root,
          stdout: "partial\n",
          stderr: "command failed\n",
          exitCode: 2,
        },
      });
    },
  });
  await makeGitMigrationProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Capture failure",
    workbench: "migration",
    projectRoot: "git-sample/app",
    steps: [{ title: "Change", action: { command: ["fake-command"] } }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  const prepared = await prepareSessionWorkspace(app, created.body.id);
  const mutations = trackSessionMutations(t, created.body.id);

  const run = await postJson(`${sessionUrl}/steps/0/run`, { confirmed: true });

  assert.equal(run.response.status, 409);
  assert.equal(run.body.code, "reconciliation_required");
  assert.deepEqual(run.body.details.expected, {
    ref: `refs/dev-workbench/checkpoints/${created.body.id}/attempt-1/result`,
    oid: null,
  });
  assert.equal(run.body.details.observed, prepared.workspace.baseOid);
  assert.deepEqual(run.body.details.captureError, {
    name: "GitWorkspaceError",
    message: "simulated result capture failure",
    code: "checkpoint_capture_failed",
  });
  assert.equal(commandCalls, 1);
  assert.deepEqual(mutations.counts(), { saves: 2, emits: 2 });
  const persisted = await (await fetch(sessionUrl)).json();
  assert.equal(persisted.status, "failed");
  assert.equal(persisted.steps[0].status, "failed");
  assert.equal(persisted.steps[0].error.message, "simulated result capture failure");
  assert.equal(persisted.attempts[0].status, "failed");
  assert.deepEqual(persisted.attempts[0].evidenceError, run.body.details.captureError);
  assert.equal(Object.hasOwn(persisted.attempts[0], "result"), false);
  assert.equal(Object.hasOwn(persisted.attempts[0], "snapshot"), false);
  const cancel = await postJson(`${sessionUrl}/steps/0/cancel`, { attempt: 1 });
  assert.equal(cancel.response.status, 409);
  assert.equal(cancel.body.code, "attempt_not_active");
});

test("two accepted checkpoints restore both directions with append-only history and one mutation each", async (t) => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  t.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  let blockNextRestore = false;
  let restoreClaimedResolve;
  let releaseRestore;
  const restoreClaimed = new Promise((resolve) => { restoreClaimedResolve = resolve; });
  const restoreBlocked = new Promise((resolve) => { releaseRestore = resolve; });
  const app = await startTestApp(t, {
    workspaceRoot: managedRoot,
    afterSessionClaim: async ({ operation }) => {
      if (operation !== "restore" || !blockNextRestore) return;
      blockNextRestore = false;
      restoreClaimedResolve();
      await restoreBlocked;
    },
  });
  const project = await makeGitMigrationProject(app.allowedRoot);
  const fingerprintBefore = await sourceFingerprint(project.repositoryRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Two restore boundaries",
    workbench: "migration",
    projectRoot: "git-sample/app",
    steps: [
      {
        id: "first",
        title: "First",
        action: {
          command: [process.execPath, "-e", "require('node:fs').writeFileSync('first.txt','first\\n')"],
        },
      },
      {
        id: "second",
        title: "Second",
        dependsOn: ["first"],
        action: {
          command: [process.execPath, "-e", "require('node:fs').writeFileSync('second.txt','second\\n')"],
        },
      },
    ],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  const prepared = await prepareSessionWorkspace(app, created.body.id);
  await postJson(`${sessionUrl}/steps/0/run`, { confirmed: true });
  const firstAccepted = await postJson(`${sessionUrl}/steps/0/review`, { decision: "accept" });
  await postJson(`${sessionUrl}/steps/1/run`, { confirmed: true });
  const secondAccepted = await postJson(`${sessionUrl}/steps/1/review`, { decision: "accept" });
  const attemptsBefore = structuredClone(secondAccepted.body.attempts);
  const eventsBefore = structuredClone(secondAccepted.body.events);
  const mutations = trackSessionMutations(t, created.body.id);

  const initial = await postJson(`${sessionUrl}/checkpoints/initial/restore`, {
    confirmed: true,
    expectedOid: prepared.workspace.baseOid,
    expectedExecutionRoot: prepared.workspace.executionRoot,
  });
  assert.equal(initial.response.status, 200);
  assert.deepEqual(mutations.counts(), { saves: 1, emits: 1 });
  assert.deepEqual(mutations.operations(), ["save", "emit"]);
  assert.equal(initial.body.workspace.currentCheckpointId, "initial");
  assert.deepEqual(initial.body.steps.map(({ status }) => status), ["pending", "pending"]);
  assert.deepEqual(initial.body.attempts, attemptsBefore);
  assert.deepEqual(initial.body.events.slice(0, eventsBefore.length), eventsBefore);

  const firstAttempt = firstAccepted.body.attempts[0];
  const first = await postJson(`${sessionUrl}/checkpoints/${firstAttempt.id}/restore`, {
    confirmed: true,
    expectedOid: firstAttempt.result.oid,
    expectedExecutionRoot: prepared.workspace.executionRoot,
  });
  assert.equal(first.response.status, 200);
  assert.deepEqual(mutations.counts(), { saves: 2, emits: 2 });
  assert.equal(first.body.workspace.currentCheckpointId, firstAttempt.id);
  assert.deepEqual(first.body.steps.map(({ status }) => status), ["completed", "pending"]);
  assert.deepEqual(first.body.attempts, attemptsBefore);
  assert.deepEqual(first.body.events.slice(0, eventsBefore.length), eventsBefore);
  assert.deepEqual(
    first.body.events.slice(eventsBefore.length).map(({ type, checkpointId }) => ({ type, checkpointId })),
    [
      { type: "workspace.restored", checkpointId: "initial" },
      { type: "workspace.restored", checkpointId: firstAttempt.id },
    ],
  );
  await assert.rejects(
    fs.access(path.join(prepared.workspace.executionRoot, "second.txt")),
    (error) => error.code === "ENOENT",
  );

  blockNextRestore = true;
  const repeated = postJson(`${sessionUrl}/checkpoints/${firstAttempt.id}/restore`, {
    confirmed: true,
    expectedOid: firstAttempt.result.oid,
    expectedExecutionRoot: prepared.workspace.executionRoot,
  });
  await withTimeout(restoreClaimed, "first concurrent restore claim");
  const concurrent = await postJson(`${sessionUrl}/checkpoints/${firstAttempt.id}/restore`, {
    confirmed: true,
    expectedOid: firstAttempt.result.oid,
    expectedExecutionRoot: prepared.workspace.executionRoot,
  });
  assert.equal(concurrent.response.status, 409);
  releaseRestore();
  const repeatedResult = await repeated;
  assert.equal(repeatedResult.response.status, 200);
  assert.deepEqual(mutations.counts(), { saves: 3, emits: 3 });
  assert.deepEqual(repeatedResult.body.attempts, attemptsBefore);
  assert.equal(repeatedResult.body.events.at(-1).type, "workspace.restored");
  assert.equal(repeatedResult.body.events.at(-1).checkpointId, firstAttempt.id);
  assert.deepEqual(await sourceFingerprint(project.repositoryRoot), fingerprintBefore);
});

test("retry rejects each missing confirmation field without spawning or appending an attempt", async (t) => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  t.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  let commandCalls = 0;
  const app = await startTestApp(t, {
    workspaceRoot: managedRoot,
    runCommand: async (root, action) => {
      commandCalls += 1;
      const error = new Error("first attempt fails");
      error.result = { command: action.command, cwd: root, stdout: "", stderr: "", exitCode: 1 };
      throw error;
    },
  });
  await makeGitMigrationProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Missing retry confirmation",
    workbench: "migration",
    projectRoot: "git-sample/app",
    steps: [{ title: "Retry", action: { command: ["fake-command"] } }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  const prepared = await prepareSessionWorkspace(app, created.body.id);
  await postJson(`${sessionUrl}/steps/0/run`, { confirmed: true });
  const failed = await (await fetch(sessionUrl)).json();
  const complete = {
    confirmed: true,
    confirmedRestore: true,
    expectedAttemptId: failed.attempts[0].id,
    expectedBaselineOid: failed.attempts[0].baseline.oid,
    expectedExecutionRoot: prepared.workspace.executionRoot,
  };

  for (const missing of [
    "confirmedRestore",
    "expectedAttemptId",
    "expectedBaselineOid",
    "expectedExecutionRoot",
  ]) {
    const body = { ...complete };
    delete body[missing];
    const result = await postJson(`${sessionUrl}/steps/0/run`, body);
    assert.equal(result.response.status, 409, missing);
    assert.equal(result.body.code, "retry_confirmation_mismatch", missing);
    const persisted = await (await fetch(sessionUrl)).json();
    assert.equal(persisted.attempts.length, 1, missing);
    assert.equal(persisted.steps[0].attempt, 1, missing);
  }
  assert.equal(commandCalls, 1);
});

test("a stale cancel cannot abort active retry attempt two", async (t) => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  t.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  let commandCalls = 0;
  let retryStarted = false;
  let retryAborted = false;
  const app = await startTestApp(t, {
    workspaceRoot: managedRoot,
    runCommand: async (root, action, { signal }) => {
      commandCalls += 1;
      if (commandCalls === 1) {
        const error = new Error("first attempt fails");
        error.result = { command: action.command, cwd: root, stdout: "", stderr: "", exitCode: 1 };
        throw error;
      }
      retryStarted = true;
      await new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          retryAborted = true;
          reject(Object.assign(new Error("Command aborted"), {
            name: "AbortError",
            result: { command: action.command, cwd: root, stdout: "", stderr: "", exitCode: null },
          }));
        }, { once: true });
      });
    },
  });
  await makeGitMigrationProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Cancel generation",
    workbench: "migration",
    projectRoot: "git-sample/app",
    steps: [{ title: "Retry", action: { command: ["fake-command"] } }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  const prepared = await prepareSessionWorkspace(app, created.body.id);
  await postJson(`${sessionUrl}/steps/0/run`, { confirmed: true });
  const failed = await (await fetch(sessionUrl)).json();
  const retry = postJson(`${sessionUrl}/steps/0/run`, {
    confirmed: true,
    confirmedRestore: true,
    expectedAttemptId: failed.attempts[0].id,
    expectedBaselineOid: failed.attempts[0].baseline.oid,
    expectedExecutionRoot: prepared.workspace.executionRoot,
  });
  await waitForCondition(() => retryStarted, "retry attempt two start");

  const stale = await postJson(`${sessionUrl}/steps/0/cancel`, { attempt: 1 });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, "attempt_not_active");
  assert.equal(retryAborted, false);
  const current = await postJson(`${sessionUrl}/steps/0/cancel`, { attempt: 2 });
  assert.equal(current.response.status, 202);
  await retry;
  const persisted = await (await fetch(sessionUrl)).json();
  assert.equal(persisted.attempts[0].status, "failed");
  assert.equal(persisted.attempts[1].status, "cancelled");
});

test("shutdown owns checkpointed abort finalization and rejects a late user cancel", async (t) => {
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  t.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  let commandStartedResolve;
  let shutdownSignalledResolve;
  let releaseCommand;
  let releaseStopAll;
  const commandStarted = new Promise((resolve) => { commandStartedResolve = resolve; });
  const shutdownSignalled = new Promise((resolve) => { shutdownSignalledResolve = resolve; });
  const commandBlocked = new Promise((resolve) => { releaseCommand = resolve; });
  const stopAllBlocked = new Promise((resolve) => { releaseStopAll = resolve; });
  const previews = new FakePreviewSupervisor();
  previews.stopAll = async () => {
    previews.stopAllCalls += 1;
    await stopAllBlocked;
  };
  const app = await startTestApp(t, {
    workspaceRoot: managedRoot,
    previews,
    runCommand: async (root, action, { signal }) => {
      commandStartedResolve();
      await new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          shutdownSignalledResolve();
          resolve();
        }, { once: true });
      });
      await commandBlocked;
      throw Object.assign(new Error("Command aborted"), {
        name: "AbortError",
        result: { command: action.command, cwd: root, stdout: "", stderr: "", exitCode: null },
      });
    },
  });
  await makeGitMigrationProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Checkpoint shutdown",
    workbench: "migration",
    projectRoot: "git-sample/app",
    steps: [{ title: "Long", action: { command: ["fake-long-command"] } }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  await prepareSessionWorkspace(app, created.body.id);
  const run = postJson(`${sessionUrl}/steps/0/run`, { confirmed: true });
  await withTimeout(commandStarted, "checkpointed shutdown command");
  const closed = new Promise((resolve) => app.server.once("close", resolve));
  app.server.close();
  await withTimeout(shutdownSignalled, "checkpointed shutdown signal");

  const lateCancel = await postJson(`${sessionUrl}/steps/0/cancel`, { attempt: 1 });
  assert.equal(lateCancel.response.status, 409);
  assert.equal(lateCancel.body.code, "finishing");
  releaseCommand();
  assert.equal((await withTimeout(run, "checkpointed shutdown run")).response.status, 400);
  const persisted = JSON.parse(await fs.readFile(
    path.join(app.stateRoot, `${created.body.id}.json`),
    "utf8",
  ));
  assert.equal(persisted.steps[0].status, "failed");
  assert.equal(persisted.steps[0].error.message, "Command aborted by server shutdown");
  assert.equal(persisted.attempts[0].status, "failed");
  releaseStopAll();
  await withTimeout(closed, "checkpointed shutdown close");
});

test("invalid review targets, state, media type, and workbench neither mutate nor publish", async (t) => {
  const app = await startTestApp(t);
  await makeSampleProject(app.allowedRoot);
  const migration = await postJson(`${app.url}/api/sessions`, {
    title: "Review validation",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ title: "Pending", traceState: { ready: true } }],
  });
  const migrationUrl = `${app.url}/api/sessions/${migration.body.id}`;
  const pendingBefore = await (await fetch(migrationUrl)).json();
  const mutations = trackSessionMutations(t, migration.body.id);
  const countsBefore = mutations.counts();

  const unknownIndex = await postJson(`${migrationUrl}/steps/9/review`, { decision: "accept" });
  assert.equal(unknownIndex.response.status, 400);
  const wrongState = await postJson(`${migrationUrl}/steps/0/review`, { decision: "accept" });
  assert.equal(wrongState.response.status, 400);
  const wrongContentType = await fetch(`${migrationUrl}/steps/0/review`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ decision: "accept" }),
  });
  assert.equal(wrongContentType.status, 415);
  assert.deepEqual(mutations.counts(), countsBefore);
  assert.deepEqual(await (await fetch(migrationUrl)).json(), pendingBefore);

  const runnable = await postJson(`${migrationUrl}/steps/0/run`, {});
  assert.equal(runnable.response.status, 200);

  const execution = await postJson(`${app.url}/api/sessions`, {
    title: "Execution cannot review",
    workbench: "execution",
    projectRoot: "sample",
    steps: [{ title: "Execute", traceState: { done: true } }],
  });
  const executionUrl = `${app.url}/api/sessions/${execution.body.id}`;
  assert.equal((await postJson(`${executionUrl}/steps/0/run`, {})).response.status, 200);
  const executionBefore = await (await fetch(executionUrl)).json();
  const wrongWorkbench = await postJson(`${executionUrl}/steps/0/review`, { decision: "accept" });
  assert.equal(wrongWorkbench.response.status, 400);
  assert.deepEqual(await (await fetch(executionUrl)).json(), executionBefore);
  assert.equal((await postJson(`${executionUrl}/annotations`, { stepIndex: 0, text: "Lock released" })).response.status, 201);

  const missingId = "00000000-0000-4000-8000-000000000000";
  const unknownSession = await postJson(`${app.url}/api/sessions/${missingId}/steps/0/review`, { decision: "accept" });
  assert.equal(unknownSession.response.status, 404);
  const repeatedUnknown = await postJson(`${app.url}/api/sessions/${missingId}/steps/0/review`, { decision: "accept" });
  assert.equal(repeatedUnknown.response.status, 404);
});

test("run and review share one lock, concurrent reviews return 409, and failures release it", async (t) => {
  let releaseOperation;
  let signalOperationClaimed;
  let blockedOperation;
  let blockedName = "run";
  let blockPending = false;
  const resetBlock = (name) => {
    blockedName = name;
    blockPending = true;
    blockedOperation = new Promise((resolve) => { releaseOperation = resolve; });
    return new Promise((resolve) => { signalOperationClaimed = resolve; });
  };
  let operationClaimed = resetBlock("run");
  t.after(() => releaseOperation());
  const app = await startTestApp(t, {
    afterSessionClaim: ({ operation }) => {
      if (operation !== blockedName || !blockPending) return undefined;
      blockPending = false;
      signalOperationClaimed();
      return blockedOperation;
    },
  });
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Locked review",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ title: "Review", traceState: { ready: true } }],
  });
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;

  const runRequest = postJson(`${sessionUrl}/steps/0/run`, {});
  await withTimeout(operationClaimed, "run claim");
  const reviewDuringRun = await postJson(`${sessionUrl}/steps/0/review`, { decision: "accept" });
  assert.equal(reviewDuringRun.response.status, 409);
  releaseOperation();
  assert.equal((await withTimeout(runRequest, "run completion")).response.status, 200);

  operationClaimed = resetBlock("review");
  const firstReviewRequest = postJson(`${sessionUrl}/steps/0/review`, { decision: "accept" });
  await withTimeout(operationClaimed, "review claim");
  const duplicateReview = await postJson(`${sessionUrl}/steps/0/review`, { decision: "accept" });
  const runDuringReview = await postJson(`${sessionUrl}/steps/0/run`, {});
  assert.equal(duplicateReview.response.status, 409);
  assert.equal(runDuringReview.response.status, 409);
  releaseOperation();
  assert.equal((await withTimeout(firstReviewRequest, "review completion")).response.status, 200);

  const repeatedReview = await postJson(`${sessionUrl}/steps/0/review`, { decision: "accept" });
  assert.equal(repeatedReview.response.status, 400);
  const annotation = await postJson(`${sessionUrl}/annotations`, { stepIndex: 0, text: "Released" });
  assert.equal(annotation.response.status, 201);
});

test("run preserves the real post-completion persistence error and releases the lock", async (t) => {
  let app;
  let sessionId;
  let failingRename;
  const sentinelMessage = "sentinel post-completion persistence failure";
  const appOptions = {
    workspaceAdapter: createSampleWorkspaceAdapter(),
    runCommand: async () => {
      const originalRename = fs.rename;
      const destination = path.join(app.stateRoot, `${sessionId}.json`);
      failingRename = async (...args) => {
        if (args[1] === destination) {
          fs.rename = originalRename;
          throw new Error(sentinelMessage);
        }
        return originalRename(...args);
      };
      fs.rename = failingRename;
      return { command: ["true"], stdout: "", stderr: "", exitCode: 0 };
    },
  };
  app = await startTestApp(t, appOptions);
  const originalRename = fs.rename;
  t.after(() => {
    if (fs.rename === failingRename) fs.rename = originalRename;
  });
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Persistence failure",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ title: "Command", action: { command: ["true"] } }],
  });
  sessionId = created.body.id;
  const sessionUrl = `${app.url}/api/sessions/${created.body.id}`;
  await prepareSessionWorkspace(app, created.body.id);

  const run = await postJson(`${sessionUrl}/steps/0/run`, { confirmed: true });

  assert.equal(run.response.status, 400);
  assert.equal(run.body.error, sentinelMessage);
  assert.doesNotMatch(run.body.error, /not running/i);
  const stored = await (await fetch(sessionUrl)).json();
  assert.equal(stored.steps[0].status, "running");
  const annotation = await postJson(`${sessionUrl}/annotations`, { stepIndex: 0, text: "Lock released" });
  assert.equal(annotation.response.status, 201);
});

test("runtime snapshot is available only for existing Migration sessions", async (t) => {
  const terminal = new TerminalBuffer();
  const previews = new FakePreviewSupervisor();
  const app = await startTestApp(t, { terminal, previews });
  await makeSampleProject(app.allowedRoot);
  const migration = await postJson(`${app.url}/api/sessions`, {
    title: "Runtime",
    workbench: "migration",
    projectRoot: "sample",
    steps: [],
  });
  terminal.append(migration.body.id, {
    source: "preview:source",
    stream: "stdout",
    text: "ready\n",
  });

  const response = await fetch(`${app.url}/api/sessions/${migration.body.id}/runtime`);
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(Number.isNaN(Date.parse(snapshot.events[0].at)), false);
  delete snapshot.events[0].at;
  assert.deepEqual(snapshot, {
    source: previews.states.source,
    target: previews.states.target,
    events: [{
      type: "terminal.output",
      sequence: 1,
      source: "preview:source",
      stream: "stdout",
      text: "ready\n",
    }],
    latestSequence: 1,
  });

  const execution = await postJson(`${app.url}/api/sessions`, {
    title: "Execution",
    workbench: "execution",
    projectRoot: "sample",
    steps: [],
  });
  assert.equal((await fetch(`${app.url}/api/sessions/${execution.body.id}/runtime`)).status, 400);
  assert.equal((await fetch(`${app.url}/api/sessions/00000000-0000-4000-8000-000000000000/runtime`)).status, 404);
});

test("runtime SSE sends a snapshot followed by preview and terminal events and cleans up", async (t) => {
  const terminal = new TerminalBuffer();
  const previews = new FakePreviewSupervisor();
  const app = await startTestApp(t, { terminal, previews, heartbeatIntervalMs: 5 });
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Live runtime",
    workbench: "migration",
    projectRoot: "sample",
    steps: [],
  });
  const abort = new AbortController();
  t.after(() => abort.abort());
  const response = await fetch(`${app.url}/api/sessions/${created.body.id}/runtime/events`, {
    signal: abort.signal,
  });
  assert.equal(response.status, 200);
  const stream = createSseReader(response);
  t.after(() => stream.cancel());

  const initial = await withTimeout(stream.next(), "runtime snapshot");
  assert.equal(initial.type, "runtime.snapshot");
  assert.equal(initial.latestSequence, 0);
  const previewEvent = previews.publish(created.body.id, "source", { state: "running" });
  assert.deepEqual(await withTimeout(stream.next(), "preview state"), previewEvent);
  const output = terminal.append(created.body.id, {
    source: "preview:source",
    stream: "stderr",
    text: "warning\n",
  });
  assert.deepEqual(await withTimeout(stream.next(), "terminal output"), output);

  await stream.cancel();
  abort.abort();
  await waitForCondition(
    () => !previews.listeners.has(created.body.id)
      && terminal.sessions.get(created.body.id).listeners.size === 0,
    "runtime SSE cleanup",
  );
  assert.equal(previews.listeners.has(created.body.id), false);
  assert.equal(terminal.sessions.get(created.body.id).listeners.size, 0);
});

test("runtime SSE does not replay buffered events already represented by the snapshot", async (t) => {
  const terminal = new TerminalBuffer();
  const previews = new FakePreviewSupervisor();
  let snapshotStarted;
  let releaseSnapshot;
  const started = new Promise((resolve) => { snapshotStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseSnapshot = resolve; });
  previews.snapshot = async () => {
    snapshotStarted();
    await blocked;
    return structuredClone(previews.states);
  };
  t.after(() => releaseSnapshot());
  const app = await startTestApp(t, { terminal, previews });
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Ordered runtime",
    workbench: "migration",
    projectRoot: "sample",
    steps: [],
  });
  const abort = new AbortController();
  t.after(() => abort.abort());
  const responsePromise = fetch(`${app.url}/api/sessions/${created.body.id}/runtime/events`, {
    signal: abort.signal,
  });
  await withTimeout(started, "delayed runtime snapshot");

  previews.publish(created.body.id, "source", { state: "starting" });
  previews.publish(created.body.id, "source", { state: "running" });
  const output = terminal.append(created.body.id, {
    source: "preview:source",
    stream: "stdout",
    text: "during snapshot\n",
  });
  releaseSnapshot();

  const response = await withTimeout(responsePromise, "ordered runtime SSE response");
  const stream = createSseReader(response);
  t.after(() => stream.cancel());
  const initial = await withTimeout(stream.next(), "ordered runtime snapshot");
  assert.equal(initial.type, "runtime.snapshot");
  assert.deepEqual(initial.source, { state: "running", latestSequence: 2 });
  assert.equal(initial.latestSequence, output.sequence);

  const laterPreview = previews.publish(created.body.id, "source", { state: "exited" });
  const laterOutput = terminal.append(created.body.id, {
    source: "preview:source",
    stream: "stdout",
    text: "after snapshot\n",
  });
  assert.deepEqual(await withTimeout(stream.next(), "post-snapshot preview state"), laterPreview);
  assert.deepEqual(await withTimeout(stream.next(), "post-snapshot terminal output"), laterOutput);
  await stream.cancel();
  abort.abort();
  await waitForCondition(
    () => !previews.listeners.has(created.body.id)
      && terminal.sessions.get(created.body.id).listeners.size === 0,
    "ordered runtime SSE cleanup",
  );
});

test("runtime SSE replays buffered events captured after their snapshot cutoff", async (t) => {
  const terminal = new TerminalBuffer();
  const previews = new FakePreviewSupervisor();
  let snapshotStarted;
  let releaseSnapshot;
  const started = new Promise((resolve) => { snapshotStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseSnapshot = resolve; });
  previews.snapshot = async () => {
    const captured = structuredClone(previews.states);
    snapshotStarted();
    await blocked;
    return captured;
  };
  const originalTerminalSnapshot = terminal.snapshot.bind(terminal);
  let lateOutput;
  terminal.snapshot = (sessionId) => {
    const captured = originalTerminalSnapshot(sessionId);
    lateOutput ??= terminal.append(sessionId, {
      source: "preview:source",
      stream: "stderr",
      text: "after terminal cutoff\n",
    });
    return captured;
  };
  t.after(() => releaseSnapshot());
  const app = await startTestApp(t, { terminal, previews });
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Runtime cutoff",
    workbench: "migration",
    projectRoot: "sample",
    steps: [],
  });
  const abort = new AbortController();
  t.after(() => abort.abort());
  const responsePromise = fetch(`${app.url}/api/sessions/${created.body.id}/runtime/events`, {
    signal: abort.signal,
  });
  await withTimeout(started, "preview snapshot cutoff");
  const starting = previews.publish(created.body.id, "source", { state: "starting" });
  const stopped = previews.publish(created.body.id, "source", { state: "stopped" });
  releaseSnapshot();

  const response = await withTimeout(responsePromise, "cutoff runtime SSE response");
  const stream = createSseReader(response);
  t.after(() => stream.cancel());
  const initial = await withTimeout(stream.next(), "cutoff runtime snapshot");
  assert.equal(initial.type, "runtime.snapshot");
  assert.deepEqual(initial.source, {
    state: "stopped",
    actualUrl: "http://127.0.0.1:4173/",
    latestSequence: 0,
  });
  assert.equal(initial.latestSequence, 0);
  assert.deepEqual(await withTimeout(stream.next(), "post-cutoff starting state"), starting);
  assert.deepEqual(await withTimeout(stream.next(), "post-cutoff stopped state"), stopped);
  assert.deepEqual(await withTimeout(stream.next(), "post-cutoff terminal output"), lateOutput);
  await stream.cancel();
  abort.abort();
  await waitForCondition(
    () => !previews.listeners.has(created.body.id)
      && terminal.sessions.get(created.body.id).listeners.size === 0,
    "cutoff runtime SSE cleanup",
  );
});

test("preview lifecycle routes validate exact paths, media type, and empty object", async (t) => {
  const previews = new FakePreviewSupervisor();
  const app = await startTestApp(t, {
    previews,
    terminal: new TerminalBuffer(),
    workspaceAdapter: createSampleWorkspaceAdapter(),
  });
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Preview controls",
    workbench: "migration",
    projectRoot: "sample",
    steps: [],
  });
  await prepareSessionWorkspace(app, created.body.id);
  const base = `${app.url}/api/sessions/${created.body.id}/previews`;

  for (const [action, expectedCall] of [
    ["start", "start"],
    ["stop", "stop"],
    ["restart", "restart"],
  ]) {
    const result = await postJson(`${base}/source/${action}`, {});
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.body, previews.states.source);
    assert.equal(previews.calls.at(-1)[0], expectedCall);
  }

  assert.equal((await postJson(`${base}/other/start`, {})).response.status, 404);
  assert.equal((await postJson(`${base}/source/pause`, {})).response.status, 404);
  assert.equal((await postJson(`${base}/source/start/extra`, {})).response.status, 404);
  assert.equal((await postJson(`${base}/source/start`, { extra: true })).response.status, 400);
  assert.equal((await fetch(`${base}/source/start`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  })).status, 415);
  assert.equal((await fetch(`${base}/source/start`, { method: "POST" })).status, 415);
});

test("preview supervisor conflict is returned while independent slots may overlap", async (t) => {
  let releaseSource;
  let sourceStarted;
  const sourceBlocked = new Promise((resolve) => { releaseSource = resolve; });
  const sourceClaimed = new Promise((resolve) => { sourceStarted = resolve; });
  const previews = new FakePreviewSupervisor();
  let sourceActive = false;
  previews.start = async (session, slot) => {
    if (slot === "source") {
      if (sourceActive) {
        const error = new Error("Preview operation already in progress");
        error.statusCode = 409;
        throw error;
      }
      sourceActive = true;
      sourceStarted();
      await sourceBlocked;
      sourceActive = false;
    }
    return previews.states[slot];
  };
  const app = await startTestApp(t, {
    previews,
    terminal: new TerminalBuffer(),
    workspaceAdapter: createSampleWorkspaceAdapter(),
  });
  t.after(() => releaseSource());
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Independent controls",
    workbench: "migration",
    projectRoot: "sample",
    steps: [],
  });
  await prepareSessionWorkspace(app, created.body.id);
  const base = `${app.url}/api/sessions/${created.body.id}/previews`;
  const first = postJson(`${base}/source/start`, {});
  await withTimeout(sourceClaimed, "source preview claim");
  assert.equal((await postJson(`${base}/source/start`, {})).response.status, 409);
  assert.equal((await postJson(`${base}/target/start`, {})).response.status, 200);
  releaseSource();
  assert.equal((await withTimeout(first, "source preview completion")).response.status, 200);
});

test("Migration command output streams to terminal and failed command evidence is retained", async (t) => {
  const terminal = new TerminalBuffer();
  const commandResult = {
    command: ["failing-command"],
    cwd: ".",
    stdout: "partial output\n",
    stderr: "failure evidence\n",
    exitCode: 2,
    startedAt: "2026-07-27T00:00:00.000Z",
    completedAt: "2026-07-27T00:00:01.000Z",
  };
  const app = await startTestApp(t, {
    terminal,
    previews: new FakePreviewSupervisor(),
    workspaceAdapter: createSampleWorkspaceAdapter(),
    runCommand: async (_root, _action, options) => {
      options.onOutput({ stream: "stdout", text: "partial output\n" });
      options.onOutput({ stream: "stderr", text: "failure evidence\n" });
      const error = new Error("Command exited with code 2");
      error.result = commandResult;
      throw error;
    },
  });
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Failed evidence",
    workbench: "migration",
    projectRoot: "sample",
    steps: [{ title: "Fail", action: { command: ["failing-command"] } }],
  });
  await prepareSessionWorkspace(app, created.body.id);

  const run = await postJson(`${app.url}/api/sessions/${created.body.id}/steps/0/run`, {
    confirmed: true,
  });
  assert.equal(run.response.status, 400);
  const events = terminal.snapshot(created.body.id).events;
  assert.deepEqual(events.map(({ source, stream, text }) => ({ source, stream, text })), [
    { source: "step:0", stream: "stdout", text: "partial output\n" },
    { source: "step:0", stream: "stderr", text: "failure evidence\n" },
  ]);
  const stored = await (await fetch(`${app.url}/api/sessions/${created.body.id}`)).json();
  assert.equal(stored.steps[0].status, "failed");
  assert.deepEqual(stored.currentSnapshot.command, commandResult);
});

test("managed shutdown aborts steps, stops previews once, and delays close callbacks", async (t) => {
  let commandStarted;
  const started = new Promise((resolve) => { commandStarted = resolve; });
  let stopAllResolve;
  const stopAllBlocked = new Promise((resolve) => { stopAllResolve = resolve; });
  const previews = new FakePreviewSupervisor();
  previews.stopAll = async () => {
    previews.stopAllCalls += 1;
    await stopAllBlocked;
  };
  const app = await startTestApp(t, {
    previews,
    terminal: new TerminalBuffer(),
    workspaceAdapter: createSampleWorkspaceAdapter(),
    runCommand: async (_root, action, { signal }) => {
      commandStarted();
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("Command aborted");
          error.name = "AbortError";
          error.result = {
            command: action.command,
            stdout: "",
            stderr: "",
            exitCode: null,
          };
          reject(error);
        }, { once: true });
      });
    },
  });
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Shutdown",
    workbench: "migration",
    projectRoot: "sample",
    metadata: {
      previewServices: {
        source: { command: ["node", "-e", ""], port: 4173 },
      },
    },
    steps: [{ title: "Long command", action: { command: ["long-command"] } }],
  });
  await prepareSessionWorkspace(app, created.body.id);
  const run = postJson(`${app.url}/api/sessions/${created.body.id}/steps/0/run`, {
    confirmed: true,
  });
  await withTimeout(started, "active step");

  const callbacks = [];
  app.server.close(() => callbacks.push("first"));
  app.server.close(() => callbacks.push("second"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(previews.stopAllCalls, 1);
  assert.deepEqual(callbacks, []);
  const rejectedLifecycle = await postJson(
    `${app.url}/api/sessions/${created.body.id}/previews/source/start`,
    {},
  );
  assert.equal(rejectedLifecycle.response.status, 503);

  const closed = new Promise((resolve) => app.server.once("close", resolve));
  stopAllResolve();
  assert.equal((await withTimeout(run, "aborted step")).response.status, 400);
  await withTimeout(closed, "managed close");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(callbacks, ["first", "second"]);
});

test("managed shutdown ends active session and runtime SSE streams before closing", async (t) => {
  let releaseStopAll;
  const stopAllBlocked = new Promise((resolve) => { releaseStopAll = resolve; });
  const previews = new FakePreviewSupervisor();
  previews.stopAll = async () => {
    previews.stopAllCalls += 1;
    await stopAllBlocked;
  };
  const terminal = new TerminalBuffer();
  const app = await startTestApp(t, { previews, terminal });
  t.after(() => releaseStopAll());
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "SSE shutdown",
    workbench: "migration",
    projectRoot: "sample",
    steps: [],
  });
  const abortSession = new AbortController();
  const abortRuntime = new AbortController();
  t.after(() => {
    abortSession.abort();
    abortRuntime.abort();
  });
  const sessionResponse = await fetch(
    `${app.url}/api/sessions/${created.body.id}/events`,
    { signal: abortSession.signal },
  );
  const runtimeResponse = await fetch(
    `${app.url}/api/sessions/${created.body.id}/runtime/events`,
    { signal: abortRuntime.signal },
  );
  const sessionStream = createSseReader(sessionResponse);
  const runtimeStream = createSseReader(runtimeResponse);
  t.after(() => {
    sessionStream.cancel();
    runtimeStream.cancel();
  });
  await withTimeout(sessionStream.next(), "initial session SSE before shutdown");
  await withTimeout(runtimeStream.next(), "initial runtime SSE before shutdown");

  let closeCallbackCalled = false;
  const closed = new Promise((resolve, reject) => {
    app.server.close((error) => {
      closeCallbackCalled = true;
      if (error) reject(error);
      else resolve();
    });
  });
  await assert.rejects(
    withTimeout(sessionStream.next(), "session SSE shutdown"),
    /SSE stream ended/,
  );
  await assert.rejects(
    withTimeout(runtimeStream.next(), "runtime SSE shutdown"),
    /SSE stream ended/,
  );
  assert.equal(closeCallbackCalled, false);
  assert.equal(previews.stopAllCalls, 1);
  assert.equal(previews.listeners.has(created.body.id), false);
  assert.equal(terminal.sessions.get(created.body.id).listeners.size, 0);
  assert.equal((await fetch(`${app.url}/api/sessions/${created.body.id}/events`)).status, 503);
  assert.equal((await fetch(`${app.url}/api/sessions/${created.body.id}/runtime/events`)).status, 503);

  releaseStopAll();
  await withTimeout(closed, "SSE managed close callback");
  assert.equal(closeCallbackCalled, true);
});
