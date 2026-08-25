import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildDiscussionOutcome,
  discussionOutcomeReport as serverDiscussionOutcomeReport,
} from "../../server/orchestrator.js";
import { discussionOutcomeReport as browserDiscussionOutcomeReport } from "../../public/i18n-core.js";
import { STRINGS as catalog } from "../../public/strings.js";

const appSource = fs.readFileSync(new URL("../../public/app.js", import.meta.url), "utf8");

// RED contract for the public/user-facing half of degraded_ledger_conflict.
//
// The engine-level RED spec in session-scenarios.test.js defines when a stable, readable
// ledger-only conflict may stop after the persistence bound. This companion regression defines
// what must happen AFTER that assessment leaves the convergence engine.
//
// Critical safety property: a bounded stop with a LIVE item-action conflict is terminal but NOT
// adoptable agreement. `public/app.js` only exposes the Execute CTA for phase:"converged", so this
// outcome must remain non-converged while preserving the distinct stop reason. Both renderers must
// then explain the ledger disagreement instead of inventing malformed/unreadable control data.
//
// Skipped until the engine change lands. Unskip together with the engine-level RED spec.
test("scenario · RED outcome: degraded ledger conflict stays unresolved, keeps its reason, and never blames unreadable controls", {
  skip: "public outcome/renderers do not yet model degraded_ledger_conflict as a non-adoptable terminal stop",
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

  // P1 contract: bounded != agreed. Keeping this out of `converged` is what prevents the browser's
  // Execute CTA from treating a still-conflicted plan as adoptable.
  assert.equal(outcome.phase, "unresolved");
  assert.notEqual(outcome.phase, "converged");
  assert.equal(outcome.agreementState, "open");
  assert.equal(outcome.sealDegraded, true);
  assert.equal(outcome.controlsParseable, true);
  assert.equal(outcome.stopReason, "degraded_ledger_conflict");
  assert.deepEqual(outcome.conflicts, [{ code: "conflicting_item_actions", itemId: "item-003" }]);

  const serverReport = serverDiscussionOutcomeReport(outcome);
  assert.match(serverReport, /تعارض|اختلاف/);
  assert.match(serverReport, /السجل|البنود|الإجراءات/);
  assert.doesNotMatch(serverReport, /غير مقروء|غير صالحة|موقفه الفعلي غير معروف|بيانات تحكم أحد المشاركين/);

  // The conversation UI does NOT render the server string: public/app.js renders meta.outcome through
  // public/i18n-core.js. Protect that shipped path in BOTH locales.
  const browserAr = browserDiscussionOutcomeReport(outcome, "ar").text;
  assert.match(browserAr, /تعارض|اختلاف/);
  assert.match(browserAr, /السجل|البنود|الإجراءات/);
  assert.doesNotMatch(browserAr, /غير مقروء|ماكانتش مقروءة|غير صالحة|موقفها الفعلي غير معروف|بيانات التحكم من/);

  const browserEn = browserDiscussionOutcomeReport(outcome, "en").text;
  assert.match(browserEn, /conflict|disagree/i);
  assert.match(browserEn, /ledger|item|action/i);
  assert.doesNotMatch(browserEn, /couldn't be read|unreadable|invalid control|actual position is unknown/i);
});

// The decision card has a separate status-label path in public/app.js. A distinct stop reason must not
// fall through to stopInvalidControl even if the narrative renderer is correct. Keep this as a RED public
// contract so the eventual implementation adds a dedicated bilingual label and wires the decision card to it.
test("scenario · RED browser status: degraded ledger conflict has a dedicated bilingual decision-card label", {
  skip: "browser stop-reason mapping/catalog do not yet include degraded_ledger_conflict",
}, () => {
  assert.match(appSource, /degraded_ledger_conflict\s*:\s*["']stopDegradedLedgerConflict["']/);
  assert.match(appSource, /outcomeLabel\(["']stopReason["'],\s*outcome\.stopReason\)/);

  assert.equal(typeof catalog.ar.stopDegradedLedgerConflict, "string");
  assert.equal(typeof catalog.en.stopDegradedLedgerConflict, "string");
  assert.match(catalog.ar.stopDegradedLedgerConflict, /خلاف|تعارض|اختلاف/);
  assert.doesNotMatch(catalog.ar.stopDegradedLedgerConflict, /بيانات الحالة|غير مقروء|غير صالحة/);
  assert.match(catalog.en.stopDegradedLedgerConflict, /conflict|disagree/i);
  assert.doesNotMatch(catalog.en.stopDegradedLedgerConflict, /invalid|unreadable|control data/i);

  // P1 execution guard: unresolved terminal outcomes must remain outside the one phase that exposes
  // "Start execution". This guards the actual browser gate while the engine contract above guards phase.
  assert.match(appSource, /latestRunFinalReport\(\)\?\.phase\s*===\s*["']converged["']\)\s*renderProceedToExecute/);
});
