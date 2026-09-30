# EDT-2 · Built-in extension & default layout

**Status:** todo · **Milestone:** Alpha (ADR-011) · **Size:** S · **Depends on:** EDT-1, UI-1 · **Skills:** ide-editor-shell

## Purpose
Make the IDE feel AI-native out of the box: `desiide-ai` built in, and the panels placed where users expect them on first run.

## Scope
- The build step copies the packaged `desiide-ai` into the app's built-in `extensions/` (`02-bundle-desiide-ai.patch` or a build-script hook, whichever is smaller).
- Built-in extension can't be uninstalled (standard built-in behavior), but it *can* be disabled.
- `03-default-layout.patch`: the Desiide container goes in the **secondary sidebar**, visible on first run. The welcome page opens the Desiide walkthrough (UI-6).
- Default settings for the app build (e.g. `desiide.*` defaults, `workbench.secondarySideBar.visible`).
- Claim the `Cmd/Ctrl+L` focus-prompt keybinding **only in the app build** (via default keybinding override).
- The extension detects the app via `vscode.env.appName` for app-only behaviors. There must be no hard dependency on it.

## Acceptance criteria
1. First launch of a fresh profile: the Desiide panel is visible in the secondary sidebar and the walkthrough opens.
2. The same `desiide-ai` build behaves identically when installed from its `.vsix` in stock VS Code (except app-only defaults), so the Beta standalone channel needs no extra work.
3. The patch set still applies cleanly after bumping to the next VSCodium minor (dry-run documented).

## Handoff notes
_(filled by the build session)_
