import "./_runtime-isolation.mjs"; // MUST be first — redirects RUNTIME_ROOT before store.js loads.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync, rmSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareAcceptedChange } from "../../server/acceptance.js";
import { assertExecutionRepository, assertProjectReady, changedTreeFiles, commitAcceptedTree, createWorktree, mergeBranch, recoverCodebateIndexLock, removeWorktree, stageAcceptedTree } from "../../server/worktree.js";
import { hasBlockingSecrets, scanForSecrets } from "../../server/secret-scan.js";
import { acceptExecution, rejectExecution } from "../../server/exec-orchestrator.js";
import { createSession, getSession, rootPath, saveSession } from "../../server/store.js";
import { projectIdentity } from "../../server/project.js";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
const secretFixture = () => ["sk", "-abcdefghij1234567890xyz"].join("");

function repository() {
  const dir = mkdtempSync(join(tmpdir(), "ar-accept-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "owner@example.com");
  git(dir, "config", "user.name", "Project Owner");
  writeFileSync(join(dir, ".gitignore"), ".agent-workspaces/\n");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function writeRefOnlyRecoveryState({ dir, worktree, accepted, temporaryIndex, nonce }) {
  const lockPath = join(dir, ".git", "index.lock");
  git(dir, "update-ref", worktree.approval.baseRef, accepted.commitSha, worktree.baseSha);
  execFileSync("git", ["read-tree", worktree.baseSha], { cwd: dir, env: { ...process.env, GIT_INDEX_FILE: temporaryIndex } });
  writeFileSync(lockPath, JSON.stringify({ codebate: true, nonce }));
  writeFileSync(`${lockPath}.codebate-intent`, JSON.stringify({
    codebate: true, nonce, phase: "refreshing", temporaryIndex,
    indexCommit: accepted.commitSha, targetRef: worktree.approval.baseRef,
    baseSha: worktree.baseSha, commitSha: accepted.commitSha,
  }));
}

function addIgnoredUserFile(dir, name, content = "user content\n") {
  writeFileSync(join(dir, ".gitignore"), `.agent-workspaces/\n${name}\n`);
  git(dir, "add", ".gitignore");
  git(dir, "commit", "-qm", `ignore ${name}`);
  writeFileSync(join(dir, name), content);
}

test("the public decision gate creates no commit before acceptance and uses the owner identity", async () => {
  const dir = repository();
  const session = await createSession("decision gate");
  let wt;
  try {
    wt = await createWorktree(dir, "codex", "t-accept");
    writeFileSync(join(wt.path, "feature.js"), "export const ready = true;\n");
    const reviewedTree = await stageAcceptedTree(wt.path, wt.baseSha);
    const identity = await projectIdentity(dir);
    session.project = { path: identity.realPath, fingerprint: identity.fingerprint, trusted: true };
    session.executions = [{
      taskId: "t-accept",
      task: "add the ready feature",
      worktree: wt,
      reviewedTree,
      status: "awaiting_user",
      review: { text: "APPROVE" },
      diff: { files: "A feature.js", stat: "", patch: "" },
      projectPath: identity.realPath,
      projectFingerprint: identity.fingerprint,
    }];
    await saveSession(session);

    assert.equal(git(wt.path, "rev-list", "--count", wt.baseSha + "..HEAD").trim(), "0");
    assert.equal(git(dir, "rev-list", "--count", wt.baseSha + "..HEAD").trim(), "0");

    const result = await acceptExecution(session.id, "t-accept", "merge");
    assert.equal(result.status, "merged");
    assert.equal(git(dir, "rev-list", "--count", wt.baseSha + "..HEAD").trim(), "1");
    assert.equal(git(dir, "log", "-1", "--format=%an").trim(), "Project Owner");
    assert.equal((await getSession(session.id)).executions[0].decision, "merge");
    wt = null;
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(join(rootPath(), "data", "sessions", `${session.id}.json`), { force: true });
    rmSync(join(rootPath(), "data", "sessions", `${session.id}.summary.json`), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accept re-scans and blocks a secret added after the preview", async () => {
  const dir = repository();
  let wt;
  try {
    wt = await createWorktree(dir, "claude", "t-secret");
    writeFileSync(join(wt.path, "feature.js"), "export const ready = true;\n");
    writeFileSync(join(wt.path, ".env"), `OPENAI_API_KEY=${secretFixture()}\n`);
    const result = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "must not commit" });
    assert.equal(result.blocked, true);
    assert.equal(git(wt.path, "rev-list", "--count", wt.baseSha + "..HEAD").trim(), "0");
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project drift and dirty state both block acceptance", async () => {
  const dir = repository();
  let wt;
  try {
    wt = await createWorktree(dir, "codex", "t-drift");
    writeFileSync(join(dir, "dirty.txt"), "dirty\n");
    await assert.rejects(() => assertProjectReady(dir, wt), /uncommitted changes/);
    git(dir, "clean", "-fdq");
    writeFileSync(join(dir, "README.md"), "changed\n");
    git(dir, "add", "README.md");
    git(dir, "commit", "-qm", "move head");
    await assert.rejects(() => assertProjectReady(dir, wt), /HEAD changed/);
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("switching to a different branch at the same SHA blocks acceptance", async () => {
  const dir = repository();
  let wt;
  try {
    wt = await createWorktree(dir, "claude", "t-branch");
    git(dir, "switch", "-qc", "other");
    await assert.rejects(() => assertProjectReady(dir, wt), /branch changed/);
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a worktree mutation after the immutable scan cannot enter the accepted commit", async () => {
  const dir = repository();
  let wt;
  try {
    wt = await createWorktree(dir, "codex", "t-immutable");
    const feature = join(wt.path, "feature.js");
    writeFileSync(feature, "export const safe = true;\n");
    const treeSha = await stageAcceptedTree(wt.path, wt.baseSha);
    assert.equal(hasBlockingSecrets(scanForSecrets(await changedTreeFiles(wt.path, wt.baseSha, treeSha))), false);
    writeFileSync(feature, `export const key = '${secretFixture()}';\n`);

    await assert.rejects(() => commitAcceptedTree(wt.path, wt, treeSha, "immutable acceptance"), /changed after the accepted snapshot/);
    assert.equal(git(wt.path, "rev-list", "--count", wt.baseSha + "..HEAD").trim(), "0");
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("accepted trees reject drive-relative Windows symlink targets", async () => {
  const dir = repository();
  let wt;
  try {
    wt = await createWorktree(dir, "codex", "t-drive-link");
    const targetSource = join(wt.path, "link-target.txt");
    writeFileSync(targetSource, "C:outside");
    const blob = git(wt.path, "hash-object", "-w", targetSource).trim();
    rmSync(targetSource, { force: true });
    git(wt.path, "update-index", "--add", "--cacheinfo", "120000", blob, "escape-link");
    const treeSha = git(wt.path, "write-tree").trim();

    await assert.rejects(
      () => changedTreeFiles(wt.path, wt.baseSha, treeSha),
      /Symlink target escapes the accepted project tree/,
    );
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch, { isolation: wt.isolation });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acceptance commits the reviewed tree even if files change after review", async () => {
  const dir = repository();
  let wt;
  try {
    wt = await createWorktree(dir, "codex", "t-reviewed-tree");
    const feature = join(wt.path, "feature.js");
    writeFileSync(feature, "export const reviewed = true;\n");
    const reviewedTree = await stageAcceptedTree(wt.path, wt.baseSha);

    writeFileSync(feature, "export const late = true;\n");
    writeFileSync(join(wt.path, "late.js"), "export const unreviewed = true;\n");
    const accepted = await prepareAcceptedChange({
      projectPath: dir,
      worktree: wt,
      reviewedTree,
      message: "reviewed snapshot only",
    });

    assert.equal(git(dir, "show", `${accepted.acceptedRef}:feature.js`), "export const reviewed = true;\n");
    assert.throws(() => git(dir, "show", `${accepted.acceptedRef}:late.js`));
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packed secret objects remain confined to the disposable execution clone", async () => {
  const dir = repository();
  let wt;
  try {
    wt = await createWorktree(dir, "codex", "t-packed-secret");
    writeFileSync(join(wt.path, "secret.txt"), `OPENAI_API_KEY=${secretFixture()}\n`);
    git(wt.path, "add", "secret.txt");
    git(wt.path, "-c", "user.name=Executor", "-c", "user.email=executor@example.com", "commit", "-qm", "secret object");
    git(wt.path, "gc", "--prune=now");
    const blob = git(wt.path, "rev-parse", "HEAD:secret.txt").trim();
    git(wt.path, "cat-file", "-e", `${blob}^{blob}`);
    assert.throws(() => git(dir, "cat-file", "-e", `${blob}^{blob}`));

    const cleanup = await removeWorktree(dir, wt.path, wt.branch);
    assert.equal(cleanup.ok, true, cleanup.errors.join("; "));
    assert.equal(existsSync(wt.path), false);
    wt = null;
    assert.throws(() => git(dir, "cat-file", "-e", `${blob}^{blob}`));
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execution clone remains readable without the source object store", async () => {
  const dir = repository();
  const sourceObjects = join(dir, ".git", "objects");
  const heldObjects = join(dir, ".git", "objects.codebate-test-held");
  let wt;
  try {
    wt = await createWorktree(dir, "codex", "t-independent-objects");
    assert.equal(existsSync(join(wt.path, ".git", "objects", "info", "alternates")), false);
    await fsPromises.rename(sourceObjects, heldObjects);
    assert.equal(git(wt.path, "show", `${wt.baseSha}:README.md`), "hello\n");
  } finally {
    if (existsSync(heldObjects)) await fsPromises.rename(heldObjects, sourceObjects);
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execution clone rejects an alternate object store added after creation", async () => {
  const dir = repository();
  let wt;
  try {
    wt = await createWorktree(dir, "codex", "t-added-alternate");
    writeFileSync(
      join(wt.path, ".git", "objects", "info", "alternates"),
      `${join(dir, ".git", "objects")}\n`,
    );
    await assert.rejects(() => assertExecutionRepository(wt), /object boundary changed/);
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execution clone rejects a commondir pointer added after creation", async () => {
  const dir = repository();
  let wt;
  try {
    wt = await createWorktree(dir, "codex", "t-added-commondir");
    // A commondir pointer redirects Git to the source repo's object/ref store without
    // touching the alternates fingerprint; validation must still reject it.
    assert.equal(existsSync(join(wt.path, ".git", "commondir")), false);
    writeFileSync(join(wt.path, ".git", "commondir"), `${join(dir, ".git")}\n`);
    await assert.rejects(() => assertExecutionRepository(wt), /common directory changed/);
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("execution metadata redirects are rejected before trusted Git operations", async (t) => {
  const dir = repository();
  let wt;
  try {
    wt = await createWorktree(dir, "codex", "t-metadata-link");
    try { symlinkSync(join(wt.path, "README.md"), join(wt.path, ".git", "metadata-link"), "file"); }
    catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`symlink creation is unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
    await assert.rejects(() => assertExecutionRepository(wt), /metadata contains a redirect/);
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup refuses non-Codebate branches and preserves the user branch", async () => {
  const dir = repository();
  try {
    git(dir, "branch", "release/keep");
    const cleanup = await removeWorktree(dir, join(dir, ".agent-workspaces", "release", "keep"), "release/keep");
    assert.equal(cleanup.ok, false);
    assert.match(cleanup.errors.join("\n"), /cleanup safety check/);
    assert.equal(git(dir, "rev-parse", "--verify", "refs/heads/release/keep").trim().length > 0, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup rejects dot-segment branches without deleting outside the execution root", async () => {
  const dir = repository();
  const projectPath = await fsPromises.realpath(dir);
  const victim = join(projectPath, "victim");
  const sentinel = join(victim, "keep.txt");
  mkdirSync(join(projectPath, ".agent-workspaces"), { recursive: true });
  mkdirSync(victim);
  writeFileSync(sentinel, "keep\n");
  try {
    const cleanup = await removeWorktree(projectPath, victim, "agent/../victim", { isolation: "clone" });
    assert.equal(cleanup.ok, false);
    assert.match(cleanup.errors.join("\n"), /cleanup safety check/);
    assert.equal(readFileSync(sentinel, "utf8"), "keep\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanup refuses a redirected clone target without deleting its destination", async (t) => {
  const dir = repository();
  const outside = mkdtempSync(join(tmpdir(), "ar-cleanup-outside-"));
  const sentinel = join(outside, "keep.txt");
  const providerRoot = join(dir, ".agent-workspaces", "codex");
  const redirected = join(providerRoot, "t-cleanup-link");
  mkdirSync(providerRoot, { recursive: true });
  writeFileSync(sentinel, "keep\n");
  try {
    try { symlinkSync(outside, redirected, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.skip(`directory links are unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    const cleanup = await removeWorktree(
      dir,
      redirected,
      "agent/codex/t-cleanup-link",
      { isolation: "clone" },
    );
    assert.equal(cleanup.ok, false, "redirected clone cleanup must fail closed");
    assert.equal(readFileSync(sentinel, "utf8"), "keep\n");
  } finally {
    try { if (lstatSync(redirected).isSymbolicLink()) unlinkSync(redirected); }
    catch {}
    rmSync(outside, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Git identity and publication configuration drift block acceptance", async () => {
  const dir = repository();
  let wt;
  try {
    wt = await createWorktree(dir, "claude", "t-config");
    git(dir, "config", "user.name", "Unexpected Author");
    await assert.rejects(() => assertProjectReady(dir, wt), /identity changed/);
    git(dir, "config", "user.name", "Project Owner");
    git(dir, "config", "core.hooksPath", "untrusted-hooks");
    await assert.rejects(() => assertProjectReady(dir, wt), /hooks, SSH, or signing/);
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent accept and reject produce one durable terminal decision", async () => {
  const dir = repository();
  const session = await createSession("decision race");
  let wt;
  try {
    wt = await createWorktree(dir, "codex", "t-decision-race");
    writeFileSync(join(wt.path, "feature.js"), "export const accepted = true;\n");
    const reviewedTree = await stageAcceptedTree(wt.path, wt.baseSha);
    const identity = await projectIdentity(dir);
    session.project = { path: identity.realPath, fingerprint: identity.fingerprint, trusted: true };
    session.executions = [{
      taskId: "t-decision-race",
      task: "add accepted feature",
      worktree: wt,
      status: "awaiting_user",
      review: { text: "APPROVE" },
      diff: { files: "A feature.js", stat: "", patch: "" },
      projectPath: identity.realPath,
      projectFingerprint: identity.fingerprint,
      reviewedTree,
    }];
    await saveSession(session);

    const results = await Promise.allSettled([
      acceptExecution(session.id, "t-decision-race", "merge"),
      rejectExecution(session.id, "t-decision-race"),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);

    const saved = await getSession(session.id);
    const winner = saved.executions[0].decision;
    assert.ok(["merge", "reject"].includes(winner));
    if (winner === "merge") {
      assert.equal(saved.executions[0].status, "merged");
      assert.equal(git(dir, "show", "HEAD:feature.js"), "export const accepted = true;\n");
    } else {
      assert.equal(saved.executions[0].status, "rejected");
      assert.throws(() => git(dir, "show", "HEAD:feature.js"));
    }
    wt = null; // either terminal decision cleaned it up
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(join(rootPath(), "data", "sessions", `${session.id}.json`), { force: true });
    rmSync(join(rootPath(), "data", "sessions", `${session.id}.summary.json`), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PR preflight rejects a non-GitHub origin without recording acceptance", async () => {
  const dir = repository();
  const session = await createSession("PR preflight");
  let wt;
  try {
    git(dir, "remote", "add", "origin", "https://gitlab.com/example/project.git");
    wt = await createWorktree(dir, "codex", "t-pr-preflight");
    writeFileSync(join(wt.path, "feature.js"), "export const ready = true;\n");
    const reviewedTree = await stageAcceptedTree(wt.path, wt.baseSha);
    const identity = await projectIdentity(dir);
    session.project = { path: identity.realPath, fingerprint: identity.fingerprint, trusted: true };
    session.executions = [{
      taskId: "t-pr-preflight",
      task: "publish accepted feature",
      worktree: wt,
      reviewedTree,
      status: "awaiting_user",
      review: { text: "APPROVE" },
      diff: { files: "A feature.js", stat: "", patch: "" },
      projectPath: identity.realPath,
      projectFingerprint: identity.fingerprint,
    }];
    await saveSession(session);

    await assert.rejects(() => acceptExecution(session.id, "t-pr-preflight", "pr"), /canonical GitHub/);
    const saved = await getSession(session.id);
    assert.equal(saved.executions[0].status, "awaiting_user");
    assert.equal(saved.executions[0].decision, undefined);
    assert.equal(saved.executions[0].acceptedAt, undefined);
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(join(rootPath(), "data", "sessions", `${session.id}.json`), { force: true });
    rmSync(join(rootPath(), "data", "sessions", `${session.id}.summary.json`), { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const crashWindow of ["ref-only", "ref-and-index"]) {
  test(`accepted merge retry repairs the ${crashWindow} crash window`, async () => {
    const dir = repository();
    let wt;
    try {
      wt = await createWorktree(dir, "codex", `t-recover-${crashWindow}`);
      writeFileSync(join(wt.path, "recovered.js"), "export const recovered = true;\n");
      const accepted = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "recover accepted merge" });
      git(dir, "update-ref", wt.approval.baseRef, accepted.commitSha, wt.baseSha);
      if (crashWindow === "ref-and-index") git(dir, "read-tree", "--reset", "-u", accepted.commitSha);

      await assertProjectReady(dir, wt, { acceptedCommit: accepted.commitSha });
      await mergeBranch(dir, wt, accepted.commitSha);
      assert.equal(git(dir, "status", "--porcelain").trim(), "");
      assert.equal(git(dir, "show", "HEAD:recovered.js"), "export const recovered = true;\n");
    } finally {
      if (wt) await removeWorktree(dir, wt.path, wt.branch);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("merge precondition failures never rewrite a newer or different checkout", async () => {
  for (const scenario of ["target-moved", "branch-switched"]) {
    const dir = repository();
    let wt;
    try {
      wt = await createWorktree(dir, "codex", `t-precondition-${scenario}`);
      writeFileSync(join(wt.path, "accepted.js"), "export const accepted = true;\n");
      const accepted = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "accepted candidate" });
      if (scenario === "target-moved") {
        writeFileSync(join(dir, "newer.js"), "export const newer = true;\n");
        git(dir, "add", "newer.js");
        git(dir, "commit", "-qm", "newer main");
      } else {
        git(dir, "switch", "-qc", "other");
        writeFileSync(join(dir, "other.txt"), "other branch\n");
        git(dir, "add", "other.txt");
        git(dir, "commit", "-qm", "other branch content");
      }
      const beforeHead = git(dir, "rev-parse", "HEAD").trim();
      const beforeTree = git(dir, "rev-parse", "HEAD^{tree}").trim();
      await assert.rejects(() => mergeBranch(dir, wt, accepted.commitSha), /moved before merge|checked-out branch changed/);
      assert.equal(git(dir, "rev-parse", "HEAD").trim(), beforeHead);
      assert.equal(git(dir, "write-tree").trim(), beforeTree);
      assert.equal(git(dir, "status", "--porcelain").trim(), "");
    } finally {
      if (wt) await removeWorktree(dir, wt.path, wt.branch);
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("startup removes only Codebate index locks, never an external Git lock", async () => {
  const dir = repository();
  const lockPath = join(dir, ".git", "index.lock");
  try {
    writeFileSync(lockPath, "external git lock");
    assert.equal(await recoverCodebateIndexLock(dir), false);
    assert.equal(existsSync(lockPath), true);
    rmSync(lockPath, { force: true });
    const indexPath = join(dir, ".git", "index");
    const indexBytes = readFileSync(indexPath);
    const staleTemporary = `${indexPath}.codebate-stale`;
    writeFileSync(lockPath, indexBytes);
    writeFileSync(staleTemporary, indexBytes);
    writeFileSync(`${lockPath}.codebate-intent`, JSON.stringify({
      phase: "installing", temporaryIndex: staleTemporary, indexCommit: git(dir, "rev-parse", "HEAD").trim(),
      targetRef: git(dir, "symbolic-ref", "HEAD").trim(), baseSha: git(dir, "rev-parse", "HEAD").trim(), commitSha: git(dir, "rev-parse", "HEAD").trim(),
      lockSha256: createHash("sha256").update(indexBytes).digest("hex"),
      lockIdentity: { dev: "different", ino: "different", birthtimeNs: "different" },
    }));
    assert.equal(await recoverCodebateIndexLock(dir), false);
    assert.equal(existsSync(lockPath), true, "same-content external lock must survive stale Codebate intent");
    rmSync(lockPath, { force: true });
    rmSync(staleTemporary, { force: true });
    writeFileSync(lockPath, JSON.stringify({ codebate: true, nonce: "test-nonce" }));
    assert.equal(await recoverCodebateIndexLock(dir), true);
    assert.equal(existsSync(lockPath), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("startup finishes an accepted index after a crash following worktree refresh", async () => {
  const dir = repository();
  let wt;
  const temporaryIndex = join(dir, ".git", "index.codebate-fault");
  const lockPath = join(dir, ".git", "index.lock");
  const intentPath = `${lockPath}.codebate-intent`;
  try {
    wt = await createWorktree(dir, "codex", "t-refresh-crash");
    writeFileSync(join(wt.path, "after-crash.js"), "export const recovered = true;\n");
    const accepted = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "accepted before crash" });
    git(dir, "update-ref", wt.approval.baseRef, accepted.commitSha, wt.baseSha);
    execFileSync("git", ["read-tree", wt.baseSha], { cwd: dir, env: { ...process.env, GIT_INDEX_FILE: temporaryIndex } });
    execFileSync("git", ["read-tree", "--reset", "-u", accepted.commitSha], { cwd: dir, env: { ...process.env, GIT_INDEX_FILE: temporaryIndex } });
    writeFileSync(lockPath, JSON.stringify({ codebate: true, nonce: "fault-nonce" }));
    writeFileSync(intentPath, JSON.stringify({
      codebate: true, nonce: "fault-nonce", phase: "refreshing", temporaryIndex,
      indexCommit: accepted.commitSha, targetRef: wt.approval.baseRef, baseSha: wt.baseSha, commitSha: accepted.commitSha,
      previousIndexSha256: createHash("sha256").update(readFileSync(join(dir, ".git", "index"))).digest("hex"),
    }));

    assert.equal(await recoverCodebateIndexLock(dir), true);
    assert.equal(git(dir, "status", "--porcelain").trim(), "");
    assert.equal(git(dir, "show", "HEAD:after-crash.js"), "export const recovered = true;\n");
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup rebuilds a stale temporary index after the target ref advances", async () => {
  const dir = repository();
  let wt;
  const temporaryIndex = join(dir, ".git", "index.codebate-stale-refresh");
  try {
    wt = await createWorktree(dir, "codex", "t-stale-refresh");
    writeFileSync(join(wt.path, "rebuilt.js"), "export const rebuilt = true;\n");
    const accepted = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "accepted before stale refresh" });
    writeRefOnlyRecoveryState({ dir, worktree: wt, accepted, temporaryIndex, nonce: "stale-refresh-nonce" });

    assert.equal(await recoverCodebateIndexLock(dir), true);
    assert.equal(git(dir, "write-tree").trim(), git(dir, "rev-parse", `${accepted.commitSha}^{tree}`).trim());
    assert.equal(git(dir, "status", "--porcelain").trim(), "");
    assert.equal(readFileSync(join(dir, "rebuilt.js"), "utf8").replace(/\r\n/g, "\n"), "export const rebuilt = true;\n");
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup rebuilds a stale temporary index when the accepted commit modifies a tracked file", async () => {
  const dir = repository();
  let wt;
  const temporaryIndex = join(dir, ".git", "index.codebate-stale-modification");
  try {
    wt = await createWorktree(dir, "codex", "t-stale-modification");
    writeFileSync(join(wt.path, "README.md"), "accepted tracked content\n");
    const accepted = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "accepted tracked modification" });
    writeRefOnlyRecoveryState({ dir, worktree: wt, accepted, temporaryIndex, nonce: "stale-modification-nonce" });

    assert.equal(await recoverCodebateIndexLock(dir), true);
    assert.equal(readFileSync(join(dir, "README.md"), "utf8").replace(/\r\n/g, "\n"), "accepted tracked content\n");
    assert.equal(git(dir, "status", "--porcelain").trim(), "");
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale-index recovery preserves a user edit that overlaps the accepted change", async () => {
  const dir = repository();
  let wt;
  const temporaryIndex = join(dir, ".git", "index.codebate-stale-user-edit");
  try {
    wt = await createWorktree(dir, "codex", "t-stale-user-edit");
    writeFileSync(join(wt.path, "README.md"), "accepted content\n");
    const accepted = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "accepted before overlapping edit" });
    writeRefOnlyRecoveryState({ dir, worktree: wt, accepted, temporaryIndex, nonce: "stale-edit-nonce" });
    writeFileSync(join(dir, "README.md"), "user content after crash\n");

    assert.equal(await recoverCodebateIndexLock(dir), true);
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "user content after crash\n");
    assert.equal(git(dir, "write-tree").trim(), git(dir, "rev-parse", `${accepted.commitSha}^{tree}`).trim());
    assert.match(git(dir, "status", "--porcelain"), /README\.md/);
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale-index recovery carries accepted files forward beside a non-overlapping user edit", async () => {
  const dir = repository();
  let wt;
  const temporaryIndex = join(dir, ".git", "index.codebate-stale-non-overlap");
  try {
    wt = await createWorktree(dir, "codex", "t-stale-non-overlap");
    writeFileSync(join(wt.path, "forward.js"), "export const forward = true;\n");
    const accepted = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "accepted beside later user edit" });
    writeRefOnlyRecoveryState({ dir, worktree: wt, accepted, temporaryIndex, nonce: "stale-non-overlap-nonce" });
    writeFileSync(join(dir, "README.md"), "user content after crash\n");

    assert.equal(await recoverCodebateIndexLock(dir), true);
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "user content after crash\n");
    assert.equal(readFileSync(join(dir, "forward.js"), "utf8").replace(/\r\n/g, "\n"), "export const forward = true;\n");
    assert.equal(git(dir, "write-tree").trim(), git(dir, "rev-parse", `${accepted.commitSha}^{tree}`).trim());
    assert.equal(git(dir, "status", "--porcelain").trim(), "M README.md");
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merge refuses to overwrite an ignored user file added by the accepted commit", async () => {
  const dir = repository();
  let wt;
  try {
    addIgnoredUserFile(dir, "local.txt");
    wt = await createWorktree(dir, "codex", "t-ignored-collision");
    writeFileSync(join(wt.path, ".gitignore"), ".agent-workspaces/\n");
    writeFileSync(join(wt.path, "local.txt"), "accepted content\n");
    const accepted = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "accepted ignored collision" });

    await assert.rejects(() => mergeBranch(dir, wt, accepted.commitSha), /overwrite an untracked or ignored project file/);
    assert.equal(readFileSync(join(dir, "local.txt"), "utf8"), "user content\n");
    assert.equal(git(dir, "rev-parse", "HEAD").trim(), wt.baseSha);
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merge preserves an ignored file created after its collision preflight", async (t) => {
  const dir = repository();
  let wt;
  try {
    writeFileSync(join(dir, ".gitignore"), ".agent-workspaces/\nlate.txt\n");
    git(dir, "add", ".gitignore");
    git(dir, "commit", "-qm", "ignore late file");
    wt = await createWorktree(dir, "codex", "t-late-ignored-collision");
    writeFileSync(join(wt.path, ".gitignore"), ".agent-workspaces/\n");
    writeFileSync(join(wt.path, "late.txt"), "accepted content\n");
    const accepted = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "accepted late collision" });
    const intentPath = join(dir, ".git", "index.lock.codebate-intent");
    const rename = fsPromises.rename.bind(fsPromises);
    let collisionCreated = false;
    t.mock.method(fsPromises, "rename", async (source, destination) => {
      const phase = destination === intentPath ? JSON.parse(readFileSync(source, "utf8")).phase : "";
      await rename(source, destination);
      if (phase === "refreshing" && !collisionCreated) {
        writeFileSync(join(dir, "late.txt"), "late user content\n");
        collisionCreated = true;
      }
    });

    await assert.rejects(() => mergeBranch(dir, wt, accepted.commitSha), /overwrite an untracked or ignored project file/);
    assert.equal(collisionCreated, true);
    assert.equal(readFileSync(join(dir, "late.txt"), "utf8"), "late user content\n");
    assert.equal(git(dir, "rev-parse", "HEAD").trim(), accepted.commitSha);

    assert.equal(await recoverCodebateIndexLock(dir), true);
    assert.equal(readFileSync(join(dir, "late.txt"), "utf8"), "late user content\n");
    assert.equal(git(dir, "write-tree").trim(), git(dir, "rev-parse", `${accepted.commitSha}^{tree}`).trim());
    assert.match(git(dir, "status", "--porcelain"), /late\.txt/);
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merge writes the complete index when the filesystem returns a short write", async (t) => {
  const dir = repository();
  let wt;
  try {
    wt = await createWorktree(dir, "codex", "t-short-index-write");
    writeFileSync(join(wt.path, "complete.js"), "export const complete = true;\n");
    const accepted = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "complete index write" });
    const lockPath = join(dir, ".git", "index.lock");
    const open = fsPromises.open.bind(fsPromises);
    let shortWriteInjected = false;
    t.mock.method(fsPromises, "open", async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) !== lockPath || args[1] !== "r+") return handle;
      const write = handle.write.bind(handle);
      handle.write = async (buffer, offset, length, position) => {
        if (!shortWriteInjected && length > 1) {
          shortWriteInjected = true;
          return write(buffer, offset, Math.floor(length / 2), position);
        }
        return write(buffer, offset, length, position);
      };
      return handle;
    });

    await mergeBranch(dir, wt, accepted.commitSha);
    assert.equal(shortWriteInjected, true);
    assert.equal(git(dir, "write-tree").trim(), git(dir, "rev-parse", `${accepted.commitSha}^{tree}`).trim());
    assert.equal(git(dir, "status", "--porcelain").trim(), "");
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merge collision checks honor case-insensitive repository paths", async () => {
  const dir = repository();
  let wt;
  try {
    addIgnoredUserFile(dir, "local.txt");
    git(dir, "config", "core.ignoreCase", "true");
    wt = await createWorktree(dir, "codex", "t-case-collision");
    writeFileSync(join(wt.path, ".gitignore"), ".agent-workspaces/\n");
    writeFileSync(join(wt.path, "LOCAL.txt"), "accepted content\n");
    const accepted = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "accepted case-only collision" });

    await assert.rejects(() => mergeBranch(dir, wt, accepted.commitSha), /overwrite an untracked or ignored project file/);
    assert.equal(readFileSync(join(dir, "local.txt"), "utf8"), "user content\n");
    assert.equal(git(dir, "rev-parse", "HEAD").trim(), wt.baseSha);
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merge collision checks block an untracked file in an accepted path's parent", async () => {
  const dir = repository();
  let wt;
  try {
    addIgnoredUserFile(dir, "local");
    wt = await createWorktree(dir, "codex", "t-parent-collision");
    writeFileSync(join(wt.path, ".gitignore"), ".agent-workspaces/\n");
    mkdirSync(join(wt.path, "local"));
    writeFileSync(join(wt.path, "local", "accepted.txt"), "accepted content\n");
    const accepted = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "accepted parent-path collision" });

    await assert.rejects(() => mergeBranch(dir, wt, accepted.commitSha), /overwrite an untracked or ignored project file/);
    assert.equal(readFileSync(join(dir, "local"), "utf8"), "user content\n");
    assert.equal(git(dir, "rev-parse", "HEAD").trim(), wt.baseSha);
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merge collision checks find descendants beyond a neighboring path", async () => {
  const dir = repository();
  let wt;
  try {
    mkdirSync(join(dir, "a"));
    writeFileSync(join(dir, "a", "tracked.txt"), "tracked\n");
    writeFileSync(join(dir, ".gitignore"), ".agent-workspaces/\na/b\na-\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "prepare nested ignored paths");
    writeFileSync(join(dir, "a", "b"), "nested user content\n");
    writeFileSync(join(dir, "a-"), "neighbor user content\n");

    wt = await createWorktree(dir, "codex", "t-descendant-collision");
    rmSync(join(wt.path, "a"), { recursive: true, force: true });
    writeFileSync(join(wt.path, "a"), "accepted content\n");
    writeFileSync(join(wt.path, ".gitignore"), ".agent-workspaces/\n");
    const accepted = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "accepted descendant collision" });

    await assert.rejects(() => mergeBranch(dir, wt, accepted.commitSha), /overwrite an untracked or ignored project file/);
    assert.equal(readFileSync(join(dir, "a", "b"), "utf8"), "nested user content\n");
    assert.equal(readFileSync(join(dir, "a-"), "utf8"), "neighbor user content\n");
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale-index recovery preserves an ignored file that collides with an accepted addition", async () => {
  const dir = repository();
  let wt;
  const temporaryIndex = join(dir, ".git", "index.codebate-ignored-collision");
  try {
    addIgnoredUserFile(dir, "local.txt");
    wt = await createWorktree(dir, "codex", "t-recovery-ignored-collision");
    writeFileSync(join(wt.path, ".gitignore"), ".agent-workspaces/\n");
    writeFileSync(join(wt.path, "local.txt"), "accepted content\n");
    const accepted = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "accepted ignored recovery collision" });
    writeRefOnlyRecoveryState({ dir, worktree: wt, accepted, temporaryIndex, nonce: "ignored-collision-nonce" });

    assert.equal(await recoverCodebateIndexLock(dir), true);
    assert.equal(readFileSync(join(dir, "local.txt"), "utf8"), "user content\n");
    assert.equal(git(dir, "write-tree").trim(), git(dir, "rev-parse", `${accepted.commitSha}^{tree}`).trim());
    assert.match(git(dir, "status", "--porcelain"), /local\.txt/);
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup index recovery preserves project edits made while the app was down", async () => {
  const dir = repository();
  let wt;
  const temporaryIndex = join(dir, ".git", "index.codebate-user-edit");
  const lockPath = join(dir, ".git", "index.lock");
  try {
    wt = await createWorktree(dir, "codex", "t-refresh-user-edit");
    writeFileSync(join(wt.path, "preserved.js"), "export const accepted = true;\n");
    const accepted = await prepareAcceptedChange({ projectPath: dir, worktree: wt, message: "accepted before crash" });
    git(dir, "update-ref", wt.approval.baseRef, accepted.commitSha, wt.baseSha);
    execFileSync("git", ["read-tree", wt.baseSha], { cwd: dir, env: { ...process.env, GIT_INDEX_FILE: temporaryIndex } });
    execFileSync("git", ["read-tree", "--reset", "-u", accepted.commitSha], { cwd: dir, env: { ...process.env, GIT_INDEX_FILE: temporaryIndex } });
    writeFileSync(join(dir, "preserved.js"), "user edit after crash\n");
    writeFileSync(lockPath, JSON.stringify({ codebate: true, nonce: "edit-nonce" }));
    writeFileSync(`${lockPath}.codebate-intent`, JSON.stringify({
      codebate: true, nonce: "edit-nonce", phase: "refreshing", temporaryIndex,
      indexCommit: accepted.commitSha, targetRef: wt.approval.baseRef, baseSha: wt.baseSha, commitSha: accepted.commitSha,
    }));

    assert.equal(await recoverCodebateIndexLock(dir), true);
    assert.equal(readFileSync(join(dir, "preserved.js"), "utf8"), "user edit after crash\n");
    assert.match(git(dir, "status", "--porcelain"), /preserved\.js/);
  } finally {
    if (wt) await removeWorktree(dir, wt.path, wt.branch);
    rmSync(dir, { recursive: true, force: true });
  }
});
