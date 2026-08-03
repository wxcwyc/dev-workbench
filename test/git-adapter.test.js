import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  GitWorkspaceError,
  captureGitState,
  createBaselineCheckpoint,
  createResultCheckpoint,
  disposeManagedWorkspace,
  inspectGitRepository,
  prepareManagedWorkspace,
  readCheckpointFileDiff,
  restoreCheckpoint,
  validateManagedWorkspace,
} from "../packages/project-adapters/src/git-adapter.js";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

async function makeRepository(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-git-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, "init", "--quiet");
  await git(root, "config", "user.name", "Dev Workbench Test");
  await git(root, "config", "user.email", "test@dev-workbench.invalid");
  await fs.mkdir(path.join(root, "app"));
  await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
  await fs.writeFile(path.join(root, "app", "keep.txt"), "before\n");
  await fs.writeFile(path.join(root, "app", "remove.txt"), "remove\n");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "initial");
  return root;
}

async function sourceFingerprint(root) {
  return {
    head: await git(root, "rev-parse", "HEAD"),
    index: await fs.readFile(path.join(root, ".git", "index")),
    status: await git(root, "status", "--porcelain=v2", "--untracked-files=all"),
    keep: await fs.readFile(path.join(root, "app", "keep.txt")),
  };
}

async function managedGitDir(worktreeRoot) {
  return git(worktreeRoot, "rev-parse", "--path-format=absolute", "--git-dir");
}

async function managedOwnerFile(worktreeRoot) {
  return path.join(await managedGitDir(worktreeRoot), "dev-workbench-owner.json");
}

function persistedWorkspace(workspace) {
  const { sessionId: _sessionId, ...persisted } = workspace;
  return persisted;
}

test("inspects clean nested projects with canonical full Git identity", async (context) => {
  const root = await makeRepository(context);
  const nested = path.join(root, "app");
  const expectedHead = await git(root, "rev-parse", "HEAD");
  const expectedCommonDir = await fs.realpath(path.join(root, ".git"));

  const inspection = await inspectGitRepository(nested);

  assert.deepEqual(inspection, {
    projectRoot: await fs.realpath(nested),
    repositoryRoot: await fs.realpath(root),
    projectRelativePath: "app",
    commonGitDir: expectedCommonDir,
    headOid: expectedHead,
    detached: false,
    dirty: [],
  });
  assert.match(inspection.headOid, /^[0-9a-f]{40}$/);

  await git(root, "checkout", "--quiet", "--detach");
  assert.equal((await inspectGitRepository(root)).detached, true);
});

test("inspection rejects non-Git and unborn repositories with typed diagnostics", async (context) => {
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-nongit-"));
  context.after(() => fs.rm(plain, { recursive: true, force: true }));
  await assert.rejects(
    inspectGitRepository(plain),
    (error) => error instanceof GitWorkspaceError && error.code === "not_git",
  );

  await git(plain, "init", "--quiet");
  await assert.rejects(
    inspectGitRepository(plain),
    (error) => error instanceof GitWorkspaceError && error.code === "unborn_head",
  );
});

test("keeps the full OID in SHA-256 repositories", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-sha256-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, "init", "--quiet", "--object-format=sha256");
  await git(root, "config", "user.name", "Dev Workbench Test");
  await git(root, "config", "user.email", "test@dev-workbench.invalid");
  await fs.writeFile(path.join(root, "file.txt"), "sha256\n");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "initial");

  const inspection = await inspectGitRepository(root);

  assert.match(inspection.headOid, /^[0-9a-f]{64}$/);
  assert.equal(inspection.headOid, await git(root, "rev-parse", "HEAD"));
});

test("inspection classifies dirty and in-progress state without mutating source", async (context) => {
  const cases = [
    {
      expected: "staged",
      mutate: async (root) => {
        await fs.writeFile(path.join(root, "app", "keep.txt"), "staged\n");
        await git(root, "add", "app/keep.txt");
      },
    },
    {
      expected: "unstaged",
      mutate: (root) => fs.writeFile(path.join(root, "app", "keep.txt"), "unstaged\n"),
    },
    {
      expected: "untracked",
      mutate: (root) => fs.writeFile(path.join(root, "app", "new.txt"), "new\n"),
    },
    {
      expected: "unmerged",
      mutate: async (root) => {
        const originalBranch = await git(root, "branch", "--show-current");
        await git(root, "checkout", "--quiet", "-b", "conflicting");
        await fs.writeFile(path.join(root, "app", "keep.txt"), "theirs\n");
        await git(root, "add", "app/keep.txt");
        await git(root, "commit", "--quiet", "-m", "theirs");
        await git(root, "checkout", "--quiet", originalBranch);
        await fs.writeFile(path.join(root, "app", "keep.txt"), "ours\n");
        await git(root, "add", "app/keep.txt");
        await git(root, "commit", "--quiet", "-m", "ours");
        await assert.rejects(git(root, "merge", "conflicting"));
      },
    },
    {
      expected: "in_progress",
      mutate: async (root) => {
        await fs.writeFile(path.join(root, ".git", "MERGE_HEAD"), await git(root, "rev-parse", "HEAD"));
      },
    },
  ];

  for (const entry of cases) {
    await test(`classifies ${entry.expected}`, async (innerContext) => {
      const root = await makeRepository(innerContext);
      await entry.mutate(root);
      const before = await sourceFingerprint(root);

      const inspection = await inspectGitRepository(root);

      assert.ok(inspection.dirty.some((item) => item.kind === entry.expected), inspection.dirty);
      assert.deepEqual(await sourceFingerprint(root), before);
    });
  }
});

test("preparation rejects dirty source and leaves its Git and files unchanged", async (context) => {
  const root = await makeRepository(context);
  await fs.writeFile(path.join(root, "app", "keep.txt"), "dirty\n");
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  context.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  const before = await sourceFingerprint(root);

  await assert.rejects(
    prepareManagedWorkspace({
      projectRoot: path.join(root, "app"),
      workspaceRoot: managedRoot,
      sessionId: "session-1",
      ownershipToken: "owner-1",
    }),
    (error) => error instanceof GitWorkspaceError
      && error.code === "source_dirty"
      && error.diagnostics.some((item) => item.kind === "unstaged"),
  );
  assert.deepEqual(await sourceFingerprint(root), before);
  assert.deepEqual(await fs.readdir(managedRoot), []);
});

test("inspection classifies dirty submodules", async (context) => {
  const root = await makeRepository(context);
  const submodule = await makeRepository(context);
  await git(root, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", submodule, "vendor/sub");
  await git(root, "commit", "--quiet", "-am", "add submodule");
  await fs.writeFile(path.join(root, "vendor", "sub", "app", "keep.txt"), "dirty submodule\n");

  const inspection = await inspectGitRepository(root);

  assert.ok(inspection.dirty.some((item) => item.kind === "submodule" && item.path === "vendor/sub"));
});

test("prepares a detached owned worktree outside the source repository", async (context) => {
  const root = await makeRepository(context);
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  context.after(() => fs.rm(managedRoot, { recursive: true, force: true }));

  const workspace = await prepareManagedWorkspace({
    projectRoot: path.join(root, "app"),
    workspaceRoot: managedRoot,
    sessionId: "session-1",
    ownershipToken: "owner-1",
  });

  assert.equal(workspace.repositoryRoot, await fs.realpath(root));
  assert.equal(workspace.projectRelativePath, "app");
  assert.equal(workspace.worktreeRoot, path.join(await fs.realpath(managedRoot), "session-1"));
  assert.equal(workspace.executionRoot, path.join(workspace.worktreeRoot, "app"));
  assert.equal(workspace.baseOid, await git(root, "rev-parse", "HEAD"));
  await assert.rejects(git(workspace.worktreeRoot, "symbolic-ref", "-q", "HEAD"));
  assert.equal(await fs.readFile(path.join(workspace.executionRoot, "keep.txt"), "utf8"), "before\n");
  assert.deepEqual(await captureGitState(root), {
    available: true,
    head: workspace.baseOid.slice(0, 7),
    status: "",
    diff: "",
  });
});

test("validates only the exact owned workspace for the owning session", async (context) => {
  const root = await makeRepository(context);
  const otherRoot = await makeRepository(context);
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  context.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  const workspace = await prepareManagedWorkspace({
    projectRoot: path.join(root, "app"),
    workspaceRoot: managedRoot,
    sessionId: "session-1",
    ownershipToken: "owner-1",
  });
  const persisted = persistedWorkspace(workspace);

  assert.deepEqual(
    await validateManagedWorkspace(persisted, { sessionId: "session-1" }),
    persisted,
  );
  await assert.rejects(
    validateManagedWorkspace(persisted, { sessionId: "session-2" }),
    (error) => error instanceof GitWorkspaceError && error.code === "ownership_mismatch",
  );
  await assert.rejects(
    validateManagedWorkspace({ ...persisted, ownershipToken: "owner-2" }, { sessionId: "session-1" }),
    (error) => error instanceof GitWorkspaceError && error.code === "ownership_mismatch",
  );

  const externalExecutionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-external-"));
  context.after(() => fs.rm(externalExecutionRoot, { recursive: true, force: true }));
  await fs.rm(workspace.executionRoot, { recursive: true });
  await fs.symlink(externalExecutionRoot, workspace.executionRoot, "dir");
  await assert.rejects(
    validateManagedWorkspace(persisted, { sessionId: "session-1" }),
    (error) => error instanceof GitWorkspaceError && error.code === "ownership_mismatch",
  );
  await fs.rm(workspace.executionRoot);
  await git(workspace.worktreeRoot, "checkout", "--quiet", "--", workspace.projectRelativePath);

  const tamperedWorkspace = {
    ...persisted,
    repositoryRoot: await fs.realpath(otherRoot),
    commonGitDir: await fs.realpath(path.join(otherRoot, ".git")),
  };
  const tamperedOwner = {
    ...tamperedWorkspace,
    sessionId: "session-1",
  };
  await fs.writeFile(
    await managedOwnerFile(workspace.worktreeRoot),
    `${JSON.stringify(tamperedOwner)}\n`,
  );
  await assert.rejects(
    validateManagedWorkspace(tamperedWorkspace, { sessionId: "session-1" }),
    (error) => error instanceof GitWorkspaceError && error.code === "ownership_mismatch",
  );

  await git(root, "worktree", "remove", workspace.worktreeRoot);
  await assert.rejects(
    validateManagedWorkspace(workspace, { sessionId: "session-1" }),
    (error) => error instanceof GitWorkspaceError && error.code === "ownership_mismatch",
  );
});

test("disposes only clean owned managed workspaces", async (context) => {
  const root = await makeRepository(context);
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  context.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  const workspace = await prepareManagedWorkspace({
    projectRoot: path.join(root, "app"),
    workspaceRoot: managedRoot,
    sessionId: "session-1",
    ownershipToken: "owner-1",
  });
  const persisted = persistedWorkspace(workspace);

  assert.deepEqual(
    await disposeManagedWorkspace(persisted, { sessionId: "session-1" }),
    { removed: true, worktreeRoot: workspace.worktreeRoot },
  );
  await assert.rejects(
    fs.access(workspace.worktreeRoot),
    (error) => error.code === "ENOENT",
  );
  assert.doesNotMatch(await git(root, "worktree", "list", "--porcelain"), new RegExp(workspace.worktreeRoot));
  assert.deepEqual(await captureGitState(root), {
    available: true,
    head: workspace.baseOid.slice(0, 7),
    status: "",
    diff: "",
  });
});

test("disposal rejects dirty, tampered, and missing managed workspaces without deleting them", async (context) => {
  const root = await makeRepository(context);
  const otherRoot = await makeRepository(context);
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  context.after(() => fs.rm(managedRoot, { recursive: true, force: true }));

  const dirtyWorkspace = await prepareManagedWorkspace({
    projectRoot: path.join(root, "app"),
    workspaceRoot: managedRoot,
    sessionId: "session-dirty",
    ownershipToken: "owner-dirty",
  });
  await fs.writeFile(path.join(dirtyWorkspace.executionRoot, "keep.txt"), "dirty\n");
  await assert.rejects(
    disposeManagedWorkspace(persistedWorkspace(dirtyWorkspace), { sessionId: "session-dirty" }),
    (error) => error instanceof GitWorkspaceError && error.code === "workspace_dirty",
  );
  assert.match(await git(root, "worktree", "list", "--porcelain"), new RegExp(dirtyWorkspace.worktreeRoot));

  const tamperedWorkspace = await prepareManagedWorkspace({
    projectRoot: path.join(root, "app"),
    workspaceRoot: managedRoot,
    sessionId: "session-tampered",
    ownershipToken: "owner-tampered",
  });
  await assert.rejects(
    disposeManagedWorkspace(persistedWorkspace(tamperedWorkspace), { sessionId: "session-foreign" }),
    (error) => error instanceof GitWorkspaceError && error.code === "ownership_mismatch",
  );
  await fs.access(tamperedWorkspace.worktreeRoot);
  const tamperedOwner = {
    ...persistedWorkspace(tamperedWorkspace),
    sessionId: "session-tampered",
    repositoryRoot: await fs.realpath(otherRoot),
    commonGitDir: await fs.realpath(path.join(otherRoot, ".git")),
  };
  await fs.writeFile(
    await managedOwnerFile(tamperedWorkspace.worktreeRoot),
    `${JSON.stringify(tamperedOwner)}\n`,
  );
  await assert.rejects(
    disposeManagedWorkspace(persistedWorkspace(tamperedOwner), { sessionId: "session-tampered" }),
    (error) => error instanceof GitWorkspaceError && error.code === "ownership_mismatch",
  );
  await fs.access(tamperedWorkspace.worktreeRoot);

  const missingWorkspace = await prepareManagedWorkspace({
    projectRoot: path.join(root, "app"),
    workspaceRoot: managedRoot,
    sessionId: "session-missing",
    ownershipToken: "owner-missing",
  });
  await git(root, "worktree", "remove", missingWorkspace.worktreeRoot);
  await assert.rejects(
    disposeManagedWorkspace(persistedWorkspace(missingWorkspace), { sessionId: "session-missing" }),
    (error) => error instanceof GitWorkspaceError && error.code === "ownership_mismatch",
  );
});

test("preparation rejects containment, path collisions, and unsafe identities", async (context) => {
  const root = await makeRepository(context);
  await assert.rejects(
    prepareManagedWorkspace({
      projectRoot: root,
      workspaceRoot: path.join(root, "managed"),
      sessionId: "session-1",
      ownershipToken: "owner-1",
    }),
    (error) => error.code === "workspace_overlap",
  );

  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  context.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(managedRoot, "session-1"));
  await assert.rejects(
    prepareManagedWorkspace({
      projectRoot: root,
      workspaceRoot: managedRoot,
      sessionId: "session-1",
      ownershipToken: "owner-1",
    }),
    (error) => error.code === "workspace_collision",
  );
  await assert.rejects(
    prepareManagedWorkspace({
      projectRoot: root,
      workspaceRoot: managedRoot,
      sessionId: "../escape",
      ownershipToken: "owner-1",
    }),
    (error) => error.code === "invalid_identity",
  );
});

test("preparation rejects a workspace symlink that canonically overlaps the source", async (context) => {
  const root = await makeRepository(context);
  const managedTarget = path.join(root, ".git", "managed-root");
  const linkParent = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-link-"));
  const workspaceLink = path.join(linkParent, "workspaces");
  context.after(() => fs.rm(linkParent, { recursive: true, force: true }));
  await fs.mkdir(managedTarget);
  await fs.symlink(managedTarget, workspaceLink, "dir");
  const before = await sourceFingerprint(root);

  await assert.rejects(
    prepareManagedWorkspace({
      projectRoot: root,
      workspaceRoot: workspaceLink,
      sessionId: "session-1",
      ownershipToken: "owner-1",
    }),
    (error) => error.code === "workspace_overlap",
  );
  assert.deepEqual(await sourceFingerprint(root), before);
  assert.deepEqual(await fs.readdir(managedTarget), []);
});

test("creates immutable baseline and exact result checkpoints then normalizes the owned worktree", async (context) => {
  const root = await makeRepository(context);
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  context.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  const workspace = await prepareManagedWorkspace({
    projectRoot: path.join(root, "app"),
    workspaceRoot: managedRoot,
    sessionId: "session-1",
    ownershipToken: "owner-1",
  });
  const baseline = await createBaselineCheckpoint(workspace, {
    sessionId: "session-1",
    attemptId: "attempt-1",
  });
  assert.deepEqual(baseline, {
    oid: workspace.baseOid,
    ref: "refs/dev-workbench/checkpoints/session-1/attempt-1/baseline",
  });

  await fs.writeFile(path.join(workspace.executionRoot, "keep.txt"), "after\n");
  await fs.rename(
    path.join(workspace.executionRoot, "remove.txt"),
    path.join(workspace.executionRoot, "renamed.txt"),
  );
  await fs.writeFile(path.join(workspace.executionRoot, "new.txt"), "new\n");
  await fs.writeFile(path.join(workspace.worktreeRoot, "binary.bin"), Buffer.from([0, 1, 2, 255]));
  await fs.writeFile(path.join(workspace.worktreeRoot, "ignored.txt"), "ignored\n");

  const result = await createResultCheckpoint(workspace, {
    sessionId: "session-1",
    attemptId: "attempt-1",
    baseline,
  });

  assert.equal(result.ref, "refs/dev-workbench/checkpoints/session-1/attempt-1/result");
  assert.match(result.oid, /^[0-9a-f]{40}$/);
  assert.equal(await git(root, "rev-parse", result.ref), result.oid);
  assert.equal(await git(workspace.worktreeRoot, "rev-parse", "HEAD"), result.oid);
  assert.equal(await git(workspace.worktreeRoot, "status", "--porcelain"), "");
  assert.equal(await git(root, "cat-file", "-e", `${result.oid}:app/new.txt`), "");
  assert.equal(await git(root, "cat-file", "-e", `${result.oid}:binary.bin`), "");
  await assert.rejects(git(root, "cat-file", "-e", `${result.oid}:ignored.txt`));
  assert.deepEqual(result.files, [
    {
      path: "app/keep.txt",
      oldPath: null,
      status: "modified",
      binary: false,
      additions: 1,
      deletions: 1,
    },
    {
      path: "app/renamed.txt",
      oldPath: "app/remove.txt",
      status: "renamed",
      binary: false,
      additions: 0,
      deletions: 0,
    },
    {
      path: "app/new.txt",
      oldPath: null,
      status: "added",
      binary: false,
      additions: 1,
      deletions: 0,
    },
    {
      path: "binary.bin",
      oldPath: null,
      status: "added",
      binary: true,
      additions: null,
      deletions: null,
    },
  ].sort((left, right) => left.path.localeCompare(right.path)));
  assert.deepEqual(result.files, [...result.files].sort((left, right) => left.path.localeCompare(right.path)));
  await assert.rejects(
    fs.readFile(path.join(workspace.worktreeRoot, "ignored.txt"), "utf8"),
    (error) => error.code === "ENOENT",
  );
  assert.deepEqual(await captureGitState(root), {
    available: true,
    head: workspace.baseOid.slice(0, 7),
    status: "",
    diff: "",
  });
});

test("reads structured text diffs for every checkpoint manifest status", async (context) => {
  const root = await makeRepository(context);
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  context.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "app", "copy-source.txt"), "copy source\n");
  await fs.writeFile(path.join(root, "app", "empty.txt"), "not empty\n");
  await fs.writeFile(path.join(root, "app", "type.txt"), "regular\n");
  await git(root, "add", ".");
  await git(root, "commit", "--quiet", "-m", "diff fixture");
  const workspace = await prepareManagedWorkspace({
    projectRoot: root,
    workspaceRoot: managedRoot,
    sessionId: "session-diff",
    ownershipToken: "owner-diff",
  });
  const baseline = await createBaselineCheckpoint(workspace, {
    sessionId: "session-diff",
    attemptId: "attempt-1",
  });
  await fs.writeFile(path.join(workspace.worktreeRoot, "app", "keep.txt"), "after 世界\n");
  await fs.rm(path.join(workspace.worktreeRoot, "app", "remove.txt"));
  await fs.rename(
    path.join(workspace.worktreeRoot, "app", "copy-source.txt"),
    path.join(workspace.worktreeRoot, "app", "renamed.txt"),
  );
  await fs.copyFile(
    path.join(workspace.worktreeRoot, "app", "renamed.txt"),
    path.join(workspace.worktreeRoot, "app", "copied.txt"),
  );
  await fs.writeFile(path.join(workspace.worktreeRoot, "app", "added.txt"), "added\n");
  await fs.writeFile(path.join(workspace.worktreeRoot, "app", "empty.txt"), "");
  await fs.rm(path.join(workspace.worktreeRoot, "app", "type.txt"));
  await fs.symlink("keep.txt", path.join(workspace.worktreeRoot, "app", "type.txt"));
  const result = await createResultCheckpoint(workspace, {
    sessionId: "session-diff",
    attemptId: "attempt-1",
    baseline,
  });
  assert.deepEqual(
    [...new Set(result.files.map((file) => file.status))].sort(),
    ["added", "copied", "deleted", "modified", "renamed", "type-changed"],
  );

  for (const file of result.files) {
    const diff = await readCheckpointFileDiff(workspace, {
      sessionId: "session-diff",
      attemptId: "attempt-1",
      baseline,
      result,
      file,
    });
    assert.equal(diff.status, file.status);
    assert.equal(diff.oldPath, file.oldPath ?? (file.status === "added" ? null : file.path));
    assert.equal(diff.newPath, file.status === "deleted" ? null : file.path);
    assert.equal(diff.binary, false);
    assert.equal(diff.truncated, false);
    assert.ok(Array.isArray(diff.hunks));
  }
  const modified = await readCheckpointFileDiff(workspace, {
    sessionId: "session-diff",
    attemptId: "attempt-1",
    baseline,
    result,
    file: result.files.find((file) => file.path === "app/keep.txt"),
  });
  assert.equal(modified.old.text, "before\n");
  assert.equal(modified.new.text, "after 世界\n");
  assert.deepEqual(
    modified.hunks[0].lines.map(({ type, text }) => ({ type, text })),
    [
      { type: "deletion", text: "before" },
      { type: "addition", text: "after 世界" },
    ],
  );
  const typeChanged = await readCheckpointFileDiff(workspace, {
    sessionId: "session-diff",
    attemptId: "attempt-1",
    baseline,
    result,
    file: result.files.find((file) => file.path === "app/type.txt"),
  });
  assert.equal(typeChanged.status, "type-changed");
  assert.equal(typeChanged.hunks.length, 2);
  assert.deepEqual(
    typeChanged.hunks.flatMap((hunk) => hunk.lines).map(({ type, text }) => ({ type, text })),
    [
      { type: "deletion", text: "regular" },
      { type: "addition", text: "keep.txt" },
    ],
  );
});

test("bounds oversized text and hunks while classifying binary and malformed UTF-8", async (context) => {
  const root = await makeRepository(context);
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  context.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  const workspace = await prepareManagedWorkspace({
    projectRoot: root,
    workspaceRoot: managedRoot,
    sessionId: "session-limits",
    ownershipToken: "owner-limits",
  });
  const baseline = await createBaselineCheckpoint(workspace, {
    sessionId: "session-limits",
    attemptId: "attempt-1",
  });
  const manyLines = Array.from({ length: 2500 }, (_, index) => `line-${index}-changed`).join("\n");
  await fs.writeFile(path.join(workspace.worktreeRoot, "app", "keep.txt"), `${manyLines}\n`);
  await fs.writeFile(path.join(workspace.worktreeRoot, "large.txt"), "x".repeat(96 * 1024));
  await fs.writeFile(path.join(workspace.worktreeRoot, "binary.bin"), Buffer.from([0, 1, 2, 255]));
  await fs.writeFile(path.join(workspace.worktreeRoot, "invalid.txt"), Buffer.from([0xc3, 0x28]));
  const result = await createResultCheckpoint(workspace, {
    sessionId: "session-limits",
    attemptId: "attempt-1",
    baseline,
  });
  const read = (filePath) => readCheckpointFileDiff(workspace, {
    sessionId: "session-limits",
    attemptId: "attempt-1",
    baseline,
    result,
    file: result.files.find((file) => file.path === filePath),
  });

  const large = await read("large.txt");
  assert.equal(large.new.truncated, true);
  assert.ok(Buffer.byteLength(large.new.text) <= 64 * 1024);
  assert.equal(large.truncated, true);
  const lineLimited = await read("app/keep.txt");
  assert.equal(lineLimited.hunksTruncated, true);
  assert.ok(lineLimited.hunks.flatMap((hunk) => hunk.lines).length <= 2000);
  for (const filePath of ["binary.bin", "invalid.txt"]) {
    const binary = await read(filePath);
    assert.equal(binary.binary, true);
    assert.equal(binary.new.text, null);
    assert.deepEqual(binary.hunks, []);
  }
});

test("rejects every manifest status whose required checkpoint side is missing", async (context) => {
  const root = await makeRepository(context);
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  context.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  const workspace = await prepareManagedWorkspace({
    projectRoot: root,
    workspaceRoot: managedRoot,
    sessionId: "session-missing-side",
    ownershipToken: "owner-missing-side",
  });
  const baseline = await createBaselineCheckpoint(workspace, {
    sessionId: "session-missing-side",
    attemptId: "attempt-1",
  });
  await fs.writeFile(path.join(workspace.worktreeRoot, "app", "keep.txt"), "result\n");
  await fs.rm(path.join(workspace.worktreeRoot, "app", "remove.txt"));
  await fs.writeFile(path.join(workspace.worktreeRoot, "app", "added.txt"), "added\n");
  const result = await createResultCheckpoint(workspace, {
    sessionId: "session-missing-side",
    attemptId: "attempt-1",
    baseline,
  });
  const invalidFiles = [
    { path: "app/added.txt", oldPath: null, status: "modified", binary: false },
    { path: "app/remove.txt", oldPath: null, status: "modified", binary: false },
    { path: "app/missing.txt", oldPath: null, status: "added", binary: false },
    { path: "app/missing.txt", oldPath: null, status: "deleted", binary: false },
    { path: "app/keep.txt", oldPath: "app/missing.txt", status: "renamed", binary: false },
    { path: "app/keep.txt", oldPath: "app/missing.txt", status: "copied", binary: false },
    { path: "app/missing.txt", oldPath: null, status: "type-changed", binary: false },
  ];

  for (const file of invalidFiles) {
    await assert.rejects(
      readCheckpointFileDiff(workspace, {
        sessionId: "session-missing-side",
        attemptId: "attempt-1",
        baseline,
        result,
        file,
      }),
      (error) => error instanceof GitWorkspaceError && error.code === "manifest_mismatch",
      `${file.status}:${file.oldPath ?? ""}->${file.path}`,
    );
  }
});

test("diff reads reject a foreign repository even when it contains matching checkpoint refs", async (context) => {
  const root = await makeRepository(context);
  const foreignRoot = await makeRepository(context);
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  context.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  const workspace = await prepareManagedWorkspace({
    projectRoot: root,
    workspaceRoot: managedRoot,
    sessionId: "session-owned-diff",
    ownershipToken: "owner-owned-diff",
  });
  const baseline = await createBaselineCheckpoint(workspace, {
    sessionId: "session-owned-diff",
    attemptId: "attempt-1",
  });
  await fs.writeFile(path.join(workspace.worktreeRoot, "app", "keep.txt"), "result\n");
  const result = await createResultCheckpoint(workspace, {
    sessionId: "session-owned-diff",
    attemptId: "attempt-1",
    baseline,
  });
  await git(foreignRoot, "fetch", "--quiet", root, baseline.oid, result.oid);
  await git(foreignRoot, "update-ref", baseline.ref, baseline.oid);
  await git(foreignRoot, "update-ref", result.ref, result.oid);

  await assert.rejects(
    readCheckpointFileDiff(
      { ...workspace, repositoryRoot: await fs.realpath(foreignRoot) },
      {
        sessionId: "session-owned-diff",
        attemptId: "attempt-1",
        baseline,
        result,
        file: result.files.find((file) => file.path === "app/keep.txt"),
      },
    ),
    (error) => error instanceof GitWorkspaceError && error.code === "ownership_mismatch",
  );
});

test("checkpoint mutations reject ref collisions and ownership mismatch", async (context) => {
  const root = await makeRepository(context);
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  context.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  const workspace = await prepareManagedWorkspace({
    projectRoot: root,
    workspaceRoot: managedRoot,
    sessionId: "session-1",
    ownershipToken: "owner-1",
  });
  const baseline = await createBaselineCheckpoint(workspace, {
    sessionId: "session-1",
    attemptId: "attempt-1",
  });
  await assert.rejects(
    createBaselineCheckpoint(workspace, { sessionId: "session-1", attemptId: "attempt-1" }),
    (error) => error.code === "ref_collision",
  );
  await assert.rejects(
    createResultCheckpoint(
      { ...workspace, ownershipToken: "other-owner" },
      { sessionId: "session-1", attemptId: "attempt-1", baseline },
    ),
    (error) => error.code === "ownership_mismatch",
  );
  await createResultCheckpoint(workspace, {
    sessionId: "session-1",
    attemptId: "attempt-1",
    baseline,
  });
  await assert.rejects(
    createResultCheckpoint(workspace, {
      sessionId: "session-1",
      attemptId: "attempt-1",
      baseline,
    }),
    (error) => error.code === "ref_collision",
  );
});

test("restore validates accepted identity and materializes only a clean owned worktree", async (context) => {
  const root = await makeRepository(context);
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  context.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  const workspace = await prepareManagedWorkspace({
    projectRoot: path.join(root, "app"),
    workspaceRoot: managedRoot,
    sessionId: "session-1",
    ownershipToken: "owner-1",
  });
  const baseline = await createBaselineCheckpoint(workspace, {
    sessionId: "session-1",
    attemptId: "attempt-1",
  });
  await fs.writeFile(path.join(workspace.executionRoot, "keep.txt"), "result\n");
  const result = await createResultCheckpoint(workspace, {
    sessionId: "session-1",
    attemptId: "attempt-1",
    baseline,
  });
  await fs.writeFile(path.join(workspace.worktreeRoot, "ignored.txt"), "ignored residue\n");
  await restoreCheckpoint(workspace, { ...baseline, accepted: true });
  assert.equal(await fs.readFile(path.join(workspace.executionRoot, "keep.txt"), "utf8"), "before\n");
  await assert.rejects(
    fs.readFile(path.join(workspace.worktreeRoot, "ignored.txt"), "utf8"),
    (error) => error.code === "ENOENT",
  );

  const foreignRoleRef = "refs/dev-workbench/checkpoints/session-1/attempt-1/foreign";
  await git(root, "update-ref", foreignRoleRef, result.oid);
  await assert.rejects(
    restoreCheckpoint(workspace, { ...result, ref: foreignRoleRef, accepted: true }),
    (error) => error.code === "checkpoint_mismatch",
  );
  await assert.rejects(
    restoreCheckpoint(workspace, { ...result, accepted: false }),
    (error) => error.code === "checkpoint_not_accepted",
  );
  await assert.rejects(
    restoreCheckpoint(workspace, { ...result, oid: "f".repeat(40), accepted: true }),
    (error) => error.code === "checkpoint_mismatch",
  );
  await assert.rejects(
    restoreCheckpoint({ ...workspace, worktreeRoot: root }, { ...result, accepted: true }),
    (error) => error.code === "ownership_mismatch",
  );
  await fs.writeFile(path.join(workspace.executionRoot, "keep.txt"), "dirty\n");
  await assert.rejects(
    restoreCheckpoint(workspace, { ...result, accepted: true }),
    (error) => error.code === "workspace_dirty",
  );
});

test("baseline and restore reject managed Git operations in progress", async (context) => {
  const root = await makeRepository(context);
  const managedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-managed-"));
  context.after(() => fs.rm(managedRoot, { recursive: true, force: true }));
  const workspace = await prepareManagedWorkspace({
    projectRoot: root,
    workspaceRoot: managedRoot,
    sessionId: "session-1",
    ownershipToken: "owner-1",
  });
  const gitDir = await git(workspace.worktreeRoot, "rev-parse", "--path-format=absolute", "--git-dir");
  const operations = [
    ["MERGE_HEAD", "merge", "file"],
    ["CHERRY_PICK_HEAD", "cherry-pick", "file"],
    ["REVERT_HEAD", "revert", "file"],
    ["rebase-merge", "rebase", "directory"],
    ["BISECT_LOG", "bisect", "file"],
    ["sequencer", "sequencer", "directory"],
  ];
  for (const [entry, operation, type] of operations) {
    const marker = path.join(gitDir, entry);
    if (type === "directory") await fs.mkdir(marker);
    else await fs.writeFile(marker, workspace.baseOid);
    await assert.rejects(
      createBaselineCheckpoint(workspace, {
        sessionId: "session-1",
        attemptId: `attempt-${operation}`,
      }),
      (error) => error.code === "workspace_dirty"
        && error.diagnostics.some((item) => item.kind === "in_progress" && item.operation === operation),
    );
    await fs.rm(marker, { recursive: true });
  }

  const baseline = await createBaselineCheckpoint(workspace, {
    sessionId: "session-1",
    attemptId: "attempt-1",
  });
  await fs.mkdir(path.join(gitDir, "rebase-merge"));
  await assert.rejects(
    restoreCheckpoint(workspace, { ...baseline, accepted: true }),
    (error) => error.code === "workspace_dirty"
      && error.diagnostics.some((item) => item.kind === "in_progress" && item.operation === "rebase"),
  );
});
