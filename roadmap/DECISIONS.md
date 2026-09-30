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

## Open (need the user's call)

1. **Jev API docs + key.** This blocks JEV-3. Also needed: "Noul" semantics, rate limits, data retention, and whether end users bring their own Jev key or Desiide proxies it (a business-model question).
2. **License**: MIT (matches VS Code, max adoption) vs Apache-2.0 (explicit patent grant, which enterprises like). *Recommendation: Apache-2.0 for our code; upstream stays MIT.*
3. **Brand icon**: the name is decided (ADR-012) and so are the colors: teal `#2BB3A3` primary, amber `#F2A33A` for Jev and risk, on slate, chosen by the user on 2026-09-29 and shipped in EDT-1. Still open: the icon. The current placeholder is a dog face made for "Mutt" and no longer matches the name. Replace `editor/patches/desiide/icons/desiide-icon.svg` and `extensions/desiide-ai/media/` before Alpha.
4. **Publisher accounts**: VS Code Marketplace publisher ID + Open VSX namespace (needed by REL-1 before **Beta**, for the standalone extension). Apple Developer account for signing and notarization: optional for Alpha and Beta (unsigned builds with a documented first-launch step), required for 1.0.
5. **Crash/error reporting**: none (pure privacy) vs opt-in, self-hostable. *Recommendation: none in Alpha, opt-in in 1.0.*
