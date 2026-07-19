# Contributing

Participation is governed by `CODE_OF_CONDUCT.md`. Report security vulnerabilities through `SECURITY.md`, not a public issue.

## Set up

Use Node.js 22+ and pnpm 10.12.1 (pinned in `package.json`).

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm run ci
pnpm lint
pnpm test:coverage
```

Use `pnpm start` for the browser-facing source server. Run `pnpm test:browser` with system Chrome/Edge and `pnpm test:smoke` for the loopback startup check.

## How contributions land

- Fork or branch, make one coherent change with focused tests, and open a pull request.
- **CI is the mandatory gate.** For every pull request it re-runs the syntax check and unit tests on Ubuntu, Windows, and macOS, plus lint and coverage on Ubuntu — you do not need the repository's review tooling or any Claude-specific tools to contribute.
- **Only a maintainer merges to `main`.** Open a PR; a maintainer reviews and merges it once CI is green. Maintainers enforce this with branch protection (see below).

## Change boundaries

- Keep provider-specific behavior in `server/adapters/` and provider metadata in `server/providers/registry.js`.
- Keep external-service code in `server/connectors/registry.js`; state-changing actions must use the approval service.
- Do not add publication or remote-write permission to an executor.
- Preserve user-owned changes in a dirty worktree.
- Add focused tests for behavior changes. The cross-platform CI matrix runs syntax and tests on Ubuntu, Windows, and macOS.

## Review gate

Maintainers (and the Claude-driven workflow) run `.review-gate/GATE.md` before pushing. **External contributors do not run this — CI is your gate.** The ordered sequence (`push` is always the final step):

1. Review the diff with the required review agents and relevant guard checklists.
2. Fix real findings.
3. Commit the reviewed change.
4. Attest the exact `HEAD` commit with `.review-gate/review-gate.sh attest --ran ...` as described in the gate file.
5. Push.

Never bypass the hooks with `--no-verify`.

## Pull requests

Keep one coherent change per PR. Explain the user impact, safety boundary, and validation commands. Do not add generated-by, agent, or co-author signatures; repository commits and PRs use only the human contributor's identity.

## Maintainers: branch protection

Protect `main` on GitHub (Settings → Branches → rule for `main`) so external contributions land only through review. This is a required, one-time setup step — until it is configured, CI runs on pull requests but is **not blocking** and pushes to `main` are not restricted. In the branch rule:

- Require a pull request before merging.
- Require these status checks to pass: `check + test` (Ubuntu / Windows / macOS), `lint + coverage`, and `source-only smoke` (Ubuntu / Windows / macOS).
- Restrict who can push/merge to maintainers, and do not allow bypassing the above.

CI (`.github/workflows/ci.yml`) already runs on every `pull_request`; branch protection is what makes those checks blocking.

## Maintainers: releasing

Releases are cut by tagging `vX.Y.Z`. The full runbook — version and CHANGELOG discipline, the automated tag ⇄ `package.json` ⇄ CHANGELOG check, stable vs pre-release channels, and rollback — is in [`RELEASING.md`](RELEASING.md).
