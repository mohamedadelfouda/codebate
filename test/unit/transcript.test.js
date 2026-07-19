import test from "node:test";
import assert from "node:assert/strict";
import { transcriptFor } from "../../server/prompts.js";

const session = (messages) => ({ messages });

test("transcriptFor renders speakers and content", () => {
  const out = transcriptFor(session([
    { author: "user", content: "hello there", phase: "user" },
    { author: "agent", agent: "claude", role: "Collaborator", content: "hi back", phase: "collaboration", round: 1 },
  ]));
  assert.match(out, /USER/);
  assert.match(out, /hello there/);
  assert.match(out, /CLAUDE/);
  assert.match(out, /hi back/);
});

test("transcriptFor trims to maxChars, keeping the first turn and the most recent", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ author: "user", content: "x".repeat(1000) + `#${i}#` }));
  const out = transcriptFor(session(many), 5000);
  assert.ok(out.length <= 5000 + 120, `unexpected length ${out.length}`);
  assert.match(out, /trimmed/i);
  // The original task (first turn) is pinned and the most recent survives; a middle one is dropped.
  assert.match(out, /#0#/);
  assert.match(out, /#59#/);
  assert.doesNotMatch(out, /#30#/);
});

test("transcriptFor keeps the original task across a long delta session", () => {
  const msgs = [
    { author: "user", content: "TASK_PROMPT design the thing", phase: "user" },
    { author: "agent", agent: "claude", role: "Collaborator", content: "R1_PLAN " + "a".repeat(800), phase: "collaboration", round: 1 },
  ];
  for (let i = 2; i <= 40; i += 1) {
    msgs.push({ author: "agent", agent: "claude", content: `DELTA_R${i} ` + "c".repeat(500), phase: "collaboration", round: i });
  }
  msgs.push({ author: "agent", agent: "codex", content: "LATEST_DELTA_TAIL", phase: "collaboration", round: 41 });
  const out = transcriptFor(session(msgs), 6000);
  // The task (first user turn) survives even though it sits at the head, and the most recent delta survives...
  assert.match(out, /TASK_PROMPT/);
  assert.match(out, /LATEST_DELTA_TAIL/);
  // ...and the redundant middle was dropped.
  assert.match(out, /trimmed/i);
  assert.doesNotMatch(out, /DELTA_R5\b/);
});

test("transcriptFor keeps the ORIGINAL task after a follow-up, not just the latest turn", () => {
  // The exact failure that lost the plan: a long original task, a full discussion + an agreed outcome, then a
  // follow-up. A "modify the plan" turn must still see the ORIGINAL plan AND the agreed outcome — not just the
  // recent turns — instead of re-discovering (or drifting to) a different subject. Content is sized well past
  // the budget so this genuinely exercises the smart-compact path, not the fast path.
  const msgs = [
    { author: "user", content: "ORIGINAL_PLAN " + "p".repeat(1500), phase: "user" },
    { author: "agent", agent: "claude", content: "R1_FILLER " + "a".repeat(3000), phase: "collaboration", round: 1 },
    { author: "system", content: "AGREED_OUTCOME summary", phase: "decision", meta: { outcome: { agreementState: "converged" } } },
    { author: "user", content: "FOLLOWUP modify the plan", phase: "user" },
    { author: "agent", agent: "claude", content: "FOLLOWUP_R1 " + "b".repeat(600), phase: "collaboration", round: 1 },
    { author: "agent", agent: "codex", content: "LATEST_TAIL", phase: "collaboration", round: 2 },
  ];
  const out = transcriptFor(session(msgs), 3000);
  // The original plan (first turn) and the agreed outcome are pinned; the follow-up + latest survive.
  assert.match(out, /ORIGINAL_PLAN/);
  assert.match(out, /AGREED_OUTCOME/);
  assert.match(out, /FOLLOWUP/);
  assert.match(out, /LATEST_TAIL/);
  assert.match(out, /trimmed|truncated/i);
  assert.ok(out.length <= 3000, `expected <= 3000, got ${out.length}`);
});

test("transcriptFor renders a compacted transcript in chronological order", () => {
  // Regression guard: a pinned outcome sits in the MIDDLE of the session. It must NOT be hoisted to the top
  // (which would read as if the agreement preceded the discussion that produced it). Everything renders in
  // original order with the elision marked.
  const msgs = [
    { author: "user", content: "TASK_ORIGINAL " + "t".repeat(400), phase: "user" },
    { author: "agent", agent: "claude", content: "EARLY_DISCUSSION " + "e".repeat(2000), phase: "collaboration", round: 1 },
    { author: "system", content: "OUTCOME_MIDDLE agreed", phase: "decision", meta: { outcome: { agreementState: "converged" } } },
    { author: "agent", agent: "claude", content: "LATE_DISCUSSION " + "l".repeat(500), phase: "collaboration", round: 2 },
    { author: "agent", agent: "codex", content: "NEWEST_TURN", phase: "collaboration", round: 3 },
  ];
  const out = transcriptFor(session(msgs), 2000);
  const iTask = out.indexOf("TASK_ORIGINAL");
  const iOutcome = out.indexOf("OUTCOME_MIDDLE");
  const iNewest = out.indexOf("NEWEST_TURN");
  assert.ok(iTask >= 0 && iOutcome >= 0 && iNewest >= 0, "task, outcome and newest turn must all be present");
  // Chronological: task before the mid-session outcome, outcome before the newest turn.
  assert.ok(iTask < iOutcome, `original task must precede the outcome (got ${iTask} vs ${iOutcome})`);
  assert.ok(iOutcome < iNewest, `mid-session outcome must precede the newest turn (got ${iOutcome} vs ${iNewest})`);
  assert.match(out, /trimmed|truncated/i);
  assert.ok(out.length <= 2000, `expected <= 2000, got ${out.length}`);
});

test("transcriptFor preserves the round-1 proposal in a finalizer-less collaboration", () => {
  // Codex review (PR #4): with no finalizer, the full plan exists ONLY in the round-1 agent turns (later rounds
  // are delta-only, and the outcome record carries status, not the plan). A follow-up must still see the plan.
  const msgs = [
    { author: "user", content: "TASK design a radar", phase: "user" },
    { author: "agent", agent: "claude", content: "FULL_PROPOSAL_PLAN " + "p".repeat(1200), phase: "collaboration", round: 1 },
    { author: "agent", agent: "codex", content: "FULL_PROPOSAL_CODEX " + "q".repeat(1200), phase: "collaboration", round: 1 },
  ];
  for (let i = 2; i <= 30; i += 1) {
    msgs.push({ author: "agent", agent: "claude", content: `DELTA_R${i} ` + "d".repeat(400), phase: "collaboration", round: i });
  }
  const out = transcriptFor(session(msgs), 5000);
  // Both round-1 full proposals survive even though they sit near the head and the tail is long.
  assert.match(out, /FULL_PROPOSAL_PLAN/);
  assert.match(out, /FULL_PROPOSAL_CODEX/);
  assert.match(out, /TASK design a radar/);
  assert.match(out, /trimmed|truncated/i);
});

test("transcriptFor never slices the newest turn off the end, even across multiple gaps", () => {
  // Codex review (PR #4): with the task, a mid-session outcome, and a recent tail separated by 2+ gaps, every
  // trim marker must be budgeted so the final slice can't cut the newest turn. Force several distinct islands.
  const msgs = [
    { author: "system", content: "PRELUDE " + "z".repeat(300), phase: "system" },
    { author: "user", content: "TASK_HEAD " + "t".repeat(1200), phase: "user" },
    { author: "agent", agent: "claude", content: "PROPOSAL " + "p".repeat(1200), phase: "collaboration", round: 1 },
    { author: "agent", agent: "codex", content: "MID_FILLER " + "m".repeat(1200), phase: "collaboration", round: 2 },
    { author: "system", content: "OUTCOME agreed", phase: "decision", meta: { outcome: { agreementState: "converged" } } },
    { author: "agent", agent: "claude", content: "MORE_FILLER " + "f".repeat(1200), phase: "collaboration", round: 3 },
    { author: "agent", agent: "codex", content: "THE_NEWEST_TURN_MUST_SURVIVE", phase: "collaboration", round: 4 },
  ];
  const out = transcriptFor(session(msgs), 3500);
  assert.match(out, /THE_NEWEST_TURN_MUST_SURVIVE/);
  assert.match(out, /TASK_HEAD/);
  assert.ok(out.length <= 3500, `expected <= 3500, got ${out.length}`);
});

test("transcriptFor honours its ceiling even at a tiny budget", () => {
  const msgs = [
    { author: "user", content: "u".repeat(500), phase: "user" },
    { author: "agent", agent: "claude", content: "a".repeat(500), phase: "collaboration", round: 1 },
    { author: "agent", agent: "codex", content: "b".repeat(500), phase: "collaboration", round: 2 },
  ];
  // Budget is clamped up to a small floor so the marker fits; output must not blow past it.
  const floor = "[Older context was trimmed by the local orchestrator.]".length + "\n\n---\n\n".length + 40;
  const out = transcriptFor(session(msgs), 60);
  assert.ok(out.length <= floor, `expected <= ${floor}, got ${out.length}`);
  assert.match(out, /trimmed|anchor truncated/);
});

test("transcriptFor handles empty / missing messages", () => {
  assert.equal(transcriptFor(session([])), "");
  assert.equal(transcriptFor({}), "");
});
