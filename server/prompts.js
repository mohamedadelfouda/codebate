function clean(text) {
  return String(text ?? "").trim();
}

// Providers sometimes leak their own execution plumbing into the reader-facing answer — Cursor has written
// lines like "The shell was rejected" straight into its reply. The answer is for the user, not a log of the
// agent's tooling, so every phase forbids that narration.
const ANSWER_HYGIENE = `Your reply is the answer itself, not a report on how you produced it: never narrate tool calls, permission prompts, or CLI/shell errors (for example "the shell was rejected" or "I don't have permission to run that"). If something you would have checked isn't available, work with what you have and, where it matters, state briefly what you couldn't verify.`;

// Head+tail excerpt for text that may be huge (agent turns can reach several MB). Keeps the
// start and end — enough to identify the answer — without ever blowing the prompt window.
function boundedExcerpt(text, max) {
  const value = clean(text);
  if (value.length <= max) return value;
  const head = Math.ceil(max * 0.75);
  return `${value.slice(0, head)}\n…[truncated]…\n${value.slice(value.length - (max - head))}`;
}

export function transcriptFor(session, maxChars = 24000) {
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

  // Under delta-only middle rounds the full plan/position lives ONLY in the round-1 agent
  // turns, and a blind tail-slice would drop them (they sit at the head). So keep them as
  // verbatim "anchors" and fill the rest from the most recent tail.
  //
  // But sessions are PERSISTENT and multi-run: each new task appends another `user` turn and
  // a fresh round-1 opener to the same message list. Matching every round===1 would pin
  // stale proposals from earlier, unrelated tasks — wasting the budget on exactly the
  // full-rewrite bloat this change removes, and potentially dropping the current task. So
  // scope the anchors to the CURRENT run only: the latest `user` turn and the round-1 agent
  // turns after it.
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i -= 1) { if (msgs[i].author === "user") { lastUserIdx = i; break; } }
  const anchorIdx = [];
  if (lastUserIdx >= 0) anchorIdx.push(lastUserIdx);
  for (let i = lastUserIdx + 1; i < msgs.length; i += 1) {
    if (msgs[i].author === "agent" && msgs[i].round === 1) anchorIdx.push(i);
  }
  const anchorBudget = Math.max(0, cap - TRIM.length - SEP.length);
  const anchors = [];
  let anchorLength = 0;
  for (const index of anchorIdx) {
    const separator = anchors.length ? SEP.length : 0;
    const remaining = anchorBudget - anchorLength - separator;
    if (remaining < 1) break;
    const block = render(msgs[index], remaining);
    anchors.push(block.text);
    anchorLength += separator + block.text.length;
    if (block.truncated) break;
  }
  const anchorText = anchors.join(SEP);

  // Fill from the most recent tail, strictly AFTER the anchors so the output stays in
  // chronological order and earlier runs are dropped entirely.
  const lastAnchor = anchorIdx.length ? anchorIdx[anchorIdx.length - 1] : lastUserIdx;
  const tail = [];
  const base = [anchorText, TRIM].filter(Boolean).join(SEP);
  let tailLength = 0;
  const tailBudget = Math.max(0, cap - base.length - SEP.length);
  for (let i = msgs.length - 1; i > lastAnchor; i -= 1) {
    const separator = tail.length ? SEP.length : 0;
    const remaining = tailBudget - tailLength - separator;
    if (remaining < 1) break;
    const block = render(msgs[i], remaining);
    tail.unshift(block.text);
    tailLength += separator + block.text.length;
    if (block.truncated) break;
  }
  return [base, tail.join(SEP)].filter(Boolean).join(SEP).slice(0, cap);
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
Use convergence=converged only if you agree with the latest proposal. goalStatus describes whether the user's actual task is complete, not whether the agents agree. Set substantiveDelta=true only when your answer materially changes the proposal; that creates a newer version and prevents an early stop this round.
itemProposals are proposals, not official state. For a new item use action=create without itemId or targetItemId. For an existing open item reuse its itemId and use keep_open, resolve, or merge_into; merge_into also requires targetItemId. A user_decision requires user/provide_decision. external_validation requires user, human_operator, or orchestrator with run_external_check. disagreement and remaining_work require agent/resume_agent_round. out_of_scope requires user/provide_decision. Do not include confidence or openPoints in version 2.
When you and the other agent have genuinely landed in the same place and you're no longer materially changing the proposal, set convergence=converged and substantiveDelta=false so the session can stop early instead of repeating a round with nothing new. goalStatus reflects only whether you can complete THIS answer, not what the user might do afterward: use needs_user (with a user_decision item) only when you genuinely cannot finish your answer until the user decides or supplies missing information, and blocked (with an external_validation item) only when the answer itself cannot be settled until an outside check runs. If you have actually answered the question and the rest is just actions you're recommending the user take next, that is goalStatus=satisfied — put them in your reader-facing answer as next steps, NOT as user_decision or external_validation items. Don't fall back on goalStatus=incomplete just because the task isn't fully finished. Reserve remaining_work for real work another agent round would still add; that is the one signal that legitimately keeps the rounds going.
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

export function collaborationPrompt({ session, agentLabel, role, round, totalRounds, userTask, projectSnapshot = "", targetVersion = 1, itemRegistry = [], confirmationRound = false }) {
  const tools = projectSnapshot
    ? `You can READ the attached project (Read/Grep/Glob) to ground what you say in the real code — read only, never edit or run anything. When you make a claim about the code, point to the file (and the line when you can), and be honest about what you actually checked versus what you're inferring.`
    : `Work from what's in front of you — don't reach for tools, edit files, or run commands.`;
  // Round 1 is where you lay the whole thing out. After that it's DELTA-ONLY: say what
  // changed, not the whole plan again (re-writing it every round burns context for nothing).
  // Only the final synthesis rebuilds the complete version.
  const guidance = round === 1
    ? `Lay out your take in full this round. Talk through what's already solid in the shared work, what you'd change or add and why, the proposal as you'd shape it now, and anything you're honestly still unsure about. Write it the way you'd talk it through with a colleague you respect — in your own voice, not as a stiff numbered form.`
    : confirmationRound
      ? `This is a confirmation round: the group already landed in the same place, and a participant made a late change last round you may not have seen. Read the latest proposal and the others' most recent turn, then either confirm you're still aligned, or — only if it genuinely changes the shared decision — say plainly what has to change. Don't add optional improvements, rephrasing, or new angles.`
      : `This is a later round, so keep it to what's actually new — don't rewrite the whole plan. In a few honest lines: what you now accept from the other agent's last turn, where they're off and why, the one or two things you're really adding this round, and whatever's still open between you. If you've got nothing substantive left to add, just say so — don't pad it out.`;
  const control = round >= 2 ? `\n${controlInstruction(targetVersion, itemRegistry, confirmationRound)}\n` : "";
  return `You're ${agentLabel}, one of two agents thinking this through together in a shared session that the user runs and ultimately decides on.
Your seat at the table: ${role || "Collaborator"}.
This is round ${round}, and there's room for up to ${totalRounds} — but you're not here to fill rounds. The moment you and the other agent genuinely land in the same place, the session stops early, and that's exactly the outcome we want.

You're not competing. You're building one answer that's better than either of you would reach alone: take what's good in the other agent's work, fix what's weak, add what's missing, and move the shared solution forward. Don't just echo what's already on the table.

${guidance}
${control}
Reply in the same language the user last used. You don't literally share a session with the other model — the local orchestrator is handing you the shared transcript, so don't pretend otherwise. ${tools}
${ANSWER_HYGIENE}
${projectSnapshot ? `\n${projectSnapshot}\n` : ""}
What the user asked for [user-provided]:
${clean(userTask)}

The conversation so far:
${transcriptFor(session)}`;
}

export function chatPrompt({ session, agentLabel, role, userTask, capabilities = {}, projectSnapshot = "" }) {
  const web = capabilities.web
    ? `[capability:web=enabled]\nWeb search is available. Use it when the user asks you to verify something, requests sources, or asks about information that may have changed. Stable questions do not need a search.`
    : `[capability:web=disabled]\nWeb search is not available in this run. Never claim that you searched; state which time-sensitive facts you could not verify.`;
  const project = capabilities.projectRead && projectSnapshot
    ? `[capability:project=trusted]\nA trusted project is attached. Prefer verified project evidence for questions about that project, and distinguish verified facts from inference.\n${projectSnapshot}`
    : `[capability:project=unavailable]\nNo trusted project evidence is available in this run. Do not claim that you inspected project files.`;
  return `You are ${agentLabel}, answering the user directly in one persistent multi-agent session.
Current mode: CHAT.
Your assigned role: ${role || "Assistant"}.

This is a normal chat: answer the user's latest message directly and helpfully in your own voice. ${web} ${project} Another agent is answering the same message separately — do not coordinate with, imitate, or wait for the other agent's answer.

Answer in the same language as the user's latest message. Do not claim you directly share a provider-side session with another model; the local orchestrator is supplying the shared transcript. Do not modify files or run shell commands.
${ANSWER_HYGIENE}

Latest user message [user-provided]:
${clean(userTask)}

Shared session transcript (for context only):
${transcriptFor(session)}`;
}

export function debatePrompt({ session, agentLabel, role, opponentLabel, round, totalRounds, userTask, independent, projectSnapshot = "", targetVersion = 1, itemRegistry = [], proposition = "", confirmationRound = false }) {
  const tools = projectSnapshot
    ? `You can READ the attached project (Read/Grep/Glob) to ground your argument in the real code — read only, never edit or run anything. When you cite the code, name the file (and the line when you can), and keep what you verified separate from what you're inferring.`
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
This is round ${round}, with room for up to ${totalRounds} — but the session can stop early the moment the disagreement is genuinely resolved, so don't stretch it just to fill rounds.

${guidance}
${control}
Reply in the same language the user last used. ${tools}
${ANSWER_HYGIENE}
${projectSnapshot ? `\n${projectSnapshot}\n` : ""}
${subject}

The debate so far:
${transcriptFor(session)}`;
}

export function synthesisPrompt({ session, agentLabel, role, userTask, mode, projectSnapshot = "", outcome = null }) {
  const tools = projectSnapshot
    ? `You may READ the attached project's files (Read/Grep/Glob) to verify claims against the real code — read only, never modify files or run commands.`
    : `Do not use tools or change files.`;
  const officialOutcome = outcome ? JSON.stringify(outcome) : "No machine-readable outcome was produced.";
  return `You are ${agentLabel}, preparing a decision brief from a persistent multi-agent session.
Mode completed: ${String(mode).toUpperCase()}.
Your role: ${role || "Decision-brief synthesizer"}.

The local orchestrator has already computed and persisted the official outcome below. It is immutable for this response. Explain it faithfully; do not re-evaluate, replace, or contradict its agreement state, completion state, stop reason, pending items, or next steps. Your prose is supporting explanation and cannot change the UI status.

Official outcome:
${officialOutcome}

Produce one useful, evidence-aware brief from the full transcript. Do not decide by majority or model reputation, and do not take an external action. Keep the user's decision authority explicit. You may include a clearly labelled recommendation, but distinguish it from verified facts and from the decision only the user can make.

Required response structure (translate every heading into the user's language):
1. Official outcome
2. Areas of agreement
3. Material disagreements, only if the official outcome contains them
4. The strongest argument from each side
5. Verified evidence and unverified claims
6. Options and the risks of each
7. Reasoned, non-binding recommendation
8. Pending decisions or external checks from the official outcome
9. Next practical step

Use the language of the user's latest message. ${tools}
${ANSWER_HYGIENE}
${projectSnapshot ? `\n${projectSnapshot}\n` : ""}
Original/current user task [user-provided]:
${clean(userTask)}

Shared session transcript:
${transcriptFor(session, 30000)}`;
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
