import fs from "node:fs/promises";
import path from "node:path";

export async function resolveProjectRoot(candidate, allowedRoot) {
  const resolvedAllowed = await fs.realpath(path.resolve(allowedRoot));
  const resolvedProject = await fs.realpath(path.resolve(candidate));
  const relative = path.relative(resolvedAllowed, resolvedProject);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Project must be inside allowed root: ${resolvedAllowed}`);
  return resolvedProject;
}

export function resolveInsideProject(projectRoot, candidate = ".") {
  const resolved = path.resolve(projectRoot, candidate);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Path escapes project root");
  return resolved;
}
