# EDT-1 · VSCodium fork & branding

**Status:** todo · **Milestone:** Beta (start in Wave 2; it runs in the background) · **Size:** M · **Depends on:** FND-1 · **Skills:** ide-editor-shell

## Purpose
A reproducible local build of the Mutt desktop app from our VSCodium fork, with our branding and no Mutt logic in the patches.

## Scope
- Fork `VSCodium/vscodium` → `SaketMunda/mutt-vscodium` (the user creates the fork, or it's done via `gh`). Add it as the `editor/` submodule of `mutt`, pinned to a VSCodium release tag.
- `editor/patches/mutt/` applied after VSCodium's patches, each with a header (purpose, files touched):
  - `01-branding.patch`: `product.json` `nameShort/nameLong` "Mutt", `applicationName` `mutt`, `dataFolderName` `.mutt-ide`, `urlProtocol` `mutt`, bundle IDs, placeholder icons (open decision #3).
  - Keep the Open VSX gallery (VSCodium default). Confirm no MS endpoints.
- `scripts/build-editor.sh`: wraps VSCodium's build with the right env vars and `nvm use` to its pinned Node.
- Document exact build commands, duration, and disk usage in the `ide-editor-shell` skill ("Building" section).

## Acceptance criteria
1. A clean build on macOS arm64 produces `Mutt.app` that launches, shows "Mutt" branding, and uses `~/.mutt-ide` for data (doesn't touch VS Code's or VSCodium's).
2. Installing an extension from Open VSX works.
3. `scripts/build-editor.sh` is idempotent (re-run doesn't re-clone unnecessarily).
4. The skill is updated with real numbers.

## Handoff notes
_(filled by the build session)_
