import { provider, providerIds } from "./providers/registry.js";
import { providerReadiness } from "./provider-readiness.js";

// Whether a provider's CLI has an update available. There is no offline "is an update available?"
// check (claude/codex `update` both check-and-install in one step), so the latest version is read
// from the npm registry (network) and compared to the installed version. Read-only: this never runs
// the update — it only reports so the UI can show UPDATE vs UPDATED. Fails soft when offline.

const CACHE_TTL_MS = 10 * 60 * 1000;
const latestCache = new Map();

export function parseSemver(text) {
  const match = String(text || "").match(/\d+\.\d+\.\d+/);
  return match ? match[0] : "";
}

// Numeric compare of the first three segments; pre-release/build suffixes are ignored (good enough
// for these CLIs' plain semver). Returns true only when `latest` is strictly newer than `current`.
export function isNewerVersion(latest, current) {
  if (!latest || !current) return false;
  const parse = (value) => String(value).split(".").map((part) => parseInt(part, 10) || 0);
  const a = parse(latest);
  const b = parse(current);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const left = a[index] || 0;
    const right = b[index] || 0;
    if (left !== right) return left > right;
  }
  return false;
}

// Read the body but abort once it exceeds `maxBytes`. A `Content-Length` header check alone is
// bypassed by a chunked/omitted-length response, so the cap is enforced while streaming.
async function readCapped(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (text.length > maxBytes) throw new Error("npm registry response too large");
    return text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new Error("npm registry response too large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchLatestFromNpm(pkg) {
  const url = `https://registry.npmjs.org/${pkg.replace(/\//g, "%2F")}/latest`;
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`npm registry responded ${response.status}`);
  // A `latest`-tag manifest is a few KB; cap the read so a hostile/misbehaving response can't balloon memory.
  const data = JSON.parse(await readCapped(response, 2_000_000));
  return parseSemver(data.version);
}

function isUpdatable(definition) {
  return Boolean(definition && Array.isArray(definition.updateArgs) && definition.updateArgs.length > 0 && definition.updatePackage);
}

export async function checkProviderUpdate(providerId, { fetchLatest = fetchLatestFromNpm, now = Date.now(), getReadiness = providerReadiness } = {}) {
  const definition = provider(providerId);
  if (!isUpdatable(definition)) return { supported: false };
  const readiness = await getReadiness(providerId);
  if (!readiness.installed) return { supported: true, installed: false };
  const current = parseSemver(readiness.version);
  if (!current) {
    // Installed, but its --version output carries no parseable semver — we can't compare, so report a
    // failed check (the UI falls back to a plain Update) rather than a wrong "✓ Updated".
    return { supported: true, installed: true, current: "", latest: "", updateAvailable: false, checkFailed: true };
  }
  const cached = latestCache.get(definition.updatePackage);
  let latest = cached && cached.expiresAt > now ? cached.value : "";
  if (!latest) {
    try {
      latest = await fetchLatest(definition.updatePackage);
    } catch {
      // Offline or registry hiccup: report the current version but no availability signal, so the
      // UI falls back to a plain "Update" affordance rather than a wrong "up to date".
      return { supported: true, installed: true, current, latest: "", updateAvailable: false, checkFailed: true };
    }
    // A 200 whose manifest yields no parseable version is a failed check too — treat it like the
    // catch above (don't cache the empty value, and never let the UI render a wrong "✓ Updated").
    if (!latest) return { supported: true, installed: true, current, latest: "", updateAvailable: false, checkFailed: true };
    latestCache.set(definition.updatePackage, { value: latest, expiresAt: now + CACHE_TTL_MS });
  }
  return { supported: true, installed: true, current, latest, updateAvailable: isNewerVersion(latest, current) };
}

export async function checkAllProviderUpdates(options) {
  const entries = await Promise.all(
    providerIds()
      .filter((id) => isUpdatable(provider(id)))
      .map(async (id) => [id, await checkProviderUpdate(id, options)]),
  );
  return Object.fromEntries(entries);
}
