import { createHash } from "node:crypto";
import { readFile, readdir, access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateTrustedLaunchDescriptor } from "./cursor-qualification.js";

// CU-1 — build a Cursor trusted-launch descriptor from a real cursor-agent install.
//
// The cursor-agent launcher runs `node(.exe) index.js <args>` from the latest versions/<v>/ directory (see
// the shipped cursor-agent.ps1). This module resolves that exact chain on disk and fingerprints it, so
// Codebate can run Cursor's Node entry point through a fingerprint-pinned descriptor instead of adding
// the generic Node runtime to the process allowlist. The built descriptor is checked by
// validateTrustedLaunchDescriptor; a build that cannot be validated is returned WITH its violations
// (never silently trusted). Because it reads real files, the builder runs on — and builds for — the host
// platform; `platform`/`arch` default to the current process and are carried into the descriptor.

// cursor-agent version dir names: YYYY.MM.DD[-HH-MM-SS]-<commit>. Matches the launcher's accepted forms.
const VERSION_DIR = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d{2})-(\d{2})-(\d{2}))?-[a-f0-9]+$/;

// Sortable numeric key from a version dir name, mirroring the launcher's "latest version" selection.
// Returns null for names that don't match, so non-version entries are filtered out.
export function versionSortKey(name) {
  const m = VERSION_DIR.exec(name);
  if (!m) return null;
  const [, y, mo, d, hh = "0", mm = "0", ss = "0"] = m;
  return ((((Number(y) * 100 + Number(mo)) * 100 + Number(d)) * 100 + Number(hh)) * 100 + Number(mm)) * 100 + Number(ss);
}

// Default install locations. The Windows path is verified; POSIX installs vary, so callers that know the
// real root should pass `installRoot` explicitly rather than rely on this guess.
function defaultInstallRoot(platform) {
  if (platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "cursor-agent");
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "cursor-agent");
}

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

// The node runtime is launched directly, so on POSIX it must carry the execute bit — a 0644 `node` exists
// but the launch fails with EACCES, so existence alone would pass a descriptor that can never run. Windows
// has no execute-bit concept for a file, so existence is enough there. Mirrors resolveAllowedCommand's
// check in server/process.js.
async function isExecutable(filePath, platform) {
  try { await access(filePath, platform === "win32" ? constants.F_OK : constants.X_OK); return true; }
  catch { return false; }
}

async function fingerprint(filePath) {
  return `sha256:${createHash("sha256").update(await readFile(filePath)).digest("hex")}`;
}

/**
 * Build and validate a Cursor trusted-launch descriptor from an on-disk cursor-agent install.
 *
 * @param {{installRoot?: string, platform?: string, arch?: string}} [options]
 *   installRoot — the cursor-agent install root (contains `versions/`); defaults to the platform location.
 *   platform/arch — carried into the descriptor; default to the host process (the builder is host-bound).
 * @returns {Promise<{ok: true, descriptor: object, trustedRoot: string, version: string,
 *   sandboxPath: string|null, sandboxFingerprint: string|null, validation: {valid: boolean, violations: string[]}}
 *   | {ok: false, reason: string}>}
 */
export async function buildCursorLaunchDescriptor({ installRoot, platform = process.platform, arch = process.arch } = {}) {
  const root = installRoot || defaultInstallRoot(platform);
  const versionsDir = path.join(root, "versions");
  let entries;
  try {
    entries = await readdir(versionsDir, { withFileTypes: true });
  } catch {
    return { ok: false, reason: `cursor-agent versions directory not found at ${versionsDir}` };
  }
  const latest = entries
    .filter((entry) => entry.isDirectory() && versionSortKey(entry.name) !== null)
    .sort((a, b) => versionSortKey(b.name) - versionSortKey(a.name))[0];
  if (!latest) return { ok: false, reason: `no cursor-agent version directory under ${versionsDir}` };

  const nominalRoot = path.join(versionsDir, latest.name);
  const nominalExecutable = path.join(nominalRoot, platform === "win32" ? "node.exe" : "node");
  const nominalEntry = path.join(nominalRoot, "index.js");
  if (!(await isExecutable(nominalExecutable, platform))) return { ok: false, reason: `node runtime missing or not executable in ${nominalRoot}` };
  if (!(await exists(nominalEntry))) return { ok: false, reason: `index.js missing in ${nominalRoot}` };
  // The sandbox binary backs execution containment. On installs/platforms without it, executor
  // qualification fails closed on cursorSandboxTrusted rather than the build guessing a wrong path.
  const nominalSandbox = path.join(nominalRoot, platform === "win32" ? "cursorsandbox.exe" : "cursorsandbox");
  const hasSandbox = await exists(nominalSandbox);

  // Resolve real paths and require the launch chain to stay INSIDE the trusted version directory: a
  // symlinked node/index.js could otherwise pass nominal-path containment while resolving to attacker
  // files elsewhere. Reads, fingerprints, and the descriptor all use the resolved paths, and any component
  // that vanishes mid-build fails closed (returns a reason) rather than throwing.
  let trustedRoot, executable, entryPoint, sandboxPath = null;
  let executableFingerprint, entryPointFingerprint, sandboxFingerprint = null;
  try {
    trustedRoot = await realpath(nominalRoot);
    executable = await realpath(nominalExecutable);
    entryPoint = await realpath(nominalEntry);
    const contained = (target) => {
      const rel = path.relative(trustedRoot, target);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    };
    if (!contained(executable) || !contained(entryPoint)) {
      return { ok: false, reason: "launch chain resolves outside the trusted version directory (symlink indirection)" };
    }
    if (hasSandbox) {
      sandboxPath = await realpath(nominalSandbox);
      if (!contained(sandboxPath)) return { ok: false, reason: "cursor sandbox resolves outside the trusted version directory" };
      sandboxFingerprint = await fingerprint(sandboxPath);
    }
    executableFingerprint = await fingerprint(executable);
    entryPointFingerprint = await fingerprint(entryPoint);
  } catch {
    return { ok: false, reason: `launch chain vanished while resolving under ${nominalRoot}` };
  }

  const descriptor = {
    schemaVersion: 1,
    providerId: "cursor",
    executable,
    executableFingerprint,
    entryPoint,
    entryPointFingerprint,
    fixedPrefixArgs: [entryPoint],
    version: latest.name,
    platform,
    arch,
  };
  const validation = validateTrustedLaunchDescriptor(descriptor, { trustedRoot, platform, arch });
  return {
    ok: true,
    descriptor,
    trustedRoot,
    version: latest.name,
    sandboxPath,
    sandboxFingerprint,
    validation,
  };
}
