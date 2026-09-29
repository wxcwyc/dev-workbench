import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import net from "node:net";
import {
  PreviewProcessSupervisor,
  resolvePreviewConfig,
} from "../packages/project-adapters/src/preview-process-supervisor.js";

async function projectSession(context, overrides = {}) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "preview-supervisor-"));
  await fs.mkdir(path.join(projectRoot, "app"));
  context.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  return {
    id: "session-1",
    workbench: "migration",
    projectRoot,
    metadata: {
      previewServices: {
        source: {
          command: [process.execPath, "-e", ""],
          cwd: "app",
          port: 4101,
          healthPath: "/health",
          previewPath: "/preview",
        },
      },
    },
    ...overrides,
  };
}

test("preview process supervisor module exports its public API", () => {
  assert.equal(typeof resolvePreviewConfig, "function");
  assert.equal(typeof PreviewProcessSupervisor, "function");
});

test("resolvePreviewConfig resolves a configured Migration preview", async (context) => {
  const session = await projectSession(context);

  assert.deepEqual(await resolvePreviewConfig(session, "source"), {
    command: [process.execPath, "-e", ""],
    cwd: path.join(session.projectRoot, "app"),
    port: 4101,
    healthPath: "/health",
    previewPath: "/preview",
    actualUrl: "http://127.0.0.1:4101/preview",
    healthUrl: "http://127.0.0.1:4101/health",
  });
});

test("resolvePreviewConfig uses cwd and path defaults", async (context) => {
  const session = await projectSession(context);
  session.metadata.previewServices.source = {
    command: [process.execPath],
    port: 4102,
  };

  const config = await resolvePreviewConfig(session, "source");
  assert.equal(config.cwd, session.projectRoot);
  assert.equal(config.healthPath, "/");
  assert.equal(config.previewPath, "/");
  assert.equal(config.healthUrl, "http://127.0.0.1:4102/");
  assert.equal(config.actualUrl, "http://127.0.0.1:4102/");
});

test("resolvePreviewConfig resolves relative cwd from workspace.executionRoot when prepared", async (context) => {
  const session = await projectSession(context);
  const executionRoot = path.join(session.projectRoot, "managed");
  await fs.mkdir(path.join(executionRoot, "nested"), { recursive: true });
  session.workspace = {
    executionRoot,
  };
  session.metadata.previewServices.source.cwd = "nested";

  const config = await resolvePreviewConfig(session, "source");

  assert.equal(config.cwd, path.join(executionRoot, "nested"));
});

test("resolvePreviewConfig reports unconfigured valid slots", async (context) => {
  const session = await projectSession(context);

  assert.equal(await resolvePreviewConfig(session, "target"), null);
});

test("resolvePreviewConfig rejects non-Migration sessions and unknown slots", async (context) => {
  const session = await projectSession(context);

  await assert.rejects(
    resolvePreviewConfig({ ...session, workbench: "execution" }, "source"),
    /migration session/i,
  );
  await assert.rejects(resolvePreviewConfig(session, "SOURCE"), /slot.*source.*target/i);
});

test("resolvePreviewConfig rejects unknown containers, services, and service keys", async (context) => {
  const session = await projectSession(context);
  session.metadata.previewServices.extra = session.metadata.previewServices.source;
  await assert.rejects(resolvePreviewConfig(session, "source"), /previewServices.*source.*target/i);

  delete session.metadata.previewServices.extra;
  session.metadata.previewServices.source.extra = true;
  await assert.rejects(resolvePreviewConfig(session, "source"), /unsupported.*extra/i);

  session.metadata.previewServices = [];
  await assert.rejects(resolvePreviewConfig(session, "source"), /previewServices.*object/i);
});

test("resolvePreviewConfig validates command and port", async (context) => {
  const session = await projectSession(context);
  const invalidCommands = [[], [""], ["node", 1], "node", null];
  for (const command of invalidCommands) {
    session.metadata.previewServices.source = { command, port: 4103 };
    await assert.rejects(resolvePreviewConfig(session, "source"), /command.*non-empty string array/i);
  }

  for (const port of [0, 65536, 1.5, "4103", null]) {
    session.metadata.previewServices.source = { command: ["node"], port };
    await assert.rejects(resolvePreviewConfig(session, "source"), /port.*integer.*1.*65535/i);
  }
});

test("resolvePreviewConfig validates origin-relative paths", async (context) => {
  const session = await projectSession(context);
  for (const candidate of [
    "",
    "health",
    "//example.test/path",
    "/back\\slash",
    "https://example.test/",
    "/line\nbreak",
    "/\u0000",
  ]) {
    session.metadata.previewServices.source = {
      command: ["node"],
      port: 4104,
      healthPath: candidate,
    };
    await assert.rejects(resolvePreviewConfig(session, "source"), /healthPath.*origin-relative/i);
  }
});

test("resolvePreviewConfig enforces the project cwd boundary", async (context) => {
  const session = await projectSession(context);
  session.metadata.previewServices.source.cwd = "../outside";

  await assert.rejects(resolvePreviewConfig(session, "source"), /escapes project root/i);
});

class FakeChild extends EventEmitter {
  constructor(pid, { ignoreTerm = false } = {}) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.ignoreTerm = ignoreTerm;
    this.kills = [];
    this.closed = false;
  }

  kill(signal) {
    this.kills.push(signal);
    if (signal === "SIGTERM" && this.ignoreTerm) return true;
    queueMicrotask(() => this.close(null, signal));
    return true;
  }

  close(exitCode = 0, signal = null) {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    this.emit("close", exitCode, signal);
  }
}

function fakeSupervisor({
  children = [],
  occupied = false,
  healthy = true,
  terminalEvents = [],
  startupTimeoutMs = 50,
  healthIntervalMs = 1,
  stopTimeoutMs = 5,
} = {}) {
  let nextPid = 100;
  const spawned = [];
  const terminal = {
    append(sessionId, event) {
      terminalEvents.push({ sessionId, ...event });
    },
  };
  const supervisor = new PreviewProcessSupervisor({
    terminal,
    startupTimeoutMs,
    healthIntervalMs,
    stopTimeoutMs,
    probePort: async () => occupied,
    healthCheck: async () => healthy,
    spawnProcess(command, options) {
      const child = children.shift() ?? new FakeChild(nextPid++);
      spawned.push({ command, options, child });
      return child;
    },
  });
  return { supervisor, spawned, terminalEvents };
}

test("snapshot exposes stopped configured slots and unconfigured slots defensively", async (context) => {
  const session = await projectSession(context);
  const { supervisor } = fakeSupervisor();

  const first = await supervisor.snapshot(session);
  assert.equal(first.source.state, "stopped");
  assert.equal(first.source.latestSequence, 0);
  assert.equal(first.source.actualUrl, "http://127.0.0.1:4101/preview");
  assert.equal(first.target.state, "unconfigured");
  assert.equal(first.target.latestSequence, 0);

  first.source.config.command[0] = "mutated";
  const second = await supervisor.snapshot(session);
  assert.equal(second.source.config.command[0], process.execPath);
});

test("preview state events expose an exact monotonically increasing snapshot cutoff", async (context) => {
  const session = await projectSession(context);
  const child = new FakeChild(199);
  const { supervisor } = fakeSupervisor({ children: [child] });
  const events = [];
  supervisor.subscribe(session.id, (event) => events.push(event));

  await supervisor.start(session, "source");
  const runningSnapshot = (await supervisor.snapshot(session)).source;
  await supervisor.stop(session.id, "source");
  const stoppedSnapshot = (await supervisor.snapshot(session)).source;

  assert.deepEqual(events.map((event) => event.state.state), [
    "starting",
    "running",
    "stopping",
    "stopped",
  ]);
  assert.ok(events.every((event) => event.sequence === event.state.latestSequence));
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.ok(events.every((event) => !("child" in event.state)));
  assert.ok(events.every((event) => !("generation" in event.state)));
  assert.equal(runningSnapshot.latestSequence, events[1].sequence);
  assert.equal(stoppedSnapshot.latestSequence, events.at(-1).sequence);
});

test("preview event sequences are globally monotonic across slots and sessions", async (context) => {
  const first = await projectSession(context);
  first.metadata.previewServices.target = {
    command: [process.execPath],
    port: 4102,
  };
  const second = {
    ...first,
    id: "session-2",
    metadata: {
      previewServices: {
        source: {
          command: [process.execPath],
          port: 4103,
        },
      },
    },
  };
  const { supervisor } = fakeSupervisor({ occupied: true });
  const events = [];
  supervisor.subscribe(first.id, (event) => events.push(event));
  supervisor.subscribe(second.id, (event) => events.push(event));

  await supervisor.start(first, "source");
  await supervisor.start(first, "target");
  await supervisor.start(second, "source");

  assert.deepEqual(events.map(({ sessionId, slot }) => [
    sessionId,
    slot,
  ]), [
    ["session-1", "source"],
    ["session-1", "target"],
    ["session-2", "source"],
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  assert.ok(events.every((event) => event.sequence === event.state.latestSequence));
});

test("start probes before spawning, streams output, and reaches running", async (context) => {
  const session = await projectSession(context);
  const terminalEvents = [];
  const child = new FakeChild(201);
  const calls = [];
  const { supervisor, spawned } = fakeSupervisor({
    children: [child],
    terminalEvents,
  });
  supervisor.probePort = async (host, port) => {
    calls.push({ type: "probe", host, port });
    return false;
  };
  supervisor.healthCheck = async (url) => {
    calls.push({ type: "health", url });
    return true;
  };

  const starting = supervisor.start(session, "source");
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write("ready\n");
  child.stderr.write("warning\n");
  const state = await starting;

  assert.equal(state.state, "running");
  assert.equal(state.pid, 201);
  assert.deepEqual(calls, [
    { type: "probe", host: "127.0.0.1", port: 4101 },
    { type: "health", url: "http://127.0.0.1:4101/health" },
  ]);
  assert.deepEqual(spawned[0].command, [process.execPath, "-e", ""]);
  assert.equal(spawned[0].options.cwd, path.join(session.projectRoot, "app"));
  assert.equal(spawned[0].options.shell, false);
  assert.equal(spawned[0].options.env, process.env);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(terminalEvents, [
    { sessionId: "session-1", source: "preview:source", stream: "stdout", text: "ready\n" },
    { sessionId: "session-1", source: "preview:source", stream: "stderr", text: "warning\n" },
  ]);

  await supervisor.stopAll();
});

test("source and target starts can run concurrently", async (context) => {
  const session = await projectSession(context);
  session.metadata.previewServices.target = {
    command: [process.execPath, "-e", ""],
    port: 4102,
  };
  const { supervisor, spawned } = fakeSupervisor();

  const [source, target] = await Promise.all([
    supervisor.start(session, "source"),
    supervisor.start(session, "target"),
  ]);

  assert.equal(source.state, "running");
  assert.equal(target.state, "running");
  assert.equal(spawned.length, 2);
  await supervisor.stopAll();
});

test("start rejects unconfigured slots without probing or spawning", async (context) => {
  const session = await projectSession(context);
  let probes = 0;
  const { supervisor, spawned } = fakeSupervisor();
  supervisor.probePort = async () => {
    probes += 1;
    return false;
  };

  await assert.rejects(supervisor.start(session, "target"), /target.*not configured/i);
  assert.equal(probes, 0);
  assert.equal(spawned.length, 0);
});

test("occupied external ports become conflicts without owning or killing a process", async (context) => {
  const session = await projectSession(context);
  const { supervisor, spawned } = fakeSupervisor({ occupied: true });
  const events = [];
  const unsubscribe = supervisor.subscribe(session.id, (event) => events.push(event));

  const state = await supervisor.start(session, "source");

  assert.equal(state.state, "conflict");
  assert.equal(state.port, 4101);
  assert.match(state.diagnostic, /already in use/i);
  assert.equal(spawned.length, 0);
  assert.equal(events.at(-1).state.state, "conflict");
  unsubscribe();
});

test("same-slot overlapping operations reject with status 409", async (context) => {
  const session = await projectSession(context);
  let releaseProbe;
  const { supervisor } = fakeSupervisor();
  supervisor.probePort = () => new Promise((resolve) => {
    releaseProbe = resolve;
  });
  const first = supervisor.start(session, "source");
  while (!releaseProbe) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  await assert.rejects(
    supervisor.start(session, "source"),
    (error) => error.statusCode === 409 && /already in progress/i.test(error.message),
  );

  releaseProbe(true);
  await first;
});

test("starting an already running slot rejects with 409 without disturbing ownership", async (context) => {
  const session = await projectSession(context);
  const child = new FakeChild(250);
  const { supervisor, spawned } = fakeSupervisor({ children: [child] });
  let probes = 0;
  supervisor.probePort = async () => {
    probes += 1;
    return false;
  };
  const running = await supervisor.start(session, "source");

  await assert.rejects(
    supervisor.start(session, "source"),
    (error) => error.statusCode === 409 && /already running/i.test(error.message),
  );

  const current = (await supervisor.snapshot(session)).source;
  assert.equal(probes, 1);
  assert.equal(spawned.length, 1);
  assert.deepEqual(child.kills, []);
  assert.equal(current.state, "running");
  assert.equal(current.pid, running.pid);
  await supervisor.stopAll();
});

test("listeners are session-isolated, unsubscribable, and exception-safe", async (context) => {
  const session = await projectSession(context);
  const { supervisor } = fakeSupervisor({ occupied: true });
  const received = [];
  supervisor.subscribe(session.id, () => {
    throw new Error("listener failure");
  });
  supervisor.subscribe("another-session", (event) => received.push(event));
  const unsubscribe = supervisor.subscribe(session.id, (event) => received.push(event));

  await supervisor.start(session, "source");
  assert.ok(received.length > 0);
  assert.ok(received.every((event) => event.sessionId === session.id));

  const before = received.length;
  unsubscribe();
  await supervisor.start({ ...session, id: "session-2" }, "source");
  assert.equal(received.length, before);
});

test("early exit and startup timeout produce exited evidence and release ownership", async (context) => {
  const session = await projectSession(context);
  const early = new FakeChild(301);
  const slow = new FakeChild(302);
  const { supervisor } = fakeSupervisor({
    children: [early, slow],
    healthy: false,
    startupTimeoutMs: 15,
  });

  const earlyStart = supervisor.start(session, "source");
  while (supervisor.records.size === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  early.close(7, null);
  const earlyState = await earlyStart;
  assert.equal(earlyState.state, "exited");
  assert.equal(earlyState.exitCode, 7);
  assert.match(earlyState.diagnostic, /before.*healthy/i);

  const timeoutState = await supervisor.start(session, "source");
  assert.equal(timeoutState.state, "exited");
  assert.match(timeoutState.diagnostic, /timed out/i);
  assert.deepEqual(slow.kills, ["SIGTERM"]);
});

test("startup timeout is enforced when a health request stalls", async (context) => {
  const session = await projectSession(context);
  const child = new FakeChild(303);
  const { supervisor } = fakeSupervisor({
    children: [child],
    startupTimeoutMs: 5,
  });
  supervisor.healthCheck = () => new Promise((resolve) => setTimeout(() => resolve(false), 40));
  const startedAt = Date.now();

  const state = await supervisor.start(session, "source");

  assert.equal(state.state, "exited");
  assert.match(state.diagnostic, /timed out/i);
  assert.ok(Date.now() - startedAt < 30);
});

test("startup deadline aborts a pending health check and cleans up the child", async (context) => {
  const session = await projectSession(context);
  const child = new FakeChild(304);
  const { supervisor } = fakeSupervisor({
    children: [child],
    startupTimeoutMs: 5,
  });
  let healthSignal;
  supervisor.healthCheck = (url, { signal } = {}) => {
    healthSignal = signal;
    return new Promise(() => {});
  };

  const state = await supervisor.start(session, "source");

  assert.equal(healthSignal.aborted, true);
  assert.equal(state.state, "exited");
  assert.match(state.diagnostic, /timed out/i);
  assert.equal(child.closed, true);
  assert.equal(supervisor.startControllers.size, 0);
});

test("stopAll aborts pending health immediately and leaves no operation or child", async (context) => {
  const session = await projectSession(context);
  const child = new FakeChild(305);
  const { supervisor, spawned } = fakeSupervisor({
    children: [child],
    startupTimeoutMs: 500,
  });
  let healthSignal;
  let healthStarted;
  const enteredHealth = new Promise((resolve) => {
    healthStarted = resolve;
  });
  supervisor.healthCheck = (url, { signal } = {}) => {
    healthSignal = signal;
    healthStarted();
    return new Promise(() => {});
  };
  const starting = supervisor.start(session, "source");
  await enteredHealth;
  assert.equal(spawned.length, 1);
  const startedAt = Date.now();

  await supervisor.stopAll();
  const state = await starting;

  assert.ok(Date.now() - startedAt < 100);
  assert.equal(healthSignal.aborted, true);
  assert.equal(state.state, "exited");
  assert.equal(child.closed, true);
  assert.equal(supervisor.operations.size, 0);
  assert.equal(supervisor.startControllers.size, 0);
});

test("child process errors expose safe structured evidence", async (context) => {
  const session = await projectSession(context);
  const child = new FakeChild(306);
  const { supervisor } = fakeSupervisor({
    children: [child],
    healthy: false,
  });
  const starting = supervisor.start(session, "source");
  while (supervisor.records.size === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const childError = {
    name: "SpawnError",
    code: "EACCES",
    message: "launch failed",
    unsafe: { secret: true },
  };
  child.emit("error", childError);
  child.close(null, null);

  const state = await starting;

  assert.equal(state.state, "exited");
  assert.deepEqual(state.error, {
    name: "SpawnError",
    code: "EACCES",
    message: "launch failed",
  });
  assert.match(state.diagnostic, /EACCES.*launch failed/i);
  state.error.message = "mutated";
  assert.equal((await supervisor.snapshot(session)).source.error.message, "launch failed");
});

test("unexpected running exit records evidence", async (context) => {
  const session = await projectSession(context);
  const child = new FakeChild(401);
  const { supervisor } = fakeSupervisor({ children: [child] });
  await supervisor.start(session, "source");

  child.close(9, null);
  await new Promise((resolve) => setImmediate(resolve));
  const state = (await supervisor.snapshot(session)).source;

  assert.equal(state.state, "exited");
  assert.equal(state.exitCode, 9);
  assert.ok(state.exitedAt);
  assert.match(state.diagnostic, /unexpectedly/i);
});

test("stop terminates only the owned child and reaches stopped", async (context) => {
  const session = await projectSession(context);
  const child = new FakeChild(501);
  const { supervisor } = fakeSupervisor({ children: [child] });
  await supervisor.start(session, "source");

  const state = await supervisor.stop(session.id, "source");

  assert.equal(state.state, "stopped");
  assert.deepEqual(child.kills, ["SIGTERM"]);
});

test("stop escalates an ignoring child to SIGKILL", async (context) => {
  const session = await projectSession(context);
  const child = new FakeChild(601, { ignoreTerm: true });
  const { supervisor } = fakeSupervisor({ children: [child], stopTimeoutMs: 2 });
  await supervisor.start(session, "source");

  const state = await supervisor.stop(session.id, "source");

  assert.equal(state.state, "stopped");
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
});

test("restart replaces the child and stale child events cannot overwrite the new generation", async (context) => {
  const session = await projectSession(context);
  const first = new FakeChild(701);
  const second = new FakeChild(702);
  const { supervisor } = fakeSupervisor({ children: [first, second] });
  await supervisor.start(session, "source");

  const state = await supervisor.restart(session, "source");
  first.emit("close", 8, null);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(state.pid, 702);
  assert.equal((await supervisor.snapshot(session)).source.pid, 702);
  await supervisor.stopAll();
});

test("stopAll concurrently stops all children and is idempotent", async (context) => {
  const session = await projectSession(context);
  session.metadata.previewServices.target = {
    command: [process.execPath],
    port: 4102,
  };
  const source = new FakeChild(801);
  const target = new FakeChild(802);
  const { supervisor } = fakeSupervisor({ children: [source, target] });
  await Promise.all([
    supervisor.start(session, "source"),
    supervisor.start(session, "target"),
  ]);

  await supervisor.stopAll();
  await supervisor.stopAll();

  assert.deepEqual(source.kills, ["SIGTERM"]);
  assert.deepEqual(target.kills, ["SIGTERM"]);
  assert.equal((await supervisor.snapshot(session)).source.state, "stopped");
  assert.equal((await supervisor.snapshot(session)).target.state, "stopped");
});

test("stopAll waits for in-flight operations and leaves no owned child", async (context) => {
  const session = await projectSession(context);
  const child = new FakeChild(803);
  const { supervisor, spawned } = fakeSupervisor({
    children: [child],
    healthy: false,
    startupTimeoutMs: 10,
  });
  const starting = supervisor.start(session, "source");
  while (spawned.length === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  await supervisor.stopAll();
  await starting;

  assert.equal(child.closed, true);
  assert.equal(supervisor.operations.size, 0);
});

const fixturePath = new URL("./fixtures/preview-server.js", import.meta.url).pathname;
const integrationTest = process.env.PREVIEW_INTEGRATION === "0" ? test.skip : test;

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitForPortRelease(port) {
  const deadline = Date.now() + 1000;
  while (true) {
    const released = await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(false);
      });
      socket.once("error", (error) => {
        socket.destroy();
        if (error.code === "ECONNREFUSED") resolve(true);
        else reject(error);
      });
    });
    if (released) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for port ${port} to be released`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function unusedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await closeServer(server);
  await waitForPortRelease(port);
  return port;
}

async function fixtureSession(context, mode = "normal") {
  const projectRoot = await fs.realpath(process.cwd());
  const port = await unusedPort();
  return {
    id: `fixture-${mode}-${port}`,
    workbench: "migration",
    projectRoot,
    metadata: {
      previewServices: {
        source: {
          command: [process.execPath, fixturePath, String(port), mode],
          port,
          healthPath: "/health",
          previewPath: "/preview",
        },
      },
    },
  };
}

integrationTest("real preview fixture starts, streams, restarts, and releases its port on stop", async (context) => {
  const session = await fixtureSession(context);
  const terminalEvents = [];
  const supervisor = new PreviewProcessSupervisor({
    terminal: {
      append(sessionId, event) {
        terminalEvents.push({ sessionId, ...event });
      },
    },
    startupTimeoutMs: 2000,
    healthIntervalMs: 20,
    stopTimeoutMs: 100,
  });
  context.after(() => supervisor.stopAll());

  const first = await supervisor.start(session, "source");
  assert.equal(first.state, "running");
  assert.ok(first.pid);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(terminalEvents.some((event) => event.stream === "stdout" && /listening/.test(event.text)));
  assert.ok(terminalEvents.some((event) => event.stream === "stderr" && /diagnostic/.test(event.text)));

  const second = await supervisor.restart(session, "source");
  assert.equal(second.state, "running");
  assert.notEqual(second.pid, first.pid);
  const stopped = await supervisor.stop(session.id, "source");
  assert.equal(stopped.state, "stopped");

  const rebound = net.createServer();
  await listen(rebound, session.metadata.previewServices.source.port);
  await closeServer(rebound);
});

integrationTest("real occupied port remains external and the subscription survives the conflict", async (context) => {
  const session = await fixtureSession(context);
  const external = net.createServer();
  await listen(external, session.metadata.previewServices.source.port);
  context.after(() => closeServer(external).catch(() => {}));
  const supervisor = new PreviewProcessSupervisor({
    terminal: { append() {} },
    startupTimeoutMs: 2000,
    healthIntervalMs: 20,
  });
  context.after(() => supervisor.stopAll());
  const events = [];
  supervisor.subscribe(session.id, (event) => events.push(event));

  const conflict = await supervisor.start(session, "source");
  assert.equal(conflict.state, "conflict");
  await closeServer(external);

  const running = await supervisor.start(session, "source");
  assert.equal(running.state, "running");
  assert.equal(events.at(-1).state.state, "running");
});

integrationTest("real early-exit, unhealthy, and ignore-term fixtures leave no child processes", async (context) => {
  const terminalEvents = [];
  const supervisor = new PreviewProcessSupervisor({
    terminal: {
      append(sessionId, event) {
        terminalEvents.push({ sessionId, ...event });
      },
    },
    startupTimeoutMs: 120,
    healthIntervalMs: 10,
    stopTimeoutMs: 30,
  });
  context.after(() => supervisor.stopAll());

  const earlySession = await fixtureSession(context, "early-exit");
  const early = await supervisor.start(earlySession, "source");
  assert.equal(early.state, "exited");
  assert.equal(early.exitCode, 17);
  assert.match(early.diagnostic, /before becoming healthy/i);

  const unhealthySession = await fixtureSession(context, "unhealthy");
  const unhealthy = await supervisor.start(unhealthySession, "source");
  assert.equal(unhealthy.state, "exited");
  assert.match(unhealthy.diagnostic, /timed out/i);

  const ignoringSession = await fixtureSession(context, "ignore-term");
  const running = await supervisor.start(ignoringSession, "source");
  assert.equal(running.state, "running");
  await supervisor.stop(ignoringSession.id, "source");
  assert.throws(() => process.kill(running.pid, 0), /ESRCH/);
  assert.ok(terminalEvents.some((event) => /ignoring SIGTERM/.test(event.text)));

  await supervisor.stopAll();
  await supervisor.stopAll();
});
