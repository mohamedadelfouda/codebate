import { runClaude } from "../adapters/claude.js";
import { discoverCodexModels, runCodex } from "../adapters/codex.js";
import { discoverCursorModels, runCursor } from "../adapters/cursor.js";

// Install guidance only — shown to the user for copy/paste, never executed by
// Codebate. Claude needs its native installer because the npm package ships
// a JS shim without the native executable this host requires.
const installHint = (byPlatform) => byPlatform[process.platform] || byPlatform.default;

const providers = new Map([
  ["claude", {
    id: "claude",
    label: "Claude",
    command: "claude",
    commandEnv: "CODEBATE_CLAUDE_COMMAND",
    install: {
      command: installHint({
        win32: "irm https://claude.ai/install.ps1 | iex",
        default: "curl -fsSL https://claude.ai/install.sh | bash",
      }),
      url: "https://code.claude.com/docs/en/install",
    },
    updateArgs: ["update"],
    updatePackage: "@anthropic-ai/claude-code",
    defaultModel: "sonnet",
    models: ["default", "best", "fable", "sonnet", "opus", "haiku"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    capabilities: {
      web: true,
      projectRead: true,
      projectTransport: "mcp",
      connectors: true,
      executeModes: [],
      controlRepair: "tool-free",
    },
    run: runClaude,
  }],
  ["codex", {
    id: "codex",
    label: "Codex",
    command: "codex",
    commandEnv: "CODEBATE_CODEX_COMMAND",
    install: {
      command: installHint({
        win32: `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"`,
        default: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
      }),
      url: "https://github.com/openai/codex",
    },
    updateArgs: ["update"],
    updatePackage: "@openai/codex",
    defaultModel: "",
    models: [],
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
    capabilities: {
      web: false,
      projectRead: true,
      projectTransport: "sandbox",
      connectors: false,
      executeModes: ["run"],
      controlRepair: "unsupported",
    },
    discoverModels: discoverCodexModels,
    run: runCodex,
  }],
  // Cursor is REVIEW-ONLY (executeModes []) and experimental on Windows: its OS sandbox — required to
  // contain an executor — exists only on macOS/Linux (cursor-agent fails closed on --sandbox enabled on
  // Windows). It launches through a fingerprint-pinned trusted descriptor, not a bare command, so it uses
  // a descriptor-based readiness path (provider-readiness.js) instead of the `command` allowlist.
  ["cursor", {
    id: "cursor",
    label: "Cursor",
    experimental: true, // internal metadata (Windows reviewer has an open-network residual); not shown as a badge
    // Launches through the fingerprint-pinned trusted descriptor, not the editable `command` allowlist — so
    // its readiness comes from provider-readiness.js, and the client hides the command/Check/Setup controls
    // (a command-allowlist probe would report cursor-agent "not found" and contradict the Setup Doctor).
    descriptorLaunch: true,
    // Optional, review-only, and not always installed — offered but NOT auto-selected, so adding Cursor
    // never turns a Claude/Codex-only run into a provider_unavailable failure (assertProvidersReady) for
    // users who don't have it. New/upgraded users get it off by default; they opt in from the toggle.
    defaultEnabled: false,
    command: "cursor-agent",
    install: {
      command: installHint({
        win32: `powershell -ExecutionPolicy ByPass -c "irm https://cursor.com/install.ps1 | iex"`,
        default: "curl https://cursor.com/install -fsS | bash",
      }),
      url: "https://docs.cursor.com/en/cli/overview",
    },
    defaultModel: "",
    models: [],
    efforts: [],
    capabilities: { web: false, projectRead: true, projectTransport: "sandbox", connectors: false, executeModes: [] },
    discoverModels: discoverCursorModels,
    run: runCursor,
  }],
]);

export function provider(id) {
  return providers.get(String(id || "").toLowerCase()) || null;
}

export function providerIds() {
  return [...providers.keys()];
}

export function providerCatalog() {
  return [...providers.values()].map(({ run, discoverModels, commandEnv, updateArgs, updatePackage, experimental, ...definition }) => ({
    ...definition,
    dynamicModels: Boolean(discoverModels),
    canUpdate: Array.isArray(updateArgs) && updateArgs.length > 0 && Boolean(updatePackage),
  }));
}

export async function discoverProviderModels(id, options) {
  const definition = provider(id);
  if (!definition?.discoverModels) throw new Error("This provider does not expose model discovery");
  return definition.discoverModels(options);
}
