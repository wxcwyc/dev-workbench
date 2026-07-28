import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertPlanInput } from "../packages/protocol/src/index.js";

const demoRoot = new URL("../examples/migration-demo/", import.meta.url);

async function readSession() {
  return JSON.parse(await fs.readFile(new URL("session.json", demoRoot), "utf8"));
}

function capture(stream) {
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output += chunk;
  });
  return () => output;
}

async function waitForOutput(readOutput, pattern, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(readOutput())) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.match(readOutput(), pattern);
}

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await once(child, "exit");
}

async function assertPortCanBeReused(port) {
  const server = net.createServer();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function startDemoServer(context, relativeScript) {
  const port = await unusedPort();
  const child = spawn(process.execPath, [
    fileURLToPath(new URL(relativeScript, demoRoot)),
    String(port),
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => stopChild(child));
  const stdout = capture(child.stdout);
  const stderr = capture(child.stderr);
  await waitForOutput(stdout, new RegExp(`listening on 127\\.0\\.0\\.1:${port}`));
  return { child, port, stdout, stderr };
}

test("migration demo session exposes stable ids, risk, and earlier-step dependencies", async () => {
  const session = await readSession();

  const planInput = { steps: session.steps };
  assert.equal(assertPlanInput(planInput), planInput);
  assert.deepEqual(session.steps.map(({ id, risk, dependsOn }) => ({ id, risk, dependsOn })), [
    { id: "reset-target-workspace", risk: "high", dependsOn: [] },
    { id: "create-application-shell", risk: "medium", dependsOn: ["reset-target-workspace"] },
    { id: "migrate-content", risk: "medium", dependsOn: ["create-application-shell"] },
    { id: "migrate-styles", risk: "low", dependsOn: ["migrate-content"] },
  ]);
});

test("migration demo declares exact source and target preview services", async () => {
  const session = await readSession();

  assert.deepEqual(session.metadata.previewServices, {
    source: {
      command: ["node", "legacy/server.js"],
      cwd: ".",
      port: 4173,
      healthPath: "/health",
      previewPath: "/",
    },
    target: {
      command: ["node", "target/server.js"],
      cwd: ".",
      port: 4174,
      healthPath: "/health",
      previewPath: "/",
    },
  });
  assert.notEqual(
    session.metadata.previewServices.source.port,
    session.metadata.previewServices.target.port,
  );
});

for (const fixture of [
  { slot: "source", script: "legacy/server.js", pagePattern: /Legacy Notes/, signal: "SIGTERM" },
  { slot: "target", script: "target/server.js", pagePattern: /Modern site preview/, signal: "SIGINT" },
]) {
  test(`${fixture.slot} preview serves health and only its intended page`, async (context) => {
    const server = await startDemoServer(context, fixture.script);
    const origin = `http://127.0.0.1:${server.port}`;

    const health = await fetch(`${origin}/health`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok\n");

    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /^text\/html/);
    assert.match(await page.text(), fixture.pagePattern);

    const unknown = await fetch(`${origin}/missing.html`);
    assert.equal(unknown.status, 404);

    const traversal = await fetch(`${origin}/%2e%2e/session.json`);
    assert.equal(traversal.status, 404);
    assert.doesNotMatch(await traversal.text(), /Framework migration command center/);

    await waitForOutput(server.stdout, /GET \/health 200/);
    await waitForOutput(server.stdout, /GET \/ 200/);
    assert.equal(server.stderr(), "");

    server.child.kill(fixture.signal);
    const [exitCode, signal] = await once(server.child, "exit");
    assert.equal(exitCode, 0);
    assert.equal(signal, null);
    await assertPortCanBeReused(server.port);
  });
}

test("reset preserves the target server and recreates its preview page", async (context) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "migration-demo-"));
  context.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const copiedDemo = path.join(tempRoot, "migration-demo");
  await fs.cp(new URL("../examples/migration-demo/", import.meta.url), copiedDemo, {
    recursive: true,
  });
  const target = path.join(copiedDemo, "target");
  await fs.writeFile(path.join(target, "index.html"), "stale preview");
  await fs.writeFile(path.join(target, "app.js"), "stale generated asset");

  const child = spawn(process.execPath, [path.join(copiedDemo, "step-runner.js"), "reset"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => stopChild(child));
  const stdout = capture(child.stdout);
  const stderr = capture(child.stderr);
  const [exitCode] = await once(child, "exit");

  assert.equal(exitCode, 0, stderr());
  assert.match(stdout(), /Target workspace reset/);
  assert.match(await fs.readFile(path.join(target, "server.js"), "utf8"), /createServer/);
  assert.match(await fs.readFile(path.join(target, "index.html"), "utf8"), /Modern site preview/);
  await assert.rejects(fs.access(path.join(target, "app.js")), { code: "ENOENT" });
});
