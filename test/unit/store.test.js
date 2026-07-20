import test from "node:test";
import assert from "node:assert/strict";
import { open, readFile, readdir, rm, stat, writeFile, utimes } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createSession,
  saveSession,
  getSession,
  addMessage,
  listSessions,
  listSessionRecoveries,
  exportSessionRecovery,
  retrySessionRecovery,
  deleteSessionRecovery,
  mutateSession,
  renameSession,
  deleteSession,
  SKIP_SESSION_WRITE,
  directoryFsyncErrorIsFatal,
} from "../../server/store.js";
import { CURRENT_SESSION_SCHEMA_VERSION } from "../../server/session-schema.js";

const sessionsDir = join(dirname(fileURLToPath(import.meta.url)), "../../data/sessions");
const backupsDir = join(dirname(fileURLToPath(import.meta.url)), "../../data/session-backups");
const cleanup = (id) => Promise.all([
  rm(join(sessionsDir, `${id}.json`), { force: true }),
  rm(join(sessionsDir, `${id}.summary.json`), { force: true }),
]).catch(() => {});

test("concurrent saves of one session store one complete payload — never torn or mixed", async () => {
  const s = await createSession("concurrency-test");
  try {
    // Each save carries a distinct, self-consistent messages array (length i).
    const expected = Array.from({ length: 60 }, (_, i) =>
      Array.from({ length: i }, (_, j) => ({ id: `${j}`, content: "x" })));
    await Promise.all(expected.map((messages) => saveSession({ ...s, messages })));
    const loaded = await getSession(s.id); // must parse — a torn write would throw here
    assert.equal(loaded.id, s.id);
    // The file must hold exactly ONE of the payloads intact — not a truncated or interleaved
    // mix of two writes. Matching by length pins it to a specific complete payload.
    assert.deepEqual(loaded.messages, expected[loaded.messages.length]);
  } finally {
    await cleanup(s.id);
  }
});

test("a durable session write is fsync'd for power-loss durability", async (t) => {
  // Round-trip tests can't catch a silently dropped fsync — spy on FileHandle.sync via its prototype and
  // confirm the durable transcript write actually syncs. (The best-effort directory fsync may also fire.)
  const probe = await open(join(sessionsDir, ".sync-probe.tmp"), "w");
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  await rm(join(sessionsDir, ".sync-probe.tmp"), { force: true });
  const realSync = proto.sync;
  let syncs = 0;
  t.mock.method(proto, "sync", async function spy(...args) { syncs += 1; return realSync.apply(this, args); });

  const s = await createSession("durability-fsync-test");
  syncs = 0; // measure only this save, not the create's own writes
  await saveSession(s);
  assert.ok(syncs >= 1, "the durable transcript write called fsync");
  await rm(join(sessionsDir, `${s.id}.json`), { force: true }).catch(() => {});
  await rm(join(sessionsDir, `${s.id}.summary.json`), { force: true }).catch(() => {});
});

test("directoryFsyncErrorIsFatal surfaces real I/O failures but tolerates unsupported-platform ones", () => {
  // Directory fsync isn't supported on Windows (syncing a dir handle throws EPERM — verified) or on some
  // network filesystems (EINVAL); those must stay best-effort or every durable write would fail there. A
  // real resource/I-O failure must surface so a caller never gets a false durability acknowledgement.
  for (const code of ["EPERM", "EINVAL", "ENOTSUP", "EISDIR", undefined]) {
    assert.equal(directoryFsyncErrorIsFatal({ code }), false, `tolerate ${code}`);
  }
  for (const code of ["ENOSPC", "EIO", "EMFILE", "ENFILE", "EDQUOT", "EROFS"]) {
    assert.equal(directoryFsyncErrorIsFatal({ code }), true, `surface ${code}`);
  }
});

test("concurrent addMessage calls on one session don't drop appends", async () => {
  const s = await createSession("addmessage-test");
  try {
    // Without serializing the load→append→save sequence, overlapping addMessage calls would
    // read the same state and clobber each other, losing messages.
    await Promise.all(Array.from({ length: 40 }, (_, i) => addMessage(s.id, { content: `m${i}` })));
    const loaded = await getSession(s.id);
    assert.equal(loaded.messages.length, 40);
    assert.equal(new Set(loaded.messages.map((m) => m.content)).size, 40); // all distinct, none lost
  } finally {
    await cleanup(s.id);
  }
});

test("a rejected conditional mutation performs no session write", async () => {
  const session = await createSession("skip-session-write");
  try {
    const mainPath = join(sessionsDir, `${session.id}.json`);
    const before = await readFile(mainPath, "utf8");
    const result = await mutateSession(session.id, () => SKIP_SESSION_WRITE);
    const after = await readFile(mainPath, "utf8");
    assert.equal(result, false);
    assert.equal(after, before);
  } finally {
    await cleanup(session.id);
  }
});

test("an unversioned session migrates only after its original source is backed up", async () => {
  const id = `legacy-${Date.now()}`;
  const mainPath = join(sessionsDir, `${id}.json`);
  const legacy = {
    id,
    title: "Legacy session",
    status: "idle",
    mode: "collaboration",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    messages: [],
    decisions: [],
    settings: {},
    connectorActions: [{ id: "connector-1", status: "completed" }],
    executions: [{ taskId: "execution-1", status: "merged", cleanupPending: false, cleanupCompletedAt: "2025-01-01T00:00:00.000Z" }],
  };
  const original = JSON.stringify(legacy, null, 2);
  await writeFile(mainPath, original, "utf8");

  try {
    const migrated = await getSession(id);
    assert.equal(migrated.sessionSchemaVersion, CURRENT_SESSION_SCHEMA_VERSION);
    assert.deepEqual(migrated.connectorActions, legacy.connectorActions);
    assert.deepEqual(migrated.executions, legacy.executions);
    const backups = (await readdir(backupsDir)).filter((name) => name.startsWith(`${id}.`));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(backupsDir, backups[0]), "utf8"), original);
  } finally {
    await cleanup(id);
    const backups = await readdir(backupsDir).catch(() => []);
    await Promise.all(backups.filter((name) => name.startsWith(`${id}.`)).map((name) => rm(join(backupsDir, name), { force: true })));
  }
});

test("a future session schema is rejected without rewriting its source", async () => {
  const id = `future-${Date.now()}`;
  const mainPath = join(sessionsDir, `${id}.json`);
  const original = JSON.stringify({ id, sessionSchemaVersion: CURRENT_SESSION_SCHEMA_VERSION + 1 }, null, 2);
  await writeFile(mainPath, original, "utf8");
  try {
    await assert.rejects(() => getSession(id), (error) => error.code === "unsupported_session_schema");
    assert.equal(await readFile(mainPath, "utf8"), original);
  } finally {
    await cleanup(id);
  }
});

test("malformed session JSON appears once as recoverable and its original can be exported", async () => {
  const id = `corrupt-${Date.now()}`;
  const fileName = `${id}.json`;
  const original = Buffer.from("{not valid json", "utf8");
  await writeFile(join(sessionsDir, fileName), original);
  let recovery;
  try {
    const first = await listSessions();
    const second = await listSessions();
    recovery = first.find((item) => item.recoveryNeeded && item.recoveryCategory === "invalid_json" && item.id.startsWith("recovery-"));
    assert.ok(recovery);
    assert.equal(second.filter((item) => item.recoveryId === recovery.recoveryId).length, 1);
    const records = (await listSessionRecoveries()).filter((record) => record.fileName === fileName);
    assert.equal(records.length, 1);
    const exported = await exportSessionRecovery(recovery.recoveryId);
    assert.deepEqual(await readFile(exported.sourcePath), original);
    await deleteSessionRecovery(recovery.recoveryId);
    await assert.rejects(() => stat(join(sessionsDir, fileName)), /ENOENT/);
  } finally {
    if (recovery) await deleteSessionRecovery(recovery.recoveryId).catch(() => {});
    await cleanup(id);
  }
});

test("concurrent recovery retry and delete produce one complete outcome", async () => {
  const id = `recovery-race-${Date.now()}`;
  const fileName = `${id}.json`;
  const sourcePath = join(sessionsDir, fileName);
  let recovery;
  try {
    await writeFile(sourcePath, "{damaged", "utf8");
    await listSessions();
    recovery = (await listSessionRecoveries()).find((record) => record.fileName === fileName);
    assert.ok(recovery);
    const now = new Date().toISOString();
    await writeFile(sourcePath, JSON.stringify({
      id, sessionSchemaVersion: CURRENT_SESSION_SCHEMA_VERSION, title: "Recovered",
      status: "idle", mode: "collaboration", createdAt: now, updatedAt: now,
      messages: [], decisions: [], settings: {}, activeRun: null,
    }), "utf8");

    const outcomes = await Promise.allSettled([
      retrySessionRecovery(recovery.recoveryId),
      deleteSessionRecovery(recovery.recoveryId),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);
  } finally {
    if (recovery) await deleteSessionRecovery(recovery.recoveryId).catch(() => {});
    await cleanup(id);
  }
});

test("session listing reads compact summaries instead of full transcript payloads", async () => {
  const session = await createSession("summary-index-test");
  try {
    const mainPath = join(sessionsDir, `${session.id}.json`);
    await writeFile(mainPath, "not valid JSON", "utf8");
    // Keep the cached summary newer than the deliberately damaged transcript.
    // A newer transcript must be parsed instead, so stale summaries cannot hide data.
    await utimes(mainPath, new Date(0), new Date(0));
    const summaries = await listSessions();
    assert.equal(summaries.find((item) => item.id === session.id)?.title, "summary-index-test");
  } finally { await cleanup(session.id); }
});

test("session listing treats equal summary and transcript mtimes as stale", async () => {
  const session = await createSession("equal-mtime-before");
  try {
    const mainPath = join(sessionsDir, `${session.id}.json`);
    const summaryPath = join(sessionsDir, `${session.id}.summary.json`);
    const stored = JSON.parse(await readFile(mainPath, "utf8"));
    stored.title = "equal-mtime-after";
    await writeFile(mainPath, JSON.stringify(stored, null, 2), "utf8");
    const sameTime = new Date("2020-01-01T00:00:00.000Z");
    await Promise.all([utimes(mainPath, sameTime, sameTime), utimes(summaryPath, sameTime, sameTime)]);

    const summaries = await listSessions();
    assert.equal(summaries.find((item) => item.id === session.id)?.title, "equal-mtime-after");
  } finally { await cleanup(session.id); }
});

test("session persistence enforces the 24 MiB UTF-8 hard limit", async () => {
  const session = await createSession("byte-budget-test");
  try {
    session.messages = Array.from({ length: 200 }, (_, index) => ({ id: String(index), content: "😀".repeat(50000) }));
    await saveSession(session);
    const info = await stat(join(sessionsDir, `${session.id}.json`));
    assert.ok(info.size <= 24 * 1024 * 1024, `stored session was ${info.size} bytes`);
  } finally { await cleanup(session.id); }
});

test("control repair audit metadata survives a session persistence round trip", async () => {
  const session = await createSession("control-repair-persistence");
  const controlRepair = {
    attempted: true,
    count: 1,
    status: "succeeded",
    errorCodes: ["unaddressed_open_item"],
    durationMs: 7,
    outputTruncated: false,
    originalControl: { truncated: false, value: { valid: true, itemProposals: [] } },
    repairedControl: {
      truncated: false,
      value: { valid: true, itemProposals: [{ action: "resolve", itemId: "item-001" }] },
    },
  };
  const controlRepairStats = {
    attemptedCalls: 1,
    succeededCalls: 1,
    failedCalls: 0,
    totalDurationMs: 7,
    errorCodeCounts: { unaddressed_open_item: 1 },
  };
  try {
    session.messages.push(
      { id: "agent", content: "answer", meta: { controlRepair } },
      { id: "outcome", content: "done", meta: { outcome: { controlRepairStats } } },
    );
    await saveSession(session);
    const loaded = await getSession(session.id);
    assert.deepEqual(loaded.messages[0].meta.controlRepair, controlRepair);
    assert.deepEqual(loaded.messages[1].meta.outcome.controlRepairStats, controlRepairStats);
  } finally {
    await cleanup(session.id);
  }
});

test("history retention never drops a terminal execution whose cleanup is pending", async () => {
  const session = await createSession("cleanup-retention-test");
  try {
    const completedAt = new Date().toISOString();
    session.executions = [
      { taskId: "pending-cleanup", status: "merged", cleanupPending: true, worktree: { path: "pending", branch: "agent/codex/pending" } },
      ...Array.from({ length: 60 }, (_, index) => ({ taskId: `clean-${index}`, status: "merged", cleanupPending: false, cleanupCompletedAt: completedAt })),
    ];
    await saveSession(session);
    const saved = await getSession(session.id);
    assert.ok(saved.executions.some((record) => record.taskId === "pending-cleanup"));
    assert.equal(saved.executions.filter((record) => record.taskId.startsWith("clean-")).length, 50);
  } finally { await cleanup(session.id); }
});
test('renameSession updates title and keeps the same id', async () => {
  const session = await createSession('rename-before');
  try {
    const renamed = await renameSession(session.id, 'rename-after');
    assert.equal(renamed.id, session.id);
    assert.equal(renamed.title, 'rename-after');
    const loaded = await getSession(session.id);
    assert.equal(loaded.id, session.id);
    assert.equal(loaded.title, 'rename-after');
    const listed = await listSessions();
    assert.equal(listed.find((item) => item.id === session.id)?.title, 'rename-after');
  } finally {
    await cleanup(session.id);
  }
});

test('renameSession rejects an empty or whitespace-only title', async () => {
  const session = await createSession('rename-guard');
  try {
    for (const blank of ['', '   ', '\n\t']) {
      await assert.rejects(() => renameSession(session.id, blank), (error) => error.code === 'title_required');
    }
    const loaded = await getSession(session.id);
    assert.equal(loaded.title, 'rename-guard');
  } finally {
    await cleanup(session.id);
  }
});

test('createSession applies the "New session" fallback after trimming a blank title', async () => {
  // A whitespace-only title used to trim down to "" and ship as an empty title; the fallback is now applied
  // after the trim (mirrors renameSession's guard). A real title with surrounding whitespace is still trimmed
  // rather than replaced.
  const blank = await createSession('   ');
  const empty = await createSession('');
  const real = await createSession('  My session  ');
  try {
    assert.equal(blank.title, 'New session');
    assert.equal(empty.title, 'New session');
    assert.equal(real.title, 'My session');
  } finally {
    await Promise.all([cleanup(blank.id), cleanup(empty.id), cleanup(real.id)]);
  }
});

test('renameSession truncates a title past the 160-code-point limit without splitting a surrogate pair', async () => {
  const session = await createSession('rename-long');
  try {
    const emoji = '\u{1F600}'; // a surrogate pair — must never be split by truncation
    const longTitle = 'x'.repeat(159) + emoji + 'y'.repeat(10);
    const renamed = await renameSession(session.id, longTitle);
    assert.equal([...renamed.title].length, 160);
    assert.equal(renamed.title, 'x'.repeat(159) + emoji);
    assert.ok(!renamed.title.includes('�'), 'no unpaired-surrogate replacement character');
  } finally {
    await cleanup(session.id);
  }
});

test('deleteSession removes transcript and summary without breaking listSessions', async () => {
  const session = await createSession('delete-me');
  try {
    await saveSession(session); // ensure the sidecar .summary.json actually exists before deleting
    const summaryFile = join(sessionsDir, `${session.id}.summary.json`);
    await stat(summaryFile); // sanity check: the summary was created
    await deleteSession(session.id);
    await assert.rejects(() => getSession(session.id), /ENOENT|no such file/i);
    await assert.rejects(() => stat(summaryFile), /ENOENT/);
    const listed = await listSessions();
    assert.equal(listed.find((item) => item.id === session.id), undefined);
  } finally {
    await cleanup(session.id);
  }
});

test('deleteSession refuses sessions with recoverable executions', async () => {
  const session = await createSession('delete-blocked');
  try {
    session.executions = [{ taskId: 'open', status: 'awaiting_decision', cleanupPending: true }];
    await saveSession(session);
    await assert.rejects(() => deleteSession(session.id), (error) => error.code === 'pending_execution_decisions');
    const loaded = await getSession(session.id);
    assert.equal(loaded.id, session.id);
  } finally {
    await cleanup(session.id);
  }
});

for (const activeStatus of ['pending', 'executing_unknown']) {
  test(`deleteSession refuses sessions with a connector action in status "${activeStatus}"`, async () => {
    const session = await createSession(`delete-blocked-connector-${activeStatus}`);
    try {
      session.connectorActions = [{ id: 'a1', connector: 'gmail', action: 'send_message', status: activeStatus }];
      await saveSession(session);
      await assert.rejects(() => deleteSession(session.id), (error) => error.code === 'pending_connector_actions');
      const loaded = await getSession(session.id);
      assert.equal(loaded.id, session.id);
    } finally {
      await cleanup(session.id);
    }
  });
}

test('deleteSession allows sessions whose connector actions are all terminal', async () => {
  const session = await createSession('delete-ok-connector');
  try {
    session.connectorActions = [{ id: 'a1', connector: 'gmail', action: 'send_message', status: 'completed' }];
    await saveSession(session);
    await deleteSession(session.id);
    await assert.rejects(() => getSession(session.id), /ENOENT|no such file/i);
  } finally {
    await cleanup(session.id);
  }
});
