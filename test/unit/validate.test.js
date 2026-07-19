import test from "node:test";
import assert from "node:assert/strict";
import { validateOption, allowedCommand } from "../../server/process.js";

test("validateOption accepts normal option values", () => {
  assert.equal(validateOption("sonnet", "model"), "sonnet");
  assert.equal(validateOption("gpt-5.6-sol", "model"), "gpt-5.6-sol");
  assert.equal(validateOption("claude", "command"), "claude");
  assert.equal(validateOption("high", "effort"), "high");
  assert.equal(validateOption("C:/Users/x/repo", "path"), "C:/Users/x/repo");
});

test("validateOption trims surrounding whitespace", () => {
  assert.equal(validateOption("  sonnet  ", "model"), "sonnet");
});

test("validateOption allows empty by default", () => {
  assert.equal(validateOption("", "model"), "");
  assert.equal(validateOption(null, "model"), "");
  assert.equal(validateOption(undefined, "model"), "");
});

test("validateOption rejects empty when allowEmpty is false", () => {
  assert.throws(() => validateOption("", "command", { allowEmpty: false }), /required/);
});

test("validateOption rejects shell metacharacters (command-injection guard)", () => {
  const dangerous = ["a; rm -rf /", "a && b", "a | b", "$(whoami)", "a`id`", "a > b", "a < b", "a'b", 'a"b', "a\nb", "a{b}"];
  for (const value of dangerous) {
    assert.throws(() => validateOption(value, "x"), /unsupported/, `should reject: ${JSON.stringify(value)}`);
  }
});

test("validateOption rejects values longer than 180 chars", () => {
  assert.throws(() => validateOption("a".repeat(181), "x"), /unsupported/);
  assert.equal(validateOption("a".repeat(180), "x"), "a".repeat(180));
});

test("allowedCommand accepts native CLIs and rejects shell shims", () => {
  assert.equal(allowedCommand("claude"), "claude");
  const absoluteClaude = process.platform === "win32" ? "C:\\tools\\claude.exe" : "/opt/tools/claude";
  assert.equal(allowedCommand(absoluteClaude, undefined, { trustedPaths: [absoluteClaude] }), absoluteClaude);
  assert.throws(() => allowedCommand("codex.cmd"), /Shell command shims/);
});

test("allowedCommand rejects arbitrary / unlisted / empty commands", () => {
  for (const bad of ["rm", "powershell", "node", "python", "curl", ""]) {
    assert.throws(() => allowedCommand(bad), /not allowed|required/);
  }
});

test("allowedCommand honors a custom allowlist and still blocks metacharacters", () => {
  assert.equal(allowedCommand("codex", new Set(["codex"])), "codex");
  assert.throws(() => allowedCommand("claude", new Set(["codex"])), /not allowed/);
  assert.throws(() => allowedCommand("claude; rm -rf"), /unsupported/);
});

test("allowedCommand rejects disguised relative commands and permits absolute paths with spaces", () => {
  // runProcess never invokes a shell. A configured path may contain spaces, but any value
  // containing a path separator must be absolute so an attached project cannot shadow a CLI.
  // Obviously-fake placeholders only (realistic attack strings can trip AV scanners).
  const bypass = ["EVILBIN /claude", "C:/Windows/System32/EVILBIN.exe /claude", "OTHERBIN /codex"];
  for (const bad of bypass) assert.throws(() => allowedCommand(bad), /absolute|trusted|not allowed/);
  const trusted = "/opt/my tools/bin/codex";
  assert.equal(allowedCommand(trusted, undefined, { trustedPaths: [trusted] }), trusted);
});
