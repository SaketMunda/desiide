# Desiide brand

Two colors, one wordmark, one mark. That's the whole system (ADR-016, revised 2026-11-25).

## Colors

| Name | Hex | Use |
|---|---|---|
| **Ink** | `#131313` | Type on paper; the ground of every dark surface (app icon, avatar, banners) |
| **Paper** | `#ECEDE8` | Type on ink; the ground of every light surface |

There is no third brand color. For hierarchy, use ink or paper at an opacity (muted text ≈ 62%, hairlines ≈ 16%, washes ≈ 5%). Never use a grey hex. Inside the editor, semantic colors (error red, diff green) are UI states, not brand colors.

## Wordmark

`wordmark-ink.svg` / `wordmark-paper.svg`: DESIIDE in a high-contrast stencil serif. The stem of each D, E and I is cut from its bowl or arms. Traced from the master artwork and kept as a single path, so it needs no font.

- Clear space: the height of the stem cut (about ⅛ of the cap height) on every side, at least.
- Minimum width: 96 px on screen. Below that, use the mark.
- Don't recolor, outline, stretch, add effects, or set it in another font.

## Mark

`mark-ink.svg` / `mark-paper.svg`: the wordmark's own D. Use it where the wordmark won't fit: app icon, favicon, avatars, the activity bar.

| File | What it's for |
|---|---|
| `app-icon.svg` | App icon (macOS grid: 824 px tile, 185 px radius on a 1024 canvas). Paper D on ink |
| `app-icon-light.svg` | Light variant (ink D on paper) for light docks, store listings, print |
| `favicon.svg` | Browser tab (64 px, rounded) |
| `social/avatar.svg` | Profile picture on X, LinkedIn, YouTube, Instagram, GitHub (full bleed; platforms crop it to a circle) |

## Type (web and marketing)

| Role | Face | Notes |
|---|---|---|
| Display | Bodoni Moda 500, *italic* for emphasis | Echoes the wordmark's contrast. Headlines only |
| Body | IBM Plex Sans 400 | |
| Utility | IBM Plex Mono 400/500 | Labels, data, anything that's code. Uppercase labels get 0.14em tracking |

All three are OFL. The site self-hosts them (`site/fonts/`), so visitors' browsers never call Google.

## Social kit

Every file is an SVG source with a PNG rendered beside it, at the platform's size:

| File | Size | Where |
|---|---|---|
| `social/avatar.png` | 800 × 800 | All profile pictures |
| `social/x-header.png` | 1500 × 500 | X header |
| `social/linkedin-banner.png` | 1584 × 396 | LinkedIn banner |
| `social/youtube-banner.png` | 2560 × 1440 | YouTube channel art (wordmark sits in the 1546 × 423 safe area) |
| `social/og-image.png` | 1200 × 630 | Link previews (also `site/og-image.png`) |

Tagline on banners: **THE OPEN-SOURCE AI IDE · YOUR MODELS · EVERY DECISION VISIBLE**. Sign-off: *Let's build something real.*

## Regenerating

```sh
node brand/render.mjs   # re-renders every PNG from its SVG (uses the repo's playwright-core)
```

## Voice

Calm, direct, specific. Lead with what the reader can use; Desiide is the proof, never the headline. No hype words, no emoji as decoration.
