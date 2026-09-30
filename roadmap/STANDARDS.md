# Engineering standards

The bar is **enterprise-trustworthy, not enterprise-heavy**. If a rule here slows shipping without protecting users, raise it in the planning session. Don't silently skip it.

## Definition of Done (every module)
- [ ] Every item in the brief's **Acceptance criteria** is met and demonstrated (test or recorded manual check).
- [ ] `scripts/verify.sh` is green (typecheck, lint, unit tests).
- [ ] New logic in `packages/*` has unit tests (target ≥80% line coverage on new files). UI logic (state, reducers, parsers) is tested. Pure presentation isn't required to be.
- [ ] No `any` / `as unknown as` at package boundaries. Every external input is validated with zod.
- [ ] No new network destinations except ones the user configured. No telemetry.
- [ ] Errors are handled: user-facing failures show an actionable message, and nothing fails silently.
- [ ] Brief updated: **Status**, **Handoff notes** (what was built, deviations, known gaps, follow-ups).
- [ ] PR opened from `mod/<ID>-<slug>`, description links the brief, CI green.

## Git
- Branch: `mod/<ID>-<slug>` (e.g. `mod/UI-2-prompt-box`). Fixes use `fix/<short>`.
- Commits: Conventional Commits with the module scope, e.g. `feat(UI-2): add @file mentions`.
- Small PRs are preferred. A module can land as 2–3 PRs if it's `L`.
- Never commit secrets, `.desiide/logs/`, or model fixture files that contain real keys.

## Code
- TypeScript strict, ESM. Named exports. One concept per file. Prefer functions and plain data over class hierarchies.
- Public API of each package lives in `src/index.ts`. Don't deep-import across packages.
- Every async operation that can hang takes an `AbortSignal`.
- Logging: structured (`pino`), to stderr or file. Never log secrets, file contents, or full prompts at `info` level.
- Comments explain *why*. Conventions belong in skills and briefs, not scattered comments.

## Testing
- Unit tests use Vitest, colocated as `*.test.ts`.
- Model and Jev HTTP is tested with recorded fixtures. Live tests run only with `DESIIDE_LIVE=1`.
- Safety-critical code (policy, deny-list, path confinement) gets **adversarial** tests (obfuscated commands, symlink escapes, `..` traversal).
- E2E lives in REL-2. Modules add E2E cases there only when their brief says so.

## Security & privacy
- Keys are stored only in VS Code SecretStorage and passed to the orchestrator over RPC on demand. They're never in env, logs, or files.
- Shell tool: workspace-confined cwd, scrubbed env, timeout, output cap, process-group kill.
- Webviews use a strict CSP and no remote resources. Messages to and from webviews are zod-validated.
- Report vulnerabilities per `SECURITY.md` (REL-3).

## Performance budgets
| Metric | Budget |
|---|---|
| Extension activation | < 150 ms (lazy, no orchestrator spawn until first use) |
| Orchestrator cold start | < 500 ms |
| Desiide overhead on first model token | < 100 ms beyond provider latency |
| Jev decision | p95 < 1.5 s, else fall back to rules |
| Webview first paint | < 300 ms |

## UX & accessibility
- Everything is reachable by keyboard, has visible focus, and ARIA labels on icon buttons.
- Colors come from VS Code theme variables plus Desiide accent tokens (UI-1). Test in dark, light, and high-contrast themes.
- Motion is subtle, under 250 ms, and honors `prefers-reduced-motion`.
- Show decisions as structured labels and numbers; keep the prose short.
