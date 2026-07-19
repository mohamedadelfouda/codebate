import { expectedApiError } from "./api-errors.js";
import { approveProviderCommand, approvedProviderCommand, checkCommand } from "./process.js";
import { discoverProviderCommands } from "./cli-discovery.js";
import { logError, redact } from "./logger.js";
import { provider } from "./providers/registry.js";
import { deriveProviderReadiness } from "./readiness-model.js";
import { buildCursorLaunchDescriptor } from "./providers/cursor-launch.js";

const READINESS_TTL_MS = 30000;
const readinessCache = new Map();

// PATH search can miss a CLI installed via npm/pnpm/bun: on Windows those expose only cmd/ps1 shims
// (rejected as non-native executables), and elsewhere the binary can be hoisted out of PATH. When the
// primary check fails and nothing has been trusted yet, discover the bundled native executable
// (cli-discovery covers Windows/macOS/Linux × x64/arm64), verify it actually runs as this provider,
// and auto-trust it — so an installed provider "just works" without a manual Trust & check step.
async function autoTrustDiscoveredCommand(definition, discover = discoverProviderCommands) {
  let candidates;
  try { candidates = await discover(definition.command); }
  catch (error) { logError("provider auto-discovery failed", redact(error?.message || String(error))); return null; }
  for (const candidate of candidates) {
    try {
      const status = await checkCommand(candidate, { allowedCommands: new Set([definition.command]), trustedPaths: [candidate] });
      if (!status.ok) continue;
      await approveProviderCommand(definition.id, candidate, new Set([definition.command]));
      return { status, path: candidate };
    } catch (error) {
      logError("provider auto-trust rejected a discovered command", redact(error?.message || String(error)));
    }
  }
  return null;
}

export function configuredProviderCommand(definition) {
  return process.env[definition.commandEnv] || definition.command;
}

export function trustedProviderCliPaths(definition) {
  return [process.env[definition.commandEnv], approvedProviderCommand(definition.id)].filter(Boolean);
}

const inFlightReadiness = new Map();

export async function providerReadiness(providerId, { refresh = false, discover = discoverProviderCommands } = {}) {
  const definition = provider(providerId);
  if (!definition) return { installed: false, version: "", detail: "Unknown provider" };
  const cached = readinessCache.get(definition.id);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.value;
  // Collapse concurrent checks for the same provider onto a single in-flight probe. Otherwise two
  // parallel checks race: the slower one's initial command check fails, the faster one auto-trusts a
  // discovered command in the meantime, and the slower one then sees a command is approved, skips its
  // own discovery, and caches its now-stale failure for the whole TTL. Sharing one probe removes the
  // race entirely. (get→set is synchronous, so two callers in the same tick can't both create a probe.)
  const existing = inFlightReadiness.get(definition.id);
  if (existing) return existing;
  const probe = computeProviderReadiness(definition, discover).finally(() => inFlightReadiness.delete(definition.id));
  inFlightReadiness.set(definition.id, probe);
  return probe;
}

async function computeProviderReadiness(definition, discover) {
  if (definition.id === "cursor") return computeCursorReadiness(definition);
  let status = await checkCommand(
    approvedProviderCommand(definition.id) || configuredProviderCommand(definition),
    {
      allowedCommands: new Set([definition.command]),
      trustedPaths: trustedProviderCliPaths(definition),
    },
  );
  // Nothing on PATH and nothing trusted yet: fall back to discovering + auto-trusting the bundled
  // native executable, so an npm/pnpm-installed provider is detected without a manual setup step.
  // Skipped when the user set an explicit command override (respect their choice — never silently
  // supersede a failing override with a different discovered binary). `discover` is injectable so
  // tests can exercise this path without a real provider install. `autoTrusted` lets the UI surface
  // that a path was trusted on the user's behalf (see docs/PROVIDERS.md). The discovered absolute
  // path is deliberately NOT returned — it would carry the OS username into the diagnostics snapshot.
  let autoTrusted = false;
  let discoveryFound = false;
  if (!status.ok && !approvedProviderCommand(definition.id) && !process.env[definition.commandEnv]) {
    const discovered = await autoTrustDiscoveredCommand(definition, discover);
    if (discovered) { status = discovered.status; autoTrusted = true; discoveryFound = true; }
  }
  // Dimensional readiness (installation/trust/auth/operational) alongside the flat fields, so the new
  // Setup Doctor can derive its chip while every existing consumer keeps reading installed/version/detail.
  const dimensions = deriveProviderReadiness({
    check: status,
    autoTrusted,
    hasApprovedCommand: Boolean(approvedProviderCommand(definition.id)),
    discoveryFound,
  });
  const value = { installed: status.ok, version: status.version, detail: status.detail, autoTrusted, dimensions };
  readinessCache.set(definition.id, { value, expiresAt: Date.now() + READINESS_TTL_MS });
  return value;
}

// Cursor launches through a fingerprint-pinned trusted descriptor, not a `command` on the allowlist, so its
// readiness is "does the trusted launch chain build + validate on this machine?", not `<command> --version`.
// The descriptor itself is the trust (fingerprinted node + index.js), so a valid build is trusted. Auth is
// reactive (deriveProviderReadiness leaves it "unknown"): an unauthenticated review fails with an auth error
// at run time rather than readiness probing the network every 30s.
async function computeCursorReadiness(definition) {
  let status;
  try {
    const built = await buildCursorLaunchDescriptor({});
    status = built.ok && built.validation.valid
      ? { ok: true, version: built.descriptor.version, detail: "Cursor detected" }
      : { ok: false, version: "", detail: redact(built.reason || "Cursor launch descriptor invalid") }; // reason embeds the install path (OS username)
  } catch (error) {
    status = { ok: false, version: "", detail: redact(error?.message || "Cursor detection failed") };
  }
  const dimensions = deriveProviderReadiness({ check: status, autoTrusted: status.ok, hasApprovedCommand: false, discoveryFound: false });
  const value = { installed: status.ok, version: status.version, detail: status.detail, autoTrusted: status.ok, dimensions };
  readinessCache.set(definition.id, { value, expiresAt: Date.now() + READINESS_TTL_MS });
  return value;
}

export async function assertProvidersReady(providerIds) {
  const statuses = await Promise.all(providerIds.map(async (providerId) => [providerId, await providerReadiness(providerId)]));
  const unavailable = statuses.find(([, status]) => !status.installed);
  if (!unavailable) return;
  const [providerId, status] = unavailable;
  const label = provider(providerId)?.label || providerId;
  throw expectedApiError("provider_unavailable", `${label} is unavailable: ${status.detail || "setup is required"}`, 503);
}

export function invalidateProviderReadiness(providerId) {
  readinessCache.delete(String(providerId || ""));
}
