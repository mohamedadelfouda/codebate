import test from "node:test";
import assert from "node:assert/strict";
import { launchBrowserHarness, waitFor } from "../browser/harness.mjs";
import { STRINGS as catalog } from "../../public/strings.js";

// RED browser-integration contract for the terminal-but-unresolved ledger-conflict outcome.
//
// This deliberately exercises the shipped discovery/rendering chain instead of matching app.js source:
//   persisted message -> latestRunMessages() -> finalReportFrom() -> latestRunFinalReport()
//   -> renderContextColumn() -> outcomeStatusMarkup()
//
// The outcome message is followed by a non-final notice so the test also proves discovery searches backward
// for the latest terminal report rather than relying on the outcome being the final message in the session.
//
// Keep skipped until degraded_ledger_conflict is implemented end-to-end. When unskipped, the browser must
// discover phase:"unresolved", render its dedicated localized stop label, and still withhold Execute.
test("scenario · RED browser: terminal unresolved outcome is discovered and rendered but never executable", {
  skip: "finalReportFrom does not yet include unresolved terminal outcomes; unskip with degraded_ledger_conflict public wiring",
}, async () => {
  const harness = await launchBrowserHarness();
  const { devtools } = harness;

  try {
    // launchBrowserHarness starts the real server in this process and sets its isolated runtime dir first,
    // so importing store here targets exactly the session storage that the browser is reading.
    const { createSession, mutateSession } = await import("../../server/store.js");
    const session = await createSession("Unresolved outcome discovery");
    const createdAt = new Date().toISOString();
    const plus = (ms) => new Date(new Date(createdAt).getTime() + ms).toISOString();

    await mutateSession(session.id, (stored) => {
      stored.settings = { ...(stored.settings || {}), rounds: 5 };
      stored.messages = [
        {
          id: "user-ledger-conflict",
          author: "user",
          content: "Resolve the ledger action split",
          createdAt,
          phase: "user",
          mode: "collaboration",
        },
        {
          id: "terminal-unresolved-ledger-conflict",
          author: "system",
          content: "Stored fallback must not be needed by the browser contract.",
          createdAt: plus(1),
          phase: "unresolved",
          mode: "collaboration",
          meta: {
            outcome: {
              outcomeVersion: 1,
              phase: "unresolved",
              agreementState: "open",
              completionState: "blocked",
              stopReason: "degraded_ledger_conflict",
              sealDegraded: true,
              requestedRounds: 5,
              completedRounds: 5,
              stoppedEarly: false,
              itemRegistry: [],
              pendingItems: [],
              pendingKinds: [],
              nextSteps: [],
              disagreements: [],
              proposedDisagreements: [],
              unclassifiedPoints: [],
              conflicts: [{ code: "conflicting_item_actions", itemId: "item-003" }],
              controlValid: true,
              controlsParseable: true,
              sealedOnQuorum: false,
              roundDiagnostics: [{ round: 5, controlFailures: [], validControlsConverged: true }],
            },
          },
        },
        {
          id: "later-non-final-notice",
          author: "system",
          content: "A later non-final notice must not hide the terminal outcome.",
          createdAt: plus(2),
          phase: "notice",
          mode: "collaboration",
          meta: { status: "notice" },
        },
      ];
      return true;
    });

    await devtools.evaluate(`(() => {
      localStorage.setItem("codebate-onboarded", "1");
      location.reload();
      return true;
    })()`);
    await waitFor(() => devtools.evaluate(`Boolean(document.querySelector("#sessionList .session-item"))`), 20000);
    await devtools.evaluate(`document.querySelector("#sessionList .session-item").click()`);
    await waitFor(() => devtools.evaluate(`!document.getElementById("sessionView").hidden`));

    // English decision/status card: reaching this label proves finalReportFrom actually discovered the
    // unresolved terminal message and renderContextColumn reached outcomeStatusMarkup.
    await devtools.evaluate(`document.querySelector('[data-lang="en"]').click()`);
    const enLabel = catalog.en.stopDegradedLedgerConflict;
    assert.equal(typeof enLabel, "string");
    await waitFor(() => devtools.evaluate(`document.getElementById("contextCol").textContent.includes(${JSON.stringify(enLabel)})`));

    // Same persisted outcome must remain discoverable after a locale switch and render the Arabic label too.
    await devtools.evaluate(`document.querySelector('[data-lang="ar"]').click()`);
    const arLabel = catalog.ar.stopDegradedLedgerConflict;
    assert.equal(typeof arLabel, "string");
    await waitFor(() => devtools.evaluate(`document.getElementById("contextCol").textContent.includes(${JSON.stringify(arLabel)})`));

    // Safety invariant from the P1 review: terminal does not mean adoptable. An unresolved ledger conflict
    // may stop the round loop, but the browser must never expose the bridge into execution for it.
    assert.equal(await devtools.evaluate(`Boolean(document.querySelector("#approvalHost .proceed"))`), false);
  } finally {
    await harness.cleanup();
  }
});
