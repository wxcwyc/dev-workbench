import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createApp } from "../apps/server/src/server.js";
import { TerminalBuffer } from "../packages/execution-core/src/terminal-buffer.js";

async function startTestApp(t, options = {}) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-server-projects-"));
  const allowedRoot = path.join(temporaryRoot, "allowed");
  const stateRoot = path.join(temporaryRoot, "state", "sessions");
  await fs.mkdir(allowedRoot, { recursive: true });

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

  server = await createApp({ allowedRoot, stateRoot, ...options });
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
    this.states = {
      source: { state: "stopped", actualUrl: "http://127.0.0.1:4173/" },
      target: { state: "running", actualUrl: "http://127.0.0.1:4174/" },
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
    this.states[slot] = state;
    const event = { type: "preview.state", sessionId, slot, state };
    for (const listener of this.listeners.get(sessionId) ?? []) listener(event);
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

test("PUT /api/sessions/:id/plan returns 409 during an active operation and never runs a command", async (t) => {
  let releaseCommand;
  let signalCommandStarted;
  const commandStarted = new Promise((resolve) => { signalCommandStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseCommand = resolve; });
  const commandResult = { command: ["deferred-test-command"], stdout: "", stderr: "", exitCode: 0 };
  t.after(() => releaseCommand(commandResult));
  let runCalls = 0;
  const app = await startTestApp(t, {
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
  previews.publish(created.body.id, "source", { state: "running" });
  assert.deepEqual(await withTimeout(stream.next(), "preview state"), {
    type: "preview.state",
    sessionId: created.body.id,
    slot: "source",
    state: { state: "running" },
  });
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
  assert.deepEqual(initial.source, { state: "running" });
  assert.equal(initial.latestSequence, output.sequence);

  previews.publish(created.body.id, "source", { state: "exited" });
  const laterOutput = terminal.append(created.body.id, {
    source: "preview:source",
    stream: "stdout",
    text: "after snapshot\n",
  });
  assert.deepEqual(await withTimeout(stream.next(), "post-snapshot preview state"), {
    type: "preview.state",
    sessionId: created.body.id,
    slot: "source",
    state: { state: "exited" },
  });
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
  previews.publish(created.body.id, "source", { state: "running" });
  releaseSnapshot();

  const response = await withTimeout(responsePromise, "cutoff runtime SSE response");
  const stream = createSseReader(response);
  t.after(() => stream.cancel());
  const initial = await withTimeout(stream.next(), "cutoff runtime snapshot");
  assert.equal(initial.type, "runtime.snapshot");
  assert.deepEqual(initial.source, {
    state: "stopped",
    actualUrl: "http://127.0.0.1:4173/",
  });
  assert.equal(initial.latestSequence, 0);
  assert.deepEqual(await withTimeout(stream.next(), "post-cutoff preview state"), {
    type: "preview.state",
    sessionId: created.body.id,
    slot: "source",
    state: { state: "running" },
  });
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
  const app = await startTestApp(t, { previews, terminal: new TerminalBuffer() });
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Preview controls",
    workbench: "migration",
    projectRoot: "sample",
    steps: [],
  });
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
  const app = await startTestApp(t, { previews, terminal: new TerminalBuffer() });
  t.after(() => releaseSource());
  await makeSampleProject(app.allowedRoot);
  const created = await postJson(`${app.url}/api/sessions`, {
    title: "Independent controls",
    workbench: "migration",
    projectRoot: "sample",
    steps: [],
  });
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
