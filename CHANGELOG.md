# Changelog

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
