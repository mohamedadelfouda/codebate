import test from "node:test";
import assert from "node:assert/strict";
import { provider, providerCatalog, providerIds } from "../../server/providers/registry.js";

test("provider registry exposes runnable Claude, Codex, and Cursor definitions", () => {
  assert.deepEqual(providerIds().sort(), ["claude", "codex", "cursor"]);
  for (const id of providerIds()) {
    assert.equal(typeof provider(id).run, "function");
  }
  // Claude/Codex expose reasoning-effort choices; Cursor encodes effort in the model id, so it has none.
  assert.ok(provider("claude").efforts.length > 0);
  assert.ok(provider("codex").efforts.length > 0);
  assert.deepEqual(provider("cursor").efforts, []);
});

test("public provider catalog omits server functions", () => {
  for (const definition of providerCatalog()) {
    assert.equal("run" in definition, false);
    assert.equal("discoverModels" in definition, false);
    assert.equal(typeof definition.dynamicModels, "boolean");
  }
});

test("catalog hides internal experimental metadata but surfaces descriptorLaunch for the UI", () => {
  const catalog = providerCatalog();
  // `experimental` is internal (it flags the Windows reviewer residual); it must never reach the client.
  assert.ok(catalog.every((definition) => !("experimental" in definition)));
  // Cursor launches via a pinned descriptor, so the client hides the command/Check/Setup allowlist controls.
  assert.equal(catalog.find((definition) => definition.id === "cursor").descriptorLaunch, true);
  assert.equal("descriptorLaunch" in catalog.find((definition) => definition.id === "claude"), false);
});

test("Codex exposes one honest write boundary and Claude remains review-only", () => {
  assert.deepEqual(provider("codex").capabilities.executeModes, ["run"]);
  assert.deepEqual(provider("claude").capabilities.executeModes, []);
});

test("every provider can use web (chat mode) so a web task isn't answered by one provider only", () => {
  for (const id of ["claude", "codex", "cursor"]) {
    assert.equal(provider(id).capabilities.web, true, `${id} web`);
  }
});
