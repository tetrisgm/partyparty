// cloudflare/worker.js
var SITE_ORIGIN = "https://partyparty.party";
var DEFAULT_OG_IMAGE = "/img/og-default.jpg";
var APP_VERSION = "125.3";
var APP_VERSION_DATE = "2026-07-29";
var STANDALONE_DOWNLOAD = "/partyparty-beta.zip";
var STANDALONE_FILES = {
  "/downloads/partyparty-125.3-219.zip": { key: "standalone/partyparty-125.3-219.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-125.3-219.zip" },
  "/downloads/partyparty-125.2-216.zip": { key: "standalone/partyparty-125.2-216.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-125.2-216.zip" },
  "/downloads/partyparty-125.1-218.zip": { key: "standalone/partyparty-125.1-218.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-125.1-218.zip" },
  "/downloads/partyparty-125.0-217.zip": { key: "standalone/partyparty-125.0-217.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-125.0-217.zip" },
  "/appcast.xml": { key: "standalone/appcast.xml", type: "application/xml; charset=utf-8", cache: "public, max-age=300" },
  "/partyparty-beta.zip": { key: "standalone/partyparty-beta.zip", type: "application/zip", cache: "public, max-age=300", download: "partyparty-beta.zip" },
  "/downloads/partyparty-123.95-197.zip": { key: "standalone/partyparty-123.95-197.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-123.95-197.zip" },
  "/downloads/partyparty-123.96-198.zip": { key: "standalone/partyparty-123.96-198.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-123.96-198.zip" },
  "/downloads/partyparty-123.97-199.zip": { key: "standalone/partyparty-123.97-199.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-123.97-199.zip" },
  "/downloads/partyparty-123.98-200.zip": { key: "standalone/partyparty-123.98-200.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-123.98-200.zip" },
  "/downloads/partyparty-123.99-201.zip": { key: "standalone/partyparty-123.99-201.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-123.99-201.zip" },
  "/downloads/partyparty-124.00-202.zip": { key: "standalone/partyparty-124.00-202.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-124.00-202.zip" },
  "/downloads/partyparty-124.01-203.zip": { key: "standalone/partyparty-124.01-203.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-124.01-203.zip" },
  "/downloads/partyparty-124.02-204.zip": { key: "standalone/partyparty-124.02-204.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-124.02-204.zip" },
  "/downloads/partyparty-124.05-207.zip": { key: "standalone/partyparty-124.05-207.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-124.05-207.zip" },
  "/downloads/partyparty-124.08-210.zip": { key: "standalone/partyparty-124.08-210.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-124.08-210.zip" },
  "/downloads/partyparty-124.09-211.zip": { key: "standalone/partyparty-124.09-211.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-124.09-211.zip" },
  "/downloads/partyparty-124.10-212.zip": { key: "standalone/partyparty-124.10-212.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-124.10-212.zip" },
  "/downloads/partyparty-124.11-213.zip": { key: "standalone/partyparty-124.11-213.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-124.11-213.zip" },
  "/downloads/partyparty-124.12-214.zip": { key: "standalone/partyparty-124.12-214.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-124.12-214.zip" },
  "/downloads/partyparty-124.13-215.zip": { key: "standalone/partyparty-124.13-215.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-124.13-215.zip" },
  "/downloads/partyparty-124.14-216.zip": { key: "standalone/partyparty-124.14-216.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-124.14-216.zip" }
};
var READ_JSON_TOO_LARGE = /* @__PURE__ */ new WeakSet();
var esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
var absUrl = (s) => {
  try {
    return new URL(s || "/", SITE_ORIGIN).href;
  } catch (_) {
    return SITE_ORIGIN + "/";
  }
};
async function readJson(request, maxBytes = 16384) {
  const cap = Math.max(0, Number(maxBytes) || 0);
  const len = Number(request?.headers?.get("content-length") || "0");
  READ_JSON_TOO_LARGE.delete(request);
  if (len && len > cap) {
    READ_JSON_TOO_LARGE.add(request);
    return null;
  }
  try {
    let text = "";
    if (request?.body?.getReader) {
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
          READ_JSON_TOO_LARGE.add(request);
          return null;
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } else {
      text = await request.text();
      if (new TextEncoder().encode(text).byteLength > cap) {
        READ_JSON_TOO_LARGE.add(request);
        return null;
      }
    }
    return text ? JSON.parse(text) : null;
  } catch (_) {
    return null;
  }
}
async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(String(str == null ? "" : str));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
var CSS = `
:root{--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--ink2:#6e6e73;--ink3:#86868b;--line:#e6e6e9;--accent:#ff2d6f;--pill:999px;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);line-height:1.45}a{color:inherit;text-decoration:none}
nav{max-width:760px;margin:0 auto;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{font-size:18px;font-weight:700}.navlinks,.ecta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:var(--pill);padding:11px 18px;background:var(--accent);color:#fff;font:inherit;font-size:14px;font-weight:650;cursor:pointer}.btn.lt{background:var(--card);border-color:var(--line);color:var(--ink)}.btn.sm{padding:8px 13px}
.page{max-width:760px;margin:0 auto;padding:8px 20px 60px}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:24px;margin-top:16px}.card h1,.card h2{margin:0 0 6px}.sub,.hint,.emptyline,.sectionhead p{color:var(--ink2)}
.sectionhead{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
footer{max-width:760px;margin:0 auto;padding:24px 20px 48px;color:var(--ink3);font-size:13px;display:flex;justify-content:space-between;gap:12px}
@media(max-width:560px){.sectionhead{display:grid}.navlinks .btn:first-child{display:none}}
`;
var SVGDEFS = "";
var NAV = `<nav><a class="brand" href="/">partyparty</a><div class="navlinks"><span class="btn lt sm">Coming to the Mac App Store</span></div></nav>`;
var TOAST_JS = "";
function shell({ title, desc, ogImage, url, body }) {
  const pageUrl = absUrl(url || "/");
  const imageUrl = absUrl(ogImage || DEFAULT_OG_IMAGE);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:url" content="${esc(pageUrl)}"><meta property="og:site_name" content="partyparty"><meta property="og:image" content="${esc(imageUrl)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(imageUrl)}">
<meta name="theme-color" content="#f5f5f7"><meta name="color-scheme" content="light">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u{1F57A}</text></svg>">
<link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin>
<style>${CSS}</style></head><body>${SVGDEFS}${NAV}${body}${TOAST_JS}</body></html>`;
}
function legalResponse(pathname) {
  const privacy = pathname === "/privacy";
  const body = privacy ? `<div class="page">
    <div class="card">
      <h1>Privacy policy</h1>
      <p class="sub">Effective July 26, 2026</p>
      <h2>What partyparty does</h2>
      <p>On ordinary venue Wi-Fi, the Mac app serves live audio and the active party room directly to guests. If the Wi-Fi prevents nearby devices from connecting, the Mac can select relay mode so encrypted guest requests and live audio pass through partyparty's Cloudflare service while the room is active.</p>
      <h2>Relay mode</h2>
      <p>Relay mode is a live transport, not cloud party storage. Live audio, listening status, text posts, reactions, and still photos pass through to the DJ's Mac and are not retained by partyparty. Photo transfer is capped and throttled so music stays first. Videos are unavailable in relay mode and do not enter the relay. Short rolling HLS media parts and still photos may be cached for up to 60 seconds to avoid repeatedly uploading identical bytes from the Mac. There are no cloud recordings, replays, or public event pages.</p>
      <h2>Secure room address</h2>
      <p>Each installation receives a random credential and a two-word hostname used only to provision its certificate-backed local room address. This infrastructure identifier is not connected to a PartyParty account or profile.</p>
      <h2>Diagnostics</h2>
      <p>The Mac App Store edition keeps diagnostics on the Mac and does not upload session logs or status telemetry. Cloudflare may process ordinary request metadata needed to operate and secure the website and certificate broker.</p>
      <h2>Sharing and tracking</h2>
      <p>partyparty does not sell personal data, track people across apps or websites, or use infrastructure data for advertising.</p>
      <h2>Contact</h2>
      <p>Questions or privacy requests: <a href="mailto:support@partyparty.party"><u>support@partyparty.party</u></a>.</p>
    </div>
  </div>` : `<div class="page">
    <div class="card">
      <h1>Support</h1>
      <p class="sub">Help with partyparty for Mac.</p>
      <h2>Contact</h2>
      <p>Email <a href="mailto:support@partyparty.party"><u>support@partyparty.party</u></a> with the app version, macOS version, and a short description of what happened.</p>
      <h2>Before a party</h2>
      <p>Connect the Mac and guests to the venue Wi-Fi, open partyparty, select the audio source, and use the displayed HTTPS QR code. Guests need no account and can keep listening while their iPhone is locked.</p>
      <h2>Privacy</h2>
      <p>Read the <a href="/privacy"><u>privacy policy</u></a>.</p>
    </div>
  </div>`;
  return new Response(shell({
    title: `${privacy ? "Privacy" : "Support"} \xB7 partyparty`,
    desc: privacy ? "How partyparty handles local party and infrastructure data." : "Support for partyparty on Mac.",
    ogImage: DEFAULT_OG_IMAGE,
    url: pathname,
    body: body + `<footer><span>partyparty</span><span><a href="/privacy">Privacy</a> \xB7 <a href="/support">Support</a></span></footer>`
  }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}
var jsonResp = (status, obj, headers = void 0) => {
  const h = new Headers(headers || {});
  h.set("content-type", "application/json");
  return new Response(JSON.stringify(obj), { status, headers: h });
};
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
    if (!await env.DL.get(`broker/host/${cand}`) && !await env.DL.get(`broker/slug/${cand}`)) return cand;
  }
  return `party-${id.slice(0, 6)}`;
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
function brokerJsonCap(pathname) {
  return 16384;
}
async function broker(request, env, pathname) {
  if (pathname === "/api/broker/ping") return jsonResp(200, { ok: true, t: Date.now() });
  if (request.method !== "POST") return jsonResp(405, { error: "POST required" });
  if (!env.CF_DNS_TOKEN || !env.CF_ZONE_ID || !env.BROKER_BASE) return jsonResp(503, { error: "broker not configured" });
  const jsonCap = brokerJsonCap(pathname);
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength && contentLength > jsonCap) return jsonResp(413, { error: "too large" });
  const body = await readJson(request, jsonCap);
  if (!body) return READ_JSON_TOO_LARGE.has(request) ? jsonResp(413, { error: "too large" }) : jsonResp(400, { error: "bad json" });
  if (pathname === "/api/broker/register") {
    const ipHash = await sha256Hex(`ip:${request.headers.get("cf-connecting-ip") || ""}`);
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
      return jsonResp(403, { error: "bad install auth" });
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
  if (!rec || rec.secret !== body.secret) {
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
    if (typeof body.directUrl === "string" && body.directUrl !== rec.directUrl) {
      rec.directUrl = body.directUrl.slice(0, 300);
      await env.DL.put(`broker/${id}.json`, JSON.stringify(rec));
    }

    const publicIP = request.headers.get("cf-connecting-ip") || "";
    const networkKey = await sha256Hex(`network-v1:${publicIP}:${subnet}`);
    const host = relayHost(env, rec.relayToken);

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
const RELAY_PHOTO_BYTES_PER_SECOND = 256 * 1024;
const RELAY_PHOTO_MAX_BYTES = 20 * 1024 * 1024;

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
  try {
    const cache = caches.default;
    const key = new Request(`https://relay-token.partyparty.internal/${token}`);
    const hit = await cache.match(key);
    if (hit) return hit.status === 204;
    const exists = !!await env.DL.head(`broker/relay/${token}`);
    await cache.put(key, new Response(null, {
      status: exists ? 204 : 404,
      headers: { "cache-control": "max-age=300" },
    }));
    return exists;
  } catch (_) {
    return !!await env.DL.get(`broker/relay/${token}`);
  }
}

function relayBootstrap(state) {
  const directURL = JSON.stringify(String(state.directUrl || ""));
  const relayURL = JSON.stringify(String(state.relayUrl || ""));
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
const directURL=${directURL};
const relayURL=${relayURL};
const detail=document.getElementById('detail');
const retry=document.getElementById('retry');
const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
async function probe(){
  if(!directURL)return false;
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),4000);
  try{
    const target=new URL('/api/time?partyPartyProbe='+Date.now(),directURL);
    const response=await fetch(target,{cache:'no-store',mode:'cors',signal:controller.signal});
    if(!response.ok)return false;
    const body=await response.json();
    return Number(body.t)>0;
  }catch(_){return false}finally{clearTimeout(timer)}
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
async function run(){
  retry.hidden=true;
  detail.textContent='Finding the fastest connection to the DJ.';
  const reachable=await probe();
  report(reachable).catch(function(){});
  if(reachable&&directURL){location.replace(directURL);return}
  if(relayURL){
    // Isolated Wi-Fi: the relay origin serves this room directly. Guests fetch
    // audio and the room API from there, never back through this page.
    location.replace(relayURL+'/');
    return;
  }
  detail.textContent='This Wi-Fi will not let guests reach the DJ, and there is no internet connection to fall back on.';
  retry.hidden=false;
}
retry.addEventListener('click',run);
run();
</script></body></html>`;
}

function relayOfflinePage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>PartyParty</title><style>:root{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;color-scheme:light dark}body{min-height:100svh;margin:0;display:grid;place-items:center;padding:32px;background:Canvas;color:CanvasText;text-align:center}main{max-width:360px}h1{font-size:22px}p{opacity:.7;line-height:1.45}button{border:0;border-radius:999px;padding:12px 20px;background:#ff2d6f;color:#fff;font:inherit;font-weight:650}</style></head><body><main><h1>The DJ is reconnecting</h1><p>Keep this page open. PartyParty will continue as soon as the Mac is available.</p><button onclick="location.reload()">Try Again</button></main></body></html>`;
}

function relayImageExtension(value) {
  return /\.(?:jpe?g|png|gif|heic|heif|webp)$/i.test(value);
}

function relayImageUpload(request, pathname) {
  if (pathname !== "/api/upload") return false;
  const name = request.headers.get("x-pp-name") || "";
  if (!name) {
    return String(request.headers.get("content-type") || "").toLowerCase().startsWith("image/");
  }
  try {
    return relayImageExtension(decodeURIComponent(name));
  } catch (_) {
    return false;
  }
}

function relayMediaUnavailable(request, pathname) {
  if (pathname === "/api/upload") return !relayImageUpload(request, pathname);
  if (!pathname.startsWith("/media/")) return false;
  return !relayImageExtension(pathname);
}

function relayMediaUnavailableResponse() {
  return jsonResp(409, {
    error: "Videos are unavailable while this Wi-Fi uses internet relay mode. Photos continue at reduced priority so music stays first.",
    code: "relay_video_unavailable",
  }, { "cache-control": "no-store" });
}

function relayPhotoTooLarge(request, pathname) {
  if (!relayImageUpload(request, pathname)) return false;
  const size = Number(request.headers.get("content-length") || 0);
  return size > RELAY_PHOTO_MAX_BYTES;
}

function relayHeadersForMac(request) {
  const out = {};
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if ([
      "accept", "accept-language", "cache-control",
      "content-type", "cookie", "if-modified-since", "if-none-match", "range",
      "user-agent", "x-pp-name",
    ].includes(lower)) {
      out[name] = [value];
    }
  }
  return out;
}

function headersFromRelay(values) {
  const headers = new Headers();
  for (const [name, entries] of Object.entries(values || {})) {
    const lower = name.toLowerCase();
    if ([
      "connection", "keep-alive", "proxy-authenticate",
      "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade",
    ].includes(lower)) continue;
    for (const value of Array.isArray(entries) ? entries : [entries]) {
      try { headers.append(name, String(value)); } catch (_) {}
    }
  }
  return headers;
}

function relayBinaryFrame(id, chunk) {
  const idBytes = new TextEncoder().encode(id);
  const body = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  const frame = new Uint8Array(RELAY_BINARY_ID_BYTES + body.byteLength);
  frame.set(idBytes.slice(0, RELAY_BINARY_ID_BYTES));
  frame.set(body, RELAY_BINARY_ID_BYTES);
  return frame;
}

function relayBinaryParts(message) {
  const bytes = message instanceof ArrayBuffer
    ? new Uint8Array(message)
    : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  if (bytes.byteLength < RELAY_BINARY_ID_BYTES) return null;
  return {
    id: new TextDecoder().decode(bytes.slice(0, RELAY_BINARY_ID_BYTES)),
    body: bytes.slice(RELAY_BINARY_ID_BYTES),
  };
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


// The r-<token> hostname now serves ONE thing: the bootstrap page a guest lands
// on after scanning the QR. It classifies the network and hands off. Media and
// the room API never touch a Worker; they go straight to the relay origin, which
// is why this file no longer contains a proxy or a Durable Object.
async function relayBootstrapRequest(request, env, token) {
  if (!await relayTokenExists(env, token)) return new Response("Not Found", { status: 404 });
  const url = new URL(request.url);

  // The guest's verdict, reported once per join. Low frequency by construction:
  // one request per phone, never per part.
  if (url.pathname === "/__pp/probe" && request.method === "POST") {
    let reachable = false;
    try { reachable = !!(await request.json()).reachable; } catch (e) {}
    await env.DL.put(`broker/relay-probe/${token}`, JSON.stringify({
      reachable, at: Date.now(),
    }));
    return jsonResp(200, { ok: true }, { "cache-control": "no-store" });
  }

  const record = await relayRoomRecord(env, token);
  return new Response(relayBootstrap(record), {
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
  });
}

// relayRoomRecord is what the bootstrap needs to decide where to send a guest:
// the Mac's direct URL, written at registration, and this room's relay origin.
async function relayRoomRecord(env, token) {
  const relayUrl = relayOriginFor(env, token);
  const pointer = await env.DL.get(`broker/relay/${token}`);
  if (!pointer) return { directUrl: "", relayUrl };
  try {
    const id = (await pointer.text()).trim();
    const raw = await env.DL.get(`broker/${id}.json`);
    if (!raw) return { directUrl: "", relayUrl };
    const rec = JSON.parse(await raw.text());
    return { directUrl: String(rec.directUrl || ""), relayUrl };
  } catch (e) {
    return { directUrl: "", relayUrl };
  }
}

function relayOriginFor(env, token) {
  return `https://${token}.relay.${env.BROKER_BASE}`;
}

var worker_default = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const relayToken = relayTokenFromHost(url.hostname, env);
    if (relayToken) {
      return relayBootstrapRequest(request, env, relayToken);
    }
    const standaloneFile = STANDALONE_FILES[pathname];
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
    if (pathname === "/api/version") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const headers = { "cache-control": "public, max-age=300" };
      if (request.method === "HEAD") {
        return new Response(null, { headers: { ...headers, "content-type": "application/json" } });
      }
      return jsonResp(200, {
        version: APP_VERSION,
        date: APP_VERSION_DATE,
        standaloneDownload: STANDALONE_DOWNLOAD
      }, headers);
    }
    if (pathname === "/privacy" || pathname === "/support") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const response = legalResponse(pathname);
      return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
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
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const u = new URL(request.url);
      u.pathname = "/";
      return env.ASSETS.fetch(new Request(u, request));
    }
    return env.ASSETS.fetch(request);
  },
  // Keep the machine namespace anchored so absent hostnames return NXDOMAIN
  // instead of falling through to a product wildcard.
  async scheduled(event, env, ctx) {
    try {
      await ensureNamespaceAnchor(env);
    } catch (_) {
    }
  }
};
export {
  APP_VERSION,
  worker_default as default,
  readJson,
  sha256Hex
};
