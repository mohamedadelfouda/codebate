const activities = new Map();

export function claimSessionActivity(sessionId, kind) {
  const id = String(sessionId || "");
  if (!id) throw new Error("Session id is required");
  if (activities.has(id)) {
    const error = new Error("Session is already busy");
    error.apiCode = "session_busy";
    error.apiStatus = 409;
    throw error;
  }
  const token = Symbol(kind);
  activities.set(id, { kind, token });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (activities.get(id)?.token === token) activities.delete(id);
  };
}

export function sessionActivity(sessionId) {
  return activities.get(String(sessionId || ""))?.kind || "";
}
