import test from "node:test";
import assert from "node:assert/strict";
import { activityControls } from "../../public/activity-state.js";

test("each activity enables only its matching stop control", () => {
  assert.deepEqual(activityControls(true, "orchestration"), {
    mainStopDisabled: false,
    executionStopHidden: true,
    executionRunDisabled: true,
  });
  assert.deepEqual(activityControls(true, "execution"), {
    mainStopDisabled: true,
    executionStopHidden: false,
    executionRunDisabled: true,
  });
  assert.deepEqual(activityControls(false, "execution"), {
    mainStopDisabled: true,
    executionStopHidden: true,
    executionRunDisabled: false,
  });
});
