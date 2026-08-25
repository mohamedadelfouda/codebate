import fs from "node:fs";

function edit(path, transform) {
  const before = fs.readFileSync(path, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`${path}: patch made no changes`);
  fs.writeFileSync(path, after);
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`missing patch target: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`patch target not unique: ${label}`);
  return source.slice(0, first) + after + source.slice(first + before.length);
}

edit("server/orchestrator.js", (input) => {
  let s = input;
  s = replaceOnce(
    s,
    'import { assessRound, parseAgentControl, stripAgentControl, validateControlRepair } from "./convergence.js";',
    'import { assessRound, parseAgentControl, stripAgentControl, validateControlRepair } from "./discussion-assessment.js";\nimport { createDegradedPersistenceTracker } from "./degraded-persistence.js";',
    "orchestrator assessment import",
  );
  s = replaceOnce(
    s,
    'function discussionOutcomePhase(assessment) {\n  // A degraded stop IS an agreement among the readable participants (one control was unreadable, so the\n  // formal seal failed). Present it as converged; the sealDegraded flag + the report layer add the honest\n  // caveat and name the excluded participant.\n  if (assessment.degradedStop) return "converged";',
    'function discussionOutcomePhase(assessment) {\n  // A persistent readable ledger split is terminal but still disputed, so it must never become adoptable.\n  if (assessment.degradedStop && assessment.stopReason === "degraded_ledger_conflict") return "unresolved";\n  // The older unreadable-control degraded path remains a readable-side agreement with an honest caveat.\n  if (assessment.degradedStop) return "converged";',
    "ledger terminal phase",
  );
  s = replaceOnce(
    s,
    '    stopReason: assessment.canStop\n      ? assessment.stopReason\n      : assessment.degradedStop ? "degraded_convergence"\n        : assessment.stopReason === "invalid_control" ? "invalid_control" : "round_limit",',
    '    stopReason: (assessment.canStop || assessment.degradedStop)\n      ? assessment.stopReason\n      : assessment.stopReason === "invalid_control" ? "invalid_control" : "round_limit",',
    "preserve degraded reason",
  );
  s = replaceOnce(
    s,
    'function terminalOutcomeReport(outcome) {\n  const round = outcome.completedRounds;\n  if (outcome.phase === "converged") {',
    'function terminalOutcomeReport(outcome) {\n  const round = outcome.completedRounds;\n  if (outcome.phase === "unresolved" && outcome.stopReason === "degraded_ledger_conflict") {\n    return `توقّف النقاش بعد ${round} جولات لأن تعارضًا ثابتًا في إجراءات السجل على البنود ظل مفتوحًا رغم أن مخرجات الوكلاء كانت قابلة للقراءة. النتيجة غير محسومة ولا تُنفّذ حتى يُحسم هذا التعارض.${pendingItemList(outcome)}`;\n  }\n  if (outcome.phase === "converged") {',
    "server ledger report",
  );
  s = replaceOnce(
    s,
    '    let confirmationRoundsRun = 0; // consecutive confirmation rounds so far (bounded by MAX_CONFIRMATION_ROUNDS)\n    let degradedRoundsRun = 0; // consecutive degradable rounds BEFORE the current one (bounded by DEGRADED_STOP_ROUNDS)',
    '    let confirmationRoundsRun = 0; // consecutive confirmation rounds so far (bounded by MAX_CONFIRMATION_ROUNDS)\n    const degradedPersistence = createDegradedPersistenceTracker(DEGRADED_STOP_ROUNDS);',
    "persistence tracker state",
  );
  const oldCounter = '        // Consecutive degradable rounds before this one; once this round would be the DEGRADED_STOP_ROUNDS-th\n        // in a row, allow the honest degraded stop instead of looping to the round limit.\n        degradedRoundsRun = lastAssessment?.degradable === true ? degradedRoundsRun + 1 : 0;\n        const invalidControlExhausted = degradedRoundsRun + 1 >= DEGRADED_STOP_ROUNDS;\n';
  s = replaceOnce(s, oldCounter, '', "collaboration lossy degraded counter");
  s = replaceOnce(
    s,
    '        const roundMessages = await reconcileRound(roundOutcome, minSurvivors);\n        const assessment = await assessRepairedRound(roundMessages, targetVersion, itemRegistry, confirmationsExhausted, invalidControlExhausted);',
    '        const roundMessages = await reconcileRound(roundOutcome, minSurvivors);\n        const degradation = degradedPersistence.boundsFor(roundMessages);\n        const assessment = await assessRepairedRound(roundMessages, targetVersion, itemRegistry, confirmationsExhausted, degradation.exhausted);\n        degradedPersistence.record(assessment, degradation.currentLedgerSignature);',
    "collaboration persistence wiring",
  );
  s = replaceOnce(
    s,
    '        degradedRoundsRun = lastAssessment?.degradable === true ? degradedRoundsRun + 1 : 0;\n        const invalidControlExhausted = degradedRoundsRun + 1 >= DEGRADED_STOP_ROUNDS;\n',
    '',
    "debate lossy degraded counter",
  );
  s = replaceOnce(
    s,
    '        const roundMsgs = await reconcileRound(rebuttalOutcome, minSurvivors);\n        const assessment = await assessRepairedRound(roundMsgs, targetVersion, itemRegistry, confirmationsExhausted, invalidControlExhausted);',
    '        const roundMsgs = await reconcileRound(rebuttalOutcome, minSurvivors);\n        const degradation = degradedPersistence.boundsFor(roundMsgs);\n        const assessment = await assessRepairedRound(roundMsgs, targetVersion, itemRegistry, confirmationsExhausted, degradation.exhausted);\n        degradedPersistence.record(assessment, degradation.currentLedgerSignature);',
    "debate persistence wiring",
  );
  return s;
});

edit("public/i18n-core.js", (input) => replaceOnce(
  input,
  '  if (outcome.phase === "converged") {',
  '  if (outcome.phase === "unresolved" && outcome.stopReason === "degraded_ledger_conflict") {\n    const text = en\n      ? `The discussion stopped after ${round} rounds because a readable ledger item-action conflict persisted. The outcome remains unresolved and cannot be executed until that conflict is decided.`\n      : `توقّف النقاش بعد ${round} جولات لأن تعارضًا ثابتًا في إجراءات السجل على البنود ظل مفتوحًا رغم أن مخرجات الوكلاء كانت قابلة للقراءة. النتيجة غير محسومة ولا تُنفّذ حتى يُحسم هذا التعارض.`;\n    return { text, items: pendingItems };\n  }\n\n  if (outcome.phase === "converged") {',
  "browser ledger report",
));

edit("public/strings.js", (input) => {
  let s = input;
  s = replaceOnce(
    s,
    'stopDegraded:"اتفاق غير مختوم (بيانات غير مقروءة)", stopCancelled:',
    'stopDegraded:"اتفاق غير مختوم (بيانات غير مقروءة)", stopDegradedLedgerConflict:"توقف مع تعارض مفتوح في إجراءات السجل", stopCancelled:',
    "Arabic ledger stop label",
  );
  s = replaceOnce(
    s,
    'stopDegraded:"Agreed but unsealed (unreadable control)", stopCancelled:',
    'stopDegraded:"Agreed but unsealed (unreadable control)", stopDegradedLedgerConflict:"Stopped with an unresolved ledger action conflict", stopCancelled:',
    "English ledger stop label",
  );
  return s;
});

edit("public/app.js", (input) => {
  let s = input;
  s = replaceOnce(
    s,
    'invalid_control: "stopInvalidControl", degraded_convergence: "stopDegraded", cancelled:',
    'invalid_control: "stopInvalidControl", degraded_convergence: "stopDegraded", degraded_ledger_conflict: "stopDegradedLedgerConflict", cancelled:',
    "browser stop-reason mapping",
  );
  s = replaceOnce(
    s,
    '["converged", "needs_user", "blocked_external", "needs_more_rounds"].includes(message.phase)',
    '["converged", "needs_user", "blocked_external", "needs_more_rounds", "unresolved"].includes(message.phase)',
    "unresolved outcome discovery",
  );
  return s;
});

edit("test/unit/session-scenarios.test.js", (input) => {
  let s = replaceOnce(
    input,
    'import { assessRound, parseAgentControl } from "../../server/convergence.js";',
    'import { assessRound, parseAgentControl } from "../../server/discussion-assessment.js";',
    "session scenario assessment import",
  );
  s = replaceOnce(
    s,
    'test("scenario · RED spec: a stable isolated ledger conflict among converged readable agents degrades after the bound", { skip: "engine lacks a degraded stop for a stable READABLE ledger-only conflict — unskip in that change" }, () => {',
    'test("scenario · a stable isolated ledger conflict among converged readable agents degrades after the bound", () => {',
    "session scenario RED activation",
  );
  return s;
});

edit("test/unit/orchestrator-degraded-ledger-outcome.test.js", (input) => {
  let s = replaceOnce(
    input,
    'test("scenario · RED outcome: degraded ledger conflict stays unresolved, keeps its reason, and never blames unreadable controls", {\n  skip: "public outcome/renderers do not yet model degraded_ledger_conflict as a non-adoptable terminal stop",\n}, () => {',
    'test("scenario · outcome: degraded ledger conflict stays unresolved, keeps its reason, and never blames unreadable controls", () => {',
    "outcome RED activation",
  );
  s = replaceOnce(
    s,
    'test("scenario · RED browser status: degraded ledger conflict has a dedicated bilingual decision-card label", {\n  skip: "browser stop-reason mapping/catalog do not yet include degraded_ledger_conflict",\n}, () => {',
    'test("scenario · browser status: degraded ledger conflict has a dedicated bilingual decision-card label", () => {',
    "status-label RED activation",
  );
  return s;
});

edit("test/unit/orchestrator-degraded-ledger-persistence.test.js", (input) => replaceOnce(
  input,
  '  test(`scenario · RED orchestration (${mode}): changed merge target on the same item resets degraded persistence`, {\n    skip: "orchestrator does not yet track a target-aware ledger-conflict signature — unskip with degraded_ledger_conflict",\n  }, async (t) => {',
  '  test(`scenario · orchestration (${mode}): changed merge target on the same item resets degraded persistence`, async (t) => {',
  "persistence RED activation",
));

edit("test/integration/unresolved-outcome-discovery.test.js", (input) => replaceOnce(
  input,
  'test("scenario · RED browser: terminal unresolved outcome is discovered and rendered but never executable", {\n  skip: "finalReportFrom does not yet include unresolved terminal outcomes; unskip with degraded_ledger_conflict public wiring",\n}, async () => {',
  'test("scenario · browser: terminal unresolved outcome is discovered and rendered but never executable", async () => {',
  "browser RED activation",
));

console.log("degraded-ledger patch applied");
