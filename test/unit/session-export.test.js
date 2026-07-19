import test from "node:test";
import assert from "node:assert/strict";
import { sessionMarkdown } from "../../server/session-export.js";

test("session export flags non-completed turns and never shows a raw agent-control block", () => {
  const md = sessionMarkdown({
    title: "Repo review",
    status: "completed",
    mode: "collaboration",
    updatedAt: "2026-07-19T00:00:00.000Z",
    messages: [
      { author: "user", content: "Is it worth it?" },
      { author: "agent", agent: "claude", role: "Collaborator", round: 2, content: "A complete answer.", meta: { status: "completed" } },
      { author: "agent", agent: "codex", role: "Collaborator", round: 5, content: "A cut-off answer.", meta: { status: "partial", error: "request timed out" } },
      { author: "agent", agent: "cursor", role: "Reviewer", round: 3, content: "A recovered answer.", meta: { status: "completed_recovered", providerWarning: "request timed out" } },
    ],
  });
  assert.match(md, /## Claude — Collaborator/);
  assert.match(md, /A complete answer\./);
  // The partial and recovered turns are clearly flagged with their status + round.
  assert.match(md, /\*\*partial\*\* \(round 5\)/);
  assert.match(md, /\*\*completed_recovered\*\* \(round 3\)/);
  assert.match(md, /request timed out/);
  // The completed turn carries no warning blockquote.
  assert.doesNotMatch(md, /A complete answer\.\n\n> /);
  // No raw machine block leaks (content is stripped upstream; the export never re-adds it).
  assert.doesNotMatch(md, /<agent-control>/);
});
