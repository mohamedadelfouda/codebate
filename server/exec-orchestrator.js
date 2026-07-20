import { getSession, listSessions, mutateSession, scratchWorkspacePath } from "./store.js";
import { runExecution } from "./executor.js";
import { assertProjectReady, listAcceptedRefs, listExecutionWorkspaces, listWorktrees, recoverCodebateIndexLock, releaseAcceptedCommit, removeWorktree, mergeBranch, pushBranch, pruneObjects, sweepOrphanExecutionWorkspaces, projectWorkspaceKey } from "./worktree.js";
import { provider } from "./providers/registry.js";
import { resolveAllowedCommand, runProcess, terminateProcess } from "./process.js";
import { hasBlockingSecrets } from "./secret-scan.js";
import { logError, redact } from "./logger.js";
import { expectedApiError } from "./api-errors.js";
import { prepareAcceptedChange, prepareReviewSnapshot } from "./acceptance.js";
import { recordDecision } from "./decisions.js";
import { registerProjectScope } from "./project-tools.js";
import path from "node:path";
import { assertTrustedProject, projectIdentity } from "./project.js";
import { githubRepository } from "./github-remote.js";
import { claimSessionActivity } from "./session-activity.js";
import { createExecAttempt, requestExecCancellation, execWasCancelled, trackExecChild, claimExecTerminal, enterExecFinalizing, execIsFinalizing, EXEC_STOPPED_MESSAGE } from "./exec-state.js";

const activeExec = new Map();
const decisionLocks = new Map();

function withDecisionLock(sessionId, taskId, task) {
  const key = `${sessionId}:${taskId}`;
  const previous = decisionLocks.get(key) || Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(() => {}, () => {});
  decisionLocks.set(key, tail);
  tail.then(() => { if (decisionLocks.get(key) === tail) decisionLocks.delete(key); });
  return run;
}
export function isExecuting(id) { return activeExec.has(id); }

// Wait, bounded, for the run body to unwind after cancellation (its finally resolves state.settle).
// Returns true if it settled, false on timeout — mirrors settlePendingProviders on the run side.
function settleExec(state, timeoutMs) {
  if (!state.settle) return Promise.resolve(true);
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([state.settle.then(() => true), timedOut]).finally(() => clearTimeout(timer));
}

// Force-finalize a run whose body did not unwind within the settle window. This is reachable not
// only when a provider child is truly unkillable, but also when the body is merely slow to unwind:
// graceful child termination plus the run body's own clone cleanup (fs.rm of the disposable worktree)
// can, on a large repo or under antivirus/indexer contention, exceed settleTimeoutMs. Releases the
// reviewer's MCP project scope (if the reviewer is what stalled) and the activity claim, and clears
// the registry so the session can't stay wedged as 409 "busy". The disposable clone is deleted by the
// run body's own catch/finally whenever it eventually unwinds; only in the rare truly-stuck case does
// it linger — git-ignored and unreferenced by any session record, so it can never be merged or
// trusted — until reconcileExecutionWorktrees reclaims it on the next startup. Idempotent via the
// single terminal claim, so this and the body's finally never double-release or double-emit.
function finalizeStalledExecStop(id, state) {
  // A cancelling run that stalled past the settle window genuinely stopped → claim "stopped" and
  // surface exec_error. A *finalizing* run has already committed its result (its exec_ready is imminent
  // or emitted); if only its slow, recoverable clone-cleanup stalled we still release the session so it
  // can't wedge as busy, but claim "finished" and stay silent — a forced exec_error would contradict
  // that exec_ready. `finalizing` is read before the idempotent claim flips status; a run that finished
  // normally in the meantime makes the claim (and this whole call) a no-op.
  const finalizing = execIsFinalizing(state);
  if (!claimExecTerminal(state, finalizing ? "finished" : "stopped")) return;
  if (activeExec.get(id) === state) activeExec.delete(id);
  state.releaseProjectScope?.();
  state.releaseActivity?.();
  if (!finalizing) state.emit?.({ type: "exec_error", error: EXEC_STOPPED_MESSAGE, code: "execution_stopped" });
}

// Stop an in-flight execution. Distinguishes: already_finished (nothing running), process_terminated
// (a child was killed), stop_requested (cancel recorded, nothing to kill yet). Terminates children,
// then waits bounded for the body to unwind; if it can't, force-finalizes so the session stays usable.
export async function stopExec(id, { settleTimeoutMs = 5000 } = {}) {
  const s = activeExec.get(id);
  if (!s) return { stopped: false, status: "already_finished" };
  if (!requestExecCancellation(s)) {
    // The run is no longer `running`: either a Stop is already in flight, or it entered its
    // non-cancellable finalizing save. Wait bounded for it to unwind; if it stalls, force-finalize so
    // the session can't wedge as busy (e.g. a slow clone delete inside the blocked_secret finalize).
    // finalizeStalledExecStop distinguishes a stalled *cancel* (surfaces exec_error) from a stalled
    // *finalize* (releases silently — its result stands, exec_ready imminent), so neither leaves the
    // session stuck. `finalizing` (captured before the await) only picks this Stop's reported status.
    const finalizing = execIsFinalizing(s);
    if (!(await settleExec(s, settleTimeoutMs))) finalizeStalledExecStop(id, s);
    return finalizing ? { stopped: false, status: "already_finished" } : { stopped: true, status: "stop_requested" };
  }
  const results = await Promise.all([...s.children].map((child) => terminateProcess(child)));
  if (!(await settleExec(s, settleTimeoutMs))) finalizeStalledExecStop(id, s);
  return {
    stopped: results.every(Boolean),
    // `process_terminated` only when at least one child was actually killed — not merely when children
    // existed (an all-failed terminate must not masquerade as a successful process termination).
    status: results.some(Boolean) ? "process_terminated" : "stop_requested",
  };
}

// Cancel every in-flight execution and kill its child processes — used at shutdown so an
// executor/reviewer agent never keeps running after the server exits. Each run's own
// finally block then clears its registry entry.
export async function abortAllExecutions() {
  for (const [, s] of activeExec) {
    requestExecCancellation(s);
    // Shutdown path: SIGKILL now — the server's ~1500ms exit would beat the SIGTERM→SIGKILL
    // escalation timer, leaving a detached executor/reviewer running after the server exits.
    await Promise.all([...s.children].map((child) => terminateProcess(child, { immediate: true })));
  }
}

async function gh(args, cwd, input = "") {
  const command = await resolveAllowedCommand("gh", new Set(["gh"]));
  const execution = await runProcess({ command, args, cwd, input, envPolicy: "github", timeoutMs: 120000 });
  if (execution.code !== 0) throw new Error(redact(execution.stderr || `gh exited with code ${execution.code}`).trim());
  return execution;
}

const RETAINED_EXECUTION_STATUSES = new Set(["awaiting_user", "accepted_pending_merge", "accepted_pending_pr"]);

function projectRecoveryState(projects, projectPath) {
  const current = projects.get(projectPath) || { keep: new Set(), acceptedRefs: new Set() };
  projects.set(projectPath, current);
  return current;
}

async function cleanupExecutionWorkspace(projectPath, worktree, { purgeSecrets = false, acceptedRef = "", acceptedCommit = "" } = {}) {
  let cleanup = await removeWorktree(projectPath, worktree.path, worktree.branch, { isolation: worktree.isolation });
  if (purgeSecrets) {
    const purged = await pruneObjects(projectPath, { isolation: worktree.isolation });
    cleanup = { ok: cleanup.ok && purged.ok, errors: [...cleanup.errors, ...purged.errors] };
  }
  if (acceptedRef || acceptedCommit) {
    const released = await releaseAcceptedCommit(projectPath, acceptedRef, acceptedCommit);
    cleanup = { ok: cleanup.ok && released.ok, errors: [...cleanup.errors, ...released.errors] };
  }
  return cleanup;
}

export async function reconcileExecutionWorktrees() {
  const projects = new Map();
  const recoveredIndexLocks = new Set();
  for (const summary of await listSessions()) {
    if (summary.projectPath) projectRecoveryState(projects, summary.projectPath);
    if (summary.hasRecoverableExecutions === false || (summary.hasRecoverableExecutions === undefined && summary.hasExecutions === false)) continue;
    try {
      let session = await getSession(summary.id);
      for (const execution of session.executions || []) {
        const executionProjectPath = execution.projectPath || session.project?.path;
        if (execution.status !== "accepting_merge" || !executionProjectPath || recoveredIndexLocks.has(executionProjectPath)) continue;
        await recoverCodebateIndexLock(executionProjectPath);
        recoveredIndexLocks.add(executionProjectPath);
      }
      const needsStateRecovery = (session.executions || []).some((execution) => ["accepting_merge", "accepting_pr", "rejecting"].includes(execution.status));
      if (needsStateRecovery) {
        for (const execution of session.executions || []) {
          if (!["accepting_merge", "accepting_pr", "rejecting"].includes(execution.status)) continue;
          await withDecisionLock(session.id, execution.taskId, () => mutateSession(session.id, (latest) => {
            const current = findExecution(latest, execution.taskId);
            if (current?.status === "accepting_merge") current.status = "accepted_pending_merge";
            if (current?.status === "accepting_pr") current.status = "accepted_pending_pr";
            if (current?.status === "rejecting") current.status = "rejected_cleanup_pending";
          }));
        }
        session = await getSession(session.id);
      }
      if (session.project?.path) projectRecoveryState(projects, session.project.path);
      for (const execution of session.executions || []) {
        const executionProjectPath = execution.projectPath || session.project?.path;
        if (!executionProjectPath) continue;
        const project = projectRecoveryState(projects, executionProjectPath);
        if (RETAINED_EXECUTION_STATUSES.has(execution.status)) {
          if (execution.worktree?.path) project.keep.add(path.resolve(execution.worktree.path));
          if (execution.acceptedRef) project.acceptedRefs.add(execution.acceptedRef);
          continue;
        }
        if (execution.cleanupPending === false && execution.cleanupCompletedAt) continue;
        await withDecisionLock(session.id, execution.taskId, async () => {
          const cleanup = execution.worktree?.path
            ? await cleanupExecutionWorkspace(executionProjectPath, execution.worktree, {
              purgeSecrets: execution.status === "blocked_secret",
              acceptedRef: execution.acceptedRef,
              acceptedCommit: execution.acceptedCommit,
            })
            : execution.acceptedRef
              ? await releaseAcceptedCommit(executionProjectPath, execution.acceptedRef, execution.acceptedCommit)
              : { ok: false, errors: ["execution cleanup record is missing its isolated workspace"] };
          await mutateSession(session.id, (latest) => {
            const current = findExecution(latest, execution.taskId);
            if (!current) return;
            current.cleanupPending = !cleanup.ok;
            current.cleanupErrors = cleanup.errors.slice(0, 5);
            if (cleanup.ok) current.cleanupCompletedAt = new Date().toISOString();
            if (cleanup.ok && current.status === "rejected_cleanup_pending") current.status = "rejected";
          });
        });
      }
    } catch (error) {
      logError(`execution reconciliation skipped session ${summary.id}`, error.message);
    }
  }

  // Remove Codebate worktrees created before a crash but never persisted.
  // Still-actionable execution worktrees remain in the keep set above.
  for (const [projectPath, project] of projects) {
    try {
      for (const workspace of await listExecutionWorkspaces(projectPath)) {
        if (!project.keep.has(path.resolve(workspace.path))) await removeWorktree(projectPath, workspace.path, workspace.branch, { isolation: workspace.isolation });
      }
      const blocks = (await listWorktrees(projectPath)).split(/\r?\n\r?\n/).filter(Boolean);
      for (const block of blocks) {
        const wtPath = block.match(/^worktree (.+)$/m)?.[1];
        const branch = block.match(/^branch refs\/heads\/(agent\/.+)$/m)?.[1];
        if (!wtPath || !branch || !path.resolve(wtPath).includes(`${path.sep}.agent-workspaces${path.sep}`)) continue;
        if (!project.keep.has(path.resolve(wtPath))) await removeWorktree(projectPath, wtPath, branch, { isolation: "legacy" });
      }
      for (const ref of await listAcceptedRefs(projectPath)) {
        if (project.acceptedRefs.has(ref)) continue;
        const commitSha = ref.split("/").pop();
        await releaseAcceptedCommit(projectPath, ref, commitSha);
      }
    } catch (error) {
      logError(`orphan worktree reconciliation skipped project ${projectPath}`, error.message);
    }
  }

  // Out-of-tree clones don't die with a deleted project the way in-tree ones did. Sweep exec-workspaces
  // buckets whose project no longer has any session — buckets for still-known projects are kept, and their
  // live executions were handled per-record above. This never deletes an in-flight clone: reconciliation
  // runs once at startup BEFORE `startupReconciled` flips true, and the /execute route refuses to create a
  // clone until then (server/index.js), so no bucket can appear concurrently with this key snapshot. (A
  // session in `recovery_needed` state has no usable projectPath, so its bucket, if any, is treated as
  // orphaned; that only costs a "run the task again" after recovery — the reviewed diff lives in the
  // session file, not the clone.)
  try {
    const knownKeys = new Set([...projects.keys()].map(projectWorkspaceKey));
    const swept = await sweepOrphanExecutionWorkspaces(knownKeys);
    if (!swept.ok) logError("orphan execution-workspace sweep incomplete", swept.errors.join("; "));
  } catch (error) {
    logError("orphan execution-workspace sweep failed", error.message);
  }
}

function reviewPrompt(task, execResult) {
  return `You are the REVIEWER. Read only — do not modify anything, just review.\n\n` +
    `The task that was implemented:\n${task}\n\n` +
    `The executor (${execResult.executor}) produced this diff summary:\n\n${execResult.diff.patch.slice(0, 120000)}\n\n` +
    `You are reviewing the disposable execution clone. Inspect the complete changed files and ` +
    `relevant surrounding code instead of relying only on this possibly truncated summary. ` +
    `Review it: is it correct and complete? List any bugs, risks, or missing pieces. ` +
    `End with a clear verdict: APPROVE or REQUEST_CHANGES, with a one-line reason.`;
}

export function pullRequestContent(execution = {}) {
  const task = redact(execution.task);
  const review = redact(execution.review?.text || "—");
  const titleTask = task.replace(/\s+/g, " ").trim() || "Accepted change";
  return {
    title: `Codebate: ${titleTask.slice(0, 60)}`,
    body: `### Task\n${task}\n\n### Review\n${review}`,
  };
}

async function openPullRequest({ projectPath, branch, title, body, repository }) {
  const safeTitle = redact(title).slice(0, 256);
  const boundedBody = redact(body).slice(0, 100000);
  try {
    const created = await gh(["pr", "create", "--repo", repository, "--head", branch, "--title", safeTitle, "--body-file", "-"], projectPath, boundedBody);
    return created.stdout.trim();
  } catch (error) {
    if (!/already exists/i.test(error.message)) throw error;
    const existing = await gh(["pr", "view", branch, "--repo", repository, "--json", "url", "--jq", ".url"], projectPath);
    return existing.stdout.trim();
  }
}

// One run: exactly one executor writes in a disposable clone, then one reviewer reads the captured diff.
// Never two writers. Result waits for the user's accept/reject decision.
export function runExecuteAndReview(sessionId, req, emit) {
  const releaseActivity = claimSessionActivity(sessionId, "execution");
  return runExecuteAndReviewClaimed(sessionId, req, emit, releaseActivity);
}

async function runExecuteAndReviewClaimed(sessionId, req, emit, releaseActivity) {
  const state = createExecAttempt();
  // stopExec needs the emitter and the activity releaser to force-finalize a run whose body is
  // wedged and whose own finally never runs (see finalizeStalledExecStop). settle resolves in the
  // finally so a normal Stop waits for the real unwind instead of racing it.
  state.emit = emit;
  state.releaseActivity = releaseActivity;
  let settleResolve;
  state.settle = new Promise((resolve) => { settleResolve = resolve; });
  let pendingWorktree = null;
  let pendingWorktreeNeedsSecretPurge = false;
  let projectPath = "";
  let terminalError = null;
  let terminalErrorCode = null;
  activeExec.set(sessionId, state);
  const registerChild = (c) => {
    // If a Stop already landed, trackExecChild refuses the child and we kill it immediately, so no
    // git/provider process ever runs past an accepted Stop (atomic with the spawn — see exec-state).
    // A refused child is never added to state.children, so this fire-and-forget kill is its only
    // termination attempt — log a genuine failure instead of silently orphaning the process.
    if (!trackExecChild(state, c)) {
      terminateProcess(c, { immediate: true })
        .then((killed) => { if (!killed) logError("orphaned execution child could not be killed", String(c.pid ?? "")); })
        .catch(() => {});
    }
  };

  try {
    const session = await getSession(sessionId);
    const project = session.project;
    if (!project?.path) throw expectedApiError("project_path_required", "Attach a project folder (git) first", 400);
    await assertTrustedProject(session);
    if ((session.executions || []).filter((item) => !["merged", "pr_opened", "rejected", "blocked_secret"].includes(item.status)).length >= 20) {
      throw expectedApiError("pending_execution_decisions", "Resolve existing execution decisions before starting more work", 409);
    }
    projectPath = project.path;
    const executor = req.executor, reviewer = req.reviewer, mode = req.mode || "run";
    if (!provider(executor)) throw expectedApiError("executor_unknown", "Unknown executor", 400);
    if (!provider(reviewer)) throw expectedApiError("reviewer_unknown", "Unknown reviewer", 400);
    if (executor === reviewer) throw expectedApiError("executor_reviewer_same", "Executor and reviewer must be different", 400);
    // Reject a review-only provider chosen as executor here — early, before any exec_started/clone, with a
    // dedicated code — rather than late and generic from executor.js's capability guard (which stays as
    // defense in depth). This is the role/capability boundary that makes executor assignment honest.
    if (!provider(executor).capabilities?.executeModes?.includes(mode)) {
      throw expectedApiError("executor_cannot_execute", `${provider(executor).label} has no safe ${mode} execution mode`, 400);
    }
    const task = String(req.task || "").trim();
    if (!task) throw expectedApiError("execution_task_required", "Execution task is empty", 400);

    emit({ type: "exec_started", executor, reviewer, mode });

    // 1) Executor writes (single writer).
    emit({ type: "exec_phase", phase: "executing", agent: executor });
    const execResult = await runExecution({
      projectPath: project.path, executor, mode, task,
      config: { ...(req.agents?.[executor] || {}), connectorSessionId: provider(executor).capabilities?.connectors && Object.values(session.connectors || {}).some((item) => item.enabled) ? session.id : "" },
      onEvent: (event) => emit({ type: "exec_activity", agent: executor, event: event?.text ? { ...event, text: redact(event.text) } : event }),
      registerChild,
      isCancelled: () => execWasCancelled(state),
    });
    pendingWorktree = execResult.worktree;

    const blockSecretExecution = async ({ diff, secretFindings }) => {
      pendingWorktreeNeedsSecretPurge = true;
      // Commit to finalizing before persisting the blocked record. A Stop that already landed makes
      // this throw (the catch discards the clone with its secrets purged); a Stop that lands during the
      // saves below is then refused, so it can't force-finalize the session mid-write.
      if (!enterExecFinalizing(state)) throw new Error(EXEC_STOPPED_MESSAGE);
      emit({ type: "exec_phase", phase: "blocked_secret", agent: executor });
      await mutateSession(sessionId, (current) => {
        current.executions ||= [];
        current.executions.push({
          taskId: execResult.taskId, executor, reviewer, mode, task,
          projectPath: project.path, projectFingerprint: project.fingerprint,
          worktree: execResult.worktree,
          executorText: execResult.text, executorMeta: execResult.meta,
          diff: { files: diff.files, stat: diff.stat, patch: "" },
          secretFindings,
          review: null, status: "blocked_secret", cleanupPending: true, cleanupErrors: [], createdAt: new Date().toISOString(),
        });
      });
      const cleanup = await cleanupExecutionWorkspace(project.path, execResult.worktree, { purgeSecrets: true });
      await mutateSession(sessionId, (current) => {
        const record = findExecution(current, execResult.taskId);
        record.cleanupPending = !cleanup.ok;
        record.cleanupErrors = cleanup.errors.slice(0, 5);
        if (cleanup.ok) record.cleanupCompletedAt = new Date().toISOString();
      });
      pendingWorktree = null;
      pendingWorktreeNeedsSecretPurge = false;
      emit({ type: "exec_secret_blocked", taskId: execResult.taskId, findings: secretFindings });
      emit({ type: "exec_ready", taskId: execResult.taskId });
    };

    // Secret gate: if the change carries secrets, stop before review/commit, discard
    // the isolated clone, and surface the findings (path/rule/line only — never the value).
    if (hasBlockingSecrets(execResult.secretFindings)) {
      await blockSecretExecution(execResult);
      return;
    }

    if (execWasCancelled(state)) throw new Error(EXEC_STOPPED_MESSAGE);

    // Materialize and scan the exact immutable tree that the reviewer and user are asked
    // to approve. Later filesystem changes are never substituted for this tree.
    const reviewSnapshot = await prepareReviewSnapshot({ projectPath: project.path, worktree: execResult.worktree });
    if (reviewSnapshot.blocked) {
      await blockSecretExecution(reviewSnapshot);
      return;
    }
    const reviewedResult = { ...execResult, diff: reviewSnapshot.diff };

    // 2) Reviewer reads the diff (read-only, no writing).
    let review = null;
    if (reviewer && provider(reviewer) && !execWasCancelled(state)) {
      emit({ type: "exec_phase", phase: "reviewing", agent: reviewer });
      const reviewerProvider = provider(reviewer);
      const mcpProject = reviewerProvider.capabilities?.projectTransport === "mcp";
      const releaseScope = mcpProject ? await registerProjectScope(session.id, execResult.worktree.path) : null;
      // Expose the reviewer's scope release to stopExec's force-finalize: if the reviewer is what
      // stalls past the settle window, the local finally below never runs, so finalizeStalledExecStop
      // must free this scope too. The release closure is idempotent, so a later local release no-ops.
      state.releaseProjectScope = releaseScope;
      let r;
      try {
        // registerProjectScope (fs.realpath) above and scratchWorkspacePath() here both await, so a
        // Stop can be accepted between the guard on the `if` above and the spawn below. Re-check after
        // the last await and before running, so an accepted Stop never starts the reviewer process —
        // the registerChild guard only kills *after* spawn. The finally still releases the scope.
        const cwd = mcpProject ? await scratchWorkspacePath() : execResult.worktree.path;
        if (execWasCancelled(state)) throw new Error(EXEC_STOPPED_MESSAGE);
        r = await reviewerProvider.run({
          prompt: reviewPrompt(task, reviewedResult),
          config: { ...(req.agents?.[reviewer] || {}), permission: mcpProject ? "project" : "planread", mcpSessionId: mcpProject ? session.id : "" },
          cwd,
          onEvent: (event) => emit({ type: "exec_activity", agent: reviewer, event: event?.text ? { ...event, text: redact(event.text) } : event }),
          registerChild,
        });
      } finally {
        releaseScope?.();
        state.releaseProjectScope = null;
      }
      review = { agent: reviewer, text: redact(r.text), meta: { model: r.model ?? null, durationMs: r.durationMs ?? null, outputTruncated: Boolean(r.outputTruncated), usage: r.usage ?? null } };
    }

    if (execWasCancelled(state)) throw new Error(EXEC_STOPPED_MESSAGE);
    const postReviewSnapshot = await prepareReviewSnapshot({ projectPath: project.path, worktree: execResult.worktree });
    if (postReviewSnapshot.treeSha !== reviewSnapshot.treeSha) {
      pendingWorktreeNeedsSecretPurge = true;
      throw new Error("Execution files changed while they were being reviewed; run the task again");
    }

    // 3) Store the execution record, awaiting the user's decision.
    const record = {
      taskId: execResult.taskId, executor, reviewer, mode, task,
      projectPath: project.path, projectFingerprint: project.fingerprint,
      worktree: execResult.worktree,
      reviewedTree: reviewSnapshot.treeSha,
      executorText: execResult.text, executorMeta: execResult.meta,
      diff: { files: reviewSnapshot.diff.files, stat: reviewSnapshot.diff.stat, patch: String(reviewSnapshot.diff.patch).slice(0, 200000) },
      secretFindings: reviewSnapshot.secretFindings,
      review, status: "awaiting_user", createdAt: new Date().toISOString(),
    };
    // Commit to finalizing before persisting the awaiting_user record. A Stop that already landed makes
    // this throw (the catch discards the clone); a Stop that lands during the save/emit below is then
    // refused, so it can't force-finalize the session mid-write and race a spurious exec_error.
    if (!enterExecFinalizing(state)) throw new Error(EXEC_STOPPED_MESSAGE);
    await mutateSession(sessionId, (current) => {
      current.executions ||= [];
      current.executions.push(record);
    });
    pendingWorktree = null;
    emit({ type: "exec_ready", taskId: record.taskId });
  } catch (err) {
    // Always discard this run's isolated workspace, regardless of who wins the terminal claim below
    // — the clone must never linger. The terminal event + activity release are emitted once, in the
    // finally, so a stalled-Stop finalize and this path can't both surface the error or double-free.
    if (pendingWorktree) await cleanupExecutionWorkspace(projectPath, pendingWorktree, { purgeSecrets: pendingWorktreeNeedsSecretPurge });
    terminalError = redact(err?.message || String(err));
    terminalErrorCode = err?.apiCode || (err?.message === EXEC_STOPPED_MESSAGE ? "execution_stopped" : "execution_failed");
    logError("execution failed", terminalError);
  } finally {
    try {
      await Promise.all([...state.children].map((child) => terminateProcess(child)));
    } finally {
      // Claim the single terminal transition. If a stalled Stop already force-finalized this run it
      // claimed "stopped" and released, so this no-ops; otherwise we release the claim exactly once
      // and surface any error the run body raised (including "stopped by user").
      if (claimExecTerminal(state, "finished")) {
        if (activeExec.get(sessionId) === state) activeExec.delete(sessionId);
        releaseActivity();
        if (terminalError) {
          emit({ type: "exec_error", error: terminalError, code: terminalErrorCode });
          try {
            await mutateSession(sessionId, (current) => {
              // Persist the error code with the transcript so a reload after a missed SSE terminal event can
              // localize the specific failure (validation / stop / generic) instead of a generic fallback line.
              current.messages.push({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), author: "system", content: `Execution failed: ${terminalError}`, phase: "exec_error", mode: current.mode, meta: { code: terminalErrorCode } });
            });
          } catch {}
        }
      }
      settleResolve();
    }
  }
}

function findExecution(session, taskId) {
  return (session.executions || []).find((e) => e.taskId === taskId);
}

// Accept: "merge" keeps the change on the local branch; "pr" pushes + opens a GitHub PR.
export async function acceptExecution(sessionId, taskId, action = "merge") {
  if (action !== "merge" && action !== "pr") throw new Error("Unsupported accept action");
  return withDecisionLock(sessionId, taskId, async () => {
    const retryableStatus = action === "pr" ? "accepted_pending_pr" : "accepted_pending_merge";
    const acceptingStatus = action === "pr" ? "accepting_pr" : "accepting_merge";
    const claim = await mutateSession(sessionId, async (session) => {
      const rec = findExecution(session, taskId);
      if (!rec) throw expectedApiError("execution_not_found", "Execution not found", 404);
      if (!["awaiting_user", retryableStatus, acceptingStatus].includes(rec.status)) throw expectedApiError("execution_already_decided", `Execution already ${rec.status}`, 409);
      if (rec.decision && rec.decision !== action) throw expectedApiError("execution_already_decided", `Execution was already accepted for ${rec.decision}`, 409);
      if (!rec.worktree?.approval) throw new Error("This execution predates the secure acceptance format; run the task again");
      if (!rec.projectPath || !rec.projectFingerprint) throw new Error("This execution predates project identity binding; run the task again");
      if (!rec.reviewedTree) throw new Error("This execution predates reviewed-tree binding; run the task again");
      if (action === "pr") {
        const publication = await assertProjectReady(rec.projectPath, rec.worktree, { acceptedCommit: rec.acceptedCommit });
        githubRepository(publication.remoteUrl);
      }
      if (!rec.acceptedAt) {
        rec.acceptedAt = new Date().toISOString();
        recordDecision(session, { type: "execution", outcome: "accepted", taskId, metadata: { action } });
      }
      rec.status = acceptingStatus;
      rec.decision = action;
      return { projectPath: rec.projectPath, projectFingerprint: rec.projectFingerprint, rec: structuredClone(rec) };
    });
    let rec = claim.rec;
    const projectPath = claim.projectPath;
    try {
      const identity = await projectIdentity(projectPath);
      if (identity.realPath !== projectPath || identity.fingerprint !== claim.projectFingerprint) {
        throw new Error("Project identity or origin changed after this execution was reviewed; run it again");
      }
      if (!rec.acceptedCommit) {
        const prepared = await prepareAcceptedChange({
          projectPath,
          worktree: rec.worktree,
          reviewedTree: rec.reviewedTree,
          message: `Codebate: ${String(rec.task).slice(0, 60)}`,
        });
        if (prepared.blocked) {
          await mutateSession(sessionId, (session) => {
            const current = findExecution(session, taskId);
            Object.assign(current, {
              diff: { files: prepared.diff.files, stat: prepared.diff.stat, patch: "" },
              secretFindings: prepared.secretFindings,
              status: "blocked_secret",
              decidedAt: new Date().toISOString(),
              decision: "blocked_at_accept",
              cleanupPending: true,
              cleanupErrors: [],
            });
            recordDecision(session, { type: "execution", outcome: "blocked_secret", taskId, metadata: { requestedAction: action } });
          });
          const cleanup = await cleanupExecutionWorkspace(projectPath, rec.worktree, { purgeSecrets: true });
          await mutateSession(sessionId, (session) => {
            const current = findExecution(session, taskId);
            current.cleanupPending = !cleanup.ok;
            current.cleanupErrors = cleanup.errors.slice(0, 5);
            if (cleanup.ok) current.cleanupCompletedAt = new Date().toISOString();
          });
          return { status: "blocked_secret", findings: prepared.secretFindings, cleanupPending: !cleanup.ok };
        }
        rec = await mutateSession(sessionId, (session) => {
          const current = findExecution(session, taskId);
          Object.assign(current, {
            diff: { files: prepared.diff.files, stat: prepared.diff.stat, patch: String(prepared.diff.patch).slice(0, 200000) },
            secretFindings: prepared.secretFindings,
            acceptedCommit: prepared.commitSha,
            acceptedTree: prepared.treeSha,
            acceptedRef: prepared.acceptedRef,
          });
          return structuredClone(current);
        });
      }

      let result = {};
      if (action === "pr") {
        const publication = await assertProjectReady(projectPath, rec.worktree);
        const repository = githubRepository(publication.remoteUrl);
        await pushBranch(projectPath, rec.worktree, rec.acceptedCommit, rec.acceptedRef);
        const { title, body } = pullRequestContent(rec);
        result = { prUrl: await openPullRequest({ projectPath, branch: rec.worktree.branch, title, body, repository }) };
      } else {
        await assertProjectReady(projectPath, rec.worktree, { acceptedCommit: rec.acceptedCommit });
        await mergeBranch(projectPath, rec.worktree, rec.acceptedCommit, rec.acceptedRef);
      }
      // Persist the externally visible terminal result before cleanup. A crash
      // after the PR/merge must not leave a retry state whose local branch is gone.
      await mutateSession(sessionId, (session) => {
        const current = findExecution(session, taskId);
        Object.assign(current, {
          status: action === "pr" ? "pr_opened" : "merged",
          decidedAt: new Date().toISOString(),
          decision: action,
          cleanupPending: true,
          cleanupErrors: [],
          ...result,
        });
      });
      const cleanup = await cleanupExecutionWorkspace(projectPath, rec.worktree, {
        acceptedRef: rec.acceptedRef,
        acceptedCommit: rec.acceptedCommit,
      });
      await mutateSession(sessionId, (session) => {
        const current = findExecution(session, taskId);
        current.cleanupPending = !cleanup.ok;
        current.cleanupErrors = cleanup.errors.slice(0, 5);
        if (cleanup.ok) current.cleanupCompletedAt = new Date().toISOString();
      });
      return { status: action === "pr" ? "pr_opened" : "merged", cleanupPending: !cleanup.ok, ...result };
    } catch (error) {
      await mutateSession(sessionId, (session) => {
        const current = findExecution(session, taskId);
        if (current?.status === acceptingStatus) current.status = retryableStatus;
      }).catch(() => {});
      throw error;
    }
  });
}

// Reject: discard the executor's worktree and branch entirely.
export async function rejectExecution(sessionId, taskId) {
  return withDecisionLock(sessionId, taskId, async () => {
    const claim = await mutateSession(sessionId, (session) => {
      const rec = findExecution(session, taskId);
      if (!rec) throw expectedApiError("execution_not_found", "Execution not found", 404);
      if (!["awaiting_user", "rejected_cleanup_pending"].includes(rec.status)) throw expectedApiError("execution_already_decided", `Execution already ${rec.status}`, 409);
      rec.status = "rejecting";
      rec.decision = "reject";
      if (!rec.decidedAt) {
        rec.decidedAt = new Date().toISOString();
        recordDecision(session, { type: "execution", outcome: "rejected", taskId });
      }
      return { projectPath: rec.projectPath || session.project.path, rec: structuredClone(rec) };
    });
    const cleanup = claim.rec.worktree?.path
      ? await removeWorktree(claim.projectPath, claim.rec.worktree.path, claim.rec.worktree.branch, { isolation: claim.rec.worktree.isolation })
      : { ok: true, errors: [] };
    await mutateSession(sessionId, (session) => {
      const current = findExecution(session, taskId);
      if (current?.status !== "rejecting") throw new Error("Execution decision changed while rejecting");
      current.status = cleanup.ok ? "rejected" : "rejected_cleanup_pending";
      current.decidedAt ||= new Date().toISOString();
      current.cleanupPending = !cleanup.ok;
      current.cleanupErrors = cleanup.errors.slice(0, 5);
      if (cleanup.ok) current.cleanupCompletedAt = new Date().toISOString();
    });
    if (!cleanup.ok) throw new Error(`Change was rejected, but cleanup is still pending: ${cleanup.errors[0]}`);
    return { status: "rejected" };
  });
}
