# LAN HTTPS reliability: implementation plan

Status: approved architecture and execution contract, 2026-07-22.

Audience: the implementation agent performing the next partyparty change. This
document is intentionally prescriptive. Do not reopen the architecture search,
restore retired fallbacks, or preserve obsolete mechanisms merely because they
already exist.

The field evidence and original review questions are in
[`lan-https-reliability.md`](lan-https-reliability.md). That document is the
problem statement. This document is the implementation contract.

## 1. Required outcome

A guest using a default-configured phone on the same ordinary Wi-Fi as the DJ's
Mac must be sent to the Mac's HTTPS listener and receive the existing LL-HLS
stream whenever that network permits private-address DNS answers and
device-to-device traffic.

The guest-facing flow remains:

```text
https://<handle>.partyparty.party/
    -> cloud router probes the machine HTTPS hostname
    -> probe succeeds: open the LAN room
    -> probe fails: open the cloud event/mirror
```

The machine endpoint remains:

```text
https://<stable-machine-label>.party.partyparty.party:<guest-port>/
```

Its certificate is publicly trusted and names the machine hostname. Its A
record contains the Mac's current private LAN address. The address may change at
home, a friend's home, a coworking space, or a controlled travel router without
requiring a new certificate or hostname.

The implementation is complete only when all of these are true:

1. A current machine A record is never deliberately removed merely because the
   app, set, or cloud presence becomes idle.
2. An absent machine name returns NXDOMAIN. It never resolves to a Cloudflare
   edge address and never resolves to a sentinel address.
3. A successful DNS publication is proven, not inferred from a 200 response or
   hidden inside a best-effort catch.
4. The Mac distinguishes certificate readiness, DNS publication, local resolver
   agreement, local TLS reachability, and real guest reachability.
5. The console never calls the LAN room reachable unless the current-network
   evidence supports that statement.
6. The cloud fallback remains available when the LAN path is blocked.
7. Native HTTPS HLS remains the iPhone player. Lock-screen and background
   playback are unchanged.

## 2. Non-negotiable constraints

These constraints override convenient implementation shortcuts.

### 2.1 Keep HTTPS LL-HLS

- Do not add or restore a production plain-HTTP audio stream.
- Do not restore `streamUrl` to `/api/status`.
- Do not change `chosenStream()` back to a plain-HLS fallback.
- Do not replace native iPhone HLS with Web Audio, MSE, a PWA, or a native guest
  app.
- Do not weaken certificate validation on guest devices.

The Mac may continue to run its existing HTTP listener because the DJ console,
local APIs, and explicit offline administration use it. That does not make HTTP
a supported guest audio route.

### 2.2 Do not use raw private-IP certificates

Public CAs cannot issue publicly trusted certificates for RFC1918 or other
reserved private addresses. `https://192.168.x.x`, `https://10.x.x.x`, and
similar URLs are not production solutions.

Let's Encrypt's short-lived IP certificates for publicly controllable IP
addresses do not change this. Do not implement an IP-certificate experiment.

### 2.3 Keep certificate private keys per Mac

- Each Mac retains its own exact-name certificate and private key.
- Continue using DNS-01 through the broker so the private HTTPS listener does
  not need public inbound reachability.
- Never embed or distribute a wildcard private key in the app.
- Never make all Macs share a `*.party.partyparty.party` certificate.

### 2.4 Preserve offline and account invariants

- Do not add authentication to guest LAN routes, HLS routes, status, heartbeat,
  media, reactions, `listener.html`, or `wall.html`.
- Keep the DJ activation/account gate.
- A once-activated Mac must retain its cached certificate and remain usable on a
  controlled offline network.
- Do not introduce a live-audio cloud relay. The existing cloud mirror remains
  the delayed remote path.

### 2.5 Do not touch the audio core

Do not modify `internal/broadcast/` in this change. Do not remove its retained
plain-HLS implementation. That code is protected by the repository policy and
requires a separate supervised live test. This plan removes obsolete routing,
DNS, and UI fallbacks, not protected broadcaster code.

## 3. Chosen architecture

This section is a decision, not a list of options.

### 3.1 One public product namespace

Keep `partyparty.party` as the existing Cloudflare zone.

Keep the proxied product wildcard:

```text
*.partyparty.party -> Cloudflare Worker
```

It continues to provide zero-provisioning public handle URLs.

Keep machine hosts under:

```text
<machine-label>.party.partyparty.party
```

Machine A records remain DNS-only and point directly to private LAN addresses.
Do not proxy them.

Do not create a separately delegated child zone. It adds zone, token,
delegation, migration, and plan-tier complexity without adding reliability that
the namespace-anchor design does not already provide.

### 3.2 Replace the guard with a namespace anchor

Create and permanently retain this exact DNS node:

```text
type:    TXT
name:    party.partyparty.party
content: partyparty-machine-namespace-v1
```

The exact TXT record makes `party.partyparty.party` the DNS closest encloser.
For an absent query such as
`missing.party.partyparty.party`, the source wildcard would have to be
`*.party.partyparty.party`. That wildcard will not exist, so the result is
NXDOMAIN. DNS must not continue searching upward to `*.partyparty.party`.

Delete this record permanently after the anchor is confirmed:

```text
*.party.partyparty.party A 192.0.2.1
```

Never recreate it. There is no replacement sentinel.

The migration order is mandatory:

1. Create or verify the exact namespace-anchor TXT.
2. Query an authoritative nameserver and prove the TXT exists.
3. Delete every `*.party.partyparty.party` A record.
4. Query an authoritative nameserver and prove a random absent machine name is
   NXDOMAIN.
5. Prove existing exact machine A records still answer unchanged.

Reversing steps 1 and 3 would briefly expose absent names to the parent proxied
wildcard and is not allowed.

### 3.3 Stable machine identity

Every install has one stable machine label. Existing installs keep the label
already stored in `install.json` and the broker record, including labels such as
`seth-live` and `ramine-live`.

For new installs, continue assigning a random collision-free broker slug. The
public handle remains pretty; the machine label is implementation detail and
does not need to include the handle.

Stop renaming machine labels after a profile handle is confirmed or renamed.
Handle changes must affect only the public Worker route and profile URL. They
must not trigger:

- machine A-record deletion;
- a new machine hostname;
- certificate reissuance;
- a temporary absent-name interval;
- changes to an active room URL.

In `cloudflare/worker.js`, remove `handleSlugBase` and `ensureHandleSlug` after
all callers and tests have been migrated. `/api/broker/a` must use
`ensureBrokerSlug`, which returns the install's existing immutable slug.

### 3.4 Persistent exact A record

The current machine A record is installation state, not live-presence state.
It must outlive broadcasts, app quits, Worker presence TTLs, and ordinary
network outages.

The authoritative record shape is:

```text
type:    A
name:    <stable-machine-label>.party.partyparty.party
content: <current Mac LAN IPv4 address>
ttl:     60
proxied: false
```

Do not delete it from `/api/broker/offline`, scheduled presence GC, app Stop,
app quit, or telemetry cleanup.

A stale private address while the Mac is idle is acceptable:

- the cloud router probes TLS before redirecting;
- another device at the stale address does not possess the machine certificate;
- TLS therefore fails closed;
- the app refreshes the record before claiming current-network readiness.

### 3.5 Current-network refresh

Publish the current LAN address at all of these events:

1. App launch, before current-network LAN readiness is claimed.
2. Network interface or primary LAN address change.
3. Wake from sleep, including wake where the private address happens to remain
   numerically identical.
4. Before or immediately at Go Live.
5. At a bounded periodic interval while the app is running.
6. On every live presence heartbeat as a repair path.

Use one coalescing refresh lane. Do not let wake, network polling, periodic
refresh, and Go Live start concurrent ACME/DNS operations. Multiple triggers
collapse into one current-IP refresh followed by at most one rerun when the
network fingerprint changed during the operation.

Certificate issuance remains conditional on certificate usability. A network
change normally updates only DNS and readiness state; it must not renew a valid
certificate.

The refresh operation must be bounded and retry with backoff. It must not block
audio capture, stop an existing set, or tear down a loaded cached certificate.

## 4. DNS publication contract

Create one Worker helper, used by both `/api/broker/a` and
`/api/broker/live`, with behavior equivalent to:

```text
upsertMachineA(env, installRecord, expectedIPv4) -> receipt
```

The helper must:

1. Derive the full hostname exclusively from the authenticated install record.
   Never accept a hostname from the client.
2. Validate that the submitted address is a real IPv4 address with four
   octets in the range 0-255. Do not retain the current regex that accepts
   values such as `999.999.999.999`.
3. Query Cloudflare for every exact A record with that hostname.
4. Create one DNS-only A record when none exists.
5. Update the retained record when its content, TTL, or proxy status is wrong.
6. Delete duplicate A records for the exact hostname. Multiple A answers can
   randomly route guests to stale addresses and are not valid state.
7. Re-read Cloudflare after mutation.
8. Return success only when exactly one A record remains and it has the expected
   address with `proxied=false`.

The successful receipt must contain at least:

```json
{
  "ok": true,
  "host": "seth-live.party.partyparty.party",
  "ip": "192.168.1.85",
  "recordId": "...",
  "proxied": false,
  "verified": true
}
```

Do not expose the Cloudflare token or other record contents.

`/api/broker/a` is strict. A Cloudflare read, write, duplicate cleanup, or
verification failure returns a non-2xx response with a stable reason code. It
must never claim success when the record is unverified.

`/api/broker/live` must continue updating cloud presence even if DNS repair
fails, but DNS failure must not be swallowed. Return a 200 heartbeat response
containing a nested DNS receipt:

```json
{
  "ok": true,
  "host": "seth-live.party.partyparty.party",
  "dns": {
    "ok": false,
    "reason": "cloudflare_write_failed"
  }
}
```

The Mac must log and consume that failure. Cloud presence success is not LAN DNS
success.

Stable DNS reason codes must include:

- `invalid_lan_ip`
- `cloudflare_read_failed`
- `cloudflare_write_failed`
- `cloudflare_verify_failed`
- `duplicate_cleanup_failed`
- `record_mismatch`

Human-readable text may change. Code and tests must branch on reason codes.

## 5. Activation and readiness model

The current `activate.Result.OK` conflates several independent facts. Replace
that ambiguity with explicit fields while preserving enough compatibility to
avoid a broad rewrite.

The activation result must represent at least:

```go
type Result struct {
    OK              bool   // certificate is usable; compatibility field
    Host            string
    CertFile        string
    KeyFile         string
    ExpectedIP      string
    DNSPublished    bool
    ResolverMatches bool
    ReasonCode      string
    Reason          string
}
```

`OK` must mean only that the Mac has a usable certificate/key for `Host`. It
must not mean that guests on the current network can reach the Mac.

LAN readiness is computed later from all current-network evidence:

```text
cert loaded for host
AND exact A publication verified for current IP
AND configured local resolver returns current IP
AND listener accepts a hostname-validating TLS request
```

Keep a separate real-guest confirmation signal from listener heartbeat/activity.
The Mac's own checks are predictive; a guest connection is proof.

### 5.1 Remove the false rebind classifier

Delete `dohResolves`, `ErrLocalResolverOnly`, and the log text that declares DNS
rebind protection from one resolver mismatch.

`https://1.1.1.1/dns-query` is a recursive resolver query, not an authoritative
query. Different recursive caches can legitimately disagree during a TTL. That
condition must not be called rebind protection.

Replace `verifyResolves` with a local resolver comparison that returns structured
evidence:

- expected current LAN IP;
- all locally resolved A addresses;
- match boolean;
- lookup error, when present;
- observation timestamp.

Authoritative publication evidence comes from the broker's verified Cloudflare
receipt, not from recursive DoH.

A local mismatch is initially `resolver_mismatch`, not `dns_rebind`. The console
may say that this Wi-Fi is currently preventing the LAN hostname from reaching
the Mac. Do not claim the router's mechanism unless a dedicated diagnostic proves
the authoritative record is correct and the local resolver continues suppressing
it after the relevant TTL.

### 5.2 Distinguish listener TLS from resolver TLS

Implement two bounded self-checks:

1. Direct listener check: dial the current LAN IP and guest port, send SNI for
   the machine hostname, and perform normal certificate validation. Do not use
   `InsecureSkipVerify`. This proves listener, certificate, port, and hostname
   correctness independent of DNS.
2. Guest-path check: request a small HTTPS health endpoint by the machine
   hostname using the system resolver and normal certificate validation. This
   proves the Mac's current resolver path reaches the listener.

Use a small existing read-only endpoint or add a minimal no-store endpoint such
as `/api/lan-health` that does not expose DJ-only data. Do not probe the HLS
playlist as a readiness requirement when no set is live.

### 5.3 Cached certificate behavior

Loading a cached certificate at boot remains correct and must stay fast.
However, the source `cached certificate` establishes only certificate readiness.
It must not automatically establish:

- current-IP publication;
- current resolver agreement;
- current-network TLS reachability;
- LAN room readiness.

The HTTPS listener may start immediately with the cached certificate. The
current-network refresh runs asynchronously and updates LAN readiness when its
checks complete.

If the app is offline on a controlled network, the cached certificate and local
DNS override can still establish LAN readiness without contacting Cloudflare.
That is a separate explicit offline mode, described below.

## 6. `/api/status` contract

Keep existing certificate and stream fields for compatible web payloads, but add
one authoritative LAN object. Do not force the console to infer readiness from
`llhlsRealCert`, `activation.OK`, or generic netcheck output.

Required shape:

```json
{
  "lan": {
    "state": "ready",
    "host": "seth-live.party.partyparty.party",
    "expectedIp": "192.168.1.85",
    "guestPort": 8443,
    "certReady": true,
    "dnsPublished": true,
    "resolverMatches": true,
    "listenerTlsReady": true,
    "guestPathTlsReady": true,
    "guestConfirmed": false,
    "cloudFallback": true,
    "reasonCode": "",
    "reason": "",
    "checkedAtMs": 0
  }
}
```

Allowed `state` values and exact meanings:

| State | Meaning |
|---|---|
| `checking` | Certificate may be loaded, but current-network checks are running or have not run. |
| `ready` | Certificate, publication, resolver, and both TLS checks passed for the current network. |
| `confirmed` | `ready`, plus at least one recent guest reached the machine host. |
| `cloud_fallback` | The app is online, but one or more LAN publication/resolver/TLS checks failed. |
| `offline_ready` | Explicit controlled-offline mode, cached cert valid, local DNS and TLS checks passed. |
| `offline_unverified` | Cached cert exists, but the app cannot prove default clients receive the required local DNS route. |
| `unavailable` | No valid certificate or no usable LAN address/listener. |

State precedence is deterministic:

1. No cert or host: `unavailable`.
2. Explicit offline mode: `offline_ready` only when local DNS and TLS pass;
   otherwise `offline_unverified`.
3. Online checks incomplete: `checking`.
4. Any required online check failed: `cloud_fallback`.
5. All checks passed and no recent guest: `ready`.
6. All checks passed and a recent guest exists: `confirmed`.

`cloudFallback=true` means the public handle route has a usable cloud/event
destination. It does not mean LAN failed. It can be true in `ready` state.

### 6.1 Replace the current reachability inference

Refactor `internal/server/reachability.go` and `netcheck.go` so that:

- resolving to any arbitrary address is not success;
- `192.0.2.1` is never treated as acceptable;
- the expected current IP must be present;
- the hostname-validating HTTPS result participates in state;
- an activation result with a usable cert but failed resolver check is visible;
- a recent active listener upgrades `ready` to `confirmed` but does not erase
  recorded DNS/TLS evidence;
- a stalled guest may degrade the stream health signal without rewriting DNS
  evidence.

Remove the current generic `reachabilityOK` default for an uninitialized state.
Unknown must render as `checking`, not success.

## 7. Console behavior

The DJ console must report the network truth without requiring the DJ to
interpret DNS terminology.

When `lan.state` is `ready`:

```text
LAN room ready on this Wi-Fi
```

When `confirmed`:

```text
Guest connected to the LAN room
```

When `cloud_fallback`:

```text
Guests can open the party, but this Wi-Fi is sending them to the cloud stream.
```

Show a short actionable reason based on `reasonCode`, for example:

- DNS publication failed: retrying automatically.
- This Wi-Fi is not returning the Mac's LAN address.
- The secure LAN listener is not reachable on this network.
- Port 8443 is blocked or unavailable.

Do not display:

- `activating anyway`;
- `authoritative DNS is correct` when only recursive DoH was checked;
- `DNS-rebind protection` based on one mismatch;
- `Compatible mode` or any implication that production audio will fall back to
  plain HTTP;
- `You're set` based only on `llhlsRealCert`.

The QR remains the public handle URL when online and linked. It must not change
as the Mac moves between networks.

The console may show the direct machine HTTPS URL in diagnostics, but that URL
is not the primary user-facing identity and must not be renamed with the handle.

Go Live remains available when the cloud fallback is ready even if LAN checks
fail. Do not strand the DJ because a venue blocks LAN routing. The UI must make
the degraded delivery explicit before and during the set.

## 8. Cloud router behavior

Keep `handleRouter` and `renderLiveJoin` as the public local-versus-cloud router.
Keep the authenticated HTTPS probe of the machine hostname.

The probe remains the final browser-specific decision because the Mac's own
network checks cannot prove that every phone bypasses Private Relay, encrypted
DNS, browser local-network permission, or AP client isolation.

Required behavior:

1. Live claimant with machine host: probe the HTTPS machine origin.
2. Probe succeeds: `location.replace()` to that same HTTPS origin.
3. Probe fails or times out: open the cloud event/mirror.
4. If there is no cloud mirror yet, show the existing join-on-party-Wi-Fi state.
5. Keep a manual link to the exact same HTTPS machine origin for browser prompt
   false negatives.

Delete `lanIpUrl` from:

- `handleRouter`;
- `renderLiveJoin`;
- live event rendering;
- associated tests and comments.

Delete the raw `http://<lan-ip>:8000/` retargeting script. It can load a page but
cannot play the enforced HTTPS hostname-backed `llhlsUrl`, so it is not an audio
fallback and must not be presented as one.

Do not replace it with another HTTP route.

## 9. Controlled offline network behavior

An arbitrary offline Wi-Fi network cannot automatically provide a public DNS
answer to a default-configured phone. The product must not pretend otherwise.

Reliable offline HTTPS requires a controlled network that gives guests a local
DNS answer for the same publicly certified machine hostname. Supported examples
include:

- macOS sharing/captive mode where guests receive the Mac-controlled DNS path;
- a travel router or hardware hotspot whose DHCP/DNS configuration resolves the
  machine hostname to the Mac's reserved private address.

The certificate remains the same cached public certificate. Only DNS is local.

In explicit offline mode:

1. QR points directly to the machine HTTPS hostname because the public handle
   router may be unreachable.
2. `dnsd` answers the exact machine hostname with the current shared/bridge IP.
3. The app proves that local DNS answer and hostname-validating TLS listener.
4. The console reports `offline_ready` only after those checks pass.
5. If the app cannot prove that joining phones receive its DNS path, report
   `offline_unverified`; do not claim automatic guest reachability.

Do not attempt to configure arbitrary third-party routers from the app in this
change. Do not add a router-vendor integration, install a phone profile, or ask
guests to trust a private CA.

## 10. Exact removal manifest

The implementation agent must remove these obsolete mechanisms and their tests,
comments, and UI copy. Do not leave dormant alternate paths behind.

### Cloudflare Worker

- Hourly creation of `*.party.<base> -> 192.0.2.1`.
- The existing guard wildcard itself, through the ordered DNS migration.
- `handleSlugBase`.
- `ensureHandleSlug`.
- Old-machine-A deletion performed during handle-derived renaming.
- `deleteGreyA` after its remaining current-host callers are removed.
- A-record deletion from `/api/broker/offline`.
- Best-effort swallowed DNS errors in `/api/broker/live`.
- `lanIpUrl` and every raw HTTP-IP fallback.
- Comments claiming a wildcard matches only one label or that the current guard
  produces NXDOMAIN.

### Go activation/server

- `dohResolves`.
- `ErrLocalResolverOnly`.
- `activating anyway` rebind log paths.
- Any status inference that equates a cached cert with LAN reachability.
- Any DNS check that accepts an arbitrary nonmatching address as success.
- `InsecureSkipVerify` in LAN readiness checks. If it remains in a separate
  non-trust diagnostic, it must not contribute to readiness.

### Web UI

- Raw LAN-IP links presented as guest audio recovery.
- Plain-HLS/compatible-mode production copy.
- Rebind-specific diagnosis without the required evidence.
- Optimistic `You're set` messaging based only on certificate presence.

## 11. Explicit retention manifest

Do not remove or redesign these pieces during this change:

- HTTPS LL-HLS and MediaMTX.
- Native iPhone `<audio>` HLS playback.
- Lock-screen/background behavior.
- Existing room target, sync geometry, and drift recovery.
- The public handle Worker route.
- Cloud event pages and delayed cloud mirror.
- Per-install DNS-01 certificate issuance.
- Cached certificate startup.
- Guest routes without authentication.
- DJ account activation gate.
- The HTTP DJ console/local API listener.
- `internal/broadcast/`, including protected dormant plain-HLS code.
- Captive/local DNS support used by explicit offline mode.
- The optional port-443 redirect, provided its readiness remains independently
  verified.
- BYO `PARTYPARTY_LIVE_HOST`/Cloudflare-token activation for explicit developer
  deployments. Do not expand it, route normal installs through it, or let it
  complicate broker state. It must use the same structured resolver/readiness
  semantics when selected.

## 12. File-by-file implementation sequence

Follow this order. Keep the tree buildable after each phase, but batch the final
product work into one coherent commit and one release.

### Phase 1: encode the failure in tests

Before changing behavior, add focused tests that fail against the current code:

1. `/api/broker/offline` removes presence but does not issue a DNS DELETE.
2. Scheduled maintenance creates/verifies the namespace anchor before deleting
   the guard.
3. Scheduled maintenance never recreates the guard after migration.
4. `/api/broker/a` leaves exactly one DNS-only A record with the expected IP.
5. `/api/broker/a` repairs wrong IP, proxied state, TTL, and duplicates.
6. `/api/broker/a` fails when its verification re-read disagrees.
7. `/api/broker/live` returns presence success plus explicit DNS failure.
8. Existing machine slug remains unchanged after handle confirmation/rename.
9. Router/event HTML contains no `http://<private-ip>:8000` fallback.
10. Resolver success requires the expected address, not merely any A answer.
11. Unknown readiness is `checking`, not `ok`.
12. Cached certificate alone does not produce LAN `ready`.

Use deterministic fake Cloudflare/DNS responses. Do not put public network timing
or resolver behavior in the release gate.

### Phase 2: `cloudflare/worker.js`

1. Add strict IPv4 validation.
2. Add `upsertMachineA` with duplicate cleanup and verification re-read.
3. Change `/api/broker/a` to immutable `ensureBrokerSlug` plus strict receipt.
4. Change `/api/broker/live` to shared upsert plus nested DNS receipt.
5. Remove DNS deletion from `/api/broker/offline`.
6. Remove handle-derived machine renaming.
7. Add idempotent namespace-anchor migration in `scheduled()`:
   - ensure exact TXT;
   - verify it;
   - delete all guard A records;
   - log failures with stable reason and retry next cron invocation.
8. Remove obsolete guard creation.
9. Remove raw-IP router/event fallback.
10. Update Worker smoke tests and comments.

The scheduled migration must be safe to run every minute and cheap after
completion. Cache a completion marker in R2 only as an optimization; continue to
verify the anchor periodically so accidental DNS deletion self-heals. Never
delete the guard unless the anchor was confirmed in the same run.

### Phase 3: `internal/activate/activate.go`

1. Extend `Result` with structured DNS/resolver evidence.
2. Parse the broker publication receipt and require `verified=true`.
3. Replace recursive DoH/rebind classification with expected-IP local resolution.
4. Preserve usable cached certs independently from DNS failure.
5. Return stable reason codes.
6. Keep certificate renewal conditional on certificate usability.
7. Update activation tests, including broker non-2xx, malformed receipt, verified
   receipt, local mismatch, and offline cached-cert cases.
8. Update stale package comments that still describe plain HLS as the product
   fallback.

The direct Cloudflare `Try`/`upsertA` path may remain for explicit BYO use, but it
must produce the same structured result and must not use the removed rebind
classifier.

### Phase 4: `main.go`

1. Replace the current activation loop's ambiguous success handling with the
   structured result.
2. Keep immediate cached-cert listener startup.
3. Add one serialized/coalesced refresh lane for launch, network change, wake,
   pre-live, periodic refresh, and retry.
4. Preserve the existing rule that refresh failure never tears down a valid
   certificate or interrupts a live set.
5. Detect wake without requiring a new Swift dependency if possible. A monotonic
   polling gap plus network fingerprint and periodic refresh is acceptable.
6. Make the periodic refresh short enough to repair a missed event while keeping
   broker/DNS traffic modest; start with five minutes and document it as a
   constant.
7. Feed live heartbeat DNS receipts back into server LAN state and diagnostics.
8. Replace optimistic logs with precise cert/DNS/resolver/TLS messages.

Do not add a second independent activation goroutine. One owner must serialize
certificate and DNS mutations.

### Phase 5: `internal/server`

1. Add the LAN state structure and deterministic reducer.
2. Add direct listener TLS and guest-path TLS checks.
3. Add or reuse a minimal HTTPS health endpoint.
4. Refactor reachability watchdog inputs to exact expected-IP and TLS evidence.
5. Keep guest heartbeat as a separate confirmation signal.
6. Expose the `lan` object through `/api/status`.
7. Preserve compatible existing fields until current payload/native versions no
   longer consume them.
8. Add table-driven tests for every state and precedence rule.

Do not make a failed LAN check stop the broadcast. It changes routing/status,
not audio-core state.

### Phase 6: `web/dj.html`

1. Render the explicit LAN state.
2. Use the exact approved copy from Section 7 or equally literal wording.
3. Show cloud fallback honestly when LAN checks fail.
4. Keep the public handle QR stable across network changes.
5. In explicit offline mode, use the direct certified machine URL.
6. Remove compatible/plain-HLS and speculative rebind copy.
7. Preserve all existing event, roster, feed, and sync controls.

### Phase 7: `cloudflare/worker.js` router/event rendering

If not completed in Phase 2, remove `lanIpUrl` and verify:

- local success redirects only to HTTPS machine origin;
- local failure reaches the cloud event/mirror;
- manual retry uses the same HTTPS machine origin;
- no generated HTML contains a raw private-IP guest URL.

### Phase 8: documentation cleanup

Update documentation that states any of the following:

- missing machine names are protected by a guard sentinel;
- plain HLS is the normal fallback;
- machine hosts are renamed to handles;
- recursive DoH proves authoritative DNS;
- a raw HTTP IP link restores low-latency audio.

Retain the original field brief as historical evidence. Mark it resolved and
link to this plan and the final implementation commit rather than rewriting its
observations.

## 13. Test and verification matrix

### 13.1 Required automated checks

Run all repository-required checks because this change spans Worker and Go:

```text
go build ./...
go vet ./...
gofmt -l .        # must print nothing
go test ./...
cd cloudflare && node test/smoke.mjs
cd app && swift build   # required if Swift is touched; otherwise ship.sh may run it
```

All spawned tests/builds must use the repository's capped process runner and
closed stdin according to `AGENTS.md`.

### 13.2 Worker/DNS cases

Automate with DNS mocks:

- record absent -> create -> verify;
- record already correct -> no mutation -> verify;
- wrong IP -> update -> verify;
- proxied exact record -> force DNS-only -> verify;
- duplicate exact records -> retain/update one, delete others -> verify;
- Cloudflare GET failure;
- POST failure;
- PUT failure;
- duplicate DELETE failure;
- verification re-read failure;
- malformed client IP;
- unauthorized install;
- offline presence removal without DNS deletion;
- anchor exists/guard exists;
- anchor absent/guard exists;
- anchor creation failure leaves guard intact;
- anchor verified then guard deletion;
- repeated scheduled run is idempotent.

### 13.3 Activation/readiness cases

- valid cached cert, refresh pending -> `checking`;
- valid cert, broker verified, resolver expected IP, TLS pass -> `ready`;
- same plus recent guest -> `confirmed`;
- cert valid, broker failure -> `cloud_fallback`;
- broker verified, local resolver wrong IP -> `cloud_fallback`;
- broker verified, resolver NXDOMAIN -> `cloud_fallback`;
- resolver correct, direct TLS fails -> `cloud_fallback`;
- direct TLS succeeds, hostname path fails -> `cloud_fallback`;
- explicit controlled offline DNS and TLS pass -> `offline_ready`;
- cached cert with uncontrolled offline DNS -> `offline_unverified`;
- no cert -> `unavailable`;
- network changes during refresh -> one coalesced rerun;
- repeated wake/network triggers do not issue parallel certificates;
- live refresh failure does not stop audio or invalidate cached cert.

### 13.4 Browser/UI cases

- Online LAN-ready public QR remains the handle URL.
- Public router probe success reaches HTTPS machine room.
- Probe failure reaches cloud event.
- No cloud mirror produces join-on-Wi-Fi state, not a dead raw-IP link.
- Console shows `checking`, `ready`, `confirmed`, `cloud_fallback`,
  `offline_ready`, `offline_unverified`, and `unavailable` correctly.
- No visible copy promises LAN reachability from certificate state alone.
- No guest page receives or renders `streamUrl`.
- Native iPhone still uses the existing `<audio>` HLS path.

### 13.5 Real DNS migration verification

After Worker deployment and before declaring the release healthy:

1. Query Cloudflare authoritative nameservers for the anchor TXT.
2. Query them for `*.party.partyparty.party` and prove no guard A remains.
3. Query a random never-used machine name and require NXDOMAIN.
4. Query Seth and Ramine exact names and require their expected private A values.
5. Query 1.1.1.1, 8.8.8.8, and the Mac's configured resolver after TTL expiry.
6. Confirm no resolver returns `192.0.2.1`.

Do not treat a recursive cache mismatch inside the TTL as rebind protection.
Record authoritative and recursive answers separately.

### 13.6 Physical network matrix

Use at least one iPhone on each available iOS generation and test:

1. Home Wi-Fi with internet.
2. Friend/home-style Wi-Fi with a different private subnet.
3. Coworking/venue Wi-Fi.
4. Controlled travel router/hotspot with internet.
5. Controlled travel router/hotspot without internet and with local DNS.
6. Sleep Mac, move to another network, wake, and Go Live.
7. DHCP address change while app remains open.
8. Stop and restart a set without quitting.
9. Quit and relaunch without changing networks.

For each network capture:

- Mac LAN IP;
- authoritative A answer;
- configured resolver answer;
- `lan.state` and reason code;
- direct listener TLS result;
- hostname-path TLS result;
- public QR destination;
- whether phone reached LAN or cloud;
- guest heartbeat confirmation;
- lock-screen/background playback continuity after LAN join.

## 14. Acceptance criteria

The release is accepted only when all of these pass:

1. Ending a set and quitting the app do not delete the machine A record.
2. The guard wildcard no longer exists.
3. Random absent machine names are NXDOMAIN at authoritative DNS.
4. Existing install machine names and certificates remain valid; no forced
   rename or unnecessary certificate issuance occurs.
5. Moving between ordinary networks updates the same hostname to the new LAN IP.
6. The app does not advertise LAN `ready` until exact DNS and TLS checks pass.
7. A real guest connection upgrades status to `confirmed`.
8. A blocked venue reports `cloud_fallback` and continues the set.
9. Controlled offline mode reaches the same HTTPS listener with the cached cert.
10. No guest-facing path advertises raw HTTP-IP audio recovery.
11. No production path restores plain HTTP HLS.
12. iPhone lock-screen and background playback still work after joining the LAN
    room.
13. All Go, Worker, and relevant Swift checks pass.
14. Public DNS, public Worker behavior, source `main`, installed app, and running
    app correspond to the same shipped release.

## 15. Failure handling and rollback

The safest rollback is code rollback while retaining the namespace anchor and
persistent exact A records. Those DNS changes are independently safer than the
old guard/delete lifecycle and must not be rolled back automatically.

If the new readiness reducer is wrong:

- keep serving the valid HTTPS listener;
- keep cloud routing available;
- roll back console/status classification in a new commit;
- do not recreate the guard;
- do not resume A deletion.

If DNS migration fails before guard deletion, leave the guard in place, report
the migration failure, and retry after fixing the cause. Never delete the guard
without a proven namespace anchor.

If a new app release fails after the DNS migration, existing apps continue to
use their exact persistent A records. NXDOMAIN for absent names is the intended
safe behavior.

## 16. Delivery procedure

This change touches Go runtime behavior and the Worker, so it requires a full
native release. It is not payload-only.

Follow the then-current root `AGENTS.md` exactly:

1. Work directly on clean canonical `main` as the sole writer.
2. Preserve unrelated work, including the original field brief.
3. Implement the complete unit before committing.
4. Run the required capped verification once.
5. Commit one coherent change with the required co-author trailer.
6. Let the repository's autoship controller perform the full release; do not run
   foreground `scripts/ship.sh` or duplicate its build/deploy.
7. Ensure the ordered DNS migration has completed before the release is declared
   healthy.
8. Verify public artifacts/feed/site/version, installed app version/build, and
   running app according to release policy.
9. Leave `main` clean, pushed, and free of temporary branches/worktrees.

## 17. Final implementation rule

Do not solve this by adding another fallback or another DNS heuristic.

The intended system is one stable certificate hostname, one persistent exact
private A record, one namespace anchor, one serialized refresh lane, and one
explicit LAN readiness state. Everything that contradicts that model must be
removed.
