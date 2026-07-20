import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isNewerVersion, parseSemver } from "./update-check.js";

// App-level "update available" check (SD-4): compares Codebate's own version to the latest published
// GitHub release. Read-only, fail-soft (never blocks startup, never claims "up to date" when offline or
// before any release exists — it only ever surfaces a NOTICE; it never runs `git pull`). Egress is opt-in:
// the real GitHub fetch runs ONLY when a caller passes `fetchLatest` in, so opening the app triggers no
// un-consented network. Testable now with an injected fetcher; activates against real releases after 1.0.

const REPO = "mohamedadelfouda/codebate";
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

function readAppVersion() {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return parseSemver(JSON.parse(readFileSync(pkgPath, "utf8")).version);
  } catch { return ""; }
}

// Codebate's own version, read once at import from package.json.
export const APP_VERSION = readAppVersion();

// Read at most maxBytes, aborting a chunked/oversized response (mirrors update-check.js's readCapped).
async function readCapped(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) { const text = await response.text(); if (text.length > maxBytes) throw new Error("release response too large"); return text; }
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new Error("release response too large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The real "latest release" source: GitHub Releases API. Fixed URL, 5s timeout, 64 KB cap, redirects
// rejected. Returns the release's semver tag, or null when there is no published release yet (404).
export async function fetchLatestFromGitHub() {
  const response = await fetch(RELEASES_URL, {
    signal: AbortSignal.timeout(5000),
    redirect: "error",
    headers: { accept: "application/vnd.github+json", "user-agent": "codebate" },
  });
  if (response.status === 404) return null; // no releases yet (pre-1.0)
  if (!response.ok) throw new Error(`GitHub responded ${response.status}`);
  return parseSemver(JSON.parse(await readCapped(response, 64_000))?.tag_name || "");
}

// G1: distribution is npm now, so the latest-version source is the public npm registry. Same shape as the
// GitHub fetcher — fixed URL, 5s timeout, 64 KB cap, redirects rejected, fail-soft (404 = never published).
const NPM_URL = "https://registry.npmjs.org/codebate/latest";
export async function fetchLatestFromNpm() {
  const response = await fetch(NPM_URL, {
    signal: AbortSignal.timeout(5000),
    redirect: "error",
    headers: { accept: "application/json", "user-agent": "codebate" },
  });
  if (response.status === 404) return null; // package/version not published
  if (!response.ok) throw new Error(`npm responded ${response.status}`);
  return parseSemver(JSON.parse(await readCapped(response, 64_000))?.version || "");
}

/**
 * Compare the current app version to the latest release. `fetchLatest` is injected — a fixture in tests, or
 * `fetchLatestFromGitHub` once the user has opted into update checks. Without it, returns "not checked" and
 * performs no network. Always fail-soft: any fetch error → `checkFailed`, `updateAvailable: false`.
 * @returns {Promise<{current: string, latest: string|null, updateAvailable: boolean, checked: boolean, checkFailed: boolean}>}
 */
export async function checkAppUpdate({ fetchLatest = null, currentVersion = APP_VERSION } = {}) {
  const current = currentVersion || APP_VERSION;
  if (typeof fetchLatest !== "function") {
    return { current, latest: null, updateAvailable: false, checked: false, checkFailed: false };
  }
  try {
    const latest = await fetchLatest();
    if (!latest) return { current, latest: null, updateAvailable: false, checked: true, checkFailed: false }; // no release yet
    return { current, latest, updateAvailable: isNewerVersion(latest, current), checked: true, checkFailed: false };
  } catch {
    return { current, latest: null, updateAvailable: false, checked: true, checkFailed: true };
  }
}
