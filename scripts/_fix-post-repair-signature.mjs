import fs from "node:fs";

function replaceOnce(text, before, after, label) {
  const count = text.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one match, got ${count}`);
  return text.replace(before, after);
}

const orchestratorPath = "server/orchestrator.js";
let orchestrator = fs.readFileSync(orchestratorPath, "utf8");

orchestrator = replaceOnce(
  orchestrator,
  `    const assessRepairedRound = async (roundMessages, targetVersion, itemRegistry, confirmationsExhausted = false, invalidControlExhausted = false) => {\n      let assessment = assessRound(roundMessages.map((message) => message.control), targetVersion, itemRegistry, confirmationsExhausted, invalidControlExhausted);\n      if (!assessment.repairTargets.length) return assessment;`,
  `    const assessRepairedRound = async (roundMessages, targetVersion, itemRegistry, confirmationsExhausted = false, degradedPersistence) => {\n      // Repair targets are discovered conservatively without allowing any degraded stop yet. The persistence\n      // decision must be based on the controls that will actually be assessed after repair, not the raw round.\n      let assessment = assessRound(roundMessages.map((message) => message.control), targetVersion, itemRegistry, confirmationsExhausted, false);\n      if (!assessment.repairTargets.length) {\n        const degradation = degradedPersistence.boundsFor(roundMessages);\n        assessment = assessRound(roundMessages.map((message) => message.control), targetVersion, itemRegistry, confirmationsExhausted, degradation.exhausted);\n        return { assessment, degradation };\n      }`,
  "assessRepairedRound header",
);

orchestrator = replaceOnce(
  orchestrator,
  `      // Re-assess after repair. A control that was unreadable/unrepairable is still invalid here, so the\n      // degraded-stop signal is computed on the POST-repair state — repair gets its chance first.\n      assessment = assessRound(roundMessages.map((message) => message.control), targetVersion, itemRegistry, confirmationsExhausted, invalidControlExhausted);\n      return assessment;`,
  `      // Compute persistence only after repair has mutated the controls. This keeps the streak keyed to the\n      // actual item/action/merge-target split that the final assessment sees.\n      const degradation = degradedPersistence.boundsFor(roundMessages);\n      assessment = assessRound(roundMessages.map((message) => message.control), targetVersion, itemRegistry, confirmationsExhausted, degradation.exhausted);\n      return { assessment, degradation };`,
  "assessRepairedRound post-repair assessment",
);

orchestrator = replaceOnce(
  orchestrator,
  `        const roundMessages = await reconcileRound(roundOutcome, minSurvivors);\n        const degradation = degradedPersistence.boundsFor(roundMessages);\n        const assessment = await assessRepairedRound(roundMessages, targetVersion, itemRegistry, confirmationsExhausted, degradation.exhausted);\n        degradedPersistence.record(assessment, degradation.currentLedgerSignature);`,
  `        const roundMessages = await reconcileRound(roundOutcome, minSurvivors);\n        const { assessment, degradation } = await assessRepairedRound(\n          roundMessages, targetVersion, itemRegistry, confirmationsExhausted, degradedPersistence,\n        );\n        degradedPersistence.record(assessment, degradation.currentLedgerSignature);`,
  "collaboration persistence timing",
);

orchestrator = replaceOnce(
  orchestrator,
  `        const roundMsgs = await reconcileRound(rebuttalOutcome, minSurvivors);\n        const degradation = degradedPersistence.boundsFor(roundMsgs);\n        const assessment = await assessRepairedRound(roundMsgs, targetVersion, itemRegistry, confirmationsExhausted, degradation.exhausted);\n        degradedPersistence.record(assessment, degradation.currentLedgerSignature);`,
  `        const roundMsgs = await reconcileRound(rebuttalOutcome, minSurvivors);\n        const { assessment, degradation } = await assessRepairedRound(\n          roundMsgs, targetVersion, itemRegistry, confirmationsExhausted, degradedPersistence,\n        );\n        degradedPersistence.record(assessment, degradation.currentLedgerSignature);`,
  "debate persistence timing",
);

fs.writeFileSync(orchestratorPath, orchestrator);

const testPath = "test/unit/orchestrator-degraded-ledger-persistence.test.js";
let tests = fs.readFileSync(testPath, "utf8");
const marker = `\nfor (const mode of ["collaboration", "debate"]) {\n  test(\`scenario · orchestration (\${mode}): repair-mutated ledger actions reset persistence before degraded stop\`, async (t) => {`;
if (!tests.includes(marker.trimStart())) {
  tests += `\n\n// A repair can turn the SAME raw omission into a different real ledger choice. Persistence must therefore\n// sign the post-repair controls. Round 3 repairs item-002 to keep_open; round 4 has the same raw omission\n// but repairs it to resolve, creating a new conflict. That change must reset the streak, so only round 5\n// (which repeats the repaired round-4 split) may stop.\nfor (const mode of ["collaboration", "debate"]) {\n  test(\`scenario · orchestration (\${mode}): repair-mutated ledger actions reset persistence before degraded stop\`, async (t) => {\n    const session = await createSession(\`ledger-conflict-post-repair-\${mode}\`);\n    const seed = [\n      createExternal("تحقق خارجي A"),\n      createExternal("تحقق خارجي B"),\n      createExternal("مرساة تحقق خارجي"),\n    ];\n    const codexKeepOpen = [\n      { action: "keep_open", itemId: "item-001" },\n      { action: "keep_open", itemId: "item-002" },\n      { action: "keep_open", itemId: "item-003" },\n    ];\n    const claudeRawOmission = [\n      { action: "merge_into", itemId: "item-001", targetItemId: "item-003" },\n      { action: "keep_open", itemId: "item-003" },\n    ];\n    const claudeRepairKeep = [\n      { action: "merge_into", itemId: "item-001", targetItemId: "item-003" },\n      { action: "keep_open", itemId: "item-002" },\n      { action: "keep_open", itemId: "item-003" },\n    ];\n    const claudeRepairResolve = [\n      { action: "merge_into", itemId: "item-001", targetItemId: "item-003" },\n      { action: "resolve", itemId: "item-002" },\n      { action: "keep_open", itemId: "item-003" },\n    ];\n\n    let claudeCall = 0;\n    let codexCall = 0;\n    t.mock.method(provider("claude"), "run", async () => {\n      claudeCall += 1;\n      if (claudeCall === 1) return providerResult("Claude opening");\n      if (claudeCall === 2) return providerResult(control({ itemProposals: seed, substantiveDelta: true }));\n      if (claudeCall === 3) return providerResult(control({ itemProposals: claudeRawOmission, targetVersion: 2 }));\n      if (claudeCall === 4) return providerResult(control({ itemProposals: claudeRepairKeep, targetVersion: 2 }));\n      if (claudeCall === 5) return providerResult(control({ itemProposals: claudeRawOmission, targetVersion: 2 }));\n      if (claudeCall === 6) return providerResult(control({ itemProposals: claudeRepairResolve, targetVersion: 2 }));\n      return providerResult(control({ itemProposals: claudeRepairResolve, targetVersion: 2 }));\n    });\n    t.mock.method(provider("codex"), "run", async () => {\n      codexCall += 1;\n      if (codexCall === 1) return providerResult("Codex opening");\n      if (codexCall === 2) return providerResult(control({ itemProposals: seed, substantiveDelta: true }));\n      return providerResult(control({ itemProposals: codexKeepOpen, targetVersion: 2 }));\n    });\n\n    try {\n      await runOrchestration(session.id, {\n        mode,\n        rounds: 5,\n        content: "Test post-repair ledger persistence",\n        finalizer: "none",\n        agents: {\n          claude: { enabled: true, role: "Collaborator" },\n          codex: { enabled: true, role: "Collaborator" },\n        },\n      }, () => {});\n\n      const saved = await getSession(session.id);\n      const outcome = saved.messages.find((message) => message.meta?.outcome)?.meta.outcome;\n      assert.equal(outcome.completedRounds, 5);\n      assert.equal(outcome.stopReason, "degraded_ledger_conflict");\n      assert.equal(outcome.sealDegraded, true);\n      assert.deepEqual(outcome.conflicts, [\n        { code: "conflicting_item_actions", itemId: "item-001" },\n        { code: "conflicting_item_actions", itemId: "item-002" },\n      ]);\n    } finally {\n      await cleanupSession(session.id);\n    }\n  });\n}\n`;
}
fs.writeFileSync(testPath, tests);
