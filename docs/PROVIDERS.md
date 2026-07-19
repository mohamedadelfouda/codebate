# Add a provider or model

## Provider contract

Add one adapter under `server/adapters/`, then register it in `server/providers/registry.js`. A provider definition contains:

- `id`: stable lowercase identifier used in sessions and DOM element IDs;
- `label`: display name;
- `command`: native CLI executable name;
- `commandEnv`: optional host environment variable for a trusted absolute executable path;
- `defaultModel` and `models`: UI defaults/static choices;
- `efforts`: accepted reasoning-effort values;
- `capabilities`: `web`, `projectRead`, `connectors`, and `executeModes`;
- `run(options)`: adapter function;
- optional `discoverModels(options)`.
- optional `updateArgs`; omit it when the CLI has no safe non-interactive self-update command.
- optional `install`: `{ command, url }` install guidance shown by the UI for copy/paste; Codebate never executes it.

If the provider's package manager install hides the native binary behind shell shims (as npm does for Codex on Windows), add its well-known package layout to `server/cli-discovery.js`. Discovery is read-only and bounded to fixed layouts. A native executable found at one of these curated layouts is **auto-trusted** after Codebate verifies it runs (`<cmd> --version` exits 0), so an npm/pnpm/bun-installed provider is detected without a manual step; this is skipped when the user set an explicit command override for that provider. An arbitrary path the user supplies elsewhere still requires explicit **Trust & check** (see below).

The browser reads `GET /api/providers`, so a registered provider automatically appears in collaboration, finalizer, executor, reviewer, health, model, effort, and role controls.

Catalog registration makes a provider visible, but it is not the whole integration. The adapter must implement the capability boundaries it advertises, and its native executable must be the provider's registered command or an explicitly selected canonical absolute path. Collaboration requires at least two enabled providers; debate intentionally requires exactly two.

Bare commands are resolved from the host's native CLI search path. A native executable discovered at a curated package layout (see discovery above) is trusted automatically after a successful `--version` check; a *custom* absolute executable the user supplies is accepted only after the user presses **Trust & check**. Either way the host persists the canonical path and its SHA-256 fingerprint to the trusted-CLI store, so the trust survives a server restart, and re-verifies the executable's identity on each use — a later fingerprint mismatch blocks it until **Trust & check** is run again. Supplying a path in a session request never trusts that path by itself.

## Adapter contract

`run(options)` receives `prompt`, `config`, `cwd`, `onEvent`, and `registerChild`. It returns visible final text plus optional model, effort, duration, exit code, session ID, truncation metadata, and a normalized `usage` record (token counts + optional cost, built with `server/usage.js`'s `buildUsage`, or `null`). It must:

- resolve only its allowlisted native executable;
- call `runProcess` with an argument array and `shell: false`;
- use the `agent` environment policy;
- apply `agentTimeoutMs`;
- surface visible partial output without reasoning/event-stream payloads;
- enforce read permissions and every advertised execution mode in the provider CLI itself; and
- clean temporary files in `finally`.

Keep tool classes separate. A web call must not also receive local project or connector access. Project access should use either a provider-enforced sandbox or Codebate's bounded `project__list_directory`/`project__read_file` broker. Connector access requires a strict per-run MCP configuration; otherwise advertise `connectors: false`.

Add adapter tests for command allowlisting, accepted effort values, output parsing, timeouts/truncation, and every advertised permission mode. Do not add an execution mode to `capabilities.executeModes` until the provider can enforce that boundary.

## Adding model choices

Static model aliases belong in the provider's `models` array. If the CLI exposes a machine-readable catalog, implement `discoverModels`; the UI will show a Load button and call `POST /api/providers/:providerId/models`.

Model IDs are data. Do not add branching by model name to the orchestrator.
