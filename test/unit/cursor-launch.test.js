import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, access, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCursorLaunchDescriptor, versionSortKey } from "../../server/providers/cursor-launch.js";

// The builder is host-bound, so fixtures use the host's launch-chain file names.
const EXE = process.platform === "win32" ? "node.exe" : "node";
const SANDBOX = process.platform === "win32" ? "cursorsandbox.exe" : "cursorsandbox";

// Create a throwaway cursor-agent install (host-appropriate file names) and return its root.
async function fakeInstall(versions = { "2026.07.16-899851b": true }) {
  const root = await mkdtemp(path.join(tmpdir(), "cursor-agent-"));
  for (const [name, withSandbox] of Object.entries(versions)) {
    const dir = path.join(root, "versions", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, EXE), "binary");
    if (process.platform !== "win32") await chmod(path.join(dir, EXE), 0o755); // the node runtime is launched directly, so it must be executable
    await writeFile(path.join(dir, "index.js"), "console.log('cursor');");
    if (withSandbox) await writeFile(path.join(dir, SANDBOX), "sandbox");
  }
  return root;
}

test("versionSortKey orders version dirs and rejects non-version names", () => {
  assert.equal(versionSortKey("not-a-version"), null);
  assert.equal(versionSortKey("2026.07.16"), null); // no commit suffix
  assert.ok(versionSortKey("2026.07.16-899851b") > versionSortKey("2026.07.9-a3815c0"));
  // the newer YYYY.MM.DD-HH-MM-SS form sorts above the same day with no build time
  assert.ok(versionSortKey("2026.7.16-01-02-03-abc") > versionSortKey("2026.7.16-abc"));
});

test("builds and validates a descriptor from a cursor-agent install", async () => {
  const root = await fakeInstall();
  try {
    const result = await buildCursorLaunchDescriptor({ installRoot: root });
    assert.equal(result.ok, true);
    assert.equal(result.validation.valid, true, JSON.stringify(result.validation.violations));
    assert.equal(result.descriptor.providerId, "cursor");
    assert.equal(result.descriptor.version, "2026.07.16-899851b");
    assert.match(result.descriptor.executableFingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.match(result.descriptor.entryPointFingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(result.descriptor.fixedPrefixArgs, [result.descriptor.entryPoint]);
    assert.ok(result.sandboxPath && result.sandboxFingerprint, "sandbox should be fingerprinted when present");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a missing sandbox binary yields sandboxPath null (executor qualification then fails closed)", async () => {
  const root = await fakeInstall({ "2026.07.16-899851b": false }); // no sandbox file
  try {
    const result = await buildCursorLaunchDescriptor({ installRoot: root });
    assert.equal(result.ok, true);
    assert.equal(result.sandboxPath, null);
    assert.equal(result.sandboxFingerprint, null);
    assert.equal(result.validation.valid, true); // the descriptor itself is still well-formed
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("picks the latest version directory", async () => {
  const root = await fakeInstall({ "2026.07.09-a3815c0": true, "2026.07.16-899851b": true });
  try {
    const result = await buildCursorLaunchDescriptor({ installRoot: root });
    assert.equal(result.version, "2026.07.16-899851b");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reports absence instead of throwing when the install or entry point is missing", async () => {
  const missing = await buildCursorLaunchDescriptor({ installRoot: path.join(tmpdir(), "no-such-cursor-agent-xyz") });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /versions directory not found/);

  const root = await mkdtemp(path.join(tmpdir(), "cursor-agent-"));
  try {
    const dir = path.join(root, "versions", "2026.07.16-899851b");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, EXE), "binary"); // node present, index.js absent
    if (process.platform !== "win32") await chmod(path.join(dir, EXE), 0o755); // executable, so the builder reaches the index.js check rather than failing on X_OK first
    const result = await buildCursorLaunchDescriptor({ installRoot: root });
    assert.equal(result.ok, false);
    assert.match(result.reason, /index\.js missing/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// win32 has no execute-bit concept and root bypasses X_OK, so the execute-bit requirement is only
// enforceable on a non-root POSIX host (where CI runs it).
const SKIP_EXEC_BIT = process.platform === "win32" || process.getuid?.() === 0;
test("a node runtime that exists but is not executable is rejected (POSIX)", { skip: SKIP_EXEC_BIT }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cursor-agent-"));
  try {
    const dir = path.join(root, "versions", "2026.07.16-899851b");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, EXE), "binary"); // left 0644 (not executable) → would fail with EACCES at launch
    await writeFile(path.join(dir, "index.js"), "console.log('cursor');");
    const result = await buildCursorLaunchDescriptor({ installRoot: root });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not executable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects a launch chain whose entry point symlinks outside the trusted directory", async () => {
  const root = await fakeInstall();
  const outside = await mkdtemp(path.join(tmpdir(), "cursor-evil-"));
  try {
    const entry = path.join(root, "versions", "2026.07.16-899851b", "index.js");
    const evil = path.join(outside, "evil-index.js");
    await writeFile(evil, "console.log('evil');");
    await rm(entry, { force: true });
    try { await symlink(evil, entry); }
    catch { return; } // symlinks not permitted here (e.g. Windows without privilege) — nothing to prove
    const result = await buildCursorLaunchDescriptor({ installRoot: root });
    assert.equal(result.ok, false);
    assert.match(result.reason, /outside the trusted version directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("builds a valid descriptor from the real cursor-agent install", { skip: process.platform !== "win32" }, async () => {
  const installRoot = path.join(process.env.LOCALAPPDATA || "", "cursor-agent");
  try { await access(path.join(installRoot, "versions")); }
  catch { return; } // cursor-agent not installed here — nothing to prove
  const result = await buildCursorLaunchDescriptor({ installRoot });
  assert.equal(result.ok, true);
  assert.equal(result.validation.valid, true, JSON.stringify(result.validation?.violations));
  assert.match(result.descriptor.executable, /node\.exe$/);
  assert.match(result.descriptor.entryPoint, /index\.js$/);
});
