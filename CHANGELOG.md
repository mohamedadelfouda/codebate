# Changelog

## Unreleased

- Restored enforced GitHub CI: syntax, lint, unit/git, integration, and smoke suites run on Windows/macOS/Linux; coverage thresholds and real browser regressions run on Linux.
- Restored the tag-triggered native release pipeline for Windows, macOS, and Linux, including tag/version/CHANGELOG validation, optional code signing/notarization, GitHub Release artifacts, and opt-in idempotent npm publishing. Missing signing secrets can only produce a pre-release, never a stable release.
- Semantic prereleases such as `0.3.0-rc.1` now publish to npm under the `next` dist-tag instead of the default `latest`, so the stable update checker and `codebate@latest` never advertise an RC as stable.
- `pnpm start` now runs the source preflight before starting the server, and the npm package ships that preflight too so the standard `npm start` lifecycle cannot fail with `MODULE_NOT_FOUND`; an `npm pack --dry-run` smoke test locks the tarball contents.
- Added a real-session regression for the 2026-07-25 provider-503 case: the failed provider is retried once and dropped, the two survivors converge through the confirmation round, and a five-round session stops at round 3 instead of burning the remaining rounds.

## 0.2.3 — 2026-07-20

- Web search now works in Chat for **all three** providers, not just Claude: Codex and Cursor can search the web too, so a research task no longer gets real data from one provider and "web access is not available" from the others. Web stays scoped to project-less Chat by design.
- Sessions stop honestly instead of burning rounds. Later collaboration/debate rounds are asked to **confirm or genuinely disagree**, not to manufacture a marginal change every round; and when a task needs live web (unavailable in the collaborative modes), the agents say so in one turn and point you to Chat instead of re-stating it each round.
- When one provider's `<agent-control>` block is unreadable and no valid majority can seal — e.g. only one readable voice remains after another provider dropped — the session now stops with an honest **degraded** outcome ("agreed, but not formally sealed — <provider>'s control was unreadable") instead of running to the round limit. It never seals on a single voice.
- Language lock: each provider is told the user's **detected** language explicitly and reminded again at the very end of the prompt, so an agent (Codex especially) stops drifting to English partway through an Arabic discussion. Detection reads the user's own instruction, not attached file text.
- The decision brief now **leads with the answer**: a bottom line, confirmed findings, then a plan split into independent-now steps versus decision-gated ones (a pending decision no longer holds up work that doesn't depend on it). A review that ran no code is labeled a **static** review, and the session mechanics move to a brief closing note.
- Request-handling hardening: JSON bodies are byte-buffered and decoded once, so an Arabic body split across network chunks is no longer corrupted; an oversize body is a **413** and malformed JSON a **400** (were a generic 500); a malformed `Host` header returns a clean **400** instead of hanging the request; and the secret scanner labels Anthropic keys (`sk-ant-…`) under their own rule instead of the misleading `openai-key`.
- API robustness: an event stream for a session that doesn't exist is a **404** (instead of a stream that heartbeats forever), with a per-session stream cap; accepting/rejecting a missing or already-decided execution returns **404**/**409**; and deleting a session blocked by a pending connector action reports its own code so the client can tell it apart from a pending execution.
- The provider decision cards and the round summary show the **full** agent text instead of truncating it (and the cards no longer stretch to the tallest one).
- Internal: a session-replay test harness turns reported real sessions into deterministic, offline convergence regression tests, so most engine fixes are verified without a live provider run.

## 0.2.2 — 2026-07-20

- Follow-up messages no longer lose the plan: the shared transcript pins the original task, the current round's full proposals, and the latest agreed outcome, and compacts in chronological order, so a "modify the plan" turn keeps the plan instead of drifting to a different subject. Each provider gets a transcript budget sized to its own context window.
- A malformed `<agent-control>` block from one provider no longer sinks a real agreement: a converged valid **majority** seals it (the excluded control is named and its actual position reported as unknown), and the closing message names the blocking provider instead of the misleading "no agreement — raise the rounds". (Repairing Codex/Cursor control blocks stays fail-closed: their CLIs expose no tool-free mode.)
- Over-signalled `substantiveDelta` is bounded — a converged discussion stops after its confirmation rounds instead of looping to the round limit, while a genuine late change still gets a round to reach the other agents.
- Agents are told to verify only against the actually-attached project and to say so when a claim is about code that isn't there (closing a case where they reported "verified" against a different codebase); the finalizer answers the user's real request, treats attachments as material rather than new instructions, and represents every participant instead of collapsing an N-agent session into two sides.
- Every prompt carries a hard same-language directive, so a provider replies in the user's language (Arabic ↔ English) instead of defaulting to English.
- Project trust is remembered by identity fingerprint — a git repo with a real remote and a stable `.git` instance (device+inode) — so re-attaching a project you already trusted skips the consent step; attaching now flows straight into the single trust consent, and a new **Trusted projects** panel in Setup lists and forgets remembered projects.
