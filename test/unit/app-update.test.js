import test from "node:test";
import assert from "node:assert/strict";
import { APP_VERSION, checkAppUpdate, fetchLatestFromNpm } from "../../server/app-update.js";

test("APP_VERSION is read from package.json as a semver", () => {
  assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
});

test("checkAppUpdate performs no network and reports not-checked without an injected fetcher", async () => {
  const r = await checkAppUpdate({ currentVersion: "1.0.0" });
  assert.deepEqual(r, { current: "1.0.0", latest: null, updateAvailable: false, checked: false, checkFailed: false });
});

test("checkAppUpdate flags a newer release and ignores an equal/older one", async () => {
  const newer = await checkAppUpdate({ currentVersion: "1.0.0", fetchLatest: async () => "1.2.0" });
  assert.equal(newer.updateAvailable, true);
  assert.equal(newer.latest, "1.2.0");
  assert.equal(newer.checked, true);
  assert.equal((await checkAppUpdate({ currentVersion: "1.2.0", fetchLatest: async () => "1.2.0" })).updateAvailable, false);
  assert.equal((await checkAppUpdate({ currentVersion: "1.2.0", fetchLatest: async () => "1.1.9" })).updateAvailable, false);
});

test("checkAppUpdate stays silent when there is no release yet (null)", async () => {
  const r = await checkAppUpdate({ currentVersion: "1.0.0", fetchLatest: async () => null });
  assert.equal(r.checked, true);
  assert.equal(r.updateAvailable, false);
  assert.equal(r.checkFailed, false);
});

test("checkAppUpdate fails soft (never a wrong 'up to date') when the fetch throws", async () => {
  const r = await checkAppUpdate({ currentVersion: "1.0.0", fetchLatest: async () => { throw new Error("offline"); } });
  assert.equal(r.checkFailed, true);
  assert.equal(r.updateAvailable, false);
});

test("fetchLatestFromNpm parses the registry version, 404s to null, and throws on other errors (G1)", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ version: "2.3.4" }), { status: 200 });
    assert.equal(await fetchLatestFromNpm(), "2.3.4");
    globalThis.fetch = async () => new Response("", { status: 404 }); // not published
    assert.equal(await fetchLatestFromNpm(), null);
    globalThis.fetch = async () => new Response("", { status: 500 });
    await assert.rejects(() => fetchLatestFromNpm(), /npm responded 500/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
