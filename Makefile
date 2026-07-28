BINARY = partyparty
GO ?= go
SWIFT_SRC = swift/ppcapture.swift
HELPER = assets/ppcapture
MEDIAMTX = assets/mediamtx
FFMPEG = assets/ffmpeg
FFMPEG_URL = https://www.osxexperts.net/ffmpeg81arm.zip
SWIFTFLAGS = -O -swift-version 5 -target arm64-apple-macos26.0 \
  -framework CoreAudio -framework AVFoundation -framework ShazamKit

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

# Native sandboxed Mac App Store app. Ad-hoc signed for local testing.
app: $(HELPER) $(MEDIAMTX) $(FFMPEG)
	GO=$(GO) ./scripts/build-app.sh

app-store-package: $(HELPER) $(MEDIAMTX) $(FFMPEG)
	./scripts/package-app-store.sh

standalone: $(HELPER) $(MEDIAMTX) $(FFMPEG)
	./scripts/build-standalone.sh

clean:
	rm -f $(BINARY) $(HELPER)
	rm -rf build

.PHONY: helper build run tone devices app app-store-package standalone clean
