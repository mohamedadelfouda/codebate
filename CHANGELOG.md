# Changelog

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
- A notice-only "update available" banner checks the npm registry when Setup opens (never on page load, never auto-updating) and shows `npm i -g codebate@latest` when a newer version exists.
- `npx codebate` / `codebate` CLI launcher: run the local app with one command — no clone, no Electron installer. It starts the loopback server, opens the browser, and stores sessions in `~/.codebate` (override with `CODEBATE_RUNTIME_DIR`). npm publishing is opt-in via an `NPM_TOKEN` release secret; the package is zero-dependency and ships only the runtime code (`bin`/`server`/`public`/`desktop`).
- Release discipline: a `RELEASING.md` runbook plus a tag ⇄ `package.json` ⇄ CHANGELOG consistency check (`scripts/check-release-version.mjs`) enforced in the tag-triggered build, so a tagged release cannot ship mislabeled or undocumented.
- Collaboration round-summaries now render in the reader's language. The server persists the structured discussion outcome on the message and the browser renders the wording from it, so an English reader sees an English summary and an Arabic reader an Arabic one from the same run — instead of the previously hardcoded Arabic text.
- The onboarding update control now reflects real state per agent CLI: **Update** (with the target version) when a newer release exists on the npm registry, a passive **✓ Updated** when already current, and a ticking elapsed timer while updating. Falls back to a plain Update affordance when offline.
- Sidebar, room-flow, and context columns are now drag-resizable (with a keyboard-operable splitter) and the topbar ☰/⇥/◫ buttons collapse/expand them on desktop instead of only opening mobile overlays; widths and collapse state persist. The rail brand name no longer truncates.
- A provider installed only as an npm/pnpm/bun shim (such as Codex on Windows, where PATH exposes only `.cmd`/`.ps1` shims) is now auto-detected: Codebate discovers the bundled native executable at its known package layout, verifies it runs, and trusts it automatically — no manual Trust & check for that curated path. Onboarding shows an "auto-detected" note. An explicit command override is never superseded, and an arbitrary path the user supplies still requires Trust & check.
- Trusted CLI paths from in-app Setup / Trust & check now persist across server restarts, and onboarding Setup discovers and trusts a found executable without closing the checklist dialog.
- Added in-app CLI setup: read-only discovery of native provider executables hidden behind npm/pnpm shims (such as a global Codex install on Windows), one-click Trust & check from a discovered path, and per-provider install guidance in the settings drawer and onboarding checklist.

## 0.2.1 — 2026-07-15

- Rejected `.git/commondir` redirection in execution clones so an untrusted executor cannot re-link a disposable clone to the source object store.
- Made desktop code signing optional and published unsigned tagged builds as pre-releases instead of failing the release.
- Fixed the macOS (`.zip`) and Linux (`.deb`/`.rpm`) installer builds so tagged releases produce artifacts on all three platforms.

## 0.2.0 — 2026-07-14

- Added goal-aware, proposal-versioned collaboration control blocks and neutral decision briefs.
- Added trusted shared evidence packs, capability routing, round summaries, and a user decision log.
- Moved Git commit creation to acceptance with immutable-tree secret scanning and drift checks.
- Isolated every execution in a disposable clone so rejected and packed secret objects never enter the project repository, and bound acceptance to the exact reviewed tree.
- Added a provider registry with dynamic provider/model UI.
- Added opt-in GitHub, Gmail, and Supabase connector actions with MCP proposals and explicit approval.
- Added OS-encrypted desktop connector settings and visible crash-uncertain action recovery states.
- Added Electron Forge packaging for Windows, macOS, and Linux plus native CI release builds.
- Added WCAG 2.1 AA keyboard, focus, contrast, reduced-motion, and live-region support across the desktop UI.
- Added parity-checked Arabic/English UI catalogs with localized errors, connector actions, decision states, numbers, and durations.
- Added host-brokered project/MCP tools so credentials stay in the host and project reads remain separate from web/connector calls.
- Added atomic accept/reject and connector approval state transitions, locked/CAS Git fast-forward acceptance, and crash-safe cleanup after terminal decisions.
- Added cross-kind session admission, latest-only session loading, action-specific stop controls, background startup recovery, and visible non-zero desktop startup failures.
- Bounded agent output, lines, final-response files, sessions, connector responses, Windows/POSIX process trees, and call duration.
