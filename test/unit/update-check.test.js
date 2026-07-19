import test from "node:test";
import assert from "node:assert/strict";
import { parseSemver, isNewerVersion, checkProviderUpdate } from "../../server/update-check.js";

test("parseSemver extracts the semver from CLI --version output", () => {
  assert.equal(parseSemver("2.1.211 (Claude Code)"), "2.1.211");
  assert.equal(parseSemver("codex-cli 0.144.4"), "0.144.4");
  assert.equal(parseSemver("v1.2.3"), "1.2.3");
  assert.equal(parseSemver("no version here"), "");
  assert.equal(parseSemver(""), "");
  assert.equal(parseSemver(null), "");
});

test("isNewerVersion compares semver numerically, not lexically", () => {
  assert.equal(isNewerVersion("0.144.5", "0.144.4"), true);
  assert.equal(isNewerVersion("2.1.211", "2.1.210"), true);
  // Lexical string compare would call "2.1.9" newer than "2.1.10"; numeric must not.
  assert.equal(isNewerVersion("2.1.10", "2.1.9"), true);
  assert.equal(isNewerVersion("2.2.0", "2.1.99"), true);
  assert.equal(isNewerVersion("2.1.211", "2.1.211"), false);
  assert.equal(isNewerVersion("2.1.210", "2.1.211"), false);
  assert.equal(isNewerVersion("1.0.0", "2.0.0"), false);
  assert.equal(isNewerVersion("", "1.0.0"), false);
  assert.equal(isNewerVersion("1.0.0", ""), false);
});

test("checkProviderUpdate reports unsupported for a provider that can't self-update", async () => {
  assert.deepEqual(await checkProviderUpdate("no-such-provider"), { supported: false });
});

test("checkProviderUpdate compares the installed version against the injected latest", async () => {
  const result = await checkProviderUpdate("codex", { fetchLatest: async () => "999.999.999", now: 1000 });
  assert.equal(result.supported, true);
  // On a host with codex installed this exercises the full compare; CI has no codex, so guard on it.
  if (result.installed) {
    assert.equal(result.latest, "999.999.999");
    assert.equal(result.updateAvailable, true);
  } else {
    assert.equal(result.updateAvailable, undefined);
  }
});

test("checkProviderUpdate soft-fails (never a wrong 'up to date') when the registry is unreachable", async () => {
  // `now` is past the previous test's 10-minute cache window, so this actually re-runs fetchLatest.
  const result = await checkProviderUpdate("codex", {
    fetchLatest: async () => { throw new Error("offline"); },
    now: 1000 + 20 * 60 * 1000,
  });
  assert.equal(result.supported, true);
  if (result.installed) {
    assert.equal(result.checkFailed, true);
    assert.equal(result.updateAvailable, false);
  }
});

test("checkProviderUpdate treats an unparseable latest (200 with no version) as a failed check, not 'up to date'", async () => {
  // A registry 200 whose manifest yields no semver must NOT render as "✓ Updated". `now` is past the
  // earlier cache windows so this re-runs fetchLatest rather than reusing a cached version.
  const result = await checkProviderUpdate("codex", {
    fetchLatest: async () => "",
    now: 1000 + 40 * 60 * 1000,
  });
  assert.equal(result.supported, true);
  if (result.installed) {
    assert.equal(result.checkFailed, true);
    assert.equal(result.updateAvailable, false);
  }
});

test("checkProviderUpdate treats an unparseable INSTALLED version as a failed check, not 'up to date'", async () => {
  // Installed, but `--version` yields no semver → `current` is empty. Comparing would silently render
  // "✓ Updated"; it must report a failed check instead. getReadiness is injected so this is deterministic.
  const result = await checkProviderUpdate("codex", {
    getReadiness: async () => ({ installed: true, version: "codex (dev build, no semver)" }),
    fetchLatest: async () => "1.2.3",
    now: 1000 + 60 * 60 * 1000,
  });
  assert.equal(result.supported, true);
  assert.equal(result.installed, true);
  assert.equal(result.current, "");
  assert.equal(result.checkFailed, true);
  assert.equal(result.updateAvailable, false);
});
