import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudePermissionArgs, createClaudeStreamCollector, runClaude } from "../../server/adapters/claude.js";
import { codexSandboxMode, codexSecurityOverrides, prepareIsolatedCodexHome, runCodex, windowsExecOptIn } from "../../server/adapters/codex.js";

// The allowlist must be enforced on the REAL execution path (runClaude/runCodex spawn the
// agent), not only on the diagnostic endpoints. A client-supplied command that isn't the
// adapter's own CLI must be rejected before any process is spawned.

test("runClaude rejects a non-allowlisted command before spawning", async () => {
  await assert.rejects(
    () => runClaude({ prompt: "hi", config: { command: "calc" }, cwd: process.cwd() }),
    /not allowed/,
  );
});

test("runCodex rejects a non-allowlisted command (even the other agent's CLI)", async () => {
  await assert.rejects(
    () => runCodex({ prompt: "hi", config: { command: "claude" }, cwd: process.cwd() }),
    /not allowed/,
  );
});

test("runClaude rejects the win32 space-tokenization shape when on Windows", async () => {
  await assert.rejects(
    () => runClaude({ prompt: "hi", config: { command: "calc /claude" }, cwd: process.cwd() }),
    /absolute|not allowed/,
  );
});

test("runCodex rejects the removed prompt-only edit permission before command discovery", async () => {
  await assert.rejects(
    () => runCodex({ prompt: "hi", config: { command: "missing-codex", permission: "edit" }, cwd: process.cwd() }),
    /Unsupported Codex permission: edit/,
  );
});

test("runClaude rejects unsupported effort values", async () => {
  await assert.rejects(
    () => runClaude({ prompt: "hi", config: { effort: "ultracode" }, cwd: process.cwd() }),
    /Unsupported Claude effort/,
  );
});

test("malformed Claude stream events never become final or partial output", () => {
  const events = [];
  const collector = createClaudeStreamCollector((event) => events.push(event));
  collector.onStdoutLine("RAW_PRIVATE_REASONING");
  collector.onStdoutLine(JSON.stringify({ type: "result", result: "safe final answer", session_id: "session-1" }));

  const output = collector.snapshot();
  assert.equal(output.finalText, "safe final answer");
  assert.equal(output.streamedText, "");
  assert.equal(output.sessionId, "session-1");
  assert.doesNotMatch(JSON.stringify(output), /RAW_PRIVATE_REASONING/);
  assert.deepEqual(events, [{ kind: "activity", text: "Claude emitted an unreadable event" }]);
});

test("the Claude collector captures token usage and cost from the result event", () => {
  const collector = createClaudeStreamCollector(() => {});
  collector.onStdoutLine(JSON.stringify({
    type: "result", result: "done", session_id: "s",
    usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 30 },
    total_cost_usd: 0.0021,
  }));
  const snap = collector.snapshot();
  assert.equal(snap.usage.raw.input_tokens, 120);
  assert.equal(snap.usage.raw.output_tokens, 40);
  assert.equal(snap.usage.costUsd, 0.0021);
  assert.equal(createClaudeStreamCollector(() => {}).snapshot().usage, null); // no usage event → null
});

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

test("Claude permissions expose an exact built-in tool surface", () => {
  assert.equal(flagValue(claudePermissionArgs("chat"), "--tools"), "WebSearch,WebFetch");
  assert.equal(flagValue(claudePermissionArgs("project"), "--tools"), "");
  assert.equal(flagValue(claudePermissionArgs("connectors"), "--tools"), "");
  assert.equal(flagValue(claudePermissionArgs("read"), "--tools"), "");
  assert.equal(flagValue(claudePermissionArgs("unknown"), "--tools"), "");
});

function configOverrides(args) {
  const overrides = [];
  for (let index = 0; index < args.length; index += 2) {
    assert.equal(args[index], "-c");
    overrides.push(args[index + 1]);
  }
  return overrides;
}

test("Codex permissions disable inherited external tool surfaces", () => {
  for (const [permission, webMode] of [["read", "disabled"], ["planread", "disabled"], ["run", "disabled"], ["chat", "live"]]) {
    const overrides = configOverrides(codexSecurityOverrides(permission));
    assert.ok(overrides.includes(`web_search="${webMode}"`));
    assert.ok(overrides.includes("mcp_servers={}"));
    for (const feature of ["apps", "hooks", "multi_agent", "memories"]) {
      assert.ok(overrides.includes(`features.${feature}=false`));
    }
  }
});

test("Codex sandbox mode: read-only unless run; platforms without a sandbox fail closed unless opted in", () => {
  // Review/plan/chat never write — read-only on every platform, whether or not the opt-in is set.
  for (const permission of ["read", "planread", "chat", "bogus"]) {
    for (const platform of ["win32", "darwin", "linux"]) {
      assert.equal(codexSandboxMode(permission, platform, false), "read-only");
      assert.equal(codexSandboxMode(permission, platform, true), "read-only");
    }
  }
  // Executor "run" on macOS/Linux uses the enforceable workspace-write sandbox (opt-in irrelevant).
  assert.equal(codexSandboxMode("run", "darwin", false), "workspace-write");
  assert.equal(codexSandboxMode("run", "linux", true), "workspace-write");
  // Windows — and ANY platform outside the macOS/Linux allowlist — has no proven OS sandbox: fails closed
  // (null) by default; danger-full-access ONLY when opted in. Guards against granting workspace-write to an
  // unproven platform on the mere assumption it sandboxes.
  for (const platform of ["win32", "freebsd"]) {
    assert.equal(codexSandboxMode("run", platform, false), null);
    assert.equal(codexSandboxMode("run", platform, true), "danger-full-access");
  }
});

test("windowsExecOptIn maps the two Windows execute opt-ins", () => {
  // Neither set.
  assert.deepEqual(windowsExecOptIn({}), { appcontainer: false, unsandboxed: false });
  // AppContainer opt-in (preferred — runCodex confines when this is set on Windows).
  assert.deepEqual(windowsExecOptIn({ CODEBATE_WINDOWS_EXEC_APPCONTAINER: "1" }), { appcontainer: true, unsandboxed: false });
  // Unsandboxed escape hatch.
  assert.deepEqual(windowsExecOptIn({ CODEBATE_ALLOW_UNSANDBOXED_WINDOWS_EXEC: "true" }), { appcontainer: false, unsandboxed: true });
  // Both set — both flags true; runCodex prefers confinement.
  assert.deepEqual(windowsExecOptIn({ CODEBATE_WINDOWS_EXEC_APPCONTAINER: "yes", CODEBATE_ALLOW_UNSANDBOXED_WINDOWS_EXEC: "on" }), { appcontainer: true, unsandboxed: true });
  // Non-truthy values do not enable it.
  assert.deepEqual(windowsExecOptIn({ CODEBATE_WINDOWS_EXEC_APPCONTAINER: "0", CODEBATE_ALLOW_UNSANDBOXED_WINDOWS_EXEC: "off" }), { appcontainer: false, unsandboxed: false });
});

test("runCodex refuses Windows execute unless an opt-in is set", async (t) => {
  if (process.platform !== "win32") { t.skip("the Windows-only fail-closed refusal path"); return; }
  // Clear BOTH opt-ins so the environment can't accidentally satisfy the gate.
  const prevAc = process.env.CODEBATE_WINDOWS_EXEC_APPCONTAINER;
  const prevUn = process.env.CODEBATE_ALLOW_UNSANDBOXED_WINDOWS_EXEC;
  delete process.env.CODEBATE_WINDOWS_EXEC_APPCONTAINER;
  delete process.env.CODEBATE_ALLOW_UNSANDBOXED_WINDOWS_EXEC;
  try {
    // Refused BEFORE any process spawn — the message names both opt-in env vars.
    await assert.rejects(
      () => runCodex({ prompt: "hi", config: { command: "codex", permission: "run" }, cwd: process.cwd() }),
      /unavailable on this platform|CODEBATE_WINDOWS_EXEC_APPCONTAINER|CODEBATE_ALLOW_UNSANDBOXED_WINDOWS_EXEC/,
    );
  } finally {
    if (prevAc === undefined) delete process.env.CODEBATE_WINDOWS_EXEC_APPCONTAINER;
    else process.env.CODEBATE_WINDOWS_EXEC_APPCONTAINER = prevAc;
    if (prevUn === undefined) delete process.env.CODEBATE_ALLOW_UNSANDBOXED_WINDOWS_EXEC;
    else process.env.CODEBATE_ALLOW_UNSANDBOXED_WINDOWS_EXEC = prevUn;
  }
});

test("Codex isolated home trusts the workspace only for executor run — kill-switches stay on", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codebate-codex-run-trust-"));
  try {
    const sourceHome = path.join(root, "source-home");
    const project = path.join(root, "project");
    await fs.mkdir(sourceHome, { recursive: true });
    await fs.mkdir(path.join(project, ".git"), { recursive: true });
    await fs.writeFile(path.join(sourceHome, "auth.json"), '{"token":"test-only"}');

    const runHome = await prepareIsolatedCodexHome({
      tempDir: path.join(root, "run"),
      cwd: project,
      permission: "run",
      sourceEnv: { CODEX_HOME: sourceHome },
    });
    const config = await fs.readFile(path.join(runHome, "config.toml"), "utf8");
    // Execute must be able to write in the disposable clone the orchestrator hands us.
    assert.match(config, /trust_level = "trusted"/);
    assert.doesNotMatch(config, /trust_level = "untrusted"/);
    // Trust re-enables writes ONLY — the external-tool kill-switches must remain in run mode.
    assert.match(config, /mcp_servers = \{\}/);
    assert.match(config, /web_search = "disabled"/);
    assert.match(config, /apps = false/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Codex isolated home copies auth only and distrusts project config", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codebate-codex-home-test-"));
  try {
    const sourceHome = path.join(root, "source-home");
    const project = path.join(root, "project");
    const tempDir = path.join(root, "run");
    await fs.mkdir(sourceHome, { recursive: true });
    await fs.mkdir(path.join(project, ".git"), { recursive: true });
    await fs.writeFile(path.join(sourceHome, "auth.json"), '{"token":"test-only"}');
    await fs.writeFile(path.join(sourceHome, "config.toml"), '[mcp_servers.evil]\ncommand = "evil"\n');

    const isolatedHome = await prepareIsolatedCodexHome({
      tempDir,
      cwd: project,
      sourceEnv: { CODEX_HOME: sourceHome },
    });

    assert.equal(await fs.readFile(path.join(isolatedHome, "auth.json"), "utf8"), '{"token":"test-only"}');
    const config = await fs.readFile(path.join(isolatedHome, "config.toml"), "utf8");
    assert.match(config, /trust_level = "untrusted"/);
    assert.match(config, /mcp_servers = \{\}/);
    assert.match(config, /apps = false/);
    assert.doesNotMatch(config, /evil/);
    assert.deepEqual((await fs.readdir(isolatedHome)).sort(), ["auth.json", "config.toml"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Codex auth isolation refuses a symlink to a file outside CODEX_HOME", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codebate-codex-auth-link-test-"));
  try {
    const sourceHome = path.join(root, "source-home");
    const project = path.join(root, "project");
    const external = path.join(root, "outside-secret.json");
    await fs.mkdir(sourceHome, { recursive: true });
    await fs.mkdir(path.join(project, ".git"), { recursive: true });
    await fs.writeFile(external, '{"token":"must-not-copy"}');
    try { await fs.symlink(external, path.join(sourceHome, "auth.json"), "file"); }
    catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`symlink creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(
      () => prepareIsolatedCodexHome({ tempDir: path.join(root, "run"), cwd: project, sourceEnv: { CODEX_HOME: sourceHome } }),
      /not a regular file/,
    );
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
