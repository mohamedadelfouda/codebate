import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createExecAttempt,
  execWasCancelled,
  requestExecCancellation,
  trackExecChild,
  claimExecTerminal,
  enterExecFinalizing,
  execIsFinalizing,
} from "../../server/exec-state.js";

// A child stand-in that only needs `.once("close", …)` — the same surface trackExecChild uses.
function fakeChild() {
  const emitter = new EventEmitter();
  emitter.close = () => emitter.emit("close");
  return emitter;
}

test("a fresh execution attempt starts running with no children", () => {
  const attempt = createExecAttempt();
  assert.equal(attempt.status, "running");
  assert.equal(attempt.children.size, 0);
  assert.equal(execWasCancelled(attempt), false);
});

test("requesting cancellation transitions running → cancelling exactly once", () => {
  const attempt = createExecAttempt();
  assert.equal(requestExecCancellation(attempt), true);
  assert.equal(attempt.status, "cancelling");
  assert.equal(execWasCancelled(attempt), true);
  // A second request finds it already cancelling and is refused, so stopExec won't re-terminate.
  assert.equal(requestExecCancellation(attempt), false);
});

test("cancellation cannot be requested once the run is terminal", () => {
  const attempt = createExecAttempt();
  claimExecTerminal(attempt, "finished");
  assert.equal(requestExecCancellation(attempt), false);
  assert.equal(attempt.status, "finished");
});

test("a child spawned while running is tracked and removed when it closes", () => {
  const attempt = createExecAttempt();
  const child = fakeChild();
  assert.equal(trackExecChild(attempt, child), true);
  assert.equal(attempt.children.has(child), true);
  child.close();
  assert.equal(attempt.children.has(child), false);
});

test("trackExecChild runs its onClose hook when the child exits", () => {
  const attempt = createExecAttempt();
  const child = fakeChild();
  let closed = null;
  trackExecChild(attempt, child, (c) => { closed = c; });
  child.close();
  assert.equal(closed, child);
});

test("a child spawned after cancellation is refused (never tracked) so the caller kills it", () => {
  const attempt = createExecAttempt();
  requestExecCancellation(attempt);
  const child = fakeChild();
  // The atomic guard: once a Stop landed, registration is refused so no new process runs past it.
  assert.equal(trackExecChild(attempt, child), false);
  assert.equal(attempt.children.has(child), false);
});

test("a child spawned after a terminal stop is likewise refused", () => {
  const attempt = createExecAttempt();
  claimExecTerminal(attempt, "stopped");
  assert.equal(execWasCancelled(attempt), true);
  assert.equal(trackExecChild(attempt, fakeChild()), false);
});

test("a child spawned after the run finished is refused — no orphan process past the run's end", () => {
  const attempt = createExecAttempt();
  claimExecTerminal(attempt, "finished");
  // `finished` is terminal but not a *cancellation*; the guard is `status !== "running"`, so a late
  // child (after which no stopExec/finally is left to kill it) is still refused. execWasCancelled
  // alone would have let it through.
  assert.equal(execWasCancelled(attempt), false);
  assert.equal(trackExecChild(attempt, fakeChild()), false);
});

test("finalizing is a committed, non-cancellable state entered only from running", () => {
  const attempt = createExecAttempt();
  assert.equal(enterExecFinalizing(attempt), true);
  assert.equal(attempt.status, "finalizing");
  assert.equal(execIsFinalizing(attempt), true);
  // A Stop landing during the final save is refused, so it can't force-finalize the session mid-write.
  assert.equal(requestExecCancellation(attempt), false);
  // Finalizing is committed-to-finish, not cancelled — so the run body proceeds with its save.
  assert.equal(execWasCancelled(attempt), false);
  // A child must not spawn during finalizing (nothing left to track/kill it).
  assert.equal(trackExecChild(attempt, fakeChild()), false);
  // Only reachable from running: a second attempt is refused.
  assert.equal(enterExecFinalizing(attempt), false);
  // It settles to finished via the normal terminal claim.
  assert.equal(claimExecTerminal(attempt, "finished"), true);
  assert.equal(attempt.status, "finished");
});

test("a Stop that already won blocks entering finalizing, so the caller aborts the save", () => {
  const attempt = createExecAttempt();
  requestExecCancellation(attempt); // Stop landed first
  assert.equal(enterExecFinalizing(attempt), false);
  assert.equal(attempt.status, "cancelling");
});

test("the terminal transition is claimed exactly once", () => {
  const attempt = createExecAttempt();
  assert.equal(claimExecTerminal(attempt, "finished"), true);
  assert.equal(attempt.status, "finished");
  // Whoever comes second — the body's finally or a stalled-stop finalize — gets false and no-ops.
  assert.equal(claimExecTerminal(attempt, "finished"), false);
  assert.equal(claimExecTerminal(attempt, "stopped"), false);
});

test("a forced stop wins the terminal claim over a later finished claim", () => {
  const attempt = createExecAttempt();
  requestExecCancellation(attempt);
  assert.equal(claimExecTerminal(attempt, "stopped"), true);
  // The body unwinding afterwards must not double-finalize.
  assert.equal(claimExecTerminal(attempt, "finished"), false);
  assert.equal(attempt.status, "stopped");
});

test("claiming an invalid terminal status is rejected", () => {
  const attempt = createExecAttempt();
  assert.throws(() => claimExecTerminal(attempt, "running"), /Invalid terminal execution status/);
  assert.throws(() => claimExecTerminal(attempt, "cancelling"), /Invalid terminal execution status/);
});
