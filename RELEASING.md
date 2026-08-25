# Releasing

A release is a single annotated `vX.Y.Z` git tag. Pushing it triggers two independent workflows:

- [`npm-release.yml`](.github/workflows/npm-release.yml) validates and tests the tagged source on Ubuntu, then publishes the CLI/npm package when `NPM_TOKEN` is configured.
- [`desktop-build.yml`](.github/workflows/desktop-build.yml) validates the same tag, builds Windows/macOS/Linux installers, and publishes the GitHub desktop release after every native build succeeds.

The workflows deliberately do **not** depend on each other. A native installer failure must not block `npx codebate`, and an npm publishing problem must not invalidate already-built desktop artifacts.

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
7. The tag starts both release workflows in parallel. npm/CLI publishing is independent of native installer builds.

## npm / terminal release

[`npm-release.yml`](.github/workflows/npm-release.yml) is the release path for `npx codebate` and global npm installs. It runs on Ubuntu only because the published npm package is platform-neutral source/CLI code; platform-specific installer builds are a separate concern.

Before publishing, the workflow:

1. checks out the exact release tag,
2. verifies tag ⇄ `package.json` ⇄ CHANGELOG consistency,
3. runs `pnpm run ci`,
4. runs coverage thresholds,
5. runs the real browser regressions,
6. publishes only if `NPM_TOKEN` is configured and the exact version is not already present.

The npm dist-tag follows the **semantic version**:

- Stable versions such as `0.3.0` publish under npm's `latest` tag.
- Semantic prereleases such as `0.3.0-rc.1` publish under npm's `next` tag, never `latest`.

The workflow also supports a manual `workflow_dispatch` with an existing tag. This is a recovery path for a tag that already exists but whose npm publish did not happen; it checks out and verifies that immutable tag before doing anything. Never move or reuse a tag to recover publishing.

This distinction is important because the in-app updater reads npm's `/codebate/latest` endpoint and the UI recommends `codebate@latest`. A release candidate must therefore never advance the `latest` dist-tag.

## Desktop release

[`desktop-build.yml`](.github/workflows/desktop-build.yml) owns native installers and the GitHub Release. It runs the release gate on Windows, macOS, and Linux, runs coverage + browser regressions on Linux, builds the native artifacts, and creates the GitHub Release only after every native build succeeds.

### Stable vs pre-release desktop artifacts

The GitHub desktop release channel is decided by the **tag suffix** and the presence of **native signing/notarization secrets**:

- A **prerelease tag** (`v0.3.0-rc.1`, `-beta`, …) → always a GitHub pre-release.
- Otherwise, **all** native signing/notarization secrets present (Windows certificate + macOS certificate,
  Apple ID/app password/team) → a normal stable GitHub release.
- Otherwise (**any** required native signing/notarization secret missing) → the installers are built
  unsigned where necessary and the GitHub release is marked pre-release, so an unsigned build can never silently become the official stable desktop download.

The workflow derives `WINDOWS_CERTIFICATE_FILE` from `WINDOWS_CERTIFICATE_BASE64` and imports
`MAC_CERTIFICATE_BASE64` into a temporary macOS keychain. The repository never stores certificate bytes
or passwords.

A desktop failure does not block npm/CLI publishing. Fix or re-run the desktop workflow independently.

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

1. **Stop serving it as stable** — move npm's stable dist-tag away from the bad package and mark/delete a bad GitHub desktop release as appropriate.
2. **Fix forward:** land the fix through CI, bump to the next PATCH, add a CHANGELOG entry that notes the yank and why, and cut a new release.
3. If the yanked version is dangerous (e.g. a security issue), call it out in both the CHANGELOG and the release notes of the superseding version.

## What's enforced automatically

- **PR/main gate** — syntax, lint, unit/git, integration, and smoke suites run on Windows/macOS/Linux; coverage thresholds and browser regressions run on Linux.
- **Packaged lifecycle completeness** — the npm-package smoke checks the real `npm pack --dry-run` manifest, including the preflight referenced by `npm start`.
- **Independent npm release gate** — npm publishing re-verifies the immutable tag and runs CI + coverage + browser regressions on Ubuntu without waiting for native installers.
- **Independent desktop gate** — GitHub desktop release creation waits for all three native builds but has no authority over npm publishing.
- **Tag ⇄ version ⇄ CHANGELOG** — `scripts/check-release-version.mjs` fails either release workflow unless the tag, `package.json` version, and a matching CHANGELOG section all agree.
- **Unsigned desktop ⇒ GitHub pre-release** — missing signing/notarization secrets can never silently produce a stable GitHub desktop release.
- **npm prerelease isolation** — semantic prereleases publish under `next`, never `latest`, so the stable update check cannot advertise an RC as stable.
- **npm is opt-in and idempotent** — it publishes only when `NPM_TOKEN` exists and skips an already-published version on workflow re-runs or manual recovery runs.
