import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { deferred, FakeElement, FakeResponse, installFakeBrowser } from "./helpers/fake-browser.js";

let importSequence = 0;

const worktreeRoot = path.resolve(".");

function workspace(overrides = {}) {
  return {
    projectRoot: "/projects/source-app",
    repositoryRoot: "/projects",
    projectRelativePath: "source-app",
    commonGitDir: "/projects/.git",
    worktreeRoot: "/tmp/dev-workbench/session-1",
    executionRoot: "/tmp/dev-workbench/session-1/source-app",
    baseOid: "a".repeat(40),
    ownershipToken: "owner-1",
    currentCheckpointId: "initial",
    ...overrides,
  };
}

function attempt(overrides = {}) {
  return {
    id: "attempt-1",
    stepIndex: 0,
    attempt: 1,
    status: "awaiting_review",
    startedAt: "2026-08-03T09:00:00.000Z",
    completedAt: "2026-08-03T09:01:00.000Z",
    baseline: {
      oid: "b".repeat(40),
      ref: "refs/dev-workbench/checkpoints/session-1/attempt-1/baseline",
    },
    result: {
      oid: "c".repeat(40),
      ref: "refs/dev-workbench/checkpoints/session-1/attempt-1/result",
      restorable: true,
    },
    snapshot: {
      files: [
        { path: "src/new-name.js", oldPath: "src/old-name.js", status: "renamed", binary: false, additions: 4, deletions: 1 },
        { path: "obsolete.txt", oldPath: "obsolete.txt", status: "deleted", binary: false, additions: 0, deletions: 8 },
      ],
      command: {
        command: ["node", "migrate.js"],
        cwd: "/tmp/dev-workbench/session-1/source-app",
        stdout: "done\n",
        stderr: "",
        exitCode: 0,
      },
    },
    ...overrides,
  };
}

function migrationSession(id = "migration", overrides = {}) {
  return {
    id,
    title: id,
    projectRoot: "/projects/source-app",
    workbench: "migration",
    status: "ready",
    cursor: 0,
    steps: [{
      id: "prepare-project",
      title: "Prepare project",
      description: "Read files",
      expected: "Ready",
      risk: "medium",
      dependsOn: [],
      attempt: 1,
      status: "awaiting_review",
      action: { command: ["node", "prepare.js"], cwd: "." },
      review: null,
    }],
    snapshots: [],
    annotations: [],
    attempts: [],
    workspace: null,
    metadata: {},
    events: [],
    ...overrides,
  };
}

async function loadController(t, route) {
  const browser = installFakeBrowser((requestPath, options = {}) => {
    if (requestPath === "/api/health") return new FakeResponse({ allowedRoot: "/projects" });
    if (requestPath === "/api/sessions" && !options.method) return new FakeResponse([]);
    if (requestPath === "/api/projects/recent") return new FakeResponse([]);
    return route(requestPath, options);
  });
  t.after(() => browser.restore());
  const module = await import(`../apps/web/app.js?web-review-test=${++importSequence}`);
  return { browser, controller: module.__testing };
}

test("review markup and styles define labelled regions, restore dialog semantics, note labelling, responsive review layout, focus-visible, reduced motion, and overflow guards", async () => {
  const [indexHtml, styles, controller] = await Promise.all([
    fs.readFile(path.join(worktreeRoot, "apps/web/index.html"), "utf8"),
    fs.readFile(path.join(worktreeRoot, "apps/web/styles.css"), "utf8"),
    fs.readFile(path.join(worktreeRoot, "apps/web/app.js"), "utf8"),
  ]);

  assert.match(indexHtml, /<label id="note-text-label"[^>]*for="note-text"/);
  assert.match(indexHtml, /<dialog id="restore-checkpoint-dialog"[^>]*aria-labelledby="restore-checkpoint-title"[^>]*aria-describedby="restore-checkpoint-description"/);
  assert.match(indexHtml, /id="restore-checkpoint-confirm"[^>]*type="button"/);
  assert.match(controller, /aria-labelledby="workspace-status"/);
  assert.match(controller, /aria-labelledby="review-files-status"/);
  assert.match(controller, /aria-labelledby="review-diff-status"/);
  assert.match(styles, /#restore-checkpoint-dialog/);
  assert.match(styles, /#restore-checkpoint-dialog button:focus-visible/);
  assert.match(styles, /@media\(max-width:900px\).*workspace/i);
  assert.match(styles, /@media\(prefers-reduced-motion:reduce\).*restore-checkpoint-dialog/s);
  assert.match(styles, /review-files[^{]*\{[^}]*overflow:auto/s);
  assert.match(styles, /review-diff[^{]*\{[^}]*min-width:0/s);
});

test("prepare workspace preserves source identity while exposing execution identity and preparation state", async (t) => {
  const prepareRequest = deferred();
  const { browser, controller } = await loadController(t, (requestPath, options) => {
    if (requestPath === "/api/sessions/prep/workspace/prepare" && options.method === "POST") return prepareRequest.promise;
    throw new Error(`Unexpected fetch ${requestPath}`);
  });
  controller.renderSession(migrationSession("prep", {
    cursor: -1,
    steps: [{
      id: "prepare-project",
      title: "Prepare project",
      description: "Read files",
      expected: "Ready",
      risk: "low",
      dependsOn: [],
      attempt: 0,
      status: "pending",
      action: { command: ["node", "prepare.js"], cwd: "." },
      review: null,
    }],
  }));

  assert.equal(browser.element("session-path").textContent, "/projects/source-app");
  assert.match(browser.element("migration-view").innerHTML, /workspace not prepared/i);

  const pending = browser.element("prepare-workspace").onclick();
  const request = browser.requests.at(-1);
  assert.equal(request.path, "/api/sessions/prep/workspace/prepare");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.body, "{}");

  prepareRequest.resolve(new FakeResponse(migrationSession("prep", {
    cursor: -1,
    workspace: workspace(),
    steps: [{
      id: "prepare-project",
      title: "Prepare project",
      description: "Read files",
      expected: "Ready",
      risk: "low",
      dependsOn: [],
      attempt: 0,
      status: "pending",
      action: { command: ["node", "prepare.js"], cwd: "." },
      review: null,
    }],
  })));
  await pending;

  assert.equal(browser.element("session-path").textContent, "/projects/source-app");
  assert.match(browser.element("migration-view").innerHTML, /source project/i);
  assert.match(browser.element("migration-view").innerHTML, /\/projects\/source-app/);
  assert.match(browser.element("migration-view").innerHTML, /execution workspace/i);
  assert.match(browser.element("migration-view").innerHTML, /\/tmp\/dev-workbench\/session-1\/source-app/);
  assert.match(browser.element("migration-view").innerHTML, /current checkpoint:\s*initial/i);
});

test("changed-file review escapes manifest paths, preserves selection, and ignores stale lazy diff responses", async (t) => {
  const firstDiff = deferred();
  const secondDiff = deferred();
  const selectedAttempt = attempt({
    snapshot: {
      files: [
        { path: "src/<script>.js", oldPath: "src/old-name.js", status: "renamed", binary: false, additions: 4, deletions: 1 },
        { path: "obsolete.txt", oldPath: "obsolete.txt", status: "deleted", binary: false, additions: 0, deletions: 8 },
      ],
      command: { command: ["node", "migrate.js"], cwd: "/tmp/dev-workbench/session-1/source-app", stdout: "", stderr: "", exitCode: 0 },
    },
  });
  const { browser, controller } = await loadController(t, (requestPath) => {
    if (requestPath.endsWith("/attempts/attempt-1/diff?path=src%2F%3Cscript%3E.js")) return firstDiff.promise;
    if (requestPath.endsWith("/attempts/attempt-1/diff?path=obsolete.txt")) return secondDiff.promise;
    throw new Error(`Unexpected fetch ${requestPath}`);
  });
  const session = migrationSession("review", {
    workspace: workspace({ currentCheckpointId: "attempt-1" }),
    attempts: [selectedAttempt],
    steps: [{ ...migrationSession().steps[0], status: "completed", review: { decision: "accept", reviewedAt: "2026-08-03T09:02:00.000Z" } }],
  });
  controller.renderSession(session);

  const initialHtml = browser.element("migration-view").innerHTML;
  assert.match(initialHtml, /src\/old-name\.js/);
  assert.match(initialHtml, /obsolete\.txt/);
  assert.doesNotMatch(initialHtml, /<script>/);

  const firstTarget = new FakeElement(browser.document);
  firstTarget.dataset.reviewPath = "src/<script>.js";
  firstTarget.dataset.reviewAttemptId = "attempt-1";
  const firstPending = browser.element("migration-view").onclick({ target: firstTarget });
  const secondTarget = new FakeElement(browser.document);
  secondTarget.dataset.reviewPath = "obsolete.txt";
  secondTarget.dataset.reviewAttemptId = "attempt-1";
  const secondPending = browser.element("migration-view").onclick({ target: secondTarget });

  secondDiff.resolve(new FakeResponse({
    path: "obsolete.txt",
    oldPath: "obsolete.txt",
    newPath: "obsolete.txt",
    status: "deleted",
    binary: false,
    truncated: false,
    old: { text: "gone\n" },
    new: { text: "" },
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ["-gone"] }],
  }));
  await secondPending;
  firstDiff.resolve(new FakeResponse({
    path: "src/<script>.js",
    oldPath: "src/old-name.js",
    newPath: "src/<script>.js",
    status: "renamed",
    binary: false,
    truncated: false,
    old: { text: "old\n" },
    new: { text: "new\n" },
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] }],
  }));
  await firstPending;

  assert.match(browser.element("migration-view").innerHTML, /obsolete\.txt/);
  assert.match(browser.element("migration-view").innerHTML, /data-review-path="obsolete\.txt" aria-pressed="true"/);
  controller.renderSession({ ...session, updatedAt: "2026-08-03T09:03:00.000Z" });
  assert.match(browser.element("migration-view").innerHTML, /data-review-path="obsolete\.txt" aria-pressed="true"/);
});

test("loaded diffs support search, side-by-side mode, binary/truncated/error states, and bounded safe highlighting", async (t) => {
  const first = deferred();
  let requestCount = 0;
  const { browser, controller } = await loadController(t, (requestPath) => {
    requestCount += 1;
    if (requestCount === 1) return first.promise;
    if (requestPath.endsWith("/attempts/attempt-1/diff?path=asset.bin")) {
      return new FakeResponse({
        path: "asset.bin",
        oldPath: "asset.bin",
        newPath: "asset.bin",
        status: "modified",
        binary: true,
        truncated: false,
        old: { text: null },
        new: { text: null },
        hunks: [],
      });
    }
    if (requestPath.endsWith("/attempts/attempt-1/diff?path=huge.html")) {
      return new FakeResponse({
        path: "huge.html",
        oldPath: "huge.html",
        newPath: "huge.html",
        status: "modified",
        binary: false,
        truncated: true,
        old: { text: "<h1>Before</h1>\n" },
        new: { text: `<main>${"line\n".repeat(800)}</main>` },
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 800, lines: ["-<h1>Before</h1>", "+<main>"] }],
      });
    }
    throw new Error("diff exploded");
  });
  controller.renderSession(migrationSession("diff-mode", {
    workspace: workspace(),
    attempts: [attempt({
      snapshot: {
        files: [
          { path: "demo.html", oldPath: "demo.html", status: "modified", binary: false, additions: 4, deletions: 1 },
          { path: "asset.bin", oldPath: "asset.bin", status: "modified", binary: true, additions: 0, deletions: 0 },
          { path: "huge.html", oldPath: "huge.html", status: "modified", binary: false, additions: 800, deletions: 1 },
          { path: "broken.js", oldPath: "broken.js", status: "modified", binary: false, additions: 1, deletions: 1 },
        ],
        command: { command: ["node", "migrate.js"], cwd: "/tmp/dev-workbench/session-1/source-app", stdout: "", stderr: "", exitCode: 0 },
      },
    })],
    steps: [{ ...migrationSession().steps[0], status: "completed", review: { decision: "accept", reviewedAt: "2026-08-03T09:02:00.000Z" } }],
  }));

  const demoTarget = new FakeElement(browser.document);
  demoTarget.dataset.reviewPath = "demo.html";
  demoTarget.dataset.reviewAttemptId = "attempt-1";
  const demoPending = browser.element("migration-view").onclick({ target: demoTarget });
  first.resolve(new FakeResponse({
    path: "demo.html",
    oldPath: "demo.html",
    newPath: "demo.html",
    status: "modified",
    binary: false,
    truncated: false,
    old: { text: "<main>alpha</main>\n" },
    new: { text: "<main>beta</main>\n<script>alert(1)</script>\n" },
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ["-<main>alpha</main>", "+<main>beta</main>", "+<script>alert(1)</script>"] }],
  }));
  await demoPending;

  assert.match(browser.element("migration-view").innerHTML, /review-unified/i);
  assert.doesNotMatch(browser.element("migration-view").innerHTML, /<script>alert/);

  const search = browser.element("review-diff-search");
  search.value = "beta";
  await browser.element("migration-view").oninput({ target: search });
  assert.match(browser.element("migration-view").innerHTML, /<mark>beta<\/mark>/i);

  const mode = new FakeElement(browser.document);
  mode.dataset.diffMode = "side-by-side";
  await browser.element("migration-view").onclick({ target: mode });
  assert.match(browser.element("migration-view").innerHTML, /review-side-by-side/i);

  const binaryTarget = new FakeElement(browser.document);
  binaryTarget.dataset.reviewPath = "asset.bin";
  binaryTarget.dataset.reviewAttemptId = "attempt-1";
  await browser.element("migration-view").onclick({ target: binaryTarget });
  assert.match(browser.element("migration-view").innerHTML, /binary file/i);

  const truncatedTarget = new FakeElement(browser.document);
  truncatedTarget.dataset.reviewPath = "huge.html";
  truncatedTarget.dataset.reviewAttemptId = "attempt-1";
  await browser.element("migration-view").onclick({ target: truncatedTarget });
  assert.match(browser.element("migration-view").innerHTML, /truncated/i);
  assert.match(browser.element("migration-view").innerHTML, /rendered first/i);

  const errorTarget = new FakeElement(browser.document);
  errorTarget.dataset.reviewPath = "broken.js";
  errorTarget.dataset.reviewAttemptId = "attempt-1";
  await browser.element("migration-view").onclick({ target: errorTarget });
  assert.match(browser.element("migration-view").innerHTML, /diff exploded/i);
});

test("running attempts post exact cancel bodies, suppress duplicates, and converge on newer session state", async (t) => {
  const cancel = deferred();
  const { browser, controller } = await loadController(t, (requestPath, options) => {
    if (requestPath === "/api/sessions/cancel/steps/0/cancel" && options.method === "POST") return cancel.promise;
    if (requestPath === "/api/sessions/other") return new FakeResponse(migrationSession("other"));
    throw new Error(`Unexpected fetch ${requestPath}`);
  });
  controller.renderSession(migrationSession("cancel", {
    status: "running",
    workspace: workspace(),
    attempts: [attempt({ status: "running" })],
    steps: [{ ...migrationSession().steps[0], status: "running" }],
  }));

  const cancelTarget = new FakeElement(browser.document);
  cancelTarget.dataset.stepAction = "cancel";
  cancelTarget.dataset.stepIndex = "0";
  const pending = browser.element("migration-view").onclick({ target: cancelTarget });
  const request = browser.requests.at(-1);
  assert.equal(request.path, "/api/sessions/cancel/steps/0/cancel");
  assert.deepEqual(JSON.parse(request.options.body), { attempt: 1 });

  const requestCount = browser.requests.length;
  await browser.element("migration-view").onclick({ target: cancelTarget });
  assert.equal(browser.requests.length, requestCount);

  controller.renderSession(migrationSession("cancel", {
    updatedAt: "2026-08-03T09:03:00.000Z",
    status: "cancelled",
    workspace: workspace(),
    attempts: [attempt({ status: "cancelled" })],
    steps: [{ ...migrationSession().steps[0], status: "cancelled" }],
  }));
  cancel.resolve(new FakeResponse({ status: "cancelling", stepIndex: 0, attempt: 1 }));
  await pending;

  assert.equal(controller.state.active.status, "cancelled");
  assert.match(browser.element("migration-view").innerHTML, /cancelled/i);
  assert.deepEqual(browser.alerts, []);
});

test("failed or cancelled retry requires exact baseline-restore confirmation and ignores stale responses", async (t) => {
  const retry = deferred();
  const confirmations = [];
  const { browser, controller } = await loadController(t, (requestPath, options) => {
    if (requestPath === "/api/sessions/retry/steps/0/run" && options.method === "POST") return retry.promise;
    throw new Error(`Unexpected fetch ${requestPath}`);
  });
  globalThis.confirm = (message) => {
    confirmations.push(message);
    return confirmations.length > 1;
  };
  controller.renderSession(migrationSession("retry", {
    status: "failed",
    workspace: workspace(),
    attempts: [attempt({ status: "failed" })],
    steps: [{ ...migrationSession().steps[0], status: "failed" }],
  }));

  const requestCount = browser.requests.length;
  await browser.element("run-next").onclick();
  assert.equal(browser.requests.length, requestCount);
  assert.match(confirmations[0], /restore baseline and retry/i);
  assert.match(confirmations[0], /attempt-1/);
  assert.match(confirmations[0], /bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/);
  assert.match(confirmations[0], /\/tmp\/dev-workbench\/session-1\/source-app/);

  const pending = browser.element("run-next").onclick();
  const request = browser.requests.at(-1);
  assert.deepEqual(JSON.parse(request.options.body), {
    confirmed: true,
    confirmedRestore: true,
    expectedAttemptId: "attempt-1",
    expectedBaselineOid: "b".repeat(40),
    expectedExecutionRoot: "/tmp/dev-workbench/session-1/source-app",
  });

  controller.renderSession(migrationSession("other", {
    workspace: workspace(),
    attempts: [],
    steps: [{ ...migrationSession().steps[0], attempt: 0, status: "pending" }],
  }));
  retry.resolve(new FakeResponse(migrationSession("retry", {
    workspace: workspace(),
    status: "awaiting_review",
    attempts: [attempt({ id: "attempt-2", attempt: 2, status: "awaiting_review" })],
    steps: [{ ...migrationSession().steps[0], attempt: 2, status: "awaiting_review" }],
  })));
  await pending;

  assert.equal(controller.state.active.id, "other");
});

test("restore opens a distinct confirmation dialog, cancel is inert, confirm sends the exact body, and stale responses are ignored", async (t) => {
  const restore = deferred();
  const trigger = new FakeElement(null);
  const { browser, controller } = await loadController(t, (requestPath, options) => {
    if (requestPath === "/api/sessions/recover/checkpoints/attempt-1/restore" && options.method === "POST") return restore.promise;
    throw new Error(`Unexpected fetch ${requestPath}`);
  });
  trigger.ownerDocument = browser.document;
  controller.renderSession(migrationSession("recover", {
    workspace: workspace({ currentCheckpointId: "initial" }),
    attempts: [attempt()],
    steps: [{ ...migrationSession().steps[0], status: "completed", review: { decision: "accept", reviewedAt: "2026-08-03T09:02:00.000Z" } }],
  }));

  trigger.dataset.restoreCheckpointId = "attempt-1";
  await browser.element("migration-view").onclick({ target: trigger });
  assert.equal(browser.requests.length, 3);
  assert.equal(browser.element("restore-checkpoint-dialog").open, true);
  assert.equal(browser.document.activeElement, browser.element("restore-checkpoint-cancel"));
  assert.match(browser.element("restore-checkpoint-description").innerHTML, /refs\/dev-workbench\/checkpoints\/session-1\/attempt-1\/result/);
  assert.match(browser.element("restore-checkpoint-description").innerHTML, /cccccccccccccccccccccccccccccccccccccccc/);
  assert.match(browser.element("restore-checkpoint-description").innerHTML, /\/tmp\/dev-workbench\/session-1\/source-app/);

  await browser.element("restore-checkpoint-cancel").onclick();
  assert.equal(browser.element("restore-checkpoint-dialog").open, false);
  assert.equal(browser.document.activeElement, trigger);

  await browser.element("migration-view").onclick({ target: trigger });
  const pending = browser.element("restore-checkpoint-confirm").onclick();
  const request = browser.requests.at(-1);
  assert.equal(request.path, "/api/sessions/recover/checkpoints/attempt-1/restore");
  assert.deepEqual(JSON.parse(request.options.body), {
    confirmed: true,
    expectedOid: "c".repeat(40),
    expectedExecutionRoot: "/tmp/dev-workbench/session-1/source-app",
  });

  controller.renderSession(migrationSession("other", {
    workspace: workspace(),
    attempts: [],
    steps: [{ ...migrationSession().steps[0], attempt: 0, status: "pending" }],
  }));
  restore.resolve(new FakeResponse(migrationSession("recover", {
    workspace: workspace({ currentCheckpointId: "attempt-1" }),
    attempts: [attempt()],
    steps: [{ ...migrationSession().steps[0], status: "completed", review: { decision: "accept", reviewedAt: "2026-08-03T09:02:00.000Z" } }],
  })));
  await pending;

  assert.equal(controller.state.active.id, "other");
  assert.equal(browser.element("restore-checkpoint-dialog").open, false);
});
