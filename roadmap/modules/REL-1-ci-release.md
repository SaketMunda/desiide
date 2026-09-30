# REL-1 · CI & release pipelines

**Status:** todo · **Milestone:** Alpha (verify + app release), Beta (extension publish) · **Size:** L · **Depends on:** FND-1; EDT-1 + EDT-2 for app releases · **Skills:** ide-editor-shell

## Purpose
Repeatable, low-effort releases, so shipping is a tag push rather than a ritual.

## Scope
**Alpha** (app-first, ADR-011)
- `verify.yml` hardening (cache pnpm, matrix macOS + Linux + Windows for packages/extension tests).
- `release-app.yml` on tag `app-v*`: verify → build `desiide-ai` → `scripts/build-editor.sh` (with `desiide-ai` built in, per EDT-2) for macOS arm64 + x64 (dmg, zip) and Linux x64 (deb, AppImage, tar.gz) → GitHub Release with SHA-256 checksums. Tags with `-alpha`/`-beta` are marked pre-release. Builds are unsigned; the release notes carry the first-launch step.
- `upstream-sync.yml` (weekly): check for a new VSCodium tag → bump the submodule on a branch → try the build → open a PR with the result.
- Version source of truth: the app tag for the app; `extensions/desiide-ai/package.json` for the extension. Changelog from Conventional Commits.

**Beta**
- `release-extension.yml` on tag `ext-v*`: verify → build → `vsce package` → publish to the **VS Code Marketplace** and **Open VSX** → attach the `.vsix` to a GitHub Release. Pre-release channel via `--pre-release` for `-alpha`/`-beta` tags.

**1.0:** Windows, signing + notarization (needs the Apple Developer account, open decision #4).

**Needs from the user:** nothing for Alpha (the built-in `GITHUB_TOKEN` is enough). By Beta: Marketplace publisher PAT (`VSCE_PAT`) and Open VSX token (`OVSX_PAT`), as repo secrets.

## Acceptance criteria
1. An app tag on a fork produces launchable macOS (arm64, x64) and Linux x64 artifacts with SHA-256 checksums, attached to a GitHub Release (pre-release for `-alpha` tags).
2. The upstream-sync job runs once (manual dispatch) and either opens a bump PR with a build result or reports that there's no new tag.
3. (Beta) A dry-run `ext-v*` tag produces a `.vsix` and skips publishing when secrets are absent; a pre-release tag publishes as pre-release on both registries (verified once for real before Beta).

## Handoff notes
_(filled by the build session)_
