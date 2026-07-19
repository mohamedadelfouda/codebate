import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  CURRENT_SESSION_SCHEMA_VERSION,
  migrateSessionDocument,
  validateSessionDocument,
} from "./session-schema.js";
import { expectedApiError } from "./api-errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RUNTIME_ROOT = process.env.CODEBATE_RUNTIME_DIR ? path.resolve(process.env.CODEBATE_RUNTIME_DIR) : ROOT;
const DATA_DIR = path.join(RUNTIME_ROOT, "data");
const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
const SESSION_BACKUPS_DIR = path.join(DATA_DIR, "session-backups");
const SESSION_RECOVERY_DIR = path.join(DATA_DIR, "session-recovery");
const SESSION_BACKUP_LIMIT = 3;
const TITLE_MAX_CODEPOINTS = 160;

// `String.slice` counts UTF-16 code units, which can split a surrogate pair (e.g. an
// emoji) in half. Truncate by Unicode code point instead so titles never end in a
// broken/unpaired surrogate.
function truncateTitle(title) {
  return [...String(title || "")].slice(0, TITLE_MAX_CODEPOINTS).join("");
}
const SCRATCH_WORKSPACE_DIR = path.join(RUNTIME_ROOT, "workspace");
// Disposable execution clones live here — under the app runtime dir, OUTSIDE any user project tree — so
// the real repo is never a few `cd ..` away from an executor and never shows up in the project's git
// status. Per-project subdirs are created by worktree.js.
const EXECUTION_WORKSPACES_DIR = path.join(RUNTIME_ROOT, "exec-workspaces");
const MAX_SESSION_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 100000;
const MAX_DECISIONS = 200;
const MAX_EXECUTIONS = 50;
const MAX_CONNECTOR_ACTIONS = 100;
const MAX_CONNECTOR_READ_AUDITS = 200;
const MAX_SESSION_BYTES = 24 * 1024 * 1024;
const TERMINAL_EXECUTION_STATUSES = new Set(["merged", "pr_opened", "rejected", "blocked_secret"]);
export const SKIP_SESSION_WRITE = Symbol("skip-session-write");

function executionNeedsRecovery(record) {
  return !TERMINAL_EXECUTION_STATUSES.has(record.status) || record.cleanupPending !== false || !record.cleanupCompletedAt;
}

function boundedText(value, max = MAX_MESSAGE_CHARS) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}\n…[stored content truncated]`;
}

function boundedJson(value, max, fallback) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return value;
    if (serialized.length <= max) return value;
    return fallback(serialized.slice(0, max));
  } catch {
    return fallback("");
  }
}

function boundExecution(record) {
  const reviewValue = boundedJson(record.review, 70000, (preview) => ({ text: preview, truncated: true }));
  const review = reviewValue ? { ...reviewValue, text: boundedText(reviewValue.text, 50000) } : reviewValue;
  const diff = record.diff ? {
    ...record.diff,
    files: boundedText(record.diff.files, 50000),
    stat: boundedText(record.diff.stat, 20000),
    patch: boundedText(record.diff.patch, 80000),
  } : record.diff;
  return {
    ...record,
    task: boundedText(record.task, 30000),
    executorText: boundedText(record.executorText, 50000),
    executorMeta: boundedJson(record.executorMeta, 20000, (preview) => ({ truncated: true, preview })),
    worktree: boundedJson(record.worktree, 30000, () => ({ path: boundedText(record.worktree?.path, 4000), branch: boundedText(record.worktree?.branch, 1000), baseSha: record.worktree?.baseSha, approval: record.worktree?.approval })),
    cleanupErrors: Array.isArray(record.cleanupErrors) ? record.cleanupErrors.slice(0, 10).map((error) => boundedText(error, 2000)) : record.cleanupErrors,
    review,
    diff,
    secretFindings: Array.isArray(record.secretFindings)
      ? record.secretFindings.slice(0, 200).map((finding) => ({
        ...finding,
        path: boundedText(finding.path, 2000),
        rule: boundedText(finding.rule, 500),
      }))
      : record.secretFindings,
  };
}

function boundConnectorAction(record) {
  const active = ["pending", "executing_unknown"].includes(record.status);
  const boundedInput = active ? record.input : boundedJson(record.input, 65536, (preview) => ({ truncated: true, preview }));
  return {
    ...record,
    input: boundedInput,
    result: boundedText(record.result, 50000),
    error: boundedText(record.error, 4000),
  };
}

function retainTerminalHistory(records, terminalLimit, isActionable) {
  const terminal = records.filter((record) => !isActionable(record)).slice(-terminalLimit);
  const keep = new Set(terminal);
  return records.filter((record) => isActionable(record) || keep.has(record));
}

function boundSession(session) {
  if (Array.isArray(session.messages)) {
    session.messages = session.messages.slice(-MAX_SESSION_MESSAGES).map((message) => ({
      ...message,
      content: boundedText(message.content, 50000),
      meta: boundedJson(message.meta, 20000, (preview) => ({ truncated: true, preview })),
      control: boundedJson(message.control, 10000, (preview) => ({ truncated: true, preview })),
    }));
  }
  if (Array.isArray(session.decisions)) {
    session.decisions = session.decisions.slice(-MAX_DECISIONS).map((decision) => ({
      ...decision,
      reason: boundedText(decision.reason, 10000),
      metadata: boundedJson(decision.metadata, 10000, (preview) => ({ truncated: true, preview })),
    }));
  }
  if (Array.isArray(session.executions)) {
    session.executions = retainTerminalHistory(session.executions, MAX_EXECUTIONS, executionNeedsRecovery).map(boundExecution);
  }
  if (Array.isArray(session.connectorActions)) {
    session.connectorActions = retainTerminalHistory(
      session.connectorActions,
      MAX_CONNECTOR_ACTIONS,
      (record) => ["pending", "executing_unknown"].includes(record.status),
    ).map(boundConnectorAction);
  }
  if (Array.isArray(session.connectorReadAudits)) {
    session.connectorReadAudits = session.connectorReadAudits.slice(-MAX_CONNECTOR_READ_AUDITS).map(boundConnectorReadAudit);
  }
  session.settings = boundedJson(session.settings, 100000, (preview) => ({ truncated: true, preview }));
  session.connectors = boundedJson(session.connectors, 50000, (preview) => ({ truncated: true, preview }));
  if (Buffer.byteLength(JSON.stringify(session, null, 2), "utf8") > MAX_SESSION_BYTES) {
    if (Array.isArray(session.messages)) session.messages = session.messages.map((message) => ({
      ...message,
      content: boundedText(message.content, 10000),
      meta: boundedJson(message.meta, 5000, (preview) => ({ truncated: true, preview })),
      control: boundedJson(message.control, 2000, (preview) => ({ truncated: true, preview })),
    }));
    if (Array.isArray(session.decisions)) session.decisions = session.decisions.slice(-100).map((decision) => ({ ...decision, reason: boundedText(decision.reason, 2000), metadata: boundedJson(decision.metadata, 2000, (preview) => ({ truncated: true, preview })) }));
    if (Array.isArray(session.executions)) {
      session.executions = retainTerminalHistory(session.executions, 10, executionNeedsRecovery).map((record) => ({
        ...record,
        task: boundedText(record.task, 10000),
        executorText: boundedText(record.executorText, 15000),
        review: record.review ? { ...record.review, text: boundedText(record.review.text, 15000) } : record.review,
        diff: record.diff ? { ...record.diff, files: boundedText(record.diff.files, 10000), stat: boundedText(record.diff.stat, 5000), patch: boundedText(record.diff.patch, 20000) } : record.diff,
      }));
    }
    if (Array.isArray(session.connectorActions)) {
      session.connectorActions = retainTerminalHistory(session.connectorActions, 20, (record) => ["pending", "executing_unknown"].includes(record.status)).map((record) => ({ ...record, result: boundedText(record.result, 10000) }));
    }
    if (Array.isArray(session.connectorReadAudits)) {
      session.connectorReadAudits = session.connectorReadAudits.slice(-50).map(boundConnectorReadAudit);
    }
    if (Array.isArray(session.messages)) session.messages = session.messages.slice(-100);
  }
  const storedBytes = Buffer.byteLength(JSON.stringify(session, null, 2), "utf8");
  if (storedBytes > MAX_SESSION_BYTES) {
    throw new Error(`Session exceeds the ${MAX_SESSION_BYTES / (1024 * 1024)} MiB storage limit; resolve pending actions or start a new session`);
  }
  return session;
}

function sessionSummary(session) {
  return {
    id: session.id,
    sessionSchemaVersion: session.sessionSchemaVersion,
    title: session.title,
    status: session.status,
    mode: session.mode,
    updatedAt: session.updatedAt,
    messageCount: session.messages?.length ?? 0,
    hasExecutions: Array.isArray(session.executions) && session.executions.length > 0,
    hasRecoverableExecutions: Array.isArray(session.executions) && session.executions.some(executionNeedsRecovery),
    projectPath: boundedText(session.project?.path, 4000),
  };
}

async function ensureDirs() {
  await Promise.all([
    fs.mkdir(SESSIONS_DIR, { recursive: true }),
    fs.mkdir(SESSION_BACKUPS_DIR, { recursive: true }),
    fs.mkdir(SESSION_RECOVERY_DIR, { recursive: true }),
  ]);
}

function boundConnectorReadAudit(record) {
  return {
    ...record,
    connector: boundedText(record.connector, 100),
    action: boundedText(record.action, 200),
    status: boundedText(record.status, 40),
    errorCode: boundedText(record.errorCode, 120),
    inputSummary: boundedJson(record.inputSummary, 20000, (preview) => ({ truncated: true, preview })),
  };
}

function sessionPath(id) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid session id");
  return path.join(SESSIONS_DIR, `${id}.json`);
}

async function replaceJson(filePath, data, { durable = true } = {}) {
  // Random temp name (not pid+Date.now(), which collides when two writes land in the same
  // millisecond in this process → a torn/half-written file). Write, fsync, then atomic rename.
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    // fsync the temp file's bytes to disk BEFORE the rename. temp+rename alone survives a process
    // crash, but a power cut between the write and the OS's lazy flush can still leave a zero-length or
    // torn file even though the rename "succeeded" — so a recovery that trusts an accepted-commit or
    // blocked_secret record could read garbage. Mirrors runtime-lock.js's handle.sync() precedent.
    const handle = await fs.open(tempPath, "w");
    try {
      await handle.writeFile(JSON.stringify(data, null, 2), "utf8");
      if (durable) await handle.sync();
    } finally {
      await handle.close().catch(() => {}); // don't let a close error mask a write/sync error (matches runtime-lock.js)
    }
    // Windows can transiently deny a replace while antivirus/indexing has the destination
    // open. Retrying the same atomic rename preserves the old-or-new guarantee; deleting the
    // destination first would introduce a window where the session does not exist.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(tempPath, filePath);
        break;
      } catch (error) {
        const retryable = process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(error.code);
        if (!retryable || attempt >= 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * (2 ** attempt)));
      }
    }
    // Also fsync the parent directory so the rename (a directory-entry change) is itself durable across a
    // power cut. Best-effort: opening a directory for fsync isn't supported on Windows / some
    // filesystems, where the temp fsync + atomic rename already give crash consistency.
    if (durable) await fsyncDir(path.dirname(filePath));
  } finally {
    // On success the rename already consumed tempPath (rm is a no-op / ENOENT); on a
    // write/rename failure this removes the leftover so temp files don't accumulate.
    // The original error still propagates.
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

// A rename is a directory-entry change, so the parent directory must be fsync'd for it to survive a power
// cut. Directory fsync genuinely isn't supported everywhere — on Windows, syncing a directory handle throws
// EPERM (verified on this platform), and some network filesystems throw EINVAL — where the temp-file fsync +
// atomic rename already give crash consistency, so those stay best-effort. But a real resource/I-O failure
// means the rename may NOT be durable, so it must surface rather than let the write report a false success.
const DIRECTORY_FSYNC_FATAL = new Set(["ENOSPC", "EIO", "EMFILE", "ENFILE", "EDQUOT", "EROFS"]);

// Exported so the "which directory-fsync failures are fatal" contract is unit-tested directly: the
// end-to-end path is hard to isolate because the temp-file fsync shares the same FileHandle.sync.
export function directoryFsyncErrorIsFatal(error) {
  return DIRECTORY_FSYNC_FATAL.has(error?.code);
}

async function fsyncDir(dirPath) {
  let handle;
  try {
    handle = await fs.open(dirPath, "r");
    await handle.sync();
  } catch (error) {
    // Skip the platform/filesystem "can't sync a directory" cases (Windows EPERM, EINVAL, and any code not
    // recognised as a genuine failure); surface a real durability failure so a caller is never told a
    // not-yet-durable write succeeded.
    if (directoryFsyncErrorIsFatal(error)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function retainRecentBackups(sessionId) {
  const prefix = `${sessionId}.`;
  const backups = (await fs.readdir(SESSION_BACKUPS_DIR))
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort()
    .reverse();
  await Promise.all(backups.slice(SESSION_BACKUP_LIMIT).map((name) => fs.rm(path.join(SESSION_BACKUPS_DIR, name), { force: true })));
}

async function backUpSessionSource(sessionId, rawText, fromVersion) {
  await fs.mkdir(SESSION_BACKUPS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(
    SESSION_BACKUPS_DIR,
    `${sessionId}.${timestamp}.v${fromVersion}.${crypto.randomUUID()}.json`,
  );
  await fs.writeFile(backupPath, rawText, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return backupPath;
}

async function readSessionFile(filePath, sessionId) {
  const rawText = await fs.readFile(filePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    error.code = "invalid_session_json";
    throw error;
  }
  const migrated = migrateSessionDocument(parsed, sessionId);
  if (migrated.migrated) {
    await backUpSessionSource(sessionId, rawText, migrated.fromVersion);
    await replaceJson(filePath, migrated.session);
    await retainRecentBackups(sessionId);
  }
  return migrated.session;
}

function recoveryIdFor(fileName) {
  return crypto.createHash("sha256").update(fileName).digest("hex").slice(0, 32);
}

function recoveryCategory(error) {
  if (error?.code === "invalid_session_json") return "invalid_json";
  if (error?.code === "unsupported_session_schema") return "unsupported_schema";
  if (error?.code === "invalid_session_schema") return "invalid_schema";
  return "read_error";
}

function recoveryRecordPath(recoveryId) {
  if (!/^[a-f0-9]{32}$/.test(recoveryId)) throw new Error("Invalid recovery id");
  return path.join(SESSION_RECOVERY_DIR, `${recoveryId}.json`);
}

async function ensureRecoveryRecord(fileName, error) {
  const recoveryId = recoveryIdFor(fileName);
  const recordPath = recoveryRecordPath(recoveryId);
  try {
    return JSON.parse(await fs.readFile(recordPath, "utf8"));
  } catch (readError) {
    // ENOENT → create it below. A truncated/corrupt record (SyntaxError) is rebuilt instead of
    // left to break export/retry/delete; any other IO error is genuinely fatal and propagates.
    if (readError?.code !== "ENOENT" && !(readError instanceof SyntaxError)) throw readError;
  }
  const record = {
    recoveryId,
    fileName: path.basename(fileName),
    category: recoveryCategory(error),
    detectedAt: new Date().toISOString(),
  };
  // Atomic temp-file + rename (via replaceJson) so a crash mid-write can never leave a
  // half-written JSON record behind. The record is deterministic for a given file+category,
  // so an overwriting last-writer-wins race is harmless.
  await replaceJson(recordPath, record);
  return record;
}

function recoverySummary(record) {
  return {
    id: `recovery-${record.recoveryId}`,
    recoveryId: record.recoveryId,
    recoveryNeeded: true,
    title: "Session needs recovery",
    status: "recovery_needed",
    mode: "recovery",
    updatedAt: record.detectedAt,
    messageCount: 0,
    recoveryCategory: record.category,
  };
}

function recoverySourcePath(record) {
  const sourcePath = path.resolve(SESSIONS_DIR, record.fileName);
  if (path.dirname(sourcePath) !== path.resolve(SESSIONS_DIR)) throw new Error("Invalid recovery source");
  return sourcePath;
}

async function clearRecoveryRecord(fileName) {
  await fs.rm(recoveryRecordPath(recoveryIdFor(fileName)), { force: true });
}

function summaryPath(filePath) {
  return filePath.replace(/\.json$/i, ".summary.json");
}

async function doWrite(filePath, data) {
  boundSession(data);
  // Validate the document id against the file it is being written to (not against itself),
  // so a mutated in-memory id can never be persisted to a filename it no longer matches.
  validateSessionDocument(data, path.basename(filePath, ".json"));
  await replaceJson(filePath, data);
  // The transcript is the transaction. The compact sidebar summary is only a
  // cache: a cache write failure must never make callers retry a durable action.
  await replaceJson(summaryPath(filePath), sessionSummary(data), { durable: false }).catch(() => {}); // cache: regenerated from the transcript on demand, so it skips the extra fsync
}

// Serialize operations per session file inside the host process. Callers that need an atomic
// read-modify-write transition must use mutateSession; saveSession only serializes its write.
const writeLocks = new Map();
function runExclusive(filePath, task) {
  const prev = writeLocks.get(filePath) || Promise.resolve();
  const run = prev.then(task, task);
  const tail = run.then(() => {}, () => {}); // non-rejecting, so one failure can't stall the chain
  writeLocks.set(filePath, tail);
  tail.then(() => { if (writeLocks.get(filePath) === tail) writeLocks.delete(filePath); });
  return run;
}
async function atomicWrite(filePath, data) {
  return runExclusive(filePath, () => doWrite(filePath, data));
}

export async function listSessions() {
  await ensureDirs();
  const files = (await fs.readdir(SESSIONS_DIR)).filter((file) => file.endsWith(".json") && !file.endsWith(".summary.json"));
  const sessions = [];
  for (const file of files) {
    try {
      const mainPath = path.join(SESSIONS_DIR, file);
      let summary;
      try {
        const cachedPath = summaryPath(mainPath);
        const [mainStat, summaryStat] = await Promise.all([fs.stat(mainPath, { bigint: true }), fs.stat(cachedPath, { bigint: true })]);
        if (summaryStat.mtimeNs <= mainStat.mtimeNs) throw new Error("stale summary cache");
        summary = JSON.parse(await fs.readFile(cachedPath, "utf8"));
        if (summary.sessionSchemaVersion !== CURRENT_SESSION_SCHEMA_VERSION) throw new Error("stale summary schema");
      }
      catch {
        const sessionId = file.replace(/\.json$/i, "");
        const session = await runExclusive(mainPath, () => readSessionFile(mainPath, sessionId));
        summary = sessionSummary(session);
        await replaceJson(summaryPath(mainPath), summary, { durable: false }).catch(() => {}); // cache: self-healing regen, so it skips the extra fsync
      }
      await clearRecoveryRecord(file).catch(() => {});
      sessions.push(summary);
    } catch (error) {
      let record;
      try { record = await ensureRecoveryRecord(file, error); }
      catch {
        record = {
          recoveryId: recoveryIdFor(file),
          fileName: path.basename(file),
          category: recoveryCategory(error),
          detectedAt: new Date().toISOString(),
        };
      }
      sessions.push(recoverySummary(record));
    }
  }
  return sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function listSessionRecoveries() {
  await ensureDirs();
  const files = (await fs.readdir(SESSION_RECOVERY_DIR)).filter((file) => /^[a-f0-9]{32}\.json$/.test(file));
  const records = [];
  for (const file of files) {
    try { records.push(JSON.parse(await fs.readFile(path.join(SESSION_RECOVERY_DIR, file), "utf8"))); }
    catch { /* Keep an unreadable recovery record isolated from healthy sessions. */ }
  }
  return records.sort((a, b) => String(b.detectedAt).localeCompare(String(a.detectedAt)));
}

async function readRecoveryRecord(recoveryId) {
  try { return JSON.parse(await fs.readFile(recoveryRecordPath(recoveryId), "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") throw expectedApiError("not_found", "Recovery record not found", 404);
    throw error;
  }
}

export async function exportSessionRecovery(recoveryId) {
  await ensureDirs();
  const record = await readRecoveryRecord(recoveryId);
  const sourcePath = recoverySourcePath(record);
  const info = await fs.stat(sourcePath);
  return { fileName: record.fileName, sourcePath, size: info.size };
}

export async function retrySessionRecovery(recoveryId) {
  await ensureDirs();
  const recordPath = recoveryRecordPath(recoveryId);
  return runExclusive(recordPath, async () => {
    const record = await readRecoveryRecord(recoveryId);
    const sessionId = record.fileName.replace(/\.json$/i, "");
    const sourcePath = recoverySourcePath(record);
    return runExclusive(sourcePath, async () => {
      const session = await readSessionFile(sourcePath, sessionId);
      await clearRecoveryRecord(record.fileName);
      return sessionSummary(session);
    });
  });
}

export async function deleteSessionRecovery(recoveryId) {
  await ensureDirs();
  const recordPath = recoveryRecordPath(recoveryId);
  return runExclusive(recordPath, async () => {
    const record = await readRecoveryRecord(recoveryId);
    const sourcePath = recoverySourcePath(record);
    return runExclusive(sourcePath, async () => {
      await fs.rm(sourcePath, { force: true });
      await fs.rm(summaryPath(sourcePath), { force: true });
      await fs.rm(recordPath, { force: true });
      return { recoveryId, deleted: true };
    });
  });
}

export async function createSession(title = "New session") {
  await ensureDirs();
  const now = new Date().toISOString();
  const session = {
    id: crypto.randomUUID(),
    sessionSchemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
    title: truncateTitle(String(title ?? "").trim() || "New session"),
    status: "idle",
    mode: "collaboration",
    createdAt: now,
    updatedAt: now,
    messages: [],
    decisions: [],
    settings: {},
    activeRun: null,
  };
  await atomicWrite(sessionPath(session.id), session);
  return session;
}

export async function getSession(id) {
  await ensureDirs();
  const filePath = sessionPath(id);
  return runExclusive(filePath, () => readSessionFile(filePath, id));
}

export async function saveSession(session) {
  session.updatedAt = new Date().toISOString();
  await atomicWrite(sessionPath(session.id), session);
  return session;
}

export async function addMessage(id, message) {
  const filePath = sessionPath(id);
  const saved = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...message,
  };
  // Serialize the whole load→append→save under the per-session lock so two concurrent
  // addMessage calls can't both read the same state and clobber each other's message.
  // (Use doWrite, not saveSession, inside the lock to avoid re-entering runExclusive.)
  await runExclusive(filePath, async () => {
    const session = await readSessionFile(filePath, id);
    session.messages.push(saved);
    session.updatedAt = new Date().toISOString();
    await doWrite(filePath, session);
  });
  return saved;
}

export function rootPath() {
  return RUNTIME_ROOT;
}

export async function scratchWorkspacePath() {
  await fs.mkdir(SCRATCH_WORKSPACE_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(SCRATCH_WORKSPACE_DIR, 0o700);
  return SCRATCH_WORKSPACE_DIR;
}

// The base dir for disposable execution clones (worktree.js owns the per-project layout under it). Pure
// path getter — no I/O — so it's safe to call from cleanup/validation paths; worktree.js creates the
// directories it needs.
export function executionWorkspacesRoot() {
  return EXECUTION_WORKSPACES_DIR;
}

export async function mutateSession(id, mutate) {
  const filePath = sessionPath(id);
  return runExclusive(filePath, async () => {
    await ensureDirs();
    const session = await readSessionFile(filePath, id);
    const result = await mutate(session);
    if (result === SKIP_SESSION_WRITE) return false;
    session.updatedAt = new Date().toISOString();
    await doWrite(filePath, session);
    return result === undefined ? session : result;
  });
}

export async function renameSession(id, title) {
  const next = truncateTitle(String(title ?? "").trim());
  if (!next) {
    const error = new Error("Title is required");
    error.code = "title_required";
    throw error;
  }
  return mutateSession(id, (session) => {
    session.title = next;
    return { id: session.id, title: session.title };
  });
}

export async function deleteSession(id, { isBusy } = {}) {
  const filePath = sessionPath(id);
  return runExclusive(filePath, async () => {
    let session;
    try {
      session = await readSessionFile(filePath, id);
    } catch (error) {
      if (error.code === "ENOENT") {
        const missing = new Error("Session not found");
        missing.code = "ENOENT";
        throw missing;
      }
      throw error;
    }
    if (typeof isBusy === "function" && isBusy()) {
      const error = new Error("Session is already busy");
      error.code = "session_busy";
      throw error;
    }
    if (Array.isArray(session.executions) && session.executions.some(executionNeedsRecovery)) {
      const error = new Error("Resolve pending execution decisions before deleting the session");
      error.code = "pending_execution_decisions";
      throw error;
    }
    if (Array.isArray(session.connectorActions) && session.connectorActions.some((record) => ["pending", "executing_unknown"].includes(record.status))) {
      const error = new Error("Resolve pending connector actions before deleting the session");
      error.code = "pending_execution_decisions";
      throw error;
    }
    await fs.rm(filePath, { force: true });
    await fs.rm(summaryPath(filePath), { force: true });
    return { id: session.id, deleted: true };
  });
}
