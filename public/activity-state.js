export function activityControls(active, kind = "orchestration") {
  const running = Boolean(active);
  const execution = running && kind === "execution";
  const orchestration = running && kind === "orchestration";
  return {
    mainStopDisabled: !orchestration,
    executionStopHidden: !execution,
    executionRunDisabled: running,
  };
}
