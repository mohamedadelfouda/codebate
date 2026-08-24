// Verify the actual npm tarball manifest, not only package.json intent. This protects lifecycle commands
// from referencing files omitted by the package `files` whitelist (for example `npm start` calling the
// source preflight). `npm pack --dry-run --json` applies npm's real packing rules without creating a tgz.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packArgs = ["pack", "--dry-run", "--json"];

// Windows exposes npm primarily through npm.cmd. Node 22's execFileSync does not execute .cmd shims
// directly without a shell (`spawnSync npm.cmd EINVAL`). Keep this smoke shell-free and still exercise
// npm's real packer by invoking the npm CLI JavaScript with the current Node runtime. Standard Node
// distributions (including setup-node and normal Windows installs) ship npm beside node.exe.
let command = "npm";
let args = packArgs;
if (process.platform === "win32") {
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  assert.equal(existsSync(npmCli), true, `npm CLI must exist beside Node on Windows: ${npmCli}`);
  command = process.execPath;
  args = [npmCli, ...packArgs];
}

const raw = execFileSync(command, args, {
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
