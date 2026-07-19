import test from "node:test";
import assert from "node:assert/strict";
import {
  CURRENT_SESSION_SCHEMA_VERSION,
  migrateSessionDocument,
  validateSessionDocument,
} from "../../server/session-schema.js";

test("session migrations are ordered and preserve unknown safe metadata", () => {
  const legacy = {
    id: "legacy-session",
    title: "Legacy",
    status: "idle",
    mode: "collaboration",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    messages: [],
    decisions: [],
    settings: {},
    openPoints: ["legacy compatibility"],
    customMetadata: { preserved: true },
  };
  const result = migrateSessionDocument(legacy, legacy.id);
  assert.equal(result.fromVersion, 0);
  assert.equal(result.session.sessionSchemaVersion, CURRENT_SESSION_SCHEMA_VERSION);
  assert.deepEqual(result.session.openPoints, legacy.openPoints);
  assert.deepEqual(result.session.customMetadata, legacy.customMetadata);
  assert.equal(result.session.activeRun, null);
});

test("schema validation rejects a filename identity mismatch", () => {
  const session = migrateSessionDocument({
    id: "session-one",
    title: "Session",
    status: "idle",
    mode: "chat",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    messages: [],
    decisions: [],
    settings: {},
  }).session;
  assert.throws(
    () => validateSessionDocument(session, "session-two"),
    (error) => error.code === "invalid_session_schema",
  );
});
