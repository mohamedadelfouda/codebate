import test from "node:test";
import assert from "node:assert/strict";
import { assessRound, parseAgentControl } from "../../server/convergence.js";

// ── Session replay harness ──────────────────────────────────────────────────────
// Behavioural convergence fixes (does a real session stop / seal when it should?) are
// expensive to verify with live provider runs. This harness turns each REAL session the
// user reports into a deterministic, offline regression test.
//
// The .md session exports strip the raw <agent-control> blocks (H7), so we can't replay raw
// bytes. Instead we distill the session's DECISIVE round into its per-agent control state and
// run it through the real convergence engine (assessRound), asserting the stop/seal decision.
// A provider that produced no parseable control that round is a `missing` (null) slot.
//
// To add a session: capture the decisive round's controls + registry and the expected
// assessment, and give the scenario a name that points back to the reported session.

function block(overrides = {}) {
  return `<agent-control>${JSON.stringify({
    controlVersion: 2,
    convergence: "converged",
    goalStatus: "satisfied",
    substantiveDelta: false,
    itemProposals: [],
    targetVersion: 2,
    ...overrides,
  })}</agent-control>`;
}
const control = (overrides = {}) => parseAgentControl(block(overrides));
// A provider whose turn produced no parseable <agent-control> block this round (e.g. Cursor
// missing_control, or a provider that drifted to free prose). This is the REAL orchestrator path:
// parseAgentControl on prose returns a present-but-invalid control object ({valid:false,
// errorCodes:["missing_control"]}) — NOT a null slot — so it counts toward the participant total.
const missingControl = () => parseAgentControl("reader-facing prose with no agent-control block");
const create = (kind, text, actor, action) => ({ action: "create", kind, text, requiredStep: { actor, action } });

// Assess one decisive round through the real engine.
const assess = (controls, { registry = [], targetVersion = 2, confirmationsExhausted = false, invalidControlExhausted = false } = {}) =>
  assessRound(controls, targetVersion, registry, confirmationsExhausted, invalidControlExhausted);

// Scenario — "Sector Radar" (a no-web research task in collaboration). By round 3 all three
// agents converged on the same conditional answer and flagged it as needing the user (needs_user
// + a user_decision item), with no substantive change left. The engine's decision here is correct:
// it must STOP and hand to the user. (The real session over-ran only because the later-round prompt
// kept provoking marginal substantiveDelta — fixed in #15; this locks in that the engine itself
// stops a converged needs_user round.)
test("scenario · no-web research: all three converge on needs_user with no delta → stops for the user", () => {
  const decision = [create("user_decision", "Confirm ownership or paste the site content", "user", "provide_decision")];
  const r = assess([
    control({ goalStatus: "needs_user", itemProposals: decision }),
    control({ goalStatus: "needs_user", itemProposals: decision }),
    control({ goalStatus: "needs_user", itemProposals: decision }),
  ]);
  assert.equal(r.agreementState, "converged");
  assert.equal(r.canStop, true);
  assert.equal(r.stopReason, "user_decision");
});

// Scenario — repo review where Codex hit its usage limit after round 1 and dropped out. Later
// rounds ran with only the remaining two providers. Two present, converged controls still certify
// and seal — dropping a provider does not stall the session.
test("scenario · provider dropout: a later round with only the two remaining converged agents still seals", () => {
  const r = assess([control(), control()]);
  assert.equal(r.agreementState, "converged");
  assert.equal(r.canStop, true);
  assert.equal(r.sealedOnQuorum, false); // full agreement of everyone present, not a quorum relaxation
});

// Scenario — a genuine late change on a converged round is NOT stopped immediately: the peers ran
// in parallel on the old snapshot, so the next round is a confirmation round. Only once the bounded
// confirmation rounds are exhausted does the residual delta stop burning the session.
test("scenario · late substantive change: waits one confirmation round, then the loop-breaker stops it", () => {
  const controls = [control(), control({ substantiveDelta: true })];
  const pending = assess(controls, { confirmationsExhausted: false });
  assert.equal(pending.canStop, false);
  assert.equal(pending.awaitingConfirmation, true);
  const exhausted = assess(controls, { confirmationsExhausted: true });
  assert.equal(exhausted.canStop, true);
});

// Scenario — repo review, THREE providers present, two converged and one produced an unparseable
// control. The quorum path already rescues this: the round seals on the valid majority (the excluded
// control is surfaced honestly). Locks in that a single malformed/missing control among three does NOT
// sink a real agreement.
test("scenario · three-way with one unparseable control: seals on the valid majority (quorum)", () => {
  const r = assess([control(), control(), missingControl()]);
  assert.equal(r.agreementState, "converged");
  assert.equal(r.canStop, true);
  assert.equal(r.sealedOnQuorum, true);
});

// ── ERP session 2fe94389 (2026-08-24, debate: Claude vs Codex) — real controls, replayed ──
// The pricing question ("50k setup + 7.5k/month?") converged in round 3 of 5. Round 2 filed a
// disagreement; round 3 BOTH agents proposed resolve(item-001) — locking in that closing an item
// requires every participant's explicit action, and that the session then seals early instead of
// burning the remaining rounds.
test("scenario · ERP pricing debate: joint resolve of the filed disagreement seals in round 3", () => {
  const disagreement = create(
    "disagreement",
    "هل 7,500 جنيهًا شهريًّا هي السعر المعلن أم خصم «عميل مؤسّس» مكتوب مقابل سعر معلن 12,000؟",
    "agent", "resume_agent_round",
  );
  // Round 2: Codex converged, Claude open with the disagreement filed. Real controls from the session.
  const r2 = assess([
    control({ itemProposals: [] }),
    control({ convergence: "open", goalStatus: "incomplete", substantiveDelta: true, itemProposals: [disagreement] }),
  ]);
  assert.equal(r2.agreementState, "open");
  assert.equal(r2.canStop, false);
  // Precedence in discussionState(): an open agreement reports open_disagreement before
  // agent_work_pending — matches the real session's roundDiagnostics for rounds 2–3.
  assert.equal(r2.continueReason, "open_disagreement");

  // Round 3 replays WITH round 2's approved registry (the harness's sequential-replay capability).
  const registryAfterR2 = r2.itemRegistry;
  assert.equal(registryAfterR2.length, 1);
  assert.equal(registryAfterR2[0].status, "open");
  const r3 = assess([
    control({ itemProposals: [{ action: "resolve", itemId: "item-001" }] }),
    control({ itemProposals: [{ action: "resolve", itemId: "item-001" }] }),
  ], { registry: registryAfterR2 });
  assert.equal(r3.agreementState, "converged");
  assert.equal(r3.canStop, true);
  assert.equal(r3.stopReason, "complete");
  const resolvedItem = r3.itemRegistry.find((i) => i.itemId === "item-001");
  assert.equal(resolvedItem?.status, "resolved");
});

test("scenario · unilateral resolve: one agent cannot close the other's open item", () => {
  const disagreement = create("disagreement", "الطرفان لم يتوافقا بعد على ترتيب بنود التنفيذ.", "agent", "resume_agent_round");
  const seeded = assess([control(), control({ convergence: "open", goalStatus: "incomplete", substantiveDelta: true, itemProposals: [disagreement] })]);
  assert.equal(seeded.itemRegistry.length, 1);

  // Codex proposes resolve, Claude stays silent on the item (no proposal for it at all).
  const r = assess([
    control({ itemProposals: [{ action: "resolve", itemId: "item-001" }] }),
    control(),
  ], { registry: seeded.itemRegistry });
  assert.equal(r.canStop, false);
  // Claude's terminal claim omits an open item → rejected before registry application.
  assert.ok(r.consistencyErrors.some((e) => e.code === "unaddressed_open_item"));
  const stillOpen = r.itemRegistry.find((i) => i.itemId === "item-001");
  assert.equal(stillOpen?.status, "open"); // NOT closed by omission or by one voice
});

// ── ERP session 2fe94389, question 3 rounds 4–5: the REAL failure this harness exists to pin ──
// Both agents' stored controls were individually valid and both declared convergence:"converged"
// + goalStatus:"satisfied" with zero delta — but their LEDGERS disagreed on items 002/003/004:
//   codex R4: keep_open ×3 + resolve(item-005)
//   claude R4: keep_open(item-002) + merge_into(item-003→004) + keep_open(item-004) + resolve(item-005)
// The merge split consensus → exactly ONE conflicting_item_actions (item-003, the contested item)
// → consistency_error. Rounds 5 repeated the same ledger split (claude dropped the merge, codex
// switched to resolve-all) so nothing changed between them: two identical invalid rounds burned
// to the round limit.
//
// NOTE: keep_open under a satisfied claim is itself rejected per-item (terminal_item_kept_open) —
// these controls are built as the engine saw them AFTER schema validation, with the ledger split
// carried by the actions themselves.
const LEDGER_CONFLICT_REGISTRY = [
  { itemId: "item-002", kind: "remaining_work", status: "open", text: "جدولة تصدير النسخ الاحتياطية لكل شركة دوريًّا", requiredStep: { actor: "agent", action: "resume_agent_round" } },
  { itemId: "item-003", kind: "remaining_work", status: "open", text: "قياس التسوية الدورية للمخزون قبل الحكم عليها", requiredStep: { actor: "agent", action: "resume_agent_round" } },
  { itemId: "item-004", kind: "external_validation", status: "open", text: "اعتماد بوابة الإصدار عبر مشغل بشري", requiredStep: { actor: "human_operator", action: "run_external_check" } },
  { itemId: "item-005", kind: "disagreement", status: "open", text: "حسم مسؤولية النسخ الاحتياطي بين المشروع ومزود الاستضافة", requiredStep: { actor: "agent", action: "resume_agent_round" } },
];
// Controls are built as RAW JSON and passed through the real parseAgentControl, exactly like the
// orchestrator does — the engine's `valid`/`targetVersion` fields come from validation, not from us.
const ledgerControl = (overrides) => parseAgentControl(`<agent-control>${JSON.stringify({ controlVersion: 2, targetVersion: 3, ...overrides })}</agent-control>`);
test("scenario · ERP Q3 rounds 4–5: readable converged controls with conflicting ledgers burn to the limit (documents current behaviour)", () => {
  const codexR4 = ledgerControl({ convergence: "converged", goalStatus: "satisfied", substantiveDelta: false, itemProposals: [
    { action: "keep_open", itemId: "item-002" }, { action: "keep_open", itemId: "item-003" },
    { action: "keep_open", itemId: "item-004" }, { action: "resolve", itemId: "item-005" },
  ] });
  const claudeR4 = ledgerControl({ convergence: "converged", goalStatus: "satisfied", substantiveDelta: false, itemProposals: [
    { action: "keep_open", itemId: "item-002" }, { action: "merge_into", itemId: "item-003", targetItemId: "item-004" },
    { action: "keep_open", itemId: "item-004" }, { action: "resolve", itemId: "item-005" },
  ] });
  assert.equal(codexR4.valid, true);
  assert.equal(claudeR4.valid, true); // individually valid — the conflict is BETWEEN them
  // The real session ran targetVersion 3 by rounds 4–5 (stored controls carry tv:3); the default
  // here is 2, which would fail version alignment BEFORE the ledger conflict is even reached.
  const r4 = assess([codexR4, claudeR4], { registry: LEDGER_CONFLICT_REGISTRY, targetVersion: 3 });
  assert.equal(r4.allValid, false);
  assert.equal(r4.continueReason, "consistency_error");
  assert.ok(r4.conflicts.some((c) => c.code === "conflicting_item_actions" && c.itemId === "item-003")); // the merge split
  // THE GAP: every readable control is valid AND converged AND delta-free, yet the degraded path is
  // gated on hasUnreadableControl in discussionState() — so a ledger conflict among READABLE,
  // agreeing-in-prose participants can never degrade. This is why the real session burned rounds 4–5.
  assert.equal(r4.degradable, false);
});

// RED spec — the fix contract, written first so the engine change lands against it.
// Same persisted condition as the real session: valid readable controls, everyone declaring
// convergence, no substantive change, and the ONLY obstacle is a stable ledger conflict.
// After DEGRADED_STOP_ROUNDS consecutive unchanged rounds the session must stop honestly
// instead of burning to the round limit. Skipped until discussionState() grows a degraded path
// for readable-control conflicts; unskip as part of that change.
test("scenario · RED spec: a stable ledger conflict among converged readable agents degrades after the bound", { skip: "engine lacks a degraded stop for READABLE controls whose item ledgers conflict — unskip in that change" }, () => {
  const codexStable = ledgerControl({ convergence: "converged", goalStatus: "satisfied", substantiveDelta: false, itemProposals: [
    { action: "keep_open", itemId: "item-002" }, { action: "keep_open", itemId: "item-003" },
    { action: "keep_open", itemId: "item-004" }, { action: "resolve", itemId: "item-005" },
  ] });
  const claudeStable = ledgerControl({ convergence: "converged", goalStatus: "satisfied", substantiveDelta: false, itemProposals: [
    { action: "keep_open", itemId: "item-002" }, { action: "merge_into", itemId: "item-003", targetItemId: "item-004" },
    { action: "keep_open", itemId: "item-004" }, { action: "resolve", itemId: "item-005" },
  ] });
  assert.equal(codexStable.valid, true);
  assert.equal(claudeStable.valid, true); // valid individually — only the LEDGERS disagree
  const waiting = assess([codexStable, claudeStable], { registry: LEDGER_CONFLICT_REGISTRY, targetVersion: 3 });
  assert.equal(waiting.canStop, false);
  assert.equal(waiting.degradable, true);        // eligible once the engine learns this shape…
  const exhausted = assess([codexStable, claudeStable], { registry: LEDGER_CONFLICT_REGISTRY, targetVersion: 3, invalidControlExhausted: true });
  assert.equal(exhausted.degradedStop, true);     // …and stops honestly when the bound is hit
  assert.equal(exhausted.stopReason, "degraded_ledger_conflict");
});

// Scenario — the ACTUAL repo-review failure. Codex hit its usage limit and dropped after round 1, so
// later rounds ran with only two providers; Cursor's control was unparseable (missing_control). That
// leaves just ONE valid control — which correctly cannot seal (quorum never seals on a single voice) —
// so the round is invalid_control and the session burns to the round limit despite the two readable
// participants effectively agreeing in prose.
//
// FIXED (degraded-seal): a single round still can't formally seal (never seals on one voice), but once the
// condition PERSISTS (invalidControlExhausted — the orchestrator bounds this at DEGRADED_STOP_ROUNDS
// consecutive rounds) the session stops honestly with a degraded outcome instead of burning to the round
// limit. The report says plainly the seal failed and which control was unreadable.
test("scenario · two agents after a dropout, one unparseable control: waits, then stops honestly (degraded)", () => {
  const waiting = assess([control(), missingControl()]);
  assert.equal(waiting.canStop, false);
  assert.equal(waiting.degradable, true);      // eligible, but not yet persisted
  assert.equal(waiting.degradedStop, false);
  assert.equal(waiting.agreementState, "unknown");

  const persisted = assess([control(), missingControl()], { invalidControlExhausted: true });
  assert.equal(persisted.degradedStop, true);
  assert.equal(persisted.stopReason, "degraded_convergence");
});
