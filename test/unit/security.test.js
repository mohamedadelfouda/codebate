import test from "node:test";
import assert from "node:assert/strict";
import { hostAllowed, checkApiAuth, issueCookieHeader, __validTokenForTest } from "../../server/security.js";

const PORT = 3210;
const TOKEN = __validTokenForTest();
const cookie = `codebateToken=${TOKEN}`;
const localOrigin = `http://127.0.0.1:${PORT}`;

test("hostAllowed accepts loopback hosts (matching or no port)", () => {
  assert.ok(hostAllowed(`127.0.0.1:${PORT}`, PORT));
  assert.ok(hostAllowed(`localhost:${PORT}`, PORT));
  assert.ok(hostAllowed("127.0.0.1", PORT));
  assert.ok(hostAllowed(`[::1]:${PORT}`, PORT));
});

test("hostAllowed rejects non-loopback / wrong port / empty (DNS rebinding)", () => {
  assert.equal(hostAllowed("evil.example.com", PORT), false);
  assert.equal(hostAllowed(`evil.example.com:${PORT}`, PORT), false);
  assert.equal(hostAllowed("127.0.0.1:9999", PORT), false);
  assert.equal(hostAllowed("", PORT), false);
  assert.equal(hostAllowed(undefined, PORT), false);
});

test("checkApiAuth rejects a missing token with 401", () => {
  const r = checkApiAuth({ method: "GET", headers: {} }, PORT);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test("checkApiAuth accepts a valid token via cookie or header", () => {
  assert.ok(checkApiAuth({ method: "GET", headers: { cookie } }, PORT).ok);
  assert.ok(checkApiAuth({ method: "GET", headers: { "x-codebate-token": TOKEN } }, PORT).ok);
});

test("checkApiAuth rejects a wrong token with 401 (no crash on length mismatch)", () => {
  const r = checkApiAuth({ method: "GET", headers: { cookie: "codebateToken=deadbeef" } }, PORT);
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test("checkApiAuth rejects cross-origin writes with 403 (CSRF)", () => {
  const r = checkApiAuth({ method: "POST", headers: { cookie, origin: "http://evil.com" } }, PORT);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test("checkApiAuth allows same-origin writes and no-Origin GETs", () => {
  assert.ok(checkApiAuth({ method: "POST", headers: { cookie, origin: localOrigin } }, PORT).ok);
  assert.ok(checkApiAuth({ method: "GET", headers: { cookie } }, PORT).ok);
});

test("checkApiAuth rejects same-host different-port writes (cookie is port-agnostic)", () => {
  // A page on 127.0.0.1:80 serializes its Origin without a port; it must not pass.
  const r = checkApiAuth({ method: "POST", headers: { cookie, origin: "http://127.0.0.1" } }, PORT);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(checkApiAuth({ method: "POST", headers: { cookie, origin: "http://127.0.0.1:9999" } }, PORT).ok, false);
});

test("checkApiAuth rejects state-changing requests with NO Origin", () => {
  const r = checkApiAuth({ method: "POST", headers: { cookie } }, PORT); // valid cookie, no Origin
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test("checkApiAuth rejects a multi-byte token without throwing", () => {
  // 64 chars but 65 UTF-8 bytes — must fail closed, not crash timingSafeEqual.
  const multibyte = "a".repeat(63) + "é";
  assert.doesNotThrow(() => checkApiAuth({ method: "GET", headers: { cookie: `codebateToken=${multibyte}` } }, PORT));
  assert.equal(checkApiAuth({ method: "GET", headers: { cookie: `codebateToken=${multibyte}` } }, PORT).status, 401);
});

test("issueCookieHeader is HttpOnly + SameSite=Strict", () => {
  const c = issueCookieHeader();
  assert.match(c, /codebateToken=/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
});
