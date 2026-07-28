import { spawn } from "node:child_process";
import net from "node:net";
import { resolveCommandCwd } from "./project-boundary.js";

const SLOTS = new Set(["source", "target"]);
const SERVICE_KEYS = new Set([
  "command",
  "cwd",
  "port",
  "healthPath",
  "previewPath",
]);

function assertOriginRelativePath(value, field) {
  if (
    typeof value !== "string"
    || !/^\/(?!\/)/.test(value)
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${field} must be an origin-relative path beginning with a single /`);
  }
}

export async function resolvePreviewConfig(session, slot) {
  if (session?.workbench !== "migration") {
    throw new Error("Preview services require a Migration session");
  }
  if (!SLOTS.has(slot)) {
    throw new Error("Preview slot must be exactly source or target");
  }

  const services = session.metadata?.previewServices;
  if (services === undefined) return null;
  if (!services || Array.isArray(services) || typeof services !== "object") {
    throw new Error("metadata.previewServices must be an object");
  }
  const unknownSlot = Object.keys(services).find((key) => !SLOTS.has(key));
  if (unknownSlot) {
    throw new Error("metadata.previewServices may contain only source and target");
  }

  const service = services[slot];
  if (service === undefined) return null;
  if (!service || Array.isArray(service) || typeof service !== "object") {
    throw new Error(`metadata.previewServices.${slot} must be an object`);
  }
  const unsupportedKey = Object.keys(service).find((key) => !SERVICE_KEYS.has(key));
  if (unsupportedKey) {
    throw new Error(`Unsupported preview service key: ${unsupportedKey}`);
  }
  if (
    !Array.isArray(service.command)
    || service.command.length === 0
    || service.command.some((part) => typeof part !== "string")
    || service.command[0].length === 0
  ) {
    throw new Error("Preview command must be a non-empty string array");
  }
  if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535) {
    throw new Error("Preview port must be an integer between 1 and 65535");
  }
  const cwdCandidate = service.cwd ?? ".";
  if (typeof cwdCandidate !== "string" || cwdCandidate.length === 0) {
    throw new Error("Preview cwd must be a non-empty string");
  }
  const healthPath = service.healthPath ?? "/";
  const previewPath = service.previewPath ?? "/";
  assertOriginRelativePath(healthPath, "healthPath");
  assertOriginRelativePath(previewPath, "previewPath");

  const cwd = await resolveCommandCwd(session.projectRoot, cwdCandidate);
  const origin = `http://127.0.0.1:${service.port}`;
  return {
    command: [...service.command],
    cwd,
    port: service.port,
    healthPath,
    previewPath,
    actualUrl: `${origin}${previewPath}`,
    healthUrl: `${origin}${healthPath}`,
  };
}

function clone(value) {
  return structuredClone(value);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultProbePort(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED") finish(false);
      else reject(error);
    });
  });
}

async function defaultHealthCheck(url, { signal } = {}) {
  try {
    const response = await fetch(url, { redirect: "manual", signal });
    await response.body?.cancel();
    return response.status >= 200 && response.status <= 399;
  } catch (error) {
    if (error.name === "AbortError") throw error;
    return false;
  }
}

function safeProcessError(error) {
  return {
    name: typeof error?.name === "string" ? error.name : "Error",
    ...(typeof error?.code === "string" ? { code: error.code } : {}),
    message: typeof error?.message === "string" ? error.message : String(error),
  };
}

function operationConflict(message = "A preview operation is already in progress for this slot") {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

export class PreviewProcessSupervisor {
  constructor({
    terminal,
    startupTimeoutMs = 10000,
    healthIntervalMs = 100,
    stopTimeoutMs = 3000,
    spawnProcess = (command, options) => spawn(command[0], command.slice(1), options),
    probePort = defaultProbePort,
    healthCheck = defaultHealthCheck,
  } = {}) {
    if (!terminal || typeof terminal.append !== "function") {
      throw new Error("PreviewProcessSupervisor requires terminal.append");
    }
    for (const [name, value] of Object.entries({
      startupTimeoutMs,
      healthIntervalMs,
      stopTimeoutMs,
    })) {
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer`);
      }
    }
    this.terminal = terminal;
    this.startupTimeoutMs = startupTimeoutMs;
    this.healthIntervalMs = healthIntervalMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.spawnProcess = spawnProcess;
    this.probePort = probePort;
    this.healthCheck = healthCheck;
    this.records = new Map();
    this.listeners = new Map();
    this.operations = new Set();
    this.nextGeneration = 1;
    this.nextEventSequence = 1;
    this.stoppingAll = false;
    this.stopAllPromise = null;
    this.startControllers = new Map();
  }

  #key(sessionId, slot) {
    return `${sessionId}\u0000${slot}`;
  }

  #publicState(record) {
    const { child, expectedExit, sessionId, slot, generation, ...state } = record;
    return clone(state);
  }

  #emit(record) {
    const sequence = this.nextEventSequence++;
    record.latestSequence = sequence;
    const event = {
      type: "preview.state",
      sessionId: record.sessionId,
      slot: record.slot,
      sequence,
      state: this.#publicState(record),
    };
    for (const listener of this.listeners.get(record.sessionId) ?? []) {
      try {
        listener(clone(event));
      } catch {
        // One consumer must not prevent other state subscribers from receiving updates.
      }
    }
  }

  #setRecord(sessionId, slot, state) {
    const key = this.#key(sessionId, slot);
    const prior = this.records.get(key);
    const record = {
      sessionId,
      slot,
      generation: prior?.generation ?? 0,
      ...state,
    };
    this.records.set(key, record);
    this.#emit(record);
    return record;
  }

  async snapshot(session) {
    const result = {};
    for (const slot of SLOTS) {
      const runtime = this.records.get(this.#key(session.id, slot));
      if (runtime) {
        result[slot] = this.#publicState(runtime);
        continue;
      }
      const config = await resolvePreviewConfig(session, slot);
      result[slot] = config
        ? {
            state: "stopped",
            config: clone(config),
            actualUrl: config.actualUrl,
            healthUrl: config.healthUrl,
            latestSequence: 0,
          }
        : { state: "unconfigured", latestSequence: 0 };
    }
    return result;
  }

  subscribe(sessionId, listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    const listeners = this.listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  async #withLock(sessionId, slot, operation) {
    if (!SLOTS.has(slot)) throw new Error("Preview slot must be exactly source or target");
    if (this.stoppingAll) throw operationConflict();
    const key = this.#key(sessionId, slot);
    if (this.operations.has(key)) throw operationConflict();
    this.operations.add(key);
    try {
      return await operation();
    } finally {
      this.operations.delete(key);
    }
  }

  start(session, slot) {
    return this.#withLock(session?.id, slot, () => this.#start(session, slot));
  }

  async #start(session, slot) {
    const key = this.#key(session.id, slot);
    const controller = new AbortController();
    this.startControllers.set(key, controller);
    try {
      return await this.#startControlled(session, slot, controller);
    } finally {
      controller.abort("start-complete");
      if (this.startControllers.get(key) === controller) {
        this.startControllers.delete(key);
      }
    }
  }

  async #startControlled(session, slot, controller) {
    const config = await resolvePreviewConfig(session, slot);
    if (!config) throw new Error(`Preview slot ${slot} is not configured`);

    const existing = this.records.get(this.#key(session.id, slot));
    if (existing?.child) throw operationConflict(`Preview slot ${slot} is already running`);

    const occupied = await this.probePort("127.0.0.1", config.port);
    if (occupied) {
      return this.#publicState(this.#setRecord(session.id, slot, {
        state: "conflict",
        config,
        port: config.port,
        actualUrl: config.actualUrl,
        healthUrl: config.healthUrl,
        diagnostic: `Port ${config.port} is already in use on 127.0.0.1`,
        observedAt: new Date().toISOString(),
      }));
    }

    const generation = this.nextGeneration++;
    const record = this.#setRecord(session.id, slot, {
      state: "starting",
      config,
      actualUrl: config.actualUrl,
      healthUrl: config.healthUrl,
      generation,
      startedAt: new Date().toISOString(),
      child: null,
    });

    let child;
    try {
      child = this.spawnProcess(config.command, {
        cwd: config.cwd,
        shell: false,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const processError = safeProcessError(error);
      Object.assign(record, {
        state: "exited",
        error: processError,
        diagnostic: `Preview process failed to spawn${processError.code ? ` (${processError.code})` : ""}: ${processError.message}`,
        exitedAt: new Date().toISOString(),
      });
      this.#emit(record);
      return this.#publicState(record);
    }
    record.child = child;
    record.pid = child.pid;

    for (const stream of ["stdout", "stderr"]) {
      child[stream]?.setEncoding("utf8");
      child[stream]?.on("data", (text) => {
        this.terminal.append(session.id, {
          source: `preview:${slot}`,
          stream,
          text,
        });
      });
    }

    let closed = false;
    let closeEvidence;
    let resolveClosed;
    const closedPromise = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    child.once("error", (error) => {
      closeEvidence = { error: safeProcessError(error) };
    });
    child.once("close", (exitCode, signal) => {
      closed = true;
      closeEvidence = { ...closeEvidence, exitCode, signal };
      resolveClosed(closeEvidence);
      controller.abort("child-exit");
      const current = this.records.get(this.#key(session.id, slot));
      if (current !== record || current.generation !== generation || record.expectedExit) return;
      const processError = closeEvidence.error;
      Object.assign(record, {
        state: "exited",
        child: null,
        exitCode,
        signal,
        exitedAt: new Date().toISOString(),
        ...(processError ? { error: processError } : {}),
        diagnostic: processError
          ? `Preview process error${processError.code ? ` ${processError.code}` : ""}: ${processError.message}`
          : record.state === "running"
            ? "Preview process exited unexpectedly"
            : "Preview process exited before becoming healthy",
      });
      this.#emit(record);
    });

    let resolveAborted;
    const abortedPromise = new Promise((resolve) => {
      resolveAborted = resolve;
    });
    const handleAbort = () => resolveAborted(false);
    controller.signal.addEventListener("abort", handleAbort, { once: true });
    const deadlineTimer = setTimeout(
      () => controller.abort("startup-timeout"),
      this.startupTimeoutMs,
    );
    try {
      while (!closed && !controller.signal.aborted) {
        const healthy = await Promise.race([
          Promise.resolve()
            .then(() => this.healthCheck(config.healthUrl, { signal: controller.signal }))
            .catch(() => false),
          closedPromise.then(() => false),
          abortedPromise,
        ]);
        if (healthy) {
          if (closed || controller.signal.aborted) break;
          Object.assign(record, {
            state: "running",
            readyAt: new Date().toISOString(),
          });
          this.#emit(record);
          return this.#publicState(record);
        }
        if (closed || controller.signal.aborted) break;
        if (this.healthIntervalMs > 0) {
          let intervalTimer;
          await Promise.race([
            closedPromise,
            abortedPromise,
            new Promise((resolve) => {
              intervalTimer = setTimeout(resolve, this.healthIntervalMs);
            }),
          ]);
          clearTimeout(intervalTimer);
        } else {
          await Promise.resolve();
        }
      }

      if (closed) {
        return this.#publicState(record);
      }

      const shutdown = controller.signal.reason === "shutdown";
      record.expectedExit = shutdown ? "shutdown" : "startup-timeout";
      child.kill("SIGTERM");
      await this.#waitForClose(child, closedPromise);
      Object.assign(record, {
        state: "exited",
        child: null,
        exitCode: closeEvidence?.exitCode ?? null,
        signal: closeEvidence?.signal ?? null,
        exitedAt: new Date().toISOString(),
        diagnostic: shutdown
          ? "Preview startup was cancelled during shutdown"
          : `Preview startup timed out after ${this.startupTimeoutMs}ms`,
      });
      this.#emit(record);
      return this.#publicState(record);
    } finally {
      clearTimeout(deadlineTimer);
      controller.signal.removeEventListener("abort", handleAbort);
    }
  }

  stop(sessionId, slot) {
    return this.#withLock(sessionId, slot, () => this.#stop(sessionId, slot));
  }

  async #waitForClose(child, closedPromise) {
    let timeout;
    const forceKill = new Promise((resolve) => {
      timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, this.stopTimeoutMs);
    });
    await Promise.race([closedPromise, forceKill]);
    if (!child.closed && child.exitCode === null && child.signalCode === null) {
      await closedPromise;
    }
    clearTimeout(timeout);
  }

  async #stop(sessionId, slot) {
    const record = this.records.get(this.#key(sessionId, slot));
    if (!record?.child) {
      if (record) {
        Object.assign(record, { state: "stopped" });
        this.#emit(record);
        return this.#publicState(record);
      }
      return { state: "stopped" };
    }

    const child = record.child;
    record.expectedExit = "stop";
    record.state = "stopping";
    this.#emit(record);
    const closedPromise = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGTERM");
    await this.#waitForClose(child, closedPromise);
    Object.assign(record, {
      state: "stopped",
      child: null,
      pid: undefined,
      stoppedAt: new Date().toISOString(),
    });
    delete record.expectedExit;
    this.#emit(record);
    return this.#publicState(record);
  }

  restart(session, slot) {
    return this.#withLock(session?.id, slot, async () => {
      await this.#stop(session.id, slot);
      return this.#start(session, slot);
    });
  }

  async stopAll() {
    if (this.stopAllPromise) return this.stopAllPromise;
    this.stoppingAll = true;
    for (const controller of this.startControllers.values()) {
      controller.abort("shutdown");
    }
    this.stopAllPromise = (async () => {
      while (this.operations.size > 0) {
        await delay(1);
      }
      const owned = [...this.records.values()].filter((record) => record.child);
      await Promise.all(owned.map((record) => this.#stop(record.sessionId, record.slot)));
      this.operations.clear();
      this.listeners.clear();
      this.startControllers.clear();
    })().finally(() => {
      this.stoppingAll = false;
      this.stopAllPromise = null;
    });
    return this.stopAllPromise;
  }
}
