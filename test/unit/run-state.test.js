import test from "node:test";
import assert from "node:assert/strict";
import {
  claimRunTerminal,
  createRunAttempt,
  requestRunCancellation,
  requestRunFailure,
  runAcceptsOutput,
  runAttemptRecord,
  runWasCancelled,
} from "../../server/run-state.js";

test("run attempts accept output only while current and non-terminal", () => {
  const attempt = createRunAttempt("collaboration");
  assert.equal(runAcceptsOutput(attempt, attempt), true);
  assert.equal(runAcceptsOutput(null, attempt), false);
  assert.equal(runAttemptRecord(attempt).status, "running");

  assert.equal(requestRunCancellation(attempt), true);
  assert.equal(requestRunCancellation(attempt), false);
  assert.equal(runWasCancelled(attempt), true);
  assert.equal(runAcceptsOutput(attempt, attempt), false);
  assert.equal(claimRunTerminal(attempt, "stopped"), true);
  assert.equal(claimRunTerminal(attempt, "completed"), false);
  assert.equal(runAttemptRecord(attempt).status, "stopped");
});

test("the first provider failure fences siblings before terminal error persistence", () => {
  const attempt = createRunAttempt("chat");
  assert.equal(requestRunFailure(attempt), true);
  assert.equal(requestRunFailure(attempt), false);
  assert.equal(runAcceptsOutput(attempt, attempt), false);
  assert.equal(runWasCancelled(attempt), false);
  assert.equal(claimRunTerminal(attempt, "error"), true);
  assert.equal(runAttemptRecord(attempt).status, "error");
});
