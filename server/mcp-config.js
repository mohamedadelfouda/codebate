import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("./mcp-server.js", import.meta.url));
const bridgeGrants = new Map();
let bridgeUrl = "";

export function setMcpBridgeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("MCP bridge must be loopback HTTP");
  bridgeUrl = new URL("/internal/mcp", url).toString();
}

export function resolveMcpBridgeGrant(value) {
  const token = String(value || "");
  const grant = bridgeGrants.get(token);
  if (!grant || grant.expiresAt < Date.now()) {
    bridgeGrants.delete(token);
    return null;
  }
  return { sessionId: grant.sessionId, capability: grant.capability };
}

function validatedSessionId(value) {
  const id = String(value || "");
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) return "";
  return id;
}

function launch(sessionId, capability) {
  const id = validatedSessionId(sessionId);
  if (!id || !bridgeUrl || !["project", "connectors"].includes(capability)) return null;
  const token = crypto.randomBytes(32).toString("hex");
  // agentTimeoutMs allows up to one hour; keep a small cleanup buffer and still
  // revoke immediately in the adapter's finally block on normal completion.
  bridgeGrants.set(token, { sessionId: id, capability, expiresAt: Date.now() + 65 * 60 * 1000 });
  return {
    token,
    command: process.execPath,
    args: [serverPath],
    env: {
      CODEBATE_SESSION_ID: id,
      CODEBATE_MCP_BRIDGE_URL: bridgeUrl,
      CODEBATE_MCP_BRIDGE_TOKEN: token,
      CODEBATE_MCP_CAPABILITY: capability,
      ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
  };
}

export function claudeMcpLaunch(sessionId, capability = "") {
  const config = launch(sessionId, capability);
  const mcpServers = config ? { codebate: { type: "stdio", ...config } } : {};
  if (config) delete mcpServers.codebate.token;
  return {
    args: ["--mcp-config", JSON.stringify({ mcpServers }), "--strict-mcp-config"],
    release: () => { if (config) bridgeGrants.delete(config.token); },
  };
}
