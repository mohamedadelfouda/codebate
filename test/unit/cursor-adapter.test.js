import test from "node:test";
import assert from "node:assert/strict";
import { buildCursorReviewArgs, parseCursorResult, parseCursorModels, runCursor } from "../../server/adapters/cursor.js";

const descriptor = {
  entryPoint: "C:\\cursor\\index.js",
  executable: "C:\\cursor\\node.exe",
  fixedPrefixArgs: ["C:\\cursor\\index.js"],
};

test("review argv is read-only: plan mode, never --force/--yolo, entry point first", () => {
  const args = buildCursorReviewArgs({ descriptor, model: "gpt-5.3-codex-low-fast", platform: "win32" });
  assert.equal(args[0], descriptor.entryPoint); // nothing precedes the entry point
  assert.ok(args.includes("--print"));
  assert.deepEqual(args.slice(args.indexOf("--mode"), args.indexOf("--mode") + 2), ["--mode", "plan"]);
  assert.deepEqual(args.slice(args.indexOf("--output-format"), args.indexOf("--output-format") + 2), ["--output-format", "json"]);
  assert.ok(args.includes("--trust"));
  assert.ok(!args.includes("--force") && !args.includes("--yolo")); // never applies changes
  assert.ok(args.includes("--model=gpt-5.3-codex-low-fast")); // single token — a value can't split into a flag
});

test("a model value that poses as a flag is rejected (argv injection)", () => {
  assert.throws(() => buildCursorReviewArgs({ descriptor, model: "--yolo", platform: "win32" }), /must not start with/);
});

test("sandbox mode is per-platform (disabled on Windows, enabled elsewhere) and model is optional", () => {
  const win = buildCursorReviewArgs({ descriptor, model: "", platform: "win32" });
  assert.deepEqual(win.slice(win.indexOf("--sandbox"), win.indexOf("--sandbox") + 2), ["--sandbox", "disabled"]);
  assert.ok(!win.includes("--model")); // omitted when empty
  const mac = buildCursorReviewArgs({ descriptor, model: "", platform: "darwin" });
  assert.deepEqual(mac.slice(mac.indexOf("--sandbox"), mac.indexOf("--sandbox") + 2), ["--sandbox", "enabled"]);
});

test("parseCursorResult reads the single json result object and fails closed on junk", () => {
  const ok = parseCursorResult('{"type":"result","subtype":"success","is_error":false,"result":"the review","session_id":"s1"}');
  assert.equal(ok.result, "the review");
  assert.equal(ok.is_error, false);
  assert.equal(parseCursorResult(""), null);
  assert.equal(parseCursorResult("not json"), null);
  // tolerate a stray leading line before the json object
  assert.equal(parseCursorResult('warning: something\n{"result":"r","is_error":false}').result, "r");
  // a changed/malformed shape whose `result` is not a string is parsed as-is — runCursor then fails closed
  // ("completed without a review") instead of coercing it to garbage text like "[object Object]".
  assert.notEqual(typeof parseCursorResult('{"type":"result","is_error":false,"result":{"unexpected":"shape"}}').result, "string");
});

test("parseCursorModels extracts model ids from the --list-models table", () => {
  const sample = "Available models\n\nauto - Auto (default)\ngpt-5.3-codex-low-fast - Codex 5.3 Low Fast\nclaude-opus-4-8-thinking-high - Opus 4.8\n";
  assert.deepEqual(parseCursorModels(sample), ["auto", "claude-opus-4-8-thinking-high", "gpt-5.3-codex-low-fast"]);
  assert.deepEqual(parseCursorModels(""), []);
});

test("runCursor rejects a non-review (executor) permission before any launch", async () => {
  await assert.rejects(
    () => runCursor({ prompt: "x", config: { permission: "run" }, cwd: ".", onEvent() {}, registerChild() {} }),
    /Unsupported Cursor permission/,
  );
});
