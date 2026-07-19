import { fileURLToPath } from "node:url";
import { getSession } from "./store.js";
import { connectorCatalog } from "./connectors/registry.js";
import { requestConnectorAction } from "./connectors/service.js";
import { redact } from "./logger.js";
import { executeProjectTool, projectToolDefinitions } from "./project-tools.js";

function response(id, result) { return { jsonrpc: "2.0", id, result }; }
function error(id, code, message) { return { jsonrpc: "2.0", id, error: { code, message: redact(message) } }; }
const toolName = (connector, action) => `connector__${connector}__${action}`;
const MCP_PROTOCOL_VERSION = "2025-03-26";

function redactedJson(value) {
  return JSON.stringify(value, (_key, nestedValue) => typeof nestedValue === "string" ? redact(nestedValue) : nestedValue);
}

function validRequest(request) {
  return Boolean(request && typeof request === "object" && !Array.isArray(request) && typeof request.method === "string");
}

export async function handleMcpRequest(request, sessionId, capability = "connectors") {
  if (!validRequest(request)) return error(null, -32600, "Invalid Request");
  if (!["project", "connectors"].includes(capability)) return error(request.id ?? null, -32602, "Invalid MCP capability scope");
  if (request.method === "initialize") {
    return response(request.id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "codebate-connectors", version: "0.2.0" },
      instructions: capability === "project"
        ? "Read-only, bounded access to the explicitly trusted project. Connector and web tools are unavailable in this capability scope."
        : "Connector reads run only after the user enables that connector for this Codebate session. Every state-changing tool creates a pending proposal; it never performs the external action. The user must approve that proposal in Codebate before execution.",
    });
  }
  if (request.method === "notifications/initialized") return null;
  if (request.method === "tools/list") {
    if (capability === "project") return response(request.id, { tools: projectToolDefinitions(sessionId) });
    const session = await getSession(sessionId);
    const tools = connectorCatalog().flatMap((item) => session.connectors?.[item.id]?.enabled === true
      ? item.actions.map((action) => ({
        name: toolName(item.id, action.id),
        description: `${action.description}${action.stateChanging ? " (creates a proposal; user approval is required before execution)" : ""}`,
        inputSchema: { type: "object", additionalProperties: true },
        annotations: { readOnlyHint: !action.stateChanging, destructiveHint: action.stateChanging },
      }))
      : []);
    return response(request.id, { tools });
  }
  if (request.method === "tools/call") {
    if (String(request.params?.name || "").startsWith("project__")) {
      if (capability !== "project") return error(request.id, -32602, "Project tools are outside this MCP capability scope");
      const result = await executeProjectTool(sessionId, request.params.name, request.params?.arguments || {});
      return response(request.id, { content: [{ type: "text", text: redactedJson(result).slice(0, 200000) }] });
    }
    if (capability !== "connectors") return error(request.id, -32602, "Connector tools are outside this MCP capability scope");
    const match = String(request.params?.name || "").match(/^connector__([a-z0-9_-]+)__([a-z0-9_-]+)$/);
    if (!match) return error(request.id, -32602, "Unknown connector tool");
    const result = await requestConnectorAction(sessionId, match[1], match[2], request.params?.arguments || {});
    return response(request.id, { content: [{ type: "text", text: redactedJson(result).slice(0, 100000) }] });
  }
  return error(request.id, -32601, "Method not found");
}

async function run() {
  const sessionId = process.env.CODEBATE_SESSION_ID;
  if (!sessionId) throw new Error("CODEBATE_SESSION_ID is required");
  const bridgeUrl = process.env.CODEBATE_MCP_BRIDGE_URL;
  const bridgeToken = process.env.CODEBATE_MCP_BRIDGE_TOKEN;
  const capability = process.env.CODEBATE_MCP_CAPABILITY;
  if (!bridgeUrl || !bridgeToken || !["project", "connectors"].includes(capability)) throw new Error("Codebate MCP bridge is not configured");
  let buffered = Buffer.alloc(0);
  const handleLine = async (line) => {
    if (!line.trim()) return;
    let request;
    try { request = JSON.parse(line); }
    catch { process.stdout.write(`${JSON.stringify(error(null, -32700, "Parse error"))}\n`); return; }
    if (!validRequest(request)) { process.stdout.write(`${JSON.stringify(error(null, -32600, "Invalid Request"))}\n`); return; }
    try {
      const bridgeResponse = await fetch(bridgeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Codebate-MCP-Token": bridgeToken },
        body: JSON.stringify({ request }),
        signal: AbortSignal.timeout(30000),
      });
      if (!bridgeResponse.ok) throw new Error(`MCP bridge rejected the request (${bridgeResponse.status})`);
      const result = await bridgeResponse.json();
      if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (failure) {
      process.stdout.write(`${JSON.stringify(error(request?.id ?? null, -32000, failure.message))}\n`);
    }
  };
  for await (const chunk of process.stdin) {
    if (buffered.length + chunk.length > 1024 * 1024) throw new Error("MCP request exceeded 1 MiB");
    buffered = Buffer.concat([buffered, chunk]);
    let newline;
    while ((newline = buffered.indexOf(10)) !== -1) {
      const line = buffered.subarray(0, newline).toString("utf8");
      buffered = buffered.subarray(newline + 1);
      await handleLine(line);
    }
  }
  if (buffered.length) await handleLine(buffered.toString("utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run().catch((failure) => {
  process.stderr.write(`${redact(failure.message)}\n`);
  process.exitCode = 1;
});
