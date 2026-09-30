# Desiide

**An open-source, AI-native IDE where you bring your own models and every AI decision is visible.**

> **Status: pre-alpha.** Desiide is being built in the open. Nothing is installable yet. The first release (Alpha) will be the Desiide desktop app for macOS and Linux. See the [roadmap](roadmap/README.md) for what's done and what's next.

## About

Desiide is a VS Code–based coding environment built around three ideas:

- **Bring your own models.** Point Desiide at a local model (Ollama) or your own Anthropic or OpenAI-compatible key. There's no Desiide account, no Desiide cloud, and no telemetry.
- **Route work by task, not by habit.** Desiide uses **Jev** (by TypeSafe) as a decision layer. For each task it chooses a workflow and a model: cheap/local first, escalating to a stronger model when the task is complex or the first attempt fails. That keeps cost down without giving up quality where it matters.
- **Nothing risky happens silently.** Every edit is a reviewable diff, and every command passes a policy gate: a hard deny-list first, then a risk check. Side-effecting actions ask by default. Each routing and risk decision is shown with its reasons and probabilities, and can be replayed.

## How it works

```
┌───────────────── VS Code / Desiide ────────────────┐
│  desiide-ai extension                               │
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
- **Jev only sees metadata**: task type, file paths and sizes, the command being gated. It never sees file contents. Jev is off until you configure it, and without it Desiide runs on a built-in deterministic rules engine.
- **API keys live only in VS Code SecretStorage.** Config refers to them as `secret:<name>`, and the orchestrator requests them over RPC when needed. They're never written to env, logs, or files.

The full wire contract is in [docs/protocol.md](docs/protocol.md).

## Release plan

| Milestone | What ships |
|---|---|
| **Alpha** | The Desiide desktop app (a VSCodium fork) for macOS and Linux, from GitHub Releases, with the AI features built in. |
| **Beta** | Critique workflow and the live Jev API. The `desiide-ai` extension is also published on Open VSX and the VS Code Marketplace, for people who stay in VS Code. |
| **1.0** | Hardening, Windows, signed builds, and team features. |

Details, build order, and module status: [roadmap/README.md](roadmap/README.md). Architecture decisions: [roadmap/DECISIONS.md](roadmap/DECISIONS.md).

## Repository layout

| Path | What's there |
|---|---|
| `extensions/desiide-ai/` | The VS Code extension. All AI and Jev UI lives here. |
| `packages/protocol/` | zod schemas for everything crossing the extension ↔ orchestrator boundary |
| `packages/orchestrator/` | Task engine, workflows, tool runner, context engine |
| `packages/models/` | Model adapters (OpenAI-compatible, Ollama, Anthropic) |
| `packages/jev/` | Jev engine, decision packs, policy gate, decision log |
| `editor/` | The VSCodium fork: the Desiide desktop app |
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
pnpm -F @desiide/protocol test   # one package's tests
pnpm format                   # Prettier
```

Stack: TypeScript (strict, ESM), pnpm workspaces, zod at every boundary, Vitest, ESLint flat config, and Prettier. Internal packages are consumed as TypeScript source and bundled with esbuild.

### Building the Desiide app

The desktop app is built from our VSCodium fork, [SaketMunda/desiide-vscodium](https://github.com/SaketMunda/desiide-vscodium), which lives in `editor/` as a git submodule. Day-to-day work on the AI features doesn't need the app build: develop `desiide-ai` in regular VS Code with **F5**.

You need macOS or Linux, `git`, `jq`, `python3`, `curl`, the Xcode Command Line Tools (macOS), and **about 15 GB of free disk**. Rust isn't needed. The script downloads the Node version VSCodium pins by itself.

```sh
git clone --recurse-submodules https://github.com/SaketMunda/desiide.git
# or, in an existing clone:
git submodule update --init editor

scripts/build-editor.sh           # ~7 min on an M4 Pro; re-runs reuse the downloaded source
scripts/build-editor.sh --clean   # re-download the upstream VS Code source first
```

The app lands in `editor/VSCode-darwin-arm64/Desiide.app` (Linux: `editor/VSCode-linux-<arch>/`). It keeps its data in `~/.desiide` and `~/Library/Application Support/Desiide`, separate from VS Code and VSCodium. If you launch it from a terminal inside VS Code, unset `ELECTRON_RUN_AS_NODE` first:

```sh
env -u ELECTRON_RUN_AS_NODE editor/VSCode-darwin-arm64/Desiide.app/Contents/MacOS/Desiide
```

**Checking the built app.** `pnpm -F desiide-ai test:app` runs a first-launch test inside the built app with a brand-new profile: the Desiide panel shows in the secondary side bar and the walkthrough opens, with nothing clicked. Before bumping VSCodium, `scripts/check-editor-patches.sh <vscode-version>` dry-runs our patches against that VS Code release in seconds.

**Changing the fork.** Desiide's branding and patches live in `editor/patches/desiide/` (see its README). The fork has its own history, so a change there takes two commits and two pushes:

```sh
# 1. Commit and push inside the fork (branch `desiide`)
git -C editor add patches/desiide
git -C editor commit -m "feat(<ID>): ..."
git -C editor push origin desiide

# 2. Record the new fork commit in this repo
git add editor
git commit -m "feat(<ID>): bump editor"
```

Push the fork first. Otherwise this repo points at a commit nobody else can fetch.

**Freeing disk space.** The build leaves about 8.5 GB behind. You can delete it anytime; the next build recreates it:

```sh
rm -rf editor/vscode editor/VSCode-*   # ~7 GB: upstream source and the built app
rm -rf ~/.cache/desiide                   # ~1 GB: pinned Node and the build's npm cache
```

## Contributing

Work is organized into **modules**, each with a brief in [`roadmap/modules/`](roadmap/modules) that defines its scope and acceptance criteria. A module is built on a `mod/<ID>-<slug>` branch and merged by PR once [the Definition of Done](roadmap/STANDARDS.md) is met and CI is green. Contribution guidelines, a code of conduct, and a security policy will be added before Alpha.

## License

To be decided before Alpha (see open decision #2 in [DECISIONS.md](roadmap/DECISIONS.md)). Upstream VS Code / VSCodium code remains under its MIT license.
