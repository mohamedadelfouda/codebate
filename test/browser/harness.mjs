// Shared harness for the headless-browser checks: it starts the real server in-process, launches a
// system Chrome/Edge in headless mode, connects a DevTools session, and hands the test a ready page.
// Each browser check (responsive-shell, sse-resync, …) imports this instead of re-deriving the setup.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export async function waitFor(read, timeoutMs = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) {
      if (error?.fatal) throw error;
      /* The browser or page may still be starting. */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the browser test condition");
}

async function existingBrowser() {
  const candidates = [
    process.env.CODEBATE_BROWSER,
    process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "",
    process.platform === "win32" ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" : "",
    process.platform === "win32" ? "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" : "",
    process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "",
    process.platform === "darwin" ? "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" : "",
    process.platform === "linux" ? "/usr/bin/google-chrome" : "",
    process.platform === "linux" ? "/usr/bin/chromium" : "",
    process.platform === "linux" ? "/usr/bin/chromium-browser" : "",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await fs.access(candidate); return candidate; }
    catch { /* Try the next supported system browser. */ }
  }
  throw new Error("No supported Chrome or Edge executable was found; set CODEBATE_BROWSER");
}

export class DevToolsSession {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("Browser connection closed"));
      this.pending.clear();
    });
  }

  async send(method, params = {}) {
    await Promise.race([
      this.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out opening the browser connection")), 5000)),
    ]);
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, method, params }));
    return Promise.race([
      response,
      new Promise((_, reject) => setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for browser command: ${method}`));
      }, 5000)),
    ]);
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Browser evaluation failed");
    }
    return result.result.value;
  }
}

export async function setViewport(devtools, width, height) {
  await devtools.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(() => devtools.evaluate(`window.innerWidth === ${width} && window.innerHeight === ${height}`));
}

// Best-effort PNG of the current page under test-results/, for diagnosing a failing check. Never
// throws (a screenshot failure must not mask the original assertion) and no-ops without a session.
async function saveScreenshot(devtools, name) {
  if (!devtools) return;
  try {
    const shot = await devtools.send("Page.captureScreenshot", { format: "png" });
    const resultsDir = path.join(root, "test-results");
    await fs.mkdir(resultsDir, { recursive: true });
    await fs.writeFile(path.join(resultsDir, `${name}.png`), Buffer.from(shot.data, "base64"));
  } catch { /* Preserve the original failure. */ }
}

// Start the server + a headless browser and return a ready DevTools session for the app page,
// plus helpers: captureFailureScreenshot(name) writes a PNG under test-results/ for a failing
// assertion, decorateError(error) appends captured browser stderr, and cleanup() tears everything
// down. On a setup failure this cleans up before rethrowing so a caller never leaks the server/browser.
export async function launchBrowserHarness() {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "codebate-browser-runtime-"));
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "codebate-browser-profile-"));
  let browser;
  let browserStderr = "";
  let devtools;
  let shutdownServer;

  const cleanup = async () => {
    if (devtools) {
      try { await devtools.send("Browser.close"); }
      catch { if (browser?.exitCode === null) browser.kill("SIGKILL"); }
    } else if (browser?.exitCode === null) {
      browser.kill("SIGKILL");
    }
    if (browser?.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => browser.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    devtools?.socket.close();
    await shutdownServer?.("browser_test");
    await fs.rm(runtimeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
    await fs.rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  };

  try {
    console.log("browser check: starting server");
    process.env.CODEBATE_RUNTIME_DIR = runtimeDir;
    process.env.NO_OPEN = "1";
    process.env.PORT = "0";
    const serverModule = await import("../../server/index.js");
    const { url } = await serverModule.serverReady;
    shutdownServer = serverModule.shutdownServer;

    const executable = await existingBrowser();
    console.log(`browser check: launching ${path.basename(executable)}`);
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      "--remote-allow-origins=*",
      `--user-data-dir=${profileDir}`,
      "--window-size=1280,800",
      url,
    ];
    // Chrome's sandbox needs a setuid helper or unprivileged user namespaces; GitHub's Linux runners
    // restrict both and run as non-root, so the sandbox aborts the launch there (the port file never
    // appears → an opaque launch timeout). It adds nothing for an ephemeral test browser loading only
    // localhost, so drop it on Linux and whenever running as root anywhere.
    if (process.platform === "linux" || (typeof process.getuid === "function" && process.getuid() === 0)) {
      args.unshift("--no-sandbox", "--disable-setuid-sandbox");
    }
    browser = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    browser.stderr.on("data", (chunk) => { browserStderr = `${browserStderr}${chunk}`.slice(-6000); });
    const portFile = path.join(profileDir, "DevToolsActivePort");
    // Fail fast (with the captured stderr) if the browser exits before publishing its debug port —
    // otherwise a crashed launch (e.g. a sandbox abort) only surfaces as an opaque 15s timeout.
    const debugPort = await waitFor(async () => {
      if (browser.exitCode !== null) {
        const error = new Error(`Browser exited before it published its debug port: ${browserStderr}`);
        error.fatal = true;
        throw error;
      }
      return Number((await fs.readFile(portFile, "utf8")).split(/\r?\n/, 1)[0]);
    });
    console.log("browser check: connected to browser");
    const pages = await waitFor(async () => {
      if (browser.exitCode !== null) {
        const error = new Error(`Browser exited before DevTools became ready: ${browserStderr}`);
        error.fatal = true;
        throw error;
      }
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1000) });
      const targets = await response.json();
      return targets.find((target) => target.type === "page" && target.url.startsWith(url) && target.webSocketDebuggerUrl);
    });
    console.log("browser check: page target found");
    devtools = new DevToolsSession(pages.webSocketDebuggerUrl);
    await devtools.send("Runtime.enable");
    await devtools.send("Page.enable");
    console.log("browser check: DevTools session ready");
    await waitFor(() => devtools.evaluate(`document.readyState === "complete"`));
    await waitFor(() => devtools.evaluate(`Boolean(document.getElementById("appShell"))`));

    return {
      devtools,
      url,
      // The server runs in this same process, so tests can drive its exports directly — e.g. close a
      // session's SSE streams to force a deterministic EventSource reconnect.
      serverModule,
      captureFailureScreenshot: (name) => saveScreenshot(devtools, name),
      decorateError: (error) => {
        if (browserStderr.trim()) error.message = `${error.message}\nBrowser stderr:\n${browserStderr.trim()}`;
        return error;
      },
      cleanup,
    };
  } catch (error) {
    // A setup failure can still happen after DevTools connects (the readyState/appShell waits), so
    // preserve the same diagnostics a test-body failure gets: a screenshot and captured browser stderr.
    await saveScreenshot(devtools, "harness-setup-failure");
    if (browserStderr.trim()) error.message = `${error.message}\nBrowser stderr:\n${browserStderr.trim()}`;
    await cleanup();
    throw error;
  }
}
