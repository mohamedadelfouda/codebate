import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

let origin;
let cookie;
let sessionId;
let runtimeDir;
let projectDir;
let shutdownServer;
let mutateSession;
let claudeMcpLaunch;

async function post(pathname, body) {
  return fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: origin },
    body: JSON.stringify(body),
  });
}

async function get(pathname) {
  return fetch(`${origin}${pathname}`, { headers: { Cookie: cookie, Origin: origin } });
}

before(async () => {
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "codebate-api-errors-"));
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "codebate-api-project-"));
  execFileSync("git", ["init", "-q"], { cwd: projectDir });
  process.env.CODEBATE_RUNTIME_DIR = runtimeDir;
  process.env.NO_OPEN = "1";
  process.env.PORT = "0";
  const serverModule = await import("../../server/index.js");
  ({ mutateSession } = await import("../../server/store.js"));
  ({ claudeMcpLaunch } = await import("../../server/mcp-config.js"));
  ({ url: origin } = await serverModule.serverReady);
  shutdownServer = serverModule.shutdownServer;

  const landing = await fetch(origin);
  cookie = landing.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);

  const created = await post("/api/sessions", { title: "Error contract" });
  assert.equal(created.status, 201);
  sessionId = (await created.json()).id;
});

after(async () => {
  await shutdownServer?.("api_error_contract_test");
  await fs.rm(runtimeDir, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
});

test("project validation keeps the legacy message and exposes a stable code", async () => {
  const response = await post(`/api/sessions/${sessionId}/project`, { path: "" });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.code, "project_path_required");
  assert.equal(payload.error, "Project path is required");
  assert.equal(payload.detail, payload.error);
});

test("route rejection exposes the same reason code in the error and route", async () => {
  const response = await post(`/api/sessions/${sessionId}/message`, { content: "run the tests" });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.code, "state_change_requires_execution");
  assert.equal(payload.route.reasonCode, payload.code);
  assert.equal(payload.detail, payload.error);
});

test("invalid orchestration configuration is rejected before a run starts", async () => {
  const response = await post(`/api/sessions/${sessionId}/message`, {
    content: "Compare two approaches",
    mode: "collaboration",
    rounds: 2,
    finalizer: "cursor",
    agents: {
      claude: { enabled: true },
      codex: { enabled: true },
    },
  });
  const payload = await response.json();

  assert.equal(response.status, 400);
  assert.equal(payload.code, "invalid_finalizer");
  assert.equal(payload.detail, payload.error);
});

test("pending execution conflict returns 409 with a stable code", async () => {
  const attached = await post(`/api/sessions/${sessionId}/project`, { path: projectDir });
  assert.equal(attached.status, 200);
  await mutateSession(sessionId, (session) => {
    session.executions = [{ taskId: "pending", status: "awaiting_user" }];
  });

  const response = await post(`/api/sessions/${sessionId}/project`, { path: projectDir });
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.code, "pending_execution_decisions");
  assert.equal(payload.detail, payload.error);
});

test("an SSE stream for a missing session is a 404, not an endlessly heartbeating stream", async () => {
  const response = await get("/api/sessions/00000000000000000000000000000000/events");
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "not_found");
});

test("accepting a missing execution is a 404 (not a generic 400)", async () => {
  const response = await post(`/api/sessions/${sessionId}/execution/no-such-task/accept`, { action: "merge" });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "execution_not_found");
});

test("deleting a session blocked by a pending connector action is a 409 with its own code", async () => {
  const created = await post("/api/sessions", { title: "Connector delete" });
  const id = (await created.json()).id;
  await mutateSession(id, (session) => { session.connectorActions = [{ id: "a1", status: "pending" }]; });
  const response = await fetch(`${origin}/api/sessions/${id}`, { method: "DELETE", headers: { Cookie: cookie, Origin: origin } });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "pending_connector_actions");
});

test("connector routes distinguish invalid, conflicting, and unavailable requests", async () => {
  const created = await post("/api/sessions", { title: "Connector contract" });
  const connectorSessionId = (await created.json()).id;

  const invalid = await post(`/api/sessions/${connectorSessionId}/connectors/not-real`, { enabled: true });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "invalid_connector");

  const disabled = await post(`/api/sessions/${connectorSessionId}/connector-actions`, {
    connector: "gmail", action: "list_messages", input: {},
  });
  assert.equal(disabled.status, 409);
  assert.equal((await disabled.json()).code, "connector_disabled");

  const enabled = await post(`/api/sessions/${connectorSessionId}/connectors/gmail`, { enabled: true });
  assert.equal(enabled.status, 200);
  const unavailable = await post(`/api/sessions/${connectorSessionId}/connector-actions`, {
    connector: "gmail", action: "list_messages", input: {},
  });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).code, "connector_auth_unavailable");
});

test("diagnostics export reports health and redacts log credentials", async () => {
  const { logError } = await import("../../server/logger.js");
  const secret = "diagnostic-secret-token-123456";
  logError("diagnostic export test", `Authorization: Bearer ${secret}`);
  const response = await get("/api/diagnostics");
  const text = await response.text();
  const payload = JSON.parse(text);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition"), /codebate-diagnostics/);
  assert.equal(payload.runtime.node, process.version);
  assert.equal(typeof payload.logging.healthy, "boolean");
  assert.equal(text.includes(secret), false);
  assert.match(text, /<redacted>/);
});

test("a missing recovery record returns the stable 404 contract", async () => {
  const response = await get("/api/session-recovery/00000000000000000000000000000000/export");
  const payload = await response.json();
  assert.equal(response.status, 404);
  assert.equal(payload.code, "not_found");
});

test("MCP bridge returns Invalid Request for a JSON null body", async () => {
  const launch = claudeMcpLaunch(sessionId, "connectors");
  const config = JSON.parse(launch.args[launch.args.indexOf("--mcp-config") + 1]);
  const token = config.mcpServers.codebate.env.CODEBATE_MCP_BRIDGE_TOKEN;
  try {
    const response = await fetch(`${origin}/internal/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Codebate-MCP-Token": token },
      body: "null",
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.error.code, -32600);
  } finally {
    launch.release();
  }
});
