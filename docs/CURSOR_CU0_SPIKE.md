# CU-0 — Cursor qualification spike (report)

> **Status:** spike output, **fixtures only**. This step does **not** enable Cursor as a provider and
> deliberately does **not** touch `server/providers/registry.js` or the process-trust layer
> (`server/process.js`). Wiring Cursor in is CU-1, and only after the empirical suite below passes on the
> owner's machine against the real Cursor CLI.
>
> **Companion plan:** [`CURSOR_INTEGRATION_PLAN.md`](CURSOR_INTEGRATION_PLAN.md) (the security analysis this
> report implements). **Scope:** Windows x64 experimental only.

## What CU-0 delivered

- **`server/providers/cursor-qualification.js`** — two pure, fail-closed functions that CU-1/CU-2 consume:
  - `validateTrustedLaunchDescriptor(descriptor, { trustedRoot, expectedProviderId })` — validates the
    trusted launch chain's shape and argv-boundary invariants.
  - `deriveCursorQualification(evidence)` — maps qualification-suite evidence to
    `{ reviewQualified, executeQualified, tests, reasons }`.
  - Exported layer lists `REQUIRED_REVIEW_LAYERS` (9) and `REQUIRED_EXECUTE_LAYERS` (12) are the single
    source of truth for what "qualified" means.
- **`test/unit/cursor-qualification.test.js`** — fixtures for a compliant descriptor/evidence set and for
  each individual violation, proving every invariant fails closed on its own.

Both functions are pure and evidence-driven: they **decide** given evidence but do not **gather** it. The
gathering — running Cursor against the mutation, network, and filesystem probes — is the empirical spike
that needs the live CLI (see [Open questions](#open-questions-need-the-live-cursor-cli)).

## Phase 0A — CLI characterization

The facts below are transcribed from `CURSOR_INTEGRATION_PLAN.md` §3, which recorded an inspection of the
Cursor CLI on the owner's machine. They are **not** re-captured here (this environment has no Cursor
install), and CU-1 **must** re-capture them as committed fixtures against the pinned version before relying
on them.

| Item | Value (per plan §3) |
|---|---|
| Version inspected | `2026.07.09-a3815c0` |
| Windows entry point | `cursor-agent.cmd → powershell → .ps1 → node.exe versions\<v>\index.js` |
| Native binaries | `node.exe`, `cursorsandbox.exe`, `crepectl.exe`, `rg.exe` |
| Headless output | `--print` + `--output-format text\|json\|stream-json` |
| Review mode | `--mode plan` (planning / read-only intent) |
| Model gate | `--model`, `--list-models` |
| Sandbox | `--sandbox <enabled\|disabled>` (backed by `cursorsandbox.exe`) |
| Apply changes | without `--force`: proposed only; with `--force`/`--yolo`: applied |
| Config isolation | `CURSOR_CONFIG_DIR`; auth via browser login or `CURSOR_API_KEY` |

**Fixtures to capture in CU-1 (not fabricated here):** `--help` text, a `--print --output-format json`
sample, a `stream-json` sample, and `--list-models` output. Fabricating "captured" output would misrepresent
what was actually observed, so CU-0 records the contract and defers the captures.

## The trusted launch descriptor (the security gap this closes)

Per the plan (§3), Cursor's Windows entry point is `node.exe index.js`. The naive fix — adding `node` to
the process allowlist — is **unacceptable**: `node.exe` is a general runtime, so any bug or input could run
`node <untrusted-script>`. Instead a **provider-bound trusted launch descriptor** pins the whole chain by
fingerprint without widening the general allowlist. `validateTrustedLaunchDescriptor` enforces:

- `providerId` is exactly the expected provider — a descriptor is **not** shareable across providers.
- `executable` and `entryPoint` are absolute; when a `trustedRoot` is supplied, both must resolve within it.
- Both `executableFingerprint` and `entryPointFingerprint` are present (on-disk equality is a runtime check
  the caller performs separately).
- **No Node flag may precede the entry point.** `fixedPrefixArgs` must be exactly `[entryPoint]` with the
  entry point first and nothing flag-like before it — otherwise `node --require evil.js index.js` would run
  attacker code *before* Cursor starts. This is the single most important invariant.
- **The launch environment must be sanitized too.** The argv invariant is necessary but not sufficient:
  `NODE_OPTIONS="--require=evil.js"` injects the same pre-Cursor code execution from the environment side,
  which no descriptor field can see. `server/process.js`'s env allowlist already excludes
  `NODE_OPTIONS`/`NODE_*`; the `envIsolated` qualification layer makes CU-1 prove the Cursor launch uses
  that sanitized env (never `envPolicy: "inherit"`).
- `platform`/`arch` are `win32`/`x64` — a descriptor validated on one platform/arch is not portable.

**Policy-name change this forces (must be documented in CU-1):** the old rule *"native provider executable
only"* stops being accurate once a runtime + script is trusted. It becomes *"provider-bound trusted launch
chain"* — either a standalone trusted binary (Codex) or a fully pinned launch chain (Node + Cursor entry
point). CU-1 records this in `SECURITY.md`, `PROVIDERS.md`, the threat model, and the trusted-CLI store
schema.

## Phase 0B — the layered qualification model

Qualification is a **layered AND that fails closed**: a layer counts as met only when its evidence is
strictly `true`; missing, `false`, or malformed evidence leaves the capability unqualified and is listed in
`reasons`. No capability is inferred from another, and there is no silent fallback to a weaker mode.

- **Reviewer** (`REQUIRED_REVIEW_LAYERS`) qualifies only when all 9 hold: `descriptorValid`, `envIsolated`,
  `planMode`, `noForce`, `configIsolated`, `projectSettingsUntrustedDisabled`, `networkDenied`,
  `filesystemVerified`, `disposableRepo`. `--mode plan` and "no `--force`" are **product behavior, not a
  security boundary** — the boundary is the *layers* around them (isolated config, sanitized env, denied
  network, verified filesystem, disposable clone). If any layer is not guaranteed → `reviewQualified = false`.
- **Executor** (`REQUIRED_EXECUTE_LAYERS`) requires the full reviewer floor **plus** 12 containment /
  process-control / sandbox-trust layers, including `parentWriteBlocked`, `homeWriteBlocked`,
  `junctionEscapeBlocked`, `stopKillsProcessTree`, `networkMatrixBlocked`, `sandboxFailClosed`, and
  `cursorSandboxTrusted`. If `cursorsandbox.exe` is absent, changed, fails to start, or Cursor falls back to
  no-sandbox → execution fails entirely.

Two layers are deliberately coarse: `networkMatrixBlocked` and `configIsolated` each stand for several
sub-checks (the plan's full network matrix — DNS/HTTP/HTTPS/direct-IP/localhost/ports/child/no-sandbox; and
isolated dir + default-deny + disabled MCPs + no `--approve-mcps`). CU-1's suite runner must AND **every**
sub-vector before setting the boolean — not pass on the first.

The result object is what CU-2 persists, bound to the version + platform + arch + descriptor fingerprint;
any change to those inputs invalidates execute qualification.

Intended CU-1 capabilities once reviewer-qualified (matches the `sandbox`-transport shape of Codex in
`server/providers/registry.js`), executor stays empty until CU-2:

```
capabilities: { web: false, projectRead: true, projectTransport: "sandbox", connectors: false, executeModes: [] }
```

## Open questions (need the live Cursor CLI)

CU-0 cannot answer these — they require running Cursor and observing it. Each maps to the layer it proves;
CU-1 runs them and feeds the booleans into `deriveCursorQualification`:

| Question (plan §4) | Proves layer |
|---|---|
| Does `--mode plan` block **all** writes, fail-closed? | `planMode` + `filesystemVerified` |
| Does the Windows sandbox block network/file leaks in every case? | `networkMatrixBlocked` |
| Does the sandbox **fail** rather than silently weaken? | `sandboxFailClosed` |
| Are direct write tools confined to the workspace? | `parentWriteBlocked`, `homeWriteBlocked`, `junctionEscapeBlocked` |
| Is the output schema stable across versions? | fixtures capture (0A) |
| Can Cursor be isolated from user/project config and MCPs? | `configIsolated`, `projectSettingsUntrustedDisabled` |
| Does the `node + index.js` descriptor run without widening the allowlist? | `descriptorValid` (end-to-end) |
| Does Cursor expose enough token usage to measure? | benchmark input (plan §7) |

## Constraints honored

- **Fixtures only.** No provider registry or process-trust change; the two functions are imported only by
  their test, not by any production path.
- **Separate branch.** `spike/cu-0-cursor-qualification`, independent of the hardening PRs.
- **Windows x64 experimental** scope is encoded in the descriptor validator, not just prose.
- **Honest about the CLI.** Every CLI fact is attributed to the plan's prior inspection; nothing is
  presented as a fresh capture from this environment.
