import { assertExecutionRepository, createWorktree, getDiff, changedFiles, removeWorktree } from "./worktree.js";
import { provider } from "./providers/registry.js";
import { scanForSecrets } from "./secret-scan.js";
import { logError, redact } from "./logger.js";
import { executionPrompt } from "./prompts.js";
import { EXEC_STOPPED_MESSAGE } from "./exec-state.js";

// Run exactly one executor with write permissions inside its disposable clone.
// The reviewer is a separate, read-only step — this function never runs two writers.
export async function runExecution({ projectPath, executor, mode = "run", task, config = {}, onEvent, registerChild, isCancelled }) {
  const executorProvider = provider(executor);
  if (!executorProvider) throw new Error(`Unknown executor: ${executor}`);
  if (!task || !String(task).trim()) throw new Error("Execution task is empty");
  if (mode !== "run") throw new Error("Executor mode must be run");
  if (!executorProvider.capabilities?.executeModes?.includes(mode)) {
    throw new Error(`${executorProvider.label} does not provide a safe ${mode} execution mode`);
  }

  // Bail before the clone if a Stop already landed, and make the clone/checkout killable. The
  // worktree creation is checked inside createWorktree too; this is the outermost gate.
  if (isCancelled?.()) throw new Error(EXEC_STOPPED_MESSAGE);
  const taskId = "t-" + crypto.randomUUID().slice(0, 8);
  const wt = await createWorktree(projectPath, executor, taskId, { registerChild, isCancelled });
  try {
    // Never launch the executor agent once a Stop has been accepted — the just-created clone is
    // cleaned up by the catch below, so no writer process starts after the user stops.
    if (isCancelled?.()) throw new Error(EXEC_STOPPED_MESSAGE);
    const response = await executorProvider.run({
      prompt: executionPrompt(task, mode),
      config: { ...config, permission: mode },
      cwd: wt.path,
      onEvent,
      registerChild,
    });
    await assertExecutionRepository(wt);
    const diff = await getDiff(wt.path, wt.baseSha);
    const secretFindings = scanForSecrets(await changedFiles(wt.path, wt.baseSha));
    return {
      taskId,
      executor,
      mode,
      worktree: wt,
      text: redact(response.text),
      meta: {
        model: response.model ?? null,
        effort: response.effort ?? null,
        durationMs: response.durationMs ?? null,
        exitCode: response.exitCode ?? null,
        outputTruncated: Boolean(response.outputTruncated),
        usage: response.usage ?? null,
      },
      diff,
      secretFindings,
    };
  } catch (error) {
    const primaryError = error instanceof Error ? error : new Error(String(error));
    try {
      const cleanup = await removeWorktree(projectPath, wt.path, wt.branch, { isolation: wt.isolation });
      if (!cleanup.ok) {
        primaryError.cleanupErrors = cleanup.errors;
        logError("execution cleanup failed", cleanup.errors.join("; "));
      }
    } catch (cleanupError) {
      primaryError.cleanupErrors = [redact(cleanupError?.message || cleanupError)];
      logError("execution cleanup failed", cleanupError?.message || cleanupError);
    }
    throw primaryError;
  }
}
