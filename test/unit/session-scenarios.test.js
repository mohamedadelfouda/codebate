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
const assess = (controls, { registry = [], targetVersion = 2, confirmationsExhausted = false } = {}) =>
  assessRound(controls, targetVersion, registry, confirmationsExhausted);

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

// Scenario — the ACTUAL repo-review failure. Codex hit its usage limit and dropped after round 1, so
// later rounds ran with only two providers; Cursor's control was unparseable (missing_control). That
// leaves just ONE valid control — which correctly cannot seal (quorum never seals on a single voice) —
// so the round is invalid_control and the session burns to the round limit despite the two readable
// participants effectively agreeing in prose.
//
// CURRENT behaviour (characterization): no seal, and it keeps going. The right fix is NOT to seal on one
// voice; it is an honest, bounded DEGRADED early-stop (ChatGPT's substantive_convergence) so the session
// stops with a truthful "couldn't formally seal — one control unreadable" outcome instead of looping.
// The degraded-seal PR flips the assertions below.
test("scenario · two agents after a dropout, one unparseable control (CURRENT, pre-fix): cannot seal → burns rounds", () => {
  const r = assess([control(), missingControl()]);
  assert.equal(r.canStop, false);
  assert.equal(r.agreementState, "unknown");
  assert.equal(r.stopReason, "invalid_control");
});
