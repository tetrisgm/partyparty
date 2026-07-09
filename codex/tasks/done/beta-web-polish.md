# Task: landing/worker polish for beta (cloudflare/worker.js + site/index.html)

Read `AGENTS.md` first. Branch only; do NOT deploy. Owns `cloudflare/worker.js`,
`site/index.html`, and may add a tiny `/api/version` route. Do NOT touch dj.html,
Go, or Swift. Keep the DJ activation gate + guest offline routes intact (SACRED).

Context (decisions already shipped): the `.pkg` is the canonical download and all
CTAs point to `/partyparty.pkg`; `/` now serves the marketing page for everyone and
the events aggregator lives at `/live`. Build these polish items:

1. **Version + freshness at the download point (#14).** Add a small
   `GET /api/version` route to worker.js returning JSON `{version, date}` where
   version is read from the repo `CODE_MAJOR` + `web/PAYLOAD_VERSION` (or a constant
   you bump) → e.g. "26.50", and date is the build/deploy date. In `site/index.html`,
   under each primary Download button, add a sub-line that fetches `/api/version` and
   renders "Free · Apple Silicon · macOS 26+ · v<version> · updated <Mon YYYY>" so it
   never goes stale. Degrade gracefully if the fetch fails (show the static part).

2. **Reconcile the story to shipped-first (#29).** The worker's `renderHome`/
   `emptyHome` lead copy (now at `/live`) currently leads with the not-yet-shipped
   keepsake/"gathered after the night" angle. Align it to the SHIPPED hook that
   `site/index.html` uses ("Throw a party where speakers would get you shut down" /
   silent-disco, offline, no app for guests). Keep any keepsake/event-page framing but
   label it explicitly "coming soon". Match the existing copy voice.

3. **Real dark mode on the marketing page (#16).** `site/index.html` declares
   `color-scheme: light` and is effectively light-only though `.dark` tokens exist in
   its stylesheet. Add a `@media (prefers-color-scheme: dark)` block that applies the
   existing `.dark` token values to `:root`, set the meta to `content="light dark"`,
   and visually sanity-check the aura hero + band backgrounds read correctly in dark.

4. **Honest trust block (#28).** `site/index.html` has zero social proof. Add ONE
   restrained trust section before the final CTA with: a founder-voice honest line
   (first person, real) AND one verifiable capability stat that is TRUE for partyparty
   (e.g. "Runs on zero internet." / "~2–4s from the decks to every phone."). **Do NOT
   fabricate testimonials, names, star ratings, or user counts** — no fake quotes. If
   there is no real third-party quote, use only the honest founder line + true stat.

5. **Retire the install stub (#19).** CTAs no longer reference
   `install-partyparty.zip`. Remove any Makefile target / build step that produces
   `Install-partyparty.zip` (grep the Makefile + scripts), and leave a one-line note
   that the `.pkg` is the sole user download. Do not delete installer-app/ sources
   (archive-later), just stop building/shipping the stub.

Constraints: no new deps; match the existing visual design + copy voice; keep it
restrained (this is polish, not a redesign).

Verify: `cd cloudflare && node test/smoke.mjs` (all pass; add a test for `/api/version`
returning JSON). Confirm `site/index.html` still renders. Paste the smoke output + a
summary of each change.
