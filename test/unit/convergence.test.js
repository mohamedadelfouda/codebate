import test from "node:test";
import assert from "node:assert/strict";
import {
  assessRound,
  CONTROL_REPAIRABLE_ERRORS,
  parseAgentControl,
  stripAgentControl,
  validateControlRepair,
} from "../../server/convergence.js";

function legacyBlock(overrides = {}) {
  return `<agent-control>${JSON.stringify({
    convergence: "converged",
    goalStatus: "satisfied",
    substantiveDelta: false,
    openPoints: [],
    confidence: 0.9,
    targetVersion: 2,
    ...overrides,
  })}</agent-control>`;
}

function block(overrides = {}) {
  return `<agent-control>${JSON.stringify({
    controlVersion: 2,
    convergence: "converged",
    goalStatus: "satisfied",
    substantiveDelta: false,
    itemProposals: [],
    targetVersion: 2,
    ...overrides,
  })}</agent-control>`;
}

function control(overrides = {}) {
  return parseAgentControl(block(overrides));
}

function create(kind, text, actor, action) {
  return { action: "create", kind, text, requiredStep: { actor, action } };
}

function item(itemId, kind, text, actor, action, status = "open") {
  return { itemId, kind, status, text, requiredStep: { actor, action } };
}

test("parseAgentControl accepts the version 2 proposal contract", () => {
  const parsed = parseAgentControl(`reader-facing answer\n${block({
    goalStatus: "needs_user",
    itemProposals: [create("user_decision", "Choose a mode", "user", "provide_decision")],
  })}`);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.controlVersion, 2);
  assert.equal(parsed.itemProposals[0].action, "create");
  assert.equal(parsed.confidence, null);
});

test("legacy controls remain readable without treating open points as categorized items", () => {
  const parsed = parseAgentControl(legacyBlock({ openPoints: ["scope"] }));
  assert.equal(parsed.valid, true);
  assert.equal(parsed.controlVersion, 1);
  assert.deepEqual(parsed.openPoints, ["scope"]);
  assert.deepEqual(parsed.itemProposals, []);
});

test("missing, malformed, and schema-invalid controls fail closed", () => {
  const invalidTexts = [
    "reader-facing answer only",
    "<agent-control>{not json}</agent-control>",
    block({ confidence: 0.9 }),
    block({ openPoints: [] }),
    block({ targetVersion: 0 }),
    block({ itemProposals: [create("user_decision", "Choose", "agent", "provide_decision")] }),
    block({ itemProposals: [{ action: "merge_into", itemId: "item-001", targetItemId: "item-001" }] }),
    block({ itemProposals: [{ action: "resolve", itemId: "item-001" }, { action: "keep_open", itemId: "item-001" }] }),
  ];
  for (const text of invalidTexts) {
    const parsed = parseAgentControl(text);
    assert.equal(parsed.valid, false);
    assert.equal(parsed.goalStatus, "incomplete");
  }
});

test("a well-formed control survives reader-facing prose around it", () => {
  // Prose before or after the block (a sign-off line, a stray fence) must not invalidate an
  // otherwise valid block — that brittleness caused false invalid_control stops after real
  // agreement. The JSON shape and schema stay strict; only the position rule is relaxed.
  assert.equal(parseAgentControl(`${block()}\nHope this helps!`).valid, true);
  assert.equal(parseAgentControl(`intro\n${block()}\n\`\`\``).valid, true);
  // A schema-invalid block still fails closed even with surrounding prose.
  assert.equal(parseAgentControl(`${block({ confidence: 0.9 })}\ntrailing`).valid, false);
});

test("parse and strip agree on block boundaries with unclosed or extra tags", () => {
  const valid = block();
  const clean = `intro ${valid} outro`;
  assert.equal(parseAgentControl(clean).valid, true);
  assert.doesNotMatch(stripAgentControl(clean), /agent-control/);
  assert.match(stripAgentControl(clean), /intro/);
  assert.match(stripAgentControl(clean), /outro/);
  // A stray unclosed open tag before the real block: first-open pairs with the first close, so
  // the whole span is one malformed block. Parse and strip must use the same scanner.
  const noisy = `<agent-control>stray ${valid}`;
  assert.equal(parseAgentControl(noisy).valid, false);
  assert.equal(stripAgentControl(noisy), "");
});

test("the final control block is authoritative and all blocks are stripped", () => {
  const text = `answer\n${block({ convergence: "open", goalStatus: "incomplete" })}\ncorrection\n${block()}`;
  assert.equal(parseAgentControl(text).convergence, "converged");
  assert.equal(stripAgentControl(text), "answer\n\ncorrection");
});

test("a complete aligned round stops with an empty official registry", () => {
  const result = assessRound([control(), control()], 2);
  assert.equal(result.canStop, true);
  assert.equal(result.agreementState, "converged");
  assert.equal(result.completionState, "satisfied");
  assert.equal(result.stopReason, "complete");
  assert.deepEqual(result.itemRegistry, []);
});

test("awaitingConfirmation gates one confirmation round when a converged round carried a late change", () => {
  // Agents run in parallel on one shared snapshot: a substantive change made this round isn't visible to
  // the others yet, so the round can't stop — but the NEXT round is an explicit confirmation round
  // (tightened prompt) instead of an endless drift of marginal re-tweaks. canStop and
  // awaitingConfirmation are mutually exclusive by construction.
  const settled = assessRound([control(), control()], 2);
  assert.equal(settled.canStop, true);
  assert.equal(settled.awaitingConfirmation, false);
  assert.equal(settled.continueReason, "stopped");

  const lateChange = assessRound([control(), control({ substantiveDelta: true })], 2);
  assert.equal(lateChange.canStop, false);
  assert.equal(lateChange.awaitingConfirmation, true);
  assert.equal(lateChange.agreementState, "converged");
  assert.equal(lateChange.continueReason, "awaiting_confirmation");
});

test("a repeat confirmation round stops instead of looping on over-signalled substantiveDelta", () => {
  // In the confirmation round the agents are still converged but a provider AGAIN reports a marginal
  // substantiveDelta. Without the cap this loops to the round limit; with confirmationRound=true the round
  // stops (the bounded one-confirmation-round contract). A real disagreement would flip agreementState off
  // "converged", so genuine conflict still keeps going.
  const controls = [control(), control({ substantiveDelta: true })];
  // The first late-change round (not yet a confirmation round) still only asks for confirmation.
  assert.equal(assessRound(controls, 2).awaitingConfirmation, true);
  // THIS is the confirmation round → stop, converged, and not awaiting again.
  const confirmed = assessRound(controls, 2, [], true);
  assert.equal(confirmed.canStop, true);
  assert.equal(confirmed.awaitingConfirmation, false);
  assert.equal(confirmed.agreementState, "converged");
  assert.equal(confirmed.continueReason, "stopped");
});

test("a user decision stops discussion and produces one derived next step", () => {
  const result = assessRound([
    control({ goalStatus: "needs_user", itemProposals: [create("user_decision", "Choose the rollout mode", "user", "provide_decision")] }),
    control({ goalStatus: "needs_user", itemProposals: [create("user_decision", "choose the rollout mode.", "user", "provide_decision")] }),
  ], 2);
  assert.equal(result.canStop, true);
  assert.equal(result.completionState, "needs_user");
  assert.equal(result.stopReason, "user_decision");
  assert.equal(result.itemRegistry.length, 1);
  assert.deepEqual(result.nextSteps, [{ actor: "user", action: "provide_decision", itemIds: ["item-001"] }]);
});

test("multiple pending kinds are preserved while completion stays conservative", () => {
  const result = assessRound([
    control({
      goalStatus: "blocked",
      itemProposals: [create("external_validation", "Verify containment", "human_operator", "run_external_check")],
    }),
    control({
      goalStatus: "needs_user",
      itemProposals: [create("user_decision", "Choose the provider", "user", "provide_decision")],
    }),
  ], 2);
  assert.equal(result.canStop, true);
  assert.equal(result.completionState, "blocked");
  assert.deepEqual(new Set(result.pendingKinds), new Set(["external_validation", "user_decision"]));
  assert.equal(result.nextSteps.length, 2);
});

test("an external follow-up cannot be certified as satisfied", () => {
  const result = assessRound([
    control({ itemProposals: [create("external_validation", "Measure token use later", "orchestrator", "run_external_check")] }),
    control(),
  ], 2);
  // H4: the itemRegistry is the source of truth. An external_validation item derives
  // completionState=blocked and the session stops cleanly on it (agents agreed; the only thing left is an
  // outside check), instead of the round being invalidated. The declared goalStatus=satisfied is normalized
  // to the registry via a warning, not a consistency error.
  assert.equal(result.completionState, "blocked");
  assert.equal(result.stopReason, "external_block");
  assert.equal(result.canStop, true);
  assert.equal(result.itemRegistry.length, 1);
  assert.equal(result.itemRegistry[0].kind, "external_validation");
  assert.equal(result.consistencyErrors.length, 0);
  assert.equal(result.warnings.some((warning) => warning.code === "goal_status_normalized"), true);
});

test("control parsing exposes closed repair diagnostics without broadening the whitelist", () => {
  assert.deepEqual(
    CONTROL_REPAIRABLE_ERRORS,
    new Set([
      "missing_control",
      "invalid_control_json",
      "invalid_control_schema",
      "target_version_mismatch",
      "unaddressed_open_item",
    ]),
  );
  assert.deepEqual(parseAgentControl("reader-facing answer").errorCodes, ["missing_control"]);
  assert.deepEqual(parseAgentControl("<agent-control>{broken}</agent-control>").errorCodes, ["invalid_control_json"]);
  assert.deepEqual(parseAgentControl(block({ confidence: 0.5 })).errorCodes, ["invalid_control_schema"]);
});

test("2026-07-18 regression: a terminal claim cannot omit an approved open item", () => {
  const registry = [item("item-001", "user_decision", "Choose a mode", "user", "provide_decision")];
  const result = assessRound([control(), control()], 2, registry);

  assert.equal(result.canStop, false);
  assert.equal(result.stopReason, "invalid_control");
  assert.equal(result.itemRegistry[0].status, "open");
  assert.deepEqual(
    result.consistencyErrors.filter((error) => error.code === "unaddressed_open_item").map((error) => error.controlIndex),
    [0, 1],
  );
});

test("a satisfied terminal claim cannot keep an approved item open", () => {
  const registry = [item("item-001", "user_decision", "Choose a mode", "user", "provide_decision")];
  const keepOpen = [{ action: "keep_open", itemId: "item-001" }];
  const result = assessRound([
    control({ itemProposals: keepOpen }),
    control({ itemProposals: keepOpen }),
  ], 2, registry);

  assert.equal(result.canStop, false);
  assert.equal(result.itemRegistry[0].status, "open");
  assert.equal(result.consistencyErrors.some((error) => error.code === "terminal_item_kept_open"), true);
  assert.deepEqual(result.repairTargets, []);
});

test("repair targets identify only stale or structurally incomplete controls", () => {
  const registry = [item("item-001", "user_decision", "Choose a mode", "user", "provide_decision")];
  const stale = control({ targetVersion: 1 });
  const result = assessRound([stale, control()], 2, registry);

  assert.deepEqual(result.repairTargets, [
    {
      controlIndex: 0,
      errorCodes: ["target_version_mismatch", "unaddressed_open_item"],
      itemIds: ["item-001"],
    },
    {
      controlIndex: 1,
      errorCodes: ["unaddressed_open_item"],
      itemIds: ["item-001"],
    },
  ]);
});

test("a valid terminal omission stays repairable when a peer control is invalid", () => {
  const registry = [item("item-001", "user_decision", "Choose a mode", "user", "provide_decision")];
  const missing = parseAgentControl("reader-facing answer without a control");
  const result = assessRound([control(), missing], 2, registry);

  assert.deepEqual(result.repairTargets, [
    {
      controlIndex: 0,
      errorCodes: ["unaddressed_open_item"],
      itemIds: ["item-001"],
    },
    {
      controlIndex: 1,
      errorCodes: ["missing_control"],
      itemIds: [],
    },
  ]);
});

test("narrow repair preserves every unaffected control field and proposal", () => {
  const original = control({
    itemProposals: [{ action: "keep_open", itemId: "item-002" }],
  });
  const target = {
    controlIndex: 0,
    errorCodes: ["unaddressed_open_item"],
    itemIds: ["item-001"],
  };
  const repaired = control({
    itemProposals: [
      { action: "keep_open", itemId: "item-002" },
      { action: "resolve", itemId: "item-001" },
    ],
  });
  assert.deepEqual(validateControlRepair(original, repaired, target, 2), { valid: true, errorCode: null });

  const changedDelta = control({
    substantiveDelta: true,
    itemProposals: [
      { action: "keep_open", itemId: "item-002" },
      { action: "resolve", itemId: "item-001" },
    ],
  });
  assert.deepEqual(
    validateControlRepair(original, changedDelta, target, 2),
    { valid: false, errorCode: "repair_scope_violation" },
  );

  const changedUnrelatedProposal = control({
    itemProposals: [
      { action: "resolve", itemId: "item-002" },
      { action: "resolve", itemId: "item-001" },
    ],
  });
  assert.deepEqual(
    validateControlRepair(original, changedUnrelatedProposal, target, 2),
    { valid: false, errorCode: "repair_scope_violation" },
  );
});

test("a malformed control may be fully regenerated but still needs the current contract", () => {
  const missing = parseAgentControl("reader-facing answer");
  const target = { controlIndex: 0, errorCodes: ["missing_control"], itemIds: [] };
  assert.deepEqual(validateControlRepair(missing, control(), target, 2), { valid: true, errorCode: null });
  assert.deepEqual(
    validateControlRepair(missing, control({ targetVersion: 1 }), target, 2),
    { valid: false, errorCode: "invalid_control_schema" },
  );
});

test("required-step precedence is deterministic for every registry order", () => {
  const openItems = [
    item("item-001", "remaining_work", "Finish the patch", "agent", "resume_agent_round"),
    item("item-002", "external_validation", "Run the external check", "orchestrator", "run_external_check"),
    item("item-003", "user_decision", "Choose the rollout", "user", "provide_decision"),
  ];
  const permutations = [
    openItems,
    [openItems[0], openItems[2], openItems[1]],
    [openItems[1], openItems[0], openItems[2]],
    [openItems[1], openItems[2], openItems[0]],
    [openItems[2], openItems[0], openItems[1]],
    [openItems[2], openItems[1], openItems[0]],
  ];

  for (const registry of permutations) {
    const result = assessRound([
      control({ goalStatus: "incomplete" }),
      control({ goalStatus: "incomplete" }),
    ], 2, registry);
    assert.equal(result.completionState, "incomplete");
    assert.equal(result.stopReason, null);
  }

  const withoutAgentWork = openItems.map((registryItem) => (
    registryItem.itemId === "item-001" ? { ...registryItem, status: "resolved" } : registryItem
  ));
  const keepPending = [
    { action: "keep_open", itemId: "item-002" },
    { action: "keep_open", itemId: "item-003" },
  ];
  const blocked = assessRound([
    control({ goalStatus: "blocked", itemProposals: keepPending }),
    control({ goalStatus: "blocked", itemProposals: keepPending }),
  ], 2, withoutAgentWork);
  assert.equal(blocked.completionState, "blocked");
  assert.equal(blocked.canStop, true);

  const onlyUser = withoutAgentWork.map((registryItem) => (
    registryItem.itemId === "item-002" ? { ...registryItem, status: "resolved" } : registryItem
  ));
  const needsUser = assessRound([
    control({ goalStatus: "needs_user", itemProposals: [{ action: "keep_open", itemId: "item-003" }] }),
    control({ goalStatus: "needs_user", itemProposals: [{ action: "keep_open", itemId: "item-003" }] }),
  ], 2, onlyUser);
  assert.equal(needsUser.completionState, "needs_user");
  assert.equal(needsUser.canStop, true);
});

test("agreement stops the rounds; pending agent work, disagreement, and change continue", () => {
  // Plain converged + incomplete now STOPS on agreement: once neither agent is adding anything
  // and nothing needs another agent round, more rounds only repeat. Completion stays reported.
  const settled = assessRound([control({ goalStatus: "incomplete" }), control({ goalStatus: "incomplete" })], 2);
  assert.equal(settled.agreementState, "converged");
  assert.equal(settled.canStop, true);
  assert.equal(settled.stopReason, "complete");

  // The safeguard against cutting off work: an explicit remaining_work item keeps the rounds
  // going even when the agents agree, because it requires another agent round.
  const remainingWork = create("remaining_work", "Wire the retry path end to end", "agent", "resume_agent_round");
  const moreWork = assessRound([
    control({ goalStatus: "incomplete", itemProposals: [remainingWork] }),
    control({ goalStatus: "incomplete" }),
  ], 2);
  assert.equal(moreWork.agreementState, "converged");
  assert.equal(moreWork.canStop, false);

  const disagreementProposal = create("disagreement", "The permission boundary is unresolved", "agent", "resume_agent_round");
  const disagreement = assessRound([
    control({ convergence: "open", goalStatus: "incomplete", itemProposals: [disagreementProposal] }),
    control({ convergence: "open", goalStatus: "incomplete" }),
  ], 2);
  assert.equal(disagreement.agreementState, "open");
  assert.deepEqual(disagreement.disagreements, ["The permission boundary is unresolved"]);
  assert.equal(disagreement.canStop, false);

  const changed = assessRound([control({ substantiveDelta: true }), control()], 2);
  assert.equal(changed.proposalChanged, true);
  assert.equal(changed.canStop, false);
});

test("a parseable but inconsistent round still surfaces the raised disagreement", () => {
  // needs_user without a user_decision item is a consistency error, so the round can't certify —
  // but the individual controls parsed, so the disagreement the agents raised must stay visible.
  const raised = create("disagreement", "Motivation vs learning-journey quality", "agent", "resume_agent_round");
  const result = assessRound([
    control({ convergence: "open", goalStatus: "needs_user", itemProposals: [raised] }),
    control({ convergence: "open", goalStatus: "satisfied" }),
  ], 2);
  assert.equal(result.allValid, false);
  assert.equal(result.controlsParseable, true);
  assert.equal(result.consistencyErrors.some((error) => error.code === "missing_user_decision"), true);
  // H4: the declared-vs-registry completion mismatch is now a normalization warning, not an invalidating
  // error — the round is still invalid here, but only because of the real missing_user_decision error.
  assert.equal(result.warnings.some((warning) => warning.code === "goal_status_normalized"), true);
  assert.deepEqual(result.proposedDisagreements, ["Motivation vs learning-journey quality"]);
});

test("missing, invalid, stale, and round-inconsistent controls fail closed", () => {
  const valid = control();
  const cases = [
    [assessRound([valid], 2), "missing participant"],
    [assessRound([valid, parseAgentControl("bad")], 2), "invalid control"],
    [assessRound([valid, control({ targetVersion: 1 })], 2), "stale control"],
    [assessRound([control({ goalStatus: "needs_user" }), control({ goalStatus: "needs_user" })], 2), "missing user item"],
    [assessRound([control({ goalStatus: "blocked" }), control({ goalStatus: "blocked" })], 2), "missing external item"],
    [assessRound([valid, valid], 2, [{
      ...item("item-001", "external_validation", "Corrupt merge", "human_operator", "run_external_check", "superseded"),
      mergedIntoId: "item-001",
    }]), "cyclic registry"],
  ];
  for (const [result, label] of cases) {
    assert.equal(result.canStop, false, label);
    assert.equal(result.stopReason, "invalid_control", label);
    assert.equal(result.agreementState, "unknown", label);
  }
});

test("legacy open points fail closed without being relabeled as disagreement", () => {
  const legacy = parseAgentControl(legacyBlock({ openPoints: ["scope"] }));
  const result = assessRound([legacy, legacy], 2);
  assert.equal(result.canStop, false);
  assert.equal(result.agreementState, "unknown");
  assert.deepEqual(result.disagreements, []);
  assert.deepEqual(result.unclassifiedPoints, ["scope"]);
});

test("official items close only when every participant proposes resolution", () => {
  const registry = [item("item-001", "user_decision", "Choose a mode", "user", "provide_decision")];
  const resolved = assessRound([
    control({ itemProposals: [{ action: "resolve", itemId: "item-001" }] }),
    control({ itemProposals: [{ action: "resolve", itemId: "item-001" }] }),
  ], 2, registry);
  assert.equal(resolved.itemRegistry[0].status, "resolved");
  assert.equal(resolved.canStop, true);

  const disputed = assessRound([
    control({ goalStatus: "needs_user", itemProposals: [{ action: "resolve", itemId: "item-001" }] }),
    control({ goalStatus: "needs_user", itemProposals: [{ action: "keep_open", itemId: "item-001" }] }),
  ], 2, registry);
  assert.equal(disputed.itemRegistry[0].status, "open");
  assert.equal(disputed.agreementState, "open");
  assert.equal(disputed.canStop, false);
});

test("unanimous merge supersedes only into an existing open target", () => {
  const registry = [
    item("item-001", "external_validation", "Canonical check", "human_operator", "run_external_check"),
    item("item-002", "external_validation", "Duplicate check", "human_operator", "run_external_check"),
  ];
  const merge = [
    { action: "keep_open", itemId: "item-001" },
    { action: "merge_into", itemId: "item-002", targetItemId: "item-001" },
  ];
  const result = assessRound([
    control({ goalStatus: "blocked", itemProposals: merge }),
    control({ goalStatus: "blocked", itemProposals: merge }),
  ], 2, registry);
  assert.equal(result.itemRegistry[1].status, "superseded");
  assert.equal(result.itemRegistry[1].mergedIntoId, "item-001");
  assert.equal(result.canStop, true);

  const cycle = [
    { action: "merge_into", itemId: "item-001", targetItemId: "item-002" },
    { action: "merge_into", itemId: "item-002", targetItemId: "item-001" },
  ];
  const invalid = assessRound([
    control({ goalStatus: "blocked", itemProposals: cycle }),
    control({ goalStatus: "blocked", itemProposals: cycle }),
  ], 2, registry);
  assert.equal(invalid.canStop, false);
  assert.equal(invalid.stopReason, "invalid_control");
});

test("exact topic classification conflicts remain visible and prevent a false terminal result", () => {
  const result = assessRound([
    control({ goalStatus: "needs_user", itemProposals: [create("user_decision", "Choose route.", "user", "provide_decision")] }),
    control({ goalStatus: "blocked", itemProposals: [create("external_validation", "choose route", "human_operator", "run_external_check")] }),
  ], 2);
  assert.equal(result.itemRegistry.length, 2);
  assert.equal(result.conflicts[0].code, "classification_conflict");
  assert.equal(result.agreementState, "open");
  assert.equal(result.canStop, false);
});

test("assessment works for every participant count accepted by the protocol", () => {
  const proposal = create("user_decision", "Choose the final mode", "user", "provide_decision");
  const result = assessRound(Array.from({ length: 3 }, () => control({ goalStatus: "needs_user", itemProposals: [proposal] })), 2);
  assert.equal(result.allPresent, true);
  assert.equal(result.itemRegistry.length, 1);
  assert.equal(result.canStop, true);
});
