import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createApp } from "../apps/server/src/server.js";

const execFileAsync = promisify(execFile);
const demoRoot = new URL("../examples/migration-demo/", import.meta.url);

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await waitFor(() => new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: address.port });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", (error) => error.code === "ECONNREFUSED" ? resolve(true) : reject(error));
  }), `port ${address.port} was not released`);
  return address.port;
}

async function requestJson(url, { method = "GET", body } = {}) {
  const response = await fetch(url, {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  return { response, body: await response.json() };
}

async function postJson(url, body, expectedStatus = 200) {
  const result = await requestJson(url, { method: "POST", body });
  assert.equal(result.response.status, expectedStatus, JSON.stringify(result.body));
  return result.body;
}

async function sourceFingerprint(repositoryRoot) {
  const tracked = (await git(repositoryRoot, "ls-files", "-z")).split("\0").filter(Boolean);
  const files = {};
  for (const relativePath of tracked) {
    files[relativePath] = await fs.readFile(path.join(repositoryRoot, relativePath));
  }
  return {
    head: await git(repositoryRoot, "rev-parse", "HEAD"),
    status: await git(repositoryRoot, "status", "--porcelain=v2", "--untracked-files=all"),
    cached: await git(repositoryRoot, "diff", "--cached", "--binary"),
    index: await fs.readFile(path.join(repositoryRoot, ".git", "index")),
    files,
    sentinel: await fs.readFile(path.join(repositoryRoot, "SOURCE_SENTINEL.txt")),
  };
}

async function openEventStream(url) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  assert.equal(response.status, 200);
  const events = [];
  let pending = "";
  const reading = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      pending += decoder.decode(chunk, { stream: true });
      let boundary;
      while ((boundary = pending.indexOf("\n\n")) !== -1) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
        if (data) events.push(JSON.parse(data));
      }
    }
  })().catch((error) => {
    if (error.name !== "AbortError") throw error;
  });
  await waitFor(() => events.length > 0, `SSE stream ${url} did not emit an initial event`);
  return {
    events,
    async close() {
      controller.abort();
      await reading;
    },
  };
}

test("real migration demo is recoverable without mutating its source repository", { timeout: 45_000 }, async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-recovery-e2e-"));
  const allowedRoot = path.join(temporaryRoot, "allowed");
  const projectRoot = path.join(allowedRoot, "migration-demo");
  const stateRoot = path.join(temporaryRoot, "state", "sessions");
  const workspaceRoot = path.join(temporaryRoot, "managed-workspaces");
  await fs.mkdir(allowedRoot, { recursive: true });
  await fs.cp(demoRoot, projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, "SOURCE_SENTINEL.txt"), "source must remain unchanged\n");
  await git(projectRoot, "init", "--quiet");
  await git(projectRoot, "config", "user.name", "Dev Workbench E2E");
  await git(projectRoot, "config", "user.email", "e2e@dev-workbench.invalid");
  await git(projectRoot, "add", ".");
  await git(projectRoot, "commit", "--quiet", "-m", "source baseline");
  const sourceBefore = await sourceFingerprint(projectRoot);

  const previewPorts = { source: await unusedPort(), target: await unusedPort() };
  const input = JSON.parse(await fs.readFile(path.join(projectRoot, "session.json"), "utf8"));
  input.projectRoot = projectRoot;
  input.metadata.previewServices.source.port = previewPorts.source;
  input.metadata.previewServices.target.port = previewPorts.target;
  input.metadata.previewServices.source.command.push(String(previewPorts.source));
  input.metadata.previewServices.target.command.push(String(previewPorts.target));

  const server = await createApp({ allowedRoot, stateRoot, workspaceRoot, heartbeatIntervalMs: 50 });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const streams = [];
  t.after(async () => {
    for (const stream of streams) await stream.close();
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  let session = await postJson(`${baseUrl}/api/sessions`, input, 201);
  const sessionUrl = `${baseUrl}/api/sessions/${session.id}`;
  const sessionEvents = await openEventStream(`${sessionUrl}/events`);
  const runtimeEvents = await openEventStream(`${sessionUrl}/runtime/events`);
  streams.push(sessionEvents, runtimeEvents);

  session = await postJson(`${sessionUrl}/workspace/prepare`, {});
  assert.notEqual(session.workspace.executionRoot, projectRoot);
  assert.equal(await fs.realpath(session.workspace.executionRoot), session.workspace.executionRoot);
  assert.deepEqual(await sourceFingerprint(projectRoot), sourceBefore);

  for (const slot of ["source", "target"]) {
    const preview = await postJson(`${sessionUrl}/previews/${slot}/start`, {});
    assert.equal(preview.state, "running");
    const health = await fetch(`http://127.0.0.1:${previewPorts[slot]}/health`);
    assert.equal(health.status, 200);
    const page = await fetch(`http://127.0.0.1:${previewPorts[slot]}/`);
    assert.equal(page.status, 200);
  }
  for (const slot of ["source", "target"]) {
    const preview = await postJson(`${sessionUrl}/previews/${slot}/stop`, {});
    assert.equal(preview.state, "stopped");
  }
  assert(runtimeEvents.events.some((event) => event.type === "runtime.snapshot"));
  await waitFor(
    () => runtimeEvents.events.filter((event) => event.type === "preview.state").length >= 4,
    "runtime SSE did not capture preview lifecycle events",
  );

  const missingConfirmation = await requestJson(`${sessionUrl}/steps/0/run`, {
    method: "POST",
    body: { confirmed: true },
  });
  assert.equal(missingConfirmation.response.status, 400);
  assert.match(missingConfirmation.body.error, /confirmedRisk/);

  session = await postJson(`${sessionUrl}/steps/0/run`, { confirmed: true, confirmedRisk: true });
  session = await postJson(`${sessionUrl}/steps/0/review`, { decision: "accept" });

  session = await postJson(`${sessionUrl}/steps/1/run`, { confirmed: true });
  const rejectedAttempt = session.attempts.at(-1);
  assert.equal(rejectedAttempt.status, "awaiting_review");
  assert.notEqual(rejectedAttempt.result.oid, rejectedAttempt.baseline.oid);
  assert.ok(rejectedAttempt.snapshot.files.some(({ path: filePath }) => filePath === "target/package.json"));
  session = await postJson(`${sessionUrl}/steps/1/review`, { decision: "reject" });
  assert.equal(session.attempts.find(({ id }) => id === rejectedAttempt.id).status, "failed");
  assert.equal(session.steps[1].review.decision, "reject");
  session = await postJson(`${sessionUrl}/steps/1/run`, {
    confirmed: true,
    confirmedRisk: true,
    confirmedRestore: true,
    expectedAttemptId: rejectedAttempt.id,
    expectedBaselineOid: rejectedAttempt.baseline.oid,
    expectedExecutionRoot: session.workspace.executionRoot,
  });
  const retriedShell = session.attempts.at(-1);
  assert.notEqual(retriedShell.id, rejectedAttempt.id);
  assert.equal(retriedShell.baseline.oid, rejectedAttempt.baseline.oid);
  session = await postJson(`${sessionUrl}/steps/1/review`, { decision: "accept" });

  for (const stepIndex of [2, 3]) {
    session = await postJson(`${sessionUrl}/steps/${stepIndex}/run`, { confirmed: true });
    session = await postJson(`${sessionUrl}/steps/${stepIndex}/review`, { decision: "accept" });
  }
  const shellAttempt = session.attempts.find((attempt) => attempt.stepIndex === 1 && attempt.status === "completed" && attempt.result.restorable);
  const styleAttempt = session.attempts.find((attempt) => attempt.stepIndex === 3 && attempt.status === "completed" && attempt.result.restorable);
  assert(shellAttempt && styleAttempt);
  const styleDiff = await requestJson(`${sessionUrl}/attempts/${styleAttempt.id}/diff?path=${encodeURIComponent("target/styles.css")}`);
  assert.equal(styleDiff.response.status, 200, JSON.stringify(styleDiff.body));
  assert.equal(styleDiff.body.newPath, "target/styles.css");
  assert.match(styleDiff.body.new.text, /font-family:system-ui/);

  session = await postJson(`${sessionUrl}/annotations`, {
    stepIndex: 3,
    attemptId: styleAttempt.id,
    kind: "bookmark",
    text: "**Review** the accepted color migration.",
    tags: ["review", "styles"],
    target: { type: "diff", path: "target/styles.css", line: 1 },
  }, 201);
  const bookmark = session.annotations.at(-1);
  assert.equal(bookmark.kind, "bookmark");

  const longRun = requestJson(`${sessionUrl}/steps/4/run`, {
    method: "POST",
    body: { confirmed: true },
  });
  await waitFor(async () => {
    const runtime = await requestJson(`${sessionUrl}/runtime`);
    return runtime.body.events.some((event) => event.source === "step:4" && event.text.includes("Verification started."));
  }, "long-running verification never emitted partial output");
  await postJson(`${sessionUrl}/steps/4/cancel`, { attempt: 1 }, 202);
  const cancelledRun = await longRun;
  assert.equal(cancelledRun.response.status, 400);
  session = (await requestJson(sessionUrl)).body;
  const cancelledAttempt = session.attempts.find((attempt) => attempt.stepIndex === 4 && attempt.status === "cancelled");
  assert(cancelledAttempt);
  assert.match(cancelledAttempt.snapshot.command.stdout, /Verification started\./);
  assert(cancelledAttempt.snapshot.files.some((file) => file.path === "target/verification-in-progress.txt"));

  session = await postJson(`${sessionUrl}/steps/4/run`, {
    confirmed: true,
    confirmedRestore: true,
    expectedAttemptId: cancelledAttempt.id,
    expectedBaselineOid: cancelledAttempt.baseline.oid,
    expectedExecutionRoot: session.workspace.executionRoot,
  });
  const retriedVerification = session.attempts.at(-1);
  assert.notEqual(retriedVerification.id, cancelledAttempt.id);
  assert.equal(retriedVerification.baseline.oid, cancelledAttempt.baseline.oid);
  session = await postJson(`${sessionUrl}/steps/4/review`, { decision: "accept" });
  assert.equal(session.status, "completed");
  assert.equal(await fs.readFile(path.join(session.workspace.executionRoot, "target", "verified.txt"), "utf8"), "Migration verified.\n");

  session = await postJson(`${sessionUrl}/checkpoints/${shellAttempt.id}/restore`, {
    confirmed: true,
    expectedOid: shellAttempt.result.oid,
    expectedExecutionRoot: session.workspace.executionRoot,
  });
  assert.equal(session.workspace.currentCheckpointId, shellAttempt.id);
  assert.equal(session.steps[0].status, "completed");
  assert.equal(session.steps[1].status, "completed");
  assert(session.steps.slice(2).every((step) => step.status === "pending"));
  assert.match(await fs.readFile(path.join(session.workspace.executionRoot, "target", "index.html"), "utf8"), /id="app"/);
  for (const removed of ["content.json", "styles.css", "verification-in-progress.txt", "verified.txt"]) {
    await assert.rejects(fs.access(path.join(session.workspace.executionRoot, "target", removed)), { code: "ENOENT" });
  }
  assert(session.annotations.some(({ id }) => id === bookmark.id));
  assert(session.attempts.some(({ id }) => id === cancelledAttempt.id));
  const historicalDiff = await requestJson(`${sessionUrl}/attempts/${styleAttempt.id}/diff?path=${encodeURIComponent("target/styles.css")}`);
  assert.equal(historicalDiff.response.status, 200, JSON.stringify(historicalDiff.body));

  await waitFor(() => sessionEvents.events.length >= 10, "session SSE did not capture the migration lifecycle");
  assert(runtimeEvents.events.some((event) => event.type === "terminal.output" && event.source === "step:4"));
  assert.deepEqual(await sourceFingerprint(projectRoot), sourceBefore);
});
