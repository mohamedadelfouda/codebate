function actionChoice(control, itemId) {
  const proposal = control?.itemProposals?.find((item) => item.action !== "create" && item.itemId === itemId);
  if (!proposal) return ["missing", ""];
  return [proposal.action, proposal.action === "merge_into" ? proposal.targetItemId : ""];
}

function itemIsActuallyContested(messages, itemId) {
  const proposals = messages
    .map((message) => message.control.itemProposals?.find((proposal) => proposal.action !== "create" && proposal.itemId === itemId))
    .filter(Boolean);

  // Mirror convergence.js::proposedRegistryUpdate semantics. Omitting an open item and explicitly
  // keeping it open are equivalent; neither is a ledger action. Only a real disagreement about a
  // state-changing action should participate in degraded persistence.
  if (!proposals.length || proposals.every((proposal) => proposal.action === "keep_open")) return false;
  if (proposals.length === messages.length && proposals.every((proposal) => proposal.action === "resolve")) return false;
  const mergeTarget = proposals[0]?.targetItemId;
  if (
    proposals.length === messages.length
    && proposals.every((proposal) => proposal.action === "merge_into" && proposal.targetItemId === mergeTarget)
  ) return false;
  return true;
}

// Stable signature of the ACTUAL contested choices, not the lossy public conflict object.
// Agent identity, item id, action, and merge target all participate, so a changed split resets the streak.
// Non-conflicting omission/keep_open differences are intentionally ignored to match plannedRegistryUpdates().
export function ledgerConflictSignature(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return null;
  if (messages.some((message) => !message?.control?.valid)) return null;

  const itemIds = [...new Set(messages.flatMap((message) => (
    message.control.itemProposals || []
  ).filter((proposal) => proposal.action !== "create").map((proposal) => proposal.itemId)))].sort();

  const contested = [];
  for (const itemId of itemIds) {
    if (!itemIsActuallyContested(messages, itemId)) continue;
    const choices = messages.map((message) => ({
      agent: String(message.agent || ""),
      choice: actionChoice(message.control, itemId),
    })).sort((left, right) => left.agent.localeCompare(right.agent));
    contested.push([itemId, choices.map(({ agent, choice }) => [agent, ...choice])]);
  }
  return contested.length ? JSON.stringify(contested) : null;
}

export function createDegradedPersistenceTracker(limit) {
  let unreadableRounds = 0;
  let ledgerSignature = null;
  let ledgerRounds = 0;

  return {
    boundsFor(messages) {
      const currentLedgerSignature = ledgerConflictSignature(messages);
      return {
        currentLedgerSignature,
        exhausted: {
          unreadable: unreadableRounds + 1 >= limit,
          ledgerConflict: Boolean(
            currentLedgerSignature
            && currentLedgerSignature === ledgerSignature
            && ledgerRounds + 1 >= limit
          ),
        },
      };
    },

    record(assessment, currentLedgerSignature) {
      if (assessment.degradedReason === "degraded_convergence") unreadableRounds += 1;
      else unreadableRounds = 0;

      if (assessment.degradedReason === "degraded_ledger_conflict" && currentLedgerSignature) {
        if (currentLedgerSignature === ledgerSignature) ledgerRounds += 1;
        else {
          ledgerSignature = currentLedgerSignature;
          ledgerRounds = 1;
        }
      } else {
        ledgerSignature = null;
        ledgerRounds = 0;
      }
    },
  };
}
