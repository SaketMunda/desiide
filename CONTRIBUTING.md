# Contributing to Desiide

Thanks for wanting to help. Desiide is an AI IDE that runs on people's machines and touches their code, so we're strict about what gets merged. This page tells you how to get a change in and what every change is checked for.

## Before you start

- **Bugs and ideas:** open an [issue](https://github.com/SaketMunda/desiide/issues) first. For anything bigger than a small fix, wait for a reply before writing code. It saves you building something we can't take.
- **Security problems:** don't open a public issue. See [SECURITY.md](SECURITY.md).
- **Where work comes from:** features are organized as modules in [`roadmap/modules/`](roadmap/modules). Each brief has the scope and acceptance criteria. If your change touches a module, read its brief.
- **How the code is laid out, and the project's hard rules:** [CLAUDE.md](CLAUDE.md) and [roadmap/STANDARDS.md](roadmap/STANDARDS.md). The rules are short; please read them.

## Making a change

1. Fork the repo and branch from `master`. Name it `mod/<ID>-<slug>` for module work, or `fix/…`, `docs/…`, `chore/…`.
2. Set up: Node 24 (see `.nvmrc`) and pnpm 12, then `pnpm install`.
3. Make the change, with Vitest tests for any package change.
4. Run `scripts/verify.sh` (typecheck, lint, tests). It must be green.
5. Open a pull request and fill in the template.

UI work follows [brand/EXPERIENCE.md](brand/EXPERIENCE.md). Desiide should feel playful and calm, a place developers enjoy coding in. "Works but feels like a job screen" isn't done.

## How a pull request gets merged

Nobody pushes to `master` directly, maintainers included. Every change goes through a pull request:

1. **Automatic checks** must pass: `verify` on Linux, macOS and Windows, `ci-lint` (workflow and shell lint), and `dependency-review` (blocks new dependencies with known vulnerabilities).
2. **The review agent** (`review` workflow) reads the diff and comments on security, the project rules above, and bugs. It runs on pull requests from branches in this repo. Pull requests from forks don't get it, because GitHub doesn't share secrets with forks and we never work around that. A maintainer reviews those by hand, with the same checklist.
3. **A code owner approves** ([CODEOWNERS](.github/CODEOWNERS)). The approval is dropped if you push again, so the last push is always reviewed.

The review agent gives advice. A maintainer makes the call. It can read files and post comments, nothing else: it can't edit, push, install or run anything.

## Security rules for every change

Changes that break these are closed, however useful they look.

**Dependencies**
- Every new dependency needs a reason in the PR description. Prefer the standard library or code we already have.
- No dependency may run install scripts unless it's added to `allowBuilds` in `pnpm-workspace.yaml`, and adding one needs a maintainer's agreement.
- pnpm refuses package versions that are under 24 hours old, and versions published with weaker provenance than earlier ones (`minimumReleaseAge`, `trustPolicy`). Don't relax these to make an install pass. If a package is flagged, say so in the PR, and a maintainer decides whether to exempt that exact version, with a written reason.
- Commit lockfile changes only when they come from your own `pnpm install`, and keep them in the same PR as the `package.json` change that caused them.

**Code**
- No obfuscated, encoded or minified source. No `eval`, `new Function`, or requiring a computed path.
- No new network destinations. Desiide only talks to endpoints the user configured, and never sends telemetry.
- Never read files outside the workspace, environment secrets, SSH keys, or browser or keychain data.
- No committed binaries, archives or generated bundles. Build them in CI.

**CI and build**
- Changes to `.github/`, `scripts/`, `editor/` or `package.json` scripts get the strictest review. Explain them in the PR.
- Pin every GitHub Action to a full commit SHA, with the version as a comment.
- Never use `pull_request_target`. Never print secrets.

## Commits

Conventional style: `feat(UI-6): …`, `fix(site): …`, `docs: …`. Keep pull requests to one topic.

## Licensing

By contributing you agree your work is dual licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), like the rest of Desiide's code (ADR-013).

## Conduct

Be kind and assume good faith. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
