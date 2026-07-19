import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("a fresh desktop runtime creates its scratch workspace on first use", async () => {
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), "codebate-runtime-"));
  const previous = process.env.CODEBATE_RUNTIME_DIR;
  try {
    process.env.CODEBATE_RUNTIME_DIR = runtime;
    const moduleUrl = new URL("../../server/store.js", import.meta.url);
    moduleUrl.searchParams.set("runtime-test", `${Date.now()}-${Math.random()}`);
    const { scratchWorkspacePath } = await import(moduleUrl.href);
    const workspace = await scratchWorkspacePath();
    assert.equal(workspace, path.join(runtime, "workspace"));
    assert.equal((await fs.stat(workspace)).isDirectory(), true);
  } finally {
    if (previous === undefined) delete process.env.CODEBATE_RUNTIME_DIR;
    else process.env.CODEBATE_RUNTIME_DIR = previous;
    await fs.rm(runtime, { recursive: true, force: true });
  }
});
