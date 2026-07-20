import fs from "node:fs/promises";
import path from "node:path";

const WORKBENCHES = new Set(["execution", "migration"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isIsoTimestamp(value) {
  if (!isNonEmptyString(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isRecentProject(entry) {
  return entry !== null
    && typeof entry === "object"
    && isNonEmptyString(entry.projectRoot)
    && WORKBENCHES.has(entry.workbench)
    && isIsoTimestamp(entry.lastUsedAt);
}

function normalizeRecentProject(entry) {
  return {
    projectRoot: entry.projectRoot,
    workbench: entry.workbench,
    lastUsedAt: entry.lastUsedAt,
  };
}

export class RecentProjectStore {
  constructor(filePath, { limit = 8, warn = console.warn } = {}) {
    this.filePath = filePath;
    this.limit = limit;
    this.warn = warn;
  }

  async list() {
    let state;
    try {
      state = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      if (error instanceof SyntaxError) {
        this.warn(`Recent projects file contains invalid JSON: ${this.filePath}`);
        return [];
      }
      throw error;
    }

    if (!Array.isArray(state)) {
      this.warn(`Recent projects state must be an array: ${this.filePath}`);
      return [];
    }

    const entries = state.filter(isRecentProject);
    if (entries.length !== state.length) {
      this.warn(`Recent projects state contains malformed entries: ${this.filePath}`);
    }
    return entries.map(normalizeRecentProject);
  }

  async record({ projectRoot, workbench }) {
    if (!isNonEmptyString(projectRoot)) throw new TypeError("projectRoot must be a non-empty string");
    if (!WORKBENCHES.has(workbench)) throw new TypeError("workbench must be execution or migration");

    const existing = await this.list();
    const entries = [
      { projectRoot, workbench, lastUsedAt: new Date().toISOString() },
      ...existing.filter((entry) => entry.projectRoot !== projectRoot),
    ].slice(0, this.limit);

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
    await fs.rename(temporary, this.filePath);
    return entries.map(normalizeRecentProject);
  }
}
