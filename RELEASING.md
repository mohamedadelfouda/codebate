# Releasing

A release is a single annotated `vX.Y.Z` git tag. Pushing it triggers
[`desktop-build.yml`](.github/workflows/desktop-build.yml), which validates the source, builds the
Windows/macOS/Linux installers, and publishes a GitHub Release. The same tag serves both audiences:
**source users** (`git clone` + `node server/index.js`) and **desktop users** (the installers).

## Versioning

- Semantic versioning `MAJOR.MINOR.PATCH`. Pre-1.0, a breaking change bumps MINOR.
- The tag is `v<version>` and **must equal** `package.json`'s `version` (enforced — see below).
- Pre-releases use a suffix: `v0.3.0-rc.1`.

## Cut a release

1. **Land everything through the [review gate](.review-gate/GATE.md) and merge to `main`.** Never
   release from an unmerged branch.
2. **Bump the version** in `package.json`.
3. **Update the CHANGELOG.** Move the `## Unreleased` notes under a new `## <version> — <YYYY-MM-DD>`
   heading. Every release must have its own CHANGELOG section (enforced).
4. **Verify locally from a clean state:**
   ```bash
   pnpm install --frozen-lockfile
   pnpm run ci                                          # syntax + unit/git tests (same as CI)
   node scripts/check-release-version.mjs v<version>    # tag ⇄ package.json ⇄ CHANGELOG agree
   node test/smoke/source-server.mjs                    # the app boots from a clean source checkout
   ```
5. **Commit** the version + CHANGELOG bump to `main` (through the gate).
6. **Tag and push:**
   ```bash
   git tag -a v<version> -m "Codebate v<version>"
   git push origin v<version>
   ```
7. The **workflow takes over**: it re-verifies the tag/version/CHANGELOG, runs `pnpm run ci` on every
   platform, builds the installers, and creates the GitHub Release. If any check fails nothing is
   published — the publish job `needs` the build job.

## Stable vs pre-release

The channel is decided by the **tag suffix** and the presence of **code-signing secrets**, not a manual flag:

- A **prerelease tag** (`v0.3.0-rc.1`, `-beta`, …) → always a **pre-release**, regardless of signing, so a
  signed release candidate is never promoted to "Latest".
- Otherwise, **all** signing secrets present (Windows cert + Apple ID / cert / team) → a normal **Latest**
  release with signed, notarized installers.
- Otherwise (**any** signing secret missing) → the installers are unsigned and the release is published as
  a **pre-release** (clearly labelled, not "Latest"), so an unsigned build can never silently become the
  official download. Add the secrets and re-tag to promote — no workflow change needed.

## Source-run users

Source users update with `git pull`. Session documents are schema-versioned and migrated on load (with a
backup of the pre-migration file), so `git pull --ff-only` onto a newer tag or `main` keeps existing
sessions readable — point users at the in-app update guidance rather than a manual reinstall. The SD-3
source preflight (`scripts/source-preflight.mjs`) hard-requires Node ≥ 22 at boot, so an unsupported Node
fails fast with a clear message instead of a cryptic syntax error.

## Rollback / yanking a bad release

A published release can't be un-downloaded, so act fast and **fix forward** — never move or reuse a
published tag:

1. **Stop serving it as "Latest"** — mark the bad release as a pre-release (or delete it):
   ```bash
   gh release edit v<bad> --prerelease
   ```
2. **Fix forward:** land the fix through the gate, bump to the next PATCH, add a CHANGELOG entry that
   notes the yank and why, and cut a new release.
3. If the yanked version is dangerous (e.g. a security issue), call it out in both the CHANGELOG and the
   release notes of the superseding version.

## What's enforced automatically

- **No release before tests pass** — the build runs `pnpm run ci` on every platform, and the publish job
  `needs` it.
- **Tag ⇄ version ⇄ CHANGELOG** — `scripts/check-release-version.mjs` fails the build unless the tag,
  `package.json` version, and a matching CHANGELOG section all agree.
- **Unsigned ⇒ pre-release** — an unsigned build is never published as a stable "Latest" release.
