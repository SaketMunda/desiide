# UI-6 · Settings & onboarding

**Status:** todo · **Milestone:** Alpha · **Size:** M · **Depends on:** UI-1, MOD-1, JEV-1 · **Skills:** ide-editor-shell, ide-model-adapters, ide-jev-decisions

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
_(filled by the build session)_
