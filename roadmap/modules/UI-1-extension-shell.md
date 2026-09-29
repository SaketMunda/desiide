# UI-1 · Extension shell & UI kit

**Status:** review · **Milestone:** Alpha · **Size:** M · **Depends on:** FND-1 · **Skills:** ide-editor-shell

## Purpose
The `mutt-ai` extension skeleton and the shared webview UI kit that every UI module builds on. It must work in stock VS Code, VSCodium, and our fork (ADR-008).

## Scope
- `extensions/mutt-ai/package.json`: publisher placeholder, `engines.vscode`, lazy activation (`onView:`, `onCommand:`), `mutt` activity-bar container with two webview views: **Mutt** (AI panel) and **Decisions**.
- Extension bundle via esbuild. The orchestrator bundle from COR-1 is copied into `dist/`.
- Webview app: Preact + Vite, one bundle with two entry views. Strict CSP with nonce, no remote resources.
- **Typed message bridge** webview ↔ extension: zod-validated messages. Extension-side router, webview-side `useBridge()` hook. State restore via `vscode.getState/setState`.
- **UI kit** (`webview/ui/`): `Card`, `Button`, `IconButton`, `Badge`, `Chip`, `ProbabilityBar`, `ScoreDots (0–4)`, `Spinner`, `EmptyState`, `Collapsible`, `CodeBlock`, and codicons (bundled locally).
- **Design tokens** (`tokens.css`): built on `--vscode-*` theme variables, plus
  `--mutt-accent-ai` (violet), `--mutt-accent-jev` (teal), and `--mutt-outcome-auto|confirm|block` (derived from theme green/yellow/red: `--vscode-testing-iconPassed`, `--vscode-editorWarning-foreground`, `--vscode-errorForeground`), radius 8 px, elevation via `--vscode-widget-shadow`. Motion tokens: 150/250 ms, disabled under `prefers-reduced-motion`.
- Status bar item: active workflow/model + running task count (click → focus the Mutt view).
- Command registration pattern (`mutt.*`) and an output channel `Mutt`.
- `vsce package` dry-run works (REL-1 publishes).

## Acceptance criteria
1. F5 in stock VS Code shows the Mutt container with both views rendering a kit showcase (dev-only command `mutt.dev.showcase`).
2. Views render correctly in Dark+, Light+, and High Contrast (screenshots attached to the PR).
3. Activation < 150 ms, and no activation on startup unless a Mutt view is visible.
4. A malformed bridge message is rejected and logged, not thrown.
5. `vsce package` produces a `.vsix` < 5 MB (excluding the orchestrator bundle).

## Handoff notes
**Built (branch `mod/UI-1-extension-shell`):**
- **Manifest** (`extensions/mutt-ai/package.json`): publisher placeholder `mutt-dev` (open decision #4), `engines.vscode ^1.100.0` (so lagging forks like Cursor/VSCodium work), activation only on `onView:mutt.*` / `onCommand:mutt.*`, the `mutt` activity-bar container with webview views `mutt.panel` (Mutt) and `mutt.decisions` (Decisions).
- **Host** (`src/`): `extension.ts` (activate → output channel `Mutt` (LogOutputChannel), view providers, status bar, commands, returns `MuttApi {activationMs, readyViews, setStatus}`), `views/MuttViewProvider.ts`, `views/html.ts` (CSP + HTML builder), `bridge/router.ts` (`createMessageRouter(source, log)`: `.on(type, handler)`, `.handle(raw)` never throws), `status.ts` (`formatStatus`), `commands.ts` (`COMMAND_IDS`).
- **Bridge contract** (`shared/messages.ts`): `WebviewToExtension` (strict: `ready`, `command` with allow-listed `WebviewCommand`, `log`) and `ExtensionToWebview` (tolerant: `init`, `showcase`). **UI modules add their message types here.**
- **Webview** (`webview/`): one Vite/Preact bundle, and the view is chosen by `#root[data-view]`. `bridge.ts` (`post`, `receive`, `useBridge(listener)`, `usePersistentState(key, initial, isValid)` over `vscode.getState/setState`), `views/App.tsx`, `views/Showcase.tsx`.
- **UI kit** (`webview/ui/`, import from `webview/ui/index.ts`): `Button`, `IconButton` (requires `label`), `Badge`, `Chip`, `Card`, `ProbabilityBar`, `ScoreDots`, `Spinner`, `EmptyState`, `Collapsible` (controlled or uncontrolled), `CodeBlock` (copy, no highlighting yet), `Codicon`. Shared `Tone = neutral|ai|jev|auto|confirm|block`. Tokens in `tokens.css`, styles in `kit.css`.
- **Build:** `pnpm -F mutt-ai build` (esbuild host bundle, always minified, + Vite webview + codicons copied to `dist/codicons`; `dist/orchestrator.js` is copied when COR-1's bundle exists). `package` → `mutt-ai.vsix`. F5 config in `.vscode/launch.json`.
- **Dev tooling:** `pnpm -F mutt-ai test:integration` runs `test/integration/suite.cjs` in real VS Code (the local install, or a download into `.vscode-test/`). `pnpm -F mutt-ai screenshots` renders the views under Dark+/Light+/HC into `.screenshots/`.

**Evidence:**
1. AC1: `test:integration` on VS Code 1.139.0 opens the Mutt container, and **both** webviews load under the CSP and complete the `ready` → `init` handshake (`readyViews: [decisions, panel]`). `mutt.dev.showcase` runs. *Manual check still needed: press F5 and look at it.*
2. AC2: `scripts/screenshots.mjs` renders both views under Dark+, Light+, and High Contrast, using colors from VS Code's built-in theme files plus the color-registry defaults. These approximate VS Code's webview theming. The screenshots are for the PR, and a real-VS-Code visual pass is still recommended.
3. AC3: integration shows `activeAfterStartup: false`, `activationMs` ≈ 0.8 ms (the `activate()` body), and **90 ms from opening the container to active** (upper bound, including bundle load). `manifest.test.ts` also asserts activation events are only `onView:mutt.*`/`onCommand:mutt.*`.
4. AC4: `router.test.ts` covers 8 malformed shapes, all rejected and `warn`-logged, never thrown, with the payload never echoed. Handler errors are logged too. `bridge.test.ts` covers the webview side (malformed messages are dropped and reported to the extension log).
5. AC5: `vsce package` → **141 KB** `.vsix` (10 files).

**Deviations:**
- **zod imports:** switched repo-wide (including `@mutt/protocol`) from `import { z } from 'zod'` to `import * as z from 'zod'`, with a `no-restricted-syntax` lint rule to keep it. The named `z` defeated tree-shaking and pulled ~450 KB (all locales) into the host bundle. With the change the bundle is 93 KB. This doesn't change the contract.
- **No `@preact/preset-vite`:** it needs Babel 7. Vite 8's built-in oxc JSX transform (`importSource: 'preact'`) does the same with fewer dependencies.
- **`pnpm-workspace.yaml` `allowBuilds`:** `esbuild: true`, `@vscode/vsce-sign: false`. pnpm 12 fails install on unapproved build scripts, and signing is REL-1's concern.
- **`vsce package --skip-license`:** the license is still open decision #2.
- **The status bar item appears once the extension activates,** not at startup. That's a consequence of lazy activation.

**Known gaps:**
- There's no real-VS-Code screenshot automation, because macOS screen capture needs a permission grant.
- `CodeBlock` has no syntax highlighting yet (UI-3 adds `highlight.js`).
- `test:integration` isn't in `verify.sh` or CI, because it needs a GUI or xvfb. REL-1 can add it with `xvfb-run` on Linux.

**Follow-ups:**
- REL-1: run `test:integration` under xvfb in CI, publish the `.vsix`, and set the real publisher ID.
- UI-2+: add message types to `shared/messages.ts` and use `usePersistentState` for draft/scroll state.
