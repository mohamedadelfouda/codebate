# Mission Control UI — Handoff

> Archived 2026-07-16. This document records an earlier implementation handoff.
> It is not a current source of truth; see [Architecture](../ARCHITECTURE.md) and
> the live code under `public/` for current behavior.

Historical branch: `ui/mission-control` · Historical base: `main`

This document was the working handoff for the "Mission Control" UI. The
"Remaining work" section below has been superseded by **"Completion log"** at the
end — read that first. Read the rest for the binding map and design decisions.

## Goal

Make the full **Mission Control decision-room mockup** the real Codebate UI, wired to the real backend, with **no fabricated data** and **no lost functionality**.

- Mockup file (design reference, static demo, not included in the repository).
- Target surfaces: `public/index.html`, `public/styles.css`, `public/app.js`, `public/strings.js`.

## Decisions already made with the user (do not re-litigate)

1. **Full merge**: reproduce the mockup layout AND keep every existing real feature (onboarding, exec drawer, connectors, project picker, round modes). Nothing is dropped.
2. **No fabricated data**: regions the backend cannot feed yet (evidence table, risk card, per-stage timestamps) are shown as explicit **"قريباً / Coming soon"** placeholders, never fake rows.
3. **Phase is derived, not manual**: the mockup's phase switch becomes a **read-only derived indicator** from real session state.

## Binding map (mockup region → real data source)

| Mockup region | Real source |
| --- | --- |
| Phase pill (`#statusPill`) + `html[data-phase]` | Derived: `running`→collaboration, converged/idle→decision, executing/awaiting_user→execute |
| Workflow stages (`#stageList`) | Derived from session lifecycle (done/active), timestamps = "قريباً" |
| Decision agent cards (`#agentGrid`, `.dcard`) | Latest real message per agent (Claude/Codex) from `currentSession.messages` |
| Approval gate (`#approvalHost`, `.approval`) | Real execution `awaiting_user` → reuse `acceptExec`/`rejectExec` |
| Live strip (`#liveStrip`) | Real running agents via SSE (`agent_start`/`agent_activity`) |
| Context cards (goal/project/log) | Already wired in `renderContextColumn()` — keep |
| Evidence table, risk card, stage times | "قريباً" placeholders (`#evidenceSoon`) |
| Presets (Simple/Builder/Mission) | Real persisted layout-density pref → `html[data-preset]` |
| View tabs (Decision/Conversation) | Toggle `[data-view-panel]`; conversation = existing `#chat` |
| Theme toggle (`#themeBtn`) | `html[data-theme]` + localStorage |

## What the PREVIOUS session (`a4e00bd`) did

- Built the 2-zone shell (rail + main with chat + context), setup/exec drawers, all modals, and the round CRUD. **This works.**
- Wrote a **complete stylesheet** (`public/styles.css`) that already includes styles for the whole decision room: `.dcard`, `.dcard-head/-body/-empty/-foot`, `.stage`, `.stage-dot`, `.live-strip`, `.live-actor`, `.approval`, `.approval-lock`, `.view-tab`, `.gate-tag`, `.pill` with `html[data-phase]`, `.preset`, `.drawer`/`.backdrop`, presets density rules.
- **Gap (the bug to fix):** those decision-room regions were **never added to the HTML and never wired in `app.js`** (grep confirms zero references to `statusPill`, `stageList`, `dcard`, view tabs, `liveStrip`, presets, theme in `app.js`). The CSS was written ahead of the markup/JS.

## What THIS session added (already in the working tree, verified well-formed)

Edits to `public/index.html` only. a11y-markup test passes (2/2); block tags balanced.

- Topbar: `#statusPill` (phase pill), `#themeBtn`, `#presetsBtn`.
- Restructured `.session-body` → **`.workspace` 3-column grid**:
  - `aside.workflow#workflow` → `#stageList` + "قريباً" note.
  - `.main-inner#mainInner` → `.decision-bar` (`#mainHeading`, `#mainSub`, `#gateTag`) + `.view-tabs` (`#tabDecision`, `#tabConversation`) + `#decisionPanel` (`#liveStrip`, `#agentGrid`, `#approvalHost`, `#evidenceSoon`) + `#conversationPanel` (existing `#chat`).
  - `aside#contextCol` (unchanged, still populated by `renderContextColumn`).
- Presets drawer `#presetsDrawer` + `#backdrop` (buttons `#closePresets`, `#closePresets2`, `.preset[data-preset]`).

**These new controls are currently INERT** — the JS to wire them is not written yet. That is the remaining work.

## Remaining work (do this, in order)

### 1. CSS (`public/styles.css`) — small
- Add `.main-inner { min-width:0; min-height:0; overflow:auto; display:grid; gap:10px; align-content:start; padding:12px; }`.
- Add `[data-view-panel][hidden]{display:none!important}` and give `#decisionPanel`/`#conversationPanel` `display:grid; gap:10px`.
- Verify `.session-view` padding does not double-inset the full-bleed `.workflow`/`.context-col` columns; likely move padding off `.session-view` and onto `.main-inner`/`.decision-bar`. **Test visually.**

### 2. `public/app.js` — the core wiring
Add and hook these (reuse existing helpers `t`, `esc`, `bdi`, `providerInfo`, `phaseLabel`):
- `derivePhase(session)` → `"collaboration" | "decision" | "execute"` and `applyPhase()` sets `document.documentElement.dataset.phase`, `#statusPill` text, `#mainHeading/#mainSub`, `#gateTag` visibility.
- `renderStages()` → build `#stageList` buttons (Plan/Collab/Decision/Execute/Review/Accept) with `.is-done/.is-active` from derived phase. No timestamps (coming soon).
- `renderDecisionCards()` → for each provider, latest agent message → `.dcard` in `#agentGrid`; empty → `.dcard-empty`.
- `renderApprovalGate()` → if an execution is `awaiting_user`, render `.approval` into `#approvalHost` with buttons calling existing `acceptExec(taskId, 'merge'|'pr')` / `rejectExec(taskId)`. Otherwise empty (executions still render in `#chat` via `renderExecutions`).
- `setView(view)` → toggle `[data-view-panel]` `hidden` + `aria-selected` on `#tabDecision/#tabConversation`. Default: `decision`.
- `setPreset(id)` / theme toggle → `dataset.preset`/`dataset.theme` + localStorage (mirror `applyShellChrome`).
- Live strip: in `handleEvent` `agent_start`/`agent_activity`/`agent_complete`, update `#liveStrip` (show while running, hide when idle).
- **Call `applyPhase()` + `renderStages()` + `renderDecisionCards()` + `renderApprovalGate()` from inside `renderMessages()`** (already the single re-render point) and on `loadSession()`.
- Wire new buttons in the "wiring" section: `#themeBtn`, `#presetsBtn`/`#closePresets`/`#closePresets2`/`#backdrop`, `.preset`, `.view-tab`, and add theme/preset load in `initialize()`.

### 3. `public/strings.js` — i18n (AR + EN, MUST stay at parity)
Add keys used by the new markup (both languages): `theme`, `customize`, `customizeSub`, `close`, `done`, `workflowNav`, `workflow`, `stageTimesSoon`, `gateTag`, `viewTabs`, `tabDecision`, `tabConversation`, `evidence`, `soon`, `evidenceSoon`, `presetSimple`, `presetSimpleDesc`, `presetBuilder`, `presetBuilderDesc`, `presetMission`, `presetMissionDesc`, plus stage labels (`stagePlan`, `stageCollab`, `stageDecision`, `stageExecute`, `stageReview`, `stageAccept`) and approval-gate copy. `test/unit/i18n.test.js` enforces AR/EN key parity — run it.

## Guardrails (non-negotiable)

- **Preserve every existing element ID and flow** in `app.js` (SSE, execution accept/reject, connectors, onboarding, project picker, focus-trapped modals). Do not rename IDs the JS depends on.
- **AR/EN RTL parity** and **WCAG 2.1 AA** (every control labeled; the a11y-markup + i18n tests must pass).
- **Security model unchanged** — this is a frontend-only change; do not touch the server auth/exec/connector contracts.
- **Review gate before any push**: follow `.review-gate/GATE.md` (spawn `code-reviewer` + `security-reviewer`, run `clean-code`/`i18n`/`accessibility` reviewers, then `attest`). Needs network for the review agents.
- **Verify**: `npm run check` + `npm test` (196 tests) must stay green; then run the app and screenshot the three phases before calling it done.

## Quick verify commands

```bash
npm run check                                   # syntax (offline)
npm test                                        # full suite incl. a11y + i18n parity (offline)
node --test test/unit/accessibility-markup.test.js
node --test test/unit/i18n.test.js
```

---

## Completion log (JS wiring session)

All the "Remaining work" above is done. Summary of what landed:

### Wiring (`public/app.js`)
- `derivePhase()` + `applyPhase()` — read-only phase (`collaboration` / `decision`
  / `execute`) derived from real session state; drives `html[data-phase]`,
  `#statusPill`, `#mainHeading`/`#mainSub`, and `#gateTag`.
- `renderStages()` — read-only stage tracker (`role="list"`, `aria-current="step"`
  on the active step). No timestamps (still "coming soon").
- `renderDecisionCards()` — latest real message per enabled provider → `.dcard`;
  empty → `.dcard-empty`.
- `renderApprovalGate()` — real `awaiting_user` execution → `.approval` reusing
  `acceptExec`/`rejectExec`.
- `renderLiveStrip()` — running agents from SSE (`agent_start`/`agent_activity`/
  `agent_complete`, cleared on run/exec end).
- `renderDecisionRoom()` is called from `renderMessages()` (the single re-render
  point), so it tracks every session load and SSE update.
- Theme toggle (`html[data-theme]`), presets (`html[data-preset]`, persisted),
  view tabs (Decision/Conversation), presets drawer — all persisted to
  `localStorage` and wired in `initialize()`.

### Shell layout fix (`public/styles.css`)
The previous shell commit left the CSS written for an `.app` > `.sessions`
structure while the HTML uses `.shell` > `.rail` + `.main` — so the rail rendered
as a 52px-tall bar stacked on top of the main column (not a sidebar), and the
shell never filled the viewport. Fixed: `.shell` is now the 2-column grid
(`--rail-w` | main, full height), `.rail` carries the 5-row template, and
`.main`/`.session-view` give the 3-column workspace a proper fill height with
per-column scroll. Dead `.app`/`.sessions` rules removed. Plus the CSS from
"Remaining work §1" (`.main-inner`, panel display, padding moved off
`.session-view`).

### i18n (`public/strings.js`)
Added AR+EN (parity test green): `roomPhase*`, `roomHeading*`, `roomSub*`,
`stagePlan/Collab/Decision/Execute/Review/Accept`, `dcardEmpty`,
`approvalGateSummary`.

### Verification
- `npm run check` + `npm test` → **199/199 green**.
- Ran the app and verified live (Browser pane, JS-measured — screenshots time out
  in this env): shell renders as sidebar+main in both RTL and LTR with no
  horizontal overflow; decision phase pill/heading/stages/cards render; view-tab
  switch, theme toggle, preset density, and the presets drawer all work.
- Review gate: `code-reviewer` + `security-reviewer` + `accessibility-reviewer`
  + `i18n-reviewer` + `clean-code-guard`. Security: clean. Fixed every finding I
  introduced: presets drawer now uses the managed-modal focus trap
  (`role="dialog"`, `aria-modal`, `appShell` inert), view tabs got roving-tabindex
  + arrow-key nav, `#statusPill` got `aria-live="polite"`, light-theme `--faint`
  raised to AA contrast, and an `evidenceSoon` HTML/catalog text drift fixed.

### Resolved by the convergence stabilization
- `renderContextColumn()` now reads the persisted deterministic outcome and maps
  agreement, completion, stop reason, pending categories, and next steps through
  the Arabic and English catalogs. Legacy sessions keep their existing report
  fallback, so raw new-state enums no longer appear in the Arabic card.

### Known pre-existing issues (NOT from this wiring — tracked separately)
- `handleAttachFiles()` cumulative-size guard sums UTF-16 char length against a
  byte limit, so multibyte text can exceed the 300 KB cap.
- `loadSession()` doesn't re-sync `#attachBtn` disabled state the way `setRunning`
  does (attach stays enabled on a running session opened fresh).

### Design polish (follow-up round)
User design review produced four fixes: (1) rail brand header — CSS selectors
renamed to match the actual HTML (`.brand-mark`/`.brand-name`), fixing the
cramped/overlapping header and the broken collapsed-rail state; (2) `.topbar-actions`
now flex + `nowrap` (with `overflow-x` safety) so the topbar stays one line and the
setup summary truncates; (3) **stage timestamps wired** — `renderStages()` shows
per-stage clock times derived from real events (first agent message, final-report
message, execution `createdAt`/`decidedAt`); Plan/Review stay blank (no honest
source), and the "coming soon" note is gone; (4) an empty-state for the context
column when a session has no cards yet. Re-reviewed (code/a11y/i18n), findings
fixed (active-stage time contrast, reflow safety, dedup helper). Evidence table
(#5) intentionally deferred — it needs a backend data source, not just wiring.

### Design polish (round 2)
Second design-review pass: (1) **Plan phase** — `derivePhase()` now returns `plan`
(new stage-0 phase + `roomPhasePlan/Heading/Sub` i18n + neutral pill dot) for a
fresh session with no agent replies, instead of wrongly showing it stuck on
Decision. (2) **Rail brand** — `.brand { min-width:0; overflow:hidden }` fixed the
315px-over-272px overflow that pushed the language toggle outside the rail and
made it unclickable. (3) **Topbar titles** — session title + meta now sit on one
line (flex row, title ellipsis, meta truncates). (4) **Evidence panel REMOVED**
from the UI (markup + `evidence/soon/evidenceSoon` keys + `.panel*`/`.soon-badge`
CSS) — it is **deferred to a backend feature**, tracked as a follow-up task, since
the earlier `#evidenceSoon`/"قريباً" placeholder (referenced in the binding map
and "What THIS session added" sections above) has no real data source yet.
Re-reviewed (code/a11y/i18n); fixed `#sessionMeta` overflow at narrow widths.

### Follow-up features (deferred, tracked as tasks — not bugs)
- **Evidence table** — needs a backend "evidence" concept in the orchestration
  engine before it can be rendered honestly; removed from the UI for now.
- **Session folders** — custom named groups for sessions (today grouping is only
  by date/project).
- Rename/delete session already exists (session ⋯ menu → `renameSession`/`deleteSession`).
