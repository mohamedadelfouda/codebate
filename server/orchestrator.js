import { getSession, listSessions, mutateSession, scratchWorkspacePath, SKIP_SESSION_WRITE } from "./store.js";
import { terminateProcess } from "./process.js";
import { provider, providerIds } from "./providers/registry.js";
import { collaborationPrompt, debatePrompt, synthesisPrompt, chatPrompt, controlRepairPrompt } from "./prompts.js";
import { assessRound, parseAgentControl, stripAgentControl, validateControlRepair } from "./convergence.js";
import { assertTrustedProject, projectSnapshot } from "./project.js";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { CappedText } from "./output-limits.js";
import { logError, logWarn, redact } from "./logger.js";
import { registerProjectScope } from "./project-tools.js";
import { claimSessionActivity } from "./session-activity.js";
import { expectedApiError } from "./api-errors.js";
import { sumUsage } from "./usage.js";
import {
  assertRunAcceptsOutput as assertAttemptAcceptsOutput,
  claimRunTerminal,
  createRunAttempt,
  requestRunCancellation,
  requestRunFailure,
  runAcceptsOutput as attemptAcceptsOutput,
  runAttemptRecord,
  runInactiveError,
  runWasCancelled,
} from "./run-state.js";

const activeRuns = new Map();
const DISCUSSION_MODES = new Set(["chat", "collaboration", "debate"]);
const MAX_ROLE_CODEPOINTS = 180;
// How many consecutive confirmation rounds to allow before accepting a converged agreement despite a provider
// still self-reporting a marginal substantiveDelta. Bounded so over-signalling can't burn every round, but ≥2
// so a GENUINE late change gets at least one round to reach the parallel peers before the loop stops.
const MAX_CONFIRMATION_ROUNDS = 2;
// A round can fail to seal only because one participant's control is unreadable/unrepairable (not a real
// disagreement) while every readable control converged. Rather than burn to the round limit, stop honestly
// once that condition has persisted this many CONSECUTIVE rounds — a degraded (not formal) seal.
const DEGRADED_STOP_ROUNDS = 2;
const CONTROL_REPAIR_TIMEOUT_MS = 60000;
const MAX_CONTROL_REPAIR_OUTPUT_BYTES = 64 * 1024;
const MAX_CONTROL_SNAPSHOT_BYTES = 5000;
const CONTROL_SNAPSHOT_PREVIEW_CHARS = 1500;

function controlRepairConfig(agentConfig) {
  const config = {};
  for (const key of ["model", "effort", "command"]) {
    if (agentConfig[key] !== undefined) config[key] = agentConfig[key];
  }
  return {
    ...config,
    permission: "read",
    mcpSessionId: "",
    connectorSessionId: "",
    timeoutMs: CONTROL_REPAIR_TIMEOUT_MS,
    maxOutputBytes: MAX_CONTROL_REPAIR_OUTPUT_BYTES,
  };
}

function controlSnapshot(control) {
  const serialized = JSON.stringify(control);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= MAX_CONTROL_SNAPSHOT_BYTES) return { truncated: false, value: structuredClone(control) };
  return {
    truncated: true,
    bytes,
    sha256: createHash("sha256").update(serialized).digest("hex"),
    preview: redact(serialized.slice(0, CONTROL_SNAPSHOT_PREVIEW_CHARS)),
  };
}

function newControlRepairStats() {
  return {
    attemptedCalls: 0,
    succeededCalls: 0,
    failedCalls: 0,
    totalDurationMs: 0,
    errorCodeCounts: {},
    usages: [],
  };
}

function recordControlRepair(stats, audit) {
  stats.attemptedCalls += 1;
  stats[audit.status === "succeeded" ? "succeededCalls" : "failedCalls"] += 1;
  stats.totalDurationMs += audit.durationMs;
  for (const code of audit.errorCodes) {
    stats.errorCodeCounts[code] = (stats.errorCodeCounts[code] || 0) + 1;
  }
  if (audit.usage) stats.usages.push(audit.usage);
}

function completedControlRepairStats(stats) {
  if (!stats.attemptedCalls) return null;
  const { usages, ...summary } = stats;
  return usages.length ? { ...summary, usage: sumUsage(usages) } : summary;
}

function controlRepairAudit({
  target,
  originalControl,
  repairedControl,
  providerResult,
  config,
  status,
  failureCode,
  durationMs,
}) {
  return {
    attempted: true,
    count: 1,
    status,
    errorCodes: [...target.errorCodes],
    ...(failureCode ? { failureCode } : {}),
    durationMs,
    outputTruncated: Boolean(providerResult?.outputTruncated),
    requestedModel: config.model || "(default)",
    requestedEffort: config.effort || "",
    usage: providerResult?.usage ?? null,
    originalControl: controlSnapshot(originalControl),
    ...(repairedControl ? { repairedControl: controlSnapshot(repairedControl) } : {}),
  };
}

function skippedControlRepairAudit({ target, originalControl, config }) {
  return {
    attempted: false,
    count: 0,
    status: "skipped",
    errorCodes: [...target.errorCodes],
    failureCode: "repair_not_supported",
    durationMs: 0,
    outputTruncated: false,
    requestedModel: config.model || "(default)",
    requestedEffort: config.effort || "",
    usage: null,
    originalControl: controlSnapshot(originalControl),
  };
}

async function invokeControlRepairProvider({ definition, prompt, config, cwd, registerChild, state }) {
  const repairPromise = Promise.resolve().then(() => definition.run({
    prompt,
    config,
    cwd,
    registerChild,
    onEvent() {},
  }));
  state.pending.add(repairPromise);
  try {
    return await repairPromise;
  } finally {
    state.pending.delete(repairPromise);
  }
}

function parsedControlRepair(providerResult, originalControl, target, targetVersion) {
  const repairedControl = parseAgentControl(redact(providerResult.text));
  const validation = providerResult.outputTruncated
    ? { valid: false, errorCode: "output_truncated" }
    : validateControlRepair(originalControl, repairedControl, target, targetVersion);
  return { repairedControl, validation };
}

async function controlRepairWorkspace(sessionId, state) {
  try {
    const cwd = await scratchWorkspacePath();
    assertRunAcceptsOutput(sessionId, state);
    return { cwd, error: null };
  } catch (error) {
    if (!runAcceptsOutput(sessionId, state) || error.runInactive) throw runInactiveError(state);
    return { cwd: null, error };
  }
}

function invalidRequest(code, message) {
  throw expectedApiError(code, message, 400);
}

function orchestrationMode(rawMode) {
  const mode = String(rawMode || "collaboration").trim().toLowerCase();
  if (!DISCUSSION_MODES.has(mode)) invalidRequest("invalid_mode", "Unsupported discussion mode");
  return mode;
}

function orchestrationRounds(rawRounds) {
  const rounds = rawRounds === undefined || rawRounds === "" ? 2 : Number(rawRounds);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) {
    invalidRequest("invalid_rounds", "Rounds must be an integer from 1 to 5");
  }
  return rounds;
}

function orchestrationTask(content) {
  const userTask = String(content || "").trim();
  if (!userTask) invalidRequest("message_required", "Write a message first");
  return userTask;
}

function orchestrationAgents(agents) {
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    invalidRequest("invalid_participants", "Agent configuration must be an object");
  }
  for (const [providerId, config] of Object.entries(agents)) {
    if (config?.enabled === false) continue;
    if (!provider(providerId)) invalidRequest("invalid_provider", `Unknown provider: ${providerId}`);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      invalidRequest("invalid_participants", `Invalid configuration for provider: ${providerId}`);
    }
  }
  return agents;
}

function orchestrationParticipants(agents, mode) {
  const selected = providerIds().filter((providerId) => Boolean(agents[providerId]) && agents[providerId].enabled !== false);
  if (selected.length < 2) invalidRequest("invalid_participants", "Enable at least two providers for this mode");
  if (mode === "debate" && selected.length !== 2) {
    invalidRequest("invalid_debate_participants", "Debate mode requires exactly two providers");
  }
  for (const providerId of selected) {
    const role = String(agents[providerId].role || "");
    if ([...role].length > MAX_ROLE_CODEPOINTS) {
      invalidRequest("invalid_agent_role", `Role is too long for provider: ${providerId}`);
    }
  }
  return selected;
}

function orchestrationFinalizer(rawFinalizer, selected) {
  const finalizer = String(rawFinalizer || "none").trim().toLowerCase();
  if (finalizer !== "none" && !selected.includes(finalizer)) {
    invalidRequest("invalid_finalizer", "Finalizer must be none or one of the selected providers");
  }
  return finalizer;
}

export function validateOrchestrationRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    invalidRequest("invalid_orchestration_request", "Request body must be an object");
  }
  const mode = orchestrationMode(request.mode);
  const rounds = orchestrationRounds(request.rounds);
  const userTask = orchestrationTask(request.content);
  const agents = orchestrationAgents(request.agents);
  const selected = orchestrationParticipants(agents, mode);
  const finalizer = orchestrationFinalizer(request.finalizer, selected);
  return { mode, rounds, userTask, selected, finalizer };
}

function runAcceptsOutput(sessionId, state) {
  return attemptAcceptsOutput(activeRuns.get(sessionId), state);
}

function assertRunAcceptsOutput(sessionId, state) {
  assertAttemptAcceptsOutput(activeRuns.get(sessionId), state);
}

function makeMessage({ author, agent, role, content, round, phase, mode }) {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    author,
    agent,
    role,
    content,
    round,
    phase,
    mode,
  };
}

// A bounded, safe preview of a still-forming answer for the live UI. It previews the HEAD, not the tail: the
// <agent-control> block is emitted at the very end, so a bounded prefix is answer text, and sanitizing a
// bounded prefix (not the whole 4MiB buffer) keeps each 100ms emit cheap. Because we sanitize BEFORE capping
// and there is no earlier context, no secret or control-block fragment can straddle the cut — we drop any
// complete block or unmatched opening tag, redact, THEN cap.
const STREAM_PREVIEW_CHARS = 600;
function streamingPreview(full) {
  const head = String(full).slice(0, STREAM_PREVIEW_CHARS * 3);
  const noComplete = stripAgentControl(head);
  const openAt = noComplete.toLowerCase().indexOf("<agent-control>");
  const clean = openAt === -1 ? noComplete : noComplete.slice(0, openAt);
  return redact(clean).trimEnd().slice(0, STREAM_PREVIEW_CHARS);
}

// The most recent substantive agent answer already in the session. When the user flips an
// existing discussion into debate with a message like "let's debate this", THAT answer is the
// real subject — not the switch message. Returned verbatim (control blocks were already
// stripped at store time) and bounded so it survives even if the transcript is later trimmed.
function lastSubstantiveAnswer(session, limit = 4000) {
  const messages = session.messages || [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.author !== "agent") continue;
    if (message.meta?.status === "partial") continue; // a partial/aborted turn is not a final answer to debate
    const content = String(message.content || "").trim();
    if (content) return content.length > limit ? `${content.slice(0, limit)}\n…[truncated]` : content;
  }
  return "";
}

function discussionOutcomePhase(assessment) {
  // A degraded stop IS an agreement among the readable participants (one control was unreadable, so the
  // formal seal failed). Present it as converged; the sealDegraded flag + the report layer add the honest
  // caveat and name the excluded participant.
  if (assessment.degradedStop) return "converged";
  if (!assessment.canStop) return "needs_more_rounds";
  // Keyed off the stop reason, not raw completion: an agreed answer that still needs the user
  // or an outside check stops on agreement (the deterministic core cleared it — no agent work
  // is pending), so it maps to a terminal phase. When canStop is true, stopReason is always one
  // of these three; the fallback is a conservative guard for an impossible unmapped value.
  return {
    complete: "converged",
    user_decision: "needs_user",
    external_block: "blocked_external",
  }[assessment.stopReason] || "needs_more_rounds";
}

export function buildDiscussionOutcome(assessment, requestedRounds, completedRounds, controlRepairStats = null, roundDiagnostics = []) {
  const phase = discussionOutcomePhase(assessment);
  return {
    outcomeVersion: 1,
    phase,
    agreementState: assessment.agreementState,
    completionState: assessment.completionState,
    stopReason: assessment.canStop
      ? assessment.stopReason
      : assessment.degradedStop ? "degraded_convergence"
        : assessment.stopReason === "invalid_control" ? "invalid_control" : "round_limit",
    sealDegraded: assessment.degradedStop === true,
    requestedRounds,
    completedRounds,
    stoppedEarly: (assessment.canStop || assessment.degradedStop) && completedRounds < requestedRounds,
    itemRegistry: structuredClone(assessment.itemRegistry),
    pendingItems: structuredClone(assessment.pendingItems),
    pendingKinds: [...assessment.pendingKinds],
    nextSteps: structuredClone(assessment.nextSteps),
    disagreements: [...assessment.disagreements],
    proposedDisagreements: [...(assessment.proposedDisagreements || [])],
    unclassifiedPoints: [...assessment.unclassifiedPoints],
    conflicts: structuredClone(assessment.conflicts),
    controlValid: assessment.allValid,
    controlsParseable: assessment.controlsParseable,
    sealedOnQuorum: assessment.sealedOnQuorum === true,
    roundDiagnostics: structuredClone(roundDiagnostics),
    ...(controlRepairStats ? { controlRepairStats: structuredClone(controlRepairStats) } : {}),
  };
}

function pendingItemList(outcome) {
  return outcome.pendingItems.length
    ? `\n${outcome.pendingItems.map((pendingItem) => `• ${pendingItem.text}`).join("\n")}`
    : "";
}

function terminalOutcomeReport(outcome) {
  const round = outcome.completedRounds;
  if (outcome.phase === "converged") {
    // `converged` now covers "agreed and settled" even when the task itself isn't fully
    // `satisfied` (the agents ran out of substantive work and no agent step is pending), so
    // don't claim the task is complete unless it actually is.
    const settledOnly = outcome.completionState !== "satisfied";
    // A degraded stop is NOT a formal seal: the readable participants agreed but one control was unreadable,
    // so say that plainly rather than "the agents agreed and settled".
    const head = outcome.sealDegraded
      ? "الوكلاء المقروئون اتفقوا، لكن الاتفاق مش مختوم رسميًا"
      : settledOnly ? "الوكلاء اتفقوا واستقرّوا على إجابة واحدة" : "الوكلاء اتفقوا والمهمة اكتملت";
    const tail = outcome.stoppedEarly ? `في الجولة ${round} — تم إيقاف الجولات المتبقية.` : `في الجولة الأخيرة (${round}).`;
    // Not "raise the rounds" — the same convergence guard would just stop again with nothing new;
    // a follow-up question or a narrowed scope is what actually moves a settled discussion forward.
    const deeper = settledOnly ? " لو عايز تعميق أكتر، ابعت سؤال متابعة أو حدّد الجزء اللي عايز توسّعه." : "";
    // An agreed stop can still leave open items needing a NON-agent action (a user decision, an
    // external check). completionState=incomplete would otherwise map this to a plain settled
    // outcome and hide the required step — so surface those items instead of dropping them.
    const pending = outcome.pendingItems.length ? `\nلسه فيه نقاط محتاجة إجراء منك أو تحقّق خارجي:${pendingItemList(outcome)}` : "";
    // Honest control note. Two mutually exclusive cases name the excluded provider via controlBlameLine:
    // - sealedOnQuorum: a valid MAJORITY sealed because one control couldn't be certified (3+ agents).
    // - sealDegraded: no majority could seal (e.g. only one readable voice after a dropout), so we stopped
    //   honestly once the readable side had converged rather than looping to the round limit.
    const blame = (outcome.sealedOnQuorum || outcome.sealDegraded) ? controlBlameLine(outcome) : "";
    const note = outcome.sealDegraded
      ? blame
        ? ` (${blame} — فتعذّر الختم الرسمي وموقفه الفعلي غير معروف؛ وقفنا بدل ما نكمّل جولات من غير جديد.)`
        : ` (بيانات تحكم أحد المشاركين غير مقروءة فتعذّر الختم الرسمي؛ وقفنا بدل ما نكمّل جولات من غير جديد.)`
      : blame
        ? ` (الاتفاق اتختم على الأغلبية؛ ${blame} — استُبعد من الختم، وموقفه الفعلي غير معروف.)`
        : "";
    return `${head} ${tail}${note}${deeper}${pending}`;
  }
  if (outcome.phase === "needs_user") {
    return `الوكلاء متفقون، والنقاش توقف في الجولة ${round} لأن النتيجة تحتاج قرارك.${pendingItemList(outcome)}`;
  }
  if (outcome.phase === "blocked_external") {
    return `الوكلاء متفقون، والنقاش توقف في الجولة ${round} لأن النتيجة تنتظر تحققًا أو خطوة خارجية.${pendingItemList(outcome)}`;
  }
  return null;
}

function openDisagreementPoints(outcome) {
  // Prefer explicit disagreement items; fall back to any open point that still needs another
  // agent round, so the user always sees WHAT is unresolved, not just that something is.
  const points = outcome.disagreements.length
    ? outcome.disagreements
    : outcome.pendingItems.filter((item) => item.requiredStep.action === "resume_agent_round").map((item) => item.text);
  return points.length ? `\nنقط الاختلاف اللي لسه مفتوحة:\n${points.map((point) => `• ${point}`).join("\n")}` : "";
}

// Name the agent(s) whose control block couldn't be certified in the last round that had a failure, so an
// invalid_control stop reads as the technical blocker it is — not a fake "the agents didn't agree". Returns ""
// when there's no per-agent failure recorded (older sessions, or a non-agent cause).
function controlBlameLine(outcome) {
  const diagnostics = outcome.roundDiagnostics || [];
  // Blame the FINAL round's failures only — an agent that slipped in an early round but self-corrected later
  // is not the blocker of THIS stop. If the final round certified all controls (the stop was a consistency
  // conflict, not a malformed block), there's nothing to blame → "" → the caller's accurate fallback.
  const finalRound = diagnostics[diagnostics.length - 1];
  const failures = finalRound?.controlFailures || [];
  if (!failures.length) return "";
  const byAgent = new Map();
  for (const failure of failures) byAgent.set(failure.agent, failure); // one entry per agent
  const parts = [...byAgent.values()].map((failure) => {
    const label = provider(failure.agent)?.label || failure.agent;
    const reason = failure.repairStatus === "skipped"
      ? "مايدعمش تصحيح بيانات التحكم"
      : failure.repairStatus === "failed"
        ? "حاول يصحّح بيانات التحكم وما نفعش"
        : "بياناته التحكمية طلعت غير صالحة";
    const codes = failure.errorCodes?.length ? ` (${failure.errorCodes.join("، ")})` : "";
    return `${label} ${reason}${codes}`;
  });
  return parts.join("، ");
}

function unfinishedOutcomeReport(outcome) {
  const round = outcome.completedRounds;
  if (outcome.stopReason === "invalid_control") {
    // Proposed disagreements are extracted from every PRESENT valid control, so they can exist even when
    // ANOTHER agent's control was malformed — surface them regardless, and never claim "no content
    // disagreement" while real points are on the table.
    const disagreementTail = outcome.proposedDisagreements.length
      ? `\nنقط الاختلاف اللي طرحوها:\n${outcome.proposedDisagreements.map((point) => `• ${point}`).join("\n")}`
      : "";
    // Case A — the controls PARSED but the round wasn't certified (a consistency/version conflict) and the
    // agents raised real points. Another round can genuinely resolve this, so it's fair to suggest more rounds.
    if (outcome.controlsParseable && outcome.proposedDisagreements.length) {
      return `انتهت ${round} جولات. الوكلاء طرحوا نقط اختلاف لكن الجولة ماتعتمدتش بسبب تعارض في بيانات التحكم — ارفع عدد الجولات أو وضّح المطلوب.${disagreementTail}`;
    }
    // Case B — a control BLOCK was actually malformed. Name the blocker; raising rounds can't fix a bad block.
    // Only assert "not a content disagreement" when there genuinely are none.
    const blame = controlBlameLine(outcome);
    if (blame) {
      const noDisagreement = disagreementTail ? "" : " ده مش خلاف في المحتوى بين الوكلاء،";
      // Report only that the OTHER valid controls DECLARED convergence — not that the agents "actually agreed"
      // (the malformed provider's position is unknown, and the valid agents answered from the pre-round
      // snapshot). Suppressed when real disagreement points are on the table.
      const diagnostics = outcome.roundDiagnostics || [];
      const restConverged = !disagreementTail && diagnostics[diagnostics.length - 1]?.validControlsConverged
        ? " باقي الوكلاء أعلنوا التوافق في بيانات التحكم، فالعطل التقني ده وحده هو اللي منع الختم الرسمي."
        : "";
      return `النقاش اتقفل لسبب تقني بعد ${round} جولات: ${blame} — فالنظام ماقدرش يختم الاتفاق رسميًا.${restConverged}${noDisagreement} وزيادة عدد الجولات مش هتحلّ العطل التقني ده.${disagreementTail}`;
    }
    // No per-agent blame recorded. Keep the reason accurate: valid JSON that hit a consistency conflict is a
    // different thing from control data that wasn't valid at all.
    const parseNote = outcome.controlsParseable
      ? "الجولة ماتعتمدتش رسميًا بسبب تعارض في بيانات التحكم"
      : "بيانات التحكم من الوكلاء ماكانتش صالحة فالاتفاق ماتختمش رسميًا";
    const noDisagreement = disagreementTail ? "" : " مش خلاف في المحتوى.";
    return `انتهت ${round} جولات، لكن ${parseNote} — سبب تقني.${noDisagreement}${disagreementTail}`;
  }
  if (outcome.agreementState === "converged" && outcome.completionState === "incomplete") {
    return `انتهت ${round} جولات. الوكلاء متفقون على الإجابة الحالية، بس لسه فيه شغل وكلاء إضافي ممكن يحسّنها — ارفع عدد الجولات لو عايز يكمّلوا.${pendingItemList(outcome)}`;
  }
  return `الاتفاق ماتمّش بعد ${round} جولات، ومحتاجين جولات إضافية.${openDisagreementPoints(outcome)}`;
}

export function discussionOutcomeReport(outcome) {
  return terminalOutcomeReport(outcome) || unfinishedOutcomeReport(outcome);
}

export function mergeOrchestrationContent(latest, session) {
  // Connector MCP calls and user approvals can update the same session while an
  // agent is running. Merge messages by id instead of replacing those concurrent
  // connector/decision updates with this orchestration's older snapshot.
  const messages = new Map();
  for (const message of [...(latest.messages || []), ...(session.messages || [])]) messages.set(message.id, message);
  latest.messages = [...messages.values()].sort((a, b) => {
    const time = String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
    return time || String(a.id || "").localeCompare(String(b.id || ""));
  });
  latest.mode = session.mode;
  latest.settings = structuredClone(session.settings || {});
  return latest;
}

async function persistRunProgress(session, state, emit) {
  const persisted = await mutateSession(session.id, (latest) => {
    if (!runAcceptsOutput(session.id, state)) return SKIP_SESSION_WRITE;
    mergeOrchestrationContent(latest, session);
    latest.status = session.status;
    latest.activeRun = runAttemptRecord(state);
    return true;
  });
  if (persisted) emit({ type: "session_updated", sessionId: session.id, runId: state.runId });
  return persisted;
}

async function persistRunTerminal(session, state, emit) {
  const persisted = await mutateSession(session.id, (latest) => {
    if (activeRuns.get(session.id) !== state || state.status !== session.status) return SKIP_SESSION_WRITE;
    mergeOrchestrationContent(latest, session);
    latest.status = session.status;
    latest.activeRun = runAttemptRecord(state);
    return true;
  });
  if (persisted) emit({ type: "session_updated", sessionId: session.id, runId: state.runId });
  return persisted;
}

async function terminateRunChildren(state, options) {
  return Promise.all([...state.children].map((child) => terminateProcess(child, options)));
}

async function settlePendingProviders(state, timeoutMs = 5000) {
  if (state.pending.size === 0) return true;
  let timeoutHandle;
  const settled = Promise.allSettled([...state.pending]).then(() => true);
  const timedOut = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve(false), timeoutMs);
    timeoutHandle.unref?.();
  });
  const completed = await Promise.race([settled, timedOut]);
  clearTimeout(timeoutHandle);
  return completed;
}

// Run one round of agents in parallel with single-provider fault tolerance. One agent's failure no longer
// aborts the round: the siblings finish, then each failed agent is retried once automatically (its failed
// partial is pruned first, so a successful retry leaves exactly one turn for that agent/round). A user
// cancellation still aborts immediately. A provider failure that survives its retry does NOT kill the run —
// the round returns the working turns plus which agents failed, so the caller (reconcileRound) can drop them
// and continue the session with the rest, or fail if too few remain. Each unit is
// { agent, run: () => Promise<message>, prune?: () => void }; returns { results: message[], failed: {agent, reason}[] }.
async function runResilientRound(units, state, autoRetries = 1) {
  const providerFailure = (outcome) => outcome.status === "rejected" && !outcome.reason?.runInactive;
  const outcomes = await Promise.allSettled(units.map((unit) => unit.run()));
  if (runWasCancelled(state)) throw runInactiveError(state);
  for (let pass = 0; pass < autoRetries; pass += 1) {
    const failed = outcomes.map((outcome, i) => (providerFailure(outcome) ? i : -1)).filter((i) => i >= 0);
    if (!failed.length) break;
    // Prune each failed attempt's partial before re-running so a success replaces it rather than sitting beside it.
    await Promise.all(failed.map((i) => units[i].prune?.()));
    const retried = await Promise.allSettled(failed.map((i) => units[i].run()));
    if (runWasCancelled(state)) throw runInactiveError(state);
    failed.forEach((i, k) => { outcomes[i] = retried[k]; });
  }
  // A cancellation/supersede rejection still aborts the whole run; a plain provider failure is reported, not thrown.
  const inactive = outcomes.find((outcome) => outcome.status === "rejected" && outcome.reason?.runInactive);
  if (inactive) throw inactive.reason;
  const results = [];
  const failed = [];
  outcomes.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") results.push(outcome.value);
    else failed.push({ agent: units[i].agent, reason: outcome.reason });
  });
  return { results, failed };
}

export async function stopRun(sessionId, { settleTimeoutMs = 5000 } = {}) {
  const state = activeRuns.get(sessionId);
  if (!state || !requestRunCancellation(state)) return false;
  const results = await terminateRunChildren(state);
  if (!(await settlePendingProviders(state, settleTimeoutMs))) {
    // Providers did not settle after cancellation (e.g. a stall in the un-timed setup phase,
    // before any child process exists to kill). Finalize the session now so it can't hang in
    // "running"; if a straggler promise settles later, the run body's terminal claim no-ops.
    await finalizeStalledStop(sessionId, state);
  }
  return results.every(Boolean);
}

async function finalizeStalledStop(sessionId, state) {
  if (!claimRunTerminal(state, "stopped", "stop_timeout")) return;
  const emit = state.emit || (() => {});
  try {
    const session = await getSession(sessionId);
    session.status = "stopped";
    session.messages.push(makeMessage({ author: "system", content: "Run stopped by user.", phase: "stopped", mode: session.mode }));
    await persistRunTerminal(session, state, emit);
    emit({ type: "run_stopped", sessionId, runId: state.runId });
  } catch (error) {
    // Match the success-path handling: on a persist failure surface run_error (not a false
    // run_stopped); startup reconciliation repairs the on-disk status on the next run.
    logError("failed to finalize stalled stopped run", redact(error?.message || String(error)));
    emit({ type: "run_error", sessionId, runId: state.runId, error: redact(error?.message || String(error)) });
  } finally {
    // The suspended run body's own finally will not run while its provider promise is stuck, so
    // release its held claims here. Both closures are idempotent, so if the straggler ever settles
    // and the run body's finally runs too, the second release is a safe no-op.
    state.releaseProjectScope?.();
    state.releaseActivity?.();
    if (activeRuns.get(sessionId) === state) activeRuns.delete(sessionId);
  }
}

export function isRunning(sessionId) {
  return activeRuns.has(sessionId);
}

// Stop every in-flight run and mark its session interrupted — used during graceful shutdown
// so we never leave a session stuck in "running" after the process exits.
export async function abortAllRuns(reason = "server_shutdown") {
  for (const [sessionId, state] of activeRuns) {
    requestRunCancellation(state);
    // Shutdown path: SIGKILL now (see terminateProcess) so a detached agent can't outlive the
    // server's ~1500ms exit, which would otherwise beat the SIGTERM→SIGKILL escalation timer.
    await terminateRunChildren(state, { immediate: true });
    if (!claimRunTerminal(state, "interrupted", reason)) continue;
    try {
      await mutateSession(sessionId, (session) => {
        if (activeRuns.get(sessionId) !== state) return;
        session.status = "interrupted";
        session.activeRun = runAttemptRecord(state);
        session.messages.push(makeMessage({
          author: "system",
          content: `تم إيقاف التشغيل بشكل مفاجئ: ${reason}`,
          phase: "interrupted",
          mode: session.mode,
        }));
      });
    } catch (error) {
      logError("failed to mark interrupted discussion", redact(error?.message || String(error)));
    }
  }
}

export async function reconcileInterruptedRuns(reason = "server_restart") {
  const summaries = await listSessions();
  let recovered = 0;
  for (const summary of summaries) {
    if (summary.status !== "running") continue;
    try {
      const didRecover = await mutateSession(summary.id, (session) => {
        if (session.status !== "running") return SKIP_SESSION_WRITE;
        const now = new Date().toISOString();
        const priorRun = session.activeRun?.runId
          ? session.activeRun
          : {
              runId: crypto.randomUUID(),
              mode: session.mode || "collaboration",
              startedAt: session.updatedAt || now,
            };
        session.status = "interrupted";
        session.activeRun = {
          ...priorRun,
          status: "interrupted",
          endedAt: now,
          interruptionReason: reason,
        };
        const message = makeMessage({
          author: "system",
          content: "The previous discussion was interrupted because the server stopped.",
          phase: "interrupted",
          mode: session.mode,
        });
        message.meta = { recovery: true, runId: priorRun.runId };
        session.messages.push(message);
        return true;
      });
      if (didRecover) recovered += 1;
    } catch (error) {
      logError(`failed to reconcile interrupted discussion ${summary.id}`, redact(error?.message || String(error)));
    }
  }
  return recovered;
}

export function runOrchestration(sessionId, request, emit) {
  const validatedRequest = validateOrchestrationRequest(request);
  const releaseActivity = claimSessionActivity(sessionId, "orchestration");
  return runOrchestrationClaimed({ sessionId, request, validatedRequest, emit, releaseActivity });
}

async function runOrchestrationClaimed({ sessionId, request, validatedRequest, emit, releaseActivity }) {
  const state = createRunAttempt(validatedRequest.mode);
  // Keep the run's emitter and resource releasers on the attempt so a stop that has to
  // force-finalize a stalled run (see stopRun) can deliver the terminal SSE event AND release the
  // activity/project-scope claims — the suspended run body's own finally never runs in that case,
  // which would otherwise leave the session wedged as "busy" (409) until the process restarts.
  state.emit = emit;
  state.releaseActivity = releaseActivity;
  let releaseProjectScope = null;
  activeRuns.set(sessionId, state);
  const registerChild = (child) => {
    state.children.add(child);
    child.once("close", () => state.children.delete(child));
  };

  try {
    const session = await getSession(sessionId);
    const { mode, rounds, userTask, selected, finalizer } = validatedRequest;

    // When a project is attached, planning turns read it (read-only) from its git root,
    // grounded by one shared snapshot given to BOTH agents so they start from the same view.
    // Re-validate the path at run time (it may have been deleted/moved since attach) so we
    // fall back to text-only planning instead of failing the whole run on a bad cwd.
    let projectPath = session.project?.path || "";
    if (projectPath) {
      await assertTrustedProject(session);
      try { if (!(await fs.stat(projectPath)).isDirectory()) throw new Error("Attached project is no longer a directory"); }
      catch (error) { throw new Error(`Attached project is unavailable: ${error.message}`); }
    }
    const projSnapshot = projectPath ? await projectSnapshot(projectPath) : "";
    if (projectPath) {
      releaseProjectScope = await registerProjectScope(session.id, projectPath);
      state.releaseProjectScope = releaseProjectScope;
    }

    const connectorSessionId = Object.values(session.connectors || {}).some((item) => item.enabled) ? session.id : "";

    const previousMode = session.mode; // captured before the overwrite below — used to detect a genuine switch INTO debate
    session.status = "running";
    session.mode = mode;
    session.settings = request;
    session.messages.push(makeMessage({ author: "user", content: userTask, phase: "user", mode }));
    session.messages.push(makeMessage({
      author: "system",
      content: `Session mode changed to ${mode}. Participants: ${selected.map((key) => provider(key).label).join(", ")}. Rounds: ${rounds}.`,
      phase: "mode_change",
      mode,
    }));
    if (!(await persistRunProgress(session, state, emit))) throw runInactiveError(state);
    emit({ type: "run_started", sessionId, runId: state.runId, mode, rounds });

    const controlRepairStats = newControlRepairStats();

    const repairMessageControl = async ({ message, target, targetVersion, itemRegistry, originalControl }) => {
      assertRunAcceptsOutput(sessionId, state);
      const definition = provider(message.agent);
      const config = controlRepairConfig(request.agents[message.agent]);
      if (definition.capabilities?.controlRepair !== "tool-free") {
        message.meta.controlRepair = skippedControlRepairAudit({
          target,
          originalControl,
          config,
        });
        return;
      }
      const startedAt = Date.now();
      const workspace = await controlRepairWorkspace(sessionId, state);
      let providerResult = workspace.error;
      let repairedControl = null;
      let status = "failed";
      let failureCode = workspace.error ? "scratch_workspace_error" : "provider_error";
      let providerFailed = Boolean(workspace.error);
      if (!providerFailed) {
        const prompt = controlRepairPrompt({
          agentLabel: definition.label,
          role: message.role,
          priorAnswer: message.content,
          originalControl: message.control,
          targetVersion,
          itemRegistry,
          problems: [target],
        });
        assertRunAcceptsOutput(sessionId, state);
        try {
          providerResult = await invokeControlRepairProvider({
            definition,
            prompt,
            config,
            cwd: workspace.cwd,
            registerChild,
            state,
          });
        } catch (error) {
          if (!runAcceptsOutput(sessionId, state) || error.runInactive) throw runInactiveError(state);
          providerResult = error;
          providerFailed = true;
        }
      }
      if (!providerFailed) {
        assertRunAcceptsOutput(sessionId, state);
        const parsedRepair = parsedControlRepair(providerResult, originalControl, target, targetVersion);
        repairedControl = parsedRepair.repairedControl;
        const { validation } = parsedRepair;
        status = validation.valid ? "succeeded" : "failed";
        failureCode = validation.errorCode;
        if (validation.valid) {
          message.control = repairedControl;
          message.convergence = repairedControl;
        }
      }
      const audit = controlRepairAudit({
        target,
        originalControl,
        repairedControl,
        providerResult,
        config,
        status,
        failureCode,
        durationMs: providerResult?.durationMs ?? Date.now() - startedAt,
      });
      message.meta.controlRepair = audit;
      recordControlRepair(controlRepairStats, audit);
    };

    const assessRepairedRound = async (roundMessages, targetVersion, itemRegistry, confirmationsExhausted = false, invalidControlExhausted = false) => {
      let assessment = assessRound(roundMessages.map((message) => message.control), targetVersion, itemRegistry, confirmationsExhausted, invalidControlExhausted);
      if (!assessment.repairTargets.length) return assessment;
      const originalControls = roundMessages.map((message) => message.control);
      await Promise.all(assessment.repairTargets.map(async (target) => {
        const message = roundMessages[target.controlIndex];
        await repairMessageControl({
          message,
          target,
          targetVersion,
          itemRegistry,
          originalControl: originalControls[target.controlIndex],
        });
      }));
      assertRunAcceptsOutput(sessionId, state);
      if (!(await persistRunProgress(session, state, emit))) throw runInactiveError(state);
      // Re-assess after repair. A control that was unreadable/unrepairable is still invalid here, so the
      // degraded-stop signal is computed on the POST-repair state — repair gets its chance first.
      assessment = assessRound(roundMessages.map((message) => message.control), targetVersion, itemRegistry, confirmationsExhausted, invalidControlExhausted);
      return assessment;
    };

    const callAgent = async (agent, prompt, round, phase) => {
      assertRunAcceptsOutput(sessionId, state);
      // Planning turns run inside the attached project (read-only) so they can read its
      // files; chat stays in the scratch workspace; unattached planning is text-only.
      const isDiscussion = phase === "collaboration" || phase === "opening" || phase === "rebuttal" || phase === "synthesis";
      const definition = provider(agent);
      const useProject = Boolean((isDiscussion || phase === "chat") && projectPath && definition.capabilities?.projectRead);
      const mcpProject = useProject && definition.capabilities?.projectTransport === "mcp";
      const connectorAccess = Boolean(!useProject && definition.capabilities?.connectors && connectorSessionId);
      const webOnly = phase === "chat" && !useProject && !connectorAccess && definition.capabilities?.web;
      const cfg = {
        ...request.agents[agent],
        permission: mcpProject ? "project" : useProject ? "planread" : connectorAccess ? "connectors" : webOnly ? "chat" : "read",
        mcpSessionId: connectorAccess || mcpProject ? session.id : "",
      };
      const cwd = useProject && !mcpProject ? projectPath : await scratchWorkspacePath();
      const role = String(cfg.role || (mode === "debate" ? "Debater" : "Collaborator"));
      const contextChars = prompt.length;
      const contextMessages = session.messages.length;
      emit({ type: "agent_start", sessionId, runId: state.runId, agent, label: provider(agent).label, role, round, phase });
      const deltaBuffer = new CappedText();
      let lastDeltaEmit = 0;
      let result;
      let providerPromise;
      try {
        providerPromise = Promise.resolve().then(() => definition.run({
          prompt,
          config: cfg,
          cwd,
          registerChild,
          onEvent(event) {
            if (!runAcceptsOutput(sessionId, state)) return;
            if (event.kind === "delta") {
              deltaBuffer.append(event.text);
              // Stream the visible answer to the UI as it forms — throttled so a fast token stream can't flood
              // SSE, and sent as a bounded, redacted, control-safe preview (see streamingPreview) so a long
              // answer can't blow up the payload and no secret or machine block shows mid-flight.
              const now = Date.now();
              if (now - lastDeltaEmit >= 100) {
                lastDeltaEmit = now;
                emit({ type: "agent_delta", sessionId, runId: state.runId, agent, text: streamingPreview(deltaBuffer.toString()), round, phase });
              }
            } else {
              const visibleEvent = event?.text ? { ...event, text: redact(event.text) } : event;
              emit({ type: "agent_activity", sessionId, runId: state.runId, agent, event: visibleEvent, round, phase });
            }
          },
        }));
        state.pending.add(providerPromise);
        result = await providerPromise;
      } catch (error) {
        const safeError = redact(error?.message || String(error));
        const partial = redact(String(error.partial || deltaBuffer.toString())).trim();
        // If this turn expected a control block and the partial output already contains a complete, valid
        // one, the agent finished its answer before the CLI failed (e.g. a post-completion timeout). A valid
        // control is a stronger completion signal than the exit code, so recover the turn instead of erroring
        // the whole session — record it completed_recovered with a provider warning, and let the round
        // assessment proceed normally. Truncated output is never recovered (the control may be cut).
        const expectsControl = round >= 2 && (phase === "collaboration" || phase === "rebuttal");
        const recoveredControl = expectsControl && partial && !error.outputTruncated ? parseAgentControl(partial) : null;
        if (recoveredControl?.valid && runAcceptsOutput(sessionId, state)) {
          const recovered = makeMessage({ author: "agent", agent, role, content: stripAgentControl(partial), round, phase, mode });
          recovered.control = recoveredControl;
          recovered.convergence = recoveredControl;
          recovered.meta = {
            requestedModel: cfg.model || "(default)", requestedEffort: cfg.effort || "",
            durationMs: error.durationMs ?? null, exitCode: error.exitCode ?? null, usage: error.usage ?? null,
            status: "completed_recovered", providerWarning: safeError,
            contextChars, contextMessages, retryCount: 0, outputTruncated: false,
          };
          session.messages.push(recovered);
          if (!(await persistRunProgress(session, state, emit))) throw runInactiveError(state);
          emit({ type: "agent_complete", sessionId, runId: state.runId, agent, message: recovered, providerSessionId: error.sessionId || null });
          return recovered;
        }
        // Otherwise, save any partial output, clearly labeled — never treat it as a final result. Strip any
        // <agent-control> block from a control-bearing turn's partial too: an unrecovered partial must never
        // leak the machine block into the reader-facing content or the export.
        if (partial && runAcceptsOutput(sessionId, state)) {
          const partialContent = expectsControl ? stripAgentControl(partial) : partial;
          const partialMsg = makeMessage({ author: "agent", agent, role, content: partialContent, round, phase, mode });
          partialMsg.meta = {
            requestedModel: cfg.model || "(default)", requestedEffort: cfg.effort || "",
            durationMs: error.durationMs ?? null, exitCode: error.exitCode ?? null,
            usage: error.usage ?? null, // token/cost captured before the failure — adapters Object.assign the meta (incl. usage) onto the error
            status: "partial", contextChars, contextMessages, error: safeError,
            outputTruncated: Boolean(error.outputTruncated),
          };
          session.messages.push(partialMsg);
          await persistRunProgress(session, state, emit);
        }
        error.agentLabel = provider(agent).label;
        throw error;
      } finally {
        if (providerPromise) state.pending.delete(providerPromise);
      }
      assertRunAcceptsOutput(sessionId, state);
      // The CONVERGENCE control line is only requested (and only meaningful) in the
      // collaboration/debate turns — parse it for early-stop and strip it there. Chat and
      // synthesis replies never ask for it, so they're left exactly as the agent wrote them
      // (otherwise a chat answer that legitimately contains that line would be corrupted).
      const usesControl = round >= 2 && (phase === "collaboration" || phase === "rebuttal");
      const safeText = redact(result.text);
      const content = usesControl ? stripAgentControl(safeText) : safeText;
      const control = usesControl ? parseAgentControl(safeText) : null;
      const message = makeMessage({ author: "agent", agent, role, content, round, phase, mode });
      message.control = control;
      message.convergence = control;
      message.meta = {
        requestedModel: cfg.model || "(default)", requestedEffort: cfg.effort || "",
        reportedModel: result.model ?? null, durationMs: result.durationMs ?? null,
        exitCode: result.exitCode ?? null, status: "completed",
        contextChars, contextMessages, retryCount: 0,
        outputTruncated: Boolean(result.outputTruncated),
        usage: result.usage ?? null,
      };
      session.messages.push(message);
      if (!(await persistRunProgress(session, state, emit))) throw runInactiveError(state);
      emit({ type: "agent_complete", sessionId, runId: state.runId, agent, message, providerSessionId: result.sessionId || null });
      return message;
    };

    // Drop a failed attempt's partial turn so a successful auto-retry (runResilientRound) leaves exactly one
    // message for (agent, round) — the recovered answer — instead of a stale partial sitting next to it. The
    // partial was already persisted and the store merge is union-by-id, so it has to be removed from the store
    // too, or the retry's next persist merges it right back in.
    const pruneFailedAttempt = async (agent, round) => {
      const i = session.messages.findIndex(
        (m) => m.author === "agent" && m.agent === agent && m.round === round && m.meta?.status === "partial",
      );
      if (i < 0) return;
      const [removed] = session.messages.splice(i, 1);
      await mutateSession(session.id, (latest) => {
        const kept = (latest.messages || []).filter((m) => m.id !== removed.id);
        if (kept.length === (latest.messages || []).length) return SKIP_SESSION_WRITE;
        latest.messages = kept;
        return true;
      });
    };

    let completedRounds = 0;
    let itemRegistry = [];
    let lastAssessment = null;
    let officialOutcome = null;
    let finalizerFailed = null;
    let proposalVersion = 1;
    let confirmationRoundsRun = 0; // consecutive confirmation rounds so far (bounded by MAX_CONFIRMATION_ROUNDS)
    let degradedRoundsRun = 0; // consecutive degradable rounds BEFORE the current one (bounded by DEGRADED_STOP_ROUNDS)
    // Per-round diagnostics: why each round continued (or stopped) and who changed the proposal. Recorded
    // for every assessed round so a run is diagnosable from its outcome/export, not only the final state.
    const roundDiagnostics = [];
    const recordDiagnostic = (round, messages, assessment) => roundDiagnostics.push({
      round,
      agreementState: assessment.agreementState,
      proposalChanged: assessment.proposalChanged,
      awaitingConfirmation: assessment.awaitingConfirmation,
      canStop: assessment.canStop,
      continueReason: assessment.continueReason,
      changedBy: messages.filter((message) => message.control?.substantiveDelta).map((message) => message.agent),
      consistencyErrors: assessment.consistencyErrors,
      warnings: assessment.warnings,
      // Which agents' control blocks couldn't be certified this round (after any repair attempt) — lets the
      // closing report name the real blocker instead of an opaque "no agreement". repairStatus distinguishes
      // "skipped" (provider can't repair), "failed" (tried, still invalid), "succeeded"/"none".
      controlFailures: messages
        .filter((message) => !message.control || message.control.valid === false)
        .map((message) => ({
          agent: message.agent,
          errorCodes: [...(message.control?.errorCodes || [])],
          repairStatus: message.meta?.controlRepair?.status || "none",
          repairFailureCode: message.meta?.controlRepair?.failureCode || null,
        })),
      // Did every agent WITH a valid control converge this round? Lets the closing report reassure the user
      // that a single bad control block sank a near-agreement — the rest had actually agreed.
      validControlsConverged: (() => {
        const valid = messages.filter((message) => message.control?.valid);
        return valid.length > 0 && valid.every((message) => message.control.convergence === "converged");
      })(),
    });

    // A provider that keeps failing (even after its automatic retry) is dropped from the rest of the session
    // rather than erroring the whole run — so one broken agent (e.g. a 401 from an un-logged-in CLI) doesn't
    // throw away the answers the others already gave. Each round runs on the surviving roster.
    const droppedAgents = new Set();
    const roster = () => selected.filter((agent) => !droppedAgents.has(agent));
    const reconcileRound = async (outcome, minSurvivors = 1) => {
      // Too few agents left to continue (debate needs both sides; every mode needs at least one): that IS a run
      // failure — claim it and clean up, then re-throw so the outer handler finalizes the session as errored. We
      // check this FIRST so an all-fail round doesn't post misleading "dropped from the rest of the session"
      // notices — there is no rest of the session.
      if (outcome.results.length < minSurvivors) {
        if (requestRunFailure(state)) await terminateRunChildren(state);
        throw outcome.failed[0]?.reason || new Error("No agents completed the round");
      }
      for (const failure of outcome.failed) {
        if (droppedAgents.has(failure.agent)) continue;
        droppedAgents.add(failure.agent);
        const safeError = redact(failure.reason?.message || String(failure.reason));
        const note = makeMessage({
          author: "system",
          content: `${provider(failure.agent).label} couldn't respond and was dropped from the rest of this session: ${safeError}`,
          phase: "notice",
          mode,
        });
        note.meta = { status: "agent_dropped", agent: failure.agent, error: safeError };
        session.messages.push(note);
        await persistRunProgress(session, state, emit).catch(() => {});
        emit({ type: "agent_dropped", sessionId, runId: state.runId, agent: failure.agent, error: safeError });
      }
      return outcome.results;
    };
    const minSurvivors = mode === "debate" ? 2 : 1;

    if (mode === "chat") {
      // Simple chat: each agent answers the user independently, in parallel, one pass.
      const snapshot = structuredClone(session);
      const chatOutcome = await runResilientRound(roster().map((agent) => {
        const prompt = chatPrompt({
          session: snapshot,
          agentLabel: provider(agent).label,
          role: request.agents[agent].role,
          userTask,
          capabilities: {
            ...provider(agent).capabilities,
            web: Boolean(provider(agent).capabilities?.web && !projectPath && !connectorSessionId),
            projectRead: Boolean(projectPath && provider(agent).capabilities?.projectRead),
          },
          projectSnapshot: projSnapshot,
          transcriptBudget: provider(agent).contextBudgetChars,
        });
        return { agent, run: () => callAgent(agent, prompt, 1, "chat"), prune: () => pruneFailedAttempt(agent, 1) };
      }), state);
      await reconcileRound(chatOutcome, minSurvivors);
    } else if (mode === "collaboration") {
      for (let round = 1; round <= rounds; round += 1) {
        if (round === 1) {
          const openingSession = structuredClone(session);
          const openingOutcome = await runResilientRound(roster().map((agent) => {
            const prompt = collaborationPrompt({
              session: openingSession,
              agentLabel: provider(agent).label,
              role: request.agents[agent].role,
              round,
              totalRounds: rounds,
              userTask,
              projectSnapshot: projSnapshot,
              participants: selected.map((id) => provider(id).label),
              transcriptBudget: provider(agent).contextBudgetChars,
            });
            return { agent, run: () => callAgent(agent, prompt, round, "collaboration"), prune: () => pruneFailedAttempt(agent, round) };
          }), state);
          await reconcileRound(openingOutcome, minSurvivors);
          completedRounds = round;
          continue;
        }
        const snapshot = structuredClone(session);
        const targetVersion = proposalVersion;
        // The previous round reached agreement but carried a late change others hadn't seen, so this
        // round is a confirmation round: a tightened prompt asks agents to only re-open on a genuine
        // decision change, so it stops here instead of drifting into marginal re-tweaks.
        const confirmationRound = lastAssessment?.awaitingConfirmation === true;
        // Count consecutive confirmation rounds; reset the moment we're not in one. Once we've spent
        // MAX_CONFIRMATION_ROUNDS of them still converged, accept the agreement instead of looping.
        confirmationRoundsRun = confirmationRound ? confirmationRoundsRun + 1 : 0;
        const confirmationsExhausted = confirmationRoundsRun >= MAX_CONFIRMATION_ROUNDS;
        // Consecutive degradable rounds before this one; once this round would be the DEGRADED_STOP_ROUNDS-th
        // in a row, allow the honest degraded stop instead of looping to the round limit.
        degradedRoundsRun = lastAssessment?.degradable === true ? degradedRoundsRun + 1 : 0;
        const invalidControlExhausted = degradedRoundsRun + 1 >= DEGRADED_STOP_ROUNDS;
        const roundOutcome = await runResilientRound(roster().map((agent) => {
          const prompt = collaborationPrompt({
            session: snapshot,
            agentLabel: provider(agent).label,
            role: request.agents[agent].role,
            round,
            totalRounds: rounds,
            userTask,
            projectSnapshot: projSnapshot,
            targetVersion,
            itemRegistry,
            confirmationRound,
            participants: selected.map((id) => provider(id).label),
            transcriptBudget: provider(agent).contextBudgetChars,
          });
          return { agent, run: () => callAgent(agent, prompt, round, "collaboration"), prune: () => pruneFailedAttempt(agent, round) };
        }), state);
        const roundMessages = await reconcileRound(roundOutcome, minSurvivors);
        const assessment = await assessRepairedRound(roundMessages, targetVersion, itemRegistry, confirmationsExhausted, invalidControlExhausted);
        lastAssessment = assessment;
        recordDiagnostic(round, roundMessages, assessment);
        itemRegistry = assessment.itemRegistry;
        completedRounds = round;
        // canStop is checked FIRST: with confirmations exhausted, canStop can be true even while proposalChanged
        // is true, and the old proposalChanged-first order would loop past it. degradedStop is a separate
        // terminal path: the round couldn't formally seal (an unreadable control) but the readable participants
        // converged and the condition persisted, so stop honestly instead of running out the rounds.
        if (assessment.canStop || assessment.degradedStop) break;
        if (assessment.proposalChanged) proposalVersion += 1;
      }
    } else {
      // Anchor the debate to the answer already on the table so a "switch to debate" message
      // debates that answer, not itself — but ONLY on a genuine switch INTO debate. If the
      // session was already in debate, a new message is a fresh question, not a re-debate of the
      // last rebuttal, so fall back to the user's message as the proposition.
      const proposition = previousMode === "debate" ? "" : lastSubstantiveAnswer(session);
      const openingSession = structuredClone(session);
      const debateOpening = await runResilientRound(roster().map((agent) => {
        const opponent = roster().find((key) => key !== agent);
        const prompt = debatePrompt({
          session: openingSession,
          agentLabel: provider(agent).label,
          role: request.agents[agent].role,
          opponentLabel: provider(opponent).label,
          round: 1,
          totalRounds: rounds,
          userTask,
          independent: true,
          projectSnapshot: projSnapshot,
          proposition,
          transcriptBudget: provider(agent).contextBudgetChars,
        });
        return { agent, run: () => callAgent(agent, prompt, 1, "opening"), prune: () => pruneFailedAttempt(agent, 1) };
      }), state);
      await reconcileRound(debateOpening, minSurvivors);
      completedRounds = 1;

      for (let round = 2; round <= rounds; round += 1) {
        const snapshot = structuredClone(session);
        const targetVersion = proposalVersion;
        // Confirmation round (see the collaboration loop): the previous round converged but carried a late
        // change the others hadn't seen, so this round gets the tightened confirm-only prompt.
        const confirmationRound = lastAssessment?.awaitingConfirmation === true;
        confirmationRoundsRun = confirmationRound ? confirmationRoundsRun + 1 : 0;
        const confirmationsExhausted = confirmationRoundsRun >= MAX_CONFIRMATION_ROUNDS;
        degradedRoundsRun = lastAssessment?.degradable === true ? degradedRoundsRun + 1 : 0;
        const invalidControlExhausted = degradedRoundsRun + 1 >= DEGRADED_STOP_ROUNDS;
        const rebuttalOutcome = await runResilientRound(roster().map((agent) => {
          const opponent = roster().find((key) => key !== agent);
          const prompt = debatePrompt({
            session: snapshot,
            agentLabel: provider(agent).label,
            role: request.agents[agent].role,
            opponentLabel: provider(opponent).label,
            round,
            totalRounds: rounds,
            userTask,
            independent: false,
            projectSnapshot: projSnapshot,
            targetVersion,
            itemRegistry,
            proposition,
            confirmationRound,
            transcriptBudget: provider(agent).contextBudgetChars,
          });
          return { agent, run: () => callAgent(agent, prompt, round, "rebuttal"), prune: () => pruneFailedAttempt(agent, round) };
        }), state);
        const roundMsgs = await reconcileRound(rebuttalOutcome, minSurvivors);
        const assessment = await assessRepairedRound(roundMsgs, targetVersion, itemRegistry, confirmationsExhausted, invalidControlExhausted);
        lastAssessment = assessment;
        recordDiagnostic(round, roundMsgs, assessment);
        itemRegistry = assessment.itemRegistry;
        completedRounds = round;
        // canStop first (see the collaboration loop): with confirmations exhausted it can be true while
        // proposalChanged is also true. degradedStop is the separate honest-stop path when an unreadable
        // control blocks the seal but the readable side converged and the condition persisted.
        if (assessment.canStop || assessment.degradedStop) break;
        if (assessment.proposalChanged) proposalVersion += 1;
      }
    }

    // Persist the deterministic outcome before asking the finalizer to explain it.
    if (!runWasCancelled(state) && mode !== "chat" && rounds >= 2 && lastAssessment) {
      officialOutcome = buildDiscussionOutcome(
        lastAssessment,
        rounds,
        completedRounds,
        completedControlRepairStats(controlRepairStats),
        roundDiagnostics,
      );
      const outcomeMessage = makeMessage({
        author: "system",
        content: discussionOutcomeReport(officialOutcome),
        phase: officialOutcome.phase,
        mode,
      });
      outcomeMessage.meta = { outcome: officialOutcome };
      session.messages.push(outcomeMessage);
      if (!(await persistRunProgress(session, state, emit))) throw runInactiveError(state);
    }

    if (mode !== "chat" && finalizer && finalizer !== "none" && roster().includes(finalizer) && !runWasCancelled(state)) {
      const prompt = synthesisPrompt({
        session,
        agentLabel: provider(finalizer).label,
        role: request.agents[finalizer].role,
        userTask,
        mode,
        projectSnapshot: projSnapshot,
        outcome: officialOutcome,
        participants: selected.map((id) => provider(id).label),
        transcriptBudget: provider(finalizer).contextBudgetChars,
      });
      try {
        await callAgent(finalizer, prompt, completedRounds + 1, "synthesis");
      } catch (finalizerError) {
        // The finalizer only EXPLAINS the already-persisted official outcome — it never decides it. So its
        // failure must NOT turn a completed discussion into an errored session: record the failure and
        // complete the run on the deterministic outcome (the source of truth). A genuine cancellation
        // mid-finalizer still stops the run.
        if (runWasCancelled(state)) throw finalizerError;
        finalizerFailed = redact(finalizerError?.message || String(finalizerError));
        logWarn("finalizer failed; completing on the official outcome", finalizerFailed);
        const noteMessage = makeMessage({
          author: "system",
          content: "The final summary couldn't be generated, so the official outcome above stands.",
          phase: "synthesis",
          mode,
        });
        noteMessage.meta = { finalizerFailed: true, providerWarning: finalizerFailed };
        session.messages.push(noteMessage);
        await persistRunProgress(session, state, emit).catch(() => {});
      }
    }

    const terminalStatus = runWasCancelled(state) ? "stopped" : "completed";
    if (claimRunTerminal(state, terminalStatus)) {
      session.status = terminalStatus;
      try {
        await persistRunTerminal(session, state, emit);
      } catch (persistError) {
        // We already own the terminal transition, so the outer catch can no longer re-claim it
        // (claimRunTerminal is one-shot). Surface the durable-write failure as run_error here so
        // the client still gets a terminal event; startup reconciliation repairs the on-disk
        // status on the next run instead of the session appearing to hang.
        logError("failed to persist completed discussion state", redact(persistError?.message || String(persistError)));
        emit({ type: "run_error", sessionId, runId: state.runId, error: redact(persistError?.message || String(persistError)) });
        return;
      }
      emit({
        type: terminalStatus === "stopped" ? "run_stopped" : "run_complete",
        sessionId,
        runId: state.runId,
      });
    }
  } catch (error) {
    const safeError = redact(error?.message || String(error));
    const terminalStatus = runWasCancelled(state) ? "stopped" : "error";
    if (claimRunTerminal(state, terminalStatus)) {
      try {
        const session = await getSession(sessionId);
        session.status = terminalStatus;
        const failMsg = makeMessage({
          author: "system",
          content: terminalStatus === "stopped" ? "Run stopped by user." : `فشل التشغيل: ${safeError}`,
          phase: terminalStatus,
          mode: session.mode,
        });
        if (terminalStatus !== "stopped") {
          failMsg.meta = {
            status: "error",
            error: safeError,
            agent: error.agentLabel || null,
            durationMs: error.durationMs ?? null,
            technical: error.technical ? redact(String(error.technical)).slice(0, 6000) : null,
          };
        }
        session.messages.push(failMsg);
        await persistRunTerminal(session, state, emit);
      } catch (persistenceError) {
        logError("failed to persist terminal discussion state", redact(persistenceError?.message || String(persistenceError)));
      }
      emit({
        type: terminalStatus === "stopped" ? "run_stopped" : "run_error",
        sessionId,
        runId: state.runId,
        error: safeError,
      });
    }
  } finally {
    try {
      releaseProjectScope?.();
      await Promise.all([...state.children].map((child) => terminateProcess(child)));
    } finally {
      if (activeRuns.get(sessionId) === state) activeRuns.delete(sessionId);
      releaseActivity();
    }
  }
}
