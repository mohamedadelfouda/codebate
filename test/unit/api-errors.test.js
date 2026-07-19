import test from "node:test";
import assert from "node:assert/strict";
import { apiErrorPayload } from "../../server/api-errors.js";

test("API error details redact credentials and personal home paths", () => {
  const credential = ["sk", "-abcDEF1234567890xyz"].join("");
  const payload = apiErrorPayload("provider_failed", new Error(`C:\\Users\\PrivateName\\project used ${credential}`));
  assert.equal(payload.code, "provider_failed");
  assert.equal(payload.error, payload.detail);
  assert.match(payload.detail, /<user>/);
  assert.match(payload.detail, /<redacted-key>/);
  assert.doesNotMatch(payload.detail, /PrivateName|abcDEF1234567890xyz/);
});
