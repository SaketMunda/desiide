# Decision log

Short ADRs. Only the planning session adds or changes entries. A build session that needs a locked decision changed stops and escalates (see `build-module` skill).

## Accepted

**ADR-001 · Editor base = VSCodium fork.** We fork `VSCodium/vscodium` (build scripts + patches over Code-OSS) because telemetry is already removed and Open VSX is already wired. We don't build an editor from scratch.

**ADR-002 · All AI/Jev UI lives in the built-in `mutt-ai` extension.** Workbench patches are limited to branding, gallery, default layout, and bundling. *Why:* cheap upstream merges, and the same code ships as a standalone extension (ADR-008).

**ADR-003 · Extension ↔ orchestrator = JSON-RPC 2.0 over stdio.** The orchestrator is a child process with no `vscode` imports. No localhost ports, so no other local process can drive the shell tool. A WebSocket transport for remote orchestration is 1.0 backlog.

**ADR-004 · The orchestrator never writes files.** It returns `FileEdit[]`, and the extension applies them via `WorkspaceEdit` (native undo, diff view, dirty-buffer aware).

**ADR-005 · Jev privacy + safety.** Jev receives metadata only, never file contents. It's off until the user configures it. The hard deny-list runs before Jev, and Jev can only make a gate stricter.

**ADR-006 · Default gating = conservative.** Side-effecting actions ask unless Jev is highly confident and no sensitive paths are involved. There's no "permissive" mode in Alpha.

**ADR-007 · v0 providers:** a generic OpenAI-compatible adapter (with an Ollama preset) and a native Anthropic adapter. Workflows address models by **role** (`cheap`, `strong`, `reviewer`), never by hard-coded ID.

**ADR-008 · Ship Alpha as an extension first; the IDE app ships at Beta.** *Why:* Jev momentum. The extension reaches every VS Code user within ~3 weeks, while the fork build (heavy, slow CI, signing) runs in parallel. Publish to both Open VSX and the VS Code Marketplace. (Third-party *extensions* on the MS Marketplace are fine; the restriction only applies to forks *consuming* it.) *Status: accepted by default. Veto in the planning session if you want app-first.*

**ADR-009 · Stack.** TypeScript strict, pnpm workspaces, internal packages consumed as TS source, esbuild bundles (extension + orchestrator), Vitest, zod at every boundary, Preact + Vite for webviews, ESLint flat config + Prettier.

**ADR-010 · Process.** One module per build session, on branch `mod/<ID>-<slug>` with a PR to `master`. CI must be green. `packages/protocol` is additive-only once FND-2 is done. Any breaking contract change needs an ADR here.

## Open (need the user's call)

1. **Jev API docs + key.** This blocks JEV-3. Also needed: "Noul" semantics, rate limits, data retention, and whether end users bring their own Jev key or Mutt proxies it (a business-model question).
2. **License**: MIT (matches VS Code, max adoption) vs Apache-2.0 (explicit patent grant, which enterprises like). *Recommendation: Apache-2.0 for our code; upstream stays MIT.*
3. **Brand**: is "Mutt" the final product name? Icon and accent colors are needed by EDT-1 and REL-3. Temporary placeholders are fine until Beta.
4. **Publisher accounts**: VS Code Marketplace publisher ID + Open VSX namespace (needed by REL-1 before Alpha). Apple Developer account for Beta signing (optional for Beta, required for 1.0).
5. **Crash/error reporting**: none (pure privacy) vs opt-in, self-hostable. *Recommendation: none in Alpha, opt-in in 1.0.*
