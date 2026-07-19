# Codebate Source-Run Remediation Plan

**Status:** Implemented on `codex/source-run-remediation` and under PR review. The §16 acceptance matrix is the sign-off checklist: its automated rows are backed by the CI gates (`pnpm check` / `test` / `lint` / `test:coverage` / `test:smoke` / `test:browser`), and each box is checked only as it is verified during review rather than assumed complete. This document remains the scope and acceptance record.

**Baseline:** Start implementation from a new clean branch based on the current `origin/main`. The convergence and decision work from PR #21 must already be present.
**Operating model:** Users clone the repository and run the browser-facing loopback server from source. Native installers and published application releases are intentionally outside this plan.

---

## 1. Decision and scope

The near-term product is the repository-hosted local server:

```text
clone repository
→ prepare the source checkout
→ run the loopback server
→ open http://127.0.0.1:3210
→ use locally installed Claude Code / Codex CLIs
```

The target end-user setup flow is:

```bash
corepack enable
pnpm install --prod --frozen-lockfile --ignore-scripts
pnpm start
```

This command sequence was validated from a clean temporary source copy. The CI source-smoke matrix repeats it on Windows, macOS, and Linux before accepting future changes.

Developers still need the development dependency set to run checks and tests:

```bash
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test
```

The existing CI already uses Node.js 22, pnpm 10.12.1, `pnpm check`, and `pnpm test`. Those facts are verified in `package.json`, `README.md`, and `.github/workflows/ci.yml`.

### Included

- Discussion-orchestrator concurrency, cancellation, and terminal-state correctness.
- Validation of participants, modes, rounds, and finalizer input.
- Independence of the first collaboration opinions.
- Session schema versioning, migration, backup, corruption visibility, and recovery.
- Protection against two server processes writing the same runtime data.
- Responsive browser UI, keyboard behavior, accessibility checks, and control-state synchronization.
- Connector read auditing, readiness, error contracts, and permission clarity.
- Codex credential-containment tests and trusted-executable hardening.
- Bounded logs, diagnostic health, and source-server recovery behavior.
- Targeted test coverage, browser tests, linting, dependency hygiene, and source-run CI.
- Current-behavior documentation and removal of stale documentation claims.
- Incremental extraction of stateful logic touched by the fixes.

### Explicitly excluded

The implementation tool must not spend time on any of the following in this remediation:

- Electron packaging or `pnpm package` / `pnpm make`.
- Native installers.
- Windows or macOS signing/notarization.
- Auto-update or manual update feeds.
- Release channels, tags, GitHub Releases, release notes, or version promotion.
- Installer smoke tests.
- Artifact checksums, SBOM publication, or binary-size work.
- Whether an unsigned build can be published.
- Release-only documentation or workflow redesign.

The existing desktop files are not to be deleted merely because distribution is deferred. They are left untouched unless a source-server fix necessarily shares code with them.

### Also excluded from remediation scope

These are future product features rather than defects:

- Cursor or a third provider.
- Three-peer, judge, or critic protocols.
- Cloud sync, teams, accounts, or telemetry.
- A general workflow/task engine.
- A full JavaScript-to-TypeScript conversion.

They should be considered only after every mandatory gate in this plan passes.

---

## 2. Non-negotiable architectural invariants

The fixes must preserve the following contracts.

### Decision authority

1. Agent output remains a proposal.
2. The deterministic assessment remains the only authority that changes official `itemRegistry` state.
3. `nextSteps` remains derived from the approved registry.
4. The finalizer remains explanatory and cannot change the official outcome.
5. Omission never resolves an official item.
6. Existing unanimous resolve/merge rules remain intact.

### Human control

1. Discussion remains read-only against a trusted project.
2. Execution remains separate from discussion.
3. State-changing connector actions still require explicit approval.
4. Uncertain connector side effects are never retried automatically.
5. No fix may introduce a hidden publish or auto-accept path.

### Privacy and security

1. The server remains loopback-only.
2. Host, Origin, CSRF, cookie, and CSP protections stay enabled.
3. Provider commands remain allowlisted and shell-free.
4. Provider, connector, GitHub, and publication environments remain isolated.
5. Connector-read audit records store metadata, not sensitive response bodies or credentials.
6. No telemetry is added.

### User interface

1. The decision experience remains one latest-position card per provider plus one official outcome.
2. The decision card's meaning and data contract must not be redesigned in this remediation.
3. Responsive work may change the surrounding shell, drawers, and controls, but not the official outcome semantics.
4. Arabic and English remain feature-equivalent.

### Data safety

1. Existing readable sessions remain readable.
2. Migrations never overwrite the only copy of a session.
3. Corrupt data is quarantined or reported, never silently deleted.
4. Terminal states are absorbing for a specific run attempt.

---

## 3. Implementation strategy

Do not implement the entire plan as one unreviewed rewrite. Use the phases in order because later phases depend on invariants established earlier.

Recommended change groups:

1. Runtime integrity and API validation.
2. Session storage, migration, and recovery.
3. Responsive UI and browser tests.
4. Connector, security, diagnostics, dependency, and documentation hardening.

Each group must keep the full test suite green. If the work is split across pull requests, each pull request must be independently safe and must follow `.review-gate/GATE.md` for its exact final commit.

### Working-tree rule

- Start from a new branch based on the latest `origin/main`.
- Do not reset, clean, or overwrite unrelated local changes.
- Do not modify the user's decision-card work unless a specific acceptance criterion requires it.
- Before editing a file, inspect its current diff against `origin/main`.
- No commit or push is required by this plan itself; if requested later, run the mandatory review gate exactly as documented in `.review-gate/GATE.md`.

---

## 4. Phase 0 — Baseline, failing regressions, and guardrails

### Objective

Capture the current behavior before fixing it and prevent later refactors from hiding regressions.

### Tasks

#### 0.1 Verify the implementation baseline

- Fetch without merging into a dirty tree.
- Confirm the new branch is based on current `origin/main`.
- Confirm PR #21's convergence changes exist.
- Run the current commands:

```bash
pnpm check
pnpm test
```

- Record the test count and exit codes in the implementation PR description; do not hard-code the count into permanent documentation.

#### 0.2 Add the known failing race test first

Add a focused Node test under the existing `test/unit/` tree. The exact filename is implementation-defined; `test/unit/orchestrator-race.test.js` is a proposed name, not an existing file.

The test must use controlled fake adapters:

- provider A rejects quickly;
- provider B resolves later;
- both run in the same parallel phase;
- persisted session state and emitted events are captured.

The test must demonstrate the pre-fix failure:

- `run_error` occurs;
- a late completion attempts to persist;
- the final status must never be `running` after the fix;
- no accepted `agent_complete` appears after the terminal event for the same run.

Do not weaken the assertion to match the current broken behavior.

#### 0.3 Add the cancellation race test

Use a provider promise that resolves at the same time as `stopRun`:

- start the provider call;
- request stop;
- let the provider resolve;
- assert no late agent message is accepted;
- assert exactly one stopped terminal event;
- assert the persisted status remains stopped.

#### 0.4 Capture existing UI behavior

Before responsive edits, add screenshots or DOM assertions for:

- desktop RTL;
- desktop LTR;
- 980×680 with context closed;
- 980×680 after pressing the context toggle;
- 800×600 shell layout.

The current broken 980px result should be represented as a failing behavioral assertion, not accepted as a golden screenshot.

### Exit gate

- Current suite passes before the new regression assertions.
- New regression tests fail for the intended reason.
- No production behavior has changed yet.

---

## 5. Phase 1 — Orchestrator run integrity

### Objective

Make one discussion attempt a coherent state machine. A stale provider completion must not write after failure, stop, completion, or replacement by a newer attempt.

### Current fault to remove

`server/orchestrator.js` currently:

- runs several phases through `Promise.all`;
- checks cancellation only before a provider call;
- lets `callAgent` persist after the provider returns;
- copies `session.status` from a stale orchestration snapshot in `mergeOrchestrationState`;
- writes the error state independently in the outer catch.

This allows `error → running` and late `agent_complete` persistence.

### Required invariants

For each run attempt:

1. Exactly one `runId` identifies the attempt.
2. At most one active run exists per session.
3. `completed`, `error`, and `stopped` are terminal for that `runId`.
4. A terminal state cannot return to `running`.
5. A provider result is persisted only while its `runId` is still current and non-terminal.
6. Exactly one terminal event is emitted for a run.
7. Events belonging to an old run cannot alter the current UI state.
8. Connector or user-decision updates made during a run are preserved.

### Tasks

#### 1.1 Introduce an explicit run-attempt model

Create a small state-transition module rather than adding more conditions directly to the existing orchestrator. A proposed path is `server/run-state.js`.

The model should define:

- run ID creation;
- active and terminal states;
- allowed transitions;
- stale-attempt rejection;
- a single helper for terminalization;
- an explicit result when a mutation is ignored because the attempt is stale.

Use `crypto.randomUUID()` or an equally collision-resistant local identifier already available in the Node runtime.

#### 1.2 Persist attempt identity

Store enough run metadata in the session to distinguish:

- current run ID;
- mode;
- start time;
- terminal state and end time;
- interruption reason when applicable.

The exact field name is part of the schema work. A proposed shape is:

```json
{
  "activeRun": {
    "runId": "uuid",
    "mode": "collaboration",
    "status": "running",
    "startedAt": "ISO-8601"
  }
}
```

This is a proposed contract. Final field names must be validated against all current session readers before implementation.

#### 1.3 Stop copying stale status

Replace the unconditional status assignment in `mergeOrchestrationState`.

Message merging may remain ID-based, but status changes must go through the run-state transition helper. No generic merge function may downgrade a terminal status.

#### 1.4 Fence every provider completion

After the provider returns and before parsing or saving its result:

- verify the attempt is still current;
- verify cancellation has not been requested;
- verify no terminal state has been persisted;
- otherwise discard the result and emit no `agent_complete`.

The provider process must still be cleaned up even when the result is discarded.

#### 1.5 Settle parallel siblings deliberately

Replace fail-fast persistence behavior with explicit coordination:

- capture all provider outcomes with `Promise.allSettled` or an equivalent coordinator;
- on the first real failure, mark the run as cancelling/error-pending once;
- terminate known sibling process trees;
- wait for siblings to settle;
- persist one terminal error;
- discard stale successful results that completed after failure.

Do not concatenate two provider failures into uncontrolled user-facing text. Store one safe primary error and optionally bounded, redacted diagnostic metadata for the others.

#### 1.6 Make stop deterministic

`stopRun` must:

- claim cancellation once for the current `runId`;
- reject repeated stop calls idempotently;
- terminate known process trees;
- wait for outstanding provider promises to settle or hit a bounded timeout;
- persist one `stopped` terminal state;
- emit one `run_stopped` event.

A stop request must not be reported as a provider error.

#### 1.7 Scope SSE events by run

Include `runId` in discussion lifecycle events:

- `run_started`;
- `agent_start`;
- `agent_complete`;
- `run_complete`;
- `run_error`;
- `run_stopped`.

Update `public/app.js` so transient UI state changes only for the current run. A `session_updated` event still triggers an authoritative reload.

#### 1.8 Reconcile interrupted discussions at startup

Execution worktrees already have startup reconciliation in `server/exec-orchestrator.js`. Add a smaller discussion reconciliation path:

- if a stored session says a discussion is running but there is no in-memory active run after server startup, mark the attempt interrupted;
- add one bounded system message explaining that the previous server process stopped;
- do not invent agent output;
- allow the user to start a new run.

The recovered state should be `error` or a new explicitly supported terminal interruption state. Do not add a new enum unless all current readers and localized labels are updated.

### Tests

Add coverage for:

- one provider fails, sibling succeeds late;
- both providers fail in different orders;
- stop before provider start;
- stop while both providers run;
- provider resolves during stop;
- old run result arrives after a new run starts;
- connector decision is saved during a discussion and survives orchestration persistence;
- server restart with a stored running discussion;
- exactly one terminal event per run;
- terminal state never transitions back to running.

Run the race scenarios repeatedly in-process to catch ordering errors. Avoid sleep-heavy tests; use controlled promises and barriers.

### Exit gate

- The reproduced race is fixed.
- The cancellation race is fixed.
- All run-state invariants have tests.
- Current convergence, execution, connector, and UI unit tests remain green.

---

## 6. Phase 2 — Request validation and discussion semantics

### Objective

Reject invalid requests before any provider starts and make initial opinions genuinely independent.

### Tasks

#### 2.1 Validate the entire request before setting status to running

Validate:

- mode is supported;
- round count is within the existing bounded range;
- every selected provider exists;
- every selected provider is available for the requested capability;
- required participant cardinality is met;
- agent roles are bounded strings;
- finalizer is `none` or one of the selected providers;
- the session is not already running or executing.

No provider process, session mode change, or running status may occur before validation succeeds.

#### 2.2 Use stable API errors

The project already has `apiErrorPayload` and `expectedApiError` in `server/api-errors.js`. Extend the current error contract rather than inventing ad hoc response shapes.

Use appropriate statuses:

- 400 for malformed or unsupported input;
- 404 for a missing session/resource;
- 409 for a valid request conflicting with current session state;
- 503 for a temporarily unavailable required provider or startup recovery.

Add stable error codes such as proposed `invalid_finalizer`, `invalid_participants`, and `provider_unavailable`. Exact names must be added to the localization/error mapping tests.

#### 2.3 Make first collaboration opinions independent

The current first collaboration round is sequential. Change it to use one immutable session snapshot, matching the independence already used for debate openings:

- both providers receive the same bounded evidence pack;
- neither receives the other provider's first response;
- later rounds receive the shared results and can react.

This aligns the implementation with the product goal of obtaining multiple opinions rather than order-biased co-authoring.

#### 2.4 Preserve convergence authority

Do not change:

- version 2 agent-control parsing;
- deterministic `itemRegistry` updates;
- unanimous resolve/merge rules;
- derived `nextSteps`;
- finalizer's explanatory role.

### Tests

- invalid finalizer is rejected before provider invocation;
- unknown provider is rejected;
- insufficient participants are rejected;
- unsupported mode/round count is rejected;
- both first-round collaboration prompts are built from the same snapshot;
- neither first response contains the other provider's new message;
- later collaboration rounds still see both earlier responses;
- existing convergence tests remain unchanged and green.

### Exit gate

- Invalid requests fail before side effects.
- Initial opinions are independent.
- API errors are stable, localized, and tested.

---

## 7. Phase 3 — Session schema, migration, locking, and recovery

### Objective

Make local JSON storage safe across code evolution, process duplication, corruption, and interruption.

### Tasks

#### 3.1 Add a top-level session schema version

Add `sessionSchemaVersion` to newly created sessions in `server/store.js`.

Create a proposed `server/session-schema.js` module that owns:

- current schema version;
- structural validation;
- migration registration;
- migration execution;
- safe defaults for optional fields;
- rejection of unsupported future schemas.

Do not make `store.js` silently repair arbitrary malformed content.

#### 3.2 Implement ordered migrations

Migrations must be sequential:

```text
unversioned legacy → version 1 → version 2 → current
```

Each migration must:

- accept one known previous version;
- produce one next version;
- be deterministic and idempotent at the file-operation level;
- preserve unknown safe metadata where possible;
- never reinterpret legacy prose as official convergence state;
- retain legacy `openPoints` compatibility already promised by the convergence work.

#### 3.3 Back up before first write of migrated data

Before replacing a legacy session:

- write an atomic backup with a bounded retention policy;
- verify the migrated JSON serializes and passes schema validation;
- replace the main file atomically;
- keep the backup if replacement fails;
- never delete the source as part of error handling.

Backups must remain under the controlled runtime directory and use safe filenames derived from the validated session ID.

#### 3.4 Quarantine corrupt sessions visibly

`listSessions` currently skips unreadable session JSON. Replace silent disappearance with a bounded recovery record:

- preserve the corrupt file;
- record its safe filename, detection time, and parse error category;
- never expose arbitrary raw file content in the UI;
- show a localized “session needs recovery” entry or recovery panel;
- allow export of the original file only through an explicit user action;
- allow deletion only through an explicit confirmation.

Do not repeatedly create duplicate quarantine records on every list refresh.

#### 3.5 Add a runtime single-writer lock

Protect the entire `CODEBATE_RUNTIME_DIR`, not only individual files inside one Node process.

A proposed `server/runtime-lock.js` should:

- atomically acquire a lock before the server begins accepting mutations;
- record PID, creation time, and a random process token;
- reject a second live server using the same runtime directory;
- distinguish an active lock from a stale lock;
- recover stale locks without deleting a lock owned by a live process;
- release the lock on graceful shutdown;
- leave a stale lock recoverable after crash.

Do not use an unverified “PID exists” check alone across platforms. Combine process identity with token/time and atomic ownership rules.

#### 3.6 Keep existing in-process write serialization

The current per-file `writeLocks` and atomic replace behavior remain useful. Runtime locking supplements them; it does not replace atomic writes or `mutateSession` serialization.

#### 3.7 Add recovery/export controls

Add a minimal UI/API path to:

- list recovery records;
- export a selected original corrupt file;
- retry migration after code is updated;
- delete a quarantined file with confirmation.

No bulk destructive action is needed.

### Tests

- unversioned session migrates and remains readable;
- migration backup is created before replacement;
- interrupted replacement preserves original or backup;
- invalid future schema is not rewritten;
- malformed JSON appears as recovery-needed rather than disappearing;
- repeated list calls do not duplicate recovery records;
- two server instances cannot mutate the same runtime directory;
- stale lock recovery works on Windows, macOS, and Linux paths;
- live lock is never stolen;
- connector decisions and execution records survive migration;
- size and history bounds still apply after migration.

### Exit gate

- Existing sessions remain readable.
- Corrupt sessions are visible and recoverable.
- Two writers cannot use the same runtime directory.
- No migration can destroy the only copy of data.

---

## 8. Phase 4 — Responsive UI, control state, and accessibility

### Objective

Make the browser UI usable from narrow windows without changing the decision model or breaking the user's decision-card work.

### Current faults to remove

- `toggleContextColumn` applies `.open` while also applying `html.context-hidden`.
- `html.context-hidden .context-col { display: none !important; }` wins, so the column stays hidden under the responsive breakpoint.
- `@media (max-width: 860px)` still references `.app` and `.sessions`, while the current shell uses `.shell` and `.rail`.
- the workflow column disappears without an equivalent narrow-layout control.
- opening a running session does not synchronize `attachBtn` in `loadSession`, although `setRunning` does.

### Tasks

#### 4.1 Separate desktop persistence from narrow-layout overlays

Use distinct states:

- desktop context preference: persisted collapsed/visible grid column;
- narrow context drawer: transient open/closed state;
- narrow workflow drawer: transient open/closed state;
- rail drawer: transient open/closed state where required.

Do not use one class to mean both “desktop column hidden” and “mobile drawer open.”

#### 4.2 Fix shell selectors and layout

- remove or replace dead `.app` and `.sessions` responsive selectors;
- target the current `.shell` and `.rail` structure;
- keep the main conversation/decision area at full usable width;
- move low-priority topbar actions into an accessible overflow control when necessary;
- keep the session title visible or provide a non-destructive truncation with accessible full text.

#### 4.3 Add narrow-layout access to context and workflow

- context opens as a drawer/overlay below the desktop breakpoint;
- workflow opens through an explicit button rather than becoming inaccessible;
- opening one overlay closes conflicting overlays;
- Escape closes the active overlay;
- focus moves into the opened overlay and returns to its trigger on close;
- background interaction is blocked only while a modal-style overlay is open.

#### 4.4 Synchronize all activity controls

Create one control-state application function used by both `loadSession` and live events.

It must update:

- message input;
- send button;
- attachment button;
- discussion stop;
- execution stop;
- execute button;
- export button where appropriate.

No control may depend on whether the user witnessed the original `run_started` event.

#### 4.5 Preserve the decision card

Responsive work may change card width, wrapping, and surrounding placement only. It must not change:

- source of official outcome;
- one-card-per-provider behavior;
- latest-run filtering;
- item registry or next-step rendering semantics;
- Arabic/English labels unless fixing a verified localization defect.

If a semantic card change becomes necessary, stop and request explicit approval before implementing it.

#### 4.6 Add browser-based accessibility checks

Introduce a browser E2E runner as a development dependency. Playwright is a suitable option, but the exact package is an implementation choice and does not exist in the current manifest.

Test:

- keyboard-only creation of a session;
- tablist arrow navigation;
- modal focus trap and focus return;
- drawer open/close and Escape;
- no horizontal document overflow at 800×600 and 980×680;
- context and workflow are reachable at narrow widths;
- RTL and LTR screenshots;
- 200% zoom/reflow for the main path;
- accessible names and selected/pressed state;
- reduced-motion behavior.

Add an automated accessibility scanner if it can run deterministically without replacing manual keyboard assertions.

### Acceptance viewports

At minimum:

- 1676×1216, Arabic and English;
- 1280×800, Arabic and English;
- 980×680, Arabic and English;
- 800×600, Arabic and English.

### Exit gate

- context opens and closes correctly at 980px;
- workflow remains reachable at narrow widths;
- no dead responsive selectors remain;
- all activity controls synchronize after opening any session;
- decision-card semantics are unchanged;
- browser tests pass in RTL and LTR.

---

## 9. Phase 5 — Connector transparency and API correctness

### Objective

Keep connector side effects safe while making read access, readiness, and failures visible and predictable.

### Tasks

#### 5.1 Persist metadata-only read audit records

When a read-only connector action executes, record:

- audit ID;
- session ID;
- connector ID;
- action ID;
- requested time and completed time;
- bounded, redacted input summary;
- success/failure status;
- bounded error code when failed.

Do not persist:

- access tokens;
- authorization headers;
- raw email bodies;
- arbitrary database result bodies;
- provider-returned secrets.

Keep the existing bounded history behavior. Pending state-changing proposals must still receive priority over old terminal audit records.

#### 5.2 Show connector grants clearly

Before enabling a connector, show:

- available read capabilities;
- available state-changing capabilities;
- whether writes require approval;
- what audit metadata is stored;
- how to disable the connector for the session.

The copy must be localized and must not imply that enabling a connector grants only write proposals if reads can happen immediately.

#### 5.3 Make GitHub readiness truthful

Replace unconditional configured status with actual checks for:

- native `gh` executable availability;
- authentication readiness;
- required command capability.

Expose distinct states such as installed, authenticated, and ready. Do not run state-changing commands as a health check.

#### 5.4 Resolve Gmail access-token ambiguity

For this source-run stabilization, keep raw access-token mode explicitly experimental:

- show that the token may expire;
- report authentication expiry as a stable readiness error;
- never claim durable OAuth support;
- provide a clear reconfiguration path;
- keep credentials in environment/secret storage only.

Implementing a full OAuth refresh flow is a separate feature and is not required to close this remediation item as long as the current limitation is explicit and correctly handled.

#### 5.5 Add Supabase least-privilege guidance

In connector setup and documentation:

- recommend a restricted key and RLS;
- warn against broad service-role credentials;
- display the configured host without displaying the key;
- keep loopback/private-host validation behavior consistent with the current configuration code.

#### 5.6 Map connector failures to stable statuses

Current connector routes often return 500 for all service errors. Introduce typed expected errors and map them consistently:

- 400: invalid connector/action/input;
- 404: missing session/action;
- 409: disabled connector, already-decided proposal, or conflicting state;
- 503: configured dependency unavailable or authentication not ready;
- 500: unexpected internal failure only.

Keep `apiErrorPayload` as the response-shape source.

#### 5.7 Preserve exactly-once side-effect behavior

Do not change the existing `pending → executing_unknown → terminal` safety rule. Add tests proving new audit writes cannot cause a state-changing connector action to execute twice.

### Tests

- read audit success and failure;
- credentials and response bodies are absent from stored audit records;
- audit history bounds;
- GitHub missing CLI, unauthenticated CLI, and ready CLI;
- Gmail expired token readiness message;
- Supabase setup copy and redaction;
- connector HTTP status/error-code matrix;
- repeated approval does not repeat a side effect;
- restart preserves `executing_unknown` without retry.

### Exit gate

- every connector read is visible through safe audit metadata;
- readiness reflects reality;
- normal input/auth/state errors are not reported as generic 500s;
- connector writes remain exactly-once and approval-gated.

---

## 10. Phase 6 — Security hardening for source execution

### Objective

Turn two security assumptions from “careful design” into executable guarantees.

### Tasks

#### 6.1 Add adversarial Codex credential-containment tests

The Codex adapter creates an isolated temporary `CODEX_HOME` and copies `auth.json` into it. Add tests that attempt, through the same command/sandbox path used by the product, to:

- read the temporary `auth.json`;
- read the original user `CODEX_HOME/auth.json`;
- copy either file into the project/workspace;
- reach the file through a symlink;
- echo recognizable credential markers into provider output.

Run the tests for the discussion read-only boundary and execution workspace-write boundary where the local CLI supports deterministic testing.

The assertions must prove that secrets do not reach:

- agent-visible output;
- persisted session messages;
- logs;
- accepted project changes.

If the underlying CLI cannot provide a deterministic offline test, document the exact unverified boundary and add the strongest host-side containment check possible. Do not claim proof that was not obtained.

#### 6.2 Fingerprint trusted provider executables

When the user approves a discovered native CLI path, store and validate a file identity:

- canonical path;
- size;
- modification time;
- cryptographic digest where practical;
- platform-specific signature metadata only if reliably available.

Before execution:

- re-resolve the canonical path;
- reject symlink replacement;
- compare the current identity to the approved identity;
- require re-approval when it changes.

Do not treat a pathname alone as permanent trust.

#### 6.3 Keep secret scanning conservative

Do not expand the scanner with speculative patterns that create broad false positives. Add a new pattern only with:

- positive fixtures;
- negative fixtures;
- a documented detection contract;
- no claim that every generic token/JWT is detectable.

#### 6.4 Re-test existing boundaries

The security regression suite must continue to cover:

- loopback Host/Origin/CSRF checks;
- environment allowlists;
- process argument boundaries;
- project realpath/symlink validation;
- secret redaction;
- markdown escaping and safe links;
- execution clone isolation.

### Exit gate

- Codex credential containment has executable evidence or an explicitly documented remaining limitation.
- a changed trusted executable requires re-approval;
- all existing security tests remain green.

---

## 11. Phase 7 — Logs, health, and operational recovery

### Objective

Keep diagnostics bounded and make failures visible without telemetry or secret leakage.

### Tasks

#### 7.1 Add bounded log rotation

Replace unlimited append-only growth in `server/logger.js` with local rotation:

- bounded maximum file size;
- bounded number of retained files;
- atomic or serialized rotation;
- safe behavior when rotation itself fails;
- no recursive logging loop.

Choose conservative bounds and cover them with tests. Do not put machine-specific absolute paths in public messages.

#### 7.2 Surface logging health

The current logger swallows directory/append failures. Preserve server availability, but expose a bounded health state:

- last logging failure category;
- last failure time;
- no sensitive path or payload by default;
- reset after a successful write if appropriate.

Include the status in the existing `/api/health` response only after verifying all consumers tolerate the additional fields.

#### 7.3 Add explicit local diagnostics export

Provide a user-triggered export that includes only:

- application/server health summary;
- provider readiness summary;
- bounded recent redacted logs;
- schema/runtime-lock status;
- session ID only when the user includes it.

Before saving, show what categories will be exported. Never auto-upload the bundle.

#### 7.4 Handle disk and permission failures

Add tests or fault injection for:

- log directory unwritable;
- session directory unwritable;
- disk-full-like write failure;
- backup write failure;
- quarantine directory failure.

The server must return a stable error and preserve the last known good session file.

### Exit gate

- logs are bounded;
- logging failure is observable;
- diagnostics contain no known secrets;
- storage failures do not destroy the last good session.

---

## 12. Phase 8 — Source-run dependency, quality, and CI gates

### Objective

Make the clone-and-run path minimal and continuously verified without introducing release work.

### Tasks

#### 8.1 Validate production-only installation

In a clean temporary clone on Windows, macOS, and Linux:

```bash
corepack enable
pnpm install --prod --frozen-lockfile --ignore-scripts
pnpm start
```

Assert:

- server reaches `/api/health` on loopback;
- static UI loads;
- missing provider CLIs produce setup/readiness UI rather than startup failure;
- no Electron postinstall is required for server startup.

Only after this passes should README make production-only install the default user path.

#### 8.2 Separate user and contributor instructions

- user path: production-only install and server start;
- contributor path: full dev install, checks, tests, and optional browser-test setup;
- provider prerequisites remain explicit;
- the source-run path must not mention installers, signing, auto-update, or releases.

#### 8.3 Remove confirmed unused dependencies

Remove `lodash` only after a repository-wide search confirms there is no runtime, script, config, or test import.

Do not remove or reorganize Electron/Forge dependencies in this remediation; they are deferred with the desktop path. Production-only source installation must avoid installing them.

#### 8.4 Scope dependency security correctly

Add a CI audit for the production/source-server dependency graph. Since the current manifest has no production dependencies, the command and expected result must be verified after all plan changes rather than assumed.

Desktop-only transitive advisories are not a source-server blocker in this plan, but they must not be mislabeled as production runtime vulnerabilities.

#### 8.5 Add a linter without mass rewrite

Introduce a minimal JavaScript linter configuration for:

- `server/`;
- `public/`;
- `scripts/`;
- tests.

First run it in report mode, fix real defects, then add it to CI. Avoid a repository-wide formatting rewrite in the same change.

#### 8.6 Add targeted coverage gates

Add a coverage command using Node's supported coverage path or a small compatible tool. Gates should emphasize critical modules rather than only a global number:

- orchestrator and run-state transitions;
- executor and execution orchestrator failure paths;
- store/schema/migration/lock;
- connector service;
- security and convergence remain highly covered.

Do not add tests that only execute lines without asserting behavior.

#### 8.7 Add browser E2E to CI

- run browser UI tests on one primary CI operating system;
- retain current unit/integration matrix on all three operating systems;
- cache browser binaries only if the cache key is pinned and safe;
- upload screenshots only on failure;
- do not require real Claude/Codex credentials.

#### 8.8 Add source-server smoke test

Create a CI job that:

- starts the server on an available loopback port;
- waits with a bounded timeout;
- requests `/api/health`;
- requests the main page;
- stops the server and verifies clean shutdown.

This is a source-server test, not a packaged-app test.

#### 8.9 Add bounded fault/soak jobs

Create a non-default or scheduled test group for:

- repeated race permutations;
- 100+ session summaries;
- a session near the 200-message bound;
- restart during a running discussion;
- lock contention;
- migration of a fixture set;
- log rotation;
- provider timeout/output-limit behavior.

Keep regular pull-request CI fast; run the heavier job on demand or on a schedule.

### Exit gate

- clean clone starts the server through the documented user path;
- current unit matrix stays green;
- lint and source-server smoke are required CI checks;
- browser E2E covers the responsive regressions;
- critical stateful modules meet behavior-based coverage targets.

---

## 13. Phase 9 — Incremental maintainability cleanup

### Objective

Reduce state-management concentration only where the remediation already touches code. Avoid a broad rewrite.

### Required extractions

Proposed modules, subject to final code-shape review:

- `server/run-state.js`: run-attempt transitions and stale-write fences.
- `server/session-schema.js`: version validation and migrations.
- `server/runtime-lock.js`: process-level runtime ownership.
- `server/diagnostics.js`: bounded health/diagnostic assembly.
- `public/shell-layout.js`: responsive shell/drawer state if it can remain DOM-focused and small.

### Rules

- Extract after characterization/regression tests exist.
- Keep public behavior unchanged during pure extraction commits.
- Do not split `server/worktree.js` merely to reduce line count; it is complex but comparatively well tested.
- Do not convert the project to a framework or bundler solely to split `public/app.js`.
- Prefer pure helpers and explicit state transitions over new classes or abstractions with one caller.
- Remove dead responsive selectors and dead code found by the new linter.

### Accepted residual risks

Large files that remain coherent and well tested are maintenance concerns, not launch defects. They do not block completion of this plan if the risky mutable state has been extracted and no duplicate logic remains.

The trusted-CLI identity check in `server/process.js` keeps an accepted time-of-check/time-of-use gap between fingerprint verification and process spawn. There is no portable way to exec a verified file handle (no `fexecve`), callers spawn the resolved path immediately (a microscopic window with no intervening await), and exploiting the gap already requires write access to the trusted CLI path — a stronger foothold than the swap itself. A copy-and-exec from a private path would be disproportionate to that risk.

The single-runtime lock in `server/runtime-lock.js` is a portable, advisory heartbeat lock, not an OS-enforced one. On Linux it verifies process identity with a start token; on Windows/macOS, where no portable start token exists, ownership falls back to heartbeat freshness plus a confirm-twice window that re-reads the lock's token before taking over, and takeover is tied to the observed lock identity (inode + mtime) so a lock another server just created is never renamed aside. The one residual is a live owner paused *longer* than the confirm window (e.g. host sleep) that resumes and writes before its own next heartbeat detects the loss and triggers `gracefulShutdown` — a bounded, self-healing window. Eliminating it entirely would require an OS advisory lock (native code) or a fencing token validated on every session write; both are disproportionate for a local, single-user, zero-dependency source server and are deferred rather than added here.

### Exit gate

- mutable run/schema/lock state has one owner each;
- no behavior changed without tests;
- no speculative framework or TypeScript migration was introduced.

---

## 14. Phase 10 — Documentation truth pass

### Objective

Make active documentation describe the source-run product and current code accurately.

### Tasks

#### 10.1 Update README after executable verification

Document:

- Node.js 22+;
- pnpm 10.12.1 via Corepack;
- validated production-only user install command;
- `pnpm start`;
- default `http://127.0.0.1:3210`;
- `PORT` override with separate POSIX and Windows examples if needed;
- provider CLI prerequisites;
- local session storage and privacy boundary;
- clean shutdown and recovery behavior;
- contributor-only checks and browser tests.

Remove active quick-start references to installers/releases. Do not claim a production-only command works until Phase 8 proves it.

#### 10.2 Correct Review Gate drift

`.review-gate/GATE.md` currently defines the authoritative order as:

```text
review → fix → commit → attest exact HEAD → push
```

Align `AGENTS.md`, `CLAUDE.md`, and `CONTRIBUTING.md` by linking to that source instead of duplicating a conflicting sequence.

#### 10.3 Archive historical handoff material

`docs/MISSION_CONTROL_HANDOFF.md` contains historical branch names, old test counts, and stale responsive claims. Move it to a clearly historical/archive location or rewrite it as a current architecture document.

If archived:

- add a date and historical label;
- remove “single source of truth” wording;
- do not update old evidence to look current.

#### 10.4 Update convergence status

`docs/SESSION_CONVERGENCE_STABILIZATION_PLAN.md` currently says the work is implemented on a feature branch based on an older main commit. Change its status to reflect that the behavior is merged, or convert it into a dated decision/implementation record.

Keep `docs/MULTI_AGENT_SESSION_MODES_PLAN.md` explicitly proposed and unimplemented.

#### 10.5 Document new runtime contracts

Update the appropriate current docs for:

- run IDs and terminal-state invariants;
- session schema/migrations/backups;
- runtime single-writer lock;
- corrupt-session recovery;
- connector read audit;
- Gmail experimental token limitation;
- trusted executable re-approval;
- diagnostics export contents;
- source-run testing commands.

Do not duplicate the same contract across many files. Choose one source and link to it.

#### 10.6 Exclude release documentation work

Do not revise signing, installer, auto-update, or release-channel documentation as part of this plan. If active navigation points users to deferred distribution material, remove the active navigation link or mark the page deferred without redesigning that subsystem.

### Docs verification

Before completion:

- verify every command against `package.json` scripts;
- run every source setup example in a clean clone;
- verify every file path exists;
- verify every endpoint against `server/index.js`;
- verify every environment/config key against the code that reads it;
- search active docs for stale branch names and old test counts;
- check internal Markdown links.

### Exit gate

- active docs describe current source-run behavior;
- commands are executable;
- historical documents are clearly historical;
- release work is absent from the remediation narrative.

---

## 15. Traceability from review findings

| Review finding | Resolution in this plan | Priority |
|---|---|---:|
| Error status can return to running | Phase 1 run identity, terminal CAS, settled siblings | P0 |
| Late provider result after stop | Phase 1 completion fence and deterministic stop | P0 |
| Sequential first collaboration opinion | Phase 2 immutable independent opening | P1 |
| Invalid/unselected finalizer silently ignored | Phase 2 preflight validation | P1 |
| Process-local storage locks only | Phase 3 runtime single-writer lock | P1 |
| Corrupt session silently disappears | Phase 3 quarantine/recovery visibility | P1 |
| No top-level session schema/migrations | Phase 3 schema and migration pipeline | P1 |
| Context cannot open at narrow width | Phase 4 separate overlay state | P1 |
| Dead `.app` / `.sessions` selectors | Phase 4 current shell selectors | P1 |
| Workflow inaccessible at narrow width | Phase 4 workflow drawer | P1 |
| Attach state can be stale | Phase 4 unified activity controls | P2 |
| Connector reads lack audit trail | Phase 5 metadata-only read audit | P1 |
| GitHub readiness always configured | Phase 5 actual readiness checks | P1 |
| Gmail access token is short-lived | Phase 5 explicit experimental/expiry handling | P1 |
| Supabase privilege risk unclear | Phase 5 least-privilege setup guidance | P1 |
| Connector errors collapse to 500 | Phase 5 typed errors/status mapping | P2 |
| Codex auth isolation lacks adversarial proof | Phase 6 negative containment tests | P1 |
| Trusted CLI approval is path-based | Phase 6 executable identity/fingerprint | P2 |
| Logs can grow indefinitely | Phase 7 bounded rotation | P2 |
| Logging failures are swallowed | Phase 7 health signal | P2 |
| Diagnostics/support visibility is weak | Phase 7 explicit local export | P2 |
| Critical module coverage is uneven | Phase 8 targeted behavior gates | P1 |
| No browser E2E | Phase 4 and Phase 8 browser tests | P1 |
| No source-server smoke in CI | Phase 8 loopback smoke job | P1 |
| No lint gate | Phase 8 minimal linting | P2 |
| Unused `lodash` | Phase 8 verified removal | P2 |
| Large stateful modules | Phase 9 targeted extraction | P2 |
| Review-gate docs disagree | Phase 10 single authoritative sequence | P1 |
| Mission Control handoff is stale | Phase 10 archive/rewrite | P1 |
| Convergence plan status is stale | Phase 10 current status | P2 |

### Findings intentionally removed from scope

The following review topics are not carried into implementation because the user explicitly deferred distribution:

- packaged EXE launch tests;
- installer install/uninstall tests;
- signing and notarization;
- unsigned pre-release behavior;
- Auto-update;
- release feeds/channels;
- GitHub Release state;
- binary size and packaged ASAR review;
- release-specific SBOM/checksums;
- desktop release workflow documentation.

Desktop-only dependency advisories are not labeled as source-runtime vulnerabilities. The source-user path must avoid installing desktop development dependencies; separate desktop maintenance can revisit that graph later.

---

## 16. Final source-run acceptance matrix

### Clean clone

- [ ] New clone on Windows starts through the documented production-only path.
- [ ] New clone on macOS starts through the documented production-only path.
- [ ] New clone on Linux starts through the documented production-only path.
- [ ] `/api/health` responds only through loopback.
- [ ] Main UI loads with no provider installed.
- [ ] Provider setup/readiness failures are understandable and non-fatal.

### Discussion integrity

- [ ] No terminal run returns to running.
- [ ] No agent completion is accepted after error/stop for the same run.
- [ ] Exactly one terminal event exists per run.
- [ ] Old-run events do not alter a newer run's UI.
- [ ] Parallel provider failures remain bounded and redacted.
- [ ] First collaboration opinions are independent.
- [ ] Finalizer input is validated before provider execution.

### Data

- [ ] Legacy unversioned sessions migrate with backup.
- [ ] Current sessions remain readable.
- [ ] Unsupported future schemas are not overwritten.
- [ ] Corrupt sessions are visible and exportable.
- [ ] Two servers cannot write the same runtime directory.
- [ ] A crash leaves a recoverable lock/session state.

### UI

- [ ] Context and workflow are reachable at every acceptance viewport.
- [ ] No horizontal document overflow at 800×600 or 980×680.
- [ ] RTL and LTR flows pass.
- [ ] Modal/drawer focus returns correctly.
- [ ] All running-session controls synchronize on open/reload.
- [ ] Decision-card semantics and user modifications remain intact.

### Connectors

- [ ] Read actions create safe audit metadata.
- [ ] No credential or raw sensitive response is stored in audit records.
- [ ] GitHub readiness reflects CLI/auth reality.
- [ ] Gmail token expiry is explicit.
- [ ] Supabase setup recommends restricted credentials.
- [ ] State-changing actions remain approval-gated and exactly-once.
- [ ] Expected connector failures use stable non-500 statuses.

### Security and diagnostics

- [ ] Codex auth containment is tested or the remaining unverified boundary is explicit.
- [ ] Changed provider executable requires re-approval.
- [ ] Logs rotate within fixed bounds.
- [ ] Logging/storage failures are visible without crashing the server.
- [ ] Diagnostics export is local, explicit, bounded, and redacted.

### Quality

- [ ] `pnpm check` passes.
- [ ] `pnpm test` passes on Windows, macOS, and Linux.
- [ ] Lint passes.
- [ ] Source-server smoke passes.
- [ ] Browser E2E passes.
- [ ] Race/fault tests pass repeatedly.
- [ ] Active documentation commands run in a clean clone.

---

## 17. Definition of done

This remediation is complete only when all of the following are true:

1. Every mandatory acceptance item in Section 16 is checked with evidence.
2. The confirmed orchestrator race and cancellation race have regression tests.
3. No new terminal-state or migration behavior exists only as an untested comment.
4. The source-run path is validated on the same operating-system matrix as current CI.
5. The browser UI works at the declared RTL/LTR viewports.
6. Session data has versioning, backup, visible corruption handling, and one-writer protection.
7. Connector reads are auditable without persisting sensitive bodies.
8. Security containment claims are backed by tests or clearly marked limitations.
9. Logs and diagnostics are bounded and redacted.
10. Active documentation matches the implementation and contains no release work from the excluded scope.
11. The final diff passes the required project review gate before any requested push.

---

## 18. Stop conditions for the implementation tool

Stop and request user approval instead of guessing if any of the following occurs:

- a fix requires changing the decision card's meaning or removing the user's card changes;
- a migration cannot preserve the only copy of a session;
- a proposed runtime lock would delete an apparently live owner's lock;
- a connector audit design requires storing raw email/database content;
- Codex containment cannot be tested and the only alternative weakens the existing sandbox;
- production-only install cannot start the server without restructuring the desktop toolchain;
- a dependency change would require package/release work excluded by this plan;
- implementation requires adding a third provider or changing protocol cardinality;
- unrelated user changes overlap the target files and cannot be preserved safely.

Difficulty, test duration, or the size of a file are not stop conditions. The tool should continue through safe in-scope alternatives.

---

## 19. Recommended execution order summary

```text
baseline + failing tests
→ run-attempt state machine
→ API validation + independent openings
→ schema + migration + runtime lock + recovery
→ responsive shell + control state + browser tests
→ connector audit/readiness/error contracts
→ Codex containment + executable fingerprint
→ bounded logs + diagnostics
→ source-only install/CI/lint/coverage/fault tests
→ targeted module extraction
→ documentation truth pass
→ complete acceptance matrix
→ mandatory review gate if commit/push is requested
```

Do not start Cursor or new multi-agent modes until this sequence is complete.
