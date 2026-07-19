import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROOT = process.env.CODEBATE_RUNTIME_DIR ? path.resolve(process.env.CODEBATE_RUNTIME_DIR) : path.resolve(__dirname, "..");
const LOG_DIR = path.join(RUNTIME_ROOT, "logs");
const LOG_FILE = path.join(LOG_DIR, "server.log");
const CURRENT_USER = process.env.USERNAME || process.env.USER || "";
const MAX_LOG_BYTES = Math.max(1024, Math.min(100 * 1024 * 1024, Number(process.env.CODEBATE_LOG_MAX_BYTES) || 2 * 1024 * 1024));
const MAX_LOG_FILES = 3;
const loggerState = {
  healthy: true, totalFailures: 0, rotationCount: 0,
  lastWriteAt: null, lastErrorAt: null, lastErrorCategory: "",
};

function noteLoggerFailure(error) {
  loggerState.healthy = false;
  loggerState.totalFailures += 1;
  loggerState.lastErrorAt = new Date().toISOString();
  loggerState.lastErrorCategory = String(error?.code || error?.name || "logging_failed").slice(0, 80);
}

function ensureLogDirectory() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); }
  catch (error) { noteLoggerFailure(error); }
}

function rotateIfNeeded(nextBytes) {
  let currentBytes = 0;
  try { currentBytes = fs.statSync(LOG_FILE).size; }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (currentBytes + nextBytes <= MAX_LOG_BYTES) return;
  for (let index = MAX_LOG_FILES; index >= 1; index -= 1) {
    const source = index === 1 ? LOG_FILE : `${LOG_FILE}.${index - 1}`;
    const target = `${LOG_FILE}.${index}`;
    try {
      if (index === MAX_LOG_FILES) fs.rmSync(target, { force: true });
      fs.renameSync(source, target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  loggerState.rotationCount += 1;
}

ensureLogDirectory();

// Strip secrets and personal paths from anything before it reaches a log file,
// a stored technical-details field, or the export. Never a full guarantee, but
// removes the obvious leaks (tokens, keys, auth headers, home paths).
export function redact(input) {
  let text = String(input ?? "");
  if (CURRENT_USER) text = text.split(CURRENT_USER).join("<user>");
  return text
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1<redacted>@")
    .replace(/sk-[A-Za-z0-9_\-]{10,}/g, "<redacted-key>")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "<redacted-key>")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "<redacted-key>")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "<redacted-key>")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "<redacted-key>")
    .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "<redacted-key>")
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1<redacted>")
    .replace(/([A-Za-z0-9_]*(?:TOKEN|APIKEY|API_KEY|KEY|SECRET|PASSWORD|AUTH)[A-Za-z0-9_]*\s*[=:]\s*)("?)[^"\s]+\2/gi, "$1<redacted>")
    .replace(/([A-Za-z]:\\Users\\)[^\\\/\s"]+/g, "$1<user>")
    .replace(/(\/(?:Users|home)\/)[^\/\s"]+/g, "$1<user>");
}

function formatLine(level, msg, extra) {
  const ts = new Date().toISOString();
  let out = `[${ts}] ${level} ${msg}`;
  if (extra !== undefined && extra !== null) {
    try { out += " " + (typeof extra === "string" ? extra : JSON.stringify(extra)); } catch { out += " [unserializable]"; }
  }
  return out + "\n";
}

export function log(level, msg, extra) {
  const formatted = Buffer.from(redact(formatLine(level, msg, extra)), "utf8");
  const maxEntryBytes = Math.min(MAX_LOG_BYTES, 256 * 1024);
  const text = formatted.length <= maxEntryBytes
    ? formatted.toString("utf8")
    : `${formatted.subarray(0, Math.max(0, maxEntryBytes - 30)).toString("utf8")}\n[log entry truncated]\n`;
  try {
    ensureLogDirectory();
    rotateIfNeeded(Buffer.byteLength(text, "utf8"));
    fs.appendFileSync(LOG_FILE, text);
    loggerState.healthy = true;
    loggerState.lastWriteAt = new Date().toISOString();
  } catch (error) { noteLoggerFailure(error); }
  const stream = level === "ERROR" ? process.stderr : process.stdout;
  try { stream.write(text); } catch {}
}

export const logError = (msg, extra) => log("ERROR", msg, extra);
export const logWarn = (msg, extra) => log("WARN", msg, extra);

export function loggerHealth() {
  return { ...loggerState, maxLogBytes: MAX_LOG_BYTES, retainedFiles: MAX_LOG_FILES + 1 };
}

function tailText(filePath, maxBytes = 64 * 1024) {
  try {
    const size = fs.statSync(filePath).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const descriptor = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(descriptor, buffer, 0, length, start);
      return redact(buffer.toString("utf8"));
    } finally { fs.closeSync(descriptor); }
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    noteLoggerFailure(error);
    return "";
  }
}

export function diagnosticLogTails() {
  return Array.from({ length: MAX_LOG_FILES + 1 }, (_, index) => ({
    file: index === 0 ? "server.log" : `server.log.${index}`,
    tail: tailText(index === 0 ? LOG_FILE : `${LOG_FILE}.${index}`),
  })).filter((entry) => entry.tail);
}
