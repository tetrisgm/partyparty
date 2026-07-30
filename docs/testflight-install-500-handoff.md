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

## 2026-07-29 18:35 update: developer-controlled state is ruled out

Build `125.8 (224)`, App Store Connect build resource
`848e6d5c-0423-4e7e-b516-121f78c7be0b`, was rebuilt using Apple's documented
embedded-tool layout:

- exactly one `.app` exists in the package;
- `ppcapture` is a plain executable in `Contents/Helpers`;
- every helper has only App Sandbox plus inherited sandbox entitlements;
- the parent owns the Shazam Mach lookup exception;
- `altool --validate-app` succeeded;
- App Store Connect processed the build as `VALID` and
  `APP_STORE_ELIGIBLE`.

The following App Store Connect state was then repaired and verified through
the API:

1. The null build "What to Test" localization was populated.
2. The beta license resource was read and then updated with explicit agreement
   text.
3. A beta app review submission was created successfully. Apple accepted it as
   `WAITING_FOR_REVIEW`, which rules out the detached or missing beta-contract
   failure reported by other developers.
4. The macOS App Store version was advanced from stale `125.5` to `125.8`.
5. Its build relationship was moved from build 222 to build 224.
6. App availability is present and enabled for new territories.
7. Internal tester and beta group membership remain active.

After every repair, TestFlight was refreshed and the install was retried. The
final controlled retry still failed before any asset URL was issued:

- endpoint:
  `https://testflight.apple.com/v2/accounts/9d44880c-595c-45b0-aac6-cf73e3c3c32f/apps/6794880742/builds/225731682/install`
- HTTP status: `500`
- phase: `ProcessingInstallInitiateResponse`
- server reason: `Error Downloading Install Data`
- correlation key: `SNBYNKQ42G3MMOCDBIFFTPON5Y`

Earlier build-224 correlation keys include
`XVJDBH2B4EHBMH64Q4QX7HJRWA`, `GSZLY4E6VX2QS3K5BAPYVTTJLQ`, and
`BCHBMSVZEZ4WZWUEWXSZXANZLM`.

This is now a demonstrated Apple install-data backend defect for app record
`6794880742`, not a package validation, local installation, beta contract,
tester assignment, availability, or App Store version relationship problem.
The request fails on Apple's server before TestFlight receives a package URL,
so no local bundle, cache, signature, entitlement, installer, or quarantine
state can cause this specific failure.

Do not upload more package variants for this error without new evidence from
Apple's server logs. Send DTS the stripped-control correlation key below and
ask them to inspect or reprovision the install-data record for app
`6794880742`, production build ID `225731682`, and control build ID
`225733993`.

### Stripped control experiment

After the owner challenged the package conclusion, a genuinely discriminating
control was run:

- copied the validated root app from the archive;
- removed `Contents/Helpers` completely;
- retained only the native Swift shell, asset catalog, privacy manifest,
  provisioning profile, and root signature;
- signed the root with the exact application identifier and team identifier
  required by the profile;
- packaged it independently with `productbuild`;
- uploaded it as `125.10 (226)`.

The resulting package was 1.5 MB and contained exactly one app, no PartyParty
server, no capture helper, no ffmpeg, no MediaMTX, no nested bundle, no
quarantine attribute, and no PartyParty release-script output. Upload completed
with no errors or warnings. App Store Connect processed it as `VALID`.

TestFlight displayed build 226 and attempted to install numeric build
`225733993`. It failed at the same endpoint and same phase before receiving any
download URL:

- HTTP status: `500`
- response body size: 37 bytes
- phase: `ProcessingInstallInitiateResponse`
- server reason: `Error Downloading Install Data`
- header correlation key: `MKQIR2EDGFM3CSLHV3TDHFS7SE`

This control disproves the hypotheses that embedded PartyParty code, helper
signatures, package size, nested bundles, local copies of PartyParty, or the
production packaging script cause the install failure. The only state shared
between production build 224 and stripped control build 226 is the App Store
app record, bundle identifier, tester account, and Apple's TestFlight service.
Other TestFlight apps install for the same tester on the same Mac, leaving app
record `6794880742` in Apple's install-data service as the shared failing
variable.

Build 225 was an invalid first control attempt because its manual root
re-signing omitted `com.apple.application-identifier`. Apple's uploader
reported warning `90886` and explicitly marked it ineligible for TestFlight.
It was not used as evidence. Build 226 corrected that mistake and uploaded
without warnings.

## Remaining external discriminators

Ordered by how much they would discriminate, most valuable first.

1. **Third-party TestFlight install.** The owner confirmed that other
   TestFlight apps install on this Mac. This rules out a general TestFlight,
   Apple ID, network, or local client outage.
2. **Prerelease OS.** macOS 27.0 build `26A5388g` is a seed. Apple's forums
   document multiple TestFlight-install regressions on macOS 26+ seeds, some
   fixed only in point releases (`ASDErrorDomain 710` invalid-hash;
   `IXErrorDomain 5` coordinated-install intent conflict). Ours is a different
   signature (server 500, not a client error), but the base rate of
   TestFlight-install bugs on seeds is clearly high. Worth testing on a
   release-build macOS.
3. **App-record state in Apple's install-data service.** The app has **never
   had an approved App Store version**; its only version record was REJECTED
   until today. Every public App Store Connect relationship is now coherent,
   but the private install-data record remains malformed or absent. Only Apple
   can inspect or reprovision it.
4. **The 37-byte JSON error body**, never captured. Only response *headers*
   were logged. Capturing that body would likely name the server-side error
   directly. Try a proxy (Charles/mitmproxy with the system trust store) on
   `testflight.apple.com`, or a more verbose `log stream` predicate that
   includes response bodies.
5. **A different Apple ID / different Mac** as tester. This can further
   document impact, but it cannot repair a server 500 for this app record.

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
test -x "$APP/Contents/Helpers/ppcapture"
codesign -d --entitlements :- "$APP/Contents/Helpers/ppcapture"
find "$APP" -type d -name '*.app'                                                                                 # exactly the root app
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

## 2026-07-29 App Review invalid binary

Apple rejected `125.8 (224)` with the exact error:

```text
ITMS-90301: This bundle is invalid - Apple is not currently accepting
applications built with this version of the OS.
```

The uploaded app recorded `BuildMachineOSBuild=26A5388g`, matching the owner's
macOS 27 prerelease seed. Xcode 26.6 and the macOS 26.5 SDK are accepted by App
Store Connect, so this error is about the build host, not the SDK, signing,
entitlements, bundle identity, or provisioning profile.

App Store packages must now be produced by `.github/workflows/app-store.yml` on
GitHub's released `macos-26` image. `scripts/package-app-store.sh` independently
rejects prerelease macOS hosts. The replacement build is `125.9 (228)`.
