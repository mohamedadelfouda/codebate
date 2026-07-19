import test from "node:test";
import assert from "node:assert/strict";
import { createLatestRequest } from "../../public/latest-request.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("a late session response cannot replace the newest selected session", async () => {
  const pending = new Map();
  const requests = createLatestRequest((id) => {
    const item = deferred();
    pending.set(id, item);
    return item.promise;
  });

  const first = requests.run("session-a");
  const second = requests.run("session-b");
  pending.get("session-b").resolve({ id: "session-b" });
  assert.deepEqual(await second, { current: true, key: "session-b", value: { id: "session-b" } });
  pending.get("session-a").resolve({ id: "session-a" });
  assert.deepEqual(await first, { current: false, key: "session-a" });
});

test("a stale rejected request is ignored after a newer request starts", async () => {
  const pending = [];
  const requests = createLatestRequest(() => {
    const item = deferred();
    pending.push(item);
    return item.promise;
  });

  const stale = requests.run("session-a");
  const current = requests.run("session-b");
  pending[0].reject(new Error("stale failure"));
  assert.deepEqual(await stale, { current: false, key: "session-a" });
  pending[1].resolve("newest");
  assert.deepEqual(await current, { current: true, key: "session-b", value: "newest" });
});

test("invalidating an in-flight request prevents it from becoming current", async () => {
  const item = deferred();
  const requests = createLatestRequest(() => item.promise);
  const pending = requests.run("session-a");
  requests.invalidate();
  item.resolve({ id: "session-a" });
  assert.deepEqual(await pending, { current: false, key: "session-a" });
});
