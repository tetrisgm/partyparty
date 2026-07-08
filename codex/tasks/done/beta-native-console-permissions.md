# Task: real capture-permission preflight + first-run polish (Swift app + dj.html)

Read `AGENTS.md` first. Work on your branch only; do NOT deploy/release/bump
CODE_MAJOR. This task owns the Swift app (`app/Sources/partyparty/*.swift`,
`app/Info.plist`, `app/installer/welcome.html`) and the permission/first-run bits of
`web/dj.html`. Do NOT touch `internal/broadcast/` (audio core, SACRED). Do NOT remove
or weaken the DJ activation gate (SACRED #2) — leave the auth/activation flow intact;
this is about the macOS capture PERMISSION UX only.

Verified findings to fix:

1. **The console is lied to about permission.** `AdminWindowController.swift:157`
   always runs `window.ppSetScreenPermission(true)` regardless of real state, so the
   console can never warn before a failed Go Live. Replace it with a REAL preflight:
   - Rename the bridge to a `CapturePermission` concept; push a JSON payload
     `{state: "granted"|"denied"|"undetermined", kind: "systemAudio"|"microphone"}`
     to a new `window.ppSetCapturePermission(payload)` (keep a back-compat shim
     calling the old name if dj.html still references it during transition).
   - For a microphone/interface source use `AVCaptureDevice.authorizationStatus(for:
     .audio)` mapped to the three states. For the system-audio (Core Audio process
     tap) source, probe the real tap/recording authorization if a reliable API exists;
     **if you cannot determine it reliably, report `undetermined` — NEVER hardcode
     `granted`.** Reporting undetermined is strictly better than today's false "true".
   - Push the correct `kind` for the currently-selected capture source.

2. **Recovery button points at a fixed pane.** dj.html's permission-recovery button
   always opens the System-Audio-Recording pane. Make its label + target pane dynamic
   off the preflight `kind`: microphone source → `x-apple.systempreferences:...?
   Privacy_Microphone` labelled "Open Microphone settings"; system-audio → the audio
   recording pane. Add a one-line "turn on partyparty in the list" instruction. Wire
   any needed `open-settings` pane handling in AppDelegate.swift.

3. **Stale Screen Recording declaration.** `app/Info.plist:44` declares
   `NSScreenCaptureUsageDescription` but the entitlement is `audio-input` and capture
   is the Core Audio tap. FIRST grep the codebase for `ScreenCaptureKit`/`SCStream`/
   `CGDisplayStream` — if screen capture is genuinely unused, remove the stale
   `NSScreenCaptureUsageDescription` key so it can never trigger a confusing Screen
   Recording TCC prompt. If it IS used somewhere, leave it and note why.

4. **Silent login-item enrollment.** `AppDelegate.swift:302 registerLoginItemByDefault`
   enrolls at-login by default with no disclosure. Keep the default-on behavior, but
   surface a one-line disclosure the user can see (e.g. in the console settings area of
   dj.html near the existing login-item opt-out toggle, or a first-run line): "partyparty
   opens at login so your party's ready — turn this off in Settings."

5. **Sign-in stall escape.** In the in-app sign-in window (`SignInWindowController` in
   AdminWindowController.swift, around the `[data-pp-linked]` detection ~183), add a
   ~60s timeout: if no linked marker appears, post a message that dj.html surfaces as
   "Having trouble? Open sign-in in your browser." The browser fallback
   (`startAccountSignInBrowser`) already exists — just make it discoverable on a silent
   embedded-OAuth stall. Do not change the successful flow.

6. **Installer copy.** `app/installer/welcome.html`: the pkg installs to the user's
   `~/Applications`, not system `/Applications`. Reword "installs to your Applications
   folder" → "installs to your Applications folder (in your home folder)".

Constraints: keep the activation gate + guest offline routes intact; no new deps;
prefer honest `undetermined` over false-positive permission state.

Verify: `cd app && swift build` (must succeed). Confirm dj.html still parses (load it
headless or lint). Paste the build output + a summary of each change, and explicitly
state what you determined about the system-audio tap permission API in your report.
