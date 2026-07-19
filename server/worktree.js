import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { resolveAllowedCommand, runProcess } from "./process.js";
import { redact } from "./logger.js";
import { isGitHubRemote } from "./github-remote.js";
import { EXEC_STOPPED_MESSAGE } from "./exec-state.js";
import { executionWorkspacesRoot } from "./store.js";

const SAFE = /^[a-zA-Z0-9_.-]+$/;
const EXECUTION_BRANCH = /^agent\/([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/;

function isSafeExecutionComponent(value) {
  return typeof value === "string" && SAFE.test(value) && value !== "." && value !== "..";
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function normalizedPath(value) {
  const resolved = path.normalize(path.resolve(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// Disposable execution clones live under the app runtime dir, namespaced by a short hash of the canonical
// project path — OUT of the project tree, so the real repo is never a `cd ..` away from an executor and
// never shows up in the project's git status. Records created before this move used an in-tree root
// (<project>/.agent-workspaces); cleanup and reconciliation still recognize that legacy root too.
export function projectWorkspaceKey(projectPath) {
  return digest(normalizedPath(projectPath)).slice(0, 16);
}

function legacyExecutionRoot(canonicalProject) {
  return path.join(canonicalProject, ".agent-workspaces");
}

function currentExecutionRootFor(canonicalProject) {
  return path.join(executionWorkspacesRoot(), projectWorkspaceKey(canonicalProject));
}

async function executionLocation(projectPath, wtPath, branch) {
  const match = String(branch || "").match(EXECUTION_BRANCH);
  if (!match || !isSafeExecutionComponent(match[1]) || !isSafeExecutionComponent(match[2])) return null;
  // The out-of-tree root is keyed off the (canonical) project path, so a clone stays cleanable even after
  // its project folder is deleted. The legacy in-tree root only exists while the project does. Accept both
  // so an execution created before the relocation stays cleanable; the branch <-> path binding must match
  // exactly for exactly one of them. Safety for the out-of-tree root comes from it living under the
  // app-owned exec root (validated again in removeWorktree), not from the project realpath.
  let canonicalProject = null;
  try { canonicalProject = await fs.realpath(projectPath); }
  catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
  const candidates = [currentExecutionRootFor(canonicalProject ?? path.resolve(projectPath))];
  if (canonicalProject) candidates.push(legacyExecutionRoot(canonicalProject));
  for (const root of candidates) {
    const expected = path.join(root, match[1], match[2]);
    if (isPathInside(root, expected) && normalizedPath(expected) === normalizedPath(wtPath)) {
      return { root, agent: match[1], taskId: match[2], expected };
    }
  }
  return null;
}

async function ensureExecutionRoot(projectPath) {
  const canonicalProject = await fs.realpath(projectPath);
  const root = currentExecutionRootFor(canonicalProject);
  try {
    const info = await fs.lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Execution workspaces directory must be a real directory");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
  }
  const canonical = await fs.realpath(root);
  if (normalizedPath(canonical) !== normalizedPath(root)) throw new Error("Execution workspaces directory cannot redirect elsewhere");
  return canonical;
}

async function assertRealDirectory(directory, label) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
  const canonical = await fs.realpath(directory);
  if (normalizedPath(canonical) !== normalizedPath(directory)) throw new Error(`${label} cannot redirect outside its approved location`);
  return canonical;
}

async function ensureRealDirectory(directory, label) {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  return assertRealDirectory(directory, label);
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Reads an optional Git metadata file, treating "absent" as empty. A fresh --no-local clone
// has neither an alternates file nor a commondir pointer, so an empty result is the expected,
// safe baseline; a non-empty one is either rejected at creation or caught on change.
async function readOptionalGitMetadata(filePath) {
  try { return await fs.readFile(filePath); }
  catch (error) {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
}

const alternatesPath = (gitDir) => path.join(gitDir, "objects", "info", "alternates");
// .git/commondir redirects object/ref/config resolution to an external "common" directory.
// A standalone clone has none; a written one would re-link the clone to the source repo.
const commonDirPath = (gitDir) => path.join(gitDir, "commondir");

async function assertRealMetadataTree(root) {
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Execution repository metadata contains a redirect");
  const pending = [root];
  let entries = 0;
  while (pending.length) {
    const current = pending.pop();
    for await (const entry of await fs.opendir(current)) {
      if (++entries > 100000) throw new Error("Execution repository metadata is unexpectedly large");
      const entryPath = path.join(current, entry.name);
      const info = await fs.lstat(entryPath);
      if (info.isSymbolicLink()) throw new Error("Execution repository metadata contains a redirect");
      if (info.isDirectory()) pending.push(entryPath);
      else if (!info.isFile()) throw new Error("Execution repository metadata contains an unsupported entry");
    }
  }
}

async function git(args, cwd, env = {}, input = "", options = {}) {
  const command = await resolveAllowedCommand("git", new Set(["git"]));
  const protectedArgs = args[0] === "config"
    ? args
    : ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=", "-c", "diff.external=", ...args];
  const execution = await runProcess({
    command,
    args: protectedArgs,
    cwd,
    env,
    envPolicy: options.envPolicy || "agent",
    input,
    timeoutMs: 120000,
    maxOutputBytes: options.maxOutputBytes,
    binaryOutput: options.binaryOutput,
    // When the execution pipeline passes a registrar, the clone/checkout processes become
    // killable mid-flight so an accepted Stop terminates them instead of racing them to finish.
    registerChild: options.registerChild,
  });
  if (execution.code !== 0) throw new Error(redact(execution.stderr || `git exited with code ${execution.code}`).trim());
  return execution;
}

async function optionalGitValue(args, cwd) {
  try { return (await git(args, cwd)).stdout.trim(); }
  catch { return ""; }
}

function fingerprint(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function publicationContext(projectPath) {
  const [baseRef, authorName, authorEmail, remoteUrl, hooksPath, sshCommand, signingKey, signingEnabled, dangerousLocalConfig] = await Promise.all([
    optionalGitValue(["symbolic-ref", "-q", "HEAD"], projectPath),
    optionalGitValue(["config", "--get", "user.name"], projectPath),
    optionalGitValue(["config", "--get", "user.email"], projectPath),
    optionalGitValue(["remote", "get-url", "origin"], projectPath),
    optionalGitValue(["config", "--get", "core.hooksPath"], projectPath),
    optionalGitValue(["config", "--get", "core.sshCommand"], projectPath),
    optionalGitValue(["config", "--get", "user.signingKey"], projectPath),
    optionalGitValue(["config", "--get", "commit.gpgSign"], projectPath),
    optionalGitValue(["config", "--local", "--name-only", "--get-regexp", "^(alias\\.|include\\.|credential\\.|filter\\.|core\\.(fsmonitor|sshcommand|attributesfile)|diff\\.external|protocol\\.|url\\.)"], projectPath),
  ]);
  if (!baseRef) throw new Error("Project must be on a named branch before execution");
  if (!authorName || !authorEmail) throw new Error("Configure Git user.name and user.email before execution");
  if (dangerousLocalConfig) throw new Error(`Repository-local executable Git configuration is not allowed: ${dangerousLocalConfig.split(/\r?\n/)[0]}`);
  const configFingerprint = fingerprint({ hooksPath, sshCommand, signingKey, signingEnabled });
  return { baseRef, authorName, authorEmail, remoteUrl, remoteFingerprint: fingerprint(remoteUrl), configFingerprint };
}

export async function isGitRepo(projectPath) {
  try { const { stdout } = await git(["rev-parse", "--is-inside-work-tree"], projectPath); return stdout.trim() === "true"; }
  catch { return false; }
}

// The regular Git transport copies reachable source objects so the disposable executor clone
// never depends on the source repository's object storage.
export async function createWorktree(projectPath, agent, taskId, { registerChild, isCancelled } = {}) {
  // A Stop accepted between pipeline stages must abort before the next git process starts (checked
  // via abortIfCancelled) and kill any that is already running (gitStep threads registerChild so the
  // clone/checkout are killable). The read-only probes below (isGitRepo, rev-parse, publicationContext)
  // run against the trusted SOURCE repo before the disposable clone exists — they're fast and carry no
  // registerChild by design, so the only cancellation cost there is a little wasted work before the
  // pre-clone gate throws.
  const abortIfCancelled = () => { if (isCancelled?.()) throw new Error(EXEC_STOPPED_MESSAGE); };
  const gitStep = (args, cwd) => git(args, cwd, {}, "", { registerChild });
  if (!isSafeExecutionComponent(agent) || !isSafeExecutionComponent(taskId)) throw new Error("Invalid agent/taskId");
  abortIfCancelled();
  if (!(await isGitRepo(projectPath))) throw new Error("Project is not a git repository");
  const { stdout: sha } = await git(["rev-parse", "HEAD"], projectPath);
  const baseSha = sha.trim();
  const approval = await publicationContext(projectPath);
  const executionRoot = await ensureExecutionRoot(projectPath);
  const agentRoot = await ensureRealDirectory(path.join(executionRoot, agent), "Execution provider directory");
  const wtPath = path.join(agentRoot, taskId);
  const branch = `agent/${agent}/${taskId}`;
  try {
    await fs.lstat(wtPath);
    throw new Error("Execution directory already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    abortIfCancelled();
    await gitStep(["clone", "--no-local", "--no-checkout", "--origin", "codebate-source", projectPath, wtPath], projectPath);
    await assertRealDirectory(wtPath, "Execution clone");
    await gitStep(["remote", "remove", "codebate-source"], wtPath);
    abortIfCancelled();
    await gitStep(["switch", "-c", branch, baseSha], wtPath);
    const canonical = await fs.realpath(wtPath);
    if (normalizedPath(canonical) !== normalizedPath(wtPath)) throw new Error("Execution clone escaped its approved directory");
    const gitDir = path.join(wtPath, ".git");
    await assertRealMetadataTree(gitDir);
    const [config, alternates, commonDir] = await Promise.all([
      fs.readFile(path.join(gitDir, "config")),
      readOptionalGitMetadata(alternatesPath(gitDir)),
      readOptionalGitMetadata(commonDirPath(gitDir)),
    ]);
    // Best-effort integrity checks, not confidentiality boundaries: a clone made with
    // --no-local has no alternates file and no commondir pointer, so either one here signals
    // that the clone would resolve objects through the source repo. They cannot stop an
    // untrusted executor that transiently adds and removes one mid-run (see SECURITY.md — the
    // clone is not an OS sandbox); OS-level isolation owns that. Fingerprinting below still
    // catches a pointer that persists to validation time, before any trusted Git operation.
    if (alternates.length) throw new Error("Execution clone unexpectedly depends on an alternate object store");
    if (commonDir.length) throw new Error("Execution clone unexpectedly redirects to a shared common directory");
    return {
      path: wtPath,
      branch,
      baseSha,
      isolation: "clone",
      cloneConfigFingerprint: digest(config),
      cloneAlternatesFingerprint: digest(alternates),
      cloneCommonDirFingerprint: digest(commonDir),
      approval: {
        baseRef: approval.baseRef,
        authorName: approval.authorName,
        authorEmail: approval.authorEmail,
        remoteFingerprint: approval.remoteFingerprint,
        configFingerprint: approval.configFingerprint,
      },
    };
  } catch (error) {
    const primaryError = error instanceof Error ? error : new Error(String(error));
    const cleanup = await removeWorktree(projectPath, wtPath, branch, { isolation: "clone" }).catch((cleanupError) => ({
      ok: false,
      errors: [redact(cleanupError?.message || cleanupError)],
    }));
    if (!cleanup.ok) primaryError.cleanupErrors = cleanup.errors;
    throw primaryError;
  }
}

export async function assertExecutionRepository(worktree) {
  if (worktree?.isolation !== "clone" || !worktree.cloneConfigFingerprint || !worktree.cloneAlternatesFingerprint || !worktree.cloneCommonDirFingerprint) {
    throw new Error("Execution predates isolated-clone safety; run the task again");
  }
  const gitDir = path.join(worktree.path, ".git");
  await assertRealMetadataTree(gitDir);
  const [gitInfo, objectsInfo, refsInfo, configInfo] = await Promise.all([
    fs.lstat(gitDir),
    fs.lstat(path.join(gitDir, "objects")),
    fs.lstat(path.join(gitDir, "refs")),
    fs.lstat(path.join(gitDir, "config")),
  ]);
  if (!gitInfo.isDirectory() || gitInfo.isSymbolicLink() || !objectsInfo.isDirectory() || objectsInfo.isSymbolicLink() || !refsInfo.isDirectory() || refsInfo.isSymbolicLink() || !configInfo.isFile() || configInfo.isSymbolicLink()) {
    throw new Error("Execution repository metadata changed; discard this run");
  }
  const canonicalGitDir = await fs.realpath(gitDir);
  const expectedPrefix = `${normalizedPath(worktree.path)}${path.sep}`;
  if (!normalizedPath(canonicalGitDir).startsWith(expectedPrefix)) throw new Error("Execution repository metadata escaped its clone");
  const [config, alternates, commonDir] = await Promise.all([
    fs.readFile(path.join(gitDir, "config")),
    readOptionalGitMetadata(alternatesPath(gitDir)),
    readOptionalGitMetadata(commonDirPath(gitDir)),
  ]);
  if (digest(config) !== worktree.cloneConfigFingerprint) throw new Error("Execution repository configuration changed; discard this run");
  if (digest(alternates) !== worktree.cloneAlternatesFingerprint) throw new Error("Execution repository object boundary changed; discard this run");
  if (digest(commonDir) !== worktree.cloneCommonDirFingerprint) throw new Error("Execution repository common directory changed; discard this run");
  return true;
}

// Full diff of what the executor changed since the branch point, plus a compact stat.
// Diffs against baseSha (the branch point) — not HEAD — so it captures changes the agent
// staged AND any it committed itself (which would otherwise move HEAD past them and hide
// them). `add -N` (intent-to-add) makes untracked files show up WITHOUT writing their
// blobs to the object database (nothing is stored until a real commit, after the secret
// scan passes and the user accepts).
export async function getDiff(wtPath, baseSha) {
  const base = baseSha || "HEAD";
  await git(["add", "-A", "-N"], wtPath);
  const { stdout: patch } = await git(["diff", "--no-ext-diff", "--no-textconv", base, "--no-color"], wtPath);
  const { stdout: stat } = await git(["diff", "--no-ext-diff", "--no-textconv", base, "--stat", "--no-color"], wtPath);
  const { stdout: names } = await git(["diff", "--no-ext-diff", "--no-textconv", base, "--name-status", "--no-color"], wtPath);
  return { patch, stat: stat.trim(), files: names.trim() };
}

const MAX_SCAN_BYTES = 2 * 1024 * 1024;

// The changed + new files (since baseSha) with their current on-disk contents, for the
// secret scan. Enumerated with `-z` so non-ASCII names aren't C-quoted. Deleted files are
// skipped; symlinks are NOT followed (a symlink to /dev/zero or a huge file would hang/OOM)
// and only their name is checked; files over MAX_SCAN_BYTES are name-checked only.
export async function changedFiles(wtPath, baseSha) {
  const base = baseSha || "HEAD";
  const names = new Set();
  const { stdout: diffZ } = await git(["diff", base, "--name-only", "-z"], wtPath);
  for (const n of diffZ.split("\0")) if (n) names.add(n);
  const { stdout: untrackedZ } = await git(["ls-files", "--others", "--exclude-standard", "-z"], wtPath);
  for (const n of untrackedZ.split("\0")) if (n) names.add(n);

  const out = [];
  for (const rel of names) {
    const full = path.join(wtPath, rel);
    let st;
    try { st = await fs.lstat(full); } catch { continue; } // deleted / gone — nothing to scan
    if (st.isSymbolicLink() || !st.isFile()) { out.push({ path: rel, content: "" }); continue; }
    // Files over the cap are flagged (oversize) so the scan can surface that they were
    // NOT content-scanned, rather than silently checking only the filename.
    if (st.size > MAX_SCAN_BYTES) { out.push({ path: rel, content: "", oversize: true }); continue; }
    let content = "";
    try { content = await fs.readFile(full, "utf8"); } catch {}
    out.push({ path: rel, content });
  }
  return out;
}

export async function listWorktrees(projectPath) {
  try { const { stdout } = await git(["worktree", "list", "--porcelain"], projectPath); return stdout.trim(); }
  catch { return ""; }
}

// Commit whatever the executor changed onto its branch, so it can be merged / pushed / PR'd.
export async function prepareWorktreeForAccept(wtPath, branch, baseSha) {
  const { stdout: currentBranchName } = await git(["rev-parse", "--abbrev-ref", "HEAD"], wtPath);
  if (currentBranchName.trim() !== branch) throw new Error("Execution worktree branch changed; run the task again");
  await git(["cat-file", "-e", `${baseSha}^{commit}`], wtPath);
  // A run-mode executor may have committed. Collapse those commits back into
  // working-tree changes so the user's accept action creates the one authoritative commit with
  // the user's configured Git identity.
  await git(["reset", "--mixed", baseSha], wtPath);
}

export async function assertWorktreeClean(wtPath) {
  const { stdout } = await git(["status", "--porcelain=v1", "--untracked-files=all"], wtPath);
  if (stdout.trim()) throw new Error("Execution worktree is still dirty after commit");
}

export async function assertProjectReady(projectPath, worktree, { acceptedCommit = "" } = {}) {
  const { stdout: head } = await git(["rev-parse", "HEAD"], projectPath);
  const headSha = head.trim();
  const recoveringAcceptedMerge = Boolean(acceptedCommit && headSha === acceptedCommit);
  if (headSha !== worktree.baseSha && !recoveringAcceptedMerge) throw new Error("Project HEAD changed while the agent was working; run the task again on the new base");
  const context = await publicationContext(projectPath);
  const approval = worktree.approval;
  if (context.baseRef !== approval.baseRef) throw new Error("Project branch changed while the agent was working; switch back or run the task again");
  if (context.authorName !== approval.authorName || context.authorEmail !== approval.authorEmail) throw new Error("Git author identity changed while the agent was working");
  if (context.remoteFingerprint !== approval.remoteFingerprint) throw new Error("Git origin changed while the agent was working");
  if (context.configFingerprint !== approval.configFingerprint) throw new Error("Git hooks, SSH, or signing configuration changed while the agent was working");
  const { stdout: rawStatus } = await git(["status", "--porcelain=v1", "--untracked-files=all"], projectPath);
  const meaningful = rawStatus.split(/\r?\n/).filter(Boolean).filter((line) => {
    const file = line.slice(3).replace(/\\/g, "/");
    return file !== ".agent-workspaces/" && !file.startsWith(".agent-workspaces/");
  });
  if (meaningful.length && recoveringAcceptedMerge) {
    const [{ stdout: unstaged }, { stdout: untracked }, { stdout: indexTree }, { stdout: baseTree }, { stdout: acceptedTree }] = await Promise.all([
      git(["diff", "--name-only", "--no-color"], projectPath),
      git(["ls-files", "--others", "--exclude-standard"], projectPath),
      git(["write-tree"], projectPath),
      git(["rev-parse", `${worktree.baseSha}^{tree}`], projectPath),
      git(["rev-parse", `${acceptedCommit}^{tree}`], projectPath),
    ]);
    const meaningfulUntracked = untracked.split(/\r?\n/).filter(Boolean).filter((file) => !file.replace(/\\/g, "/").startsWith(".agent-workspaces/"));
    const knownCrashIndex = [baseTree.trim(), acceptedTree.trim()].includes(indexTree.trim());
    if (unstaged.trim() || meaningfulUntracked.length || !knownCrashIndex) {
      throw new Error("Project working tree changed after the accepted commit; inspect it before retrying");
    }
  } else if (meaningful.length) {
    throw new Error("Project working tree has uncommitted changes; clean or commit them before accepting");
  }
  return context;
}

export async function stageAcceptedTree(wtPath, baseSha) {
  const { stdout: tracked } = await git(["diff", "--no-ext-diff", "--no-textconv", baseSha, "--name-only", "-z"], wtPath);
  const { stdout: untracked } = await git(["ls-files", "--others", "--exclude-standard", "-z"], wtPath);
  const paths = [...new Set(`${tracked}${untracked}`.split("\0").filter(Boolean))];
  if (paths.length) {
    const attributes = await git(["check-attr", "-z", "filter", "--stdin"], wtPath, {} , `${paths.join("\0")}\0`);
    const fields = attributes.stdout.split("\0");
    for (let index = 0; index + 2 < fields.length; index += 3) {
      const [file, , value] = fields.slice(index, index + 3);
      if (value && value !== "unspecified" && value !== "unset") throw new Error(`External Git clean filters are not allowed during acceptance: ${file}`);
    }
  }
  await git(["add", "-A"], wtPath);
  const { stdout: tree } = await git(["write-tree"], wtPath);
  const { stdout: baseTree } = await git(["rev-parse", `${baseSha}^{tree}`], wtPath);
  if (tree.trim() === baseTree.trim()) throw new Error("The accepted execution has no changes to commit");
  return tree.trim();
}

export async function treeDiff(wtPath, baseSha, treeSha) {
  const { stdout: patch } = await git(["diff", "--no-ext-diff", "--no-textconv", baseSha, treeSha, "--no-color"], wtPath);
  const { stdout: stat } = await git(["diff", "--no-ext-diff", "--no-textconv", baseSha, treeSha, "--stat", "--no-color"], wtPath);
  const { stdout: names } = await git(["diff", "--no-ext-diff", "--no-textconv", baseSha, treeSha, "--name-status", "--no-color"], wtPath);
  return { patch, stat: stat.trim(), files: names.trim() };
}

export async function changedTreeFiles(wtPath, baseSha, treeSha) {
  const raw = await git(["diff", "--raw", "-z", "--no-renames", "--abbrev=64", baseSha, treeSha], wtPath);
  if (raw.stdoutTruncated) throw new Error("Changed-file metadata exceeded the safe scan limit");
  const tokens = raw.stdout.split("\0");
  const entries = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const header = tokens[index];
    const relativePath = tokens[index + 1];
    if (!header || !relativePath) continue;
    const match = header.match(/^:\d+ (\d+) [0-9a-f]+ ([0-9a-f]+) [A-Z]\d*$/i);
    if (!match || /^0+$/.test(match[2])) continue;
    entries.push({ path: relativePath, mode: match[1], sha: match[2] });
  }
  if (entries.length > 5000) throw new Error("Acceptance changes too many files for a safe review");

  const blobs = entries;
  const checked = blobs.length
    ? await git(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], wtPath, {}, `${blobs.map((entry) => entry.sha).join("\n")}\n`)
    : { stdout: "", stdoutTruncated: false };
  if (checked.stdoutTruncated) throw new Error("Blob metadata exceeded the safe scan limit");
  const metadata = checked.stdout.trim() ? checked.stdout.trim().split(/\r?\n/) : [];
  if (metadata.length !== blobs.length) throw new Error("Git returned incomplete blob metadata during secret scanning");

  const MAX_TOTAL_SCAN_BYTES = 24 * 1024 * 1024;
  let scheduledBytes = 0;
  const readable = [];
  for (let index = 0; index < blobs.length; index += 1) {
    const match = metadata[index].match(/^([0-9a-f]+) blob (\d+)$/i);
    if (!match || match[1] !== blobs[index].sha) throw new Error("Git blob metadata changed during secret scanning");
    const size = Number(match[2]);
    blobs[index].size = size;
    if (size <= MAX_SCAN_BYTES && scheduledBytes + size <= MAX_TOTAL_SCAN_BYTES) {
      scheduledBytes += size;
      readable.push(blobs[index]);
    }
  }

  let contents = Buffer.alloc(0);
  if (readable.length) {
    const batch = await git(
      ["cat-file", "--batch"],
      wtPath,
      {},
      `${readable.map((entry) => entry.sha).join("\n")}\n`,
      { binaryOutput: true, maxOutputBytes: MAX_TOTAL_SCAN_BYTES + readable.length * 128 },
    );
    if (batch.stdoutTruncated) throw new Error("Blob contents exceeded the safe scan limit");
    contents = batch.stdoutBuffer;
  }

  const contentByEntry = new Map();
  let cursor = 0;
  for (const entry of readable) {
    const newline = contents.indexOf(10, cursor);
    if (newline === -1) throw new Error("Git returned an incomplete blob header");
    const header = contents.subarray(cursor, newline).toString("utf8");
    const match = header.match(/^([0-9a-f]+) blob (\d+)$/i);
    if (!match || match[1] !== entry.sha || Number(match[2]) !== entry.size) throw new Error("Git blob changed during secret scanning");
    const start = newline + 1;
    const end = start + entry.size;
    if (end >= contents.length || contents[end] !== 10) throw new Error("Git returned incomplete blob contents");
    contentByEntry.set(entry, contents.subarray(start, end).toString("utf8"));
    cursor = end + 1;
  }

  return entries.map((entry) => {
    if (!contentByEntry.has(entry)) return { path: entry.path, content: "", oversize: true };
    const content = contentByEntry.get(entry);
    if (entry.mode === "120000") {
      const components = content.split(/[\\/]/);
      if (path.posix.isAbsolute(content) || path.win32.isAbsolute(content) || path.win32.parse(content).root || components.includes("..")) {
        throw new Error(`Symlink target escapes the accepted project tree: ${entry.path}`);
      }
    }
    return { path: entry.path, content };
  });
}

export async function commitAcceptedTree(wtPath, worktree, treeSha, message, { useReviewedTree = false } = {}) {
  const currentHead = (await git(["rev-parse", "HEAD"], wtPath)).stdout.trim();
  if (!useReviewedTree) {
    const unstaged = (await git(["diff", "--name-only", "--no-color"], wtPath)).stdout.trim();
    if (unstaged) throw new Error("Execution files changed after the accepted snapshot was created; review and accept again");
  }
  const identity = worktree.approval;
  const env = {
    GIT_AUTHOR_NAME: identity.authorName,
    GIT_AUTHOR_EMAIL: identity.authorEmail,
    GIT_COMMITTER_NAME: identity.authorName,
    GIT_COMMITTER_EMAIL: identity.authorEmail,
  };
  const { stdout } = await git(["-c", "commit.gpgSign=false", "commit-tree", treeSha, "-p", worktree.baseSha, "-m", message], wtPath, env);
  const commitSha = stdout.trim();
  await git(["update-ref", `refs/heads/${worktree.branch}`, commitSha, currentHead], wtPath);
  if (!useReviewedTree) {
    try {
      await assertWorktreeClean(wtPath);
    } catch (error) {
      await git(["update-ref", `refs/heads/${worktree.branch}`, currentHead, commitSha], wtPath);
      throw error;
    }
  }
  return commitSha;
}

function acceptedRef(commitSha) {
  if (!/^[0-9a-f]{40,64}$/i.test(String(commitSha || ""))) throw new Error("Accepted commit id is invalid");
  return `refs/codebate/accepted/${commitSha}`;
}

export async function importAcceptedCommit(projectPath, worktree, commitSha, treeSha) {
  await assertExecutionRepository(worktree);
  const ref = acceptedRef(commitSha);
  await git(["fetch", "--no-tags", "--force", worktree.path, `${commitSha}:${ref}`], projectPath);
  const [importedCommit, importedTree, lineage] = await Promise.all([
    optionalGitValue(["rev-parse", ref], projectPath),
    optionalGitValue(["rev-parse", `${ref}^{tree}`], projectPath),
    optionalGitValue(["rev-list", "--parents", "-n", "1", ref], projectPath),
  ]);
  const parts = lineage.split(/\s+/).filter(Boolean);
  if (importedCommit !== commitSha || importedTree !== treeSha || parts.length !== 2 || parts[0] !== commitSha || parts[1] !== worktree.baseSha) {
    await git(["update-ref", "-d", ref], projectPath).catch(() => {});
    throw new Error("Imported execution commit did not match the reviewed tree and base");
  }
  return ref;
}

export async function releaseAcceptedCommit(projectPath, ref, commitSha) {
  if (ref !== acceptedRef(commitSha)) return { ok: false, errors: ["accepted ref failed the cleanup safety check"] };
  try {
    await git(["update-ref", "-d", ref, commitSha], projectPath);
    return { ok: true, errors: [] };
  } catch (error) {
    return { ok: false, errors: [`accepted ref delete: ${error.message}`] };
  }
}

export async function listAcceptedRefs(projectPath) {
  const { stdout } = await git(["for-each-ref", "--format=%(refname)", "refs/codebate/accepted/"], projectPath);
  return stdout.split(/\r?\n/).filter((ref) => /^refs\/codebate\/accepted\/[0-9a-f]{40,64}$/i.test(ref));
}

export async function hasGitHubOrigin(projectPath) {
  try { const { stdout } = await git(["remote", "get-url", "origin"], projectPath); return isGitHubRemote(stdout.trim()); }
  catch { return false; }
}

async function indexPaths(projectPath) {
  const value = (await git(["rev-parse", "--git-path", "index"], projectPath)).stdout.trim();
  const indexPath = path.isAbsolute(value) ? value : path.resolve(projectPath, value);
  return { indexPath, lockPath: `${indexPath}.lock`, intentPath: `${indexPath}.lock.codebate-intent` };
}

async function renameIndexLock(lockPath, indexPath) {
  for (let attempt = 0; ; attempt += 1) {
    try { await fs.rename(lockPath, indexPath); return; }
    catch (error) {
      if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * (2 ** attempt)));
    }
  }
}

async function writeCompleteFile(handle, contents) {
  let offset = 0;
  while (offset < contents.length) {
    const { bytesWritten } = await handle.write(contents, offset, contents.length - offset, offset);
    if (bytesWritten <= 0) throw new Error("Git index lock write made no progress");
    offset += bytesWritten;
  }
}

async function writeIntent(intentPath, value) {
  const temporary = `${intentPath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    for (let attempt = 0; ; attempt += 1) {
      try { await fs.rename(temporary, intentPath); return; }
      catch (error) {
        if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (2 ** attempt)));
      }
    }
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

function nulSeparatedPaths(output) {
  return String(output || "").split("\0").filter(Boolean).map((entry) => entry.replace(/\/$/, ""));
}

function normalizedGitPath(value, ignoreCase) {
  const unicodeNormalized = value.normalize("NFC");
  return ignoreCase ? unicodeNormalized.toLowerCase() : unicodeNormalized;
}

function lowerBound(sorted, target) {
  let start = 0;
  let end = sorted.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (sorted[middle] < target) start = middle + 1;
    else end = middle;
  }
  return start;
}

function gitPathListsOverlap(leftPaths, rightPaths, ignoreCase) {
  const right = [...new Set(rightPaths.map((entry) => normalizedGitPath(entry, ignoreCase)))].sort();
  const rightSet = new Set(right);
  for (const entry of leftPaths) {
    const left = normalizedGitPath(entry, ignoreCase);
    if (rightSet.has(left)) return true;
    for (let slash = left.lastIndexOf("/"); slash > 0; slash = left.lastIndexOf("/", slash - 1)) {
      if (rightSet.has(left.slice(0, slash))) return true;
    }
    const descendantPrefix = `${left}/`;
    const descendant = right[lowerBound(right, descendantPrefix)];
    if (descendant?.startsWith(descendantPrefix)) return true;
  }
  return false;
}

async function acceptedAdditionCollidesWithUntracked(projectPath, baseSha, commitSha) {
  const [added, ignoreCaseSetting] = await Promise.all([
    git(["diff-tree", "--no-commit-id", "--name-only", "-z", "--diff-filter=A", "--no-renames", "-r", baseSha, commitSha], projectPath),
    optionalGitValue(["config", "--bool", "core.ignoreCase"], projectPath),
  ]);
  if (added.stdoutTruncated) throw new Error("The accepted change has too many paths to check safely for merge collisions");
  const additions = nulSeparatedPaths(added.stdout);
  if (additions.length === 0) return false;
  const [visible, ignored] = await Promise.all([
    git(["ls-files", "--others", "--exclude-standard", "--directory", "-z"], projectPath),
    git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"], projectPath),
  ]);
  if (visible.stdoutTruncated || ignored.stdoutTruncated) {
    throw new Error("The project has too many untracked files to check safely for merge collisions");
  }
  const worktreeOnly = [...nulSeparatedPaths(visible.stdout), ...nulSeparatedPaths(ignored.stdout)];
  const ignoreCase = ignoreCaseSetting === "true" || process.platform === "win32";
  return gitPathListsOverlap(additions, worktreeOnly, ignoreCase);
}

async function assertNoAcceptedAdditionCollision(projectPath, baseSha, commitSha) {
  if (await acceptedAdditionCollidesWithUntracked(projectPath, baseSha, commitSha)) {
    throw new Error("The accepted change would overwrite an untracked or ignored project file");
  }
}

async function rebuildInterruptedRefresh(projectPath, indexPath, intent) {
  const lineage = (await git(["rev-list", "--parents", "-n", "1", intent.commitSha], projectPath)).stdout.trim().split(/\s+/);
  if (lineage.length !== 2 || lineage[0] !== intent.commitSha || lineage[1] !== intent.baseSha) {
    throw new Error("Interrupted merge recovery no longer matches the accepted commit lineage");
  }

  const [indexChanges, trackedChanges, untrackedFiles, additionCollision] = await Promise.all([
    git(["diff-index", "--cached", "--name-only", "-z", intent.baseSha], projectPath).then((result) => result.stdout),
    git(["diff-files", "--name-only", "-z"], projectPath).then((result) => result.stdout),
    git(["ls-files", "--others", "--exclude-standard", "-z"], projectPath).then((result) => result.stdout),
    acceptedAdditionCollidesWithUntracked(projectPath, intent.baseSha, intent.commitSha),
  ]);
  if (indexChanges) {
    throw new Error("Interrupted merge recovery found an unexpected project index");
  }

  const temporaryIndex = intent.temporaryIndex;
  const worktreeChanged = Boolean(trackedChanges || untrackedFiles);
  await fs.rm(temporaryIndex, { force: true });
  await fs.rm(`${temporaryIndex}.lock`, { force: true });
  // The validated real index carries worktree stat and sparse-checkout bits
  // that a freshly read tree does not. Preserve them for the safe two-tree update.
  await fs.copyFile(indexPath, temporaryIndex);
  if (additionCollision) {
    await git(["read-tree", intent.commitSha], projectPath, { GIT_INDEX_FILE: temporaryIndex });
  } else {
    try {
      // A two-tree update carries the accepted commit forward while preserving
      // non-overlapping edits made after the crash.
      await git(["read-tree", "-m", "-u", intent.baseSha, intent.commitSha], projectPath, { GIT_INDEX_FILE: temporaryIndex });
    } catch (error) {
      if (!worktreeChanged) throw error;
      // If a user edit overlaps the accepted change, preserve the user's bytes
      // and finish only the index. Git will expose that overlap as an unstaged
      // modification instead of silently overwriting it.
      await fs.rm(temporaryIndex, { force: true });
      await fs.rm(`${temporaryIndex}.lock`, { force: true });
      await git(["read-tree", intent.commitSha], projectPath, { GIT_INDEX_FILE: temporaryIndex });
    }
  }

  const [temporaryTree, intendedTree] = await Promise.all([
    git(["write-tree"], projectPath, { GIT_INDEX_FILE: temporaryIndex }).then((result) => result.stdout.trim()),
    git(["rev-parse", `${intent.commitSha}^{tree}`], projectPath).then((result) => result.stdout.trim()),
  ]);
  if (!temporaryTree || temporaryTree !== intendedTree) {
    throw new Error("Interrupted merge recovery could not rebuild the accepted index");
  }
  return fs.readFile(temporaryIndex);
}

// Startup recovery only removes a lock that carries Codebate's marker (or a
// binary index whose hash matches Codebate's durable install intent). It never
// removes an unrelated Git process's index.lock.
export async function recoverCodebateIndexLock(projectPath) {
  const { indexPath, lockPath, intentPath } = await indexPaths(projectPath);
  let intent = null;
  try { intent = JSON.parse(await fs.readFile(intentPath, "utf8")); } catch {}
  let lock = null;
  let lockInfo = null;
  try {
    lockInfo = await fs.stat(lockPath, { bigint: true });
    if (lockInfo.size <= BigInt(64 * 1024 * 1024)) lock = await fs.readFile(lockPath);
  } catch {}
  if (!lock) {
    await fs.rm(intentPath, { force: true }).catch(() => {});
    return false;
  }
  let marker = null;
  try { marker = JSON.parse(lock.toString("utf8")); } catch {}
  const identityMatches = Boolean(
    intent?.lockIdentity && lockInfo && String(lockInfo.ino) !== "0" &&
    intent.lockIdentity.dev === String(lockInfo.dev) &&
    intent.lockIdentity.ino === String(lockInfo.ino) &&
    intent.lockIdentity.birthtimeNs === String(lockInfo.birthtimeNs),
  );
  const markerOwned = marker?.codebate === true && (!intent?.nonce || marker.nonce === intent.nonce);
  const hashOwned = identityMatches && intent?.phase === "installing" && intent.lockSha256 === crypto.createHash("sha256").update(lock).digest("hex");
  let partialInstallOwned = false;
  let verifiedTemporary = null;
  let safeTemporary = false;
  if (typeof intent?.temporaryIndex === "string") {
    const expectedPrefix = `${path.basename(indexPath)}.codebate-`;
    safeTemporary = path.dirname(intent.temporaryIndex) === path.dirname(indexPath) && path.basename(intent.temporaryIndex).startsWith(expectedPrefix);
    if (safeTemporary) {
      try {
        const [expected, currentIndex] = await Promise.all([fs.readFile(intent.temporaryIndex), fs.readFile(indexPath)]);
        const currentHash = crypto.createHash("sha256").update(currentIndex).digest("hex");
        if (intent.phase === "installing") {
          partialInstallOwned = identityMatches && currentHash === intent.previousIndexSha256 && lock.length <= expected.length && expected.subarray(0, lock.length).equals(lock);
        }
        const [temporaryTree, intendedTree] = await Promise.all([
          git(["write-tree"], projectPath, { GIT_INDEX_FILE: intent.temporaryIndex }).then((result) => result.stdout.trim()),
          optionalGitValue(["rev-parse", `${intent.indexCommit}^{tree}`], projectPath),
        ]);
        if (temporaryTree && temporaryTree === intendedTree) verifiedTemporary = expected;
      } catch {}
    }
  }
  if (markerOwned || hashOwned || partialInstallOwned) {
    const currentTarget = intent?.targetRef ? await optionalGitValue(["rev-parse", intent.targetRef], projectPath) : "";
    const currentHeadRef = await optionalGitValue(["symbolic-ref", "-q", "HEAD"], projectPath);
    const refsValid = currentHeadRef === intent?.targetRef && currentTarget === intent?.indexCommit && intent?.indexCommit === intent?.commitSha;
    if (!verifiedTemporary && markerOwned && refsValid && safeTemporary && intent?.phase === "refreshing") {
      verifiedTemporary = await rebuildInterruptedRefresh(projectPath, indexPath, intent);
    }
    const canFinishIndex = verifiedTemporary && refsValid;
    if (canFinishIndex) {
      const previousIndex = await fs.readFile(indexPath);
      await writeIntent(intentPath, {
        ...intent,
        phase: "installing",
        lockSha256: crypto.createHash("sha256").update(verifiedTemporary).digest("hex"),
        previousIndexSha256: crypto.createHash("sha256").update(previousIndex).digest("hex"),
      });
      await fs.writeFile(lockPath, verifiedTemporary);
      await renameIndexLock(lockPath, indexPath);
    } else {
      await fs.rm(lockPath, { force: true });
    }
    await fs.rm(intentPath, { force: true }).catch(() => {});
    if (typeof intent?.temporaryIndex === "string") await fs.rm(intent.temporaryIndex, { force: true }).catch(() => {});
    return true;
  }
  // The sidecar is stale but the lock belongs to another Git operation.
  await fs.rm(intentPath, { force: true }).catch(() => {});
  return false;
}

// Merge the executor's branch into the project's current branch (accept -> keep changes locally).
export async function mergeBranch(projectPath, worktree, commitSha, ref = acceptedRef(commitSha)) {
  if (ref !== acceptedRef(commitSha) || await optionalGitValue(["rev-parse", ref], projectPath) !== commitSha) {
    throw new Error("The reviewed commit is not available for merge");
  }
  const targetRef = worktree.approval.baseRef;
  const { indexPath, lockPath, intentPath } = await indexPaths(projectPath);
  const temporaryIndex = `${indexPath}.codebate-${crypto.randomUUID()}`;
  const lockNonce = crypto.randomUUID();
  let lockHandle;
  let ownsLock = false;
  let installedIndex = false;
  let targetCommitted = false;
  let preserveRecovery = false;
  let lockIdentity = null;

  const installIndex = async (indexCommit) => {
    const contents = await fs.readFile(temporaryIndex);
    const previousIndex = await fs.readFile(indexPath);
    await writeIntent(intentPath, {
      codebate: true,
      nonce: lockNonce,
      phase: "installing",
      lockSha256: crypto.createHash("sha256").update(contents).digest("hex"),
      previousIndexSha256: crypto.createHash("sha256").update(previousIndex).digest("hex"),
      temporaryIndex,
      indexCommit,
      targetRef,
      baseSha: worktree.baseSha,
      commitSha,
      lockIdentity,
    });
    await lockHandle.truncate(0);
    await writeCompleteFile(lockHandle, contents);
    await lockHandle.sync();
    await lockHandle.close();
    lockHandle = null;
    await renameIndexLock(lockPath, indexPath);
    installedIndex = true;
  };

  try {
    try {
      await fs.writeFile(lockPath, JSON.stringify({ codebate: true, nonce: lockNonce }), { flag: "wx", mode: 0o600 });
      ownsLock = true;
      lockHandle = await fs.open(lockPath, "r+");
      const lockInfo = await lockHandle.stat({ bigint: true });
      lockIdentity = { dev: String(lockInfo.dev), ino: String(lockInfo.ino), birthtimeNs: String(lockInfo.birthtimeNs) };
      await writeIntent(intentPath, { codebate: true, nonce: lockNonce, phase: "locked", lockIdentity });
    }
    catch (error) {
      if (error.code === "EEXIST") throw new Error("Another Git operation is using this working tree; retry after it finishes");
      throw error;
    }
    const [currentTarget, checkedOutRef] = await Promise.all([
      optionalGitValue(["rev-parse", targetRef], projectPath),
      optionalGitValue(["symbolic-ref", "-q", "HEAD"], projectPath),
    ]);
    const targetAlreadyAdvanced = currentTarget === commitSha;
    if (!targetAlreadyAdvanced && currentTarget !== worktree.baseSha) throw new Error("Target branch moved before merge; run the task again");
    if (checkedOutRef !== targetRef) throw new Error("The checked-out branch changed before merge; run the task again");
    await assertNoAcceptedAdditionCollision(projectPath, worktree.baseSha, commitSha);

    await git(["read-tree", worktree.baseSha], projectPath, { GIT_INDEX_FILE: temporaryIndex });
    await writeIntent(intentPath, {
      codebate: true,
      nonce: lockNonce,
      phase: "refreshing",
      temporaryIndex,
      indexCommit: commitSha,
      targetRef,
      baseSha: worktree.baseSha,
      commitSha,
      lockIdentity,
    });

    // Hold Git's real index lock across the target CAS and worktree refresh. Git
    // switch/checkout/merge obey this lock, so another branch cannot become the
    // refresh target between the HEAD check and read-tree.
    if (!targetAlreadyAdvanced) {
      await git(["update-ref", targetRef, commitSha, worktree.baseSha], projectPath);
    }
    targetCommitted = true;
    if (await optionalGitValue(["symbolic-ref", "-q", "HEAD"], projectPath) !== targetRef) {
      throw new Error("The checked-out branch changed during merge; the accepted branch was not applied to this worktree");
    }
    await assertNoAcceptedAdditionCollision(projectPath, worktree.baseSha, commitSha);
    await git(["read-tree", "--reset", "-u", commitSha], projectPath, { GIT_INDEX_FILE: temporaryIndex });
    const [preparedHead, preparedRef] = await Promise.all([
      optionalGitValue(["rev-parse", "HEAD"], projectPath),
      optionalGitValue(["symbolic-ref", "-q", "HEAD"], projectPath),
    ]);
    if (preparedHead !== commitSha || preparedRef !== targetRef) throw new Error("The checked-out branch changed during merge");
    await installIndex(commitSha);
  } catch (error) {
    // Once the accepted commit is visible through the target ref, recovery must
    // finish forward. Rolling the ref back after another Git process could have
    // observed it can leave HEAD, the index, and the worktree inconsistent.
    preserveRecovery = targetCommitted && !installedIndex;
    throw error;
  } finally {
    if (lockHandle) await lockHandle.close().catch(() => {});
    if (!preserveRecovery) {
      await fs.rm(temporaryIndex, { force: true }).catch(() => {});
      if (ownsLock) await fs.rm(intentPath, { force: true }).catch(() => {});
      if (ownsLock && !installedIndex) await fs.rm(lockPath, { force: true }).catch(() => {});
    }
  }
}

// Push the executor's branch to origin (needed before opening a PR).
export async function pushBranch(projectPath, worktree, commitSha, ref) {
  const context = await assertProjectReady(projectPath, worktree);
  if (!context.remoteUrl) throw new Error("Project has no origin remote");
  if (ref !== acceptedRef(commitSha) || await optionalGitValue(["rev-parse", ref], projectPath) !== commitSha) {
    throw new Error("The reviewed commit is not available for publication");
  }
  await git(
    ["push", context.remoteUrl, `${ref}:refs/heads/${worktree.branch}`],
    projectPath,
    {},
    "",
    { envPolicy: "publication" },
  );
  return context;
}

// New executions use an isolated clone, so deleting that directory deletes loose and packed
// secret objects without touching the user's repository. This aggressive fallback exists only
// for pre-isolation records created by older builds.
export async function pruneObjects(projectPath, { strict = false, isolation = "legacy" } = {}) {
  if (isolation === "clone") return { ok: true, errors: [] };
  try {
    await git(["repack", "-Ad", "--unpack-unreachable=now"], projectPath);
    await git(["prune", "--expire=now"], projectPath);
    return { ok: true, errors: [] };
  } catch (error) {
    if (strict) throw new Error(`Could not purge unreachable Git objects: ${error.message}`);
    return { ok: false, errors: [error.message] };
  }
}

// Discard an executor's worktree and its branch (used on reject / cleanup).
export async function removeWorktree(projectPath, wtPath, branch, { strict = false, isolation = "" } = {}) {
  const errors = [];
  let location;
  try { location = await executionLocation(projectPath, wtPath, branch); }
  catch (error) { errors.push(redact(error.message)); }
  if (!location) {
    const message = errors[0] || "execution path or branch failed the cleanup safety check";
    if (strict) throw new Error(message);
    return { ok: false, errors: [message] };
  }
  let rootAvailable = true;
  let targetAvailable = true;
  try {
    const rootInfo = await fs.lstat(location.root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("execution root is not a real directory");
    const canonicalRoot = await fs.realpath(location.root);
    if (normalizedPath(canonicalRoot) !== normalizedPath(location.root)) throw new Error("execution root changed before cleanup");
    const agentRoot = path.join(location.root, location.agent);
    const agentInfo = await fs.lstat(agentRoot);
    if (!agentInfo.isDirectory() || agentInfo.isSymbolicLink()) throw new Error("execution provider directory is not a real directory");
    const canonicalAgent = await fs.realpath(agentRoot);
    if (normalizedPath(canonicalAgent) !== normalizedPath(agentRoot)) throw new Error("execution provider directory changed before cleanup");
  } catch (error) {
    if (error.code === "ENOENT") { rootAvailable = false; targetAvailable = false; }
    else errors.push(redact(error.message));
  }
  if (rootAvailable) {
    try { await assertRealDirectory(location.expected, "Execution workspace"); }
    catch (error) {
      if (error.code === "ENOENT") targetAvailable = false;
      else errors.push(redact(error.message));
    }
  }
  if (errors.length) {
    if (strict) throw new Error(`Execution cleanup failed: ${errors.join("; ")}`);
    return { ok: false, errors };
  }
  let savedIsolation = isolation;
  if (!savedIsolation && rootAvailable) {
    try {
      const gitInfo = await fs.lstat(path.join(wtPath, ".git"));
      if (!gitInfo.isSymbolicLink() && gitInfo.isDirectory()) savedIsolation = "clone";
      else if (!gitInfo.isSymbolicLink() && gitInfo.isFile()) savedIsolation = "legacy";
    } catch {}
  }
  if (!["clone", "legacy"].includes(savedIsolation)) {
    const message = "execution isolation type is unknown; cleanup was left for manual review";
    if (strict) throw new Error(message);
    return { ok: false, errors: [message] };
  }
  const isolatedClone = savedIsolation === "clone";
  if (isolatedClone) {
    try { if (targetAvailable) await fs.rm(wtPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
    catch (error) { errors.push(`clone delete: ${redact(error.message)}`); }
  } else {
    try { await git(["worktree", "remove", "--force", wtPath], projectPath); } catch {}
  }
  // Project-side Git cleanup applies only to a legacy in-tree worktree (registered in the project's Git).
  // An isolated clone is a separate repo (own objects/refs) the project never registered, so it needs none
  // of this — and running `git worktree prune` / `git worktree list` with cwd = a possibly-deleted project
  // (surviving project deletion is the relocation's whole point) spawns git with ENOENT and wrongly reports
  // a cleanup failure, stranding the execution in cleanupPending. For an isolated clone the fs delete above
  // + the existence check below ARE the cleanup.
  if (!isolatedClone) {
    try { await git(["worktree", "prune", "--expire=now"], projectPath); }
    catch (error) { errors.push(`worktree prune: ${error.message}`); }
    const branchRef = `refs/heads/${branch}`;
    if (await optionalGitValue(["rev-parse", "--verify", branchRef], projectPath)) {
      try { await git(["branch", "-D", branch], projectPath); }
      catch (error) { errors.push(`branch delete: ${error.message}`); }
    }
    try { await git(["worktree", "prune", "--expire=now"], projectPath); }
    catch (error) { errors.push(`worktree prune: ${error.message}`); }
  }
  try { await fs.access(wtPath); errors.push("worktree directory still exists after cleanup"); } catch {}
  if (!isolatedClone) {
    const registered = (await listWorktrees(projectPath)).split(/\r?\n\r?\n/).some((block) => block.match(/^worktree (.+)$/m)?.[1] === wtPath);
    if (registered) errors.push("worktree registration still exists after cleanup");
    if (await optionalGitValue(["rev-parse", "--verify", `refs/heads/${branch}`], projectPath)) {
      errors.push("execution branch still exists after cleanup");
    }
  }
  if (strict && errors.length) throw new Error(`Execution cleanup failed: ${errors.join("; ")}`);
  return { ok: errors.length === 0, errors };
}

async function scanExecutionRoot(root) {
  let agentEntries;
  try { agentEntries = await fs.readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const found = [];
  for (const agentEntry of agentEntries) {
    if (!agentEntry.isDirectory() || agentEntry.isSymbolicLink() || !isSafeExecutionComponent(agentEntry.name)) continue;
    const agentPath = path.join(root, agentEntry.name);
    for (const taskEntry of await fs.readdir(agentPath, { withFileTypes: true })) {
      if (!taskEntry.isDirectory() || taskEntry.isSymbolicLink() || !isSafeExecutionComponent(taskEntry.name)) continue;
      const workspacePath = path.join(agentPath, taskEntry.name);
      found.push({
        path: workspacePath,
        branch: `agent/${agentEntry.name}/${taskEntry.name}`,
        isolation: await workspaceIsolation(workspacePath),
      });
    }
  }
  return found;
}

export async function listExecutionWorkspaces(projectPath) {
  // Scan the current out-of-tree root AND any legacy in-tree root. Key the current root off the realpath
  // (matching creation); if the project dir is gone, its bucket is keyed from the already-canonical stored
  // path and the legacy in-tree root is gone with it.
  let canonicalProject = null;
  try { canonicalProject = await fs.realpath(projectPath); }
  catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
  const current = await scanExecutionRoot(currentExecutionRootFor(canonicalProject ?? path.resolve(projectPath)));
  const legacy = canonicalProject ? await scanExecutionRoot(legacyExecutionRoot(canonicalProject)) : [];
  return [...current, ...legacy];
}

// Out-of-tree clones don't die with a deleted project the way in-tree ones did. Sweep any exec-workspaces
// project bucket whose key matches no surviving session (a project that still has a session keeps its
// bucket; active executions within a kept bucket are handled per-record). Only ever removes a real
// 16-hex directory directly under the app-owned root — never a symlink or anything that redirects out.
export async function sweepOrphanExecutionWorkspaces(knownProjectKeys, base = executionWorkspacesRoot()) {
  let entries;
  try { entries = await fs.readdir(base, { withFileTypes: true }); }
  catch (error) {
    if (error.code === "ENOENT") return { ok: true, errors: [] };
    return { ok: false, errors: [redact(error.message)] };
  }
  const errors = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[0-9a-f]{16}$/.test(entry.name)) continue;
    if (knownProjectKeys.has(entry.name)) continue;
    const dir = path.join(base, entry.name);
    try {
      const canonical = await fs.realpath(dir);
      if (normalizedPath(canonical) !== normalizedPath(dir)) { errors.push("orphan execution bucket changed before cleanup"); continue; }
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch (error) { errors.push(redact(error.message)); }
  }
  return { ok: errors.length === 0, errors };
}

async function workspaceIsolation(workspacePath) {
  try {
    const gitInfo = await fs.lstat(path.join(workspacePath, ".git"));
    if (!gitInfo.isSymbolicLink() && gitInfo.isDirectory()) return "clone";
    if (!gitInfo.isSymbolicLink() && gitInfo.isFile()) return "legacy";
  } catch {}
  return "unknown";
}
