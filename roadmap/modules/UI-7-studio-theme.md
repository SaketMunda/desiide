# UI-7 · Studio theme, icon & motion

**Status:** review · **Milestone:** Alpha · **Size:** M · **Depends on:** UI-1, EDT-1 · **Skills:** ide-editor-shell

## Purpose

Make the app look and feel like Desiide, not a reskinned VS Code: the Midnight Maker direction (ADR-023, `brand/EXPERIENCE.md`) applied inside the IDE. "Personality outside. Focus inside."

**The bar:** playful and psychologically relaxing. A developer should open Desiide at 11pm and feel like they're in their own studio, not at work. If a screen is correct but joyless, it isn't done. See the "feeling" line at the top of `brand/EXPERIENCE.md`.

## Scope

**Theme (editor patch `01-default-theme.patch` + theme contribution)**

- **Desiide Midnight** (default): midnight surfaces, refined sidebars, tabs, panels and status bar using the ADR-023 palette. Lime marks the active tab and primary actions only.
- **Syntax theme:** violet keywords, cyan functions/types, amber strings, muted italic comments. Every token is ≥ 4.5:1 against the editor background.
- **Desiide Daylight:** a light variant with the same mapping, secondary.
- High contrast still works (VS Code's own HC themes plus our tokens).

**Design tokens for webviews (`extensions/desiide-ai`)**

- One token file shared by UI-2…UI-6: surfaces, text, the five state colors (lime done/approve, violet decision/routing, cyan running, amber needs-you, red blocked), radius, type (Geist / Geist Mono bundled locally, no network).
- Tokens read VS Code theme variables first, so a user's own theme still wins on base colors. Desiide's state colors stay.

**State treatments (shared components)**

- Thinking: shimmer text, collapses to "Thought for Ns".
- Routing/decision: violet chip with a probability bar and one soft pulse when it lands.
- Tool run: cyan spinner → lime check or red cross.
- Needs you (gate, review): amber border, primary button nudges gently until answered.
- Use the landing-page preview (`site/index.html`, `#preview`) as the visual reference.

**Brand in the app**

- App icon: `brand/app-icon-glossy.svg` replaces `editor/patches/desiide/icons/desiide-icon.svg`; re-run `icons/generate.sh`. Letterpress watermark, activity-bar icon (monochrome D) and extension icon follow.
- Welcome page: Desiide wordmark and tagline, no "Editing evolved".

**Motion**

- Under 250 ms, eased; one animation at a time per region; all off under `prefers-reduced-motion`.

## Acceptance criteria

1. A fresh profile opens in Desiide Midnight with the glossy icon in the Dock and the D watermark in empty editors.
2. A contrast test checks every syntax and UI text token against its background (≥ 4.5:1 for text, ≥ 3:1 for UI glyphs).
3. The five AI states render with the shared components in UI-3's Chromium harness, in Midnight, Daylight and HC (screenshots attached).
4. With reduced motion on, no animation runs (harness check).
5. No webview requests anything from the network for fonts or assets.
6. Vibe check: side-by-side screenshots (stock VS Code vs Desiide Midnight, empty editor + an agent run) attached to the PR, and the user signs off that it feels playful and calm, not like a reskin.

## Handoff notes

**Built (branch `mod/UI-7-studio-theme`; editor fork branch `ui-7-studio-theme`):**

- **Themes (`extensions/desiide-ai/themes/`):** `palette.ts` holds one palette per variant (Midnight, Daylight) and one mapping to ~300 VS Code theme keys and the syntax scopes. `pnpm -F desiide-ai themes` writes `desiide-midnight-color-theme.json` and `desiide-daylight-color-theme.json`; a test fails if they are stale, so the variants can't drift apart.
  - Midnight: `#0A0C12` chrome → `#0E111A` side → `#11141E` editor → `#181D2D`/`#1F2537` raised. Text `#ECEDE8`/`#C9CCD6`/`#9AA1B4`.
  - Lime only on primary buttons, the active tab, activity-bar/panel active markers and the cursor (a test pins that list). Selection, focus and lists use violet tints, like the site preview.
  - Syntax: violet keywords, cyan functions, mint-cyan types, amber strings, pink numbers/regex, muted italic comments.
  - Daylight uses the same mapping on paper-white surfaces, with darker state colors (lime stays the button fill with ink text; the active marker is olive `#4F7A00`).
  - High contrast: VS Code's own HC themes; the webview tokens add bright (or dark) state colors.
- **`01-default-theme.patch`:** defaults are now `Desiide Midnight` / `Desiide Daylight` (the old `Desiide Dark` / `Desiide Light` ids are gone; the app had no public release with them).
- **Webview tokens (`webview/ui/tokens.css`):** base colors read `--vscode-*` first. The five state colors are fixed per theme kind (`--desiide-state-done|decision|running|needs|blocked`). Selection is `--desiide-select` (violet). Older names (`--desiide-accent`, `-accent-jev`, `-outcome-*`) remain as aliases, so UI-2…UI-6 restyled without code changes.
  - Type: Geist (UI) and Geist Mono (chips, numbers, labels) bundled from `webview/ui/fonts/` (OFL licences ship in `dist/webview/`). Code keeps the user's editor font (`--desiide-font-code`).
  - Shape: radius 6 / 10 / 14. Motion: 120 / 200 / 240 ms.
  - `kit.css` turns every animation and transition off under `prefers-reduced-motion`.
- **State components (`webview/ui/states.tsx`, `stateLogic.ts`):**
  - `ThinkingLabel` (shimmer → "Thought for N s").
  - `DecisionChip` + `summarizeDecision` (violet chip with the headline probability and outcome tag; one pulse via `firstLanding`, only for a decision < 3 s old seen for the first time).
  - `RunMark` (cyan spinner, amber while waiting, a lime check that pops only if it finished on screen, red cross).
  - `NeedsYou` (amber card; `Button nudge` breathes until answered).
  - `BlockedNote` (calm red).
  - `Tone` gains the state names (`done`, `decision`, `running`, `needs`, `blocked`) next to the old ones.
- **Transcript (UI-3) now uses them:** Thinking, tool cards (`RunMark`), the decision slot (`DecisionChip`, no panel link yet), the approval slot (`NeedsYou`, no buttons yet). Also: user turns are right-aligned bubbles, and errors get a soft red edge instead of a red border.
- **Brand in the app (editor fork):**
  - `icons/desiide-icon.svg` = `brand/app-icon-glossy.svg`. `icons/generate.sh` regenerates the `.icns`/Linux/server icons, the product icon, and the extension's `media/icon.png`.
  - The letterpress (quiet: paper at 9% on dark) and the activity-bar `media/desiide.svg` now come from `brand/mark-paper.svg`.
  - New `03-welcome-wordmark.patch` + overlay `desiide-wordmark.svg`: the Welcome page shows the DESIIDE wordmark (CSS mask in the theme foreground; the name stays as text for screen readers) and "Vibe code, with receipts."
- **Harness and tools:**
  - `test/webview/states.mjs` (part of `test:webview`).
  - `scripts/webview-themes.mjs` (shared theme colors for the harness and `screenshots.mjs`).
  - `scripts/vibe-check.mjs`: window-only screenshots of stock VS Code vs the built app, with a real Ollama run.
  - `test/app/suite.cjs` asserts the default theme.

**Public API:** `webview/ui` exports `ThinkingLabel`, `DecisionChip`, `RunMark`, `NeedsYou`, `BlockedNote`, `summarizeDecision`, `firstLanding`, `thinkingLabel`, and `Button`'s `nudge` prop. Tokens: `--desiide-state-*`, `--desiide-select`, `--desiide-lime`/`-lime-ink`, `--desiide-font-mono`/`-font-code`, `--desiide-radius-lg`, `--desiide-motion-slow`.

**Evidence**

1. **AC1:** `pnpm -F desiide-ai test:app` on a brand-new profile: `"colorTheme":"Desiide Midnight","themeKind":2` (asserted in `test/app/suite.cjs`). Dock icon: the built bundle's `Desiide.app/Contents/Resources/Desiide.icns` renders the glossy D (`.screenshots/vibe/desiide-dock-icon.png`). Watermark: `.screenshots/vibe/desiide-empty.png`.
2. **AC2:** `src/themes.test.ts`: 53 text pairs at 4.5:1 and 22 glyph pairs at 3:1 per theme (translucent colors blended onto their surface), every syntax and semantic token (comments included) at 4.5:1, and terminal ANSI colors. 160 tests.
3. **AC3:** `test/webview/states.mjs` renders all five states in the showcase and live in the task stream (thinking → decision pulse → running → needs you → done pop / blocked) in Midnight, Daylight and High Contrast. Screenshots: `.screenshots/states-{desiide-midnight,desiide-daylight,high-contrast}-{showcase,stream}.png`.
4. **AC4:** the same harness with `reducedMotion: 'reduce'`: `document.getAnimations()` is 0 in the showcase, while thinking and while tools run (7 / 2 / 5 without it).
5. **AC5:** the harness answers only the webview origin, aborts and records anything else, and asserts no request left it. It also checks that Geist and Geist Mono load from `dist/webview/`, with no CSP violations under the real CSP.
6. **AC6:** `scripts/vibe-check.mjs`: `.screenshots/vibe/side-by-side-{empty,run}.png` (stock VS Code "Dark 2026" with the desiide-ai `.vsix` vs the built Desiide app, the same "Try it" run on `qwen3.5:2b`). **Awaiting the user's sign-off.**

**Deviations**

- **Contrast categories:** "UI glyphs" at 3:1 includes line numbers, inactive tabs/titles, placeholders and disabled text. These are inactive or non-essential text under WCAG. Everything else, including every syntax token and comments, is tested at 4.5:1.
- **Long-running indicators loop:** spinner, thinking shimmer, the needs-you nudge (a ~220 ms glow every 2.8 s) and the running pill. "Under 250 ms" is applied to each movement, not to the loop. All are off under reduced motion.
- **One decision landing is one "animation" made of three properties** (rise + ring + bar fill, all ≤ 240 ms).
- **The tool's approval wait** shows an amber `RunMark` (`waiting`) in the tool card, so the card can pop to done when the user approves.
- **Stock VS Code applies a development extension's own theme** (`--extensionDevelopmentPath`). That's why the vibe check installs the `.vsix`. Users who install desiide-ai from a gallery are not affected.

**Known gaps**

- No Desiide HC theme (by design: VS Code's HC + our tokens).
- The welcome tagline is English-only (new localize key).
- The webview shimmer uses gradient text, which is turned off in HC.

**Follow-ups**

- UI-4: give the approval card's primary button `nudge` while unanswered, and use `NeedsYou` / `RunMark`.
- UI-5: pass `onClick` to `DecisionChip` for the panel link.
- Optional opt-in "Afterhours" ambient touches in the IDE (EXPERIENCE.md) were not in this brief's scope.
