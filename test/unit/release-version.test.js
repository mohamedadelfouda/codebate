import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkReleaseVersion } from "../../scripts/check-release-version.mjs";

const CHANGELOG = "# Changelog\n\n## Unreleased\n\n- wip\n\n## 0.3.0 — 2026-07-20\n\n- thing\n\n## 0.2.1 — 2026-07-15\n\n- older\n";
const testDir = dirname(fileURLToPath(import.meta.url));

test("release check passes when tag, package version, and CHANGELOG all agree", () => {
  assert.deepEqual(checkReleaseVersion({ tag: "v0.3.0", version: "0.3.0", changelog: CHANGELOG }), { ok: true, version: "0.3.0" });
});

test("release check fails on a tag/version mismatch", () => {
  const r = checkReleaseVersion({ tag: "v0.3.0", version: "0.2.1", changelog: CHANGELOG });
  assert.equal(r.ok, false);
  assert.match(r.error, /mismatch/);
});

test("release check fails when CHANGELOG has no section for the version", () => {
  const r = checkReleaseVersion({ tag: "v0.9.9", version: "0.9.9", changelog: CHANGELOG });
  assert.equal(r.ok, false);
  assert.match(r.error, /CHANGELOG/);
});

test("release check rejects anything that is not a vX.Y.Z release tag", () => {
  for (const tag of ["", "0.3.0", "release-1", "v1.2", "vlatest", "v1.2.3.4"]) {
    assert.equal(checkReleaseVersion({ tag, version: "0.3.0", changelog: CHANGELOG }).ok, false, `expected reject for "${tag}"`);
  }
});

test("release check accepts a prerelease tag when the version and CHANGELOG match", () => {
  const cl = "# Changelog\n\n## 0.3.0-rc.1 — 2026-07-20\n\n- rc\n";
  assert.deepEqual(checkReleaseVersion({ tag: "v0.3.0-rc.1", version: "0.3.0-rc.1", changelog: cl }), { ok: true, version: "0.3.0-rc.1" });
});

test("release check does not treat a version as a prefix of another (0.3.0 vs 0.3.0-rc)", () => {
  // A "## 0.3.0-rc.1" section must NOT satisfy a v0.3.0 release (word boundary after the exact version).
  const cl = "# Changelog\n\n## 0.3.0-rc.1 — 2026-07-20\n\n- rc only\n";
  assert.equal(checkReleaseVersion({ tag: "v0.3.0", version: "0.3.0", changelog: cl }).ok, false);
});

test("npm release is independent from desktop builds and keeps prereleases off latest", () => {
  const npmWorkflow = readFileSync(join(testDir, "../../.github/workflows/npm-release.yml"), "utf8");
  const desktopWorkflow = readFileSync(join(testDir, "../../.github/workflows/desktop-build.yml"), "utf8");

  assert.match(npmWorkflow, /workflow_dispatch:/);
  assert.match(npmWorkflow, /npm_tag=latest/);
  assert.match(npmWorkflow, /if \[\[ "\$\{RELEASE_TAG\}" == \*-\* \]\]; then[\s\S]*?npm_tag=next/);
  assert.match(npmWorkflow, /NPM_DIST_TAG: \$\{\{ steps\.channel\.outputs\.npm_tag \}\}/);
  assert.match(npmWorkflow, /npm publish --access public --tag "\$\{NPM_DIST_TAG\}"/);
  assert.doesNotMatch(npmWorkflow, /^\s*npm publish --access public\s*$/m);

  assert.doesNotMatch(desktopWorkflow, /npm publish/);
  assert.doesNotMatch(desktopWorkflow, /NPM_TOKEN/);
});
