function clean(text) {
  return String(text ?? "").trim();
}

// Providers sometimes leak their own execution plumbing into the reader-facing answer — Cursor has written
// lines like "The shell was rejected" straight into its reply. The answer is for the user, not a log of the
// agent's tooling, so every phase forbids that narration.
const ANSWER_HYGIENE = `Your reply is the answer itself, not a report on how you produced it: never narrate tool calls, permission prompts, or CLI/shell errors (for example "the shell was rejected" or "I don't have permission to run that"). If something you would have checked isn't available, work with what you have and, where it matters, state briefly what you couldn't verify.`;

// Agents kept treating an attached document as "the task", drifting from what the user actually asked (e.g.
// "analyze this failed session" turned into a review of the plan pasted inside it). Keep the user's own
// instruction as the task; attachments are material to act ON, not new instructions or a replacement subject.
const TASK_INTERPRETATION = `Do what the user actually asked in their own words. When their message includes attached files or a pasted document/session (often under an "[Attached files]" marker), let the user's own request decide how to use it: if they asked you to ANALYZE, review, or critique the attachment, that analysis IS the task — don't drift into re-doing the attachment's own topic. But if they explicitly delegated to it ("follow the attached spec", "answer the questions in this file"), carry out those contents as instructed. Either way, don't let an attachment silently become a different subject that replaces what the user asked.`;

// Head+tail excerpt for text that may be huge (agent turns can reach several MB). Keeps the
// start and end — enough to identify the answer — without ever blowing the prompt window.
function boundedExcerpt(text, max) {
  const value = clean(text);
  if (value.length <= max) return value;
  const head = Math.ceil(max * 0.75);
  return `${value.slice(0, head)}\n…[truncated]…\n${value.slice(value.length - (max - head))}`;
}

// How much of the running transcript to hand each agent. Big on purpose: modern model windows hold far more
// than the old 24k, and aggressively trimming the discussion is exactly what made a follow-up ("modify the
// plan") lose the plan. One tunable constant — a smaller-window provider lowers it via contextBudgetChars in
// the provider registry, and the pins below (original task + current proposals + latest outcome) survive any
// trim regardless.
const TRANSCRIPT_BUDGET_CHARS = 200000;
export function transcriptFor(session, maxChars = TRANSCRIPT_BUDGET_CHARS) {
  // Aborted turns (a provider that failed mid-answer) are kept in the session for the reader, but never fed
  // back to the agents — a surviving agent must not reason from an explicitly incomplete, dropped response.
  const msgs = (session.messages ?? []).filter((message) => message.meta?.status !== "partial");
  const SEP = "\n\n---\n\n";
  const TRIM = "[Older context was trimmed by the local orchestrator.]";
  const cap = Math.max(maxChars, TRIM.length + SEP.length + 40);
  const render = (message, limit = cap) => {
    const speaker = message.author === "user"
      ? "USER"
      : message.author === "system"
        ? "SYSTEM"
        : `${String(message.agent || "AGENT").toUpperCase()}${message.role ? ` (${message.role})` : ""}`;
    const source = message.author === "user" ? "user-provided" : "stored-session";
    const header = `[${speaker} | source:${source} | ${message.phase || "message"}${message.round ? ` | round ${message.round}` : ""}]\n`;
    const raw = String(message.content ?? "");
    if (header.length > limit) return { text: header.slice(0, limit), truncated: true };
    const room = Math.max(0, limit - header.length);
    const suffix = "\n…[message truncated]";
    if (raw.length <= room) return { text: `${header}${raw.trim()}`, truncated: false };
    const kept = room <= suffix.length ? suffix.slice(0, room) : `${raw.slice(0, room - suffix.length).trim()}${suffix}`;
    return { text: `${header}${kept}`.slice(0, limit), truncated: true };
  };

  // First try the exact transcript, but stop rendering as soon as the bounded budget is
  // exceeded. This never materializes the full persistent history before trimming it.
  const full = [];
  let fullLength = 0;
  let overflow = false;
  for (const message of msgs) {
    const separator = full.length ? SEP.length : 0;
    const remaining = cap - fullLength - separator;
    if (remaining < 1) { overflow = true; break; }
    const block = render(message, remaining);
    if (block.truncated) { overflow = true; break; }
    full.push(block.text);
    fullLength += separator + block.text.length;
  }
  if (!overflow) return full.join(SEP);

  // Overflow: smart-compact instead of a blind trim. Pin the turns a follow-up depends on, fill the rest from
  // the newest tail, then emit everything in CHRONOLOGICAL order with a trim marker at each elided gap (so an
  // earlier turn never reads as if it came after a later one). Pins, in priority order:
  //   • the ORIGINAL task (first user turn) — the subject the whole session is about;
  //   • the NEWEST turn — continuity for the next round;
  //   • the latest official outcome (the agreed state so far);
  //   • the CURRENT run's round-1 agent turns — in a delta-only discussion the full proposal/plan lives ONLY
  //     here (later rounds are deltas, and the outcome record is status, not the plan), so a "modify the plan"
  //     follow-up needs them. This is why the plan survives even a finalizer-less collaboration.
  const firstUserIdx = msgs.findIndex((message) => message.author === "user");
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i -= 1) { if (msgs[i].author === "user") { lastUserIdx = i; break; } }
  let latestOutcomeIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i -= 1) { if (msgs[i].meta?.outcome) { latestOutcomeIdx = i; break; } }
  const proposalIdx = [];
  for (let i = lastUserIdx + 1; i < msgs.length; i += 1) {
    if (msgs[i].author === "agent" && msgs[i].round === 1) proposalIdx.push(i);
  }
  const pins = [...new Set([firstUserIdx, msgs.length - 1, latestOutcomeIdx, ...proposalIdx].filter((index) => index >= 0))];

  // Reserve room for EVERY gap marker up front, so the chronological join can never overflow `cap` and force
  // the final slice to cut content off the end — which would drop the NEWEST turn (rendered last). Gaps are
  // bounded by the pinned islands: each pin, plus the head, can open at most one gap, so `pins.length + 2`
  // markers is a safe upper bound. Render each kept message exactly once, caching by index.
  const markerCost = TRIM.length + SEP.length;
  const budget = Math.max(0, cap - (pins.length + 2) * markerCost);
  const kept = new Map();
  let used = 0;
  const keep = (index) => {
    if (index < 0 || index >= msgs.length || kept.has(index)) return;
    const remaining = budget - used - (kept.size ? SEP.length : 0);
    if (remaining < 1) return;
    const block = render(msgs[index], remaining);
    kept.set(index, block.text);
    used += block.text.length + SEP.length;
  };
  // Pins first (priority order above), then fill the rest of the tail newest-first until the budget is spent.
  for (const index of pins) keep(index);
  for (let i = msgs.length - 1; i >= 0 && used < budget; i -= 1) keep(i);

  // Emit in chronological order, dropping a trim marker wherever a run of messages was elided (before the
  // first kept turn, between non-adjacent kept turns, and after the last kept turn).
  const order = [...kept.keys()].sort((a, b) => a - b);
  const parts = [];
  let prev = -1;
  for (const index of order) {
    if (index > prev + 1) parts.push(TRIM);
    parts.push(kept.get(index));
    prev = index;
  }
  if (order.length && order[order.length - 1] < msgs.length - 1) parts.push(TRIM);
  if (!parts.length) parts.push(TRIM);
  return parts.join(SEP).slice(0, cap);
}

function controlShape(targetVersion) {
  return JSON.stringify({
    controlVersion: 2,
    convergence: "converged|open|not_evaluated",
    goalStatus: "satisfied|incomplete|blocked|needs_user",
    substantiveDelta: false,
    itemProposals: [{
      action: "create|keep_open|resolve|merge_into",
      itemId: "required except for create",
      targetItemId: "merge_into only",
      kind: "create only: disagreement|user_decision|external_validation|remaining_work|out_of_scope",
      text: "create only: specific unresolved item",
      requiredStep: { actor: "create only: user|human_operator|orchestrator|agent", action: "create only: provide_decision|run_external_check|resume_agent_round" },
    }],
    targetVersion,
  });
}

function controlInstruction(targetVersion, itemRegistry = [], confirmationRound = false) {
  const confirmation = confirmationRound
    ? `CONFIRMATION ROUND — the group already reached agreement; a participant made a late change last round you may not have seen (everyone works from one shared snapshot, so same-round changes aren't visible until now). Review the latest proposal and the others' most recent turn. Do NOT add optional improvements, rephrasing, or new angles. Set substantiveDelta=true ONLY if you genuinely need to change the shared decision; otherwise set convergence=converged and substantiveDelta=false so the session closes now.\n`
    : "";
  return `${confirmation}End with exactly one machine-readable control block after your reader-facing answer:
<agent-control>${controlShape(targetVersion)}</agent-control>
Use convergence=converged only if you agree with the latest proposal. goalStatus describes whether the user's actual task is complete, not whether the agents agree. Set substantiveDelta=true ONLY when your answer MATERIALLY changes the shared proposal — a different decision, a corrected fact, a changed recommendation. Do NOT set it for rephrasing, re-emphasis, extra detail, or re-stating points already on the table: a false substantiveDelta creates a new version and forces another paid round for nothing. If you've genuinely agreed and have nothing material to add, set substantiveDelta=false so the session can stop.
itemProposals are proposals, not official state. For a new item use action=create without itemId or targetItemId. For an existing open item reuse its itemId and use keep_open, resolve, or merge_into; merge_into also requires targetItemId. A user_decision requires user/provide_decision. external_validation requires user, human_operator, or orchestrator with run_external_check. disagreement and remaining_work require agent/resume_agent_round. out_of_scope requires user/provide_decision. Do not include confidence or openPoints in version 2.
When you and the other agents have genuinely landed in the same place and you're no longer materially changing the proposal, set convergence=converged and substantiveDelta=false so the session can stop early instead of repeating a round with nothing new. goalStatus reflects only whether you can complete THIS answer, not what the user might do afterward: use needs_user (with a user_decision item) only when you genuinely cannot finish your answer until the user decides or supplies missing information, and blocked (with an external_validation item) only when the answer itself cannot be settled until an outside check runs. If you have actually answered the question and the rest is just actions you're recommending the user take next, that is goalStatus=satisfied — put them in your reader-facing answer as next steps, NOT as user_decision or external_validation items. Don't fall back on goalStatus=incomplete just because the task isn't fully finished. Reserve remaining_work for real work another agent round would still add; that is the one signal that legitimately keeps the rounds going.
Current approved itemRegistry (reuse these IDs; omission never closes an item):
${JSON.stringify(itemRegistry)}
Review every open item before making a terminal claim. Reuse its existing itemId. If your answer says it is resolved, obsolete, or no longer needs the user, emit resolve or merge_into. If it remains open, emit keep_open and choose a matching goalStatus. Omission of an open item prevents the terminal claim from being accepted. Do not create a new item for a topic whose itemId is already listed.
Do not put the block in a code fence or write anything after it.`;
}

// Repair never reopens the debate: the reader-facing answer already stands. The prompt only
// corrects the explicitly classified machine-signal defects supplied by deterministic assessment.
export function controlRepairPrompt({
  agentLabel,
  role,
  priorAnswer,
  originalControl = null,
  targetVersion = 1,
  itemRegistry = [],
  problems = [],
}) {
  return `You are ${agentLabel}, performing a narrow control repair for your previous ${role || "agent"} turn.
Do not rewrite the reader-facing answer, add reasoning, change your position, or introduce any new decision or fact.

Original reader-facing answer:
<original-answer>
${boundedExcerpt(priorAnswer, 4000)}
</original-answer>

Original normalized control:
${JSON.stringify(originalControl)}

Current approved itemRegistry:
${JSON.stringify(itemRegistry)}

Structured control problems:
${JSON.stringify(problems)}

Repair only the listed structural problems. When the original control is valid, preserve convergence, goalStatus, substantiveDelta, targetVersion, and every unrelated item proposal exactly unless that specific field is named by a listed problem. For unaddressed_open_item, only add an explicit action for the listed itemId. For target_version_mismatch, only update targetVersion. When the original control is missing or malformed, reconstruct it from the original answer and explicitly address every open registry item with its existing itemId.
Return exactly one <agent-control> block using this contract:
<agent-control>${controlShape(targetVersion)}</agent-control>
Do not use a code fence. Do not write anything after it, and do not write anything before it.`;
}

export function collaborationPrompt({ session, agentLabel, role, round, totalRounds, userTask, projectSnapshot = "", targetVersion = 1, itemRegistry = [], confirmationRound = false, participants = [], transcriptBudget = TRANSCRIPT_BUDGET_CHARS }) {
  const others = participants.filter((name) => name && name !== agentLabel);
  const roster = others.length > 1
    ? ` The other agents at the table are ${others.join(" and ")} — engage with what EACH of them says, not just one; this is a ${participants.length}-way discussion, so don't collapse it down to a single opposing voice.`
    : others.length === 1
      ? ` The other agent at the table is ${others[0]} — engage directly with what they actually say.`
      : "";
  const tools = projectSnapshot
    ? `You can READ the attached project (Read/Grep/Glob) to ground what you say in the real code — read only, never edit or run anything. When you make a claim about the code, point to the file (and the line when you can), and be honest about what you actually checked versus what you're inferring. Only claim to have verified something if you actually opened it in THIS attached project (its path and top-level tree are in the evidence pack). If the discussion is about a different codebase, or files that simply aren't here, say plainly you can't verify those from this project — never pass off memory or assumption as a code check.`
    : `Work from what's in front of you — don't reach for tools, edit files, or run commands.`;
  // Round 1 is where you lay the whole thing out. After that it's DELTA-ONLY: say what
  // changed, not the whole plan again (re-writing it every round burns context for nothing).
  // Only the final synthesis rebuilds the complete version.
  const guidance = round === 1
    ? `Lay out your take in full this round. Talk through what's already solid in the shared work, what you'd change or add and why, the proposal as you'd shape it now, and anything you're honestly still unsure about. Write it the way you'd talk it through with a colleague you respect — in your own voice, not as a stiff numbered form.`
    : confirmationRound
      ? `This is a confirmation round: the group already landed in the same place, and a participant made a late change last round you may not have seen. Read the latest proposal and the others' most recent turn, then either confirm you're still aligned, or — only if it genuinely changes the shared decision — say plainly what has to change. Don't add optional improvements, rephrasing, or new angles.`
      : `This is a later round, so keep it to what's actually new — don't rewrite the whole plan. In a few honest lines: what you now accept from the others' latest turns, where any of them is off and why, the one or two things you're really adding this round, and whatever's still open between you. Engage with every other agent's points, not just one. If you've got nothing substantive left to add, just say so — don't pad it out.`;
  const control = round >= 2 ? `\n${controlInstruction(targetVersion, itemRegistry, confirmationRound)}\n` : "";
  return `You're ${agentLabel}, one of ${participants.length || "several"} agents thinking this through together in a shared session that the user runs and ultimately decides on.${roster}
Your seat at the table: ${role || "Collaborator"}.
This is round ${round} of THIS run, and there's room for up to ${totalRounds} — but you're not here to fill rounds. The moment all the agents genuinely land in the same place, the session stops early, and that's exactly the outcome we want. The round number and status here are the authoritative count for THIS run: if the session was interrupted and resumed, don't mistake an earlier attempt's "rounds completed" text for the current round. (A prior run that finished normally is still valid context — if the user is building on that earlier agreed result, work from it, don't discard it.)

You're not competing. You're building one answer that's better than any of you would reach alone: take what's good in the others' work, fix what's weak, add what's missing, and move the shared solution forward. Don't just echo what's already on the table.

${guidance}
${control}
Reply in the same language the user last used. You don't literally share a session with the other models — the local orchestrator is handing you the shared transcript, so don't pretend otherwise. ${tools}
${ANSWER_HYGIENE}
${TASK_INTERPRETATION}
${projectSnapshot ? `\n${projectSnapshot}\n` : ""}
What the user asked for [user-provided]:
${clean(userTask)}

The conversation so far:
${transcriptFor(session, transcriptBudget)}`;
}

export function chatPrompt({ session, agentLabel, role, userTask, capabilities = {}, projectSnapshot = "", transcriptBudget = TRANSCRIPT_BUDGET_CHARS }) {
  const web = capabilities.web
    ? `[capability:web=enabled]\nWeb search is available. Use it when the user asks you to verify something, requests sources, or asks about information that may have changed. Stable questions do not need a search.`
    : `[capability:web=disabled]\nWeb search is not available in this run. Never claim that you searched; state which time-sensitive facts you could not verify.`;
  const project = capabilities.projectRead && projectSnapshot
    ? `[capability:project=trusted]\nA trusted project is attached. Prefer verified project evidence for questions about that project, and distinguish verified facts from inference.\n${projectSnapshot}`
    : `[capability:project=unavailable]\nNo trusted project evidence is available in this run. Do not claim that you inspected project files.`;
  return `You are ${agentLabel}, answering the user directly in one persistent multi-agent session.
Current mode: CHAT.
Your assigned role: ${role || "Assistant"}.

This is a normal chat: answer the user's latest message directly and helpfully in your own voice. ${web} ${project} The other agents are answering the same message separately — do not coordinate with, imitate, or wait for their answers.

Answer in the same language as the user's latest message. Do not claim you directly share a provider-side session with another model; the local orchestrator is supplying the shared transcript. Do not modify files or run shell commands.
${ANSWER_HYGIENE}

Latest user message [user-provided]:
${clean(userTask)}

Shared session transcript (for context only):
${transcriptFor(session, transcriptBudget)}`;
}

export function debatePrompt({ session, agentLabel, role, opponentLabel, round, totalRounds, userTask, independent, projectSnapshot = "", targetVersion = 1, itemRegistry = [], proposition = "", confirmationRound = false, transcriptBudget = TRANSCRIPT_BUDGET_CHARS }) {
  const tools = projectSnapshot
    ? `You can READ the attached project (Read/Grep/Glob) to ground your argument in the real code — read only, never edit or run anything. When you cite the code, name the file (and the line when you can), and keep what you verified separate from what you're inferring. Only claim to have verified something if you actually opened it in THIS attached project (its path and top-level tree are in the evidence pack); if the argument is about a different codebase or files that aren't here, say plainly you can't verify those from this project — never pass off memory as a code check.`
    : `Argue from what's in front of you — don't reach for tools, edit files, or run commands.`;
  const guidance = independent
    ? `This is your opening. Form your own position from the task and the earlier context — don't shadow how your opponent framed theirs. Make the real case: where you stand and why, your strongest arguments, what you'll honestly concede, where the other side falls short, what evidence or test would actually change your mind, the call you'd make, and how confident you are (0–100). Argue it like you mean it, in your own voice — not as a checklist.`
    : confirmationRound
      ? `This is a confirmation round: the group already landed in the same place, and a participant made a late change last round you may not have seen. Read the latest proposal and the other side's most recent turn, then either confirm you're still aligned, or — only if it genuinely changes the shared decision — say plainly what has to change. Don't add optional improvements, rephrasing, or new angles.`
      : `This is a rebuttal, so go straight at the strongest opposing point on the table — don't re-argue your whole case. In a few sharp, honest lines: what you now concede from their last turn, your best specific challenge to it, anything genuinely new you're bringing this round, what's still unsettled between you, and your updated confidence (0–100).`;
  const control = !independent ? `\n${controlInstruction(targetVersion, itemRegistry, confirmationRound)}\n` : "";
  // When the debate was opened on an existing discussion, the subject is the answer already on
  // the table — the user's message ("let's debate this") is only the trigger. Anchor to it
  // explicitly so the context isn't lost and the agents don't debate the switch itself. If the
  // user's message states its own proposition, they follow that instead.
  const propositionText = clean(proposition);
  const subject = propositionText
    ? `What to debate: the most recent answer this session produced, quoted below. The user's latest message is what asked you to open the debate — treat it as the trigger (and any extra steer), NOT as the thing to debate, unless it clearly states a different proposition of its own.

The answer under debate [from the transcript]:
${propositionText}

The user's latest message [user-provided]:
${clean(userTask)}`
    : `The question on the table [user-provided]:
${clean(userTask)}`;
  return `You're ${agentLabel}, debating in a shared session that the user runs and ultimately decides on.
Your position: ${role || "Critical debater"}.
Across the table: ${opponentLabel}.
This is round ${round} of THIS run, with room for up to ${totalRounds} — but the session can stop early the moment the disagreement is genuinely resolved, so don't stretch it just to fill rounds. The round number and status here are the authoritative count for THIS run: if the session was interrupted and resumed, don't mistake an earlier attempt's "rounds completed" text for the current round. (A prior run that finished normally is still valid context to build on.)

${guidance}
${control}
Reply in the same language the user last used. ${tools}
${ANSWER_HYGIENE}
${TASK_INTERPRETATION}
${projectSnapshot ? `\n${projectSnapshot}\n` : ""}
${subject}

The debate so far:
${transcriptFor(session, transcriptBudget)}`;
}

export function synthesisPrompt({ session, agentLabel, role, userTask, mode, projectSnapshot = "", outcome = null, participants = [], transcriptBudget = TRANSCRIPT_BUDGET_CHARS }) {
  const tools = projectSnapshot
    ? `You may READ the attached project's files (Read/Grep/Glob) to verify claims against the real code — read only, never modify files or run commands. Only mark something "verified" if you actually opened it in THIS attached project (its path and top-level tree are in the evidence pack); if the discussion is about a different codebase or files that aren't here, list those claims as UNVERIFIED — never present an agent's memory or assumption as a code check.`
    : `Do not use tools or change files.`;
  const officialOutcome = outcome ? JSON.stringify(outcome) : "No machine-readable outcome was produced.";
  // When the machine outcome couldn't be certified (a control block failed validation), its own agreement /
  // pending / disagreement lists are unreliable and may be empty even though real items exist — the brief must
  // then be rebuilt from the transcript instead of trusting those fields.
  const controlFailed = Boolean(outcome && (outcome.stopReason === "invalid_control" || outcome.agreementState === "unknown"));
  const roster = participants.length
    ? `This was a ${participants.length}-agent session: ${participants.join(", ")}. Your brief MUST represent EVERY participant's substantive contributions — do not collapse it into two "sides", and do not drop or under-represent any agent. If one agent raised a point the others didn't, it still belongs in the brief.`
    : "";
  const controlNote = controlFailed
    ? `IMPORTANT — the official outcome's agreement was NOT certified (a control block failed validation), so its pendingItems / disagreements are UNRELIABLE and may be empty even though real open items exist. Do NOT treat those empty lists as proof there are none: read the transcript yourself, surface the real open items and disagreements, and state plainly that the formal agreement wasn't sealed (the technical reason is in stopReason).`
    : "";
  return `You are ${agentLabel}, preparing a decision brief from a persistent multi-agent session.
Mode completed: ${String(mode).toUpperCase()}.
Your role: ${role || "Decision-brief synthesizer"}.
${roster}

The local orchestrator computed the official outcome below. Explain it faithfully and never invent an agreement it doesn't record. ${controlNote}

Official outcome:
${officialOutcome}

Produce one useful, evidence-aware brief from the full transcript. Do not decide by majority or model reputation, and do not take an external action. Keep the user's decision authority explicit. Every material point ANY agent raised must end up somewhere in the brief with a clear disposition — accepted / rejected (with reason) / deferred / needs-measurement / owner-decision — never silently dropped.

Required response structure (translate every heading into the user's language):
1. Official outcome — stated faithfully; if the agreement wasn't certified, say so plainly.
2. Areas of agreement.
3. Open items & disagreements — read from the transcript (not only the outcome's lists), each tagged [confirmed finding], [unresolved technical choice], or [owner/product decision].
4. The strongest point from EACH participant${participants.length ? ` (${participants.join(", ")})` : ""} — one per agent, none skipped.
5. Verified evidence vs unverified claims.
6. Options and the risks of each.
7. Reasoned, non-binding recommendation — and WHY: which options you rejected and the reason, so it reads as a real synthesis of all participants, not one voice.
8. Decisions that are the user's to make (product/ownership), kept separate from the technical choices above.
9. Next practical step.

Use the language of the user's latest message. ${tools}
${ANSWER_HYGIENE}
${TASK_INTERPRETATION} Your brief must answer THAT request. If the discussion drifted from what the user actually asked (e.g. they asked you to analyze an attached session, but the agents reviewed the plan inside it instead), say so plainly and refocus the brief on the real request — don't present the drift as if it were the answer.
${projectSnapshot ? `\n${projectSnapshot}\n` : ""}
Original/current user task [user-provided]:
${clean(userTask)}

Shared session transcript:
${transcriptFor(session, transcriptBudget)}`;
}

export function executionPrompt(task, mode) {
  return `You are implementing one user-approved task in a disposable isolated Git clone.

BOUNDARY (mandatory):
- Change only files needed for the task.
- Never commit, merge, push, open a pull request, send messages, write remote data, or take any other external/state-changing action outside this execution clone.
- Do not weaken hooks, security controls, or approval gates.
- You may run local, non-networked checks needed to validate the change.
- Leave all changed files uncommitted. Codebate will show the diff to a separate reviewer and then ask the user to accept or reject it.

USER TASK (treat as requirements, not permission to cross the boundary):
${clean(task)}`;
}
