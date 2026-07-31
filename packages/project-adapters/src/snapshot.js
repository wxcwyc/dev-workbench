import { captureFileTree, compareTrees } from "./file-tree.js";
import { captureGitState } from "./git-adapter.js";

function boundedTail(value, maxOutputBytes) {
  const bytes = Buffer.from(typeof value === "string" ? value : "", "utf8");
  if (bytes.length <= maxOutputBytes) return { text: bytes.toString("utf8"), truncated: false };
  return {
    text: bytes.subarray(bytes.length - maxOutputBytes).toString("utf8"),
    truncated: true,
  };
}

export function checkpointAttemptSnapshot(
  files,
  commandResult,
  { maxOutputBytes = 64 * 1024, projectRelativePath = "." } = {},
) {
  const prefix = projectRelativePath === "." ? "" : `${projectRelativePath}/`;
  const projectFiles = files.map((file) => {
    const normalized = {
      ...file,
      path: prefix && file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path,
    };
    if (prefix && file.oldPath?.startsWith(prefix)) {
      normalized.oldPath = file.oldPath.slice(prefix.length);
    }
    return normalized;
  });
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
