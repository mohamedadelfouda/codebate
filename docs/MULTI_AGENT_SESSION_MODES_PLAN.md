# Configurable Multi-Agent Session Modes

Status: design proposal for review; no implementation is included.

## Review request

Please challenge this plan before implementation, with particular attention to:

1. Whether separating providers, participants, seats, and protocol roles is the smallest maintainable design.
2. Whether the three proposed protocols create genuinely different viewpoints instead of extra output volume.
3. Whether missing-provider and mid-run failure behavior is explicit and safe.
4. Whether blind judging and criticism are sufficient to reduce provider/model bias.
5. Whether the Cursor CLI boundary can enforce read-only discussion sessions on every supported platform.
6. Whether existing sessions and two-provider workflows can remain backward compatible without a risky data rewrite.

## 1. Objective

Extend Codebate from a provider-keyed two-agent conversation into configurable two- or three-participant sessions while preserving the existing provider adapter model.

The user must be able to:

- run any supported two-provider combination when a third provider is unavailable;
- run a three-peer session;
- run two participants with a third participant acting as a judge;
- run two participants with a third participant acting as a critic;
- assign any available provider to any seat or protocol role;
- choose provider-specific model and effort settings for each occupied seat; and
- see unavailable providers without allowing them to block application startup or unrelated sessions.

The system must not use majority voting as a correctness mechanism. Evidence, explicit reasoning, task completion, and user-defined constraints remain the basis for evaluation.

## 2. Non-goals

The first implementation should not:

- allow more than three active participants;
- silently replace a missing provider or downgrade a three-participant protocol to a two-participant protocol;
- use one provider in multiple seats to simulate independent viewpoints;
- let a judge or critic modify project files;
- add Cursor as an execution provider;
- add cloud-agent orchestration;
- create a general-purpose protocol definition language; or
- replace the existing provider adapter contract.

## 3. Verified current state

The following statements describe the current code, not the proposed design:

- `server/providers/registry.js` registers two providers: Claude and Codex.
- Provider-specific execution stays in `server/adapters/`, matching the boundary documented in `CONTRIBUTING.md` and `docs/PROVIDERS.md`.
- `GET /api/providers` exposes the provider catalog, and `public/app.js` builds provider setup cards and related controls from that catalog.
- Discussion requests currently send an `agents` object keyed by provider ID.
- `server/orchestrator.js` selects enabled registered providers, requires at least two for discussion, and requires exactly two for debate.
- Chat runs the selected providers independently in parallel for one pass.
- Collaboration supports every selected provider, but its first round currently runs sequentially against the live session. A later participant can therefore receive an earlier participant's answer through the transcript.
- Debate uses an immutable opening snapshot and runs its two openings in parallel.
- Several prompts in `server/prompts.js` explicitly say "one of two agents," "the other agent," or "another agent."
- `server/adapters/codex.js` already provides the Codex integration. Codex is not the proposed third provider.
- The current provider cards use a two-column desktop grid in `public/styles.css`.

These boundaries mean a third provider card alone is a small extension, but configurable three-seat protocols require a participant layer above the provider registry.

## 4. Core model

Keep these concepts separate:

| Concept | Meaning | Example |
| --- | --- | --- |
| Provider | Installed integration and capability definition | Claude, Codex, Cursor |
| Participant | One provider taking part in one session run | Participant B using Codex |
| Seat | Stable session-local identity used in messages and UI | A, B, C |
| Protocol role | Structural authority defined by the selected mode | peer, debater, judge, critic |
| Perspective | Optional user-authored specialization that does not change authority | security reviewer, product strategist |
| Protocol | Rules for ordering, visibility, feedback, stopping, and final output | triad, duo with judge, duo with critic |

Protocol roles must be controlled values. A free-form perspective may influence what a participant examines, but it must not grant judge, critic, execution, or tool authority.

### Proposed session-run shape

The following is an illustrative internal shape, not a current API contract:

```json
{
  "protocol": "duo_judge",
  "participants": [
    {
      "id": "seat-a",
      "providerId": "claude",
      "protocolRole": "debater",
      "perspective": "Product and usability",
      "model": "sonnet",
      "effort": "high"
    },
    {
      "id": "seat-b",
      "providerId": "codex",
      "protocolRole": "debater",
      "perspective": "Implementation and reliability",
      "model": "",
      "effort": "high"
    },
    {
      "id": "seat-c",
      "providerId": "cursor",
      "protocolRole": "judge",
      "perspective": "Evidence and risk",
      "model": "",
      "effort": "high"
    }
  ],
  "rounds": 2,
  "finalizerParticipantId": "seat-c"
}
```

### Finalizer validation

Normalize and validate the participant roster before resolving the finalizer. `finalizerParticipantId` may be absent or explicitly set to `"none"`, or it must exactly match one participant ID in the normalized roster. Reject duplicate participant IDs, unknown finalizer IDs, and protocol-role mismatches before spawning any provider process.

Allowed finalizers depend on the protocol:

- Three-peer sessions allow no finalizer or one participant whose role is `peer`.
- Duo-with-judge sessions use the `judge` by default and may explicitly select no final brief. A `debater` cannot replace the judge.
- Duo-with-critic sessions allow no finalizer or one of the two `peer` participants. The `critic` cannot be the finalizer.

During normalization, an omitted finalizer resolves to the `judge` in duo-with-judge sessions and to no finalizer in the three-peer and duo-with-critic protocols. An explicit `"none"` remains no finalizer in every protocol.

The selected finalizer must also pass the same readiness and capability checks required for its finalization phase. Persist the selection by participant ID and never infer it from provider registry order.

### Message metadata compatibility

Message metadata needs an independent `messageMetadataVersion`; it must not inherit the session-settings schema version. New protocol messages should use version 1 and persist `participantId`, `providerId`, and `protocolRole` together. They may also write the legacy `agent` alias during the compatibility period.

For versioned messages, the participant tuple is authoritative. Validate that `participantId` exists in the saved run roster and that its `providerId` and `protocolRole` match that roster. Reject newly written messages when the versioned tuple is incomplete or when `agent` conflicts with `providerId`.

The orchestrator must stamp message attribution from the server-owned invocation claim identified by `runId`, `phaseKey`, `attemptId`, and `participantId`. Provider adapters and model output may return content and execution status, but they cannot supply or override participant identity, provider identity, or protocol authority.

For unversioned legacy messages, keep `agent` as the original historical attribution and normalize a read-only participant projection from the saved session or run assignment. Set `providerId` from the legacy `agent`; set `participantId` from the saved assignment when available; and set `protocolRole` from that assignment or to `null` when it is unknown. If no saved assignment exists, derive a stable legacy participant identity from available stored message, run, and provider data rather than the current provider registry. A `null` legacy role is display-only and cannot grant protocol authority or satisfy validation for a new run. Do not rewrite the historical transcript solely to add the new fields. This preserves the original author while giving new UI and orchestration code one normalized read shape.

## 5. Availability and cardinality rules

Availability is independent for every provider.

- A provider may be supported but not installed, installed but not authenticated, or installed and ready.
- Missing or unhealthy providers must not prevent the server or desktop app from starting.
- Seat selectors should show unavailable providers as disabled and explain the failed readiness check.
- Client and UI readiness results are informative only. Immediately before every provider phase, including finalization, the orchestrator must repeat server-authoritative installation, authentication, capability, and command-allowlist checks against the saved run assignment.
- Bind each saved run assignment to a trusted execution fingerprint for the resolved executable and effective provider configuration. If that identity changes before a phase starts, fail the phase without substitution or fallback and require a new run configuration.
- Any two distinct ready providers may run the existing two-participant protocols.
- Three-peer, duo-with-judge, and duo-with-critic protocols require three distinct ready providers.
- A three-participant protocol selected with fewer than three ready assigned participants must be rejected before any provider process starts.
- The application must not silently change the protocol, substitute a provider, or reuse one provider in two seats.
- If a provider becomes unavailable after configuration, preserve the configuration and show the user how to select another provider or protocol.

If a provider fails mid-run, keep every completed message and clearly mark the incomplete phase. Do not silently reassign its role. A later "continue with remaining participants" action may be considered separately, but it is not part of the first implementation.

## 6. Protocol definitions

### 6.1 Three-peer session

Purpose: collect three independent positions, then let all participants improve their positions after seeing the others.

Flow:

1. Validate three distinct ready participants with the `peer` role.
2. Create one immutable opening snapshot containing the user request and the transcript before the run.
3. Run all three openings in parallel from that same snapshot. No peer sees another peer's opening before completing its own.
4. Anonymize the other openings as Participant A, B, or C when building reflection prompts. Do not expose provider or model names.
5. Run reflection rounds in parallel from a shared immutable round snapshot.
6. Treat agreement as a reported state, not a vote. Early stopping requires every active peer to report that the current proposal satisfies the goal and that no material disagreement remains.
7. Allow an optional user-selected finalizer. "No finalizer" must remain valid so the user can inspect the three positions directly.

### 6.2 Two participants with a judge

Purpose: let two participants develop competing or alternative positions, then ask a separate participant to evaluate the result.

Flow:

1. Validate two `debater` participants and one `judge` participant.
2. Run the two openings independently and in parallel.
3. Run configured rebuttal rounds. Each debater receives the same immutable prior-round snapshot.
4. Keep the judge out of the debate transcript until both debaters finish or one fails.
5. Give the judge anonymized Position A and Position B in randomized display order, the user request, the verified project snapshot when available, and an evaluation rubric.
6. Require the judge to identify the strongest point from each position, unsupported claims, material risks, and goal coverage before giving a conclusion.
7. Permit the judge to synthesize a third conclusion only when neither position is sufficient, and require it to distinguish that synthesis from either original position.
8. The judge produces the final brief by default. The user may choose no final brief, but another debater should not silently replace the judge.

Recommended judge rubric:

- correctness and evidence;
- coverage of the user's actual goal;
- explicit handling of uncertainty;
- operational risk and reversibility;
- simplicity relative to the benefit; and
- clarity of the next decision or action.

### 6.3 Two participants with a critic

Purpose: let two collaborators build answers while a third participant searches for omissions, weak assumptions, and failure modes without deciding the outcome.

Flow:

1. Validate two `peer` participants and one `critic` participant.
2. Run the two openings independently and in parallel.
3. Give the critic both anonymized openings and the user request.
4. Require the critic to produce a bounded critique: material omissions, unsupported assumptions, contradictions, edge cases, and the minimum questions each peer must answer.
5. Give both peers the same critique and the same immutable transcript snapshot.
6. Run both responses in parallel so neither peer anchors on the other's response.
7. Repeat the critique-response cycle only for the configured number of rounds.
8. Do not let the critic select a winner or present its critique as the final decision.
9. Allow either peer, or no participant, to be selected as the finalizer. If the critic is ever allowed to synthesize in a later version, that must be a distinct protocol role and explicit user choice.

## 7. Protocol orchestration design

Do not place all new behavior in one expanding conditional inside `server/orchestrator.js`.

Extract shared orchestration primitives for:

- participant and capability validation;
- immutable phase snapshots;
- parallel provider calls;
- transcript projection and anonymization;
- phase persistence and events;
- convergence assessment;
- finalization; and
- cancellation and partial-failure handling.

Place protocol-specific ordering and visibility rules behind a small protocol registry. A possible proposed layout is:

```text
server/
  protocols/
    registry.js
    triad.js
    duo-judge.js
    duo-critic.js
```

This layout is a proposal, not an existing path requirement. Start with explicit protocol functions rather than a generic workflow language.

The provider registry should remain responsible for provider metadata and adapter selection. Protocol code calls a participant's selected provider through the existing provider `run(options)` contract.

## 8. Prompt and transcript rules

- Remove assumptions such as "one of two agents" and "the other agent."
- Every prompt must state the participant's seat, protocol role, perspective, current phase, and permitted actions.
- Protocol prompts must receive an explicit participant roster instead of inferring other participants from provider IDs.
- Openings must use an immutable pre-run snapshot.
- Later parallel phases must use one immutable prior-phase snapshot.
- Judges and critics should see anonymized participant labels and not provider or model identity.
- Anonymized order presented to a judge should be randomized and recorded for traceability.
- A judge must not decide by provider reputation or majority.
- A critic must not acquire decision authority through prompt wording.
- Discussion prompts must not be treated as a security boundary; adapter-enforced permissions remain mandatory.
- Existing transcript caps, redaction, final-output limits, and cancellation behavior must continue to apply.

The current convergence control must be reviewed for arbitrary participant counts. For a three-peer protocol, early stopping should require compatible control reports from all three active participants, not two matching reports or a majority.

## 9. UI plan

Separate provider setup from session composition.

### Provider setup

Keep one setup card per registered provider for:

- command and trusted executable selection;
- installed/authenticated health;
- model discovery or configured model choices;
- supported effort values;
- capability summary; and
- install or sign-in guidance.

The provider grid should support three cards without leaving the third card in an accidental half-empty row on normal desktop widths, while preserving the existing one-column mobile layout.

### Session composition

Add a session-mode selector and one seat card per required participant. Each seat card should contain:

- provider selector;
- model and effort controls;
- protocol role, displayed but constrained by the selected mode;
- optional perspective text; and
- readiness state.

Changing the mode should update required seats and roles without discarding valid provider/model choices unnecessarily.

Compatibility behavior:

- With two ready providers, two-participant modes remain enabled and three-participant modes are disabled with an explanation.
- With three ready providers, every proposed mode becomes selectable.
- If an assigned provider becomes unavailable, the Run action is disabled and the exact seat requiring attention is identified.
- The UI must never imply that disabling an unavailable third provider disables the two ready providers.

When a phase fails but its run remains active, show one explicit retry action for that failed phase. Do not show retry for completed phases or cancelled runs. The action must identify the saved run and failed attempt; it cannot change the participant, provider, role, prompt snapshot, or protocol. A stale or conflicting retry response should refresh the current phase state instead of pretending that a new attempt started.

## 10. Cursor provider plan

Cursor is the proposed third provider. A Cursor desktop editor command is not automatically equivalent to the Cursor Agent CLI and must not be accepted as a substitute without a verified machine-readable agent interface.

The adapter should:

- live in `server/adapters/cursor.js`;
- register provider metadata in `server/providers/registry.js`;
- allowlist only the intended Cursor Agent executable or an explicitly designed Windows-to-WSL bridge;
- use Cursor's non-interactive print mode with structured output;
- parse assistant deltas, the terminal result, duration, model, session ID, and errors while ignoring unknown fields;
- apply the existing process containment, timeout, truncation, redaction, and cancellation boundaries;
- avoid surfacing reasoning or raw tool payloads as final user-visible output;
- avoid inheriting arbitrary host secrets; and
- advertise no capability until the adapter enforces it and focused tests cover it.

Discussion mode must be read-only. Do not rely only on prompt text. The implementation must verify a Cursor configuration that denies file writes and shell commands and prevents inherited project MCP configuration from widening the tool surface. Do not pass Cursor's force-write option in discussion protocols.

Cursor CLI behavior and flags are upstream concerns. Verify them during implementation rather than copying them into project documentation:

- [Cursor CLI installation](https://docs.cursor.com/en/cli/installation)
- [Cursor CLI headless mode](https://docs.cursor.com/en/cli/headless)
- [Cursor CLI output format](https://docs.cursor.com/en/cli/reference/output-format)
- [Cursor CLI permissions](https://docs.cursor.com/cli/reference/permissions)
- [Cursor CLI authentication](https://docs.cursor.com/en/cli/reference/authentication)

### Windows and WSL

Cursor's current installation documentation routes Windows users through WSL. Treat Windows-to-WSL execution as a separate integration boundary, not a shell command assembled from user input.

Before enabling it, verify:

- distribution discovery and explicit selection;
- Windows-to-WSL working-directory conversion, including non-`C:` drives;
- canonical project containment after path conversion;
- authentication inside the selected distribution;
- process-tree cancellation;
- temporary configuration cleanup;
- behavior when WSL or the selected distribution is unavailable; and
- command allowlisting without accepting arbitrary `wsl.exe` arguments from a session request.

If those guarantees are not ready, ship Cursor support first on platforms with a directly supported native Cursor Agent executable and keep the Windows provider visibly unavailable with accurate setup guidance.

## 11. Persistence and compatibility

Introduce a schema version for new session settings rather than guessing the shape from present fields.

Compatibility rules:

- Existing saved requests keyed by the current `agents` object must remain readable.
- When an old session has no explicit participant assignment, derive legacy seats from the saved `agents` keys and their saved order. That saved mapping is authoritative even if the current provider registry has been reordered or a provider is no longer available.
- Only when neither a saved assignment nor saved provider order exists may normalization use a deterministic fallback based on stable stored provider IDs. Mark that projection as legacy-derived and do not persist it until the user changes the session.
- Never use current provider registry order to infer a historical seat or message author.
- Preserve historical message authors and metadata; do not rewrite prior transcripts in place.
- Keep existing chat, collaboration, and two-participant debate behavior available while the new protocol model rolls out.
- Store participant assignment with the session so reopening it does not depend on current provider ordering.
- A provider removed or unavailable later must remain identifiable in historical messages.

Migration should occur at the read/normalization boundary and persist only after the user makes a new change. Avoid a startup-time bulk rewrite of user session files.

## 12. Failure behavior

Define and test distinct user-facing failures for these proposed conditions:

- fewer participants than the protocol requires;
- duplicate provider assignment;
- provider not installed or not authenticated;
- provider capability incompatible with the requested phase;
- judge unavailable after debate completion;
- critic unavailable before a critique phase;
- provider process failure with partial output;
- invalid or incomplete structured output;
- WSL distribution or path conversion failure; and
- cancellation during a parallel phase.

Completed outputs must remain visible after a failure. A failed judge means "no judgment produced," not "the last debater wins." A failed critic means "critique phase incomplete," not automatic approval of the peers' output.

### Phase persistence and idempotency

Each orchestration run needs an immutable `runId` and a monotonic `generation` that changes when the run is cancelled or superseded. Each logical phase needs a stable `phaseKey` derived from the run, protocol phase, round, and participant. Each provider invocation needs a separate `attemptId`; an explicit retry creates a new attempt under the same logical `phaseKey`. Persist explicit `pending`, `running`, `completed`, `failed`, and `cancelled` states; do not infer phase state from the presence of transcript text.

The persistence boundary must guarantee that:

- a phase is durably marked `running` before its provider process is treated as active;
- a completed message and its phase transition to `completed` are stored in one serialized or atomic session mutation before a completion event is emitted;
- message IDs are unique, and the composite `(runId, generation, phaseKey, attemptId)` is the idempotency identity for one provider invocation. `phaseKey` groups the attempt history and is intentionally reused by an explicit retry;
- every completion mutation compares the exact `runId`, `generation`, `phaseKey`, and `attemptId` and succeeds only while that attempt is still `running` and the run is active;
- an explicit retry creates a new attempt only for a `failed` phase and never repeats completed protocol work;
- cancellation and failure preserve completed outputs, persist terminal state before reporting it, and leave remaining phases non-final;
- output or events arriving after cancellation, supersession, or attempt replacement are ignored and cannot re-open a phase or feed finalization;
- a final outcome is persisted only after every phase required by the protocol has a valid terminal result; and
- concurrent retry, stop, or reconnect requests cannot acquire more than one active claim for the same phase.

If storage cannot provide a multi-record transaction, use a single serialized session mutation or an equivalent compare-and-swap revision so readers never observe a completed phase without its message, or a final outcome while required phases are incomplete.

### Explicit retry contract

The first implementation supports retrying a failed phase, not continuing with fewer participants and not reconfiguring a run in place. A retry request carries `runId`, `generation`, `phaseKey`, and the failed `attemptId`. The server compares those values with persisted state, verifies that the run is still active and the phase is still `failed`, repeats the server-authoritative provider checks, and atomically creates one new `attemptId` under the same `phaseKey`. Concurrent or stale requests lose that comparison and return the current state without spawning another process.

The retry must reuse the immutable phase input and saved participant assignment. If the executable or effective provider configuration fingerprint has changed, the retry fails closed and the user must create a new run configuration. Cancelled runs are terminal in the first implementation and also require a new run. Downstream phases and finalization may resume only after the retried phase is durably completed.

## 13. Security invariants

- Discussion protocols remain non-mutating.
- Provider adapters enforce permissions; prompts do not grant or remove capabilities.
- Provider commands remain allowlisted native executables or narrowly defined bridges.
- User-supplied command strings never create shell command lines.
- Web, connector, and project-read capabilities remain separated according to the existing provider capability boundaries.
- Judge and critic transcript projections must not expose secrets, hidden reasoning, raw tool payloads, or unredacted process output.
- Temporary auth/config copies must use restricted permissions and be removed in `finally` behavior.
- Parallel phases must remain cancellable as one run and terminate every registered child process.
- Cursor discussion support does not ship until write and shell denial are verified with negative tests.

## 14. Test plan

### Participant and protocol tests

- Accept every distinct two-provider combination for existing two-participant modes.
- Reject one participant.
- Accept exactly three distinct ready participants for each three-participant protocol.
- Reject a missing, unhealthy, duplicated, or disabled participant before spawning a provider process.
- Preserve configured provider-to-seat assignment across save and reload.
- Read legacy provider-keyed settings without rewriting historical messages.
- Reopen a legacy session after the current provider registry is reordered or a provider is removed and preserve its saved provider-to-seat mapping and historical author attribution.
- Accept an omitted or explicit `"none"` finalizer, resolve an omitted duo-with-judge finalizer to its judge, and resolve omitted three-peer and duo-with-critic finalizers to none.
- Reject unknown or protocol-ineligible finalizer IDs and reject duplicate participant IDs before spawning a provider process.
- Normalize unversioned message metadata without changing the original legacy `agent` attribution.
- Reject provider- or model-supplied participant metadata that does not come from the server-owned invocation claim.
- Reject a versioned message whose participant tuple is incomplete, conflicts with legacy `agent`, or does not match the saved run roster.
- Keep deterministic legacy fallback identity stable across reloads and do not persist that fallback until the user changes the session.
- Reject a phase when provider readiness, authentication, capability, executable, or effective configuration changes between session configuration and spawn.

### Orchestration tests

- Three-peer openings receive the same pre-run snapshot and cannot see peer openings.
- Duo debaters receive the same opening snapshot.
- The judge starts only after both debate branches finish.
- Judge input contains anonymized positions in recorded randomized order.
- The critic starts after both peer openings and cannot emit the final verdict phase.
- Both peers receive the same critic output and prior-round snapshot.
- Three-peer convergence requires all active peers; two matching peers are insufficient.
- A provider failure preserves completed and partial messages with accurate phase metadata.
- Cancellation terminates every provider active in a parallel phase.
- A reconnect or duplicate completion delivery after interruption between durable persistence and event delivery does not duplicate a message or phase completion.
- Cancellation, duplicate events, and concurrent retries cannot produce a false final phase or more than one active attempt for the same `phaseKey`.
- Concurrent retry requests for the same failed attempt create exactly one new composite invocation identity and one provider process.
- A delayed completion callback received after cancellation or supersession fails its generation-and-attempt comparison and cannot persist output or trigger finalization.

### Cursor adapter tests

- Reject non-allowlisted commands and unsafe WSL argument shapes.
- Parse successful structured output and incremental assistant text.
- Treat malformed or missing terminal results as failures.
- Preserve safe partial output without exposing reasoning or raw tool payloads.
- Enforce timeout, output limits, redaction, and process-tree cancellation.
- Prove that discussion mode cannot write files or run shell commands.
- Prove that project or user MCP configuration cannot widen the discussion tool surface.
- Verify Windows path conversion and containment for every supported drive/path form.

### UI and accessibility tests

- Render any registered provider count without hardcoded provider IDs.
- Disable three-participant modes when fewer than three providers are ready.
- Keep two-participant modes available when the third provider is missing.
- Prevent duplicate provider assignment.
- Associate every generated label with its control and expose readiness errors through live status text.
- Preserve keyboard navigation and responsive layout for two and three provider cards.

### Regression verification

Run the repository's configured syntax and test commands on its supported CI platforms. Add focused acceptance coverage for two-provider use on a machine without Cursor Agent CLI and three-provider use on a configured machine or controlled test double.

## 15. Delivery phases

### Phase 1: participant abstraction and compatibility

- Introduce participant/seat normalization above the provider registry.
- Preserve existing two-provider chat, collaboration, and debate.
- Remove hardcoded two-agent prompt wording where it is no longer correct.
- Add legacy settings normalization and tests.

Exit criterion: existing two-provider behavior passes unchanged through participant IDs.

### Phase 2: session composition UI

- Separate provider readiness setup from seat assignment.
- Add protocol selection, role display, provider selection, and validation.
- Support unavailable-provider states and any valid two-provider combination.

Exit criterion: users can configure sessions without a third provider, and three-participant modes cannot start accidentally.

### Phase 3: three-peer protocol

- Add independent parallel openings, shared reflection snapshots, all-participant convergence, and optional finalization.

Exit criterion: three openings are demonstrably independent and no majority rule can stop the session.

### Phase 4: judge and critic protocols

- Add blind judge evaluation and bounded critic feedback cycles.
- Add protocol-specific failure and finalization behavior.

Exit criterion: automated tests prove that judge and critic authority cannot be confused.

### Phase 5: persistence and recovery

- Add persisted phase states, invocation idempotency, late-completion fencing, and the bounded failed-phase retry contract.
- Add the failed-phase retry action and stale-state handling to the UI.

Exit criterion: crash recovery, duplicate delivery, cancellation, and concurrent retry tests cannot duplicate output, revive cancelled work, or create two active attempts for one logical phase.

### Phase 6: Cursor provider

- Add the adapter, registry entry, readiness checks, structured-output parsing, and authentication guidance.
- Add native-platform support first, then the Windows-to-WSL bridge only after its containment tests pass.

Exit criterion: Cursor can participate in read-only discussion with the same output, timeout, cancellation, and redaction guarantees as the existing discussion providers.

### Phase 7: verification and documentation

- Run focused and full regression suites.
- Review production code, test code, and documentation with the project's required review gates.
- Update provider and architecture documentation to describe only behavior that has shipped.

Exit criterion: required checks and review-gate attestation pass for the exact reviewed commit before it is pushed.

## 16. Acceptance criteria

The feature is complete only when:

- the app starts and two-provider sessions run when Cursor is missing;
- the user can assign any ready provider to any compatible seat;
- three-participant protocols require three distinct ready providers;
- no three-participant protocol silently falls back to two participants;
- three-peer openings are independent;
- judge and critic inputs hide provider/model identity;
- a judge evaluates but does not win by provider reputation or majority;
- a critic cannot issue the final verdict;
- existing sessions remain readable;
- discussion modes cannot modify files or execute shell commands through any provider;
- partial failures retain completed work and accurately report the missing phase;
- a failed phase can be retried explicitly without changing its saved assignment or duplicating completed work;
- cancellation is terminal and late provider output cannot revive cancelled work; and
- the complete configured verification suite passes.

## 17. Decisions to resolve before implementation

Recommended defaults are included so reviewers can disagree with something concrete.

1. **Duplicate providers in multiple seats:** disallow in the first version to preserve genuine independence.
2. **Judge synthesis:** allow only when neither position satisfies the goal, and require explicit labeling.
3. **Critic frequency:** critique after each completed peer round, within the configured round limit.
4. **Perspective customization:** allow free text, but keep protocol authority fixed and visible.
5. **Judge identity:** blind the judge to provider/model identity and randomize recorded position order.
6. **Three-peer finalizer:** optional; default to none until the user selects one.
7. **Failure degradation:** never automatic; preserve partial work. An explicit retry may rerun the same failed phase under its saved assignment when the execution fingerprint is unchanged; continuing with fewer participants, changing the assignment, or recovering a cancelled run requires a new explicit run configuration.
8. **Windows Cursor support:** require a tested WSL bridge rather than treating the desktop editor command as the Agent CLI.
9. **Execution:** keep Cursor discussion-only until a separate execution threat model and approval flow are designed.
