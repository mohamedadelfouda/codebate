import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDiff, changedFiles } from "../../server/worktree.js";
import { scanForSecrets, hasBlockingSecrets } from "../../server/secret-scan.js";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
const openAiFixture = ["sk", "-abcdefghij1234567890xyz"].join("");
const awsAccessKeyFixture = ["AK", "IAIOSFODNN7EXAMPLE"].join("");

test("changed files are scanned; a secret is caught and getDiff writes no commit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-secret-"));
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "README.md"), "hello\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");

    // Simulate an executor's changes: one clean file + one secret-bearing file.
    writeFileSync(join(dir, "app.js"), "export const x = 1;\n");
    writeFileSync(join(dir, ".env"), `OPENAI_API_KEY=${openAiFixture}\n`);

    const diff = await getDiff(dir);
    assert.match(diff.files, /app\.js/);
    assert.match(diff.files, /\.env/);

    const files = await changedFiles(dir);
    assert.deepEqual(files.map((f) => f.path).sort(), [".env", "app.js"]);

    const findings = scanForSecrets(files);
    assert.ok(hasBlockingSecrets(findings), "should block on the .env secret");
    assert.ok(findings.some((f) => f.path === ".env"));

    // Intent-to-add must not have produced a commit — only the init commit exists.
    const commits = git(dir, "log", "--oneline").trim().split(/\r?\n/);
    assert.equal(commits.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clean change scans clean", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-clean-"));
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "README.md"), "hello\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");

    writeFileSync(join(dir, "app.js"), "export const add = (a, b) => a + b;\n");
    await getDiff(dir);
    const findings = scanForSecrets(await changedFiles(dir));
    assert.deepEqual(findings, []);
    assert.equal(hasBlockingSecrets(findings), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getDiff shows changes the agent already staged (diff vs HEAD, not index)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-staged-"));
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "README.md"), "hello\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");

    // The agent modifies + stages a file itself, plus leaves an untracked one.
    writeFileSync(join(dir, "README.md"), "hello\nworld\n");
    git(dir, "add", "README.md");
    writeFileSync(join(dir, "new.js"), "export const y = 2;\n");

    const diff = await getDiff(dir);
    assert.match(diff.files, /README\.md/, "staged change must appear in the review diff");
    assert.match(diff.files, /new\.js/, "untracked change must appear");
    assert.match(diff.patch, /world/, "staged content must be in the patch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a secret the executor commits ITSELF is still caught (scan vs base SHA)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-selfcommit-"));
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "README.md"), "hello\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
    const baseSha = git(dir, "rev-parse", "HEAD").trim();

    // The executor writes a secret and commits it itself — HEAD moves past it, so a
    // HEAD-based scan would see nothing. The base-SHA scan must still catch it.
    writeFileSync(join(dir, "deploy.sh"), `AWS_KEY=${awsAccessKeyFixture}\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "wip");

    const files = await changedFiles(dir, baseSha);
    assert.ok(files.some((f) => f.path === "deploy.sh"), "self-committed file must be scanned");
    assert.ok(hasBlockingSecrets(scanForSecrets(files)), "self-committed secret must block");
    assert.match((await getDiff(dir, baseSha)).files, /deploy\.sh/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a secret in a non-ASCII filename is read and scanned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ar-unicode-"));
  try {
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "README.md"), "hello\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
    const baseSha = git(dir, "rev-parse", "HEAD").trim();

    writeFileSync(join(dir, "café.js"), `const k = '${openAiFixture}';\n`);
    const files = await changedFiles(dir, baseSha);
    const hit = files.find((f) => f.path.includes("caf"));
    assert.ok(hit, "non-ASCII filename must be listed");
    assert.ok(hit.content.includes(openAiFixture), "its content must actually be read");
    assert.ok(hasBlockingSecrets(scanForSecrets(files)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
