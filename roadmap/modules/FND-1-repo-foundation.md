# FND-1 · Repo foundation

**Status:** done · **Milestone:** Alpha · **Size:** S · **Depends on:** — · **Skills:** none

## Purpose
The monorepo skeleton every other module builds on: tooling, the verify script, CI, and empty packages.

## Scope
- pnpm workspace: `packages/*`, `extensions/*`. `.nvmrc` = 24. `packageManager` field pinned.
- `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, ESM, `moduleResolution: bundler`) and per-package `tsconfig.json` with project references. Typecheck via `tsc -b` (noEmit).
- Internal packages `@desiide/protocol`, `@desiide/orchestrator`, `@desiide/models`, `@desiide/jev` with `exports` → `./src/index.ts` (consumed as source, bundled by esbuild). Each has one placeholder test.
- `extensions/desiide-ai/` placeholder `package.json` only (UI-1 fills it).
- ESLint flat config (typescript-eslint strict; `no-explicit-any: error`) + Prettier. Vitest workspace config.
- `scripts/verify.sh`: `pnpm -r typecheck && pnpm lint && pnpm test`.
- `.github/workflows/verify.yml` (PR + push to master), `.github/pull_request_template.md` containing the DoD checklist from `STANDARDS.md`.
- `.gitignore` (node_modules, dist, `.desiide/logs/`, `*.vsix`), `.editorconfig`.

## Out of scope
The license file (open decision), the VSCodium fork (EDT-1), and the extension scaffold (UI-1).

## Acceptance criteria
1. Fresh clone: `pnpm i && scripts/verify.sh` passes in < 60 s locally.
2. The CI workflow runs and passes on a PR.
3. Adding `const x: any = 1; export { x }` in any package fails lint.
4. A package can import another (`@desiide/protocol` from `@desiide/jev`) and typecheck passes.

## Handoff notes
**Built (branch `mod/FND-1-repo-foundation`):**
- pnpm workspace (`packages/*`, `extensions/*`), `packageManager: pnpm@12.6.0`, `.nvmrc` = 24, `engines.node >=24`.
- `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, ESM, `moduleResolution: bundler`, `allowImportingTsExtensions`). Root `tsconfig.json` is a solution file referencing each package + `tsconfig.tooling.json` (covers `eslint.config.ts`, `vitest.config.ts`).
- `@desiide/protocol`, `@desiide/orchestrator`, `@desiide/models`, `@desiide/jev`: `exports` → `./src/index.ts`, one placeholder test each. `@desiide/jev` depends on `@desiide/protocol` (`workspace:*` + tsconfig `references`) to prove cross-package imports.
- `extensions/desiide-ai/package.json` placeholder.
- ESLint flat config (`eslint.config.ts`): `@eslint/js` recommended + `typescript-eslint` strict + `no-explicit-any: error` + `eslint-config-prettier`. Prettier (`singleQuote`, `printWidth: 100`).
- Vitest root config using `test.projects: ['packages/*']`. Each package also has its own `test` script.
- `scripts/verify.sh`, `.github/workflows/verify.yml` (PR + push to master, frozen lockfile), `.github/pull_request_template.md` (DoD checklist), `.gitignore`, `.editorconfig`.

**How new packages plug in:** add `packages/<name>/` with `package.json` (`exports` → `./src/index.ts`, `typecheck: tsc -b`, `test: vitest run`) and a `tsconfig.json` copied from an existing package (set its `outDir`/`tsBuildInfoFile` to its own name under `node_modules/.cache/tsc/`). Add a `references` entry in the consumer's tsconfig and in root `tsconfig.json`. Import sibling files with a `.ts` extension.

**Deviations:**
- *Typecheck isn't strictly `noEmit`.* `tsc -b` refuses referenced projects that disable emit (TS6310), so packages use `composite` + `emitDeclarationOnly`, writing `.d.ts` into `node_modules/.cache/tsc/<pkg>`. Nothing is emitted into the source tree, and runtime bundling is still esbuild's job.
- *TypeScript pinned to `~6.0.3`, not 7.x.* typescript-eslint 8.x requires TS `<6.1`. Revisit when typescript-eslint supports TS 7.
- *Vitest uses `test.projects` rather than a separate workspace file.* Vitest 3.2+ deprecated `vitest.workspace` in favor of projects.
- *Prettier ignores `**/*.md`.* Without that, `prettier --write` reformats the planning-owned roadmap, CLAUDE.md, and skills.

**Known gaps:**
- Corepack 0.34 (bundled with Node 24.11) can't launch pnpm 12, whose package no longer ships `bin/pnpm.cjs`. Locally, install pnpm with `npm i -g pnpm@12.6.0` (or `npx pnpm@12.6.0`). CI uses `pnpm/action-setup`, which reads `packageManager`.
- AC 2 (CI passes on a PR) needs the PR pushed. See the PR checks.
- AC 3 was checked manually (probe file in every package → 5 `no-explicit-any` errors). There's no automated regression test for the lint config.

**Follow-ups:**
- Add a Vitest coverage provider (`@vitest/coverage-v8`) once real logic lands, to measure the ≥80% target in STANDARDS.
- REL-3 could document the pnpm-12/corepack install note in CONTRIBUTING.
