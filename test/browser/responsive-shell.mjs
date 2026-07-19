import assert from "node:assert/strict";
import { launchBrowserHarness, waitFor, setViewport } from "./harness.mjs";

async function assertOverlay(devtools, triggerId, panelId) {
  await devtools.evaluate(`document.getElementById(${JSON.stringify(triggerId)}).click()`);
  const opened = await devtools.evaluate(`(() => {
    const panel = document.getElementById(${JSON.stringify(panelId)});
    return {
      open: panel.classList.contains("open"),
      visible: getComputedStyle(panel).display !== "none",
      focused: document.activeElement === panel,
      blocked: !document.getElementById("shellOverlayBackdrop").hidden,
      modal: panel.getAttribute("role") === "dialog" && panel.getAttribute("aria-modal") === "true",
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);
  assert.deepEqual(opened, { open: true, visible: true, focused: true, blocked: true, modal: true, overflow: false });
  await devtools.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  assert.equal(await devtools.evaluate(`document.getElementById(${JSON.stringify(panelId)}).classList.contains("open")`), false);
  assert.equal(await devtools.evaluate(`document.getElementById(${JSON.stringify(panelId)}).hasAttribute("aria-modal")`), false);
  assert.equal(await devtools.evaluate(`document.activeElement.id`), triggerId);
}

async function run() {
  const harness = await launchBrowserHarness();
  const { devtools } = harness;
  try {
    await devtools.evaluate(`(() => {
      localStorage.setItem("codebate-onboarded", "1");
      localStorage.setItem("codebate-rail-collapsed", "1");
    })()`);
    await devtools.evaluate(`location.reload(); true`);
    await waitFor(() => devtools.evaluate(`document.readyState === "complete" && !document.getElementById("emptyState").hidden`));
    await setViewport(devtools, 800, 600);
    console.log("browser check: testing mobile cold start");
    await assertOverlay(devtools, "emptyRailDrawerToggle", "sessionsRail");
    await devtools.evaluate(`document.getElementById("emptyRailDrawerToggle").click()`);
    assert.deepEqual(await devtools.evaluate(`(() => ({
      newSessionVisible: getComputedStyle(document.getElementById("newSessionBtn")).display !== "none",
      sessionListVisible: getComputedStyle(document.getElementById("sessionList")).display !== "none",
      railWide: document.getElementById("sessionsRail").getBoundingClientRect().width > 250,
    }))()`), { newSessionVisible: true, sessionListVisible: true, railWide: true });
    await devtools.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await devtools.evaluate(`localStorage.removeItem("codebate-rail-collapsed")`);
    await devtools.evaluate(`(async () => {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Responsive shell test" }),
      });
      return (await response.json()).id;
    })()`);
    await devtools.evaluate(`location.reload(); true`);
    await waitFor(() => devtools.evaluate(`Boolean(document.querySelector("#sessionList .session-item"))`), 20000);
    console.log("browser check: session created");
    await devtools.evaluate(`document.querySelector("#sessionList .session-item").click()`);
    await waitFor(() => devtools.evaluate(`!document.getElementById("sessionView").hidden`));

    await setViewport(devtools, 1280, 800);
    assert.equal(await devtools.evaluate(`document.getElementById("toggleContext").getAttribute("aria-expanded")`), "true");
    await setViewport(devtools, 980, 680);
    console.log("browser check: testing 980x680");
    await assertOverlay(devtools, "contextDrawerToggle", "contextCol");
    await devtools.evaluate(`(() => {
      const panel = document.getElementById("contextCol");
      document.getElementById("contextDrawerToggle").click();
      panel.insertAdjacentHTML("beforeend", "<details><summary>Context focus test</summary></details>");
      panel.focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    })()`);
    assert.equal(await devtools.evaluate(`document.activeElement?.tagName`), "SUMMARY");
    await devtools.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await assertOverlay(devtools, "workflowToggle", "workflow");
    await devtools.evaluate(`document.documentElement.dataset.preset = "simple"`);
    await assertOverlay(devtools, "workflowToggle", "workflow");
    await devtools.evaluate(`document.documentElement.dataset.preset = "mission"`);
    await devtools.evaluate(`(() => {
      const button = document.getElementById("newSessionBtn");
      button.focus();
      button.click();
    })()`);
    await waitFor(() => devtools.evaluate(`document.activeElement.id === "newSessionName"`));
    await devtools.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await waitFor(() => devtools.evaluate(`document.getElementById("newSessionModal").classList.contains("hidden")`));
    await waitFor(() => devtools.evaluate(`document.activeElement.id === "newSessionBtn"`));

    await setViewport(devtools, 800, 600);
    console.log("browser check: testing 800x600");
    await assertOverlay(devtools, "railDrawerToggle", "sessionsRail");
    await devtools.evaluate(`(() => {
      document.getElementById("railDrawerToggle").click();
      document.querySelector("#sessionList .session-item").click();
    })()`);
    await waitFor(() => devtools.evaluate(`!document.getElementById("sessionsRail").classList.contains("open")`));
    await waitFor(() => devtools.evaluate(`document.activeElement.id === "sessionTitle"`));
    assert.equal(await devtools.evaluate(`document.activeElement.id`), "sessionTitle");
    assert.equal(await devtools.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true);
    await devtools.evaluate(`document.querySelector('[data-lang="en"]').click()`);
    assert.equal(await devtools.evaluate(`document.documentElement.dir`), "ltr");
    assert.equal(await devtools.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true);
    await devtools.evaluate(`(() => {
      const tab = document.getElementById("tabDecision");
      tab.focus();
      tab.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    })()`);
    assert.equal(await devtools.evaluate(`document.activeElement.id`), "tabConversation");
    assert.equal(await devtools.evaluate(`document.getElementById("tabConversation").getAttribute("aria-selected")`), "true");

    await setViewport(devtools, 400, 300);
    assert.equal(await devtools.evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), true);
    await assertOverlay(devtools, "contextDrawerToggle", "contextCol");
  } catch (error) {
    await harness.captureFailureScreenshot("responsive-shell-failure");
    throw harness.decorateError(error);
  } finally {
    await harness.cleanup();
  }
}

try {
  await run();
  console.log("responsive browser checks passed");
} catch (error) {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
}
