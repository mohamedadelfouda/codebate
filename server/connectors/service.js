import crypto from "node:crypto";
import { getSession, listSessions, mutateSession, SKIP_SESSION_WRITE } from "../store.js";
import { connector, executeConnectorAction } from "./registry.js";
import { recordDecision } from "../decisions.js";
import { logError, redact } from "../logger.js";
import { expectedApiError } from "../api-errors.js";

const CREDENTIAL_FIELD_PARTS = new Set(["auth", "authorization", "credential", "credentials", "key", "password", "secret", "token"]);
const OMITTED_AUDIT_FIELDS = new Set(["body", "content", "html", "message", "raw", "text"]);

function connectorError(code, message, status) {
  return expectedApiError(code, message, status);
}

function credentialField(name) {
  const separated = String(name).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  const parts = separated.split(/[^a-z0-9]+/);
  return parts.some((part) => CREDENTIAL_FIELD_PARTS.has(part))
    || /^(?:access|api|client|private|refresh|service)(?:key|secret|token)$/.test(parts.join(""));
}

function safeStructuredResult(result, fieldName = "") {
  if (fieldName && credentialField(fieldName)) return "<redacted>";
  if (typeof result === "string") return redact(result);
  if (Array.isArray(result)) return result.map((entry) => safeStructuredResult(entry));
  if (result && typeof result === "object") {
    return Object.fromEntries(Object.entries(result).map(([key, entry]) => [key, safeStructuredResult(entry, key)]));
  }
  return result;
}

function safeStoredResult(result, maxChars = 100000) {
  return (JSON.stringify(safeStructuredResult(result)) ?? "null").slice(0, maxChars);
}

function auditInputSummary(value, fieldName = "", depth = 0) {
  if (fieldName && credentialField(fieldName)) return "<redacted>";
  if (fieldName && OMITTED_AUDIT_FIELDS.has(fieldName.toLowerCase())) {
    let serialized;
    try { serialized = typeof value === "string" ? value : JSON.stringify(value); }
    catch { serialized = ""; }
    return `<omitted:${Buffer.byteLength(serialized ?? "", "utf8")}>`;
  }
  if (depth > 5) return "<omitted:depth>";
  if (typeof value === "string") {
    return redact(value).slice(0, 500);
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => auditInputSummary(entry, "", depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, entry]) => [key, auditInputSummary(entry, key, depth + 1)]));
  }
  return value;
}

function enabledConnector(session, connectorId) {
  const definition = connector(connectorId);
  if (!definition) throw connectorError("invalid_connector", "Unknown connector", 400);
  if (session.connectors?.[definition.id]?.enabled !== true) throw connectorError("connector_disabled", `${definition.label} connector is not enabled for this session`, 409);
  if (session.project?.path && session.project.trusted !== true) throw connectorError("connector_project_untrusted", "Connectors stay disabled while the attached project is untrusted", 409);
  return definition;
}

export async function setConnectorEnabled(sessionId, connectorId, enabled) {
  const definition = connector(connectorId);
  if (!definition) throw connectorError("invalid_connector", "Unknown connector", 400);
  return mutateSession(sessionId, (session) => {
    session.connectors ||= {};
    session.connectors[definition.id] = { enabled: enabled === true, changedAt: new Date().toISOString() };
    recordDecision(session, { type: "connector", outcome: enabled === true ? "enabled" : "disabled", metadata: { connector: definition.id } });
    return structuredClone(session.connectors[definition.id]);
  });
}

export async function requestConnectorAction(sessionId, connectorId, actionId, input = {}) {
  let serializedInput;
  try { serializedInput = JSON.stringify(input); }
  catch { throw connectorError("invalid_connector_input", "Connector input must be JSON serializable", 400); }
  if (serializedInput === undefined) throw connectorError("invalid_connector_input", "Connector input must be a JSON value", 400);
  if (Buffer.byteLength(serializedInput, "utf8") > 65536) throw connectorError("connector_input_too_large", "Connector input exceeds the 64 KiB approval limit", 400);
  const session = await getSession(sessionId);
  const definition = enabledConnector(session, connectorId);
  const canonicalConnectorId = definition.id;
  if (!Object.hasOwn(definition.actions, actionId)) throw connectorError("connector_action_not_found", "Unknown connector action", 404);
  const action = definition.actions[actionId];
  if (!action.stateChanging) {
    const audit = {
      id: crypto.randomUUID(), sessionId, connector: canonicalConnectorId, action: actionId,
      status: "running", requestedAt: new Date().toISOString(), inputSummary: auditInputSummary(input),
    };
    await mutateSession(sessionId, (latest) => {
      enabledConnector(latest, canonicalConnectorId);
      latest.connectorReadAudits ||= [];
      latest.connectorReadAudits.push(audit);
    });
    try {
      const result = await executeConnectorAction(canonicalConnectorId, actionId, input);
      await mutateSession(sessionId, (latest) => {
        const record = latest.connectorReadAudits?.find((item) => item.id === audit.id);
        if (record) Object.assign(record, { status: "completed", completedAt: new Date().toISOString() });
      });
      return { status: "completed", auditId: audit.id, result: safeStructuredResult(result) };
    } catch (error) {
      try {
        await mutateSession(sessionId, (latest) => {
          const record = latest.connectorReadAudits?.find((item) => item.id === audit.id);
          if (record) Object.assign(record, {
            status: "failed", completedAt: new Date().toISOString(),
            errorCode: error?.apiCode || "connector_dependency_unavailable",
          });
        });
      } catch (stateError) {
        logError("connector read audit failure could not be saved", stateError.message);
      }
      throw error;
    }
  }
  return mutateSession(sessionId, (latest) => {
    enabledConnector(latest, canonicalConnectorId);
    latest.connectorActions ||= [];
    if (latest.connectorActions.filter((item) => ["pending", "executing_unknown"].includes(item.status)).length >= 50) {
      throw connectorError("connector_proposal_limit", "Resolve existing connector proposals before creating more", 409);
    }
    const proposal = {
      id: crypto.randomUUID(), connector: canonicalConnectorId, action: actionId, input: structuredClone(input),
      status: "pending", createdAt: new Date().toISOString(),
    };
    latest.connectorActions.push(proposal);
    return structuredClone(proposal);
  });
}

// A read-connector audit is written "running", then flipped to "completed"/"failed" once the read
// settles. A crash in between leaves it stuck "running" forever. At startup, settle any such orphan to
// "interrupted" (not "failed" — the read didn't fail, its outcome is just unknown) with a restart reason;
// a read has no side effects, so the user can simply re-read. Mirrors reconcileInterruptedRuns /
// reconcileExecutionWorktrees (called together at startup), including their skip of unmutatable summaries.
export async function reconcileInterruptedReadAudits(reason = "server_restart") {
  const summaries = await listSessions();
  let recovered = 0;
  for (const summary of summaries) {
    if (summary.recoveryNeeded) continue; // synthetic recovery placeholder — no session file to mutate
    try {
      const settled = await mutateSession(summary.id, (latest) => {
        const audits = latest.connectorReadAudits;
        if (!Array.isArray(audits) || !audits.some((audit) => audit.status === "running")) return SKIP_SESSION_WRITE;
        const now = new Date().toISOString();
        for (const audit of audits) {
          if (audit.status === "running") {
            Object.assign(audit, { status: "interrupted", completedAt: now, interruptionReason: reason });
          }
        }
        return true;
      });
      if (settled) recovered += 1;
    } catch (error) {
      logError(`connector read audit reconciliation failed for ${summary.id}`, redact(error?.message || String(error)));
    }
  }
  return recovered;
}

export async function decideConnectorAction(sessionId, actionId, approve) {
  if (approve !== true && approve !== false) throw connectorError("invalid_connector_decision", "Connector approval must be a boolean", 400);
  const claim = await mutateSession(sessionId, (session) => {
    const proposal = (session.connectorActions || []).find((item) => item.id === actionId);
    if (!proposal) throw connectorError("connector_action_not_found", "Connector action not found", 404);
    if (proposal.status !== "pending") throw connectorError("connector_action_already_decided", `Connector action is already ${proposal.status}`, 409);
    enabledConnector(session, proposal.connector);
    proposal.decidedAt = new Date().toISOString();
    if (approve !== true) {
      proposal.status = "rejected";
      recordDecision(session, { type: "connector_action", outcome: "rejected", taskId: proposal.id, metadata: { connector: proposal.connector, action: proposal.action } });
      return { rejected: true, proposal: structuredClone(proposal) };
    }
    // Claim exactly once before releasing the session lock. A crash during the external
    // call leaves executing_unknown, which is intentionally never retried automatically.
    proposal.status = "executing_unknown";
    recordDecision(session, { type: "connector_action", outcome: "approved", taskId: proposal.id, metadata: { connector: proposal.connector, action: proposal.action } });
    return {
      rejected: false,
      execution: { connector: proposal.connector, action: proposal.action, input: structuredClone(proposal.input) },
    };
  });
  if (claim.rejected) return claim.proposal;

  async function finish(update) {
    return mutateSession(sessionId, (session) => {
      const proposal = (session.connectorActions || []).find((item) => item.id === actionId);
      if (!proposal) throw new Error("Connector action disappeared while it was executing");
      if (proposal.status !== "executing_unknown") throw new Error(`Connector action changed to ${proposal.status} while it was executing`);
      Object.assign(proposal, update);
      return structuredClone(proposal);
    });
  }

  let result;
  try {
    result = await executeConnectorAction(claim.execution.connector, claim.execution.action, claim.execution.input);
  } catch (error) {
    const primaryError = error instanceof Error ? error : new Error(String(error));
    try {
      await finish({
        status: "failed_after_approval",
        failedAt: new Date().toISOString(),
        error: redact(primaryError.message).slice(0, 2000),
      });
    } catch (stateError) {
      primaryError.stateUpdateError = redact(stateError.message);
      logError("connector failure state could not be saved", stateError.message);
    }
    throw primaryError;
  }
  return finish({
    status: "completed",
    completedAt: new Date().toISOString(),
    result: safeStoredResult(result),
  });
}
