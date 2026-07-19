import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

async function git(projectRoot, args) {
  try {
    const result = await execFileAsync("git", ["-C", projectRoot, ...args], { maxBuffer: 8 * 1024 * 1024 });
    return result.stdout.trim();
  } catch (error) {
    if (/not a git repository/i.test(error.stderr ?? "")) return null;
    throw error;
  }
}

export async function captureGitState(projectRoot) {
  const head = await git(projectRoot, ["rev-parse", "--short", "HEAD"]);
  if (head === null) return { available: false, head: null, status: "", diff: "" };
  const [status, diff] = await Promise.all([git(projectRoot, ["status", "--short"]), git(projectRoot, ["diff", "--no-ext-diff", "--", "."])]);
  return { available: true, head, status, diff };
}
