import test from "node:test";
import assert from "node:assert/strict";
import { deriveProviderReadiness, deriveSetupCapabilities } from "../../server/readiness-model.js";

test("deriveProviderReadiness maps a running command to installed + operational", () => {
  const state = deriveProviderReadiness({ check: { ok: true, version: "1.2.0" } });
  assert.deepEqual(state.installation, { state: "installed", version: "1.2.0" });
  assert.equal(state.trust.state, "not_required"); // runs from PATH — no path-level trust needed
  assert.deepEqual(state.auth, { state: "unknown", observedAt: null }); // --version proves "runs", not "signed in"
  assert.deepEqual(state.operational, { available: true, reasonCode: null });
});

test("deriveProviderReadiness marks an explicitly trusted or auto-trusted path as trusted", () => {
  assert.equal(deriveProviderReadiness({ check: { ok: true, version: "1" }, hasApprovedCommand: true }).trust.state, "trusted");
  assert.equal(deriveProviderReadiness({ check: { ok: true, version: "1" }, autoTrusted: true }).trust.state, "trusted");
});

test("deriveProviderReadiness maps nothing found to missing + not_installed", () => {
  const state = deriveProviderReadiness({ check: { ok: false, version: "", detail: "not found" } });
  assert.equal(state.installation.state, "missing");
  assert.equal(state.installation.version, "");
  assert.equal(state.trust.state, "not_required");
  assert.deepEqual(state.operational, { available: false, reasonCode: "not_installed" });
});

test("deriveProviderReadiness maps a discovered-but-unverified binary to discovered + untrusted, gated on trust", () => {
  const state = deriveProviderReadiness({ check: { ok: false }, discoveryFound: true });
  assert.equal(state.installation.state, "discovered");
  assert.equal(state.trust.state, "untrusted");
  assert.deepEqual(state.operational, { available: false, reasonCode: "needs_trust" });
});

test("deriveProviderReadiness never asserts auth from a version check", () => {
  for (const check of [{ ok: true, version: "1" }, { ok: false }]) {
    assert.equal(deriveProviderReadiness({ check }).auth.state, "unknown");
  }
});

test("deriveProviderReadiness keeps trust for a previously-trusted binary that no longer runs", () => {
  // A trusted path that stopped working (moved/uninstalled): the dimensions are orthogonal, so trust
  // stays trusted while installation reports it's gone. (The planned check_failed state will refine the
  // "not_installed" reason for this case.)
  const state = deriveProviderReadiness({ check: { ok: false }, hasApprovedCommand: true });
  assert.equal(state.installation.state, "missing");
  assert.equal(state.trust.state, "trusted");
  assert.deepEqual(state.operational, { available: false, reasonCode: "not_installed" });
});

test("deriveSetupCapabilities needs two operational providers — one is not enough", () => {
  const one = deriveSetupCapabilities({ providers: [{ provider: "codex", operational: { available: true } }], gitAvailable: true });
  assert.equal(one.discussion.available, false);
  assert.equal(one.discussion.readyProviders, 1);
  assert.equal(one.executionEngine.available, false);
});

test("deriveSetupCapabilities unlocks discussion at two providers, execution only with Git too", () => {
  const providers = [
    { provider: "codex", operational: { available: true }, executeModes: ["run"] },
    { provider: "claude", operational: { available: true }, executeModes: [] }, // ready reviewer, but can't execute
    { provider: "cursor", operational: { available: false }, executeModes: ["run"] }, // not ready — excluded
  ];
  const noGit = deriveSetupCapabilities({ providers, gitAvailable: false });
  assert.equal(noGit.discussion.available, true);
  assert.equal(noGit.discussion.readyProviders, 2);
  assert.equal(noGit.executionEngine.available, false); // execution engine needs Git
  assert.equal(noGit.gitFeatures.available, false);

  const withGit = deriveSetupCapabilities({ providers, gitAvailable: true });
  assert.equal(withGit.executionEngine.available, true);
  // Only Codex supports an execute mode, so it's the sole executor; Claude is still a valid reviewer.
  assert.deepEqual(withGit.executionEngine.executorCandidates, ["codex"]);
  assert.deepEqual(withGit.executionEngine.reviewerCandidates, ["codex", "claude"]);
  assert.equal(withGit.gitFeatures.available, true);
});

test("deriveSetupCapabilities offers no execution engine when no ready provider can execute", () => {
  // Two providers ready, but neither supports an execute mode → discussion yes, execution engine no.
  const providers = [
    { provider: "claude", operational: { available: true }, executeModes: [] },
    { provider: "gemini", operational: { available: true }, executeModes: [] },
  ];
  const caps = deriveSetupCapabilities({ providers, gitAvailable: true });
  assert.equal(caps.discussion.available, true);
  assert.equal(caps.executionEngine.available, false);
  assert.deepEqual(caps.executionEngine.executorCandidates, []);
});
