import { assertExecutionRepository, assertProjectReady, changedTreeFiles, commitAcceptedTree, importAcceptedCommit, prepareWorktreeForAccept, stageAcceptedTree, treeDiff } from "./worktree.js";
import { hasBlockingSecrets, scanForSecrets } from "./secret-scan.js";

export async function prepareReviewSnapshot({ projectPath, worktree }) {
  await assertProjectReady(projectPath, worktree);
  await assertExecutionRepository(worktree);
  const treeSha = await stageAcceptedTree(worktree.path, worktree.baseSha);
  const diff = await treeDiff(worktree.path, worktree.baseSha, treeSha);
  const secretFindings = scanForSecrets(await changedTreeFiles(worktree.path, worktree.baseSha, treeSha));
  return { treeSha, diff, secretFindings, blocked: hasBlockingSecrets(secretFindings) };
}

export async function prepareAcceptedChange({ projectPath, worktree, message, reviewedTree = "" }) {
  await assertProjectReady(projectPath, worktree);
  await assertExecutionRepository(worktree);
  await prepareWorktreeForAccept(worktree.path, worktree.branch, worktree.baseSha);
  const treeSha = reviewedTree || await stageAcceptedTree(worktree.path, worktree.baseSha);
  const diff = await treeDiff(worktree.path, worktree.baseSha, treeSha);
  const secretFindings = scanForSecrets(await changedTreeFiles(worktree.path, worktree.baseSha, treeSha));
  if (hasBlockingSecrets(secretFindings)) {
    return { committed: false, blocked: true, diff, secretFindings };
  }

  const commitSha = await commitAcceptedTree(worktree.path, worktree, treeSha, message, { useReviewedTree: Boolean(reviewedTree) });
  const acceptedRef = await importAcceptedCommit(projectPath, worktree, commitSha, treeSha);
  await assertProjectReady(projectPath, worktree);
  return { committed: true, blocked: false, commitSha, treeSha, acceptedRef, diff, secretFindings };
}
