// Cancellation state machine for one execute+review run: exactly one executor writes in a
// disposable clone, then one reviewer reads the captured diff. This mirrors run-state.js for the
// execution pipeline and is kept as pure functions so the stop/cancel race can be unit-tested
// without spawning git or provider child processes.

const TERMINAL_STATUSES = new Set(["stopped", "finished"]);

// The single cancellation-sentinel message, thrown at each pipeline-stage gate and surfaced as the
// terminal exec_error. Centralized so the executor, the worktree builder, and the orchestrator
// (plus the test that pins it) can't drift apart. Mirrors run-state.js owning runInactiveError().
export const EXEC_STOPPED_MESSAGE = "Execution stopped by user";

export function createExecAttempt() {
  return {
    // running → cancelling (a Stop was accepted) → stopped | finished (terminal, claimed once).
    // running → finalizing (committed to persist the result, non-cancellable) → finished.
    status: "running",
    children: new Set(),
  };
}

// True once a Stop has been accepted, or the run already settled as stopped. Threaded into the
// executor pipeline as isCancelled() so each stage can bail before it starts the next child.
export function execWasCancelled(attempt) {
  return attempt.status === "cancelling" || attempt.status === "stopped";
}

// Record a Stop request. Returns false when the run cannot accept one (already cancelling, already
// terminal, or finalizing) so stopExec can report "already stopping" instead of re-running terminate +
// settle a second time.
export function requestExecCancellation(attempt) {
  if (attempt.status !== "running") return false;
  attempt.status = "cancelling";
  return true;
}

// Enter the non-cancellable finalizing state before the run persists its terminal result (the
// awaiting_user record, or a blocked_secret record). Once here, requestExecCancellation refuses a Stop
// (status is no longer `running`), so a Stop cannot force-finalize the session out from under the
// in-flight save and then race a contradictory exec_error against the imminent exec_ready. Returns
// false when the run already left `running` (a Stop won the race first) so the caller aborts the save.
export function enterExecFinalizing(attempt) {
  if (attempt.status !== "running") return false;
  attempt.status = "finalizing";
  return true;
}

// True while the run is committed to persisting its result (past the last cancellation gate). stopExec
// uses this to wait for the run's own finally to emit the terminal event instead of force-finalizing.
export function execIsFinalizing(attempt) {
  return attempt.status === "finalizing";
}

// Track a freshly spawned child. Returns true when tracked (run still live). Returns false once the
// run has left `running` — the child must never run, so the caller kills it immediately. runProcess
// calls this synchronously right after spawn (no await between spawn and this call) and stopExec
// runs on the same single thread, so the check here is atomic with the spawn: a Stop that lands first
// makes this return false (the caller kills the child now); a spawn that wins puts the child in
// `children` for stopExec's terminate loop to kill. No child can slip past an accepted Stop.
// The guard is `status !== "running"`, not `execWasCancelled`: the terminal `finished` and the
// non-cancellable `finalizing` states must reject a late child too — after either, no stopExec or
// finally is left to track or kill it, so it would leak as an orphan process past the run's end.
export function trackExecChild(attempt, child, onClose) {
  if (attempt.status !== "running") return false;
  attempt.children.add(child);
  child.once("close", () => {
    attempt.children.delete(child);
    onClose?.(child);
  });
  return true;
}

// Claim the single terminal transition. The run body's finally claims "finished"; a Stop that has
// to force-finalize a wedged run claims "stopped". Idempotent — the first caller wins, so a stalled
// stop's finalize and the body's own finally never both emit the terminal event or release the
// activity claim.
export function claimExecTerminal(attempt, status) {
  if (!TERMINAL_STATUSES.has(status)) throw new Error(`Invalid terminal execution status: ${status}`);
  if (TERMINAL_STATUSES.has(attempt.status)) return false;
  attempt.status = status;
  return true;
}
