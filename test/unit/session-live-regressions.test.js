import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { runOrchestration } from "../../server/orchestrator.js";
import { provider } from "../../server/providers/registry.js";
import { createSession, getSession, rootPath } from "../../server/store.js";

function providerResult(text) {
  return { text, model: "test", durationMs: 1, exitCode: 0, sessionId: null };
}

function control({ targetVersion, substantiveDelta = false }) {
  return `<agent-control>${JSON.stringify({
    controlVersion: 2,
    convergence: "converged",
    goalStatus: "satisfied",
    substantiveDelta,
    itemProposals: [],
    targetVersion,
  })}</agent-control>`;
}

async function cleanupSession(id) {
  const dir = join(rootPath(), "data", "sessions");
  await Promise.all([
    rm(join(dir, `${id}.json`), { force: true }),
    rm(join(dir, `${id}.summary.json`), { force: true }),
  ]);
}

// Real-session regression (2026-07-25): one provider returned 503 and was dropped; the two
// survivors still converged, ran one confirmation round for the late delta, and the session
// stopped at round 3 instead of burning the configured five rounds. Keep the provider failure
// at the orchestrator level here — the lower-level session-scenarios harness already covers the
// convergence math after a dropout.
test("2026-07-25 · provider 503 drops cleanly; survivors converge and stop at round 3", async (t) => {
  const session = await createSession("2026-07-25-provider-503");
  const events = [];
  let claudeCalls = 0;
  let cursorCalls = 0;
  let codexCalls = 0;

  t.mock.method(provider("claude"), "run", async () => {
    claudeCalls += 1;
    if (claudeCalls === 1) return providerResult("Claude opening proposal");
    if (claudeCalls === 2) {
      return providerResult(`Claude converges with one decision-changing refinement.\n${control({ targetVersion: 1, substantiveDelta: true })}`);
    }
    return providerResult(`Claude confirms; nothing material changed.\n${control({ targetVersion: 2 })}`);
  });

  t.mock.method(provider("cursor"), "run", async () => {
    cursorCalls += 1;
    if (cursorCalls === 1) return providerResult("Cursor opening proposal");
    if (cursorCalls === 2) return providerResult(`Cursor agrees with the revised proposal.\n${control({ targetVersion: 1 })}`);
    return providerResult(`Cursor confirms the same proposal.\n${control({ targetVersion: 2 })}`);
  });

  t.mock.method(provider("codex"), "run", async () => {
    codexCalls += 1;
    throw new Error("503 Service Unavailable");
  });

  try {
    await runOrchestration(session.id, {
      mode: "collaboration",
      rounds: 5,
      content: "Review this repository and converge on the important fixes",
      finalizer: "none",
      agents: {
        claude: { enabled: true, role: "Collaborator" },
        codex: { enabled: true, role: "Collaborator" },
        cursor: { enabled: true, role: "Collaborator" },
      },
    }, (event) => events.push(event));

    const saved = await getSession(session.id);
    const outcomeMessage = saved.messages.find((message) => message.meta?.outcome);
    const outcome = outcomeMessage?.meta?.outcome;

    assert.equal(codexCalls, 2, "Codex gets one automatic retry, then is dropped");
    assert.ok(events.some((event) => event.type === "agent_dropped" && event.agent === "codex"));
    assert.equal(events.some((event) => event.type === "run_error"), false);
    assert.equal(saved.status, "completed");
    assert.equal(outcome.agreementState, "converged");
    assert.equal(outcome.completedRounds, 3);
    assert.equal(outcome.stoppedEarly, true);
    assert.equal(saved.messages.some((message) => message.round === 4), false);
    assert.equal(saved.messages.some((message) => message.round === 5), false);
    assert.ok(claudeCalls >= 3);
    assert.ok(cursorCalls >= 3);
  } finally {
    await cleanupSession(session.id);
  }
});
