#!/usr/bin/env bash
# Generate app/icon.icns from an emoji on a purple squircle (the app icon shown in
# the Dock, Finder, and System Settings). Usage: scripts/make-icon.sh [emoji]
set -euo pipefail
cd "$(dirname "$0")/.."
EMOJI="${1:-🕺}"
TMP="$(mktemp -d)"

cat > "$TMP/render.swift" <<'SWIFT'
import AppKit
let emoji = CommandLine.arguments[1], out = CommandLine.arguments[2]
let S = 1024.0
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(S), pixelsHigh: Int(S),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let m = S * 0.06
let rect = NSRect(x: m, y: m, width: S - 2*m, height: S - 2*m)
let r = (S - 2*m) * 0.2237
NSBezierPath(roundedRect: rect, xRadius: r, yRadius: r).addClip()
NSGradient(starting: NSColor(srgbRed: 0.486, green: 0.227, blue: 0.929, alpha: 1),
           ending:   NSColor(srgbRed: 0.09,  green: 0.06,  blue: 0.18,  alpha: 1))!
    .draw(in: rect, angle: -90)
let para = NSMutableParagraphStyle(); para.alignment = .center
let str = NSAttributedString(string: emoji,
    attributes: [.font: NSFont.systemFont(ofSize: S * 0.5), .paragraphStyle: para])
let bb = str.size()
str.draw(in: NSRect(x: (S - bb.width)/2, y: (S - bb.height)/2, width: bb.width, height: bb.height))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
SWIFT

swift "$TMP/render.swift" "$EMOJI" "$TMP/icon-1024.png"

ICONSET="$TMP/icon.iconset"; mkdir -p "$ICONSET"
gen() { sips -z "$1" "$1" "$TMP/icon-1024.png" --out "$ICONSET/$2" >/dev/null; }
gen 16 icon_16x16.png;     gen 32  icon_16x16@2x.png
gen 32 icon_32x32.png;     gen 64  icon_32x32@2x.png
gen 128 icon_128x128.png;  gen 256 icon_128x128@2x.png
gen 256 icon_256x256.png;  gen 512 icon_256x256@2x.png
gen 512 icon_512x512.png;  gen 1024 icon_512x512@2x.png
iconutil -c icns "$ICONSET" -o app/icon.icns
echo "wrote app/icon.icns"
rm -rf "$TMP"
