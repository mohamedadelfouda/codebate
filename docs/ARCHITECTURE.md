# Architecture

## Runtime

`desktop/main.js` is the Electron main process. It starts `server/index.js` on an ephemeral loopback port, then loads that URL in a sandboxed `BrowserWindow` with Node integration disabled. Source mode can run the same server directly on port `3210` unless `PORT` is set.

`server/index.js` owns HTTP routing, same-origin authorization, server-sent events, lifecycle shutdown, background startup reconciliation, and static files from `public/`. The server starts accepting UI connections before reconciliation completes, while new discussion and execution requests remain gated until recovery finishes. `server/runtime-lock.js` atomically claims the runtime directory before the server listens, so a second live process cannot write the same data. Its heartbeat and the bounded logger state are included in `/api/health`; `/api/diagnostics` downloads a local JSON snapshot with redacted log tails and no automatic upload.

`server/store.js` serializes read-modify-write transitions per session, replaces JSON files atomically, and creates the runtime scratch workspace on demand. `server/session-schema.js` validates the current schema and runs ordered migrations. The original legacy file is backed up before the migrated document replaces it. Malformed or unsupported files stay untouched and appear as recovery records with explicit export, retry, and confirmed-delete routes. The store keeps up to 200 messages and decisions, 50 terminal executions, 100 terminal connector actions, and 200 connector-read audit records while preserving actionable records. Nested metadata and the total session footprint are bounded. Compact summary sidecars make the session list independent of transcript size. Desktop data uses `CODEBATE_RUNTIME_DIR`; source mode uses the repository's ignored `data/`, `logs/`, and `workspace/` folders.

## Collaboration pipeline

`server/orchestrator.js` selects providers from `server/providers/registry.js`. `server/run-state.js` gives each attempt a `runId` and absorbing terminal state; late provider results and old server-sent events are discarded once that attempt stops, fails, completes, or is replaced. A provider failure fences its siblings before one terminal error is persisted. Startup reconciliation marks an orphaned stored run as interrupted exactly once.

A trusted project produces one bounded shared evidence pack through `server/project.js`. First collaboration opinions run concurrently from the same immutable snapshot, so neither opening receives the other provider's new answer. Later rounds receive the shared history and end in a validated `<agent-control>` JSON block.

`server/convergence.js` validates the version 2 control contract. Agents propose item changes through `itemProposals`; deterministic assessment applies valid proposals to the official `itemRegistry` and derives `nextSteps` and completion from its open items. Required-step precedence is agent work (`incomplete`), external validation (`blocked`), then a user decision (`needs_user`), independent of registry order. Agents cannot close or merge an official item by omission, and closing or merging an existing item requires the same explicit action from every participant. A terminal claim that omits an open item is rejected before registry application. Stored unversioned controls with `openPoints` remain readable, but their unclassified points cannot create an early stop.

Agreement and completion are assessed separately. Early stop requires every participating provider to supply a valid current control, report no substantive delta, report convergence without a genuine disagreement, and leave no open item requiring another agent round. An agreed result may stop as `satisfied`, `needs_user`, `blocked`, or as settled-but-`incomplete` when no official agent work remains. Missing, invalid, stale, or contradictory control data fails closed.

For the closed set of representational control errors, `server/orchestrator.js` may make one bounded repair call per affected participant only when that provider advertises a tool-free repair mode. Claude currently supplies that mode; Codex repair fails closed as `repair_not_supported` because a read-only Codex sandbox still permits host-file reads. Eligible repair runs in the scratch workspace with read-only permission, no tools, connector, or MCP session, a sanitized agent environment, a 60-second timeout, and a 64 KiB output limit. A narrow repair must preserve every unaffected control field and proposal; malformed or missing controls may be regenerated but still pass the normal validator and multi-participant consensus rules. The original reader-facing answer is never replaced. Bounded audit metadata is stored under `message.meta.controlRepair`, and aggregate call, duration, result, error-code, and real provider-usage data is stored under optional `officialOutcome.controlRepairStats`. The orchestrator stores the approved outcome with the system message before asking the finalizer to explain it, so repair output and finalizer prose cannot change the official result independently.

`public/app.js` renders one round-summary card for the latest user run. New sessions read the persisted outcome directly and show localized agreement, completion, stop reason, pending categories, and derived next steps. Legacy sessions fall back to their stored report and `openPoints` without rewriting session files.

## Execution pipeline

`server/executor.js`, `server/exec-orchestrator.js`, `server/acceptance.js`, and `server/worktree.js` implement the lifecycle documented in [EXECUTION.md](../EXECUTION.md). Each writer receives a disposable independent clone whose Git objects and refs stay outside the project repository. The reviewed tree is imported only after acceptance under an exact private ref. Raw child processes are centralized in `server/process.js`, which preserves argument boundaries with `shell: false`, bounds output, sanitizes agent environments, applies timeouts, and contains descendant processes with Windows Job Objects or POSIX process groups.

## Connector pipeline

`server/connectors/registry.js` defines connector actions and whether they change external state. `server/connectors/service.js` enforces per-session opt-in and atomically claims each approval before its side effect. `server/connector-config.js` serializes host credential updates; the desktop main process persists them with Electron `safeStorage`. `server/mcp-server.js` is a credential-free stdio proxy. It forwards bounded requests through an authenticated, per-run loopback grant to the host process, where sessions and connector credentials remain available.

Read-only connector calls write metadata-only audit records; raw responses and credential fields are excluded. Connector readiness distinguishes configuration/authentication from availability, and expected input, conflict, missing-action, and external-service failures use stable non-500 contracts.

Claude receives a strict per-run MCP configuration containing only Codebate's broker. Project-read, web, and connector calls are separated so a single model call cannot combine local files with external tools. Codex does not receive automatic connector injection because its current CLI configuration has no equivalent strict per-run MCP-only flag; Codex project calls also disable web. This avoids silently loading unrelated MCP servers.

## Extension boundaries

- Provider-specific CLI flags and output parsing stay in `server/adapters/`.
- Provider catalog metadata and supported modes stay in `server/providers/registry.js`.
- Connector schemas and external calls stay in `server/connectors/`; encrypted persistence stays in the Electron main process.
- Approval, retry, and session persistence stay outside adapters and connectors.
- Browser code consumes public catalogs; it does not contain the source of truth for providers or actions.
- Native provider paths — approved explicitly via **Trust & check**, or auto-trusted after a verifying `--version` run when discovered at a curated npm/pnpm/bun package layout — are persisted with a SHA-256 executable fingerprint. A later identity mismatch blocks use until the user runs **Trust & check** again.
