import { win32 as winPath, posix as posixPath } from "node:path";

// CU-0 (Cursor integration — Phase 0B) · SECURITY-QUALIFICATION MODEL · SPIKE ARTIFACT.
//
// Pure and fixtures-driven. These functions CONSUME evidence — a trusted-launch descriptor and the
// results of the qualification suite run against a real Cursor CLI — and DECIDE whether Cursor may act
// as a reviewer or an executor inside Codebate. `validateTrustedLaunchDescriptor` is now LIVE (imported
// by cursor-launch.js, run on every review turn). The `deriveCursorQualification` layer model remains a
// reference/fixtures model, NOT a runtime gate: the review layers it names are instead structurally
// guaranteed by the adapter (fixed `--mode plan`, no `--force`, disposable `CURSOR_CONFIG_DIR`) — except
// OS-level network denial on Windows, an accepted residual (see SECURITY.md). CU-1 landed by owner decision.
//
// The governing principle is FAIL-CLOSED: a layer is satisfied only when its evidence is exactly `true`.
// Missing, `false`, or malformed evidence is treated as "not guaranteed" → not qualified. No layer is
// ever inferred from another, and there is no silent fallback to a weaker mode.

export const CURSOR_QUALIFICATION_SCHEMA_VERSION = 1;

// The launch chain differs per platform (executable name, sandbox backend, path style), so a descriptor is
// bound to the platform+arch it was built for and validated with THAT platform's path semantics — never
// reused across platforms. Qualification is per-platform: a descriptor proven on one OS says nothing about
// another, and Cursor becomes available on a platform only where its safety suite has passed there.
export const SUPPORTED_PLATFORMS = Object.freeze(["win32", "darwin", "linux"]);
export const SUPPORTED_ARCHES = Object.freeze(["x64", "arm64"]);

// Reviewer boundary = a layered AND. A reviewer must not be able to mutate anything outside a disposable
// test repo, reach the network, or be steered by untrusted project settings. `--mode plan` and the
// absence of `--force` are PRODUCT behaviors, not a security boundary on their own, so they are
// necessary but never sufficient — the containment layers around them are what make review safe.
export const REQUIRED_REVIEW_LAYERS = Object.freeze([
  "descriptorValid",                  // the trusted launch chain (node + index.js) validates by fingerprint
  "envIsolated",                      // launch env sanitized — NODE_OPTIONS / NODE_* cannot inject --require before Cursor
  "planMode",                         // invoked with --mode plan
  "noForce",                          // no --force / --yolo (changes are proposed, not applied)
  "configIsolated",                   // isolated CURSOR_CONFIG_DIR — not the user's real config
  "projectSettingsUntrustedDisabled", // a malicious .cursor/cli.json in the project cannot take effect
  "networkDenied",                    // the reviewer runs with network access denied
  "filesystemVerified",               // full name+hash snapshot: no project/parent/home change, incl. hidden & ignored
  "disposableRepo",                   // ran against a disposable clone, never the real repository
]);

// Executor boundary = every reviewer layer PLUS containment, process-control, and sandbox-trust layers.
// Writing is only allowed inside the clone; everything outside it, the network, and an untrusted or
// absent Cursor sandbox must all fail closed.
export const REQUIRED_EXECUTE_LAYERS = Object.freeze([
  "cloneWriteAllowed",     // writes inside the clone succeed (the executor capability itself)
  "parentWriteBlocked",    // a write to ../outside.txt is rejected
  "homeWriteBlocked",      // a write into Home is rejected
  "junctionEscapeBlocked", // a junction/symlink pointing outside the workspace is rejected
  "childProcessConfined",  // spawned child processes inherit the restrictions
  "stopKillsProcessTree",  // Stop terminates Cursor and every child it spawned
  "networkMatrixBlocked",  // DNS / HTTP / HTTPS / direct-IP / localhost / local-ports / child / no-sandbox all denied
  "sandboxFailClosed",     // a sandbox failure aborts the run — never a silent fallback to unsandboxed
  "cursorSandboxTrusted",  // cursorsandbox.exe is present and its fingerprint matches the trust chain
  "secretScanIntact",      // the secret scan on the produced diff still runs and passes
  "reviewedTreeBinding",   // the reviewed-tree binding is unchanged
  "noCursorWorktreeInClone", // Cursor did not spawn its own worktree inside the clone
]);

const NODE_FLAG = /^-/; // any argv token starting with "-" is a Node flag when it precedes the entry point

// The path flavor matches the descriptor's target platform, so validation is deterministic regardless of
// which OS the check runs on (a win32 descriptor is always checked with win32 path semantics, etc.).
function pathFor(platform) {
  return platform === "win32" ? winPath : posixPath;
}

function isWithin(pathModule, root, target) {
  // True when `target` resolves inside `root` under the given path flavor.
  if (!pathModule.isAbsolute(root) || !pathModule.isAbsolute(target)) return false;
  const rel = pathModule.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !pathModule.isAbsolute(rel);
}

/**
 * Validate a Cursor trusted-launch descriptor.
 *
 * The descriptor binds a fixed launch chain (`trusted node.exe → trusted index.js → [request args]`) by
 * fingerprint, so Codebate can run Cursor's Node entry point WITHOUT adding the generic `node.exe` to
 * the process allowlist (which would let any bug or input run `node <untrusted-script>`). The critical
 * invariant is that NO Node flag may precede `index.js`: `node --require evil.js index.js` would execute
 * attacker code before Cursor ever starts, so the fixed prefix must be exactly the entry point.
 *
 * Pure and synchronous. Fingerprint/realpath equality against the on-disk binaries is a RUNTIME check the
 * caller performs separately; this validates the descriptor's shape, argv-boundary, and platform binding.
 *
 * @param {object} descriptor
 * @param {{trustedRoot: string, expectedProviderId?: string, platform?: string, arch?: string}} options
 *   trustedRoot — REQUIRED absolute path (in the descriptor's platform flavor) of the trusted Cursor version
 *   directory; `executable` and `entryPoint` must resolve within it. A missing trustedRoot fails closed.
 *   platform/arch — the target being validated FOR (default: the current process). The descriptor must
 *   declare a supported platform/arch AND match the target — a descriptor is never portable across them.
 * @returns {{valid: boolean, violations: string[]}}
 */
export function validateTrustedLaunchDescriptor(descriptor, { trustedRoot = null, expectedProviderId = "cursor", platform = process.platform, arch = process.arch } = {}) {
  if (!descriptor || typeof descriptor !== "object") {
    return { valid: false, violations: ["descriptor is missing or not an object"] };
  }
  const violations = [];
  const pathModule = pathFor(descriptor.platform);
  const absolute = (value) => typeof value === "string" && value.length > 0 && pathModule.isAbsolute(value);

  if (descriptor.schemaVersion !== 1) violations.push("schemaVersion must be 1");
  if (descriptor.providerId !== expectedProviderId) {
    violations.push(`providerId must be "${expectedProviderId}" — descriptors are provider-bound and not shareable`);
  }
  if (!absolute(descriptor.executable)) violations.push("executable must be an absolute path");
  if (!absolute(descriptor.entryPoint)) violations.push("entryPoint must be an absolute path");
  if (typeof descriptor.executableFingerprint !== "string" || descriptor.executableFingerprint === "") {
    violations.push("executableFingerprint is required");
  }
  if (typeof descriptor.entryPointFingerprint !== "string" || descriptor.entryPointFingerprint === "") {
    violations.push("entryPointFingerprint is required");
  }

  const prefix = descriptor.fixedPrefixArgs;
  if (!Array.isArray(prefix) || prefix.length === 0) {
    violations.push("fixedPrefixArgs must be a non-empty array");
  } else if (!prefix.every((arg) => typeof arg === "string")) {
    violations.push("fixedPrefixArgs must contain only strings");
  } else {
    const entryIndex = prefix.indexOf(descriptor.entryPoint);
    if (entryIndex === -1) {
      violations.push("fixedPrefixArgs must include the entryPoint");
    } else if (entryIndex !== 0) {
      violations.push("entryPoint must be the first fixed-prefix arg (trusted node → trusted index.js → request args)");
    }
    // No Node flag may appear before the entry point — it would run code before Cursor starts.
    const beforeEntry = entryIndex === -1 ? prefix : prefix.slice(0, entryIndex);
    if (beforeEntry.some((arg) => NODE_FLAG.test(arg))) {
      violations.push("no Node flags may precede the entryPoint (e.g. --require/--import run code before Cursor)");
    }
    // The fixed prefix is EXACTLY the entry point: request args append AFTER it at launch, so any arg baked
    // into the trusted prefix (e.g. a trailing --force / --yolo) would reach Cursor as if it were trusted.
    if (prefix.length !== 1) {
      violations.push("fixedPrefixArgs must be exactly [entryPoint] — no args after the entry point (those belong to the request, not the trusted prefix)");
    }
  }

  // Platform/arch binding: the descriptor must target a supported platform/arch AND match what we are
  // validating for. A descriptor built for one platform/arch is never valid for another.
  if (!SUPPORTED_PLATFORMS.includes(descriptor.platform)) {
    violations.push(`platform must be one of: ${SUPPORTED_PLATFORMS.join(", ")}`);
  } else if (descriptor.platform !== platform) {
    violations.push(`descriptor platform "${descriptor.platform}" does not match the target platform "${platform}"`);
  }
  if (!SUPPORTED_ARCHES.includes(descriptor.arch)) {
    violations.push(`arch must be one of: ${SUPPORTED_ARCHES.join(", ")}`);
  } else if (descriptor.arch !== arch) {
    violations.push(`descriptor arch "${descriptor.arch}" does not match the target arch "${arch}"`);
  }

  // Containment is mandatory: a missing trustedRoot fails closed instead of skipping the check, otherwise a
  // descriptor pointing anywhere on disk would validate. trustedRoot is the trusted Cursor version
  // directory, always known at the (CU-1) call site that builds the descriptor.
  if (!trustedRoot) {
    violations.push("trustedRoot must be supplied to verify launch-chain containment");
  } else {
    if (absolute(descriptor.entryPoint) && !isWithin(pathModule, trustedRoot, descriptor.entryPoint)) {
      violations.push("entryPoint must resolve within the trusted Cursor version directory");
    }
    if (absolute(descriptor.executable) && !isWithin(pathModule, trustedRoot, descriptor.executable)) {
      violations.push("executable must resolve within the trusted Cursor version directory");
    }
  }

  return { valid: violations.length === 0, violations };
}

function unmetLayers(tests, layers) {
  // Fail-closed: a layer is met only when its evidence is exactly `true`.
  const source = tests && typeof tests === "object" ? tests : {};
  return layers.filter((layer) => source[layer] !== true);
}

/**
 * Derive Cursor's review/execute qualification from suite evidence.
 *
 * `reviewQualified` is true only when EVERY reviewer layer is proven; `executeQualified` requires the full
 * reviewer floor PLUS every executor layer. Any layer that is not exactly `true` — missing, false, or
 * malformed — leaves that capability unqualified and is listed in `reasons`. There is no partial credit
 * and no capability is inferred from another.
 *
 * @param {{version?: string, platform?: string, arch?: string, tests?: Record<string, boolean>}} [evidence]
 * @returns {{schemaVersion: number, provider: "cursor", version: string|null, platform: string|null,
 *   arch: string|null, reviewQualified: boolean, executeQualified: boolean,
 *   tests: {review: Record<string, boolean>, execute: Record<string, boolean>}, reasons: string[]}}
 */
export function deriveCursorQualification(evidence = {}) {
  const tests = evidence?.tests;
  const reviewUnmet = unmetLayers(tests, REQUIRED_REVIEW_LAYERS);
  const executeUnmet = unmetLayers(tests, REQUIRED_EXECUTE_LAYERS);
  const reviewQualified = reviewUnmet.length === 0;
  const executeQualified = reviewQualified && executeUnmet.length === 0;

  const reasons = [
    ...reviewUnmet.map((layer) => `review layer not guaranteed: ${layer}`),
    ...executeUnmet.map((layer) => `execute layer not guaranteed: ${layer}`),
  ];
  // Executor layers can all pass while the reviewer floor does not — execution still cannot qualify.
  if (!reviewQualified && executeUnmet.length === 0) {
    reasons.push("execute blocked: every reviewer layer must pass before execution can qualify");
  }

  return {
    schemaVersion: CURSOR_QUALIFICATION_SCHEMA_VERSION,
    provider: "cursor",
    version: typeof evidence?.version === "string" ? evidence.version : null,
    platform: typeof evidence?.platform === "string" ? evidence.platform : null,
    arch: typeof evidence?.arch === "string" ? evidence.arch : null,
    reviewQualified,
    executeQualified,
    tests: {
      review: Object.fromEntries(REQUIRED_REVIEW_LAYERS.map((layer) => [layer, tests?.[layer] === true])),
      execute: Object.fromEntries(REQUIRED_EXECUTE_LAYERS.map((layer) => [layer, tests?.[layer] === true])),
    },
    reasons,
  };
}
