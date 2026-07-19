import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loggerModule = new URL("../../server/logger.js", import.meta.url).href;

function childState(script, env) {
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", env: { ...process.env, ...env },
  });
  const marker = output.trim().split(/\r?\n/).findLast((line) => line.startsWith("STATE:"));
  return JSON.parse(marker.slice("STATE:".length));
}

test("logger rotates within a bounded file count", () => {
  const runtime = mkdtempSync(join(tmpdir(), "codebate-log-rotate-"));
  try {
    const state = childState(`
      const { log, loggerHealth } = await import(${JSON.stringify(loggerModule)});
      for (let index = 0; index < 100; index += 1) log("INFO", "rotation-test", "x".repeat(180));
      log("INFO", "oversized-entry", "y".repeat(5000));
      process.stdout.write("STATE:" + JSON.stringify(loggerHealth()));
    `, { CODEBATE_RUNTIME_DIR: runtime, CODEBATE_LOG_MAX_BYTES: "1024" });
    const files = readdirSync(join(runtime, "logs")).filter((file) => file.startsWith("server.log"));
    assert.ok(files.length <= 4);
    assert.ok(files.every((file) => statSync(join(runtime, "logs", file)).size <= 1024));
    assert.ok(state.rotationCount > 0);
    assert.equal(state.healthy, true);
  } finally { rmSync(runtime, { recursive: true, force: true }); }
});

test("logger exposes write failures without crashing the process", () => {
  const dir = mkdtempSync(join(tmpdir(), "codebate-log-fault-"));
  const invalidRuntime = join(dir, "runtime-file");
  writeFileSync(invalidRuntime, "not a directory");
  try {
    const state = childState(`
      const { log, loggerHealth } = await import(${JSON.stringify(loggerModule)});
      log("INFO", "write-fault-test");
      process.stdout.write("STATE:" + JSON.stringify(loggerHealth()));
    `, { CODEBATE_RUNTIME_DIR: invalidRuntime });
    assert.equal(state.healthy, false);
    assert.ok(state.totalFailures >= 1);
    assert.ok(state.lastErrorCategory);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
