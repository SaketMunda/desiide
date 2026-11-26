# UI-6 · Settings & onboarding

**Status:** review · **Milestone:** Alpha · **Size:** M · **Depends on:** UI-1, MOD-1, JEV-1 · **Skills:** ide-editor-shell, ide-model-adapters, ide-jev-decisions

## Purpose
Get a new user from install to first task in **under 2 minutes**, and give pros full control over models, roles, Jev, and gating.

## Scope
**Onboarding (VS Code walkthrough contribution + the panel's first-run state)**
1. Detect a local Ollama (`models.list {discover:true}`). If found, offer one-click "Use `<model>` as cheap".
2. Otherwise, or additionally, add a cloud provider: Anthropic / OpenAI-compatible (base URL presets: OpenAI, OpenRouter, Gemini-compat), then paste a key → SecretStorage → **Test**.
3. Assign roles (auto-suggested: local → cheap, cloud → strong).
4. Optional: enable Jev (explains exactly what is sent, with a sample payload).
5. "Try it" button → prefills the Prompt Box with a sample task.

**Settings page (webview)**
- **Models**: list with health, add/edit/remove, test, capability overrides, and the `secret:` key status (set / missing, never displayed).
- **Roles**: cheap / strong / reviewer dropdowns.
- **Jev**: off by default. Endpoint, key, `redactPaths`, **Preview payload** (live sample state built by JEV-1 from the current workspace), and Test connection.
- **Gating**: Conservative (default) / Strict. Sensitive-glob editor (writes `.desiide/project.json`). The deny-list is shown read-only.
- **Project**: test and lint commands (auto-detected, editable).
- **Path-redaction salt:** generate a random salt (≥32 bytes, `crypto.randomBytes`) per workspace on first use, keep it in `workspaceState`, and pass it to the orchestrator when `desiide.jev.redactPaths` is on. Never derive it from the workspace path, because that could be guessed (JEV-1 handoff, user decision 2026-10-05).
- **Model locality:** show each model as Local / Cloud (`ModelInfo.locality`), and let the user override it per model (`ModelConfig.locality`, ADR-017).
- Settings persist as VS Code settings (`desiide.*`). Secrets go only to SecretStorage. Changes push `config.update` to the orchestrator.

## Acceptance criteria
1. A fresh profile with Ollama running reaches a successful first task in under 2 min (timed manual QA script).
2. Keys are never written to settings.json, logs, or webview state (test with a sentinel key).
3. An invalid key → Test shows the error kind and hint.
4. Loosening gating isn't possible from the UI or by hand-editing settings (JEV-2 validation surfaces a warning).
5. The Jev payload preview contains no file contents.

## Handoff notes
**Built (branch `mod/UI-6-settings-onboarding`):**
- **Protocol (additive):** `JevConfig.redactSalt` (32–512 chars). The extension sends a random per-workspace salt (`crypto.randomBytes(32)`, hex, in `workspaceState`) only while `redactPaths` is on.
- **Jev (additive export):** `DENY_RULES` (`{id, text}[]`, frozen), so the deny-list can be shown read-only.
- **Orchestrator:**
  - `src/jev/handlers.ts` registers `jev.preview` and `jev.test`.
    - The preview builds each pack with JEV-1's builders from up to 5 real workspace files (the rg walk, spread evenly, then COR-4 `describeFiles`), using the same redaction and caps as real decisions.
    - `jev.test` never calls the endpoint (JEV-3 is blocked). It reports `not_configured` or `unavailable` honestly.
  - `workspacePolicy` builds the path redactor from the salt and passes it to the gate. With `redactPaths` on and no salt, it sends a `log` warning and leaves paths unredacted; it never falls back to a guessable salt.
  - It also exposes `redactor()`, `jevSettings()`, `loadProject()` and `git()`.
- **Extension host (`src/settings/`):**
  - `config.ts`: `readDesiideConfig` reads `desiide.*` value by value into a valid `DesiideConfig` and reports problems. Gating warnings come from an unknown mode (falls back to conservative) and from looser, unknown or malformed thresholds, via JEV-2's `resolveThresholds`. It also has `suggestRoles` (local → cheap, cloud → strong + reviewer; only fills unset roles), `rolesWithout`, `inferLocality` and `uniqueModelId`.
  - `service.ts`: `SettingsService` (no `vscode`) handles every page message: discovery, one-click Ollama, save/edit/remove models (renames move their roles), keys, `models.test`, roles, Jev settings/preview/test, gating mode and the project file.
  - `project.ts`: `.desiide/project.json` read/merge (unknown keys kept, validated before writing). Test/lint auto-detection covers package.json scripts with the lockfile's runner, Cargo, Go, pyproject (ruff) and Makefile.
  - `salt.ts`, `controller.ts` (the **Settings editor tab** `desiide.settings`, settings writes, SecretStorage, file IO, a debounced push on settings or secret changes), and `tryIt.ts`.
  - `OrchestratorClient.onSessionStart`: runs after `initialize` and before `ready` on **every** (re)start. The extension sends `config.update` there, so no request ever reaches an orchestrator without settings. Settings changes push only to a running orchestrator and never spawn one (activation stays lazy).
- **Webview (`webview/settings/`):** Get started (5 steps), Models, Roles, Jev, Gating, Project. `PageId` (`panel | decisions | settings`) widens the bridge's view id.
- **Manifest:**
  - Settings schema for `desiide.models`, `roles`, `jev.*` and `gating.*`. `apiKey` has a `secret:` pattern, and threshold min/max flag looser values in the settings editor too.
  - Commands `desiide.openSettings` (optional section arg) and `desiide.tryIt`, plus a gear on the panel title.
  - The walkthrough gains Connect (completes on the `desiide.hasModels` context), Roles, Jev and Try it, ahead of Panel and Theme.

**Public API:** `DesiideApi.settings` → `open(section?)`, `service` (`config()`, `push()`, `state()`). Commands: `desiide.openSettings`, `desiide.tryIt`, and `desiide.setup` (now opens Settings → Get started).

**Evidence**
1. **AC1 (< 2 min to a first task with Ollama):**
   - `src/settings/onboarding.live.test.ts` (`DESIIDE_LIVE=1`) starts from a fresh profile with no settings and runs the real bundled orchestrator against a real Ollama: discover → Use as cheap → Test → Try it task `done`.
   - Measured 2026-11-26 with `qwen2.5:7b`: discovered at 0.1 s, test OK at 3.9 s, **task done at 9.2 s**. It also passes with `qwen3.5:2b`.
   - The Chromium run drives the same UI path by keyboard only (`localOneClick`).
   - **Manual QA script** (to time in the built app):
     1. Fresh `--user-data-dir`, Ollama running, open a folder.
     2. Click "Set up a model" in the panel. Settings → Get started opens and finds Ollama by itself.
     3. Click "Use as cheap" and see "Connected · N ms".
     4. Click "Try a sample task", then press Enter in the Prompt Box.
     5. The answer streams in.

     Expected: about 30 s of clicks plus model time. **Not yet run by hand in the packaged app**; see Known gaps.
2. **AC2 (keys never in settings.json, logs or webview state, sentinel):**
   - `settings.process.test.ts` uses the bundled orchestrator and a local 127.0.0.1 server that returns 401 and echoes the `Authorization` header. The sentinel is used (it reaches the server through `secrets.get`), and it appears in none of: settings writes, posts to the webview, the extension log, or the orchestrator's log files.
   - `service.test.ts` › "AC2…" covers the same across model keys, the Jev key, the Jev settings and the page state. Only `set`/`missing` and `secret:` refs come back.
   - `config.test.ts` › "rejects a raw API key in settings".
   - Chromium (`cloudKey_dark/light`): the key goes only into `settings.saveModel.key` (never into the config). The field is cleared after saving, and the key is never in `vscode.setState`, input values or the DOM.
3. **AC3 (invalid key → Test shows error kind and hint):**
   - `settings.process.test.ts` gives `kind: auth` with a non-empty hint from the real adapter.
   - `service.test.ts` › "AC3".
   - Chromium checks that the `auth` badge, the message and the hint are all rendered (screenshot `settings-start-cloud-error-*`).
4. **AC4 (loosening impossible from the UI or by hand-editing):**
   - The UI only offers Conservative and Strict (Chromium asserts exactly these two). Thresholds aren't editable in the UI.
   - Hand edits: `config.test.ts` › "AC4" covers `mode: permissive`, looser, unknown and malformed thresholds. They are never applied (mode falls back to conservative, and JEV-2 ignores the thresholds) and are listed as warnings.
   - `service.test.ts` › "AC4" puts them in the page state. Chromium renders the "Ignored, to keep you safe" callout.
   - The orchestrator still sends its own `log` warnings (JEV-2).
5. **AC5 (Jev preview has no file contents):**
   - `packages/orchestrator/src/jev/handlers.test.ts` › "AC5": every file holds a sentinel and `.env` holds `API_KEY=…`. All three packs come back over RPC with neither, and `.env` is marked sensitive.
   - The redaction test checks that a project folder (`acmecorp`) and file name are hashed, that allow-listed names stay readable, and that the salt itself never appears.
- `scripts/verify.sh` is green: 1935 tests (+165).
- `test:webview` (prompt, stream and the new settings suite) passes.
- `test:integration` in VS Code 1.147 passes: activation 2.5 ms, and the orchestrator is still idle after activation.

**Deviations**
- **The settings page is an editor tab, not a sidebar view.** It has room for forms, and VS Code users expect settings to open in an editor tab. The walkthrough steps and the panel's "Set up a model" open it, and `desiide.setup` now lands on Get started instead of the walkthrough list (UI-2 allowed retargeting it).
- **Keys are shared per provider** (`secret:anthropic`, `secret:openai`, `secret:openrouter`, `secret:gemini`): one key covers every model of that provider. A custom server gets `secret:<model-id>`, and only when a key is typed.
- **Implemented `jev.preview` / `jev.test` in the orchestrator** (the JEV-1 handoff assigned the preview to UI-6).
  - The preview's sample is a `bug_fix` task at `balance`. risk_gate shows an `apply_edit` of 2 sampled files. `availableModels[].latencyMs` is 0 (not measured yet), and `costTier` comes from `costPerMTok.output`: local = free, unknown cloud price = medium, < $2 low, < $20 medium, else high.
  - **COR-5 should reuse `availableModels` / `costTierOf`, or replace them.**
- **The extension now depends on `@desiide/jev`** (pure: `resolveThresholds`, `DENY_RULES`, `DEFAULT_SENSITIVE_GLOBS`), so warnings and lists show without the orchestrator running and can't drift from the gate's rules.
- **Settings are written where the value already lives** (folder, then workspace, then user). The project's test/lint commands and sensitive globs go to `.desiide/project.json` (shared with the team), not to settings.
- **Onboarding steps check off only when the model works**: a model the orchestrator can't reach, or a missing key, doesn't count.

**Known gaps**
- **AC1 hasn't been timed by hand in the packaged app**, only by the live test (9.2 s machine time) and the Chromium keyboard run. Run the manual QA script above on the next app build.
- **Protocol quirk (pre-existing):** `ModelConfig.capabilities` is `ModelCapabilities.partial()`, which keeps `vision`'s `.default(false)`. Any capability override therefore also sets `vision: false`, which overrides a probed `true`. That's harmless in Alpha (no image input). Fixing it changes protocol semantics, so it's a planning call.
- **Multi-root:** the project file, command detection and the preview sample use the first folder (COR-6).
- Discovery only finds Ollama at its loopback default, or at a configured base URL (MOD-1 privacy rule).
- `test:webview` and the live test aren't in `verify.sh` or CI (same as UI-1/2/3).
- Colors are still the pre-UI-7 tokens. The page uses only token variables, so the Studio restyle flows through.
- **Workspace trust:** project test/lint commands are editable and allow-listed even in untrusted workspaces (JEV-2 follow-up still open).

**Follow-ups**
- **UI-7:** restyle with the Studio tokens. The success check in onboarding is the "lime moment".
- **JEV-3:** replace `jevTestResult` with a real call, and show the engine status (connected / degraded) in Settings → Jev.
- **UI-5:** link Jev status to `desiide.openSettings` with arg `"jev"`.
- **REL-2:** add the onboarding path to the Alpha suite (fresh profile + Ollama), using the manual QA script above.
- **Planning:** the protocol `vision` default quirk above. Possibly a "Forget all keys" command.
