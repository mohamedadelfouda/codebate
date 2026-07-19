import test from "node:test";
import assert from "node:assert/strict";
import { scanForSecrets, hasBlockingSecrets } from "../../server/secret-scan.js";

const credentialFixtures = {
  openai: ["sk", "-abcdefghij1234567890xyz"].join(""),
  github: ["gh", "p_abcdefghijklmnopqrstuvwxyz0123"].join(""),
  awsAccessKey: ["AK", "IAIOSFODNN7EXAMPLE"].join(""),
  google: ["AI", "za", "B".repeat(35)].join(""),
};

test("flags sensitive filenames (.env, keys) and blocks", () => {
  const f = scanForSecrets([{ path: "config/.env", content: "X=1" }]);
  assert.ok(f.some((x) => x.rule === "sensitive-filename"));
  assert.ok(hasBlockingSecrets(f));
  assert.ok(scanForSecrets([{ path: "server.key", content: "" }]).some((x) => x.rule === "sensitive-filename"));
});

test("detects a private key block (critical)", () => {
  const privateKeyHeader = ["-----BEGIN RSA ", "PRIVATE KEY-----"].join("");
  const f = scanForSecrets([{ path: "a.txt", content: `${privateKeyHeader}\nMIIabc` }]);
  assert.ok(f.some((x) => x.rule === "private-key" && x.severity === "critical"));
});

test("detects provider tokens", () => {
  assert.ok(scanForSecrets([{ path: "a", content: `k ${credentialFixtures.openai}` }]).some((x) => x.rule === "openai-key"));
  assert.ok(scanForSecrets([{ path: "a", content: credentialFixtures.github }]).some((x) => x.rule === "github-token"));
  assert.ok(scanForSecrets([{ path: "a", content: credentialFixtures.awsAccessKey }]).some((x) => x.rule === "aws-access-key-id"));
  assert.ok(scanForSecrets([{ path: "a", content: credentialFixtures.google }]).some((x) => x.rule === "google-api-key"));
});

test("detects secret-looking assignments", () => {
  const assignment = ['const password = "', "hunter2xyz", '";'].join("");
  assert.ok(scanForSecrets([{ path: "a.js", content: assignment }]).some((x) => x.rule === "secret-assignment"));
});

test("detects unquoted secret assignments but not code refs", () => {
  const assignment = ["DB_PASSWORD=", "supersecretlongvalue"].join("");
  assert.ok(scanForSecrets([{ path: "config.sh", content: assignment }]).some((x) => x.rule === "secret-assignment-unquoted"));
  // env-var / code references should not false-positive
  assert.deepEqual(scanForSecrets([{ path: "a.js", content: "const password = process.env.PW;" }]), []);
  assert.deepEqual(scanForSecrets([{ path: "a.js", content: "let secret = require('./s');" }]), []);
});

test("reports the line number but never the secret value", () => {
  const f = scanForSecrets([{ path: "a", content: `line1\nx = ${credentialFixtures.openai}\nline3` }]);
  const hit = f.find((x) => x.rule === "openai-key");
  assert.equal(hit.line, 2);
  assert.equal(JSON.stringify(hit).includes(credentialFixtures.openai), false);
});

test("blocks an oversized file that could not be content-scanned", () => {
  const f = scanForSecrets([{ path: "assets/big.bin", content: "", oversize: true }]);
  assert.ok(f.some((x) => x.rule === "unscanned-large-file" && x.severity === "high"));
  assert.equal(hasBlockingSecrets(f), true);
});

test("clean files produce no findings", () => {
  const f = scanForSecrets([{ path: "src/app.js", content: "export const x = 1;\nconsole.log(x);" }]);
  assert.deepEqual(f, []);
  assert.equal(hasBlockingSecrets(f), false);
});
