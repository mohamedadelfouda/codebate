import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeProjectTool, projectToolDefinitions, registerProjectScope } from "../../server/project-tools.js";
import { handleMcpRequest } from "../../server/mcp-server.js";

test("project tools expose only bounded reads inside the registered root", async () => {
  const root = mkdtempSync(join(tmpdir(), "ar-project-tools-"));
  const sessionId = "session_test_123";
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "app.js"), "export const ready = true;\n");
  const release = await registerProjectScope(sessionId, root);
  try {
    assert.deepEqual(projectToolDefinitions(sessionId).map((tool) => tool.name), ["project__list_directory", "project__read_file"]);
    const listing = await executeProjectTool(sessionId, "project__list_directory", { path: "src" });
    assert.deepEqual(listing, [{ name: "app.js", type: "file" }]);
    const read = await executeProjectTool(sessionId, "project__read_file", { path: "src/app.js", limit: 7 });
    assert.equal(read.content, "export ");
    assert.equal(read.eof, false);
    await assert.rejects(() => executeProjectTool(sessionId, "project__read_file", { path: "../outside.txt" }), /stay inside/);
  } finally {
    release();
    rmSync(root, { recursive: true, force: true });
  }
  assert.equal(projectToolDefinitions(sessionId).length, 0);
});

test("project file pagination preserves complete UTF-8 code points", async () => {
  const root = mkdtempSync(join(tmpdir(), "ar-project-emoji-"));
  const sessionId = "session_emoji_123";
  writeFileSync(join(root, "emoji.txt"), "A🙂B");
  const release = await registerProjectScope(sessionId, root);
  try {
    const firstPage = await executeProjectTool(sessionId, "project__read_file", { path: "emoji.txt", limit: 2 });
    const emojiPage = await executeProjectTool(sessionId, "project__read_file", { path: "emoji.txt", offset: firstPage.nextOffset, limit: 1 });
    const finalPage = await executeProjectTool(sessionId, "project__read_file", { path: "emoji.txt", offset: emojiPage.nextOffset, limit: 2 });
    assert.equal(firstPage.content + emojiPage.content + finalPage.content, "A🙂B");
    assert.equal(finalPage.eof, true);
  } finally {
    release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("project file pagination preserves a byte-order mark at a page boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "ar-project-bom-"));
  const sessionId = "session_bom_123";
  writeFileSync(join(root, "bom.txt"), "A\uFEFFB");
  const release = await registerProjectScope(sessionId, root);
  try {
    const firstPage = await executeProjectTool(sessionId, "project__read_file", { path: "bom.txt", limit: 1 });
    const bomPage = await executeProjectTool(sessionId, "project__read_file", { path: "bom.txt", offset: firstPage.nextOffset, limit: 1 });
    const finalPage = await executeProjectTool(sessionId, "project__read_file", { path: "bom.txt", offset: bomPage.nextOffset, limit: 1 });
    assert.equal(firstPage.content + bomPage.content + finalPage.content, "A\uFEFFB");
  } finally {
    release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("project reads reject invalid and incomplete UTF-8 sequences", async () => {
  const root = mkdtempSync(join(tmpdir(), "ar-project-invalid-utf8-"));
  const sessionId = "session_invalid_utf8_123";
  writeFileSync(join(root, "incomplete.bin"), Buffer.from([0xf0]));
  writeFileSync(join(root, "invalid.bin"), Buffer.from([0xff]));
  writeFileSync(join(root, "emoji.txt"), "🙂");
  const release = await registerProjectScope(sessionId, root);
  try {
    await assert.rejects(
      () => executeProjectTool(sessionId, "project__read_file", { path: "incomplete.bin", limit: 1 }),
      /not valid UTF-8/,
    );
    await assert.rejects(
      () => executeProjectTool(sessionId, "project__read_file", { path: "invalid.bin", limit: 1 }),
      /not valid UTF-8/,
    );
    await assert.rejects(
      () => executeProjectTool(sessionId, "project__read_file", { path: "emoji.txt", offset: 2, limit: 1 }),
      /not valid UTF-8/,
    );
  } finally {
    release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP project reads redact credentials without changing the tool response contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "ar-project-redaction-"));
  const sessionId = "session_redaction_123";
  const credential = "quoted-assignment-secret";
  writeFileSync(join(root, "config.txt"), `TOKEN="${credential}"\n`);
  const release = await registerProjectScope(sessionId, root);
  try {
    const response = await handleMcpRequest({
      id: 1,
      method: "tools/call",
      params: { name: "project__read_file", arguments: { path: "config.txt" } },
    }, sessionId, "project");
    const text = response.result.content[0].text;
    const payload = JSON.parse(text);
    assert.equal(payload.content, "TOKEN=<redacted>\n");
    assert.equal(text.includes(credential), false);
  } finally {
    release();
    rmSync(root, { recursive: true, force: true });
  }
});
