import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const ignored = new Set([".git", "node_modules", ".dev-workbench"]);
const textExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".md", ".html", ".css", ".yml", ".yaml", ".toml", ".txt", ".pl"]);

function reportOptionalError(onError, relativePath, error) {
  if (!onError) throw error;
  onError(relativePath, error);
}

async function walk(root, current, entries, limit, options, rootDirectory = false) {
  if (entries.length >= limit) return;
  let children;
  try {
    children = await fs.readdir(current, { withFileTypes: true });
  } catch (error) {
    if (rootDirectory) throw error;
    reportOptionalError(options.onError, path.relative(root, current), error);
    return;
  }
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    if (entries.length >= limit || ignored.has(child.name)) continue;
    const absolute = path.join(current, child.name);
    const relativePath = path.relative(root, absolute);
    if (child.isDirectory()) {
      entries.push({ path: relativePath, type: "directory" });
      await walk(root, absolute, entries, limit, options);
      continue;
    }
    if (!child.isFile()) continue;
    let stat;
    try {
      stat = await fs.stat(absolute);
    } catch (error) {
      reportOptionalError(options.onError, relativePath, error);
      continue;
    }
    const entry = { path: relativePath, type: "file", size: stat.size, modifiedAt: stat.mtime.toISOString() };
    if (options.hashFiles && stat.size <= 128 * 1024 && textExtensions.has(path.extname(child.name).toLowerCase())) {
      try {
        entry.hash = createHash("sha256").update(await fs.readFile(absolute)).digest("hex").slice(0, 16);
      } catch (error) {
        reportOptionalError(options.onError, relativePath, error);
      }
    }
    entries.push(entry);
  }
}

export async function captureFileTree(projectRoot, limit = 2000, { hashFiles = true, onError = null } = {}) {
  const entries = [];
  await walk(projectRoot, projectRoot, entries, limit, { hashFiles, onError }, true);
  return { entries, truncated: entries.length >= limit };
}

export function compareTrees(before = { entries: [] }, after = { entries: [] }) {
  const left = new Map(before.entries.map((entry) => [entry.path, entry]));
  const right = new Map(after.entries.map((entry) => [entry.path, entry]));
  const changes = [];
  for (const [filePath, entry] of right) {
    if (!left.has(filePath)) changes.push({ path: filePath, status: "added" });
    else if (entry.hash && left.get(filePath).hash && entry.hash !== left.get(filePath).hash) changes.push({ path: filePath, status: "modified" });
  }
  for (const filePath of left.keys()) if (!right.has(filePath)) changes.push({ path: filePath, status: "deleted" });
  return changes;
}
