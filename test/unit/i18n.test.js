import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  connectorActionKeys,
  connectorLabelKey,
  connectorStatusKey,
  decisionActionKey,
  decisionOutcomeKey,
  decisionTypeKey,
  discussionOutcomeReport,
  errorMessageKey,
  formatLocaleDuration,
  formatMessageCount,
  formatLocaleNumber,
  localeId,
} from "../../public/i18n-core.js";
import { STRINGS as catalog } from "../../public/strings.js";

const html = fs.readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");

test("Arabic and English catalogs have identical keys and value types", () => {
  const arabicKeys = Object.keys(catalog.ar).sort();
  const englishKeys = Object.keys(catalog.en).sort();
  assert.deepEqual(arabicKeys, englishKeys);
  for (const key of arabicKeys) assert.equal(typeof catalog.ar[key], typeof catalog.en[key], key);
});

test("every static HTML translation hook exists in both catalogs", () => {
  const keys = [...html.matchAll(/data-i18n(?:-ph|-title|-aria-label)?=["']([^"']+)["']/g)].map((match) => match[1]);
  assert.ok(keys.length > 0);
  for (const key of new Set(keys)) {
    assert.ok(key in catalog.ar, `missing Arabic translation: ${key}`);
    assert.ok(key in catalog.en, `missing English translation: ${key}`);
  }
});

test("locale formatters use explicit Arabic and English locales", () => {
  assert.equal(localeId("ar"), "ar-EG");
  assert.equal(localeId("en"), "en-GB");
  assert.notEqual(formatLocaleNumber("ar", 1234), formatLocaleNumber("en", 1234));
  assert.notEqual(formatLocaleDuration("ar", 65000), formatLocaleDuration("en", 65000));
  assert.equal(formatLocaleDuration("en", Number.NaN), "");
  assert.equal(formatMessageCount("en", 1), "1 message");
  assert.equal(formatMessageCount("en", 2), "2 messages");
  assert.equal(formatMessageCount("ar", 1), "رسالة واحدة");
  assert.equal(formatMessageCount("ar", 2), "رسالتان");
  assert.match(formatMessageCount("ar", 3), /رسائل/);
});

test("known API, connector, and decision identifiers resolve to catalog keys", () => {
  assert.equal(errorMessageKey({ code: "session_busy" }), "errorSessionBusy");
  assert.equal(errorMessageKey({ code: "invalid_finalizer" }), "errorInvalidFinalizer");
  assert.equal(errorMessageKey({ code: "provider_unavailable" }), "errorProviderUnavailable");
  assert.equal(errorMessageKey({ route: { reasonCode: "project_trust_required" } }), "routeProjectTrustRequired");
  assert.equal(errorMessageKey({ code: "future_error" }), "errorUnexpected");
  // P0-3b: server execution errors now carry codes the client localizes (no hardcoded server strings).
  assert.equal(errorMessageKey({ code: "executor_unknown" }), "errorExecutorUnknown");
  assert.equal(errorMessageKey({ code: "reviewer_unknown" }), "errorReviewerUnknown");
  assert.equal(errorMessageKey({ code: "executor_reviewer_same" }), "errorExecutorReviewerSame");
  assert.equal(errorMessageKey({ code: "executor_cannot_execute" }), "errorExecutorCannotExecute");
  assert.equal(errorMessageKey({ code: "execution_task_required" }), "errorExecutionTaskRequired");
  assert.equal(errorMessageKey({ code: "execution_stopped" }), "errorExecutionStopped");
  assert.equal(errorMessageKey({ code: "execution_failed" }), "executionFailed");
  assert.equal(connectorLabelKey("gmail"), "connectorGmail");
  assert.equal(connectorActionKeys("gmail", "send_message").label, "actionGmailSendMessage");
  assert.equal(connectorStatusKey("pending"), "actionPending");
  assert.equal(decisionTypeKey("connector_action"), "decisionTypeConnectorAction");
  assert.equal(decisionOutcomeKey("approved"), "decisionOutcomeApproved");
  assert.equal(decisionActionKey("merge"), "decisionActionMerge");

  const mappedKeys = [
    errorMessageKey({ code: "session_busy" }),
    errorMessageKey({ code: "invalid_finalizer" }),
    errorMessageKey({ code: "provider_unavailable" }),
    errorMessageKey({ route: { reasonCode: "project_trust_required" } }),
    errorMessageKey({ code: "executor_unknown" }),
    errorMessageKey({ code: "reviewer_unknown" }),
    errorMessageKey({ code: "executor_reviewer_same" }),
    errorMessageKey({ code: "executor_cannot_execute" }),
    errorMessageKey({ code: "execution_task_required" }),
    errorMessageKey({ code: "execution_stopped" }),
    errorMessageKey({ code: "execution_failed" }),
    connectorLabelKey("gmail"),
    ...Object.values(connectorActionKeys("gmail", "send_message")),
    connectorStatusKey("pending"),
    decisionTypeKey("connector_action"),
    decisionOutcomeKey("approved"),
    decisionActionKey("merge"),
  ];
  for (const key of mappedKeys) {
    assert.ok(key in catalog.ar, `mapped key missing from Arabic catalog: ${key}`);
    assert.ok(key in catalog.en, `mapped key missing from English catalog: ${key}`);
  }
});

test("discussionOutcomeReport renders the structured outcome in the reader's language", () => {
  // A missing / truncated outcome yields empty text so the caller falls back to the stored content. Only a
  // complete, server-stamped outcome (outcomeVersion 1, set atomically with every field) renders.
  assert.deepEqual(discussionOutcomeReport(null), { text: "", items: [] });
  assert.deepEqual(discussionOutcomeReport({}), { text: "", items: [] });
  assert.deepEqual(discussionOutcomeReport({ phase: "converged" }), { text: "", items: [] }); // no completedRounds
  assert.deepEqual(discussionOutcomeReport({ phase: "converged", completedRounds: 3 }), { text: "", items: [] }); // truncated: no outcomeVersion

  const converged = { outcomeVersion: 1, phase: "converged", completedRounds: 3, stoppedEarly: false };
  assert.match(discussionOutcomeReport(converged, "en").text, /agreed.*final round \(3\)/);
  assert.match(discussionOutcomeReport(converged, "ar").text, /الجولة الأخيرة/);
  assert.notEqual(discussionOutcomeReport(converged, "en").text, discussionOutcomeReport(converged, "ar").text);
  // Arabic renders locale-consistent Arabic-Indic digits, not Western ones.
  assert.match(discussionOutcomeReport(converged, "ar").text, /٣/);
  assert.deepEqual(discussionOutcomeReport(converged, "en").items, []);

  const early = { outcomeVersion: 1, phase: "converged", completedRounds: 2, stoppedEarly: true };
  assert.match(discussionOutcomeReport(early, "en").text, /remaining rounds were stopped/);

  // needs_user carries the pending items as separate bullet lines, not baked into the sentence.
  const needsUser = { outcomeVersion: 1, phase: "needs_user", completedRounds: 4, pendingItems: [{ text: "Confirm the API budget" }, { text: "Pick a region" }] };
  const nu = discussionOutcomeReport(needsUser, "en");
  assert.match(nu.text, /needs your decision/);
  assert.deepEqual(nu.items, ["Confirm the API budget", "Pick a region"]);
  assert.match(discussionOutcomeReport(needsUser, "ar").text, /قرارك/);

  // blocked_external also carries the pending items.
  const blocked = { outcomeVersion: 1, phase: "blocked_external", completedRounds: 3, pendingItems: [{ text: "Await CI" }] };
  const be = discussionOutcomeReport(blocked, "en");
  assert.match(be.text, /awaits verification or an external step/);
  assert.deepEqual(be.items, ["Await CI"]);

  const disagreement = { outcomeVersion: 1, phase: "unresolved", completedRounds: 5, disagreements: ["Cache strategy", "Error handling"] };
  const dz = discussionOutcomeReport(disagreement, "en");
  assert.match(dz.text, /disagreement/);
  assert.deepEqual(dz.items, ["Cache strategy", "Error handling"]);

  const invalidControl = { outcomeVersion: 1, phase: "unresolved", completedRounds: 6, stopReason: "invalid_control" };
  assert.match(discussionOutcomeReport(invalidControl, "en").text, /control data was missing or invalid/);
  assert.deepEqual(discussionOutcomeReport(invalidControl, "en").items, []);

  // With a blocking provider recorded, the browser renderer NAMES it and surfaces raised points (mirrors the
  // server's honest report) instead of the generic "control data was invalid" message.
  const controlBlocked = {
    outcomeVersion: 1, phase: "unresolved", completedRounds: 5, stopReason: "invalid_control",
    proposedDisagreements: ["polling vs hook"],
    roundDiagnostics: [{ round: 5, controlFailures: [{ agent: "codex" }] }],
  };
  const blockedEn = discussionOutcomeReport(controlBlocked, "en");
  assert.match(blockedEn.text, /Codex/);
  assert.match(blockedEn.text, /technical reason/);
  assert.deepEqual(blockedEn.items, ["polling vs hook"]);
  assert.match(discussionOutcomeReport(controlBlocked, "ar").text, /Codex/);

  // converged-but-incomplete (unfinished agreement) carries the pending items.
  const incomplete = { outcomeVersion: 1, phase: "unresolved", completedRounds: 4, agreementState: "converged", completionState: "incomplete", pendingItems: [{ text: "Write tests" }] };
  const inc = discussionOutcomeReport(incomplete, "ar");
  assert.match(inc.text, /تحتاج شغلًا إضافيًا/);
  assert.deepEqual(inc.items, ["Write tests"]);

  const fallback = { outcomeVersion: 1, phase: "unresolved", completedRounds: 7 };
  assert.match(discussionOutcomeReport(fallback, "en").text, /without a final, adoptable agreement/);
  assert.match(discussionOutcomeReport(fallback, "ar").text, /من غير اتفاق نهائي/);
});
