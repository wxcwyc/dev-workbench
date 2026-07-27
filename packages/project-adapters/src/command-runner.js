import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { resolveCommandCwd } from "./project-boundary.js";

export async function runConfirmedCommand(projectRoot, action, {
  timeoutMs = 120000,
  maxOutputBytes = 8 * 1024 * 1024,
  onOutput = () => {},
  signal,
  terminationGraceMs = 1000,
} = {}) {
  if (!Array.isArray(action?.command) || !action.command.length || action.command.some((part) => typeof part !== "string")) throw new Error("Step action.command must be a non-empty string array");
  if (!Number.isInteger(terminationGraceMs) || terminationGraceMs < 0) throw new Error("terminationGraceMs must be a finite non-negative integer");
  const [executable, ...args] = action.command;
  const cwd = await resolveCommandCwd(projectRoot, action.cwd ?? ".");
  const startedAt = new Date().toISOString();

  const initialResult = () => ({
    command: action.command,
    cwd,
    stdout: "",
    stderr: "",
    exitCode: null,
    startedAt,
    completedAt: new Date().toISOString(),
  });
  const abortError = () => Object.assign(new Error("Command aborted"), { name: "AbortError" });
  if (signal?.aborted) {
    const error = abortError();
    error.result = initialResult();
    throw error;
  }

  return new Promise((resolve, reject) => {
    const decoders = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };
    const output = { stdout: "", stderr: "" };
    let outputBytes = 0;
    let settled = false;
    let failure = null;
    let terminated = false;
    let timeout;
    let terminationGraceTimeout;
    let child;

    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(terminationGraceTimeout);
      signal?.removeEventListener("abort", handleAbort);
    };
    const makeResult = (exitCode, childSignal) => ({
      command: action.command,
      cwd,
      ...output,
      exitCode,
      ...(childSignal ? { signal: childSignal } : {}),
      startedAt,
      completedAt: new Date().toISOString(),
    });
    const settle = (error, exitCode, childSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const result = makeResult(exitCode, childSignal);
      if (error) {
        error.result = result;
        reject(error);
      } else {
        resolve(result);
      }
    };
    const terminate = (error) => {
      if (failure) return;
      failure = error;
      if (!terminated) {
        terminated = true;
        child.kill("SIGTERM");
        terminationGraceTimeout = setTimeout(() => {
          if (!settled) child.kill("SIGKILL");
        }, terminationGraceMs);
      }
    };
    function handleAbort() {
      terminate(abortError());
    }

    try {
      child = spawn(executable, args, { cwd, shell: false, env: process.env });
    } catch (error) {
      settle(error, null, null);
      return;
    }

    for (const stream of ["stdout", "stderr"]) {
      child[stream].on("data", (chunk) => {
        if (failure || settled) return;
        const remainingBytes = Math.max(0, maxOutputBytes - outputBytes);
        const accepted = chunk.subarray(0, remainingBytes);
        outputBytes += accepted.length;
        const text = decoders[stream].write(accepted);
        if (text) {
          output[stream] += text;
          try {
            onOutput({ stream, text });
          } catch (error) {
            terminate(error);
            return;
          }
        }
        if (accepted.length < chunk.length) {
          terminate(new Error(`Command output exceeded ${maxOutputBytes} bytes`));
        }
      });
    }

    child.once("error", (error) => {
      settle(failure ?? error, null, null);
    });
    child.once("close", (exitCode, childSignal) => {
      if (!failure) {
        for (const stream of ["stdout", "stderr"]) {
          const text = decoders[stream].end();
          if (!text) continue;
          output[stream] += text;
          try {
            onOutput({ stream, text });
          } catch (error) {
            failure = error;
            break;
          }
        }
      }
      if (failure) settle(failure, exitCode, childSignal);
      else if (exitCode === 0) settle(null, 0, childSignal);
      else settle(new Error(`Command exited with code ${exitCode}`), exitCode, childSignal);
    });

    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) handleAbort();
    timeout = setTimeout(() => {
      terminate(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}
