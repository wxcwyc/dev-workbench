import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveCommandCwd } from "./project-boundary.js";
const execFileAsync = promisify(execFile);

export async function runConfirmedCommand(projectRoot, action, { timeoutMs = 120000 } = {}) {
  if (!Array.isArray(action?.command) || !action.command.length || action.command.some((part) => typeof part !== "string")) throw new Error("Step action.command must be a non-empty string array");
  const [executable, ...args] = action.command;
  const cwd = await resolveCommandCwd(projectRoot, action.cwd ?? ".");
  const startedAt = new Date().toISOString();
  const result = await execFileAsync(executable, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...(action.env ?? {}) } });
  return { command: action.command, cwd, stdout: result.stdout, stderr: result.stderr, exitCode: 0, startedAt, completedAt: new Date().toISOString() };
}
