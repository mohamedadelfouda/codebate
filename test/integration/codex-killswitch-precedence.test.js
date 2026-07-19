// Empirical proof that Codebate's `-c mcp_servers={}` / `-c features.*=false` kill-switches WIN over a
// hostile Codex config, at the level of the real `codex` binary — not just the generated config string.
//
// The unit tests assert we PASS those flags; this asserts the binary HONORS them with the right
// precedence. It plants a hostile MCP server in a Codex home's config.toml (a stdio command that writes a
// sentinel file the instant Codex launches it) and marks the project trust_level="trusted". Then:
//   control  — run `codex exec` WITHOUT our overrides  -> the sentinel SHOULD appear (server launches),
//              which proves the hostile config is actually load-bearing in this Codex build; if it does
//              NOT appear the test is inconclusive here and SKIPS.
//   override — run `codex exec` WITH ...codexSecurityOverrides("run") (`-c mcp_servers={}`) -> the
//              sentinel MUST NOT appear (our override wins; the hostile server never launches).
//
// Not in the default suite. Run on macOS/Linux with a real codex on PATH:
//   npm run test:integration
// It SKIPS on Windows (execute is confined/refused there) and when `codex` is absent. See SECURITY.md
// ("Verifying the Codex kill-switch precedence") for the manual runbook.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { codexSecurityOverrides } from "../../server/adapters/codex.js";

function codexAvailable() {
  try { execFileSync("codex", ["--version"], { stdio: "ignore", timeout: 10000 }); return true; }
  catch { return false; }
}

function runCodexExec({ codexHome, project, outputPath, extraArgs }) {
  const args = [
    "exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check",
    "-c", "model_reasoning_effort=low",
    ...extraArgs,
    "--output-last-message", outputPath, "-",
  ];
  return new Promise((resolve) => {
    const child = execFile("codex", args, {
      cwd: project,
      env: { ...process.env, CODEX_HOME: codexHome },
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    child.stdin.end("Reply with the single word: done.\n");
  });
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

test("Codex honors -c mcp_servers={} over a hostile config (kill-switch precedence)", async (t) => {
  if (process.platform === "win32") { t.skip("Codex execute is confined/refused on Windows; run this on macOS/Linux"); return; }
  if (!codexAvailable()) { t.skip("a real `codex` binary on PATH is required"); return; }

  const root = await mkdtemp(join(tmpdir(), "codex-killswitch-"));
  const project = join(root, "project");
  await mkdir(project, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: project });
  await writeFile(join(project, "readme.txt"), "hostile-config precedence probe\n");

  // A fake MCP "server": the instant Codex spawns it, it drops a sentinel and exits. Its mere launch is
  // the signal — it never needs to speak MCP.
  const sentinel = join(root, "SENTINEL_MCP_LAUNCHED");
  const evilServer = join(root, "evil-mcp.mjs");
  await writeFile(evilServer, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(sentinel)}, "launched"); setTimeout(() => process.exit(0), 250);\n`);

  const codexHome = join(root, "codex-home");
  await mkdir(codexHome, { recursive: true });
  // Hostile config: trust the project for run AND register the sentinel MCP server. If -c does not
  // override this, Codex will launch the server and the sentinel appears.
  const hostileConfig = [
    `[projects.${JSON.stringify(project)}]`,
    `trust_level = "trusted"`,
    ``,
    `[mcp_servers.evil]`,
    `command = "node"`,
    `args = [${JSON.stringify(evilServer)}, ${JSON.stringify(sentinel)}]`,
    ``,
  ].join("\n");
  await writeFile(join(codexHome, "config.toml"), hostileConfig);

  try {
    // Control: no override — does the hostile MCP server actually launch in this Codex build?
    await runCodexExec({ codexHome, project, outputPath: join(root, "c.txt"), extraArgs: [] });
    if (!(await exists(sentinel))) {
      t.skip("inconclusive: the hostile MCP server did not launch even without our override (Codex build/auth may gate MCP startup differently); verify manually per the SECURITY.md runbook");
      return;
    }
    await rm(sentinel, { force: true });

    // Override: our kill-switches must suppress the hostile server.
    await runCodexExec({ codexHome, project, outputPath: join(root, "o.txt"), extraArgs: codexSecurityOverrides("run") });
    assert.equal(await exists(sentinel), false, "the hostile MCP server launched despite -c mcp_servers={} — the kill-switch did NOT win");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
