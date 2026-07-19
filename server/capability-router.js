const RULES = [
  {
    intent: "publish",
    capability: "publish",
    patterns: [/\b(?:push|publish|open|create)\s+(?:a\s+)?(?:pr|pull request)\b/i, /\b(?:push|publish)\s+(?:the\s+)?(?:changes|branch|code)\b/i, /\b(?:send|email)\s+(?:it|this|them|the)\b/i, /(?:اعمل|افتح|انشر|ارفع)\s*(?:pr|pull request|بي آر)/i, /(?:ابعت|ارسل)\s*(?:الإيميل|الايميل|البريد)/i],
  },
  {
    intent: "execute",
    capability: "execute",
    patterns: [/\b(?:run|execute)\s+(?:the\s+)?tests?\b/i, /\brun\s+(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|check|lint|build)\b/i, /\bcommit\s+(?:the\s+)?(?:changes|code)\b/i, /\b(?:implement|fix|refactor|edit|change)\s+(?:the\s+)?(?:code|project|repo|files?|bug|feature)/i, /(?:شغ[ّ]?ل|نفذ|طب[ّ]?ق)\s*(?:الاختبارات|التستات|الخطة|التعديل|الكود)/i, /(?:اصلح|عد[ّ]?ل|غي[ّ]?ر)\s*(?:المشكلة|الكود|المشروع|الملفات)/i],
  },
  {
    intent: "project_read",
    capability: "projectRead",
    patterns: [/\b(?:review|audit|inspect|analy[sz]e)\s+(?:(?:the|this|that|my)\s+)?(?:project|repo|repository|codebase|code)\b/i, /(?:راجع|حلل|افحص)\s*(?:المشروع|الريبو|الكود)/i],
  },
];

const FOLLOW_UP_ACTION = /^(?:(?:please|then|and\s+then)\s+|(?:من فضلك|ثم)\s+)*(?:(?:push|publish|open|create|send|email|run|execute|commit|implement|fix|refactor|edit|change)\b|(?:و?(?:اعمل|افتح|انشر|ارفع|ابعت|ارسل|شغ[ّ]?ل|نفذ|طب[ّ]?ق|اصلح|عد[ّ]?ل|غي[ّ]?ر))(?=\s|$))/i;

function explicitFollowUpText(source) {
  const boundaries = /\r?\n|[,;:.!?؟]|\b(?:and\s+)?then\b|(?:^|\s)(?:ثم|وبعدين|وبعدها|بعد كده)(?=\s)/gi;
  for (const boundary of source.matchAll(boundaries)) {
    const tail = source.slice(boundary.index + boundary[0].length).trimStart();
    if (FOLLOW_UP_ACTION.test(tail)) return tail;
  }
  if (/^can you explain\b/i.test(source)) {
    for (const boundary of source.matchAll(/\band\b/gi)) {
      const tail = source.slice(boundary.index + boundary[0].length).trimStart();
      if (FOLLOW_UP_ACTION.test(tail)) return tail;
    }
  }
  return "";
}

export function routeRequest(text) {
  const source = String(text || "").trim();
  const informational = /^(?:how\s+(?:do|does|did|can|could|should|would|to)\b|what\s+(?:is|are|do|does|did|can|could|should|would)\b|(?:why|where|when)\b|can you explain\b|ازاي|إزاي|كيف|ليه|لماذا|فين)(?=\s|[؟?]|$)/i.test(source);
  const explicitFollowUp = informational ? explicitFollowUpText(source) : "";
  for (const rule of RULES) {
    if (informational && !explicitFollowUp && (rule.intent === "execute" || rule.intent === "publish")) continue;
    const candidate = informational && explicitFollowUp && (rule.intent === "execute" || rule.intent === "publish") ? explicitFollowUp : source;
    if (rule.patterns.some((pattern) => pattern.test(candidate))) {
      return { intent: rule.intent, requiredCapability: rule.capability, confidence: "high" };
    }
  }
  return { intent: "discussion", requiredCapability: "discussion", confidence: "default" };
}

export function preflightRoute(text, { projectTrusted = false } = {}) {
  const route = routeRequest(text);
  if (route.intent === "execute" || route.intent === "publish") {
    return {
      ...route,
      allowed: false,
      action: "open_execution",
      reasonCode: "state_change_requires_execution",
      reason: "This request changes state and needs the Execute → Review → Decide flow.",
    };
  }
  if (route.intent === "project_read" && !projectTrusted) {
    return {
      ...route,
      allowed: false,
      action: "attach_project",
      reasonCode: "project_trust_required",
      reason: "Attach and trust the project before a read-only review.",
    };
  }
  return { ...route, allowed: true, action: null, reasonCode: null, reason: "" };
}
