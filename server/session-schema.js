export const CURRENT_SESSION_SCHEMA_VERSION = 2;

function schemaError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function legacyToVersion1(legacy) {
  const fallbackTime = legacy.updatedAt || legacy.createdAt || "1970-01-01T00:00:00.000Z";
  return {
    ...legacy,
    sessionSchemaVersion: 1,
    title: legacy.title === undefined ? "Recovered session" : legacy.title,
    status: legacy.status === undefined ? "idle" : legacy.status,
    mode: legacy.mode === undefined ? "collaboration" : legacy.mode,
    createdAt: legacy.createdAt === undefined ? fallbackTime : legacy.createdAt,
    updatedAt: legacy.updatedAt === undefined ? fallbackTime : legacy.updatedAt,
    messages: legacy.messages === undefined ? [] : legacy.messages,
    decisions: legacy.decisions === undefined ? [] : legacy.decisions,
    settings: legacy.settings === undefined ? {} : legacy.settings,
  };
}

function version1ToVersion2(version1) {
  return {
    ...version1,
    sessionSchemaVersion: 2,
    activeRun: version1.activeRun === undefined ? null : version1.activeRun,
  };
}

const MIGRATIONS = new Map([
  [0, legacyToVersion1],
  [1, version1ToVersion2],
]);

export function validateSessionDocument(session, expectedId = "") {
  if (!isRecord(session)) throw schemaError("invalid_session_schema", "Session must be an object");
  if (session.sessionSchemaVersion !== CURRENT_SESSION_SCHEMA_VERSION) {
    throw schemaError("invalid_session_schema", "Session schema version is not current");
  }
  if (typeof session.id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(session.id)) {
    throw schemaError("invalid_session_schema", "Session id is invalid");
  }
  if (expectedId && session.id !== expectedId) {
    throw schemaError("invalid_session_schema", "Session id does not match its filename");
  }
  for (const field of ["title", "status", "mode", "createdAt", "updatedAt"]) {
    if (typeof session[field] !== "string") throw schemaError("invalid_session_schema", `Session ${field} must be a string`);
  }
  if (!Array.isArray(session.messages)) throw schemaError("invalid_session_schema", "Session messages must be an array");
  if (!Array.isArray(session.decisions)) throw schemaError("invalid_session_schema", "Session decisions must be an array");
  if (!isRecord(session.settings)) throw schemaError("invalid_session_schema", "Session settings must be an object");
  if (session.activeRun !== null && session.activeRun !== undefined) {
    if (!isRecord(session.activeRun) || typeof session.activeRun.runId !== "string" || typeof session.activeRun.status !== "string") {
      throw schemaError("invalid_session_schema", "Session activeRun is invalid");
    }
  }
  return session;
}

export function migrateSessionDocument(source, expectedId = "") {
  if (!isRecord(source)) throw schemaError("invalid_session_schema", "Session must be an object");
  const rawVersion = source.sessionSchemaVersion;
  const initialVersion = rawVersion === undefined ? 0 : rawVersion;
  if (!Number.isInteger(initialVersion) || initialVersion < 0) {
    throw schemaError("invalid_session_schema", "Session schema version is invalid");
  }
  if (initialVersion > CURRENT_SESSION_SCHEMA_VERSION) {
    throw schemaError("unsupported_session_schema", "Session was created by a newer Codebate version");
  }

  let version = initialVersion;
  let session = structuredClone(source);
  while (version < CURRENT_SESSION_SCHEMA_VERSION) {
    const migrate = MIGRATIONS.get(version);
    if (!migrate) throw schemaError("unsupported_session_schema", `No migration exists for session schema ${version}`);
    session = migrate(session);
    version = session.sessionSchemaVersion;
  }
  validateSessionDocument(session, expectedId);
  return { session, migrated: initialVersion !== CURRENT_SESSION_SCHEMA_VERSION, fromVersion: initialVersion };
}
