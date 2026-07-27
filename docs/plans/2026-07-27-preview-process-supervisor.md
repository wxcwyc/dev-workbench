# Preview Process Supervisor and Real-Time Terminal Output Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Supervise two loopback preview servers and stream bounded preview and Migration-step stdout/stderr into the Migration Center without persisting high-frequency runtime state.

**Architecture:** A bounded `TerminalBuffer` and a `PreviewProcessSupervisor` own ephemeral runtime state outside Session JSON. The server exposes a separate runtime snapshot/SSE surface, streams `spawn` output from Migration commands, and performs managed shutdown; the browser owns a second EventSource and renders preview controls plus a filtered live terminal.

**Tech Stack:** Node.js 22 standard library (`child_process`, `events`, `net`, `http`, `fetch`), existing zero-dependency HTTP/SSE server, vanilla JavaScript UI, `node:test`.

---

## Execution Rules

- Use `superpowers:test-driven-development` for every task: write one failing behavior first, observe RED, implement only enough for GREEN.
- The task owner commits only its listed files.
- After each task, run its targeted tests and `git diff --check`.
- After each task commit, an independent specification reviewer and an independent quality reviewer must approve it. Findings return to the original task owner.
- Do not touch root or worktree `AGENTS.md`.
- Commands remain argv arrays with `shell: false`; do not introduce a shell string, PTY, remote host configuration, or unbounded log storage.

### Task 1: Bounded Terminal Runtime

**Files:**

- Create: `packages/execution-core/src/terminal-buffer.js`
- Create: `test/terminal-buffer.test.js`

**Step 1: Write the failing terminal event test**

Add tests that construct `new TerminalBuffer({ maxBytes: 12, now })`, append stdout/stderr to one session, and assert:

```js
assert.deepEqual(buffer.append("session-1", {
  source: "preview:source",
  stream: "stdout",
  text: "ready\n",
}), {
  type: "terminal.output",
  sequence: 1,
  source: "preview:source",
  stream: "stdout",
  text: "ready\n",
  at: "2026-07-27T00:00:00.000Z",
});
```

Also assert:

- sequences are monotonic per session and independent between sessions;
- `subscribe(sessionId, listener)` receives only that session and returns an unsubscribe function;
- invalid session IDs, sources, streams, or empty/non-string text throw without mutation;
- UTF-8 byte size uses `Buffer.byteLength`, not JavaScript character count;
- eviction removes oldest whole events until the tail fits;
- one oversized event is retained with its text truncated to the newest valid UTF-8 suffix;
- `snapshot(sessionId)` returns `{ events, latestSequence }` as a defensive clone;
- `delete(sessionId)` drops buffer and sequence state.

**Step 2: Run the test to verify RED**

Run:

```bash
node --test test/terminal-buffer.test.js
```

Expected: FAIL because `terminal-buffer.js` does not exist.

**Step 3: Implement the minimal buffer**

Export:

```js
export class TerminalBuffer {
  constructor({ maxBytes = 256 * 1024, now = () => new Date().toISOString() } = {}) {}
  append(sessionId, { source, stream, text }) {}
  snapshot(sessionId) {}
  subscribe(sessionId, listener) {}
  delete(sessionId) {}
}
```

Use a `Map` per session containing `{ latestSequence, bytes, events, listeners }`. Accept sources matching exactly `preview:source`, `preview:target`, or `/^step:\d+$/`; accept only `stdout` and `stderr`. Notify listeners after the new event is in the snapshot. Listener failure must not break other listeners or `append()`.

**Step 4: Run targeted tests**

Run:

```bash
node --test test/terminal-buffer.test.js
```

Expected: all terminal-buffer tests PASS.

**Step 5: Commit**

```bash
git add packages/execution-core/src/terminal-buffer.js test/terminal-buffer.test.js
git commit -m "feat(runtime): add bounded terminal streams"
```

### Task 2: Stream Migration Command Output Safely

**Files:**

- Modify: `packages/project-adapters/src/command-runner.js`
- Modify: `test/project-adapters.test.js`

**Step 1: Write failing compatibility and streaming tests**

Extend command-runner tests to execute `process.execPath` scripts that:

- write stdout, wait briefly, then write stderr;
- exit non-zero;
- run past a short timeout;
- emit more than an injected `maxOutputBytes`;
- remain active until an `AbortController` aborts.

Assert the new call shape:

```js
const chunks = [];
const result = await runConfirmedCommand(root, {
  command: [process.execPath, "-e", script],
}, {
  onOutput: (entry) => chunks.push(entry),
});

assert.deepEqual(chunks.map(({ stream, text }) => ({ stream, text })), [
  { stream: "stdout", text: "first\n" },
  { stream: "stderr", text: "second\n" },
]);
assert.equal(result.stdout, "first\n");
assert.equal(result.stderr, "second\n");
```

For failure paths, assert the rejected error exposes `error.result` containing command, canonical cwd, partial stdout/stderr, exitCode or signal, startedAt, and completedAt. Assert timeout, overflow, and abort terminate the child. Retain existing tests for literal shell metacharacters, executable paths containing spaces, cwd escape, and replaced-root rejection.

**Step 2: Run the targeted test to verify RED**

Run:

```bash
node --test --test-name-pattern="command runner" test/project-adapters.test.js
```

Expected: new streaming/abort assertions FAIL against buffered `execFile`.

**Step 3: Replace `execFile` with `spawn`**

Preserve the public function and existing defaults:

```js
export async function runConfirmedCommand(projectRoot, action, {
  timeoutMs = 120000,
  maxOutputBytes = 8 * 1024 * 1024,
  onOutput = () => {},
  signal,
} = {}) {}
```

Required behavior:

- resolve cwd before spawning;
- call `spawn(executable, args, { cwd, shell: false, env: process.env })`;
- call `setEncoding("utf8")` on stdout/stderr;
- append chunks separately and call `onOutput({ stream, text })`;
- enforce the combined UTF-8 byte limit;
- terminate once on timeout, overflow, or abort;
- remove timers and abort listeners on settlement;
- treat exit code `0` as success and every other exit/spawn error as failure;
- settle the Promise exactly once.

Do not add action-level environment fields because the protocol does not allow them.

**Step 4: Run targeted and adapter tests**

Run:

```bash
node --test --test-name-pattern="command runner" test/project-adapters.test.js
node --test test/project-adapters.test.js
```

Expected: all tests PASS.

**Step 5: Commit**

```bash
git add packages/project-adapters/src/command-runner.js test/project-adapters.test.js
git commit -m "feat(runtime): stream migration command output"
```

### Task 3: Persist Failed Command Evidence

**Files:**

- Modify: `packages/execution-core/src/session-engine.js`
- Modify: `test/session-engine.test.js`

**Step 1: Write a failing atomic failure-evidence test**

Add a Migration test that starts a step, then calls:

```js
engine.failStep(session, 0, new Error("command failed"), {
  command: {
    command: ["node", "fail.js"],
    cwd: "/project",
    stdout: "before failure\n",
    stderr: "boom\n",
    exitCode: 2,
  },
});
```

Assert:

- the step and session are `failed`;
- snapshot index `0` contains the command evidence, `stepIndex`, and `capturedAt`;
- cursor becomes `0`;
- the normal `step.failed` event remains;
- calling without a snapshot retains legacy behavior;
- a throwing snapshot getter or a `publicSession()` clone failure leaves steps, snapshots, cursor, events, and timestamps unchanged.

**Step 2: Run the test to verify RED**

Run:

```bash
node --test --test-name-pattern="failure evidence|failStep" test/session-engine.test.js
```

Expected: FAIL because `failStep()` ignores the snapshot.

**Step 3: Extend `failStep()` atomically**

Change the signature to:

```js
failStep(session, index, error, snapshot = null)
```

Build candidate steps, snapshots, cursor, events, status, and timestamp before mutating the session. When a snapshot is provided, store a shallow clone plus `stepIndex` and a new `capturedAt`, and move the cursor to the failed step. When absent, preserve the existing snapshots and cursor.

**Step 4: Run session-engine tests**

Run:

```bash
node --test test/session-engine.test.js
```

Expected: all tests PASS.

**Step 5: Commit**

```bash
git add packages/execution-core/src/session-engine.js test/session-engine.test.js
git commit -m "feat(runtime): retain failed command evidence"
```

### Task 4: Preview Process Supervisor

**Files:**

- Create: `packages/project-adapters/src/preview-process-supervisor.js`
- Create: `test/preview-process-supervisor.test.js`
- Create: `test/fixtures/preview-server.js`

**Step 1: Write failing configuration and lifecycle tests**

Create a fixture server accepting argv for port and mode. It must:

- listen only on `127.0.0.1`;
- answer `/health`;
- print one stdout and one stderr startup line;
- optionally exit before health;
- close on SIGTERM.

Test exported configuration normalization:

```js
const config = await resolvePreviewConfig(session, "source");
assert.deepEqual(config.command, [process.execPath, fixture, "4173"]);
assert.equal(config.cwd, projectRoot);
assert.equal(config.actualUrl, "http://127.0.0.1:4173/");
assert.equal(config.healthUrl, "http://127.0.0.1:4173/health");
```

Reject non-Migration sessions, unknown slots/keys, malformed argv, escaping cwd, invalid ports, and non-leading-slash paths.

Test `PreviewProcessSupervisor` using real fixture children and short injected timeouts:

- initial configured state is `stopped`;
- start publishes `starting`, reaches `running`, and streams both outputs;
- source and target run concurrently;
- stop reaches `stopped` and the port closes;
- restart replaces the owned child and reaches `running`;
- an externally occupied port produces `conflict` and leaves the external listener alive;
- early exit and unexpected running exit produce `exited` evidence;
- duplicate same-slot lifecycle operations reject with status code 409;
- `stopAll()` stops every owned child and is idempotent.

**Step 2: Run the test to verify RED**

Run:

```bash
node --test test/preview-process-supervisor.test.js
```

Expected: FAIL because the supervisor module does not exist.

**Step 3: Implement validation and ownership**

Export:

```js
export async function resolvePreviewConfig(session, slot) {}

export class PreviewProcessSupervisor {
  constructor({
    terminal,
    startupTimeoutMs = 10000,
    healthIntervalMs = 100,
    stopTimeoutMs = 3000,
  } = {}) {}
  snapshot(session) {}
  subscribe(sessionId, listener) {}
  async start(session, slot) {}
  async stop(sessionId, slot) {}
  async restart(session, slot) {}
  async stopAll() {}
}
```

Use standard-library `net.connect` for the preflight port probe, `spawn` with `shell: false`, and `fetch` for health checks. Store only child objects created by this instance. Publish defensive `preview.state` envelopes. Never inspect or kill the PID listening on a conflicted port.

**Step 4: Run supervisor and adapter regression tests**

Run:

```bash
node --test test/preview-process-supervisor.test.js
node --test test/project-adapters.test.js
```

Expected: all tests PASS and no fixture process remains.

**Step 5: Commit**

```bash
git add packages/project-adapters/src/preview-process-supervisor.js test/preview-process-supervisor.test.js test/fixtures/preview-server.js
git commit -m "feat(runtime): supervise preview processes"
```

### Task 5: Runtime HTTP, SSE, Step Wiring, and Managed Shutdown

**Files:**

- Modify: `apps/server/src/server.js`
- Modify: `test/server-projects.test.js`

**Step 1: Add failing runtime API/SSE tests**

Extend `startTestApp()` only as needed to expose the server and inject runtime collaborators. Add tests for:

- `GET /api/sessions/:id/runtime` returns both preview states plus `{ events, latestSequence }`;
- Execution sessions and missing sessions are rejected appropriately;
- runtime SSE first sends `runtime.snapshot`, then receives `preview.state` and `terminal.output`, with heartbeat/close cleanup;
- lifecycle endpoints accept only `source|target`, exact action paths, JSON content type, and `{}`;
- successful start/stop/restart return supervisor state;
- a concurrent same-slot action returns 409 while source and target remain independent;
- Migration step output is published as `step:<index>`;
- failed command `error.result` is captured into the failed snapshot;
- server close aborts an active step, stops preview processes, closes HTTP, and invokes its callback only afterward;
- repeated close/signal-equivalent shutdown shares one cleanup operation.

Use an injected fake supervisor for routing tests and one real supervisor smoke test for shutdown ownership.

**Step 2: Run selected tests to verify RED**

Run:

```bash
node --test --test-name-pattern="runtime|preview|terminal|managed shutdown" test/server-projects.test.js
```

Expected: FAIL with missing routes and no runtime events.

**Step 3: Wire runtime components into `createApp()`**

Construct or accept injected instances:

```js
const terminal = options.terminal ?? new TerminalBuffer();
const previews = options.previews ?? new PreviewProcessSupervisor({ terminal });
```

Add a runtime snapshot helper combining `previews.snapshot(session)` and `terminal.snapshot(session.id)`. Add the routes exactly as designed. Runtime SSE subscribes to both components, sends an immediate snapshot, heartbeats every 15 seconds, and removes all listeners on request close.

In the run route:

```js
const controller = new AbortController();
activeStepControllers.set(id, controller);
const result = await runCommand(session.projectRoot, step.action, {
  signal: controller.signal,
  onOutput: ({ stream, text }) => terminal.append(id, {
    source: `step:${index}`,
    stream,
    text,
  }),
});
```

Remove the controller in `finally`. When a command error has `error.result`, attempt a project snapshot with that result and pass it to `failStep`; preserve the original command error if snapshot capture or persistence also fails.

Implement one idempotent managed shutdown used by the wrapped `server.close()`. It marks shutdown active, aborts active step controllers, awaits `previews.stopAll()`, then invokes the original HTTP close. New lifecycle mutations during shutdown receive 503.

In the executable entrypoint, register one-shot SIGINT/SIGTERM handlers that await managed close before setting the process exit code.

**Step 4: Run server and full tests**

Run:

```bash
node --test test/server-projects.test.js
node --test
```

Expected: all tests PASS. These commands require loopback permission in the managed environment.

**Step 5: Commit**

```bash
git add apps/server/src/server.js test/server-projects.test.js
git commit -m "feat(server): expose supervised preview runtime"
```

### Task 6: Migration Center Preview Controls and Live Terminal

**Files:**

- Modify: `apps/web/app.js`
- Modify: `apps/web/styles.css`
- Modify: `test/helpers/fake-browser.js`
- Modify: `test/web-controller.test.js`
- Modify: `test/web-onboarding.test.js`

**Step 1: Write failing UI and ownership tests**

Add fake EventSource support for two independently owned streams and dynamic preview control events.

Controller tests must assert:

- opening a Migration session creates `/events` and `/runtime/events` EventSources;
- opening Execution creates only Session SSE or safely ignores absent runtime UI;
- reopening/switching closes old streams, clears handlers, and ignores late runtime messages;
- `runtime.snapshot`, `preview.state`, and `terminal.output` update only the owning session;
- terminal events are ordered, bounded client-side, escaped, and filterable by all/source/target/current step;
- source and target lifecycle requests have independent pending locks;
- stale lifecycle responses cannot overwrite a newer session or SSE state;
- Start, Stop, Restart use exact POST paths and `{}`;
- Refresh changes only the chosen iframe reload token/source;
- an older timeline snapshot still renders persisted `snapshot.command` separately from live output;
- malformed runtime envelopes are ignored without breaking the Session stream.

Static UI tests must assert accessible button names, status live regions, terminal filter controls, sandboxed iframes, and responsive styles.

**Step 2: Run UI tests to verify RED**

Run:

```bash
node --test test/web-controller.test.js test/web-onboarding.test.js
```

Expected: new runtime UI assertions FAIL.

**Step 3: Implement minimal runtime client state and rendering**

Extend client state with:

```js
runtime: {
  sessionId: null,
  source: null,
  target: null,
  events: [],
  latestSequence: 0,
  filter: "all",
  eventSource: null,
  requests: { source: 0, target: 0 },
  pending: { source: false, target: false },
}
```

Render each preview card with escaped label, command, state, diagnostic, URL, lifecycle buttons, refresh button, and sandboxed iframe. Render live events into a `<pre>` with visible source/stream prefixes. Keep persisted command history in a clearly separate historical section.

Use event delegation on `#migration-view`. `openSession()` must close both old streams before assigning new owners. Runtime SSE is authoritative; HTTP responses may fill a gap but must pass session, request, and generation checks before rendering.

Do not add a framework or xterm.js.

**Step 4: Run web and full tests**

Run:

```bash
node --test test/web-controller.test.js test/web-onboarding.test.js
node --test
```

Expected: all tests PASS.

**Step 5: Commit**

```bash
git add apps/web/app.js apps/web/styles.css test/helpers/fake-browser.js test/web-controller.test.js test/web-onboarding.test.js
git commit -m "feat(web): operate previews with live terminal output"
```

### Task 7: Runnable Two-Preview Migration Demo

**Files:**

- Create: `examples/migration-demo/legacy/server.js`
- Create: `examples/migration-demo/target/server.js`
- Create: `examples/migration-demo/target/index.html`
- Modify: `examples/migration-demo/session.json`
- Modify: `examples/migration-demo/step-runner.js`
- Modify: `test/migration-demo.test.js`

**Step 1: Write failing demo contract tests**

Assert the example session contains exact `metadata.previewServices.source` and `.target` shapes with distinct ports, loopback-derived paths, project-relative cwd, and argv commands.

Start both example servers as child processes on test-selected ports or by allowing the scripts to accept an argv port override. Assert:

- `/health` returns success for both;
- source serves the legacy page;
- target serves its current generated page;
- both print startup evidence;
- SIGTERM closes each server and port.

Ensure `step-runner.js reset` recreates the target files required by the target preview server rather than deleting the server entrypoint itself.

**Step 2: Run demo tests to verify RED**

Run:

```bash
node --test test/migration-demo.test.js
```

Expected: FAIL because the two runnable services and preview config are absent.

**Step 3: Implement the minimal example servers**

Use only `node:http` and `node:fs/promises`. Bind to `127.0.0.1`, route `/health` separately, serve only the intended HTML file, log requests, reject path traversal, and close on SIGINT/SIGTERM.

Use stable default ports in `session.json`, while accepting an optional port argv in the fixture-facing script so tests avoid conflicts.

**Step 4: Run demo, supervisor, and full tests**

Run:

```bash
node --test test/migration-demo.test.js test/preview-process-supervisor.test.js
node --test
```

Expected: all tests PASS and no example child remains.

**Step 5: Commit**

```bash
git add examples/migration-demo test/migration-demo.test.js
git commit -m "feat(examples): run dual migration previews"
```

### Task 8: Architecture, Development Status, and End-to-End Verification

**Files:**

- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DEVELOPMENT_PLAN.md`
- Modify: `docs/INITIAL_SOLUTION.md`
- Test: all existing and newly added tests

**Step 1: Update documentation**

Document:

- ephemeral Supervisor/TerminalBuffer ownership versus persisted Session state;
- dedicated runtime SSE alongside Session SSE;
- loopback-only health and preview URLs;
- bounded 256 KiB runtime tail and 8 MiB completed command capture;
- managed shutdown and non-ownership of external port listeners;
- Milestone 2 completion status for Preview Process Supervisor and real-time terminal output;
- remaining limitations: no PTY/input, no durable preview logs, no remote workers, no post-creation preview config editor.

Do not mark later Git checkpoint or recovery work complete.

**Step 2: Run documentation and diff checks**

Run:

```bash
git diff --check
rg -n "Preview Process Supervisor|TerminalBuffer|runtime SSE|256 KiB|8 MiB" docs
```

Expected: no whitespace errors and all architecture claims are present.

**Step 3: Run targeted verification**

Run:

```bash
node --test test/terminal-buffer.test.js
node --test test/project-adapters.test.js
node --test test/session-engine.test.js
node --test test/preview-process-supervisor.test.js
node --test test/server-projects.test.js
node --test test/web-controller.test.js test/web-onboarding.test.js
node --test test/migration-demo.test.js
```

Expected: every targeted suite PASS.

**Step 4: Run the full regression suite**

Run:

```bash
node --test
```

Expected: all tests PASS with zero failures and the process exits cleanly.

**Step 5: Run a runtime smoke test**

Start the workbench on an available loopback port with temporary state, create the migration demo, subscribe to runtime SSE, start source and target, observe both healthy states and log events, run one Migration step and observe incremental `step:0` output, then close the workbench.

Verify after close:

- workbench port is closed;
- source and target ports are closed;
- no child created by the smoke test remains;
- the completed or failed step snapshot contains its final command output;
- no external conflict listener used by a negative test was terminated.

**Step 6: Commit documentation**

```bash
git add docs/ARCHITECTURE.md docs/DEVELOPMENT_PLAN.md docs/INITIAL_SOLUTION.md
git commit -m "docs: describe supervised preview runtime"
```

## Final Review Gate

After Task 8:

1. Run an independent final specification review against:
   - `docs/plans/2026-07-27-preview-process-supervisor-design.md`
   - this implementation plan.
2. Run an independent final code-quality and security review.
3. Return every actionable finding to the responsible original task owner.
4. Re-run affected targeted tests and the full suite after fixes.
5. Use `superpowers:verification-before-completion` before claiming success.
6. Use `superpowers:finishing-a-development-branch` to integrate locally into `main` only after both final reviews approve.

