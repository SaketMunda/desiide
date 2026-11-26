# UI-7 · Studio theme, icon & motion

**Status:** in-progress · **Milestone:** Alpha · **Size:** M · **Depends on:** UI-1, EDT-1 · **Skills:** ide-editor-shell

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

_(filled by the build session)_
