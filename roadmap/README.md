# Desiide Roadmap

This is the source of truth for **what** gets built, **in what order**, and **what "done" means**.

- **Planning session** (decisions, scope, priorities) owns this folder: `README.md`, `DECISIONS.md`, `STANDARDS.md`, and the "Scope / Acceptance" parts of module briefs.
- **Build sessions** each build one module. They follow the `build-module` skill, update their module's **Status** and **Handoff notes**, and never change another module's scope.

## Milestones

| Milestone | What ships | Target (indicative) | Exit criteria |
|---|---|---|---|
| **Alpha** | **Desiide** desktop app (VSCodium fork) for macOS (arm64 + x64) and Linux x64, from GitHub Releases, with `desiide-ai` built in (ADR-011). Unsigned: first launch needs one documented step. | ~4 weeks from FND-1 start | A dev downloads and launches Desiide, connects Ollama or a Claude/OpenAI-compat key in <2 min, runs a bug-fix task, sees the Jev routing + risk decisions, and approves a diff. Open VSX extensions install. REL-2 Alpha suite green against the app. |
| **Beta** | Critique workflow. Live Jev API. The `desiide-ai` extension also published standalone on Open VSX + VS Code Marketplace, for people who stay in VS Code. | ~+3 weeks | Critique and live Jev pass the REL-2 suite in the app. The standalone extension installs from both registries and passes the suite in stock VS Code. |
| **1.0** | Hardening + pro/enterprise features (see backlog). Windows. Signed builds. | ~+4–6 weeks | Defined at the Beta retro. |

Targets are indicative and get revisited in the planning session after each milestone.

## Module index

Size: **S** ≈ half a session, **M** ≈ one session, **L** ≈ 2–3 sessions.
Status: `todo` · `in-progress` · `review` · `done` · `blocked`. A build session updates **only its own row**.

| ID | Module | Milestone | Size | Depends on | Status |
|---|---|---|---|---|---|
| [FND-1](modules/FND-1-repo-foundation.md) | Repo foundation | Alpha | S | — | done |
| [FND-2](modules/FND-2-protocol.md) | Protocol (shared contracts) | Alpha | M | FND-1 | done |
| [COR-1](modules/COR-1-orchestrator-host.md) | Orchestrator host & RPC | Alpha | M | FND-2 | done |
| [COR-2](modules/COR-2-task-engine.md) | Task engine & agent loop | Alpha | L | FND-2, COR-1, MOD-1 | done |
| [COR-3](modules/COR-3-tool-runner.md) | Tool runner | Alpha | M | FND-2 | done |
| [COR-4](modules/COR-4-context-engine.md) | Context engine | Alpha | M | COR-3 | in-progress |
| [COR-5](modules/COR-5-workflows.md) | Workflows (single/cascade/critique) | Alpha + Beta | M | COR-2, JEV-2 | todo |
| [MOD-1](modules/MOD-1-model-core.md) | Model core (interface, registry, HTTP) | Alpha | M | FND-2 | done |
| [MOD-2](modules/MOD-2-openai-compat-adapter.md) | OpenAI-compatible + Ollama adapter | Alpha | M | MOD-1 | review |
| [MOD-3](modules/MOD-3-anthropic-adapter.md) | Anthropic adapter + reasoning (ADR-022) | Alpha | M | MOD-1 | review |
| [JEV-1](modules/JEV-1-jev-core.md) | Jev core (packs, rules engine, state) | Alpha | M | FND-2 | done |
| [JEV-2](modules/JEV-2-policy-gate.md) | Policy & risk gate | Alpha | M | JEV-1 | review |
| [JEV-3](modules/JEV-3-jev-http-client.md) | Jev HTTP client (TypeSafe API) | Alpha* | S | JEV-1, **API docs** | blocked |
| [JEV-4](modules/JEV-4-decision-log.md) | Decision log & replay | Alpha | S | JEV-1 | todo |
| [UI-1](modules/UI-1-extension-shell.md) | Extension shell & UI kit | Alpha | M | FND-1 | done |
| [UI-2](modules/UI-2-prompt-box.md) | Prompt Box | Alpha | M | UI-1, FND-2 | done |
| [UI-3](modules/UI-3-task-stream.md) | Task stream (transcript) | Alpha | M | UI-1, FND-2 | todo |
| [UI-4](modules/UI-4-review-gate.md) | Review & approval (diffs, commands) | Alpha | L | UI-3, COR-2 | todo |
| [UI-5](modules/UI-5-decision-panel.md) | Decision panel | Alpha | M | UI-1, JEV-4 | todo |
| [UI-6](modules/UI-6-settings-onboarding.md) | Settings & onboarding | Alpha | M | UI-1, MOD-1, JEV-1 | todo |
| [EDT-1](modules/EDT-1-fork-build.md) | VSCodium fork & branding | Alpha | M | FND-1 | done |
| [EDT-2](modules/EDT-2-fork-integration.md) | Built-in extension & default layout | Alpha | S | EDT-1, UI-1 | done |
| [COR-6](modules/COR-6-multi-root.md) | Multi-root workspaces | Beta | M | COR-3, UI-2, UI-4 | todo |
| [REL-1](modules/REL-1-ci-release.md) | CI & release pipelines | Alpha + Beta | L | FND-1, EDT-1, EDT-2 (app release) | todo |
| [REL-2](modules/REL-2-e2e-qa.md) | E2E & QA | Alpha + Beta | M | UI-4, COR-2 | todo |
| [REL-3](modules/REL-3-docs-community.md) | Docs & community | Alpha + Beta | S | continuous | todo |

\* JEV-3 ships in Alpha if the TypeSafe API docs arrive in time. Otherwise Alpha ships on the rules engine with Jev marked "coming soon". Everything else is designed so this swap needs no other changes.

## Build order (waves)

Modules in the same wave can run in **parallel sessions**, each on its own branch or worktree. Don't start a module until its dependencies are `done`, unless its brief gives a mock strategy.

```
Wave 1  FND-1
Wave 2  FND-2 · UI-1 · EDT-1 · REL-1 (verify CI part)
Wave 3  COR-1 · COR-3 · MOD-1 · JEV-1 · UI-2 (mock client) · EDT-2
Wave 4  COR-2 · COR-4 · MOD-2 · MOD-3 · JEV-2 · JEV-4 · UI-3 · UI-6
Wave 5  COR-5 (single+cascade) · UI-4 · UI-5 · JEV-3 (when docs land)
Wave 6  REL-2 (app) · REL-1 (app release) · REL-3  → 🚀 Alpha
Beta    COR-5 (critique) · COR-6 · REL-1 (extension publish) · REL-2 (standalone extension) · REL-3  → 🚀 Beta
```

Critical path to Alpha: `FND-1 → FND-2 → COR-1 → COR-2 → UI-4 → REL-2`. Put the strongest attention there. The app track `EDT-1 → EDT-2 → REL-1 (app release)` also blocks Alpha (ADR-011), but it's short and runs in parallel.

## 1.0 backlog (not yet briefed; the planning session writes briefs after Beta)
- Inline tab autocomplete (FIM on a local model, Jev-routed escalation)
- Local semantic codebase index (embeddings) for the context engine
- MCP client support (external tools inside the agent loop, gated by policy)
- Enterprise policy: org-managed gating/model allow-lists (managed settings), exportable audit log
- Jev task-queue prioritization (Score: priority/payoff) for many concurrent agents
- Remote orchestrator (WebSocket transport, auth)
- Native Gemini adapter; more presets (OpenRouter, vLLM, LM Studio)
- Windows builds; macOS signing + notarization; auto-update channel

## Open decisions (planning session)
See `DECISIONS.md` → "Open".
