import crypto from "node:crypto";

export function recordDecision(session, { type, outcome, reason = "", taskId = null, metadata = {} }) {
  session.decisions ||= [];
  const decision = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    type: String(type || "decision"),
    outcome: String(outcome || ""),
    reason: String(reason || ""),
    taskId,
    metadata,
  };
  session.decisions.push(decision);
  return decision;
}
