// cloudflare/worker.js
var SITE_ORIGIN = "https://partyparty.party";
var DEFAULT_OG_IMAGE = "/img/og-default.jpg";
var APP_VERSION = "123.88";
var APP_VERSION_DATE = "2026-07-26";
var STANDALONE_BUILD = "190";
var STANDALONE_DOWNLOAD = "/partyparty-beta.zip";
var STANDALONE_FILES = {
  "/appcast.xml": { key: "standalone/appcast.xml", type: "application/xml; charset=utf-8", cache: "public, max-age=300" },
  "/partyparty-beta.zip": { key: "standalone/partyparty-beta.zip", type: "application/zip", cache: "public, max-age=300", download: "partyparty-beta.zip" },
  "/downloads/partyparty-123.88-190.zip": { key: "standalone/partyparty-123.88-190.zip", type: "application/zip", cache: "public, max-age=31536000, immutable", download: "partyparty-123.88-190.zip" }
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
      <p>The Mac app serves live audio and the active party room directly to guests on the same Wi-Fi. Party audio, guest names, posts, comments, reactions, photos, and videos stay on the DJ's Mac. They are not uploaded to partyparty's cloud service.</p>
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
  return jsonResp(404, { error: "unknown broker endpoint" });
}
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
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
        standaloneBuild: STANDALONE_BUILD,
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
