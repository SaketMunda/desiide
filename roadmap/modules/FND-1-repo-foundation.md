# FND-1 · Repo foundation

**Status:** todo · **Milestone:** Alpha · **Size:** S · **Depends on:** — · **Skills:** none

## Purpose
The monorepo skeleton every other module builds on: tooling, the verify script, CI, and empty packages.

## Scope
- pnpm workspace: `packages/*`, `extensions/*`. `.nvmrc` = 24. `packageManager` field pinned.
- `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, ESM, `moduleResolution: bundler`) and per-package `tsconfig.json` with project references. Typecheck via `tsc -b` (noEmit).
- Internal packages `@mutt/protocol`, `@mutt/orchestrator`, `@mutt/models`, `@mutt/jev` with `exports` → `./src/index.ts` (consumed as source, bundled by esbuild). Each has one placeholder test.
- `extensions/mutt-ai/` placeholder `package.json` only (UI-1 fills it).
- ESLint flat config (typescript-eslint strict; `no-explicit-any: error`) + Prettier. Vitest workspace config.
- `scripts/verify.sh`: `pnpm -r typecheck && pnpm lint && pnpm test`.
- `.github/workflows/verify.yml` (PR + push to master), `.github/pull_request_template.md` containing the DoD checklist from `STANDARDS.md`.
- `.gitignore` (node_modules, dist, `.mutt/logs/`, `*.vsix`), `.editorconfig`.

## Out of scope
The license file (open decision), the VSCodium fork (EDT-1), and the extension scaffold (UI-1).

## Acceptance criteria
1. Fresh clone: `pnpm i && scripts/verify.sh` passes in < 60 s locally.
2. The CI workflow runs and passes on a PR.
3. Adding `const x: any = 1; export { x }` in any package fails lint.
4. A package can import another (`@mutt/protocol` from `@mutt/jev`) and typecheck passes.

## Handoff notes
_(filled by the build session)_
