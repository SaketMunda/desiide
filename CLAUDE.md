# Mutt — AI-native IDE

Open-source VS Code fork (VSCodium base) with bring-your-own models and Jev (TypeSafe) as the routing / risk / cost decision layer. Alpha ships the Mutt desktop app with the `mutt-ai` extension built in (ADR-011); the extension is also published standalone at Beta.

## How work is organized
- `roadmap/README.md`: milestones, the module index with status, and the build order (waves).
- `roadmap/modules/<ID>-*.md`: one brief per module (scope, acceptance criteria, handoff notes).
- `roadmap/DECISIONS.md`: accepted ADRs + open decisions. `roadmap/STANDARDS.md`: Definition of Done.
- **Build sessions:** when asked to build or work on a module ("build Prompt Box", "UI-2", "next module"), use the `build-module` skill.
- **Planning sessions:** own scope, priorities, and ADRs. Build sessions never change another module's scope or an ADR; they escalate instead.

## Layout
- `editor/`: VSCodium fork (submodule). Only minimal patches in `editor/patches/mutt/`.
- `extensions/mutt-ai/`: the extension. **All AI/Jev UI lives here**, not in workbench patches.
- `packages/protocol`: zod schemas for everything crossing the extension ↔ orchestrator boundary. Additive-only.
- `packages/orchestrator`: host, task engine, workflows, tool runner, context engine. No `vscode` imports.
- `packages/models`: `ModelAdapter` implementations.
- `packages/jev`: `JevEngine` (HTTP + rules), decision packs, policy, decision log.

## Commands
- `scripts/verify.sh`: typecheck + lint + test. Must be green before any task is called done.
- `pnpm -F <pkg> test`: run one package's tests.
- For the editor build, see the `ide-editor-shell` skill.

## Domain skills
- `ide-editor-shell`: `editor/`, `extensions/mutt-ai/`
- `ide-orchestration-core`: `packages/orchestrator`, `packages/protocol`
- `ide-model-adapters`: `packages/models`
- `ide-jev-decisions`: `packages/jev`, gating, decision packs

## Non-negotiable rules
- **Privacy:** no telemetry. No request goes to an endpoint the user didn't configure. Jev receives metadata only, never file contents. API keys live only in VS Code SecretStorage (config uses `secret:<name>`) and reach the orchestrator via the `secrets.get` RPC. They're never in env, logs, or files.
- **Safety:** the hard deny-list runs before Jev. Jev can make a gate stricter, never looser. Default gating is conservative.
- **Edits:** the orchestrator never writes files. It returns `FileEdit[]`, and the extension applies them via `WorkspaceEdit`.
- **Transport:** JSON-RPC over stdio. No localhost ports without an ADR.
- **Types:** TypeScript strict, no `any` at package boundaries. zod-validate every external input (RPC, webview messages, model output, Jev responses).
- **Tests:** Vitest for every package change. HTTP uses recorded fixtures, and live calls only run under `MUTT_LIVE=1`.
