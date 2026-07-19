import { provider } from "./providers/registry.js";
import { stripAgentControl } from "./convergence.js";

// Render a session to shareable Markdown. Non-completed agent turns (partial / completed_recovered / error)
// are flagged so an interrupted or recovered reply is never presented as a normal, complete answer. Agent
// content is stripped of any <agent-control> machine block again here (defense-in-depth): the orchestrator
// already strips it before storing, but the export never re-emits the block even if some path stored it raw.
export function sessionMarkdown(session) {
  const out = [`# ${session.title}`, "", `- Status: ${session.status}`, `- Mode: ${session.mode}`, `- Updated: ${session.updatedAt}`, "", "---", ""];
  for (const message of session.messages ?? []) {
    const who = message.author === "user"
      ? "User"
      : message.author === "system"
        ? "System"
        : `${provider(message.agent)?.label || message.agent || "Agent"}${message.role ? ` — ${message.role}` : ""}`;
    const meta = message.meta || {};
    const flag = message.author === "agent" && meta.status && meta.status !== "completed"
      ? `\n\n> ⚠️ **${meta.status}**${message.round != null ? ` (round ${message.round})` : ""}${meta.providerWarning || meta.error ? ` — ${meta.providerWarning || meta.error}` : ""}`
      : "";
    const body = message.author === "agent" ? stripAgentControl(message.content || "") : String(message.content || "");
    out.push(`## ${who}`, "", `${body}${flag}`, "");
  }
  return out.join("\n");
}
