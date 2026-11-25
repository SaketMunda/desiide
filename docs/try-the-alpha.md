# Try the alpha

Desiide is in early alpha. This page gets you from download to a first task in about 5 minutes, and tells you what does and doesn't work yet.

## What works today

- The app installs and runs on macOS (Apple silicon and Intel) and Linux x64. It's VS Code underneath, so extensions from Open VSX, themes and keybindings work.
- The Desiide panel (right side bar, or Cmd/Ctrl+L) takes a task and streams the agent's work live: what it reads, which tools it runs, and its reasoning.
- Every tool call passes the policy gate. Deny-listed commands are blocked, and side-effecting ones ask first.

## Not built yet

- **Setup screens.** You add a model by editing `settings.json` (below).
- **Applying edits.** The agent proposes changes, but nothing is written to your files yet. Diff review and approval comes next.
- **The decision panel.** Routing and risk decisions are logged but not shown in their own view yet.

## 1. Install

Download the build for your machine from [GitHub Releases](https://github.com/SaketMunda/desiide/releases) (the newest `app-v…` pre-release).

**macOS.** Open the `.dmg` and drag Desiide to Applications. The alpha isn't signed yet, so macOS blocks the first launch. Clear the quarantine flag once:

```sh
xattr -dr com.apple.quarantine /Applications/Desiide.app
```

**Linux.** Use the `.deb`, the `.tar.gz`, or the `.AppImage` (`chmod +x` it first).

## 2. Run a local model

Install [Ollama](https://ollama.com), then pull a model that supports tool calls:

```sh
ollama pull qwen3.5:2b-q4_K_M
```

## 3. Point Desiide at it

Open the Command Palette, run **Preferences: Open User Settings (JSON)**, and add:

```jsonc
"desiide.models": [
  { "id": "local", "provider": "ollama", "model": "qwen3.5:2b-q4_K_M" }
],
"desiide.roles": { "cheap": "local", "strong": "local" }
```

`provider` can be `ollama`, `openai-compatible` or `anthropic`. Cloud keys need the setup screens, which aren't built yet, so stay local for now.

## 4. Run a task

1. Open a small project folder and click **Trust** when asked. Restricted Mode turns the Desiide panel off.
2. Open the Desiide panel (Cmd/Ctrl+L) and give it a task, e.g. *"Explain what src/index.ts does and suggest one fix."*
3. Watch the stream. When it wants to run a command, it asks you first.

## Feedback

Open an [issue](https://github.com/SaketMunda/desiide/issues) with your OS, the task you gave it, and what happened. Screenshots of the task stream help most.
