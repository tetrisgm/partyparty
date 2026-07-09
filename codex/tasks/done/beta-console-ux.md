# Task: DJ console first-run UX polish (web/dj.html)

Read `AGENTS.md` first. Branch only; do NOT deploy. Owns `web/dj.html` (you may add a
tiny message handler in `app/Sources/partyparty/AdminWindowController.swift` ONLY if a
feedback link needs the native shell). Do NOT touch `internal/broadcast/` (audio core).

**CRITICAL — decision A: KEEP the DJ activation gate exactly as it is.** Do NOT remove,
bypass, or make it non-blocking. These are COPY + guidance + confidence additions layered
on top of the existing gate/flow. The gate stays; guests stay offline-capable.

Build these (each verified as a real beta-readiness gap):

1. **Reframe the gate copy wall → welcome + early-access (#24).** Keep the gate, but
   change its tone: title/body should lead with what partyparty is and set an honest
   "early access" expectation (e.g. title "partyparty · early access", body explains the
   one-time sign-in links this Mac to publish/replay online). Add a short first-run
   ORIENTATION on/above the gate stating the 3 steps: "1. Sign in once · 2. Pick your
   audio source · 3. Go Live — guests scan a QR." Add a persistent, low-key feedback link
   in the console footer (a `mailto:ramine@ramine.net?subject=partyparty%20beta` is fine).

2. **Capture-source picker as a named step (#18).** The bare `<select id=device>` only
   explains itself via a hover tooltip. Add a visible label "1. Pick what guests hear"
   near it, a persistent one-line inline hint (not a tooltip) — e.g. "Mac output =
   everything playing · Test tone = prove the connection first" — and surface the existing
   Source guide as a visible "What should I pick?" link (not buried in Settings).

3. **One-tap "Test a guest connection" prover (#26).** In the guest-setup card, add a
   button that (a) selects the Test tone source, (b) starts the broadcast, and (c) tells
   the DJ to scan the Party QR and confirm they hear the 440 Hz beep, then flips to the
   existing "guests can reach you" confirmation when a listener appears. This exercises
   capture→network→playback end-to-end and directly de-risks the FOUNDATIONAL false-live
   gotcha (DJ shows Live while guests hear nothing). Reuse existing self-test wiring.

4. **Pre-permission soft-ask before the FIRST Go Live (#23).** In the Go-Live path
   (startBroadcast), if the capture-permission preflight state (from the recently-added
   `window.ppSetCapturePermission({state,kind})` bridge) is `undetermined`, intercept and
   show a benefit-framed in-app card: "Let partyparty capture your Mac's audio so guests
   hear what you're playing" with "Allow" and "Not now". Only on Allow proceed to
   `POST /api/start` (which triggers the real one-shot macOS TCC dialog). On "Not now" do
   not fire the OS prompt. State the payoff, not the mechanism. If preflight is already
   `granted`, skip straight to Go Live (no extra friction).

Constraints: keep the activation gate + guest offline path intact; no new libraries;
match the existing dj.html style; passive playback decrees still hold.

Verify: load dj.html headless (or lint) — confirm both inline scripts parse and no JS
errors on load; confirm the gate still blocks when unlinked. Paste a summary of each
change and how you verified the gate still gates.
