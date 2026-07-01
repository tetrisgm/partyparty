# Distribution — party.ramine.net

The **source** stays private (`github.com/tetrisgm/partyparty`). The **public
download + landing page** live on Cloudflare, under `party.ramine.net`, served by
a single Worker:

```
                          party.ramine.net  (Cloudflare Worker: "partyparty-site")
                          ├── /                -> static assets  (site/index.html)   the landing page
                          ├── /partyparty.zip  -> R2 "partyparty-dl"                  the notarized .app, zipped (~60 MB)
                          └── /appcast.xml     -> R2 "partyparty-dl"                  Sparkle auto-update feed (see TODO)
```

Why a Worker (not plain Pages): Cloudflare Pages caps files at 25 MB; the bundled
app (ffmpeg + mediamtx + helpers) is ~100 MB, so the big files come from R2 while
the page is served as static assets. One hostname, pretty URLs.

Relevant files:
- `cloudflare/wrangler.jsonc` — Worker config (assets dir, R2 binding, custom domain).
- `cloudflare/worker.js`      — serves R2 for `/partyparty.zip` + `/appcast.xml`, else the landing page.
- `site/index.html`           — the landing page.
- `scripts/deploy-site.sh`    — packages the app, uploads to R2, deploys the Worker (`make deploy-site`).

## One-time setup

```sh
cd cloudflare
npm install
npx wrangler login            # opens a browser; approve. (Or export CLOUDFLARE_API_TOKEN.)
```

`wrangler login` stores creds in your user config, so subsequent `make deploy-site`
runs are non-interactive. The first deploy provisions the `party.ramine.net` DNS
record + edge cert automatically (ramine.net is already in this Cloudflare account).

## Publish / update the download

```sh
make notarize      # build + Developer-ID sign + notarize + staple the .app
make deploy-site   # zip it, push to R2, deploy the Worker + landing page
```

`deploy-site` warns (doesn't block) if the build isn't notarized — an
un-notarized download trips Gatekeeper on the guest's Mac.

Verify: open <https://party.ramine.net> and click Download; the file should be
`partyparty.zip`. `curl -I https://party.ramine.net/partyparty.zip` should be 200.

## TODO — not wired yet

1. **CI automation.** `.github/workflows/release.yml` still publishes to (private)
   GitHub Releases. Point it at R2 instead: add a `CLOUDFLARE_API_TOKEN` repo
   secret (scoped to Workers Scripts + R2 write) and, on `git tag vX.Y.Z`, upload
   the zip + appcast to `partyparty-dl` and `wrangler deploy` the Worker. Then a
   tag = a live release with zero manual steps.

2. **Finish Sparkle auto-update.** Currently `SUPublicEDKey` in `app/Info.plist`
   is a placeholder, so updates can't be verified. To enable:
   - `generate_keys` (Sparkle tool) → put the public key in `SUPublicEDKey`,
     store the private key as the `SPARKLE_ED_PRIVATE_KEY` CI secret.
   - Generate the appcast with `--download-url-prefix https://party.ramine.net/`
     and upload `appcast.xml` (+ the versioned zip) to R2. The feed URL is already
     set to `https://party.ramine.net/appcast.xml`.
   See `docs/RELEASING.md` for the existing appcast-generation step.

3. **Optional:** ship a drag-to-Applications **.dmg** instead of a bare zip.
