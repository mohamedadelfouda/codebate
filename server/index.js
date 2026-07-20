import http from "node:http";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import {
  listSessions,
  createSession,
  getSession,
  mutateSession,
  renameSession,
  deleteSession,
  listSessionRecoveries,
  exportSessionRecovery,
  retrySessionRecovery,
  deleteSessionRecovery,
  rootPath,
  isProjectTrusted,
  rememberTrustedProject,
  listTrustedProjects,
  forgetTrustedProject,
} from "./store.js";
import { approveProviderCommand, approvedProviderCommand, checkCommand, resolveAllowedCommand, runProcess, configureTrustedCliStore, hydrateTrustedProviderCommands } from "./process.js";
import { discoverProviderCommands } from "./cli-discovery.js";
import { runOrchestration, stopRun, isRunning, abortAllRuns, reconcileInterruptedRuns, validateOrchestrationRequest } from "./orchestrator.js";
import { runExecuteAndReview, acceptExecution, rejectExecution, isExecuting, stopExec, abortAllExecutions, reconcileExecutionWorktrees } from "./exec-orchestrator.js";
import { isGitRepo, hasGitHubOrigin } from "./worktree.js";
import { logError, logWarn, redact } from "./logger.js";
import { hostAllowed, checkApiAuth, issueCookieHeader, securityHeaders } from "./security.js";
import { projectIdentity } from "./project.js";
import { provider, providerCatalog, providerIds, discoverProviderModels } from "./providers/registry.js";
import { preflightRoute } from "./capability-router.js";
import { recordDecision } from "./decisions.js";
import { connectorCatalog, githubConnectorReadiness } from "./connectors/registry.js";
import { setConnectorEnabled, requestConnectorAction, decideConnectorAction, reconcileInterruptedReadAudits } from "./connectors/service.js";
import { handleMcpRequest } from "./mcp-server.js";
import { resolveMcpBridgeGrant, setMcpBridgeUrl } from "./mcp-config.js";
export { configureConnectorSecretStore, hydrateConnectorSecrets } from "./connector-config.js";
import { connectorConfigurationCatalog, saveConnectorConfiguration } from "./connector-config.js";
import { apiErrorPayload, expectedApiError } from "./api-errors.js";
import { acquireRuntimeLock, detectSyncedRuntimeFolder } from "./runtime-lock.js";
import {
  assertProvidersReady,
  configuredProviderCommand,
  invalidateProviderReadiness,
  providerReadiness,
  trustedProviderCliPaths,
} from "./provider-readiness.js";
import { checkAllProviderUpdates } from "./update-check.js";
import { checkAppUpdate, fetchLatestFromNpm } from "./app-update.js";
import { diagnosticSnapshot, healthSnapshot } from "./diagnostics.js";
import { sessionMarkdown } from "./session-export.js";

// First-run detection resolves native executables before entering an attached project.
// A path the user already trusted this run (via Trust & check) takes precedence, so
// re-checks reflect the working setup instead of the bare PATH lookup.
async function detectAgents() {
  const detected = await Promise.all(providerIds().map(async (id) => {
    const definition = provider(id);
    return [id, await providerReadiness(id, { refresh: true })];
  }));
  const githubReadiness = await githubConnectorReadiness({ refresh: true });
  const github = { authed: githubReadiness.ready, detail: githubReadiness.detail };
  return { providers: Object.fromEntries(detected), github };
}

// List the user's GitHub repos (so they pick instead of pasting a URL).
async function ghRepos() {
  const command = await resolveAllowedCommand("gh", new Set(["gh"]));
  const r = await runProcess({ command, args: ["repo", "list", "--limit", "100", "--json", "nameWithOwner,url,visibility,updatedAt"], envPolicy: "github", timeoutMs: 15000 });
  if (r.code !== 0) throw new Error((r.stderr || "gh repo list failed").split(/\r?\n/)[0]);
  return JSON.parse(r.stdout || "[]");
}
// Clone a chosen repo into a local projects folder, return its path.
async function ghClone(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid repo name");
  const base = path.join(os.homedir(), "CodebateProjects");
  const [owner, rawName] = repo.split("/");
  const name = rawName.replace(/\.git$/, "");
  if ([owner, name].some((part) => !part || part === "." || part === "..")) throw new Error("Invalid repo name");
  const dest = path.join(base, owner, name);
  const relativeDestination = path.relative(base, dest);
  if (!relativeDestination || relativeDestination.startsWith("..") || path.isAbsolute(relativeDestination)) throw new Error("Invalid repository destination");
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.access(dest);
    const command = await resolveAllowedCommand("git", new Set(["git"]));
    const result = await runProcess({ command, args: ["remote", "get-url", "origin"], cwd: dest, envPolicy: "agent", timeoutMs: 8000 });
    const remote = result.stdout.trim();
    const match = remote.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i);
    if (result.code !== 0 || !match || `${match[1]}/${match[2]}`.toLowerCase() !== `${owner}/${name}`.toLowerCase()) {
      throw new Error(`Existing destination does not match ${owner}/${name}: ${dest}`);
    }
    return { path: dest, existed: true };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const command = await resolveAllowedCommand("gh", new Set(["gh"]));
  const r = await runProcess({ command, args: ["repo", "clone", repo, dest], envPolicy: "github", timeoutMs: 180000 });
  if (r.code !== 0) throw new Error((r.stderr || "clone failed").split(/\r?\n/).slice(-2).join(" "));
  return { path: dest, existed: false };
}
// Server-side folder browser (no manual path typing). Empty path => drives on Windows.
async function listDirs(p) {
  if (!p) {
    if (process.platform === "win32") {
      const drives = [];
      for (const L of "CDEFGABHIJKLMNOPQRSTUVWXYZ") { try { await fs.access(`${L}:\\`); drives.push({ name: `${L}:\\`, path: `${L}:\\` }); } catch {} }
      return { path: "", parent: null, dirs: drives, isGit: false };
    }
    p = os.homedir() || path.parse(process.cwd()).root;
  }
  const entries = await fs.readdir(p, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => ({ name: e.name, path: path.join(p, e.name) })).sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(p);
  return { path: p, parent: parent === p ? "" : parent, dirs, isGit: await isGitRepo(p) };
}
// Update a CLI from inside the tool (claude update / codex update).
async function updateAgent(agent) {
  const definition = provider(agent);
  if (!definition) throw new Error("Unknown agent");
  if (!Array.isArray(definition.updateArgs) || definition.updateArgs.length === 0) throw new Error("This provider does not expose an in-app update command");
  const command = await resolveAllowedCommand(approvedProviderCommand(definition.id) || configuredProviderCommand(definition), new Set([definition.command]), { trustedPaths: trustedProviderCliPaths(definition) });
  const r = await runProcess({ command, args: definition.updateArgs, timeoutMs: 240000, containTree: true });
  const out = `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/).filter(Boolean).slice(-6).join("\n");
  return { ok: r.code === 0, output: out.slice(0, 900) };
}

let shuttingDown = false;
let shutdownPromise = null;
let startupReconciled = false;
let runtimeLock = null;
export function shutdownServer(reason = "requested") {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    try { await abortAllRuns(reason); } catch (e) { logError("abortAllRuns failed during shutdown", String(e)); }
    try { await abortAllExecutions(reason); } catch (e) { logError("abortAllExecutions failed during shutdown", String(e)); }
    await new Promise((resolve) => {
      try { server.close(() => resolve()); } catch { resolve(); }
      server.closeAllConnections?.();
    });
    const lock = runtimeLock;
    runtimeLock = null;
    try { await lock?.release(); } catch (e) { logError("runtime lock release failed during shutdown", String(e)); }
  })();
  return shutdownPromise;
}
async function gracefulShutdown(reason, error) {
  logError(`graceful shutdown (${reason})`, error?.stack || (error ? String(error) : ""));
  try { await shutdownServer(reason); }
  finally { process.exitCode = 1; }
}

// An uncaught exception leaves the process in an undefined state: log, stop accepting work,
// mark in-flight runs interrupted, then shut down cleanly (don't pretend nothing happened).
process.on("uncaughtException", (error) => gracefulShutdown("uncaughtException", error));
// Rejections are logged and classified, but do not force a crash on their own.
process.on("unhandledRejection", (reason) => logError("unhandledRejection (logged, not fatal)", reason?.stack || String(reason)));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = fileURLToPath(import.meta.url);
const directEntry = process.argv[1] && (process.platform === "win32"
  ? path.resolve(process.argv[1]).toLowerCase() === path.resolve(modulePath).toLowerCase()
  : path.resolve(process.argv[1]) === path.resolve(modulePath));
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const PORT = Number(process.env.PORT || 3210);
let activePort = PORT;
const clients = new Map();
// Cap concurrent SSE streams per session so a caller can't open unbounded streams (each holds a socket
// + heartbeat interval). A few browser tabs is the normal case; 8 is generous headroom.
const MAX_SSE_CLIENTS_PER_SESSION = 8;

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...securityHeaders() });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request body too large");
  }
  return body ? JSON.parse(body) : {};
}

function emit(sessionId, event) {
  const payload = `data: ${JSON.stringify({ ...event, at: new Date().toISOString() })}\n\n`;
  for (const res of clients.get(sessionId) ?? []) {
    try { res.write(payload); } catch {}
  }
}

function addSseClient(sessionId, req, res) {
  const existing = clients.get(sessionId);
  if (existing && existing.size >= MAX_SSE_CLIENTS_PER_SESSION) {
    return json(res, 429, apiErrorPayload("too_many_streams", "Too many open event streams for this session"));
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    ...securityHeaders(),
  });
  res.write(`data: ${JSON.stringify({ type: "connected", sessionId })}\n\n`);
  const set = clients.get(sessionId) ?? new Set();
  set.add(res);
  clients.set(sessionId, set);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    set.delete(res);
    if (set.size === 0) clients.delete(sessionId);
  });
}

// End every live SSE stream for a session. The browser's EventSource then auto-reconnects (unless
// the client closed it first), so its onopen re-sync path runs. Used when a session is deleted — its
// streams must not dangle — and by the reconnect regression test to force a deterministic drop.
export function closeSessionStreams(sessionId) {
  const set = clients.get(sessionId);
  if (!set) return 0;
  let closed = 0;
  for (const client of set) {
    try { client.end(); closed += 1; } catch { /* client already gone */ }
  }
  clients.delete(sessionId);
  return closed;
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" })[ext] || "application/octet-stream";
}

async function serveStatic(urlPath, res) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.resolve(PUBLIC_DIR, `.${requested}`);
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  try {
    const data = await fs.readFile(filePath);
    const headers = { "Content-Type": `${mimeType(filePath)}; charset=utf-8`, "Cache-Control": "no-store", ...securityHeaders() };
    // The HTML page carries the session cookie that authorizes subsequent /api calls.
    if (requested === "/index.html") headers["Set-Cookie"] = issueCookieHeader();
    res.writeHead(200, headers);
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    // Global host allowlist (DNS-rebinding defense) — reject before any routing or body read.
    if (!hostAllowed(req.headers.host, activePort)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", ...securityHeaders() });
      return res.end("Forbidden host");
    }
    if (req.method === "POST" && url.pathname === "/internal/mcp") {
      const grant = resolveMcpBridgeGrant(req.headers["x-codebate-mcp-token"]);
      if (!grant) return json(res, 401, apiErrorPayload("unauthorized", "Unauthorized"));
      const body = await readJson(req);
      const request = body && typeof body === "object" && Object.hasOwn(body, "request") ? body.request : null;
      return json(res, 200, await handleMcpRequest(request, grant.sessionId, grant.capability));
    }
    // Every /api/* route requires the per-run session token (cookie or header),
    // plus a matching Origin for state-changing methods. The page itself (served
    // statically) needs no token — it's what delivers the cookie.
    if (parts[0] === "api") {
      const auth = checkApiAuth(req, activePort);
      if (!auth.ok) {
        const code = auth.status === 403 ? "forbidden_origin" : "unauthorized";
        return json(res, auth.status, apiErrorPayload(code, auth.error));
      }
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, healthSnapshot({ runtimeLock, startupReconciled, shuttingDown }));
    }
    if (req.method === "GET" && url.pathname === "/api/diagnostics") {
      res.setHeader("Content-Disposition", `attachment; filename="codebate-diagnostics-${new Date().toISOString().slice(0, 10)}.json"`);
      return json(res, 200, await diagnosticSnapshot({ runtimeLock, startupReconciled, shuttingDown }));
    }
    if (req.method === "GET" && url.pathname === "/api/sessions") {
      return json(res, 200, await listSessions());
    }
    if (req.method === "GET" && url.pathname === "/api/session-recovery") {
      return json(res, 200, await listSessionRecoveries());
    }
    if (parts[0] === "api" && parts[1] === "session-recovery" && parts[2] && parts[3] === "export" && req.method === "GET") {
      const recovery = await exportSessionRecovery(parts[2]);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="codebate-recovery-${parts[2]}.json"`,
        "Content-Length": recovery.size,
        "Cache-Control": "no-store",
        ...securityHeaders(),
      });
      const stream = createReadStream(recovery.sourcePath);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
      return;
    }
    if (parts[0] === "api" && parts[1] === "session-recovery" && parts[2] && parts[3] === "retry" && req.method === "POST") {
      return json(res, 200, await retrySessionRecovery(parts[2]));
    }
    if (parts[0] === "api" && parts[1] === "session-recovery" && parts[2] && req.method === "DELETE" && parts.length === 3) {
      const body = await readJson(req);
      if (body.confirm !== true) return json(res, 400, apiErrorPayload("recovery_delete_confirmation_required", "Confirm deletion of the damaged session file"));
      return json(res, 200, await deleteSessionRecovery(parts[2]));
    }
    if (req.method === "POST" && url.pathname === "/api/sessions") {
      const body = await readJson(req);
      return json(res, 201, await createSession(body.title));
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && req.method === "GET" && parts.length === 3) {
      const session = await getSession(parts[2]);
      session.running = isRunning(parts[2]);
      session.executing = isExecuting(parts[2]);
      delete session.connectorActions;
      return json(res, 200, session);
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && req.method === "PATCH" && parts.length === 3) {
      const body = await readJson(req);
      try {
        return json(res, 200, await renameSession(parts[2], body.title));
      } catch (error) {
        if (error.code === "title_required") return json(res, 400, apiErrorPayload("title_required", error));
        if (error.code === "ENOENT" || /ENOENT|no such file/i.test(String(error.message))) {
          return json(res, 404, apiErrorPayload("not_found", error));
        }
        throw error;
      }
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && req.method === "DELETE" && parts.length === 3) {
      try {
        const result = await deleteSession(parts[2], {
          isBusy: () => isRunning(parts[2]) || isExecuting(parts[2]),
        });
        closeSessionStreams(parts[2]);
        return json(res, 200, result);
      } catch (error) {
        if (error.code === "session_busy") {
          return json(res, 409, apiErrorPayload("session_busy", error));
        }
        if (error.code === "pending_execution_decisions") {
          return json(res, 409, apiErrorPayload("pending_execution_decisions", error));
        }
        if (error.code === "pending_connector_actions") {
          return json(res, 409, apiErrorPayload("pending_connector_actions", error));
        }
        if (error.code === "ENOENT" || /ENOENT|no such file/i.test(String(error.message))) {
          return json(res, 404, apiErrorPayload("not_found", error));
        }
        throw error;
      }
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "events" && req.method === "GET") {
      // Don't open a stream for a session that doesn't exist (it would just sit there heartbeating forever).
      try { await getSession(parts[2]); }
      catch (error) {
        if (error.code === "ENOENT" || /ENOENT|no such file/i.test(String(error.message))) return json(res, 404, apiErrorPayload("not_found", "Session not found"));
        throw error;
      }
      return addSseClient(parts[2], req, res);
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "connectors" && req.method === "GET") {
      try {
        const session = await getSession(parts[2]);
        const allActions = session.connectorActions || [];
        const activeActions = allActions.filter((item) => ["pending", "executing_unknown"].includes(item.status));
        const recentTerminal = allActions.filter((item) => !["pending", "executing_unknown"].includes(item.status)).slice(-20);
        const github = await githubConnectorReadiness();
        return json(res, 200, {
          connectors: connectorCatalog({ github }), enabled: session.connectors || {},
          actions: [...activeActions, ...recentTerminal], readAudits: (session.connectorReadAudits || []).slice(-20),
        });
      } catch (error) {
        return json(res, error.apiStatus || 500, apiErrorPayload(error.apiCode || "connector_catalog_failed", error));
      }
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "connectors" && parts[4] && req.method === "POST") {
      const body = await readJson(req);
      try { return json(res, 200, await setConnectorEnabled(parts[2], parts[4], body.enabled === true)); }
      catch (error) { return json(res, error.apiStatus || 500, apiErrorPayload(error.apiCode || "connector_toggle_failed", error)); }
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "connector-actions" && parts.length === 4 && req.method === "POST") {
      if (shuttingDown) return json(res, 503, apiErrorPayload("server_shutting_down", "Server is shutting down"));
      if (!startupReconciled) return json(res, 503, apiErrorPayload("startup_recovery_pending", "Startup recovery is still running; retry in a moment"));
      const body = await readJson(req);
      try { return json(res, 200, await requestConnectorAction(parts[2], String(body.connector || ""), String(body.action || ""), body.input || {})); }
      catch (error) { return json(res, error.apiStatus || 500, apiErrorPayload(error.apiCode || "connector_action_request_failed", error)); }
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "connector-actions" && parts[4] && parts[5] === "decide" && req.method === "POST") {
      const body = await readJson(req);
      try { return json(res, 200, await decideConnectorAction(parts[2], parts[4], body.approve)); }
      catch (error) { return json(res, error.apiStatus || 500, apiErrorPayload(error.apiCode || "connector_action_decision_failed", error)); }
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "message" && req.method === "POST") {
      if (shuttingDown) return json(res, 503, apiErrorPayload("server_shutting_down", "Server is shutting down"));
      if (!startupReconciled) return json(res, 503, apiErrorPayload("startup_recovery_pending", "Startup recovery is still running; retry in a moment"));
      const body = await readJson(req);
      if (isRunning(parts[2]) || isExecuting(parts[2])) return json(res, 409, apiErrorPayload("session_busy", "Session is already busy"));
      const session = await getSession(parts[2]);
      const route = preflightRoute(body.content, { projectTrusted: session.project?.trusted === true });
      if (!route.allowed) return json(res, 409, apiErrorPayload(route.reasonCode, route.reason, { route }));
      const validatedRequest = validateOrchestrationRequest(body);
      await assertProvidersReady(validatedRequest.selected);
      const backgroundRun = runOrchestration(parts[2], body, (event) => emit(parts[2], event));
      void backgroundRun.catch((error) => logError("orchestration background task failed", error?.stack || String(error)));
      return json(res, 202, { ok: true });
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "stop" && req.method === "POST") {
      return json(res, 200, { stopped: await stopRun(parts[2]) });
    }
    // ---- Execution layer ----
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "project" && req.method === "POST") {
      const body = await readJson(req);
      const projectPath = String(body.path || "").trim();
      if (!projectPath) return json(res, 400, apiErrorPayload("project_path_required", "Project path is required"));
      let stat;
      try { stat = await fs.stat(projectPath); }
      catch (error) {
        // A missing path (ENOENT) or a path whose parent component is a file (ENOTDIR) is a 400 "not found" —
        // matching projectIdentity's handling; permission, descriptor-exhaustion, and other I/O errors are real
        // faults, so let them reach the global handler (500) instead of being masked as "not found" here.
        if (["ENOENT", "ENOTDIR"].includes(error?.code)) return json(res, 400, apiErrorPayload("project_path_not_found", "Project path not found"));
        throw error;
      }
      if (!stat.isDirectory()) return json(res, 400, apiErrorPayload("project_path_not_directory", "Project path is not a directory"));
      const git = await isGitRepo(projectPath);
      const identity = await projectIdentity(projectPath);
      const canOpenPr = git ? await hasGitHubOrigin(identity.realPath) : false;
      // Remembered consent: if the user already trusted THIS exact project (same fingerprint) before, attach it
      // already-trusted instead of forcing the trust step again. Restricted to a STRONG identity — a git repo
      // whose on-disk .git instance we could resolve (identity.gitInstance) — because a non-git/unresolvable
      // folder's fingerprint is essentially path-only, so a reused path could otherwise silently re-trust
      // unrelated content. Same condition gates the save below. assertTrustedProject still re-verifies at run time.
      const strongIdentity = Boolean(identity.gitInstance);
      const remembered = strongIdentity && await isProjectTrusted(identity.fingerprint);
      const project = await mutateSession(parts[2], (session) => {
        if ((session.executions || []).some((item) => !["merged", "pr_opened", "rejected", "blocked_secret"].includes(item.status))) {
          throw expectedApiError("pending_execution_decisions", "Resolve pending execution decisions before changing the attached project");
        }
        session.project = {
          path: identity.realPath,
          fingerprint: identity.fingerprint,
          trusted: remembered,
          isGit: git,
          canOpenPr,
          ...(remembered ? { trustedAt: new Date().toISOString(), trustedFromMemory: true } : {}),
        };
        if (remembered) recordDecision(session, { type: "project_trust", outcome: "trusted", metadata: { fingerprint: identity.fingerprint, fromMemory: true } });
        return structuredClone(session.project);
      });
      return json(res, 200, { project });
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "project-trust" && req.method === "POST") {
      const body = await readJson(req);
      const claim = await getSession(parts[2]);
      if (!claim.project?.path) return json(res, 400, apiErrorPayload("project_not_attached", "Attach a project first"));
      const identity = await projectIdentity(claim.project.path);
      if (body.fingerprint !== claim.project.fingerprint || identity.fingerprint !== claim.project.fingerprint) {
        return json(res, 409, apiErrorPayload("project_identity_changed", "Project identity changed; attach it again before trusting"));
      }
      const project = await mutateSession(parts[2], (session) => {
        if (session.project?.path !== claim.project.path || session.project?.fingerprint !== claim.project.fingerprint) {
          throw expectedApiError("project_changed_before_trust", "Attached project changed before trust was recorded; review it again");
        }
        session.project.trusted = true;
        session.project.trustedAt = new Date().toISOString();
        recordDecision(session, { type: "project_trust", outcome: "trusted", metadata: { fingerprint: session.project.fingerprint } });
        return structuredClone(session.project);
      });
      // Remember this consent so re-attaching the same project later skips the trust step — but ONLY for a
      // strong identity (a git repo whose on-disk .git instance we could resolve; identity.gitInstance),
      // the SAME condition the auto-apply on attach uses. A path-only fingerprint is never persisted.
      if (identity.gitInstance) await rememberTrustedProject(project.fingerprint, project.path);
      return json(res, 200, { project });
    }
    if (parts[0] === "api" && parts[1] === "trusted-projects" && !parts[2] && req.method === "GET") {
      return json(res, 200, { projects: await listTrustedProjects() });
    }
    if (parts[0] === "api" && parts[1] === "app-update" && !parts[2] && req.method === "GET") {
      // G1: notice-only npm-registry version check. Egress happens only when a client asks (the setup modal),
      // never on page load; fail-soft (never a wrong "up to date"), and it never auto-updates anything.
      return json(res, 200, await checkAppUpdate({ fetchLatest: fetchLatestFromNpm }));
    }
    if (parts[0] === "api" && parts[1] === "trusted-projects" && parts[2] && req.method === "DELETE") {
      // Forget a remembered trust: the next attach of that project re-prompts for consent.
      const projects = await forgetTrustedProject(decodeURIComponent(parts[2]));
      return json(res, 200, { projects });
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "execute" && req.method === "POST") {
      if (shuttingDown) return json(res, 503, apiErrorPayload("server_shutting_down", "Server is shutting down"));
      if (!startupReconciled) return json(res, 503, apiErrorPayload("startup_recovery_pending", "Startup recovery is still running; retry in a moment"));
      if (isExecuting(parts[2]) || isRunning(parts[2])) return json(res, 409, apiErrorPayload("session_busy", "Session is already busy"));
      const body = await readJson(req);
      const backgroundExecution = runExecuteAndReview(parts[2], body, (event) => emit(parts[2], event));
      void backgroundExecution.catch((error) => logError("execution background task failed", error?.stack || String(error)));
      return json(res, 202, { ok: true });
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "exec-stop" && req.method === "POST") {
      // { stopped, status } — status is stop_requested | process_terminated | already_finished.
      return json(res, 200, await stopExec(parts[2]));
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "execution" && parts[4] && parts[5] === "accept" && req.method === "POST") {
      if (!startupReconciled) return json(res, 503, apiErrorPayload("startup_recovery_pending", "Startup recovery is still running; retry in a moment"));
      const body = await readJson(req);
      try { return json(res, 200, await acceptExecution(parts[2], parts[4], body.action || "merge")); }
      catch (e) { return json(res, e.apiStatus || 400, apiErrorPayload(e.apiCode || "execution_accept_failed", e)); }
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "execution" && parts[4] && parts[5] === "reject" && req.method === "POST") {
      if (!startupReconciled) return json(res, 503, apiErrorPayload("startup_recovery_pending", "Startup recovery is still running; retry in a moment"));
      try { return json(res, 200, await rejectExecution(parts[2], parts[4])); }
      catch (e) { return json(res, e.apiStatus || 400, apiErrorPayload(e.apiCode || "execution_reject_failed", e)); }
    }
    if (req.method === "GET" && url.pathname === "/api/agents/status") {
      return json(res, 200, await detectAgents());
    }
    // Reads the npm registry (network) to report which agent CLIs have a newer version, so the UI can
    // show UPDATE vs UPDATED. Separate from status so status stays fast/offline; fails soft.
    if (req.method === "GET" && url.pathname === "/api/agents/update-check") {
      return json(res, 200, await checkAllProviderUpdates());
    }
    if (req.method === "GET" && url.pathname === "/api/providers") {
      return json(res, 200, { providers: providerCatalog() });
    }
    if (req.method === "GET" && url.pathname === "/api/connector-config") {
      return json(res, 200, { connectors: connectorConfigurationCatalog() });
    }
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "connector-config" && parts[2]) {
      const body = await readJson(req);
      try { return json(res, 200, { connector: await saveConnectorConfiguration(parts[2], body) }); }
      catch (e) { return json(res, 400, apiErrorPayload("connector_configuration_failed", e)); }
    }
    if (req.method === "POST" && url.pathname === "/api/agents/update") {
      const body = await readJson(req);
      try { return json(res, 200, await updateAgent(String(body.agent || ""))); }
      catch (e) { return json(res, 400, apiErrorPayload("provider_update_failed", e)); }
    }
    if (req.method === "GET" && url.pathname === "/api/github/repos") {
      try { return json(res, 200, { repos: await ghRepos() }); }
      catch (e) { return json(res, 200, apiErrorPayload("github_repositories_unavailable", e, { repos: [] })); }
    }
    if (req.method === "POST" && url.pathname === "/api/github/clone") {
      const body = await readJson(req);
      try { return json(res, 200, await ghClone(String(body.repo || ""))); }
      catch (e) { return json(res, 400, apiErrorPayload("github_clone_failed", e)); }
    }
    if (req.method === "GET" && url.pathname === "/api/fs/list") {
      try { return json(res, 200, await listDirs(url.searchParams.get("path") || "")); }
      catch (e) { return json(res, 400, apiErrorPayload("filesystem_list_failed", e)); }
    }
    if (parts[0] === "api" && parts[1] === "sessions" && parts[2] && parts[3] === "export" && req.method === "GET") {
      const session = await getSession(parts[2]);
      const md = sessionMarkdown(session);
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename=\"codebate-${session.id}.md\"`,
        ...securityHeaders(),
      });
      return res.end(md);
    }
    if (req.method === "POST" && url.pathname === "/api/cli/check") {
      const body = await readJson(req);
      try {
        const definition = provider(String(body.provider || ""));
        if (!definition) throw new Error("Select a known provider before trusting its executable");
        // Descriptor-launched providers (e.g. Cursor) resolve readiness through their pinned launch
        // descriptor, never the command allowlist — refuse a command probe here rather than mislead.
        if (definition.descriptorLaunch) throw new Error(`${definition.label} launches via a trusted descriptor, not an editable command`);
        if (path.isAbsolute(String(body.command || ""))) {
          await approveProviderCommand(definition.id, body.command, new Set([definition.command]));
          invalidateProviderReadiness(definition.id);
        }
        const status = await checkCommand(body.command, { allowedCommands: new Set([definition.command]), trustedPaths: trustedProviderCliPaths(definition) });
        return json(res, 200, status.ok ? status : { ...status, code: "provider_check_failed" });
      }
      catch (e) { return json(res, 200, { ok: false, version: "", code: "provider_check_failed", detail: redact(e.message) }); }
    }
    // Read-only discovery of native executables that PATH search misses (e.g.
    // npm-installed Codex on Windows exposes only cmd/ps1 shims). Nothing found
    // here is executed or trusted; the user still confirms via Trust & check.
    if (req.method === "POST" && url.pathname === "/api/cli/discover") {
      const body = await readJson(req);
      try {
        const definition = provider(String(body.provider || ""));
        if (!definition) throw new Error("Select a known provider before discovering its executable");
        if (definition.descriptorLaunch) throw new Error(`${definition.label} launches via a trusted descriptor, not an editable command`);
        const candidates = await discoverProviderCommands(definition.command);
        let resolved = "";
        try { resolved = await resolveAllowedCommand(approvedProviderCommand(definition.id) || configuredProviderCommand(definition), new Set([definition.command]), { trustedPaths: trustedProviderCliPaths(definition) }); }
        catch (e) { logError("cli discover: configured command did not resolve", redact(e.message)); }
        return json(res, 200, { resolved, candidates });
      }
      catch (e) { return json(res, 400, apiErrorPayload("provider_discovery_failed", e)); }
    }
    if (req.method === "POST" && parts[0] === "api" && parts[1] === "providers" && parts[2] && parts[3] === "models") {
      const body = await readJson(req);
      try {
        return json(res, 200, { models: await discoverProviderModels(parts[2], { command: body.command || provider(parts[2])?.command }) });
      } catch (error) {
        const detail = redact(error.message);
        return json(res, 200, { models: [], code: "provider_model_discovery_failed", warning: detail, detail });
      }
    }
    if (await serveStatic(url.pathname, res)) return;
    json(res, 404, apiErrorPayload("not_found", "Not found"));
  } catch (error) {
    json(res, error.apiStatus || 500, apiErrorPayload(error.apiCode || "internal_error", error));
  }
});

export const serverReady = new Promise((resolve, reject) => {
  // Bail out of startup if a shutdown was requested while we were preparing. Releasing the lock
  // here (rather than only in shutdownServer) is required because shutdownServer may have run
  // before this async body acquired the lock, so it would not have seen it.
  const abortIfShuttingDown = async () => {
    if (!shuttingDown) return false;
    await runtimeLock?.release().catch(() => {});
    runtimeLock = null;
    return true;
  };
  // Startup-only guard: covers a pre-listen failure such as EADDRINUSE. It is removed the moment
  // the server is listening; from then on a server error must STOP the server (below), never
  // release the lock and leave a lock-less server still serving traffic.
  const onStartupError = (error) => {
    void Promise.resolve(runtimeLock?.release()).finally(() => {
      runtimeLock = null;
      reject(error);
    });
  };
  server.once("error", onStartupError);
  void (async () => {
    if (shuttingDown) throw new Error("server_shutting_down");
    runtimeLock = await acquireRuntimeLock(rootPath(), {
      onOwnershipLost(error) { void gracefulShutdown("runtime_lock_lost", error); },
    });
    if (await abortIfShuttingDown()) throw new Error("server_shutting_down");
    // P1-2: the runtime lock is advisory; file-sync clients rewrite mtime/ino out of band and can
    // corrupt it (and clobber session writes). Warn — never block — when the data folder looks synced.
    const syncedFolder = detectSyncedRuntimeFolder(rootPath());
    if (syncedFolder) {
      logWarn(`Data folder is inside a synced folder (${syncedFolder.provider}). Move it to a LOCAL disk: file-sync clients can corrupt the advisory runtime lock and clobber session writes. Set CODEBATE_RUNTIME_DIR to a local path.`);
    }
    // Restore Trust & check approvals from the previous run before accepting
    // traffic, so detectAgents and absolute command paths keep working after a
    // restart without asking the user to set up again.
    configureTrustedCliStore(path.join(rootPath(), "data", "trusted-cli.json"));
    try { await hydrateTrustedProviderCommands(); }
    catch (error) { logError("trusted CLI hydrate failed", redact(error.message)); }
    if (await abortIfShuttingDown()) throw new Error("server_shutting_down");
    server.listen(PORT, "127.0.0.1", () => {
      // Now listening: replace the startup guard with a fatal handler. Any later operational
      // server error goes through gracefulShutdown, which stops the server AND releases the lock,
      // instead of the old behavior that released the lock but kept the process serving.
      server.removeListener("error", onStartupError);
      server.on("error", (error) => { void gracefulShutdown("server_error", error); });
      // A shutdown that landed between the last guard and here: tear down instead of announcing ready.
      if (shuttingDown) { void gracefulShutdown("server_shutting_down"); reject(new Error("server_shutting_down")); return; }
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : PORT;
      activePort = actualPort;
      const url = `http://127.0.0.1:${actualPort}`;
      setMcpBridgeUrl(url);
      void Promise.all([
        reconcileInterruptedRuns().catch((error) => logError("discussion reconciliation failed", error.message)),
        reconcileExecutionWorktrees().catch((error) => logError("execution workspace reconciliation failed", error.message)),
        reconcileInterruptedReadAudits().catch((error) => logError("connector read audit reconciliation failed", error.message)),
      ]).finally(() => {
        startupReconciled = true;
        console.log(`\nCodebate is running at ${url}\nData folder: ${path.join(rootPath(), "data")}\n`);
        if (process.env.NO_OPEN !== "1") {
          const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
          const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
          try { spawn(command, args, { detached: true, stdio: "ignore" }).unref(); } catch {}
        }
        resolve({ port: actualPort, url });
      });
    });
  })().catch(async (error) => {
    server.removeListener("error", onStartupError);
    await runtimeLock?.release().catch(() => {});
    runtimeLock = null;
    reject(error);
  });
});

if (directEntry) {
  void serverReady.catch((error) => gracefulShutdown("startup", error));
}
