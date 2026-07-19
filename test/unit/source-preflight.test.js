import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isNodeSupported, isGitPresent } from "../../scripts/source-preflight.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/source-preflight.mjs");

test("source-preflight passes on a supported host and never starts the server", () => {
  // The test runner itself is Node >= 22 with Git available, so the happy path must exit 0 and report OK.
  // execFileSync throws on a non-zero exit, so reaching the assertion already proves exit 0.
  const out = execFileSync(process.execPath, [script], { encoding: "utf8" });
  assert.match(out, /Preflight OK — Node .+ on .+\/.+\./);
  assert.doesNotMatch(out, /listening|server ready|127\.0\.0\.1/i); // it must not spawn the server
});

test("isNodeSupported gates on Node major >= 22", () => {
  // The hard startup gate — exercise the branch the happy-path subprocess test can't reach (it always
  // runs on the supported test-runner Node).
  for (const v of ["22.0.0", "22.11.0", "24.3.1"]) assert.equal(isNodeSupported(v), true, v);
  for (const v of ["21.7.3", "20.11.1", "18.19.0"]) assert.equal(isNodeSupported(v), false, v);
  assert.equal(isNodeSupported("nonsense"), false); // unparseable major → unsupported, never a throw
});

test("isGitPresent is true only for a clean `git --version` probe", () => {
  assert.equal(isGitPresent({ status: 0 }), true);
  assert.equal(isGitPresent({ error: new Error("spawn git ENOENT") }), false); // Git not installed
  assert.equal(isGitPresent({ error: new Error("ETIMEDOUT"), status: null }), false); // hung probe → timed out
  assert.equal(isGitPresent({ status: 1 }), false);
  assert.equal(isGitPresent({ status: null }), false); // signal-killed probe
});
