import test from "node:test";
import assert from "node:assert/strict";
import { createDegradedPersistenceTracker, ledgerConflictSignature } from "../../server/degraded-persistence.js";

function message(agent, itemProposals) {
  return {
    agent,
    control: {
      valid: true,
      itemProposals,
    },
  };
}

const stableConflictClaude = {
  action: "merge_into",
  itemId: "item-001",
  targetItemId: "item-003",
};
const stableConflictCodex = { action: "keep_open", itemId: "item-001" };

test("ledger persistence ignores harmless omission versus keep_open on a non-conflicting item", () => {
  const explicitKeep = [
    message("claude", [stableConflictClaude, { action: "keep_open", itemId: "item-002" }]),
    message("codex", [stableConflictCodex, { action: "keep_open", itemId: "item-002" }]),
  ];
  const harmlessOmission = [
    message("claude", [stableConflictClaude]),
    message("codex", [stableConflictCodex, { action: "keep_open", itemId: "item-002" }]),
  ];

  const firstSignature = ledgerConflictSignature(explicitKeep);
  const secondSignature = ledgerConflictSignature(harmlessOmission);
  assert.ok(firstSignature);
  assert.equal(secondSignature, firstSignature);

  const tracker = createDegradedPersistenceTracker(2);
  const first = tracker.boundsFor(explicitKeep);
  assert.equal(first.exhausted.ledgerConflict, false);
  tracker.record({ degradedReason: "degraded_ledger_conflict" }, first.currentLedgerSignature);

  const second = tracker.boundsFor(harmlessOmission);
  assert.equal(second.currentLedgerSignature, first.currentLedgerSignature);
  assert.equal(second.exhausted.ledgerConflict, true);
});

test("ledger persistence still resets when the real conflicting merge target changes", () => {
  const mergeToTwo = [
    message("claude", [{ action: "merge_into", itemId: "item-001", targetItemId: "item-002" }]),
    message("codex", [stableConflictCodex]),
  ];
  const mergeToThree = [
    message("claude", [stableConflictClaude]),
    message("codex", [stableConflictCodex]),
  ];

  assert.notEqual(ledgerConflictSignature(mergeToTwo), ledgerConflictSignature(mergeToThree));
});
