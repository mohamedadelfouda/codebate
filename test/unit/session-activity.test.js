import test from "node:test";
import assert from "node:assert/strict";
import { claimSessionActivity, sessionActivity } from "../../server/session-activity.js";

test("one atomic claim covers orchestration and execution for the same session", () => {
  const id = `activity-${process.pid}-${Date.now()}`;
  const release = claimSessionActivity(id, "orchestration");
  assert.equal(sessionActivity(id), "orchestration");

  assert.throws(
    () => claimSessionActivity(id, "execution"),
    (error) => error.apiStatus === 409 && error.apiCode === "session_busy",
  );

  release();
  release();
  assert.equal(sessionActivity(id), "");

  const releaseExecution = claimSessionActivity(id, "execution");
  assert.equal(sessionActivity(id), "execution");
  releaseExecution();
});
