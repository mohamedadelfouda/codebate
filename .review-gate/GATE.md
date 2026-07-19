# Review Gate — Pre-Push Protocol (MANDATORY)

This repo enforces review at **`git push`** time (`gateMode: push`). The pre-push
git hook catches `git push` for every actor (terminal/human/any tool); the Claude
integration additionally blocks `gh pr create` — for guaranteed PR-level
enforcement add a CI check. Before pushing ANY work or opening a PR, always run
this gate in order — even if the user only says "push". The hook BLOCKS the push
until it's done.

1. **Review the change** (the branch diff vs the base) across the relevant
   dimensions — in parallel if your tool supports subagents — using the agents in
   `.review-gate/agents/` and the guard-skills in `.review-gate/skills/`:
   - `code-reviewer` — always
   - `security-reviewer` — always
   - `performance-reviewer` — when non-trivial logic / hot paths / queries change
   - `database-reviewer` — when SQL / migrations / queries change
   - `accessibility-reviewer` — when UI changes
   - `i18n-reviewer` — when user-facing text / locale formatting changes
   - `refactor-cleaner` — when the change risks dead code / duplication
   - guard-skills: `clean-code-guard` (production code), `test-guard` (tests),
     `docs-guard` (docs/markdown)

   If your tool can't spawn subagents, apply these files as **checklists** in a
   single pass over the diff.
2. **Self-review + fix** every real finding.
3. **Commit** the work (the marker binds to the resulting HEAD).
4. **Attest**:
   ```bash
   bash .review-gate/review-gate.sh attest --ran <steps>
   ```
   `<steps>` = `review` + whichever guard-skills the diff needed (`clean-code`,
   `test`, `docs`). `attest` computes the required set from the changed files and
   REFUSES the marker unless `--ran` covers it, then runs the configured verify
   (typecheck + lint + test).
5. **Push** — allowed only while the marker matches HEAD. **Any new commit after
   attest invalidates the marker** → commit first, then attest, then push, with no
   commits in between.

**Enforcement:** the `pre-push` git hook (fires for any tool/terminal) + an
optional Claude Code PreToolUse hook. It's an **honesty gate**, not a sandbox —
the escape hatch is `git push --no-verify`; don't use it to skip the review. For
stronger, server-side enforcement, add a CI check that re-runs verify on the PR.

> Verify commands are configured in `.review-gate/gate.config.json`
> (`gateMode` must stay `"push"`).
