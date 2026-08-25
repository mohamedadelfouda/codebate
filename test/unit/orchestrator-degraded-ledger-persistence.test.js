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
// DEGRADED_STOP_ROUNDS is 2, but "two degradable rounds" is not enough: the SAME conflict must
// persist. A conflict on item-001 followed by a different conflict on item-002 is new information
// and must reset the persistence streak. The second identical item-002 conflict may then stop.
//
// Collaboration and debate maintain separate copies of the degraded-round counter, so this scenario
// is intentionally data-driven across BOTH modes. Fixing the signature reset in only one loop must
// leave the other variant red.
//
// Current orchestration counts only lastAssessment.degradable, so once readable ledger conflicts
// become degradable the buggy implementation would stop on round 4. The correct implementation
// reaches round 5 and only then emits degraded_ledger_conflict.
//
// Skipped until the readable-ledger degraded engine path lands. Unskip with that implementation.
for (const mode of ["collaboration", "debate"]) {
  test(`scenario · RED orchestration (${mode}): changing ledger conflict resets the degraded persistence streak`, {
    skip: "orchestrator does not yet track a ledger-conflict signature — unskip with degraded_ledger_conflict",
  }, async (t) => {
    const session = await createSession(`ledger-conflict-persistence-${mode}`);
    const seed = [
      createExternal("تحقق خارجي A"),
      createExternal("تحقق خارجي B"),
      createExternal("مرساة تحقق خارجي تبقى مفتوحة"),
    ];

    const round3Claude = [
      { action: "resolve", itemId: "item-001" },
      { action: "keep_open", itemId: "item-002" },
      { action: "keep_open", itemId: "item-003" },
    ];
    const round3Codex = [
      { action: "keep_open", itemId: "item-001" },
      { action: "keep_open", itemId: "item-002" },
      { action: "keep_open", itemId: "item-003" },
    ];
    const conflictBClaude = [
      { action: "keep_open", itemId: "item-001" },
      { action: "resolve", itemId: "item-002" },
      { action: "keep_open", itemId: "item-003" },
    ];
    const conflictBCodex = [
      { action: "keep_open", itemId: "item-001" },
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
      return providerResult(control({ itemProposals: conflictBClaude, targetVersion: 2 }));
    });
    t.mock.method(provider("codex"), "run", async () => {
      codexCall += 1;
      if (codexCall === 1) return providerResult("Codex opening");
      if (codexCall === 2) return providerResult(control({ itemProposals: seed, substantiveDelta: true }));
      if (codexCall === 3) return providerResult(control({ itemProposals: round3Codex, targetVersion: 2 }));
      return providerResult(control({ itemProposals: conflictBCodex, targetVersion: 2 }));
    });

    try {
      await runOrchestration(session.id, {
        mode,
        rounds: 5,
        content: "Test stable ledger-conflict persistence",
        finalizer: "none",
        agents: {
          claude: { enabled: true, role: "Collaborator" },
          codex: { enabled: true, role: "Collaborator" },
        },
      }, () => {});

      const saved = await getSession(session.id);
      const outcome = saved.messages.find((message) => message.meta?.outcome)?.meta.outcome;

      // Round 3 conflicts on item-001. Round 4 switches to item-002, so the streak MUST reset.
      // Round 5 repeats item-002 and is the first point where the persistence bound is satisfied.
      assert.equal(outcome.completedRounds, 5);
      assert.equal(outcome.stopReason, "degraded_ledger_conflict");
      assert.equal(outcome.sealDegraded, true);
      assert.deepEqual(outcome.conflicts, [{ code: "conflicting_item_actions", itemId: "item-002" }]);
    } finally {
      await cleanupSession(session.id);
    }
  });
}
