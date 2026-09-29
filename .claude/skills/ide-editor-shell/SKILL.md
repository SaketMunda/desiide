---
name: ide-editor-shell
description: Working on the VSCodium fork (editor/) or the built-in mutt-ai extension (extensions/mutt-ai/) — branding, patches, building the app, adding panels/commands/menus, upstream syncs, extension compatibility. Load before touching either directory.
---

# Editor shell (VSCodium fork + mutt-ai extension)

## Structure
- `editor/` is a submodule of our fork of `VSCodium/vscodium`, pinned to a release tag. VSCodium's scripts clone upstream `microsoft/vscode` at a pinned commit, then apply `patches/*.patch`. Our changes go in `editor/patches/mutt/` and are applied after VSCodium's own patches.
- `extensions/mutt-ai/` is copied into the build as a **built-in extension**. It owns every piece of AI/Jev UI.

## Decision rule: extension vs. patch
Default to the extension. Patch the workbench **only** when the extension API cannot do it:
| Need | Where |
|---|---|
| Panels, views, webviews, commands, menus, keybindings, status bar, settings | `mutt-ai` `package.json` contributions |
| Product name, icons, data folder, default settings, Open VSX gallery | `product.json` patch |
| Default placement of the Mutt container in the secondary sidebar on first run | small workbench patch |
| Anything else | Write down why the extension API can't do it in the patch header before adding it |

Each patch does one thing, has a header comment (purpose, upstream files touched), and is named `NN-short-name.patch`.

## Adding UI
- Views: `contributes.viewsContainers` (`mutt` container) + `contributes.views` with `type: "webview"`. Register the view with `registerWebviewViewProvider`.
- Webviews: Preact + Vite bundle, strict CSP (`default-src 'none'`, nonce'd scripts), and colors via `var(--vscode-*)` plus Mutt accent tokens. Respect `prefers-reduced-motion`.
- Commands are prefixed `mutt.`. Settings are namespaced `mutt.*`.
- The extension talks to the orchestrator only through `packages/protocol` RPC types. Never import orchestrator internals.

## Extension compatibility
- Don't change the `vscode` API surface or `enabledApiProposals` for third-party extensions.
- The gallery is Open VSX (VSCodium default). The Microsoft Marketplace is not allowed for forks. Proprietary MS extensions (Pylance, C# Dev Kit, Remote-SSH) won't work, so point users to the OSS alternatives (basedpyright, Open Remote SSH).

## Building
- Use the Node version from VSCodium's pinned `.nvmrc` (`nvm use`), not the repo root's Node 24.
- The first build takes ~30–60 min and ~15 GB. Run it in the background. Record the exact commands that worked here once 0.6 is done.
- Dev loop: develop `mutt-ai` in **stock VS Code** (F5 Extension Development Host). Only build the fork to test patches or packaging.

## Upstream sync
- Bump the VSCodium tag → re-run the build → fix patches that fail to apply. Patches that touch `src/vs/workbench/**` break most often, which is one more reason to keep them tiny.
- Never hand-edit files inside the cloned `vscode/` tree. Regenerate the patch instead (`git diff > patches/mutt/NN-x.patch`).

## Gotchas
- Electron: keep extension activation lazy (`onView:`/`onCommand:`). Never block the extension host. Heavy work belongs in the orchestrator child process.
- Telemetry: VSCodium removes MS telemetry. Don't add any, including in webviews (no remote fonts/CDNs).
- `product.json` `dataFolderName` must differ from VS Code/VSCodium so user settings don't collide.
