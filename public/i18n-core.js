const ERROR_MESSAGE_KEYS = Object.freeze({
  unauthorized: "errorUnauthorized",
  forbidden_origin: "errorForbiddenOrigin",
  server_shutting_down: "errorServerShuttingDown",
  session_busy: "errorSessionBusy",
  title_required: "errorTitleRequired",
  state_change_requires_execution: "routeStateChangeRequiresExecution",
  project_trust_required: "routeProjectTrustRequired",
  project_path_required: "errorProjectPathRequired",
  project_path_not_found: "errorProjectPathNotFound",
  project_path_not_directory: "errorProjectPathNotDirectory",
  pending_execution_decisions: "errorPendingExecutionDecisions",
  project_not_attached: "errorProjectNotAttached",
  project_identity_changed: "errorProjectIdentityChanged",
  project_changed_before_trust: "errorProjectChangedBeforeTrust",
  startup_recovery_pending: "errorStartupRecoveryPending",
  invalid_orchestration_request: "errorInvalidDiscussionRequest",
  invalid_mode: "errorInvalidDiscussionRequest",
  invalid_rounds: "errorInvalidDiscussionRequest",
  message_required: "errorMessageRequired",
  invalid_participants: "errorInvalidParticipants",
  invalid_debate_participants: "errorInvalidDebateParticipants",
  invalid_provider: "errorInvalidProvider",
  invalid_agent_role: "errorInvalidDiscussionRequest",
  invalid_finalizer: "errorInvalidFinalizer",
  provider_unavailable: "errorProviderUnavailable",
  recovery_delete_confirmation_required: "errorRecoveryConfirmationRequired",
  execution_accept_failed: "errorExecutionAcceptFailed",
  execution_reject_failed: "errorExecutionRejectFailed",
  executor_unknown: "errorExecutorUnknown",
  reviewer_unknown: "errorReviewerUnknown",
  executor_reviewer_same: "errorExecutorReviewerSame",
  executor_cannot_execute: "errorExecutorCannotExecute",
  execution_task_required: "errorExecutionTaskRequired",
  execution_failed: "executionFailed",
  execution_stopped: "errorExecutionStopped",
  connector_catalog_failed: "errorConnectorCatalogFailed",
  connector_toggle_failed: "errorConnectorToggleFailed",
  connector_action_request_failed: "errorConnectorActionRequestFailed",
  connector_action_decision_failed: "errorConnectorActionDecisionFailed",
  connector_configuration_failed: "errorConnectorConfigurationFailed",
  invalid_connector: "errorInvalidConnectorRequest",
  invalid_connector_input: "errorInvalidConnectorRequest",
  invalid_connector_decision: "errorInvalidConnectorRequest",
  invalid_connector_configuration: "errorInvalidConnectorRequest",
  connector_input_too_large: "errorInvalidConnectorRequest",
  connector_action_not_found: "errorNotFound",
  connector_disabled: "errorConnectorDisabled",
  connector_project_untrusted: "errorConnectorProjectUntrusted",
  connector_proposal_limit: "errorConnectorProposalLimit",
  connector_action_already_decided: "errorConnectorActionAlreadyDecided",
  connector_auth_unavailable: "errorConnectorAuthUnavailable",
  connector_dependency_unavailable: "errorConnectorDependencyUnavailable",
  connector_response_invalid: "errorConnectorResponseInvalid",
  provider_update_failed: "errorProviderUpdateFailed",
  provider_check_failed: "errorProviderCheckFailed",
  provider_model_discovery_failed: "errorProviderModelDiscoveryFailed",
  provider_discovery_failed: "errorProviderDiscoveryFailed",
  github_repositories_unavailable: "errorGithubRepositoriesUnavailable",
  github_clone_failed: "errorGithubCloneFailed",
  filesystem_list_failed: "errorFilesystemListFailed",
  not_found: "errorNotFound",
  internal_error: "errorInternal",
});

const CONNECTOR_LABEL_KEYS = Object.freeze({
  github: "connectorGithub",
  gmail: "connectorGmail",
  supabase: "connectorSupabase",
});

const CONNECTOR_ACTION_KEYS = Object.freeze({
  "github:list_repositories": { label: "actionGithubListRepositories", description: "actionGithubListRepositoriesDescription" },
  "github:create_issue": { label: "actionGithubCreateIssue", description: "actionGithubCreateIssueDescription" },
  "gmail:list_messages": { label: "actionGmailListMessages", description: "actionGmailListMessagesDescription" },
  "gmail:get_message": { label: "actionGmailGetMessage", description: "actionGmailGetMessageDescription" },
  "gmail:send_message": { label: "actionGmailSendMessage", description: "actionGmailSendMessageDescription" },
  "supabase:select_rows": { label: "actionSupabaseSelectRows", description: "actionSupabaseSelectRowsDescription" },
  "supabase:insert_row": { label: "actionSupabaseInsertRow", description: "actionSupabaseInsertRowDescription" },
});

const CONNECTOR_STATUS_KEYS = Object.freeze({
  pending: "actionPending",
  executing_unknown: "actionUnknown",
  completed: "actionCompleted",
  running: "statusRunning",
  interrupted: "statusInterrupted",
  failed: "statusError",
  failed_after_approval: "actionFailed",
  rejected: "actionRejected",
});

const DECISION_TYPE_KEYS = Object.freeze({
  project_trust: "decisionTypeProjectTrust",
  execution: "decisionTypeExecution",
  connector: "decisionTypeConnector",
  connector_action: "decisionTypeConnectorAction",
  decision: "decisionTypeDecision",
});

const DECISION_OUTCOME_KEYS = Object.freeze({
  trusted: "decisionOutcomeTrusted",
  accepted: "decisionOutcomeAccepted",
  blocked_secret: "decisionOutcomeBlockedSecret",
  rejected: "decisionOutcomeRejected",
  enabled: "decisionOutcomeEnabled",
  disabled: "decisionOutcomeDisabled",
  approved: "decisionOutcomeApproved",
});

const DECISION_ACTION_KEYS = Object.freeze({
  merge: "decisionActionMerge",
  pr: "decisionActionPr",
});

export function localeId(language) {
  return language === "en" ? "en-GB" : "ar-EG";
}

export function formatLocaleNumber(language, value) {
  return new Intl.NumberFormat(localeId(language)).format(Number(value));
}

export function formatMessageCount(language, value) {
  const count = Math.max(0, Number(value) || 0);
  const locale = localeId(language);
  const category = new Intl.PluralRules(locale).select(count);
  if (language === "en") return `${formatLocaleNumber(language, count)} ${category === "one" ? "message" : "messages"}`;
  if (category === "zero") return "لا رسائل";
  if (category === "one") return "رسالة واحدة";
  if (category === "two") return "رسالتان";
  return `${formatLocaleNumber(language, count)} ${category === "few" ? "رسائل" : "رسالة"}`;
}

export function formatLocaleDuration(language, milliseconds) {
  const numeric = Number(milliseconds);
  if (!Number.isFinite(numeric)) return "";
  const totalSeconds = Math.max(0, Math.round(numeric / 1000));
  const locale = localeId(language);
  const secondsFormatter = new Intl.NumberFormat(locale, { style: "unit", unit: "second", unitDisplay: "short" });
  if (totalSeconds < 60) return secondsFormatter.format(totalSeconds);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const minutesFormatter = new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "short" });
  return new Intl.ListFormat(locale, { style: "narrow", type: "unit" }).format([
    minutesFormatter.format(minutes),
    secondsFormatter.format(seconds),
  ]);
}

export function errorMessageKey(failure = {}) {
  const code = failure.code || failure.reasonCode || failure.route?.reasonCode;
  return ERROR_MESSAGE_KEYS[code] || "errorUnexpected";
}

// Render the deterministic discussion outcome (the round-summary the orchestrator persists on the
// system message's `meta.outcome`) in the reader's language. The browser owns the user-facing wording:
// the server stores the structured outcome, and this renders it, so an English reader sees English and
// an Arabic reader sees Arabic from the same run. Returns `{ text, items }` — a single-direction summary
// sentence plus the free-text bullet lines (pending items or disagreements, authored by the agents), so
// the caller can render each bullet on its own line and bidi-isolate it. Returns empty text for a
// missing/truncated outcome so the caller can fall back to the stored text. Pure (no DOM), unit-tested.
//
// The Arabic wording mirrors `discussionOutcomeReport`/`terminalOutcomeReport`/`unfinishedOutcomeReport`
// in server/orchestrator.js, which still generates the stored `content` (the agent transcript + the
// truncated-meta fallback). Keep the two in sync until they are consolidated behind one renderer.
export function discussionOutcomeReport(outcome, language = "ar") {
  // Render only a complete, server-stamped outcome: buildDiscussionOutcome sets outcomeVersion 1 atomically
  // with every field, so its absence marks a truncated/foreign outcome that must fall back to the stored
  // content rather than render a generic "N rounds ended" summary over it. (Same validity marker as
  // officialOutcomeFrom in app.js.)
  if (!outcome || typeof outcome !== "object" || outcome.outcomeVersion !== 1 || typeof outcome.completedRounds !== "number") return { text: "", items: [] };
  const en = language === "en";
  const round = formatLocaleNumber(language, outcome.completedRounds);
  const pendingItems = Array.isArray(outcome.pendingItems) ? outcome.pendingItems.map((item) => item.text) : [];

  if (outcome.phase === "converged") {
    const text = outcome.stoppedEarly
      ? (en ? `The agents agreed and the task is complete at round ${round} — the remaining rounds were stopped.`
            : `الوكلاء اتفقوا والمهمة اكتملت في الجولة ${round} — تم إيقاف الجولات المتبقية.`)
      : (en ? `The agents agreed and the task is complete at the final round (${round}).`
            : `الوكلاء اتفقوا والمهمة اكتملت في الجولة الأخيرة (${round}).`);
    return { text, items: [] };
  }
  if (outcome.phase === "needs_user") {
    return { items: pendingItems, text: en
      ? `The agents agree; the discussion stopped at round ${round} because the outcome needs your decision.`
      : `الوكلاء متفقون، والنقاش توقف في الجولة ${round} لأن النتيجة تحتاج قرارك.` };
  }
  if (outcome.phase === "blocked_external") {
    return { items: pendingItems, text: en
      ? `The agents agree; the discussion stopped at round ${round} because the outcome awaits verification or an external step.`
      : `الوكلاء متفقون، والنقاش توقف في الجولة ${round} لأن النتيجة تنتظر تحققًا أو خطوة خارجية.` };
  }

  // Unfinished (no adoptable terminal agreement).
  if (outcome.stopReason === "invalid_control") {
    // Mirror the server's honest report: name the provider(s) whose control blocked certification (from the
    // final round's diagnostics) and surface any raised points, so this reads as the technical hiccup it is —
    // not a fabricated "the agents disagreed". Kept in sync with server/orchestrator.js controlBlameLine.
    const diagnostics = Array.isArray(outcome.roundDiagnostics) ? outcome.roundDiagnostics : [];
    const failures = (diagnostics.length && Array.isArray(diagnostics[diagnostics.length - 1].controlFailures))
      ? diagnostics[diagnostics.length - 1].controlFailures : [];
    const names = [...new Set(failures.map((failure) => failure && failure.agent).filter(Boolean))]
      .map((agent) => agent.charAt(0).toUpperCase() + agent.slice(1));
    const points = Array.isArray(outcome.proposedDisagreements) ? outcome.proposedDisagreements : [];
    if (names.length) {
      return { items: points, text: en
        ? `The discussion stopped for a technical reason after ${round} rounds: ${names.join(", ")}'s control data couldn't be certified, so the agreement wasn't sealed. This is not a disagreement between the agents, and adding rounds won't fix it.`
        : `توقّف النقاش لسبب تقني بعد ${round} جولات: تعذّر اعتماد بيانات التحكم من ${names.join("، ")}، فلم يُختم الاتفاق. هذا ليس خلافًا بين الوكلاء، وزيادة الجولات لن تحلّه.` };
    }
    return { items: points, text: en
      ? `${round} rounds ended, but the agreement couldn't be certified because the control data was missing or invalid — a technical reason, not a disagreement.`
      : `انتهت ${round} جولات، لكن تعذّر اعتماد الاتفاق لأن بيانات التحكم كانت ناقصة أو غير صالحة — سبب تقني، وليس خلافًا.` };
  }
  if (Array.isArray(outcome.disagreements) && outcome.disagreements.length) {
    return { items: [...outcome.disagreements], text: en
      ? `${round} rounds ended and a substantive disagreement between the agents remains:`
      : `انتهت ${round} جولات وما زال هناك اختلاف جوهري بين الوكلاء:` };
  }
  if (outcome.agreementState === "converged" && outcome.completionState === "incomplete") {
    return { items: pendingItems, text: en
      ? `${round} rounds ended. The agents agree on the current state, but the task still needs more work.`
      : `انتهت ${round} جولات. الوكلاء متفقون على الوضع الحالي، لكن المهمة ما زالت تحتاج شغلًا إضافيًا.` };
  }
  return { items: [], text: en
    ? `${round} rounds ended without a final, adoptable agreement.`
    : `انتهت ${round} جولات من غير اتفاق نهائي قابل للاعتماد.` };
}

export function connectorLabelKey(connectorId) {
  return CONNECTOR_LABEL_KEYS[connectorId] || null;
}

export function connectorActionKeys(connectorId, actionId) {
  return CONNECTOR_ACTION_KEYS[`${connectorId}:${actionId}`] || null;
}

export function connectorStatusKey(status) {
  return CONNECTOR_STATUS_KEYS[status] || null;
}

export function decisionTypeKey(type) {
  return DECISION_TYPE_KEYS[type] || null;
}

export function decisionOutcomeKey(outcome) {
  return DECISION_OUTCOME_KEYS[outcome] || null;
}

export function decisionActionKey(action) {
  return DECISION_ACTION_KEYS[action] || null;
}
