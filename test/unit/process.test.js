import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { allowedCommand, approveProviderCommand, approvedProviderCommand, configureTrustedCliStore, hydrateTrustedProviderCommands, parsePosixProcessGroupLiveness, resolveAllowedCommand, runProcess, sanitizedAgentEnv, sanitizedGithubEnv, sanitizedPublicationEnv, terminateProcess, WINDOWS_CONFINEMENT_FAILURE_MARKER, WINDOWS_CONFINEMENT_FAILURE_EXIT } from "../../server/process.js";

// Run node against a temp .js file so large scripts stay readable and cross-platform.
function withScript(body, fn) {
  const dir = mkdtempSync(join(tmpdir(), "ar-proc-"));
  const file = join(dir, "s.js");
  writeFileSync(file, body);
  return Promise.resolve(fn(file)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function waitForClose(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("child did not close")); }, timeoutMs);
    const onClose = () => { cleanup(); resolve(); };
    const cleanup = () => { clearTimeout(timer); child.off("close", onClose); };
    child.once("close", onClose);
  });
}

async function stopChild(child) {
  if (!child) return;
  await terminateProcess(child, { immediate: true }).catch(() => false);
  await waitForClose(child, 2000).catch(() => {});
}

function forceStopPid(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return;
  try { process.kill(pid, "SIGKILL"); } catch {}
}

function posixProcessIsLive(pid) {
  try {
    const state = execFileSync("/bin/ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return Boolean(state) && !state.toUpperCase().startsWith("Z");
  } catch (error) {
    if (error?.status === 1 && !String(error?.stdout || "").trim() && !String(error?.stderr || "").trim()) return false;
    throw error;
  }
}

test("POSIX process-group inspection ignores zombies but keeps live members", () => {
  assert.equal(parsePosixProcessGroupLiveness(" 42 Z\n 42 Z+\n 7 S\n", 42), false);
  assert.equal(parsePosixProcessGroupLiveness(" 42 Z\n 42 S\n", 42), true);
  assert.equal(parsePosixProcessGroupLiveness("not process data\n", 42), null);
});

test("runProcess caps accumulated stdout so a runaway CLI can't blow up memory", async () => {
  await withScript("for(let i=0;i<300000;i++)console.log('xxxxxxxxxxxxxxxx')\n", async (file) => {
    const r = await runProcess({ command: "node", args: [file] });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.length <= 5 * 1024 * 1024, `stdout ${r.stdout.length} should be capped near 4MB`);
    assert.match(r.stdout, /\[truncated\]/);
  });
});

test("runProcess caps a single line larger than the buffer (not just many lines)", async () => {
  // One ~6MB line with no newline must be sliced while streaming, not retained in full.
  await withScript("process.stdout.write('x'.repeat(6*1024*1024))\n", async (file) => {
    const r = await runProcess({ command: "node", args: [file] });
    assert.equal(r.code, 0);
    assert.ok(r.stdout.length <= 5 * 1024 * 1024, `stdout ${r.stdout.length} should be capped near 4MB`);
    assert.match(r.stdout, /\[truncated\]/);
  });
});

test("runProcess preserves argument boundaries without a shell", async () => {
  await withScript("console.log(JSON.stringify(process.argv.slice(2)))\n", async (file) => {
    const value = "SAFE --injected FLAG";
    const r = await runProcess({ command: process.execPath, args: [file, value] });
    assert.deepEqual(JSON.parse(r.stdout), [value]);
  });
});

test("allowedCommand accepts an explicitly trusted absolute path with spaces and rejects relative paths", () => {
  const absolute = process.platform === "win32" ? "C:\\Program Files\\Agent CLIs\\codex.exe" : "/opt/Agent CLIs/codex";
  assert.equal(allowedCommand(absolute, new Set(["codex"]), { trustedPaths: [absolute] }), absolute);
  assert.throws(() => allowedCommand(absolute, new Set(["codex"])), /not been trusted/);
  const relative = `.${process.platform === "win32" ? "\\" : "/"}codex`;
  assert.throws(() => allowedCommand(relative, new Set(["codex"])), /absolute/);
});

test("an explicitly approved CLI symlink resolves consistently on later launches", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ar-cli-link-"));
  const link = join(dir, process.platform === "win32" ? "codex.exe" : "codex");
  try {
    try { symlinkSync(process.execPath, link, "file"); }
    catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`symlink creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    const approved = await approveProviderCommand("symlink_test", link, new Set(["codex"]));
    assert.equal(approved, realpathSync(process.execPath));
    assert.equal(
      await resolveAllowedCommand(link, new Set(["codex"]), { trustedPaths: [approvedProviderCommand("symlink_test")] }),
      realpathSync(process.execPath),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("trusted CLI approvals persist to disk and reload in a fresh process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-trusted-cli-"));
  const store = join(dir, "trusted-cli.json");
  const binary = join(dir, process.platform === "win32" ? "codex.exe" : "codex");
  const providerId = "persist_test";
  writeFileSync(binary, "placeholder");
  if (process.platform !== "win32") {
    const { chmodSync } = await import("node:fs");
    chmodSync(binary, 0o755);
  }
  try {
    configureTrustedCliStore(store);
    const approved = await approveProviderCommand(providerId, binary, new Set(["codex"]));
    assert.equal(approvedProviderCommand(providerId), approved);
    const processModule = new URL("../../server/process.js", import.meta.url).href;
    const script = `
      import { configureTrustedCliStore, hydrateTrustedProviderCommands, approvedProviderCommand } from ${JSON.stringify(processModule)};
      configureTrustedCliStore(${JSON.stringify(store)});
      await hydrateTrustedProviderCommands({ allowed: new Set(["codex"]) });
      process.stdout.write(approvedProviderCommand(${JSON.stringify(providerId)}));
    `;
    const reloaded = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(reloaded, approved);
  } finally {
    configureTrustedCliStore("");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a trusted CLI is rejected after the executable at that path changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-trusted-cli-swap-"));
  const store = join(dir, "trusted-cli.json");
  const binary = join(dir, process.platform === "win32" ? "codex.exe" : "codex");
  const providerId = "swap_test";
  writeFileSync(binary, "first executable identity");
  if (process.platform !== "win32") {
    const { chmodSync } = await import("node:fs");
    chmodSync(binary, 0o755);
  }
  try {
    configureTrustedCliStore(store);
    await approveProviderCommand(providerId, binary, new Set(["codex"]));
    writeFileSync(binary, "different executable identity");
    await assert.rejects(
      () => resolveAllowedCommand(binary, new Set(["codex"]), { trustedPaths: [approvedProviderCommand(providerId)] }),
      /identity changed/,
    );
    await approveProviderCommand(providerId, binary, new Set(["codex"]));
    // Compare against the SAME canonicalizer the code uses (async fs.realpath). On Windows,
    // realpathSync keeps an 8.3 short path (e.g. MOHAM_~1) while promises.realpath expands it,
    // so the sync form would spuriously mismatch when os.tmpdir() sits under a short-name parent.
    assert.equal(await resolveAllowedCommand(binary, new Set(["codex"]), { trustedPaths: [approvedProviderCommand(providerId)] }), await realpath(binary));
  } finally {
    configureTrustedCliStore("");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy path-only trusted CLI records are not hydrated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-trusted-cli-legacy-"));
  const store = join(dir, "trusted-cli.json");
  const binary = join(dir, process.platform === "win32" ? "codex.exe" : "codex");
  writeFileSync(binary, "legacy executable");
  writeFileSync(store, JSON.stringify({ legacy_test: binary }));
  if (process.platform !== "win32") {
    const { chmodSync } = await import("node:fs");
    chmodSync(binary, 0o755);
  }
  try {
    configureTrustedCliStore(store);
    await hydrateTrustedProviderCommands({ allowed: new Set(["codex"]) });
    assert.equal(approvedProviderCommand("legacy_test"), "");
  } finally {
    configureTrustedCliStore("");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed trusted-cli persist rolls back in-memory approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-trusted-cli-rb-"));
  const binary = join(dir, process.platform === "win32" ? "codex.exe" : "codex");
  const providerId = "rollback_test";
  writeFileSync(binary, "placeholder");
  if (process.platform !== "win32") {
    const { chmodSync } = await import("node:fs");
    chmodSync(binary, 0o755);
  }
  // Parent path is a file, so mkdir/rename for the store must fail.
  const blocker = join(dir, "not-a-dir");
  writeFileSync(blocker, "x");
  const badStore = join(blocker, "trusted-cli.json");
  const goodStore = join(dir, "trusted-cli.json");
  try {
    configureTrustedCliStore(badStore);
    await assert.rejects(() => approveProviderCommand(providerId, binary, new Set(["codex"])));
    assert.equal(approvedProviderCommand(providerId), "");

    configureTrustedCliStore(goodStore);
    const kept = await approveProviderCommand(providerId, binary, new Set(["codex"]));
    assert.equal(approvedProviderCommand(providerId), kept);

    configureTrustedCliStore(badStore);
    await assert.rejects(() => approveProviderCommand(providerId, binary, new Set(["codex"])));
    assert.equal(approvedProviderCommand(providerId), kept);
  } finally {
    configureTrustedCliStore("");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent environment is allowlisted and does not inherit credentials", async () => {
  const secretKeys = [
    "CODEBATE_TEST_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "CODEBATE_GMAIL_ACCESS_TOKEN",
    "CODEBATE_SUPABASE_KEY",
  ];
  const previous = Object.fromEntries(secretKeys.map((key) => [key, process.env[key]]));
  for (const key of secretKeys) process.env[key] = "do-not-inherit";
  try {
    const agentEnv = sanitizedAgentEnv();
    for (const key of secretKeys) assert.equal(agentEnv[key], undefined);
    await withScript("console.log(JSON.stringify({secret:process.env.CODEBATE_TEST_TOKEN||null,path:Boolean(process.env.PATH)}))\n", async (file) => {
      const r = await runProcess({ command: process.execPath, args: [file], envPolicy: "agent" });
      assert.deepEqual(JSON.parse(r.stdout), { secret: null, path: true });
    });
  } finally {
    for (const key of secretKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("runProcess rejects unknown environment policies", async () => {
  await assert.rejects(
    () => runProcess({ command: process.execPath, args: ["-e", ""], envPolicy: "typo" }),
    /Unsupported process environment policy/,
  );
});

test("publication environment adds only the SSH agent socket", () => {
  const source = { PATH: "safe-path", SSH_AUTH_SOCK: "/tmp/ssh-agent.sock", SECRET_TOKEN: "no" };
  assert.deepEqual(sanitizedPublicationEnv(source), { PATH: "safe-path", SSH_AUTH_SOCK: "/tmp/ssh-agent.sock" });
});

test("GitHub environment excludes connector credentials", () => {
  const source = { PATH: "safe-path", GH_TOKEN: "github", CODEBATE_GMAIL_ACCESS_TOKEN: "gmail", CODEBATE_SUPABASE_KEY: "database" };
  assert.deepEqual(sanitizedGithubEnv(source), { PATH: "safe-path", GH_TOKEN: "github" });
});

test("terminateProcess immediate kills a child that ignores SIGTERM (shutdown path)", async () => {
  let child;
  try {
    child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });
    // terminateProcess resolves only after the child has actually exited, so confirm the
    // close afterwards. A close promise created *before* the await races the kill — on
    // Windows CI, PowerShell/taskkill cold-start can exceed the timer, which then rejects
    // while unawaited (an unhandled rejection that flaked the release build).
    assert.equal(await terminateProcess(child, { immediate: true }), true);
    await waitForClose(child, 15000);
  } finally {
    await stopChild(child);
  }
});

test("terminateProcess removes a Windows child process tree", async () => {
  if (process.platform !== "win32") return;
  await withScript(
    "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)\n",
    async (file) => {
      let child;
      let grandchildPid;
      try {
        child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "ignore"] });
        grandchildPid = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("grandchild PID was not reported")), 2000);
          child.stdout.once("data", (chunk) => { clearTimeout(timer); resolve(Number(String(chunk).trim())); });
        });
        // Await the kill first, then confirm close — see the shutdown-path test above for
        // why a pre-attached close promise races the Windows kill and flakes.
        assert.equal(await terminateProcess(child, { immediate: true }), true);
        await waitForClose(child, 15000);
        assert.throws(() => process.kill(grandchildPid, 0), /ESRCH|not found|no such process/i);
        grandchildPid = undefined;
      } finally {
        await stopChild(child);
        forceStopPid(grandchildPid);
      }
    },
  );
});

test("runProcess Job Object containment kills a detached Windows descendant", async () => {
  if (process.platform !== "win32") return;
  await withScript(
    "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)\n",
    async (file) => {
      let wrapper;
      let descendantPid;
      let running;
      let reportPid;
      // Windows CI can take over 35s to cold-start PowerShell and compile the Job Object helper.
      const reportTimeoutMs = 60_000;
      const reported = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("contained descendant PID was not reported")), reportTimeoutMs);
        reportPid = (line) => {
          const pid = Number(String(line).trim());
          if (!Number.isSafeInteger(pid)) return;
          clearTimeout(timer);
          resolve(pid);
        };
      });
      try {
        running = runProcess({
          command: process.execPath,
          args: [file],
          containTree: true,
          timeoutMs: reportTimeoutMs + 10_000,
          registerChild: (child) => { wrapper = child; },
          onStdoutLine: (line) => reportPid(line),
        });
        descendantPid = await reported;
        assert.ok(wrapper?.pid);
        assert.equal(await terminateProcess(wrapper, { immediate: true }), true);
        await running;
        assert.throws(() => process.kill(descendantPid, 0), /ESRCH|not found|no such process/i);
        descendantPid = undefined;
      } finally {
        await stopChild(wrapper);
        await running?.catch(() => {});
        forceStopPid(descendantPid);
      }
    },
  );
});

test("runProcess containment kills a POSIX descendant after its parent exits normally", async () => {
  if (process.platform === "win32") return;
  await withScript(
    "const{spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);c.unref()\n",
    async (file) => {
      let wrapper;
      let descendantPid;
      let running;
      try {
        running = runProcess({
          command: process.execPath,
          args: [file],
          containTree: true,
          timeoutMs: 5000,
          registerChild: (child) => { wrapper = child; },
          onStdoutLine: (line) => {
            const pid = Number(line.trim());
            if (Number.isSafeInteger(pid)) descendantPid = pid;
          },
        });
        const result = await running;
        assert.equal(result.code, 0);
        assert.ok(Number.isSafeInteger(descendantPid));
        assert.equal(posixProcessIsLive(descendantPid), false);
        descendantPid = undefined;
      } finally {
        await stopChild(wrapper);
        await running?.catch(() => {});
        forceStopPid(descendantPid);
      }
    },
  );
});

test("Windows Job Object launcher preserves empty and spaced argument boundaries", async () => {
  if (process.platform !== "win32") return;
  await withScript("console.log(JSON.stringify(process.argv.slice(2)))\n", async (file) => {
    const result = await runProcess({ command: process.execPath, args: [file, "", "value with spaces"], containTree: true });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), ["", "value with spaces"]);
  });
});

test("runProcess returns small output intact and streams every line", async () => {
  await withScript("console.log('a');console.log('b')\n", async (file) => {
    const lines = [];
    const r = await runProcess({ command: "node", args: [file], onStdoutLine: (l) => lines.push(l) });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /a\r?\nb/);
    assert.deepEqual(lines, ["a", "b"]);
  });
});

// Fail-open guard: AppContainer confinement is delivered only through the Windows Job Object wrapper, so
// asking for it without that wrapper must be refused, never silently run unconfined. Cross-platform.
test("runProcess rejects windowsConfinement without the Windows containTree wrapper", async () => {
  await assert.rejects(
    () => runProcess({ command: "node", args: ["-e", "0"], windowsConfinement: { containerName: "x", grants: [] } }),
    /windowsConfinement requires containTree/,
  );
});

// The confinement-failure contract (marker + reserved exit code) is duplicated between process.js and
// windows-job-runner.ps1. Assert the PowerShell source still carries both literals so the two can't drift
// apart unnoticed — this runs on every OS, not just when the Windows integration suite happens to run.
test("windows-job-runner.ps1 keeps the confinement-failure marker and exit code in sync", () => {
  const wrapper = readFileSync(fileURLToPath(new URL("../../server/windows-job-runner.ps1", import.meta.url)), "utf8");
  assert.ok(wrapper.includes(WINDOWS_CONFINEMENT_FAILURE_MARKER), "wrapper must emit the confinement-failure marker process.js looks for");
  assert.ok(wrapper.includes(`exit ${WINDOWS_CONFINEMENT_FAILURE_EXIT}`), "wrapper must exit with the reserved confinement-failure code process.js checks");
});
