# Decision log

Short ADRs. Only the planning session adds or changes entries. A build session that needs a locked decision changed stops and escalates (see `build-module` skill).

## Accepted

**ADR-001 · Editor base = VSCodium fork.** We fork `VSCodium/vscodium` (build scripts + patches over Code-OSS) because telemetry is already removed and Open VSX is already wired. We don't build an editor from scratch.

**ADR-002 · All AI/Jev UI lives in the built-in `desiide-ai` extension.** Workbench patches are limited to branding, gallery, default layout, and bundling. *Why:* cheap upstream merges, and the same code can also ship as a standalone extension (ADR-011, Beta).

**ADR-003 · Extension ↔ orchestrator = JSON-RPC 2.0 over stdio.** The orchestrator is a child process with no `vscode` imports. No localhost ports, so no other local process can drive the shell tool. A WebSocket transport for remote orchestration is 1.0 backlog.

**ADR-004 · The orchestrator never writes files.** It returns `FileEdit[]`, and the extension applies them via `WorkspaceEdit` (native undo, diff view, dirty-buffer aware).

**ADR-005 · Jev privacy + safety.** Jev receives metadata only, never file contents. It's off until the user configures it. The hard deny-list runs before Jev, and Jev can only make a gate stricter.

**ADR-006 · Default gating = conservative.** Side-effecting actions ask unless Jev is highly confident and no sensitive paths are involved. There's no "permissive" mode in Alpha.

**ADR-007 · v0 providers:** a generic OpenAI-compatible adapter (with an Ollama preset) and a native Anthropic adapter. Workflows address models by **role** (`cheap`, `strong`, `reviewer`), never by hard-coded ID.

**ADR-008 · ~~Ship Alpha as an extension first; the IDE app ships at Beta.~~** *Superseded by ADR-011 (2026-09-29).* *Why:* Jev momentum. The extension reaches every VS Code user within ~3 weeks, while the fork build (heavy, slow CI, signing) runs in parallel. Publish to both Open VSX and the VS Code Marketplace. (Third-party *extensions* on the MS Marketplace are fine; the restriction only applies to forks *consuming* it.) *Status: was accepted by default; vetoed by the user in favor of app-first.*

**ADR-009 · Stack.** TypeScript strict, pnpm workspaces, internal packages consumed as TS source, esbuild bundles (extension + orchestrator), Vitest, zod at every boundary, Preact + Vite for webviews, ESLint flat config + Prettier.

**ADR-010 · Process.** One module per build session, on branch `mod/<ID>-<slug>` with a PR to `master`. CI must be green. `packages/protocol` is additive-only once FND-2 is done. Any breaking contract change needs an ADR here.

**ADR-011 · App-first: Alpha ships the Desiide desktop app.** Alpha is the Desiide desktop app (VSCodium fork) for macOS (arm64 + x64) and Linux x64, from GitHub Releases, with `desiide-ai` built in. *Why:* the product is the IDE, an AI-native editor in the Cursor / Windsurf class, not an add-on to someone else's editor. EDT-1 showed that the fork is cheap: a ~7 min local build, branding done by overlays, and a single hook line in VSCodium's scripts. ADR-002 stands: all AI/Jev UI stays in `desiide-ai`, which stays compatible with stock VS Code, so publishing it standalone (Open VSX + VS Code Marketplace) is a secondary channel at Beta. Alpha builds are unsigned, so first launch needs one documented step. Signing and notarization stay in 1.0. *Decided by the user, 2026-09-29.*

**ADR-012 · Product renamed Mutt → Desiide.** The user owns `desiide.com`. Everything renamed in one change: repos (`SaketMunda/desiide`, `SaketMunda/desiide-vscodium`, fork branch `desiide`), the extension `desiide-ai`, packages `@desiide/*`, commands and settings `desiide.*`, CSS tokens `--desiide-*`, env vars `DESIIDE_*`, the workspace folder `.desiide/`, the app binary `desiide`, the data folder `~/.desiide`, the URL protocol `desiide`, and the macOS bundle ID `com.desiide.app`. Handoff notes written before the rename use the new names, but their evidence was produced under the old ones. Git history and the fork's old `mutt` branch keep the old name. *Decided by the user, 2026-09-30.*

**ADR-013 · License: `MIT OR Apache-2.0`.** Desiide's own code is dual licensed, at the user's option (`LICENSE-MIT`, `LICENSE-APACHE`). Upstream VS Code / VSCodium code stays MIT. *Why:* MIT matches VS Code and keeps adoption friction at zero; Apache-2.0 adds the explicit patent grant enterprises' legal teams look for. Offering both gives each audience what it needs. Contributions are accepted under the same dual terms. *Decided by the user, 2026-10-05.* (Resolves open #2.)

**ADR-014 · No crash or error reporting in Alpha and Beta; opt-in and self-hostable from 1.0.** It's never on by default, and it never sends file contents, prompts, or keys. *Why:* "no telemetry" is a core promise, and the 1.0 opt-in only exists to fix crashes users choose to report. *Decided by the user, 2026-10-05.* (Resolves open #5.)

**ADR-015 · One name everywhere: `desiide`.** The user owns `desiide.com`, so every account and identifier uses `desiide`: the VS Code Marketplace publisher and the Open VSX namespace are both `desiide`, so the extension ID is `desiide.desiide-ai` (it was the placeholder `desiide-dev`). The Apple Developer account, used for signing at 1.0, is registered to a `desiide.com` address. *Why:* one name is easy to find and hard to impersonate, and registries hand out names first come, first served. *Action for the user:* create the accounts (Claude can't create accounts or hold credentials). Tokens go in CI secrets only (REL-1). *Decided by the user, 2026-10-05.* (Resolves open #4.)

**ADR-016 · Brand mark: the "D" monogram.** A teal "D" whose stem is a text cursor, split from the bowl by a stencil cut, with an amber dot in the counter for Jev's decision, on the slate tile. It replaces the "Mutt" dog placeholder in the app icon, the editor watermark, the activity bar, and the extension icon. The Brandmark.io serif wordmark was rejected because it reads as editorial, not as a developer tool. *Decided by the user, 2026-10-05.* (Resolves open #3.)

**ADR-017 · Models carry a locality: `local | cloud`.** `ModelConfig.locality` is optional and overrides inference. `ModelInfo.locality` and Jev's `availableModels[].locality` carry the result. Inference is deliberately narrow: Ollama, or a loopback `baseUrl`, counts as `local`, and everything else, LAN addresses included, counts as `cloud`. *Why:* routing ("keep this on my machine") and privacy decisions need to know where data goes. Guessing from cost was wrong (a free cloud model counted as local), and claiming `local` wrongly would send private context off the machine. *Decided by the user, 2026-10-05.*

**ADR-018 · Multi-root workspaces use root-qualified paths.** With more than one workspace folder, every `WorkspacePath` starts with the folder's label, e.g. `api/src/a.ts`. A single-folder workspace is unchanged (no prefix). The extension sends the labels in `initialize` (additive `workspaceFolders: {name, path}[]`), and they're unique within the session. This is VS Code's own `asRelativePath` convention. *Why:* one string per path works the same for the model, tools, edits, Jev, and the decision log, and it lets the model create files in any folder. The alternative, an extra `root` field on every path-carrying type and tool argument, has to be threaded through everything and silently picks folder #1 whenever it's forgotten. Paths stay relative, so no absolute local path ever reaches a model or Jev (good for the remote orchestrator too). Built in COR-6 (Beta). *Decided by the user, 2026-10-05: "do it for the end goal, not just Alpha."*

**ADR-019 · Gating asks for what is sensitive or risky, not for everything.** It refines ADR-006 and doesn't loosen it: deny-listed actions are blocked, and sensitive files, multi-file edits, and side-effecting commands ask. Read-only actions on non-sensitive files run without asking. COR-2's `confirmAllGate` is a stopgap until JEV-2's `PolicyGate` replaces it, and JEV-2 is the next module. *Decided by the user, 2026-10-05.*

**ADR-020 · Jev API questions belong to JEV-3.** API docs, the key model (bring-your-own vs proxied), Noul semantics, rate limits, and retention are resolved inside JEV-3 when the TypeSafe docs arrive. They don't block anything else: Alpha runs on the rules engine behind the same `JevEngine` interface. *Decided by the user, 2026-10-05.* (Resolves open #1.)

**ADR-021 · Only the deny-list blocks; everything else that's doubtful is asked.** A risk_gate answer never blocks by default (`blockSafeNowBelow` = 0). Deletes such as `rm -rf dist`, migrations, `git reset --hard`, and other actions the engine judges unsafe go to `confirm` with their reasons. The hard deny-list still blocks without consulting Jev. Users who want engine-driven blocking can raise `desiide.gating.thresholds.blockSafeNowBelow` (e.g. 0.3), which counts as stricter. *Why:* blocking with no override in Alpha stopped legitimate work the user would approve (cleaning build output, running their own migration). Asking keeps the user in control without losing safety. *Decided by the user, 2026-10-06.* Refines ADR-006 and ADR-019.

## Open (need the user's call)

None right now.

## Actions for the user
- Create the `desiide` publisher on the VS Code Marketplace and the `desiide` namespace on Open VSX before Beta (ADR-015). Apple Developer account under `desiide.com` before 1.0.
