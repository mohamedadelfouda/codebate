import { diagnosticLogTails, loggerHealth, redact } from "./logger.js";
import { providerIds } from "./providers/registry.js";
import { providerReadiness } from "./provider-readiness.js";
import { githubConnectorReadiness } from "./connectors/registry.js";
import { detectSyncedRuntimeFolder } from "./runtime-lock.js";
import { rootPath } from "./store.js";
import { APP_VERSION } from "./app-update.js";

function sharedHealth({ runtimeLock, startupReconciled, shuttingDown }) {
  return {
    startupReconciled,
    shuttingDown,
    logging: loggerHealth(),
    runtimeLock: runtimeLock?.health?.() || null,
  };
}

export function healthSnapshot(state) {
  const health = sharedHealth(state);
  return {
    ok: health.logging.healthy && (!health.runtimeLock || health.runtimeLock.healthy),
    appVersion: APP_VERSION,
    node: process.version,
    platform: process.platform,
    uptimeSeconds: Math.round(process.uptime()),
    // Advisory-only signal: the data folder looks like it lives in a file-sync client's tree, which can
    // corrupt the runtime lock. Never affects `ok` — it's a warning the UI can surface, not a failure.
    syncedFolder: detectSyncedRuntimeFolder(rootPath()),
    ...health,
  };
}

export async function diagnosticSnapshot(state) {
  const [providerEntries, github] = await Promise.all([
    Promise.all(providerIds().map(async (id) => [id, await providerReadiness(id)])),
    githubConnectorReadiness(),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch, uptimeSeconds: Math.round(process.uptime()) },
    server: { startupReconciled: state.startupReconciled, shuttingDown: state.shuttingDown },
    logging: loggerHealth(),
    runtimeLock: state.runtimeLock?.health?.() || null,
    providers: Object.fromEntries(providerEntries.map(([id, readiness]) => [id, {
      ...readiness, version: redact(readiness.version), detail: redact(readiness.detail),
    }])),
    github: { ...github, detail: redact(github.detail) },
    logs: diagnosticLogTails(),
  };
}
