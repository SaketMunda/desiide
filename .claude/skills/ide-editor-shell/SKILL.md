---
name: ide-editor-shell
description: Working on the VSCodium fork (editor/) or the built-in desiide-ai extension (extensions/desiide-ai/) — branding, patches, building the app, adding panels/commands/menus, upstream syncs, extension compatibility. Load before touching either directory.
---

# Editor shell (VSCodium fork + desiide-ai extension)

## Structure
- `editor/` is a submodule of our fork of `VSCodium/vscodium`, pinned to a release tag. VSCodium's scripts clone upstream `microsoft/vscode` at a pinned commit, then apply `patches/*.patch`. Our changes go in `editor/patches/desiide/` and are applied after VSCodium's own patches: `prepare_vscode.sh` sources `patches/desiide/apply.sh` (our only edit to a VSCodium script), which merges the `product.json` overlay, copies the `resources/` and `src/` file overlays (icons, watermark), then applies `*.patch`. Prefer overlays to diffs; see `editor/patches/desiide/README.md`.
- The fork lives on branch `desiide` of `SaketMunda/desiide-vscodium` (remote `origin`); `upstream` is `VSCodium/vscodium`.
- `extensions/desiide-ai/` is copied into the build as a **built-in extension**. It owns every piece of AI/Jev UI.

## Decision rule: extension vs. patch
Default to the extension. Patch the workbench **only** when the extension API cannot do it:
| Need | Where |
|---|---|
| Panels, views, webviews, commands, menus, keybindings, status bar, settings | `desiide-ai` `package.json` contributions |
| Product name, icons, data folder, default settings, Open VSX gallery | `product.json` patch |
| Default placement of the Desiide container in the secondary sidebar on first run | small workbench patch |
| Anything else | Write down why the extension API can't do it in the patch header before adding it |

Each patch does one thing, has a header comment (purpose, upstream files touched), and is named `NN-short-name.patch`.

## Adding UI
- Views: `contributes.viewsContainers` (`desiide` container) + `contributes.views` with `type: "webview"`. Register the view with `registerWebviewViewProvider`.
- Webviews: Preact + Vite bundle, strict CSP (`default-src 'none'`, nonce'd scripts), and colors via `var(--vscode-*)` plus Desiide accent tokens. Respect `prefers-reduced-motion`.
- Commands are prefixed `desiide.`. Settings are namespaced `desiide.*`.
- The extension talks to the orchestrator only through `packages/protocol` RPC types. Never import orchestrator internals.

## Extension compatibility
- Don't change the `vscode` API surface or `enabledApiProposals` for third-party extensions.
- The gallery is Open VSX (VSCodium default). The Microsoft Marketplace is not allowed for forks. Proprietary MS extensions (Pylance, C# Dev Kit, Remote-SSH) won't work, so point users to the OSS alternatives (basedpyright, Open Remote SSH).

## Building
- One command: `scripts/build-editor.sh` (add `--clean` to re-fetch upstream). Output: `editor/VSCode-darwin-arm64/Desiide.app` (or `VSCode-linux-<arch>/`). Don't use VSCodium's `dev/build.sh`: it hard-codes the VSCodium branding variables.
- Prerequisites: `git`, `jq`, `python3`, `curl`, Xcode Command Line Tools. **No Rust needed**: the script sets `SHOULD_BUILD_CLI=no` (the CLI is only for tunnels). The script uses VSCodium's pinned Node (`editor/.nvmrc`); if `node -v` differs, it downloads and checksum-verifies that version into `~/.cache/desiide/`.
- The script pins `RELEASE_VERSION` to the submodule tag and computes `BUILD_SOURCEVERSION` itself (VSCodium's defaults are time-based, or `npm install -g` a tool). It uses a private npm cache in `~/.cache/desiide/npm`, so a broken `~/.npm` (e.g. root-owned files) doesn't matter. It sets `DISABLE_UPDATE=yes`: the app never polls VSCodium's update feed.
- Measured (EDT-1, 2026-09-29, Apple M4 Pro, 12 cores, 24 GB, VSCodium `1.135.06055`): upstream fetch 41 s; build 6.6 min; peak RAM 7.5 GB. Disk: `editor/vscode` 6.1 GB, `Desiide.app` 1.0 GB, caches ~1.2 GB (npm 0.6, node-gyp 0.25, Node 0.2, Electron 0.13). Keep **~15 GB free** for headroom.
- Re-runs are idempotent: if `editor/vscode` is already at the pinned commit, the script resets it (undoing the previous run's patches) instead of re-cloning, then re-runs `npm ci` + compile (~6–7 min).
- Launching from a terminal inside VS Code: unset `ELECTRON_RUN_AS_NODE` first (`env -u ELECTRON_RUN_AS_NODE .../Desiide.app/Contents/MacOS/Desiide`), or Electron starts as plain Node ("bad option").
- Data locations: user data `~/Library/Application Support/Desiide`, extensions `~/.desiide/extensions`. Neither collides with VS Code or VSCodium.
- Dev loop: develop `desiide-ai` in **stock VS Code** (F5 Extension Development Host). Only build the fork to test patches or packaging.

## Upstream sync
- Bump the VSCodium tag → re-run the build → fix patches that fail to apply. Patches that touch `src/vs/workbench/**` break most often, which is one more reason to keep them tiny.
- Never hand-edit files inside the cloned `vscode/` tree. Regenerate the patch instead (`git diff > patches/desiide/NN-x.patch`).

## Gotchas
- Electron: keep extension activation lazy (`onView:`/`onCommand:`). Never block the extension host. Heavy work belongs in the orchestrator child process.
- Telemetry: VSCodium removes MS telemetry. Don't add any, including in webviews (no remote fonts/CDNs).
- `product.json` `dataFolderName` must differ from VS Code/VSCodium so user settings don't collide.
