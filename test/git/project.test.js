import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectIdentity, projectSnapshot } from "../../server/project.js";

const git = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

test("projectSnapshot reports branch, tree, and read-only guidance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-snap-"));
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "README.md"), "# hi\n");
    mkdirSync(join(dir, "server"));
    writeFileSync(join(dir, "server", "index.js"), "// x\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");

    const snap = await projectSnapshot(dir);
    assert.match(snap, /SHARED EVIDENCE PACK/);
    assert.match(snap, /verified-from-project/);
    assert.match(snap, /not-verified.*Tests/);
    assert.match(snap, /README\.md/);
    assert.match(snap, /server\//);
    assert.match(snap, /Read.?\/.?Grep.?\/.?Glob/);
    assert.match(snap, /# hi/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("projectSnapshot is empty for no path", async () => {
  assert.equal(await projectSnapshot(""), "");
});

test("missing trusted projects ask the user to attach again", async () => {
  const missing = join(tmpdir(), `ar-missing-project-${Date.now()}`);
  await assert.rejects(() => projectIdentity(missing), /attach and trust it again/);
});

test("projectSnapshot reads README through a byte cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-snap-large-"));
  try {
    git(dir, "init", "-q");
    writeFileSync(join(dir, "README.md"), "x".repeat(5 * 1024 * 1024));
    const snap = await projectSnapshot(dir);
    assert.ok(snap.length < 10000, `snapshot length was ${snap.length}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("projectSnapshot never follows a README symlink outside the project", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ar-snap-link-"));
  const outside = join(tmpdir(), `ar-snap-secret-${Date.now()}.txt`);
  try {
    git(dir, "init", "-q");
    writeFileSync(outside, "OUTSIDE_PRIVATE_CONTENT");
    try { symlinkSync(outside, join(dir, "README.md"), "file"); }
    catch (error) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("symlink creation is unavailable"); throw error; }
    const snap = await projectSnapshot(dir);
    assert.doesNotMatch(snap, /OUTSIDE_PRIVATE_CONTENT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { force: true });
  }
});
