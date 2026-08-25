import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { runOrchestration } from "../../server/orchestrator.js";
import { createSession, getSession, rootPath } from "../../server/store.js";
import { provider } from "../../server/providers/registry.js";

function providerResult(text) {
  return { text, model: "test", durationMs: 1, exitCode: 0, sessionId: null };
}

function control({ itemProposals, targetVersion = 1, substantiveDelta = false }) {
  return `<agent-control>${JSON.stringify({
    controlVersion: 2,
    convergence: "converged",
    goalStatus: "blocked",
    substantiveDelta,
    itemProposals,
    targetVersion,
  })}</agent-control>`;
}

function createExternal(text) {
  return {
    action: "create",
    kind: "external_validation",
    text,
    requiredStep: { actor: "human_operator", action: "run_external_check" },
  };
}

async function cleanupSession(id) {
  const dir = join(rootPath(), "data", "sessions");
  await Promise.all([
    rm(join(dir, `${id}.json`), { force: true }),
    rm(join(dir, `${id}.summary.json`), { force: true }),
  ]);
}

// RED orchestration contract for degraded_ledger_conflict persistence.
//
// DEGRADED_STOP_ROUNDS is 2, but "two degradable rounds" is not enough: the SAME ledger split must
// persist. The signature must include the actual per-agent action choices AND merge target, not only
// the lossy public conflict shape `{ code, itemId }` or even `{ agent, itemId, action }`.
//
// Round 3 and round 4 keep the same contested item and the same `merge_into` action, but Claude changes
// the target from item-002 to item-003. That target change is new information and must reset the streak.
// Round 5 repeats merge_into(item-003), and only then may the bounded degraded stop fire.
//
// Collaboration and debate maintain separate copies of the degraded-round counter, so this scenario
// is intentionally data-driven across BOTH modes. Fixing the signature reset in only one loop must
// leave the other variant red.
//
// Current orchestration counts only lastAssessment.degradable. A future implementation that keys the
// streak on assessment.conflicts alone would still be wrong because plannedRegistryUpdates() exposes
// conflicts only as `{ code, itemId }`; an implementation that adds action but omits targetItemId would
// also still be wrong and would stop on round 4. The correct target-aware implementation reaches round 5.
//
// Skipped until the readable-ledger degraded engine path lands. Unskip with that implementation.
for (const mode of ["collaboration", "debate"]) {
  test(`scenario · RED orchestration (${mode}): changed merge target on the same item resets degraded persistence`, {
    skip: "orchestrator does not yet track a target-aware ledger-conflict signature — unskip with degraded_ledger_conflict",
  }, async (t) => {
    const session = await createSession(`ledger-conflict-persistence-${mode}`);
    const seed = [
      createExternal("تحقق خارجي A"),
      createExternal("تحقق خارجي B"),
      createExternal("مرساة تحقق خارجي تبقى مفتوحة"),
    ];

    // Round 3: item-001 is contested as merge_into(item-002) vs keep_open.
    // item-002 remains open, so the merge target is valid.
    const round3Claude = [
      { action: "merge_into", itemId: "item-001", targetItemId: "item-002" },
      { action: "keep_open", itemId: "item-002" },
      { action: "keep_open", itemId: "item-003" },
    ];
    const codexKeepOpen = [
      { action: "keep_open", itemId: "item-001" },
      { action: "keep_open", itemId: "item-002" },
      { action: "keep_open", itemId: "item-003" },
    ];

    // Rounds 4-5: SAME item-001 and SAME `merge_into` action, but Claude switches the target to item-003.
    // item-003 also remains open, so this second merge alternative is independently valid.
    // The public conflict object remains identical across rounds 3-5:
    // `{ code: "conflicting_item_actions", itemId: "item-001" }`.
    const round4And5Claude = [
      { action: "merge_into", itemId: "item-001", targetItemId: "item-003" },
      { action: "keep_open", itemId: "item-002" },
      { action: "keep_open", itemId: "item-003" },
    ];

    let claudeCall = 0;
    let codexCall = 0;
    t.mock.method(provider("claude"), "run", async () => {
      claudeCall += 1;
      if (claudeCall === 1) return providerResult("Claude opening");
      if (claudeCall === 2) return providerResult(control({ itemProposals: seed, substantiveDelta: true }));
      if (claudeCall === 3) return providerResult(control({ itemProposals: round3Claude, targetVersion: 2 }));
      return providerResult(control({ itemProposals: round4And5Claude, targetVersion: 2 }));
    });
    t.mock.method(provider("codex"), "run", async () => {
      codexCall += 1;
      if (codexCall === 1) return providerResult("Codex opening");
      if (codexCall === 2) return providerResult(control({ itemProposals: seed, substantiveDelta: true }));
      return providerResult(control({ itemProposals: codexKeepOpen, targetVersion: 2 }));
    });

    try {
      await runOrchestration(session.id, {
        mode,
        rounds: 5,
        content: "Test target-aware ledger-conflict persistence",
        finalizer: "none",
        agents: {
          claude: { enabled: true, role: "Collaborator" },
          codex: { enabled: true, role: "Collaborator" },
        },
      }, () => {});

      const saved = await getSession(session.id);
      const outcome = saved.messages.find((message) => message.meta?.outcome)?.meta.outcome;

      // Round 3 and round 4 surface the same public conflict on item-001 and use the same action,
      // but the merge target changed item-002 -> item-003. That MUST reset persistence.
      // Round 5 repeats merge_into(item-003) and is the first point where the bound is satisfied.
      assert.equal(outcome.completedRounds, 5);
      assert.equal(outcome.stopReason, "degraded_ledger_conflict");
      assert.equal(outcome.sealDegraded, true);
      assert.deepEqual(outcome.conflicts, [{ code: "conflicting_item_actions", itemId: "item-001" }]);
    } finally {
      await cleanupSession(session.id);
    }
  });
}
