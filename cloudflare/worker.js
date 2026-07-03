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
// Published set media (audio + waveform) and event cover, served range-aware
// from R2 under event/<slug>/. File shapes are pinned so a slug can only reach
// its own set/cover objects.
const MEDIA_RE = /^\/event\/([A-Za-z0-9_.-]{1,48})\/([a-f0-9]{1,32}\.m4a|[a-f0-9]{1,32}\.peaks\.json|cover\.jpg)$/;
const SLUG_RE = /^[A-Za-z0-9_.-]{1,48}$/;
const SETID_RE = /^[a-f0-9]{1,32}$/;
// OTA content: the signed manifest (pointer, short cache) and immutable,
// versioned payload bundles. Served from R2 under the content/ prefix.
const CONTENT_RE = /^\/content\/(manifest\.json|payload-\d+\.tar\.gz)$/;
const SITE_ORIGIN = "https://party.ramine.net";
const DEFAULT_OG_IMAGE = "/img/og-default.jpg";

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);
const randHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const absUrl = (s) => {
  try { return new URL(s || "/", SITE_ORIGIN).href; }
  catch (_) { return SITE_ORIGIN + "/"; }
};

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
.player .psub{color:var(--ink2);font-size:14px;margin:0 0 16px}
.wave{display:flex;align-items:center;gap:2px;height:64px;cursor:pointer;margin-bottom:14px}
.wave i{flex:1 1 0;min-width:2px;min-height:2px;background:var(--line);border-radius:2px;transition:background .12s}
.wave i.on{background:var(--accent)}
.player audio{width:100%;margin-top:4px}
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
document.querySelectorAll('[data-share]').forEach(function(el){el.addEventListener('click',async function(ev){ev.preventDefault();var url=el.getAttribute('data-share-url')||location.href,title=el.getAttribute('data-share-title')||document.title,text=el.getAttribute('data-share-text')||'';try{if(navigator.share){await navigator.share({title:title,text:text,url:url});return}}catch(e){if(e&&e.name==='AbortError')return}try{if(navigator.clipboard&&navigator.clipboard.writeText){await navigator.clipboard.writeText(url)}else{var ta=document.createElement('textarea');ta.value=url;ta.setAttribute('readonly','');ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta)}toast('Link copied')}catch(e){toast(url)}})});
</script>`;

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
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🕺</text></svg>">
<link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin>
<style>${CSS}</style></head><body>${SVGDEFS}${NAV}${body}${TOAST_JS}</body></html>`;
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return (h ? h + ":" : "") + mm + ":" + String(sec).padStart(2, "0");
}

// eventFromRow projects a D1 events row (+ its latest ready set) into the shape
// renderEvent expects. A missing set yields an "upcoming" empty state.
function eventFromRow(row, set, slug) {
  return {
    slug,
    title: row.title || "A partyparty set",
    dj: row.host || "",
    when: row.starts || "",
    where: row.where_txt || "",
    // Drive the pill off whether a ready set exists, not the D1 status column
    // (which defaults to 'replay') — a set-less event (cover/meta only) reads as
    // "upcoming", which is what the empty-state card keys on.
    status: set ? "replay" : "upcoming",
    listeners: 0,
    tagline: row.tagline || "",
    cover: row.cover_key ? `/event/${slug}/cover.jpg` : "/img/dance.jpg",
    about: row.about || "",
    wall: [],
    socials: {},
    set: set ? { id: set.id, durationMs: set.duration_ms } : null,
  };
}

function renderEvent(e) {
  const soon = "Coming soon — event pages are in progress.";
  const social = (id, url, bg) => url ? `<a href="${esc(url)}" data-soon="${soon}" style="background:${bg}" aria-label="${id}"><svg viewBox="0 0 24 24" fill="currentColor"><use href="#${id}"/></svg></a>` : "";
  const statusPill = e.status === "live"
    ? `<span class="statuspill"><span class="dot"></span> Live · ${esc(e.listeners)} listening</span>`
    : e.status === "upcoming" ? `<span class="statuspill">Upcoming</span>`
    : `<span class="statuspill">▶ Replay</span>`;

  const metaBits = [e.when, e.where, e.dj ? "by " + e.dj : ""].filter(Boolean).map(esc);
  const emeta = metaBits.length ? `<div class="emeta">${metaBits.join(" · ")}</div>` : "";
  const ctaNote = e.status === "live" ? "Scan the QR at the party to listen"
    : e.set ? "The set replay is below — press play" : "The replay lands here when the DJ finishes";

  // Live (the demo seed) shows the animated now-playing bar; a published event
  // shows the real replay player.
  const liveCard = e.status === "live" ? `
  <div class="card">
    <div class="livebar">
      <div class="eq"><i></i><i></i><i></i><i></i><i></i></div>
      <div class="np"><b>Now playing</b><div>${esc(e.tagline)}</div></div>
      <div class="cnt"><b>${esc(e.listeners)}</b><span>listening, in sync</span></div>
    </div>
    <div class="cardhint">To listen, scan the QR at the party — the set plays in your browser, no app. When the DJ stops, the replay lands here.</div>
  </div>` : "";

  const playerCard = e.set ? `
  <div class="card player">
    <h2>The set ▶</h2>
    <p class="psub">${esc(fmtDur(e.set.durationMs))} · silent-disco replay</p>
    <div class="wave" id="wave" data-peaks="/event/${esc(e.slug)}/${esc(e.set.id)}.peaks.json"></div>
    <audio id="setaudio" controls preload="none" src="/event/${esc(e.slug)}/${esc(e.set.id)}.m4a"></audio>
  </div>` : "";

  const aboutInner = (e.about ? `<p>${esc(e.about)}</p>` : "") +
    (social("sc", e.socials?.soundcloud, "#ff7700") + social("ig", e.socials?.instagram, "#c13584") + social("sp", e.socials?.spotify, "#1db954")
      ? `<div class="slist">${social("sc", e.socials?.soundcloud, "#ff7700")}${social("ig", e.socials?.instagram, "#c13584")}${social("sp", e.socials?.spotify, "#1db954")}</div>` : "");
  const aboutCard = aboutInner ? `<div class="card about"><h2>About this set</h2>${aboutInner}</div>` : "";
  const previewBadge = e.set ? "" : `<span class="preview">Preview · event pages in progress</span>`;
  const shareUrl = e.slug ? `${SITE_ORIGIN}/e/${esc(e.slug)}` : "";
  const shareButton = e.slug
    ? `<button class="btn ghost sm" data-share data-share-url="${shareUrl}" data-share-title="${esc(e.title)} · partyparty" data-share-text="${esc(e.tagline || "A partyparty set")}">Share</button>`
    : `<button class="btn ghost sm" data-soon="${soon}">Share</button>`;
  const upcomingCard = !e.set && e.status === "upcoming" ? `
  <div class="card"><p class="sub" style="margin:0">The set replay lands here once ${esc(e.dj || "the DJ")} plays. Check back after the party.</p></div>` : "";

  const waveScript = e.set ? `<script>
(function(){var a=document.getElementById('setaudio'),w=document.getElementById('wave');if(!a||!w)return;var bars=[];
fetch(w.getAttribute('data-peaks')).then(function(r){return r.json()}).then(function(d){var p=(d&&d.peaks)||[];w.innerHTML='';p.forEach(function(v){var b=document.createElement('i');b.style.height=Math.max(2,v)+'%';w.appendChild(b);bars.push(b)})}).catch(function(){});
function paint(){if(!bars.length||!a.duration)return;var k=Math.floor((a.currentTime/a.duration)*bars.length);for(var i=0;i<bars.length;i++)bars[i].className=i<=k?'on':''}
a.addEventListener('timeupdate',paint);
w.addEventListener('click',function(e){if(!a.duration)return;var r=w.getBoundingClientRect();a.currentTime=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width))*a.duration});
})();
</script>` : "";

  const body = `<div class="page">
    <div class="hdr">
      <div class="cover" style="background-image:url('${esc(e.cover)}')"></div>
      <div class="hactions">${shareButton}</div>
      <div class="in">
        ${statusPill}
        <h1 class="etitle">${esc(e.title)}</h1>
        ${emeta}
        <div class="ecta"><button class="btn" data-soon="${soon}">＋ Add your photos &amp; videos</button><span class="note">${esc(ctaNote)}</span></div>
        ${previewBadge}
      </div>
    </div>
    ${liveCard}${playerCard}${upcomingCard}
    <div class="card">
      <h2>The wall</h2>
      <p class="sub">Everything the room shot tonight — you approve what shows.</p>
      <div class="wall">
        ${(e.wall || []).map((s) => `<div class="thumb" style="background-image:url('${esc(s)}')"></div>`).join("")}
        <div class="add" data-soon="${soon}"><div style="font-size:22px">＋</div>Add yours</div>
      </div>
      <div class="cardhint">Guests drop photos, videos and comments straight from their phone — moderated by the DJ. Coming soon.</div>
    </div>
    ${aboutCard}
  </div>
  <footer><span>🕺 partyparty</span><span>Silent-disco popups on your Mac · <a href="/" style="color:var(--link)">what is this?</a></span></footer>${waveScript}`;

  const descBits = [e.when, e.where].filter(Boolean).join(" · ");
  const ogImage = e.cover && e.cover.indexOf("/event/") === 0 ? e.cover : DEFAULT_OG_IMAGE;
  return shell({ title: `${e.title} · partyparty`, desc: `${e.title}${descBits ? " — " + descBits : ""}. ${e.tagline}`.trim(), ogImage, url: e.slug ? `/e/${e.slug}` : "/", body });
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

// contentState returns the latest published versions, cached briefly so the
// long-poll's repeated reads and every concurrent subscriber collapse to about
// one R2 read per window instead of ~2 reads every couple seconds per Mac. The
// short TTL keeps push latency to a few seconds. Falls back to a direct read if
// the edge cache is unavailable.
async function contentState(env) {
  const cache = caches.default;
  const key = new Request("https://pp-internal-cache/content-state");
  try {
    const hit = await cache.match(key);
    if (hit) return await hit.json();
  } catch (e) { /* fall through to a direct read */ }
  const state = await readContentState(env);
  try {
    await cache.put(key, new Response(JSON.stringify(state), {
      headers: { "content-type": "application/json", "cache-control": "max-age=3" },
    }));
  } catch (e) { /* caching is best-effort */ }
  return state;
}

// readContentState pulls the versions from existing R2 artifacts: the payload
// version from the signed manifest, the app version from a one-line marker
// release.sh writes. Missing artifacts degrade to zeros (nothing to update to)
// rather than erroring.
async function readContentState(env) {
  let payloadVersion = 0, minRuntime = 1, appVersion = "";
  try {
    const m = await env.DL.get("content/manifest.json");
    if (m) { const j = await m.json(); payloadVersion = j.payloadVersion || 0; minRuntime = j.minRuntime || 1; }
  } catch (e) { /* leave defaults */ }
  try {
    const a = await env.DL.get("content/app-version");
    if (a) appVersion = (await a.text()).trim();
  } catch (e) { /* leave empty */ }
  return { payloadVersion, minRuntime, appVersion };
}

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

// authInstall validates an install id + secret against its broker record and
// returns the record (or null). The shared identity check behind every publish
// route — same {id,secret} primitive the cert broker uses.
async function authInstall(env, id, secret) {
  if (!/^[a-f0-9]{12}$/.test(String(id || ""))) return null;
  const rec = await env.DL.get(`broker/${id}.json`).then((o) => (o ? o.json() : null));
  if (!rec || rec.secret !== secret) return null;
  return rec;
}

// auditPublish appends a best-effort row to publish_events (forensics only —
// never blocks or fails a publish).
async function auditPublish(env, id, slug, action) {
  try {
    await env.DB.prepare("INSERT INTO publish_events (install_id, slug, action, ts_ms) VALUES (?,?,?,?)")
      .bind(id, slug, action, Date.now()).run();
  } catch (e) { /* best-effort */ }
}

// publishUpload streams a set's audio/waveform straight into R2. Header-authed
// (creds can't ride the JSON body — the body IS the media), with the slug's
// ownership re-checked against D1 on every call before any write, so a valid
// install can only ever write inside an event it owns.
async function publishUpload(request, env, pathname) {
  if (request.method !== "PUT") return jsonResp(405, { error: "PUT required" });
  if (!env.DB) return jsonResp(503, { error: "events db not configured" });
  const id = request.headers.get("x-pp-id") || "";
  const rec = await authInstall(env, id, request.headers.get("x-pp-secret") || "");
  if (!rec) return jsonResp(403, { error: "bad credentials" });
  const slug = request.headers.get("x-pp-slug") || "";
  const setId = request.headers.get("x-pp-set") || "";
  if (!SLUG_RE.test(slug) || !SETID_RE.test(setId)) return jsonResp(400, { error: "bad slug/set" });
  // Ownership: the slug must be owned by THIS install, and the set must belong
  // to the slug — both re-checked here, independent of publish-meta.
  const owner = await env.DB.prepare("SELECT install_id FROM events WHERE slug=?").bind(slug).first();
  if (!owner || owner.install_id !== id) return jsonResp(403, { error: "not your event" });
  const set = await env.DB.prepare("SELECT slug FROM event_sets WHERE id=?").bind(setId).first();
  if (!set || set.slug !== slug) return jsonResp(404, { error: "no such set" });

  const isAudio = pathname === "/api/broker/publish-audio";
  const cap = isAudio ? 200_000_000 : 2_000_000;
  const cl = Number(request.headers.get("content-length") || "0");
  if (!cl || cl > cap) return jsonResp(413, { error: "bad size" });
  const key = isAudio ? `event/${slug}/${setId}.m4a` : `event/${slug}/${setId}.peaks.json`;
  const put = await env.DL.put(key, request.body, { httpMetadata: { contentType: isAudio ? "audio/mp4" : "application/json" } });
  // Don't trust the declared content-length for what actually landed: R2 reports
  // the real stored size, so a body that lied (small header, large stream) is
  // deleted and rejected rather than persisted or recorded.
  const size = (put && typeof put.size === "number") ? put.size : cl;
  if (size > cap) {
    await env.DL.delete(key);
    return jsonResp(413, { error: "too large" });
  }
  if (isAudio) {
    // Symmetric ready-flip: whichever of audio/peaks lands SECOND promotes the
    // set. Otherwise a peaks-before-audio order (a retry, a reordered proxy)
    // would strand a fully-uploaded set at 'pending' forever.
    await env.DB.prepare("UPDATE event_sets SET audio_key=?, size_bytes=?, state=CASE WHEN peaks_key IS NOT NULL THEN 'ready' ELSE state END WHERE id=?").bind(key, size, setId).run();
  } else {
    await env.DB.prepare("UPDATE event_sets SET peaks_key=?, state=CASE WHEN audio_key IS NOT NULL THEN 'ready' ELSE state END WHERE id=?").bind(key, setId).run();
  }
  await auditPublish(env, id, slug, isAudio ? "publish-audio" : "publish-peaks");
  return jsonResp(200, { ok: true, key });
}

async function publishCover(request, env) {
  if (request.method !== "PUT") return jsonResp(405, { error: "PUT required" });
  if (!env.DB) return jsonResp(503, { error: "events db not configured" });
  const id = request.headers.get("x-pp-id") || "";
  const rec = await authInstall(env, id, request.headers.get("x-pp-secret") || "");
  if (!rec) return jsonResp(403, { error: "bad credentials" });
  const slug = request.headers.get("x-pp-slug") || "";
  if (!SLUG_RE.test(slug)) return jsonResp(400, { error: "bad slug" });
  // First-writer-wins, matching publish-meta: a cover can create/claim the
  // event row before the set itself exists, but never steal another install's slug.
  const owner = await env.DB.prepare("SELECT install_id FROM events WHERE slug=?").bind(slug).first();
  if (owner && owner.install_id !== id) return jsonResp(409, { error: "slug taken" });
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO events (slug, install_id, created_ms, updated_ms)
     VALUES (?1,?2,?3,?3)
     ON CONFLICT(slug) DO UPDATE SET updated_ms=?3
     WHERE events.install_id=?2`
  ).bind(slug, id, now).run();
  const check = await env.DB.prepare("SELECT install_id FROM events WHERE slug=?").bind(slug).first();
  if (!check || check.install_id !== id) return jsonResp(409, { error: "slug taken" });

  const cap = 8_000_000;
  const cl = Number(request.headers.get("content-length") || "0");
  if (!cl || cl > cap) return jsonResp(413, { error: "bad size" });
  const key = `event/${slug}/cover.jpg`;
  const put = await env.DL.put(key, request.body, { httpMetadata: { contentType: "image/jpeg" } });
  const size = (put && typeof put.size === "number") ? put.size : cl;
  if (size > cap) {
    await env.DL.delete(key);
    return jsonResp(413, { error: "too large" });
  }
  await env.DB.prepare("UPDATE events SET cover_key=?, updated_ms=? WHERE slug=? AND install_id=?").bind(key, now, slug, id).run();
  await auditPublish(env, id, slug, "publish-cover");
  return jsonResp(200, { ok: true, key });
}

async function broker(request, env, pathname) {
  // Reachability probe for the app's connection test (any method, no auth,
  // no side effects) — proves the venue's network can reach the broker.
  if (pathname === "/api/broker/ping") return jsonResp(200, { ok: true, t: Date.now() });
  // Binary uploads: header-authed + streamed, so they must run BEFORE the
  // POST-only guard and the request.json() parse below.
  if (pathname === "/api/broker/publish-audio" || pathname === "/api/broker/publish-peaks") {
    return await publishUpload(request, env, pathname);
  }
  if (pathname === "/api/broker/publish-cover") {
    return await publishCover(request, env);
  }
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
  // Admin-only: enumerate installs (id + slug + created) so support tooling
  // can find "fader91" without anyone reading out an install id. Sits BEFORE
  // the per-install id validation — this endpoint has no id of its own.
  if (pathname === "/api/broker/installs") {
    if (!isAdmin) return jsonResp(403, { error: "admin only" });
    const list = await env.DL.list({ prefix: "broker/", limit: 1000 });
    const installs = [];
    for (const o of list.objects) {
      if (!o.key.endsWith(".json")) continue; // stray legacy objects
      try {
        const r2 = await env.DL.get(o.key).then((x) => (x ? x.json() : null));
        if (r2) installs.push({ id: o.key.slice(7, -5), slug: r2.slug || "", created: r2.created || 0 });
      } catch (e) { /* unparseable record — skip, don't kill the listing */ }
    }
    return jsonResp(200, { installs });
  }
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

  // Publish (metadata): claim/own the event slug and mint a pending set. The
  // two binary uploads (audio, peaks) follow on their own header-authed routes.
  if (pathname === "/api/broker/publish-meta") {
    if (!env.DB) return jsonResp(503, { error: "events db not configured" });
    const slug = String(body.slug || "");
    if (!SLUG_RE.test(slug)) return jsonResp(400, { error: "bad slug" });
    // First-writer-wins: a slug already owned by ANOTHER install is off-limits
    // (the Mac then retries with its collision-proof auto slug).
    const owner = await env.DB.prepare("SELECT install_id FROM events WHERE slug=?").bind(slug).first();
    if (owner && owner.install_id !== id) return jsonResp(409, { error: "slug taken" });
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO events (slug, install_id, title, host, starts, where_txt, tagline, about, status, created_ms, updated_ms)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'replay',?9,?9)
       ON CONFLICT(slug) DO UPDATE SET title=?3, host=?4, starts=?5, where_txt=?6, tagline=?7, about=?8, updated_ms=?9
       WHERE events.install_id=?2`
    ).bind(slug, id, clip(body.title, 200), clip(body.host, 80), clip(body.starts, 120),
      clip(body.where, 120), clip(body.tagline, 200), clip(body.about, 4000), now).run();
    // Re-verify ownership post-upsert (closes any claim race) before minting a set.
    const check = await env.DB.prepare("SELECT install_id FROM events WHERE slug=?").bind(slug).first();
    if (!check || check.install_id !== id) return jsonResp(409, { error: "slug taken" });
    const setId = randHex(12);
    await env.DB.prepare(
      `INSERT INTO event_sets (id, slug, duration_ms, size_bytes, recorded_ms, published_ms, state)
       VALUES (?,?,?,?,?,?, 'pending')`
    ).bind(setId, slug, Math.max(0, Number(body.duration_ms) || 0),
      Math.max(0, Number(body.size_bytes) || 0), Math.max(0, Number(body.recorded_ms) || 0), now).run();
    await auditPublish(env, id, slug, "publish-meta");
    return jsonResp(200, { ok: true, slug, setId, url: `https://${env.BROKER_BASE}/e/${slug}` });
  }

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

    // OTA content: the manifest and versioned payload bundles live in R2 under
    // content/. The manifest is the pointer (kept fresh); bundles are immutable.
    if (CONTENT_RE.test(pathname)) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const key = pathname.slice(1); // "content/manifest.json" | "content/payload-<v>.tar.gz"
      const obj = await env.DL.get(key);
      if (!obj) return new Response("Not found — run scripts/publish-payload.sh.", { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      const isManifest = key === "content/manifest.json";
      headers.set("content-type", isManifest ? "application/json" : "application/gzip");
      // Manifest is the pointer clients poll — short cache. Bundles are content-
      // addressed by version and never change — cache hard.
      headers.set("cache-control", isManifest ? "public, max-age=60" : "public, max-age=86400, immutable");
      return new Response(request.method === "HEAD" ? null : obj.body, { headers });
    }

    // Published set media (audio + waveform) and the event cover, from R2 under
    // event/<slug>/. Audio is served RANGE-AWARE (206) so <audio> can seek; it's
    // content-addressed by set id, so cache hard.
    const media = pathname.match(MEDIA_RE);
    if (media) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const file = media[2];
      const key = `event/${media[1]}/${file}`;
      const isAudio = file.endsWith(".m4a");
      const ctype = isAudio ? "audio/mp4" : file === "cover.jpg" ? "image/jpeg" : "application/json";
      const cache = file === "cover.jpg" ? "public, max-age=300" : "public, max-age=31536000, immutable";
      const rangeHdr = isAudio ? request.headers.get("range") : null;
      if (rangeHdr) {
        const head = await env.DL.head(key);
        if (!head) return new Response("Not found", { status: 404 });
        const size = head.size;
        const mm = /^bytes=(\d*)-(\d*)$/.exec(rangeHdr);
        let start = mm && mm[1] !== "" ? parseInt(mm[1], 10) : NaN;
        let end = mm && mm[2] !== "" ? parseInt(mm[2], 10) : NaN;
        if (mm) {
          if (isNaN(start) && !isNaN(end)) { start = Math.max(0, size - end); end = size - 1; } // bytes=-N suffix
          else if (!isNaN(start) && isNaN(end)) { end = size - 1; }                              // bytes=N-
        }
        if (mm && !isNaN(start) && !isNaN(end) && start <= end && start < size) {
          end = Math.min(end, size - 1);
          const obj = await env.DL.get(key, { range: { offset: start, length: end - start + 1 } });
          if (!obj) return new Response("Not found", { status: 404 });
          const h = new Headers();
          h.set("content-type", ctype);
          h.set("accept-ranges", "bytes");
          h.set("content-range", `bytes ${start}-${end}/${size}`);
          h.set("content-length", String(end - start + 1));
          h.set("cache-control", cache);
          h.set("etag", obj.httpEtag);
          return new Response(request.method === "HEAD" ? null : obj.body, { status: 206, headers: h });
        }
        // malformed/unsatisfiable range → fall through to whole-object 200
      }
      const obj = await env.DL.get(key);
      if (!obj) return new Response("Not found", { status: 404 });
      const h = new Headers();
      obj.writeHttpMetadata(h);
      h.set("content-type", ctype);
      h.set("accept-ranges", "bytes");
      h.set("cache-control", cache);
      h.set("etag", obj.httpEtag);
      return new Response(request.method === "HEAD" ? null : obj.body, { headers: h });
    }

    // Push-then-pull update signalling. /content/state.json is the tiny current
    // state (latest payload + app versions); /content/subscribe is a long-poll
    // that returns the instant either moves past what the caller already has, so
    // a Mac learns about a new build in ~seconds instead of on a poll timer. The
    // signal only ever triggers a PULL — the payload pull is still ed25519- +
    // hash-verified and the app update is still Sparkle-signed — so this endpoint
    // is safe to serve unsigned.
    if (pathname === "/content/state.json" || pathname === "/content/subscribe") {
      const first = await contentState(env);
      if (pathname === "/content/state.json") {
        return new Response(JSON.stringify(first), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      const q = new URL(request.url).searchParams;
      const cv = parseInt(q.get("cv") || "0", 10) || 0;
      const av = q.get("av") || "";
      const moved = (s) => (s.payloadVersion || 0) > cv || (!!s.appVersion && s.appVersion !== av);
      let s = first;
      const deadline = Date.now() + 20000; // hold ~20s, then let the Mac reconnect
      while (!moved(s) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        s = await contentState(env);
      }
      return new Response(JSON.stringify({ ...s, changed: moved(s) }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }

    // Event pages: /e/<slug> is real (D1-backed); /@<handle> keeps the demo seed
    // so old shared links still render something.
    const evm = pathname.match(EVENT_RE);
    if (evm) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const htmlHeaders = { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" };
      if (!env.DB) return new Response(renderNotFound(), { status: 503, headers: htmlHeaders });
      const slug = evm[1];
      const row = await env.DB.prepare("SELECT * FROM events WHERE slug=?").bind(slug).first();
      if (!row) {
        return new Response(renderNotFound(), { status: 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=30" } });
      }
      const set = await env.DB.prepare(
        "SELECT * FROM event_sets WHERE slug=? AND state='ready' AND audio_key IS NOT NULL ORDER BY published_ms DESC LIMIT 1"
      ).bind(slug).first();
      return new Response(renderEvent(eventFromRow(row, set, slug)), { headers: htmlHeaders });
    }
    if (HANDLE_RE.test(pathname)) {
      return new Response(renderEvent(DEMO), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
    }

    return env.ASSETS.fetch(request);
  },
};
