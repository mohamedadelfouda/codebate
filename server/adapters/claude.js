import { approvedProviderCommand, runProcess, validateOption, resolveAllowedCommand } from "../process.js";
import { redact } from "../logger.js";
import { CappedText, agentTimeoutMs } from "../output-limits.js";
import { claudeMcpLaunch } from "../mcp-config.js";
import { buildUsage } from "../usage.js";

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item.text === "string") return item.text;
    if (item && typeof item.content === "string") return item.content;
    return "";
  }).join("");
}

function parseClaudeLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

export function createClaudeStreamCollector(onEvent, maxOutputBytes) {
  let sessionId = null;
  let resultError = null;
  let usage = null;
  const finalText = new CappedText(maxOutputBytes);
  const streamedText = new CappedText(maxOutputBytes);
  return {
    onStdoutLine(line) {
      const event = parseClaudeLine(line);
      if (!event) {
        if (line.trim()) onEvent?.({ kind: "activity", text: "Claude emitted an unreadable event" });
        return;
      }
      sessionId ||= event.session_id || event.sessionId || event.message?.session_id || null;
      if (event.type === "result") {
        if (event.usage || Number.isFinite(event.total_cost_usd)) usage = { raw: event.usage || {}, costUsd: event.total_cost_usd };
        if (event.is_error) resultError = typeof event.result === "string" ? event.result : "Claude reported an error";
        else if (typeof event.result === "string") finalText.replace(event.result);
        return;
      }
      const delta = event.delta?.text || event.content_block_delta?.delta?.text || event.message?.delta?.text;
      if (typeof delta === "string" && delta) {
        streamedText.append(delta);
        onEvent?.({ kind: "delta", text: delta });
        return;
      }
      const messageText = contentText(event.message?.content || event.content);
      if (messageText) finalText.replace(messageText);
      const type = String(event.type || "");
      if (type.includes("error")) onEvent?.({ kind: "error", text: event.error?.message || event.message || type });
      else if (type) onEvent?.({ kind: "activity", text: type });
    },
    snapshot() {
      return {
        sessionId,
        resultError,
        usage,
        finalText: finalText.toString(),
        streamedText: streamedText.toString(),
        outputTruncated: finalText.truncated || streamedText.truncated,
      };
    },
  };
}

export function claudePermissionArgs(permission = "read") {
  if (permission === "chat") {
    return ["--permission-mode", "auto", "--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch", "--disallowedTools", "Bash,Edit,Write,NotebookEdit,Read,Grep,Glob,Task"];
  }
  if (permission === "project") {
    return ["--permission-mode", "auto", "--tools", "", "--allowedTools", "mcp__codebate__project__list_directory,mcp__codebate__project__read_file", "--disallowedTools", "Bash,Edit,Write,NotebookEdit,Read,Grep,Glob,WebSearch,WebFetch,Task"];
  }
  if (permission === "connectors") {
    return ["--permission-mode", "auto", "--tools", "", "--allowedTools", "mcp__codebate__connector__*", "--disallowedTools", "Bash,Edit,Write,NotebookEdit,Read,Grep,Glob,WebSearch,WebFetch,Task"];
  }
  return ["--tools", "", "--disallowedTools", "*"];
}

export async function runClaude({ prompt, config, cwd, onEvent, registerChild }) {
  const model = validateOption(config.model || "sonnet", "Claude model", { allowEmpty: false });
  const effort = validateOption(config.effort || "high", "Claude effort", { allowEmpty: false });
  if (!new Set(["low", "medium", "high", "xhigh", "max"]).has(effort)) {
    throw new Error(`Unsupported Claude effort: ${effort}`);
  }

  // Restrict the client-supplied command to a trusted native Claude executable on the path
  // that actually spawns the agent, not only on diagnostic endpoints.
  const trustedCommand = process.env.CODEBATE_CLAUDE_COMMAND || "";
  const requestedCommand = config.command || trustedCommand || "claude";
  const command = await resolveAllowedCommand(requestedCommand, new Set(["claude"]), { trustedPaths: [trustedCommand, approvedProviderCommand("claude")] });

  // Permission level controls what the agent may do. Claude exposes collaboration,
  // web-only chat, connector proposals, and brokered read-only project review; it
  // does not expose an execution permission.
  // "chat" is web-only. It never combines untrusted web content with host-file tools.
  // Project reads use only the host-brokered, canonical-path MCP tools in "project" mode.
  // --allowedTools only pre-approves; it does not restrict availability. --tools is the
  // exact built-in surface, while deny rules remain as defense in depth. MCP tools are
  // supplied separately by Codebate's strict per-run MCP configuration.
  const permission = config.permission || "read";
  const permArgs = claudePermissionArgs(permission);
  const mcp = claudeMcpLaunch(config.mcpSessionId || config.connectorSessionId, permission === "project" ? "project" : permission === "connectors" ? "connectors" : "");
  const args = [
    "-p",
    "--model", model,
    "--effort", effort,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--no-chrome",
    ...mcp.args,
    ...permArgs,
    "Use the complete task supplied through standard input. Return only your response for the shared session.",
  ];

  const collector = createClaudeStreamCollector(onEvent, config.maxOutputBytes);
  const startedAt = Date.now();
  let result;
  try {
    result = await runProcess({
      command,
      args,
      input: prompt,
      cwd,
      envPolicy: "agent",
      timeoutMs: agentTimeoutMs(config.timeoutMs),
      maxOutputBytes: config.maxOutputBytes,
      containTree: true,
      registerChild,
      onStdoutLine: collector.onStdoutLine,
      onStderrLine(line) {
        if (line.trim()) onEvent?.({ kind: "stderr", text: line.slice(0, 500) });
      },
    });
  } finally {
    mcp.release();
  }

  const durationMs = Date.now() - startedAt;
  const output = collector.snapshot();
  const firstLine = (text) => String(text || "").split(/\r?\n/).find((l) => l.trim()) || "";
  const usage = output.usage
    ? buildUsage("claude", {
        inputTokens: output.usage.raw.input_tokens,
        cachedInputTokens: output.usage.raw.cache_read_input_tokens,
        cacheWriteTokens: output.usage.raw.cache_creation_input_tokens,
        outputTokens: output.usage.raw.output_tokens,
        costUsd: output.usage.costUsd,
      })
    : null;
  const meta = { model, effort, exitCode: result.code, durationMs, usage };

  if (result.code !== 0 || output.resultError) {
    const message = output.resultError || firstLine(result.stderr) || `Claude exited with code ${result.code}`;
    const error = new Error(message);
    // Only the visible text stream is kept as partial — never thinking/reasoning.
    error.partial = String(output.streamedText || output.finalText).trim();
    error.outputTruncated = output.outputTruncated || result.stdoutTruncated;
    // Technical details = exit code + tail of stderr, redacted. Never raw stdout (it carries thinking).
    error.technical = redact([`exitCode=${result.code}`, (result.stderr || "").trim().split(/\r?\n/).slice(-8).join("\n")].filter(Boolean).join("\n")).slice(0, 4000);
    Object.assign(error, meta);
    throw error;
  }
  // No raw-stdout fallback: use only parsed final text or the visible delta stream. Raw
  // stdout is the JSON event stream (can carry thinking) — never surface it as the answer.
  const text = String(output.finalText || output.streamedText).trim();
  if (!text) {
    const error = new Error("Claude completed without a final response");
    Object.assign(error, meta);
    throw error;
  }
  return { text, sessionId: output.sessionId, outputTruncated: output.outputTruncated || result.stdoutTruncated, ...meta };
}
