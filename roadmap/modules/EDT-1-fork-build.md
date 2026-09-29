# EDT-1 · VSCodium fork & branding

**Status:** done · **Milestone:** Alpha (ADR-011) · **Size:** M · **Depends on:** FND-1 · **Skills:** ide-editor-shell

## Purpose
A reproducible local build of the Mutt desktop app from our VSCodium fork, with our branding and no Mutt logic in the patches.

## Scope
- Fork `VSCodium/vscodium` → `SaketMunda/mutt-vscodium` (the user creates the fork, or it's done via `gh`). Add it as the `editor/` submodule of `mutt`, pinned to a VSCodium release tag.
- `editor/patches/mutt/` applied after VSCodium's patches, each with a header (purpose, files touched):
  - `01-branding.patch`: `product.json` `nameShort/nameLong` "Mutt", `applicationName` `mutt`, `dataFolderName` `.mutt-ide`, `urlProtocol` `mutt`, bundle IDs, placeholder icons (open decision #3).
  - Keep the Open VSX gallery (VSCodium default). Confirm no MS endpoints.
- `scripts/build-editor.sh`: wraps VSCodium's build with the right env vars and `nvm use` to its pinned Node.
- Document exact build commands, duration, and disk usage in the `ide-editor-shell` skill ("Building" section).

## Acceptance criteria
1. A clean build on macOS arm64 produces `Mutt.app` that launches, shows "Mutt" branding, and uses `~/.mutt-ide` for data (doesn't touch VS Code's or VSCodium's).
2. Installing an extension from Open VSX works.
3. `scripts/build-editor.sh` is idempotent (re-run doesn't re-clone unnecessarily).
4. The skill is updated with real numbers.

## Handoff notes
**Built (branch `mod/EDT-1-fork-build`; fork branch `mutt` in `editor/`):**
- **Submodule:** `editor/` → `https://github.com/SaketMunda/mutt-vscodium.git`, branch `mutt`, on VSCodium tag `1.135.06055` (upstream VS Code `1.135.0` @ `08d4889f`). Remotes: `origin` = our fork, `upstream` = `VSCodium/vscodium`.
- **Hook:** the only edit to a VSCodium script is a 4-line block at the end of `prepare_vscode.sh`'s patch section that sources `patches/mutt/apply.sh`.
- **`editor/patches/mutt/`** (see its README):
  - `product.json`: branding overlay merged last. `nameShort/nameLong` "Mutt", `applicationName` `mutt`, `dataFolderName` `.mutt-ide`, `serverDataFolderName` `.mutt-ide-server`, `urlProtocol` `mutt`, `darwinBundleIdentifier` `io.github.saketmunda.mutt`, fresh Windows GUIDs/CLSIDs, and issue/docs/release links to `SaketMunda/mutt`.
  - `resources/` + `src/` file overlays: app icons (`.icns`, Linux, server/web, favicon), the editor watermark, and the workbench product icon (`code-icon.svg`, e.g. the Welcome tab). All generated from `icons/mutt-icon.svg` by `icons/generate.sh`, which uses only macOS tools.
  - `01-default-theme.patch`: the `workbench.colorTheme` / `preferredDark` / `preferredLight` defaults become Mutt Dark / Mutt Light (8 lines in `themeConfiguration.ts`). Upstream's fallback (`ThemeSettingDefaults`) is untouched, so without `mutt-ai` the app falls back to the stock themes.
- **Build:** `scripts/build-editor.sh [--clean]`. It sets the branding env (`APP_NAME=Mutt`, `BINARY_NAME=mutt`, `ORG_NAME=Mutt`, `GH_REPO_PATH`/`ASSETS_REPOSITORY=SaketMunda/mutt`). It turns off CLI, REH, and updates (`DISABLE_UPDATE=yes`). It pins Node, `RELEASE_VERSION`, and `BUILD_SOURCEVERSION`, and uses a private npm cache.
- **Brand palette ("Mixed breed", chosen by the user on 2026-09-29):** teal `#2BB3A3` primary, amber `#F2A33A` for Jev decisions and risk, on slate `#15191E`. It ships as **Mutt Dark / Mutt Light** themes contributed by `mutt-ai` (`extensions/mutt-ai/themes/`). Alpha users can opt in, and the app defaults to them. UI kit accents: `--mutt-accent` (teal, was `--mutt-accent-ai` violet) and `--mutt-accent-jev` (amber, was teal). Warnings use a separate yellow (`#E5C454` / `#806300`) so they never read as Jev. The extension also got its Marketplace icon (`media/icon.png`).
- **Skill:** `ide-editor-shell` → "Structure" and "Building" updated with the hook and the real numbers.

**Evidence:**
1. AC1: `scripts/build-editor.sh` on macOS arm64 (M4 Pro) produced `editor/VSCode-darwin-arm64/Mutt.app` in 6.6 min. `Info.plist`: `CFBundleName` Mutt, `CFBundleIdentifier` `io.github.saketmunda.mutt`, icon `Mutt.icns`, version `1.135.06055`. Launched: the window shows the Mutt Dark theme, dog icon, and watermark. Data goes to `~/Library/Application Support/Mutt` and `~/.mutt-ide`. The modification times of `~/.vscode` and `~/Library/Application Support/Code` didn't change, and there's no VSCodium data folder on this machine.
2. AC2: `bin/mutt --install-extension EditorConfig.EditorConfig` installed v0.18.2 from Open VSX (`extensionsGallery` = open-vsx.org) into `~/.mutt-ide/extensions`. The extension host log shows it loading in the app.
3. AC3: a second run printed `Reusing editor/vscode at 08d4889f…`, with no clone. The tree is reset to undo the previous run's patches, so repeated runs don't stack patches.
4. AC4: the skill's "Building" section has the measured time, RAM, and disk numbers.
- **Endpoint audit** (built `product.json`): no automatic Microsoft requests. `updateUrl` is `null`, and the gallery is Open VSX. What remains:
  - user-clicked help links (`go.microsoft.com` keyboard-shortcut, tips, and video pages, and the upstream license);
  - build-time GitHub downloads of the built-in js-debug extensions;
  - the web-only `vscode-cdn.net` webview origin (desktop serves webviews locally).
- Tests: `themes.test.ts` (WCAG AA for text/background pairs and syntax colors, and dark/light key parity), `verify.sh` green.

**Deviations:**
- **Branding is a `product.json` overlay, not `01-branding.patch`.** A diff of `product.json` would break on every upstream `product.json` change, while an overlay merge doesn't. This uses the same mechanism VSCodium uses for its own `product.json`. `01-` is the default-theme patch instead.
- **`dev/build.sh` isn't wrapped.** It hard-codes VSCodium's branding env vars, so `build-editor.sh` follows its steps directly.
- **No Rust CLI build** (`SHOULD_BUILD_CLI=no`). The CLI is only needed for tunnels, and it would add a Rust toolchain dependency.
- **The default theme belongs to EDT-1, not EDT-2.** The user asked for a distinct identity. EDT-2 still owns the other app defaults and bundling `mutt-ai`.
- **The bundle ID** `io.github.saketmunda.mutt` is a placeholder on a domain the user controls, until open decision #3/#4.

**Known gaps:**
- Until EDT-2 bundles `mutt-ai`, a fresh app has no Mutt themes and falls back to the stock Dark 2026 theme. For the evidence screenshot, I installed the `mutt-ai` `.vsix` into the app by hand.
- Some strings still say VSCodium: copyright/company in `Info.plist` ("VSCodium" replaces "Microsoft Corporation", which is set by VSCodium's script after our hook), and the web/server manifest `name`. None of these are visible in normal use. A follow-up could move them into the overlay.
- The fork isn't pushed: `SaketMunda/mutt-vscodium` has to be created on GitHub first. Then run `git -C editor push -u origin mutt`. Until that's done, the submodule commit exists only on this machine.
- Only macOS arm64 was built. The Linux path in the script is untested (REL-1 will run it in CI).

**Follow-ups:**
- EDT-2: bundle `mutt-ai` (which brings the themes); secondary-sidebar layout.
- REL-1: Linux + macOS x64 builds of `scripts/build-editor.sh` in CI; weekly upstream-sync PR.
- Planning: record the palette as the resolution of the color half of open decision #3 (name and final icon still open).
