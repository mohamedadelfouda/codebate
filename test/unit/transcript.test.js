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

test("transcriptFor trims to maxChars and flags it", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ author: "user", content: "x".repeat(1000) + `#${i}#` }));
  const out = transcriptFor(session(many), 5000);
  // Trimmed output is the tail plus a short prefix marker.
  assert.ok(out.length <= 5000 + 120, `unexpected length ${out.length}`);
  assert.match(out, /trimmed/i);
  // The most recent message must survive; the oldest must be gone.
  assert.match(out, /#59#/);
  assert.doesNotMatch(out, /#0#/);
});

test("transcriptFor preserves round-1 anchors when trimming a long delta session", () => {
  // A realistic run: a user prompt, two round-1 full plans, then many delta rounds.
  const msgs = [
    { author: "user", content: "TASK_PROMPT design the thing", phase: "user" },
    { author: "agent", agent: "claude", role: "Collaborator", content: "FULL_PLAN_ANCHOR " + "a".repeat(800), phase: "collaboration", round: 1 },
    { author: "agent", agent: "codex", role: "Collaborator", content: "FULL_PLAN_CODEX " + "b".repeat(800), phase: "collaboration", round: 1 },
  ];
  for (let i = 2; i <= 40; i += 1) {
    msgs.push({ author: "agent", agent: "claude", content: `DELTA_R${i} ` + "c".repeat(500), phase: "collaboration", round: i });
  }
  msgs.push({ author: "agent", agent: "codex", content: "LATEST_DELTA_TAIL", phase: "collaboration", round: 41 });
  const out = transcriptFor(session(msgs), 6000);
  // The current task's prompt and both round-1 full plans survive even though they sit at the head...
  assert.match(out, /TASK_PROMPT/);
  assert.match(out, /FULL_PLAN_ANCHOR/);
  assert.match(out, /FULL_PLAN_CODEX/);
  // ...the most recent delta survives...
  assert.match(out, /LATEST_DELTA_TAIL/);
  // ...and the redundant middle was dropped.
  assert.match(out, /trimmed/i);
  assert.doesNotMatch(out, /DELTA_R5\b/);
});

test("transcriptFor scopes anchors to the current run, not stale earlier tasks", () => {
  // Persistent session: an unrelated prior task X, then the current task Y in the same list.
  const msgs = [
    { author: "user", content: "TASK_X unrelated old question", phase: "user" },
    { author: "agent", agent: "claude", content: "X_ROUND1_CLAUDE " + "a".repeat(1200), phase: "collaboration", round: 1 },
    { author: "agent", agent: "codex", content: "X_ROUND1_CODEX " + "b".repeat(1200), phase: "collaboration", round: 1 },
    { author: "agent", agent: "claude", content: "X_R2 " + "c".repeat(1200), phase: "collaboration", round: 2 },
    { author: "user", content: "TASK_Y the current question", phase: "user" },
    { author: "agent", agent: "claude", content: "Y_ROUND1_CLAUDE " + "d".repeat(600), phase: "collaboration", round: 1 },
    { author: "agent", agent: "codex", content: "Y_ROUND1_CODEX " + "e".repeat(600), phase: "collaboration", round: 1 },
    { author: "agent", agent: "codex", content: "Y_LATEST_TAIL", phase: "collaboration", round: 2 },
  ];
  const out = transcriptFor(session(msgs), 4000);
  // Current task Y's prompt and round-1 plans are kept...
  assert.match(out, /TASK_Y/);
  assert.match(out, /Y_ROUND1_CLAUDE/);
  assert.match(out, /Y_ROUND1_CODEX/);
  assert.match(out, /Y_LATEST_TAIL/);
  // ...stale prior-task round-1 proposals are NOT pinned.
  assert.doesNotMatch(out, /X_ROUND1_CLAUDE/);
  assert.doesNotMatch(out, /X_ROUND1_CODEX/);
  // Hard ceiling holds.
  assert.ok(out.length <= 4000, `expected <= 4000, got ${out.length}`);
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
