import crypto from "node:crypto";

const TERMINAL_STATUSES = new Set(["completed", "error", "stopped", "interrupted"]);

export function createRunAttempt(mode) {
  return {
    runId: crypto.randomUUID(),
    mode,
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    interruptionReason: "",
    children: new Set(),
    pending: new Set(),
  };
}

export function runAcceptsOutput(currentAttempt, attempt) {
  return currentAttempt === attempt && attempt.status === "running";
}

export function runInactiveError(attempt) {
  const stopped = attempt.status === "cancelling" || attempt.status === "stopped";
  const error = new Error(stopped ? "Run stopped by user" : "Run is no longer active");
  error.runInactive = true;
  return error;
}

export function assertRunAcceptsOutput(currentAttempt, attempt) {
  if (!runAcceptsOutput(currentAttempt, attempt)) throw runInactiveError(attempt);
}

export function requestRunCancellation(attempt) {
  if (attempt.status !== "running") return false;
  attempt.status = "cancelling";
  return true;
}

export function requestRunFailure(attempt) {
  if (attempt.status !== "running") return false;
  attempt.status = "failing";
  return true;
}

export function runWasCancelled(attempt) {
  return attempt.status === "cancelling" || attempt.status === "stopped";
}

export function claimRunTerminal(attempt, status, interruptionReason = "") {
  if (!TERMINAL_STATUSES.has(status)) throw new Error(`Invalid terminal run status: ${status}`);
  if (TERMINAL_STATUSES.has(attempt.status)) return false;
  attempt.status = status;
  attempt.endedAt = new Date().toISOString();
  attempt.interruptionReason = String(interruptionReason || "");
  return true;
}

export function runAttemptRecord(attempt) {
  const record = {
    runId: attempt.runId,
    mode: attempt.mode,
    status: attempt.status === "cancelling" || attempt.status === "failing" ? "running" : attempt.status,
    startedAt: attempt.startedAt,
  };
  if (attempt.endedAt) record.endedAt = attempt.endedAt;
  if (attempt.interruptionReason) record.interruptionReason = attempt.interruptionReason;
  return record;
}
