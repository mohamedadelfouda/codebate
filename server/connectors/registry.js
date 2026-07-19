import { resolveAllowedCommand, runProcess } from "../process.js";
import { redact } from "../logger.js";
import { expectedApiError } from "../api-errors.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GITHUB_READINESS_TTL_MS = 30000;
let githubReadinessCache = null;

function connectorError(code, message, status) {
  return expectedApiError(code, message, status);
}

function requiredText(value, label, max = 500) {
  const text = String(value || "").trim();
  if (!text || text.length > max || /[\r\n]/.test(text)) throw connectorError("invalid_connector_input", `${label} is invalid`, 400);
  return text;
}

function githubRepo(value) {
  const repo = requiredText(value, "Repository", 200);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw connectorError("invalid_connector_input", "Repository must be owner/name", 400);
  return repo;
}

async function gh(args, input = "") {
  try {
    const command = await resolveAllowedCommand("gh", new Set(["gh"]));
    const result = await runProcess({ command, args, input, envPolicy: "github", timeoutMs: 30000 });
    if (result.code !== 0) {
      const detail = redact(result.stderr || "GitHub CLI action failed");
      const authFailure = /auth|login|credential|token/i.test(detail);
      throw connectorError(authFailure ? "connector_auth_unavailable" : "connector_dependency_unavailable", detail, 503);
    }
    return result.stdout.trim();
  } catch (error) {
    if (error?.apiCode) throw error;
    throw connectorError("connector_dependency_unavailable", redact(error.message || "GitHub CLI is unavailable"), 503);
  }
}

function gmailToken() {
  const token = process.env.CODEBATE_GMAIL_ACCESS_TOKEN;
  if (!token) throw connectorError("connector_auth_unavailable", "Gmail connector is not configured", 503);
  return token;
}

async function boundedJson(response, maxBytes = 1024 * 1024) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > maxBytes) throw connectorError("connector_response_invalid", "Connector response exceeded the 1 MiB limit", 502);
  if (!response.body?.getReader) return response.json();
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw connectorError("connector_response_invalid", "Connector response exceeded the 1 MiB limit", 502);
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  if (!bytes) return {};
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}

async function gmail(pathname, options = {}) {
  try {
    const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${pathname}`, {
      ...options,
      headers: { Authorization: `Bearer ${gmailToken()}`, "Content-Type": "application/json", ...(options.headers || {}) },
      signal: AbortSignal.timeout(20000),
    });
    const data = await boundedJson(response);
    if (!response.ok) {
      const detail = `Gmail request failed (${response.status}): ${redact(data.error?.message || "unknown error")}`;
      throw connectorError([401, 403].includes(response.status) ? "connector_auth_unavailable" : "connector_dependency_unavailable", detail, 503);
    }
    return data;
  } catch (error) {
    if (error?.apiCode) throw error;
    throw connectorError("connector_dependency_unavailable", redact(error.message || "Gmail is unavailable"), 503);
  }
}

function supabaseConfig() {
  const rawUrl = process.env.CODEBATE_SUPABASE_URL;
  const key = process.env.CODEBATE_SUPABASE_KEY;
  if (!rawUrl || !key) throw connectorError("connector_auth_unavailable", "Supabase connector is not configured", 503);
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw connectorError("invalid_connector_configuration", "Supabase URL is not a valid URL", 400);
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw connectorError("invalid_connector_configuration", "Supabase URL must use HTTPS (except loopback development)", 400);
  return { url: url.toString().replace(/\/$/, ""), key };
}

async function supabase(table, options = {}, params = new URLSearchParams()) {
  if (!IDENTIFIER.test(table)) throw connectorError("invalid_connector_input", "Invalid Supabase table name", 400);
  const { url, key } = supabaseConfig();
  try {
    const response = await fetch(`${url}/rest/v1/${table}?${params}`, {
      ...options,
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=representation", ...(options.headers || {}) },
      signal: AbortSignal.timeout(20000),
    });
    const data = await boundedJson(response);
    if (!response.ok) {
      const detail = `Supabase request failed (${response.status}): ${redact(JSON.stringify(data).slice(0, 1000))}`;
      throw connectorError([401, 403].includes(response.status) ? "connector_auth_unavailable" : "connector_dependency_unavailable", detail, 503);
    }
    return data;
  } catch (error) {
    if (error?.apiCode) throw error;
    throw connectorError("connector_dependency_unavailable", redact(error.message || "Supabase is unavailable"), 503);
  }
}

const connectors = new Map([
  ["github", {
    id: "github", label: "GitHub", configured: () => true,
    actions: {
      list_repositories: { description: "List repositories visible to the signed-in GitHub CLI", stateChanging: false, run: async (input) => JSON.parse(await gh(["repo", "list", "--limit", String(Math.min(100, Math.max(1, Number(input.limit) || 30))), "--json", "nameWithOwner,url,visibility,updatedAt"]) || "[]") },
      create_issue: { description: "Create a GitHub issue", stateChanging: true, run: async (input) => {
        const body = String(input.body || "").slice(0, 50000);
        return { url: await gh(["issue", "create", "--repo", githubRepo(input.repo), "--title", requiredText(input.title, "Title", 250), "--body-file", "-"], body) };
      } },
    },
  }],
  ["gmail", {
    id: "gmail", label: "Gmail", configured: () => Boolean(process.env.CODEBATE_GMAIL_ACCESS_TOKEN),
    actions: {
      list_messages: { description: "List Gmail message identifiers", stateChanging: false, run: async (input) => gmail(`messages?${new URLSearchParams({ maxResults: String(Math.min(50, Math.max(1, Number(input.limit) || 20))), ...(input.query ? { q: String(input.query).slice(0, 500) } : {}) })}`) },
      get_message: { description: "Read one Gmail message with headers and body", stateChanging: false, run: async (input) => {
        const id = requiredText(input.id, "Message id", 200);
        if (!/^[A-Za-z0-9_-]+$/.test(id)) throw connectorError("invalid_connector_input", "Message id is invalid", 400);
        return gmail(`messages/${id}?format=full`);
      } },
      send_message: { description: "Send an email through Gmail", stateChanging: true, run: async (input) => {
        const to = requiredText(input.to, "Recipient", 320);
        const subject = requiredText(input.subject, "Subject", 998);
        const body = String(input.body || "").slice(0, 100000);
        const raw = Buffer.from(`To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`).toString("base64url");
        return gmail("messages/send", { method: "POST", body: JSON.stringify({ raw }) });
      } },
    },
  }],
  ["supabase", {
    id: "supabase", label: "Supabase", configured: () => Boolean(process.env.CODEBATE_SUPABASE_URL && process.env.CODEBATE_SUPABASE_KEY),
    actions: {
      select_rows: { description: "Read rows from an explicitly named Supabase table", stateChanging: false, run: async (input) => {
        const params = new URLSearchParams({ select: String(input.select || "*").slice(0, 1000), limit: String(Math.min(100, Math.max(1, Number(input.limit) || 20))) });
        for (const [column, value] of Object.entries(input.equals || {})) {
          if (!IDENTIFIER.test(column)) throw connectorError("invalid_connector_input", "Invalid Supabase filter column", 400);
          params.set(column, `eq.${String(value).slice(0, 1000)}`);
        }
        return supabase(String(input.table || ""), {}, params);
      } },
      insert_row: { description: "Insert one row into an explicitly named Supabase table", stateChanging: true, run: async (input) => {
        if (!input.row || typeof input.row !== "object" || Array.isArray(input.row)) throw connectorError("invalid_connector_input", "Supabase row must be an object", 400);
        const body = JSON.stringify(input.row);
        if (Buffer.byteLength(body) > 100000) throw connectorError("invalid_connector_input", "Supabase row is too large", 400);
        return supabase(String(input.table || ""), { method: "POST", body });
      } },
    },
  }],
]);

export function connector(id) { return connectors.get(String(id || "").toLowerCase()) || null; }
export async function githubConnectorReadiness({ refresh = false } = {}) {
  if (!refresh && githubReadinessCache?.expiresAt > Date.now()) return githubReadinessCache.value;
  let value;
  try {
    const command = await resolveAllowedCommand("gh", new Set(["gh"]));
    const result = await runProcess({ command, args: ["auth", "status"], envPolicy: "github", timeoutMs: 9000 });
    const detail = redact(`${result.stdout}\n${result.stderr}`.split(/\r?\n/).find((line) => line.trim()) || "").slice(0, 200);
    value = { installed: true, configured: result.code === 0, ready: result.code === 0, detail };
  } catch (error) {
    value = { installed: false, configured: false, ready: false, detail: redact(error.message || "GitHub CLI is unavailable").slice(0, 200) };
  }
  githubReadinessCache = { value, expiresAt: Date.now() + GITHUB_READINESS_TTL_MS };
  return value;
}

function supabaseHost() {
  try { return process.env.CODEBATE_SUPABASE_URL ? new URL(process.env.CODEBATE_SUPABASE_URL).host : ""; }
  catch { return ""; }
}

export function connectorCatalog(readiness = {}) {
  return [...connectors.values()].map((item) => ({
    id: item.id,
    label: item.label,
    configured: item.id === "github" ? readiness.github?.configured === true : item.configured(),
    ready: item.id === "github" ? readiness.github?.ready === true : item.configured(),
    detail: item.id === "github" ? readiness.github?.detail || "" : "",
    experimental: item.id === "gmail",
    limitation: item.id === "gmail" ? "gmail_token_expiry_unmanaged" : null,
    displayHost: item.id === "supabase" ? supabaseHost() : "",
    securityGuidance: item.id === "supabase" ? "supabase_least_privilege_rls" : null,
    actions: Object.entries(item.actions).map(([id, action]) => ({ id, description: action.description, stateChanging: action.stateChanging })),
  }));
}
export async function executeConnectorAction(connectorId, actionId, input = {}) {
  const definition = connector(connectorId);
  if (!definition || !Object.hasOwn(definition.actions, actionId)) throw connectorError("connector_action_not_found", "Unknown connector action", 404);
  const action = definition.actions[actionId];
  if (!definition.configured()) throw connectorError("connector_auth_unavailable", `${definition.label} connector is not configured`, 503);
  return action.run(input || {});
}
