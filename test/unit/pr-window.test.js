import test from "node:test";
import assert from "node:assert/strict";
import { closeReservedPrWindow, openReservedPrWindow, reservePrWindow } from "../../public/pr-window.js";

test("PR acceptance reserves a browser window synchronously and removes its opener", () => {
  const reserved = { opener: {}, closed: false };
  const calls = [];
  const hostWindow = { open: (...args) => { calls.push(args); return reserved; } };

  assert.equal(reservePrWindow(hostWindow, "merge"), null);
  assert.equal(reservePrWindow(hostWindow, "pr"), reserved);
  assert.deepEqual(calls, [["about:blank", "_blank"]]);
  assert.equal(reserved.opener, null);
  assert.equal(reservePrWindow({ open: () => { throw new Error("blocked"); } }, "pr"), null);
});

test("a reserved PR window navigates after the asynchronous acceptance succeeds", () => {
  let navigated = "";
  const reserved = { closed: false, location: { replace: (url) => { navigated = url; } } };
  const hostWindow = { open: () => { throw new Error("fallback should not run"); } };

  assert.equal(openReservedPrWindow(hostWindow, reserved, "https://github.com/example/project/pull/1"), true);
  assert.equal(navigated, "https://github.com/example/project/pull/1");
});

test("PR window handling closes unused reservations and supports Electron's external fallback", () => {
  let closed = false;
  const reserved = { closed: false, close: () => { closed = true; } };
  const calls = [];
  const hostWindow = { open: (...args) => { calls.push(args); return null; } };

  assert.equal(openReservedPrWindow(hostWindow, null, "https://github.com/example/project/pull/2"), true);
  assert.deepEqual(calls, [["https://github.com/example/project/pull/2", "_blank", "noopener"]]);
  assert.equal(openReservedPrWindow(hostWindow, reserved, "javascript:alert(1)"), false);
  assert.equal(closed, true);
  closeReservedPrWindow(null);
});

test("PR window handling rejects non-canonical URLs and contains fallback launch errors", () => {
  const hostWindow = { open: () => { throw new Error("launch failed"); } };

  assert.equal(openReservedPrWindow(hostWindow, null, "https://user:secret@github.com/example/project/pull/3"), false);
  assert.equal(openReservedPrWindow(hostWindow, null, "https://example.com/example/project/pull/3"), false);
  assert.equal(openReservedPrWindow(hostWindow, null, "https://github.com/example/project/pull/3"), false);
});

test("PR window handling rejects non-default GitHub ports before launching", () => {
  let closed = false;
  const reserved = { closed: false, close: () => { closed = true; } };
  const calls = [];
  const hostWindow = { open: (...args) => { calls.push(args); return null; } };

  assert.equal(openReservedPrWindow(hostWindow, reserved, "https://github.com:444/example/project/pull/3"), false);
  assert.equal(closed, true);
  assert.deepEqual(calls, []);
});
