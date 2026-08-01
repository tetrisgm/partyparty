# PartyParty × Apple - design system

**Rule: "Apple's SYSTEM, our CONTENT."** Adopt Apple's structure wholesale (SF type
scale, 4/8-pt grid, semantic light+dark tokens, concentric squircle radii, ONE
restrained accent, hairline separators, generous whitespace, a single Liquid-Glass
layer on floating chrome only, short spring-out motion). Keep PartyParty's nightlife
energy where energy belongs: the **photography, the copy, and one brand accent**
(PartyParty pink). Nothing else is tinted.

Three surfaces share these tokens:
- **Landing page** (`site/index.html`) - product/download information only.
- **App console** (`web/dj.html`, macOS WKWebView) - stays **dark** (DJ booth), macOS
  13px type ladder, one Liquid-Glass surface (the sticky Go-Live bar). ⬜ to do.
- **Guest player** (`web/listener.html`) - dark, iOS 17px/44px ladder. ⬜ to do.

## Fonts (licensing matters)
- **Public web / guest phone browser:** `-apple-system, BlinkMacSystemFont, "SF Pro
  Display", "SF Pro Text", "Inter", "Helvetica Neue", Helvetica, Arial, system-ui,
  sans-serif`. Apple devices resolve to real SF *before* Inter loads; non-Apple gets
  self-hosted **Inter** (SIL OFL, `site/fonts/inter.woff2`, preloaded).
- **In-app WKWebView:** system stack only (`-apple-system, BlinkMacSystemFont,
  system-ui`) - ship NO webfont; real SF is on-device, free, legal.
- **HARD RULE:** never `@font-face`/self-host San Francisco on the public site - the SF
  license forbids website use (apple.com may only because Apple owns it). Inter is the
  legal fallback (`site/fonts/OFL-Inter.txt`).
- Sizes in `rem` (root 16px) so OS text-scaling works. `font-synthesis:none`.

## Type scale
Headlines are **always Semibold (600)** with **negative tracking that grows with size**;
captions/eyebrows use near-zero or slightly positive tracking. Never 700/800.

| Use | Size | Weight | Tracking | Line |
|---|---|---|---|---|
| Hero display (landing) | `clamp(40px,6vw,80px)` | 600 | -0.025em | 1.05 |
| Section headline | `clamp(32px,4vw,48px)` | 600 | -0.02em | 1.08 |
| Sub headline | `clamp(24px,2.6vw,32px)` | 600 | ~0 | 1.125 |
| Lede | 19px | 400 | +0.012em | 1.42 |
| Body (web + guest) | 17px | 400 | -0.011em | 1.47 |
| Small / secondary | 14px | 400 | -0.016em | 1.43 |
| Eyebrow (uppercase) | 12px | 600 | +0.06em | 1.33 |
| **Console** large title | 26px | 600 | -0.015em | 1.23 |
| **Console** card header | 17px | 600 | -0.01em | 1.29 |
| **Console** body (base) | 13px | 400 | -0.006em | 1.31 |
| **Console** caption/hint | 11px | 400 | 0 | 1.27 |
| Mono (ffmpeg log) | 12px | 400 | 0 | 1.5 |

Landing uses the marketing ladder (17px body / huge display); console uses the macOS
Dynamic-Type ladder (13px body / 26px title) so it feels like a native Mac window, not
a blown-up phone; guest page uses the iOS ladder (17px body / 44px targets).

## Color tokens
**Light:** `--bg #fff` · `--bg-secondary #f5f5f7` · `--bg-tertiary #fbfbfd` ·
`--label #1d1d1f` · `--label-secondary #6e6e73` · `--label-tertiary #86868b` ·
`--separator #d2d2d7` · `--fill rgba(120,120,128,.12)` · `--link #0066cc` ·
`--accent #ff2d6f` · `--accent-hover #f5215f` · `--success #34c759` ·
`--warn #ff9500` · `--danger #ff3b30` · `--glass-bg rgba(255,255,255,.72)`.

**Dark:** `--bg #000` · `--bg-elevated #1c1c1e` · `--bg-elevated-2 #2c2c2e` ·
`--label #f5f5f7` · `--label-secondary #86868b` · `--label-tertiary #6e6e73` ·
`--separator rgba(255,255,255,.10)` · `--fill rgba(120,120,128,.24)` ·
`--link #2997ff` · `--accent #ff3b7f` · `--glass-bg rgba(28,28,30,.62)`.

Accent = **primary action only** (CTA fill + a couple highlight words). Standard links
use **system blue** (`--link`). Status colors are semantic only.

## Spacing / radii
- **Spacing:** 4/8-pt scale (`4,8,12,16,20,24,32,40,48,64,80,96,120`). Landing section
  padding `clamp(80px,10vw,120px)`; text column ~980px (imagery can go full-bleed);
  gutter 20–24px. Console: 680px column, 20px card padding, 24px card gap, 14px field
  gap, 6px label-to-control.
- **Radii (squircle ladder):** `--r-xs 8` (chips) · `--r-sm 10` (console controls/fields)
  · `--r-md 12` (cards/tiles) · `--r-lg 18` (feature tiles/sheets) · `--r-xl 24–28`
  (hero cards/windows) · `--r-pill 980px` (landing CTAs). **Concentricity: inner =
  outer − padding** (don't give a nested element its container's radius). Progressive
  enhancement: `corner-shape:superellipse(2)` (real squircles on Chromium 139+, graceful
  fallback elsewhere). Landing CTAs are full pills; **console buttons are 10px
  rounded-rect (macOS), not pills.**

## Materials - Liquid Glass
ONE glass layer per view, on **floating chrome only** (nav, sticky Go-Live bar). Never on
content cards, never glass-on-glass.
- **Light glass:** `background:rgba(255,255,255,.72); backdrop-filter:blur(20px)
  saturate(180%); border-bottom:1px solid var(--separator); box-shadow:inset 0 1px 0
  rgba(255,255,255,.7),0 1px 0 rgba(0,0,0,.04)`. The `saturate(180%)` = the "vibrancy"
  tell; the inset top highlight = the specular edge.
- **Dark glass:** `background:rgba(28,28,30,.62); backdrop-filter:blur(24px)
  saturate(170%); border-top:1px solid rgba(255,255,255,.12); box-shadow:inset 0 1px 0
  rgba(255,255,255,.10),0 -8px 32px rgba(0,0,0,.45)`.
- Blur 16–30px max; keep text ≥4.5:1 over glass. **Fallbacks required:**
  `@supports not (backdrop-filter:blur(1px))` → opaque; `@media
  (prefers-reduced-transparency:reduce)` → opaque; `@media (prefers-contrast:more)` →
  opaque + solid border.

## Motion
Transform/opacity only, short + spring-ish. Easings: `--ease-apple
cubic-bezier(.4,0,.6,1)` (reveals/nav), `--ease-out cubic-bezier(.25,.1,.25,1)`,
`--ease-spring cubic-bezier(.34,1.56,.64,1)` (glass press only). Durations: hover
150–200ms · control 250–350ms · sheet 400–500ms · scroll reveal 500–700ms. Hover =
`translateY(-1px)+brightness(1.03)` (NOT -2px + growing colored glow). Scroll reveal =
opacity 0→1 + translateY(24→0), 600ms, IntersectionObserver, stagger 60–120ms. **Wrap
everything in `@media (prefers-reduced-motion:reduce)`.**

## Components (highlights)
- **Nav:** transparent over the black hero (white text) → on scroll flips to light glass
  + `#1d1d1f` text + hairline. Brand 17–19px/600.
- **Primary CTA (landing):** full pill, `--accent` fill, 17px/600, min 44px, hover
  brightness+1px lift, **no drop-shadow glow**. Ghost = 1px `--separator` border pill.
  Text link = "How it works ›" in `--link`, underline on hover.
- **Tile/bento:** flat `--bg-secondary` fill, 12px squircle, hairline only, **no shadow**,
  inner image radius < tile radius.
- **vs block:** flat hairline-separated rows with a `--success` check + bolded lead - not
  bordered boxes.
- **Console card:** `--bg-elevated`, 1px `--separator`, 12px radius, 20px padding, 24px
  gap; header 17px/600; controls 28–32px tall, 10px radius, `--fill`. Tab active-underline
  in `--accent`. Status badges: pill, semantic tint ~18%.
- **Console Go-Live bar:** the ONE glass surface (dark glass recipe), fixed bottom, 680px
  inner, full-width button 52px / 12px radius, `--success` green ↔ `--danger` red.
- **Guest player:** keep the big circular tap-to-play (200px) + dark radial bg; idle
  neutral/`--accent`, playing `--success` pulse; 44px targets; keep the 🔒 locked-phone
  line + Media Session.
- **Footer:** light, hairline top, `--label-tertiary` 12–14px, flat/minimal.

## Pitfalls (the "fake Apple" tells - avoid)
Multi-color gradients as primary language · Bold 700/800 headlines · loose/positive
tracking on big type · cramped whitespace / too-wide columns · heavy borders + drop
shadows + gradient card fills · tiny-radius fake squircles / broken concentricity ·
glass-on-glass or glass everywhere / blur >30px · `@font-face` SF on the web · consumer
hover (big lifts + colored glow + bouncy easings) · missing a11y guards / <44px phone
targets / 44px controls on macOS (should be 28px) · tinting everything (tint is
semantic - primary action only).

_Derived from an Apple-HIG / Liquid-Glass (iOS·macOS 26) / apple.com research pass. The
landing page implements this; the console + guest page are next._
