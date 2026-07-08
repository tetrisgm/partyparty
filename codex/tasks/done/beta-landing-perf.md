# Task: landing page performance + polish (site/index.html)

Read `AGENTS.md` first. Work on your branch only; do NOT deploy or run wrangler.
This task touches ONLY `site/` — do not edit worker.js, dj.html, or any Go/Swift.

Context: `site/index.html` is partyparty's marketing page (served at party.ramine.net
via the Cloudflare Worker's ASSETS binding). A beta-readiness audit found concrete,
objective performance + polish defects. Fix exactly these:

1. **LCP hero images are lazy-loaded** — the two above-the-fold hero-cluster images,
   `site/index.html:305` (`/shots/console.jpg`) and `:310` (`/shots/player.jpg`), have
   `loading="lazy"`, which defers the most important paint. Remove `loading="lazy"`
   from BOTH, and add `fetchpriority="high"` to the console.jpg hero image. Leave
   `loading="lazy"` on the genuinely below-the-fold images (crowd, party, dance,
   decks, eventpage, the second player shot lower in the page).

2. **No image has width/height** → layout shift (CLS). Add explicit intrinsic
   `width` and `height` attributes (or an `aspect-ratio` style) to EVERY `<img>` in
   the page. Read each file's real pixel dimensions from `site/img/*` and
   `site/shots/*` (use `sips -g pixelWidth -g pixelHeight <file>` or `file`) and use
   those exact values so the reserved box matches the asset.

3. **Mislabeled "How it works" anchor** — the hero CTA at `:299` is
   `href="#how"`, but `id="how"` sits on the comparison-table band (`:424`,
   "No app — and it still scales"). The true step-by-step section "What actually
   happens" is at `:493` and has no id. Give that step-by-step section an id and
   point the hero "How it works" button at it (the step-by-step is the honest
   "how it works" target). Leave the comparison band reachable too.

4. **Heavy JPEGs, no modern format / responsive sizes** — the page ships ~1.18 MB of
   JPEG. Generate WebP alongside the heaviest assets and serve via `<picture>` (JPEG
   fallback in `<img>`): `shots/eventpage.jpg` (337KB), `img/crowd.jpg` (227KB),
   `img/decks.jpg` (188KB), `img/dance.jpg` (170KB), `shots/console.jpg` (151KB),
   `img/portrait.jpg` (172KB). Use `cwebp -q 82` if available, else `sips -s format
   webp`. Target < 60KB each at display size. Commit the generated `.webp` files.
   **Do NOT delete `img/hero.jpg` or `img/portrait.jpg`** — they are referenced by
   the DJ photo-wall array in worker.js; keep the originals.

Constraints: no new runtime libraries; keep the existing visual design/layout
identical (this is perf + correctness, not a redesign). Do not change copy.

Verify: open `site/index.html` in a browser or headless check that it still renders;
confirm no broken `<img>`/`<picture>` markup; confirm the anchor scrolls to the
step-by-step section. Paste what you changed + the per-image before/after byte sizes
in your final report.
