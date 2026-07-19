import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("provider adapters enforce a caller-supplied output cap before returning text", async (t) => {
  const realProcess = await import("../../server/process.js");
  const invocations = [];
  t.mock.module("../../server/process.js", {
    namedExports: {
      ...realProcess,
      resolveAllowedCommand: async () => process.execPath,
      runProcess: async (options) => {
        invocations.push(options);
        if (options.args.includes("--output-last-message")) {
          const outputPath = options.args[options.args.indexOf("--output-last-message") + 1];
          await fs.writeFile(outputPath, "x".repeat(200));
        } else {
          options.onStdoutLine(JSON.stringify({ type: "result", result: "x".repeat(200) }));
        }
        return { code: 0, stdout: "", stderr: "", stdoutTruncated: false };
      },
    },
  });

  const { runClaude } = await import("../../server/adapters/claude.js");
  const { runCodex } = await import("../../server/adapters/codex.js");
  const config = { command: "test-provider", permission: "read", maxOutputBytes: 32 };
  const claude = await runClaude({ prompt: "repair", config, cwd: process.cwd() });
  const codex = await runCodex({ prompt: "repair", config, cwd: process.cwd() });

  assert.equal(invocations.length, 2);
  assert.equal(invocations.every((invocation) => invocation.maxOutputBytes === 32), true);
  assert.equal(invocations.every((invocation) => invocation.envPolicy === "agent"), true);
  assert.equal(claude.outputTruncated, true);
  assert.equal(codex.outputTruncated, true);
  assert.ok(Buffer.byteLength(claude.text, "utf8") < 200);
  assert.ok(Buffer.byteLength(codex.text, "utf8") < 200);
});
