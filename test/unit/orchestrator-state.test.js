import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  buildDiscussionOutcome,
  discussionOutcomeReport,
  isRunning,
  mergeOrchestrationContent,
  reconcileInterruptedRuns,
  runOrchestration,
  stopRun,
  validateOrchestrationRequest,
} from "../../server/orchestrator.js";
import { createSession, getSession, mutateSession, rootPath, scratchWorkspacePath } from "../../server/store.js";
import { provider } from "../../server/providers/registry.js";
import { claimSessionActivity } from "../../server/session-activity.js";
import { assessRound, parseAgentControl } from "../../server/convergence.js";

function rawControl(overrides) {
  return parseAgentControl(`<agent-control>${JSON.stringify({ controlVersion: 2, convergence: "converged", goalStatus: "satisfied", substantiveDelta: false, itemProposals: [], targetVersion: 1, ...overrides })}</agent-control>`);
}

function versionedControl({
  goalStatus,
  itemProposals,
  targetVersion = 1,
  substantiveDelta = false,
}) {
  return `<agent-control>${JSON.stringify({
    controlVersion: 2,
    convergence: "converged",
    goalStatus,
    substantiveDelta,
    itemProposals,
    targetVersion,
  })}</agent-control>`;
}

function controlBlock(goalStatus, itemProposals) {
  return versionedControl({ goalStatus, itemProposals });
}

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

function chatRequest(content) {
  return {
    mode: "chat",
    rounds: 1,
    content,
    finalizer: "none",
    agents: {
      claude: { enabled: true, role: "Collaborator" },
      codex: { enabled: true, role: "Collaborator" },
    },
  };
}

function collaborationRequest(content) {
  return { ...chatRequest(content), mode: "collaboration" };
}

async function nextEventLoopTurn() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function drainSessionWrites(sessionId) {
  await nextEventLoopTurn();
  await mutateSession(sessionId, () => {});
}

function assertSingleRunIdentity(events) {
  const runIds = new Set(events.map((event) => event.runId));
  assert.equal(runIds.size, 1);
  assert.match([...runIds][0], /^[0-9a-f-]{36}$/i);
}

async function cleanupSession(id) {
  const dir = join(rootPath(), "data", "sessions");
  await Promise.all([
    rm(join(dir, `${id}.json`), { force: true }),
    rm(join(dir, `${id}.summary.json`), { force: true }),
  ]);
}

test("orchestration content merge preserves concurrent state without authorizing a status transition", () => {
  const latest = {
    id: "session-1",
    status: "running",
    mode: "collaboration",
    settings: { rounds: 2 },
    messages: [{ id: "old", createdAt: "2026-07-14T10:00:00.000Z", content: "old" }],
    connectorActions: [{ id: "proposal-1", status: "pending" }],
    decisions: [{ id: "decision-1", outcome: "approved" }],
  };
  const orchestration = {
    ...structuredClone(latest),
    status: "completed",
    settings: { rounds: 3 },
    messages: [
      { id: "old", createdAt: "2026-07-14T10:00:00.000Z", content: "old" },
      { id: "answer", createdAt: "2026-07-14T10:01:00.000Z", content: "answer" },
    ],
    connectorActions: [],
    decisions: [],
  };

  const merged = mergeOrchestrationContent(latest, orchestration);
  assert.equal(merged.status, "running");
  assert.deepEqual(merged.settings, { rounds: 3 });
  assert.deepEqual(merged.messages.map((message) => message.id), ["old", "answer"]);
  assert.deepEqual(merged.connectorActions, [{ id: "proposal-1", status: "pending" }]);
  assert.deepEqual(merged.decisions, [{ id: "decision-1", outcome: "approved" }]);
});

test("outcome reporting separates agreement from a pending user decision", () => {
  const assessment = {
    canStop: true,
    agreementState: "converged",
    completionState: "needs_user",
    stopReason: "user_decision",
    itemRegistry: [],
    pendingItems: [],
    pendingKinds: ["user_decision"],
    nextSteps: [],
    disagreements: [],
    unclassifiedPoints: [],
    conflicts: [],
    allValid: true,
  };
  const outcome = buildDiscussionOutcome(assessment, 5, 2);
  assert.equal(outcome.phase, "needs_user");
  assert.equal(outcome.stoppedEarly, true);
  assert.match(discussionOutcomeReport(outcome), /الوكلاء متفقون/);
  assert.doesNotMatch(discussionOutcomeReport(outcome), /مش متفقين|اختلاف جوهري/);
});

test("outcome reporting spells out disagreement points when rounds end unresolved", () => {
  const assessment = {
    canStop: false,
    agreementState: "open",
    completionState: "incomplete",
    stopReason: null,
    itemRegistry: [],
    pendingItems: [],
    pendingKinds: ["disagreement"],
    nextSteps: [],
    disagreements: ["هل fail-closed هو القرار الصح؟", "ترتيب القياس قبل الـeval"],
    unclassifiedPoints: [],
    conflicts: [],
    allValid: true,
  };
  const outcome = buildDiscussionOutcome(assessment, 3, 3);
  assert.equal(outcome.phase, "needs_more_rounds");
  assert.equal(outcome.stopReason, "round_limit");
  const report = discussionOutcomeReport(outcome);
  assert.match(report, /الاتفاق ماتمّش/);
  assert.match(report, /نقط الاختلاف/);
  assert.match(report, /fail-closed هو القرار الصح/);
});

test("an inconsistent-but-parseable round reports the raised disagreement, not opaque control data", () => {
  // End-to-end through the real pipeline: a needs_user control that raised a disagreement but no
  // user_decision item is a consistency error (round not certified), yet the controls parsed —
  // assessRound → buildDiscussionOutcome → report must carry the raised point all the way through.
  const raised = { action: "create", kind: "disagreement", text: "الدافع الفوري مقابل جودة رحلة التعلم", requiredStep: { actor: "agent", action: "resume_agent_round" } };
  const assessment = assessRound([
    rawControl({ convergence: "open", goalStatus: "needs_user", itemProposals: [raised] }),
    rawControl({ convergence: "open", goalStatus: "satisfied" }),
  ], 1);
  assert.equal(assessment.allValid, false);
  assert.equal(assessment.controlsParseable, true);
  assert.equal(assessment.consistencyErrors.some((error) => error.code === "missing_user_decision"), true);
  assert.equal(assessment.consistencyErrors.some((error) => error.code === "completion_registry_mismatch"), true);
  const outcome = buildDiscussionOutcome(assessment, 2, 2);
  assert.equal(outcome.stopReason, "invalid_control");
  assert.equal(outcome.controlsParseable, true);
  assert.deepEqual(outcome.proposedDisagreements, ["الدافع الفوري مقابل جودة رحلة التعلم"]);
  const report = discussionOutcomeReport(outcome);
  assert.match(report, /نقط الاختلاف اللي طرحوها/);
  assert.match(report, /الدافع الفوري مقابل جودة رحلة التعلم/);
  assert.doesNotMatch(report, /من غير ما الوكلاء يوصلوا لاتفاق مؤكَّد/);
});

test("an agreed-but-incomplete stop reports as settled without claiming completion", () => {
  const assessment = {
    canStop: true,
    agreementState: "converged",
    completionState: "incomplete",
    stopReason: "complete",
    itemRegistry: [],
    pendingItems: [],
    pendingKinds: [],
    nextSteps: [],
    disagreements: [],
    unclassifiedPoints: [],
    conflicts: [],
    allValid: true,
  };
  const outcome = buildDiscussionOutcome(assessment, 5, 2);
  assert.equal(outcome.phase, "converged");
  assert.equal(outcome.stoppedEarly, true);
  const report = discussionOutcomeReport(outcome);
  assert.match(report, /استقرّوا على إجابة واحدة/);
  assert.doesNotMatch(report, /المهمة اكتملت/);
});

test("an agreed stop derives a pending user decision from its required step (Codex #30)", () => {
  // A conservative incomplete declaration must not hide the more useful official required step.
  const decision = { action: "create", kind: "user_decision", text: "اختَر آلية نشر النماذج", requiredStep: { actor: "user", action: "provide_decision" } };
  const assessment = assessRound([
    rawControl({ goalStatus: "incomplete", itemProposals: [decision] }),
    rawControl({ goalStatus: "incomplete" }),
  ], 1);
  assert.equal(assessment.agreementState, "converged");
  assert.equal(assessment.completionState, "needs_user");
  assert.equal(assessment.canStop, true);
  const outcome = buildDiscussionOutcome(assessment, 3, 2);
  assert.equal(outcome.phase, "needs_user");
  const report = discussionOutcomeReport(outcome);
  assert.match(report, /تحتاج قرارك/);
  assert.match(report, /اختَر آلية نشر النماذج/);
});

test("a five-round collaboration stops after round two and finalizes once", async (t) => {
  const session = await createSession("convergence-regression");
  let claudeCalls = 0;
  let codexCalls = 0;
  const result = (text) => ({ text, model: "test", durationMs: 1, exitCode: 0, sessionId: null });

  t.mock.method(provider("claude"), "run", async () => {
    claudeCalls += 1;
    if (claudeCalls === 1) return result("Claude opening proposal");
    if (claudeCalls === 2) {
      return result(`Claude agrees\n${controlBlock("needs_user", [{
        action: "create",
        kind: "user_decision",
        text: "Choose the rollout mode",
        requiredStep: { actor: "user", action: "provide_decision" },
      }])}`);
    }
    return result("الوكلاء غير متفقين — هذا نص finalizer متعمد أن يكون خاطئًا");
  });
  t.mock.method(provider("codex"), "run", async () => {
    codexCalls += 1;
    if (codexCalls === 1) return result("Codex opening proposal");
    return result(`Codex agrees\n${controlBlock("blocked", [{
      action: "create",
      kind: "external_validation",
      text: "Verify Cursor containment",
      requiredStep: { actor: "human_operator", action: "run_external_check" },
    }])}`);
  });

  try {
    await runOrchestration(session.id, {
      mode: "collaboration",
      rounds: 5,
      content: "Plan the change",
      finalizer: "claude",
      agents: {
        claude: { enabled: true, role: "Collaborator" },
        codex: { enabled: true, role: "Collaborator" },
      },
    }, () => {});

    const saved = await getSession(session.id);
    assert.equal(saved.status, "completed");
    assert.equal(saved.activeRun.status, "completed");
    assert.ok(saved.activeRun.endedAt);
    const discussion = saved.messages.filter((message) => message.phase === "collaboration");
    const synthesis = saved.messages.filter((message) => message.phase === "synthesis");
    const outcomeMessage = saved.messages.find((message) => message.meta?.outcome);
    assert.deepEqual([...new Set(discussion.map((message) => message.round))], [1, 2]);
    assert.equal(discussion.length, 4);
    assert.equal(synthesis.length, 1);
    assert.equal(outcomeMessage.phase, "blocked_external");
    assert.equal(outcomeMessage.meta.outcome.agreementState, "converged");
    assert.equal(outcomeMessage.meta.outcome.completionState, "blocked");
    assert.equal(outcomeMessage.meta.outcome.requestedRounds, 5);
    assert.equal(outcomeMessage.meta.outcome.completedRounds, 2);
    assert.deepEqual(new Set(outcomeMessage.meta.outcome.pendingKinds), new Set(["user_decision", "external_validation"]));
    assert.doesNotMatch(outcomeMessage.content, /مش متفقين/);
    assert.match(synthesis[0].content, /غير متفقين/);
    assert.equal(outcomeMessage.meta.outcome.agreementState, "converged");
  } finally {
    await cleanupSession(session.id);
  }
});

test("a dropped control block is repaired so genuine agreement is not lost", async (t) => {
  const session = await createSession("control-repair");
  await mutateSession(session.id, (stored) => {
    stored.connectors = { gmail: { enabled: true } };
  });
  let claudeCalls = 0;
  let codexCalls = 0;
  let repairInvocation = null;
  const result = (text) => ({ text, model: "test", durationMs: 1, exitCode: 0, sessionId: null });

  t.mock.method(provider("claude"), "run", async (invocation) => {
    claudeCalls += 1;
    if (claudeCalls === 1) return result("Claude opening proposal");
    if (claudeCalls === 2) return result("Claude agrees — but this reply drops its control block entirely.");
    repairInvocation = invocation;
    return {
      ...result(controlBlock("satisfied", [])),
      durationMs: 7,
      usage: {
        source: "claude",
        inputTokens: 10,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
        totalTokens: 15,
        costUsd: null,
      },
    };
  });
  t.mock.method(provider("codex"), "run", async () => {
    codexCalls += 1;
    if (codexCalls === 1) return result("Codex opening proposal");
    return result(`Codex agrees.\n${controlBlock("satisfied", [])}`);
  });

  try {
    await runOrchestration(session.id, {
      mode: "collaboration",
      rounds: 2,
      content: "Plan the change",
      finalizer: "none",
      agents: { claude: { enabled: true, role: "Collaborator" }, codex: { enabled: true, role: "Collaborator" } },
    }, () => {});

    const saved = await getSession(session.id);
    const outcomeMessage = saved.messages.find((message) => message.meta?.outcome);
    assert.equal(outcomeMessage.phase, "converged");
    assert.equal(outcomeMessage.meta.outcome.agreementState, "converged");
    assert.equal(outcomeMessage.meta.outcome.controlValid, true);
    const claudeRound2 = saved.messages.find((m) => m.agent === "claude" && m.round === 2 && m.phase === "collaboration");
    assert.equal(claudeRound2.control.valid, true);
    assert.equal(claudeRound2.meta.controlRepaired, undefined);
    assert.equal(claudeRound2.meta.controlRepair.status, "succeeded");
    assert.equal(claudeRound2.meta.controlRepair.count, 1);
    assert.deepEqual(claudeRound2.meta.controlRepair.errorCodes, ["missing_control"]);
    assert.equal(claudeRound2.meta.controlRepair.durationMs, 7);
    assert.equal(claudeRound2.meta.controlRepair.originalControl.value.valid, false);
    assert.equal(claudeRound2.meta.controlRepair.repairedControl.value.valid, true);
    assert.match(claudeRound2.content, /Claude agrees/); // reader-facing answer preserved
    assert.equal(repairInvocation.config.permission, "read");
    assert.equal(repairInvocation.config.mcpSessionId, "");
    assert.equal(repairInvocation.config.connectorSessionId, "");
    assert.equal(repairInvocation.config.timeoutMs, 60000);
    assert.equal(repairInvocation.config.maxOutputBytes, 64 * 1024);
    assert.equal(repairInvocation.cwd, await scratchWorkspacePath());
    assert.deepEqual(outcomeMessage.meta.outcome.controlRepairStats, {
      attemptedCalls: 1,
      succeededCalls: 1,
      failedCalls: 0,
      totalDurationMs: 7,
      errorCodeCounts: { missing_control: 1 },
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
        totalTokens: 15,
        costUsd: null,
      },
    });
  } finally {
    await cleanupSession(session.id);
  }
});

test("control repair fails closed when the provider cannot guarantee a tool-free call", async (t) => {
  const session = await createSession("unsupported-control-repair");
  let claudeCalls = 0;
  let codexCalls = 0;

  t.mock.method(provider("claude"), "run", async () => {
    claudeCalls += 1;
    return providerResult(claudeCalls === 1
      ? "Claude opening"
      : versionedControl({ goalStatus: "satisfied", itemProposals: [] }));
  });
  t.mock.method(provider("codex"), "run", async () => {
    codexCalls += 1;
    if (codexCalls === 1) return providerResult("Codex opening");
    if (codexCalls === 2) return providerResult("Codex agrees but omits the control block.");
    throw new Error("Codex control repair must not launch without a tool-free provider mode");
  });

  try {
    await runOrchestration(session.id, {
      mode: "collaboration",
      rounds: 2,
      content: "Plan the change",
      finalizer: "none",
      agents: {
        claude: { enabled: true, role: "Collaborator" },
        codex: { enabled: true, role: "Collaborator" },
      },
    }, () => {});

    const saved = await getSession(session.id);
    const codexRound2 = saved.messages.find((message) => (
      message.agent === "codex"
      && message.round === 2
      && message.phase === "collaboration"
    ));
    const outcome = saved.messages.find((message) => message.meta?.outcome)?.meta.outcome;

    assert.equal(codexRound2.meta.controlRepair.attempted, false);
    assert.equal(codexRound2.meta.controlRepair.count, 0);
    assert.equal(codexRound2.meta.controlRepair.status, "skipped");
    assert.equal(codexRound2.meta.controlRepair.failureCode, "repair_not_supported");
    assert.deepEqual(codexRound2.meta.controlRepair.errorCodes, ["missing_control"]);
    assert.equal(outcome.controlValid, false);
    assert.equal("controlRepairStats" in outcome, false);
  } finally {
    await cleanupSession(session.id);
  }
});

test("2026-07-18 regression: omitted approved items are repaired before the final assessment", async (t) => {
  const session = await createSession("omitted-item-repair");
  let claudeCalls = 0;
  let codexCalls = 0;
  const openDecision = {
    action: "create",
    kind: "user_decision",
    text: "Choose the rollout mode",
    requiredStep: { actor: "user", action: "provide_decision" },
  };
  const resolveDecision = [{ action: "resolve", itemId: "item-001" }];

  t.mock.method(provider("claude"), "run", async () => {
    claudeCalls += 1;
    if (claudeCalls === 1) return providerResult("Claude opening");
    if (claudeCalls === 2) {
      return providerResult(versionedControl({
        goalStatus: "needs_user",
        itemProposals: [openDecision],
        substantiveDelta: true,
      }));
    }
    if (claudeCalls === 3) {
      return providerResult(`Claude confirms the choice is resolved.\n${versionedControl({
        goalStatus: "satisfied",
        itemProposals: [],
        targetVersion: 2,
      })}`);
    }
    return providerResult(versionedControl({
      goalStatus: "satisfied",
      itemProposals: resolveDecision,
      targetVersion: 2,
    }));
  });
  t.mock.method(provider("codex"), "run", async () => {
    codexCalls += 1;
    if (codexCalls === 1) return providerResult("Codex opening");
    if (codexCalls === 2) {
      return providerResult(versionedControl({
        goalStatus: "needs_user",
        itemProposals: [openDecision],
        substantiveDelta: true,
      }));
    }
    if (codexCalls === 3) {
      return providerResult(`Codex confirms the choice is resolved.\n${versionedControl({
        goalStatus: "satisfied",
        itemProposals: resolveDecision,
        targetVersion: 2,
      })}`);
    }
    throw new Error("Codex should not need a control repair call");
  });

  try {
    await runOrchestration(session.id, {
      mode: "collaboration",
      rounds: 5,
      content: "Resolve the rollout plan",
      finalizer: "none",
      agents: {
        claude: { enabled: true, role: "Collaborator" },
        codex: { enabled: true, role: "Collaborator" },
      },
    }, () => {});

    const saved = await getSession(session.id);
    const outcome = saved.messages.find((message) => message.meta?.outcome)?.meta.outcome;
    assert.equal(outcome.completedRounds, 3);
    assert.equal(outcome.stoppedEarly, true);
    assert.equal(outcome.agreementState, "converged");
    assert.equal(outcome.completionState, "satisfied");
    assert.equal(outcome.itemRegistry[0].status, "resolved");
    assert.equal(outcome.controlRepairStats.attemptedCalls, 1);
    assert.equal(saved.status, "completed");
    assert.equal(saved.activeRun.status, "completed");
    const roundThree = saved.messages.filter((message) => message.round === 3 && message.phase === "collaboration");
    assert.equal(roundThree.length, 2);
    assert.equal(roundThree.find((message) => message.agent === "claude").meta.controlRepair.status, "succeeded");
    assert.equal(roundThree.find((message) => message.agent === "codex").meta.controlRepair, undefined);
    assert.equal(saved.messages.some((message) => message.round === 4), false);
  } finally {
    await cleanupSession(session.id);
  }
});

test("a stale target version gets one narrow repair", async (t) => {
  const session = await createSession("target-version-repair");
  let claudeCalls = 0;
  let codexCalls = 0;
  t.mock.method(provider("claude"), "run", async () => {
    claudeCalls += 1;
    if (claudeCalls === 1) return providerResult("Claude opening");
    if (claudeCalls === 2) {
      return providerResult(versionedControl({ goalStatus: "satisfied", itemProposals: [], targetVersion: 9 }));
    }
    return providerResult(versionedControl({ goalStatus: "satisfied", itemProposals: [], targetVersion: 1 }));
  });
  t.mock.method(provider("codex"), "run", async () => {
    codexCalls += 1;
    if (codexCalls === 1) return providerResult("Codex opening");
    return providerResult(versionedControl({ goalStatus: "satisfied", itemProposals: [], targetVersion: 1 }));
  });

  try {
    await runOrchestration(session.id, {
      mode: "collaboration",
      rounds: 2,
      content: "Repair the stale version",
      finalizer: "none",
      agents: {
        claude: { enabled: true, role: "Collaborator" },
        codex: { enabled: true, role: "Collaborator" },
      },
    }, () => {});
    const saved = await getSession(session.id);
    const claudeRoundTwo = saved.messages.find((message) => message.agent === "claude" && message.round === 2);
    assert.equal(claudeRoundTwo.control.targetVersion, 1);
    assert.deepEqual(claudeRoundTwo.meta.controlRepair.errorCodes, ["target_version_mismatch"]);
    assert.equal(claudeRoundTwo.meta.controlRepair.status, "succeeded");
  } finally {
    await cleanupSession(session.id);
  }
});

test("a provider failure during control repair stays conservative", async (t) => {
  const session = await createSession("control-diagnostic");
  let claudeCalls = 0;
  const result = (text) => ({ text, model: "test", durationMs: 1, exitCode: 0, sessionId: null });
  t.mock.method(provider("claude"), "run", async () => {
    claudeCalls += 1;
    if (claudeCalls === 1) return result("Claude opening proposal");
    if (claudeCalls === 2) return result("Claude agrees but never emits a control block.");
    throw new Error("controlled repair failure");
  });
  t.mock.method(provider("codex"), "run", async () => result(`Codex.\n${controlBlock("satisfied", [])}`));

  try {
    await runOrchestration(session.id, {
      mode: "collaboration",
      rounds: 2,
      content: "Plan the change",
      finalizer: "none",
      agents: { claude: { enabled: true, role: "Collaborator" }, codex: { enabled: true, role: "Collaborator" } },
    }, () => {});

    const saved = await getSession(session.id);
    const claudeRound2 = saved.messages.find((m) => m.agent === "claude" && m.round === 2 && m.phase === "collaboration");
    assert.equal(claudeRound2.control.valid, false);
    assert.equal(claudeRound2.meta.controlInvalidRaw, undefined);
    assert.equal(claudeRound2.meta.controlRepaired, undefined);
    assert.equal(claudeRound2.meta.controlRepair.status, "failed");
    assert.equal(claudeRound2.meta.controlRepair.count, 1);
    assert.deepEqual(claudeRound2.meta.controlRepair.errorCodes, ["missing_control"]);
    assert.equal(claudeRound2.meta.controlRepair.failureCode, "provider_error");
    assert.equal(claudeRound2.meta.retryCount, 0);
    const outcome = saved.messages.find((message) => message.meta?.outcome)?.meta.outcome;
    assert.equal(outcome.controlRepairStats.failedCalls, 1);
    assert.equal("usage" in outcome.controlRepairStats, false);
  } finally {
    await cleanupSession(session.id);
  }
});

test("stopping during control repair rejects the late repaired control", async (t) => {
  const session = await createSession("control-repair-cancellation");
  const repairStarted = deferred();
  const releaseRepair = deferred();
  const events = [];
  let claudeCalls = 0;

  t.mock.method(provider("claude"), "run", async () => {
    claudeCalls += 1;
    if (claudeCalls === 1) return providerResult("Claude opening");
    if (claudeCalls === 2) return providerResult("Claude agrees without a control block.");
    repairStarted.resolve();
    await releaseRepair.promise;
    return providerResult(controlBlock("satisfied", []));
  });
  t.mock.method(provider("codex"), "run", async () => {
    if (events.some((event) => event.type === "agent_complete" && event.agent === "codex")) {
      return providerResult(controlBlock("satisfied", []));
    }
    return providerResult("Codex opening");
  });

  const runPromise = runOrchestration(session.id, {
    mode: "collaboration",
    rounds: 2,
    content: "Stop during repair",
    finalizer: "none",
    agents: {
      claude: { enabled: true, role: "Collaborator" },
      codex: { enabled: true, role: "Collaborator" },
    },
  }, (event) => events.push(event));

  try {
    await repairStarted.promise;
    assert.equal(await stopRun(session.id, { settleTimeoutMs: 50 }), true);
    releaseRepair.resolve();
    await runPromise;

    const saved = await getSession(session.id);
    assert.equal(saved.status, "stopped");
    assert.equal(saved.activeRun.status, "stopped");
    assert.equal(saved.messages.some((message) => message.meta?.controlRepair?.status === "succeeded"), false);
    assert.equal(events.filter((event) => event.type === "run_stopped").length, 1);
  } finally {
    releaseRepair.resolve();
    await runPromise;
    await cleanupSession(session.id);
  }
});

test("truncated repair output is rejected without storing raw provider output", async (t) => {
  const session = await createSession("control-verbatim");
  const badBlock = `<agent-control>${JSON.stringify({ controlVersion: 2, convergence: "bogus", goalStatus: "satisfied", substantiveDelta: false, itemProposals: [], targetVersion: 1 })}</agent-control>`;
  const result = (text) => ({ text, model: "test", durationMs: 1, exitCode: 0, sessionId: null });
  let claudeCalls = 0;
  t.mock.method(provider("claude"), "run", async () => {
    claudeCalls += 1;
    if (claudeCalls === 1) return result("Claude opening proposal");
    if (claudeCalls === 2) return result(`Claude agrees.\n${badBlock}`);
    return { ...result(controlBlock("satisfied", [])), outputTruncated: true };
  });
  t.mock.method(provider("codex"), "run", async () => result(`Codex.\n${controlBlock("satisfied", [])}`));

  try {
    await runOrchestration(session.id, {
      mode: "collaboration",
      rounds: 2,
      content: "Plan the change",
      finalizer: "none",
      agents: { claude: { enabled: true, role: "Collaborator" }, codex: { enabled: true, role: "Collaborator" } },
    }, () => {});

    const saved = await getSession(session.id);
    const claudeRound2 = saved.messages.find((m) => m.agent === "claude" && m.round === 2 && m.phase === "collaboration");
    assert.equal(claudeRound2.control.valid, false);
    assert.equal(claudeRound2.meta.controlInvalidRaw, undefined);
    assert.equal(claudeRound2.meta.controlRepair.status, "failed");
    assert.deepEqual(claudeRound2.meta.controlRepair.errorCodes, ["invalid_control_schema"]);
    assert.equal(claudeRound2.meta.controlRepair.failureCode, "output_truncated");
    assert.equal(claudeRound2.meta.controlRepair.outputTruncated, true);
    assert.equal(claudeRound2.meta.controlRepair.repairedControl.value.valid, true);
    assert.match(claudeRound2.content, /Claude agrees\./); // reader-facing answer preserved, block stripped
    assert.doesNotMatch(claudeRound2.content, /agent-control/);
  } finally {
    await cleanupSession(session.id);
  }
});

test("a debate runs opening then rebuttal, converges early, and finalizes once", async (t) => {
  const session = await createSession("debate-convergence");
  let claudeCalls = 0;
  let codexCalls = 0;

  t.mock.method(provider("claude"), "run", async () => {
    claudeCalls += 1;
    // Round 1 opening is independent and carries NO control block (debate opening ≠ rebuttal).
    if (claudeCalls === 1) return providerResult("Claude opening: in-process cache is simpler for one node.");
    // Round 2 rebuttal concedes and converges (delta-free) so the run stops before round 3.
    if (claudeCalls === 2) return providerResult(`Claude concedes Redis wins once you scale.\n${controlBlock("satisfied", [])}`);
    // Third call is the synthesis brief (finalizer = claude); synthesis never carries a control block.
    return providerResult("Decision brief: Redis for horizontal scale; the choice remains the user's.");
  });
  t.mock.method(provider("codex"), "run", async () => {
    codexCalls += 1;
    if (codexCalls === 1) return providerResult("Codex opening: use Redis to scale horizontally.");
    return providerResult(`Codex agrees the tradeoff is settled.\n${controlBlock("satisfied", [])}`);
  });

  try {
    await runOrchestration(session.id, {
      mode: "debate",
      rounds: 3,
      content: "Redis or in-process cache?",
      finalizer: "claude",
      agents: {
        claude: { enabled: true, role: "Debater" },
        codex: { enabled: true, role: "Debater" },
      },
    }, () => {});

    const saved = await getSession(session.id);
    assert.equal(saved.status, "completed");
    assert.equal(saved.activeRun.status, "completed");

    // Debate's distinctive phases: round 1 = "opening", later rounds = "rebuttal" — never "collaboration".
    const opening = saved.messages.filter((message) => message.phase === "opening");
    const rebuttal = saved.messages.filter((message) => message.phase === "rebuttal");
    const synthesis = saved.messages.filter((message) => message.phase === "synthesis");
    assert.equal(saved.messages.some((message) => message.phase === "collaboration"), false);
    assert.equal(opening.length, 2); // one opening per participant
    assert.deepEqual([...new Set(opening.map((message) => message.round))], [1]);
    // Converged on the first rebuttal round → stops early (round 2 only, not the full 3).
    assert.equal(rebuttal.length, 2);
    assert.deepEqual([...new Set(rebuttal.map((message) => message.round))], [2]);
    assert.equal(synthesis.length, 1);

    const outcomeMessage = saved.messages.find((message) => message.meta?.outcome);
    assert.equal(outcomeMessage.meta.outcome.agreementState, "converged");
    assert.equal(outcomeMessage.meta.outcome.completionState, "satisfied");
    assert.equal(outcomeMessage.meta.outcome.requestedRounds, 3);
    assert.equal(outcomeMessage.meta.outcome.completedRounds, 2);
  } finally {
    await cleanupSession(session.id);
  }
});

test("orchestration request validation rejects unsupported or inconsistent configurations", () => {
  const base = collaborationRequest("Validate this request");
  const cases = [
    ["unsupported mode", { ...base, mode: "parliament" }, "invalid_mode"],
    ["invalid rounds", { ...base, rounds: 0 }, "invalid_rounds"],
    ["one participant", { ...base, agents: { claude: { enabled: true } } }, "invalid_participants"],
    [
      "unknown enabled provider",
      { ...base, agents: { ...base.agents, nonexistent: { enabled: true } } },
      "invalid_provider",
    ],
    ["unselected finalizer", { ...base, finalizer: "cursor" }, "invalid_finalizer"],
    [
      "oversized role",
      {
        ...base,
        agents: {
          ...base.agents,
          claude: { ...base.agents.claude, role: "x".repeat(181) },
        },
      },
      "invalid_agent_role",
    ],
  ];

  for (const [label, request, expectedCode] of cases) {
    assert.throws(
      () => validateOrchestrationRequest(request),
      (error) => error.apiStatus === 400 && error.apiCode === expectedCode,
      label,
    );
  }
});

test("2026-07-16 regression: provider failure stays terminal after a late sibling result", async (t) => {
  const session = await createSession("provider-failure-race");
  const releaseCodex = deferred();
  const claudeFailed = deferred();
  const events = [];

  t.mock.method(provider("claude"), "run", async () => {
    claudeFailed.resolve();
    throw new Error("controlled provider failure");
  });
  t.mock.method(provider("codex"), "run", async () => {
    await releaseCodex.promise;
    return providerResult("late Codex response");
  });

  try {
    const runPromise = runOrchestration(session.id, chatRequest("Reproduce the provider race"), (event) => events.push(event));
    await claudeFailed.promise;
    await nextEventLoopTurn();
    releaseCodex.resolve();
    await runPromise;
    await drainSessionWrites(session.id);

    const saved = await getSession(session.id);
    assert.equal(saved.status, "error");
    assert.equal(saved.activeRun.status, "error");
    assert.ok(saved.activeRun.endedAt);
    assert.equal(saved.messages.some((message) => message.content === "late Codex response"), false);
    assert.equal(events.filter((event) => event.type === "run_error").length, 1);
    assert.equal(events.some((event) => event.type === "agent_complete" && event.agent === "codex"), false);
    assertSingleRunIdentity(events);
  } finally {
    releaseCodex.resolve();
    await cleanupSession(session.id);
  }
});

test("2026-07-16 regression: stopping a run rejects provider results that return during cancellation", async (t) => {
  const session = await createSession("provider-stop-race");
  const releaseClaude = deferred();
  const releaseCodex = deferred();
  const bothStarted = deferred();
  const events = [];
  let starts = 0;

  t.mock.method(provider("claude"), "run", async () => {
    await releaseClaude.promise;
    return providerResult("late Claude response");
  });
  t.mock.method(provider("codex"), "run", async () => {
    await releaseCodex.promise;
    return providerResult("late Codex response");
  });

  const runPromise = runOrchestration(session.id, chatRequest("Stop this run"), (event) => {
    events.push(event);
    if (event.type === "agent_start" && ++starts === 2) bothStarted.resolve();
  });

  try {
    await bothStarted.promise;
    const stopPromise = stopRun(session.id);
    await nextEventLoopTurn();
    releaseClaude.resolve();
    releaseCodex.resolve();
    assert.equal(await stopPromise, true);
    await runPromise;

    const saved = await getSession(session.id);
    assert.equal(saved.status, "stopped");
    assert.equal(saved.activeRun.status, "stopped");
    assert.equal(saved.messages.some((message) => message.meta?.status === "completed"), false);
    assert.equal(events.filter((event) => event.type === "agent_complete").length, 0);
    assert.equal(events.filter((event) => event.type === "run_stopped").length, 1);
    assertSingleRunIdentity(events);
  } finally {
    releaseClaude.resolve();
    releaseCodex.resolve();
    await runPromise;
    await cleanupSession(session.id);
  }
});

test("startup reconciliation terminalizes a stored running discussion exactly once", async () => {
  const session = await createSession("interrupted-discussion-recovery");
  const runId = "11111111-1111-4111-8111-111111111111";
  await mutateSession(session.id, (stored) => {
    stored.status = "running";
    stored.activeRun = {
      runId,
      mode: "collaboration",
      status: "running",
      startedAt: "2026-07-15T12:00:00.000Z",
    };
  });

  try {
    await reconcileInterruptedRuns("test_restart");
    await reconcileInterruptedRuns("test_restart");
    const saved = await getSession(session.id);
    assert.equal(saved.status, "interrupted");
    assert.equal(saved.activeRun.status, "interrupted");
    assert.equal(saved.activeRun.runId, runId);
    assert.equal(saved.activeRun.interruptionReason, "test_restart");
    assert.equal(saved.messages.filter((message) => message.meta?.recovery && message.meta.runId === runId).length, 1);
  } finally {
    await cleanupSession(session.id);
  }
});

test("first collaboration opinions start independently before either provider returns", async (t) => {
  const session = await createSession("independent-collaboration-opening");
  const claudeOpening = "CLAUDE_OPENING_MUST_NOT_REACH_CODEX";
  let codexPrompt = "";

  t.mock.method(provider("claude"), "run", async () => providerResult(claudeOpening));
  t.mock.method(provider("codex"), "run", async ({ prompt }) => {
    codexPrompt = prompt;
    return providerResult("Codex opening");
  });

  try {
    await runOrchestration(session.id, collaborationRequest("Collect independent opinions"), () => {});
    assert.doesNotMatch(codexPrompt, new RegExp(claudeOpening));
  } finally {
    await cleanupSession(session.id);
  }
});

test("2026-07-16 regression: a stop finalizes a run whose providers never settle", async (t) => {
  const session = await createSession("stop-settle-timeout");
  const bothStarted = deferred();
  // Providers stay pending (no child to kill) until the test releases them — a real stall in the
  // un-timed setup phase. Using a resolvable deferred (not an un-resolvable promise) lets the run
  // body unwind at the end, so the node:test runner is not left with a dangling promise.
  const releaseProviders = deferred();
  // stopRun's settle-timeout timer is unref'd so it can't hold a shutting-down process open; in
  // production the running HTTP server keeps the loop alive. This test has no such handle, so hold
  // the loop open ourselves — otherwise it drains during the settle wait and node:test cancels the
  // test with "Promise resolution is still pending" (seen on the Node 22 CI runner, not Node 24).
  const keepLoopAlive = setInterval(() => {}, 25);
  const events = [];
  let starts = 0;

  t.mock.method(provider("claude"), "run", async () => { await releaseProviders.promise; return providerResult("unreachable"); });
  t.mock.method(provider("codex"), "run", async () => { await releaseProviders.promise; return providerResult("unreachable"); });

  const runPromise = runOrchestration(session.id, chatRequest("Stop a stalled run"), (event) => {
    events.push(event);
    if (event.type === "agent_start" && ++starts === 2) bothStarted.resolve();
  });
  runPromise.catch(() => {});

  try {
    await bothStarted.promise;
    // The settle wait must give up quickly and force-finalize instead of leaving it "running".
    assert.equal(await stopRun(session.id, { settleTimeoutMs: 50 }), true);

    const saved = await getSession(session.id);
    assert.equal(saved.status, "stopped");
    assert.equal(saved.activeRun.status, "stopped");
    assert.equal(isRunning(session.id), false);
    // The activity claim must also be released, or the session stays wedged as 409 "busy" forever
    // even though it reads "stopped". Claiming + immediately releasing proves it is usable again.
    assert.doesNotThrow(() => claimSessionActivity(session.id, "post-stop-check")());
    assert.equal(events.filter((event) => event.type === "run_stopped").length, 1);
    assert.equal(events.some((event) => event.type === "agent_complete"), false);
    assertSingleRunIdentity(events);
  } finally {
    clearInterval(keepLoopAlive);
    // Release the stalled providers so the run body unwinds (their late results are discarded
    // because the run is already terminal), then await it so no pending promise outlives the test.
    releaseProviders.resolve();
    await runPromise.catch(() => {});
    await cleanupSession(session.id);
  }
});
