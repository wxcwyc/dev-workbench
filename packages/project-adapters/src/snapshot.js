import { captureFileTree, compareTrees } from "./file-tree.js";
import { captureGitState } from "./git-adapter.js";

function boundedTail(value, maxOutputBytes) {
  const bytes = Buffer.from(typeof value === "string" ? value : "", "utf8");
  if (bytes.length <= maxOutputBytes) return { text: bytes.toString("utf8"), truncated: false };
  let start = bytes.length - maxOutputBytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return {
    text: bytes.subarray(start).toString("utf8"),
    truncated: true,
  };
}

function projectManifest(files, projectRelativePath) {
  if (projectRelativePath === ".") return files.map((file) => ({ ...file }));
  const prefix = `${projectRelativePath}/`;
  const inside = (filePath) => typeof filePath === "string" && filePath.startsWith(prefix);
  const relative = (filePath) => filePath.slice(prefix.length);
  return files
    .filter((file) => inside(file.path))
    .map((file) => ({
      ...file,
      path: relative(file.path),
      oldPath: inside(file.oldPath) ? relative(file.oldPath) : null,
    }));
}

export function checkpointAttemptSnapshot(
  files,
  commandResult,
  { maxOutputBytes = 64 * 1024, projectRelativePath = "." } = {},
) {
  const projectFiles = projectManifest(files, projectRelativePath);
  if (commandResult == null) return { files: projectFiles, command: null };
  const stdout = boundedTail(commandResult.stdout, maxOutputBytes);
  const stderr = boundedTail(commandResult.stderr, maxOutputBytes);
  return {
    files: projectFiles,
    command: {
      ...commandResult,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    },
  };
}

export async function captureProjectSnapshot(projectRoot, previous = null, commandResult = null) {
  const [tree, git] = await Promise.all([captureFileTree(projectRoot), captureGitState(projectRoot)]);
  return { tree, treeChanges: compareTrees(previous?.tree, tree), git, command: commandResult };
}
