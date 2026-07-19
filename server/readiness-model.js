// Pure readiness derivation — no I/O, no DOM, no side effects. Maps the raw probe signals gathered by
// provider-readiness.js (a command check, discovery, persisted trust) to the dimensional provider
// readiness contract, and derives what a given setup can do. Being pure, the same functions back the
// API (`GET /api/setup/status`), a future `codebate doctor` CLI, and diagnostics — one source of
// truth (SETUP_DOCTOR_UPDATE_PLAN §5, §7, §8). The browser renders a chip from these dimensions; it
// never re-derives state.
//
// Dimensions are independent axes (a flat enum conflates them and explodes with a third provider):
//   installation: missing | discovered | installed   (+ check_failed later, needs an error-typed probe)
//   trust:        not_required | untrusted | trusted
//   auth:         unknown | verified | failed_observed
//   operational:  { available, reasonCode }
//
// auth is reactive-first: it stays "unknown" here (we show "installed — login not tested yet") and only
// becomes "failed_observed" when a real run fails a classified auth check — a later increment. A
// `--version` success proves the CLI runs, NOT that it is signed in, so we never assert auth from it.
// `trust` carries only `{state}` here; the discovered absolute path and its fingerprint are deliberately
// withheld (they would carry the OS username into the diagnostics snapshot — see provider-readiness.js)
// and land with the transactional Trust & Check split (§9).

export function deriveProviderReadiness({
  check,
  autoTrusted = false,
  hasApprovedCommand = false,
  discoveryFound = false,
} = {}) {
  const runs = Boolean(check?.ok);
  const version = runs ? String(check?.version || "") : "";

  // Installation: it runs → installed; else something was found on disk but not verified → discovered
  // (only reachable once §9 surfaces found-but-unverified candidates — provider-readiness.js's current
  // auto-trust call site sets discoveryFound only alongside a passing check, so this arm is unit-tested
  // but dormant in production today); else nothing at all → missing.
  const installation = runs
    ? { state: "installed", version }
    : discoveryFound
      ? { state: "discovered", version: "" }
      : { state: "missing", version: "" };

  // Trust: a specific path was explicitly approved (persisted) or auto-trusted this run → trusted; a
  // discovered-but-unverified path still needs the user's OK → untrusted; anything that just runs from
  // PATH needs no path-level trust → not_required.
  const trust = {
    state: (hasApprovedCommand || autoTrusted)
      ? "trusted"
      : installation.state === "discovered"
        ? "untrusted"
        : "not_required",
  };

  const auth = { state: "unknown", observedAt: null };

  // Operational: the executable is both runnable and cleared to run. A discovered-untrusted binary is
  // present but gated on trust, so it is not operational until verified.
  const available = runs && trust.state !== "untrusted";
  const operational = {
    available,
    reasonCode: available ? null : installation.state === "missing" ? "not_installed" : "needs_trust",
  };

  return { installation, trust, auth, operational };
}

// Machine readiness ≠ session readiness (SETUP_DOCTOR_UPDATE_PLAN §8). This derives only what the
// *machine* can do from the operational providers + Git; execution on real code additionally needs an
// attached, trusted project, which is session-scoped and derived elsewhere. Codebate's value is two
// agents comparing/debating, so every collaborative capability needs at least two operational providers
// — a single provider is intentionally not enough (you would just use that CLI directly).
export function deriveSetupCapabilities({ providers = [], gitAvailable = false } = {}) {
  const ready = providers.filter((entry) => entry?.operational?.available);
  const readyIds = ready.map((entry) => entry.provider);
  const enoughAgents = readyIds.length >= 2;
  // An executor must actually support an execute mode (registry `capabilities.executeModes` — today only
  // Codex; executor.js enforces it at runtime). A reviewer can be any distinct ready provider
  // (exec-orchestrator only requires executor !== reviewer). Deriving executors from executeModes keeps
  // the contract honest so a UI built on it never offers a non-executor as the executor.
  const executorCandidates = enoughAgents
    ? ready.filter((entry) => Array.isArray(entry.executeModes) && entry.executeModes.length > 0).map((entry) => entry.provider)
    : [];
  const reviewerCandidates = enoughAgents ? readyIds : [];
  return {
    discussion: { available: enoughAgents, readyProviders: readyIds.length },
    executionEngine: {
      available: enoughAgents && Boolean(gitAvailable) && executorCandidates.length > 0,
      executorCandidates,
      reviewerCandidates,
    },
    gitFeatures: { available: Boolean(gitAvailable) },
  };
}
