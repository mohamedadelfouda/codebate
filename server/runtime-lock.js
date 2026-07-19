import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// The runtime lock is ADVISORY, not a kernel lock. It upholds "one Codebate writer per data
// directory" under normal operation, but with a bounded, self-healing risk window rather than a hard
// guarantee: the heartbeat proves event-loop liveness (not process liveness), so a server wedged in
// more than CORRUPT_LOCK_STALE_MS of synchronous work can momentarily look dead and have its lock
// taken over by a second server; and takeover keys off file identity (ino + mtime), which some
// filesystems report unreliably (e.g. ino = 0 on certain Windows volumes). A true cross-process kernel
// lock (flock) would need a native dependency, against the project's zero-runtime-deps rule. Two
// operational consequences follow: run ONE server per data directory, and keep the data directory on a
// LOCAL disk — file-sync clients (OneDrive, Dropbox, Google Drive, iCloud) rewrite mtime/ino out of
// band and can both corrupt the lock and clobber session writes. detectSyncedRuntimeFolder surfaces
// that second case as a startup + diagnostics warning; it never blocks startup.

const LOCK_FILE_NAME = ".codebate-runtime.lock";
const HEARTBEAT_INTERVAL_MS = 5000;
const CORRUPT_LOCK_STALE_MS = 30000;

function runtimeLockError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.apiCode = code;
  error.apiStatus = 409;
  return error;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function linuxProcessStartToken(pid) {
  if (process.platform !== "linux") return "";
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
  const closeParen = stat.lastIndexOf(")");
  const token = closeParen === -1 ? "" : stat.slice(closeParen + 2).split(" ")[19] || "";
  if (!token) throw runtimeLockError("runtime_lock_uncertain", "Runtime lock owner identity could not be verified");
  return token;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function heartbeatFresh(stat) {
  return Boolean(stat && Date.now() - stat.mtimeMs < CORRUPT_LOCK_STALE_MS);
}

async function processOwnsRecordedLock(owner, stat, lockPath, staleConfirmMs) {
  if (!processIsAlive(owner?.pid)) return false;
  if (owner.processStartToken && process.platform === "linux") {
    try {
      return await linuxProcessStartToken(owner.pid) === owner.processStartToken;
    } catch (error) {
      if (error?.code === "ENOENT" && !processIsAlive(owner.pid)) return false;
      throw runtimeLockError("runtime_lock_uncertain", "Runtime lock owner identity could not be verified");
    }
  }
  // No strong identity proof (non-Linux, or a legacy record without a start token). A live PID is
  // NOT proof of ownership: after a crash the OS can reuse the dead server's PID for an unrelated
  // process, which would otherwise wedge the data folder until that stranger exits. Fall back to
  // heartbeat freshness — the owner rewrites the lock file's mtime every HEARTBEAT_INTERVAL_MS.
  if (heartbeatFresh(stat)) return true;
  // The heartbeat looks stale but the PID is alive. Before stealing the lock from an owner that may
  // merely have been paused (e.g. host sleep/wake, where its heartbeat timer has not fired yet),
  // give it one more heartbeat window and re-read the mtime: a live Codebate owner refreshes it
  // within that window, a dead one (or an unrelated reused PID) does not. This preserves the
  // "one writer per data directory" invariant against a bounded double-writer race.
  await delay(staleConfirmMs);
  if (!processIsAlive(owner.pid)) return false;
  const confirmed = await readLock(lockPath).catch(() => null);
  if (!confirmed) return false;
  // A different token means another server already took over between our read and now — treat the
  // lock as owned rather than stealing it. The same token with a refreshed mtime means the original
  // owner resumed and is alive. Only a same-owner, still-stale lock is genuinely recoverable.
  if (confirmed.owner?.token !== owner.token) return true;
  return heartbeatFresh(confirmed.stat);
}

async function readLock(lockPath) {
  const [text, stat] = await Promise.all([fs.readFile(lockPath, "utf8"), fs.stat(lockPath)]);
  return { owner: JSON.parse(text), stat };
}

async function createOwnedLock(lockPath, { onOwnershipLost, heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS } = {}) {
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const processStartToken = await linuxProcessStartToken(process.pid).catch(() => "");
  const owner = {
    pid: process.pid,
    token,
    createdAt: now,
    processStartedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
    ...(processStartToken ? { processStartToken } : {}),
  };
  let handle;
  try {
    handle = await fs.open(lockPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      handle = null;
      await fs.rm(lockPath, { force: true }).catch(() => {});
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }

  let released = false;
  let heartbeatRunning = false;
  let ownershipLossReported = false;
  const health = { healthy: true, ownershipLost: false, consecutiveFailures: 0, lastHeartbeatAt: null, lastErrorAt: null, lastErrorCategory: "", released: false };
  const heartbeat = setInterval(async () => {
    if (released || heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      const current = await readLock(lockPath);
      if (current.owner.token !== token) {
        const error = new Error("Runtime lock ownership changed");
        error.code = "runtime_lock_ownership_lost";
        throw error;
      }
      const timestamp = new Date();
      await fs.utimes(lockPath, timestamp, timestamp);
      health.healthy = true;
      health.consecutiveFailures = 0;
      health.lastHeartbeatAt = timestamp.toISOString();
    } catch (error) {
      health.healthy = false;
      health.consecutiveFailures += 1;
      health.lastErrorAt = new Date().toISOString();
      health.lastErrorCategory = String(error?.code || error?.name || "runtime_lock_heartbeat_failed").slice(0, 80);
      const confirmedLoss = ["ENOENT", "runtime_lock_ownership_lost"].includes(error?.code) || error instanceof SyntaxError;
      if (!ownershipLossReported && (confirmedLoss || health.consecutiveFailures >= 3)) {
        ownershipLossReported = true;
        health.ownershipLost = true;
        clearInterval(heartbeat);
        onOwnershipLost?.(error);
      }
    }
    finally { heartbeatRunning = false; }
  }, Math.max(10, heartbeatIntervalMs));
  heartbeat.unref?.();

  return {
    owner,
    lockPath,
    health() { return { ...health }; },
    async release() {
      if (released) return false;
      released = true;
      health.released = true;
      clearInterval(heartbeat);
      try {
        const current = await readLock(lockPath);
        if (current.owner.token !== token) return false;
        await fs.rm(lockPath, { force: true });
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    },
  };
}

export async function acquireRuntimeLock(runtimeRoot, options = {}) {
  const requestedRoot = String(runtimeRoot || "").trim();
  if (!requestedRoot) throw runtimeLockError("runtime_lock_invalid", "Runtime directory is required");
  // How long to wait before confirming a stale-but-alive owner is really gone (one heartbeat + a
  // margin). Configurable so tests don't pay the full window.
  const staleConfirmMs = options.staleConfirmMs ?? HEARTBEAT_INTERVAL_MS + 1000;
  const root = path.resolve(requestedRoot);
  await fs.mkdir(root, { recursive: true });
  const lockPath = path.join(root, LOCK_FILE_NAME);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await createOwnedLock(lockPath, options);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    let observed;
    try {
      observed = await readLock(lockPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      const stat = await fs.stat(lockPath).catch(() => null);
      const recent = stat && Date.now() - stat.mtimeMs < CORRUPT_LOCK_STALE_MS;
      if (recent) throw runtimeLockError("runtime_lock_uncertain", "Runtime lock is incomplete; retry shortly");
      observed = { owner: null, stat };
    }

    if (observed.owner && await processOwnsRecordedLock(observed.owner, observed.stat, lockPath, staleConfirmMs)) {
      throw runtimeLockError("runtime_locked", "Another Codebate server is using this data folder");
    }

    // Tie the takeover to the identity we just inspected: if the lock file changed between the
    // ownership decision and here (another server refreshed or replaced it), do not move that new
    // snapshot aside — restart the loop and re-evaluate the current owner.
    const beforeRename = await fs.stat(lockPath).catch(() => null);
    if (!beforeRename) continue;
    if (observed.stat && (beforeRename.ino !== observed.stat.ino || beforeRename.mtimeMs !== observed.stat.mtimeMs)) continue;
    const stalePath = `${lockPath}.${crypto.randomUUID()}.stale`;
    try {
      await fs.rename(lockPath, stalePath);
    } catch (error) {
      if (["ENOENT", "EEXIST"].includes(error?.code)) continue;
      throw error;
    }
    try {
      return await createOwnedLock(lockPath, options);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    } finally {
      await fs.rm(stalePath, { force: true }).catch(() => {});
    }
  }
  throw runtimeLockError("runtime_locked", "Another Codebate server acquired this data folder");
}

// Default folder names the major file-sync clients use, matched anywhere in the path (cross-platform;
// backslash or forward slash). The trailing class requires a separator, space, or end-of-string AFTER
// the name, so "OneDrive - Contoso" (business, space-separated) matches but "onedrive-uploader" does
// not. Modern hyphenated mounts ("OneDrive-Contoso", "GoogleDrive-user@x") live under macOS
// CloudStorage and are handled by CLOUD_STORAGE_MOUNT below — which sidesteps the "OneDrive-<word>"
// false-positive ambiguity entirely rather than trying to tell a real suffix from a coincidence.
const SYNCED_FOLDER_MARKERS = [
  { provider: "OneDrive", pattern: /[\\/]OneDrive(?:[\\/ ]|$)/i },
  { provider: "Dropbox", pattern: /[\\/]Dropbox(?:[\\/ ]|$)/i },
  { provider: "Google Drive", pattern: /[\\/]Google ?Drive(?:[\\/ ]|$)/i },
  { provider: "iCloud Drive", pattern: /[\\/](?:iCloud Drive|Mobile Documents)(?:[\\/]|$)/i },
];

// macOS "File Provider" desktop clients (OneDrive, Google Drive, Dropbox, Box, …) all mount under
// ~/Library/CloudStorage/<Provider>-<account>/. Matching the parent catches every hyphenated suffix
// without guessing it; the leading provider word maps to a friendly label.
const CLOUD_STORAGE_MOUNT = /[\\/]Library[\\/]CloudStorage[\\/]([A-Za-z]+)/i;
const CLOUD_STORAGE_PROVIDERS = { onedrive: "OneDrive", googledrive: "Google Drive", dropbox: "Dropbox", box: "Box", icloud: "iCloud Drive" };

function pathIsInside(child, parent) {
  const rel = path.relative(path.resolve(String(parent)), path.resolve(String(child)));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Best-effort heuristic: is the runtime/data directory inside a known file-sync client's folder?
// Returns { provider } when it looks synced, else null. Used ONLY to warn — never to block, so a false
// positive can never stop the app. Matches macOS CloudStorage mounts and the default folder names
// cross-platform, plus the Windows %OneDrive%* env roots (OneDrive can redirect Documents/Desktop
// without "OneDrive" in the visible path).
export function detectSyncedRuntimeFolder(runtimeRoot, env = process.env) {
  const resolved = path.resolve(String(runtimeRoot || "."));
  const mount = resolved.match(CLOUD_STORAGE_MOUNT);
  if (mount) return { provider: CLOUD_STORAGE_PROVIDERS[mount[1].toLowerCase()] || "cloud storage" };
  for (const { provider, pattern } of SYNCED_FOLDER_MARKERS) {
    if (pattern.test(resolved)) return { provider };
  }
  for (const key of ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]) {
    const base = env?.[key];
    if (base && String(base).trim() && pathIsInside(resolved, base)) return { provider: "OneDrive" };
  }
  return null;
}
