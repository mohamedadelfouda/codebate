import { app, BrowserWindow, dialog, safeStorage, shell, session } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const squirrelEvent = process.platform === "win32"
  ? process.argv.find((arg) => arg.startsWith("--squirrel-"))
  : null;
let mainWindow = null;
let serverModule = null;
let quitting = false;

function handleSquirrelEvent(event) {
  const handledEvents = new Set(["--squirrel-install", "--squirrel-updated", "--squirrel-uninstall", "--squirrel-obsolete"]);
  if (!handledEvents.has(event)) return false;
  if (event === "--squirrel-obsolete") {
    app.quit();
    return true;
  }
  const updateExe = path.resolve(path.dirname(process.execPath), "..", "Update.exe");
  const executable = path.basename(process.execPath);
  const operation = event === "--squirrel-uninstall" ? "--removeShortcut" : "--createShortcut";
  try {
    const child = spawn(updateExe, [operation, executable], { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => app.quit());
    child.once("exit", () => app.quit());
  } catch {
    app.quit();
  }
  return true;
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch {
    return "";
  }
}

function openSafeExternalUrl(value) {
  const external = safeExternalUrl(value);
  if (!external) return;
  shell.openExternal(external).catch((error) => {
    console.error("Could not open external URL:", error?.code || "open_failed");
  });
}

async function createWindow() {
  process.env.PORT = "0";
  process.env.NO_OPEN = "1";
  process.env.CODEBATE_RUNTIME_DIR = app.getPath("userData");
  serverModule = await import("../server/index.js");
  const secretsPath = path.join(app.getPath("userData"), "connector-secrets.bin");
  const secureBackend = safeStorage.getSelectedStorageBackend?.();
  const secureStorageAvailable = safeStorage.isEncryptionAvailable() && secureBackend !== "basic_text";
  if (secureStorageAvailable) {
    try {
      const encrypted = Buffer.from(await fs.readFile(secretsPath, "utf8"), "base64");
      serverModule.hydrateConnectorSecrets(JSON.parse(safeStorage.decryptString(encrypted)));
    } catch (error) {
      if (error?.code !== "ENOENT") console.error("Could not load connector credentials:", error?.code || "load_failed");
    }
    serverModule.configureConnectorSecretStore({
      available: true,
      persist: async (values) => {
        const encrypted = safeStorage.encryptString(JSON.stringify(values)).toString("base64");
        const tempPath = `${secretsPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(tempPath, encrypted, { encoding: "utf8", mode: 0o600 });
        try {
          for (let attempt = 0; ; attempt += 1) {
            try { await fs.rename(tempPath, secretsPath); break; }
            catch (error) {
              if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
              await new Promise((resolve) => setTimeout(resolve, 10 * (2 ** attempt)));
            }
          }
          await fs.chmod(secretsPath, 0o600).catch(() => {});
        } finally {
          await fs.rm(tempPath, { force: true }).catch(() => {});
        }
      },
    });
  }
  const { url } = await serverModule.serverReady;

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#171716",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    openSafeExternalUrl(target);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, target) => {
    try { if (new URL(target).origin === new URL(url).origin) return; } catch {}
    event.preventDefault();
    openSafeExternalUrl(target);
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  await mainWindow.loadURL(url);
}

async function startDesktop() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.setAppUserModelId("com.mohamedadel.codebate");
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  await app.whenReady();
  await createWindow();
}

app.on("before-quit", (event) => {
  if (quitting || !serverModule) return;
  event.preventDefault();
  quitting = true;
  const deadline = new Promise((resolve) => setTimeout(resolve, 7000));
  Promise.race([serverModule.shutdownServer("desktop_quit"), deadline]).finally(() => app.exit(0));
});
app.on("window-all-closed", () => app.quit());

if (!handleSquirrelEvent(squirrelEvent)) startDesktop().catch(async (error) => {
  try {
    const { logError } = await import("../server/logger.js");
    logError("desktop startup failed", error?.stack || String(error));
  } catch { console.error(error); }
  try {
    dialog.showErrorBox("Codebate couldn't start", `The local service failed to start (${error?.code || "startup_error"}). Check the application log and try again.`);
  } catch {}
  app.exit(1);
});
