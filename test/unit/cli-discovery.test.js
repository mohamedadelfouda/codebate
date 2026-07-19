import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { discoverProviderCommands, providerDiscoveryLayouts } from "../../server/cli-discovery.js";

async function makeExecutable(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "binary placeholder");
  await fs.chmod(filePath, 0o755);
}

async function withTempDir(run) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codebate-cli-discovery-"));
  try {
    return await run(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("codex layouts target only the native binary for the requested platform", () => {
  const layouts = providerDiscoveryLayouts("codex", { platform: "win32", arch: "x64" });
  assert.ok(layouts.length >= 2);
  for (const layout of layouts) {
    assert.equal(layout.at(-1), "codex.exe");
    assert.ok(layout.includes("vendor"));
  }
  const posixLayouts = providerDiscoveryLayouts("codex", { platform: "linux", arch: "arm64" });
  for (const layout of posixLayouts) assert.equal(layout.at(-1), "codex");
});

test("unknown commands and unsupported platforms discover nothing", async () => {
  assert.deepEqual(providerDiscoveryLayouts("claude"), []);
  assert.deepEqual(providerDiscoveryLayouts("calc"), []);
  assert.deepEqual(await discoverProviderCommands("calc"), []);
  assert.deepEqual(await discoverProviderCommands("codex", { platform: "sunos", arch: "x64", env: { PATH: "" } }), []);
});

test("discovers the codex.exe hidden behind a Windows npm shim install", async () => {
  await withTempDir(async (tempDir) => {
    const exe = path.join(
      tempDir, "npm", "node_modules", "@openai", "codex", "node_modules",
      "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe",
    );
    await makeExecutable(exe);
    // The npm global bin directory (containing only cmd/ps1 shims) is on PATH;
    // discovery must derive its node_modules sibling and find the vendor exe.
    const env = { PATH: path.join(tempDir, "npm"), APPDATA: tempDir, USERPROFILE: tempDir };
    const found = await discoverProviderCommands("codex", { platform: "win32", arch: "x64", env });
    assert.equal(found.length, 1, `expected one candidate, got: ${found.join(", ")}`);
    assert.equal(path.basename(found[0]).toLowerCase(), "codex.exe");
  });
});

test("duplicate roots from PATH and APPDATA yield one deduplicated candidate", async () => {
  await withTempDir(async (tempDir) => {
    const exe = path.join(
      tempDir, "npm", "node_modules", "@openai", "codex-win32-x64",
      "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe",
    );
    await makeExecutable(exe);
    const env = {
      PATH: [path.join(tempDir, "npm"), path.join(tempDir, "npm")].join(path.delimiter),
      APPDATA: tempDir,
      USERPROFILE: tempDir,
    };
    const found = await discoverProviderCommands("codex", { platform: "win32", arch: "x64", env });
    assert.equal(found.length, 1);
  });
});

test("discovers a POSIX npm prefix install through the bin directory on PATH", async () => {
  await withTempDir(async (tempDir) => {
    const exe = path.join(
      tempDir, "lib", "node_modules", "@openai", "codex", "node_modules",
      "@openai", "codex-linux-x64", "vendor", "x86_64-unknown-linux-musl", "bin", "codex",
    );
    await makeExecutable(exe);
    const env = { PATH: path.join(tempDir, "bin"), HOME: tempDir };
    const found = await discoverProviderCommands("codex", { platform: "linux", arch: "x64", env });
    assert.equal(found.length, 1);
    assert.equal(path.basename(found[0]), "codex");
  });
});

test("discovers the fallback vendor layout inside the CLI package itself", async () => {
  await withTempDir(async (tempDir) => {
    const exe = path.join(
      tempDir, "npm", "node_modules", "@openai", "codex",
      "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe",
    );
    await makeExecutable(exe);
    const env = { PATH: path.join(tempDir, "npm"), APPDATA: tempDir, USERPROFILE: tempDir };
    const found = await discoverProviderCommands("codex", { platform: "win32", arch: "x64", env });
    assert.equal(found.length, 1, `expected one candidate, got: ${found.join(", ")}`);
    assert.equal(path.basename(found[0]).toLowerCase(), "codex.exe");
  });
});

test("directories and shim scripts at the probe location are not offered", async () => {
  await withTempDir(async (tempDir) => {
    const binDir = path.join(
      tempDir, "npm", "node_modules", "@openai", "codex", "node_modules",
      "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin",
    );
    // A directory named like the binary must not be treated as an executable.
    await fs.mkdir(path.join(binDir, "codex.exe"), { recursive: true });
    const env = { PATH: "", APPDATA: tempDir, USERPROFILE: tempDir };
    const found = await discoverProviderCommands("codex", { platform: "win32", arch: "x64", env });
    assert.deepEqual(found, []);
  });
});
