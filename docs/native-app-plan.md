# partyparty — native macOS app plan (menu-bar, signed, auto-updating)

Decisions (2026-06-30): ship a **Developer-ID-signed, notarized, auto-updating macOS menu-bar app**
(not App Store — sandbox breaks the subprocess/capture/port model). Capture moves to **Core Audio
process taps** (audio-only permission). Build the **full** app, not a staged minimal one.

## App shape
- **Menu-bar shell** — AppKit `NSStatusItem` (not SwiftUI `MenuBarExtra`, which regresses on macOS 26).
  SwiftUI only for *content* via `NSHostingView`. Supervises the Go server child process.
- **DJ admin = a native `NSWindow` hosting a `WKWebView`** pointed at `http://localhost:<port>/dj`. Reuses
  `web/dj.html` ~100% (all `/api/*` calls are same-origin; QR renders locally). No browser, no visible port.
- **Guests unchanged** — their own phone browser loads `web/listener.html` (needed for lock-screen /
  background audio; cannot be in-app).
- **Hybrid activation policy** — `.accessory` (menu-bar only, no Dock icon) at rest; flip to `.regular`
  while the admin window is open (Dock icon, Cmd-Tab, re-summon), back to `.accessory` on close.
- **Auto-update** — Sparkle 2 standard controller (own branding), appcast on GitHub Releases, EdDSA-signed.
  Gentle menu-bar badge (not focus-steal) while live/`.accessory`.
- **Touches** — optional Start-at-Login (`SMAppService.mainApp`, default off), Preferences scene, clean
  quit (SIGTERM the Go child → free ports), native first-run permission onboarding.

## Capture: Core Audio process taps (replaces ScreenCaptureKit)
`CATapDescription` → `AudioHardwareCreateProcessTap` → aggregate device (macOS 14.4+). Wins: audio-only
TCC tier (`NSAudioCaptureUsageDescription`) so **no monthly screen-recording re-auth nag**, **no restart
after granting**, and **native per-app capture** (capture just RekordBox — kills the BlackHole need).
Rewrites `swift/ppcapture.swift`; same piped-f32le-to-ffmpeg architecture.

## The notarization gotcha (resolved)
Embedded ffmpeg/mediamtx/ppcapture are only *ad-hoc* signed → they run from /tmp today but **fail
notarization** and thrash the TCC grant. Fix: ship them **signed in `partyparty.app/Contents/Helpers/`**
(not extracted), sign inside-out (helpers first, app last, never `--deep`), notarize + staple the bundle.
Done on the Go side via the `bundle` build tag (`assets_bundle.go` resolves `../Helpers`; default build
still embeds for dev). Entitlements: **none beyond hardened runtime**. Stable bundle id
`net.ramine.partyparty` anchors the audio-capture TCC grant across updates.

## Build order
1. **[done] Go foundation** — `-tags bundle` helper resolution from `Contents/Helpers/`; `--no-open` flag
   (the shell hosts the admin); graceful SIGTERM (already wired).
2. **Swift menu-bar shell** — `NSStatusItem` + SwiftUI popover (status/listeners/sync-spread/Go-Live) +
   right-click `NSMenu`; spawn/supervise the Go child; activation-policy hybrid.
3. **Native admin window** — `NSWindow` + `WKWebView` on `localhost/dj`; ATS `localhost` exception
   (never `127.0.0.1`); persistent data store; JS↔Swift bridge; `dj.html` de-web (hide header) + relabel
   permission copy to "System Audio Recording".
4. **Sparkle** wiring + gentle reminders gated on activation state; menu badge + in-window banner.
5. **SMAppService** start-at-login + Preferences + clean quit.
6. **Onboarding** window + permission state machine (pre-explainer → prompt → deep-link recovery).
7. **Core Audio taps** rewrite of `ppcapture.swift` (system tap + per-app sub-picker).
8. **.app bundle build** (Package.swift/xcodebuild + Info.plist + entitlements + icon) and the
   **release CI** (Developer ID sign → notarytool → staple → Sparkle appcast → GitHub Release on tag).

## CI / secrets (user adds to the GitHub repo)
Repo: `github.com/tetrisgm/partyparty` (private). Starter CI = build-check. Release workflow needs:
Developer ID Application cert (`.p12` base64) + password, Team ID, App Store Connect API key (or Apple ID +
app-specific password) for `notarytool`, and the Sparkle EdDSA private key (generated when wiring updates).

## Must-verify on a real signed build (cannot confirm headlessly)
- Locked-screen survival of a live stream (gates the product — test from the signed `.app`, not the terminal).
- TCC grant attributed to the `.app` (launch via LaunchServices, not by exec'ing the inner binary) and
  persisting across auto-updates.
- Notarization passes with helpers signed in `Contents/Helpers/`.
- Core Audio taps: no-restart grant + per-app capture actually work on macOS 26.
