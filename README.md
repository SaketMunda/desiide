# Mutt

**An open-source, AI-native IDE where you bring your own models and every AI decision is visible.**

> **Status: pre-alpha.** Mutt is being built in the open. Nothing is installable yet. The first release (Alpha) will be the `mutt-ai` VS Code extension. See the [roadmap](roadmap/README.md) for what's done and what's next.

## About

Mutt is a VS Code–based coding environment built around three ideas:

- **Bring your own models.** Point Mutt at a local model (Ollama) or your own Anthropic or OpenAI-compatible key. There's no Mutt account, no Mutt cloud, and no telemetry.
- **Route work by task, not by habit.** Mutt uses **Jev** (by TypeSafe) as a decision layer. For each task it chooses a workflow and a model: cheap/local first, escalating to a stronger model when the task is complex or the first attempt fails. That keeps cost down without giving up quality where it matters.
- **Nothing risky happens silently.** Every edit is a reviewable diff, and every command passes a policy gate: a hard deny-list first, then a risk check. Side-effecting actions ask by default. Each routing and risk decision is shown with its reasons and probabilities, and can be replayed.

The name: a mutt is a mix of breeds. Mutt mixes whichever models you have and picks the right one for each job.

## How it works

```
┌──────────────── VS Code / Mutt IDE ────────────────┐
│  mutt-ai extension                                  │
│  Prompt Box · Task stream · Diff review ·           │
│  Approvals · Decision panel · Settings              │
└───────────────┬─────────────────────────────────────┘
                │ JSON-RPC 2.0 over stdio (no ports)
┌───────────────▼─────────────────────────────────────┐
│  Orchestrator (child process, no vscode imports)     │
│  Task engine & agent loop · Workflows                │
│  (single / cascade / critique) · Tool runner ·       │
│  Context engine                                      │
├──────────────────────┬──────────────────────────────┤
│  Model adapters      │  Jev decisions               │
│  OpenAI-compatible,  │  workflow_select · risk_gate │
│  Ollama, Anthropic   │  cost_route · policy · log   │
└──────────────────────┴──────────────────────────────┘
```

- The orchestrator **never writes files**. It proposes search/replace edits, and the extension applies them through VS Code's `WorkspaceEdit` after you approve, so undo and dirty buffers work as usual.
- **Jev only sees metadata**: task type, file paths and sizes, the command being gated. It never sees file contents. Jev is off until you configure it, and without it Mutt runs on a built-in deterministic rules engine.
- **API keys live only in VS Code SecretStorage.** Config refers to them as `secret:<name>`, and the orchestrator requests them over RPC when needed. They're never written to env, logs, or files.

The full wire contract is in [docs/protocol.md](docs/protocol.md).

## Release plan

| Milestone | What ships |
|---|---|
| **Alpha** | The `mutt-ai` extension on Open VSX and the VS Code Marketplace. Works in VS Code, VSCodium, and compatible editors. |
| **Beta** | The Mutt IDE desktop app (a VSCodium fork) for macOS and Linux, with the extension built in. Critique workflow and the live Jev API. |
| **1.0** | Hardening, Windows, signed builds, and team features. |

Details, build order, and module status: [roadmap/README.md](roadmap/README.md). Architecture decisions: [roadmap/DECISIONS.md](roadmap/DECISIONS.md).

## Repository layout

| Path | What's there |
|---|---|
| `extensions/mutt-ai/` | The VS Code extension. All AI and Jev UI lives here. |
| `packages/protocol/` | zod schemas for everything crossing the extension ↔ orchestrator boundary |
| `packages/orchestrator/` | Task engine, workflows, tool runner, context engine |
| `packages/models/` | Model adapters (OpenAI-compatible, Ollama, Anthropic) |
| `packages/jev/` | Jev engine, decision packs, policy gate, decision log |
| `editor/` | The VSCodium fork (Beta) |
| `roadmap/` | Milestones, module briefs, standards, decisions |
| `docs/` | Developer docs |

## Development

Requirements: **Node 24** (see `.nvmrc`) and **pnpm 12**.

```sh
npm i -g pnpm@12.6.0   # corepack in Node 24.11 can't launch pnpm 12 yet
pnpm install
scripts/verify.sh      # typecheck + lint + tests; must be green before a PR
```

Useful commands:

```sh
pnpm -F @mutt/protocol test   # one package's tests
pnpm format                   # Prettier
```

Stack: TypeScript (strict, ESM), pnpm workspaces, zod at every boundary, Vitest, ESLint flat config, and Prettier. Internal packages are consumed as TypeScript source and bundled with esbuild.

## Contributing

Work is organized into **modules**, each with a brief in [`roadmap/modules/`](roadmap/modules) that defines its scope and acceptance criteria. A module is built on a `mod/<ID>-<slug>` branch and merged by PR once [the Definition of Done](roadmap/STANDARDS.md) is met and CI is green. Contribution guidelines, a code of conduct, and a security policy will be added before Alpha.

## License

To be decided before Alpha (see open decision #2 in [DECISIONS.md](roadmap/DECISIONS.md)). Upstream VS Code / VSCodium code remains under its MIT license.
