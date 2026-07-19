import fs from "node:fs/promises";
import path from "node:path";
import { nativeCliSearchPath } from "./process.js";

// Discovery locates native provider executables that plain PATH search misses,
// e.g. a Windows npm install of Codex exposes only cmd/ps1 shims on PATH while
// the real codex.exe sits inside the npm package. Discovery is read-only: it
// probes a fixed set of well-known filesystem layouts and never runs a shim or
// package code. Executing a discovered path still requires the user's explicit
// Trust & check, which re-validates it through the command allowlist.

const MAX_CANDIDATES = 5;

// Codex ships its Rust binary in per-platform npm packages; the launcher
// resolves vendor/<target-triple>/bin/codex(.exe) inside them.
const CODEX_PLATFORM_TARGETS = {
  "win32:x64": { pkg: "@openai/codex-win32-x64", triple: "x86_64-pc-windows-msvc", binary: "codex.exe" },
  "win32:arm64": { pkg: "@openai/codex-win32-arm64", triple: "aarch64-pc-windows-msvc", binary: "codex.exe" },
  "darwin:x64": { pkg: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin", binary: "codex" },
  "darwin:arm64": { pkg: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin", binary: "codex" },
  "linux:x64": { pkg: "@openai/codex-linux-x64", triple: "x86_64-unknown-linux-musl", binary: "codex" },
  "linux:arm64": { pkg: "@openai/codex-linux-arm64", triple: "aarch64-unknown-linux-musl", binary: "codex" },
};

function codexLayouts(platform, arch) {
  const target = CODEX_PLATFORM_TARGETS[`${platform}:${arch}`];
  if (!target) return [];
  const vendorTail = ["vendor", target.triple, "bin", target.binary];
  const [scope, name] = target.pkg.split("/");
  return [
    // npm keeps the optional platform package nested under the CLI package.
    ["@openai", "codex", "node_modules", scope, name, ...vendorTail],
    // Hoisted installs place the platform package at the node_modules root.
    [scope, name, ...vendorTail],
    // The launcher's fallback vendors binaries inside the CLI package itself.
    ["@openai", "codex", ...vendorTail],
  ];
}

// Layout probes per provider command, relative to a global node_modules root.
// Claude's native installer already lands on the PATH search (~/.local/bin),
// so it needs no package-layout probes.
const NODE_PACKAGE_LAYOUTS = { codex: codexLayouts };

function homeDirectory(env) {
  return env.USERPROFILE || env.HOME || "";
}

async function directoryNames(directory) {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// pnpm stores global packages under <pnpm-home>/global/<store-version>/node_modules.
async function pnpmGlobalRoots(pnpmHome) {
  if (!pnpmHome) return [];
  const globalBase = path.join(pnpmHome, "global");
  const versions = (await directoryNames(globalBase)).filter((name) => /^\d+$/.test(name)).slice(0, 4);
  return versions.map((version) => path.join(globalBase, version, "node_modules"));
}

async function nodeModulesRoots({ platform, env }) {
  const home = homeDirectory(env);
  const roots = [];
  // npm's global bin directory sits beside (Windows) or one level above
  // (POSIX lib/) its node_modules, so derive both from every search-path dir.
  for (const directory of nativeCliSearchPath(env).split(path.delimiter).filter(Boolean)) {
    roots.push(path.join(directory, "node_modules"));
    roots.push(path.join(directory, "..", "lib", "node_modules"));
  }
  if (platform === "win32") {
    if (env.APPDATA) roots.push(path.join(env.APPDATA, "npm", "node_modules"));
    if (env.LOCALAPPDATA) roots.push(...await pnpmGlobalRoots(path.join(env.LOCALAPPDATA, "pnpm")));
  } else if (home) {
    roots.push(path.join(home, ".npm-global", "lib", "node_modules"));
    const pnpmHome = platform === "darwin" ? path.join(home, "Library", "pnpm") : path.join(home, ".local", "share", "pnpm");
    roots.push(...await pnpmGlobalRoots(pnpmHome));
  }
  if (platform !== "win32") roots.push("/usr/local/lib/node_modules", "/usr/lib/node_modules", "/opt/homebrew/lib/node_modules");
  if (home) roots.push(path.join(home, ".bun", "install", "global", "node_modules"));
  return [...new Set(roots.map((root) => path.normalize(path.resolve(root))))];
}

async function nativeExecutable(candidate, platform) {
  try {
    const stats = await fs.stat(candidate);
    if (!stats.isFile()) return "";
    await fs.access(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return await fs.realpath(candidate);
  } catch {
    return "";
  }
}

export function providerDiscoveryLayouts(command, { platform = process.platform, arch = process.arch } = {}) {
  const layouts = NODE_PACKAGE_LAYOUTS[String(command || "").toLowerCase()];
  return layouts ? layouts(platform, arch) : [];
}

export async function discoverProviderCommands(command, { platform = process.platform, arch = process.arch, env = process.env } = {}) {
  const layouts = providerDiscoveryLayouts(command, { platform, arch });
  if (layouts.length === 0) return [];
  const found = [];
  const seen = new Set();
  for (const root of await nodeModulesRoots({ platform, env })) {
    for (const layout of layouts) {
      const resolved = await nativeExecutable(path.join(root, ...layout), platform);
      if (!resolved) continue;
      const key = platform === "win32" ? resolved.toLowerCase() : resolved;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(resolved);
      if (found.length >= MAX_CANDIDATES) return found;
    }
  }
  return found;
}
