import fs from "node:fs/promises";

export const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MAX_AGENT_TEXT_BYTES = 4 * 1024 * 1024;
export const MAX_STREAM_LINE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000;

const TRUNCATED = "\n…[truncated]";

export function completeUtf8PrefixLength(value, maxBytes = value.length) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const end = Math.min(buffer.length, Math.max(0, maxBytes));
  if (end === 0) return 0;
  let leadIndex = end - 1;
  while (leadIndex >= 0 && (buffer[leadIndex] & 0xc0) === 0x80) leadIndex -= 1;
  if (leadIndex < 0) return end;
  const lead = buffer[leadIndex];
  const sequenceBytes = lead >= 0xf0 && lead <= 0xf4 ? 4
    : lead >= 0xe0 && lead <= 0xef ? 3
      : lead >= 0xc2 && lead <= 0xdf ? 2
        : 1;
  return leadIndex + sequenceBytes > end ? leadIndex : end;
}

export class CappedText {
  constructor(maxBytes = MAX_AGENT_TEXT_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer");
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.bytes = 0;
    this.truncated = false;
  }

  append(value) {
    if (value === undefined || value === null || this.truncated) return this;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    const room = this.maxBytes - this.bytes;
    if (chunk.length <= room) {
      this.chunks.push(Buffer.from(chunk));
      this.bytes += chunk.length;
      return this;
    }
    if (room > 0) {
      this.chunks.push(Buffer.from(chunk.subarray(0, room)));
      this.bytes += room;
    }
    this.truncated = true;
    return this;
  }

  replace(value) {
    this.chunks = [];
    this.bytes = 0;
    this.truncated = false;
    return this.append(value);
  }

  toString() {
    const contents = Buffer.concat(this.chunks, this.bytes);
    const safeLength = this.truncated ? completeUtf8PrefixLength(contents) : contents.length;
    const text = contents.subarray(0, safeLength).toString("utf8");
    return this.truncated ? `${text}${TRUNCATED}` : text;
  }

  toBuffer() {
    return Buffer.concat(this.chunks, this.bytes);
  }
}

export function agentTimeoutMs(value = process.env.CODEBATE_AGENT_TIMEOUT_MS) {
  if (value === undefined || value === null || value === "") return DEFAULT_AGENT_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 60 * 60 * 1000) {
    throw new Error("Agent timeout must be an integer between 1000 and 3600000 milliseconds");
  }
  return timeout;
}

export async function readTextFileCapped(filePath, maxBytes = MAX_AGENT_TEXT_BYTES) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > maxBytes;
    const requestedBytes = Math.min(bytesRead, maxBytes);
    const safeBytes = truncated ? completeUtf8PrefixLength(buffer, requestedBytes) : requestedBytes;
    const text = buffer.subarray(0, safeBytes).toString("utf8");
    return { text: truncated ? `${text}${TRUNCATED}` : text, truncated, bytesRead };
  } finally {
    await handle.close();
  }
}
