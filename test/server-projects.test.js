import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "../apps/server/src/server.js";

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
    stateRoot,
    temporaryRoot,
    url: `http://127.0.0.1:${port}`,
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
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

test("GET /api/health reports the injected allowed root", async (t) => {
  const app = await startTestApp(t);

  const response = await fetch(`${app.url}/api/health`);

  assert.equal(response.status, 200);
  assert.equal((await response.json()).allowedRoot, app.allowedRoot);
});
