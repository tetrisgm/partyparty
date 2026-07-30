# TestFlight macOS install fails with HTTP 500: investigation handoff

Written 2026-07-29 for a fresh investigator. Everything here is observed, not
inferred, unless marked as a hypothesis. Where a conclusion was reached and
later disproved, both are recorded, because the disproof is the useful part.

## The symptom

Clicking **Install** in TestFlight.app on macOS produces:

> Could not install partyparty: DJ Wi-Fi Radio.
> TestFlight is currently unavailable. Try again.

## The exact failure, from os_log

Captured with `log stream --predicate 'process == "TestFlight"'` during the
click. Identical on every attempt:

```
TestFlight [com.apple.TestFlight:host-install]
  [fm.partyparty.app;6794880742 <buildNum> 125.5 (222);shouldReinstallSameVersion:NO]
  installing: Install Request Created: Starting install for bundleID
  (fm.partyparty.app) for user account (1064438869)
TestFlight [com.apple.TestFlight:host-install] installing: Downloading Install Data
TestFlight [com.apple.AppleMediaServices:url-loading] AMSURLRequestEncoder:
  Encoding request for URL:
  https://testflight.apple.com/v2/accounts/<acct>/apps/6794880742/builds/<buildNum>/install
TestFlight [com.apple.TestFlight:networking] RP(...) URL=<same>; code=500; Headers={
    Connection = close;
    "Content-Length" = 37;
    "Content-Type" = "application/json";
    Server = "daiquiri/5";
    "X-Apple-Jingle-Correlation-Key" = PO6CBYP4BKATVVQRR24NG5XHAU;
}
TestFlight [com.apple.TestFlight:host-install] installing:
  FAILED: TFBundleInstallation for fm.partyparty.app
     downloadProgress=(null)
     installProgress=(null)
     serverFailureReason=Error Downloading Install Data
     visualStatus=TFInstallRequestVisualStatusInstallingIndeterminate
     previousPhaseDescription=ProcessingInstallInitiateResponse
     installStatusDescription=None
```

Salient points:

- The 500 comes from **Apple's** `testflight.apple.com`, server `daiquiri/5`,
  with a 37 byte JSON body (never captured; only headers were logged).
- It fails at `ProcessingInstallInitiateResponse`, i.e. while processing the
  response to the install-initiate call. **Zero bytes of the app are ever
  downloaded** (`downloadProgress=(null)`).
- The TestFlight client successfully lists the app, its version, size, release
  notes and previous builds, so client to server auth and metadata reads work.
  Only the install call fails.

Correlation keys captured: `PO6CBYP4BKATVVQRR24NG5XHAU`,
`JP7YCXELCU4RTEXUMIPITT6RL4`.

## Environment

| | |
|---|---|
| OS | **macOS 27.0, build 26A5388g** (Darwin 27.0.0) — a **prerelease seed** |
| Hardware | Apple silicon |
| App | partyparty: DJ Wi-Fi Radio |
| App Apple ID | 6794880742 |
| Bundle ID | `fm.partyparty.app` |
| Distribution | Mac App Store (`.pkg` via `xcodebuild -exportArchive`) |
| Tester account | ramine@ramine.net, state ACCEPTED, internal group "Internal testing" (hasAccessToAllBuilds) |

## Builds tested, all fail identically

| Version | Build | ASC build id | Uploaded | processingState |
|---|---|---|---|---|
| 125.5 | 222 | `152b52fd-218b-41bc-ab53-372132fe66b7` | 2026-07-29 17:11 | VALID |
| 125.5 | 221 | `b5d1940a-5f5d-4932-b8d3-b35fa7e20610` | 2026-07-29 16:05 | VALID (now expired) |
| 124.00 | 202 | `0b40368f-4edd-4b23-80aa-3df771288078` | 2026-07-27 23:57 | VALID |

Build 222 is **structurally different** from 221 (different nested bundle
identifier, no provisioning profile in the nested bundle, a completely
different `ffmpeg` binary, 78.7 MB vs 108.5 MB). Same failure. Build 202
predates all of this week's changes. Same failure.

`internalBuildState = IN_BETA_TESTING` on 221 and 222, so the builds are
considered installable by ASC.

## Ruled out, with method

1. **Duplicate bundles on the client.** This is the best documented cause of
   this error class (see Unity thread in References: leftover same-bundle-ID
   apps in Downloads broke installs). Removed **every** app bundle on the Mac
   carrying `fm.partyparty.app` or `fm.partyparty.beta`: `/Applications`,
   `~/Applications`, six copies under the repo's `build/`, and **440 bundles
   totalling 28 GB in `~/Library/Caches/Sparkle_generate_appcast/`**. Verified
   with `mdfind "kMDItemCFBundleIdentifier == 'fm.partyparty.app'"` returning
   nothing for both identifiers. Install still fails identically.
2. **Client caches and daemons.** Restarted TestFlight, `appstoreagent`,
   `storedownloadd`. Removed `~/Library/Caches/fm.partyparty.*` and
   `~/Library/Application Scripts/fm.partyparty.*`. No change.
3. **A single bad build.** Three builds across three days, two structurally
   different packages.
4. **Package identity collision** (see "Fixed defects" below). This was my
   leading hypothesis and it was **wrong**: build 222 has the collision
   removed and fails identically.
5. **Rejected App Store version blocking install.** The app's only version
   record was `116.87 / REJECTED`. Corrected to `125.5 /
   PREPARE_FOR_SUBMISSION` with the current build attached. No change to the
   install failure.

## NOT ruled out — where to look next

Ordered by how much they would discriminate, most valuable first.

1. **Does *any* TestFlight app install on this Mac?** This is the single
   highest-value untested experiment and it is cheap. The tester account also
   has Roon ARC and Steam Link under "Currently Testing". If a third-party app
   also fails with a 500 at install-initiate, the fault is the client/OS or
   the Apple ID, and partyparty is irrelevant. If a third-party app installs
   fine, the fault is specific to app record 6794880742. **I deliberately did
   not run this** because it installs unrequested third-party software on the
   owner's machine; get his go-ahead first, then remove the app after.
2. **Prerelease OS.** macOS 27.0 build `26A5388g` is a seed. Apple's forums
   document multiple TestFlight-install regressions on macOS 26+ seeds, some
   fixed only in point releases (`ASDErrorDomain 710` invalid-hash;
   `IXErrorDomain 5` coordinated-install intent conflict). Ours is a different
   signature (server 500, not a client error), but the base rate of
   TestFlight-install bugs on seeds is clearly high. Worth testing on a
   release-build macOS.
3. **App-record state in Apple's install-data service.** The app has **never
   had an approved App Store version**; its only version record was REJECTED
   until today. Hypothesis: install-data generation for a Mac app depends on
   app-record state that is malformed or absent for a never-approved app.
   Untestable from outside; needs Apple's server logs for the correlation
   keys.
4. **The 37-byte JSON error body**, never captured. Only response *headers*
   were logged. Capturing that body would likely name the server-side error
   directly. Try a proxy (Charles/mitmproxy with the system trust store) on
   `testflight.apple.com`, or a more verbose `log stream` predicate that
   includes response bodies.
5. **A different Apple ID / different Mac** as tester. Not tested.

## Fixed defects found along the way (real, independent of the 500)

These were all genuine and are all fixed and committed. None of them fixed the
install failure, but two of them would have caused App Review rejections and
one was a licensing violation.

### 1. Nested helper claimed the parent's identity

`scripts/xcode-embed-helpers.sh` stamped the nested capture helper with
`PRODUCT_BUNDLE_IDENTIFIER` (the parent's `fm.partyparty.app`) instead of its
own declared `fm.partyparty.capture`, and signed it claiming the parent's
`com.apple.application-identifier`, which made Xcode embed the **parent's
provisioning profile inside the nested bundle**. The uploaded package
contained two app bundles both claiming `fm.partyparty.app`, each with a
profile for that identity. `altool` validation accepts this.

Worse: `scripts/verify-app-store.sh` **asserted the defect** in two places. It
required the helper's `CFBundleIdentifier` to *equal* the parent's, and
required `com.apple.application-identifier` in the helper's entitlements. Both
inverted now, plus a new gate that nested bundles embed no provisioning
profile.

Done deliberately in commit `c63876c` ("Sign the App Store capture helper
completely") to fix ShazamKit error 202. The part ShazamKit actually needs is
the `com.apple.shazamd` Mach lookup exception, which is retained; the identity
claim was not needed.

### 2. GPL ffmpeg shipped inside a closed-source App Store app

`assets/ffmpeg` was a third-party (osxexperts.net) build configured
`--enable-gpl --enable-libx264 --enable-libx265`. GPL is incompatible with App
Store distribution terms. This is very likely why `116.87` was REJECTED and
would have rejected every future submission.

Nothing in the product needs any GPL component. Enumerated actual usage: live
path is `f32le` in, `aac_at` (AudioToolbox) encode, `tee` to
`rtsp`+`adts`+`hls` legs with `use_fifo=1:drop_pkts_on_overflow=1`; recordings
are mp4/mov/segment; thumbnails *decode* video (`h264` + VideoToolbox) and
encode `png`/`mjpeg`. **No video is ever encoded.**

`scripts/build-ffmpeg-lgpl.sh` now builds `assets/ffmpeg` from pinned upstream
source with no GPL flag and no external libraries, gated on every capability
above plus a real `aac_at` encode. 51 MB to 21 MB. Verified by running the
exact production tee shape against a real MediaMTX, and the real-binary
integration test (`internal/origin/realmtx_test.go`) passes with it.

### 3. App Review metadata described a deleted product

`demoAccountRequired: true` and review notes instructing the reviewer to "sign
in with Apple, Google, or email" — for an app whose account system was
**removed on 2026-07-26** (commit "Remove PartyParty account system"; project
doctrine forbids restoring product auth). Independently sufficient to fail
review. Rewritten to describe the real account-free product with single-Mac
review steps.

### 4. Store record was jammed

The REJECTED `116.87` blocked new versions entirely: creating one returned
`"You cannot create a new version of the App in the current state."` PATCHed
in place to `125.5`.

## Artifacts

- Evidence bundle: `~/Desktop/partyparty-testflight-500-evidence/`
  - `01-install-failure-screen-recording.mov` (5 MB)
  - `02-install-failure-screenshot.png`
  - `03-os-log-evidence.txt` (raw log excerpts, correlation keys)
  - `04-summary.txt`
- Apple DTS case **20000120924076**, subject "Apple Developer Support -
  Distribution". Apple replied 2026-07-29 09:47 (Shanda): *"Upon researching
  your request it appears the issue may be resolved. If you are still
  experiencing this issue please gather a screen recording and screen shots."*
  Failure reproduced at **17:34 the same day**, after that reply. A reply with
  all of the above was sent 2026-07-29 ~17:45.
  - **Correction owed to Apple:** that reply states the OS as "macOS 26.0
    (Darwin 27.0.0)". It is actually **macOS 27.0 build 26A5388g**, a
    prerelease seed. This is material to triage and should be corrected in a
    follow-up.
- `scripts/asc-api.py` — App Store Connect API client (ES256 JWT from the team
  key in `~/Library/Application Support/partyparty/app-store-connect/`, no
  secrets on argv). Use it for any ASC state inspection:
  `./scripts/asc-api.py GET "/v1/builds?filter[app]=6794880742&sort=-uploadedDate"`

## Reproducing

```bash
# 1. capture the failure
log stream --style compact --predicate 'process == "TestFlight"' > /tmp/tf.log &
# click Install in TestFlight.app, wait for the dialog, then:
pkill -f "log stream"
grep -E "code=500|serverFailureReason|previousPhase|Correlation" /tmp/tf.log

# 2. confirm no conflicting bundles exist
mdfind "kMDItemCFBundleIdentifier == 'fm.partyparty.app'"
mdfind "kMDItemCFBundleIdentifier == 'fm.partyparty.beta'"

# 3. confirm build state in ASC
cd ~/dev/partyparty
./scripts/asc-api.py GET "/v1/builds?filter[app]=6794880742&filter[version]=222&fields[builds]=version,processingState,expired"
./scripts/asc-api.py GET "/v1/builds/152b52fd-218b-41bc-ab53-372132fe66b7/buildBetaDetail?fields[buildBetaDetails]=internalBuildState,externalBuildState"

# 4. inspect the uploaded package structure
pkgutil --expand-full dist/partyparty-app-store.pkg /tmp/pkg
APP=/tmp/pkg/fm.partyparty.app.pkg/Payload/partyparty.app
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Helpers/ppcapture.app/Contents/Info.plist"  # fm.partyparty.capture
codesign -dv "$APP/Contents/Helpers/ppcapture.app"                                                                # Identifier=fm.partyparty.capture
ls "$APP/Contents/Helpers/ppcapture.app/Contents/embedded.provisionprofile"                                       # must not exist
strings -a "$APP/Contents/Helpers/ffmpeg" | grep -c -- --enable-gpl                                               # must be 0
```

## References

- Unity: leftover same-bundle-ID app bundles break App Store/TestFlight
  installs — https://discussions.unity.com/t/macos-appstore-testflight-install-error/1685599
- Apple forums, macOS TestFlight install `ASDErrorDomain 710` invalid hash —
  https://developer.apple.com/forums/thread/791541
- Apple forums, `IXErrorDomain 5` coordinated-install intent conflict, fixed in
  a point release — https://developer.apple.com/forums/thread/797150
- Apple forums, TestFlight API 500s acknowledged —
  https://developer.apple.com/forums/thread/774949

## Relevant commits

- `9b47604` Make the App Store package tell the truth about identity and license
- `15157a2` App Store lane current again, and relayed guests stop paying quadruple bytes
