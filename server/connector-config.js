const CONNECTOR_FIELDS = Object.freeze({
  gmail: [
    { id: "accessToken", label: "OAuth access token", env: "CODEBATE_GMAIL_ACCESS_TOKEN", secret: true, max: 8192 },
  ],
  supabase: [
    { id: "url", label: "Project URL", env: "CODEBATE_SUPABASE_URL", secret: false, max: 2048 },
    { id: "key", label: "API key", env: "CODEBATE_SUPABASE_KEY", secret: true, max: 8192 },
  ],
});

let secureStore = null;
let configurationTail = Promise.resolve();

function specs(connectorId) {
  const fields = CONNECTOR_FIELDS[String(connectorId || "").toLowerCase()];
  if (!fields) throw new Error("This connector has no editable credentials");
  return fields;
}

function currentSecrets() {
  const result = {};
  for (const [connectorId, fields] of Object.entries(CONNECTOR_FIELDS)) {
    result[connectorId] = {};
    for (const field of fields) {
      const value = process.env[field.env];
      if (value) result[connectorId][field.id] = value;
    }
  }
  return result;
}

function validateValue(connectorId, field, value) {
  const text = String(value || "").trim();
  if (text.length > field.max || /[\0\r\n]/.test(text)) throw new Error(`${field.label} is invalid`);
  if (connectorId === "supabase" && field.id === "url" && text) {
    let url;
    try { url = new URL(text); }
    catch { throw new Error(`${field.label} is invalid`); }
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new Error("Supabase URL must use HTTPS (except loopback development)");
    return url.toString().replace(/\/$/, "");
  }
  return text;
}

export function configureConnectorSecretStore(store) {
  secureStore = store?.available === true && typeof store.persist === "function" ? store : null;
}

export function hydrateConnectorSecrets(saved = {}) {
  for (const [connectorId, fields] of Object.entries(CONNECTOR_FIELDS)) {
    for (const field of fields) {
      const value = saved?.[connectorId]?.[field.id];
      if (typeof value !== "string" || !value) continue;
      try { process.env[field.env] = validateValue(connectorId, field, value); }
      catch {}
    }
  }
}

export function connectorConfigurationCatalog() {
  return Object.entries(CONNECTOR_FIELDS).map(([id, fields]) => ({
    id,
    editable: Boolean(secureStore),
    configured: fields.every((field) => Boolean(process.env[field.env])),
    fields: fields.map((field) => ({ id: field.id, label: field.label, secret: field.secret, configured: Boolean(process.env[field.env]) })),
  }));
}

export async function saveConnectorConfiguration(connectorId, input = {}) {
  const operation = async () => {
    const id = String(connectorId || "").toLowerCase();
    const fields = specs(id);
    if (!secureStore) throw new Error("Secure credential storage is unavailable. Configure this connector with host environment variables instead");
    const candidate = currentSecrets();
    candidate[id] ||= {};
    for (const field of fields) {
      if (input.clear === true) delete candidate[id][field.id];
      else if (Object.hasOwn(input, field.id) && String(input[field.id] || "").trim()) {
        candidate[id][field.id] = validateValue(id, field, input[field.id]);
      }
    }
    await secureStore.persist(candidate);
    for (const field of fields) {
      const value = candidate[id][field.id];
      if (value) process.env[field.env] = value;
      else delete process.env[field.env];
    }
    return connectorConfigurationCatalog().find((item) => item.id === id);
  };
  const run = configurationTail.then(operation, operation);
  configurationTail = run.then(() => {}, () => {});
  return run;
}
