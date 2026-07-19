const OPEN_TAG = "<agent-control>";
const CLOSE_TAG = "</agent-control>";
const CONTROL_VERSION = 2;

// Every complete <agent-control>…</agent-control> block, scanned left-to-right with each open
// paired to the NEXT close (non-overlapping) — the same semantics the original lazy regex had,
// but with linear indexOf scans that can't backtrack. Agent turns can reach several MB (see
// output-limits), and a lazy `<agent-control>[\s\S]*?</agent-control>` over many unclosed tags is
// O(n²) — a synchronous scan that would freeze the single Node event loop for the whole server.
// One shared scanner keeps parse/strip/raw agreeing on exactly which spans are blocks.
function controlBlocks(source) {
  const lower = source.toLowerCase();
  const blocks = [];
  let cursor = 0;
  for (;;) {
    const openAt = lower.indexOf(OPEN_TAG, cursor);
    if (openAt === -1) break;
    const closeAt = lower.indexOf(CLOSE_TAG, openAt + OPEN_TAG.length);
    if (closeAt === -1) break;
    const end = closeAt + CLOSE_TAG.length;
    blocks.push({ start: openAt, end, inner: source.slice(openAt + OPEN_TAG.length, closeAt) });
    cursor = end;
  }
  return blocks;
}
const CONVERGENCE = new Set(["converged", "open", "not_evaluated"]);
const GOAL_STATUS = new Set(["satisfied", "incomplete", "blocked", "needs_user"]);
const ITEM_KINDS = new Set(["disagreement", "user_decision", "external_validation", "remaining_work", "out_of_scope"]);
const ITEM_STATUSES = new Set(["open", "resolved", "superseded"]);
const PROPOSAL_ACTIONS = new Set(["create", "keep_open", "resolve", "merge_into"]);
const ITEM_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_ITEMS = 20;
const MAX_REGISTRY_ITEMS = 100;
const MAX_ITEM_TEXT = 500;
export const CONTROL_REPAIRABLE_ERRORS = new Set([
  "missing_control",
  "invalid_control_json",
  "invalid_control_schema",
  "target_version_mismatch",
  "unaddressed_open_item",
]);

const ACTION_ACTORS = {
  provide_decision: new Set(["user"]),
  run_external_check: new Set(["user", "human_operator", "orchestrator"]),
  resume_agent_round: new Set(["agent"]),
};

const KIND_ACTIONS = {
  disagreement: new Set(["resume_agent_round"]),
  user_decision: new Set(["provide_decision"]),
  external_validation: new Set(["run_external_check"]),
  remaining_work: new Set(["resume_agent_round"]),
  out_of_scope: new Set(["provide_decision"]),
};

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validText(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_ITEM_TEXT;
}

function validRequiredStep(kind, step) {
  if (!isObject(step) || typeof step.actor !== "string" || typeof step.action !== "string") return false;
  return Boolean(ACTION_ACTORS[step.action]?.has(step.actor) && KIND_ACTIONS[kind]?.has(step.action));
}

function normalizeRequiredStep(step) {
  return { actor: step.actor, action: step.action };
}

function normalizeProposal(candidate) {
  if (!isObject(candidate) || !PROPOSAL_ACTIONS.has(candidate.action)) return null;
  if (candidate.action === "create") {
    if (candidate.itemId !== undefined || candidate.targetItemId !== undefined) return null;
    if (!ITEM_KINDS.has(candidate.kind) || !validText(candidate.text) || !validRequiredStep(candidate.kind, candidate.requiredStep)) return null;
    return {
      action: "create",
      kind: candidate.kind,
      text: candidate.text.trim(),
      requiredStep: normalizeRequiredStep(candidate.requiredStep),
    };
  }
  if (typeof candidate.itemId !== "string" || !ITEM_ID.test(candidate.itemId)) return null;
  if (candidate.action === "merge_into") {
    if (typeof candidate.targetItemId !== "string" || !ITEM_ID.test(candidate.targetItemId) || candidate.targetItemId === candidate.itemId) return null;
    return { action: candidate.action, itemId: candidate.itemId, targetItemId: candidate.targetItemId };
  }
  if (candidate.targetItemId !== undefined) return null;
  return { action: candidate.action, itemId: candidate.itemId };
}

function invalidControl(errorCode = "invalid_control_schema") {
  return {
    valid: false,
    errorCodes: [errorCode],
    controlVersion: null,
    convergence: "unknown",
    converged: false,
    goalStatus: "incomplete",
    substantiveDelta: false,
    itemProposals: [],
    openPoints: [],
    open: "",
    confidence: null,
    targetVersion: null,
  };
}

function validBase(candidate) {
  return isObject(candidate)
    && CONVERGENCE.has(candidate.convergence)
    && GOAL_STATUS.has(candidate.goalStatus)
    && typeof candidate.substantiveDelta === "boolean"
    && Number.isInteger(candidate.targetVersion)
    && candidate.targetVersion >= 1;
}

function validatedVersionTwo(candidate) {
  if (!validBase(candidate) || candidate.controlVersion !== CONTROL_VERSION) return null;
  if (candidate.openPoints !== undefined || candidate.confidence !== undefined) return null;
  if (!Array.isArray(candidate.itemProposals) || candidate.itemProposals.length > MAX_ITEMS) return null;
  const itemProposals = candidate.itemProposals.map(normalizeProposal);
  if (itemProposals.some((proposal) => !proposal)) return null;
  const referencedIds = itemProposals.filter((proposal) => proposal.action !== "create").map((proposal) => proposal.itemId);
  if (new Set(referencedIds).size !== referencedIds.length) return null;
  if (candidate.convergence === "converged" && itemProposals.some((proposal) => proposal.action === "create" && proposal.kind === "disagreement")) return null;
  if (candidate.goalStatus === "satisfied" && itemProposals.some((proposal) => proposal.action === "create" && proposal.kind === "remaining_work")) return null;
  return {
    valid: true,
    errorCodes: [],
    controlVersion: CONTROL_VERSION,
    convergence: candidate.convergence,
    converged: candidate.convergence === "converged",
    goalStatus: candidate.goalStatus,
    substantiveDelta: candidate.substantiveDelta,
    itemProposals,
    openPoints: [],
    open: "",
    confidence: null,
    targetVersion: candidate.targetVersion,
  };
}

function validatedLegacyControl(candidate) {
  if (!validBase(candidate) || candidate.controlVersion !== undefined) return null;
  if (!Array.isArray(candidate.openPoints) || candidate.openPoints.length > MAX_ITEMS) return null;
  if (!candidate.openPoints.every((point) => typeof point === "string" && point.length <= MAX_ITEM_TEXT)) return null;
  if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) return null;
  const openPoints = candidate.openPoints.map((point) => point.trim()).filter(Boolean);
  return {
    valid: true,
    errorCodes: [],
    controlVersion: 1,
    convergence: candidate.convergence,
    converged: candidate.convergence === "converged",
    goalStatus: candidate.goalStatus,
    substantiveDelta: candidate.substantiveDelta,
    itemProposals: [],
    openPoints,
    open: openPoints.join("; "),
    confidence: candidate.confidence,
    targetVersion: candidate.targetVersion,
  };
}

function validatedControl(candidate) {
  return validatedVersionTwo(candidate) || validatedLegacyControl(candidate);
}

export function parseAgentControl(text) {
  // Take the LAST control block and ignore any prose around it. The block is the machine
  // signal; reader-facing text before or after it (a sign-off line, a stray ``` fence) must
  // not invalidate an otherwise well-formed block — that brittleness was the main cause of
  // false `invalid_control` stops when agents had genuinely agreed. JSON shape and the
  // version-2 schema stay strict below, so a malformed or off-contract block still fails closed.
  const block = controlBlocks(String(text || "")).at(-1);
  if (!block) return invalidControl("missing_control");
  try { return validatedControl(JSON.parse(block.inner)) || invalidControl(); }
  catch { return invalidControl("invalid_control_json"); }
}

export function stripAgentControl(text) {
  // Remove every complete block the shared scanner found, leaving the prose around them.
  const source = String(text || "");
  const blocks = controlBlocks(source);
  let result = "";
  let cursor = 0;
  for (const block of blocks) {
    result += source.slice(cursor, block.start);
    cursor = block.end;
  }
  return (result + source.slice(cursor)).trimEnd();
}

function validRegistryItem(registryItem) {
  if (!isObject(registryItem) || typeof registryItem.itemId !== "string" || !ITEM_ID.test(registryItem.itemId)) return false;
  if (!ITEM_KINDS.has(registryItem.kind) || !ITEM_STATUSES.has(registryItem.status) || !validText(registryItem.text)) return false;
  if (!validRequiredStep(registryItem.kind, registryItem.requiredStep)) return false;
  if (registryItem.status === "superseded") return typeof registryItem.mergedIntoId === "string" && ITEM_ID.test(registryItem.mergedIntoId);
  return registryItem.mergedIntoId === undefined;
}

function validRegistryReferences(itemRegistry) {
  const registryById = new Map(itemRegistry.map((registryItem) => [registryItem.itemId, registryItem]));
  for (const registryItem of itemRegistry.filter((candidate) => candidate.status === "superseded")) {
    const visitedIds = new Set();
    let mergedItem = registryItem;
    while (mergedItem?.status === "superseded") {
      if (visitedIds.has(mergedItem.itemId) || !registryById.has(mergedItem.mergedIntoId)) return false;
      visitedIds.add(mergedItem.itemId);
      mergedItem = registryById.get(mergedItem.mergedIntoId);
    }
  }
  return true;
}

function normalizeRegistry(itemRegistry) {
  if (!Array.isArray(itemRegistry) || itemRegistry.length > MAX_REGISTRY_ITEMS || !itemRegistry.every(validRegistryItem)) return null;
  const ids = itemRegistry.map((registryItem) => registryItem.itemId);
  if (new Set(ids).size !== ids.length || !validRegistryReferences(itemRegistry)) return null;
  return itemRegistry.map((registryItem) => ({
    itemId: registryItem.itemId,
    kind: registryItem.kind,
    status: registryItem.status,
    text: registryItem.text.trim(),
    requiredStep: normalizeRequiredStep(registryItem.requiredStep),
    ...(registryItem.mergedIntoId ? { mergedIntoId: registryItem.mergedIntoId } : {}),
  }));
}

function nextItemId(registry) {
  const largest = registry.reduce((max, registryItem) => {
    const match = /^item-(\d+)$/.exec(registryItem.itemId);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `item-${String(largest + 1).padStart(3, "0")}`;
}

function proposalSignature(proposal) {
  const text = normalizedTopic(proposal.text);
  return JSON.stringify([proposal.kind, text, proposal.requiredStep.actor, proposal.requiredStep.action]);
}

function normalizedTopic(text) {
  return text.toLocaleLowerCase().replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function registryConflicts(registry) {
  const topics = new Map();
  for (const registryItem of registry.filter((entry) => entry.status === "open")) {
    const topic = normalizedTopic(registryItem.text) || registryItem.itemId;
    const topicItems = topics.get(topic) || [];
    topicItems.push(registryItem);
    topics.set(topic, topicItems);
  }
  const conflicts = [];
  for (const topicItems of topics.values()) {
    const topicKinds = new Set(topicItems.map((registryItem) => registryItem.kind));
    const requiredSteps = new Set(topicItems.map((registryItem) => `${registryItem.requiredStep.actor}:${registryItem.requiredStep.action}`));
    if (topicKinds.size > 1) conflicts.push({ code: "classification_conflict", itemIds: topicItems.map((registryItem) => registryItem.itemId) });
    else if (requiredSteps.size > 1) conflicts.push({ code: "required_step_conflict", itemIds: topicItems.map((registryItem) => registryItem.itemId) });
  }
  return conflicts;
}

function referencedItemErrors(controls, registryById) {
  const errors = [];
  for (const control of controls) {
    for (const proposal of control.itemProposals) {
      if (proposal.action === "create") continue;
      const registryItem = registryById.get(proposal.itemId);
      if (!registryItem) errors.push({ code: "unknown_item", itemId: proposal.itemId });
      else if (registryItem.status !== "open") errors.push({ code: "item_not_open", itemId: proposal.itemId });
    }
  }
  return errors;
}

function uniqueCreateProposals(controls, registry) {
  const knownSignatures = new Set(registry.filter((registryItem) => registryItem.status === "open").map(proposalSignature));
  const uniqueProposals = [];
  for (const proposal of controls.flatMap((control) => control.itemProposals).filter((candidate) => candidate.action === "create")) {
    const signature = proposalSignature(proposal);
    if (knownSignatures.has(signature)) continue;
    knownSignatures.add(signature);
    uniqueProposals.push(proposal);
  }
  return uniqueProposals;
}

function proposedRegistryUpdate(controls, registryItem) {
  const proposals = controls.map((control) => control.itemProposals.find((proposal) => proposal.itemId === registryItem.itemId)).filter(Boolean);
  if (!proposals.length || proposals.every((proposal) => proposal.action === "keep_open")) return null;
  if (proposals.length === controls.length && proposals.every((proposal) => proposal.action === "resolve")) return { action: "resolve" };
  const mergeTarget = proposals[0]?.targetItemId;
  if (proposals.length === controls.length && proposals.every((proposal) => proposal.action === "merge_into" && proposal.targetItemId === mergeTarget)) {
    return { action: "merge_into", targetItemId: mergeTarget };
  }
  return { action: "conflict" };
}

function plannedRegistryUpdates(controls, registry) {
  const updates = new Map();
  const conflicts = [];
  for (const registryItem of registry.filter((candidate) => candidate.status === "open")) {
    const proposedUpdate = proposedRegistryUpdate(controls, registryItem);
    if (!proposedUpdate) continue;
    if (proposedUpdate.action === "conflict") conflicts.push({ code: "conflicting_item_actions", itemId: registryItem.itemId });
    else updates.set(registryItem.itemId, proposedUpdate);
  }
  return { updates, conflicts };
}

function invalidMergeErrors(plannedUpdates, registryById) {
  const errors = [];
  for (const [itemId, plannedUpdate] of plannedUpdates) {
    if (plannedUpdate.action !== "merge_into") continue;
    const mergeTarget = registryById.get(plannedUpdate.targetItemId);
    if (!mergeTarget || mergeTarget.status !== "open" || plannedUpdates.has(plannedUpdate.targetItemId)) {
      errors.push({ code: "invalid_merge_target", itemId, targetItemId: plannedUpdate.targetItemId });
    }
  }
  return errors;
}

function applyExistingUpdates(currentRegistry, plannedUpdates) {
  const approvedRegistry = structuredClone(currentRegistry);
  const approvedById = new Map(approvedRegistry.map((registryItem) => [registryItem.itemId, registryItem]));
  for (const [itemId, plannedUpdate] of plannedUpdates) {
    const registryItem = approvedById.get(itemId);
    if (plannedUpdate.action === "resolve") registryItem.status = "resolved";
    else {
      registryItem.status = "superseded";
      registryItem.mergedIntoId = plannedUpdate.targetItemId;
    }
  }
  return approvedRegistry;
}

function appendCreatedItems(approvedRegistry, createProposals) {
  for (const proposal of createProposals) {
    approvedRegistry.push({
      itemId: nextItemId(approvedRegistry),
      kind: proposal.kind,
      status: "open",
      text: proposal.text,
      requiredStep: normalizeRequiredStep(proposal.requiredStep),
    });
  }
}

function applyProposals(controls, currentRegistry) {
  const registryById = new Map(currentRegistry.map((registryItem) => [registryItem.itemId, registryItem]));
  const referenceErrors = referencedItemErrors(controls, registryById);
  if (referenceErrors.length) return { registry: currentRegistry, conflicts: [], errors: referenceErrors };
  const createProposals = uniqueCreateProposals(controls, currentRegistry);
  if (currentRegistry.length + createProposals.length > MAX_REGISTRY_ITEMS) {
    return { registry: currentRegistry, conflicts: [], errors: [{ code: "registry_limit" }] };
  }
  const { updates, conflicts } = plannedRegistryUpdates(controls, currentRegistry);
  const mergeErrors = invalidMergeErrors(updates, registryById);
  if (mergeErrors.length) return { registry: currentRegistry, conflicts, errors: mergeErrors };
  const approvedRegistry = applyExistingUpdates(currentRegistry, updates);
  appendCreatedItems(approvedRegistry, createProposals);
  return { registry: approvedRegistry, conflicts: [...conflicts, ...registryConflicts(approvedRegistry)], errors: [] };
}

function derivedNextSteps(pendingItems) {
  const grouped = new Map();
  for (const pendingItem of pendingItems) {
    const key = `${pendingItem.requiredStep.actor}\u0000${pendingItem.requiredStep.action}`;
    const step = grouped.get(key) || { ...pendingItem.requiredStep, itemIds: [] };
    step.itemIds.push(pendingItem.itemId);
    grouped.set(key, step);
  }
  return [...grouped.values()];
}

function declaredCompletion(controls) {
  if (controls.some((control) => control.goalStatus === "incomplete")) return "incomplete";
  if (controls.some((control) => control.goalStatus === "blocked")) return "blocked";
  if (controls.some((control) => control.goalStatus === "needs_user")) return "needs_user";
  return "satisfied";
}

function requiredStepCompletion(pendingItems) {
  const actions = new Set(pendingItems.map((pendingItem) => pendingItem.requiredStep.action));
  if (actions.has("resume_agent_round")) return "incomplete";
  if (actions.has("run_external_check")) return "blocked";
  if (actions.has("provide_decision")) return "needs_user";
  return "satisfied";
}

function aggregateCompletion(controls, pendingItems) {
  const requiredCompletion = requiredStepCompletion(pendingItems);
  return requiredCompletion === "satisfied" ? declaredCompletion(controls) : requiredCompletion;
}

function terminalClaim(control) {
  return control.convergence === "converged" && control.goalStatus !== "incomplete";
}

function terminalItemErrors(controls, currentRegistry) {
  const errors = [];
  const openItems = currentRegistry.filter((registryItem) => registryItem.status === "open");
  controls.forEach((control, controlIndex) => {
    if (!terminalClaim(control) || control.controlVersion !== CONTROL_VERSION) return;
    const proposalsById = new Map(control.itemProposals
      .filter((proposal) => proposal.action !== "create")
      .map((proposal) => [proposal.itemId, proposal]));
    for (const registryItem of openItems) {
      const proposal = proposalsById.get(registryItem.itemId);
      if (!proposal) {
        errors.push({ code: "unaddressed_open_item", controlIndex, itemId: registryItem.itemId });
      } else if (control.goalStatus === "satisfied" && proposal.action === "keep_open") {
        errors.push({ code: "terminal_item_kept_open", controlIndex, itemId: registryItem.itemId });
      }
    }
  });
  return errors;
}

function roundConsistencyErrors({ controls, currentRegistry, pendingItems, applicationErrors, enabled }) {
  const errors = [...applicationErrors];
  errors.push(...terminalItemErrors(controls, currentRegistry));
  if (!enabled) return errors;
  if (controls.some((control) => control.goalStatus === "needs_user") && !pendingItems.some((pendingItem) => pendingItem.kind === "user_decision")) {
    errors.push({ code: "missing_user_decision" });
  }
  if (controls.some((control) => control.goalStatus === "blocked") && !pendingItems.some((pendingItem) => pendingItem.kind === "external_validation")) {
    errors.push({ code: "missing_external_validation" });
  }
  const declared = declaredCompletion(controls);
  const required = requiredStepCompletion(pendingItems);
  if (required !== "satisfied" && declared !== "incomplete" && declared !== required) {
    errors.push({ code: "completion_registry_mismatch", declaredCompletion: declared, requiredCompletion: required });
  }
  return errors;
}

function repairTargets(controls, targetVersion, consistencyErrors) {
  return controls.flatMap((control, controlIndex) => {
    const errorCodes = new Set(control?.errorCodes || []);
    if (control?.valid && control.targetVersion !== targetVersion) errorCodes.add("target_version_mismatch");
    const itemIds = [];
    for (const error of consistencyErrors) {
      if (error.controlIndex !== controlIndex || error.code !== "unaddressed_open_item") continue;
      errorCodes.add(error.code);
      itemIds.push(error.itemId);
    }
    const repairableCodes = [...errorCodes].filter((code) => CONTROL_REPAIRABLE_ERRORS.has(code));
    return repairableCodes.length ? [{ controlIndex, errorCodes: repairableCodes, itemIds: [...new Set(itemIds)] }] : [];
  });
}

function validateRound(controls, targetVersion, itemRegistry) {
  const present = controls.filter(Boolean);
  const allPresent = present.length === controls.length && present.length >= 2;
  const controlsValid = allPresent && present.every((control) => control.valid);
  const currentRegistry = normalizeRegistry(itemRegistry);
  const registryValid = currentRegistry !== null;
  const versionAligned = controlsValid && present.every((control) => control.targetVersion === targetVersion);
  const application = versionAligned && registryValid
    ? applyProposals(present, currentRegistry)
    : { registry: currentRegistry || [], conflicts: [], errors: [] };
  const candidatePendingItems = application.registry.filter((registryItem) => registryItem.status === "open");
  const consistencyErrors = roundConsistencyErrors({
    controls: present,
    currentRegistry: currentRegistry || [],
    pendingItems: candidatePendingItems,
    applicationErrors: application.errors,
    enabled: controlsValid && registryValid,
  });
  const roundValid = controlsValid && registryValid && versionAligned && consistencyErrors.length === 0;
  return {
    present,
    allPresent,
    versionAligned,
    currentRegistry: currentRegistry || [],
    application,
    consistencyErrors,
    repairTargets: repairTargets(controls, targetVersion, consistencyErrors),
    roundValid,
    controlsValid,
  };
}

function agreementStateFor({ roundValid, controls, pendingItems, conflicts, unclassifiedPoints }) {
  if (!roundValid || unclassifiedPoints.length) return "unknown";
  const hasDisagreement = conflicts.length || pendingItems.some((pendingItem) => pendingItem.kind === "disagreement");
  if (hasDisagreement || controls.some((control) => control.convergence === "open")) return "open";
  return controls.every((control) => control.convergence === "converged") ? "converged" : "unknown";
}

function discussionState(validation) {
  const { present, roundValid, currentRegistry, application } = validation;
  const approvedRegistry = roundValid ? application.registry : (currentRegistry || []);
  const pendingItems = approvedRegistry.filter((registryItem) => registryItem.status === "open");
  const unclassifiedPoints = [...new Set(present.flatMap((control) => control.openPoints || []).filter(Boolean))];
  const disagreements = pendingItems.filter((pendingItem) => pendingItem.kind === "disagreement").map((pendingItem) => pendingItem.text);
  // Disagreements the agents RAISED in their controls this round, read straight from the
  // proposals — available even when the round can't be certified. This is report-only context
  // (never official state): it lets an invalid-but-parseable round still show what was on the
  // table instead of an opaque "invalid control" message.
  const proposedDisagreements = [...new Set(present
    .flatMap((control) => control.itemProposals || [])
    .filter((proposal) => proposal.action === "create" && proposal.kind === "disagreement")
    .map((proposal) => proposal.text)
    .filter(Boolean))];
  const agreementState = agreementStateFor({ roundValid, controls: present, pendingItems, conflicts: application.conflicts, unclassifiedPoints });
  const completionState = roundValid ? aggregateCompletion(present, pendingItems) : "incomplete";
  const proposalChanged = roundValid && present.some((control) => control.substantiveDelta);
  // Early stop is driven by AGREEMENT, not by the task being fully done: once both agents
  // converge and a full round passes with no substantive change, further rounds only repeat.
  // We never stop while an open item still requires another agent round (an unresolved
  // disagreement, or an explicit remaining_work item) — that is the machine-checked safeguard
  // against cutting off pending agent work. A bare goalStatus=incomplete with no such item means
  // the agents flagged nothing more to do: it is reported as "settled, not fully done", not
  // treated as a reason to keep looping (the prompt asks them to file remaining_work when
  // another round would genuinely help). Completion state stays in the reported outcome, no
  // longer a gate, so an agreed answer that still needs the user or an outside check stops here.
  const agentWorkPending = pendingItems.some((pendingItem) => pendingItem.requiredStep.action === "resume_agent_round");
  const canStop = roundValid && !proposalChanged && agreementState === "converged" && !agentWorkPending;
  // Agreement is reached, but a participant made a late substantive change THIS round. Agents run in
  // parallel on one shared snapshot, so the others haven't seen it yet — the round correctly can't stop.
  // This flags "the next round is a confirmation round": the orchestrator gives it a tightened prompt so
  // participants only re-open on a genuine decision change, instead of drifting into marginal re-tweaks
  // that keep proposalChanged=true and never converge. Mutually exclusive with canStop by construction.
  const awaitingConfirmation = roundValid && agreementState === "converged" && proposalChanged && !agentWorkPending;
  // Reason still follows the aggregate completion state — needs_user and blocked already imply
  // their matching official item through the round consistency rules, so this stays faithful to
  // what the agents reported. The new case this enables, an agreed-but-incomplete stop, reports
  // as a plain completed agreement (the report layer distinguishes "settled" from "satisfied").
  const stopReason = !roundValid
    ? "invalid_control"
    : !canStop
      ? null
      : { satisfied: "complete", needs_user: "user_decision", blocked: "external_block", incomplete: "complete" }[completionState];
  return { canStop, awaitingConfirmation, agreementState, completionState, stopReason, approvedRegistry, pendingItems, unclassifiedPoints, disagreements, proposedDisagreements, proposalChanged };
}

function assessmentPayload(validation, state) {
  return {
    canStop: state.canStop,
    awaitingConfirmation: state.awaitingConfirmation,
    agreementState: state.agreementState,
    completionState: state.completionState,
    stopReason: state.stopReason,
    itemRegistry: state.approvedRegistry,
    pendingItems: state.pendingItems,
    pendingKinds: [...new Set(state.pendingItems.map((pendingItem) => pendingItem.kind))],
    nextSteps: derivedNextSteps(state.pendingItems),
    disagreements: state.disagreements,
    proposedDisagreements: state.proposedDisagreements,
    unclassifiedPoints: state.unclassifiedPoints,
    conflicts: validation.application.conflicts,
    consistencyErrors: validation.consistencyErrors,
    repairTargets: validation.repairTargets,
    proposalChanged: state.proposalChanged,
    versionAligned: validation.versionAligned,
    allPresent: validation.allPresent,
    allValid: validation.roundValid,
    controlsParseable: validation.controlsValid,
  };
}

export function assessRound(controls, targetVersion, itemRegistry = []) {
  const validation = validateRound(controls, targetVersion, itemRegistry);
  return assessmentPayload(validation, discussionState(validation));
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function unmatchedProposals(originalProposals, repairedProposals) {
  const remaining = [...repairedProposals];
  for (const proposal of originalProposals) {
    const index = remaining.findIndex((candidate) => equalJson(candidate, proposal));
    if (index === -1) return null;
    remaining.splice(index, 1);
  }
  return remaining;
}

function repairedContractError(repairedControl, targetVersion) {
  if (repairedControl?.valid
      && repairedControl.controlVersion === CONTROL_VERSION
      && repairedControl.targetVersion === targetVersion) return null;
  return repairedControl?.errorCodes?.[0] || "invalid_control_schema";
}

function preservesNarrowRepairFields(originalControl, repairedControl, errorCodes) {
  for (const field of ["controlVersion", "convergence", "goalStatus", "substantiveDelta"]) {
    if (repairedControl[field] !== originalControl[field]) return false;
  }
  return errorCodes.has("target_version_mismatch") || repairedControl.targetVersion === originalControl.targetVersion;
}

function validNarrowProposalAdditions(originalControl, repairedControl, allowedItemIds) {
  const addedProposals = unmatchedProposals(originalControl.itemProposals, repairedControl.itemProposals);
  if (!addedProposals) return false;
  const additionsAreNarrow = addedProposals.every((proposal) => (
    proposal.action !== "create" && allowedItemIds.has(proposal.itemId)
  ));
  const addressedItems = new Set(addedProposals.map((proposal) => proposal.itemId));
  return additionsAreNarrow && [...allowedItemIds].every((itemId) => addressedItems.has(itemId));
}

export function validateControlRepair(originalControl, repairedControl, repairTarget, targetVersion) {
  const contractError = repairedContractError(repairedControl, targetVersion);
  if (contractError) return { valid: false, errorCode: contractError };
  const errorCodes = new Set(repairTarget.errorCodes);
  if (!originalControl?.valid || [...errorCodes].some((code) => ["missing_control", "invalid_control_json", "invalid_control_schema"].includes(code))) {
    return { valid: true, errorCode: null };
  }
  const allowedCodes = new Set(["target_version_mismatch", "unaddressed_open_item"]);
  if ([...errorCodes].some((code) => !allowedCodes.has(code))) return { valid: false, errorCode: "repair_scope_violation" };
  if (!preservesNarrowRepairFields(originalControl, repairedControl, errorCodes)) {
    return { valid: false, errorCode: "repair_scope_violation" };
  }
  const allowedItemIds = new Set(repairTarget.itemIds);
  if (!validNarrowProposalAdditions(originalControl, repairedControl, allowedItemIds)) {
    return { valid: false, errorCode: "repair_scope_violation" };
  }
  return { valid: true, errorCode: null };
}
