import {
  connectorActionKeys,
  connectorLabelKey,
  connectorStatusKey,
  decisionActionKey,
  decisionOutcomeKey,
  decisionTypeKey,
  discussionOutcomeReport,
  errorMessageKey,
  formatLocaleDuration,
  formatMessageCount,
  formatLocaleNumber,
  localeId,
} from "./i18n-core.js";
import { createLatestRequest } from "./latest-request.js";
import { activityControls } from "./activity-state.js";
import { closeReservedPrWindow, openReservedPrWindow, reservePrWindow } from "./pr-window.js";
import { STRINGS } from "./strings.js";
import { renderMarkdown } from "./markdown.js";
import { shouldHandleRunEvent } from "./run-events.js";

const $ = (id) => document.getElementById(id);

let currentSessionId = null;
let currentSession = null;
let sessionViewEpoch = 0;
const sessionRequests = createLatestRequest((id) => api(`/api/sessions/${id}`));
const connectorRequests = createLatestRequest(async (id) => {
  const [data, configuration] = await Promise.all([
    api(`/api/sessions/${id}/connectors`),
    api("/api/connector-config"),
  ]);
  return { data, configuration };
});
let eventSource = null;
let mode = "collaboration";
let running = false;
let currentRunId = null;
let activeShellOverlay = null;
let shellOverlayTrigger = null;
let lang = "ar";
let routeSuggestion = null;

function isCurrentSessionView(sessionId, viewEpoch) {
  return currentSessionId === sessionId && sessionViewEpoch === viewEpoch;
}
let providers = [];
let lastProvidersReady = true; // last-known setup completeness, so applyLang can restore the ⚙ badge label
let renderedMessageSessionId = null;
let renderedMessageIds = new Set();
let pendingAttachments = [];
let sessionGroupBy = localStorage.getItem("codebate-session-group") || "date";
let renameTargetId = null;
let openSessionMenu = null;
let openSessionMenuAnchor = null;
const ATTACH_MAX_BYTES = 100 * 1024;
const ATTACH_MAX_FILES = 5;
const ATTACH_MAX_TOTAL_BYTES = 300 * 1024;

// Enumerates every possible per-provider control id. A descriptor-launched provider (e.g. Cursor) renders no
// Command/Effort element, so saveSettings/loadSettings must keep their `if (!$(id)) continue` guards.
const settingsIds = () => ["rounds", "finalizer", ...providers.flatMap((item) => ["Command", "Model", "Effort", "Role", "Enabled"].map((suffix) => `${item.id}${suffix}`))];
const providerInfo = (id) => providers.find((item) => item.id === id) || { id, label: id || "Agent" };
// A distinct mark per provider, drawn in the provider's brand colour (currentColor), so Claude, Codex and
// Cursor — whose labels all start with "C" — are told apart at a glance instead of every avatar showing the
// letter "C". Authored inline SVG (never user data), so it's safe to inject; unknown providers fall back to
// their first letter.
const PROVIDER_GLYPHS = {
  // Brand logos supplied by the user. Codex's shipped `<style>.a{fill:…}` + class="a" was replaced with a
  // direct fill (a global `.a` rule would bleed onto the rest of the page); its gradient lives once in the
  // #cdxGrad sprite in index.html (a per-avatar def went blank whenever its container was hidden). Cursor is
  // monochrome (currentColor), so it takes the avatar's brand tint.
  claude: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#D97757" fill-rule="nonzero" d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>`,
  codex: `<svg viewBox="0 0 250 250" aria-hidden="true"><path fill="url(#cdxGrad)" d="m84.3 5.1q3.7-1.5 7.7-2.6 3.9-1 7.9-1.6 4-0.5 8.1-0.6 4 0 8 0.5 20.7 2.4 37.1 17.7 0.1 0.1 0.4 0.3 0.1 0 0.2 0 0 0 0.2 0 0 0 0.1 0 0 0 0.1 0 5.2-1.4 10.7-1.9 5.4-0.4 10.7 0.1 5.5 0.4 10.7 1.9 5.2 1.3 10.1 3.6l0.6 0.4 1.6 0.8q5.2 2.5 9.7 6.1 4.7 3.4 8.6 7.7 3.8 4.3 6.9 9.2 3 4.8 5.2 10.2 4.3 10.5 4.3 22.1 0.2 2.1 0 4.2-0.1 2.2-0.2 4.3-0.3 2.1-0.7 4.3-0.4 2.1-0.9 4.1 0 0.2 0 0.4 0 0.2 0 0.5 0 0.1 0.1 0.4 0.1 0.1 0.3 0.3 12.3 12.6 16.3 30 6 29.7-12.2 53.5l-1.9 2.2q-3 3.5-6.5 6.4-3.4 3.1-7.3 5.5-3.8 2.4-8.1 4.2-4.1 1.9-8.5 3.2-0.3 0-0.4 0.2-0.3 0-0.4 0.1-0.1 0.1-0.3 0.4 0 0.1-0.1 0.3c-2.7 7.7-5.3 14.2-10.2 20.7-12.5 16.5-30.8 25.5-51.5 25.5q-24.6-0.1-43.6-18.1-0.2-0.1-0.4-0.2-0.2-0.1-0.4-0.1-0.2 0-0.3 0-0.3 0-0.4 0c-5.4 1.7-10.9 1.9-16.7 1.9q-3.5 0-7-0.5-3.4-0.4-6.9-1.2-3.3-0.8-6.6-2-3.3-1.2-6.4-2.8-3.3-1.6-6.4-3.6-3-2-5.8-4.3-3-2.3-5.5-5-2.5-2.6-4.6-5.6c-2.2-2.7-4.3-5.4-5.8-8.5q-0.8-1.6-1.6-3.2-0.6-1.7-1.3-3.3-0.7-1.7-1.2-3.4-0.5-1.6-1-3.4-1.1-4-1.6-7.9-0.6-4-0.6-8 0-4 0.6-8 0.4-4 1.4-8 0 0 0-0.1 0-0.1 0-0.1 0.2-0.2 0.2-0.3 0-0.1-0.2-0.1 0-0.2 0-0.3 0-0.1-0.1-0.1 0-0.2 0-0.2-0.1-0.1-0.1-0.1-2.4-2.5-4.6-5.2-2.1-2.7-4-5.4-1.7-3-3.2-6-1.5-3.1-2.6-6.3-0.8-2-1.3-4.1-0.7-2-1.1-4-0.4-2.1-0.7-4.2-0.2-2.2-0.4-4.3-0.2-2.8-0.1-5.6 0-2.8 0.3-5.4 0.1-2.8 0.6-5.6 0.4-2.8 1.1-5.5 7-23.1 26.9-36.3 4.3-2.9 8.2-4.5 4.5-1.9 9-3.2 0.2 0 0.3-0.1 0.1-0.2 0.3-0.3 0.1 0 0.1-0.3 0.1-0.1 0.1-0.2 1-3.1 2.2-6 1-2.9 2.5-5.7 1.5-3 3.2-5.6 1.7-2.7 3.7-5.1 2.5-3.2 5.3-5.9 3-2.8 6.1-5.4 3.2-2.4 6.8-4.4 3.5-2 7.2-3.5zm48.3 146.4c-2.3 0.1-4.4 1-6 2.8-1.5 1.6-2.4 3.7-2.4 5.9 0 2.3 0.9 4.4 2.4 6.2 1.6 1.6 3.7 2.5 6 2.6h50.4c2.4 0.1 4.8-0.6 6.5-2.4 1.7-1.6 2.8-4 2.8-6.4 0-2.4-1.1-4.7-2.8-6.3-1.7-1.8-4.1-2.6-6.5-2.4zm-56.7-64.9c-1.2-1.9-3-3.4-5.3-3.9-2.2-0.5-4.5-0.3-6.5 0.9-2 1.1-3.5 3-4.1 5.2-0.7 2.2-0.4 4.6 0.6 6.5l17.7 30.9-17.5 29.5c-1.2 2-1.6 4.5-1.1 6.8 0.7 2.3 2.1 4.1 4.1 5.3 2 1.2 4.4 1.6 6.7 0.9 2.2-0.5 4.2-1.9 5.4-3.9l20.1-34.1q0.7-0.9 0.9-2.1 0.3-1.1 0.3-2.3 0-1.2-0.3-2.2-0.2-1.2-0.8-2.2z"/></svg>`,
  cursor: `<svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true"><path d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z"/></svg>`,
};
const providerGlyph = (id, label) => PROVIDER_GLYPHS[id] || esc(String(label || id || "?").slice(0, 1));

/* ---------------- i18n ---------------- */
const t = (key) => STRINGS[lang][key];

function bdi(value, direction = "auto") {
  return `<bdi dir="${direction}">${esc(value)}</bdi>`;
}

function failureDetail(failure) {
  return String(failure?.detail || failure?.error || failure?.warning || failure?.message || "");
}

function localizedFailure(failure) {
  const key = errorMessageKey(failure);
  const detail = failureDetail(failure);
  if (detail) console.error(`[Codebate: ${failure?.code || failure?.reasonCode || "unexpected"}] ${detail}`);
  return t(key) || t("errorUnexpected");
}

// A persisted app-error message (an exec_error, or a run failure) resolves its localized text from the
// stored error `code` when present, so reloading the transcript shows the same specific explanation the
// live SSE announcement did — not a generic line. Legacy messages (no code) and run failures fall back to
// their existing generic keys.
function appErrorMessageKey(message) {
  if (message.phase !== "exec_error") return "runFailed";
  const code = message.meta?.code;
  return code ? errorMessageKey({ code }) : "executionFailed";
}

function failureFromPayload(payload) {
  return Object.assign(new Error(failureDetail(payload)), payload);
}

function localizedMarkup(key, fallback) {
  return key ? esc(t(key)) : bdi(fallback, "ltr");
}

function effortMessageKey(value) {
  return {
    minimal: "effortMinimal",
    low: "effortLow",
    medium: "effortMedium",
    high: "effortHigh",
    xhigh: "effortXhigh",
    max: "effortMax",
    ultracode: "effortUltracode",
  }[value] || null;
}

function rolePresetForValue(value) {
  for (const language of Object.keys(STRINGS)) {
    for (const key of ["defaultRole", "debateAdvocateRole", "debateChallengerRole"]) {
      if (STRINGS[language][key] === value) return key;
    }
  }
  return null;
}

function applyRolePreset(input, presetKey) {
  if (!input || input.dataset.roleEdited === "true") return;
  input.dataset.rolePreset = presetKey;
  input.value = t(presetKey);
}

function localizeProviderRoles() {
  providers.forEach((item) => {
    const input = $(`${item.id}Role`);
    if (input) applyRolePreset(input, input.dataset.rolePreset || "defaultRole");
  });
}

// First-run default: honor a saved choice, otherwise follow the browser's PRIMARY
// language and fall back to English. Only a browser whose top preference is Arabic
// opens in Arabic — everyone else (the open-source default audience) gets English.
// (We deliberately read navigator.language, not navigator.languages: an English-first
// user who merely lists Arabic as a secondary locale should still default to English.)
function detectDefaultLang() {
  const saved = localStorage.getItem("codebate-lang");
  if (STRINGS[saved]) return saved;
  return String(navigator.language || "").toLowerCase().startsWith("ar") ? "ar" : "en";
}

function applyLang(next) {
  lang = STRINGS[next] ? next : "ar";
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
  document.querySelectorAll("[data-i18n]").forEach((el) => { const k = el.getAttribute("data-i18n"); if (STRINGS[lang][k]) el.textContent = t(k); });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => { const k = el.getAttribute("data-i18n-ph"); if (STRINGS[lang][k]) el.placeholder = t(k); });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => { const k = el.getAttribute("data-i18n-title"); if (STRINGS[lang][k]) el.title = t(k); });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    const value = STRINGS[lang][el.getAttribute("data-i18n-aria-label")];
    if (typeof value === "string") el.setAttribute("aria-label", value);
  });
  reflectSetupBadge(lastProvidersReady); // re-apply after the static ⚙ aria-label above was reset

  document.querySelectorAll("[data-provider-toggle]").forEach((input) => input.setAttribute("aria-label", t("providerEnabled")(providerInfo(input.dataset.providerToggle).label)));
  document.querySelectorAll(".check-cli").forEach((button) => button.setAttribute("aria-label", t("checkProvider")(providerInfo(button.dataset.agent).label)));
  document.querySelectorAll(".setup-cli").forEach((button) => button.setAttribute("aria-label", t("setupProviderCli")(providerInfo(button.dataset.agent).label)));
  document.querySelectorAll(".load-models").forEach((button) => button.setAttribute("aria-label", t("loadProviderModels")(providerInfo(button.dataset.agent).label)));
  document.querySelectorAll("[data-effort-value]").forEach((option) => {
    const key = effortMessageKey(option.dataset.effortValue);
    option.textContent = key ? t(key) : option.dataset.effortValue;
    option.dir = key ? "auto" : "ltr";
  });
  localizeProviderRoles();
  document.querySelectorAll(".lang-btn").forEach((b) => {
    const active = b.dataset.lang === lang;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-pressed", String(active));
  });
  setConnected(!$("serverStatus").classList.contains("is-bad") ? true : false);
  updateSetupSummary();
  applyShellChrome();
  refreshSessions();
  if (currentSession) { loadSessionMeta(); renderMessages(); loadConnectors(); }
  // Onboarding status rows are built with baked-in t(...) labels (no data-i18n), so re-render them when the
  // language changes while the dialog is open — otherwise the list stays in the previous language while the
  // static parts around it flip (the picker now lives inside this dialog, so that switch is reachable).
  if (!$("onboardModal")?.classList.contains("hidden")) loadOnboard();
  localStorage.setItem("codebate-lang", lang);
}

/* ---------------- settings ---------------- */
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("codebate-settings") || "{}");
    for (const id of settingsIds()) {
      const el = $(id); if (!el || !(id in saved)) continue;
      if (el.type === "checkbox") el.checked = Boolean(saved[id]); else el.value = saved[id];
      if (id.endsWith("Role")) {
        const preset = rolePresetForValue(el.value);
        el.dataset.roleEdited = String(!preset);
        if (preset) el.dataset.rolePreset = preset;
      }
    }
    if (saved.mode) setMode(saved.mode, true);
  } catch {}
}
function saveSettings() {
  const saved = { mode };
  for (const id of settingsIds()) { const el = $(id); if (!el) continue; saved[id] = el.type === "checkbox" ? el.checked : el.value; }
  localStorage.setItem("codebate-settings", JSON.stringify(saved));
}

/* ---------------- api ---------------- */
async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", headers: { "Content-Type": "application/json; charset=utf-8", ...(options.headers || {}) }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `HTTP ${res.status}`);
    Object.assign(error, data);
    throw error;
  }
  return data;
}

/* ---------------- managed modal focus ---------------- */
const FOCUSABLE_SELECTOR = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";
let activeModal = null;
let activeModalDismiss = null;
let modalReturnFocus = null;

function focusableElements(modal) {
  return [...modal.querySelectorAll(FOCUSABLE_SELECTOR)].filter((element) => element.getClientRects().length > 0);
}

function openManagedModal(modal, { initialFocus, dismiss }) {
  if (activeModal && activeModal !== modal) closeManagedModal(activeModal, { restoreFocus: false });
  modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  activeModal = modal;
  activeModalDismiss = dismiss;
  $("appShell").inert = true;
  modal.classList.remove("hidden");
  requestAnimationFrame(() => {
    const target = initialFocus || focusableElements(modal)[0] || modal.querySelector(".modal");
    target?.focus();
  });
}

function closeManagedModal(modal, { restoreFocus = true } = {}) {
  modal.classList.add("hidden");
  if (activeModal !== modal) return;
  const returnFocus = modalReturnFocus;
  activeModal = null;
  activeModalDismiss = null;
  modalReturnFocus = null;
  $("appShell").inert = false;
  if (restoreFocus && returnFocus?.isConnected) requestAnimationFrame(() => returnFocus.focus());
}

document.addEventListener("keydown", (event) => {
  if (!activeModal) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    activeModalDismiss?.();
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = focusableElements(activeModal);
  if (!focusable.length) {
    event.preventDefault();
    activeModal.querySelector(".modal")?.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const currentIndex = focusable.indexOf(document.activeElement);
  if (currentIndex === -1 || (event.shiftKey && document.activeElement === first)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}, true);

async function loadProviderCatalog() {
  const response = await api("/api/providers");
  providers = response.providers || [];
  const grid = $("agentsGrid");
  grid.innerHTML = "";
  for (const item of providers) {
    const card = document.createElement("article");
    card.className = "agent-card";
    card.dataset.agent = item.id;
    const modelList = `${item.id}Models`;
    const titleId = `${item.id}Title`;
    const enabledId = `${item.id}Enabled`;
    const commandId = `${item.id}Command`;
    const modelId = `${item.id}Model`;
    const effortId = `${item.id}Effort`;
    const roleId = `${item.id}Role`;
    const modelOptions = (item.models || []).map((model) => `<option value="${esc(model)}"></option>`).join("");
    const effortOptions = (item.efforts || []).map((effort) => {
      const key = effortMessageKey(effort);
      return `<option value="${esc(effort)}" data-effort-value="${esc(effort)}" dir="${key ? "auto" : "ltr"}"${effort === "high" ? " selected" : ""}>${esc(key ? t(key) : effort)}</option>`;
    }).join("");
    card.setAttribute("aria-labelledby", titleId);
    card.innerHTML = [
      `<div class="agent-head"><span class="agent-avatar ${esc(item.id)}" aria-hidden="true">${providerGlyph(item.id, item.label)}</span>`,
      `<div class="agent-id"><h3 id="${esc(titleId)}">${esc(item.label)}</h3>${item.descriptorLaunch ? "" : `<span id="${esc(item.id)}Health" class="health" role="status" aria-live="polite" data-i18n="notChecked">${esc(t("notChecked"))}</span>`}</div>`,
      `<label class="switch" for="${esc(enabledId)}"><input id="${esc(enabledId)}" type="checkbox" ${item.defaultEnabled === false ? "" : "checked"} data-provider-toggle="${esc(item.id)}" aria-label="${esc(t("providerEnabled")(item.label))}"><span aria-hidden="true"></span></label></div>`,
      `<div class="agent-fields">${item.descriptorLaunch ? "" : `<div class="field"><label for="${esc(commandId)}" data-i18n="command">${esc(t("command"))}</label><div class="inline"><input id="${esc(commandId)}" value="${esc(item.command)}"><button class="btn-mini check-cli" data-agent="${esc(item.id)}" data-i18n="check" aria-label="${esc(t("checkProvider")(item.label))}">${esc(t("check"))}</button><button class="btn-mini setup-cli" data-agent="${esc(item.id)}" data-i18n="setupCli" aria-label="${esc(t("setupProviderCli")(item.label))}" aria-expanded="false" aria-controls="${esc(item.id)}CliSetup">${esc(t("setupCli"))}</button></div></div>`}`,
      `<div class="field"><label for="${esc(modelId)}" data-i18n="model">${esc(t("model"))}</label><div class="inline"><input id="${esc(modelId)}" list="${esc(modelList)}" value="${esc(item.defaultModel || "")}">${item.dynamicModels ? `<button class="btn-mini load-models" data-agent="${esc(item.id)}" data-i18n="load" aria-label="${esc(t("loadProviderModels")(item.label))}">${esc(t("load"))}</button>` : ""}</div><datalist id="${esc(modelList)}">${modelOptions}</datalist></div>`,
      `${(item.efforts || []).length ? `<div class="field"><label for="${esc(effortId)}" data-i18n="effort">${esc(t("effort"))}</label><select id="${esc(effortId)}">${effortOptions}</select></div>` : ""}`,
      `<div class="field"><label for="${esc(roleId)}" data-i18n="role">${esc(t("role"))}</label><input id="${esc(roleId)}" value="${esc(t("defaultRole"))}" data-role-preset="defaultRole" data-role-edited="false"></div></div>`,
      `${item.descriptorLaunch ? "" : `<div id="${esc(item.id)}CliSetup" class="cli-setup" aria-live="polite" hidden></div>`}`,
      `<div id="${esc(item.id)}RunState" class="run-state" role="status" aria-live="polite" data-i18n="ready">${esc(t("ready"))}</div>`,
    ].join("");
    grid.appendChild(card);
    $(roleId).addEventListener("input", (event) => { event.currentTarget.dataset.roleEdited = "true"; });
  }

  const fillSelect = (element, filter = () => true) => {
    element.innerHTML = "";
    for (const item of providers.filter(filter)) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      element.appendChild(option);
    }
  };
  fillSelect($("finalizer"));
  const none = document.createElement("option");
  none.value = "none";
  none.dataset.i18n = "none";
  none.textContent = t("none");
  $("finalizer").appendChild(none);
  fillSelect($("execExecutor"), (item) => item.capabilities?.executeModes?.length);
  fillSelect($("execReviewer"));
  const runProvider = providers.find((item) => item.capabilities?.executeModes?.includes("run"));
  if (runProvider) $("execExecutor").value = runProvider.id;
  const alternate = providers.find((item) => item.id !== $("execExecutor").value);
  if (alternate) $("execReviewer").value = alternate.id;

  document.querySelectorAll(".check-cli").forEach((button) => { button.onclick = () => checkCli(button.dataset.agent); });
  document.querySelectorAll(".setup-cli").forEach((button) => { button.onclick = () => toggleCliSetup(button.dataset.agent); });
  document.querySelectorAll(".load-models").forEach((button) => { button.onclick = () => loadModels(button.dataset.agent, button); });
  settingsIds().forEach((id) => { const element = $(id); if (element) element.addEventListener("change", () => { saveSettings(); updateSetupSummary(); }); });
}

/* ---------------- mode + setup drawer ---------------- */
function setMode(next, silent) {
  mode = next === "debate" ? "debate" : next === "chat" ? "chat" : "collaboration";
  document.querySelectorAll(".mode-btn").forEach((b) => {
    const active = b.dataset.mode === mode;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-pressed", String(active));
  });
  providers.forEach((item, index) => {
    const preset = mode === "debate"
      ? (index === 0 ? "debateAdvocateRole" : "debateChallengerRole")
      : "defaultRole";
    applyRolePreset($(`${item.id}Role`), preset);
  });
  // Chat is a single independent pass per message — rounds and finalizer don't apply.
  const isChat = mode === "chat";
  $("rounds").disabled = isChat;
  $("finalizer").disabled = isChat;
  updateSetupSummary();
  if (!silent) saveSettings();
}
function toggleSetup() {
  const drawer = $("setupDrawer");
  const open = drawer.hidden;
  drawer.hidden = !open;
  $("setupToggle").setAttribute("aria-expanded", String(open));
  if (open) {
    $("execDrawer").hidden = true;
    $("execToggle").setAttribute("aria-expanded", "false");
  }
}
function updateSetupSummary() {
  const parts = providers.filter((item) => $(`${item.id}Enabled`)?.checked).map((item) => item.label);
  const modeLabel = discussionModeLabel(mode);
  const roundsPart = mode === "chat" ? "" : ` · ${formatLocaleNumber(lang, $("rounds").value)} ${t("roundsShort")}`;
  $("setupSummary").textContent = `${modeLabel} · ${parts.join(" + ") || "—"}${roundsPart}`;
}

/* ---------------- sessions rail ---------------- */
function discussionModeLabel(value) {
  return { collaboration: t("modeCollab"), debate: t("modeDebate"), chat: t("modeChat"), idle: t("statusIdle"), recovery: t("recoverySession") }[value] || String(value || "");
}

function sessionStatusLabel(status) {
  const key = {
    idle: "statusIdle",
    running: "statusRunning",
    completed: "statusCompleted",
    error: "statusError",
    interrupted: "statusInterrupted",
    recovery_needed: "statusRecovery",
  }[status];
  return key ? t(key) : String(status || t("statusIdle"));
}

function phaseLabel(phase) {
  const key = {
    chat: "phaseChat",
    collaboration: "phaseCollaboration",
    opening: "phaseOpening",
    rebuttal: "phaseRebuttal",
    synthesis: "phaseSynthesis",
    converged: "phaseConverged",
    needs_user: "phaseNeedsUser",
    blocked_external: "phaseBlockedExternal",
    needs_more_rounds: "phaseNeedsMoreRounds",
  }[phase];
  return key ? t(key) : String(phase || "");
}

async function refreshSessions() {
  let sessions;
  try { sessions = await api("/api/sessions"); } catch { return; }
  const list = $("sessionList");
  list.innerHTML = "";
  closeSessionMenu();
  const groups = groupSessions(sessions, sessionGroupBy);
  for (const group of groups) {
    const label = document.createElement("div");
    label.className = "session-group-label";
    label.textContent = group.label;
    list.appendChild(label);
    for (const s of group.sessions) {
      const row = document.createElement("div");
      row.className = `session-row ${s.id === currentSessionId ? "is-active" : ""}`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "session-item";
      if (s.id === currentSessionId) btn.setAttribute("aria-current", "page");
      const dot = document.createElement("span");
      dot.className = `si-dot ${s.status || ""}`;
      dot.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span");
      copy.className = "si-copy";
      const title = document.createElement("strong");
      title.className = "si-title";
      title.textContent = s.recoveryNeeded ? t("recoverySession") : s.title;
      const meta = document.createElement("small");
      meta.className = "si-sub";
      meta.textContent = `${discussionModeLabel(s.mode)} · ${formatMessageCount(lang, s.messageCount)} · ${sessionStatusLabel(s.status)}`;
      copy.append(title, meta);
      btn.append(dot, copy);
      btn.onclick = () => s.recoveryNeeded ? toggleSessionMenu(more, s) : openSession(s.id);
      const more = document.createElement("button");
      more.type = "button";
      more.className = "session-more";
      more.setAttribute("aria-label", t("sessionMenu"));
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute("aria-expanded", "false");
      more.textContent = "⋯";
      more.onclick = (event) => {
        event.stopPropagation();
        toggleSessionMenu(more, s);
      };
      row.append(btn, more);
      list.appendChild(row);
    }
  }
}

function groupSessions(sessions, by) {
  const buckets = new Map();
  for (const session of sessions) {
    let key;
    let label;
    if (by === "project") {
      const path = String(session.projectPath || "").trim();
      key = path || "__none__";
      label = path ? projectBasename(path) : t("noProject");
    } else {
      const bucket = dateBucket(session.updatedAt);
      key = bucket.key;
      label = bucket.label;
    }
    if (!buckets.has(key)) buckets.set(key, { key, label, sessions: [] });
    buckets.get(key).sessions.push(session);
  }
  return [...buckets.values()];
}

function projectBasename(projectPath) {
  const parts = String(projectPath).replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || projectPath;
}

function dateBucket(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return { key: "earlier", label: t("earlier") };
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startThat = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDiff = Math.round((startToday - startThat) / 86400000);
  if (dayDiff <= 0) return { key: "today", label: t("today") };
  if (dayDiff === 1) return { key: "yesterday", label: t("yesterday") };
  return { key: "earlier", label: t("earlier") };
}

function closeSessionMenu({ restoreFocus = false } = {}) {
  if (openSessionMenu) {
    openSessionMenu.remove();
    openSessionMenu = null;
  }
  document.querySelectorAll(".session-more[aria-expanded='true']").forEach((btn) => btn.setAttribute("aria-expanded", "false"));
  if (restoreFocus) openSessionMenuAnchor?.focus();
  openSessionMenuAnchor = null;
}

function onSessionMenuKeydown(event) {
  const items = [...openSessionMenu.querySelectorAll("[role='menuitem']")];
  const currentIndex = items.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    items[(currentIndex + delta + items.length) % items.length]?.focus();
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeSessionMenu({ restoreFocus: true });
  } else if (event.key === "Tab") {
    // A borderless popup menu isn't part of the page's tab order — Tab closes it.
    closeSessionMenu();
  }
}

function toggleSessionMenu(anchor, session) {
  if (openSessionMenu && openSessionMenu.dataset.sessionId === session.id) {
    closeSessionMenu();
    return;
  }
  closeSessionMenu();
  const menu = document.createElement("div");
  menu.className = "session-menu";
  menu.dataset.sessionId = session.id;
  menu.setAttribute("role", "menu");
  if (session.recoveryNeeded) {
    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.setAttribute("role", "menuitem");
    exportBtn.textContent = t("recoveryExport");
    exportBtn.onclick = () => {
      closeSessionMenu();
      const link = document.createElement("a");
      link.href = `/api/session-recovery/${session.recoveryId}/export`;
      link.download = "";
      document.body.appendChild(link);
      link.click();
      link.remove();
    };
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.setAttribute("role", "menuitem");
    retryBtn.textContent = t("recoveryRetry");
    retryBtn.onclick = async () => {
      closeSessionMenu();
      try {
        await api(`/api/session-recovery/${session.recoveryId}/retry`, { method: "POST", body: "{}" });
        await refreshSessions();
      } catch (error) { $("liveStatus").textContent = localizedFailure(error); }
    };
    const recoveryDeleteBtn = document.createElement("button");
    recoveryDeleteBtn.type = "button";
    recoveryDeleteBtn.className = "is-danger";
    recoveryDeleteBtn.setAttribute("role", "menuitem");
    recoveryDeleteBtn.textContent = t("recoveryDelete");
    recoveryDeleteBtn.onclick = async () => {
      closeSessionMenu();
      if (!window.confirm(t("recoveryDeleteConfirm"))) return;
      try {
        await api(`/api/session-recovery/${session.recoveryId}`, { method: "DELETE", body: JSON.stringify({ confirm: true }) });
        await refreshSessions();
      } catch (error) { $("liveStatus").textContent = localizedFailure(error); }
    };
    menu.append(exportBtn, retryBtn, recoveryDeleteBtn);
  } else {
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.setAttribute("role", "menuitem");
    renameBtn.textContent = t("renameSession");
    renameBtn.onclick = () => { closeSessionMenu(); openRenameSessionModal(session); };
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "is-danger";
    deleteBtn.setAttribute("role", "menuitem");
    deleteBtn.textContent = t("deleteSession");
    deleteBtn.onclick = () => { closeSessionMenu(); void confirmDeleteSession(session); };
    menu.append(renameBtn, deleteBtn);
  }
  menu.addEventListener("keydown", onSessionMenuKeydown);
  document.body.appendChild(menu);
  openSessionMenu = menu;
  openSessionMenuAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  const rect = anchor.getBoundingClientRect();
  const menuWidth = menu.offsetWidth;
  const left = Math.min(window.innerWidth - menuWidth - 8, Math.max(8, rect.left));
  menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, rect.bottom + 4)}px`;
  menu.style.left = `${left}px`;
  menu.querySelector("[role='menuitem']")?.focus();
}

function openRenameSessionModal(session) {
  renameTargetId = session.id;
  $("renameSessionInput").value = session.title || "";
  $("renameSessionError").textContent = "";
  $("renameSessionError").classList.add("hidden");
  openManagedModal($("renameSessionModal"), { initialFocus: $("renameSessionInput"), dismiss: closeRenameSessionModal });
}

function closeRenameSessionModal() {
  renameTargetId = null;
  closeManagedModal($("renameSessionModal"));
}

async function saveRenameSession() {
  if (!renameTargetId) return;
  const title = $("renameSessionInput").value.trim();
  const err = $("renameSessionError");
  if (!title) {
    err.textContent = t("errorTitleRequired");
    err.classList.remove("hidden");
    return;
  }
  try {
    const result = await api(`/api/sessions/${renameTargetId}`, { method: "PATCH", body: JSON.stringify({ title }) });
    if (currentSessionId === renameTargetId && currentSession) {
      currentSession.title = result.title;
      loadSessionMeta();
    }
    closeRenameSessionModal();
    await refreshSessions();
  } catch (error) {
    err.textContent = localizedFailure(error);
    err.classList.remove("hidden");
  }
}

async function confirmDeleteSession(session) {
  if (!window.confirm(t("deleteSessionConfirm"))) return;
  try {
    await api(`/api/sessions/${session.id}`, { method: "DELETE" });
    if (currentSessionId === session.id) {
      if (eventSource) { eventSource.close(); eventSource = null; }
      currentSessionId = null;
      currentSession = null;
      sessionRequests.invalidate();
      connectorRequests.invalidate();
      $("sessionView").hidden = true;
      $("emptyState").hidden = false;
      $("contextCol").innerHTML = "";
      clearAttachments();
    }
    await refreshSessions();
  } catch (error) {
    $("liveStatus").textContent = localizedFailure(error);
  }
}

// Each rail/workflow/context column collapses via a persisted root class on wide screens and becomes
// an overlay below its breakpoint. topbarBtn is the topbar toggle whose state mirrors the column.
const COLUMN_TOGGLES = {
  rail: { cls: "rail-collapsed", key: "codebate-rail-collapsed", overlayBelow: "(max-width: 860px)", needsSession: false, topbarBtn: "railDrawerToggle" },
  workflow: { cls: "workflow-hidden", key: "codebate-workflow-hidden", overlayBelow: "(max-width: 1100px)", needsSession: true, topbarBtn: "workflowToggle" },
  context: { cls: "context-hidden", key: "codebate-context-hidden", overlayBelow: "(max-width: 1100px)", needsSession: true, topbarBtn: "contextDrawerToggle" },
};

function applyShellChrome() {
  const root = document.documentElement;
  for (const spec of Object.values(COLUMN_TOGGLES)) {
    root.classList.toggle(spec.cls, localStorage.getItem(spec.key) === "1");
  }
  const railCollapsed = root.classList.contains("rail-collapsed");
  const railBtn = $("toggleRail");
  if (railBtn) {
    railBtn.setAttribute("aria-pressed", String(railCollapsed));
    railBtn.title = t("toggleRail");
    railBtn.setAttribute("aria-label", t("toggleRail"));
  }
  const contextBtn = $("toggleContext");
  if (contextBtn) {
    const contextHidden = root.classList.contains("context-hidden");
    // Below the breakpoint the button toggles an overlay, so its pressed/active state must track whether
    // that overlay is open — not the persisted collapse class, which would leave it stuck "pressed" after
    // the overlay closes. Above the breakpoint it reflects the inline column's collapse state. One value
    // drives is-active, aria-pressed, and aria-expanded so they can't disagree.
    const contextActive = window.matchMedia(COLUMN_TOGGLES.context.overlayBelow).matches
      ? activeShellOverlay === "context"
      : !contextHidden;
    contextBtn.classList.toggle("is-active", contextActive);
    contextBtn.setAttribute("aria-pressed", String(contextActive));
    contextBtn.setAttribute("aria-expanded", String(contextActive));
    contextBtn.title = t("toggleContext");
    contextBtn.setAttribute("aria-label", t("toggleContext"));
  }
  // The rail-toolbar workflow toggle is the desktop control for the room-flow column (the topbar ⇥ is
  // hidden at desktop widths), mirroring the context toggle. Same overlay-aware active/expanded state.
  const workflowBtn = $("toggleWorkflow");
  if (workflowBtn) {
    const workflowActive = window.matchMedia(COLUMN_TOGGLES.workflow.overlayBelow).matches
      ? activeShellOverlay === "workflow"
      : !root.classList.contains("workflow-hidden");
    workflowBtn.classList.toggle("is-active", workflowActive);
    workflowBtn.setAttribute("aria-pressed", String(workflowActive));
    workflowBtn.setAttribute("aria-expanded", String(workflowActive));
    workflowBtn.title = t("workflowNav");
    workflowBtn.setAttribute("aria-label", t("workflowNav"));
  }
  // Keep the topbar ☰/⇥/◫ toggles' aria-expanded correct in BOTH modes and across resizes: at wide
  // sizes it reflects the inline column's collapse state; below the breakpoint it reflects whether
  // that overlay is open. Recomputed unconditionally so resizing past a breakpoint can't leave it stale.
  for (const [kind, spec] of Object.entries(COLUMN_TOGGLES)) {
    const btn = $(spec.topbarBtn);
    if (!btn) continue;
    btn.setAttribute("aria-expanded", String(window.matchMedia(spec.overlayBelow).matches
      ? activeShellOverlay === kind
      : !root.classList.contains(spec.cls)));
  }
  const groupSelect = $("sessionGroupBy");
  if (groupSelect) groupSelect.value = sessionGroupBy;
}

function toggleRailCollapsed() {
  const spec = COLUMN_TOGGLES.rail;
  if (window.matchMedia(spec.overlayBelow).matches) {
    closeShellOverlay();
    return;
  }
  const next = !document.documentElement.classList.contains(spec.cls);
  localStorage.setItem(spec.key, next ? "1" : "0");
  applyShellChrome();
}

// Width-aware column toggle for the topbar controls (and the rail's context button): below the
// column's breakpoint it is an overlay, so open/close it; at wider sizes it is an inline column, so
// collapse/expand it via its persisted class. This is why the topbar ☰/⇥/◫ buttons now do something
// on desktop instead of toggling an overlay that isn't rendered at that width.
function toggleColumn(kind, trigger) {
  const spec = COLUMN_TOGGLES[kind];
  if (!spec) return;
  if (window.matchMedia(spec.overlayBelow).matches) {
    if (spec.needsSession && !currentSessionId) return;
    toggleShellOverlay(kind, trigger);
    return;
  }
  const collapsed = document.documentElement.classList.toggle(spec.cls);
  localStorage.setItem(spec.key, collapsed ? "1" : "0");
  applyShellChrome();
}

// Drag- or keyboard-resize the rail / workflow / context columns (wide layout). Resizers live on the
// stable grid containers (not the columns, whose innerHTML is rebuilt) and set each column's
// persisted -open width var. Direction-aware so it feels right in both LTR and RTL. As an ARIA
// "window splitter" each resizer is focusable and arrow/Home/End operable with a live aria-valuenow.
function setupColumnResizers() {
  const shell = $("appShell");
  const workspace = document.querySelector(".workspace");
  const configs = [
    { col: "rail", parent: shell, colEl: "sessionsRail", varOpen: "--rail-w-open", key: "codebate-rail-w", min: 180, max: 460, edge: "end" },
    { col: "workflow", parent: workspace, colEl: "workflow", varOpen: "--workflow-w-open", key: "codebate-workflow-w", min: 150, max: 380, edge: "end" },
    { col: "context", parent: workspace, colEl: "contextCol", varOpen: "--context-w-open", key: "codebate-context-w", min: 220, max: 520, edge: "start" },
  ];
  const widthOf = (varOpen) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(varOpen)) || 0;
  for (const cfg of configs) {
    if (!cfg.parent || !$(cfg.colEl)) continue; // both are static in index.html; guard defensively
    const saved = parseInt(localStorage.getItem(cfg.key), 10);
    if (saved >= cfg.min && saved <= cfg.max) document.documentElement.style.setProperty(cfg.varOpen, `${saved}px`);

    const resizer = document.createElement("div");
    resizer.className = "col-resizer";
    resizer.dataset.col = cfg.col;
    resizer.tabIndex = 0;
    resizer.setAttribute("role", "separator");
    resizer.setAttribute("aria-orientation", "vertical");
    // A distinct label per column so screen-reader users can tell the three separators apart.
    const ariaKey = `resizeColumn${cfg.col.charAt(0).toUpperCase()}${cfg.col.slice(1)}`; // …Rail/…Workflow/…Context
    resizer.setAttribute("aria-controls", cfg.colEl);
    resizer.setAttribute("data-i18n-aria-label", ariaKey); // re-localized by applyLang
    resizer.setAttribute("aria-label", t(ariaKey));
    resizer.setAttribute("aria-valuemin", String(cfg.min));
    resizer.setAttribute("aria-valuemax", String(cfg.max));
    // Insert the handle next to the column it splits so tab/DOM order matches the visual boundary
    // (WCAG 2.4.3). It stays inside the same position:relative container (.shell/.workspace), so its
    // absolute positioning is unchanged. edge:"end" → after the column; edge:"start" (context) → before.
    $(cfg.colEl).insertAdjacentElement(cfg.edge === "end" ? "afterend" : "beforebegin", resizer);

    const applyWidth = (px, persist) => {
      const width = Math.max(cfg.min, Math.min(cfg.max, Math.round(px)));
      document.documentElement.style.setProperty(cfg.varOpen, `${width}px`);
      resizer.setAttribute("aria-valuenow", String(width));
      if (persist) localStorage.setItem(cfg.key, String(width));
      return width;
    };
    applyWidth(widthOf(cfg.varOpen), false); // seed aria-valuenow from the current width

    let fixedEdgeX = 0, dragging = false;
    resizer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !$(cfg.colEl)) return;
      event.preventDefault();
      dragging = true;
      resizer.classList.add("dragging");
      // Width = |pointer − the column's fixed (non-dragged) edge|, so it's correct in both LTR and
      // RTL without sign juggling. inline-start is the left edge in LTR, the right edge in RTL.
      // Capture the edge BEFORE setPointerCapture (which can throw), so the move handler is never
      // left with a stale/zero edge.
      const rect = $(cfg.colEl).getBoundingClientRect();
      const rtl = document.documentElement.dir === "rtl";
      fixedEdgeX = cfg.edge === "end" ? (rtl ? rect.right : rect.left) : (rtl ? rect.left : rect.right);
      try { resizer.setPointerCapture(event.pointerId); } catch { /* pointer may be synthetic */ }
    });
    resizer.addEventListener("pointermove", (event) => {
      if (dragging) applyWidth(Math.abs(event.clientX - fixedEdgeX), false);
    });
    const finish = (event) => {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove("dragging");
      try { resizer.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
      localStorage.setItem(cfg.key, String(Math.round(widthOf(cfg.varOpen))));
    };
    resizer.addEventListener("pointerup", finish);
    resizer.addEventListener("pointercancel", finish);

    resizer.addEventListener("keydown", (event) => {
      // A physical Right arrow widens a start-edge (leading-boundary) column and narrows an end-edge
      // one — and RTL flips that. Home/End jump to the limits.
      const rtl = document.documentElement.dir === "rtl";
      const rightWidens = (cfg.edge === "end") !== rtl;
      const step = event.shiftKey ? 48 : 16;
      const current = widthOf(cfg.varOpen);
      let next;
      if (event.key === "Home") next = cfg.min;
      else if (event.key === "End") next = cfg.max;
      else if (event.key === "ArrowRight") next = current + (rightWidens ? step : -step);
      else if (event.key === "ArrowLeft") next = current + (rightWidens ? -step : step);
      else return;
      applyWidth(next, true);
      event.preventDefault();
    });
  }
}

const SHELL_OVERLAYS = {
  rail: "sessionsRail",
  workflow: "workflow",
  context: "contextCol",
};

function shellOverlayButtons() {
  return [$("railDrawerToggle"), $("emptyRailDrawerToggle"), $("workflowToggle"), $("contextDrawerToggle"), $("toggleContext"), $("toggleWorkflow")].filter(Boolean);
}

function closeShellOverlay({ restoreFocus = true } = {}) {
  if (!activeShellOverlay) return;
  const trigger = shellOverlayTrigger;
  Object.values(SHELL_OVERLAYS).forEach((id) => {
    const panel = $(id);
    panel?.classList.remove("open");
    panel?.removeAttribute("role");
    panel?.removeAttribute("aria-modal");
  });
  shellOverlayButtons().forEach((button) => button.setAttribute("aria-expanded", "false"));
  const backdrop = $("shellOverlayBackdrop");
  backdrop.hidden = true;
  activeShellOverlay = null;
  shellOverlayTrigger = null;
  // Re-sync every toggle's is-active/aria-pressed/aria-expanded now that no overlay is open — closing via
  // Escape/backdrop must not leave a toggle stuck "pressed" (the aria-expanded reset alone isn't enough).
  applyShellChrome();
  if (restoreFocus) trigger?.focus();
}

function openShellOverlay(kind, trigger) {
  const panel = $(SHELL_OVERLAYS[kind]);
  if (!panel) return;
  closeShellOverlay({ restoreFocus: false });
  activeShellOverlay = kind;
  shellOverlayTrigger = trigger;
  panel.classList.add("open");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  $("shellOverlayBackdrop").hidden = false;
  shellOverlayButtons().forEach((button) => {
    button.setAttribute("aria-expanded", String(button === trigger || button.getAttribute("aria-controls") === panel.id));
  });
  // Re-sync is-active/aria-pressed/aria-expanded now that this overlay is open — the manual loop above
  // only sets aria-expanded, so without this the rail-toolbar toggles would stay visually un-pressed.
  applyShellChrome();
  panel.focus();
}

function toggleShellOverlay(kind, trigger) {
  if (activeShellOverlay === kind) closeShellOverlay();
  else openShellOverlay(kind, trigger);
}

function handleShellOverlayKeydown(event) {
  if (!activeShellOverlay) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeShellOverlay();
    return;
  }
  if (event.key !== "Tab") return;
  const panel = $(SHELL_OVERLAYS[activeShellOverlay]);
  const focusable = [...panel.querySelectorAll("button:not(:disabled), a[href], summary, input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")];
  if (!focusable.length) {
    event.preventDefault();
    panel.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && [first, panel].includes(document.activeElement)) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === panel) { event.preventDefault(); first.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

/* ---------------- session open / focused view ---------------- */
async function openSession(id) {
  const focusMainAfterOpen = activeShellOverlay === "rail";
  closeShellOverlay({ restoreFocus: false });
  const switching = currentSessionId !== id;
  if (switching) sessionViewEpoch += 1;
  const viewEpoch = sessionViewEpoch;
  sessionRequests.invalidate();
  connectorRequests.invalidate();
  currentSessionId = id;
  currentSession = null;
  if (switching) currentRunId = null;
  routeSuggestion = null;
  pendingExec = null;
  renderedMessageSessionId = null;
  renderedMessageIds = new Set();
  running = false;
  if (activeModal === $("approveModal")) closeManagedModal($("approveModal"), { restoreFocus: false });
  $("messageInput").disabled = true;
  $("sendBtn").disabled = true;
  $("stopBtn").disabled = true;
  $("execStopBtn").hidden = true;
  $("execRun").disabled = true;
  $("exportBtn").disabled = true;
  $("projectPath").value = "";
  $("projectStatus").textContent = "";
  $("projectStatus").className = "run-state";
  $("trustProject").hidden = true;
  $("chat").innerHTML = "";
  $("connectorsList").innerHTML = "";
  if (switching) {
    $("sessionTitle").textContent = "—";
    $("sessionMeta").textContent = "";
    $("messageInput").value = "";
    autoGrow($("messageInput"));
    clearAttachments();
    $("execTask").value = "";
    $("execStatus").textContent = "";
    $("liveStatus").textContent = t("ready");
    for (const item of providers) setAgentState(item.id, t("ready"));
  }
  if (eventSource) eventSource.close();
  const source = new EventSource(`/api/sessions/${id}/events`);
  eventSource = source;
  let streamOpenedBefore = false;
  source.onmessage = (e) => { if (eventSource === source && isCurrentSessionView(id, viewEpoch)) handleEvent(JSON.parse(e.data)); };
  source.onopen = () => {
    if (eventSource !== source || !isCurrentSessionView(id, viewEpoch)) return;
    setConnected(true);
    // A reconnect — the browser auto-reopens an EventSource after a dropped connection (laptop
    // sleep, network blip) — may have missed a run's terminal event, which is fire-and-forget with
    // no server backlog. Re-sync from persisted state so the UI can't stay stuck on "running" with
    // inputs locked. The first open is skipped: openSession already loaded the session below.
    if (streamOpenedBefore) { loadSession().catch(() => {}); refreshSessions().catch(() => {}); }
    streamOpenedBefore = true;
  };
  source.onerror = () => { if (eventSource === source && isCurrentSessionView(id, viewEpoch)) setConnected(false); };
  $("emptyState").hidden = true;
  $("sessionView").hidden = false;
  if (focusMainAfterOpen) $("sessionTitle").focus();
  try { await loadSession(); }
  catch (error) {
    if (isCurrentSessionView(id, viewEpoch)) {
      $("liveStatus").textContent = localizedFailure(error);
      $("messageInput").disabled = true;
      $("sendBtn").disabled = true;
      $("execRun").disabled = true;
      $("exportBtn").disabled = true;
    }
  }
  if (isCurrentSessionView(id, viewEpoch)) await refreshSessions();
}

async function loadSession() {
  const requestedId = currentSessionId;
  if (!requestedId) { sessionRequests.invalidate(); connectorRequests.invalidate(); return false; }
  const result = await sessionRequests.run(requestedId);
  if (!result.current || currentSessionId !== requestedId) return false;
  currentSession = result.value;
  const orchestrating = Boolean(currentSession.running || currentSession.status === "running");
  const executing = Boolean(currentSession.executing);
  if (orchestrating && currentSession.activeRun?.status === "running") currentRunId = currentSession.activeRun.runId;
  else if (!orchestrating) currentRunId = null;
  running = orchestrating || executing;
  loadSessionMeta();
  applyActivityControlState(running, executing ? "execution" : "orchestration");
  if (currentSession.project?.path) {
    $("projectPath").value = currentSession.project.path;
    const trusted = currentSession.project.trusted === true;
    $("projectStatus").innerHTML = trusted ? `${esc(t("attached"))}: ${bdi(currentSession.project.path, "ltr")}` : esc(t("untrustedProject"));
    $("projectStatus").className = `run-state ${trusted ? "done" : ""}`;
    $("trustProject").hidden = trusted;
  } else {
    $("projectPath").value = "";
    $("projectStatus").textContent = "";
    $("projectStatus").className = "run-state";
    $("trustProject").hidden = true;
  }
  renderMessages();
  loadConnectors();
  return true;
}
function loadSessionMeta() {
  if (!currentSession) return;
  $("sessionTitle").textContent = currentSession.title;
  $("sessionMeta").textContent = `${discussionModeLabel(currentSession.mode)} · ${formatMessageCount(lang, currentSession.messages.length)} · ${sessionStatusLabel(currentSession.status)}`;
}

/* ---------------- messages ---------------- */
function esc(text) {
  return String(text ?? "").replace(/[&<>'"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;" }[c]));
}
function fmtDuration(ms) {
  return ms == null ? "" : formatLocaleDuration(lang, ms);
}
function technicalDetailsHtml(detail) {
  return detail ? `<details class="tech"><summary>${esc(t("techDetails"))}</summary><pre dir="ltr" tabindex="0">${esc(String(detail).slice(0, 8000))}</pre></details>` : "";
}
function renderMessages() {
  const chat = $("chat");
  const messages = currentSession?.messages ?? [];
  let freshMessages = [];
  if (renderedMessageSessionId === currentSessionId) {
    freshMessages = messages.filter((message) => message.id && !renderedMessageIds.has(message.id));
  }
  renderedMessageSessionId = currentSessionId;
  renderedMessageIds = new Set(messages.map((message) => message.id).filter(Boolean));
  chat.setAttribute("aria-busy", "true");
  chat.innerHTML = "";
  renderRouteSuggestion(chat);
  for (const msg of messages) {
    const meta = msg.meta || {};
    const isPartial = meta.status === "partial";
    const isError = meta.status === "error";
    const el = document.createElement("article");
    el.className = `msg msg-${msg.author}${isPartial ? " msg-partial" : ""}${isError ? " msg-error" : ""}`;
    const time = msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString(lang === "ar" ? "ar-EG" : "en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
    const appError = isError || msg.phase === "exec_error";
    const errorDetail = appError ? [meta.error || msg.content, meta.technical].filter(Boolean).join("\n\n") : meta.technical;
    const techHtml = technicalDetailsHtml(errorDetail);

    if (msg.author === "agent") {
      const info = providerInfo(msg.agent);
      const name = info.label;
      const badges = [msg.role, phaseLabel(msg.phase), msg.round ? `${t("roundWord")} ${formatLocaleNumber(lang, msg.round)}` : "", isPartial ? t("partialTag") : ""]
        .filter(Boolean)
        .map((b) => `<span class="badge${isPartial && b === t("partialTag") ? " badge-partial" : ""}">${esc(b)}</span>`).join("");
      const metaParts = [meta.requestedModel ? bdi(meta.requestedModel, "ltr") : "", meta.requestedEffort ? bdi(meta.requestedEffort, "ltr") : "", fmtDuration(meta.durationMs) ? esc(fmtDuration(meta.durationMs)) : "", meta.outputTruncated ? esc(t("truncatedTag")) : ""].filter(Boolean);
      const ctx = meta.contextChars ? ` · ${esc(t("contextWord"))} ${bdi(formatLocaleNumber(lang, meta.contextChars))}` : "";
      const footer = metaParts.length ? `<div class="msg-meta">${metaParts.join(" · ")}${ctx}</div>` : "";
      el.innerHTML =
        `<div class="msg-head"><span class="agent-avatar ${esc(info.id)}" aria-hidden="true">${providerGlyph(info.id, name)}</span>` +
        `<span class="msg-name">${bdi(name)}</span>${badges}<span class="msg-time">${bdi(time)}</span></div>` +
        `<div class="msg-body"><div class="msg-content md">${renderMarkdown(msg.content)}</div>${footer}${techHtml}</div>`;
    } else if (msg.author === "user") {
      el.innerHTML = `<div class="msg-body"><div class="msg-content md">${renderMarkdown(msg.content)}</div></div>`;
    } else {
      // A discussion round-summary carries its structured outcome in meta.outcome; render it in the
      // reader's language rather than the server's stored (Arabic) text. Each free-text bullet (pending
      // items / disagreements, authored by the agents) gets its own line and is bidi-isolated, so a
      // different-direction item can't reorder against the template. Falls back to the stored content
      // when there's no outcome (or a truncated one).
      const report = meta.outcome ? discussionOutcomeReport(meta.outcome, lang) : null;
      let systemBody;
      if (appError) {
        systemBody = esc(t(appErrorMessageKey(msg)));
      } else if (report?.text) {
        const items = report.items.map((item) => `<div class="outcome-item" dir="auto">• ${bdi(item)}</div>`).join("");
        systemBody = `${esc(report.text)}${items}`;
      } else {
        systemBody = esc(msg.content);
      }
      el.innerHTML = `<div class="msg-body" dir="auto">${systemBody}</div>${techHtml}`;
    }
    chat.appendChild(el);
  }
  renderExecutions();
  renderContextColumn();
  renderDecisionRoom();
  // Completed sessions open at the first message (read from the top); live runs follow the newest.
  chat.scrollTop = running ? chat.scrollHeight : 0;
  chat.setAttribute("aria-busy", "false");
  const latest = freshMessages.filter((message) => message.author !== "user").pop();
  if (latest) {
    const speaker = latest.author === "agent" ? providerInfo(latest.agent).label : t("system");
    const announcement = $("conversationAnnouncements");
    announcement.textContent = "";
    // Announce the same localized text the reader sees (mirrors the systemBody branches in the render loop):
    // an error message announces the localized failure line, a round-summary the report rendered from
    // meta.outcome (sentence + items) — never the server's stored Arabic `content` — so a screen-reader user
    // hears it in their language too.
    const latestAppError = latest.meta?.status === "error" || latest.phase === "exec_error";
    let body;
    if (latestAppError) {
      body = t(appErrorMessageKey(latest));
    } else {
      const outcome = latest.meta?.outcome ? discussionOutcomeReport(latest.meta.outcome, lang) : null;
      body = outcome?.text ? [outcome.text, ...outcome.items].join(" ") : String(latest.content || "");
    }
    requestAnimationFrame(() => { announcement.textContent = `${t("newMessageFrom")(speaker)}: ${body.slice(0, 500)}`; });
  }
}

function renderRouteSuggestion(chat) {
  if (!routeSuggestion) return;
  const card = document.createElement("section");
  card.className = "session-insight route-suggestion";
  card.innerHTML = `<p>${esc(t(errorMessageKey(routeSuggestion)))}</p><button class="btn-primary">${esc(t("routeAction"))}</button>`;
  card.querySelector("button").onclick = () => {
    $("execDrawer").hidden = false;
    $("execToggle").setAttribute("aria-expanded", "true");
    $("setupDrawer").hidden = true;
    $("setupToggle").setAttribute("aria-expanded", "false");
    if (routeSuggestion.action === "open_execution") $("execTask").value = $("messageInput").value.trim();
    routeSuggestion = null;
    renderMessages();
  };
  chat.appendChild(card);
}

const OUTCOME_LABEL_KEYS = {
  agreement: { converged: "agreementConverged", open: "agreementOpen", unknown: "agreementUnknown", fallback: "agreementUnknown" },
  completion: { satisfied: "completionSatisfied", needs_user: "completionNeedsUser", blocked: "completionBlocked", incomplete: "completionIncomplete", fallback: "completionIncomplete" },
  stopReason: { complete: "stopComplete", user_decision: "stopUserDecision", external_block: "stopExternalBlock", round_limit: "stopRoundLimit", invalid_control: "stopInvalidControl", cancelled: "stopCancelled", error: "stopError", fallback: "stopInvalidControl" },
  kind: { disagreement: "pendingDisagreement", user_decision: "pendingUserDecision", external_validation: "pendingExternalValidation", remaining_work: "pendingRemainingWork", out_of_scope: "pendingOutOfScope", fallback: "pendingUnclassified" },
  actor: { user: "actorUser", human_operator: "actorHumanOperator", orchestrator: "actorOrchestrator", agent: "actorAgent", fallback: "system" },
  action: { provide_decision: "actionProvideDecision", run_external_check: "actionRunExternalCheck", resume_agent_round: "actionResumeAgentRound", fallback: "unresolved" },
};

function outcomeLabel(group, statusValue) {
  const labels = OUTCOME_LABEL_KEYS[group];
  return t(labels[statusValue] || labels.fallback);
}

function officialOutcomeFrom(message) {
  const outcome = message?.meta?.outcome;
  return outcome?.outcomeVersion === 1 && Array.isArray(outcome.pendingItems) && Array.isArray(outcome.nextSteps)
    ? outcome
    : null;
}

// Messages from the latest round only, so a stale outcome/report from a prior run
// (before the newest user message) never gets shown as the current one.
function latestRunMessages() {
  const messages = currentSession?.messages || [];
  let latestUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].author === "user") { latestUserIndex = index; break; }
  }
  return latestUserIndex >= 0 ? messages.slice(latestUserIndex) : messages;
}

function outcomeStatusMarkup(outcome) {
  return `<p><b>${esc(t("agreementState"))}:</b> ${esc(outcomeLabel("agreement", outcome.agreementState))} · <b>${esc(t("completionState"))}:</b> ${esc(outcomeLabel("completion", outcome.completionState))} · <b>${esc(t("stopReason"))}:</b> ${esc(outcomeLabel("stopReason", outcome.stopReason))}</p>`;
}

function pendingItemsMarkup(outcome) {
  const groupedItems = new Map();
  for (const pendingItem of outcome.pendingItems || []) {
    const group = groupedItems.get(pendingItem.kind) || [];
    group.push(pendingItem.text);
    groupedItems.set(pendingItem.kind, group);
  }
  return [...groupedItems].map(([kind, texts]) => `<p><b>${esc(outcomeLabel("kind", kind))}:</b> ${texts.map((text) => bdi(text)).join(" · ")}</p>`).join("");
}

function nextStepsMarkup(outcome) {
  if (!outcome.nextSteps?.length) return "";
  const pendingById = new Map((outcome.pendingItems || []).map((pendingItem) => [pendingItem.itemId, pendingItem.text]));
  const steps = outcome.nextSteps.map((nextStep) => {
    const relatedItems = (nextStep.itemIds || []).map((itemId) => pendingById.get(itemId)).filter(Boolean);
    const context = relatedItems.length ? `: ${relatedItems.map((text) => bdi(text)).join("، ")}` : "";
    return `${esc(outcomeLabel("actor", nextStep.actor))} — ${esc(outcomeLabel("action", nextStep.action))}${context}`;
  });
  return `<p><b>${esc(t("nextSteps"))}:</b> ${steps.join(" · ")}</p>`;
}

function correctionsMarkup(corrections) {
  if (!corrections.length) return "";
  const entries = corrections
    .map((correction) => `${bdi(correction.agent, "ltr")}: <span dir="auto">${esc(correction.content)}</span>`)
    .join(" · ");
  return `<p><b>${esc(t("corrections"))}:</b> ${entries}</p>`;
}

function roundMetricsMarkup(requested, completed) {
  return `<div class="insight-metrics"><span>${esc(t("requested"))}: <b>${bdi(formatLocaleNumber(lang, requested))}</b></span><span>${esc(t("completed"))}: <b>${bdi(formatLocaleNumber(lang, completed))}</b></span></div>`;
}

// Body-only markup (no heading) — the caller wraps this in a contextCard(), which
// already renders the title in its own <summary>.
function decisionCardBody({ requested, completed, outcome, finalReport, corrections }) {
  const officialOutcome = outcome
    ? `${outcomeStatusMarkup(outcome)}${pendingItemsMarkup(outcome)}${nextStepsMarkup(outcome)}`
    : "";
  const legacyReport = !outcome && finalReport ? `<p dir="auto">${esc(finalReport.content)}</p>` : "";
  return [
    roundMetricsMarkup(requested, completed),
    officialOutcome,
    legacyReport,
    correctionsMarkup(corrections),
  ].join("");
}

function renderContextColumn() {
  const col = $("contextCol");
  if (!col) return;
  col.innerHTML = "";
  if (!currentSession) return;

  const runMessages = latestRunMessages();
  const discussion = runMessages.filter((message) => message.author === "agent" && ["collaboration", "opening", "rebuttal"].includes(message.phase));
  const finalReport = latestRunFinalReport();
  const outcome = officialOutcomeFrom(finalReport);
  const completed = Number(outcome?.completedRounds) || Math.max(0, ...discussion.map((message) => Number(message.round) || 0));
  const requested = Number(outcome?.requestedRounds) || Number(currentSession.settings?.rounds) || 0;
  // The official outcome already classifies open items via pendingItemsMarkup above;
  // the legacy openPoints list only matters as a fallback when there's no outcome yet.
  const openPoints = outcome ? [] : [...new Set(discussion.flatMap((message) => message.control?.openPoints || []).filter(Boolean))];
  const corrections = discussion.filter((message) => message.control?.substantiveDelta).map((message) => ({ agent: message.agent, content: String(message.content || "").slice(0, 140) }));

  if (requested || completed || outcome || openPoints.length || corrections.length || finalReport) {
    col.appendChild(contextCard("goal", t("roundTracker"), decisionCardBody({ requested, completed, outcome, finalReport, corrections }), true));
  }

  if (openPoints.length) {
    const riskBody = `<ul>${openPoints.map((point) => `<li dir="auto">${esc(point)}</li>`).join("")}</ul>`;
    col.appendChild(contextCard("risk", t("contextRisks"), riskBody, false));
  }

  if (currentSession.project?.path) {
    const trusted = currentSession.project.trusted === true;
    const trustLabel = trusted ? t("attached") : t("untrustedProject");
    const body = `<p class="context-path">${esc(currentSession.project.path)}</p><p class="context-meta">${esc(trustLabel)}</p>`;
    col.appendChild(contextCard("project", t("contextProject"), body, true));
  }

  if (currentSession.decisions?.length) {
    const items = currentSession.decisions.slice(-8).map((decision) => {
      const type = localizedMarkup(decisionTypeKey(decision.type), decision.type);
      const outcome = localizedMarkup(decisionOutcomeKey(decision.outcome), decision.outcome);
      const connectorId = decision.metadata?.connector;
      const actionId = decision.metadata?.action || decision.metadata?.requestedAction;
      const actionKey = connectorId ? connectorActionKeys(connectorId, actionId)?.label : decisionActionKey(actionId);
      const context = actionId
        ? localizedMarkup(actionKey, actionId)
        : connectorId ? localizedMarkup(connectorLabelKey(connectorId), connectorId) : "";
      return `<li><b>${outcome}</b> · ${type}${context ? ` (${context})` : ""}</li>`;
    }).join("");
    col.appendChild(contextCard("log", t("decisionLog"), `<ul>${items}</ul>`, false));
  }

  if (!col.children.length) {
    const empty = document.createElement("div");
    empty.className = "context-empty";
    empty.innerHTML = `<span class="context-empty-mark" aria-hidden="true">◔</span><p>${esc(t("contextEmpty"))}</p>`;
    col.appendChild(empty);
  }
}

function contextCard(id, title, bodyHtml, open) {
  const details = document.createElement("details");
  details.className = "context-card";
  details.dataset.contextCard = id;
  details.open = open;
  details.innerHTML = `<summary>${esc(title)}</summary><div class="context-card-body">${bodyHtml}</div>`;
  return details;
}

let attachGeneration = 0;
// Invalidates any in-flight file.text() reads (e.g. from a session switch mid-read) so
// their result can't land in pendingAttachments after the list has moved on.
function clearAttachments() {
  attachGeneration += 1;
  pendingAttachments = [];
  renderAttachChips();
}

function renderAttachChips() {
  const host = $("attachChips");
  if (!host) return;
  host.innerHTML = "";
  host.hidden = pendingAttachments.length === 0;
  pendingAttachments.forEach((file, index) => {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    const name = document.createElement("span");
    name.textContent = file.name;
    name.title = file.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", t("clear"));
    remove.textContent = "×";
    remove.onclick = () => {
      pendingAttachments.splice(index, 1);
      renderAttachChips();
    };
    chip.append(name, remove);
    host.appendChild(chip);
  });
}

async function handleAttachFiles(fileList) {
  const files = [...(fileList || [])];
  const requestedGeneration = attachGeneration;
  for (const file of files) {
    if (requestedGeneration !== attachGeneration) return; // a clear/switch happened mid-read

    if (pendingAttachments.length >= ATTACH_MAX_FILES) {
      $("liveStatus").textContent = t("attachTooMany");
      break;
    }
    if (file.size > ATTACH_MAX_BYTES) {
      $("liveStatus").textContent = `${t("attachTooLarge")}: ${file.name}`;
      continue;
    }
    const used = pendingAttachments.reduce((sum, item) => sum + item.bytes, 0);
    if (used + file.size > ATTACH_MAX_TOTAL_BYTES) {
      $("liveStatus").textContent = t("attachTooLarge");
      break;
    }
    try {
      const content = await file.text();
      if (requestedGeneration !== attachGeneration) return; // superseded while awaiting the read
      const name = String(file.name || "file").replace(/[\r\n]+/g, " ").slice(0, 180);
      pendingAttachments.push({ name, content, bytes: file.size });
    } catch {
      if (requestedGeneration === attachGeneration) $("liveStatus").textContent = `${t("attachReadFailed")}: ${file.name}`;
    }
  }
  renderAttachChips();
  $("attachInput").value = "";
}

function contentWithAttachments(base) {
  if (!pendingAttachments.length) return base;
  const blocks = pendingAttachments.map((file) => {
    const safeName = String(file.name || "file").replace(/[\r\n]+/g, " ").slice(0, 180);
    return `--- ${safeName} ---\n${file.content}`;
  }).join("\n\n");
  return `${base}\n\n[Attached files]\n${blocks}`.trim();
}
function autoGrow(el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 120) + "px"; }

/* ---------------- SSE ---------------- */
// Turn a raw provider activity event into a short, humane status. Adapters emit a `kind` plus a raw `text`
// that can be a provider event type (e.g. "turn.started"); show the reader a friendly state keyed off `kind`
// instead of that raw token, so provider event names and diagnostic noise never leak into the status line.
function humanizeActivity(evt) {
  switch (evt?.kind) {
    case "thinking": return t("agentThinking");
    case "delta": return t("agentWriting");
    default: return t("agentWorking");
  }
}
function handleEvent(event) {
  if (event.type === "session_updated") loadSession();
  if (!shouldHandleRunEvent(currentRunId, event)) return;
  if (event.type === "run_started") { currentRunId = event.runId; liveAgents = {}; renderLiveStrip(); setRunning(true, `${discussionModeLabel(event.mode)} · ${formatLocaleNumber(lang, event.rounds)} ${t("roundsShort")}`); }
  if (event.type === "agent_start") { const s = `${phaseLabel(event.phase)} · ${t("roundWord")} ${formatLocaleNumber(lang, event.round)}`; liveAgents[event.agent] = s; renderLiveStrip(); setAgentState(event.agent, s, "running"); }
  if (event.type === "agent_activity" && event.event?.text) { const s = humanizeActivity(event.event); if (event.agent in liveAgents) { liveAgents[event.agent] = s; renderLiveStrip(); } setAgentState(event.agent, s, "running"); }
  if (event.type === "agent_complete") { liveAgents[event.agent] = t("replied"); renderLiveStrip(); setAgentState(event.agent, t("replied"), "done"); }
  if (["run_complete","run_stopped","run_error"].includes(event.type)) {
    liveAgents = {}; renderLiveStrip();
    setRunning(false, event.type === "run_complete" ? t("runDone") : event.type === "run_stopped" ? t("runStopped") : localizedFailure({ code: event.code, detail: event.error }));
    currentRunId = null;
    loadSession(); refreshSessions();
  }
  if (event.type === "exec_started") setRunning(true, t("starting"), "execution");
  if (event.type === "exec_phase") { const s = event.phase === "executing" ? t("execExecuting")(event.agent) : t("execReviewing")(event.agent); liveAgents = { [event.agent]: s }; renderLiveStrip(); $("execStatus").textContent = s; $("liveStatus").textContent = s; }
  if (event.type === "exec_ready") { liveAgents = {}; renderLiveStrip(); setRunning(false, t("execAwaiting")); $("execStopBtn").hidden = true; $("execRun").disabled = false; $("execTask").value = ""; loadSession(); refreshSessions(); }
  if (event.type === "exec_error") { liveAgents = {}; renderLiveStrip(); setRunning(false, localizedFailure({ code: event.code, detail: event.error })); $("execStopBtn").hidden = true; $("execRun").disabled = false; loadSession(); refreshSessions(); }
}
function setAgentState(agent, text, cls = "") { const el = $(`${agent}RunState`); if (el) { el.textContent = text; el.className = `run-state ${cls}`; } }
function setRunning(value, status, kind = "orchestration") {
  running = value;
  applyActivityControlState(value, kind);
  if (status) $("liveStatus").textContent = status;
}
function applyActivityControlState(value, kind = "orchestration") {
  const controls = activityControls(value, kind);
  const unavailable = value || !currentSessionId;
  $("messageInput").disabled = unavailable;
  $("sendBtn").disabled = unavailable;
  $("attachBtn").disabled = unavailable;
  $("stopBtn").disabled = controls.mainStopDisabled;
  $("execStopBtn").hidden = controls.executionStopHidden;
  $("execRun").disabled = controls.executionRunDisabled;
  $("exportBtn").disabled = !currentSessionId;
}

/* ---------------- send ---------------- */
function payload() {
  const content = contentWithAttachments($("messageInput").value.trim());
  return {
    content, mode, rounds: Number($("rounds").value), finalizer: $("finalizer").value,
    agents: providerPayload(true),
  };
}

function providerPayload(includeRole = false) {
  return Object.fromEntries(providers.map((item) => [item.id, {
    enabled: $(`${item.id}Enabled`)?.checked ?? true,
    command: $(`${item.id}Command`)?.value.trim() || item.command,
    model: $(`${item.id}Model`)?.value.trim() || "",
    effort: $(`${item.id}Effort`)?.value || "high",
    ...(includeRole ? { role: $(`${item.id}Role`)?.value.trim() || t("defaultRole") } : {}),
  }]));
}
async function sendMessage() {
  if (!currentSessionId || running) return;
  const requestedId = currentSessionId;
  const requestedEpoch = sessionViewEpoch;
  const body = payload();
  if (!body.content) { $("liveStatus").textContent = t("writeFirst"); return; }
  saveSettings();
  setRunning(true, t("starting"));
  try {
    await api(`/api/sessions/${requestedId}/message`, { method: "POST", body: JSON.stringify(body) });
    if (!isCurrentSessionView(requestedId, requestedEpoch)) return;
    $("messageInput").value = "";
    clearAttachments();
    autoGrow($("messageInput"));
  } catch (error) {
    if (!isCurrentSessionView(requestedId, requestedEpoch)) return;
    setRunning(false, localizedFailure(error));
    if (error.route) {
      routeSuggestion = error.route;
      renderMessages();
    }
  }
}

/* ---------------- cli check / models ---------------- */
async function checkCli(agent) {
  const commandEl = $(`${agent}Command`);
  const health = $(`${agent}Health`);
  // Descriptor-launched providers (e.g. Cursor) render neither a command input nor a health span — they
  // resolve readiness via the descriptor, not this command-allowlist probe. Bail out safely if absent.
  if (!commandEl || !health) return false;
  const command = commandEl.value.trim();
  health.textContent = "..."; health.className = "health";
  try {
    const result = await api("/api/cli/check", { method: "POST", body: JSON.stringify({ provider: agent, command }) });
    health.textContent = result.ok ? result.version : localizedFailure(result);
    health.className = `health ${result.ok ? "ok" : "bad"}`;
    return result.ok === true;
  } catch (error) { health.textContent = localizedFailure(error); health.className = "health bad"; return false; }
}
function toggleCliSetup(agent) {
  const panel = $(`${agent}CliSetup`);
  const button = document.querySelector(`.setup-cli[data-agent="${agent}"]`);
  if (!panel.hidden) {
    // Ignore clicks while discovery is in flight — closing mid-search made
    // users hammer Setup until a later click happened to land after results.
    if (cliSetupInFlight.has(agent)) return;
    panel.hidden = true;
    button?.setAttribute("aria-expanded", "false");
    return;
  }
  panel.hidden = false;
  button?.setAttribute("aria-expanded", "true");
  runCliSetup(agent);
}

const cliSetupInFlight = new Set();

async function applyDiscoveredCommand(agent, candidate) {
  const commandEl = $(`${agent}Command`);
  if (!commandEl) return false; // descriptor-launched providers have no editable command to trust
  commandEl.value = candidate;
  saveSettings();
  return checkCli(agent);
}

async function runCliSetup(agent) {
  if (cliSetupInFlight.has(agent)) return;
  cliSetupInFlight.add(agent);
  const panel = $(`${agent}CliSetup`);
  panel.textContent = t("setupSearching");
  let result;
  try {
    result = await api("/api/cli/discover", { method: "POST", body: JSON.stringify({ provider: agent }) });
  } catch (error) {
    panel.textContent = localizedFailure(error);
    return;
  } finally {
    cliSetupInFlight.delete(agent);
  }
  // One clear native binary: trust it immediately so Setup is one click, not
  // discover → choose → trust. Multiple candidates still need an explicit pick.
  if (!result.resolved && result.candidates?.length === 1) {
    const ok = await applyDiscoveredCommand(agent, result.candidates[0]);
    if (ok) {
      result = await api("/api/cli/discover", { method: "POST", body: JSON.stringify({ provider: agent }) }).catch(() => result);
    }
  }
  // Built offline and inserted in one mutation so the polite live region
  // announces the result as one coherent message, not fragment by fragment.
  const fragment = document.createDocumentFragment();
  if (result.resolved) {
    const ok = document.createElement("p");
    ok.className = "cli-setup-ok";
    ok.textContent = t("setupCommandOk");
    fragment.appendChild(ok);
    const resolvedPath = document.createElement("div");
    resolvedPath.className = "cli-setup-path";
    resolvedPath.innerHTML = bdi(result.resolved, "ltr");
    fragment.appendChild(resolvedPath);
  }
  if (result.candidates?.length) {
    const intro = document.createElement("p");
    intro.className = "cli-setup-intro";
    intro.textContent = t("setupFoundIntro");
    fragment.appendChild(intro);
    for (const candidate of result.candidates) {
      const row = document.createElement("div");
      row.className = "cli-setup-row";
      row.innerHTML = `<span class="cli-setup-path">${bdi(candidate, "ltr")}</span>`;
      const use = document.createElement("button");
      use.className = "btn-mini";
      use.textContent = t("useThisPath");
      use.setAttribute("aria-label", `${t("useThisPath")}: ${candidate}`);
      use.onclick = async () => {
        use.disabled = true;
        const ok = await applyDiscoveredCommand(agent, candidate);
        use.disabled = false;
        if (ok) runCliSetup(agent);
      };
      row.appendChild(use);
      fragment.appendChild(row);
    }
  } else if (!result.resolved) {
    const info = providerInfo(agent);
    const none = document.createElement("p");
    none.className = "cli-setup-intro";
    none.textContent = t("setupNoneFound");
    fragment.appendChild(none);
    if (info.install?.command) {
      const row = document.createElement("div");
      row.className = "cli-setup-row";
      row.innerHTML = `<code class="cli-setup-cmd">${bdi(info.install.command, "ltr")}</code>`;
      const copy = document.createElement("button");
      copy.className = "btn-mini";
      copy.textContent = t("copyCommand");
      // Feedback lives beside the button so its accessible name stays stable;
      // the panel's live region announces the span's text change.
      const feedback = document.createElement("span");
      feedback.className = "cli-setup-feedback";
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(info.install.command); feedback.textContent = t("copied"); }
        catch { feedback.textContent = t("copyFailed"); }
        setTimeout(() => { feedback.textContent = ""; }, 1600);
      };
      row.appendChild(copy);
      row.appendChild(feedback);
      fragment.appendChild(row);
    }
    if (info.install?.url && /^https:\/\//.test(info.install.url)) {
      const docs = document.createElement("a");
      docs.className = "cli-setup-docs";
      docs.href = info.install.url;
      docs.target = "_blank";
      docs.rel = "noreferrer noopener";
      docs.textContent = t("installDocs");
      const newTab = document.createElement("span");
      newTab.className = "sr-only";
      newTab.textContent = ` (${t("opensInNewTab")})`;
      docs.appendChild(newTab);
      fragment.appendChild(docs);
    }
  }
  panel.replaceChildren(fragment);
}

async function loadModels(agent, btn) {
  btn.disabled = true; const old = btn.textContent; btn.textContent = "...";
  try {
    const result = await api(`/api/providers/${encodeURIComponent(agent)}/models`, { method: "POST", body: JSON.stringify({ command: $(`${agent}Command`)?.value.trim() || "" }) });
    if (result.code) throw failureFromPayload(result);
    const list = $(`${agent}Models`); list.innerHTML = "";
    for (const m of result.models) { const o = document.createElement("option"); o.value = m; list.appendChild(o); }
  } catch (error) { btn.title = localizedFailure(error); }
  finally { btn.disabled = false; btn.textContent = old; }
}

/* ---------------- new session modal ---------------- */
function openNewSessionModal() {
  $("newSessionName").value = ""; $("newSessionFirst").value = "";
  chosenProject = null; $("projChosen").classList.add("hidden");
  $("fsList").dataset.loaded = ""; $("repoList").dataset.loaded = ""; if ($("repoSearch")) $("repoSearch").value = "";
  setProjTab("none");
  hideModalError();
  openManagedModal($("newSessionModal"), { initialFocus: $("newSessionName"), dismiss: closeNewSessionModal });
}
function closeNewSessionModal() { closeManagedModal($("newSessionModal")); }
function showModalError(m) { const el = $("newSessionError"); el.textContent = m; el.classList.remove("hidden"); }
function hideModalError() { const el = $("newSessionError"); el.textContent = ""; el.classList.add("hidden"); }
async function confirmNewSession() {
  const title = $("newSessionName").value.trim() || t("newSession");
  const first = $("newSessionFirst").value.trim();
  hideModalError();
  const createBtn = $("newSessionCreate"); createBtn.disabled = true;
  try {
    const session = await api("/api/sessions", { method: "POST", body: JSON.stringify({ title }) });
    if (chosenProject) {
      let projectPath = chosenProject.path;
      if (chosenProject.type === "github") {
        showChosen(t("cloning"));
        const cl = await api("/api/github/clone", { method: "POST", body: JSON.stringify({ repo: chosenProject.repo }) });
        projectPath = cl.path;
      }
      await api(`/api/sessions/${session.id}/project`, { method: "POST", body: JSON.stringify({ path: projectPath }) });
    }
    closeNewSessionModal();
    await refreshSessions();
    await openSession(session.id);
    if (first) $("messageInput").value = first;
    $("messageInput").focus();
  } catch (error) { showModalError(localizedFailure(error)); }
  finally { createBtn.disabled = false; }
}

/* ---------------- connection ---------------- */
function setConnected(ok) {
  $("serverStatus").classList.toggle("is-bad", !ok);
  $("connText").textContent = ok ? t("connected") : t("disconnected");
}
async function pollHealth() { try { await api("/api/health"); setConnected(true); } catch { setConnected(false); } }

/* ---------------- onboarding ---------------- */
async function loadOnboard() {
  // Re-rendering the list discards the old buttons; clear any elapsed-timer intervals still ticking
  // on those detached nodes so they don't leak.
  for (const timer of updateTimers.values()) clearInterval(timer);
  updateTimers.clear();
  const list = $("onboardList"); list.textContent = "...";
  try {
    const s = await api("/api/agents/status");
    list.innerHTML = "";
    const provRows = providers.map((item) => ({
      name: item.label, agent: item.id,
      ok: s.providers?.[item.id]?.installed,
      detail: s.providers?.[item.id]?.version || s.providers?.[item.id]?.detail,
      autoTrusted: s.providers?.[item.id]?.autoTrusted,
    }));
    const rows = [...provRows, { name: "GitHub (gh)", ok: s.github.authed, detail: s.github.detail, agent: null }];
    for (const r of rows) list.appendChild(renderDoctorRow(r));
    // Locked-mode framing: Debate & cross-review need BOTH agents ready (GitHub is optional for them).
    const providersReady = provRows.length > 0 && provRows.every((r) => r.ok);
    const hint = $("onboardLockHint");
    hint.hidden = false;
    hint.textContent = providersReady ? t("doctorReadyHint") : t("doctorLockedHint");
    hint.classList.toggle("is-locked", !providersReady);
    markDoctorChecked(providersReady);
    refreshUpdateStates();
    // An inline control (Re-check / Verify & trust) that triggered this reload was just destroyed by the
    // re-render; keep focus inside the dialog so keyboard users aren't dropped to <body>.
    const modalEl = $("onboardModal");
    if (!modalEl.classList.contains("hidden") && !modalEl.contains(document.activeElement)) {
      modalEl.querySelector(".modal")?.focus();
    }
  } catch (e) { list.textContent = localizedFailure(e); }
}

// One Doctor row: the status line, plus — for a not-installed provider — an inline setup panel so the
// user never has to drill into the Setup drawer to see how to fix it.
function renderDoctorRow(r) {
  const item = document.createElement("div"); item.className = "onboard-item";
  const row = document.createElement("div"); row.className = "onboard-row";
  const state = r.ok ? t("installed") : t("notInstalled");
  if (!r.ok && r.detail) console.error(`[Codebate: provider_check_failed] ${r.detail}`);
  // Surface auto-trust: this provider's bundled executable was discovered and trusted for the user
  // (no manual Trust & check), so they can see it happened rather than it being silent.
  const detail = [state, r.ok ? r.detail : "", r.autoTrusted ? t("autoDetected") : ""].filter(Boolean).join(" · ");
  row.innerHTML = `<span class="onboard-dot ${r.ok ? "ok" : "bad"}" aria-hidden="true"></span><span class="ob-name">${esc(r.name)}</span><span class="ob-detail">${esc(detail)}</span>`;
  if (r.agent && r.ok && providerInfo(r.agent).canUpdate) {
    // Rendered as "Checking…" first; refreshUpdateStates() flips it to UPDATE or ✓ Updated.
    const actions = document.createElement("span"); actions.className = "ob-actions";
    const btn = document.createElement("button");
    btn.className = "btn-mini update-btn"; btn.dataset.update = r.agent;
    // #63 moved the onboarding row's aria-live to the lock hint, but updateAgentCli() still relies on the
    // "Updating…/Updated" status being announced. Give the update control its own polite live region —
    // aria-live (not role="status") so it stays a real button. (CodeRabbit)
    btn.setAttribute("aria-live", "polite");
    btn.textContent = t("checkingUpdate"); btn.disabled = true;
    actions.appendChild(btn); row.appendChild(actions);
  }
  item.appendChild(row);
  if (r.agent && !r.ok) item.appendChild(renderMissingPanel(r.agent));
  return item;
}

// Inline setup for a not-installed provider: install command (copy) + docs link + [Find installed copy]
// (discovery → found path + [Verify & trust]) + [Re-check].
function renderMissingPanel(agent) {
  const info = providerInfo(agent);
  const box = document.createElement("div"); box.className = "onboard-detail";
  const intro = document.createElement("p"); intro.className = "ob-install-intro"; intro.textContent = t("installIntro");
  box.appendChild(intro);
  if (info.install?.command) {
    const cmdRow = document.createElement("div"); cmdRow.className = "ob-cmd-row";
    const code = document.createElement("code"); code.className = "cli-setup-cmd"; code.innerHTML = bdi(info.install.command, "ltr");
    const copy = document.createElement("button"); copy.className = "btn-mini"; copy.textContent = t("copyCommand");
    const feedback = document.createElement("span"); feedback.className = "ob-copy-feedback"; feedback.setAttribute("aria-live", "polite");
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(info.install.command); feedback.textContent = t("copied"); }
      catch { feedback.textContent = t("copyFailed"); }
    };
    cmdRow.append(code, copy, feedback);
    box.appendChild(cmdRow);
  }
  const linkRow = document.createElement("div"); linkRow.className = "ob-link-row";
  if (info.install?.url && /^https:\/\//.test(info.install.url)) {
    const docs = document.createElement("a"); docs.className = "ob-docs";
    docs.href = info.install.url; docs.target = "_blank"; docs.rel = "noreferrer noopener";
    docs.textContent = t("installDocs");
    const sr = document.createElement("span"); sr.className = "sr-only"; sr.textContent = ` (${t("opensInNewTab")})`;
    docs.appendChild(sr); linkRow.appendChild(docs);
  }
  // A descriptor-launched provider (e.g. Cursor) has no editable command to discover or trust — a PATH probe
  // can't resolve its shim, and the trust flow (applyDiscoveredCommand → checkCli) targets a command input +
  // health span its card no longer renders. Offer only the install command + docs + Re-check; its readiness
  // comes from the pinned descriptor and refreshes on Re-check.
  if (!info.descriptorLaunch) {
    const find = document.createElement("button"); find.className = "btn-mini";
    find.textContent = t("findInstalled");
    find.setAttribute("aria-label", `${t("findInstalled")}: ${info.label}`);
    find.onclick = () => discoverForDoctor(agent, box, find);
    linkRow.appendChild(find);
  }
  const recheck = document.createElement("button"); recheck.className = "btn-mini btn-ghost";
  recheck.textContent = t("recheck");
  recheck.onclick = () => loadOnboard();
  linkRow.appendChild(recheck);
  box.appendChild(linkRow);
  return box;
}

// Discover a native executable and, when found, show each path with [Verify & trust] inline (no drawer).
async function discoverForDoctor(agent, box, btn) {
  btn.disabled = true; const prev = btn.textContent; btn.textContent = t("setupSearching");
  box.querySelector(".ob-found")?.remove();
  try {
    const result = await api("/api/cli/discover", { method: "POST", body: JSON.stringify({ provider: agent }) });
    if (result.resolved) { await loadOnboard(); return; }
    const candidates = result.candidates || [];
    btn.textContent = prev; btn.disabled = false;
    const found = document.createElement("div"); found.className = "ob-found";
    if (!candidates.length) {
      const none = document.createElement("p"); none.className = "ob-install-intro"; none.textContent = t("setupNoneFound");
      found.appendChild(none);
    } else {
      const foundIntro = document.createElement("p"); foundIntro.className = "ob-install-intro"; foundIntro.textContent = t("setupFoundIntro");
      found.appendChild(foundIntro);
      for (const candidate of candidates) {
        const fr = document.createElement("div"); fr.className = "ob-found-row";
        const label = document.createElement("span"); label.className = "ob-found-path";
        label.innerHTML = `${esc(t("foundAt"))} <code>${bdi(candidate, "ltr")}</code>`;
        const trust = document.createElement("button"); trust.className = "btn-mini"; trust.textContent = t("verifyAndTrust");
        trust.setAttribute("aria-label", `${t("verifyAndTrust")}: ${candidate}`);
        trust.onclick = async () => { trust.disabled = true; const ok = await applyDiscoveredCommand(agent, candidate); if (ok) await loadOnboard(); else trust.disabled = false; };
        fr.append(label, trust); found.appendChild(fr);
      }
    }
    box.appendChild(found);
  } catch (e) {
    btn.textContent = prev; btn.disabled = false;
    // Wrap in .ob-found so a retry's top-of-function cleanup replaces this error instead of stacking it.
    const errBox = document.createElement("div"); errBox.className = "ob-found";
    const err = document.createElement("p"); err.className = "ob-install-intro"; err.textContent = localizedFailure(e);
    errBox.appendChild(err); box.appendChild(errBox);
  }
}

// Persist + render the last-checked time, and reflect setup completeness on the Setup (⚙) button badge.
function markDoctorChecked(providersReady) {
  const now = new Date();
  try { localStorage.setItem("codebate-doctor-checked", now.toISOString()); } catch {}
  const stamp = $("onboardLastChecked");
  if (stamp) stamp.textContent = `${t("lastChecked")}: ${new Intl.DateTimeFormat(localeId(lang), { hour: "2-digit", minute: "2-digit" }).format(now)}`;
  reflectSetupBadge(providersReady);
}

// Show an attention dot on the Setup (⚙) button whenever the agents aren't both ready, so setup stays
// discoverable after the Doctor is closed. Also flip the button's accessible name so screen-reader and
// voice-control users get the same "setup incomplete" signal the dot gives sighted users. applyLang()
// re-applies this from lastProvidersReady after it resets the static aria-label on a language switch.
function reflectSetupBadge(providersReady) {
  lastProvidersReady = providersReady;
  const btn = $("openOnboard");
  if (!btn) return;
  btn.classList.toggle("needs-setup", !providersReady);
  btn.setAttribute("aria-label", providersReady ? t("setup") : t("setupNeedsAttention"));
}

// Turn each "Checking…" update button into its real state using a registry version check.
const updateTimers = new Map();

// Reset a CLI update button to a plain, clickable "Update" — used whenever the availability check
// couldn't produce a verdict (offline, registry hiccup, unparseable manifest), so a button is never
// stranded on a disabled "Checking…" and the user can still try to update.
function resetToPlainUpdate(btn) {
  btn.disabled = false; btn.className = "btn-mini update-btn";
  btn.textContent = t("update"); btn.title = "";
  btn.onclick = () => updateAgentCli(btn.dataset.update, btn);
}
async function refreshUpdateStates() {
  let checks;
  try { checks = await api("/api/agents/update-check"); }
  catch {
    // Offline / check failed: offer a plain Update they can still click to try updating.
    for (const btn of document.querySelectorAll(".update-btn[data-update]")) { btn.hidden = false; resetToPlainUpdate(btn); }
    return;
  }
  for (const btn of document.querySelectorAll(".update-btn[data-update]")) {
    const c = checks[btn.dataset.update];
    if (!c || !c.installed) { btn.hidden = true; continue; }
    btn.hidden = false;
    if (c.updateAvailable) {
      btn.disabled = false;
      btn.className = "btn-mini update-btn update-available";
      // Isolate the version so the LTR number/arrow render correctly inside an RTL button.
      btn.innerHTML = c.latest ? `${esc(t("update"))} → ${bdi(c.latest, "ltr")}` : esc(t("update"));
      btn.title = c.current && c.latest ? `${c.current} → ${c.latest}` : "";
      btn.onclick = () => updateAgentCli(btn.dataset.update, btn);
    } else if (c.checkFailed) {
      // Couldn't reach the registry — offer a plain Update rather than a possibly-wrong "up to date".
      resetToPlainUpdate(btn);
    } else {
      btn.disabled = true; btn.className = "btn-mini update-btn is-updated";
      btn.textContent = t("updated"); btn.title = c.current || ""; btn.onclick = null;
    }
  }
}
async function updateAgentCli(agent, btn) {
  btn.disabled = true; btn.onclick = null; btn.title = "";
  const startedAt = Date.now();
  // "Updating…" is announced once; the ticking seconds go in an aria-hidden span so a slow
  // `claude update`/`codex update` never looks frozen yet doesn't re-announce every second to a
  // screen reader (the onboarding row is an aria-live status region).
  btn.textContent = "";
  const label = document.createElement("span"); label.textContent = t("updating");
  const elapsed = document.createElement("span"); elapsed.className = "upd-elapsed"; elapsed.setAttribute("aria-hidden", "true");
  btn.append(label, elapsed);
  // Locale-aware compact seconds ("5s" / "٥ ث") so the ticker matches every other number in the app
  // (Arabic-Indic digits in AR), instead of always-Western hand-formatted digits.
  const secFmt = new Intl.NumberFormat(localeId(lang), { style: "unit", unit: "second", unitDisplay: "narrow" });
  const tick = () => { elapsed.textContent = " " + secFmt.format(Math.round((Date.now() - startedAt) / 1000)); };
  tick();
  const timer = setInterval(tick, 1000);
  updateTimers.set(agent, timer); // tracked so loadOnboard can clear a ticking timer on re-render
  const restore = () => { btn.disabled = false; btn.onclick = () => updateAgentCli(agent, btn); };
  try {
    const r = await api("/api/agents/update", { method: "POST", body: JSON.stringify({ agent }) });
    clearInterval(timer); updateTimers.delete(agent);
    btn.textContent = r.ok ? t("updated") : t("updateFailed");
    if (r.ok) { setTimeout(loadOnboard, 1200); } // re-check: shows the new version + flips the button
    else { btn.title = r.output || ""; restore(); } // let the user retry a failed update
  } catch (e) {
    clearInterval(timer); updateTimers.delete(agent);
    btn.textContent = t("updateFailed"); btn.title = localizedFailure(e); restore();
  }
}

/* project picker (new-session modal) */
let projMode = "none";
let chosenProject = null;
let repoCache = [];
function setProjTab(mode) {
  projMode = mode;
  document.querySelectorAll(".proj-tab").forEach((b) => {
    const active = b.dataset.proj === mode;
    b.classList.toggle("is-active", active);
    b.setAttribute("aria-pressed", String(active));
  });
  $("projLocalPane").hidden = mode !== "local";
  $("projGithubPane").hidden = mode !== "github";
  if (mode === "none") { chosenProject = null; $("projChosen").classList.add("hidden"); }
  if (mode === "local" && $("fsList").dataset.loaded !== "1") fsNavigate("");
  if (mode === "github" && $("repoList").dataset.loaded !== "1") loadRepos();
}
function showChosen(value, { icon = "", technical = false } = {}) {
  const el = $("projChosen");
  const content = technical ? bdi(value, "ltr") : `<span dir="auto">${esc(value)}</span>`;
  el.innerHTML = `<span aria-hidden="true">✓${icon ? ` ${esc(icon)}` : ""}</span> ${content}`;
  el.classList.remove("hidden");
}
async function fsNavigate(p) {
  const list = $("fsList"); list.innerHTML = `<div class="fs-empty">…</div>`;
  try {
    const r = await api(`/api/fs/list?path=${encodeURIComponent(p)}`);
    list.dataset.loaded = "1";
    $("fsPath").innerHTML = r.path ? bdi(r.path, "ltr") : "—";
    $("fsUp").dataset.parent = r.parent ?? "";
    $("fsUp").disabled = r.parent === null;
    list.innerHTML = "";
    if (r.path) {
      const cur = document.createElement("div"); cur.className = "fs-item";
      cur.innerHTML = `${r.isGit ? '<span class="fs-git">git</span>' : '<span class="fs-ic" aria-hidden="true">📂</span>'}<span class="fs-name">${esc(t("useFolder"))} ← ${bdi(r.path, "ltr")}</span><button class="fs-use">${esc(t("useFolder"))}</button>`;
      cur.querySelector(".fs-use").onclick = () => { chosenProject = { type: "local", path: r.path }; showChosen(r.path, { icon: "📁", technical: true }); };
      list.appendChild(cur);
    }
    for (const d of r.dirs) {
      const row = document.createElement("button"); row.type = "button"; row.className = "fs-item fs-item-button";
      row.setAttribute("aria-label", t("openFolder")(d.name));
      row.innerHTML = `<span class="fs-ic" aria-hidden="true">📁</span><span class="fs-name">${bdi(d.name)}</span>`;
      row.onclick = () => fsNavigate(d.path);
      list.appendChild(row);
    }
    if (!r.dirs.length && !r.path) list.innerHTML = `<div class="fs-empty">${esc(t("noFolders"))}</div>`;
  } catch (e) { list.innerHTML = `<div class="fs-empty">${esc(localizedFailure(e))}</div>`; }
}
async function loadRepos() {
  const list = $("repoList"); list.innerHTML = `<div class="fs-empty">…</div>`;
  try {
    const r = await api("/api/github/repos");
    if (r.code) throw failureFromPayload(r);
    list.dataset.loaded = "1";
    repoCache = r.repos || [];
    renderRepos("");
  } catch (e) { list.innerHTML = `<div class="fs-empty">${esc(localizedFailure(e))}</div>`; }
}
function renderRepos(q) {
  const list = $("repoList"); list.innerHTML = "";
  const repos = repoCache.filter((r) => r.nameWithOwner.toLowerCase().includes(q.toLowerCase()));
  if (!repos.length) { list.innerHTML = `<div class="fs-empty">${esc(t("noRepos"))}</div>`; return; }
  for (const r of repos.slice(0, 60)) {
    const row = document.createElement("button"); row.type = "button"; row.className = "fs-item fs-item-button";
    row.setAttribute("aria-label", t("selectRepository")(r.nameWithOwner));
    row.innerHTML = `<span class="fs-ic" aria-hidden="true">◉</span><span class="fs-name">${bdi(r.nameWithOwner, "ltr")}</span><span class="repo-vis">${bdi(r.visibility, "ltr")}</span>`;
    row.onclick = () => { chosenProject = { type: "github", repo: r.nameWithOwner }; showChosen(r.nameWithOwner, { icon: "◉", technical: true }); };
    list.appendChild(row);
  }
}
function openOnboard() {
  const modal = $("onboardModal");
  openManagedModal(modal, { initialFocus: modal.querySelector(".modal"), dismiss: closeOnboard });
  loadOnboard();
}
function closeOnboard() {
  closeManagedModal($("onboardModal"));
  localStorage.setItem("codebate-onboarded", "1");
}

/* ---------------- project + execute ---------------- */
function toggleExec() {
  const drawer = $("execDrawer");
  const open = drawer.hidden;
  drawer.hidden = !open;
  $("execToggle").setAttribute("aria-expanded", String(open));
  if (open) {
    $("setupDrawer").hidden = true;
    $("setupToggle").setAttribute("aria-expanded", "false");
  }
}
async function attachProject() {
  const p = $("projectPath").value.trim(); if (!p || !currentSessionId) return;
  const requestedId = currentSessionId;
  const requestedEpoch = sessionViewEpoch;
  const st = $("projectStatus"); st.textContent = "..."; st.className = "run-state";
  try {
    const r = await api(`/api/sessions/${requestedId}/project`, { method: "POST", body: JSON.stringify({ path: p }) });
    if (!isCurrentSessionView(requestedId, requestedEpoch)) return;
    st.textContent = t("untrustedProject");
    st.className = "run-state";
    $("trustProject").hidden = false;
    if (currentSession) currentSession.project = r.project;
  } catch (e) { if (isCurrentSessionView(requestedId, requestedEpoch)) st.textContent = localizedFailure(e); }
}
async function trustProject() {
  if (!currentSession?.project || !window.confirm(t("trustPrompt"))) return;
  const requestedId = currentSessionId;
  const requestedEpoch = sessionViewEpoch;
  const fingerprint = currentSession.project.fingerprint;
  try {
    const response = await api(`/api/sessions/${requestedId}/project-trust`, {
      method: "POST",
      body: JSON.stringify({ fingerprint }),
    });
    if (!isCurrentSessionView(requestedId, requestedEpoch) || !currentSession) return;
    currentSession.project = response.project;
    await loadSession();
  } catch (error) {
    if (isCurrentSessionView(requestedId, requestedEpoch)) $("projectStatus").textContent = localizedFailure(error);
  }
}
async function loadConnectors() {
  const requestedId = currentSessionId;
  const requestedEpoch = sessionViewEpoch;
  if (!requestedId) { connectorRequests.invalidate(); return; }
  const list = $("connectorsList");
  try {
    const request = await connectorRequests.run(requestedId);
    if (!request.current || !isCurrentSessionView(requestedId, requestedEpoch)) return;
    const { data, configuration } = request.value;
    const configs = new Map((configuration.connectors || []).map((item) => [item.id, item]));
    list.innerHTML = "";
    for (const connector of data.connectors) {
      const enabled = data.enabled?.[connector.id]?.enabled === true;
      const config = configs.get(connector.id);
      const connectorName = localizedMarkup(connectorLabelKey(connector.id), connector.label || connector.id);
      const descriptions = connector.actions.map((action) => localizedMarkup(connectorActionKeys(connector.id, action.id)?.description, action.id)).join(" · ");
      const notes = [
        connector.experimental ? t("connectorExperimental") : "",
        connector.limitation === "gmail_token_expiry_unmanaged" ? t("gmailTokenLimitation") : "",
        connector.securityGuidance === "supabase_least_privilege_rls" ? t("supabaseSecurityGuidance") : "",
      ].filter(Boolean);
      const hostNote = connector.displayHost ? `<small>${esc(t("configuredHost"))}: ${bdi(connector.displayHost, "ltr")}</small>` : "";
      const row = document.createElement("div");
      row.className = "connector-row";
      row.innerHTML = `<div><b>${connectorName}</b><small>${connector.configured ? descriptions : esc(t("notConfigured"))}</small>${notes.map((note) => `<small>${esc(note)}</small>`).join("")}${hostNote}</div><div class="connector-controls">${config ? `<button class="btn-mini" data-config aria-expanded="false">${esc(t("configure"))}</button>` : ""}<button class="btn-mini" data-toggle${!enabled && !connector.ready ? " disabled" : ""}>${esc(enabled ? t("disable") : t("enable"))}</button></div>`;
      row.querySelector("[data-toggle]").onclick = async () => {
        try {
          await api(`/api/sessions/${requestedId}/connectors/${encodeURIComponent(connector.id)}`, { method: "POST", body: JSON.stringify({ enabled: !enabled }) });
          if (isCurrentSessionView(requestedId, requestedEpoch)) await loadSession();
        } catch (error) {
          if (isCurrentSessionView(requestedId, requestedEpoch)) list.textContent = localizedFailure(error);
        }
      };
      list.appendChild(row);
      row.querySelector("[data-config]")?.addEventListener("click", (event) => {
        const button = event.currentTarget;
        const existing = list.querySelector(`[data-config-form="${connector.id}"]`);
        if (existing) { existing.remove(); button.setAttribute("aria-expanded", "false"); return; }
        const form = document.createElement("div");
        form.className = "connector-config";
        form.dataset.configForm = connector.id;
        form.id = `connector-config-${connector.id}`;
        button.setAttribute("aria-controls", form.id);
        button.setAttribute("aria-expanded", "true");
        const fieldLabels = { "gmail:accessToken": t("gmailAccessToken"), "supabase:url": t("supabaseUrl"), "supabase:key": t("supabaseKey") };
        form.innerHTML = config.editable
          ? `${config.fields.map((field) => { const inputId = `connector-${connector.id}-${field.id}`; return `<label for="${esc(inputId)}">${esc(fieldLabels[`${connector.id}:${field.id}`] || field.label)}</label><input id="${esc(inputId)}" data-field="${esc(field.id)}" type="${field.secret ? "password" : "url"}" placeholder="${field.configured ? "••••••••" : ""}" autocomplete="off">`; }).join("")}<div class="inline"><button type="button" class="btn-primary" data-save>${esc(t("save"))}</button><button type="button" class="btn-danger" data-clear>${esc(t("clear"))}</button><span class="connector-status" role="status" aria-live="polite"></span></div>`
          : `<span class="connector-status" role="status">${esc(t("secureStoreUnavailable"))}</span>`;
        row.after(form);
        const submit = async (clear) => {
          const status = form.querySelector(".connector-status");
          const body = { clear };
          form.querySelectorAll("[data-field]").forEach((input) => { if (input.value) body[input.dataset.field] = input.value; });
          try {
            await api(`/api/connector-config/${encodeURIComponent(connector.id)}`, { method: "POST", body: JSON.stringify(body) });
            await loadConnectors();
          } catch (error) { status.textContent = localizedFailure(error); }
        };
        form.querySelector("[data-save]")?.addEventListener("click", () => submit(false));
        form.querySelector("[data-clear]")?.addEventListener("click", () => submit(true));
      });
    }
    for (const action of (data.actions || []).slice(-20).reverse()) {
      const row = document.createElement("div");
      row.className = "connector-action";
      const connectorName = localizedMarkup(connectorLabelKey(action.connector), action.connector);
      const actionName = localizedMarkup(connectorActionKeys(action.connector, action.action)?.label, action.action);
      const status = localizedMarkup(connectorStatusKey(action.status), action.status);
      const renderedResult = action.result && typeof action.result === "object" ? JSON.stringify(action.result, null, 2) : String(action.result || "");
      const result = action.error ? technicalDetailsHtml(action.error) : renderedResult ? `<pre dir="ltr" tabindex="0">${esc(renderedResult)}</pre>` : "";
      row.innerHTML = `<b>${connectorName} · ${actionName}</b><span class="connector-status" role="status" aria-live="polite">${status}</span><pre dir="ltr" tabindex="0">${esc(JSON.stringify(action.input, null, 2))}</pre>${result}${action.status === "pending" ? `<div><button class="btn-primary">${esc(t("approveAction"))}</button><button class="btn-danger">${esc(t("rejectAction"))}</button></div>` : ""}`;
      if (action.status === "pending") {
        const decide = async (approve) => {
          try {
            await api(`/api/sessions/${requestedId}/connector-actions/${encodeURIComponent(action.id)}/decide`, { method: "POST", body: JSON.stringify({ approve }) });
            if (isCurrentSessionView(requestedId, requestedEpoch)) await loadSession();
          } catch (error) {
            if (isCurrentSessionView(requestedId, requestedEpoch)) list.textContent = localizedFailure(error);
          }
        };
        const buttons = row.querySelectorAll("button");
        buttons[0].onclick = () => decide(true);
        buttons[1].onclick = () => decide(false);
      }
      list.appendChild(row);
    }
    for (const audit of (data.readAudits || []).slice(-20).reverse()) {
      const row = document.createElement("div");
      row.className = "connector-action connector-audit";
      const connectorName = localizedMarkup(connectorLabelKey(audit.connector), audit.connector);
      const actionName = localizedMarkup(connectorActionKeys(audit.connector, audit.action)?.label, audit.action);
      const status = localizedMarkup(connectorStatusKey(audit.status), audit.status);
      const timing = [audit.requestedAt, audit.completedAt].filter(Boolean).map((date) => formatClock(date)).join(" → ");
      row.innerHTML = `<b>${esc(t("connectorReadAudit"))} · ${connectorName} · ${actionName}</b><span class="connector-status">${status}</span><small>${esc(timing)}</small><pre dir="ltr" tabindex="0">${esc(JSON.stringify(audit.inputSummary || {}, null, 2))}</pre>`;
      list.appendChild(row);
    }
  } catch (error) {
    if (isCurrentSessionView(requestedId, requestedEpoch)) list.textContent = localizedFailure(error);
  }
}
function execPayload() {
  return {
    executor: $("execExecutor").value, reviewer: $("execReviewer").value, mode: $("execMode").value, task: $("execTask").value.trim(),
    agents: providerPayload(false),
  };
}
function syncExecModes() {
  const allowed = providerInfo($("execExecutor").value).capabilities?.executeModes || [];
  for (const option of $("execMode").options) option.disabled = !allowed.includes(option.value);
  if (!allowed.includes($("execMode").value)) $("execMode").value = allowed[0] || "run";
}
let pendingExec = null;
function requestExec() {
  if (!currentSessionId || running) return;
  const body = execPayload();
  if (!body.task) { $("execStatus").textContent = t("writeFirst"); return; }
  if (body.executor === body.reviewer) { $("execStatus").textContent = t("sameAgent"); return; }
  pendingExec = body;
  const executor = bdi(providerInfo(body.executor).label, "ltr");
  const reviewer = bdi(providerInfo(body.reviewer).label, "ltr");
  $("approveBody").innerHTML = `${t("approvalSummary")(executor, esc(modeLabel(body.mode)), reviewer)}<br><br><span dir="auto">${esc(body.task)}</span>`;
  openManagedModal($("approveModal"), { initialFocus: $("approveCancel"), dismiss: cancelExecApproval });
}
async function confirmExec() {
  closeManagedModal($("approveModal"), { restoreFocus: false });
  if (!pendingExec) return;
  const requestedId = currentSessionId;
  const requestedEpoch = sessionViewEpoch;
  const body = pendingExec;
  pendingExec = null;
  setRunning(true, t("starting"), "execution");
  $("execStopBtn").focus();
  try { await api(`/api/sessions/${requestedId}/execute`, { method: "POST", body: JSON.stringify(body) }); }
  catch (e) {
    if (!isCurrentSessionView(requestedId, requestedEpoch)) return;
    setRunning(false, localizedFailure(e));
    $("execStopBtn").hidden = true;
    $("execRun").disabled = false;
  }
}
function cancelExecApproval() {
  closeManagedModal($("approveModal"));
  pendingExec = null;
}

/* ---------------- execution result cards ---------------- */
function highlightDiff(patch) {
  return String(patch).split("\n").map((l) => {
    const e = esc(l);
    if (l.startsWith("+") && !l.startsWith("+++")) return `<span class="diff-add">${e}</span>`;
    if (l.startsWith("-") && !l.startsWith("---")) return `<span class="diff-del">${e}</span>`;
    if (l.startsWith("@@")) return `<span class="diff-hunk">${e}</span>`;
    return e;
  }).join("\n");
}
function modeLabel(m) { return { run: t("modeRun"), full: t("modeFull") }[m] || m; }
function execStatusLabel(s) { return { awaiting_user: t("execAwaiting"), accepting_merge: t("accepting"), accepting_pr: t("publishing"), rejecting: t("rejecting"), accepted_pending_merge: t("retryMerge"), accepted_pending_pr: t("retryPr"), rejected_cleanup_pending: t("retryCleanup"), merged: t("merged"), pr_opened: t("prOpened"), rejected: t("rejected"), blocked_secret: `🔒 ${t("secretsBlocked")}` }[s] || s; }
function renderExecutions() {
  const chat = $("chat");
  for (const ex of currentSession?.executions ?? []) {
    const el = document.createElement("article"); el.className = "msg exec-card";
    let body = `<div class="exec-body">`;
    body += `<div class="exec-part"><div class="exec-label">${esc(t("executor"))} (${bdi(providerInfo(ex.executor).label, "ltr")})</div><div class="exec-text" dir="auto">${esc(ex.executorText || "")}</div></div>`;
    if (ex.diff?.patch) body += `<div class="exec-part exec-diff"><div class="exec-label">${bdi(ex.diff.files || "", "ltr")}</div><pre dir="ltr" tabindex="0">${highlightDiff(ex.diff.patch)}</pre></div>`;
    if (ex.review?.text) body += `<div class="exec-part"><div class="exec-label">${esc(t("reviewer"))} (${bdi(providerInfo(ex.reviewer).label, "ltr")})</div><div class="exec-text" dir="auto">${esc(ex.review.text)}</div></div>`;
    if (ex.executorMeta?.outputTruncated || ex.review?.meta?.outputTruncated) body += `<div class="exec-part"><div class="exec-label">⚠ ${esc(t("truncatedTag"))}</div></div>`;
    if (ex.secretFindings?.length) body += `<div class="exec-part"><div class="exec-label">🔒 ${esc(t("secretScanBlocked"))}</div><div class="exec-text">${ex.secretFindings.map((f) => `${bdi(f.path, "ltr")}${f.line ? `:${bdi(formatLocaleNumber(lang, f.line))}` : ""} — ${bdi(f.rule, "ltr")} (${bdi(f.severity, "ltr")})`).join("<br>")}</div></div>`;
    if (ex.status === "awaiting_user") {
      body += `<div class="exec-decision"><button class="btn-primary" data-accept="merge" data-task="${esc(ex.taskId)}">${esc(t("mergeLocal"))}</button>`;
      if (currentSession.project?.canOpenPr) body += `<button class="btn-ghost" data-accept="pr" data-task="${esc(ex.taskId)}">${esc(t("openPr"))}</button>`;
      body += `<button class="btn-danger" data-reject="${esc(ex.taskId)}">${esc(t("reject"))}</button></div>`;
    } else if (ex.status === "accepted_pending_merge" || ex.status === "accepted_pending_pr") {
      const retryAction = ex.status === "accepted_pending_pr" ? "pr" : "merge";
      body += `<div class="exec-decision"><button class="btn-primary" data-accept="${retryAction}" data-task="${esc(ex.taskId)}">${esc(execStatusLabel(ex.status))}</button></div>`;
    } else if (ex.status === "rejected_cleanup_pending") {
      body += `<div class="exec-decision"><button class="btn-danger" data-reject="${esc(ex.taskId)}">${esc(execStatusLabel(ex.status))}</button></div>`;
    } else {
      const link = ex.prUrl ? ` — <a href="${esc(ex.prUrl)}" target="_blank" rel="noopener">PR<span class="sr-only"> (${esc(t("opensInNewTab"))})</span></a>` : "";
      body += `<div class="exec-status-line">${esc(execStatusLabel(ex.status))}${link}</div>`;
    }
    body += `</div>`;
    el.innerHTML = `<div class="exec-card-head"><span class="exec-badge">${esc(t("execute"))}</span> <b>${bdi(providerInfo(ex.executor).label, "ltr")}</b> → ${ex.reviewer ? bdi(providerInfo(ex.reviewer).label, "ltr") : "—"} <span class="badge">${esc(modeLabel(ex.mode))}</span> <span class="badge">${esc(execStatusLabel(ex.status))}</span></div>${body}`;
    chat.appendChild(el);
  }
  const lockDecisionButtons = (button) => button.closest(".exec-card")?.querySelectorAll("[data-accept],[data-reject]").forEach((item) => { item.disabled = true; });
  chat.querySelectorAll("[data-accept]").forEach((b) => b.onclick = () => { lockDecisionButtons(b); acceptExec(b.dataset.task, b.dataset.accept); });
  chat.querySelectorAll("[data-reject]").forEach((b) => b.onclick = () => { lockDecisionButtons(b); rejectExec(b.dataset.reject); });
}
async function acceptExec(taskId, action) {
  const requestedId = currentSessionId;
  const requestedEpoch = sessionViewEpoch;
  // Reserve the browser window during the click event. Waiting for the API and
  // session refresh first causes normal popup blockers to reject the PR window.
  const reservedPrWindow = reservePrWindow(window, action);
  let response;
  try {
    response = await api(`/api/sessions/${requestedId}/execution/${taskId}/accept`, { method: "POST", body: JSON.stringify({ action }) });
  } catch (error) {
    closeReservedPrWindow(reservedPrWindow);
    if (!isCurrentSessionView(requestedId, requestedEpoch)) return;
    $("liveStatus").textContent = localizedFailure(error);
    await loadSession();
    return;
  }
  if (!isCurrentSessionView(requestedId, requestedEpoch)) {
    closeReservedPrWindow(reservedPrWindow);
    return;
  }
  openReservedPrWindow(window, reservedPrWindow, response.prUrl);
  try {
    await loadSession();
  } catch (error) {
    if (isCurrentSessionView(requestedId, requestedEpoch)) $("liveStatus").textContent = localizedFailure(error);
  }
}
async function rejectExec(taskId) {
  const requestedId = currentSessionId;
  const requestedEpoch = sessionViewEpoch;
  try {
    await api(`/api/sessions/${requestedId}/execution/${taskId}/reject`, { method: "POST", body: "{}" });
    if (isCurrentSessionView(requestedId, requestedEpoch)) await loadSession();
  } catch (error) {
    if (!isCurrentSessionView(requestedId, requestedEpoch)) return;
    $("liveStatus").textContent = localizedFailure(error);
    await loadSession();
  }
}

/* ---------------- mission-control decision room ---------------- */
const ROOM_PHASES = {
  plan: { pill: "roomPhasePlan", heading: "roomHeadingPlan", sub: "roomSubPlan" },
  collaboration: { pill: "roomPhaseCollaboration", heading: "roomHeadingCollaboration", sub: "roomSubCollaboration" },
  decision: { pill: "roomPhaseDecision", heading: "roomHeadingDecision", sub: "roomSubDecision" },
  execute: { pill: "roomPhaseExecute", heading: "roomHeadingExecute", sub: "roomSubExecute" },
};
const STAGE_KEYS = ["stagePlan", "stageCollab", "stageDecision", "stageExecute", "stageReview", "stageAccept"];
const STAGE_INDEX = { plan: 0, collaboration: 1, decision: 2, execute: 3 };
let liveAgents = {};

const TERMINAL_EXEC = new Set(["merged", "pr_opened", "rejected", "blocked_secret"]);
function pendingExecution() {
  return (currentSession?.executions ?? []).find((item) => item.status === "awaiting_user");
}
// An execution that still needs the user (awaiting a decision) or is stuck mid-accept/reject
// after an interruption (the *_pending retry states) — anything not yet in a terminal state.
function unresolvedExecution() {
  return (currentSession?.executions ?? []).find((item) => !TERMINAL_EXEC.has(item.status));
}
// Read-only phase derived from real session state; the mockup's manual switch is never authoritative.
function derivePhase() {
  if (!currentSession) return "plan";
  if (currentSession.executing || unresolvedExecution()) return "execute";
  if (currentSession.running || currentSession.status === "running") return "collaboration";
  // A fresh session with no agent replies yet hasn't reached a decision — keep it at Plan.
  const hasAgentReply = (currentSession.messages ?? []).some((message) => message.author === "agent");
  return hasAgentReply ? "decision" : "plan";
}
// Highest workflow stage the session has actually reached, from history — so the tracker
// never regresses (e.g. a merged execution keeps Execute/Accept marked done even though the
// live phase falls back to "decision" once nothing is in flight).
function furthestStageReached() {
  const executions = currentSession?.executions ?? [];
  // A successfully accepted execution completes every stage (index has no
  // "active" stage past the last one, so Accept stops showing as still in-progress).
  if (executions.some((item) => ["merged", "pr_opened"].includes(item.status))) return STAGE_KEYS.length;
  if (executions.length) return 3;
  if (latestHistoricalFinalReport()) return 2;
  if ((currentSession?.messages ?? []).some((message) => message.author === "agent")) return 1;
  return 0;
}
function applyPhase() {
  const phase = derivePhase();
  document.documentElement.dataset.phase = phase;
  const keys = ROOM_PHASES[phase];
  $("statusPill").textContent = t(keys.pill);
  $("mainHeading").textContent = t(keys.heading);
  $("mainSub").textContent = t(keys.sub);
  $("gateTag").hidden = phase !== "decision";
}
function formatClock(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString(localeId(lang), { hour: "2-digit", minute: "2-digit" });
}
function finalReportFrom(messages) {
  return [...messages].reverse().find((message) => ["converged", "needs_user", "blocked_external", "needs_more_rounds"].includes(message.phase));
}
function latestRunFinalReport() {
  return finalReportFrom(latestRunMessages());
}
function latestHistoricalFinalReport() {
  return finalReportFrom(currentSession?.messages ?? []);
}
// Stage timestamps derived from real events only; stages with no honest source (Plan, Review) stay blank.
function stageTimes() {
  const executions = currentSession?.executions ?? [];
  const firstAgent = (currentSession?.messages ?? []).find((message) => message.author === "agent");
  const finalReport = latestHistoricalFinalReport();
  const firstExec = executions.find((execution) => execution.createdAt);
  const accepted = [...executions].reverse().find((execution) => ["merged", "pr_opened"].includes(execution.status) && execution.decidedAt);
  return {
    1: firstAgent?.createdAt,   // Collaborate
    2: finalReport?.createdAt,  // Decision
    3: firstExec?.createdAt,    // Execute
    5: accepted?.decidedAt,     // Accept (most recent accepted cycle)
  };
}
function renderStages() {
  const host = $("stageList");
  if (!host) return;
  const activeIndex = Math.max(STAGE_INDEX[derivePhase()] ?? 2, furthestStageReached());
  const times = stageTimes();
  host.setAttribute("role", "list");
  host.innerHTML = "";
  STAGE_KEYS.forEach((key, index) => {
    const done = index < activeIndex;
    const active = index === activeIndex;
    const stage = document.createElement("div");
    stage.className = `stage${done ? " is-done" : ""}${active ? " is-active" : ""}`;
    stage.setAttribute("role", "listitem");
    if (active) stage.setAttribute("aria-current", "step");
    const clock = formatClock(times[index]);
    const clockHtml = clock ? `<time class="stage-time" datetime="${esc(times[index])}">${bdi(clock)}</time>` : "";
    stage.innerHTML = `<span class="stage-dot" aria-hidden="true">${done ? "✓" : bdi(formatLocaleNumber(lang, index + 1))}</span><strong>${esc(t(key))}</strong>${clockHtml}`;
    host.appendChild(stage);
  });
}
function latestAgentMessage(providerId) {
  const messages = currentSession?.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].author === "agent" && messages[index].agent === providerId) return messages[index];
  }
  return null;
}
function enabledProviders() {
  const enabled = providers.filter((item) => $(`${item.id}Enabled`)?.checked ?? true);
  return enabled.length ? enabled : providers;
}
function renderDecisionCards() {
  const host = $("agentGrid");
  if (!host) return;
  host.innerHTML = "";
  for (const provider of enabledProviders()) {
    const message = latestAgentMessage(provider.id);
    const nameId = `dcard-${provider.id}-name`;
    const card = document.createElement("article");
    card.className = `dcard ${esc(provider.id)}`;
    card.setAttribute("aria-labelledby", nameId);
    const badge = message ? phaseLabel(message.phase) : "";
    const head = `<div class="dcard-head"><div class="dcard-id"><span class="agent-avatar ${esc(provider.id)}" aria-hidden="true">${providerGlyph(provider.id, provider.label)}</span><strong id="${esc(nameId)}">${bdi(provider.label)}</strong></div>${badge ? `<span class="badge">${esc(badge)}</span>` : ""}</div>`;
    let body;
    if (message) {
      const meta = message.meta || {};
      const footParts = [
        meta.requestedModel ? bdi(meta.requestedModel, "ltr") : "",
        meta.requestedEffort ? bdi(meta.requestedEffort, "ltr") : "",
        fmtDuration(meta.durationMs) ? esc(fmtDuration(meta.durationMs)) : "",
        message.round ? `${esc(t("roundWord"))} ${bdi(formatLocaleNumber(lang, message.round))}` : "",
      ].filter(Boolean);
      const foot = footParts.length ? `<div class="dcard-foot">${footParts.join(" · ")}</div>` : "";
      body = `<div class="dcard-body md">${renderMarkdown(String(message.content || "").slice(0, 600))}${foot}</div>`;
    } else {
      body = `<div class="dcard-body"><p class="dcard-empty">${esc(t("dcardEmpty"))}</p></div>`;
    }
    card.innerHTML = head + body;
    host.appendChild(card);
  }
}
function renderApprovalGate() {
  const host = $("approvalHost");
  if (!host) return;
  host.innerHTML = "";
  const execution = pendingExecution();
  if (!execution) {
    // A prior accept/reject stuck mid-flight after an interruption still needs the user —
    // surface its retry here rather than the "Start execution" CTA, so nothing is stranded.
    const stuck = unresolvedExecution();
    if (stuck) { renderExecStuck(host, stuck); return; }
    // Otherwise, once the room actually converged on an outcome, offer a one-click bridge
    // into the Execute drawer. "needs_more_rounds" means the discussion did NOT reach
    // agreement — don't offer to execute an unresolved report.
    if (derivePhase() === "decision" && latestRunFinalReport()?.phase === "converged") renderProceedToExecute(host);
    return;
  }
  const executor = bdi(providerInfo(execution.executor).label, "ltr");
  const card = document.createElement("div");
  card.className = "approval";
  card.innerHTML = `<div class="approval-lock" aria-hidden="true">🔒</div><div><strong>${esc(t("execAwaiting"))}</strong><p>${t("approvalGateSummary")(executor)}</p></div><div class="approval-actions"></div>`;
  const actions = card.querySelector(".approval-actions");
  const addButton = (className, label, handler) => {
    const button = document.createElement("button");
    button.className = className;
    button.textContent = label;
    button.onclick = () => { actions.querySelectorAll("button").forEach((item) => { item.disabled = true; }); handler(); };
    actions.appendChild(button);
  };
  addButton("btn-primary", t("mergeLocal"), () => acceptExec(execution.taskId, "merge"));
  if (currentSession.project?.canOpenPr) addButton("btn-ghost", t("openPr"), () => acceptExec(execution.taskId, "pr"));
  addButton("btn-danger", t("reject"), () => rejectExec(execution.taskId));
  host.appendChild(card);
}
// A crash/interruption can leave an execution mid-accept or mid-reject. Surface the
// retry (or the in-progress status) in the Decision view so it isn't only reachable
// from the Conversation tab.
function renderExecStuck(host, ex) {
  const card = document.createElement("div");
  card.className = "approval";
  card.innerHTML = `<div class="approval-lock" aria-hidden="true">⟳</div><div><strong>${esc(t("execAwaiting"))}</strong><p>${esc(execStatusLabel(ex.status))}</p></div><div class="approval-actions"></div>`;
  const retry = {
    accepted_pending_merge: () => acceptExec(ex.taskId, "merge"),
    accepted_pending_pr: () => acceptExec(ex.taskId, "pr"),
    rejected_cleanup_pending: () => rejectExec(ex.taskId),
  }[ex.status];
  if (retry) {
    const button = document.createElement("button");
    button.className = "btn-primary";
    button.textContent = execStatusLabel(ex.status);
    button.onclick = () => { button.disabled = true; retry(); };
    card.querySelector(".approval-actions").appendChild(button);
  }
  host.appendChild(card);
}
function renderProceedToExecute(host) {
  const card = document.createElement("div");
  card.className = "proceed";
  card.innerHTML = `<div><strong>${esc(t("proceedTitle"))}</strong><p>${esc(t("proceedSub"))}</p></div><div class="proceed-actions"></div>`;
  const button = document.createElement("button");
  button.className = "btn-primary";
  button.textContent = t("proceedExecute");
  button.onclick = proceedToExecute;
  card.querySelector(".proceed-actions").appendChild(button);
  host.appendChild(card);
}
// Bridge from a converged discussion into execution: open the Execute drawer and
// seed the task with the agreed outcome. The user still reviews and runs it, then
// the normal execution approval gate (merge / PR / reject) follows.
function proceedToExecute() {
  const report = latestRunFinalReport();
  const conclusion = report ? String(report.content || "").trim() : "";
  $("execDrawer").hidden = false;
  $("execToggle").setAttribute("aria-expanded", "true");
  $("setupDrawer").hidden = true;
  $("setupToggle").setAttribute("aria-expanded", "false");
  if (conclusion && !$("execTask").value.trim()) $("execTask").value = `${t("proceedTaskPrefix")}\n\n${conclusion}`;
  $("execTask").focus();
}
function renderLiveStrip() {
  const strip = $("liveStrip");
  if (!strip) return;
  const ids = Object.keys(liveAgents);
  if (!ids.length) { strip.hidden = true; strip.innerHTML = ""; return; }
  strip.hidden = false;
  strip.innerHTML = ids.map((id) => {
    const info = providerInfo(id);
    return `<div class="live-actor"><span class="agent-avatar ${esc(info.id)}" aria-hidden="true">${providerGlyph(info.id, info.label)}</span><div><strong>${bdi(info.label)}</strong><span dir="auto">${esc(liveAgents[id])}</span></div></div>`;
  }).join("");
}
// Single re-render entry point, called from renderMessages() so it tracks every session/SSE update.
function renderDecisionRoom() {
  if (!$("stageList")) return;
  applyPhase();
  renderStages();
  renderDecisionCards();
  renderApprovalGate();
}

/* ---------------- theme / preset / view ---------------- */
function applyTheme(theme) {
  const value = theme === "light" ? "light" : "dark";
  if (value === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
  const button = $("themeBtn");
  if (button) {
    button.setAttribute("aria-pressed", String(value === "light"));
    button.textContent = value === "light" ? "☾" : "☼";
  }
  localStorage.setItem("codebate-theme", value);
}
function toggleTheme() { applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"); }

function applyPreset(id) {
  const value = ["simple", "builder", "mission"].includes(id) ? id : "mission";
  document.documentElement.dataset.preset = value;
  document.querySelectorAll(".preset").forEach((button) => {
    const active = button.dataset.preset === value;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  localStorage.setItem("codebate-preset", value);
}

const VIEW_TABS = ["tabDecision", "tabConversation"];
function setView(view) {
  const value = view === "conversation" ? "conversation" : "decision";
  $("decisionPanel").hidden = value !== "decision";
  $("conversationPanel").hidden = value !== "conversation";
  for (const id of VIEW_TABS) {
    const tab = $(id);
    const selected = tab.dataset.view === value;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1; // roving tabindex per the ARIA tabs pattern
  }
  localStorage.setItem("codebate-view", value);
}
function onViewTabKeydown(event) {
  const currentIndex = VIEW_TABS.indexOf(event.currentTarget.id);
  if (currentIndex === -1) return;
  let nextIndex = null;
  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    const forward = (event.key === "ArrowRight") !== (document.documentElement.dir === "rtl");
    nextIndex = (currentIndex + (forward ? 1 : -1) + VIEW_TABS.length) % VIEW_TABS.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = VIEW_TABS.length - 1;
  }
  if (nextIndex === null) return;
  event.preventDefault();
  const tab = $(VIEW_TABS[nextIndex]);
  setView(tab.dataset.view);
  tab.focus();
}

// The presets drawer reuses the app's managed-modal machinery (focus trap +
// appShell inert + Escape), then layers the slide/backdrop chrome on top.
function openPresets() {
  const drawer = $("presetsDrawer");
  const backdrop = $("backdrop");
  backdrop.hidden = false;
  drawer.setAttribute("aria-hidden", "false");
  openManagedModal(drawer, { initialFocus: $("closePresets"), dismiss: closePresets });
  requestAnimationFrame(() => { backdrop.classList.add("open"); drawer.classList.add("open"); });
}
function closePresets() {
  const drawer = $("presetsDrawer");
  const backdrop = $("backdrop");
  drawer.classList.remove("open");
  backdrop.classList.remove("open");
  backdrop.hidden = true;
  drawer.setAttribute("aria-hidden", "true");
  closeManagedModal(drawer);
}

/* ---------------- wiring ---------------- */
document.querySelectorAll(".lang-btn").forEach((b) => b.onclick = () => applyLang(b.dataset.lang));
document.querySelectorAll(".mode-btn").forEach((b) => b.onclick = () => setMode(b.dataset.mode));
$("setupToggle").onclick = toggleSetup;
$("newSessionBtn").onclick = openNewSessionModal;
$("emptyNewBtn").onclick = openNewSessionModal;
$("newSessionCreate").onclick = confirmNewSession;
$("newSessionCancel").onclick = closeNewSessionModal;
$("newSessionName").addEventListener("keydown", (e) => { if (e.key === "Enter") confirmNewSession(); });
document.querySelectorAll(".proj-tab").forEach((b) => b.onclick = () => setProjTab(b.dataset.proj));
$("fsUp").onclick = () => fsNavigate($("fsUp").dataset.parent || "");
$("repoSearch").addEventListener("input", () => renderRepos($("repoSearch").value));
$("sendBtn").onclick = sendMessage;
$("stopBtn").onclick = async () => { if (currentSessionId) await api(`/api/sessions/${currentSessionId}/stop`, { method: "POST", body: "{}" }); };
$("exportBtn").onclick = () => { if (currentSessionId) location.href = `/api/sessions/${currentSessionId}/export`; };
$("messageInput").addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") sendMessage(); });
$("messageInput").addEventListener("input", () => autoGrow($("messageInput")));
$("newSessionModal").addEventListener("click", (e) => { if (e.target === $("newSessionModal")) closeNewSessionModal(); });
$("connFooter").onclick = () => { pollHealth(); if (currentSessionId) openSession(currentSessionId); };
$("openOnboard").onclick = openOnboard;
$("diagnosticsBtn").onclick = () => {
  if (confirm(t("diagnosticsConfirm"))) location.href = "/api/diagnostics";
};
$("onboardRefresh").onclick = loadOnboard;
$("onboardDone").onclick = closeOnboard;
$("onboardModal").addEventListener("click", (e) => { if (e.target === $("onboardModal")) closeOnboard(); });
$("execToggle").onclick = toggleExec;
$("execExecutor").onchange = syncExecModes;
$("attachProject").onclick = attachProject;
$("trustProject").onclick = trustProject;
$("execRun").onclick = requestExec;
$("execStopBtn").onclick = async () => { if (currentSessionId) await api(`/api/sessions/${currentSessionId}/exec-stop`, { method: "POST", body: "{}" }); };
$("approveGo").onclick = confirmExec;
$("approveCancel").onclick = cancelExecApproval;
$("approveModal").addEventListener("click", (e) => { if (e.target === $("approveModal")) cancelExecApproval(); });
$("toggleRail").onclick = toggleRailCollapsed;
$("toggleContext").onclick = () => toggleColumn("context", $("toggleContext"));
$("toggleWorkflow").onclick = () => toggleColumn("workflow", $("toggleWorkflow"));
$("railDrawerToggle").onclick = () => toggleColumn("rail", $("railDrawerToggle"));
$("emptyRailDrawerToggle").onclick = () => toggleColumn("rail", $("emptyRailDrawerToggle"));
$("workflowToggle").onclick = () => toggleColumn("workflow", $("workflowToggle"));
$("contextDrawerToggle").onclick = () => toggleColumn("context", $("contextDrawerToggle"));
setupColumnResizers();
$("shellOverlayBackdrop").onclick = () => closeShellOverlay();
document.addEventListener("keydown", handleShellOverlayKeydown);
window.addEventListener("resize", () => {
  if (activeShellOverlay === "rail" && !window.matchMedia("(max-width: 860px)").matches) closeShellOverlay({ restoreFocus: false });
  if (["workflow", "context"].includes(activeShellOverlay) && !window.matchMedia("(max-width: 1100px)").matches) closeShellOverlay({ restoreFocus: false });
  applyShellChrome();
});
$("themeBtn").onclick = toggleTheme;
$("presetsBtn").onclick = openPresets;
$("closePresets").onclick = closePresets;
$("closePresets2").onclick = closePresets;
$("backdrop").onclick = closePresets;
document.querySelectorAll(".preset").forEach((button) => { button.onclick = () => applyPreset(button.dataset.preset); });
$("tabDecision").onclick = () => setView("decision");
$("tabConversation").onclick = () => setView("conversation");
VIEW_TABS.forEach((id) => { $(id).addEventListener("keydown", onViewTabKeydown); });
$("sessionGroupBy").onchange = () => {
  sessionGroupBy = $("sessionGroupBy").value === "project" ? "project" : "date";
  localStorage.setItem("codebate-session-group", sessionGroupBy);
  refreshSessions();
};
$("attachBtn").onclick = () => $("attachInput").click();
$("attachInput").addEventListener("change", () => handleAttachFiles($("attachInput").files));
$("renameSessionSave").onclick = saveRenameSession;
$("renameSessionCancel").onclick = closeRenameSessionModal;
$("renameSessionModal").addEventListener("click", (e) => { if (e.target === $("renameSessionModal")) closeRenameSessionModal(); });
$("renameSessionInput").addEventListener("keydown", (e) => { if (e.key === "Enter") saveRenameSession(); });
document.addEventListener("click", (event) => {
  if (openSessionMenu && !openSessionMenu.contains(event.target) && !event.target.closest?.(".session-more")) {
    closeSessionMenu();
  }
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b" && !activeModal) {
    event.preventDefault();
    toggleRailCollapsed();
  }
});

async function initialize() {
  applyShellChrome();
  applyLang(detectDefaultLang());
  applyTheme(localStorage.getItem("codebate-theme") || "dark");
  applyPreset(localStorage.getItem("codebate-preset") || "mission");
  setView(localStorage.getItem("codebate-view") || "decision");
  try {
    await loadProviderCatalog();
    loadSettings();
    syncExecModes();
    updateSetupSummary();
    // Absolute command paths from a previous session still need Trust & check
    // on a fresh server (or after hydrate). Re-check quietly so health badges
    // match what the user already configured.
    await Promise.all(providers.map(async (item) => {
      const command = $(`${item.id}Command`)?.value.trim() || "";
      if (command && /[\\/]/.test(command)) await checkCli(item.id);
    }));
  } catch (error) {
    setConnected(false);
    $("connText").textContent = localizedFailure(error);
  }
  refreshSessions();
  pollHealth();
  setInterval(pollHealth, 10000);
  // Reflect setup completeness on the ⚙ badge, and auto-open the Doctor on first run ONLY when something
  // is actually missing — a fully-ready setup shouldn't nag. A ready setup just clears the badge silently.
  try {
    const s = await api("/api/agents/status");
    const providersReady = providers.length > 0 && providers.every((item) => s.providers?.[item.id]?.installed);
    if (!providersReady && !localStorage.getItem("codebate-onboarded")) openOnboard();
    else reflectSetupBadge(providersReady);
  } catch { /* offline / boot race: leave the badge at its default */ }
}
initialize();
