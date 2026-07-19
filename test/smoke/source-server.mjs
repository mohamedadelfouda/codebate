import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "codebate-source-smoke-"));
let shutdownServer;
try {
  process.env.CODEBATE_RUNTIME_DIR = runtimeDir;
  process.env.NO_OPEN = "1";
  process.env.PORT = "0";
  const serverModule = await import("../../server/index.js");
  shutdownServer = serverModule.shutdownServer;
  const { url } = await serverModule.serverReady;
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);

  const landing = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const html = await landing.text();
  assert.equal(landing.status, 200);
  assert.match(html, /Codebate/);

  const cookie = landing.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const health = await fetch(`${url}/api/health`, { headers: { Cookie: cookie, Origin: url }, signal: AbortSignal.timeout(10000) });
  const payload = await health.json();
  assert.equal(health.status, 200);
  assert.equal(typeof payload.ok, "boolean");
  assert.equal(payload.platform, process.platform);
  console.log("source server smoke passed");
} finally {
  await shutdownServer?.("source_smoke");
  await fs.rm(runtimeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
