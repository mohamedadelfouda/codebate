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

test("degraded stop reports an unsealed agreement that names the unreadable control — never a completed task", () => {
  const outcome = {
    phase: "converged",
    completedRounds: 4,
    stopReason: "degraded_convergence",
    sealDegraded: true,
    sealedOnQuorum: false,
    stoppedEarly: true,
    completionState: "incomplete",
    pendingItems: [],
    disagreements: [],
    proposedDisagreements: [],
    roundDiagnostics: [
      { round: 3, controlFailures: [] },
      { round: 4, controlFailures: [{ agent: "cursor", errorCodes: ["missing_control"], repairStatus: "skipped" }] },
    ],
  };
  const report = discussionOutcomeReport(outcome);
  assert.match(report, /Cursor/);                 // names the participant whose control was unreadable
  assert.match(report, /مش مختوم رسميًا/);         // says the formal seal failed
  assert.match(report, /تعذّر الختم الرسمي/);      // and why
  assert.doesNotMatch(report, /المهمة اكتملت/);    // must NOT claim the task completed
});

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

test("invalid_control report notes the other valid controls DECLARED convergence, not that agents agreed", () => {
  // Codex review (P2): a bad control block sank a round the OTHER controls declared converged. Report that the
  // valid controls DECLARED convergence (a fact) — not that the agents "actually agreed" (unknowable, since the
  // malformed provider's position is unknown and valid agents answered from the pre-round snapshot).
  const outcome = invalidControlOutcome({
    roundDiagnostics: [{
      round: 5,
      controlFailures: [{ agent: "cursor", errorCodes: ["invalid_control_schema"], repairStatus: "skipped" }],
      validControlsConverged: true,
    }],
  });
  const report = discussionOutcomeReport(outcome);
  assert.match(report, /Cursor/);
  assert.match(report, /أعلنوا التوافق في بيانات التحكم/);
  assert.doesNotMatch(report, /كانوا فعلاً متفقين/);
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
