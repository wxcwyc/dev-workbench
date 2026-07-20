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
