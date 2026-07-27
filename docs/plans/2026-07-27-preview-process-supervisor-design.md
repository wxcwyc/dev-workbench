# Preview Process Supervisor and Real-Time Terminal Output Design

## Goal

Complete the next Milestone 2 slice by supervising independent source and target preview servers and streaming their output, together with Migration step output, into the Migration Center in real time.

The implementation remains a trusted-local, dependency-free Node.js application. It does not introduce a PTY, an interactive shell, arbitrary remote health checks, containers, or a generalized job system.

## Scope

This slice adds:

- source and target preview-service configuration;
- start, stop, restart, status monitoring, health checks, and manual iframe refresh;
- port-conflict diagnosis without terminating the port owner;
- bounded, reconnectable stdout/stderr streaming for preview services;
- incremental stdout/stderr streaming for Migration step commands;
- retained evidence after preview failure and persisted command output after step completion;
- cleanup of workbench-owned preview and step processes during server shutdown;
- a runnable two-preview migration example.

Preview configuration editing after session creation, interactive terminal input, arbitrary signal controls, process attachment, remote workers, containers, and durable preview logs are deferred.

## Configuration Contract

A Migration session may define two preview services under `metadata.previewServices`:

```json
{
  "metadata": {
    "sourceLabel": "Legacy site",
    "targetLabel": "Modern site",
    "previewServices": {
      "source": {
        "command": ["node", "legacy/server.js"],
        "cwd": ".",
        "port": 4173,
        "healthPath": "/health",
        "previewPath": "/"
      },
      "target": {
        "command": ["node", "target/server.js"],
        "cwd": ".",
        "port": 4174,
        "healthPath": "/health",
        "previewPath": "/"
      }
    }
  }
}
```

Both slots are optional, but only `source` and `target` are accepted. A configured service requires:

- a non-empty string argv array;
- an optional project-relative cwd, defaulting to `.`;
- an integer port from 1 through 65535;
- a health path beginning with `/`, defaulting to `/`;
- a preview path beginning with `/`, defaulting to `/`.

The server validates this contract before a lifecycle action. The command cwd goes through the existing canonical project-boundary checks. Commands always run with `shell: false`. Health and preview URLs are derived as `http://127.0.0.1:<port><path>`; configuration cannot redirect health checks to an arbitrary host.

The first slice uses imported session JSON and the bundled example as configuration surfaces. Migration Center displays the resulting configuration and controls, but no separate configuration editor is added.

## Runtime Architecture

Three small runtime components remain separate from persisted Session state:

1. `TerminalBuffer` assigns monotonically increasing sequence numbers, retains a bounded per-session tail, and publishes output events.
2. `PreviewProcessSupervisor` owns source and target child processes and their lifecycle state.
3. The server owns an `AbortController` for each active Migration step command so shutdown can terminate that child as well.

The supervisor is keyed by session ID and slot. Each owned entry contains only runtime data:

- the spawned child reference;
- current status and timestamps;
- the validated configuration;
- actual URL and health URL;
- requested-stop state;
- last exit or conflict evidence.

Runtime state is reconstructed as `stopped` after a workbench restart. Preview output is intentionally not written to session JSON. This prevents high-frequency log traffic from cloning and persisting the full Session.

## Preview Lifecycle

Each configured slot follows:

```text
stopped
  -> starting
       -> running          after a successful health check
       -> conflict         when the configured port is already occupied before spawn
       -> exited           when the child exits before becoming healthy
  -> stopping
       -> stopped          after an explicit stop

running
  -> exited                after an unexpected exit
  -> stopping -> stopped   after an explicit stop

conflict or exited
  -> starting              after start or restart
```

Lifecycle operations are serialized per session and slot. Source and target may operate concurrently. Preview lifecycle does not take the Session mutation lock because it does not mutate persisted Session state; the per-slot lock rejects duplicate or overlapping lifecycle requests.

Start performs these operations in order:

1. validate the session, slot, configuration, argv, cwd, port, and paths;
2. probe `127.0.0.1:<port>`;
3. if occupied, publish `conflict` evidence and do not spawn or kill anything;
4. spawn the configured argv without a shell;
5. stream stdout and stderr immediately;
6. poll the loopback health URL until it succeeds, the child exits, or the startup timeout expires;
7. publish `running` only after health succeeds.

A health response with status 200 through 399 is healthy. A startup timeout terminates the owned child and records an `exited` result with a diagnostic. The unavoidable probe-to-bind race is reported through the child’s exit and stderr evidence.

Stop signals only the exact child created by the supervisor. It first requests graceful termination, then uses a forced termination after a short timeout. It never discovers or terminates a process by port, PID file, or executable name. Restart is a serialized stop followed by start and retains the prior bounded log tail.

## Terminal Model

All live output uses one event shape:

```json
{
  "type": "terminal.output",
  "sequence": 42,
  "source": "preview:source",
  "stream": "stdout",
  "text": "ready on 4173\n",
  "at": "2026-07-27T12:00:00.000Z"
}
```

`source` is one of:

- `preview:source`;
- `preview:target`;
- `step:<zero-based-index>`.

`stream` is `stdout` or `stderr`. Child streams use UTF-8 decoding before publication so a multi-byte character is not split into invalid text.

Each session retains a 256 KiB chronological tail across all sources. Oldest events are evicted first. This tail supports browser reconnection and evidence after a preview exits, but is not durable across workbench restarts.

Migration command capture remains bounded to the existing 8 MiB result limit. The live terminal receives chunks immediately, while successful or failed completion still produces the command result used by snapshot history. Output overflow, timeout, abort, spawn failure, and non-zero exit terminate the command and produce an explicit error.

When the user seeks an older completed step, its persisted `currentSnapshot.command` remains the canonical historical output. The live terminal is a separate “current runtime” view and does not replace snapshot evidence.

## Runtime API and SSE

The server adds:

```text
GET  /api/sessions/:id/runtime
GET  /api/sessions/:id/runtime/events
POST /api/sessions/:id/previews/:slot/start
POST /api/sessions/:id/previews/:slot/stop
POST /api/sessions/:id/previews/:slot/restart
```

`slot` is exactly `source` or `target`. Lifecycle POST requests require `Content-Type: application/json` and an empty object. They return the resulting preview state.

The runtime snapshot contains:

- normalized source and target configuration summaries;
- current lifecycle states and diagnostics;
- actual and health URLs;
- the bounded terminal tail and latest sequence.

The runtime SSE endpoint sends envelopes through ordinary `message` frames:

- `runtime.snapshot` immediately after connection;
- `preview.state` on lifecycle changes;
- `terminal.output` for stdout/stderr chunks.

It uses the existing heartbeat convention. A reconnect receives a fresh runtime snapshot before new incremental events. The existing Session SSE remains unchanged and authoritative for persisted Session transitions.

## Migration Command Streaming

`runConfirmedCommand()` moves from promisified `execFile` to `spawn` while retaining:

- argv-only execution;
- `shell: false`;
- canonical cwd resolution;
- the current environment;
- the existing timeout and output limit;
- a result containing command, cwd, stdout, stderr, exit code, and timestamps.

It accepts optional `onOutput` and `signal` controls. The server connects `onOutput` to the session `TerminalBuffer` and registers an `AbortController` while the step is active.

Step state and persistence ordering remain unchanged:

1. mark and persist `running`;
2. stream command output without persisting each chunk;
3. capture the final project snapshot and command result;
4. persist `awaiting_review` or `failed`;
5. publish the normal Session SSE update.

The existing per-session mutation lock continues to serialize step execution and review.

## Server Shutdown

Shutdown is idempotent and shared by:

- an explicit `server.close()` call;
- SIGINT;
- SIGTERM.

It performs:

1. stop accepting lifecycle mutations;
2. abort active Migration step commands;
3. gracefully stop every preview child owned by the supervisor;
4. force any owned child that misses the grace period;
5. close the HTTP server.

The managed close path invokes its callback only after owned children have exited. Signal handlers await the same path before exiting. Repeated shutdown requests reuse the same promise.

No cleanup operation targets an external process, including a process responsible for a detected port conflict.

## Web UI

Migration Center replaces the two bare preview panels with preview cards containing:

- label and validated command summary;
- status and diagnostic;
- actual URL;
- Start, Stop, and Restart actions;
- Refresh iframe action;
- the existing sandboxed iframe.

Controls reflect lifecycle state and lock while their own request is active. Source and target requests remain independent.

The command-output area becomes a real-time terminal panel with filters for:

- all live output;
- source preview;
- target preview;
- the current Migration step.

Output is rendered as escaped text, distinguishes stdout and stderr, preserves chronological ordering, and follows new output unless the user has scrolled away. A bounded client-side mirror matches the server tail.

Opening a session owns exactly one Session SSE and one Runtime SSE. Switching or reopening closes both old streams, clears their handlers, and ignores late frames and stale lifecycle responses.

Manual refresh reloads only the selected iframe. The URL is always passed through the existing safe-preview URL guard.

## Example

The migration demo gains two minimal Node.js HTTP servers:

- a source server serving the legacy site and `/health`;
- a target server serving the generated target workspace and `/health`.

They use distinct fixed loopback ports, print startup and request evidence, and shut down on termination signals. The example session configures both services. This enables manual and automated verification of concurrent startup, health, live logs, refresh, abnormal exit evidence, restart, and cleanup.

## Error Handling and Security

- Missing or malformed preview configuration returns a validation error without spawning.
- Preview actions require a Migration session.
- Duplicate lifecycle actions return conflict without changing ownership.
- An occupied port records a conflict and never kills the listener.
- A process that exits unexpectedly retains exit code, signal, timestamp, and bounded logs.
- Health checks and previews remain loopback-only.
- Commands never pass through a shell string.
- Project cwd boundary and symlink checks remain authoritative.
- Runtime output is treated as untrusted text and escaped in the browser.
- Terminal buffers and completed command capture are bounded.

## Testing

Tests cover:

- preview configuration validation and project-boundary enforcement;
- terminal sequence ordering, UTF-8 chunks, eviction, and reconnect snapshots;
- supervisor start, health, concurrent source/target operation, stop, restart, conflict, startup failure, unexpected exit, and ownership;
- command streaming, result compatibility, timeout, overflow, abort, non-zero exit, and shell safety;
- runtime HTTP and SSE validation, lifecycle locking, event delivery, and shutdown cleanup;
- Migration UI status/actions, filtering, iframe refresh, escaping, stale-response handling, and dual-EventSource ownership;
- two-server example behavior;
- full repository regression and an end-to-end runtime smoke test.

## Delivery

Implementation is divided into sequential TDD tasks. A fresh implementation subagent owns each task. After its targeted tests pass, an independent specification reviewer and an independent quality reviewer inspect the task. Findings return to the original implementer until both reviewers approve.

