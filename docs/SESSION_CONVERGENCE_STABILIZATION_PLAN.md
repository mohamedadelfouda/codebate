# Session Convergence and Decision Experience Stabilization

Status: implemented and merged into the current mainline behavior. This file is a decision and implementation record, not a branch handoff.

This stabilization is the prerequisite for the provider and protocol work proposed in `docs/MULTI_AGENT_SESSION_MODES_PLAN.md`.

## 1. Objective

Make collaboration outcomes trustworthy and stop unproductive rounds before adding a third provider or new three-participant protocols.

The implementation:

- stores agent agreement separately from task completion;
- distinguishes genuine disagreement, user decisions, external validation, remaining work, and out-of-scope items;
- stops after a valid, delta-free agreement when the result is complete, waiting for the user, or externally blocked;
- fails closed on missing, invalid, stale, or contradictory controls;
- makes deterministic assessment the only authority that changes official pending-item state;
- keeps the finalizer explanatory rather than authoritative; and
- shows one localized decision card for the latest run without changing the card layout or hiding the transcript.

## 2. Non-goals

This change does not:

- add Cursor or another provider;
- add three-peer, judge, or critic protocols;
- change execution, review, connector, or approval permissions;
- infer agreement from prose;
- use majority voting or semantic similarity;
- build a workflow engine; or
- redesign the decision card, transcript, or responsive layout.

## 3. State model

Agreement and completion are orthogonal.

### Agreement state

| Value | Meaning |
| --- | --- |
| `converged` | Every participant supplied a compatible current control and no genuine disagreement remains. |
| `open` | At least one participant reports an open position or an official disagreement remains. |
| `unknown` | Required state cannot be trusted because control data is invalid, stale, contradictory, or unclassified legacy data remains. |

### Completion state

| Value | Meaning | Discussion terminal? |
| --- | --- | --- |
| `satisfied` | The requested thinking task is complete. | Yes |
| `needs_user` | The proposal is settled but requires an explicit user choice. | Yes |
| `blocked` | The proposal is settled but requires external validation or another outside step. | Yes |
| `incomplete` | More agent work may still materially improve the answer. | By agreement only, when no agent step is pending (§13) |

Completion is aggregated conservatively in this order:

```text
incomplete > blocked > needs_user > satisfied
```

The outcome persists one of these stop reasons:

- `complete`
- `user_decision`
- `external_block`
- `round_limit`
- `invalid_control`

The UI also has localized fallback labels for cancelled and failed runs, although normal discussion outcomes are currently produced by the five reasons above.

## 4. Version 2 control contract

Later collaboration and debate rounds end with a bounded `<agent-control>` JSON block containing:

| Field | Contract |
| --- | --- |
| `controlVersion` | Must equal `2`. |
| `convergence` | `converged`, `open`, or `not_evaluated`. |
| `goalStatus` | `satisfied`, `incomplete`, `blocked`, or `needs_user`. |
| `substantiveDelta` | Boolean indicating whether the proposal materially changed in this round. |
| `itemProposals` | Bounded actions proposed against pending items. |
| `targetVersion` | Positive proposal version required to match the current round. |

Version 2 deliberately omits confidence. Confidence from stored legacy controls remains readable for compatibility but does not influence stopping or appear in the new decision card.

### Item proposals

Agents can propose these actions:

| Action | Meaning |
| --- | --- |
| `create` | Propose a new categorized pending item and its required step. |
| `keep_open` | Explicitly preserve an existing official item. |
| `resolve` | Propose closing an existing official item. |
| `merge_into` | Propose superseding an item into another existing open item. |

A create proposal includes:

- `kind`: `disagreement`, `user_decision`, `external_validation`, `remaining_work`, or `out_of_scope`;
- bounded reader-facing `text`; and
- `requiredStep` containing an allowed `actor` and `action` pair.

Allowed required actions are:

| Action | Allowed actor |
| --- | --- |
| `provide_decision` | `user` |
| `run_external_check` | `user`, `human_operator`, or `orchestrator` |
| `resume_agent_round` | `agent` |

The item kind constrains which action is valid. For example, a user decision requires `provide_decision`, while disagreement and remaining work require another agent round.

## 5. Official item registry

Agent output is a proposal, not persisted truth. The data flow is:

```text
agent itemProposals
→ deterministic assessment
→ approved itemRegistry
→ derived nextSteps
→ persisted outcome
→ finalizer explanation
```

Official items contain a system-generated stable `itemId`, kind, status, text, and `requiredStep`. Persisted statuses are `open`, `resolved`, and `superseded`.

Registry rules:

- omission never closes an item;
- resolving or merging an existing item requires the same explicit proposal from every participant;
- merge targets must exist and remain open;
- an item cannot merge into itself, a merge target that is also changing, or a closed item;
- invalid references and invalid merges fail the round closed;
- new items deduplicate only when kind, punctuation/case/whitespace-normalized text, actor, and action all match; and
- matching normalized text with different kinds or required steps remains visible as a conflict.

No semantic or fuzzy merge occurs merely because two sentences appear similar.

## 6. Consistency and early stopping

Every assessed round requires controls from all active participants, valid contract fields, and the current target version.

Additional consistency rules include:

- `convergence: converged` cannot create a disagreement item;
- `goalStatus: satisfied` cannot create remaining work;
- `needs_user` requires an official open `user_decision` item after proposals are applied;
- `blocked` requires an official open `external_validation` item after proposals are applied;
- a version-2 terminal claim must address every currently open official item;
- `satisfied` cannot keep an official item open;
- open required steps derive completion with deterministic precedence:
  `resume_agent_round` → `incomplete`, `run_external_check` → `blocked`,
  `provide_decision` → `needs_user`;
- classification, required-step, or item-action conflicts prevent a trusted terminal outcome; and
- any substantive delta prevents early stopping in that round.

Early stop is driven by agreement, not by the task being fully done (see §13). It occurs when the round is valid, delta-free, agreement is `converged`, and no open item still requires another agent round (an unresolved `disagreement` or an explicit `remaining_work`). The completion state is reported but no longer gates the stop, so an agreed answer that still needs the user or an outside check stops here and surfaces those pending points instead of repeating rounds. Genuine disagreement and pending agent work continue until a later terminal round or the configured round limit; an agreed-but-`incomplete` result is reported as a settled agreement rather than a completed task.

## 7. Orchestration and finalization

`server/orchestrator.js` carries the approved registry into each later round and records the completed round count. At the end it persists an `outcomeVersion: 1` snapshot on the system outcome message with:

- phase;
- agreement and completion states;
- stop reason;
- requested and completed rounds;
- approved registry and pending items;
- derived next steps;
- disagreements, conflicts, and unclassified legacy points; and
- control validity; and
- optional aggregate Control Repair statistics when a repair was attempted.

Normal reader-facing phases are:

| Phase | Meaning |
| --- | --- |
| `converged` | Agreed and complete. |
| `needs_user` | Agreed and waiting for the user. |
| `blocked_external` | Agreed and waiting for an outside check or dependency. |
| `needs_more_rounds` | The round limit ended with disagreement, incomplete work, or invalid controls. |

The finalizer still runs once after the discussion ends. Its prompt receives the official outcome as immutable context and may explain it, but its wording cannot change the persisted status.

## 8. Decision card

The existing round-summary card remains one card per user run, not one card per round. It updates as rounds arrive and becomes the final decision card when an official outcome is persisted.

For the latest run it displays:

- requested and completed rounds;
- localized agreement state;
- localized completion state;
- localized stop reason;
- pending items grouped by category;
- derived next steps with the responsible actor; and
- substantive changes collected from that run.

The card does not scan earlier runs when a session contains multiple user requests. Stored sessions without an official outcome retain the legacy report and `openPoints` fallback. The transcript and synthesis remain visible in their existing layout.

## 9. Compatibility

- Stored controls without `controlVersion` remain parseable.
- Legacy `openPoints` remain unclassified and cannot be reinterpreted as genuine disagreement.
- Historical session files are not rewritten.
- Mixed sessions can display their legacy messages while new runs use version 2.
- Chat, execution, review, connectors, and approvals keep their existing behavior.

## 10. Verification coverage

Focused tests cover:

- strict version 2 parsing and legacy reads;
- malformed, stale, and contradictory controls fail closed, while reader-facing prose around an otherwise valid block does not (see §13);
- agreement, completion, and stop-reason combinations;
- user decisions, external validation, remaining work, and genuine disagreement;
- official registry creation, unanimous resolution, and unanimous merge;
- invalid references, merge targets, and classification conflicts;
- arbitrary accepted participant counts, including three controls;
- prompt contracts and immutable finalizer outcomes;
- a five-round collaboration that stops after round two and finalizes once;
- Arabic and English catalog parity; and
- existing static accessibility checks.

Required final verification and publication order:

1. Review the exact branch diff with the required reviewers in `.review-gate/agents/`, running independent reviews in parallel when possible, and apply the relevant guard checklists from `.review-gate/skills/`. Documentation changes require the docs guard in addition to the always-required review and security checks.
2. Reconcile the findings, fix every real issue, and self-review the resulting diff.
3. Commit only the reviewed diff.
4. Attest that exact commit before pushing. The attestation runs the configured verification commands (`npm run check` and `npm test`):

   ```bash
   bash .review-gate/review-gate.sh attest --ran review,clean-code,docs
   ```

5. Push without adding another commit between attestation and the push. Any new commit invalidates the attestation and requires the review, verification, and attestation steps again.

On Windows linked worktrees, invoke the same script through Git Bash when `bash` is not available on `PATH`; the review categories and ordering do not change.

## 11. Acceptance criteria

This stabilization is ready when:

- agreement and completion are stored and displayed separately;
- agreed `needs_user` and externally blocked outcomes stop unnecessary rounds;
- invalid and stale controls fail closed, while prose around a valid block is tolerated (see §13);
- genuine disagreement and pending agent work (an open `disagreement` or `remaining_work` item) do not stop early, while an agreed answer with no such pending work does;
- agents cannot silently close official items;
- user decisions and external checks are not described as agent disagreement;
- the captured five-round case is covered by a regression test;
- the latest-run decision card is concise and localized;
- raw enum values do not leak into the Arabic interface;
- existing sessions remain readable; and
- the complete verification suite passes.

## 12. Relationship to multi-agent modes

The stabilized outcome model can be reused by three peers without changing its authority rules: every active participant must contribute a valid control, and no majority can close official items. Judge and critic protocols can consume categorized pending items without turning the registry into a general workflow engine. Cursor feasibility and containment remain separate gates.

## 13. Refinement: agreement-driven stop, lenient parsing, debate anchoring

A real session exposed three gaps between "the protocol is correct" and "the decision experience is trustworthy": agents agreed in prose across five rounds but the run ended `invalid_control`; the rounds never stopped despite the agents repeating "nothing to add"; and switching that session into debate produced a debate about the switch itself. This refinement addresses all three without changing the authority model — deterministic assessment is still the only writer of official state, and agreement is still never inferred from prose.

- **Lenient control parsing.** `parseAgentControl` now takes the last `<agent-control>` block and ignores reader-facing prose before or after it (a sign-off line, a stray code fence). The JSON shape and the version-2 schema stay strict, so a malformed or off-contract block still fails closed. The earlier "nothing after the block" rule was the main cause of false `invalid_control` stops when the agents had genuinely agreed. The prompt still asks agents to end with the block and add nothing after it.
- **Agreement-driven early stop with a work safeguard.** Early stop no longer requires the completion state to be terminal. It fires when the round is valid, delta-free, and `converged`, provided no open item still requires another agent round. That guard — an open `disagreement` or `remaining_work` item — is the machine-checkable safeguard that agreement never cuts off real work: while any agent is still changing the proposal (`substantiveDelta`) or has raised remaining work, the rounds continue. Completion becomes reported context rather than a gate, so an agreed answer that still needs the user or an outside check stops and surfaces those pending points, and an agreed-but-`incomplete` result is reported as a settled agreement rather than a completed task. The stop reason still follows the aggregate completion state. Prompts now instruct agents to signal genuine convergence (`converged` + `substantiveDelta: false`), to use `needs_user`/`blocked` with the matching item when only the user or an outside check remains, and to reserve `remaining_work` for work another round would truly add.
- **Debate anchoring.** When a session is switched *into* debate from another mode, the subject is the most recent substantive agent answer already in the session, passed to the debate prompt verbatim and bounded so it survives transcript trimming. The user's latest message ("let's debate this") is treated as the trigger, not the proposition, unless it states a proposition of its own. This applies only to a genuine switch: a session that was already in debate treats a new message as a fresh proposition, not a re-debate of the last rebuttal. A debate with no prior answer still uses the user's message as the question.

Unresolved rounds now report in plain language — the agreement was not reached, more rounds are needed, and the open disagreement points the agents raised — rather than only an opaque control-data message. A round that fails purely on a control inconsistency (rather than an unreadable block) still names that cause but now lists the raised points alongside it.

## 14. Refinement: bounded Control Repair

The first implementation of Control Repair ran while each provider answer was
being parsed and covered only a missing or malformed block. The stabilized path
now performs the first normal round assessment before deciding whether any
repair is allowed. This keeps deterministic validation authoritative and avoids
turning Repair into a hidden second discussion round.

Repair is limited to the following source errors:

- `missing_control`;
- `invalid_control_json`;
- `invalid_control_schema`;
- `target_version_mismatch`; and
- `unaddressed_open_item`.

Any other error remains conservative until it is classified explicitly. A
valid narrow repair may update a stale target version and add actions for the
specific omitted item IDs, but it must preserve `controlVersion`,
`convergence`, `goalStatus`, `substantiveDelta`, and every unrelated proposal.
A missing or malformed block may be regenerated in full because there is no
valid original contract to preserve. In both cases the result passes the same
parser, schema, consistency, registry, and consensus checks as an original
control.

Each affected participant receives at most one repair call for that assessment,
but only when its provider advertises a tool-free Control Repair mode. Claude is
currently eligible because its read configuration disables all tools. Codex is
not eligible: its read-only sandbox prevents writes but does not confine host
file reads, so the orchestrator records `repair_not_supported` without launching
the provider. An eligible call receives the bounded reader-facing answer,
original normalized control, official registry, target version, and structured
error target. It runs in the runtime scratch workspace with `permission: read`,
no tools, connector, or MCP session, the existing sanitized agent environment,
a 60-second timeout, and a 64 KiB provider-output cap. Cancellation invalidates
late repair output through the same run-state checks used by normal provider
calls.

The reader-facing answer remains unchanged. The message stores bounded
`meta.controlRepair` audit data separately from `retryCount`, including source
error codes, result, failure code, duration, truncation state, requested
model/effort, real usage when returned, and bounded original/repaired control
snapshots. The optional outcome-level `controlRepairStats` aggregates calls,
duration, results, error codes, and only real provider usage; it never estimates
tokens. Session persistence accepts both optional fields without a production
schema migration.
