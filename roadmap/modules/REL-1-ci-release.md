# REL-1 · CI & release pipelines

**Status:** review · **Milestone:** Alpha (verify + app release), Beta (extension publish) · **Size:** L · **Depends on:** FND-1; EDT-1 + EDT-2 for app releases · **Skills:** ide-editor-shell

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
**Built (branch `mod/REL-1-ci-release`; fork `desiide` @ `bd475dd`):**
- **`verify.yml`** (hardened): a matrix of `ubuntu-latest`, `macos-latest`, and `windows-latest` running `scripts/verify.sh` (bash on all three), with the pnpm store cached. It's reusable (`workflow_call`), so release workflows run the same gate. A new `ci-lint` job runs `actionlint` (pinned, checksum-verified) and `shellcheck --severity=warning` over `scripts/`. All actions are pinned by commit SHA. A new `.gitattributes` (`eol=lf`) keeps Windows checkouts from failing `prettier --check`.
- **`release-app.yml`** (tag `app-v<semver>`, or "Run workflow" with an existing tag) runs: parse tag → `verify` → build per target (`darwin-arm64` on `macos-15`, `darwin-x64` on `macos-15-intel`, `linux-x64` on `ubuntu-22.04`) → `build-editor.sh` → `package-app.sh` → `smoke-app.sh` → upload → one `release` job that writes `SHA256SUMS` over every asset, generates notes, and creates or updates the GitHub Release (pre-release when the tag has a suffix). **PRs that touch the build or packaging run it as a dry run** (version `0.0.0-pr.<n>`, no `verify` duplicate, no release job).
- **`scripts/package-app.sh <version> [out]`** produces:
  - macOS: `Desiide-<v>-darwin-<arch>.dmg` (drag-to-Applications layout) and `.zip` (`ditto`). Both are ad-hoc signed, because packaging edits `Info.plist` after Electron's own signature.
  - Linux x64: `.tar.gz` (top-level folder), `.deb` (upstream gulp tasks), and `Desiide-<v>-linux-x86_64.AppImage`. The AppImage uses `appimagetool` 1.9.1 and the type2 runtime, pinned by SHA-256 (matching GitHub's published digests), with no update information embedded.
- **`scripts/smoke-app.sh <version> [dist]`** installs every asset the way a user would and runs EDT-2's first-launch suite (`test:app`) against each one:
  - macOS: mount the dmg, check the Applications link, copy the app out, quarantine it, take the documented `xattr` step, `codesign --verify`, launch. Then the same launch from the unzipped zip.
  - Linux: tar.gz, extracted AppImage, and the `.deb` via `apt-get install`. For the `.deb` it also asserts the install registered no Microsoft apt repo.
- **`scripts/lib/editor-env.sh`**: platform detection plus `use_editor_node`, shared by `build-editor.sh` and `package-app.sh` (moved out of `build-editor.sh` unchanged).
- **`upstream-sync.yml`** (Mondays 06:17 UTC, plus manual dispatch):
  - Compares VSCodium's latest release with `base-version` and writes "no new release" to the job summary when there's nothing to do.
  - Otherwise it merges the release tag into fork branch `sync/vscodium-<tag>`, updates `base-version`, runs `check-editor-patches.sh`, builds, and runs `test:app`.
  - It pushes the fork branch (needs `EDITOR_FORK_TOKEN`) and opens or updates a bump PR here with a results table (draft if any step failed). On a merge conflict it opens or comments on an issue listing the conflicted files instead.
- **`release-extension.yml`** (Beta; tag `ext-v<semver>`): `verify` → check the tag's `x.y.z` equals `package.json`'s version → `vsce package` (`--pre-release` for suffixed tags) → `vsce publish` if `VSCE_PAT` is set → `ovsx@1.2.0 publish` if `OVSX_PAT` is set → GitHub Release with the `.vsix`. A missing secret is reported as "skipped" in the summary, not as a failure.
- **`scripts/release/`** (TypeScript run directly by Node 24, tested in the new Vitest `scripts` project, typechecked by `tsconfig.tooling.json`):
  - `tag.ts`: tag → kind/version/pre-release; checks the extension version.
  - `notes.ts`: release notes with install / first-launch steps, plus a Conventional Commits changelog since the previous tag of the same kind (extension notes only cover `extensions/desiide-ai` and `packages/`).
  - `upstream.ts`: VSCodium version comparison.
- **Fork (`editor/patches/desiide/apply.sh`, step 4):** the `.deb` never registers Microsoft's apt repository. See Deviations.
- **Skill:** `ide-editor-shell` got "Releasing (REL-1)" and the automated part of "Upstream sync".

**Evidence:**
1. **AC1 (app tag → launchable artifacts + checksums + Release):**
   - **Local, macOS arm64 (M4 Pro).** `build-editor.sh` built the app in 4 min, and `package-app.sh 0.0.0-local` produced the `.dmg` (355 MB) and `.zip` (305 MB) in 37 s.
   - `smoke-app.sh` then passed for both: dmg → Applications link present → quarantined → `xattr` step → `codesign --verify --deep --strict` OK → `test:app` gave `builtIn: true`, `readyViews: [decisions, panel]`, `welcomeOpened: true`, `focusCommand: true`. The unzipped zip gave the same result.
   - A plain launch of the quarantined dmg copy, after the `xattr` step, also started cleanly (10 processes, `desiide-ai` activated).
   - **CI:** `darwin-x64`, `linux-x64` (tar.gz, AppImage, `.deb` + the no-Microsoft-repo assertion), and `darwin-arm64` on GitHub runners run in this PR's `release-app` dry run. See the PR checks.
   - **Checksums, pre-release, and Release publishing** run on the first real `app-v*` tag. The logic they rely on is unit-tested: `release.test.ts` covers tag → pre-release, release notes, and the changelog.
2. **AC2 (upstream sync):** VSCodium's latest release is `1.135.06055`, which is already `base-version`, so the run takes the "no new tag" path. Locally, `node scripts/release/upstream.ts 1.135.06055 editor/patches/desiide/base-version` prints `newer=false`. The `check` job writes "No new VSCodium release…" to the summary. `workflow_dispatch` only appears once the workflow is on `master`, so the one manual run happens right after merge. `check-editor-patches.sh 1.135.0` passes all four checks, including the new `.deb` guard anchor.
3. **AC3 (Beta, extension):**
   - `tag.ts ext-v0.0.1-beta --package …` → `prerelease=true`. A mismatched tag fails with "bump package.json to X, or tag ext-vY".
   - `vsce package --pre-release` → `.vsix` (42 files, 496 KB) whose manifest has `PreRelease = true`.
   - With no `VSCE_PAT`/`OVSX_PAT`, both publish steps report "skipped". Publishing for real waits on the registry accounts (ADR-015).
- `actionlint` 1.7.12 (with shellcheck) passes on all four workflows. `shellcheck --severity=warning` passes on `scripts/`. `verify.sh` is green (1769 tests, including 25 new ones in `scripts/release/release.test.ts`).
- **`test:app` timing:** the first launch of freshly signed code took 19–25 s before the panel webview reported ready, which hit the suite's 20 s wait twice. Warm launches take ~1 s. The wait is now 60 s.

**Deviations:**
- **Privacy fix in the fork, found while packaging.** Upstream's `.deb` postinst adds `packages.microsoft.com/repos/code` (plus its key) for every package name except `code-oss`. VSCodium only rewrites that exception to `codium`, so a `desiide` package would have registered Microsoft's VS Code repo on every install, and `apt update` would then contact Microsoft. `apply.sh` step 4 makes the check never match and fails the build if upstream rewords it. `check-editor-patches.sh` checks the anchor line, `package-app.sh` refuses a `.deb` without the guard, and `smoke-app.sh` asserts that `/etc/apt` is unchanged after install.
- **Upstream sync needs one secret, `EDITOR_FORK_TOKEN`.** The brief says Alpha needs only `GITHUB_TOKEN`, but `GITHUB_TOKEN` can't push to another repository (`SaketMunda/desiide-vscodium`). Without the secret, the "no new release" path and the merge/patch/build checks all work, and the push step fails with an actionable error. Use a fine-grained token with Contents read/write on the fork only. The repo setting "Allow GitHub Actions to create and approve pull requests" must also be on for the bump PR.
- **The release dry run on PRs isn't in the brief.** It's the only way to exercise the full pipeline on real runners without publishing a release, and it keeps protecting packaging after this module.
- **One `SHA256SUMS` file** instead of per-file `.sha256` files: it's the convention `shasum -c` / `sha256sum -c` expect.
- **The app version is the tag, in asset names and the release only.** Inside the app, `About` still shows the VSCodium base (`1.135.06055`), because that's what extension compatibility and upstream builds key on. See Follow-ups.
- **EDT-2's `test:app` suite (`test/app/suite.cjs`), two test-only fixes:**
  - Its built-in check matched only macOS's `Resources/`. It now matches case-insensitively, so it passes on Linux's `resources/`.
  - Its wait went from 20 s to 60 s, for cold first launches (see Evidence).

**Known gaps:**
- **No release has been published yet.** The first real `app-v*` tag is the user's call (it creates a public pre-release). Until then, AC1's evidence is the PR dry run plus the local macOS run.
- **Unsigned builds:**
  - macOS needs the one-time `xattr -dr com.apple.quarantine` (in the release notes).
  - On Ubuntu 24.04+, AppArmor's user-namespace restriction can stop the AppImage's Chromium sandbox. The `.deb` is the recommended Linux install there.
  - The `.deb` maintainer field still says VSCodium (VSCodium's own `sed` runs after our hook). This is cosmetic, like EDT-1's remaining VSCodium strings.
- **The AppImage needs FUSE 2** (`libfuse2`). The release notes say so.
- **glibc ≥ 2.35** (Ubuntu 22.04 / Debian 12 and newer), because Linux builds on `ubuntu-22.04` without VS Code's sysroot.
- **Windows in the verify matrix** first failed on master (103 tests). Branch `fix/windows-verify` fixed it:
  - **Product (COR-3/COR-4):**
    - Timeout and cancel never killed anything on Windows. `process.kill(-pid)` is POSIX-only, so the fix kills the tree with `taskkill /T /F` while the process is running.
    - There's no post-exit reap on Windows, because PIDs get reused.
    - ripgrep printed `\` paths into workspace paths and the repo map; the fix passes `--path-separator /`.
  - **Tests:**
    - Fixture paths used `URL.pathname`.
    - POSIX file modes and signals.
    - Symlinks to `/etc`.
    - Process tests now run `node` instead of shell syntax.
  - **Still POSIX-only:** the tests that check shell syntax. Which shell the `shell` tool uses on Windows (cmd, PowerShell, Git Bash) is an open planning question, and it matters by Beta, when the standalone extension reaches Windows users.
- **AC3's "verified once for real before Beta"** needs the `desiide` publisher/namespace and the `VSCE_PAT`/`OVSX_PAT` secrets (ADR-015, user action).

**Follow-ups:**
- Show Desiide's own version in About (`product.json` overlay + a small patch), stamped from the tag by `release-app.yml`.
- REL-2: reuse `smoke-app.sh`'s "install like a user" step before the E2E suite.
- Upstream sync: add a workflow that fast-forwards the fork's `desiide` branch when a bump PR merges (today it's one documented command).
- 1.0: Developer ID signing + notarization (`package-app.sh` is where `codesign` goes), Windows packaging, and arm64 Linux.
