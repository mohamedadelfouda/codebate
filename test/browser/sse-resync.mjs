// P0-2 regression: when the live SSE stream drops and the browser auto-reconnects the EventSource,
// the client must re-sync from persisted state (loadSession) so a run that finished during the
// disconnect can't leave the UI stuck on "running". app.js loads as an ES module, so its internals
// aren't reachable from Runtime.evaluate; instead we assert the observable side effect — a reconnect
// fires a GET for this session — by ending the stream server-side (a real, deterministic drop that
// the browser then reconnects) and watching an instrumented window.fetch. Before the fix,
// source.onopen only flipped the connection indicator and never re-fetched, so no GET fired on
// reconnect (verified: the assertion below times out without the app.js change).
import assert from "node:assert/strict";
import { launchBrowserHarness, waitFor } from "./harness.mjs";

async function run() {
  const harness = await launchBrowserHarness();
  const { devtools, serverModule } = harness;
  try {
    await devtools.evaluate(`localStorage.setItem("codebate-onboarded", "1")`);
    await devtools.evaluate(`location.reload(); true`);
    await waitFor(() => devtools.evaluate(`document.readyState === "complete" && !document.getElementById("emptyState").hidden`));

    const sessionId = await devtools.evaluate(`(async () => {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "SSE resync test" }),
      });
      return (await response.json()).id;
    })()`);
    assert.match(sessionId, /[0-9a-f-]{10,}/i);

    await devtools.evaluate(`location.reload(); true`);
    await waitFor(() => devtools.evaluate(`Boolean(document.querySelector("#sessionList .session-item"))`), 20000);
    await devtools.evaluate(`document.querySelector("#sessionList .session-item").click()`);
    await waitFor(() => devtools.evaluate(`!document.getElementById("sessionView").hidden`));
    // Wait for the stream's initial open (connection indicator not in its "bad" state).
    await waitFor(() => devtools.evaluate(`!document.getElementById("serverStatus").classList.contains("is-bad")`));
    console.log("sse resync check: session open, stream connected");

    // Count only loadSession's GET from here on. app.js calls the bare global fetch, so wrapping
    // window.fetch intercepts it. The match must be EXACT — loadSession hits "/api/sessions/<id>",
    // whereas "/api/sessions/<id>/connectors", "/api/sessions/<id>/events" (the SSE stream is an
    // EventSource anyway, not fetch), and "/api/sessions" (the list refresh) must not count, or the
    // test would pass without the fix on an unrelated re-fetch.
    await devtools.evaluate(`(() => {
      window.__sessionGets = 0;
      const original = window.fetch;
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        const path = url.split("?")[0];
        const method = ((init && init.method) || "GET").toUpperCase();
        if (method === "GET" && path.endsWith("/api/sessions/${sessionId}")) window.__sessionGets += 1;
        return original(input, init);
      };
      return true;
    })()`);

    // Force a deterministic drop: end the server side of the live SSE stream. The session still
    // exists, so the browser's EventSource reconnects cleanly — and its onopen must now re-sync,
    // observable as a GET for this session firing after the reconnect.
    // Poll until the server has actually registered this session's SSE stream, then close it. The UI's
    // connection indicator (waited on above) can flip on the browser's EventSource.onopen before the
    // server finishes registering the stream in `clients`, so closing once could race and return 0 — a
    // flake. Using closeSessionStreams's own return value as the wait condition closes it exactly when
    // it exists.
    await waitFor(() => serverModule.closeSessionStreams(sessionId) >= 1, 20000);
    console.log("sse resync check: server closed the stream");

    const resynced = await waitFor(() => devtools.evaluate(`window.__sessionGets > 0`), 20000);
    assert.equal(resynced, true);
    // The reconnect also restored the connected indicator, so the UI isn't left showing "disconnected".
    await waitFor(() => devtools.evaluate(`!document.getElementById("serverStatus").classList.contains("is-bad")`), 10000);
    console.log("sse resync check: reconnect re-synced the session");
  } catch (error) {
    await harness.captureFailureScreenshot("sse-resync-failure");
    throw harness.decorateError(error);
  } finally {
    await harness.cleanup();
  }
}

try {
  await run();
  console.log("sse resync browser checks passed");
} catch (error) {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
}
