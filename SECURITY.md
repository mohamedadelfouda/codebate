# Security policy

## Report a vulnerability

Do not open a public issue for a vulnerability or exposed credential. Use GitHub's private vulnerability reporting for this repository. Include affected files/version, reproduction conditions, impact, and a minimal safe proof of concept.

## Threat model

Codebate treats project files, filenames, Git metadata, agent output, connector input, and web content as untrusted data. It assumes the local operating-system account, installed provider CLIs, Git executable, and Electron package are trusted.

Primary controls include loopback-only HTTP, host/origin/token checks, strict response headers, explicit project trust, provider command allowlists, `shell: false`, purpose-specific environment allowlists, bounded streams/files/timeouts, Windows Job Object or POSIX process-group containment, one atomic writer per session, disposable execution clones with separate Git objects/refs/configuration, immutable reviewed-tree secret scans, and Git fast-forward acceptance with drift checks plus an index lock across ref/index/working-tree refresh. Connector approvals are atomic, and every external write requires a user decision.

## Important limitations

- Agent output can contain sensitive data and is stored in local session JSON.
- Secret scanning is a defense in depth and cannot identify every credential format.
- A disposable clone isolates new Git objects, refs, and configuration; it does not by itself restrict all filesystem reads.
- The single-writer runtime lock is advisory (no native `flock`, per the zero-runtime-deps rule): it holds "one writer per data folder" with a bounded, self-healing risk window, not a hard kernel guarantee. Keep the data folder on a local disk — file-sync clients (OneDrive, Dropbox, Google Drive, iCloud) rewrite file metadata out of band and can both corrupt the lock and clobber session writes. Codebate warns when it detects a synced data folder but does not block startup.
- Claude currently has no execution mode; its project review uses Codebate's bounded read-only broker with repository settings/hooks disabled.
- Automated Control Repair is permitted only for providers that expose a tool-free repair mode. Claude's read configuration disables all tools and is currently eligible. Codex read-only still permits host-file reads, so Codex Control Repair fails closed as `repair_not_supported` and no repair process is launched. A scratch working directory is not treated as a filesystem-read boundary.
- On macOS/Linux, Codex run execution relies on the Codex `workspace-write` sandbox (writes confined to the workspace, network denied) and keeps web, connectors, and publication outside the agent step. Windows has no in-Codex OS sandbox primitive, so `workspace-write` degrades to read-only there and Codex run execution **fails closed** (is refused) by default. Two explicit, off-by-default operator opt-ins enable it — see "Windows Codex execute confinement" below.
- Cursor is a **review-only** provider (it has no execution mode; `executeModes: []`). A review launches `cursor-agent` in `--mode plan` (read-only) through a fingerprint-pinned trusted-launch descriptor, in a disposable `CURSOR_CONFIG_DIR` with the user's own MCPs/settings off. On macOS/Linux the review runs OS-sandboxed. **On Windows there is no cursor OS sandbox**, so a Windows Cursor review runs unsandboxed with network reachable: it reads the trusted project (in discuss/collaboration/debate, the real project — the same `projectRead` exposure as Codex; in Execute→Review, only the disposable clone) and can make network calls. Write-safety on Windows rests on `--mode plan` (a Cursor product guarantee, not an OS boundary). The disposable `CURSOR_CONFIG_DIR` isolates only the *user's* Cursor config — a project-local `.cursor` (permissions in `.cursor/cli.json`, MCP servers in `.cursor/mcp.json`, rules) is still read from the workspace and honored under `--trust`, so a project-configured MCP server could spawn a subprocess that `--mode plan` does not contain and (on Windows) nothing OS-sandboxes. That project-settings exposure is part of the same accepted residual — a trusted project's own Cursor config is trusted with it, so `projectSettingsUntrustedDisabled` is deliberately not enforced for Cursor. This residual is accepted for the experimental Windows reviewer; enable Cursor only for projects you trust.
- Desktop builds are not automatically trusted by Windows or macOS unless the maintainer configures signing/notarization credentials.
- Gmail access tokens and Supabase keys grant whatever rights their issuer assigned; use the least-privileged credential available.
- Desktop connector secrets rely on the operating system's secure-storage service. Linux `basic_text` storage is rejected rather than treated as encryption.

## Windows Codex execute confinement

Codex execute writes to the disposable clone. On macOS/Linux that is confined by Codex's own `workspace-write` sandbox (filesystem scoped to the workspace, network denied). Windows has no such in-Codex primitive, so execute is refused by default and gated behind one of two explicit, off-by-default operator opt-ins:

- **`CODEBATE_WINDOWS_EXEC_APPCONTAINER=1` (preferred).** The model-run process tree runs inside a Windows **AppContainer** (`Codebate.CodexExec`) layered into the existing Job Object wrapper (`server/windows-job-runner.ps1`). An AppContainer token denies, by default, both the filesystem (only paths whose ACL grants the container SID are reachable) and the network (no `internetClient` capability). Codebate grants that SID only the run's disposable clone and its isolated Codex home — directories it owns and deletes afterward, so **no persistent host ACL change** is made. A prompt-injected model-run command therefore cannot read host secrets (SSH keys, the user's real Codex token, browser stores) or exfiltrate over the network, even though Codex's own `--sandbox` is `danger-full-access`. If the AppContainer cannot be set up or cannot launch the provider, the run **fails closed** (is refused); Codebate never falls back to an unconfined launch.

- **`CODEBATE_ALLOW_UNSANDBOXED_WINDOWS_EXEC=1` (escape hatch, lower priority).** Runs Codex `danger-full-access` with **no** OS confinement — model-run commands get the desktop user's full filesystem and network. Containment then rests only on the disposable clone, project trust, and the MCP/web/features kill-switches, **not** on an OS sandbox. Use only on a machine and projects you fully trust, and only where the AppContainer path cannot launch the provider.

Residual risks of the AppContainer path:

- **Provider reachability.** An AppContainer can only execute files reachable by app containers (System32, typical Program Files installs). A user-local Codex/Node install (for example an npm-global under `%APPDATA%`) is not reachable, so confined execute **fails closed** there rather than running. Install Codex where an app container can read it, or use the escape hatch on a trusted machine.
- **Shared container SID.** A stable container name means concurrent confined runs share one SID; each grants only its own clone, but while both run either clone is reachable by the shared container. Both are disposable clones of the user's own trusted projects and the network is denied, so this is a low-severity residual.
- **Not yet proven end-to-end with a live Codex.** The confinement primitive itself is covered by `test/integration/windows-confinement.test.js` — a synthetic model-run child cannot read a host secret or reach the network but can write its granted clone. A full run with the real `codex.exe` requires a native Codex reachable by an app container and has not yet been exercised in CI; keep this behind the opt-in until that is done before treating it as a default.

## Verifying the Codex kill-switch precedence

Codex run marks the workspace `trust_level = "trusted"` so the executor can write in the clone; the MCP/web/features kill-switches (`-c mcp_servers={}`, `-c features.*=false`, `-c web_search=disabled`) must still win over any Codex config a hostile project might commit. `test/integration/codex-killswitch-precedence.test.js` proves this against the real binary: it plants a config that would launch a sentinel-writing MCP server for a trusted project, runs `codex exec` with our overrides, and asserts the server never launches. Run it on macOS/Linux with an authenticated `codex` on `PATH`:

    npm run test:integration

It skips on Windows (execute is confined/refused there) and when `codex` is absent, and skips as inconclusive if the hostile server does not launch even in the control run.
