// party.ramine.net
//
// Routes:
//   GET /appcast.xml            -> R2 (Sparkle update feed)
//   GET /partyparty.zip         -> R2 (latest build)
//   GET /partyparty-<ver>.zip   -> R2 (immutable, Sparkle enclosures)
//   GET /e/<slug>               -> server-rendered EVENT page (gathers the night)
//   GET /@<handle>              -> demo event (kept so shared links work)
//   GET /*                      -> static landing page (../site assets)
//
// Scope: partyparty is a Mac app for Wi-Fi silent-disco popups. Each EVENT gets a
// page that gathers the night — photos, videos, comments guests drop, that the DJ
// approves. NOT a social platform: no profiles, no followers, no feed. The page
// design follows Apple's Snapshot language (a cover-backed header card + stacked
// white content cards). Seed data now; R2 uploads + moderation later. Interactive
// bits are marked coming-soon (honest live preview).

const ZIP_RE = /^\/[A-Za-z0-9._-]+\.(zip|pkg|dmg)$/;
const EVENT_RE = /^\/e\/([A-Za-z0-9_.-]{1,48})$/;
const HANDLE_RE = /^\/@([A-Za-z0-9_.]{1,30})$/;

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const DEMO = {
  title: "Rooftop Sessions", dj: "Ramine",
  when: "Saturday · 11pm", where: "Le Toit — Paris",
  status: "live", listeners: 42, tagline: "House & techno · silent rooftop popup",
  cover: "/img/dance.jpg",
  about: "A silent-disco rooftop popup — bring your earbuds, scan the QR at the door to tune in, and drop your photos and clips here. No app, no speakers, no shutdown.",
  wall: ["/img/party.jpg", "/img/crowd.jpg", "/img/decks.jpg", "/img/hero.jpg", "/img/portrait.jpg"],
  socials: { soundcloud: "#", instagram: "#", spotify: "#" },
};

const CSS = `
:root{--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--ink2:#6e6e73;--ink3:#86868b;--line:#e6e6e9;--hair:rgba(0,0,0,.08);--accent:#ff2d6f;--link:#0066cc;--warn:#ff9500;--good:#34c759;--live:#ff3b5c;--r:20px;--pill:980px;--sans:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Inter","Helvetica Neue",Helvetica,Arial,system-ui,sans-serif}
@font-face{font-family:'Inter';src:url('/fonts/inter.woff2') format('woff2');font-weight:100 900;font-display:swap}
*{box-sizing:border-box}body{margin:0;font-family:var(--sans);color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased;letter-spacing:-.011em;line-height:1.47}
a{color:inherit;text-decoration:none}img{display:block;max-width:100%}
@supports(corner-shape:superellipse(2)){.hdr,.card,.thumb,.wc,.ev .cov{corner-shape:superellipse(2)}}
nav{max-width:940px;margin:0 auto;padding:16px 20px;display:flex;align-items:center;justify-content:space-between}
.brand{font-weight:600;font-size:19px;letter-spacing:-.02em}
.btn{display:inline-flex;align-items:center;gap:7px;font-size:15px;font-weight:600;padding:11px 20px;border-radius:var(--pill);border:1px solid transparent;cursor:pointer;background:var(--accent);color:#fff;transition:filter .15s,border-color .15s,background .15s}
.btn:hover{filter:brightness(1.05)}
.btn.sm{padding:9px 16px;font-size:14px}
.btn.ghost{background:rgba(255,255,255,.16);color:#fff;border-color:rgba(255,255,255,.4);backdrop-filter:blur(6px)}
.btn.ghost:hover{background:rgba(255,255,255,.26);filter:none}
.btn.lt{background:var(--bg);color:var(--ink);border-color:var(--line)}
.btn.lt:hover{border-color:var(--accent);filter:none}
.page{max-width:940px;margin:0 auto;padding:4px 20px 60px}

/* cover-backed event header */
.hdr{position:relative;border-radius:26px;overflow:hidden;color:#fff;min-height:340px;display:flex}
.hdr .cover{position:absolute;inset:0;background-size:cover;background-position:center;transform:scale(1.02)}
.hdr .cover::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.15) 0%,rgba(0,0,0,.35) 45%,rgba(0,0,0,.85) 100%)}
.hdr .in{position:relative;z-index:1;padding:28px;display:flex;flex-direction:column;justify-content:flex-end;width:100%}
.hactions{position:absolute;top:24px;right:24px;z-index:2;display:flex;gap:8px}
.statuspill{display:inline-flex;align-items:center;gap:8px;align-self:flex-start;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;background:rgba(0,0,0,.4);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,.25);border-radius:var(--pill);padding:6px 13px;margin-bottom:14px}
.statuspill .dot{width:8px;height:8px;border-radius:50%;background:var(--live);box-shadow:0 0 0 0 rgba(255,59,92,.6);animation:pulse 1.7s infinite}
@keyframes pulse{70%{box-shadow:0 0 0 8px rgba(255,59,92,0)}100%{box-shadow:0 0 0 0 rgba(255,59,92,0)}}
.etitle{font-size:clamp(30px,5vw,44px);font-weight:700;letter-spacing:-.025em;margin:0;line-height:1.05;text-shadow:0 2px 20px rgba(0,0,0,.3)}
.emeta{font-size:15px;opacity:.92;margin-top:8px}
.ecta{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:18px}
.ecta .note{font-size:13px;opacity:.85}
.preview{display:inline-block;margin-top:16px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#fff;background:rgba(255,255,255,.16);border-radius:var(--pill);padding:5px 12px;align-self:flex-start}

.card{background:var(--card);border-radius:var(--r);padding:24px;margin-top:16px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 0 0 1px var(--hair)}
.card h2{font-size:20px;font-weight:600;letter-spacing:-.02em;margin:0 0 6px}
.card .sub{color:var(--ink2);font-size:14px;margin:0 0 16px}
.livebar{display:flex;align-items:center;gap:14px}
.livebar .eq{display:flex;gap:3px;align-items:flex-end;height:26px}
.livebar .eq i{width:4px;background:var(--accent);border-radius:2px;animation:bar 1s ease-in-out infinite}
.livebar .eq i:nth-child(2){animation-delay:.15s}.livebar .eq i:nth-child(3){animation-delay:.35s}.livebar .eq i:nth-child(4){animation-delay:.5s}.livebar .eq i:nth-child(5){animation-delay:.2s}
@keyframes bar{0%,100%{height:6px}50%{height:24px}}
.livebar .np b{font-weight:600}.livebar .np div{color:var(--ink2);font-size:13px}
.livebar .cnt{margin-left:auto;text-align:right}.livebar .cnt b{font-size:22px}.livebar .cnt span{display:block;color:var(--ink2);font-size:12px}
.wall{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
@media(max-width:640px){.wall{grid-template-columns:repeat(3,1fr)}}
.wall .thumb{aspect-ratio:1;border-radius:12px;background-size:cover;background-position:center;background-color:var(--bg)}
.wall .add{aspect-ratio:1;border-radius:12px;border:1px dashed var(--line);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--ink2);font-size:12px;text-align:center;padding:8px;cursor:pointer}
.wall .add:hover{border-color:var(--accent);color:var(--accent)}
.cardhint{color:var(--ink3);font-size:12px;margin-top:14px}
.about p{margin:0 0 16px;color:var(--ink);font-size:15px;line-height:1.55;max-width:64ch}
.slist{display:flex;gap:10px}
.slist a{width:38px;height:38px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;color:#fff}
.slist svg{width:18px;height:18px}
footer{max-width:940px;margin:0 auto;padding:28px 20px 60px;color:var(--ink3);font-size:13px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px}
.toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);background:#1d1d1f;color:#fff;padding:12px 18px;border-radius:var(--pill);font-size:14px;opacity:0;pointer-events:none;transition:.25s;z-index:50}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.nf{max-width:560px;margin:70px auto;text-align:center;padding:0 22px}
.nf .art{width:96px;height:96px;border-radius:26px;margin:0 auto 22px;background:linear-gradient(135deg,#6d1a54,#a52c7c);display:grid;place-items:center;font-size:44px}
.nf h1{font-size:32px;letter-spacing:-.025em;margin:0 0 10px}.nf p{color:var(--ink2);font-size:18px;margin:0 0 26px;line-height:1.5}
`;

const SVGDEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<g id="ig"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.5" cy="6.5" r="1.3"/></g>
<g id="sc"><path d="M9.5 17.5H18a3 3 0 0 0 .2-6A5.2 5.2 0 0 0 9.8 8.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M3.2 12v5.5M5.6 10v7.5M8 9v8.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></g>
<g id="sp"><circle cx="12" cy="12" r="10"/><path d="M7 10.2c3-.9 6.6-.5 9.2 1.1M7.6 12.8c2.4-.7 5.4-.4 7.5 1M8.1 15.2c1.9-.5 4-.3 5.6.8" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></g>
</defs></svg>`;

const NAV = `<nav><a class="brand" href="/">🕺 partyparty</a><a class="btn lt sm" href="/partyparty.zip">Get the app</a></nav>`;

const TOAST_JS = `<div class="toast" id="t"></div><script>
var tt;function toast(m){var e=document.getElementById('t');e.textContent=m;e.classList.add('show');clearTimeout(tt);tt=setTimeout(function(){e.classList.remove('show')},2600)}
document.querySelectorAll('[data-soon]').forEach(function(el){el.addEventListener('click',function(ev){ev.preventDefault();toast(el.getAttribute('data-soon'))})});
</script>`;

function shell({ title, desc, ogImage, body }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : ""}
<meta name="theme-color" content="#f5f5f7"><meta name="color-scheme" content="light">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🕺</text></svg>">
<link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin>
<style>${CSS}</style></head><body>${SVGDEFS}${NAV}${body}${TOAST_JS}</body></html>`;
}

function renderEvent(e) {
  const soon = "Coming soon — event pages are in progress.";
  const social = (id, url, bg) => url ? `<a href="${esc(url)}" data-soon="${soon}" style="background:${bg}" aria-label="${id}"><svg viewBox="0 0 24 24" fill="currentColor"><use href="#${id}"/></svg></a>` : "";
  const statusPill = e.status === "live"
    ? `<span class="statuspill"><span class="dot"></span> Live · ${esc(e.listeners)} listening</span>`
    : e.status === "upcoming" ? `<span class="statuspill">Upcoming</span>`
    : `<span class="statuspill">▶ Replay</span>`;

  const liveCard = e.status === "live" ? `
  <div class="card">
    <div class="livebar">
      <div class="eq"><i></i><i></i><i></i><i></i><i></i></div>
      <div class="np"><b>Now playing</b><div>${esc(e.tagline)}</div></div>
      <div class="cnt"><b>${esc(e.listeners)}</b><span>listening, in sync</span></div>
    </div>
    <div class="cardhint">To listen, scan the QR at the party — the set plays in your browser, no app. When the DJ stops, the replay lands here.</div>
  </div>` : "";

  const body = `<div class="page">
    <div class="hdr">
      <div class="cover" style="background-image:url('${esc(e.cover)}')"></div>
      <div class="hactions"><button class="btn ghost sm" data-soon="${soon}">Share</button></div>
      <div class="in">
        ${statusPill}
        <h1 class="etitle">${esc(e.title)}</h1>
        <div class="emeta">${esc(e.when)} · ${esc(e.where)} · by ${esc(e.dj)}</div>
        <div class="ecta"><button class="btn" data-soon="${soon}">＋ Add your photos &amp; videos</button><span class="note">Scan the QR at the party to listen</span></div>
        <span class="preview">Preview · app ships today, event pages in progress</span>
      </div>
    </div>
    ${liveCard}
    <div class="card">
      <h2>The wall</h2>
      <p class="sub">Everything the room shot tonight — you approve what shows.</p>
      <div class="wall">
        ${(e.wall || []).map((s) => `<div class="thumb" style="background-image:url('${esc(s)}')"></div>`).join("")}
        <div class="add" data-soon="${soon}"><div style="font-size:22px">＋</div>Add yours</div>
      </div>
      <div class="cardhint">Guests drop photos, videos and comments straight from their phone — moderated by the DJ. Coming soon.</div>
    </div>
    <div class="card about">
      <h2>About this set</h2>
      <p>${esc(e.about)}</p>
      <div class="slist">${social("sc", e.socials?.soundcloud, "#ff7700")}${social("ig", e.socials?.instagram, "#c13584")}${social("sp", e.socials?.spotify, "#1db954")}</div>
    </div>
  </div>
  <footer><span>🕺 partyparty</span><span>Silent-disco popups on your Mac · <a href="/" style="color:var(--link)">what is this?</a></span></footer>`;

  return shell({ title: `${e.title} · partyparty`, desc: `${e.title} — ${e.when} · ${e.where}. ${e.tagline}`, ogImage: e.cover, body });
}

function renderNotFound() {
  const body = `<div class="nf">
    <div class="art">🕺</div>
    <h1>That event isn't here.</h1>
    <p>Every partyparty popup gets a page that gathers the night — photos, videos and clips from everyone there. Throw one and share the link.</p>
    <a class="btn" style="padding:13px 24px;font-size:16px" href="/partyparty.zip">Get the app</a>
    <p style="font-size:13px;margin-top:22px">Event pages are in progress. <a href="/" style="color:var(--link)">See what partyparty is ›</a></p>
  </div>`;
  return shell({ title: `partyparty`, desc: `partyparty event page`, body });
}

// ---- Cert broker (the Plex pattern, vendor side) ----
//
// Lets ANY partyparty install get a real Let's Encrypt cert with zero config:
// the app registers here once (an id + bearer secret + its own namespace
// <id>.BROKER_BASE), runs ACME locally (private keys never leave the DJ's
// Mac), and asks this broker to publish the DNS-01 challenge TXT and the
// IP-encoded A records (192-168-1-117.<id>.pp.ramine.net -> 192.168.1.117 —
// created once, correct forever). The Cloudflare DNS token lives ONLY here as
// a Worker secret; each install can only write inside its own namespace.

const jsonResp = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

async function cfDNS(env, method, suffix, body) {
  const url = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records${suffix}`;
  const resp = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${env.CF_DNS_TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await resp.json().catch(() => ({}));
  if (!j.success) throw new Error("cloudflare: " + (j.errors && j.errors[0] ? j.errors[0].message : resp.status));
  return j.result;
}

async function broker(request, env, pathname) {
  // Reachability probe for the app's connection test (any method, no auth,
  // no side effects) — proves the venue's network can reach the broker.
  if (pathname === "/api/broker/ping") return jsonResp(200, { ok: true, t: Date.now() });
  if (request.method !== "POST") return jsonResp(405, { error: "POST required" });
  if (!env.CF_DNS_TOKEN || !env.CF_ZONE_ID || !env.BROKER_BASE) return jsonResp(503, { error: "broker not configured" });
  const body = await request.json().catch(() => null);
  if (!body) return jsonResp(400, { error: "bad json" });

  if (pathname === "/api/broker/register") {
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const secret = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    // Pretty, memorable hostname label (disco42, groove7…) — the guest link is
    // https://<slug>.<base>:8443/, not an IP-encoded eyesore.
    const WORDS = ["disco", "groove", "bass", "vinyl", "tempo", "fader", "reverb", "echo", "strobe", "neon",
      "boombox", "sub", "beat", "drop", "loop", "mix", "vibe", "funk", "wave", "pulse",
      "rhythm", "deck", "fade", "amp", "chorus", "riff", "snare", "hihat", "kick", "midi"];
    let slug = "";
    for (let tries = 0; tries < 10; tries++) {
      const cand = WORDS[Math.floor(Math.random() * WORDS.length)] + String(Math.floor(Math.random() * 90) + 10);
      if (!(await env.DL.get(`broker/slug/${cand}`))) { slug = cand; break; }
    }
    if (!slug) slug = "party" + id.slice(0, 6); // vanishingly unlikely
    await env.DL.put(`broker/slug/${slug}`, id);
    await env.DL.put(`broker/${id}.json`, JSON.stringify({ secret, slug, created: Date.now() }));
    return jsonResp(200, { id, secret, base: env.BROKER_BASE, slug });
  }

  // Authenticated endpoints — writes are confined to <id>.<base>.
  // Support/admin retrieval: ADMIN_KEY (a Worker secret) may stand in for an
  // install's own secret on the read-only dump/list/get endpoints, so field
  // problems can be pulled up by install id without asking anyone for creds.
  const isAdmin = env.ADMIN_KEY && body.admin === env.ADMIN_KEY;
  const id = String(body.id || "");
  if (!/^[a-f0-9]{12}$/.test(id)) return jsonResp(400, { error: "bad id" });
  const rec = await env.DL.get(`broker/${id}.json`).then((o) => (o ? o.json() : null));
  const READ_ONLY = ["/api/broker/telemetry-dump", "/api/broker/log-list", "/api/broker/log-get"];
  if (isAdmin && READ_ONLY.includes(pathname)) {
    // admin bypass — read-only endpoints only
  } else if (!rec || rec.secret !== body.secret) {
    return jsonResp(403, { error: "bad credentials" });
  }

  // The install's namespace label: its pretty slug (new installs) or its raw
  // id (pre-slug installs). Writes stay confined to that label.
  const label = rec.slug || id;

  if (pathname === "/api/broker/txt") {
    const value = String(body.value || "");
    if (!value || value.length > 255) return jsonResp(400, { error: "bad value" });
    const name = `_acme-challenge.${label}.${env.BROKER_BASE}`;
    const old = await cfDNS(env, "GET", `?type=TXT&name=${name}`);
    for (const r of old || []) await cfDNS(env, "DELETE", "/" + r.id);
    await cfDNS(env, "POST", "", { type: "TXT", name, content: value, ttl: 60 });
    return jsonResp(200, { ok: true, name });
  }

  if (pathname === "/api/broker/a") {
    const ip = String(body.ip || "");
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return jsonResp(400, { error: "bad ip" });
    // Slugged installs: ONE record per install, upserted to the current venue
    // IP (DNS-only, never proxied). Pre-slug installs keep the old IP-encoded
    // create-once names.
    const name = rec.slug
      ? `${rec.slug}.${env.BROKER_BASE}`
      : `${ip.replaceAll(".", "-")}.${id}.${env.BROKER_BASE}`;
    const existing = await cfDNS(env, "GET", `?type=A&name=${name}`);
    if (existing && existing.length) {
      if (existing[0].content !== ip) {
        await cfDNS(env, "PUT", "/" + existing[0].id, { type: "A", name, content: ip, ttl: 60, proxied: false });
      }
    } else {
      await cfDNS(env, "POST", "", { type: "A", name, content: ip, ttl: 60, proxied: false });
    }
    return jsonResp(200, { ok: true, host: name });
  }

  // Debug telemetry: the DJ's Mac snapshots its /api/status here while live so
  // playback problems can be analyzed after the fact (per-listener latency,
  // rate, buffer, delivery, sync spread, the app's log ring). Scoped to the
  // install's own prefix; ~20KB per 30s while broadcasting.
  if (pathname === "/api/broker/telemetry") {
    if (!body.snap) return jsonResp(400, { error: "no snap" });
    await env.DL.put(`telemetry/${id}/${Date.now()}.json`, JSON.stringify(body.snap));
    return jsonResp(200, { ok: true });
  }
  // Session diagnostics: the app ships its gzipped session log here every few
  // minutes (and on quit). ~50-500KB per upload, replaced per session key.
  if (pathname === "/api/broker/log") {
    const session = String(body.session || "").replace(/[^a-zA-Z0-9._-]/g, "");
    if (!body.log || !session) return jsonResp(400, { error: "no log/session" });
    let bytes;
    try {
      bytes = Uint8Array.from(atob(body.log), (c) => c.charCodeAt(0));
    } catch (e) {
      return jsonResp(400, { error: "bad base64" });
    }
    if (bytes.length > 6_000_000) return jsonResp(413, { error: "log too large" });
    await env.DL.put(`logs/${id}/${session}.log.gz`, bytes);
    return jsonResp(200, { ok: true });
  }
  if (pathname === "/api/broker/log-list") {
    const list = await env.DL.list({ prefix: `logs/${id}/`, limit: 1000 });
    return jsonResp(200, { logs: list.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded })) });
  }
  if (pathname === "/api/broker/log-get") {
    const key = String(body.key || "");
    if (!key.startsWith(`logs/${id}/`)) return jsonResp(400, { error: "bad key" });
    const o = await env.DL.get(key);
    if (!o) return jsonResp(404, { error: "not found" });
    const buf = new Uint8Array(await o.arrayBuffer());
    let b64 = "";
    for (let i = 0; i < buf.length; i += 0x8000) b64 += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return jsonResp(200, { key, gz: btoa(b64) });
  }
  if (pathname === "/api/broker/telemetry-dump") {
    const n = Math.min(Number(body.n) || 10, 50);
    const list = await env.DL.list({ prefix: `telemetry/${id}/`, limit: 1000 });
    const keys = list.objects.map((o) => o.key).sort().slice(-n);
    const entries = [];
    for (const k of keys) {
      const o = await env.DL.get(k);
      if (o) entries.push({ key: k, snap: await o.json() });
    }
    return jsonResp(200, { entries });
  }

  return jsonResp(404, { error: "unknown broker endpoint" });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith("/api/broker/")) {
      try {
        return await broker(request, env, pathname);
      } catch (e) {
        return jsonResp(500, { error: String((e && e.message) || e) });
      }
    }

    const isFeed = pathname === "/appcast.xml";
    const isZip = ZIP_RE.test(pathname);
    if (isFeed || isZip) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const key = pathname.slice(1);
      const obj = await env.DL.get(key);
      if (!obj) return new Response("Not found — run `make release`.", { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      if (isFeed) {
        headers.set("content-type", "application/xml");
        headers.set("cache-control", "public, max-age=60");
      } else {
        headers.set("content-type",
          key.endsWith(".dmg") ? "application/x-apple-diskimage" :
          key.endsWith(".pkg") ? "application/octet-stream" : "application/zip");
        // The stable "latest" pkg downloads with a friendly, branded filename;
        // versioned/other files keep their real name.
        const dlName = key === "partyparty.pkg" ? "PartyParty Installer.pkg" : key;
        headers.set("content-disposition", `attachment; filename="${dlName}"`);
        const isLatestAlias = key === "partyparty.zip" || key === "partyparty.pkg" || key === "partyparty.dmg";
        headers.set("cache-control", isLatestAlias ? "public, max-age=300" : "public, max-age=86400, immutable");
      }
      return new Response(request.method === "HEAD" ? null : obj.body, { headers });
    }

    // Event pages: /e/<slug> (canonical) and /@<handle> (demo, so shared links work).
    if (EVENT_RE.test(pathname) || HANDLE_RE.test(pathname)) {
      const html = renderEvent(DEMO); // seed; swaps for a real lookup (D1) later
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
    }

    return env.ASSETS.fetch(request);
  },
};
