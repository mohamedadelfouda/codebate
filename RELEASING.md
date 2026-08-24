# Releasing

A release is a single annotated `vX.Y.Z` git tag. Pushing it triggers
[`desktop-build.yml`](.github/workflows/desktop-build.yml), which validates the source, builds the
Windows/macOS/Linux installers, and publishes a GitHub Release. The same tag serves both audiences:
**source users** (`git clone` + `pnpm start`) and **desktop users** (the installers). When the optional
`NPM_TOKEN` secret is configured, the same workflow also publishes the matching npm package if that
version is not already present.

Normal pull requests and pushes to `main` are guarded by [`ci.yml`](.github/workflows/ci.yml): the core
quality gate runs on Windows, macOS, and Linux, while coverage thresholds and the real headless-browser
regressions run on Linux.

## Versioning

- Semantic versioning `MAJOR.MINOR.PATCH`. Pre-1.0, a breaking change bumps MINOR.
- The tag is `v<version>` and **must equal** `package.json`'s `version` (enforced — see below).
- Pre-releases use a suffix: `v0.3.0-rc.1`.

## Cut a release

1. **Land everything through review and merge to `main`.** Never release from an unmerged branch.
2. **Bump the version** in `package.json`.
3. **Update the CHANGELOG.** Move the `## Unreleased` notes under a new `## <version> — <YYYY-MM-DD>`
   heading. Every release must have its own CHANGELOG section (enforced).
4. **Verify locally from a clean state:**
   ```bash
   corepack enable
   pnpm install --frozen-lockfile --ignore-scripts
   pnpm run ci
   pnpm run test:coverage
   pnpm run test:browser
   node scripts/check-release-version.mjs v<version>
   ```
   `pnpm run ci` covers syntax, lint, unit/git tests, integration tests, and source/CLI/npm-package smoke tests.
5. **Commit** the version + CHANGELOG bump to `main` through the normal PR/CI path.
6. **Tag and push:**
   ```bash
   git tag -a v<version> -m "Codebate v<version>"
   git push origin v<version>
   ```
7. The **tag workflow takes over**: it re-verifies tag/version/CHANGELOG, runs the release gate on every
   platform, runs coverage + browser regressions on Linux, builds the native installers, and creates the
   GitHub Release only after every native build succeeds.

## Stable vs pre-release

The channel is decided by the **tag suffix** and the presence of **native signing/notarization secrets**,
not a manual flag:

- A **prerelease tag** (`v0.3.0-rc.1`, `-beta`, …) → always a **pre-release**, regardless of signing.
- Otherwise, **all** native signing/notarization secrets present (Windows certificate + macOS certificate,
  Apple ID/app password/team) → a normal stable release.
- Otherwise (**any** required native signing/notarization secret missing) → the installers are built
  unsigned where necessary and the release is published as a **pre-release**, so an unsigned build can
  never silently become the official stable download.

The workflow derives `WINDOWS_CERTIFICATE_FILE` from `WINDOWS_CERTIFICATE_BASE64` and imports
`MAC_CERTIFICATE_BASE64` into a temporary macOS keychain. The repository never stores certificate bytes
or passwords.

## npm publishing

npm publishing is deliberately opt-in. If the repository secret `NPM_TOKEN` is configured, the tagged
workflow publishes `codebate@<package.json version>` after the native builds succeed. If that exact npm
version already exists, a workflow re-run skips publishing instead of failing. Without `NPM_TOKEN`, the
GitHub/desktop release still completes and npm publishing is skipped explicitly.

The npm dist-tag follows the **semantic version**, not the desktop-signing state:

- Stable versions such as `0.3.0` publish under npm's `latest` tag.
- Semantic prereleases such as `0.3.0-rc.1` publish under npm's `next` tag, never `latest`.
- A stable semantic version whose desktop installers are forced to GitHub pre-release only because signing
  secrets are missing still publishes under npm `latest`; npm/CLI stability is independent of native
  installer signing.

This distinction is important because the in-app updater reads npm's `/codebate/latest` endpoint and the
UI recommends `codebate@latest`. A release candidate must therefore never advance the `latest` dist-tag.

## Source-run and npm-lifecycle users

Source users update with `git pull`. `pnpm start` runs `scripts/source-preflight.mjs` before the server, so
Node < 22 fails fast with a clear error and a missing Git install is surfaced as a non-blocking warning.
Session documents are schema-versioned and migrated on load (with a backup of the pre-migration file), so
`git pull --ff-only` onto a newer tag or `main` keeps existing sessions readable.

The npm package **also ships `scripts/source-preflight.mjs`** because npm's standard `start` lifecycle uses
the same `package.json` command. The smoke suite runs `npm pack --dry-run --json` and asserts that this
preflight plus the runtime entry points are actually present in the tarball, so the package whitelist
cannot silently break `npm start` again.

`npx codebate` / globally installed npm users continue through the packaged CLI launcher (`bin/codebate.mjs`).

## Rollback / yanking a bad release

A published release can't be un-downloaded, so act fast and **fix forward** — never move or reuse a
published tag:

1. **Stop serving it as stable** — mark the bad release as a pre-release (or delete it):
   ```bash
   gh release edit v<bad> --prerelease
   ```
2. **Fix forward:** land the fix through CI, bump to the next PATCH, add a CHANGELOG entry that notes the
   yank and why, and cut a new release.
3. If the yanked version is dangerous (e.g. a security issue), call it out in both the CHANGELOG and the
   release notes of the superseding version.

## What's enforced automatically

- **PR/main gate** — syntax, lint, unit/git, integration, and smoke suites run on Windows/macOS/Linux;
  coverage thresholds and browser regressions run on Linux.
- **Packaged lifecycle completeness** — the npm-package smoke checks the real `npm pack --dry-run` manifest,
  including the preflight referenced by `npm start`.
- **No tagged release before tests pass** — the native build matrix runs the release gate and the publish
  job depends on all three build jobs.
- **Tag ⇄ version ⇄ CHANGELOG** — `scripts/check-release-version.mjs` fails the tag workflow unless the tag,
  `package.json` version, and a matching CHANGELOG section all agree.
- **Unsigned ⇒ pre-release** — missing signing/notarization secrets can never silently produce a stable
  GitHub release.
- **npm prerelease isolation** — semantic prereleases publish under `next`, never `latest`, so the in-app
  stable update check cannot advertise an RC as stable.
- **npm is opt-in and idempotent** — it publishes only when `NPM_TOKEN` exists and skips an already-published
  version on workflow re-runs.
