# Desktop distribution

Electron Forge configuration lives in `forge.config.cjs`. `pnpm make` builds only the current platform. `.github/workflows/desktop-build.yml` builds each target on its native GitHub runner and attaches artifacts to a GitHub Release for tags matching `v*`.

## Local package commands

```bash
pnpm package
pnpm make
```

Artifacts are written under `out/`, which is ignored by Git. The Windows Squirrel lifecycle creates or removes the application shortcut during install, update, and uninstall.

For an offline/local Windows build, Forge reuses `.electron-cache/electron-v43.1.0-win32-x64.zip` when present. That cache, Corepack files, pnpm stores, tests, and repository-only tooling are excluded from the packaged ASAR. `server/windows-job-runner.ps1` is deliberately unpacked because PowerShell must read it from the real filesystem.

## Signing

Unsigned installers can trigger operating-system warnings. The Forge configuration reads signing credentials only from the build environment:

- Windows Squirrel: `WINDOWS_CERTIFICATE_FILE` and `WINDOWS_CERTIFICATE_PASSWORD`. Tagged CI releases derive the file from `WINDOWS_CERTIFICATE_BASE64`.
- macOS signing: `APPLE_TEAM_ID` with a signing identity installed in the build keychain.
- macOS notarization: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Tagged CI releases import `MAC_CERTIFICATE_BASE64` using `MAC_CERTIFICATE_PASSWORD` into a temporary keychain.

The repository does not contain signing files or passwords. Tagged release jobs fail when Windows or macOS signing secrets are absent, so the release job cannot publish unsigned native tag artifacts. Manual/local builds remain unsigned unless the same environment variables are supplied. Electron Forge's current signing requirements are documented upstream for [Windows](https://www.electronforge.io/guides/code-signing/code-signing-windows) and [macOS](https://www.electronforge.io/guides/code-signing/code-signing-macos).

## Desktop security settings

The renderer uses `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and `webSecurity: true`. All permission requests are denied. New windows are denied; HTTPS links are handed to the operating system browser. Navigation away from the app's loopback origin is blocked.

Gmail and Supabase connector credentials are encrypted with Electron `safeStorage` under the app-data directory. The Linux `basic_text` backend is not accepted as secure storage, so connector setup falls back to documented host environment variables when no Secret Service/KWallet backend is available.
