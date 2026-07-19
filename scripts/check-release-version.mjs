// Verifies a release is internally consistent before it ships: the git tag (vX.Y.Z), the package.json
// "version", and a matching CHANGELOG.md section must all agree. Enforced in the tag-triggered build
// (.github/workflows/desktop-build.yml) so a tagged release can never be mislabeled or undocumented, and
// runnable locally per RELEASING.md: `node scripts/check-release-version.mjs vX.Y.Z`.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

// Pure so it can be unit-tested without a real tag or filesystem.
export function checkReleaseVersion({ tag, version, changelog }) {
  const trimmed = String(tag || "").trim();
  const match = trimmed.match(SEMVER_TAG);
  if (!match) return { ok: false, error: `Tag "${trimmed}" is not a vX.Y.Z release tag.` };
  const tagVersion = match[1];
  if (version !== tagVersion) {
    return { ok: false, error: `Tag/version mismatch: tag ${trimmed} → ${tagVersion}, but package.json is ${version}. Bump package.json (and CHANGELOG) or retag to v${version}.` };
  }
  // A release must be documented: CHANGELOG.md needs a "## <version>" section, not just "Unreleased".
  // The lookahead prevents a longer version (e.g. a "## 0.3.0-rc.1" heading) from satisfying "0.3.0".
  const hasSection = new RegExp(`^##\\s+${tagVersion.replace(/[.\\]/g, "\\$&")}(?![-.+0-9A-Za-z])`, "m").test(String(changelog || ""));
  if (!hasSection) {
    return { ok: false, error: `CHANGELOG.md has no "## ${tagVersion}" section. Move the Unreleased notes under "## ${tagVersion} — <date>" before releasing.` };
  }
  return { ok: true, version: tagVersion };
}

// CLI: node scripts/check-release-version.mjs [tag]   (tag defaults to $GITHUB_REF_NAME in CI).
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const tag = process.argv[2] || process.env.GITHUB_REF_NAME || "";
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const result = checkReleaseVersion({ tag, version, changelog });
  if (!result.ok) { console.error(`✗ ${result.error}`); process.exit(1); }
  console.log(`✓ Release ${tag} is consistent: package.json ${result.version} + a CHANGELOG section are present.`);
}
