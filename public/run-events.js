const RUN_EVENT_TYPES = new Set([
  "run_started",
  "agent_start",
  "agent_activity",
  "agent_complete",
  "run_complete",
  "run_error",
  "run_stopped",
]);

export function shouldHandleRunEvent(currentRunId, event) {
  if (!RUN_EVENT_TYPES.has(event?.type)) return true;
  if (event.type === "run_started") {
    const validRunId = typeof event.runId === "string" && event.runId.length > 0;
    return validRunId && (!currentRunId || event.runId === currentRunId);
  }
  return Boolean(currentRunId) && event.runId === currentRunId;
}
