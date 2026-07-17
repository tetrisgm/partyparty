# Distribution — partyparty.party

The **source** stays private (`github.com/tetrisgm/partyparty`). The **public
download + landing page** live on Cloudflare, under `partyparty.party`, served by
a single Worker:

```
                          partyparty.party  (Cloudflare Worker: "partyparty-site")
                          ├── /                -> static assets  (site/index.html)   the landing page
                          ├── /partyparty.pkg  -> R2 "partyparty-dl"                  the signed installer
                          ├── /appcast.xml     -> R2 "partyparty-dl"                  Sparkle auto-update feed
                          └── /content/*       -> R2 "partyparty-dl"                  signed web OTA payloads
```

Why a Worker (not plain Pages): Cloudflare Pages caps files at 25 MB; the bundled
app (ffmpeg + mediamtx + helpers) is ~100 MB, so the big files come from R2 while
the page is served as static assets. One hostname, pretty URLs.

Relevant files:
- `cloudflare/wrangler.jsonc` — Worker config (assets dir, R2 binding, custom domain).
- `cloudflare/worker.js`      — serves downloads, Sparkle, OTA, and the public web application.
- `site/index.html`           — the landing page.
- `scripts/ship.sh`           — the only owner-facing release command.

## One-time setup

```sh
cd cloudflare
npm install
npx wrangler login            # opens a browser; approve. (Or export CLOUDFLARE_API_TOKEN.)
```

`wrangler login` stores creds in your user config, so subsequent `scripts/ship.sh`
runs are non-interactive. The first deploy provisions the `partyparty.party` DNS
record + edge cert automatically (the zone is already in this Cloudflare account).

## Publish / update the download

```sh
scripts/ship.sh                 # full native/server release
scripts/ship.sh --payload-only  # compatible web-only OTA release
```

The ship workflow verifies, signs, notarizes, uploads immutable artifacts, and
flips the public feed/version markers only after the artifacts are available.

Verify: open <https://partyparty.party> and click Download; the file should be
`partyparty.pkg`. `curl -I https://partyparty.party/partyparty.pkg` should be 200.

## Releasing

Both paths build → sign → notarize → sign the appcast → publish to R2:
- **`scripts/ship.sh`** — from your Mac, no CI secrets. The normal path.
- **`git tag vX.Y.Z && git push --tags`** — GitHub Actions does it (needs the repo
  secrets in [RELEASING.md](RELEASING.md); `CLOUDFLARE_API_TOKEN` + the Apple secrets
  are the ones still to add).

See [RELEASING.md](RELEASING.md) for both.

## Status

- ✅ Sparkle auto-update wired — `SUPublicEDKey` is set, the private key is in the
  keychain + `SPARKLE_ED_PRIVATE_KEY` secret, and a signed `appcast.xml` is live.
- ✅ CI release workflow rewritten to publish to R2 on a tag (path B above).

## TODO

- **Optional:** ship a drag-to-Applications **.dmg** instead of a bare zip.
