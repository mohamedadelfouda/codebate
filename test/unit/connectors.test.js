import test from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createSession, getSession, saveSession } from "../../server/store.js";
import { connectorCatalog, executeConnectorAction } from "../../server/connectors/registry.js";
import { setConnectorEnabled, requestConnectorAction, decideConnectorAction, reconcileInterruptedReadAudits } from "../../server/connectors/service.js";
import { handleMcpRequest } from "../../server/mcp-server.js";
import { claudeMcpLaunch, resolveMcpBridgeGrant, setMcpBridgeUrl } from "../../server/mcp-config.js";

const sessionsDir = join(dirname(fileURLToPath(import.meta.url)), "../../data/sessions");
const cleanup = (id) => Promise.all([
  rm(join(sessionsDir, `${id}.json`), { force: true }),
  rm(join(sessionsDir, `${id}.summary.json`), { force: true }),
]).catch(() => {});

test("connector catalog exposes read/write intent without implementation functions", () => {
  const catalog = connectorCatalog();
  assert.deepEqual(catalog.map((item) => item.id), ["github", "gmail", "supabase"]);
  assert.equal(catalog.find((item) => item.id === "gmail").actions.find((action) => action.id === "send_message").stateChanging, true);
  assert.ok(catalog.every((item) => item.actions.every((action) => !("run" in action))));
});

test("state-changing connector calls become proposals and require an explicit decision", async () => {
  const session = await createSession("connector-test");
  try {
    await setConnectorEnabled(session.id, "github", true);
    const proposal = await requestConnectorAction(session.id, "github", "create_issue", { repo: "owner/repo", title: "Title", body: "Body" });
    assert.equal(proposal.status, "pending");
    const rejected = await decideConnectorAction(session.id, proposal.id, false);
    assert.equal(rejected.status, "rejected");
    const saved = await getSession(session.id);
    assert.ok(saved.decisions.some((decision) => decision.outcome === "rejected" && decision.taskId === proposal.id));
  } finally { await cleanup(session.id); }
});

test("a connector read audit stuck 'running' after a crash is reconciled to interrupted at startup", async () => {
  const session = await createSession("read-audit-reconcile");
  try {
    // Simulate a crash mid-read: one audit left "running", one already settled.
    const now = new Date().toISOString();
    await saveSession({
      ...session,
      connectorReadAudits: [
        { id: "stuck", connector: "gmail", action: "list_messages", status: "running", requestedAt: now },
        { id: "done", connector: "gmail", action: "list_messages", status: "completed", requestedAt: now, completedAt: now },
      ],
    });
    const recovered = await reconcileInterruptedReadAudits("server_restart");
    assert.ok(recovered >= 1);
    const reloaded = await getSession(session.id);
    const stuck = reloaded.connectorReadAudits.find((audit) => audit.id === "stuck");
    const done = reloaded.connectorReadAudits.find((audit) => audit.id === "done");
    assert.equal(stuck.status, "interrupted");
    assert.equal(stuck.interruptionReason, "server_restart");
    assert.ok(stuck.completedAt);
    assert.equal(done.status, "completed"); // a settled audit is left untouched

    // Idempotent: a second pass must not re-touch an already-interrupted audit (guards the running-only filter).
    await reconcileInterruptedReadAudits("later_restart");
    const again = (await getSession(session.id)).connectorReadAudits.find((audit) => audit.id === "stuck");
    assert.equal(again.status, "interrupted");
    assert.equal(again.interruptionReason, "server_restart"); // unchanged — not reconciled a second time
    assert.equal(again.completedAt, stuck.completedAt);
  } finally { await cleanup(session.id); }
});

test("reconcileInterruptedReadAudits leaves a session with no running read audits untouched", async () => {
  const session = await createSession("read-audit-noop");
  try {
    const now = new Date().toISOString();
    await saveSession({
      ...session,
      connectorReadAudits: [{ id: "done", connector: "gmail", action: "list_messages", status: "completed", requestedAt: now, completedAt: now }],
    });
    const before = (await getSession(session.id)).connectorReadAudits;
    await reconcileInterruptedReadAudits("server_restart");
    const after = (await getSession(session.id)).connectorReadAudits;
    assert.deepEqual(after, before); // nothing "running" → nothing changed
  } finally { await cleanup(session.id); }
});

test("connector proposals reject inputs too large to review and persist safely", async () => {
  const session = await createSession("connector-size-test");
  try {
    await setConnectorEnabled(session.id, "github", true);
    await assert.rejects(
      () => requestConnectorAction(session.id, "github", "create_issue", { body: "🙂".repeat(17000) }),
      /64 KiB approval limit/,
    );
  } finally { await cleanup(session.id); }
});

test("inherited object properties are never connector actions", async () => {
  await assert.rejects(() => executeConnectorAction("github", "constructor", {}), /Unknown connector action/);
  const session = await createSession("connector-inherited-action-test");
  try {
    await setConnectorEnabled(session.id, "github", true);
    await assert.rejects(
      () => requestConnectorAction(session.id, "github", "constructor", {}),
      /Unknown connector action/,
    );
  } finally { await cleanup(session.id); }
});

test("Gmail send requires boolean approval and executes exactly once", async () => {
  const session = await createSession("gmail-approval-test");
  const previousToken = process.env.CODEBATE_GMAIL_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  let calls = 0;
  process.env.CODEBATE_GMAIL_ACCESS_TOKEN = "placeholder-token";
  globalThis.fetch = async (_url, options) => {
    calls += 1;
    const payload = JSON.parse(options.body);
    assert.match(Buffer.from(payload.raw, "base64url").toString("utf8"), /To: user@example\.com/);
    return { ok: true, status: 200, json: async () => ({ id: "message-id" }) };
  };
  try {
    await setConnectorEnabled(session.id, "gmail", true);
    const proposal = await requestConnectorAction(session.id, "gmail", "send_message", { to: "user@example.com", subject: "Hello", body: "Body" });
    assert.equal(calls, 0);
    await assert.rejects(() => decideConnectorAction(session.id, proposal.id, "true"), /must be a boolean/);
    assert.equal(calls, 0);
    const completed = await decideConnectorAction(session.id, proposal.id, true);
    assert.equal(completed.status, "completed");
    assert.equal(calls, 1);
    await assert.rejects(() => decideConnectorAction(session.id, proposal.id, true), /already completed/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.CODEBATE_GMAIL_ACCESS_TOKEN;
    else process.env.CODEBATE_GMAIL_ACCESS_TOKEN = previousToken;
    await cleanup(session.id);
  }
});

test("read-only connector results preserve structure while redacting credentials", async () => {
  const session = await createSession("gmail-read-redaction-test");
  const previousToken = process.env.CODEBATE_GMAIL_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  const credential = "quoted-connector-secret";
  process.env.CODEBATE_GMAIL_ACCESS_TOKEN = "placeholder-token";
  globalThis.fetch = async () => new Response(JSON.stringify({
    messages: [{ id: "message-id", snippet: `TOKEN="${credential}"`, metadata: { accessToken: "opaque-value", label: "visible" } }],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  try {
    await setConnectorEnabled(session.id, "gmail", true);
    const completed = await requestConnectorAction(session.id, "gmail", "list_messages", {
      query: `TOKEN="${credential}"`, accessToken: "input-secret", body: "private message body",
      content: { nested: "private structured content" },
    });
    assert.ok(Array.isArray(completed.result.messages));
    assert.equal(completed.result.messages[0].snippet, "TOKEN=<redacted>");
    assert.equal(completed.result.messages[0].metadata.accessToken, "<redacted>");
    assert.equal(completed.result.messages[0].metadata.label, "visible");
    assert.equal(JSON.stringify(completed).includes(credential), false);
    const saved = await getSession(session.id);
    const audit = saved.connectorReadAudits.find((item) => item.id === completed.auditId);
    assert.equal(audit.status, "completed");
    assert.equal(audit.inputSummary.accessToken, "<redacted>");
    assert.match(audit.inputSummary.body, /^<omitted:/);
    assert.match(audit.inputSummary.content, /^<omitted:/);
    assert.doesNotMatch(JSON.stringify(audit), /private structured content/);
    assert.equal(JSON.stringify(audit).includes(credential), false);
    assert.equal(Object.hasOwn(audit, "result"), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.CODEBATE_GMAIL_ACCESS_TOKEN;
    else process.env.CODEBATE_GMAIL_ACCESS_TOKEN = previousToken;
    await cleanup(session.id);
  }
});

test("approved connector results are stored safely without changing the execution input", async () => {
  const session = await createSession("gmail-write-redaction-test");
  const previousToken = process.env.CODEBATE_GMAIL_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  const outboundValue = "send-this-value";
  const responseSecret = "quoted-response-secret";
  process.env.CODEBATE_GMAIL_ACCESS_TOKEN = "placeholder-token";
  globalThis.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    const message = Buffer.from(payload.raw, "base64url").toString("utf8");
    assert.match(message, new RegExp(`TOKEN="${outboundValue}"`));
    return { ok: true, status: 200, json: async () => ({
      id: "message-id",
      credentials: { accessToken: "opaque-value" },
      summary: `PASSWORD="${responseSecret}"`,
    }) };
  };
  try {
    await setConnectorEnabled(session.id, "gmail", true);
    const proposal = await requestConnectorAction(session.id, "gmail", "send_message", {
      to: "user@example.com", subject: "Hello", body: `TOKEN="${outboundValue}"`,
    });
    const completed = await decideConnectorAction(session.id, proposal.id, true);
    const storedResult = JSON.parse(completed.result);
    assert.equal(storedResult.credentials, "<redacted>");
    assert.equal(storedResult.summary, "PASSWORD=<redacted>");
    assert.equal(completed.result.includes(responseSecret), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.CODEBATE_GMAIL_ACCESS_TOKEN;
    else process.env.CODEBATE_GMAIL_ACCESS_TOKEN = previousToken;
    await cleanup(session.id);
  }
});

test("malformed success response leaves an approved connector action failed", async () => {
  const session = await createSession("gmail-malformed-response-test");
  const previousToken = process.env.CODEBATE_GMAIL_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.CODEBATE_GMAIL_ACCESS_TOKEN = "placeholder-token";
  globalThis.fetch = async () => new Response("{not-json", { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    await setConnectorEnabled(session.id, "gmail", true);
    const proposal = await requestConnectorAction(session.id, "gmail", "send_message", { to: "user@example.com", subject: "Hello", body: "Body" });
    await assert.rejects(
      () => decideConnectorAction(session.id, proposal.id, true),
      (error) => error.apiCode === "connector_dependency_unavailable" && error.apiStatus === 503,
    );
    const saved = await getSession(session.id);
    assert.equal(saved.connectorActions.find((item) => item.id === proposal.id).status, "failed_after_approval");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.CODEBATE_GMAIL_ACCESS_TOKEN;
    else process.env.CODEBATE_GMAIL_ACCESS_TOKEN = previousToken;
    await cleanup(session.id);
  }
});

test("connector identifiers are stored canonically", async () => {
  const session = await createSession("connector-canonical-id-test");
  try {
    await setConnectorEnabled(session.id, "GITHUB", true);
    const saved = await getSession(session.id);
    assert.equal(saved.connectors.github.enabled, true);
    assert.equal(saved.connectors.GITHUB, undefined);
  } finally { await cleanup(session.id); }
});

test("failed read-only connector calls retain only bounded audit metadata", async () => {
  const session = await createSession("gmail-read-audit-failure-test");
  const previousToken = process.env.CODEBATE_GMAIL_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.CODEBATE_GMAIL_ACCESS_TOKEN = "placeholder-token";
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "expired token response body" } }), {
    status: 401, headers: { "Content-Type": "application/json" },
  });
  try {
    await setConnectorEnabled(session.id, "gmail", true);
    await assert.rejects(
      () => requestConnectorAction(session.id, "gmail", "list_messages", { accessToken: "never-store-this" }),
      (error) => error.apiCode === "connector_auth_unavailable" && error.apiStatus === 503,
    );
    const saved = await getSession(session.id);
    assert.equal(saved.connectorReadAudits.length, 1);
    assert.equal(saved.connectorReadAudits[0].status, "failed");
    assert.equal(saved.connectorReadAudits[0].errorCode, "connector_auth_unavailable");
    assert.equal(JSON.stringify(saved.connectorReadAudits).includes("expired token response body"), false);
    assert.equal(JSON.stringify(saved.connectorReadAudits).includes("never-store-this"), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.CODEBATE_GMAIL_ACCESS_TOKEN;
    else process.env.CODEBATE_GMAIL_ACCESS_TOKEN = previousToken;
    await cleanup(session.id);
  }
});

test("connector read audit history is bounded", async () => {
  const session = await createSession("connector-read-audit-bound-test");
  try {
    session.connectorReadAudits = Array.from({ length: 205 }, (_, index) => ({
      id: String(index), connector: "gmail", action: "list_messages", status: "completed",
      requestedAt: new Date(index).toISOString(), inputSummary: {},
    }));
    await saveSession(session);
    const saved = await getSession(session.id);
    assert.equal(saved.connectorReadAudits.length, 200);
    assert.equal(saved.connectorReadAudits[0].id, "5");
  } finally { await cleanup(session.id); }
});

test("connector failure-state persistence cannot mask the upstream error", async () => {
  const session = await createSession("gmail-primary-error-test");
  const previousToken = process.env.CODEBATE_GMAIL_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.CODEBATE_GMAIL_ACCESS_TOKEN = "placeholder-token";
  try {
    await setConnectorEnabled(session.id, "gmail", true);
    const proposal = await requestConnectorAction(session.id, "gmail", "send_message", { to: "user@example.com", subject: "Hello", body: "Body" });
    globalThis.fetch = async () => {
      await cleanup(session.id);
      throw new Error("upstream connector failed");
    };
    await assert.rejects(
      () => decideConnectorAction(session.id, proposal.id, true),
      /upstream connector failed/,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.CODEBATE_GMAIL_ACCESS_TOKEN;
    else process.env.CODEBATE_GMAIL_ACCESS_TOKEN = previousToken;
    await cleanup(session.id);
  }
});

test("connector completion preserves session updates written during the external call", async () => {
  const session = await createSession("connector-concurrency-test");
  const previousToken = process.env.CODEBATE_GMAIL_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  let releaseFetch;
  let fetchStarted;
  const started = new Promise((resolve) => { fetchStarted = resolve; });
  const release = new Promise((resolve) => { releaseFetch = resolve; });
  process.env.CODEBATE_GMAIL_ACCESS_TOKEN = "placeholder-token";
  globalThis.fetch = async () => {
    fetchStarted();
    await release;
    return { ok: true, status: 200, json: async () => ({ id: "message-id" }) };
  };
  try {
    await setConnectorEnabled(session.id, "gmail", true);
    const proposal = await requestConnectorAction(session.id, "gmail", "send_message", { to: "user@example.com", subject: "Hello", body: "Body" });
    const decision = decideConnectorAction(session.id, proposal.id, true);
    await started;
    const concurrent = await getSession(session.id);
    concurrent.messages.push({ role: "user", content: "written while connector was running" });
    await saveSession(concurrent);
    releaseFetch();
    await decision;
    const saved = await getSession(session.id);
    assert.ok(saved.messages.some((message) => message.content === "written while connector was running"));
    assert.equal(saved.connectorActions.find((item) => item.id === proposal.id).status, "completed");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.CODEBATE_GMAIL_ACCESS_TOKEN;
    else process.env.CODEBATE_GMAIL_ACCESS_TOKEN = previousToken;
    await cleanup(session.id);
  }
});

test("two concurrent approvals claim one connector side effect exactly once", async () => {
  const session = await createSession("connector-double-approval-test");
  const previousToken = process.env.CODEBATE_GMAIL_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  let calls = 0;
  process.env.CODEBATE_GMAIL_ACCESS_TOKEN = "placeholder-token";
  globalThis.fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: true, status: 200, json: async () => ({ id: "message-id" }) };
  };
  try {
    await setConnectorEnabled(session.id, "gmail", true);
    const proposal = await requestConnectorAction(session.id, "gmail", "send_message", { to: "user@example.com", subject: "Hello", body: "Body" });
    const results = await Promise.allSettled([
      decideConnectorAction(session.id, proposal.id, true),
      decideConnectorAction(session.id, proposal.id, true),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.CODEBATE_GMAIL_ACCESS_TOKEN;
    else process.env.CODEBATE_GMAIL_ACCESS_TOKEN = previousToken;
    await cleanup(session.id);
  }
});

test("untrusted attached projects disable connectors even after opt-in", async () => {
  const session = await createSession("connector-trust-test");
  try {
    session.project = { path: "placeholder", trusted: false };
    await saveSession(session);
    await setConnectorEnabled(session.id, "github", true);
    await assert.rejects(() => requestConnectorAction(session.id, "github", "create_issue", {}), /untrusted/);
  } finally { await cleanup(session.id); }
});

test("MCP transport lists only session-enabled connector tools", async () => {
  const session = await createSession("mcp-test");
  try {
    await setConnectorEnabled(session.id, "github", true);
    const initialized = await handleMcpRequest({ id: 1, method: "initialize", params: { protocolVersion: "test-version" } }, session.id);
    assert.equal(initialized.result.protocolVersion, "2025-03-26");
    const listed = await handleMcpRequest({ id: 2, method: "tools/list" }, session.id, "connectors");
    assert.ok(listed.result.tools.some((tool) => tool.name === "connector__github__create_issue"));
    assert.equal(listed.result.tools.some((tool) => tool.name.includes("gmail")), false);
  } finally { await cleanup(session.id); }
});

test("MCP rejects structurally invalid requests", async () => {
  for (const request of [null, "invalid", [], {}]) {
    const rejected = await handleMcpRequest(request, "session_invalid_request");
    assert.equal(rejected.id, null);
    assert.equal(rejected.error.code, -32600);
  }
});

test("Claude receives a strict per-run MCP config even when no connector is enabled", () => {
  setMcpBridgeUrl("http://127.0.0.1:3210");
  const emptyLaunch = claudeMcpLaunch("");
  const empty = emptyLaunch.args;
  assert.ok(empty.includes("--strict-mcp-config"));
  assert.deepEqual(JSON.parse(empty[empty.indexOf("--mcp-config") + 1]), { mcpServers: {} });
  const scopedLaunch = claudeMcpLaunch("session_123", "connectors");
  const scoped = scopedLaunch.args;
  const config = JSON.parse(scoped[scoped.indexOf("--mcp-config") + 1]);
  assert.equal(config.mcpServers.codebate.env.CODEBATE_SESSION_ID, "session_123");
  assert.equal(config.mcpServers.codebate.env.CODEBATE_MCP_CAPABILITY, "connectors");
  const token = config.mcpServers.codebate.env.CODEBATE_MCP_BRIDGE_TOKEN;
  assert.deepEqual(resolveMcpBridgeGrant(token), { sessionId: "session_123", capability: "connectors" });
  scopedLaunch.release();
  assert.equal(resolveMcpBridgeGrant(token), null);
});

test("MCP capability scopes cannot mix project reads with connector tools", async () => {
  const session = await createSession("mcp-scope-test");
  try {
    await setConnectorEnabled(session.id, "github", true);
    const connectorList = await handleMcpRequest({ id: 1, method: "tools/list" }, session.id, "connectors");
    assert.ok(connectorList.result.tools.every((tool) => tool.name.startsWith("connector__")));
    const projectList = await handleMcpRequest({ id: 2, method: "tools/list" }, session.id, "project");
    assert.ok(projectList.result.tools.every((tool) => tool.name.startsWith("project__")));
    const blocked = await handleMcpRequest({ id: 3, method: "tools/call", params: { name: "connector__github__create_issue", arguments: {} } }, session.id, "project");
    assert.match(blocked.error.message, /outside this MCP capability scope/);
  } finally { await cleanup(session.id); }
});
