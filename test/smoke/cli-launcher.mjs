// Smoke-tests the `codebate` CLI launcher (bin/codebate.mjs) as a real subprocess — not by importing
// the server directly like source-server.mjs — so the bin's own behavior is covered: it boots the
// server, serves the app, and honors CODEBATE_RUNTIME_DIR for the data directory. This guards the
// launcher against a future refactor (e.g. a static import that would break the data-dir defaulting).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bin = path.join(root, "bin", "codebate.mjs");
const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "codebate-cli-smoke-"));

let child;
try {
  child = spawn(process.execPath, [bin], {
    env: { ...process.env, CODEBATE_RUNTIME_DIR: runtimeDir, NO_OPEN: "1", PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // The launcher boots server/index.js, which prints "Codebate is running at http://127.0.0.1:<port>".
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`launcher did not report a URL in time; output:\n${out}`)), 20000);
    let out = "";
    const scan = (buf) => {
      out += buf;
      const match = out.match(/running at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`launcher exited early (code ${code}); output:\n${out}`)); });
  });
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);

  const landing = await fetch(url, { signal: AbortSignal.timeout(10000) });
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /Codebate/);

  // Data must live under the configured runtime dir (the mechanism that keeps a global install out of
  // the read-only package folder), not next to the sources.
  assert.equal((await fs.stat(path.join(runtimeDir, "data"))).isDirectory(), true);
  console.log("cli launcher smoke passed");
} finally {
  child?.kill();
  if (child && child.exitCode === null) await new Promise((r) => child.on("exit", r));
  await fs.rm(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
