import fs from "node:fs/promises";
import path from "node:path";

export async function resolveProjectRoot(candidate, allowedRoot) {
  const resolvedAllowed = await fs.realpath(path.resolve(allowedRoot));
  const resolvedProject = await fs.realpath(path.resolve(candidate));
  const relative = path.relative(resolvedAllowed, resolvedProject);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Project must be inside allowed root: ${resolvedAllowed}`);
  return resolvedProject;
}

export function resolveInsideProject(projectRoot, candidate = ".") {
  const resolved = path.resolve(projectRoot, candidate);
  const relative = path.relative(projectRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Path escapes project root");
  return resolved;
}

export async function resolveCommandCwd(projectRoot, candidate = ".") {
  if (!path.isAbsolute(projectRoot) || path.resolve(projectRoot) !== projectRoot) {
    throw new Error("Project root must be a canonical absolute path");
  }

  let rootEntry;
  try {
    rootEntry = await fs.lstat(projectRoot);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Project root does not exist: ${projectRoot}`);
    throw error;
  }
  if (rootEntry.isSymbolicLink()) throw new Error(`Project root must not be a symbolic link: ${projectRoot}`);
  if (!rootEntry.isDirectory()) throw new Error(`Project root must be a directory: ${projectRoot}`);

  const canonicalRoot = await fs.realpath(projectRoot);
  if (canonicalRoot !== projectRoot) throw new Error(`Project root must be its canonical absolute path: ${canonicalRoot}`);

  const lexicalCwd = resolveInsideProject(projectRoot, candidate);
  let canonicalCwd;
  try {
    canonicalCwd = await fs.realpath(lexicalCwd);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Command working directory does not exist: ${lexicalCwd}`);
    throw error;
  }
  const relative = path.relative(canonicalRoot, canonicalCwd);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Command working directory escapes project boundary: ${canonicalRoot}`);
  }
  if (!(await fs.stat(canonicalCwd)).isDirectory()) {
    throw new Error(`Command working directory must be a directory: ${canonicalCwd}`);
  }
  return canonicalCwd;
}
