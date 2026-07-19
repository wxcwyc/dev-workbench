import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const ignored = new Set([".git", "node_modules", ".dev-workbench"]);
const textExtensions = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".md", ".html", ".css", ".yml", ".yaml", ".toml", ".txt", ".pl"]);

async function walk(root, current, entries, limit) {
  if (entries.length >= limit) return;
  const children = await fs.readdir(current, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    if (entries.length >= limit || ignored.has(child.name)) continue;
    const absolute = path.join(current, child.name);
    const relativePath = path.relative(root, absolute);
    if (child.isDirectory()) {
      entries.push({ path: relativePath, type: "directory" });
      await walk(root, absolute, entries, limit);
      continue;
    }
    if (!child.isFile()) continue;
    const stat = await fs.stat(absolute);
    const entry = { path: relativePath, type: "file", size: stat.size, modifiedAt: stat.mtime.toISOString() };
    if (stat.size <= 128 * 1024 && textExtensions.has(path.extname(child.name).toLowerCase())) {
      entry.hash = createHash("sha256").update(await fs.readFile(absolute)).digest("hex").slice(0, 16);
    }
    entries.push(entry);
  }
}

export async function captureFileTree(projectRoot, limit = 2000) {
  const entries = [];
  await walk(projectRoot, projectRoot, entries, limit);
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
