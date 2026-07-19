import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("trusted-project memory remembers, lists, and forgets by fingerprint", async () => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codebate-trusted-"));
  const previous = process.env.CODEBATE_RUNTIME_DIR;
  process.env.CODEBATE_RUNTIME_DIR = runtimeRoot;
  try {
    const store = await import("../../server/store.js");

    // An unknown fingerprint is never trusted.
    assert.equal(await store.isProjectTrusted("fp-a"), false);

    // Remembering one makes exactly that fingerprint trusted (remembered consent, not a blanket trust).
    await store.rememberTrustedProject("fp-a", "/projects/alpha");
    assert.equal(await store.isProjectTrusted("fp-a"), true);
    assert.equal(await store.isProjectTrusted("fp-b"), false);

    // Idempotent: remembering the same fingerprint again doesn't duplicate the entry.
    await store.rememberTrustedProject("fp-a", "/projects/alpha");
    const list = await store.listTrustedProjects();
    assert.equal(list.filter((entry) => entry.fingerprint === "fp-a").length, 1);
    assert.equal(list[0].path, "/projects/alpha");
    assert.equal(typeof list[0].trustedAt, "string");

    // Forgetting re-prompts next time (no longer trusted).
    await store.forgetTrustedProject("fp-a");
    assert.equal(await store.isProjectTrusted("fp-a"), false);

    // An empty/missing fingerprint is never trusted and never written (fail closed to re-consent).
    assert.equal(await store.isProjectTrusted(""), false);
    await store.rememberTrustedProject("", "/nope");
    assert.equal((await store.listTrustedProjects()).length, 0);
  } finally {
    if (previous === undefined) delete process.env.CODEBATE_RUNTIME_DIR;
    else process.env.CODEBATE_RUNTIME_DIR = previous;
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
});
