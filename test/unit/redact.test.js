import test from "node:test";
import assert from "node:assert/strict";
import { pullRequestContent } from "../../server/exec-orchestrator.js";
import { redact } from "../../server/logger.js";

test("redact masks OpenAI-style sk- keys", () => {
  const credential = ["sk", "-abcDEF1234567890xyz"].join("");
  const out = redact(`using ${credential} now`);
  assert.match(out, /<redacted-key>/);
  assert.doesNotMatch(out, /abcDEF1234567890xyz/);
});

test("redact masks provider fixtures without committing credential-shaped literals", () => {
  // GitHub secret-scanning alert #1 regression: build formats at runtime so
  // this test exercises redaction without storing a provider-shaped key in Git.
  const credentials = [
    ["gh", "p_abcdefghijklmnopqrstuvwxyz0123"].join(""),
    ["AK", "IAIOSFODNN7EXAMPLE"].join(""),
    ["xox", "b-1234567890-secret"].join(""),
    ["AI", "za12345678901234567890123456789012345"].join(""),
    ["github", "pat", "11AA22BB33CC44DD55EE66FF77"].join("_"),
  ];
  const output = redact(credentials.join(" "));
  for (const credential of credentials) assert.equal(output.includes(credential), false);
  assert.equal(output.match(/<redacted-key>/g)?.length, 5);
});

test("pull request publication redacts task and review text at the boundary", () => {
  const credential = ["gh", "p_abcdefghijklmnopqrstuvwxyz0123"].join("");
  const payload = pullRequestContent({
    task: `Ship safely\nwith ${credential}`,
    review: { text: "APPROVE with Bearer aa.bb.cc-DD_ee" },
  });
  assert.doesNotMatch(`${payload.title}\n${payload.body}`, /ghp_|aa\.bb\.cc/);
  assert.match(payload.title, /^Codebate: Ship safely with <redacted-key>$/);
  assert.match(payload.body, /Bearer <redacted>/);
});

test("redact masks Bearer tokens", () => {
  const out = redact("sent header Bearer aa.bb.cc-DD_ee to api");
  assert.match(out, /Bearer <redacted>/);
  assert.doesNotMatch(out, /aa\.bb\.cc/);
});

test("redact masks credentials embedded in remote URLs", () => {
  const out = redact("fatal: https://owner:secret-token@github.com/owner/repo.git failed");
  assert.equal(out.includes("secret-token"), false);
  assert.match(out, /https:\/\/<redacted>@github\.com/);
});

test("redact masks TOKEN/SECRET/PASSWORD/API_KEY assignments", () => {
  assert.match(redact("GH_TOKEN=ghp_secretvalue"), /<redacted>/);
  assert.match(redact('API_KEY: "zzzzzzzz"'), /<redacted>/);
  assert.match(redact("password = hunter2"), /<redacted>/);
  assert.doesNotMatch(redact("GH_TOKEN=ghp_secretvalue"), /ghp_secretvalue/);
});

test("redact masks Windows user home paths", () => {
  const out = redact("wrote C:\\Users\\SomePerson\\project\\.env");
  assert.match(out, /<user>/);
  assert.doesNotMatch(out, /SomePerson/);
});

test("redact masks unix home paths", () => {
  assert.match(redact("path /home/someone/code"), /\/home\/<user>/);
  assert.match(redact("path /Users/someone/code"), /\/Users\/<user>/);
});

test("redact is a no-op for clean text", () => {
  assert.equal(redact("just a normal log line"), "just a normal log line");
});
