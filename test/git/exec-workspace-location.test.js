// The disposable execution clone was relocated OUT of the project tree (it used to live at
// <project>/.agent-workspaces/<agent>/<taskId>) into an app-owned runtime bucket. These tests pin the
// new location, the backward-compat cleanup of legacy in-tree records, and the orphan-bucket sweep.
import "./_runtime-isolation.mjs"; // MUST be first — redirects RUNTIME_ROOT before store.js loads.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { createWorktree, removeWorktree, projectWorkspaceKey, sweepOrphanExecutionWorkspaces } from "../../server/worktree.js";
import { executionWorkspacesRoot } from "../../server/store.js";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

function repository() {
  const dir = mkdtempSync(join(tmpdir(), "ar-exec-loc-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "owner@example.com");
  git(dir, "config", "user.name", "Project Owner");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return realpathSync(dir);
}

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

test("the disposable clone is created OUT of the project tree, in the app exec-workspaces bucket", async () => {
  const dir = repository();
  const bucket = join(executionWorkspacesRoot(), projectWorkspaceKey(dir));
  try {
    const wt = await createWorktree(dir, "codex", "t-outoftree");
    // Not inside the project, and no in-tree .agent-workspaces was created.
    assert.equal(isInside(dir, wt.path), false, `clone ${wt.path} must not be inside the project ${dir}`);
    assert.equal(existsSync(join(dir, ".agent-workspaces")), false, "no in-tree .agent-workspaces directory is created");
    // Under exec-workspaces/<projectKey>/codex/<taskId>, and a real clone.
    assert.ok(isInside(bucket, wt.path), `clone ${wt.path} must live under the project's exec bucket ${bucket}`);
    assert.equal(wt.path, join(bucket, "codex", "t-outoftree"));
    assert.ok(existsSync(join(wt.path, ".git")), "the clone is a real git directory");

    const cleanup = await removeWorktree(dir, wt.path, wt.branch, { isolation: "clone" });
    assert.ok(cleanup.ok, `out-of-tree cleanup should succeed: ${cleanup.errors?.join("; ")}`);
    assert.equal(existsSync(wt.path), false, "removeWorktree deletes the out-of-tree clone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bucket, { recursive: true, force: true });
  }
});

test("removeWorktree still cleans a legacy in-tree clone record (backward compat)", async () => {
  const dir = repository();
  try {
    // Simulate a clone created by an older build, in-tree at <project>/.agent-workspaces/codex/t-legacy.
    const legacy = join(dir, ".agent-workspaces", "codex", "t-legacy");
    mkdirSync(join(legacy, ".git"), { recursive: true });
    writeFileSync(join(legacy, "file.txt"), "x");
    const cleanup = await removeWorktree(dir, legacy, "agent/codex/t-legacy", { isolation: "clone" });
    assert.ok(cleanup.ok, `legacy in-tree cleanup should succeed: ${cleanup.errors?.join("; ")}`);
    assert.equal(existsSync(legacy), false, "the legacy in-tree clone is removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the orphan sweep removes a session-less bucket, keeps a known one, ignores non-buckets", async () => {
  const root = mkdtempSync(join(tmpdir(), "ar-exec-sweep-"));
  const knownKey = "a".repeat(16);
  const orphanKey = "b".repeat(16);
  const notABucket = "sessions"; // wrong shape (not 16-hex) — must be left untouched
  try {
    mkdirSync(join(root, knownKey, "codex", "t-x"), { recursive: true });
    mkdirSync(join(root, orphanKey, "codex", "t-y"), { recursive: true });
    mkdirSync(join(root, notABucket), { recursive: true });

    const swept = await sweepOrphanExecutionWorkspaces(new Set([knownKey]), root);
    assert.ok(swept.ok, `sweep should succeed: ${swept.errors?.join("; ")}`);
    assert.equal(existsSync(join(root, knownKey)), true, "a bucket with a surviving session is kept");
    assert.equal(existsSync(join(root, orphanKey)), false, "a session-less bucket is swept");
    assert.equal(existsSync(join(root, notABucket)), true, "a non-bucket-shaped directory is left untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the orphan sweep refuses to follow a symlinked bucket to delete its target", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ar-exec-sweep-link-"));
  const secret = mkdtempSync(join(tmpdir(), "ar-exec-secret-"));
  writeFileSync(join(secret, "keep.txt"), "must survive");
  const linkPath = join(root, "c".repeat(16)); // bucket-shaped name that is actually a symlink/junction
  try {
    try {
      symlinkSync(secret, linkPath, "junction");
    } catch (error) {
      // Non-elevated Windows without Developer Mode can't create links — the guard is verified elsewhere.
      if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip(`symlink/junction creation unavailable: ${error.code}`); return; }
      throw error;
    }
    // Its key is not in the known set, so the sweep treats it as orphaned — but it must reject the symlink
    // and never delete through it to the target's contents.
    const swept = await sweepOrphanExecutionWorkspaces(new Set(), root);
    assert.ok(swept.ok, `sweep should not error on a symlink entry: ${swept.errors?.join("; ")}`);
    assert.equal(existsSync(join(secret, "keep.txt")), true, "the symlink target's contents must never be deleted");
  } finally {
    rmSync(linkPath, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(secret, { recursive: true, force: true });
  }
});
