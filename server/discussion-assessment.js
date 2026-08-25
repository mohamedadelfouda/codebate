import {
  assessRound as assessBaseRound,
  parseAgentControl,
  stripAgentControl,
  validateControlRepair,
} from "./convergence.js";

export { parseAgentControl, stripAgentControl, validateControlRepair };

function degradedBounds(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      unreadable: value.unreadable === true,
      ledgerConflict: value.ledgerConflict === true,
    };
  }
  const exhausted = value === true;
  return { unreadable: exhausted, ledgerConflict: exhausted };
}

function readableLedgerConflictEligible(assessment, controls) {
  if (!assessment.allValid || !assessment.controlsParseable) return false;
  if (assessment.consistencyErrors.length || assessment.unclassifiedPoints.length || assessment.disagreements.length) return false;
  if (!assessment.conflicts.length || assessment.conflicts.some((conflict) => conflict.code !== "conflicting_item_actions")) return false;
  if (!controls.length || controls.some((control) => !control?.valid || control.convergence !== "converged" || control.substantiveDelta)) return false;

  const conflictItems = new Set(assessment.conflicts.map((conflict) => conflict.itemId));
  // A contested ledger item is itself unresolved agent work, but unrelated remaining_work/disagreement
  // must never be hidden by this bounded stop. External/user steps are safe to keep pending and surface.
  return !assessment.pendingItems.some((item) => (
    item.requiredStep?.action === "resume_agent_round" && !conflictItems.has(item.itemId)
  ));
}

export function assessRound(
  controls,
  targetVersion,
  itemRegistry = [],
  confirmationsExhausted = false,
  degradedExhausted = false,
) {
  const bounds = degradedBounds(degradedExhausted);
  const assessment = assessBaseRound(
    controls,
    targetVersion,
    itemRegistry,
    confirmationsExhausted,
    bounds.unreadable,
  );

  if (!readableLedgerConflictEligible(assessment, controls)) {
    return {
      ...assessment,
      degradedReason: assessment.degradable ? "degraded_convergence" : null,
    };
  }

  const degradedStop = bounds.ledgerConflict;
  return {
    ...assessment,
    degradable: true,
    degradedStop,
    degradedReason: "degraded_ledger_conflict",
    stopReason: degradedStop ? "degraded_ledger_conflict" : assessment.stopReason,
  };
}
