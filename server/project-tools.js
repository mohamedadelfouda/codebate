import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { completeUtf8PrefixLength } from "./output-limits.js";

const scopes = new Map();
const MAX_DIRECTORY_ENTRIES = 500;
const MAX_READ_CHARS = 128000;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function validSessionId(value) {
  return /^[a-zA-Z0-9_-]{8,100}$/.test(String(value || ""));
}

function relativeInput(value = "") {
  const input = String(value || "").replace(/\\/g, "/");
  if (input.includes("\0") || path.posix.isAbsolute(input) || input.split("/").includes("..")) {
    throw new Error("Project tool paths must stay inside the attached project");
  }
  return input.replace(/^\.\//, "");
}

async function scopedPath(scope, relative = "") {
  const candidate = path.resolve(scope.root, relativeInput(relative));
  const resolved = await fs.realpath(candidate);
  const prefix = scope.root.endsWith(path.sep) ? scope.root : `${scope.root}${path.sep}`;
  if (resolved !== scope.root && !resolved.startsWith(prefix)) throw new Error("Project path escapes the attached project");
  return resolved;
}

function sameFileIdentity(...stats) {
  return stats.every((stat) => stat.isFile())
    && stats.every((stat) => stat.dev === stats[0].dev && stat.ino === stats[0].ino);
}

async function openScopedFile(scope, relative) {
  const input = relativeInput(relative);
  const candidate = path.resolve(scope.root, input);
  const canonical = await scopedPath(scope, input);
  const before = await fs.lstat(canonical, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Project path is not a regular file");
  const handle = await fs.open(canonical, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const [opened, resolvedAgain, after] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.realpath(candidate),
      fs.lstat(canonical, { bigint: true }),
    ]);
    if (resolvedAgain !== canonical || !sameFileIdentity(before, opened, after)) {
      throw new Error("Project file changed while it was being opened; retry the read");
    }
    return { handle, stat: opened };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function registerProjectScope(sessionId, root) {
  if (!validSessionId(sessionId)) throw new Error("Invalid project-tool session id");
  const canonicalRoot = await fs.realpath(root);
  const token = Symbol(sessionId);
  scopes.set(sessionId, { root: canonicalRoot, token });
  return () => {
    if (scopes.get(sessionId)?.token === token) scopes.delete(sessionId);
  };
}

export function projectToolDefinitions(sessionId) {
  if (!scopes.has(sessionId)) return [];
  return [
    {
      name: "project__list_directory",
      description: "List one directory inside the explicitly trusted project. Read-only and bounded.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    {
      name: "project__read_file",
      description: "Read a bounded text slice from a file inside the explicitly trusted project.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: MAX_READ_CHARS } },
        required: ["path"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
  ];
}

export async function executeProjectTool(sessionId, name, input = {}) {
  const scope = scopes.get(sessionId);
  if (!scope) throw new Error("No trusted project scope is active for this session");
  if (name === "project__list_directory") {
    const directory = await scopedPath(scope, input.path || "");
    const before = await fs.lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Project path is not a real directory");
    const entries = [];
    const handle = await fs.opendir(directory);
    for await (const entry of handle) {
      if (entries.length >= MAX_DIRECTORY_ENTRIES) throw new Error("Directory has too many entries; request a narrower path");
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".agent-workspaces") continue;
      entries.push({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" });
    }
    const directoryAgain = await scopedPath(scope, input.path || "");
    const after = await fs.lstat(directory, { bigint: true });
    if (directoryAgain !== directory || !after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error("Project directory changed while it was being listed; retry the read");
    }
    return entries;
  }
  if (name === "project__read_file") {
    const offset = Math.max(0, Number.isSafeInteger(input.offset) ? input.offset : 0);
    const limit = Math.min(MAX_READ_CHARS, Math.max(1, Number.isInteger(input.limit) ? input.limit : 64000));
    const { handle, stat } = await openScopedFile(scope, input.path);
    try {
      const remaining = stat.size > BigInt(offset) ? stat.size - BigInt(offset) : 0n;
      const readLimit = Number(remaining > BigInt(limit + 3) ? BigInt(limit + 3) : remaining);
      const buffer = Buffer.alloc(readLimit);
      const { bytesRead } = await handle.read(buffer, 0, readLimit, offset);
      let contentBytes = completeUtf8PrefixLength(buffer, Math.min(bytesRead, limit));
      for (let candidate = limit + 1; contentBytes === 0 && candidate <= bytesRead; candidate += 1) {
        contentBytes = completeUtf8PrefixLength(buffer, candidate);
      }
      if (bytesRead > 0 && contentBytes === 0) throw new Error("Project file is not valid UTF-8 at the requested offset");
      const nextOffset = offset + contentBytes;
      let content;
      try {
        content = fatalUtf8Decoder.decode(buffer.subarray(0, contentBytes));
      } catch {
        throw new Error("Project file is not valid UTF-8 at the requested offset");
      }
      return { path: relativeInput(input.path), offset, nextOffset, eof: BigInt(nextOffset) >= stat.size, content };
    } finally {
      await handle.close();
    }
  }
  throw new Error("Unknown project tool");
}
