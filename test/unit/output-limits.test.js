import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CappedText, agentTimeoutMs, readTextFileCapped } from "../../server/output-limits.js";

test("CappedText caps by bytes without returning a broken UTF-8 sequence", () => {
  const value = new CappedText(5);
  value.append("🙂🙂");
  assert.equal(value.truncated, true);
  assert.match(value.toString(), /^🙂/);
  assert.doesNotMatch(value.toString(), /�/);
  assert.match(value.toString(), /truncated/);
});

test("CappedText owns appended Buffer bytes", () => {
  const source = Buffer.from("owned");
  const value = new CappedText(10).append(source);
  source.fill("x");
  assert.equal(value.toString(), "owned");
});

test("agentTimeoutMs validates configurable timeouts", () => {
  assert.equal(agentTimeoutMs("5000"), 5000);
  assert.throws(() => agentTimeoutMs("0"), /between 1000/);
  assert.throws(() => agentTimeoutMs("forever"), /integer/);
});

test("readTextFileCapped never reads an unbounded final response", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ar-output-"));
  const file = join(dir, "final.txt");
  try {
    await writeFile(file, "🙂🙂");
    const result = await readTextFileCapped(file, 5);
    assert.equal(result.truncated, true);
    assert.match(result.text, /^🙂/);
    assert.doesNotMatch(result.text, /�/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
