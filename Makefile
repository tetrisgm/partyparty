BINARY = partyparty
GO ?= go
SWIFT_SRC = swift/ppcapture.swift
HELPER = assets/ppcapture
MEDIAMTX = assets/mediamtx
FFMPEG = assets/ffmpeg
FFMPEG_URL = https://www.osxexperts.net/ffmpeg81arm.zip
SWIFTFLAGS = -O -swift-version 5 -target arm64-apple-macos26.0 \
  -framework CoreAudio

# Core Audio system-audio helper (embedded into the Go binary).
$(HELPER): $(SWIFT_SRC)
	@mkdir -p assets
	swiftc $(SWIFTFLAGS) -o $(HELPER) $(SWIFT_SRC)

# MediaMTX (LL-HLS server) bundled into the Go binary so users need no install.
$(MEDIAMTX):
	@mkdir -p assets
	@command -v mediamtx >/dev/null || { echo "need mediamtx to bundle it: brew install mediamtx"; exit 1; }
	cp "$$(command -v mediamtx)" $(MEDIAMTX)
	chmod +x $(MEDIAMTX)

# Static FFmpeg (self-contained arm64, incl. aac_at + avfoundation) bundled in.
$(FFMPEG):
	@mkdir -p assets
	curl -sL "$(FFMPEG_URL)" -o /tmp/pp-ffmpeg.zip
	cd /tmp && rm -rf pp-ffx && mkdir pp-ffx && cd pp-ffx && unzip -oq /tmp/pp-ffmpeg.zip
	cp /tmp/pp-ffx/ffmpeg $(FFMPEG)
	chmod +x $(FFMPEG)

helper: $(HELPER)

build: $(HELPER) $(MEDIAMTX) $(FFMPEG)
	$(GO) build -o $(BINARY) .

run: build
	./$(BINARY)

tone: build
	./$(BINARY) --tone

devices:
	ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 | sed -n '/audio devices/,$$p'

# Native macOS .app (menu-bar shell + Go server + helpers). Ad-hoc signed for
# local testing; the signed/notarized release is built by CI.
app: $(HELPER) $(MEDIAMTX) $(FFMPEG)
	GO=$(GO) ./scripts/build-app.sh

# Notarize the local .app (needed for the privileged port-80 daemon). Requires a
# one-time `xcrun notarytool store-credentials "pp-notary" ...` — see scripts/notarize.sh.
notarize: app
	./scripts/notarize.sh

# Owner-facing ship command: verify, build, publish downloads/site, then flip
# app/update feeds. One-time: cd cloudflare && npm install && npx wrangler login
ship:
	./scripts/ship.sh

# Publish the landing page + current app download to partyparty.party
# (Cloudflare Worker + R2). Lower-level helper; prefer `make ship`.
deploy-site:
	./scripts/deploy-site.sh

# Back-compat alias for the old owner command. It now goes through ship so
# versioning, verification, artifact order, and feed flips stay centralized.
release: ship

clean:
	rm -f $(BINARY) $(HELPER)
	rm -rf build

.PHONY: helper build run tone devices app notarize ship deploy-site release clean
