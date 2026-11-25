# Desiide brand

The **logo** is two colors, one wordmark, one mark (ADR-016). Everything around it (site, app, webviews) follows the **Midnight Maker** direction in [EXPERIENCE.md](EXPERIENCE.md) (ADR-023).

## Logo colors

| Name | Hex | Use |
|---|---|---|
| **Ink** | `#131313` | Type on paper; the ground of every dark surface (app icon, avatar, banners) |
| **Paper** | `#ECEDE8` | Type on ink; the ground of every light surface |

The logo never uses a third color.

## Product palette (ADR-023)

| Token | Hex | Role |
|---|---|---|
| Midnight | `#0A0C12` | Page / app ground |
| Surface → Raise | `#121624` → `#1F2537` | Panels, cards, popovers (tinted, never pure black) |
| Paper | `#ECEDE8` | Primary text |
| Muted / Dim | `#9AA1B4` / `#626A80` | Secondary text, metadata |
| **Electric lime** | `#C6FF3D` | Brand accent: primary action, done, approve |
| Violet | `#9C8CFF` | Decisions, routing |
| Cyan | `#5CE1E6` | Running, info, types |
| Amber | `#FFB547` | Needs you: asks, reviews, strings |
| Red | `#FF6B6B` | Blocked, removed |

Text on lime is `#11140A`. Glow is a highlight for one thing at a time, never a default border.

## Wordmark

`wordmark-ink.svg` / `wordmark-paper.svg`: DESIIDE in a high-contrast stencil serif. The stem of each D, E and I is cut from its bowl or arms. Traced from the master artwork and kept as a single path, so it needs no font.

- Clear space: the height of the stem cut (about ⅛ of the cap height) on every side, at least.
- Minimum width: 96 px on screen. Below that, use the mark.
- Don't recolor, outline, stretch, add effects, or set it in another font.

## Mark

`mark-ink.svg` / `mark-paper.svg`: the wordmark's own D. Use it where the wordmark won't fit: app icon, favicon, avatars, the activity bar.

| File | What it's for |
|---|---|
| `app-icon-glossy.svg` | **The app icon.** OS-style glossy tile, paper D on ink, faint lime rim |
| `app-icon.svg` | Flat app icon (macOS grid: 824 px tile, 185 px radius on a 1024 canvas) for print and tiny sizes |
| `app-icon-light.svg` | Light variant (ink D on paper) for light docks, store listings, print |
| `favicon.svg` | Browser tab (64 px, rounded) |
| `social/avatar.svg` | Profile picture on X, LinkedIn, YouTube, Instagram, GitHub (full bleed; platforms crop it to a circle) |

## Type (web and marketing)

| Role | Face | Notes |
|---|---|---|
| Display | Bricolage Grotesque 700–800, condensed (`font-stretch` 78–85%), tight tracking | Oversized headlines. The wordmark stays the only serif |
| Body / UI | Geist 400–500 | |
| Technical | Geist Mono 400/500 | Code, terminals, labels, data. Uppercase labels get 0.14em tracking |

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
