import fs from "node:fs/promises";
import path from "node:path";

export class SessionStore {
  constructor(root) { this.root = root; }
  async initialize() { await fs.mkdir(this.root, { recursive: true }); }
  filePath(id) {
    if (!/^[a-f0-9-]+$/i.test(id)) throw new Error("Invalid session id");
    return path.join(this.root, `${id}.json`);
  }
  async save(session) {
    await this.initialize();
    const destination = this.filePath(session.id);
    const temporary = `${destination}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    await fs.rename(temporary, destination);
    return session;
  }
  async get(id) {
    try { return JSON.parse(await fs.readFile(this.filePath(id), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async list() {
    await this.initialize();
    const files = (await fs.readdir(this.root)).filter((name) => name.endsWith(".json"));
    const sessions = await Promise.all(files.map((name) => fs.readFile(path.join(this.root, name), "utf8").then(JSON.parse)));
    return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
}
