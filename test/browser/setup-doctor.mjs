// SD-2 Setup Doctor: the persistent Doctor evolves the onboarding modal with inline per-provider setup,
// locked-mode framing, an attention badge, and a focus trap. Status is mocked so the render is identical
// on any machine (CI has no provider CLIs; a dev box may have them).
import assert from "node:assert/strict";
import { launchBrowserHarness, waitFor } from "./harness.mjs";

// Three providers ship now (claude, codex, cursor), so a fixture must give every one a status or the
// unlisted provider renders as not-installed and skews the missing-panel counts below.
const CURSOR_READY = { installed: true, version: "cursor-agent 2026.07.16" };
const STATUS = {
  allMissing: { providers: { claude: { installed: false, detail: "not found on PATH" }, codex: { installed: false, detail: "not found on PATH" }, cursor: { installed: false, detail: "not found on PATH" } }, github: { authed: false, detail: "not signed in" } },
  claudeMissing: { providers: { claude: { installed: false, detail: "not found on PATH" }, codex: { installed: true, version: "codex-cli 1.0.0" }, cursor: CURSOR_READY }, github: { authed: true, detail: "github.com" } },
  allReady: { providers: { claude: { installed: true, version: "claude 1.0.0" }, codex: { installed: true, version: "codex-cli 1.0.0" }, cursor: CURSOR_READY }, github: { authed: true, detail: "github.com" } },
};

// Intercept only /api/agents/status; everything else (providers catalog, update-check) hits the real server.
const mockStatus = (payload) => `(() => {
  const data = ${JSON.stringify(payload)};
  if (!window.__origFetch) window.__origFetch = window.fetch;
  window.fetch = (url, opts) => String(url).includes("/api/agents/status")
    ? Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } }))
    : window.__origFetch(url, opts);
  return true;
})()`;

async function run() {
  const harness = await launchBrowserHarness();
  const { devtools } = harness;
  try {
    // Suppress the first-run auto-open so we drive the Doctor explicitly.
    await devtools.evaluate(`(() => { localStorage.setItem("codebate-onboarded", "1"); return true; })()`);
    // Arm the status stub as an init script BEFORE reloading, so initialize()'s own /api/agents/status
    // request is already mocked in the fresh document. Otherwise a slow real response (a dev box with
    // provider CLIs installed) can land after loadOnboard() and overwrite the badge via reflectSetupBadge,
    // making the test host-dependent — and the stub in the current context is wiped by the reload, so it
    // must run again in the new document before any page script.
    await devtools.send("Page.addScriptToEvaluateOnNewDocument", { source: mockStatus(STATUS.claudeMissing) });
    await devtools.evaluate(`location.reload(); true`);
    await waitFor(() => devtools.evaluate(`document.readyState === "complete" && Boolean(document.getElementById("openOnboard"))`));

    // --- Missing provider: inline install/discover panel + locked framing + focus moves into the modal ---
    await devtools.evaluate(`(() => { const b = document.getElementById("openOnboard"); b.focus(); b.click(); return true; })()`);
    await waitFor(() => devtools.evaluate(`Boolean(document.querySelector("#onboardList .onboard-detail"))`));
    // Focus moves into the dialog (openManagedModal focuses on the next frame — poll rather than snapshot).
    await waitFor(() => devtools.evaluate(`document.getElementById("onboardModal").contains(document.activeElement)`));

    const open = await devtools.evaluate(`(() => {
      const modal = document.getElementById("onboardModal");
      const claude = [...document.querySelectorAll("#onboardList .onboard-item")].find(i => i.querySelector(".ob-name")?.textContent === "Claude");
      const panel = claude?.querySelector(".onboard-detail");
      const hint = document.getElementById("onboardLockHint");
      return {
        modalVisible: !modal.classList.contains("hidden"),
        hasInstallCommand: Boolean(panel?.querySelector(".cli-setup-cmd")?.textContent?.trim()),
        hasDocsLink: /^https:\\/\\//.test(panel?.querySelector("a.ob-docs")?.getAttribute("href") || ""),
        hasActions: [...(panel?.querySelectorAll("button") || [])].filter(b => b.textContent.trim()).length >= 2,
        lockedHint: !hint.hidden && hint.classList.contains("is-locked") && hint.textContent.includes("🔒"),
        badge: document.getElementById("openOnboard").classList.contains("needs-setup"),
      };
    })()`);
    assert.deepEqual(open, {
      modalVisible: true, hasInstallCommand: true,
      hasDocsLink: true, hasActions: true, lockedHint: true, badge: true,
    });
    const missingBadgeLabel = await devtools.evaluate(`document.getElementById("openOnboard").getAttribute("aria-label")`);
    console.log("browser check: Doctor shows inline setup + locked framing + badge, focus trapped in the dialog");

    // --- Escape closes the Doctor and restores focus to the opener ---
    await devtools.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
    await waitFor(() => devtools.evaluate(`document.getElementById("onboardModal").classList.contains("hidden")`));
    await waitFor(() => devtools.evaluate(`document.activeElement?.id === "openOnboard"`));
    console.log("browser check: Escape closes the Doctor and returns focus to the opener");

    // --- Zero providers ready: ALL show inline setup panels, still locked, badge on (the 0-of-3 case) ---
    await devtools.evaluate(mockStatus(STATUS.allMissing));
    await devtools.evaluate(`(() => { document.getElementById("openOnboard").click(); return true; })()`);
    await waitFor(() => devtools.evaluate(`document.querySelectorAll("#onboardList .onboard-detail").length === 3`));
    const zero = await devtools.evaluate(`(() => {
      const hint = document.getElementById("onboardLockHint");
      return {
        missingPanels: document.querySelectorAll("#onboardList .onboard-detail").length,
        lockedHint: !hint.hidden && hint.classList.contains("is-locked"),
        badge: document.getElementById("openOnboard").classList.contains("needs-setup"),
      };
    })()`);
    assert.deepEqual(zero, { missingPanels: 3, lockedHint: true, badge: true });
    // A descriptor-launched provider (Cursor) must NOT offer "Find installed copy" — a PATH probe can't
    // resolve its shim and the trust flow targets a command input its card doesn't render. Its panel shows
    // only Re-check (1 button); a command-allowlist provider (Claude) offers Find + Re-check (2 buttons).
    const discoverUi = await devtools.evaluate(`(() => {
      const itemFor = (name) => [...document.querySelectorAll("#onboardList .onboard-item")].find(i => i.querySelector(".ob-name")?.textContent === name);
      const linkButtons = (name) => itemFor(name)?.querySelectorAll(".onboard-detail .ob-link-row button").length ?? -1;
      return { cursor: linkButtons("Cursor"), claude: linkButtons("Claude") };
    })()`);
    assert.deepEqual(discoverUi, { cursor: 1, claude: 2 });
    await devtools.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
    await waitFor(() => devtools.evaluate(`document.getElementById("onboardModal").classList.contains("hidden")`));
    console.log("browser check: Doctor shows every provider's setup panel when zero are ready (0/3), and Cursor hides command-discovery");

    // --- All ready: ready framing, no missing panels, no attention badge ---
    await devtools.evaluate(mockStatus(STATUS.allReady));
    await devtools.evaluate(`(() => { document.getElementById("openOnboard").click(); return true; })()`);
    await waitFor(() => devtools.evaluate(`(() => { const h = document.getElementById("onboardLockHint"); return !h.hidden && !h.classList.contains("is-locked"); })()`));
    const ready = await devtools.evaluate(`(() => ({
      noMissingPanels: document.querySelectorAll("#onboardList .onboard-detail").length === 0,
      badge: document.getElementById("openOnboard").classList.contains("needs-setup"),
      lastChecked: Boolean(document.getElementById("onboardLastChecked").textContent.trim()),
    }))()`);
    assert.deepEqual(ready, { noMissingPanels: true, badge: false, lastChecked: true });
    // The ⚙ badge must expose a distinct accessible name (not just a CSS dot) when setup is incomplete.
    const readyBadgeLabel = await devtools.evaluate(`document.getElementById("openOnboard").getAttribute("aria-label")`);
    assert.ok(missingBadgeLabel && readyBadgeLabel && missingBadgeLabel !== readyBadgeLabel,
      `expected a distinct incomplete-setup aria-label; got missing="${missingBadgeLabel}" ready="${readyBadgeLabel}"`);
    console.log("browser check: the ⚙ badge exposes a distinct accessible name when setup is incomplete");
  } catch (error) {
    await harness.captureFailureScreenshot("setup-doctor-failure");
    throw harness.decorateError(error);
  } finally {
    await harness.cleanup();
  }
}

try {
  await run();
  console.log("setup doctor browser checks passed");
} catch (error) {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
}
