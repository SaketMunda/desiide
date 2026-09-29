# UI-1 · Extension shell & UI kit

**Status:** in-progress · **Milestone:** Alpha · **Size:** M · **Depends on:** FND-1 · **Skills:** ide-editor-shell

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
_(filled by the build session)_
