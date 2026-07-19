import test from "node:test";
import assert from "node:assert/strict";
import { discussionOutcomeReport } from "../../server/orchestrator.js";

// A non-terminal outcome that stopped on invalid_control (terminalOutcomeReport returns null → unfinished path).
function invalidControlOutcome(overrides = {}) {
  return {
    phase: "unfinished",
    completedRounds: 5,
    stopReason: "invalid_control",
    controlsParseable: false,
    proposedDisagreements: [],
    disagreements: [],
    pendingItems: [],
    roundDiagnostics: [],
    ...overrides,
  };
}

test("invalid_control report names the blocking provider and never says 'raise the rounds'", () => {
  const outcome = invalidControlOutcome({
    roundDiagnostics: [
      { round: 4, controlFailures: [] },
      { round: 5, controlFailures: [{ agent: "cursor", errorCodes: ["invalid_control_schema"], repairStatus: "failed", repairFailureCode: "invalid_control_schema" }] },
    ],
  });
  const report = discussionOutcomeReport(outcome);
  assert.match(report, /Cursor/);                    // names the actual blocker
  assert.match(report, /invalid_control_schema/);    // surfaces the technical code
  assert.match(report, /سبب تقني|لسبب تقني/);        // framed as technical, not a disagreement
  assert.doesNotMatch(report, /ترفع عدد الجولات|جرّب ترفع/); // the misleading advice is gone
});

test("invalid_control report is honest even without per-agent failure data (older sessions)", () => {
  const report = discussionOutcomeReport(invalidControlOutcome());
  assert.match(report, /سبب تقني/);
  assert.doesNotMatch(report, /ترفع عدد الجولات/);
});

test("invalid_control report does not blame a provider that self-corrected before the final round", () => {
  // codex slipped in round 2 but the final round certified everyone; the stop is a consistency conflict, not
  // codex's early slip. The report must NOT name codex — only the final round's failures count as the blocker.
  const outcome = invalidControlOutcome({
    controlsParseable: true,
    roundDiagnostics: [
      { round: 2, controlFailures: [{ agent: "codex", errorCodes: ["invalid_control_json"], repairStatus: "failed" }] },
      { round: 5, controlFailures: [] },
    ],
  });
  const report = discussionOutcomeReport(outcome);
  assert.doesNotMatch(report, /Codex/);
  assert.match(report, /تعارض في بيانات التحكم|سبب تقني/);
});

test("invalid_control report still surfaces proposed disagreement points when parseable", () => {
  // Parseable-but-inconsistent is a distinct case: the controls are valid JSON, the round hit a consistency
  // conflict, and the agents raised real points. Surface the points (another round CAN resolve this).
  const outcome = invalidControlOutcome({
    controlsParseable: true,
    proposedDisagreements: ["مصدر البيانات: getLatestPriceBatch مقابل stocks_batch"],
  });
  const report = discussionOutcomeReport(outcome);
  assert.match(report, /getLatestPriceBatch/);
  assert.match(report, /نقط الاختلاف/);
});

test("invalid_control report surfaces a disagreement even when another control was malformed", () => {
  // Codex review: a valid control can raise a disagreement while a DIFFERENT agent's control is malformed
  // (controlsParseable=false for the round). The report must surface that point and never deny the disagreement.
  const outcome = invalidControlOutcome({
    controlsParseable: false,
    proposedDisagreements: ["الاختيار المعماري: polling مقابل hook"],
    roundDiagnostics: [{ round: 5, controlFailures: [{ agent: "codex", errorCodes: ["invalid_control_json"], repairStatus: "skipped" }] }],
  });
  const report = discussionOutcomeReport(outcome);
  assert.match(report, /Codex/);                      // names the malformed blocker
  assert.match(report, /polling مقابل hook/);         // surfaces the raised disagreement
  assert.doesNotMatch(report, /مش خلاف في المحتوى/);  // does NOT falsely deny the disagreement
});
