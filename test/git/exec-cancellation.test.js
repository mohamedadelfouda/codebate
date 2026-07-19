import "./_runtime-isolation.mjs"; // MUST be first — redirects RUNTIME_ROOT before store.js loads.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, projectWorkspaceKey } from "../../server/worktree.js";
import { runExecution } from "../../server/executor.js";
import { runExecuteAndReview, stopExec, isExecuting } from "../../server/exec-orchestrator.js";
import { createSession, executionWorkspacesRoot, getSession, rootPath, saveSession } from "../../server/store.js";
import { projectIdentity } from "../../server/project.js";
import { provider } from "../../server/providers/registry.js";
import { claimSessionActivity } from "../../server/session-activity.js";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

function repository() {
  const dir = mkdtempSync(join(tmpdir(), "ar-exec-cancel-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "owner@example.com");
  git(dir, "config", "user.name", "Project Owner");
  writeFileSync(join(dir, ".gitignore"), ".agent-workspaces/\n");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function nextEventLoopTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function trustedSession(name, dir) {
  const session = await createSession(name);
  const identity = await projectIdentity(dir);
  session.project = { path: identity.realPath, fingerprint: identity.fingerprint, trusted: true, isGit: true, canOpenPr: false };
  await saveSession(session);
  return session;
}

async function cleanupSession(id) {
  const sessions = join(rootPath(), "data", "sessions");
  await Promise.all([
    rm(join(sessions, `${id}.json`), { force: true }),
    rm(join(sessions, `${id}.summary.json`), { force: true }),
  ]);
}

// The out-of-tree bucket for this project's executor should hold no leftover task clones after a stop.
function executorAgentRoot(dir, agent) {
  return join(executionWorkspacesRoot(), projectWorkspaceKey(realpathSync(dir)), agent);
}
function executorWorkspaceCount(dir, agent) {
  const root = executorAgentRoot(dir, agent);
  return existsSync(root) ? readdirSync(root).length : 0;
}

const execRequest = () => ({ executor: "codex", reviewer: "claude", mode: "run", task: "add a feature", agents: {} });

test("createWorktree aborts before cloning when a stop already landed", async () => {
  const dir = repository();
  try {
    await assert.rejects(
      () => createWorktree(dir, "codex", "t-precancel", { isCancelled: () => true }),
      /Execution stopped by user/,
    );
    // The clone must never have started: no workspace tree was created for it.
    assert.equal(executorWorkspaceCount(dir, "codex"), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stop that lands after the clone aborts before the executor runs and cleans up", async (t) => {
  const dir = repository();
  let providerCalled = false;
  // The executor must never launch once a stop is accepted after the clone exists.
  t.mock.method(provider("codex"), "run", async () => {
    providerCalled = true;
    return { text: "must not run", model: "test", durationMs: 1, exitCode: 0 };
  });
  // Report "cancelled" only once the clone directory exists on disk — i.e. after createWorktree's
  // clone step, before the executor is launched. Filesystem-based so it doesn't depend on the exact
  // number of internal cancel checks (which would make the test brittle).
  const cloneExists = () => {
    const agentRoot = executorAgentRoot(dir, "codex");
    if (!existsSync(agentRoot)) return false;
    return readdirSync(agentRoot).some((entry) => existsSync(join(agentRoot, entry, ".git")));
  };

  try {
    await assert.rejects(
      () => runExecution({ projectPath: dir, executor: "codex", mode: "run", task: "add a feature", registerChild: () => {}, isCancelled: cloneExists }),
      /Execution stopped by user/,
    );
    assert.equal(providerCalled, false);
    assert.equal(executorWorkspaceCount(dir, "codex"), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopping mid-execution discards the executor result, cleans the clone, and frees the session", async (t) => {
  const dir = repository();
  const session = await trustedSession("exec-stop-discard", dir);
  const executorStarted = deferred();
  const releaseExecutor = deferred();
  const events = [];

  // The real clone runs; only the provider boundary is mocked, so we can stop while the executor
  // "runs" and prove its output is thrown away rather than stored for a decision.
  t.mock.method(provider("codex"), "run", async () => {
    executorStarted.resolve();
    await releaseExecutor.promise;
    return { text: "executor output", model: "test", durationMs: 1, exitCode: 0 };
  });
  // The reviewer must never run once a stop is accepted before review.
  t.mock.method(provider("claude"), "run", async () => { throw new Error("reviewer must not run after a stop"); });

  try {
    const runPromise = runExecuteAndReview(session.id, execRequest(), (event) => events.push(event));
    await executorStarted.promise;

    const stopPromise = stopExec(session.id);
    await nextEventLoopTurn();
    releaseExecutor.resolve();
    const stopResult = await stopPromise;
    await runPromise;

    assert.equal(stopResult.stopped, true);
    assert.equal(isExecuting(session.id), false);

    const saved = await getSession(session.id);
    // No awaiting_user record — the stopped run left nothing for the user to accept.
    assert.equal((saved.executions || []).some((e) => e.status === "awaiting_user"), false);
    // The isolated clone is gone.
    assert.equal(executorWorkspaceCount(dir, "codex"), 0);
    // The activity claim is released — claiming + releasing again must not throw 409 "busy".
    assert.doesNotThrow(() => claimSessionActivity(session.id, "post-stop-check")());
    // The reviewer was never reached, and the stop surfaced as an exec_error terminal event.
    assert.equal(events.some((e) => e.type === "exec_error"), true);
  } finally {
    releaseExecutor.resolve();
    await cleanupSession(session.id);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stop force-finalizes an execution whose provider never settles", async (t) => {
  const dir = repository();
  const session = await trustedSession("exec-stop-stall", dir);
  const executorStarted = deferred();
  const releaseExecutor = deferred();
  // settleExec's timeout timer is unref'd, so hold the loop open ourselves for the 50ms wait —
  // otherwise the test process could drain during the settle race (seen on the Node 22 CI runner).
  const keepLoopAlive = setInterval(() => {}, 25);
  const events = [];

  t.mock.method(provider("codex"), "run", async () => {
    executorStarted.resolve();
    await releaseExecutor.promise; // stalls until the finally releases it
    return { text: "unreachable", model: "test", durationMs: 1, exitCode: 0 };
  });
  t.mock.method(provider("claude"), "run", async () => { throw new Error("reviewer must not run after a stop"); });

  const runPromise = runExecuteAndReview(session.id, execRequest(), (event) => events.push(event));
  runPromise.catch(() => {});

  try {
    await executorStarted.promise;
    // The body is wedged in the mocked provider, so settle must give up and force-finalize.
    const stopResult = await stopExec(session.id, { settleTimeoutMs: 50 });

    assert.equal(stopResult.stopped, true);
    assert.equal(isExecuting(session.id), false);
    // The activity claim is released even though the body never unwound — the session is usable.
    assert.doesNotThrow(() => claimSessionActivity(session.id, "post-finalize-check")());
    assert.equal(events.some((e) => e.type === "exec_error"), true);

    // Force-finalize freed the session; releasing the wedged provider lets the body unwind, and its
    // own catch/finally still deletes the disposable clone — the stalled path doesn't leak it.
    releaseExecutor.resolve();
    await runPromise;
    assert.equal(executorWorkspaceCount(dir, "codex"), 0);
  } finally {
    clearInterval(keepLoopAlive);
    releaseExecutor.resolve();
    await runPromise.catch(() => {});
    await cleanupSession(session.id);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a run that finalizes to awaiting_user emits exec_ready with no exec_error, and a later stop is a clean no-op", async (t) => {
  const dir = repository();
  const session = await trustedSession("exec-finalize-awaiting", dir);
  const events = [];

  // Both agents succeed: the executor writes a real change, the reviewer approves — so the run reaches
  // the finalizing save and persists an awaiting_user record.
  t.mock.method(provider("codex"), "run", async ({ cwd }) => {
    writeFileSync(join(cwd, "feature.txt"), "new feature\n");
    return { text: "executor output", model: "test", durationMs: 1, exitCode: 0 };
  });
  t.mock.method(provider("claude"), "run", async () => ({ text: "APPROVE — looks correct", model: "test", durationMs: 1, exitCode: 0 }));

  try {
    await runExecuteAndReview(session.id, execRequest(), (event) => events.push(event));

    // The committed result stands: exec_ready fired, and — the guarantee this PR restores — no
    // exec_error was raced against it. The awaiting_user record is persisted for the user's decision.
    assert.equal(events.some((e) => e.type === "exec_ready"), true);
    assert.equal(events.some((e) => e.type === "exec_error"), false);
    const saved = await getSession(session.id);
    assert.equal((saved.executions || []).some((e) => e.status === "awaiting_user"), true);
    assert.equal(isExecuting(session.id), false);

    // The run already finished; a Stop now reports already_finished and must not surface a spurious
    // exec_error after the fact.
    assert.deepEqual(await stopExec(session.id), { stopped: false, status: "already_finished" });
    assert.equal(events.filter((e) => e.type === "exec_error").length, 0);
  } finally {
    await cleanupSession(session.id);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stop accepted after review but before the finalizing commit is honored — no record, session freed", async (t) => {
  const dir = repository();
  const session = await trustedSession("exec-stop-before-finalizing", dir);
  const events = [];
  const reviewerDone = deferred();

  t.mock.method(provider("codex"), "run", async ({ cwd }) => {
    writeFileSync(join(cwd, "feature.txt"), "new feature\n");
    return { text: "executor output", model: "test", durationMs: 1, exitCode: 0 };
  });
  // Resolve the instant review finishes; the run then snapshots and reaches the finalizing gate.
  t.mock.method(provider("claude"), "run", async () => {
    reviewerDone.resolve();
    return { text: "APPROVE", model: "test", durationMs: 1, exitCode: 0 };
  });

  try {
    const runPromise = runExecuteAndReview(session.id, execRequest(), (event) => events.push(event));
    await reviewerDone.promise;
    // stopExec's synchronous requestExecCancellation runs while the run is still unwinding the reviewer /
    // in prepareReviewSnapshot — i.e. before enterExecFinalizing — so the Stop wins the race to the gate:
    // enterExecFinalizing then refuses to commit and the run raises EXEC_STOPPED before any save.
    await stopExec(session.id);
    await runPromise;

    // The Stop won the gate: exec_error terminated the run, exec_ready never fired, nothing was left for
    // the user to accept, and the session is free. The mirror case — a Stop that lands *after*
    // enterExecFinalizing being refused (and a stalled finalize releasing silently) — is covered
    // deterministically at the state-machine level in test/unit/exec-state.test.js; a full end-to-end
    // stop-during-finalizing integration test needs a mutation-injection seam and is tracked as a follow-up.
    assert.equal(events.some((event) => event.type === "exec_error"), true);
    assert.equal(events.some((event) => event.type === "exec_ready"), false);
    const saved = await getSession(session.id);
    assert.equal((saved.executions || []).some((execution) => execution.status === "awaiting_user"), false);
    assert.equal(isExecuting(session.id), false);
    assert.doesNotThrow(() => claimSessionActivity(session.id, "post-stop-before-finalizing")());
  } finally {
    await cleanupSession(session.id);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stopping a session that is not executing reports already_finished", async () => {
  const result = await stopExec("no-such-session");
  assert.deepEqual(result, { stopped: false, status: "already_finished" });
});

test("an execution validation failure surfaces a localizable code, not a hardcoded string", async () => {
  // No project attached — runExecuteAndReview rejects at the first validation gate, before any clone.
  const session = await createSession("exec-validation-code");
  const events = [];
  try {
    await runExecuteAndReview(session.id, execRequest(), (event) => events.push(event));
    const error = events.find((event) => event.type === "exec_error");
    assert.ok(error, "an exec_error event was emitted");
    // The client maps this code → localized text (errorProjectPathRequired) instead of a server-authored string.
    assert.equal(error.code, "project_path_required");
    // The same code is persisted on the transcript message, so a reload after a missed SSE terminal event
    // can localize the specific failure instead of falling back to the generic "execution failed" line.
    const stored = await getSession(session.id);
    const failMessage = stored.messages.filter((message) => message.phase === "exec_error").pop();
    assert.ok(failMessage, "an exec_error message was persisted");
    assert.equal(failMessage.meta?.code, "project_path_required");
    assert.equal(events.some((event) => event.type === "exec_ready"), false);
    assert.equal(isExecuting(session.id), false);
  } finally {
    await cleanupSession(session.id);
  }
});

test("a review-only provider chosen as executor is rejected early with executor_cannot_execute", async () => {
  // claude has no executeModes, so it must be rejected as an executor at the capability gate — before any
  // exec_started / clone — with the dedicated code, not late and generic from executor.js.
  const dir = repository();
  let session;
  const events = [];
  try {
    session = await trustedSession("executor-capability-guard", dir);
    await runExecuteAndReview(session.id, { executor: "claude", reviewer: "codex", mode: "run", task: "add a feature", agents: {} }, (event) => events.push(event));
    const error = events.find((event) => event.type === "exec_error");
    assert.ok(error, "an exec_error event was emitted");
    assert.equal(error.code, "executor_cannot_execute");
    assert.equal(events.some((event) => event.type === "exec_started"), false); // rejected before execution begins
    assert.equal(events.some((event) => event.type === "exec_ready"), false);
    assert.equal(isExecuting(session.id), false);
  } finally {
    // Session setup is inside try so a setup failure still runs cleanup; nested finally guarantees the
    // temp repo is removed even if cleanupSession throws.
    try { if (session) await cleanupSession(session.id); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
