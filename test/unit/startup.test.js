import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("direct source startup exits non-zero when the listen port is unavailable", async () => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), "codebate-startup-"));
  const blocker = net.createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolve);
  });
  const port = blocker.address().port;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  let child;
  try {
    child = spawn(process.execPath, [path.join(root, "server", "index.js")], {
      cwd: root,
      env: { ...process.env, CODEBATE_RUNTIME_DIR: runtime, NO_OPEN: "1", PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10000);
    const [code] = await once(child, "exit");
    clearTimeout(timeout);
    assert.equal(code, 1, stderr);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await new Promise((resolve) => blocker.close(resolve));
    await fs.rm(runtime, { recursive: true, force: true });
  }
});
