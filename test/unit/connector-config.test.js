import test from "node:test";
import assert from "node:assert/strict";
import {
  configureConnectorSecretStore,
  connectorConfigurationCatalog,
  hydrateConnectorSecrets,
  saveConnectorConfiguration,
} from "../../server/connector-config.js";

const KEYS = ["CODEBATE_GMAIL_ACCESS_TOKEN", "CODEBATE_SUPABASE_URL", "CODEBATE_SUPABASE_KEY"];

test("concurrent secure connector updates are serialized without losing either connector", async () => {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  let saved = null;
  configureConnectorSecretStore({
    available: true,
    persist: async (value) => { await new Promise((resolve) => setTimeout(resolve, 5)); saved = structuredClone(value); },
  });
  try {
    await Promise.all([
      saveConnectorConfiguration("gmail", { accessToken: "gmail-token" }),
      saveConnectorConfiguration("supabase", { url: "https://example.supabase.co", key: "supabase-key" }),
    ]);
    assert.equal(saved.gmail.accessToken, "gmail-token");
    assert.equal(saved.supabase.key, "supabase-key");
    assert.equal(connectorConfigurationCatalog().find((item) => item.id === "supabase").configured, true);
  } finally {
    configureConnectorSecretStore(null);
    for (const key of KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("credential hydration skips one invalid field and continues with valid fields", () => {
  const previous = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  try {
    hydrateConnectorSecrets({
      gmail: { accessToken: "gmail-token" },
      supabase: { url: "not a URL", key: "supabase-key" },
    });
    assert.equal(process.env.CODEBATE_GMAIL_ACCESS_TOKEN, "gmail-token");
    assert.equal(process.env.CODEBATE_SUPABASE_URL, undefined);
    assert.equal(process.env.CODEBATE_SUPABASE_KEY, "supabase-key");
  } finally {
    for (const key of KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("invalid connector URLs return a stable field-specific error", async () => {
  configureConnectorSecretStore({ available: true, persist: async () => {} });
  try {
    await assert.rejects(
      () => saveConnectorConfiguration("supabase", { url: "not a URL" }),
      /Project URL is invalid/,
    );
  } finally {
    configureConnectorSecretStore(null);
  }
});
