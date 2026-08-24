// Verify the actual npm tarball manifest, not only package.json intent. This protects lifecycle commands
// from referencing files omitted by the package `files` whitelist (for example `npm start` calling the
// source preflight). `npm pack --dry-run --json` applies npm's real packing rules without creating a tgz.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const raw = execFileSync(npm, ["pack", "--dry-run", "--json"], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" },
});

const result = JSON.parse(raw);
assert.equal(Array.isArray(result), true, "npm pack --json must return an array");
assert.equal(result.length, 1, "exactly one package should be described");

const packed = new Set((result[0].files || []).map((file) => file.path.replaceAll("\\", "/")));
for (const required of [
  "package.json",
  "bin/codebate.mjs",
  "server/index.js",
  "public/index.html",
  "scripts/source-preflight.mjs",
]) {
  assert.equal(packed.has(required), true, `${required} must be present in the npm package`);
}

console.log("npm package smoke passed");
