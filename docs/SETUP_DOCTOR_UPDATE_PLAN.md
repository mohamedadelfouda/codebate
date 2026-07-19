# Setup Doctor + Update Notify — Implementation Plan

> **Status:** Draft (for review)
> **Date:** 2026-07-16
> **Provenance:** Drafted by Claude, adversarially cross-reviewed by GPT over
> several rounds, and verified against the branch code. The cross-review caught
> an auto-install mistake, a Trust & Check ordering bug, and drove the
> dimensional readiness model, the setup-vs-session capability split, and the
> TOCTOU hardening below.
> **Implementation:** to be done on dedicated `feat/` branches off `main`
> (**not** the token-efficiency branch). This PR contains the **plan only**.

---

## 1. Goal

Lower the **activation cost** of Codebate and let users learn about updates —
without taking on Mac/Linux/desktop packaging.

The project's real risk is **distribution, not quality**. Today the wall is:
"install Node + two CLIs + Git + sign in to both, or the tool refuses to run."
This plan turns a dead-end first run into a screen that says exactly what's
missing and how to fix it.

---

## 2. Settled decisions (context for reviewers)

1. **Install is guidance-only, never executed.** Encoded in
   [`registry.js`](../server/providers/registry.js) (_"Install guidance only —
   never executed by Codebate"_). Installers are `curl|bash` / `irm|iex`;
   running them from inside the tool is an RCE-shaped risk. The Doctor
   **guides + detects + re-checks**, never runs an installer.
2. **Single-agent is not a mode.** Codebate's value is two models
   cross-checking; a genuinely single-subscription user is not the target. A
   single-agent path stays a **fallback** only (a provider dies mid-run →
   degrade instead of crash) — a **separate follow-up, out of scope here**.
3. **Target segment:** "has two subscriptions but installed only one CLI." Their
   pain is **installation/discovery**, not subscription.

---

## 3. Scope

| In ✅ | Out ❌ |
|---|---|
| Source preflight (Node check + Git warning) | Auto-installing anything (incl. `node_modules`) |
| Persistent Setup Doctor (evolve existing onboarding) | Single-agent as a mode (fallback = separate follow-up) |
| Update-notify for Codebate itself | Mac/Linux/desktop packaging (Electron makers stay closed) |
| Discover PATH-hidden CLIs + transactional Trust & Check | Auto `git pull` |

---

## 4. Corrected understanding of current behavior (verified)

- **No runtime dependencies.** Every `server/**` import is a `node:*` built-in;
  `package.json` has only `devDependencies`. `node server/index.js` runs
  **without `node_modules`**. → **Never run `pnpm install` on the user path** —
  it would pull dev/packaging tooling and *raise* activation cost.
- **Gating is per selected participant, not global.**
  [`validateOrchestrationRequest`](../server/orchestrator.js) resolves the
  selected participants for the mode, then
  [`assertProvidersReady(selected)`](../server/index.js) checks those. The
  discussion modes need ≥2 participants (debate exactly 2), so a one-CLI user
  can't start a full discussion — but the cause is the participant requirement,
  not a global "any provider missing" reject.
- **Onboarding UI already exists.** [`public/app.js`](../public/app.js) already
  has provider status, setup buttons, CLI discovery, Trust & Check, and a
  provider-update button. → **Evolve it; do not build a parallel modal/drawer.**
- **Trust & Check has an ordering bug.** [`/api/cli/check`](../server/index.js)
  persists trust (`approveProviderCommand`) **before** validating
  (`checkCommand`). Trust can survive a failed check (see §9).

---

## 5. Design principles (make it reusable from day one)

The readiness core is written so the web UI, a future `codebate doctor`, an
`npx` launcher, and diagnostics all share **one source of truth**.

- **Readiness is pure functions, not endpoint-bound:** `getSetupStatus()`,
  `probeProviderCandidate()`, `trustProviderCandidate()`,
  `deriveSetupCapabilities()`. The API calls them; a future CLI
  (`codebate doctor` / `--json`) calls the same functions.
- **No DOM in state logic.** The server/module computes; the UI only renders.
- **Carry `installationType`** (`git|zip|npm|desktop|development`) so Update
  Notify can behave correctly per install method later.

> These are constraints to honor now so the terminal path stays *possible* — not
> a mandate to build the CLI in this effort.

---

## 6. Work breakdown (PRs, priority order)

### PR1 — Readiness contract (backend)

- Pure functions (§5), dimensional provider state (§7), setup-vs-session
  capabilities (§8), transactional + TOCTOU-safe Trust & Check (§9).
- `GET /api/setup/status` — **local only, no network**.
- Reuse `providerReadiness`, `discoverProviderCommands`, `provider.install`,
  `checkCommand`.
- Unit tests (§10).

### PR2 — Setup Doctor UI

- **Evolve the existing onboarding** in [`public/app.js`](../public/app.js);
  reuse the existing Setup Drawer, do not duplicate.
- Auto-open on first run only when something is missing; stays reachable from a
  status indicator; keeps last-check state + timestamp.
- Per provider: derived chip + version; `missing` → install command (copy) +
  docs + [Re-check]; `discovered` + `untrusted` → found path + [Verify & trust].
- Update consent lives as a **small section inside the Doctor**, not a competing
  modal (see §PR4).
- Locked-mode framing: "Debate & cross-review unlock when both providers are
  ready 🔒". All strings via [`strings.js`](../public/strings.js) (AR + EN).
- Accessibility: focus trap, Escape close, focus return. Browser tests.

### PR3 — Source preflight

- Shell wrappers keep only the **Node presence + version ≥22** check, then chain
  — the preflight **does not spawn the server**:
  ```
  node scripts/source-preflight.mjs && node server/index.js
  ```
  (so signals/exit codes stay direct and the preflight stays a pure check).
- `scripts/source-preflight.mjs`: checks Git, prints one **terse** warning,
  detects platform/arch, returns a clear exit code, **installs nothing**.
  Details + install links live in the Doctor, not duplicated in the terminal.
- Contributor path (`corepack enable && pnpm install --frozen-lockfile`) goes in
  [`CONTRIBUTING.md`](../CONTRIBUTING.md), not the user run path.

### PR4 — Update notify

- **Separate** `GET /api/update-status` (opening the Doctor never triggers a
  network call without consent).
- **Single source of truth: the GitHub Releases API** (no fallback — two sources
  can disagree). Discipline: every real release has a tag + Release; drafts /
  prereleases are hidden from stable users; the `package.json` version matches
  the tag; no release before tests pass; no releases → return `unavailable`
  silently.
- **Egress hardening:** saved opt-in; ~5s timeout; ~64KB max response; fixed URL;
  reject redirects / verify final destination; schema validation; ignore
  malformed; cache 12–24h; no aggressive retry; never render remote Markdown as
  HTML; a failed check never fails startup.
- **Install-aware instructions** (the maintainer often works on dev branches):
  git checkout on stable/`main` → `git status --short` then `git pull --ff-only`;
  ZIP → "download from the releases page"; feature branch → "development
  checkout; stable auto-notifications are off".
- **Distinct labels**: "Update Claude CLI" / "Update Codex CLI" (provider CLI
  update, may execute the CLI's own update) vs "Codebate update available"
  (notice + instructions only, never runs `git pull`).

---

## 7. Provider readiness — dimensional model

Store **independent dimensions**; the UI derives the display chip. A flat enum
conflates orthogonal axes and explodes when a third provider is added.

```json
{
  "provider": "codex",
  "installation": { "state": "missing|discovered|installed|check_failed", "version": "..." },
  "trust":        { "state": "not_required|untrusted|trusted", "path": "...", "fingerprint": "..." },
  "auth":         { "state": "unknown|verified|failed_observed", "observedAt": null },
  "operational":  { "available": true, "reasonCode": null }
}
```

Derived chips:

```
discovered + untrusted     → found, needs trust
installed + auth unknown    → installed, login not tested yet
installed + auth failed     → needs sign-in
```

- `operational.available` = executable is trusted and runnable.
- `auth.verified` **only** after a trusted auth probe or a real successful run.
  `--version` success proves "runs", **not** "signed in".
- Never show "installed but not signed in" without evidence; before evidence say
  **"installed — login not tested yet."** Auth detection is **reactive-first**
  (`failed_observed` when a real run fails a classified auth check).

---

## 8. Capabilities — setup vs session (separate)

Machine readiness ≠ session readiness. Having two providers + Git does **not**
mean `execution.available` — execution also needs an attached, **trusted**
project (session-scoped, see [project-trust](../server/index.js)).

`setupCapabilities` (in `/api/setup/status`, shown by the Doctor):

```json
{
  "discussion":      { "available": true, "readyProviders": 2 },
  "executionEngine": { "available": true, "executorCandidates": ["codex"], "reviewerCandidates": ["codex", "claude"] },
  "gitFeatures":     { "available": true }
}
```

`sessionCapabilities` (in the session endpoint, shown in-session):

```json
{
  "execute": { "available": false, "reasonCode": "project_not_attached" },
  "merge":   { "available": false, "reasonCode": "project_not_attached" }
}
```

**Executor** candidates derive from `provider.capabilities.executeModes` (today
only Codex has `["run"]`; `executor.js` enforces it at runtime). **Reviewer**
candidates are any ready provider — reviewing needs no execute mode, so the pool
is every ready provider, the executor included (hence `["codex", "claude"]`
above, not `["claude"]`). The executor ≠ reviewer rule is enforced per-request by
[`exec-orchestrator.js`](../server/exec-orchestrator.js), which rejects a run
whose executor and reviewer match — the executor is **not** pre-excluded from the
reviewer pool.

---

## 9. Security

**Transactional + TOCTOU-safe Trust & Check** (fixes the §4 ordering bug):

1. `probeProviderCandidate()` returns canonical path + version + fingerprint +
   a short-lived `candidateId`.
2. On Trust, the server re-runs `realpath` / `stat` / fingerprint /
   `checkCommand` and compares to the probe result.
3. Persist trust **only if unchanged and the check passed**; roll back on
   failure. Never trust a failed check. Do not rely on a client-sent path alone.
4. Multiple candidates → the user chooses; never auto-select.

> Severity: the real bug is "trust persisted before a passing check" — fix that
> first. The fingerprint re-verify is defense-in-depth against a low-probability
> local swap between probe and click; cheap because the project-trust flow
> ([index.js](../server/index.js)) already uses fingerprint re-verification.

**Git missing** → warning + continue, reflected in capabilities (text discussion
available; isolated execution / merge / PR not). Button = "Install instructions",
not "Fix" (Codebate will not install Git). **Update egress** → §PR4.

---

## 10. Tests

**Setup Doctor:** zero / one / two ready providers; one discovered candidate;
multiple candidates (user chooses); candidate fails probe → **not** persisted;
candidate changes between probe and trust → rejected, nothing persisted;
symlink/junction swapped between probe and trust → rejected; probe expired; path
gone at trust; `auth unknown`; a real run success → `auth verified`; a classified
auth failure → `failed_observed` and it does **not** flip another provider;
clear/reset trust → `discovered`+`untrusted`; Git installed while running →
re-check opens Git features; re-check invalidates stale cache; Doctor auto-opens
only on first-run gaps; `/api/setup/status` issues **no** network request; a11y
(focus trap, close, focus return); every string present in AR + EN.

**Update check:** no fetch before consent; consent is not a competing modal over
the Doctor; cache prevents repeats; timeout; offline; malformed JSON; response
exceeds size limit; redirect rejected; equal / older-remote / newer-remote
versions; dev branch; ZIP install; banner dismissal is per-version (reappears on
a newer release).

---

## 11. Landing via the review gate (mandatory)

Per [`.review-gate/GATE.md`](../.review-gate/GATE.md), for each PR: review the
diff (`code-reviewer` + `security-reviewer` always; `accessibility-reviewer` +
`i18n-reviewer` for UI/text; `test-guard`; `clean-code-guard`; `docs-guard`) →
fix → commit → `attest --ran …` → push. PR1 (Trust & Check) and PR4 (egress) get
the most security scrutiny.

---

## 12. Roadmap placement

```
P0 fixes
→ PR1 Setup Doctor readiness
→ PR2 Setup Doctor UI
→ Alpha launch
→ PR3 Source preflight
→ PR4 Update Notify   (only after release discipline exists)
```

The Doctor comes before Update Notify: a user doesn't care about a new version
if they can't get past first run. Preflight is small and independent, so its
position is flexible.

---

## 13. Decisions log

1. **Auto `pnpm install`?** No — don't even check `node_modules` on the user run
   path; the project runs without it.
2. **Git missing?** Warning + continue, Git-dependent capabilities disabled with
   the reason shown.
3. **Update check default?** Off; non-blocking consent as a section inside the
   Doctor; after consent it runs in the background and the choice is saved.
4. **Auth probe or reactive?** Reactive-first; `auth: unknown` until a trusted
   probe or a real classified failure.
5. **Provider state shape?** Independent dimensions (installation / trust / auth
   / operational), not a single enum.
6. **Capabilities shape?** Split `setupCapabilities` (machine) from
   `sessionCapabilities` (session).
7. **Update source?** GitHub Releases API only — one source of truth.
8. **Branches?** Dedicated `feat/*` off a fresh baseline, separate from the
   token-efficiency work. Order: PR1 → PR2 → PR3 → PR4.

---

## Appendix — user vs contributor run paths

- **User (source run):** `node server/index.js` after installing Node 22+. No
  `node_modules`. The Doctor handles Claude/Codex/Git.
- **Contributor:** `corepack enable && pnpm install --frozen-lockfile` for tests,
  lint, and desktop builds.
