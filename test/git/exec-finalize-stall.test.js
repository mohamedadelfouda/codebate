// Deterministic integration test for the finalize-DURING-stall path in exec-orchestrator.js
// (finalizeStalledExecStop + stopExec). This is the one scenario the sibling exec-cancellation.test.js
// can't reach without module mocking: a Stop landing while a *finalizing* run is genuinely stalled
// mid-cleanupExecutionWorkspace (the slow removeWorktree / fs.rm case on the blocked_secret path).
//
// To make it deterministic we mock server/worktree.js's removeWorktree to block (via t.mock.module,
// which needs the --experimental-test-module-mocks flag set in package.json's test scripts) and force
// the blocked_secret branch by mocking hasBlockingSecrets. The orchestrator is imported *after* the
// mocks so its `import { removeWorktree } from "./worktree.js"` binds to the mock; a static import at
// the top of the file would have bound the real module before the mock was installed.
import "./_runtime-isolation.mjs"; // MUST be first — redirects RUNTIME_ROOT before store.js loads.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, getSession, rootPath, saveSession } from "../../server/store.js";
import { projectIdentity } from "../../server/project.js";
import { provider } from "../../server/providers/registry.js";
import { claimSessionActivity } from "../../server/session-activity.js";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

function repository() {
  const dir = mkdtempSync(join(tmpdir(), "ar-exec-stall-"));
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

const execRequest = () => ({ executor: "codex", reviewer: "claude", mode: "run", task: "add a feature", agents: {} });

test("a stop during a stalled finalizing clone-cleanup releases the session silently, and the record still lands", async (t) => {
  const dir = repository();
  const session = await trustedSession("exec-stall-finalizing", dir);
  const events = [];
  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  // settleExec's timeout timer is unref'd, so hold the loop open ourselves through the settle race —
  // otherwise the process can drain while the run is parked in the stalled removeWorktree and the pending
  // promise trips node:test ("Promise resolution is still pending but the event loop has already resolved"),
  // as seen on the Node 22 CI runner (mirrors the sibling stall test in exec-cancellation.test.js).
  const keepLoopAlive = setInterval(() => {}, 25);

  // Stall removeWorktree (keep every other worktree export real — createWorktree must run the real
  // clone). It signals when it's entered (we're now inside the finalizing cleanup) then blocks.
  const realWorktree = await import("../../server/worktree.js");
  t.mock.module("../../server/worktree.js", {
    namedExports: {
      ...realWorktree,
      removeWorktree: async (...args) => {
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        return realWorktree.removeWorktree(...args);
      },
    },
  });
  // Force the blocked_secret branch so finalize runs cleanupExecutionWorkspace inside the finalizing window.
  const realSecretScan = await import("../../server/secret-scan.js");
  t.mock.module("../../server/secret-scan.js", {
    namedExports: { ...realSecretScan, hasBlockingSecrets: () => true },
  });
  // Import the orchestrator now, after the mocks, so it binds them.
  const { runExecuteAndReview, stopExec, isExecuting } = await import("../../server/exec-orchestrator.js");

  // Executor writes a real change; the reviewer is never reached (the secret block precedes review).
  t.mock.method(provider("codex"), "run", async ({ cwd }) => {
    writeFileSync(join(cwd, "feature.txt"), "new feature\n");
    return { text: "executor output", model: "test", durationMs: 1, exitCode: 0 };
  });

  // Declared outside the try so the finally can drain it before teardown.
  const runPromise = runExecuteAndReview(session.id, execRequest(), (event) => events.push(event));
  runPromise.catch(() => {}); // no unhandled rejection if an assertion throws before we await it
  try {
    // Wait until the run has entered finalizing and is blocked inside the stalled removeWorktree.
    await cleanupStarted.promise;
    // The Stop lands during that stalled finalize: requestExecCancellation refuses it, and because the
    // blocked cleanup can't settle within the window, finalizeStalledExecStop releases the session — but
    // silently, because it's finalizing (a committed result), not cancelling.
    const stopResult = await stopExec(session.id, { settleTimeoutMs: 50 });
    assert.deepEqual(stopResult, { stopped: false, status: "already_finished" });
    // (a) The session is freed, never wedged busy: isExecuting is false and a fresh activity claim
    // succeeds (no 409), even though the run body is still blocked in the background.
    assert.equal(isExecuting(session.id), false);
    assert.doesNotThrow(() => claimSessionActivity(session.id, "post-stall-check")());

    releaseCleanup.resolve(); // let the stalled cleanup finish
    await runPromise;

    // (b) The committed result stands: exec_ready fired and exec_error never did — never both.
    assert.equal(events.some((event) => event.type === "exec_ready"), true);
    assert.equal(events.some((event) => event.type === "exec_error"), false);
    // (c) The run body's second save landed after the early release: the blocked_secret record is
    // persisted with cleanup completed, not left pending.
    const saved = await getSession(session.id);
    const record = (saved.executions || []).find((execution) => execution.status === "blocked_secret");
    assert.ok(record, "a blocked_secret execution record was persisted");
    assert.equal(record.cleanupPending, false);
    assert.match(record.cleanupCompletedAt || "", /^\d{4}-\d\d-\d\dT/);
  } finally {
    clearInterval(keepLoopAlive);
    releaseCleanup.resolve();
    // Drain the background run before deleting its session/clone, so a *future* assertion failure above
    // can't race the run's own cleanup writes against this teardown (which would surface a spurious ENOENT).
    await runPromise.catch(() => {});
    await cleanupSession(session.id);
    rmSync(dir, { recursive: true, force: true });
  }
});
