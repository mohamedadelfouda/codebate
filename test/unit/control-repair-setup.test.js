import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function providerResult(text) {
  return { text, model: "test", durationMs: 1, exitCode: 0, sessionId: null };
}

function controlBlock() {
  return `<agent-control>${JSON.stringify({
    controlVersion: 2,
    convergence: "converged",
    goalStatus: "satisfied",
    substantiveDelta: false,
    itemProposals: [],
    targetVersion: 1,
  })}</agent-control>`;
}

test("scratch setup failure keeps the original control and completes conservatively", async (t) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codebate-repair-setup-"));
  const previousRuntimeRoot = process.env.CODEBATE_RUNTIME_DIR;
  process.env.CODEBATE_RUNTIME_DIR = runtimeRoot;

  try {
    const [{ runOrchestration }, store, { provider }] = await Promise.all([
      import("../../server/orchestrator.js"),
      import("../../server/store.js"),
      import("../../server/providers/registry.js"),
    ]);
    const session = await store.createSession("repair setup failure");
    const roundTwoReady = deferred();
    const workspacePath = path.join(runtimeRoot, "workspace");
    let roundTwoProviders = 0;
    let claudeCalls = 0;
    let codexCalls = 0;

    const finishRoundTwo = async (text) => {
      roundTwoProviders += 1;
      if (roundTwoProviders === 2) {
        await fs.rm(workspacePath, { recursive: true, force: true });
        await fs.writeFile(workspacePath, "blocks directory creation");
        roundTwoReady.resolve();
      }
      await roundTwoReady.promise;
      return providerResult(text);
    };

    t.mock.method(provider("claude"), "run", async () => {
      claudeCalls += 1;
      return claudeCalls === 1
        ? providerResult("Claude opening")
        : finishRoundTwo("Claude answer without a control");
    });
    t.mock.method(provider("codex"), "run", async () => {
      codexCalls += 1;
      return codexCalls === 1
        ? providerResult("Codex opening")
        : finishRoundTwo(controlBlock());
    });

    await runOrchestration(session.id, {
      mode: "collaboration",
      rounds: 2,
      content: "Assess the repair path",
      finalizer: "none",
      agents: {
        claude: { enabled: true, role: "Collaborator" },
        codex: { enabled: true, role: "Collaborator" },
      },
    }, () => {});

    const saved = await store.getSession(session.id);
    const claudeRoundTwo = saved.messages.find((message) => message.agent === "claude" && message.round === 2);
    const outcome = saved.messages.find((message) => message.meta?.outcome)?.meta.outcome;
    assert.equal(saved.status, "completed");
    assert.equal(claudeRoundTwo.control.valid, false);
    assert.equal(claudeRoundTwo.meta.controlRepair.failureCode, "scratch_workspace_error");
    assert.equal(outcome.controlValid, false);
    assert.equal(outcome.controlRepairStats.failedCalls, 1);
  } finally {
    if (previousRuntimeRoot === undefined) delete process.env.CODEBATE_RUNTIME_DIR;
    else process.env.CODEBATE_RUNTIME_DIR = previousRuntimeRoot;
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});
