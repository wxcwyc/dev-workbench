import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const CHECKPOINT_PREFIX = "refs/dev-workbench/checkpoints";
const IDENTITY_PATTERN = /^(?!\.)(?!.*\.\.)(?!.*\.$)[A-Za-z0-9._-]+$/;
const MAX_DIFF_TEXT_BYTES = 64 * 1024;
const MAX_DIFF_LINES = 2000;
const MAX_DIFF_HUNKS = 200;
const MAX_PATCH_BYTES = 512 * 1024;

export class GitWorkspaceError extends Error {
  constructor(code, message, diagnostics = []) {
    super(message);
    this.name = "GitWorkspaceError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

async function runGit(cwd, args, options = {}) {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT,
      ...options,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
    return options.trim === false ? result.stdout : result.stdout.trim();
  } catch (error) {
    if (options.allowNotRepository && /not a git repository/i.test(error.stderr ?? "")) {
      return null;
    }
    throw error;
  }
}

function isSameOrInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertIdentity(value, label) {
  if (typeof value !== "string" || !IDENTITY_PATTERN.test(value)) {
    throw new GitWorkspaceError("invalid_identity", `${label} is not a safe Git ref segment`);
  }
}

function checkpointRef(sessionId, attemptId, role) {
  assertIdentity(sessionId, "sessionId");
  assertIdentity(attemptId, "attemptId");
  return `${CHECKPOINT_PREFIX}/${sessionId}/${attemptId}/${role}`;
}

function parseDirtyStatus(output) {
  const records = output.split("\0").filter(Boolean);
  const diagnostics = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith("? ")) {
      diagnostics.push({ kind: "untracked", path: record.slice(2) });
      continue;
    }
    if (record.startsWith("u ")) {
      diagnostics.push({ kind: "unmerged", path: record.split(" ").slice(10).join(" ") });
      continue;
    }
    if (!record.startsWith("1 ") && !record.startsWith("2 ")) continue;
    const fields = record.split(" ");
    const xy = fields[1];
    const submodule = fields[2];
    const pathStart = record.startsWith("2 ") ? 9 : 8;
    const filePath = fields.slice(pathStart).join(" ");
    if (xy[0] !== ".") diagnostics.push({ kind: "staged", path: filePath });
    if (xy[1] !== ".") diagnostics.push({ kind: "unstaged", path: filePath });
    if (submodule !== "N...") diagnostics.push({ kind: "submodule", path: filePath });
    if (record.startsWith("2 ")) index += 1;
  }
  return diagnostics;
}

async function findInProgressState(commonGitDir, gitDir) {
  const checks = [
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["REBASE_HEAD", "rebase"],
    ["rebase-apply", "rebase"],
    ["rebase-merge", "rebase"],
    ["BISECT_LOG", "bisect"],
    ["sequencer", "sequencer"],
  ];
  const roots = [...new Set([gitDir, commonGitDir])];
  const diagnostics = [];
  for (const [entry, operation] of checks) {
    for (const root of roots) {
      try {
        await fs.access(path.join(root, entry));
        diagnostics.push({ kind: "in_progress", operation });
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return diagnostics;
}

export async function inspectGitRepository(projectRoot) {
  const canonicalProjectRoot = await fs.realpath(projectRoot);
  const repositoryRootOutput = await runGit(
    canonicalProjectRoot,
    ["rev-parse", "--show-toplevel"],
    { allowNotRepository: true },
  );
  if (repositoryRootOutput === null) {
    throw new GitWorkspaceError("not_git", "Project root is not inside a Git repository");
  }
  const repositoryRoot = await fs.realpath(repositoryRootOutput);
  if (!isSameOrInside(repositoryRoot, canonicalProjectRoot)) {
    throw new GitWorkspaceError("invalid_project_root", "Project root is outside the discovered repository");
  }

  let headOid;
  try {
    headOid = await runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  } catch (error) {
    if (/unknown revision|needed a single revision|ambiguous argument/i.test(error.stderr ?? "")) {
      throw new GitWorkspaceError("unborn_head", "Repository does not have a committed HEAD");
    }
    throw error;
  }

  const [commonGitDirOutput, gitDirOutput, symbolicHead, status] = await Promise.all([
    runGit(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    runGit(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-dir"]),
    runGit(repositoryRoot, ["symbolic-ref", "-q", "HEAD"]).catch((error) => {
      if (error.code === 1) return "";
      throw error;
    }),
    runGit(repositoryRoot, [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ], { trim: false }),
  ]);
  const commonGitDir = await fs.realpath(commonGitDirOutput);
  const gitDir = await fs.realpath(gitDirOutput);
  const dirty = [
    ...parseDirtyStatus(status),
    ...await findInProgressState(commonGitDir, gitDir),
  ];

  return {
    projectRoot: canonicalProjectRoot,
    repositoryRoot,
    projectRelativePath: path.relative(repositoryRoot, canonicalProjectRoot) || ".",
    commonGitDir,
    headOid,
    detached: symbolicHead === "",
    dirty,
  };
}

function ownerFile(gitDir) {
  return path.join(gitDir, "dev-workbench-owner.json");
}

async function readOwnership(worktreeRoot) {
  let gitDir;
  try {
    gitDir = await fs.realpath(await runGit(worktreeRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    ]));
  } catch (error) {
    throw new GitWorkspaceError("ownership_mismatch", "Managed worktree Git metadata is unavailable", [
      { kind: "ownership", detail: error.message },
    ]);
  }
  try {
    return JSON.parse(await fs.readFile(ownerFile(gitDir), "utf8"));
  } catch (error) {
    throw new GitWorkspaceError("ownership_mismatch", "Managed worktree ownership metadata is unavailable", [
      { kind: "ownership", detail: error.message },
    ]);
  }
}

async function assertOwnedWorkspace(workspace, { sessionId } = {}) {
  if (!workspace || typeof workspace !== "object") {
    throw new GitWorkspaceError("ownership_mismatch", "Managed workspace identity is required");
  }
  const expectedSessionId = sessionId ?? workspace.sessionId;
  if (typeof expectedSessionId !== "string" || expectedSessionId.length === 0) {
    throw new GitWorkspaceError("ownership_mismatch", "Managed workspace session identity is required");
  }
  const canonicalWorktreeRoot = await fs.realpath(workspace.worktreeRoot).catch(() => null);
  if (canonicalWorktreeRoot !== workspace.worktreeRoot) {
    throw new GitWorkspaceError("ownership_mismatch", "Managed worktree path does not match");
  }
  const owner = await readOwnership(canonicalWorktreeRoot);
  const expected = {
    sessionId: expectedSessionId,
    ownershipToken: workspace.ownershipToken,
    projectRoot: workspace.projectRoot,
    repositoryRoot: workspace.repositoryRoot,
    projectRelativePath: workspace.projectRelativePath,
    commonGitDir: workspace.commonGitDir,
    worktreeRoot: workspace.worktreeRoot,
    executionRoot: workspace.executionRoot,
    baseOid: workspace.baseOid,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (owner[key] !== value) {
      throw new GitWorkspaceError("ownership_mismatch", `Managed worktree ${key} does not match`);
    }
  }
  for (const key of [
    "projectRoot",
    "repositoryRoot",
    "commonGitDir",
    "worktreeRoot",
    "executionRoot",
  ]) {
    const canonicalPath = await fs.realpath(workspace[key]).catch(() => null);
    if (canonicalPath !== workspace[key]) {
      throw new GitWorkspaceError("ownership_mismatch", `Managed worktree ${key} is not canonical`);
    }
  }
  const relative = workspace.projectRelativePath === "." ? "" : workspace.projectRelativePath;
  if (path.join(workspace.worktreeRoot, relative) !== workspace.executionRoot) {
    throw new GitWorkspaceError("ownership_mismatch", "Managed execution path does not match");
  }
  const [topLevelOutput, commonGitDirOutput] = await Promise.all([
    runGit(workspace.worktreeRoot, ["rev-parse", "--show-toplevel"]).catch((error) => {
      throw new GitWorkspaceError("ownership_mismatch", "Managed worktree root is unavailable", [
        { kind: "ownership", detail: error.message },
      ]);
    }),
    runGit(workspace.worktreeRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).catch((error) => {
      throw new GitWorkspaceError("ownership_mismatch", "Managed worktree repository identity is unavailable", [
        { kind: "ownership", detail: error.message },
      ]);
    }),
  ]);
  const [topLevel, commonGitDir] = await Promise.all([
    fs.realpath(topLevelOutput).catch(() => null),
    fs.realpath(commonGitDirOutput).catch(() => null),
  ]);
  if (topLevel !== workspace.worktreeRoot) {
    throw new GitWorkspaceError("ownership_mismatch", "Managed worktree root does not match its Git identity");
  }
  if (commonGitDir !== workspace.commonGitDir) {
    throw new GitWorkspaceError("ownership_mismatch", "Managed worktree common Git directory does not match");
  }
  return owner;
}

export async function validateManagedWorkspace(workspace, { sessionId } = {}) {
  await assertOwnedWorkspace(workspace, { sessionId });
  return workspace;
}

export async function prepareManagedWorkspace({
  projectRoot,
  workspaceRoot,
  sessionId,
  ownershipToken,
}) {
  assertIdentity(sessionId, "sessionId");
  if (typeof ownershipToken !== "string" || ownershipToken.length === 0) {
    throw new GitWorkspaceError("invalid_identity", "ownershipToken must be a non-empty string");
  }
  const inspection = await inspectGitRepository(projectRoot);
  if (inspection.dirty.length > 0) {
    throw new GitWorkspaceError(
      "source_dirty",
      "Source repository must be clean before workspace preparation",
      inspection.dirty,
    );
  }

  const requestedWorkspaceRoot = path.resolve(workspaceRoot);
  if (
    isSameOrInside(inspection.repositoryRoot, requestedWorkspaceRoot)
    || isSameOrInside(requestedWorkspaceRoot, inspection.repositoryRoot)
  ) {
    throw new GitWorkspaceError("workspace_overlap", "Managed workspace root overlaps source repository");
  }
  await fs.mkdir(requestedWorkspaceRoot, { recursive: true });
  const canonicalWorkspaceRoot = await fs.realpath(requestedWorkspaceRoot);
  if (
    isSameOrInside(inspection.repositoryRoot, canonicalWorkspaceRoot)
    || isSameOrInside(canonicalWorkspaceRoot, inspection.repositoryRoot)
  ) {
    throw new GitWorkspaceError("workspace_overlap", "Managed workspace root overlaps source repository");
  }
  const worktreeRoot = path.join(canonicalWorkspaceRoot, sessionId);
  try {
    await fs.lstat(worktreeRoot);
    throw new GitWorkspaceError("workspace_collision", "Managed worktree path already exists");
  } catch (error) {
    if (error instanceof GitWorkspaceError) throw error;
    if (error.code !== "ENOENT") throw error;
  }

  await runGit(inspection.repositoryRoot, [
    "worktree",
    "add",
    "--detach",
    worktreeRoot,
    inspection.headOid,
  ]);
  try {
    const gitDir = await fs.realpath(await runGit(worktreeRoot, [
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    ]));
    const relative = inspection.projectRelativePath === "." ? "" : inspection.projectRelativePath;
    const workspace = {
      sessionId,
      ownershipToken,
      projectRoot: inspection.projectRoot,
      repositoryRoot: inspection.repositoryRoot,
      projectRelativePath: inspection.projectRelativePath,
      commonGitDir: inspection.commonGitDir,
      worktreeRoot: await fs.realpath(worktreeRoot),
      executionRoot: await fs.realpath(path.join(worktreeRoot, relative)),
      baseOid: inspection.headOid,
    };
    await fs.writeFile(ownerFile(gitDir), `${JSON.stringify(workspace)}\n`, { flag: "wx" });
    return workspace;
  } catch (error) {
    await runGit(inspection.repositoryRoot, ["worktree", "remove", worktreeRoot]).catch(() => {});
    throw error;
  }
}

async function assertCleanWorkspace(workspace, options) {
  await validateManagedWorkspace(workspace, options);
  const [status, gitDirOutput, commonGitDirOutput] = await Promise.all([
    runGit(workspace.worktreeRoot, [
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=all",
      "--ignore-submodules=none",
    ], { trim: false }),
    runGit(workspace.worktreeRoot, ["rev-parse", "--path-format=absolute", "--git-dir"]),
    runGit(workspace.worktreeRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  ]);
  const gitDir = await fs.realpath(gitDirOutput);
  const commonGitDir = await fs.realpath(commonGitDirOutput);
  if (commonGitDir !== workspace.commonGitDir) {
    throw new GitWorkspaceError("ownership_mismatch", "Managed worktree common Git directory does not match");
  }
  const dirty = [
    ...parseDirtyStatus(status),
    ...await findInProgressState(commonGitDir, gitDir),
  ];
  if (dirty.length > 0) {
    throw new GitWorkspaceError("workspace_dirty", "Managed worktree must be clean", dirty);
  }
}

async function listRegisteredWorktrees(repositoryRoot) {
  const output = await runGit(repositoryRoot, ["worktree", "list", "--porcelain"], { trim: false });
  const entries = [];
  for (const block of output.split("\n\n")) {
    if (block === "") continue;
    const worktreeLine = block.split("\n").find((line) => line.startsWith("worktree "));
    if (worktreeLine) entries.push(worktreeLine.slice("worktree ".length));
  }
  return entries;
}

export async function disposeManagedWorkspace(workspace, { sessionId } = {}) {
  await validateManagedWorkspace(workspace, { sessionId });
  const registeredWorktrees = await listRegisteredWorktrees(workspace.repositoryRoot);
  if (!registeredWorktrees.includes(workspace.worktreeRoot)) {
    throw new GitWorkspaceError("workspace_unregistered", "Managed worktree is no longer registered");
  }
  await assertCleanWorkspace(workspace, { sessionId });
  await runGit(workspace.repositoryRoot, ["worktree", "remove", workspace.worktreeRoot]).catch((error) => {
    throw new GitWorkspaceError("workspace_dispose_failed", "Managed worktree could not be removed", [
      { kind: "ownership", detail: error.message },
    ]);
  });
  try {
    await fs.access(workspace.worktreeRoot);
    throw new GitWorkspaceError("workspace_dispose_failed", "Managed worktree still exists after removal");
  } catch (error) {
    if (error instanceof GitWorkspaceError) throw error;
    if (error.code !== "ENOENT") throw error;
  }
  return {
    removed: true,
    worktreeRoot: workspace.worktreeRoot,
  };
}

async function assertRefAbsent(repositoryRoot, ref) {
  try {
    await runGit(repositoryRoot, ["show-ref", "--verify", "--quiet", ref]);
    throw new GitWorkspaceError("ref_collision", `Checkpoint ref already exists: ${ref}`);
  } catch (error) {
    if (error instanceof GitWorkspaceError) throw error;
    if (error.code !== 1) throw error;
  }
}

async function createRef(repositoryRoot, ref, oid) {
  await assertRefAbsent(repositoryRoot, ref);
  await runGit(repositoryRoot, ["update-ref", ref, oid, "0".repeat(oid.length)]);
}

export async function createBaselineCheckpoint(workspace, { sessionId, attemptId }) {
  await assertCleanWorkspace(workspace);
  if (sessionId !== workspace.sessionId) {
    throw new GitWorkspaceError("ownership_mismatch", "Checkpoint session does not own this worktree");
  }
  const ref = checkpointRef(sessionId, attemptId, "baseline");
  const oid = await runGit(workspace.worktreeRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  await createRef(workspace.repositoryRoot, ref, oid);
  return { oid, ref };
}

async function assertCheckpointRef(workspace, checkpoint, sessionId, attemptId, role) {
  const expectedRef = checkpointRef(sessionId, attemptId, role);
  if (checkpoint?.ref !== expectedRef || !/^[0-9a-f]{40,64}$/.test(checkpoint?.oid ?? "")) {
    throw new GitWorkspaceError("checkpoint_mismatch", "Checkpoint identity does not match");
  }
  const observedOid = await runGit(workspace.repositoryRoot, [
    "rev-parse",
    "--verify",
    `${expectedRef}^{commit}`,
  ]).catch(() => null);
  if (observedOid !== checkpoint.oid) {
    throw new GitWorkspaceError("checkpoint_mismatch", "Checkpoint ref does not resolve to the expected OID");
  }
}

function assertManifestPath(filePath) {
  const segments = typeof filePath === "string" ? filePath.split("/") : [];
  if (
    segments.length === 0
    || filePath === ""
    || filePath.includes("\0")
    || filePath.includes("\\")
    || path.posix.isAbsolute(filePath)
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new GitWorkspaceError("invalid_path", "Manifest path is not safe");
  }
}

function runGitPrefix(cwd, args, limit) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    const errors = [];
    let retained = 0;
    let total = 0;
    let terminated = false;
    child.stdout.on("data", (chunk) => {
      total += chunk.length;
      if (retained < limit) {
        const kept = chunk.subarray(0, limit - retained);
        chunks.push(kept);
        retained += kept.length;
      }
      if (total > limit && !terminated) {
        terminated = true;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk) => {
      const errorBytes = errors.reduce((sum, item) => sum + item.length, 0);
      if (errorBytes < 4096) errors.push(chunk.subarray(0, 4096 - errorBytes));
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0 && !terminated) {
        const error = new Error(Buffer.concat(errors).toString("utf8").trim() || `git exited with code ${code}`);
        error.code = code;
        reject(error);
        return;
      }
      resolve({ buffer: Buffer.concat(chunks), truncated: terminated || total > limit, total });
    });
  });
}

async function readBlob(repositoryRoot, oid, filePath) {
  if (filePath === null) {
    return { path: null, exists: false, bytes: 0, text: null, truncated: false };
  }
  const object = `${oid}:${filePath}`;
  let type;
  try {
    type = await runGit(repositoryRoot, ["cat-file", "-t", object]);
  } catch (error) {
    throw new GitWorkspaceError(
      "manifest_mismatch",
      "Manifest path is absent from its checkpoint",
      [{ kind: "git_object", path: filePath, detail: error.message }],
    );
  }
  if (type !== "blob") {
    return { path: filePath, exists: true, bytes: 0, text: null, truncated: false, binary: true };
  }
  const size = Number(await runGit(repositoryRoot, ["cat-file", "-s", object]));
  const content = await runGitPrefix(repositoryRoot, ["cat-file", "blob", object], MAX_DIFF_TEXT_BYTES);
  const hasNul = content.buffer.includes(0);
  let text = null;
  let invalidUtf8 = false;
  if (!hasNul) {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const maximumTrim = content.truncated ? Math.min(3, content.buffer.length) : 0;
    for (let trim = 0; trim <= maximumTrim; trim += 1) {
      try {
        text = decoder.decode(trim === 0 ? content.buffer : content.buffer.subarray(0, -trim));
        break;
      } catch {
        if (trim === maximumTrim) invalidUtf8 = true;
      }
    }
  }
  return {
    path: filePath,
    exists: true,
    bytes: Number.isFinite(size) ? size : content.total,
    text: hasNul || invalidUtf8 ? null : text,
    truncated: content.truncated,
    binary: hasNul || invalidUtf8,
  };
}

function parseHunks(patchText, patchTruncated) {
  const hunks = [];
  let lineCount = 0;
  let truncated = patchTruncated;
  let current = null;
  let oldLine = 0;
  let newLine = 0;
  for (const rawLine of patchText.split("\n")) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rawLine);
    if (match) {
      if (hunks.length >= MAX_DIFF_HUNKS) {
        truncated = true;
        break;
      }
      current = {
        oldStart: Number(match[1]),
        oldLines: Number(match[2] ?? 1),
        newStart: Number(match[3]),
        newLines: Number(match[4] ?? 1),
        lines: [],
      };
      oldLine = current.oldStart;
      newLine = current.newStart;
      hunks.push(current);
      continue;
    }
    if (!current || rawLine.startsWith("\\ No newline at end of file")) continue;
    const marker = rawLine[0];
    if (![' ', '+', '-'].includes(marker)) continue;
    if (lineCount >= MAX_DIFF_LINES) {
      truncated = true;
      break;
    }
    const line = {
      type: marker === "+" ? "addition" : marker === "-" ? "deletion" : "context",
      text: rawLine.slice(1),
      oldLine: marker === "+" ? null : oldLine,
      newLine: marker === "-" ? null : newLine,
    };
    current.lines.push(line);
    lineCount += 1;
    if (marker !== "+") oldLine += 1;
    if (marker !== "-") newLine += 1;
  }
  return { hunks, truncated };
}

export async function readCheckpointFileDiff(workspace, {
  sessionId,
  attemptId,
  baseline,
  result,
  file,
}) {
  if (sessionId !== workspace?.sessionId) {
    throw new GitWorkspaceError("ownership_mismatch", "Diff session does not own this repository evidence");
  }
  assertIdentity(sessionId, "sessionId");
  assertIdentity(attemptId, "attemptId");
  if (workspace.projectRelativePath !== ".") assertManifestPath(workspace.projectRelativePath);
  const validStatuses = new Set(["added", "modified", "deleted", "renamed", "copied", "type-changed"]);
  if (!file || !validStatuses.has(file.status)) {
    throw new GitWorkspaceError("manifest_mismatch", "Diff path is not present in the attempt manifest");
  }
  assertManifestPath(file.path);
  if (file.oldPath !== null && file.oldPath !== undefined) assertManifestPath(file.oldPath);
  await assertOwnedWorkspace(workspace, { sessionId });
  await assertCheckpointRef(workspace, baseline, sessionId, attemptId, "baseline");
  await assertCheckpointRef(workspace, result, sessionId, attemptId, "result");

  const oldPath = file.status === "added"
    ? null
    : (file.status === "renamed" || file.status === "copied" ? file.oldPath : file.path);
  const newPath = file.status === "deleted" ? null : file.path;
  if ((file.status === "renamed" || file.status === "copied") && oldPath == null) {
    throw new GitWorkspaceError("manifest_mismatch", "Renamed and copied files require an old path");
  }
  const projectPrefix = workspace.projectRelativePath === "." ? "" : `${workspace.projectRelativePath}/`;
  const repositoryOldPath = oldPath === null ? null : `${projectPrefix}${oldPath}`;
  const repositoryNewPath = newPath === null ? null : `${projectPrefix}${newPath}`;
  const [oldSide, newSide] = await Promise.all([
    readBlob(workspace.repositoryRoot, baseline.oid, repositoryOldPath),
    readBlob(workspace.repositoryRoot, result.oid, repositoryNewPath),
  ]);
  oldSide.path = oldPath;
  newSide.path = newPath;
  const binary = file.binary === true || oldSide.binary === true || newSide.binary === true;
  delete oldSide.binary;
  delete newSide.binary;
  let hunks = [];
  let hunksTruncated = false;
  if (!binary) {
    const paths = [...new Set([repositoryOldPath, repositoryNewPath].filter(Boolean))];
    const patch = await runGitPrefix(workspace.repositoryRoot, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--unified=3",
      "--find-renames",
      "--find-copies",
      baseline.oid,
      result.oid,
      "--",
      ...paths,
    ], MAX_PATCH_BYTES);
    ({ hunks, truncated: hunksTruncated } = parseHunks(patch.buffer.toString("utf8"), patch.truncated));
  }
  return {
    status: file.status,
    oldPath,
    newPath,
    binary,
    truncated: oldSide.truncated || newSide.truncated || hunksTruncated,
    old: oldSide,
    new: newSide,
    hunks,
    hunksTruncated,
  };
}

function statusName(letter) {
  return {
    A: "added",
    M: "modified",
    D: "deleted",
    R: "renamed",
    C: "copied",
    T: "type-changed",
    U: "unmerged",
  }[letter] ?? "modified";
}

async function buildManifest(repositoryRoot, baselineOid, resultOid) {
  const [nameStatusOutput, numstatOutput] = await Promise.all([
    runGit(repositoryRoot, [
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      "--find-copies",
      baselineOid,
      resultOid,
    ], { trim: false }),
    runGit(repositoryRoot, ["diff", "--numstat", "-z", baselineOid, resultOid], { trim: false }),
  ]);
  const counts = new Map();
  const numstat = numstatOutput.split("\0");
  for (let index = 0; index < numstat.length;) {
    const record = numstat[index++];
    if (!record) continue;
    const [additions, deletions, inlinePath] = record.split("\t");
    let filePath = inlinePath;
    if (inlinePath === "") {
      index += 1;
      filePath = numstat[index++];
    }
    counts.set(filePath, {
      binary: additions === "-" || deletions === "-",
      additions: additions === "-" ? null : Number(additions),
      deletions: deletions === "-" ? null : Number(deletions),
    });
  }

  const records = nameStatusOutput.split("\0").filter(Boolean);
  const files = [];
  for (let index = 0; index < records.length;) {
    const code = records[index++];
    const status = statusName(code[0]);
    const oldPath = status === "renamed" || status === "copied" ? records[index++] : null;
    const filePath = records[index++];
    const count = counts.get(filePath) ?? {
      binary: false,
      additions: 0,
      deletions: 0,
    };
    files.push({ path: filePath, oldPath, status, ...count });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function createResultCheckpoint(workspace, {
  sessionId,
  attemptId,
  baseline,
}) {
  await assertOwnedWorkspace(workspace);
  if (sessionId !== workspace.sessionId) {
    throw new GitWorkspaceError("ownership_mismatch", "Checkpoint session does not own this worktree");
  }
  await assertCheckpointRef(workspace, baseline, sessionId, attemptId, "baseline");
  const resultRef = checkpointRef(sessionId, attemptId, "result");
  await assertRefAbsent(workspace.repositoryRoot, resultRef);

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dev-workbench-index-"));
  const indexFile = path.join(temporaryDirectory, "index");
  const gitEnvironment = {
    GIT_INDEX_FILE: indexFile,
    GIT_AUTHOR_NAME: "Dev Workbench",
    GIT_AUTHOR_EMAIL: "dev-workbench@localhost",
    GIT_COMMITTER_NAME: "Dev Workbench",
    GIT_COMMITTER_EMAIL: "dev-workbench@localhost",
  };
  try {
    await runGit(workspace.worktreeRoot, ["read-tree", baseline.oid], { env: gitEnvironment });
    await runGit(workspace.worktreeRoot, ["add", "-A", "--", "."], { env: gitEnvironment });
    const treeOid = await runGit(workspace.worktreeRoot, ["write-tree"], { env: gitEnvironment });
    const resultOid = await runGit(workspace.repositoryRoot, [
      "commit-tree",
      treeOid,
      "-p",
      baseline.oid,
      "-m",
      `Dev Workbench checkpoint ${sessionId}/${attemptId}`,
    ], { env: gitEnvironment });
    await createRef(workspace.repositoryRoot, resultRef, resultOid);
    const files = await buildManifest(workspace.repositoryRoot, baseline.oid, resultOid);
    await runGit(workspace.worktreeRoot, ["reset", "--hard", resultOid]);
    await runGit(workspace.worktreeRoot, ["clean", "-dffx"]);
    const remainingStatus = await runGit(workspace.worktreeRoot, [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    if (remainingStatus !== "") {
      throw new GitWorkspaceError("normalization_failed", "Managed worktree did not normalize cleanly");
    }
    return { oid: resultOid, ref: resultRef, files };
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function restoreCheckpoint(workspace, checkpoint) {
  await assertCleanWorkspace(workspace);
  if (checkpoint?.accepted !== true) {
    throw new GitWorkspaceError("checkpoint_not_accepted", "Checkpoint is not an accepted restore target");
  }
  const refParts = typeof checkpoint.ref === "string" ? checkpoint.ref.split("/") : [];
  const validRef = refParts.length === 6
    && refParts[0] === "refs"
    && refParts[1] === "dev-workbench"
    && refParts[2] === "checkpoints"
    && refParts[3] === workspace.sessionId
    && IDENTITY_PATTERN.test(refParts[4])
    && (refParts[5] === "baseline" || refParts[5] === "result");
  if (
    !validRef
    || !/^[0-9a-f]{40,64}$/.test(checkpoint.oid ?? "")
  ) {
    throw new GitWorkspaceError("checkpoint_mismatch", "Restore checkpoint identity does not match");
  }
  const observedOid = await runGit(workspace.repositoryRoot, [
    "rev-parse",
    "--verify",
    `${checkpoint.ref}^{commit}`,
  ]).catch(() => null);
  if (observedOid !== checkpoint.oid) {
    throw new GitWorkspaceError("checkpoint_mismatch", "Restore checkpoint ref does not match its OID");
  }
  await runGit(workspace.worktreeRoot, ["clean", "-dffx"]);
  await runGit(workspace.worktreeRoot, ["checkout", "--detach", checkpoint.oid]);
  await runGit(workspace.worktreeRoot, ["reset", "--hard", checkpoint.oid]);
  await runGit(workspace.worktreeRoot, ["clean", "-dffx"]);
  const materializedOid = await runGit(workspace.worktreeRoot, ["rev-parse", "HEAD"]);
  if (materializedOid !== checkpoint.oid) {
    throw new GitWorkspaceError("restore_failed", "Managed worktree did not reach the requested checkpoint");
  }
  return { oid: materializedOid, ref: checkpoint.ref };
}

async function git(projectRoot, args) {
  try {
    return await runGit(projectRoot, args);
  } catch (error) {
    if (/not a git repository/i.test(error.stderr ?? "")) return null;
    throw error;
  }
}

export async function captureGitState(projectRoot) {
  const head = await git(projectRoot, ["rev-parse", "--short", "HEAD"]);
  if (head === null) return { available: false, head: null, status: "", diff: "" };
  const [status, diff] = await Promise.all([
    git(projectRoot, ["status", "--short"]),
    git(projectRoot, ["diff", "--no-ext-diff", "--", "."]),
  ]);
  return { available: true, head, status, diff };
}
