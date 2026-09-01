// cloudflare/worker.js
var SITE_ORIGIN = "https://partyparty.party";
var DEFAULT_OG_IMAGE = "/img/social-card.png";
// There is no public download any more: the app reaches people through the
// permanent TestFlight link, which is the site's only call to action. What
// remains here is the UPDATE path for Macs already carrying a standalone build
// - removing that would strand them on whatever version they have, silently.
// The advertised entry point, /PartyParty-Beta.zip, is gone.
var STANDALONE_FILES = {
  "/appcast.xml": { key: "standalone/appcast.xml", type: "application/xml; charset=utf-8", cache: "public, max-age=300" }
};
// Versioned release downloads are resolved from R2 BY NAME, never from a map in
// this source. The map version of this shipped a release whose zip was uploaded
// and advertised while the map had no entry, so every updating Mac got a 404
// from a ship that passed all its gates. A name either exists in the bucket or
// it does not; there is no registry to forget to update, and shipping a release
// no longer edits or redeploys this Worker at all.
var STANDALONE_RELEASE = /^\/downloads\/(PartyParty-\d+(?:\.\d+)*-\d+\.zip)$/;

// The published appcast is the single source of truth for what version is out:
// it is the artifact Sparkle updates from, uploaded as the LAST step of a ship.
// Deriving /api/version from it (instead of a constant edited at ship time)
// means the site can never claim a version whose update feed does not serve it.
// Cached briefly per isolate; the public release verifier polls for a minute.
var VERSION_CACHE = { at: 0, version: "", date: "" };
async function appcastVersion(env) {
  const now = Date.now();
  if (VERSION_CACHE.version && now - VERSION_CACHE.at < 30000) return VERSION_CACHE;
  try {
    const object = await env.DL.get("standalone/appcast.xml");
    if (!object) return VERSION_CACHE;
    const xml = await object.text();
    const version = (xml.match(/<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/) || [])[1] || "";
    let date = "";
    const pub = (xml.match(/<pubDate>([^<]+)<\/pubDate>/) || [])[1];
    if (pub) {
      const parsed = new Date(pub);
      if (!isNaN(parsed)) date = parsed.toISOString().slice(0, 10);
    }
    if (version) VERSION_CACHE = { at: now, version, date };
  } catch (_) {}
  return VERSION_CACHE;
}
var esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
var absUrl = (s) => {
  try {
    return new URL(s || "/", SITE_ORIGIN).href;
  } catch (_) {
    return SITE_ORIGIN + "/";
  }
};
async function readJsonResult(request, maxBytes = 16384) {
  const cap = Math.max(0, Number(maxBytes) || 0);
  const len = Number(request?.headers?.get("content-length") || "0");
  if (len && len > cap) {
    return { value: null, tooLarge: true };
  }
  try {
    if (!request?.body?.getReader) return { value: null, tooLarge: false };
    let text = "";
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {
        });
        return { value: null, tooLarge: true };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { value: text ? JSON.parse(text) : null, tooLarge: false };
  } catch (_) {
    return { value: null, tooLarge: false };
  }
}
async function readJson(request, maxBytes = 16384) {
  return (await readJsonResult(request, maxBytes)).value;
}
async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(String(str == null ? "" : str));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
var CSS = `
:root{--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--ink2:#6e6e73;--ink3:#6e6e73;--line:#e6e6e9;--accent:#d41446;--pill:999px;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);line-height:1.45}a{color:inherit;text-decoration:none}
nav{max-width:760px;margin:0 auto;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{font-size:18px;font-weight:700}.navlinks,.ecta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:var(--pill);padding:11px 18px;background:var(--accent);color:#fff;font:inherit;font-size:14px;font-weight:650;cursor:pointer}.btn.lt{background:var(--card);border-color:var(--line);color:var(--ink)}.btn.sm{padding:8px 13px}
.page{max-width:760px;margin:0 auto;padding:8px 20px 60px}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:24px;margin-top:16px}.card h1,.card h2{margin:0 0 6px}.sub,.hint,.emptyline,.sectionhead p{color:var(--ink2)}
.sectionhead{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
footer{max-width:760px;margin:0 auto;padding:24px 20px 48px;color:var(--ink3);font-size:13px;display:flex;justify-content:space-between;gap:12px}
@media(max-width:560px){.sectionhead{display:grid}.navlinks .btn:first-child{display:none}}
`;
var SVGDEFS = "";
// One door, the same one the landing page offers. It used to say "Coming to the
// Mac App Store", which was never true of this app and had sat there for weeks.
var NAV = `<nav><a class="brand" href="/">PartyParty</a><div class="navlinks"><a class="btn sm" href="https://testflight.apple.com/join/HPRAgyJk" target="_blank" rel="noopener">Join the TestFlight beta</a></div></nav>`;
var TOAST_JS = "";
function shell({ title, desc, ogImage, url, body }) {
  const pageUrl = absUrl(url || "/");
  const imageUrl = absUrl(ogImage || DEFAULT_OG_IMAGE);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:url" content="${esc(pageUrl)}"><meta property="og:site_name" content="PartyParty"><meta property="og:image" content="${esc(imageUrl)}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="PartyParty: Your Mac, their phones, one live room">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(imageUrl)}"><meta name="twitter:image:alt" content="PartyParty: Your Mac, their phones, one live room">
<meta name="theme-color" content="#f5f5f7"><meta name="color-scheme" content="light">
<link rel="canonical" href="${esc(pageUrl)}">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u{1F57A}</text></svg>">
<style>${CSS}</style></head><body>${SVGDEFS}${NAV}${body}${TOAST_JS}</body></html>`;
}
function legalResponse(pathname) {
  const privacy = pathname === "/privacy";
  const body = privacy ? `<div class="page">
    <div class="card">
      <h1>Privacy policy</h1>
      <p class="sub">Effective July 26, 2026</p>
      <h2>What PartyParty does</h2>
      <p>On ordinary venue Wi-Fi, the Mac app serves live audio and the active party room directly to guests. If the Wi-Fi prevents nearby devices from connecting, the Mac can select relay mode so encrypted guest requests and live audio pass through PartyParty's Cloudflare service while the room is active.</p>
      <h2>Relay mode</h2>
      <p>Relay mode is a live transport, not cloud party storage. Live audio, listening status, text posts, reactions, and still photos pass through to the DJ's Mac and are not retained by PartyParty. Photo transfer is capped and throttled so music stays first. Videos are unavailable in relay mode and do not enter the relay. Short rolling HLS media parts and still photos may be cached for up to 60 seconds to avoid repeatedly uploading identical bytes from the Mac. There are no cloud recordings, replays, or public event pages.</p>
      <h2>Secure room address</h2>
      <p>Each installation receives a random credential and a two-word hostname used only to provision its certificate-backed local room address. This infrastructure identifier is not connected to a PartyParty account or profile.</p>
      <h2>Diagnostics</h2>
      <p>The Mac App Store edition keeps diagnostics on the Mac and does not upload session logs or status telemetry. Cloudflare may process ordinary request metadata needed to operate and secure the website and certificate broker.</p>
      <h2>Sharing and tracking</h2>
      <p>PartyParty does not sell personal data, track people across apps or websites, or use infrastructure data for advertising.</p>
      <h2>Contact</h2>
      <p>Questions or privacy requests: <a href="mailto:support@partyparty.party"><u>support@PartyParty.party</u></a>.</p>
    </div>
  </div>` : `<div class="page">
    <div class="card">
      <h1>Support</h1>
      <p class="sub">Help with PartyParty for Mac.</p>
      <h2>Contact</h2>
      <p>Email <a href="mailto:support@partyparty.party"><u>support@PartyParty.party</u></a> with the app version, macOS version, and a short description of what happened.</p>
      <p>For reproducible bugs, use the <a href="https://github.com/tetrisgm/partyparty/issues/new/choose"><u>GitHub issue templates</u></a> and omit credentials, private party URLs, and guest information.</p>
      <h2>Before a party</h2>
      <p>Connect the Mac and guests to the venue Wi-Fi, open PartyParty, select the audio source, and use the displayed HTTPS QR code. Guests need no account and can keep listening while their iPhone is locked.</p>
      <h2>Privacy</h2>
      <p>Read the <a href="/privacy"><u>privacy policy</u></a>.</p>
    </div>
  </div>`;
  return new Response(shell({
    title: `${privacy ? "Privacy" : "Support"} \xB7 PartyParty`,
    desc: privacy ? "How PartyParty handles local party and infrastructure data." : "Support for PartyParty on Mac.",
    ogImage: DEFAULT_OG_IMAGE,
    url: pathname,
    body: body + `<footer><span>PartyParty</span><span><a href="/privacy">Privacy</a> \xB7 <a href="/support">Support</a></span></footer>`
  }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}
var jsonResp = (status, obj, headers = void 0) => {
  const h = new Headers(headers || {});
  h.set("content-type", "application/json");
  return new Response(JSON.stringify(obj), { status, headers: h });
};
function requestMediaType(request) {
  return String(request.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
}
function isJsonContentType(request) {
  return requestMediaType(request) === "application/json";
}
function isRelayProbeContentType(request) {
  // Older listener pages deliberately used the CORS-safelisted text/plain
  // envelope for this cross-origin recovery report. The body is still bounded
  // and strictly typed as JSON below, so retain that wire compatibility.
  const mediaType = requestMediaType(request);
  return mediaType === "application/json" || mediaType === "text/plain";
}
function jsonMethodNotAllowed(allow, error) {
  return jsonResp(405, { error }, { allow });
}
function methodNotAllowed(allow) {
  return new Response("Method Not Allowed", { status: 405, headers: { allow } });
}
function withoutBodyForHead(request, response) {
  if (request.method !== "HEAD") return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
function withProductSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
var BROKER_HOST_FIRST_WORDS = [
  "disco",
  "neon",
  "cosmic",
  "velvet",
  "electric",
  "midnight",
  "glitter",
  "funky",
  "groovy",
  "silver",
  "golden",
  "laser",
  "boogie",
  "rainbow",
  "happy",
  "wild",
  "super",
  "magic",
  "lucky",
  "tropical"
];
var BROKER_HOST_SECOND_WORDS = [
  "dance",
  "groove",
  "party",
  "boogie",
  "beat",
  "disco",
  "jam",
  "rave",
  "vinyl",
  "strobe",
  "rhythm",
  "chorus",
  "bass",
  "remix",
  "encore",
  "speaker",
  "turntable",
  "dancefloor",
  "mixtape",
  "headliner"
];
async function newHostLabel(env, id) {
  for (let tries = 0; tries < 20; tries++) {
    const first = BROKER_HOST_FIRST_WORDS[Math.floor(Math.random() * BROKER_HOST_FIRST_WORDS.length)];
    const second = BROKER_HOST_SECOND_WORDS[Math.floor(Math.random() * BROKER_HOST_SECOND_WORDS.length)];
    const cand = `${first}-${second}`;
    if (!await env.DL.get(`broker/host/${cand}`) && !await env.DL.get(`broker/slug/${cand}`) && !await env.DL.get(`broker/join/${cand}`) && !await env.DL.get(`broker/handle/${cand}`)) return cand;
  }
  return `party-${id.slice(0, 6)}`;
}

// The join name a guest actually reads: two party words, minted once per
// install and mapped to its relay token. r-<32hex> stays valid forever (old
// QRs and printed links), but nobody should have to look at it.
const JOIN_NAME_RE = /^[a-z]+-[a-z]+(-\d{1,2})?$/;
async function newJoinName(env) {
  for (let tries = 0; tries < 20; tries++) {
    const first = BROKER_HOST_FIRST_WORDS[Math.floor(Math.random() * BROKER_HOST_FIRST_WORDS.length)];
    const second = BROKER_HOST_SECOND_WORDS[Math.floor(Math.random() * BROKER_HOST_SECOND_WORDS.length)];
    const cand = tries < 10 ? `${first}-${second}` : `${first}-${second}-${Math.floor(Math.random() * 90) + 10}`;
    if (!await env.DL.get(`broker/join/${cand}`) && !await env.DL.get(`broker/host/${cand}`) && !await env.DL.get(`broker/slug/${cand}`) && !await env.DL.get(`broker/handle/${cand}`)) return cand;
  }
  return "";
}

function joinNameFromHost(hostname, env) {
  const suffix = `.${String(env.BROKER_BASE || "").toLowerCase()}`;
  const host = String(hostname || "").toLowerCase();
  if (!host.endsWith(suffix)) return "";
  const label = host.slice(0, -suffix.length);
  if (label.includes(".") || label.startsWith("r-")) return "";
  return JOIN_NAME_RE.test(label) ? label : "";
}
async function ensureHostLabel(env, id, rec) {
  if (!rec.hostLabel && rec.slug) {
    rec.hostLabel = rec.slug;
    delete rec.slug;
    await env.DL.put(`broker/host/${rec.hostLabel}`, id);
    await env.DL.put(`broker/${id}.json`, JSON.stringify(rec));
  }
  if (rec.hostLabel) return rec.hostLabel;
  const hostLabel = await newHostLabel(env, id);
  rec.hostLabel = hostLabel;
  await env.DL.put(`broker/host/${hostLabel}`, id);
  await env.DL.put(`broker/${id}.json`, JSON.stringify(rec));
  return hostLabel;
}
function machineHost(env, label) {
  return `${label}.party.${env.BROKER_BASE}`;
}
function normalizeDirectURL(env, value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const suffix = `.party.${String(env.BROKER_BASE || "").toLowerCase()}`;
    const hostname = parsed.hostname.toLowerCase();
    if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
        parsed.pathname !== "/" || parsed.search || parsed.hash ||
        !hostname.endsWith(suffix)) return null;
    const label = hostname.slice(0, -suffix.length);
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
    return `${parsed.origin}/`;
  } catch (_) {
    return null;
  }
}
async function cfDNS(env, method, suffix, body, zoneId) {
  const zone = zoneId || env.CF_ZONE_ID;
  const url = `https://api.cloudflare.com/client/v4/zones/${zone}/dns_records${suffix}`;
  const resp = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${env.CF_DNS_TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : void 0
  });
  const j = await resp.json().catch(() => ({}));
  if (!j.success) throw new Error("cloudflare: " + (j.errors && j.errors[0] ? j.errors[0].message : resp.status));
  return j.result;
}
async function authInstall(env, id, secret) {
  if (!/^[a-f0-9]{12}$/.test(String(id || ""))) return null;
  const rec = await env.DL.get(`broker/${id}.json`).then((o) => o ? o.json() : null);
  if (!rec || rec.secret !== secret) return null;
  return rec;
}

// "I have never heard of you" is a different answer to "that is not your
// secret", and a Mac needs to be able to tell them apart.
//
// Both used to come back as one opaque 403, and a Mac only ever registers when
// its own install.json is missing - so an install this side had forgotten kept
// presenting the same id forever and got refused forever: no DNS, no cert, no
// relay, no self-heal, and nothing on screen saying why. Saying so plainly lets
// the Mac register again and carry on.
//
// Safe to answer honestly: registering mints a NEW id, so knowing that an id is
// unknown gets a caller nothing it could not get by asking to register.
async function installKnown(env, id) {
  if (!/^[a-f0-9]{12}$/.test(String(id || ""))) return false;
  return !!await env.DL.head(`broker/${id}.json`);
}

async function installAuthFailure(env, id) {
  return await installKnown(env, id)
    ? jsonResp(403, { error: "bad install auth" })
    : jsonResp(403, { error: "unknown install", reregister: true });
}
function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function relayHost(env, token) {
  return `r-${token}.${env.BROKER_BASE}`;
}
function relaySubnet(ip) {
  if (!isValidIPv4(ip)) return "";
  const parts = ip.split(".");
  const octets = parts.map(Number);
  if (octets[0] === 0 || octets[0] === 127 || octets[0] >= 224 ||
      (octets[0] === 169 && octets[1] === 254)) return "";
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}
function isValidIPv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ""));
  if (!m) return false;
  return m.slice(1, 5).every((o) => {
    const n = Number(o);
    return n >= 0 && n <= 255 && String(n) === o;
  });
}
async function upsertMachineA(env, rec, expectedIPv4) {
  const host = machineHost(env, rec.hostLabel);
  if (!isValidIPv4(expectedIPv4)) return { ok: false, host, reason: "invalid_lan_ip" };
  let existing;
  try {
    existing = await cfDNS(env, "GET", `?type=A&name=${encodeURIComponent(host)}`) || [];
  } catch (e) {
    return { ok: false, host, reason: "cloudflare_read_failed" };
  }
  let keep = existing.find((r) => r.content === expectedIPv4 && r.proxied === false) || existing[0] || null;
  try {
    if (!keep) {
      keep = await cfDNS(env, "POST", "", { type: "A", name: host, content: expectedIPv4, ttl: 60, proxied: false });
    } else if (keep.content !== expectedIPv4 || keep.ttl !== 60 || keep.proxied !== false) {
      keep = await cfDNS(env, "PUT", "/" + keep.id, { type: "A", name: host, content: expectedIPv4, ttl: 60, proxied: false });
    }
  } catch (e) {
    return { ok: false, host, reason: "cloudflare_write_failed" };
  }
  try {
    for (const r of existing) if (r.id !== keep.id) await cfDNS(env, "DELETE", "/" + r.id);
  } catch (e) {
    return { ok: false, host, reason: "duplicate_cleanup_failed" };
  }
  let after;
  try {
    after = await cfDNS(env, "GET", `?type=A&name=${encodeURIComponent(host)}`) || [];
  } catch (e) {
    return { ok: false, host, reason: "cloudflare_verify_failed" };
  }
  if (after.length !== 1 || after[0].content !== expectedIPv4 || after[0].proxied !== false) {
    return { ok: false, host, reason: "record_mismatch" };
  }
  return { ok: true, host, ip: expectedIPv4, recordId: after[0].id, proxied: false, verified: true };
}
var NAMESPACE_ANCHOR_CONTENT = "partyparty-machine-namespace-v1";
async function ensureNamespaceAnchor(env) {
  if (!(env.CF_DNS_TOKEN && env.CF_ZONE_ID && env.BROKER_BASE)) {
    return { ok: false, reason: "not_configured" };
  }
  const anchorName = `party.${env.BROKER_BASE}`;
  const guardName = `*.party.${env.BROKER_BASE}`;
  const hasAnchor = (recs) => (recs || []).some((r) => String(r.content || "").replace(/^"|"$/g, "") === NAMESPACE_ANCHOR_CONTENT);
  let txt;
  try {
    txt = await cfDNS(env, "GET", `?type=TXT&name=${encodeURIComponent(anchorName)}`);
  } catch (e) {
    return { ok: false, reason: "anchor_read_failed" };
  }
  if (!hasAnchor(txt)) {
    try {
      await cfDNS(env, "POST", "", { type: "TXT", name: anchorName, content: NAMESPACE_ANCHOR_CONTENT, ttl: 300 });
    } catch (e) {
      return { ok: false, reason: "anchor_create_failed" };
    }
  }
  let confirm;
  try {
    confirm = await cfDNS(env, "GET", `?type=TXT&name=${encodeURIComponent(anchorName)}`);
  } catch (e) {
    return { ok: false, reason: "anchor_verify_failed" };
  }
  if (!hasAnchor(confirm)) return { ok: false, reason: "anchor_unverified" };
  let guards;
  try {
    guards = await cfDNS(env, "GET", `?type=A&name=${encodeURIComponent(guardName)}`);
  } catch (e) {
    return { ok: true, anchor: true, guardCleanup: "read_failed" };
  }
  let deleted = 0;
  for (const r of guards || []) {
    try {
      await cfDNS(env, "DELETE", "/" + r.id);
      deleted++;
    } catch (e) {
    }
  }
  return { ok: true, anchor: true, deletedGuards: deleted };
}
async function discoverRateLimited(ipHash, bucket = "discover", maxAge = 2) {
  try {
    const cache = caches.default;
    if (!cache) return false;
    const key = new Request(`https://ratelimit.partyparty.internal/${bucket}/${ipHash}`);
    if (await cache.match(key)) return true;
    await cache.put(key, new Response("1", { headers: { "cache-control": `max-age=${maxAge}` } }));
    return false;
  } catch (e) {
    return false;
  }
}
const BROKER_JSON_MAX_BYTES = 16384;
async function broker(request, env, pathname) {
  if (pathname === "/api/broker/ping") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return jsonMethodNotAllowed("GET, HEAD", "GET or HEAD required");
    }
    return withoutBodyForHead(request, jsonResp(200, { ok: true, t: Date.now() }));
  }
  if (request.method !== "POST") return jsonMethodNotAllowed("POST", "POST required");
  if (!isJsonContentType(request)) return jsonResp(415, { error: "application/json required" });
  if (!env.CF_DNS_TOKEN || !env.CF_ZONE_ID || !env.BROKER_BASE) return jsonResp(503, { error: "broker not configured" });
  const parsed = await readJsonResult(request, BROKER_JSON_MAX_BYTES);
  if (parsed.tooLarge) return jsonResp(413, { error: "too large" });
  const body = parsed.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonResp(400, { error: "bad json" });
  if (pathname === "/api/broker/register") {
    const ipHash = await sha256Hex(`ip:${request.headers.get("cf-connecting-ip") || ""}`);
    if (env.REGISTRATION_RATE_LIMITER) {
      const result = await env.REGISTRATION_RATE_LIMITER.limit({ key: ipHash });
      if (!result.success) {
        return jsonResp(429, { error: "slow down" }, { "retry-after": "60" });
      }
    }
    if (await discoverRateLimited(ipHash, "register", 10)) {
      return jsonResp(429, { error: "slow down" }, { "retry-after": "10" });
    }
    const id2 = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const secret = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const hostLabel = await newHostLabel(env, id2);
    await env.DL.put(`broker/host/${hostLabel}`, id2);
    await env.DL.put(`broker/${id2}.json`, JSON.stringify({ secret, hostLabel, created: Date.now() }));
    return jsonResp(200, { id: id2, secret, base: env.BROKER_BASE, hostLabel });
  }
  // Does this credential publish to this room?
  //
  // Asked by the relay origin, which cannot know publish credentials: the broker
  // mints one per install at registration and gives it only to that Mac. The
  // origin therefore has to ask, and it asks whether a PRESENTED token is right
  // rather than what the right token is, so no publish credential is ever handed
  // out here and the origin box stores nothing that could publish to a room.
  //
  // Unauthenticated on purpose. It confirms only a token the caller already holds
  // and never reveals one, and a 192 bit token is not guessable. Requiring a
  // shared secret would mean provisioning one onto the origin, which is a
  // credential to leak in exchange for nothing.
  if (pathname === "/api/broker/relay/verify") {
    const room = String(body.room || "");
    const presented = String(body.token || "");
    if (!/^[a-f0-9]{32}$/.test(room) || !/^[a-f0-9]{48}$/.test(presented)) {
      return jsonResp(403, { ok: false });
    }
    const owner = await env.DL.get(`broker/relay/${room}`);
    if (!owner) return jsonResp(404, { ok: false });
    const raw = await env.DL.get(`broker/${await owner.text()}.json`);
    if (!raw) return jsonResp(404, { ok: false });
    let want = "";
    try { want = String(JSON.parse(await raw.text()).relayPublishToken || ""); } catch (e) {}
    if (!want || want.length !== presented.length) return jsonResp(403, { ok: false });
    // Constant time compare, so a wrong answer never leaks where it went wrong.
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ presented.charCodeAt(i);
    return jsonResp(diff === 0 ? 200 : 403, { ok: diff === 0 }, { "cache-control": "no-store" });
  }
  if (pathname === "/api/broker/wildcard-cert") {
    const id2 = String(body.id || "");
    if (!await authInstall(env, id2, body.secret || "")) {
      return installAuthFailure(env, id2);
    }
    const obj = await env.DL.get("wildcard/current.json");
    if (!obj) return jsonResp(404, { error: "wildcard cert not provisioned" });
    return new Response(await obj.text(), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }
  const isAdmin = env.ADMIN_KEY && body.admin === env.ADMIN_KEY;
  if (pathname === "/api/broker/installs") {
    if (!isAdmin) return jsonResp(403, { error: "admin only" });
    const list = await env.DL.list({ prefix: "broker/", limit: 1e3 });
    const installs = [];
    for (const o of list.objects) {
      if (!o.key.endsWith(".json")) continue;
      try {
        const r2 = await env.DL.get(o.key).then((x) => x ? x.json() : null);
        if (r2) installs.push({ id: o.key.slice(7, -5), hostLabel: r2.hostLabel || r2.slug || "", created: r2.created || 0 });
      } catch (e) {
      }
    }
    return jsonResp(200, { installs });
  }
  if (pathname === "/api/broker/dns-admin") {
    if (!isAdmin) return jsonResp(403, { error: "admin only" });
    const op = String(body.op || "list");
    const zone = body.zone != null && /^[0-9a-f]{32}$/i.test(String(body.zone)) ? String(body.zone) : void 0;
    if (body.zone != null && !zone) return jsonResp(400, { error: "bad zone" });
    try {
      if (op === "list") {
        const search = body.search ? `&search=${encodeURIComponent(String(body.search).slice(0, 120))}` : "";
        const recs = await cfDNS(env, "GET", `?per_page=100${search}`, void 0, zone);
        return jsonResp(200, { ok: true, records: (recs || []).map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied })) });
      }
      if (op === "create") {
        const rec2 = { type: String(body.type || "A"), name: String(body.name || ""), content: String(body.content || ""), ttl: 1, proxied: body.proxied !== false };
        if (!rec2.name || !rec2.content) return jsonResp(400, { error: "name and content required" });
        if (body.priority != null) rec2.priority = Number(body.priority) || 0;
        const made = await cfDNS(env, "POST", "", rec2, zone);
        return jsonResp(200, { ok: true, id: made?.id || "" });
      }
      if (op === "delete") {
        const rid = String(body.recordId || "");
        if (!/^[0-9a-f]{32}$/i.test(rid)) return jsonResp(400, { error: "bad recordId" });
        await cfDNS(env, "DELETE", "/" + encodeURIComponent(rid), void 0, zone);
        return jsonResp(200, { ok: true });
      }
      return jsonResp(400, { error: "bad op" });
    } catch (e) {
      return jsonResp(502, { error: String(e && e.message || e) });
    }
  }
  const id = String(body.id || "");
  if (!/^[a-f0-9]{12}$/.test(id)) return jsonResp(400, { error: "bad id" });
  const rec = await env.DL.get(`broker/${id}.json`).then((o) => o ? o.json() : null);
  if (!rec) {
    // Forgotten, not wrong. The Mac registers again rather than retrying a
    // credential nothing on this side has ever heard of.
    return jsonResp(403, { error: "unknown install", reregister: true });
  }
  if (rec.secret !== body.secret) {
    return jsonResp(403, { error: "bad credentials" });
  }
  await ensureHostLabel(env, id, rec);
  let label = rec.hostLabel || id;
  if (pathname === "/api/broker/txt") {
    label = await ensureHostLabel(env, id, rec);
    const value = String(body.value || "");
    if (!value || value.length > 255) return jsonResp(400, { error: "bad value" });
    const name = `_acme-challenge.${machineHost(env, label)}`;
    const old = await cfDNS(env, "GET", `?type=TXT&name=${name}`);
    for (const r of old || []) await cfDNS(env, "DELETE", "/" + r.id);
    await cfDNS(env, "POST", "", { type: "TXT", name, content: value, ttl: 60 });
    return jsonResp(200, { ok: true, name });
  }
  if (pathname === "/api/broker/a") {
    await ensureHostLabel(env, id, rec);
    const receipt = await upsertMachineA(env, rec, String(body.ip || ""));
    if (!receipt.ok) {
      return jsonResp(
        receipt.reason === "invalid_lan_ip" ? 400 : 502,
        { ok: false, host: receipt.host, reason: receipt.reason }
      );
    }
    return jsonResp(200, receipt);
  }
  if (pathname === "/api/broker/relay/register") {
    const subnet = relaySubnet(String(body.lanIp || ""));
    if (!subnet) return jsonResp(400, { error: "bad LAN IP" });
    let tokenCreated = false;
    if (!rec.relayToken || !/^[a-f0-9]{32}$/.test(rec.relayToken)) {
      rec.relayToken = randomHex(16);
      tokenCreated = true;
      await env.DL.put(`broker/relay/${rec.relayToken}`, id);
      await env.DL.put(`broker/${id}.json`, JSON.stringify(rec));
    }
    if (!tokenCreated && !await env.DL.head(`broker/relay/${rec.relayToken}`)) {
      await env.DL.put(`broker/relay/${rec.relayToken}`, id);
    }
    // Each install gets its own publish credential, minted once and reused, so a
    // Mac can only ever publish to its own room. Hand-placed credentials do not
    // scale past one install and are what this replaces.
    if (!rec.relayPublishToken || !/^[a-f0-9]{48}$/.test(rec.relayPublishToken)) {
      rec.relayPublishToken = randomHex(24);
      await env.DL.put(`broker/${id}.json`, JSON.stringify(rec));
    }
    // The bootstrap is stateless, so it reads the Mac's direct URL from here
    // rather than from a live socket the Mac used to hold open.
    if (typeof body.directUrl === "string") {
      const directUrl = normalizeDirectURL(env, body.directUrl);
      if (directUrl === null) return jsonResp(400, { error: "bad direct URL" });
      if (directUrl !== rec.directUrl) {
        rec.directUrl = directUrl;
        await env.DL.put(`broker/${id}.json`, JSON.stringify(rec));
      }
    }

    // Pretty join name, minted once and kept for the install's lifetime. The
    // QR encodes this; the raw r-<token> host keeps working for old links.
    if (!rec.relayJoinName || !JOIN_NAME_RE.test(rec.relayJoinName)) {
      const name = await newJoinName(env);
      if (name) {
        rec.relayJoinName = name;
        await env.DL.put(`broker/join/${name}`, rec.relayToken);
        await env.DL.put(`broker/${id}.json`, JSON.stringify(rec));
      }
    } else if (!await env.DL.head(`broker/join/${rec.relayJoinName}`)) {
      await env.DL.put(`broker/join/${rec.relayJoinName}`, rec.relayToken);
    }

    // Party membership, so a join link outlives the Mac that minted it. Every
    // live member writes its own presence under the party, and the join page
    // reads them all. Registration refreshes every 30s, so a member that stops
    // writing has left; nothing is deleted here, because a Mac that is closing
    // is exactly the Mac that will not get to tell us.
    if (PARTY_ID_RE.test(String(body.partyId || ""))) {
      rec.partyId = String(body.partyId);
      await env.DL.put(`broker/${id}.json`, JSON.stringify(rec));
      await env.DL.put(partyMemberKey(rec.partyId, id), JSON.stringify({
        directUrl: String(rec.directUrl || ""), at: Date.now(),
      }));
    }

    const publicIP = request.headers.get("cf-connecting-ip") || "";
    const networkKey = await sha256Hex(`network-v1:${publicIP}:${subnet}`);
    const host = rec.relayJoinName ? `${rec.relayJoinName}.${env.BROKER_BASE}` : relayHost(env, rec.relayToken);

    // A guest's verdict, if one has been reported since the last poll. This is
    // how the Mac learns whether the venue isolates devices now that there is no
    // socket to push it over.
    let probe = null;
    const probeKey = `broker/relay-probe/${rec.relayToken}`;
    const stored = await env.DL.get(probeKey);
    if (stored) {
      try {
        const parsed = JSON.parse(await stored.text());
        if (typeof parsed.reachable === "boolean") probe = parsed.reachable;
      } catch (e) {}
      await env.DL.delete(probeKey); // consumed once, so a stale verdict cannot linger
    }

    return jsonResp(200, {
      joinUrl: `https://${host}/`,
      relayUrl: relayOriginFor(env, rec.relayToken),
      publishToken: rec.relayPublishToken,
      room: rec.relayToken,
      networkKey,
      probe,
    });
  }
  return jsonResp(404, { error: "unknown broker endpoint" });
}

const RELAY_TOKEN_RE = /^[a-f0-9]{32}$/;
const RELAY_PROBE_JSON_MAX_BYTES = 128;
const RELAY_PROBE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
});
function relayProbeJson(status, body, headers = void 0) {
  return jsonResp(status, body, { ...RELAY_PROBE_HEADERS, ...(headers || {}) });
}
function relayTokenFromHost(hostname, env) {
  const suffix = `.${String(env.BROKER_BASE || "").toLowerCase()}`;
  const host = String(hostname || "").toLowerCase();
  if (!host.endsWith(suffix)) return "";
  const label = host.slice(0, -suffix.length);
  if (!label.startsWith("r-")) return "";
  const token = label.slice(2);
  return RELAY_TOKEN_RE.test(token) ? token : "";
}

async function relayTokenExists(env, token) {
  if (!RELAY_TOKEN_RE.test(token)) return false;
  const cache = globalThis.caches?.default;
  const key = new Request(`https://relay-token.partyparty.internal/${token}`);
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return hit.status === 204;
    } catch (_) {}
  }

  let exists;
  try {
    exists = typeof env.DL.head === "function"
      ? !!await env.DL.head(`broker/relay/${token}`)
      : !!await env.DL.get(`broker/relay/${token}`);
  } catch (_) {
    exists = !!await env.DL.get(`broker/relay/${token}`);
  }
  if (cache) {
    try {
      await cache.put(key, new Response(null, {
        status: exists ? 204 : 404,
        headers: { "cache-control": "max-age=300" },
      }));
    } catch (_) {}
  }
  return exists;
}

function scriptJSON(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => ({
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026",
    "\u2028": "\\u2028",
    "\u2029": "\\u2029"
  })[character]);
}
function relayBootstrap(state) {
  const known = Array.isArray(state.directUrls) && state.directUrls.length
    ? state.directUrls
    : [String(state.directUrl || "")];
  const directURLs = scriptJSON(known.filter(Boolean).map(String));
  const relayURL = scriptJSON(String(state.relayUrl || ""));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<title>Joining PartyParty</title>
<style>
:root{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;color-scheme:light dark}
*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:32px;background:Canvas;color:CanvasText}
main{width:min(100%,360px);text-align:center}.spinner{width:28px;height:28px;margin:0 auto 20px;border:3px solid color-mix(in srgb,CanvasText 18%,transparent);border-top-color:#ff2d6f;border-radius:50%;animation:spin .8s linear infinite}
h1{font-size:22px;margin:0 0 8px}p{font-size:15px;line-height:1.45;margin:0;color:color-mix(in srgb,CanvasText 66%,transparent)}
button{margin-top:22px;border:0;border-radius:999px;padding:12px 20px;background:#ff2d6f;color:white;font:inherit;font-weight:650}
@keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body><main><div class="spinner" aria-hidden="true"></div><h1>Checking this Wi-Fi</h1><p id="detail">Finding the fastest connection to the DJ.</p><button id="retry" hidden>Try Again</button></main>
<script>
// Every Mac currently playing this party, freshest first. The link's own Mac
// leads while it is alive; the others are why the link still works after the
// host packs up.
const candidates=${directURLs};
const relayURL=${relayURL};
const detail=document.getElementById('detail');
const retry=document.getElementById('retry');
const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
async function reach(url,timeout,roundSignal){
  const controller=new AbortController();
  const cancel=()=>controller.abort();
  if(roundSignal){
    if(roundSignal.aborted)return false;
    roundSignal.addEventListener('abort',cancel,{once:true});
  }
  const timer=setTimeout(()=>controller.abort(),timeout);
  try{
    const target=new URL('/api/time?partyPartyProbe='+Date.now(),url);
    const response=await fetch(target,{cache:'no-store',mode:'cors',signal:controller.signal});
    if(response.ok){
      const body=await response.json();
      if(Number(body.t)>0)return true;
    }
  }catch(_){}
  finally{
    clearTimeout(timer);
    if(roundSignal)roundSignal.removeEventListener('abort',cancel);
  }
  return false;
}
async function probeRound(timeout){
  const controller=new AbortController();
  return new Promise((resolve)=>{
    let remaining=candidates.length;
    let settled=false;
    const finish=(url)=>{
      if(settled)return;
      settled=true;
      controller.abort();
      resolve(url);
    };
    for(const url of candidates){
      reach(url,timeout,controller.signal).then((answered)=>{
        if(answered){finish(url);return}
        remaining--;
        if(remaining===0)finish('');
      });
    }
  });
}
// Returns the address that answered, or '' - the party may be several Macs and
// the one that minted this link is not always the one still playing.
async function probe(){
  if(!candidates.length)return '';
  // A success proves direct reachability. A timeout does not prove isolation:
  // the first scan can race DNS convergence, TLS startup, or a brief Wi-Fi
  // transition. Keep the total check bounded, but require several independent
  // failures before paying the permanent latency cost of relay mode. Macs in
  // one round are checked together: trying 40 serially could otherwise keep a
  // guest on this spinner for more than eight minutes. The first answer aborts
  // the losing requests; the retry ladder now has a fixed 13.5-second ceiling
  // regardless of party size.
  const timeouts=[2500,4000,6000];
  for(let i=0;i<timeouts.length;i++){
    const answered=await probeRound(timeouts[i]);
    if(answered)return answered;
    if(i+1<timeouts.length)await sleep(500);
  }
  return '';
}
async function report(reachable){
  // keepalive, because this page navigates away immediately after calling this
  // and an ordinary fetch is cancelled when it does. That dropped the verdict in
  // exactly the case where it succeeded: a reachable guest reported, redirected
  // to the Mac, and the report died with the page. Guests connected fine and the
  // DJ console sat on "Scan the QR code once to finish the check" forever,
  // because the scan that would finish it could never be delivered.
  const body=JSON.stringify({reachable});
  try{
    await fetch('/__pp/probe',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body,
      cache:'no-store',
      keepalive:true
    });
  }catch(_){
    if(navigator.sendBeacon){
      navigator.sendBeacon('/__pp/probe',new Blob([body],{type:'application/json'}));
    }
  }
}
// The guest's own probe IS the decision. It just proved whether this phone can
// reach the Mac, which is the only question that matters, so waiting for the Mac
// to agree would add a round trip and a way to get stuck.
//
// The report still goes out because the Mac needs the verdict to set the room's
// mode and cache it for this network, but nothing here waits on it.
async function relayLive(){
  // A registration is a name, not a stream: only a live health check earns the
  // handoff. The check goes through this page's own origin - the Worker probes
  // the relay server-side - because a direct fetch to the relay origin is
  // cross-origin, carries no CORS headers, and the browser blocks it silently.
  if(!relayURL)return false;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),4000);
  try{
    const response=await fetch('/__pp/relay-live?t='+Date.now(),{cache:'no-store',signal:controller.signal});
    if(!response.ok)return false;
    const body=await response.json();
    return body.live===true;
  }catch(_){return false}
  finally{clearTimeout(timer)}
}
let running=false;
async function run(){
  if(running)return;
  running=true;
  retry.hidden=true;
  detail.textContent='Finding the fastest connection to the DJ.';
  const answered=await probe();
  report(!!answered).catch(function(){});
  if(answered){location.replace(answered);return}
  if(await relayLive()){
    // Isolated Wi-Fi or a remote guest: the relay origin serves this room
    // directly. Guests fetch audio and the room API from there, never back
    // through this page.
    location.replace(relayURL+'/');
    return;
  }
  detail.textContent=relayURL
    ?'This party is playing on its own Wi-Fi right now. Join that Wi-Fi to listen - this page keeps checking and connects you the moment a path opens.'
    :'This Wi-Fi will not let guests reach the DJ, and there is no internet connection to fall back on. This page keeps checking.';
  retry.hidden=false;
  running=false;
}
retry.addEventListener('click',run);
// A stuck phone must converge on its own: a guest who joins the party Wi-Fi
// mid-spinner, or whose 5G blips back, should not need to know to refresh.
addEventListener('online',run);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)run()});
(async()=>{for(;;){await run();await sleep(8000)}})();
</script></body></html>`;
}

// The r-<token> hostname now serves ONE thing: the bootstrap page a guest lands
// on after scanning the QR. It classifies the network and hands off. Media and
// the room API never touch a Worker; they go straight to the relay origin, which
// is why this file no longer contains a proxy or a Durable Object.
async function relayBootstrapRequest(request, env, token) {
  const url = new URL(request.url);

  // The guest's verdict, reported once per join. Low frequency by construction:
  // one request per phone, never per part.
  if (url.pathname === "/__pp/probe") {
    if (request.method !== "POST" && request.method !== "OPTIONS") {
      return relayProbeJson(405, { error: "POST required" }, { allow: "POST, OPTIONS" });
    }
    if (request.method === "POST" && !isRelayProbeContentType(request)) {
      return relayProbeJson(415, { error: "JSON body required" });
    }
    if (!await relayTokenExists(env, token)) return relayProbeJson(404, { error: "room not found" });
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: RELAY_PROBE_HEADERS });
    }
    const parsed = await readJsonResult(request, RELAY_PROBE_JSON_MAX_BYTES);
    if (parsed.tooLarge) return relayProbeJson(413, { error: "too large" });
    const body = parsed.value;
    if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.reachable !== "boolean") {
      return relayProbeJson(400, { error: "bad json" });
    }
    await env.DL.put(`broker/relay-probe/${token}`, JSON.stringify({
      reachable: body.reachable, at: Date.now(),
    }));
    return relayProbeJson(200, { ok: true });
  }

  // Same-origin relay liveness for the bootstrap page. The page cannot check
  // the relay origin's health itself: that fetch is cross-origin, the health
  // endpoint sends no CORS headers, and the browser silently blocks it - which
  // parked every remote guest on "try again" while the relay was streaming
  // fine (2026-08-05). The Worker checks server-side, where CORS does not
  // exist.
  if (url.pathname === "/__pp/relay-live") {
    if (request.method !== "GET") return jsonMethodNotAllowed("GET", "GET required");
    if (!await relayTokenExists(env, token)) return new Response("Not Found", { status: 404 });
    const origin = relayOriginFor(env, token);
    let live = false;
    if (origin) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      try {
        const response = await fetch(origin + "/__pp/health", {
          signal: controller.signal,
          cf: { cacheTtl: 0 },
        });
        live = response.ok;
        if (response.body) await response.body.cancel().catch(() => {
        });
      } catch (e) {}
      finally { clearTimeout(timer); }
    }
    return jsonResp(200, { live }, { "cache-control": "no-store" });
  }

  if (url.pathname !== "/") return new Response("Not Found", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
  if (!await relayTokenExists(env, token)) return new Response("Not Found", { status: 404 });
  if (request.method === "HEAD") {
    return new Response(null, {
      headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
    });
  }
  const record = await relayRoomRecord(env, token);
  return new Response(relayBootstrap(record), {
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
  });
}

// relayRoomRecord is what the bootstrap needs to decide where to send a guest:
// every live Mac in this party, freshest first, and this room's relay origin.
//
// More than one address, because a party can be several Macs and the one that
// minted the link is not always the one still playing. When a host packs up,
// their address keeps resolving to a Mac that has gone - guests already inside
// re-home, but anyone arriving after that used to find nothing. The page now
// tries the whole party.
async function relayRoomRecord(env, token) {
  const relayUrl = relayOriginFor(env, token);
  const pointer = await env.DL.get(`broker/relay/${token}`);
  if (!pointer) return { directUrl: "", directUrls: [], relayUrl };
  try {
    const id = (await pointer.text()).trim();
    const raw = await env.DL.get(`broker/${id}.json`);
    if (!raw) return { directUrl: "", directUrls: [], relayUrl };
    const rec = JSON.parse(await raw.text());
    const own = normalizeDirectURL(env, rec.directUrl);
    const directUrls = await partyDirectUrls(env, rec.partyId, own);
    return { directUrl: own || "", directUrls, relayUrl };
  } catch (e) {
    return { directUrl: "", directUrls: [], relayUrl };
  }
}

// A party id is minted by the Mac as <date>-<time>-<4 hex>; anything else is
// not written, so a bad value can never create a namespace of junk keys.
const PARTY_ID_RE = /^\d{4}-\d{2}-\d{2}-\d{4}-[a-f0-9]{4}$/;
// Two missed registrations of slack. The Mac re-registers every 30s, so a
// member last seen within 90s is still playing.
const PARTY_MEMBER_TTL_MS = 90 * 1000;
function partyMemberKey(partyId, installId) {
  return `broker/party/${partyId}/${installId}`;
}

// Every live member's direct URL, freshest first, with the link's own Mac kept
// at the front while it is alive - a guest should reach the Mac they scanned
// whenever it is there, and only then try the rest of the party.
async function partyDirectUrls(env, partyId, ownUrl) {
  const urls = [];
  const push = (url) => {
    const clean = normalizeDirectURL(env, url);
    if (clean && !urls.includes(clean)) urls.push(clean);
  };
  if (!PARTY_ID_RE.test(String(partyId || ""))) {
    push(ownUrl);
    return urls;
  }
  let members = [];
  try {
    const listed = await env.DL.list({ prefix: `broker/party/${partyId}/`, limit: 40 });
    const now = Date.now();
    for (const object of listed.objects || []) {
      const raw = await env.DL.get(object.key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(await raw.text());
        const at = Number(parsed.at || 0);
        if (!at || now - at > PARTY_MEMBER_TTL_MS) continue;
        members.push({ at, directUrl: String(parsed.directUrl || "") });
      } catch (e) {}
    }
  } catch (e) {
    push(ownUrl);
    return urls;
  }
  members.sort((a, b) => b.at - a.at);
  const ownIsLive = members.some((m) => m.directUrl === String(ownUrl || "").trim());
  if (ownIsLive) push(ownUrl);
  for (const member of members) push(member.directUrl);
  if (!urls.length) push(ownUrl);
  return urls;
}

function relayOriginFor(env, token) {
  return `https://${token}.relay.${env.BROKER_BASE}`;
}

var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    // HTTPS only on the product domain. The r-<token> join hosts are handled
    // below and are equally https; a plaintext request here is either a typo or
    // somebody listening.
    if (url.protocol !== "https:") {
      const secure = new URL(url);
      secure.protocol = "https:";
      return new Response(null, { status: 301, headers: { location: secure.toString() } });
    }
    if (url.hostname === `www.${env.BROKER_BASE}`) {
      const canonical = new URL(url);
      canonical.hostname = env.BROKER_BASE;
      return new Response(null, { status: 308, headers: { location: canonical.toString() } });
    }

    const relayToken = relayTokenFromHost(url.hostname, env);
    if (relayToken) {
      return relayBootstrapRequest(request, env, relayToken);
    }
    const joinName = joinNameFromHost(url.hostname, env);
    if (joinName) {
      const mapped = await env.DL.get(`broker/join/${joinName}`);
      if (mapped) {
        const token = (await mapped.text()).trim();
        if (/^[a-f0-9]{32}$/.test(token)) {
          return relayBootstrapRequest(request, env, token);
        }
      }
      // No mapping: fall through - an unmapped word-word host is just the site.
    }
    let standaloneFile = STANDALONE_FILES[pathname];
    const release = pathname.match(STANDALONE_RELEASE);
    if (!standaloneFile && release) {
      standaloneFile = {
        key: `standalone/${release[1]}`,
        type: "application/zip",
        cache: "public, max-age=31536000, immutable",
        download: release[1]
      };
    }
    if (standaloneFile) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const object = await env.DL.get(standaloneFile.key);
      if (!object) return new Response("Not Found", { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("content-type", standaloneFile.type);
      headers.set("content-length", String(object.size));
      if (standaloneFile.download) {
        headers.set("content-disposition", `attachment; filename="${standaloneFile.download}"`);
      }
      headers.set("cache-control", standaloneFile.cache);
      if (object.httpEtag) headers.set("etag", object.httpEtag);
      return new Response(request.method === "HEAD" ? null : object.body, { headers });
    }
    // Apple hands out a file to prove we own this domain before Sign in with
    // Apple will work on it. Served from R2 so putting it in place is an
    // upload, not a deploy - the file arrives from Apple long after this code
    // does, and nobody should have to ship a Worker to paste it.
    if (pathname === "/.well-known/apple-developer-domain-association.txt") {
      if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
      const object = await env.DL.get("apple/domain-association.txt");
      if (!object) return new Response("Not Found", { status: 404 });
      const headers = new Headers({ "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" });
      if (Number.isFinite(object.size)) headers.set("content-length", String(object.size));
      return new Response(request.method === "HEAD" ? null : object.body, {
        headers,
      });
    }
    if (pathname === "/api/relay-canary") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return jsonMethodNotAllowed("GET, HEAD", "GET or HEAD required");
      }
      const raw = await env.DL.get("canary/relay.json");
      if (!raw) {
        return withoutBodyForHead(request, jsonResp(200, { healthy: null, note: "no check has run yet" }, { "cache-control": "no-store" }));
      }
      return new Response(request.method === "HEAD" ? null : raw.body, {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    if (pathname === "/api/version") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed("GET, HEAD");
      }
      const headers = { "cache-control": "public, max-age=300" };
      if (request.method === "HEAD") {
        return new Response(null, { headers: { ...headers, "content-type": "application/json" } });
      }
      const current = await appcastVersion(env);
      if (!current.version) return jsonResp(503, { error: "version unavailable" }, { "cache-control": "no-store" });
      return jsonResp(200, {
        version: current.version,
        date: current.date,
      }, headers);
    }
    if (pathname.startsWith("/go/testflight/")) {
      if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://testflight.apple.com/join/HPRAgyJk",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    }
    if (pathname.startsWith("/go/github/")) {
      if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://github.com/tetrisgm/partyparty",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    }
    if (pathname === "/privacy" || pathname === "/support") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed("GET, HEAD");
      }
      const response = legalResponse(pathname);
      const productResponse = request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
      return withProductSecurityHeaders(productResponse);
    }
    if (pathname.startsWith("/api/broker/")) {
      try {
        return await broker(request, env, pathname);
      } catch (e) {
        return jsonResp(500, { error: String(e && e.message || e) });
      }
    }
    if (pathname === "/") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return methodNotAllowed("GET, HEAD");
      }
      const u = new URL(request.url);
      u.pathname = "/";
      return withProductSecurityHeaders(await env.ASSETS.fetch(new Request(u, request)));
    }
    return withProductSecurityHeaders(await env.ASSETS.fetch(request));
  },
  // Keep the machine namespace anchored so absent hostnames return NXDOMAIN
  // instead of falling through to a product wildcard, and watch the relay
  // origin so a sick relay plane is known before a DJ finds out mid-party.
  async scheduled(event, env, ctx) {
    try {
      await ensureNamespaceAnchor(env);
    } catch (_) {
    }
    try {
      await relayCanary(env);
    } catch (_) {
    }
  }
};

// The relay canary. The origin serving relayed parties has exactly one
// consumer-visible failure mode: a DJ goes live on an isolated network and
// guests get nothing. The Mac now probes it before claiming RELAY, but that
// only helps the DJ standing there; this records the outage as it happens, so
// "how long was the relay down" has an answer and a recovery is visible without
// anyone ssh-ing into the box. State lives beside the broker's other records;
// /api/relay-canary serves the latest.
async function relayCanary(env) {
  const started = Date.now();
  let healthy = false;
  let detail = "";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const response = await fetch("https://health.relay.partyparty.party/__pp/health", {
      signal: controller.signal,
      cf: { cacheTtl: 0 },
    });
    clearTimeout(timer);
    healthy = response.ok;
    detail = healthy ? await response.text() : `status ${response.status}`;
  } catch (err) {
    detail = String(err && err.message || err).slice(0, 200);
  }
  const previousRaw = await env.DL.get("canary/relay.json");
  let previous = {};
  if (previousRaw) {
    try { previous = JSON.parse(await previousRaw.text()); } catch (_) {}
  }
  const record = {
    healthy,
    detail: detail.slice(0, 300),
    checkedAt: started,
    ms: Date.now() - started,
    // The transition timestamps are what make an outage a fact instead of a
    // guess: sickSince survives while sick, and clears on recovery.
    sickSince: healthy ? 0 : (previous.healthy === false ? previous.sickSince || started : started),
    lastHealthyAt: healthy ? started : previous.lastHealthyAt || 0,
  };
  await env.DL.put("canary/relay.json", JSON.stringify(record));
}
export {
  worker_default as default,
  readJson,
  sha256Hex
};
