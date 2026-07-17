# partyparty — online-first web service plan (v2)

> Historical pre-cutover design record. References to `party.ramine.net` below
> intentionally preserve the DNS evidence and migration plan as written; the
> shipped product and all current operational documentation use
> `partyparty.party`.
>
> Approved direction 2026-07-16. Doctrine: **assume online**, cloud-assisted
> discovery + identity + feed + replay; the LAN/HLS path is the offline fallback.
> Live audio NEVER leaves the LAN/HLS `<audio>` path for in-room guests; a cloud
> HLS mirror (R2) serves remote guests. Hosting runs on Cloudflare's free tier.

# PartyParty v2 — Live Everywhere, One Link (plan to approve)

Repo facts confirmed: `party.ramine.net` lives inside the single `ramine.net` CF zone (`CF_ZONE_ID` 56cc234f…); the Worker is bound apex-only via `routes:[{party.ramine.net, custom_domain:true}]` — **no `triggers.crons` today**. Mac ffmpeg already runs `-f tee` with an RTSP leg + optional ADTS record leg, both `onfail=ignore`/`use_fifo=1` (broadcast.go ~L398); plain-HLS tee was removed. Broker auth = `id`+`secret` to `/api/broker/*`; `publish.go` has the R2 upload primitives; `telemetryLoop` (main.go L79) is gated on `PARTYPARTY_TELEMETRY`; `activate.BrokerHost()` yields `<slug>.party.ramine.net`.

---

## 1. What changed from V1

- **Cloud HLS mirror added** — the same live set fans out to remote (off-LAN) guests via R2, not just LAN.
- **Same-link local/remote routing replaces "subdomain → LAN A record"** — `<username>.party.ramine.net` is now a **proxied Worker entry** that decides LAN-vs-cloud per guest; the raw LAN-IP host moves to the grey `<slug>.party.ramine.net`.
- **Free wildcard cert via `party.ramine.net` zone delegation** replaces the refused ~$10/mo ACM.
- **Auto-discovery de-privacy'd and prioritized** — Go Live == discoverable; no opt-out, no gate.
- **Follow / notify-when-live dropped** (existing "waiting for DJ → auto-plays" covers presence).
- **Pre-party invite/RSVP deferred** to Phase 4.

---

## 2. The model

The permanent link is **`<username>.party.ramine.net`**, a cloud-first proxied entry. The Worker resolves the handle to its live install, compares the guest's `cf-connecting-ip` hash to the Mac's, and branches: **LOCAL → 302 to the Mac's LAN host** (`<slug>.party.ramine.net`, tight LL-HLS, offline-capable); **REMOTE → Worker page wired to the R2 cloud mirror** (~10s behind, fine). **Both audio paths are plain HLS in a `<audio>` element** — locked-phone / background-safe identically. `/e/<slug>` is the one event identity (live → replay via a status column); `/@username` is the profile.

| Surface | Served by | Audio | Notes |
|---|---|---|---|
| `<username>.party.ramine.net` | **Cloud** (Worker) | — (router) | Permanent link; 302s or serves per guest |
| LOCAL guest → `<slug>.party.ramine.net` | **Mac** (LAN) | LL-HLS `<audio>` | Tight, offline-capable, Mac LE cert |
| REMOTE guest (Worker page) | **Cloud** (R2) | HLS `<audio>` | ~8–15s behind; zero-egress fanout |
| `/e/<slug>` | **Cloud** (R2) | m4a `<audio>` | Live status → seekable replay |
| `/@username` | **Cloud** (D1) | — | Profile aggregating events |

---

## 3. The cloud mirror

**Architecture: R2 (Option A), reject Stream Live and a 2nd cloud MediaMTX** — both bill per delivered minute / need an always-on paid origin; R2 has **zero egress** so one live set → many remote listeners is nearly free, and it reuses `publish.go`'s R2 primitives + broker auth verbatim.

- **Mac:** add a **third HLS tee leg** to `buildArgs` (stream-copy the already-encoded AAC — no second encode): `[f=hls:hls_time=3:hls_list_size=8:hls_flags=delete_segments+omit_endlist:hls_segment_type=mpegts:onfail=ignore:use_fifo=1]<scratch>/live.m3u8`. Same `onfail=ignore`+`use_fifo=1` isolation the record leg already relies on — a slow cloud leg **cannot back-pressure the LAN RTSP leg**. A new `internal/livemirror` goroutine (tied to broadcast lifecycle) watches the scratch dir and **PUTs the new `seg-N.ts` first, then the rewritten `live.m3u8`**, reusing `publish.go` httpClient/putFile/Creds, keyed by `slug` + go-live session id.
- **Worker:** `PUT /api/broker/live-segment` + `/api/broker/live-playlist` (header-authed, D1 ownership re-check like `publishUpload`) → R2 `event/<slug>/live/*`, evicting out-of-window segments inline. `GET /event/<slug>/live/<file>`: playlist `application/vnd.apple.mpegurl` **`no-store`**, `.ts` `audio/mp2t` CDN-cacheable so reads collapse to ~zero origin.
- **Cost / latency:** cost scales with concurrent **live Macs** (Class-A writes), ~$0.06 per 4h set; **listener egress = $0**. Remote latency ~8–15s (accepted).
- **Offline:** mirror simply doesn't exist offline; LAN path is unaffected. Cleanup = inline prune + cron backstop nuking `event/<slug>/live/` on registry expiry + optional R2 lifecycle rule.

---

## 4. Free cert + DNS (no paid ACM)

Confirmed by dig: `party.ramine.net` is **not** its own zone, so `ramine.net`'s Universal SSL (`ramine.net` + `*.ramine.net`, one level) does **not** cover `x.party.ramine.net`.

- **Delegate `party.ramine.net` as its own Cloudflare zone** (same account) via `party NS …` in `ramine.net`. Its Universal SSL then auto-covers `party.ramine.net` + `*.party.ramine.net` **free**.
- In the new zone: re-create apex `party.ramine.net` → Worker (proxied custom domain) + **one proxied wildcard `*.party.ramine.net` → Worker**; broker keeps writing **grey `<slug>.party.ramine.net` A → LAN IP** (more-specific beats the wildcard, so LAN hosts win and stay direct-to-IP).
- **Repoint `CF_ZONE_ID` + `CF_DNS_TOKEN` to the new zone** in the same deploy (else every cert-DNS/A upsert 403s).
- **De-risk FIRST:** create the zone and confirm Edge Certificates lists `*.party.ramine.net` before building routing. Fallback if a plan gate blocks it: path-based `/@username` (works under the existing apex cert, zero new cert).

---

## 5. Auto-discovery (simplified)

- **Mac:** `liveCheckinLoop` — sibling to `telemetryLoop` but **not** gated on `PARTYPARTY_TELEMETRY** — POSTs `{id, secret, lan_ip, title, now_playing}` to `POST /api/broker/live` every 30s while live; best-effort **offline DELETE** on Stop/quit.
- **Worker:** derives public IP from **`cf-connecting-ip` only** (never a Mac-claimed value), hashes `sha256("ip:"+ip)`, resolves `handle`/`display_name` **server-side** from `device_installs→dj_profiles` (no impersonation), upserts `live_installs` with `expires_ms=now+90s`.
- **Guest:** `GET /api/discover` (unauth) hashes the guest's `cf-connecting-ip`, selects live rows on that IP where `expires_ms>now` **`ORDER BY started_ms DESC`** (most-recent go-live = which Mac is live), returns public fields only. Landing + app join page fire it once on load + on refocus → "A party is on this Wi-Fi — Join `<DJ>`" (multi → chooser). Empty falls through to the existing QR/paste path. `title`/`now_playing` HTML-escaped.
- **Correctness lives in the read path** (`expires_ms>now` filter); the 60s cron is pure GC. **No opt-out** by design.

---

## 6. Phased build

**Phase 1 — Identity backbone (now).** Username at sign-up (soft-gate `/welcome`), editable in `/settings`; every account mints a `dj_profiles` handle + reserved-word gate (handle can't equal a broker slug pattern). `/e/<slug>` live→replay status column; `/@username` profile. All cloud/D1, no cert/DNS change yet. *Offline:* unaffected — join/listen/post still LAN-only via QR/`<slug>` host.

**Phase 2 — Subdomain + which-is-live + LAN-live host.** Delegate `party.ramine.net` zone → free wildcard; repoint `CF_ZONE_ID`/`CF_DNS_TOKEN`; add proxied `*.party.ramine.net` Worker router (LOCAL 302 / REMOTE placeholder / IDLE waiting page). `live_installs` table (migration 0007) + `POST /api/broker/live` heartbeat extending the Mac 30s loop; go-live reconciled with the existing `publish-meta` slug claim (avoid 409). LAN audio stays on grey `<slug>` host verbatim. *Offline:* QR encodes `https://<slug>.party.ramine.net/` directly (cloud bypassed; cached grey A or embedded `internal/dnsd` + cached LE cert serve it).

**Phase 3 — Cloud mirror + auto-discovery + live feed-sync.** Third tee leg + `internal/livemirror` uploader; Worker live ingest/serve routes + inline prune + cron backstop (adds the first `triggers.crons` to wrangler). REMOTE branch goes live. `GET /api/discover` + landing/app banner. Add cron GC of expired `live_installs`. *Offline:* mirror + discovery simply absent; LAN + QR unaffected.

**Phase 4 — Pre-party (later).** Invite / RSVP / Partiful-style flow. Not now.

---

## 7. Open decisions (recommend yes/no)

- **Ship the mirror as MPEG-TS, fMP4 later?** — **YES**, TS first (bulletproof native-Safari `<audio>`, no init-segment ordering); fMP4 as a later flag.
- **3s mirror segments?** — **YES** (one seg + one playlist PUT / 3s is trivially cheap; ~10s remote latency, in the accepted band).
- **Mac uploads the rewritten playlist (vs Worker generating it from an R2 LIST)?** — **YES, Mac-as-source-of-truth** (a Worker LIST per request is costly + eventually-consistent).
- **LOCAL guests get a 302 to the Mac's slug host (vs Worker proxying LAN audio cross-origin)?** — **YES, 302** (reuses today's working LAN listener, no CORS, stays offline-capable once loaded).
- **Probe the LAN `/health` after a public-IP match before committing to LOCAL?** — **YES** (~1.5s timeout; on fail self-redirect to the cloud mirror — guards VPN/CGNAT/guest-VLAN false matches).
- **Reuse the flat `<slug>`/`<username>` namespace under the wildcard (vs a `.l.` sublabel for LAN)?** — **YES, flat + reserved-word gate** (already live); sublabel only if collisions ever bite.
- **Dedicated `/api/broker/live` (vs piggyback on `/api/broker/telemetry`)?** — **YES, dedicated** (telemetry is debug-gated + heavy; discovery must not depend on a debug toggle).
- **90s presence TTL + explicit offline-delete?** — **YES** (rides one dropped 30s beat; clean stop removes instantly; crashed Mac gone in ≤1.5min).
- **Serve remote guests plain HLS, not LL-HLS?** — **YES, plain** (LL multiplies R2 PUTs + window complexity for non-dancing listeners).
- **De-risk the free wildcard by creating the zone and checking Edge Certificates BEFORE building routing?** — **YES** (fallback: path-based `/@username`, zero new cert).

---

## Appendix — subsystem designs (from the design pass)

### Cloud HLS live mirror — same permanent link serves remote guests a cloud HLS copy of the live set

**Recommendation:** Build Option A: the Mac tees a third, plain-HLS leg off the single ffmpeg encode into a local scratch dir, and a Go uploader goroutine ships each new segment + rewritten media playlist to R2 through the existing broker (x-pp-id/x-pp-secret/x-pp-slug header auth in internal/publish), where a new Worker route serves them from event/<slug>/live/ to a plain <audio> element. Reject B (Cloudflare Stream Live) because it bills per delivered minute — the exact opposite of the owner's zero-egress goal — and C (a second cloud MediaMTX) because it means running and paying for an always-on origin. A wins on every stated priority: R2 has zero egress so fanning one live set out to many remote listeners is nearly free, it reuses publish.go's proven R2 upload primitives and broker auth verbatim, and it stays plain HLS in <audio> so locked-phone/background playback is preserved identically to the LAN path. Encode-once/tee-many means the cloud leg adds no second encode and, isolated with onfail=ignore + use_fifo=1 like the existing recording leg, cannot stall or kill the LAN LL-HLS stream. Expect the remote listener to sit roughly 8-15s behind the room (segment length × live-edge depth + upload/CDN), which the directive explicitly accepts.

**What it entails:**
- Mac tee leg: in internal/broadcast/broadcast.go buildArgs, add a THIRD tee output alongside the RTSP and record legs: [f=hls:hls_time=3:hls_list_size=8:hls_flags=delete_segments+omit_endlist:hls_segment_type=mpegts:onfail=ignore:use_fifo=1]<scratchDir>/live.m3u8 — stream-copy off the same encoded AAC (no second encode), onfail=ignore/use_fifo so a slow cloud leg can NEVER back-pressure the LAN RTSP leg.
- Mac uploader: a new internal/livemirror goroutine started/stopped with the broadcast lifecycle that fs-watches scratchDir; on each change it PUTs new seg-<seq>.ts FIRST, then the rewritten live.m3u8 SECOND (never reference a segment the cloud lacks), reusing publish.go's httpClient + putFile/putBytes + Creds. Keyed by slug=SlugForEvent(...) and a per-go-live live-session id (go-live timestamp), NOT setId (no setId exists mid-set).
- Worker ingest routes: PUT /api/broker/live-segment and PUT /api/broker/live-playlist (or one route keyed by x-pp-file), header-authed via authInstall, D1 ownership re-checked against events.install_id exactly like publishUpload, writing to R2 event/<slug>/live/<file>. The playlist PUT carries the current window so the Worker deletes evicted segments inline.
- Worker serve route: GET /event/<slug>/live/<file> from R2 (env.DL) — media playlist served content-type application/vnd.apple.mpegurl with cache-control:no-store (guests must always see the live edge); .ts segments served audio/mp2t, short/immutable cache so Cloudflare's CDN collapses duplicate reads across many listeners to near-zero origin reads.
- Cleanup: Worker prunes segments as they fall out of the uploaded window (with a grace margin), plus a cron backstop that deletes the whole event/<slug>/live/ prefix when the live-installs registry row expires (set ended / Mac vanished / crash), and the Mac deletes live.m3u8 on Stop.
- Listener page (web/listener.html + the cloud idle page): pick <audio> src = LAN LL-HLS for a local guest, or https://party.ramine.net/event/<slug>/live/live.m3u8 for a remote guest — same <audio> element either way; small 'listening from away, a few seconds behind' note for the cloud path.
- Replay handoff: leave the existing post-set publish.go flow unchanged — it uploads the permanent seekable event/<slug>/<setId>.m4a. Live mirror and replay share the R2 bucket, the event/<slug>/ prefix, the D1 event row, and the broker auth, but are distinct objects with distinct lifecycles (ephemeral TS window vs one immutable m4a). Both derive from the SAME single ffmpeg encode: LAN leg + record leg (→replay) + live-cloud leg (→mirror).

**Changes:**
- `mac` — broadcast.go buildArgs: add a third HLS tee leg (mpegts, hls_time=3, list_size 8, delete_segments+omit_endlist, onfail=ignore, use_fifo=1) writing to a local scratch dir — encode-once, isolated so it can't disturb the LAN RTSP leg.
- `mac` — New internal/livemirror uploader goroutine tied to the broadcast lifecycle: watch the scratch dir, PUT new segment then rewritten playlist to the broker, reusing publish.go httpClient/putFile/putBytes/Creds; keyed by slug + go-live session id.
- `worker` — Add PUT /api/broker/live-segment and /api/broker/live-playlist (header-authed, D1 ownership re-check like publishUpload) writing R2 event/<slug>/live/*, with inline eviction of out-of-window segments.
- `worker` — Add GET /event/<slug>/live/<file>: playlist as application/vnd.apple.mpegurl no-store, .ts as audio/mp2t with CDN-cacheable headers.
- `worker` — Extend the cron sweep to delete the event/<slug>/live/ prefix when the live-installs registry row expires (crash-safe backstop).
- `r2` — New ephemeral prefix event/<slug>/live/ (rolling ~8-segment window, ~1MB resident per live Mac); optional R2 lifecycle rule as a second backstop deleting live/ objects after a few hours.
- `web` — listener.html + cloud idle page choose <audio> src between LAN LL-HLS (local) and the cloud live.m3u8 (remote), with an 'a few seconds behind' note on the cloud path.
- `d1` — No new table for the mirror itself (reuses events ownership); when the live-installs registry (V1 plan) lands, carry the live playlist pointer + expiry on its row so the cron knows what to sweep.

**Decisions:**
- Segment container for the mirror: MPEG-TS AAC vs fragmented-MP4 (init.mp4 + .m4s)? → Ship MPEG-TS first — bulletproof native-Safari HLS in <audio>, no init-segment upload ordering to get right. Keep fMP4 as a tunable flag for later (aligns with the .m4a replay and a possible LL upgrade), but TS is the lowest-risk v1.
- Where does the cloud HLS get produced — a third ffmpeg tee leg, or a second local ffmpeg pulling MediaMTX's RTSP? → Third tee leg. It reuses the single existing encode (no second decode/encode), and onfail=ignore + use_fifo=1 give the same isolation the recording leg already relies on. A separate ffmpeg only buys isolation the tee flags already provide, at 2x CPU.
- Segment length (upload cadence vs latency)? → 3s. One segment PUT + one playlist PUT per 3s per live Mac is trivially cheap on R2, and 3s keeps remote latency in the ~10s range the directive accepts. Drop to 2s only if field tests want it tighter.
- Who owns the media playlist — Mac uploads it, or the Worker generates it from an R2 list? → Mac uploads the rewritten playlist each tick (tiny, ~1/3s). A Worker-generated playlist would need an R2 LIST per guest request (costly + eventually consistent). Mac-as-source-of-truth is simpler and exact.
- Segment eviction / TTL strategy (R2 has no per-object TTL)? → Defense in depth: Mac declares its current window on each playlist PUT and the Worker deletes evicted segments inline (with a grace margin for slow fetchers), plus a cron backstop that nukes event/<slug>/live/ on registry expiry, plus an optional R2 lifecycle rule. Inline prune is the primary; the others catch crashes.
- Should remote guests get Low-Latency HLS like the LAN path? → No. Plain HLS a few seconds behind is the directive; LL-HLS partial segments would multiply R2 PUTs and complicate the sliding window for no benefit to non-dancing remote listeners. Keep the mirror plain.
- Does the live mirror need its own DNS zone / wildcard cert? → No — the mirror is served from party.ramine.net, already a Worker custom domain with an edge cert. The party.ramine.net-own-zone / Universal-SSL wildcard work belongs to the separate local-vs-remote routing task, not to building the mirror.

**Risks:** The cloud HLS leg shares one ffmpeg tee with the LAN RTSP leg — a bug or bad option in the third leg could disrupt the live LAN stream. Must verify onfail=ignore + use_fifo=1 fully isolate it (a failing cloud leg leaves RTSP untouched) before shipping; this is the single biggest risk.; Playlist/segment ordering: a guest could fetch a playlist that references a segment the Worker hasn't received. Mitigated by always PUTting the segment before the playlist that names it, and keeping evicted segments a grace margin longer than the window.; Playlist caching: if live.m3u8 is CDN-cached, remote guests freeze at a stale live edge. Must serve it no-store; only segments (content-addressed by seq) are cacheable.; Sliding-window prune race: deleting a segment a slow remote listener is mid-fetch. Mitigated by the grace margin beyond the playlist window.; Cost scales with concurrent LIVE MACS (Class A writes), not listeners — negligible today (~$0.06 per 4hr set) but worth watching if many DJs go live at once. Listener egress is zero (R2) and reads collapse via CDN.; Locked-phone playback of an ongoing (no-ENDLIST) live TS playlist in <audio> must be field-verified on a real iPhone the way the LAN path was — native HLS should keep playing backgrounded, but the ephemeral live playlist is a new shape to confirm.; A guest switching networks mid-set (LAN tight → cloud ~10s behind) experiences a time jump; acceptable per directive but should be noted in the UI.

### Same-link local/remote live routing for &lt;username&gt;.party.ramine.net + the free *.party.ramine.net wildcard TLS (zone delegation)

**Recommendation:** Make &lt;username&gt;.party.ramine.net a PROXIED (orange) Worker hostname that is the single permanent entry point, and move the LAN-audio role onto the already-working grey slug host &lt;slug&gt;.party.ramine.net (Mac-issued Let's Encrypt, grey A -&gt; LAN IP — confirmed live today: wave77.party.ramine.net resolves to 192.168.1.117). The Worker resolves the handle to its live_installs row, then compares the guest's public-IP hash (sha256("ip:"+cf-connecting-ip)) to the Mac's: match =&gt; LOCAL, 302 the guest to https://&lt;slug&gt;.party.ramine.net/ (the Mac serves the tight LAN LL-HLS listener exactly as today, offline-capable, no cross-origin); no match =&gt; REMOTE, serve a Worker listener page wired to the R2 cloud HLS mirror. Both play through a plain &lt;audio&gt; so locked-phone playback is preserved. Serving a proxied per-username host needs an edge cert for *.party.ramine.net, and I confirmed by dig that party.ramine.net is NOT its own zone (no NS/SOA delegation) — it lives inside the single ramine.net Cloudflare zone, whose Universal SSL covers only ramine.net + *.ramine.net (one level), so it does NOT cover x.party.ramine.net. The free fix is to add party.ramine.net as its OWN Cloudflare zone (same account, subdomain delegation from ramine.net); its Universal SSL then auto-covers party.ramine.net + *.party.ramine.net for free, no $10/mo ACM. A single proxied wildcard *.party.ramine.net -&gt; Worker record then serves every username, while the more-specific grey &lt;slug&gt;.party.ramine.net records carve out the LAN hosts.

**What it entails:**
- DNS ZONE: add party.ramine.net as its own Cloudflare zone (account 4e958c1f...), accept same-account subdomain delegation (or add `party NS <ns1>`/`<ns2>` in the ramine.net zone), wait for Active, verify Universal SSL lists party.ramine.net + *.party.ramine.net (free) under SSL/TLS -> Edge Certificates.
- DNS RECORDS (new zone): re-create the apex Worker custom domain party.ramine.net (proxied); add ONE proxied wildcard *.party.ramine.net -> Worker (this is what the free Universal wildcard secures); the broker re-upserts the grey &lt;slug&gt;.party.ramine.net A records (DNS-only, more-specific than the wildcard so they win for real LAN hosts).
- WORKER: point CF_ZONE_ID/CF_DNS_TOKEN at the new zone; add a host-router for *.party.ramine.net that maps the leftmost label (username) -> dj_profiles.handle -> newest non-expired live_installs row (honoring primary_install_id), then branches LOCAL (302 to the slug LAN host) vs REMOTE (cloud-mirror listener page) vs IDLE (waiting-for-DJ page + app CTA).
- WORKER: add /api/broker/live heartbeat (reads cf-connecting-ip to set public_ip_hash; body carries lan_host, lan_ip, listeners, now_playing, mirror_key) and a go-live reconcile with the existing publish-meta slug claim to avoid the 409.
- WORKER: add apex/app auto-discovery route — SELECT handle FROM live_installs WHERE public_ip_hash = sha256('ip:'+cf-connecting-ip) AND expires_ms>now — one match => offer/redirect to that username; >1 match (CGNAT) => fall back to QR/link, no privacy gate.
- D1: migration 0007 live_installs (install_id PK, handle, profile_id, lan_host, lan_ip, public_ip_hash, mirror_key, listeners, now_playing, started_ms, updated_ms, expires_ms) with indexes on (handle, started_ms DESC), (public_ip_hash, expires_ms), (expires_ms); 60s cron sweep of expired rows + lazy expiry-filter on read.
- MAC: extend the existing 30s live telemetry loop (main.go ~line 110) to also POST /api/broker/live with lan_host=activate.BrokerHost(), current LAN IP, listeners, now_playing; no cert code change — activate.go's suffix zone-walk already finds the party.ramine.net zone first.
- R2/CLOUD MIRROR (dependency, separate build): the Mac pushes a live HLS mirror of the LL-HLS set to R2 (zero egress) and reports mirror_key; the REMOTE branch serves it. Design here only routes to it.
- OFFLINE: QR encodes https://&lt;slug&gt;.party.ramine.net/ directly (cloud bypassed); resolution comes from the cached public grey A or the Mac's embedded internal/dnsd (127.0.0.1:5354, pf-redirected udp/53, CatchAll captive mode) when on a Mac-hotspot/travel-router; the Mac's cached LE cert (~60d) serves TLS with no internet.

**Changes:**
- `dns` — Delegate party.ramine.net as its own Cloudflare zone (same account) via NS records in ramine.net; this is the whole free-wildcard unlock.
- `dns` — In the new zone: apex party.ramine.net -> Worker (proxied, custom domain) + one proxied wildcard *.party.ramine.net -> Worker; grey &lt;slug&gt;.party.ramine.net A -> LAN IP records remain (broker-written, more-specific than the wildcard).
- `cert` — Universal SSL on the new zone auto-covers party.ramine.net + *.party.ramine.net for free (no ACM). LAN slug hosts keep their free per-host Mac Let's Encrypt cert (grey => edge cert irrelevant).
- `worker` — Repoint CF_ZONE_ID + CF_DNS_TOKEN to the new zone; add host-based username router (local 302 to slug host / remote cloud-mirror page / idle page), /api/broker/live heartbeat reading cf-connecting-ip, and the auto-discovery reverse-lookup.
- `d1` — New live_installs registry table (migration 0007) with handle, public_ip_hash, lan_host, lan_ip, mirror_key, listeners, now_playing, TTL expires_ms; indexes for handle-newest and public_ip_hash reverse lookup.
- `mac` — Extend the 30s live telemetry loop to also upsert the live registry (lan_host from activate.BrokerHost(), LAN IP, listeners, now_playing). No activate.go cert changes.
- `r2` — Live HLS cloud mirror bucket/prefix for remote guests (zero egress); Mac pushes it, worker's REMOTE branch serves it. Separate build, referenced as the remote audio source.

**Decisions:**
- Host-based &lt;username&gt;.party.ramine.net (needs the wildcard cert) vs path-based party.ramine.net/@username (works under the EXISTING apex cert, zero new cert work)? → Host-based, per the product directive that the permanent link is &lt;username&gt;.party.ramine.net. Keep path-based (/@username already renders profiles) as the zero-cert fallback if the subdomain-zone free-wildcard path is ever blocked by plan limits.
- For LOCAL guests: 302-redirect to the Mac's slug host, or have the Worker serve the page and only fetch LAN audio cross-origin? → 302-redirect. The Mac already serves the full listener at &lt;slug&gt;.party.ramine.net; redirecting avoids cross-origin CORS on the hls.js path, keeps the page offline-capable once loaded, and reuses today's working LAN listener verbatim.
- Trust the public-IP match outright, or probe the LAN host before committing a guest to LOCAL? → Probe. Public-IP match is a heuristic (VPN/CGNAT/guest-WiFi-isolation can lie). After the 302, the LAN page fetches /health with a ~1.5s timeout; on failure it self-redirects back to the cloud-mirror URL. Belt-and-suspenders against a black-hole LAN host.
- LAN audio host: reuse the flat &lt;slug&gt;.party.ramine.net namespace (risking a username/slug collision under the wildcard) or isolate LAN hosts under a sublabel? → Reuse the flat slug host (already built, already live) plus a reserved-word gate so a chosen handle can never equal a broker slug pattern (word+digits). Sublabel (&lt;slug&gt;.l.party.ramine.net) is the clean-room alternative if collisions ever bite — grey hosts don't need the edge wildcard so depth is free there.
- live_installs cleanup: 60s cron sweep vs lazy expiry-filter on read? → Both. Cron keeps the public_ip_hash reverse-lookup index honest for auto-discovery; lazy filtering (expires_ms>now on every read) guarantees correctness even if a cron run is skipped. Add a [triggers] crons entry (none exists in wrangler.jsonc today).
- Which Mac is 'live' for a handle when several installs share it? → Most-recent-go-live wins (ORDER BY started_ms DESC), overridden by dj_profiles.primary_install_id when set — mirrors the V1 plan and the existing primary_install_id column.

**Risks:** Subdomain-as-its-own-zone with a free Universal SSL wildcard must be confirmed on THIS account/plan — Cloudflare has historically gated some subdomain-zone setups behind Enterprise. De-risk FIRST by creating the party.ramine.net zone and checking Edge Certificates shows *.party.ramine.net before building anything. Fallbacks: path-based /@username (no new cert) or the refused $10 ACM.; Cutover blip: moving party.ramine.net to a new zone re-provisions the apex Worker custom domain + Universal SSL (minutes of DNS/cert propagation) — the app download, Sparkle appcast, sign-in, and broker all live at party.ramine.net and could briefly fail. Pre-create every record in the new zone and cut over in a quiet window.; CGNAT / shared public IP: multiple Macs (or a venue behind carrier-grade NAT) can share one public_ip_hash, so auto-discovery could match the wrong install and LOCAL detection can misfire. Mitigate with the >1-match => fall back to QR rule and the mandatory LAN-host probe before committing a guest to local.; Proxied wildcard vs specific grey records: relies on Cloudflare resolving the exact &lt;slug&gt;.party.ramine.net grey A over the proxied *.party.ramine.net (it does — exact beats wildcard). Verify after cutover so LAN hosts aren't accidentally proxied (proxying would break the direct-to-LAN-IP Plex pattern).; Username/slug namespace collision on the flat wildcard: a handle equal to a live broker slug would shadow a LAN host with the Worker page (or vice-versa). Enforce a reserved-word/handle gate at sign-up.; CF_DNS_TOKEN re-scoping: the broker's cfDNS writes to CF_ZONE_ID; after delegation the token and zone id must both point at the NEW zone or every cert-DNS/A upsert silently 403s. Rotate the secret as part of the same deploy.; Remote path depends on the R2 live HLS mirror actually existing and staying current; if the mirror lags or is absent, remote guests get nothing. The routing degrades to an honest 'live nearby only / no remote stream yet' state until the mirror build lands.

### Auto-discovery — broker live presence (live_installs) + GET /api/discover, same-public-IP match

**Recommendation:** Add a lightweight authed presence check-in (POST /api/broker/live) that the Mac fires every 30s while broadcasting — a sibling to the existing telemetryLoop but decoupled from the PARTYPARTY_TELEMETRY debug toggle — carrying {id, secret, lan_ip, title, now_playing}. The Worker derives the public IP from cf-connecting-ip (never a Mac-claimed value — the Mac can't reliably know its NAT egress IP and a client value is spoofable), hashes it with the existing sha256("ip:"+ip) pattern, resolves handle/display_name server-side from device_installs→dj_profiles (so a party can't impersonate another handle), and upserts a row into a new live_installs D1 table with expires_ms = now + 90s. A new unauth GET /api/discover hashes the guest's cf-connecting-ip the same way, selects live_installs where public_ip_hash matches and expires_ms > now ordered by started_ms DESC (most-recent go-live first = the "which Mac is live" rule), and returns only already-public fields {handle, display_name, title, now_playing, host, listeners}. The landing page and app join page fire this once on load (and on tab refocus), showing a single "A party is happening on this Wi-Fi — Join <DJ>" CTA that navigates to the Mac-reported host (https://<host>.party.ramine.net), or a short chooser list when more than one party shares the IP; empty result falls through to the existing QR/paste-link path. Correctness does not depend on the cron: /api/discover filters expired rows at read time, and a 60s cron (net-new scheduled handler) is pure housekeeping to keep the table small. This reuses the broker's existing id+secret auth, IP-hash convention, and the linked-install lookup, and stays agnostic to the slug→username hostname migration because it hands off to whatever host the Mac already activated.

**What it entails:**
- New D1 table live_installs: install_id (PK), handle, display_name, public_ip_hash (indexed), lan_ip, host, title, now_playing, listeners, started_ms, updated_ms, expires_ms — plus index idx_live_ip on (public_ip_hash, expires_ms). Shipped as migration 0007_live_installs.sql.
- POST /api/broker/live (authed, id+secret): resolve handle/display_name from device_installs→dj_profiles, hash cf-connecting-ip via sha256('ip:'+ip), UPSERT live_installs with expires_ms=now+90000; a {live:false} branch (or /api/broker/offline) DELETEs the row so a party drops immediately on go-offline/quit instead of waiting out the TTL.
- GET /api/discover (unauth, read-only): hash cf-connecting-ip, SELECT live_installs WHERE public_ip_hash=? AND expires_ms>now ORDER BY started_ms DESC, return {parties:[...]} with only public fields, cache-control no-store, lightly rate-limited by cf-connecting-ip. Returns [] cleanly when nothing matches.
- scheduled(event,env,ctx) export in worker.js doing DELETE FROM live_installs WHERE expires_ms<now, plus triggers.crons ['* * * * *'] added to wrangler.jsonc (no scheduled handler or crons exist today — this is net-new).
- Mac: a liveCheckinLoop goroutine (sibling to telemetryLoop, NOT gated on PARTYPARTY_TELEMETRY), 30s cadence while bc.Status().State=='live', POSTing {id, secret, lan_ip, title, now_playing}; best-effort offline DELETE call on broadcast stop and on app quit. lan_ip and host are already known from the /api/broker/a activation result.
- Guest UX in web/ (party.ramine.net landing + app join page): one-time GET /api/discover on load and on visibilitychange→visible; single-party banner 'A party is happening on this Wi-Fi — Join <DJ>' → navigate to https://<host>; multi-party 'Parties on this Wi-Fi' list; DJ-authored title/now_playing HTML-escaped on render; empty result leaves the existing QR/paste-link fallback untouched.
- Handoff: the Join CTA points at the exact host string the Mac reported (the /api/broker/a activation host), so V2 cloud-first routing at <host>.party.ramine.net decides local-LAN vs cloud-mirror — discovery only delivers the guest to the permanent link.

**Changes:**
- `d1` — Add migration 0007_live_installs.sql: create live_installs (install_id PK, handle, display_name, public_ip_hash, lan_ip, host, title, now_playing, listeners, started_ms, updated_ms, expires_ms) + index idx_live_ip on (public_ip_hash, expires_ms).
- `worker` — Add authed POST /api/broker/live handler (resolve handle via device_installs→dj_profiles, hash cf-connecting-ip, upsert live_installs, TTL 90s) plus a {live:false} delete branch for go-offline/quit.
- `worker` — Add unauth GET /api/discover: hash cf-connecting-ip, select live parties on that IP where expires_ms>now ordered by started_ms DESC, return public fields only, no-store, rate-limited.
- `worker` — Add scheduled(event,env,ctx) export that DELETEs expired live_installs rows (housekeeping; read path already filters by expires_ms).
- `worker` — Add triggers.crons ['* * * * *'] to wrangler.jsonc to drive the 60s sweep (no crons configured today).
- `mac` — Add a live check-in loop (sibling to telemetryLoop, independent of PARTYPARTY_TELEMETRY) posting {id,secret,lan_ip,title,now_playing} every 30s while live, plus a best-effort offline delete on broadcast stop and app quit.
- `web` — Add discovery banner to party.ramine.net landing + app join page: one-time /api/discover fetch on load and refocus, single-party Join CTA to https://<host>, multi-party chooser, escape DJ title, fall through to QR/paste when empty.

**Decisions:**
- Dedicated /api/broker/live check-in, or piggyback presence onto the existing /api/broker/telemetry heartbeat? → Dedicated endpoint. Telemetry is debug-only (disable-able via PARTYPARTY_TELEMETRY=0) and ships a ~20KB snapshot; coupling discoverability to a debug toggle is wrong, and a tiny presence payload keeps the write cheap. Drive it from a sibling goroutine on the same 30s/while-live trigger.
- Trust a Mac-sent public IP, or read cf-connecting-ip at the edge? → cf-connecting-ip only, on BOTH the Mac check-in and the guest fetch. The Mac cannot reliably know its NAT egress IP, and a client-supplied value is spoofable; the edge value is authoritative and injection-proof. Store it hashed (sha256('ip:'+ip)) to match the existing session/rsvp convention — never persist the raw IP.
- Require a 60s cron for expiry, or expire lazily at read time? → Both, but correctness lives in the read path: /api/discover filters expires_ms>now, so the feature is correct even if the cron never runs. Add the 60s cron only as GC to keep the table small. This avoids making a brand-new scheduled handler a correctness dependency.
- How does the guest page hand off — reconstruct <handle>.party.ramine.net, or echo the host the Mac reported? → Echo the exact host the Mac already activated (the /api/broker/a result), stored in live_installs.host. This keeps discovery agnostic to the in-flight slug→username hostname migration and guarantees the link the guest opens is the one with a live A record.
- Guest-page cadence: one-time on load, or poll? → One-time on load plus a refetch on visibilitychange→visible, per the 'foreground-only, one-time' directive. No background polling — it's cheap, respects the directive, and a returning guest who just joined a network gets a fresh check on refocus.
- TTL length for a live_installs row? → 90s (three missed 30s check-ins). Long enough to ride out one dropped heartbeat without the party flickering out of the list, short enough that a crashed Mac disappears within ~1.5 min. Pair with the explicit offline-delete so a clean stop removes the party instantly.
- Include now_playing / track in the banner? → Yes, optional. Pull now_playing from the same status snapshot the Mac already has so the banner can read 'Join <DJ> — <track>'; keep it nullable and HTML-escaped. It measurably raises 'is this really my party' confidence at zero extra plumbing.

**Risks:** CGNAT / shared carrier NAT: strangers behind the same public IP would see each other's party. Accepted per the no-privacy-fuss directive, but label the banner softly ('a party may be on this Wi-Fi') and keep QR/paste as the precise path; a coarse ASN/city second signal can tighten it later if needed.; NAT/protocol mismatch causes silent misses: guest on IPv6 while the Mac heartbeats over IPv4 (or a guest-VLAN that egresses a different public IP than the Mac) yields non-matching hashes and no discovery, even on the same physical Wi-Fi. This fails closed and is covered by the QR/paste fallback, but it means auto-discovery is best-effort, not guaranteed.; XSS via DJ-authored title/now_playing rendered into the guest banner — must be HTML-escaped on output (the codebase already has esc()).; Impersonation if the handle were client-supplied — mitigated by resolving handle/display_name server-side from device_installs→dj_profiles, never from the check-in body.; Presence staleness on a hard crash for up to the 90s TTL; mitigated by the read-time expiry filter and the explicit offline-delete on clean stop.; By design there is NO opt-out: clicking Go Live makes the party discoverable to anyone sharing the egress IP. This is the intended behavior, but it is the one property to keep in mind if the privacy stance ever changes.

## Addendum (2026-07-16, field-driven): discovery/routing is LAN-probe-based, not IP-match-based

The predicted "NAT/protocol mismatch causes silent misses" risk was confirmed at the
FIRST real party: a guest iPhone on the DJ's Wi-Fi showed Cloudflare a different
public IP than the DJ's Mac (iCloud Private Relay / carrier NAT / v4-v6 split), so
neither party.ramine.net nor <handle>.party.ramine.net matched. The QR (direct LAN
host) worked — which is also the proof of the replacement mechanism.

**Mechanism now:** the join page / landing ships the live party's LAN URL
(https://<slug>.party.ramine.net:<port>/) and the BROWSER probes it: a no-cors
HTTPS fetch resolves iff the guest can reach the Mac's private LAN IP presenting a
valid cert for that exact hostname — authenticated proof of being on the party's
Wi-Fi. Reachable → tight LAN room; not → cloud mirror + a manual "tap to join"
link. /api/discover returns live parties globally (IP only reorders as a hint);
the probe is the gate, not the IP. Adversarially reviewed (3 lenses, no blockers):
Apple confirms Private Relay never proxies local-network connections, and a
subresource TLS name-mismatch hard-fails with no interstitial, so same-private-IP
strangers can't false-positive.

**Staged probe UX:** show the cloud player after 3s (never block on a slow probe),
keep probing to 12s (Chrome 142+ shows a local-network permission prompt that needs
time); late LAN success auto-jumps unless audio already started (then an inline
"switch to the live room" upgrade link).

**Known dead zones (fail closed to the cloud mirror; manual link remains):**
- Chromium local-network permission denied/ignored → probe false-negative; the
  manual link (top-level navigation, exempt) still joins. The Go server answers
  PNA preflights (Access-Control-Allow-Private-Network) for older Chromium.
- Router DNS-rebind protection (Fritz!Box default, some resolvers) strips public
  DNS answers pointing at RFC1918 → name won't resolve on that venue LAN at all
  (also breaks the QR path). DJ remedy: allowlist party.ramine.net in the router.
- AP/client isolation or guest VLANs block station-to-station traffic → probe
  fails, but so would the LAN audio; the mirror is the correct outcome.
- The probe (like the QR) is load-bearing on the Mac's :<port> cert being valid,
  unexpired, and name-matching — a cert-provisioning gap silently degrades every
  on-LAN guest to the mirror. Cert health belongs in go-live health checks.
