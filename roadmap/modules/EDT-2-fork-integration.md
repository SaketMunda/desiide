# EDT-2 · Built-in extension & default layout

**Status:** done · **Milestone:** Alpha (ADR-011) · **Size:** S · **Depends on:** EDT-1, UI-1 · **Skills:** ide-editor-shell

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
**Built (branch `mod/EDT-2-fork-integration`; fork `desiide` @ `9005646`):**
- **Bundling, without a source patch.** `scripts/build-editor.sh` packages `desiide-ai` (`pnpm --filter desiide-ai run package`) and stages it at `vscode/.build/desiide/desiide-ai.vsix`. `apply.sh` then adds it to `product.json` `builtInExtensions` with a local `vsix` path and its SHA-256 (upstream's build verifies it). It has no gallery metadata, so the app never looks it up on Open VSX. It's a standard built-in: the CLI refuses to uninstall it ("is a Built-in extension and cannot be uninstalled"), and it can be disabled.
- **`desiide-app`** (`editor/patches/desiide/extensions/desiide-app/`): a code-free built-in extension that ships only in the app. It binds **Cmd/Ctrl+L → `desiide.focus`**. Terminals keep Ctrl+L for the shell, because `desiide.focus` isn't in `commandsToSkipShell`.
- **`02-default-layout.patch`** (3 files, about 10 lines):
  1. The **built-in** `desiide-ai`'s container goes to the secondary side bar. The manifest still says `activitybar`, so stock VS Code is unchanged.
  2. `workbench.secondarySideBar.defaultVisibility` now defaults to `visible`.
  3. A window with no saved side-bar state opens the Desiide container. Upstream opened the hidden Copilot chat container, which showed as an empty panel.
- **Walkthrough `desiide.welcome`** ("Set up Desiide AI", in `desiide-ai`): a minimal 2-step stub (the panel, and themes). **UI-6 owns the content** and should keep the ID. `src/appWelcome.ts` (`isDesiideApp`, `shouldOpenWelcome`) opens it once per user (globalState `desiide.app.welcomeShown`), only when `vscode.env.appName === 'Desiide'`.
- **Public API:** `DesiideApi.welcomeOpened` (read-only, additive) lets tests observe the first-run behavior.
- **Tools:**
  - `pnpm -F desiide-ai test:app` runs the first-launch suite inside the built app with a new profile.
  - `scripts/check-editor-patches.sh <vscode-tag>` dry-runs our patches against another VS Code release without building.

**Evidence:**
1. **AC1:** `test:app` against the built app (fresh profile, no `--skip-welcome`, nothing clicked) → `builtIn: true`, `activatedWithoutInteraction: true`, `readyViews: [decisions, panel]`, `welcomeOpened: true`, `focusCommand: true`. A visual check with a fresh profile shows the Desiide panel and Decisions in the secondary side bar, the "Set up Desiide AI" walkthrough open, and the walkthrough's "Use keyboard shortcut ⌘ L" tip (resolved from the app-only keybinding).
2. **AC2:** `test:integration` in stock VS Code 1.139.0 with the same build → `appName: "Visual Studio Code"`, `welcomeOpened: false`, no tabs opened, not active at startup, activation 0.76 ms, both views ready, all commands registered. `manifest.test.ts` asserts that the manifest never contributes `secondarySidebar` (placement is app-only). `appWelcome.test.ts` covers app detection (VS Code, VSCodium, Cursor, and Code - OSS are all "not the app").
3. **AC3:** there's no VSCodium release newer than `1.135.06055` yet: its master still pins VS Code 1.135.0. The dry run therefore targets **VS Code 1.139.0**, the current stable that the next VSCodium minor will be based on. `scripts/check-editor-patches.sh 1.139.0` → both patches apply, and local-VSIX built-ins are still supported. It also fails correctly on too-old code: against 1.100.0, `02-default-layout.patch` doesn't apply, because that version predates the setting.
- `verify.sh` green (428 tests). App build: 4–5 min on the reuse path.

**Deviations:**
- **Bundling isn't a `02-bundle-desiide-ai.patch`.** Upstream already supports local-VSIX built-ins, so it's done in `apply.sh` plus the build script (the brief allowed "whichever is smaller"). The layout patch is therefore `02-`, not `03-`.
- **App defaults use a patch, not settings.** Extension `configurationDefaults` load after the layout is computed, so they can't make the side bar visible on first launch. The visibility default is in the layout patch, and `desiide-app` only carries the keybinding. No `desiide.*` settings exist yet to default.
- **The walkthrough stub is created here.** UI-6 is still `todo`, and AC1 needs the walkthrough to exist. Content and steps are UI-6's.
- **Cmd+L targets `desiide.focus`** (it focuses the panel). UI-2 should repoint it to its focus-prompt command.
- **`base-version` replaces `git describe`.** The fork carries no VSCodium tags (GitHub forks don't copy them), so EDT-1's `git describe` failed on a fresh submodule checkout. It had only worked on my original clone.

**Known gaps:**
- If `desiide-ai` is disabled, the app falls back to the stock theme, and the secondary side bar opens empty once. The user can close it, and it stays closed.
- The Cmd+L keypress itself wasn't automated, because the API can't read keybindings. The evidence is the walkthrough tip, which resolves the binding.
- `test:app` needs a display, like `test:integration`. REL-1 can run both under `xvfb-run` on Linux.
- Only macOS arm64 was built and tested.

**Follow-ups:**
- **UI-2:** repoint Cmd/Ctrl+L in `desiide-app` to the prompt-focus command.
- **UI-6:** fill in the `desiide.welcome` walkthrough (connect a model, first task), keeping the ID.
- **REL-1:** run `check-editor-patches.sh` in `upstream-sync.yml` before attempting the build. Run `test:app` against the release artifacts.
