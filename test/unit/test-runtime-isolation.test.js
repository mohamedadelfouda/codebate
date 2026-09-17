import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Unit tests that load server modules which touch the runtime root (sessions under data/, logs/) must
// redirect CODEBATE_RUNTIME_DIR before those modules load. Otherwise `npm test` writes into the real
// data/ folder and reconcileInterruptedRuns marks a live session on the same checkout "interrupted".
const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, "../../server");
const RUNTIME_MODULES = new Set([join(serverRoot, "store.js"), join(serverRoot, "logger.js")]);
// Deliberately anchored to the first bytes of the file: the isolation import must run before anything else
// loads, so a leading comment or BOM counts as a violation.
const ISOLATION_IMPORT = /^import "\.\/_runtime-isolation\.mjs";/;

// Relative module specifiers from static imports, `export … from` re-exports, and dynamic `import("…")`
// calls with a string literal. A dynamic import of runtime-touching code still loads it in this process.
function staticImports(file) {
  const source = readFileSync(file, "utf8");
  const patterns = [
    /^\s*import\s+(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm,
    /^\s*export\s+[^"';]*?\s+from\s+["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const specifiers = patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((m) => m[1]));
  return specifiers.filter((s) => s.startsWith(".")).map((s) => resolve(dirname(file), s));
}

const touchesRuntime = new Map();
function reachesRuntime(file, trail = new Set()) {
  if (RUNTIME_MODULES.has(file)) return true;
  if (touchesRuntime.has(file)) return touchesRuntime.get(file);
  if (trail.has(file) || !file.startsWith(serverRoot) || !file.endsWith(".js")) return false;
  trail.add(file);
  let result;
  try {
    result = staticImports(file).some((dep) => reachesRuntime(dep, trail));
  } catch {
    result = false; // an unreadable import target cannot reach the runtime modules
  }
  touchesRuntime.set(file, result);
  return result;
}

test("every unit test that loads runtime-touching server code isolates the runtime root first", () => {
  const offenders = readdirSync(here)
    .filter((name) => name.endsWith(".test.js"))
    .filter((name) => {
      const file = join(here, name);
      const loadsRuntime = staticImports(file).some((dep) => reachesRuntime(dep));
      if (!loadsRuntime) return false;
      return !ISOLATION_IMPORT.test(readFileSync(file, "utf8"));
    });
  assert.deepEqual(offenders, []);
});
