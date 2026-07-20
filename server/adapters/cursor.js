import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess, validateOption } from "../process.js";
import { redact } from "../logger.js";
import { agentTimeoutMs } from "../output-limits.js";
import { buildCursorLaunchDescriptor } from "../providers/cursor-launch.js";

// Cursor (cursor-agent) reviewer adapter.
//
// Cursor is REVIEW-ONLY in Codebate (capabilities.executeModes []): its OS sandbox — the only thing that
// could contain writes/network for execution — exists on macOS/Linux but NOT Windows, where cursor-agent
// FAILS CLOSED on `--sandbox enabled`. Review write-safety does not need the OS sandbox: it comes from
// `--mode plan` (read-only; verified to write nothing), NOT from the cwd. The orchestrator passes the real
// attached project as cwd in discuss/collaboration/debate/chat (read-only planning — the same projectRead
// exposure as Codex) and a disposable clone only in Execute→Review; --mode plan is what keeps both read-only.
// Cursor launches through a trusted descriptor — a fixed node + index.js chain, containment-checked inside
// the trusted version dir and fingerprinted fresh at launch (never a bare `node` on the process allowlist) —
// always with a sanitized env (no NODE_OPTIONS) and never `--force`/`--yolo`.
//
// REGISTRY-WIRED as a review-only provider (CU-1), with the owner's explicit acceptance of the Windows
// residual. Config isolation IS implemented (withIsolatedConfig gives each review a disposable
// CURSOR_CONFIG_DIR with the user's own MCPs/settings off). What is NOT enforced is OS-level network denial
// on Windows: cursor-agent has no OS sandbox there, so a Windows review reads the project (the real attached
// project in discussion flows; the disposable clone in Execute→Review) and can reach the network — contained
// only by --mode plan (read-only), not by the cwd. macOS/Linux run OS-sandboxed. See SECURITY.md for the
// accepted residual.

const REVIEW_PERMISSIONS = new Set(["read", "chat", "planread"]);

// Build the review argv. Pure, so the argv boundary (entry point first, plan mode, never --force) is
// directly testable. Request args only ever append AFTER the descriptor's fixed prefix ([entryPoint]).
export function buildCursorReviewArgs({ descriptor, model, platform = process.platform, web = false }) {
  // Windows has no OS sandbox (allowlist mode only); macOS/Linux run the reviewer OS-sandboxed.
  // Web (chat) mode needs network egress, so the sandbox is dropped there — but the orchestrator only
  // enables web when NO project is attached (webOnly = phase==="chat" && !useProject), so the run happens
  // in an EMPTY scratch cwd. Dropping the sandbox for web therefore exposes only that empty dir to the
  // network, never the real project. Every non-web run keeps the sandbox enabled on macOS/Linux.
  const sandbox = (web || platform === "win32") ? "disabled" : "enabled";
  const args = [
    ...descriptor.fixedPrefixArgs, // exactly [entryPoint] — validated; nothing may precede it
    "--print",
    "--output-format", "json",
    "--mode", "plan",              // read-only planning; never --force / --yolo
    "--sandbox", sandbox,
    "--trust",                     // trust the workspace in headless mode (real project in discussion flows, clone in Execute→Review)
  ];
  if (model) {
    // A leading dash would let a model value pose as its own flag (e.g. --yolo, cursor-agent's apply mode).
    // Reject it, and emit the value as a single --model=<value> token so the parser can never split it into
    // a separate flag — a bogus value then fails closed as an unknown model instead of enabling anything.
    if (model.startsWith("-")) throw new Error("Cursor model must not start with '-'");
    args.push(`--model=${model}`);
  }
  return args;
}

// cursor-agent --output-format json prints a single result object. Parse it defensively (tolerate a stray
// leading line) and return null when nothing parseable is present, so callers fail closed.
export function parseCursorResult(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  // Only accept a real result envelope, so a coincidental JSON-shaped line can't pose as the review.
  const envelope = (obj) => (obj && typeof obj === "object" && ("result" in obj || "is_error" in obj || "type" in obj) ? obj : null);
  try { const whole = envelope(JSON.parse(text)); if (whole) return whole; } catch {}
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { const obj = envelope(JSON.parse(lines[i])); if (obj) return obj; } catch {}
  }
  return null;
}

// Parse `cursor-agent --list-models` output ("<id> - <label>" per line) into sorted unique model ids.
export function parseCursorModels(stdout) {
  const models = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = /^([a-z0-9][\w.-]*)\s+-\s+/i.exec(line.trim());
    if (match) models.push(match[1]);
  }
  return [...new Set(models)].sort();
}

function cursorErrorMessage(parsed, processResult, stderr) {
  const fromResult = parsed?.is_error && typeof parsed?.result === "string" ? parsed.result : "";
  const firstStderr = stderr.find((line) => line.trim()) || "";
  // Redact the surfaced message — it becomes error.message, the most user-visible path; error.technical
  // and discoverCursorModels already redact, so match them (redact strips username/local paths).
  return redact((fromResult || firstStderr || `Cursor exited with code ${processResult.code}`).trim());
}

async function resolveDescriptor() {
  // Build + validate from the real install RIGHT before use: the fresh fingerprints are the runtime
  // integrity check, and building last keeps the check-to-exec window minimal.
  const built = await buildCursorLaunchDescriptor({});
  if (!built.ok) throw new Error(`Cursor launch chain unavailable: ${built.reason}`);
  if (!built.validation.valid) throw new Error(`Cursor launch descriptor invalid: ${built.validation.violations.join("; ")}`);
  return built.descriptor;
}

// Run `fn(configDir)` against a fresh, empty CURSOR_CONFIG_DIR so Cursor reads NO user MCPs/settings/project
// trust for this run — the configIsolated review layer. Login persists (stored OS-side; verified an empty
// config dir still authenticates). The temp dir is always cleaned up.
async function withIsolatedConfig(fn) {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "codebate-cursor-"));
  try { return await fn(configDir); }
  finally { await rm(configDir, { recursive: true, force: true }); }
}

export async function runCursor({ prompt, config, cwd, onEvent, registerChild }) {
  // Reviewer-only: an executor permission must never reach Cursor (it has no qualified write mode).
  const permission = config.permission || "read";
  if (!REVIEW_PERMISSIONS.has(permission)) throw new Error(`Unsupported Cursor permission: ${permission}`);
  const model = validateOption(config.model || "", "Cursor model");
  // "chat" is the web-enabled, project-less mode (see registry/orchestrator): drop the OS sandbox so the
  // reviewer can reach the network. It runs in an empty scratch cwd, so only that dir is exposed.
  const web = permission === "chat";

  const descriptor = await resolveDescriptor();
  const args = buildCursorReviewArgs({ descriptor, model, web });
  const stderr = [];
  const startedAt = Date.now();
  const processResult = await withIsolatedConfig((configDir) => runProcess({
    command: descriptor.executable,
    args,
    input: prompt,               // prompt via stdin — no CLI length limit
    cwd,
    env: { CURSOR_CONFIG_DIR: configDir }, // isolated per run — no user MCPs/settings/project trust leak in
    envPolicy: "agent",          // sanitized env: excludes NODE_OPTIONS/NODE_* (the envIsolated layer)
    timeoutMs: agentTimeoutMs(config.timeoutMs),
    containTree: true,           // Stop kills cursor-agent and its whole child tree
    registerChild,
    onStderrLine(line) { if (line.trim()) { if (stderr.length < 50) stderr.push(line); onEvent?.({ kind: "stderr", text: line.slice(0, 500) }); } }, // cap retained lines (only the first is used for the error) so a noisy/hostile child can't grow this unbounded
  }));
  const durationMs = Date.now() - startedAt;
  const parsed = parseCursorResult(processResult.stdout);
  const meta = { model: model || "(default)", effort: config.effort || "", exitCode: processResult.code, durationMs };

  if (processResult.code !== 0 || !parsed || parsed.is_error) {
    const error = new Error(cursorErrorMessage(parsed, processResult, stderr));
    error.partial = typeof parsed?.result === "string" ? parsed.result : "";
    error.outputTruncated = Boolean(processResult.stdoutTruncated);
    error.technical = redact([`exitCode=${processResult.code}`, (processResult.stderr || "").trim().split(/\r?\n/).slice(-8).join("\n")].filter(Boolean).join("\n")).slice(0, 4000);
    Object.assign(error, meta);
    throw error;
  }
  // Fail closed: only a string `result` is a real review. A malformed / changed shape (object, array, …)
  // becomes "" and routes into the "completed without a review" error below — never coerced into garbage
  // text like "[object Object]" and returned as a successful review. Mirrors the error path's guard above.
  const text = typeof parsed.result === "string" ? parsed.result.trim() : "";
  if (!text) { const error = new Error("Cursor completed without a review"); Object.assign(error, meta); throw error; }
  return { text, sessionId: parsed.session_id || null, outputTruncated: Boolean(processResult.stdoutTruncated), ...meta };
}

export async function discoverCursorModels() {
  const descriptor = await resolveDescriptor();
  const result = await withIsolatedConfig((configDir) => runProcess({
    command: descriptor.executable,
    args: [...descriptor.fixedPrefixArgs, "--list-models"],
    env: { CURSOR_CONFIG_DIR: configDir },
    envPolicy: "agent",
    timeoutMs: 15000,
    containTree: true,
  }));
  if (result.code !== 0) throw new Error(redact((result.stderr || "Unable to read Cursor model catalog").split(/\r?\n/)[0]));
  return parseCursorModels(result.stdout);
}
