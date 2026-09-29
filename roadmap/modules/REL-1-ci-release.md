# REL-1 · CI & release pipelines

**Status:** todo · **Milestone:** Alpha (verify + extension publish), Beta (app builds) · **Size:** M · **Depends on:** FND-1; EDT-1 for app builds · **Skills:** ide-editor-shell

## Purpose
Repeatable, low-effort releases, so shipping is a tag push rather than a ritual.

## Scope
**Alpha**
- `verify.yml` hardening (cache pnpm, matrix macOS + Linux + Windows for packages/extension tests).
- `release-extension.yml` on tag `ext-v*`: verify → build → `vsce package` → publish to the **VS Code Marketplace** and **Open VSX** → attach the `.vsix` to a GitHub Release. Pre-release channel via `--pre-release` for `-alpha`/`-beta` tags.
- Version source of truth: `extensions/mutt-ai/package.json`. Changelog from Conventional Commits.

**Beta**
- `release-app.yml` on tag `app-v*`: build the fork for macOS arm64/x64 (dmg, zip) and Linux x64 (deb, AppImage, tar.gz). Upload with SHA-256 checksums.
- `upstream-sync.yml` (weekly): check for a new VSCodium tag → bump the submodule on a branch → try the build → open a PR with the result.
- Windows + signing + notarization: 1.0 (needs the Apple Developer account, open decision #4).

**Needs from the user:** Marketplace publisher PAT (`VSCE_PAT`), Open VSX token (`OVSX_PAT`), as repo secrets.

## Acceptance criteria
1. A dry-run tag on a fork produces a `.vsix` artifact and skips publishing when secrets are absent.
2. A pre-release tag publishes as pre-release on both registries (verified once for real before Alpha).
3. (Beta) An app tag produces launchable macOS + Linux artifacts with checksums.

## Handoff notes
_(filled by the build session)_
