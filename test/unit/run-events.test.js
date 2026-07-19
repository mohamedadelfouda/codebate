import test from "node:test";
import assert from "node:assert/strict";
import { shouldHandleRunEvent } from "../../public/run-events.js";

test("run-scoped UI events are accepted only for the current attempt", () => {
  assert.equal(shouldHandleRunEvent(null, { type: "run_started", runId: "run-new" }), true);
  assert.equal(shouldHandleRunEvent("run-new", { type: "run_started", runId: "run-old" }), false);
  assert.equal(shouldHandleRunEvent(null, { type: "agent_complete", runId: "run-old" }), false);
  assert.equal(shouldHandleRunEvent("run-new", { type: "agent_start", runId: "run-new" }), true);
  assert.equal(shouldHandleRunEvent("run-new", { type: "run_error", runId: "run-old" }), false);
  assert.equal(shouldHandleRunEvent("run-new", { type: "session_updated", runId: "run-old" }), true);
});
