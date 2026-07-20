// Multi-layer secret detection for the files an executor changed, BEFORE they get
// committed / shown to the reviewer / merged. Layers: sensitive filenames + content
// patterns. It is a guard, NOT a guarantee — it reduces obvious leaks; it can't catch
// every secret and may false-positive. Findings never carry the secret value itself,
// only path / rule / severity / line, so surfacing them can't leak the secret.

const SENSITIVE_FILENAMES = [
  /(^|[\\/])\.env(\.[\w.-]+)?$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.key$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|[\\/])credentials(\.\w+)?$/i,
  /(^|[\\/])\.npmrc$/i,
  /(^|[\\/])\.pypirc$/i,
];

const CONTENT_RULES = [
  { rule: "private-key", severity: "critical", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { rule: "aws-access-key-id", severity: "critical", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "github-token", severity: "critical", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  // Anthropic keys (sk-ant-…) must be caught under their own label, and the generic OpenAI rule below
  // excludes the ant- prefix so a single key isn't double-reported and mislabeled as an OpenAI key. The
  // anthropic floor is {16,} after "sk-ant-" so the two rules' UNION still covers everything the old single
  // /sk-[A-Za-z0-9_-]{20,}/ caught (20 chars after "sk-" == 16 after "sk-ant-") — no coverage gap.
  { rule: "anthropic-key", severity: "critical", re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/ },
  { rule: "openai-key", severity: "critical", re: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/ },
  { rule: "slack-token", severity: "high", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { rule: "google-api-key", severity: "high", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: "aws-secret-key", severity: "high", re: /aws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+]{40}/i },
  { rule: "secret-assignment", severity: "high", re: /(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token)\s*[=:]\s*['"][^'"\n]{8,}['"]/i },
  // Unquoted form (dotenv / shell / Dockerfile ENV): KEY=longvalue with no quotes. Requires
  // a 12+ char value and skips obvious code refs (process.env, require, literals) to limit
  // false positives; still fail-closed, so the user reviews anything it flags.
  { rule: "secret-assignment-unquoted", severity: "high", re: /(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token)\s*[=:]\s*(?!(?:process|os|env|require|import|null|true|false|undefined)\b)[^\s'"#][^\s'"]{11,}/i },
];

// files: [{ path, content }]. content "" for binary/unreadable (filename check still runs).
export function scanForSecrets(files = []) {
  const findings = [];
  for (const file of files) {
    const path = String(file?.path || "");
    if (SENSITIVE_FILENAMES.some((re) => re.test(path))) {
      findings.push({ path, rule: "sensitive-filename", severity: "high", line: 0 });
    }
    // Fail closed when a changed blob could not be content-scanned. Accepting an opaque
    // changed blob would make the authoritative accept-time scan meaningless.
    if (file?.oversize) {
      findings.push({ path, rule: "unscanned-large-file", severity: "high", line: 0 });
    }
    const content = String(file?.content ?? "");
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    for (const { rule, severity, re } of CONTENT_RULES) {
      const idx = lines.findIndex((l) => re.test(l));
      if (idx !== -1) findings.push({ path, rule, severity, line: idx + 1 });
    }
  }
  return findings;
}

// Critical/high findings block the flow (fail-closed). Lower severities only warn.
export function hasBlockingSecrets(findings = []) {
  return findings.some((f) => f.severity === "critical" || f.severity === "high");
}
