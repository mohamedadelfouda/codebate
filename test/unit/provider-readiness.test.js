import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, chmod, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertProvidersReady, invalidateProviderReadiness, providerReadiness } from "../../server/provider-readiness.js";
import { approvedProviderCommand, configureTrustedCliStore } from "../../server/process.js";

test("unknown or unavailable providers use the stable readiness error contract", async () => {
  assert.deepEqual(await providerReadiness("missing-provider"), {
    installed: false,
    version: "",
    detail: "Unknown provider",
  });
  await assert.rejects(
    () => assertProvidersReady(["missing-provider"]),
    (error) => error.apiStatus === 503 && error.apiCode === "provider_unavailable",
  );
});

test("an explicit command override disables auto-discovery (a failing override is never superseded)", async () => {
  // Runs before the auto-detect test below, so codex is not yet approved in this process — the only
  // reason discovery is skipped here is the override, which is exactly what we're asserting.
  process.env.CODEBATE_CODEX_COMMAND = join(tmpdir(), "definitely-not-a-real-codex");
  invalidateProviderReadiness("codex");
  try {
    let discovered = false;
    const status = await providerReadiness("codex", {
      refresh: true,
      discover: async () => { discovered = true; return []; },
    });
    assert.equal(discovered, false);
    assert.equal(status.installed, false);
  } finally {
    delete process.env.CODEBATE_CODEX_COMMAND;
    invalidateProviderReadiness("codex");
  }
});

test("a provider missed by PATH search is auto-detected and trusted via its discovered native executable", async () => {
  // Windows npm installs of Codex expose only cmd/ps1 shims on PATH (rejected as non-native), so
  // detection must fall back to the bundled native executable. Stand in for that binary with a copy
  // of `node` named `codex` — it responds to `--version` and its basename passes the allowlist —
  // and inject it through the `discover` seam so this runs without a real Codex install.
  const dir = await mkdtemp(join(tmpdir(), "ar-readiness-"));
  const bin = join(dir, process.platform === "win32" ? "codex.exe" : "codex");
  await copyFile(process.execPath, bin);
  if (process.platform !== "win32") await chmod(bin, 0o755);
  const store = join(dir, "trusted-cli.json");
  configureTrustedCliStore(store);
  invalidateProviderReadiness("codex");
  // Force the primary `codex` lookup to miss regardless of the host — a developer who actually has Codex
  // on PATH would otherwise pass the primary check, so the injected discover would never run and
  // autoTrusted would be false. An empty PATH makes bare "codex" unresolvable; the discovered binary is
  // verified by its absolute path, so it still runs. Restored in finally.
  const savedPath = process.env.PATH;
  process.env.PATH = "";

  try {
    // Bare "codex" can't resolve (empty PATH), so readiness must discover the native binary, verify it
    // runs, auto-trust it, and report installed — no manual Trust & check.
    const status = await providerReadiness("codex", { refresh: true, discover: async () => [bin] });
    assert.equal(status.installed, true);
    assert.equal(status.autoTrusted, true);
    assert.match(status.version, /\d+\.\d+/);
    assert.match(approvedProviderCommand("codex"), /codex(\.exe)?$/i);
    // The approval persists so the next launch skips discovery.
    assert.match(await readFile(store, "utf8"), /"codex"/);

    // Once trusted, readiness uses the approved path and never re-runs discovery (throwing discover
    // would surface if it were called again).
    const again = await providerReadiness("codex", {
      refresh: true,
      discover: async () => { throw new Error("discovery must not run once a command is trusted"); },
    });
    assert.equal(again.installed, true);
  } finally {
    process.env.PATH = savedPath;
    invalidateProviderReadiness("codex");
    // Clears the in-memory `codex` approval too (configureTrustedCliStore resets the map), so this
    // test's auto-trust can't leak forward and make a later test think codex is already trusted.
    configureTrustedCliStore("");
    await rm(dir, { recursive: true, force: true });
  }
});
