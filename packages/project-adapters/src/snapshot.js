import { captureFileTree, compareTrees } from "./file-tree.js";
import { captureGitState } from "./git-adapter.js";

export async function captureProjectSnapshot(projectRoot, previous = null, commandResult = null) {
  const [tree, git] = await Promise.all([captureFileTree(projectRoot), captureGitState(projectRoot)]);
  return { tree, treeChanges: compareTrees(previous?.tree, tree), git, command: commandResult };
}
