import test from "node:test";
import assert from "node:assert/strict";
import { buildDiscussionOutcome, discussionOutcomeReport } from "../../server/orchestrator.js";

// RED contract for the public/user-facing half of degraded_ledger_conflict.
//
// The engine-level RED spec in session-scenarios.test.js defines when a stable, readable
// ledger-only conflict may stop after the persistence bound. This companion regression defines
// what must happen AFTER that assessment leaves the convergence engine: the orchestrator must
// preserve the distinct stop reason and the report must explain the ledger disagreement, not
// reuse the malformed/unreadable-control explanation from degraded_convergence.
//
// Skipped until the engine change lands. Unskip together with the engine-level RED spec.
test("scenario · RED outcome: degraded ledger conflict keeps its reason and never blames unreadable controls", {
  skip: "public outcome currently rewrites every degraded stop to degraded_convergence — unskip with the readable-ledger degraded path",
}, () => {
  // Shape of the future engine result after the isolated readable conflict persists to its bound.
  // Both controls were parseable/valid; the only unresolved machine disagreement is item-003.
  const assessment = {
    canStop: false,
    degradedStop: true,
    degradable: true,
    agreementState: "open",
    completionState: "blocked",
    stopReason: "degraded_ledger_conflict",
    itemRegistry: [
      {
        itemId: "item-004",
        kind: "external_validation",
        status: "open",
        text: "اعتماد بوابة الإصدار عبر مشغل بشري",
        requiredStep: { actor: "human_operator", action: "run_external_check" },
      },
    ],
    pendingItems: [
      {
        itemId: "item-004",
        kind: "external_validation",
        status: "open",
        text: "اعتماد بوابة الإصدار عبر مشغل بشري",
        requiredStep: { actor: "human_operator", action: "run_external_check" },
      },
    ],
    pendingKinds: ["external_validation"],
    nextSteps: [{ actor: "human_operator", action: "run_external_check", itemIds: ["item-004"] }],
    disagreements: [],
    proposedDisagreements: [],
    unclassifiedPoints: [],
    conflicts: [{ code: "conflicting_item_actions", itemId: "item-003" }],
    allValid: true,
    controlsParseable: true,
    sealedOnQuorum: false,
  };

  const outcome = buildDiscussionOutcome(assessment, 5, 5, null, [
    { round: 5, controlFailures: [], validControlsConverged: true },
  ]);

  assert.equal(outcome.phase, "converged");
  assert.equal(outcome.sealDegraded, true);
  assert.equal(outcome.controlsParseable, true);
  assert.equal(outcome.stopReason, "degraded_ledger_conflict");
  assert.deepEqual(outcome.conflicts, [{ code: "conflicting_item_actions", itemId: "item-003" }]);

  const report = discussionOutcomeReport(outcome);
  // Keep the copy flexible, but require the user-facing explanation to identify a ledger/item-action
  // disagreement rather than inventing an unreadable participant when every control parsed cleanly.
  assert.match(report, /تعارض|اختلاف/);
  assert.match(report, /السجل|البنود|الإجراءات/);
  assert.doesNotMatch(report, /غير مقروء|غير صالحة|موقفه الفعلي غير معروف|بيانات تحكم أحد المشاركين/);
});
