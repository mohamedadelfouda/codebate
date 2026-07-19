const fs = require("node:fs");
const path = require("node:path");

const localElectronZipDir = path.join(__dirname, ".electron-cache");

module.exports = {
  packagerConfig: {
    asar: { unpack: "**/windows-job-runner.ps1" },
    executableName: "Codebate",
    appBundleId: "com.mohamedadel.codebate",
    appCategoryType: "public.app-category.developer-tools",
    ...(fs.existsSync(localElectronZipDir) ? { electronZipDir: localElectronZipDir } : {}),
    ...(process.env.APPLE_TEAM_ID ? { osxSign: {} } : {}),
    ...(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID ? {
      osxNotarize: {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID,
      },
    } : {}),
    ignore: [
      /^\/(?:\.git|\.github|\.githooks|\.review-gate|\.agents|\.claude|\.codex)(?:\/|$)/,
      /^\/(?:\.corepack|\.electron-cache|\.pnpm-store|\.codex-manual-cache|data|docs|logs|node_modules|out|scripts|test|workspace)(?:\/|$)/,
      /^\/(?:\.gitattributes|\.gitignore|\.npmrc|forge\.config\.cjs|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/,
      /^\/(?:AGENTS\.md|CHANGELOG\.md|CLAUDE\.md|CODE_OF_CONDUCT\.md|CONTRIBUTING\.md|DESIGN\.md|EXECUTION\.md|PRODUCT\.md|README\.md|SECURITY\.md)$/,
      /^\/(?:start-linux\.sh|start-macos\.command|start-windows\.bat)$/,
    ],
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "Codebate",
        authors: "Mohamed Adel Fouda",
        description: "A local multi-agent decision and execution room",
        ...(process.env.WINDOWS_CERTIFICATE_FILE ? {
          certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
          certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
        } : {}),
      },
    },
    // macOS ships a .zip (pure JS, no native toolchain). maker-dmg pulls the native
    // appdmg/volume.node addon, which pnpm does not build by default; add it back once
    // that build is wired up if a .dmg is wanted.
    { name: "@electron-forge/maker-zip", platforms: ["darwin"] },
    // bin must match packagerConfig.executableName ("Codebate"); otherwise the deb/rpm
    // makers look for a binary named after the package ("codebate") and fail.
    { name: "@electron-forge/maker-deb", platforms: ["linux"], config: { options: { bin: "Codebate" } } },
    { name: "@electron-forge/maker-rpm", platforms: ["linux"], config: { options: { bin: "Codebate" } } },
  ],
};
