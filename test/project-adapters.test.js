import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureFileTree, compareTrees } from "../packages/project-adapters/src/file-tree.js";
import { runConfirmedCommand } from "../packages/project-adapters/src/command-runner.js";
import { resolveInsideProject, resolveProjectRoot } from "../packages/project-adapters/src/project-boundary.js";

test("file snapshots expose added and modified files", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-tree-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "one.txt"), "before");
  const before = await captureFileTree(root);
  await fs.writeFile(path.join(root, "one.txt"), "after");
  await fs.writeFile(path.join(root, "two.js"), "export default 2;");
  const after = await captureFileTree(root);
  assert.deepEqual(compareTrees(before, after), [
    { path: "one.txt", status: "modified" },
    { path: "two.js", status: "added" }
  ]);
});

test("confirmed command runner uses argv without a shell and stays inside project", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-command-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = process.platform === "win32"
    ? [process.execPath, "-e", "process.stdout.write('safe')"]
    : ["printf", "%.4s", "safe;exit 99"];
  const result = await runConfirmedCommand(root, { command });
  assert.equal(result.stdout, "safe");
  assert.throws(() => resolveInsideProject(root, "../escape"), /escapes project root/);
  assert.equal(await resolveProjectRoot(root, os.tmpdir()), await fs.realpath(root));
});

test("command runner rejects shell syntax in the executable", async () => {
  await assert.rejects(
    runConfirmedCommand(os.tmpdir(), { command: ["node;rm", "anything"] }),
    /shell syntax/
  );
});

test("command runner rejects a cwd symlink that escapes the project", async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-cwd-boundary-"));
  const projectRoot = path.join(temporaryRoot, "project");
  const outsideRoot = path.join(temporaryRoot, "outside");
  const marker = path.join(outsideRoot, "executed.txt");
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  await fs.mkdir(projectRoot);
  await fs.mkdir(outsideRoot);
  await fs.symlink(outsideRoot, path.join(projectRoot, "link"), process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    runConfirmedCommand(projectRoot, {
      command: [process.execPath, "-e", "require('node:fs').writeFileSync('executed.txt', 'unsafe')"],
      cwd: "link",
    }),
    /project boundary/i,
  );
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
});

test("command runner rejects a canonical project root replaced by a symlink", async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-root-boundary-"));
  const projectRoot = path.join(temporaryRoot, "project");
  const movedRoot = path.join(temporaryRoot, "moved-project");
  const outsideRoot = path.join(temporaryRoot, "outside");
  const marker = path.join(outsideRoot, "executed.txt");
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  await fs.mkdir(projectRoot);
  await fs.mkdir(outsideRoot);
  const canonicalRoot = await fs.realpath(projectRoot);
  await fs.rename(projectRoot, movedRoot);
  await fs.symlink(outsideRoot, projectRoot, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    runConfirmedCommand(canonicalRoot, {
      command: [process.execPath, "-e", "require('node:fs').writeFileSync('executed.txt', 'unsafe')"],
    }),
    /project root.*symbolic link/i,
  );
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
});
