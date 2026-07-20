import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chatPrompt,
  collaborationPrompt,
  controlRepairPrompt,
  debatePrompt,
  executionPrompt,
  synthesisPrompt,
  transcriptFor,
} from "../../server/prompts.js";

const session = { messages: [] };
const base = { session, agentLabel: "Claude", role: "Collaborator", totalRounds: 5, userTask: "design X" };

function assertControlContract(prompt, targetVersion) {
  assert.match(prompt, /<agent-control>/);
  assert.match(prompt, /<\/agent-control>/);
  assert.match(prompt, new RegExp(`"targetVersion":${targetVersion}`));
  assert.match(prompt, /"controlVersion":2/);
  assert.match(prompt, /"goalStatus"/);
  assert.match(prompt, /"substantiveDelta"/);
  assert.match(prompt, /"itemProposals"/);
  assert.doesNotMatch(prompt, /"confidence":/);
  assert.doesNotMatch(prompt, /"openPoints":/);
  assert.match(prompt, /write anything after it/i);
}

test("collaboration opening requests a full proposal without a control block", () => {
  const prompt = collaborationPrompt({ ...base, round: 1 });
  assert.match(prompt, /design X/);
  assert.doesNotMatch(prompt, /<agent-control>/);
});

test("collaboration roster names the other participants and matches the count", () => {
  // Three-way session: the acting agent must be told about EACH of the other two by name.
  const threeWay = collaborationPrompt({ ...base, round: 1, participants: ["Claude", "Codex", "Cursor"] });
  assert.match(threeWay, /Codex/);
  assert.match(threeWay, /Cursor/);
  assert.match(threeWay, /one of 3 agents/);
  assert.match(threeWay, /3-way discussion/);

  // Two-way session (the common case): singular framing, and NOT the self-contradictory "don't collapse into
  // two sides" line that only makes sense with three or more.
  const twoWay = collaborationPrompt({ ...base, round: 1, participants: ["Claude", "Codex"] });
  assert.match(twoWay, /The other agent at the table is Codex/);
  assert.match(twoWay, /one of 2 agents/);
  assert.doesNotMatch(twoWay, /-way discussion/);
});

test("later collaboration rounds request a versioned control contract", () => {
  const prompt = collaborationPrompt({
    ...base,
    round: 3,
    targetVersion: 7,
    itemRegistry: [{
      itemId: "item-001",
      kind: "user_decision",
      status: "open",
      text: "Choose the rollout",
      requiredStep: { actor: "user", action: "provide_decision" },
    }],
  });
  assertControlContract(prompt, 7);
  assert.match(prompt, /item-001/);
  assert.match(prompt, /review every open item/i);
  assert.match(prompt, /reuse its existing itemId/i);
  assert.match(prompt, /resolve or merge_into/i);
  assert.match(prompt, /omission.*prevents/i);
  assert.match(prompt, /do not create a new item/i);
});

test("the control instruction discourages substantiveDelta over-signalling", () => {
  const prompt = collaborationPrompt({ ...base, round: 3, targetVersion: 2 });
  assert.match(prompt, /substantiveDelta=true ONLY when/);
  assert.match(prompt, /forces another paid round/);
  assert.match(prompt, /rephrasing, re-emphasis/);
});

test("a confirmation round adds a tightened instruction only when flagged", () => {
  const normal = collaborationPrompt({ ...base, round: 3, targetVersion: 2 });
  assert.doesNotMatch(normal, /CONFIRMATION ROUND/);

  const confirming = collaborationPrompt({ ...base, round: 3, targetVersion: 2, confirmationRound: true });
  assert.match(confirming, /CONFIRMATION ROUND/);
  assert.match(confirming, /do not add optional improvements/i);
  assert.match(confirming, /substantiveDelta=false/);
  assertControlContract(confirming, 2); // still a valid control contract
});

test("the control instruction separates needs_user from post-answer next steps", () => {
  const prompt = collaborationPrompt({ ...base, round: 3, targetVersion: 2 });
  assert.match(prompt, /goalStatus reflects only whether you can complete THIS answer/);
  assert.match(prompt, /needs_user \(with a user_decision item\) only when you genuinely cannot finish/);
  assert.match(prompt, /recommending the user take next, that is goalStatus=satisfied/);
  assert.match(prompt, /NOT as user_decision or external_validation items/);
});

test("control repair requests one control block without a second reader-facing answer", () => {
  const prompt = controlRepairPrompt({
    agentLabel: "Claude",
    role: "Collaborator",
    priorAnswer: "We agreed that the rollout choice is resolved.",
    targetVersion: 7,
    itemRegistry: [{
      itemId: "item-001",
      kind: "user_decision",
      status: "open",
      text: "Choose the rollout",
      requiredStep: { actor: "user", action: "provide_decision" },
    }],
    problems: [{ errorCodes: ["unaddressed_open_item"], itemIds: ["item-001"] }],
  });

  assertControlContract(prompt, 7);
  assert.match(prompt, /unaddressed_open_item/);
  assert.match(prompt, /item-001/);
  assert.match(prompt, /control repair/i);
  assert.match(prompt, /do not rewrite.*reader-facing answer/i);
  assert.match(prompt, /exactly one <agent-control>/i);
  assert.match(prompt, /missing or malformed.*every open registry item/i);
});

test("project grounding appears only when a snapshot is supplied", () => {
  const withoutProject = collaborationPrompt({ ...base, round: 1 });
  const withProject = collaborationPrompt({ ...base, round: 1, projectSnapshot: "PROJECT_TREE_SENTINEL" });
  assert.doesNotMatch(withoutProject, /PROJECT_TREE_SENTINEL/);
  assert.match(withProject, /PROJECT_TREE_SENTINEL/);
});

test("a project-backed prompt forbids claiming verification against code not in the attached project", () => {
  // Grounding integrity: agents hallucinated "verifying" a different codebase against the attached repo.
  const withProject = collaborationPrompt({ ...base, round: 1, projectSnapshot: "TREE" });
  assert.match(withProject, /THIS attached project/);
  assert.match(withProject, /can't verify/i);
  // Without a project there's no verification boundary to assert.
  assert.doesNotMatch(collaborationPrompt({ ...base, round: 1 }), /THIS attached project/);
  // The finalizer gets the same boundary.
  const synth = synthesisPrompt({ ...base, mode: "collaboration", projectSnapshot: "TREE" });
  assert.match(synth, /UNVERIFIED|list those claims as/);
});

test("every task-bearing prompt frames attachments as material, not new instructions", () => {
  // Task-interpretation: an attached document/session must not become "the task" (the finalizer produced a
  // brief about a plan inside an attachment instead of the analysis the user asked for).
  for (const prompt of [
    collaborationPrompt({ ...base, round: 1 }),
    debatePrompt({ ...base, opponentLabel: "Codex", round: 1, independent: true }),
    synthesisPrompt({ ...base, mode: "collaboration" }),
  ]) {
    assert.match(prompt, /\[Attached files\]/);
    // Analysis-request vs explicit-delegation are distinguished (an attachment isn't always "the task").
    assert.match(prompt, /explicitly delegated/);
  }
  // The finalizer additionally refocuses on the user's actual request if the discussion drifted.
  assert.match(synthesisPrompt({ ...base, mode: "collaboration" }), /drifted/);
});

test("round-bearing prompts mark the orchestrator's round as authoritative but keep a completed prior run", () => {
  // Resume: an INTERRUPTED run leaves stale "rounds completed" text; the agent trusts the given round. But a
  // prior run that finished normally is still valid follow-up context and must not be discarded.
  const collab = collaborationPrompt({ ...base, round: 3, targetVersion: 2 });
  const debate = debatePrompt({ ...base, opponentLabel: "Codex", round: 3, independent: false, targetVersion: 2 });
  assert.match(collab, /round 3 of THIS run/);
  assert.match(collab, /interrupted and resumed/i);
  assert.match(collab, /finished normally is still valid context/i);
  assert.match(debate, /interrupted and resumed/i);
});

test("every prompt carries a hard same-language directive (D1)", () => {
  // Cursor kept replying in English inside an Arabic conversation; the directive must be emphatic in every mode.
  const prompts = [
    collaborationPrompt({ ...base, round: 1 }),
    collaborationPrompt({ ...base, round: 3, targetVersion: 2 }),
    chatPrompt({ ...base }),
    debatePrompt({ ...base, opponentLabel: "Codex", round: 1, independent: true }),
    debatePrompt({ ...base, opponentLabel: "Codex", round: 3, independent: false, targetVersion: 2 }),
    synthesisPrompt({ ...base, mode: "debate" }),
  ];
  for (const prompt of prompts) {
    assert.match(prompt, /SAME LANGUAGE as the user's latest message/);
    assert.match(prompt, /hard requirement/);
  }
});

test("every phase forbids narrating tool usage or CLI errors in the reader-facing answer (H9)", () => {
  const prompts = {
    "collaboration opening": collaborationPrompt({ ...base, round: 1 }),
    "collaboration round": collaborationPrompt({ ...base, round: 3, targetVersion: 2 }),
    chat: chatPrompt({ ...base }),
    "debate opening": debatePrompt({ ...base, opponentLabel: "Codex", round: 1, independent: true }),
    "debate round": debatePrompt({ ...base, opponentLabel: "Codex", round: 3, independent: false, targetVersion: 2 }),
    synthesis: synthesisPrompt({ ...base, mode: "debate" }),
  };
  for (const [label, prompt] of Object.entries(prompts)) {
    assert.match(prompt, /never narrate tool calls, permission prompts, or CLI\/shell errors/, label);
    assert.match(prompt, /the shell was rejected/, label);
  }
});

test("debate opening is independent and has no convergence control", () => {
  const prompt = debatePrompt({ ...base, opponentLabel: "Codex", round: 1, independent: true });
  assert.match(prompt, /Codex/);
  assert.match(prompt, /design X/);
  assert.doesNotMatch(prompt, /<agent-control>/);
});

test("a debate confirmation round reaffirms agreement instead of rebutting", () => {
  const rebuttal = debatePrompt({ ...base, opponentLabel: "Codex", round: 3, independent: false, targetVersion: 2 });
  assert.match(rebuttal, /go straight at the strongest opposing point/);
  assert.doesNotMatch(rebuttal, /CONFIRMATION ROUND/);

  const confirming = debatePrompt({ ...base, opponentLabel: "Codex", round: 3, independent: false, targetVersion: 2, confirmationRound: true });
  assert.match(confirming, /This is a confirmation round/);
  assert.doesNotMatch(confirming, /go straight at the strongest opposing point/);
  assert.match(confirming, /CONFIRMATION ROUND/); // the control instruction is tightened too
  assertControlContract(confirming, 2);
});

test("debate rebuttal uses the same versioned control contract", () => {
  const prompt = debatePrompt({ ...base, opponentLabel: "Codex", round: 2, independent: false, targetVersion: 4 });
  assertControlContract(prompt, 4);
});

test("a debate opened on a prior answer debates that answer, not the switch message", () => {
  const prompt = debatePrompt({
    ...base,
    opponentLabel: "Codex",
    round: 1,
    independent: true,
    userTask: "let's debate this",
    proposition: "We should ship the mini-eval before adding any provider.",
  });
  assert.match(prompt, /What to debate/);
  assert.match(prompt, /We should ship the mini-eval before adding any provider\./);
  assert.match(prompt, /treat it as the trigger/i);
  assert.match(prompt, /let's debate this/); // the switch message survives, but as the trigger
  assert.doesNotMatch(prompt, /The question on the table/);
});

test("a debate with no prior answer falls back to the user's message as the question", () => {
  const prompt = debatePrompt({ ...base, opponentLabel: "Codex", round: 1, independent: true, userTask: "Postgres or Mongo?" });
  assert.match(prompt, /The question on the table/);
  assert.match(prompt, /Postgres or Mongo\?/);
  assert.doesNotMatch(prompt, /What to debate/);
});

test("a rebuttal carries both the anchored proposition and the versioned control contract", () => {
  const prompt = debatePrompt({ ...base, opponentLabel: "Codex", round: 2, independent: false, targetVersion: 3, proposition: "Ship the mini-eval before adding a provider." });
  assert.match(prompt, /What to debate/);
  assert.match(prompt, /Ship the mini-eval before adding a provider\./);
  assertControlContract(prompt, 3);
});

test("controlRepairPrompt bounds a huge prior answer to a head+tail excerpt", () => {
  const huge = `HEAD_MARKER ${"x".repeat(60000)} TAIL_MARKER`;
  const prompt = controlRepairPrompt({ agentLabel: "Claude", priorAnswer: huge, targetVersion: 2 });
  assert.ok(prompt.length < 10000, `expected a bounded prompt, got ${prompt.length} chars`);
  assert.match(prompt, /HEAD_MARKER/);   // start preserved
  assert.match(prompt, /TAIL_MARKER/);   // end preserved
  assert.match(prompt, /\[truncated\]/); // middle elided
  assertControlContract(prompt, 2);      // still carries the versioned control contract
});

test("synthesis receives an immutable official outcome to explain", () => {
  const prompt = synthesisPrompt({
    ...base,
    mode: "collaboration",
    outcome: {
      agreementState: "converged",
      completionState: "needs_user",
      stopReason: "user_decision",
      pendingItems: [{ itemId: "item-001", text: "Choose a mode" }],
      nextSteps: [{ actor: "user", action: "provide_decision", itemIds: ["item-001"] }],
    },
  });
  assert.match(prompt, /official outcome/i);
  assert.match(prompt, /"completionState":"needs_user"/);
});

test("chat describes only capabilities that are actually available", () => {
  const offline = chatPrompt({ ...base, capabilities: { web: false }, projectSnapshot: "" });
  assert.match(offline, /\[capability:web=disabled\]/);
  assert.match(offline, /\[capability:project=unavailable\]/);
  assert.doesNotMatch(offline, /PROJECT_EVIDENCE/);

  const grounded = chatPrompt({ ...base, capabilities: { web: true, projectRead: true }, projectSnapshot: "PROJECT_EVIDENCE" });
  assert.match(grounded, /\[capability:web=enabled\]/);
  assert.match(grounded, /\[capability:project=trusted\]/);
  assert.match(grounded, /PROJECT_EVIDENCE/);
});

test("execution prompt preserves the user task inside explicit boundary sections", () => {
  const prompt = executionPrompt("fix the parser", "run");
  assert.match(prompt, /fix the parser/);
  assert.match(prompt, /BOUNDARY \(mandatory\):/);
  assert.match(prompt, /USER TASK \(treat as requirements/);
});

test("transcript headers stay inside the requested context budget", () => {
  const maxChars = 128;
  const transcript = transcriptFor({
    messages: [{ author: "agent", agent: "x".repeat(500), role: "y".repeat(500), content: "" }],
  }, maxChars);
  assert.ok(transcript.length <= maxChars, `transcript length ${transcript.length} exceeded ${maxChars}`);
});
