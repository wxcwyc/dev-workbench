import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectProject } from "../packages/project-adapters/src/project-inspector.js";

async function createProject(context) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-inspect-"));
  context.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  return projectRoot;
}

function createPartialReadHandle(content, chunkSizes = []) {
  const source = Buffer.from(content);
  const calls = [];
  let sourceOffset = 0;
  let chunkIndex = 0;
  return {
    calls,
    async read(buffer, offset, length, position) {
      const call = { offset, length, position, bytesRead: 0 };
      calls.push(call);
      const requestedChunk = chunkSizes[chunkIndex++] ?? length;
      const bytesRead = Math.min(requestedChunk, length, source.length - sourceOffset);
      call.bytesRead = bytesRead;
      if (bytesRead > 0) {
        source.copy(buffer, offset, sourceOffset, sourceOffset + bytesRead);
        sourceOffset += bytesRead;
      }
      return { bytesRead, buffer };
    },
  };
}

test("inspects a pnpm Next.js TypeScript project", async (context) => {
  const projectRoot = await createProject(context);
  await fs.mkdir(path.join(projectRoot, ".git"));
  await fs.mkdir(path.join(projectRoot, "src"));
  await fs.writeFile(path.join(projectRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await fs.writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
    dependencies: { next: "latest", react: "latest" }
  }));
  await fs.writeFile(path.join(projectRoot, "src", "page.tsx"), "export default function Page() {}\n");

  assert.deepEqual(await inspectProject(projectRoot), {
    projectRoot,
    git: true,
    packageManager: "pnpm",
    languages: ["TypeScript"],
    frameworks: ["Next.js", "React"],
    evidence: ["package.json", "pnpm-lock.yaml", "src/page.tsx"],
    warnings: []
  });
});

test("keeps inspecting when package.json is malformed", async (context) => {
  const projectRoot = await createProject(context);
  await fs.writeFile(path.join(projectRoot, "package-lock.json"), "{}\n");
  await fs.writeFile(path.join(projectRoot, "package.json"), "{ not-json");
  await fs.writeFile(path.join(projectRoot, "main.py"), "print('hello')\n");

  const result = await inspectProject(projectRoot);

  assert.equal(result.packageManager, "npm");
  assert.deepEqual(result.languages, ["Python"]);
  assert.deepEqual(result.frameworks, []);
  assert.deepEqual(result.evidence, ["main.py", "package-lock.json", "package.json"]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /package\.json/);
});

test("falls back to npm and sorts languages by frequency then name", async (context) => {
  const projectRoot = await createProject(context);
  await fs.mkdir(path.join(projectRoot, "src"));
  await fs.writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
    devDependencies: { vite: "latest" }
  }));
  await fs.writeFile(path.join(projectRoot, "src", "first.js"), "export const first = 1;\n");
  await fs.writeFile(path.join(projectRoot, "src", "second.jsx"), "export const Second = () => null;\n");
  await fs.writeFile(path.join(projectRoot, "src", "app.ts"), "export const app = true;\n");
  await fs.writeFile(path.join(projectRoot, "src", "main.py"), "print('hello')\n");

  const result = await inspectProject(projectRoot);

  assert.equal(result.packageManager, "npm");
  assert.deepEqual(result.languages, ["JavaScript", "Python", "TypeScript"]);
  assert.deepEqual(result.frameworks, ["Vite"]);
});

test("detects root package metadata when the language scan is truncated", async (context) => {
  const projectRoot = await createProject(context);
  const crowdedDirectory = path.join(projectRoot, "a-crowded-directory");
  await fs.mkdir(crowdedDirectory);
  await Promise.all(Array.from(
    { length: 1999 },
    (_, index) => fs.mkdir(path.join(crowdedDirectory, `entry-${String(index).padStart(4, "0")}`))
  ));
  await fs.writeFile(path.join(projectRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await fs.writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
    dependencies: { next: "latest" }
  }));

  const result = await inspectProject(projectRoot);

  assert.equal(result.packageManager, "pnpm");
  assert.deepEqual(result.frameworks, ["Next.js"]);
  assert.ok(result.evidence.includes("package.json"));
  assert.ok(result.evidence.includes("pnpm-lock.yaml"));
  assert.deepEqual(result.warnings, ["Language scan truncated after 2000 file-tree entries."]);
});

test("recognizes a Git worktree metadata file", async (context) => {
  const projectRoot = await createProject(context);
  await fs.writeFile(path.join(projectRoot, ".git"), "gitdir: ../.git/worktrees/example\n");

  const result = await inspectProject(projectRoot);

  assert.equal(result.git, true);
});

test("does not follow a package.json symlink outside the project", async (context) => {
  const projectRoot = await createProject(context);
  const outsideRoot = await createProject(context);
  const outsideManifest = path.join(outsideRoot, "outside-package.json");
  await fs.writeFile(outsideManifest, JSON.stringify({
    dependencies: { next: "latest" }
  }));
  await fs.symlink(outsideManifest, path.join(projectRoot, "package.json"));

  const result = await inspectProject(projectRoot);

  assert.equal(result.packageManager, null);
  assert.deepEqual(result.frameworks, []);
  assert.ok(!result.evidence.includes("package.json"));
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /package\.json.*symbolic link/i);
});

test("does not read a package.json larger than one MiB", async (context) => {
  const projectRoot = await createProject(context);
  await fs.writeFile(path.join(projectRoot, "package.json"), JSON.stringify({
    dependencies: { next: "latest" },
    padding: "x".repeat(1_048_576)
  }));

  const result = await inspectProject(projectRoot);

  assert.equal(result.packageManager, null);
  assert.deepEqual(result.frameworks, []);
  assert.ok(!result.evidence.includes("package.json"));
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /package\.json.*too large/i);
});

test("ignores a non-regular package.json", async (context) => {
  const projectRoot = await createProject(context);
  await fs.mkdir(path.join(projectRoot, "package.json"));

  const result = await inspectProject(projectRoot);

  assert.ok(!result.evidence.includes("package.json"));
  assert.ok(result.warnings.some((warning) => /package\.json.*regular file/i.test(warning)));
});

test("warns when package.json cannot be opened", async (context) => {
  const projectRoot = await createProject(context);
  const packagePath = path.join(projectRoot, "package.json");
  await fs.writeFile(packagePath, "{}\n");
  const originalOpen = fs.open.bind(fs);
  context.mock.method(fs, "open", async (target, ...args) => {
    if (path.resolve(target) === packagePath) throw new Error("open denied");
    return originalOpen(target, ...args);
  });

  const result = await inspectProject(projectRoot);

  assert.ok(!result.evidence.includes("package.json"));
  assert.ok(result.warnings.some((warning) => /package\.json.*open denied/i.test(warning)));
});

test("warns and closes the handle when package.json cannot be read", async (context) => {
  const projectRoot = await createProject(context);
  const packagePath = path.join(projectRoot, "package.json");
  await fs.writeFile(packagePath, "{}\n");
  const originalOpen = fs.open.bind(fs);
  let closed = false;
  context.mock.method(fs, "open", async (target, ...args) => {
    if (path.resolve(target) !== packagePath) return originalOpen(target, ...args);
    return {
      stat: () => fs.stat(packagePath),
      read: async () => { throw new Error("read denied"); },
      close: async () => { closed = true; },
    };
  });

  const result = await inspectProject(projectRoot);

  assert.equal(closed, true);
  assert.ok(!result.evidence.includes("package.json"));
  assert.ok(result.warnings.some((warning) => /package\.json.*read denied/i.test(warning)));
});

test("rejects package.json growth after a small handle stat", async (context) => {
  const projectRoot = await createProject(context);
  const packagePath = path.join(projectRoot, "package.json");
  const maximumSize = 1024 * 1024;
  await fs.writeFile(packagePath, "{}\n");
  const growingHandle = createPartialReadHandle(
    Buffer.alloc(maximumSize + 1, "x"),
    [2, 3, maximumSize],
  );
  growingHandle.stat = () => fs.stat(packagePath);
  growingHandle.close = async () => { growingHandle.closed = true; };
  const originalOpen = fs.open.bind(fs);
  context.mock.method(fs, "open", async (target, ...args) => {
    if (path.resolve(target) === packagePath) return growingHandle;
    return originalOpen(target, ...args);
  });

  const result = await inspectProject(projectRoot);

  assert.equal(growingHandle.closed, true);
  assert.ok(!result.evidence.includes("package.json"));
  assert.ok(result.warnings.some((warning) => /package\.json.*too large/i.test(warning)));
  assert.ok(growingHandle.calls.every(({ offset, length }) => offset + length <= maximumSize + 1));
  assert.equal(growingHandle.calls.reduce((total, { bytesRead }) => total + bytesRead, 0), maximumSize + 1);
});

test("reads package.json only through a bounded no-follow file handle", async () => {
  const source = await fs.readFile(
    new URL("../packages/project-adapters/src/project-inspector.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /fs\.open\([^\n]+O_NOFOLLOW/);
  assert.match(source, /packageHandle\.stat\(/);
  assert.match(source, /\.read\(/);
  assert.match(source, /packageHandle\.close\(/);
  assert.doesNotMatch(source, /packageHandle\.readFile\(/);
  assert.doesNotMatch(source, /fs\.readFile\(path\.join\(projectRoot,\s*["']package\.json["']/);
});

test("bounded handle reads combine partial reads through EOF", async () => {
  const { readBoundedFileHandle } = await import("../packages/project-adapters/src/project-inspector.js");
  assert.equal(typeof readBoundedFileHandle, "function");
  const handle = createPartialReadHandle('{"dependencies":{"react":"latest"}}', [1, 2, 3, 5, 8]);

  const content = await readBoundedFileHandle(handle, 64);

  assert.deepEqual(JSON.parse(content.toString("utf8")), {
    dependencies: { react: "latest" },
  });
  assert.ok(handle.calls.length > 1);
  assert.equal(handle.calls.at(-1).position, null);
});

test("bounded handle reads reject growth beyond the limit without reading past max plus one", async () => {
  const { readBoundedFileHandle } = await import("../packages/project-adapters/src/project-inspector.js");
  assert.equal(typeof readBoundedFileHandle, "function");
  const maximumSize = 5;
  const handle = createPartialReadHandle("123456", [2, 1, 3]);

  await assert.rejects(
    readBoundedFileHandle(handle, maximumSize),
    /too large.*5 bytes/i,
  );

  assert.ok(handle.calls.every(({ offset, length }) => offset + length <= maximumSize + 1));
  assert.equal(Math.max(...handle.calls.map(({ offset, length }) => offset + length)), maximumSize + 1);
  assert.equal(handle.calls.reduce((total, { bytesRead }) => total + bytesRead, 0), maximumSize + 1);
});

test("inspectProject rejects a project root replaced by a symlink", async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-inspect-root-"));
  const projectRoot = path.join(temporaryRoot, "project");
  const movedRoot = path.join(temporaryRoot, "moved-project");
  const outsideRoot = path.join(temporaryRoot, "outside");
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  await fs.mkdir(projectRoot);
  await fs.mkdir(outsideRoot);
  await fs.rename(projectRoot, movedRoot);
  await fs.symlink(outsideRoot, projectRoot, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    inspectProject(projectRoot),
    /project root.*symbolic link/i,
  );
});

test("inspectProject rejects a root changed during inspection", async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-inspect-root-race-"));
  const projectRoot = path.join(temporaryRoot, "project");
  const movedRoot = path.join(temporaryRoot, "moved-project");
  const outsideRoot = path.join(temporaryRoot, "outside");
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  await fs.mkdir(projectRoot);
  await fs.mkdir(outsideRoot);
  const originalReaddir = fs.readdir.bind(fs);
  let replaced = false;
  context.mock.method(fs, "readdir", async (target, options) => {
    const children = await originalReaddir(target, options);
    if (!replaced && path.resolve(target) === projectRoot) {
      replaced = true;
      await fs.rename(projectRoot, movedRoot);
      await fs.symlink(outsideRoot, projectRoot, process.platform === "win32" ? "junction" : "dir");
    }
    return children;
  });

  await assert.rejects(
    inspectProject(projectRoot),
    /project root changed during inspection/i,
  );
});

test("inspectProject verifies the root identity before returning", async () => {
  const source = await fs.readFile(
    new URL("../packages/project-adapters/src/project-inspector.js", import.meta.url),
    "utf8",
  );

  assert.equal(source.match(/await readProjectRootIdentity\(projectRoot\)/g)?.length, 2);
  assert.match(source, /Project root changed during inspection/);
});

test("inspectProject skips source hashing", async (context) => {
  const projectRoot = await createProject(context);
  const sourceFile = path.join(projectRoot, "index.js");
  await fs.writeFile(sourceFile, "export default true;\n");
  const originalReadFile = fs.readFile.bind(fs);
  context.mock.method(fs, "readFile", async (target, ...args) => {
    if (path.resolve(target) === sourceFile) throw new Error("source content must not be read");
    return originalReadFile(target, ...args);
  });

  const result = await inspectProject(projectRoot);

  assert.deepEqual(result.languages, ["JavaScript"]);
  assert.ok(result.evidence.includes("index.js"));
});

test("inspectProject warns and continues after a nested scan failure", async (context) => {
  const projectRoot = await createProject(context);
  const nested = path.join(projectRoot, "nested");
  await fs.mkdir(nested);
  await fs.writeFile(path.join(projectRoot, "main.py"), "print('safe')\n");
  const originalReaddir = fs.readdir.bind(fs);
  context.mock.method(fs, "readdir", async (target, options) => {
    if (path.resolve(target) === nested) {
      const error = new Error("nested directory denied");
      error.code = "EACCES";
      throw error;
    }
    return originalReaddir(target, options);
  });

  const result = await inspectProject(projectRoot);

  assert.deepEqual(result.languages, ["Python"]);
  assert.ok(result.evidence.includes("main.py"));
  assert.ok(result.warnings.some((warning) => /nested.*nested directory denied/i.test(warning)));
});
