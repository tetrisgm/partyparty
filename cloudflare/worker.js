// party.ramine.net
//
// Routes:
//   GET /appcast.xml            -> R2 (Sparkle update feed)
//   GET /partyparty.zip         -> R2 (latest build)
//   GET /partyparty-<ver>.zip   -> R2 (immutable, Sparkle enclosures)
//   GET /@<handle>              -> server-rendered DJ page (Apple "Snapshot"-style timeline)
//   GET /*                      -> static landing page (../site assets)
//
// The DJ page follows Apple's Snapshot visual language: a tinted rounded profile
// header card floating on light gray, then a stack of white content cards (events,
// the wall, about) with pill CTAs. Server-rendered for real OG tags. Seed data now,
// D1 + R2 media + Sign-in-with-Apple ("claim your page") later. Interactive bits are
// marked coming-soon (honest live preview).

const ZIP_RE = /^\/[A-Za-z0-9._-]+\.zip$/;
const HANDLE_RE = /^\/@([A-Za-z0-9_.]{1,30})$/;

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const PROFILES = {
  ramine: {
    name: "Ramine", verified: true,
    avatar: "/img/portrait.jpg", banner: "/img/party.jpg",
    bio: "House & techno for rooftops, parks and warehouses. Silent popups you won't get shut down.",
    role: "DJ", location: "Paris", since: "2026",
    socials: { soundcloud: "#", instagram: "#", spotify: "#" },
    followers: "1,204", following: "318",
    events: [
      { title: "Rooftop Sessions", when: "This Saturday · 11pm", where: "Le Toit — Paris", status: "upcoming", cover: "/img/dance.jpg" },
      { title: "Warehouse, NYE", when: "Dec 31 · 10pm", where: "Somewhere east", status: "ended", cover: "/img/crowd.jpg", replay: true },
      { title: "Beach sunset set", when: "Aug 12", where: "Calanques", status: "ended", cover: "/img/hero.jpg", replay: true },
    ],
    wall: ["/img/party.jpg", "/img/dance.jpg", "/img/crowd.jpg", "/img/decks.jpg", "/img/hero.jpg", "/img/portrait.jpg"],
  },
};

const CSS = `
:root{--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--ink2:#6e6e73;--ink3:#86868b;--line:#e6e6e9;--hair:rgba(0,0,0,.08);--accent:#ff2d6f;--link:#0066cc;--warn:#ff9500;--good:#34c759;--r:20px;--pill:980px;--sans:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Inter","Helvetica Neue",Helvetica,Arial,system-ui,sans-serif}
@font-face{font-family:'Inter';src:url('/fonts/inter.woff2') format('woff2');font-weight:100 900;font-display:swap}
*{box-sizing:border-box}body{margin:0;font-family:var(--sans);color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased;letter-spacing:-.011em;line-height:1.47}
a{color:inherit;text-decoration:none}img{display:block;max-width:100%}
@supports(corner-shape:superellipse(2)){.hdr,.card,.thumb,.ebig-cov,.ev .cov{corner-shape:superellipse(2)}}
nav{max-width:940px;margin:0 auto;padding:16px 20px;display:flex;align-items:center;justify-content:space-between}
.brand{font-weight:600;font-size:19px;letter-spacing:-.02em}
.btn{display:inline-flex;align-items:center;gap:7px;font-size:14px;font-weight:600;padding:9px 16px;border-radius:var(--pill);border:1px solid transparent;cursor:pointer;background:var(--accent);color:#fff;transition:filter .15s,border-color .15s,background .15s}
.btn:hover{filter:brightness(1.05)}
.btn.ghost{background:rgba(255,255,255,.16);color:#fff;border-color:rgba(255,255,255,.35)}
.btn.ghost:hover{background:rgba(255,255,255,.26);filter:none}
.btn.lt{background:var(--bg);color:var(--ink);border-color:var(--line)}
.btn.lt:hover{border-color:var(--accent);filter:none}
.page{max-width:940px;margin:0 auto;padding:4px 20px 60px}

/* tinted header card (Snapshot) */
.hdr{position:relative;border-radius:26px;overflow:hidden;padding:30px;color:#fff;
  background:radial-gradient(95% 130% at 12% 8%, rgba(255,120,180,.55), rgba(255,120,180,0) 60%),radial-gradient(80% 120% at 95% 20%, rgba(255,154,60,.35), rgba(255,154,60,0) 55%),linear-gradient(135deg,#2e0e28 0%,#6d1a54 55%,#a52c7c 100%)}
.hdr .top{display:flex;gap:24px;align-items:center}
.avatar{width:120px;height:120px;border-radius:50%;object-fit:cover;flex:0 0 auto;box-shadow:0 10px 30px rgba(0,0,0,.3);background:#000}
.hname{font-size:30px;font-weight:700;letter-spacing:-.02em;display:flex;align-items:center;gap:9px;margin:0}
.verified{display:inline-flex;color:#fff}
.hrole{opacity:.85;font-size:15px;margin-top:3px}
.chips{display:flex;gap:8px;margin-top:14px}
.chips a{width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.16);display:inline-flex;align-items:center;justify-content:center;color:#fff;transition:background .15s}
.chips a:hover{background:rgba(255,255,255,.28)}
.chips svg{width:18px;height:18px}
.hbio{margin:16px 0 0;font-size:14.5px;opacity:.92;max-width:62ch;line-height:1.5}
.hstats{display:flex;gap:22px;margin-top:14px;font-size:14px;opacity:.9}
.hstats b{font-weight:700}
.hactions{position:absolute;top:26px;right:26px;display:flex;gap:8px}
.hclaim{margin-top:16px;font-size:13px;opacity:.9}
.hclaim a{text-decoration:underline;cursor:pointer}
.preview{display:inline-block;margin-top:14px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#fff;background:rgba(255,255,255,.16);border-radius:var(--pill);padding:5px 12px}
@media(max-width:640px){.hdr .top{flex-direction:column;text-align:center;align-items:center}.hactions{position:static;justify-content:center;margin-top:16px}.hbio,.hstats{text-align:center;justify-content:center}}

/* content cards */
.card{background:var(--card);border-radius:var(--r);padding:24px;margin-top:16px;box-shadow:0 1px 2px rgba(0,0,0,.04),0 0 0 1px var(--hair)}
.card .h2{display:flex;align-items:center;justify-content:space-between;margin:0 0 16px}
.card h2{font-size:20px;font-weight:600;letter-spacing:-.02em;margin:0}
.seclabel{color:var(--ink2);font-size:13px;font-weight:600;letter-spacing:.02em;margin:0 0 8px}
.ebig{display:flex;gap:20px;align-items:stretch}
.ebig-cov{width:280px;flex:0 0 auto;border-radius:14px;background-size:cover;background-position:center;min-height:170px;position:relative}
.ebig .tag{position:absolute;top:10px;left:10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#fff;background:var(--accent);border-radius:var(--pill);padding:3px 10px}
.ebig .body{display:flex;flex-direction:column;justify-content:center}
.ebig h3{font-size:20px;margin:0 0 4px;font-weight:600}
.ebig p{margin:0;color:var(--ink2);font-size:15px}
.ebig .btn{margin-top:16px;align-self:flex-start}
@media(max-width:640px){.ebig{flex-direction:column}.ebig-cov{width:100%}}
.egrid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
@media(max-width:640px){.egrid{grid-template-columns:1fr 1fr}}
.ev .cov{aspect-ratio:16/10;border-radius:12px;background-size:cover;background-position:center;position:relative}
.ev .rtag{position:absolute;top:8px;left:8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#fff;background:rgba(0,0,0,.55);border-radius:var(--pill);padding:2px 8px}
.ev h4{margin:9px 0 2px;font-size:14px;font-weight:600}
.ev p{margin:0;color:var(--ink2);font-size:12.5px}
.wall{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
@media(max-width:640px){.wall{grid-template-columns:repeat(3,1fr)}}
.wall .thumb{aspect-ratio:1;border-radius:12px;background-size:cover;background-position:center;background-color:var(--bg)}
.wall .add{aspect-ratio:1;border-radius:12px;border:1px dashed var(--line);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--ink2);font-size:12px;text-align:center;padding:8px;cursor:pointer}
.wall .add:hover{border-color:var(--accent);color:var(--accent)}
.about{display:grid;grid-template-columns:1fr 1fr;gap:8px 40px}
@media(max-width:640px){.about{grid-template-columns:1fr}}
.about .r{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);font-size:15px}
.about .r .ic{width:30px;height:30px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;color:#fff;flex:0 0 auto}
.about .meta{color:var(--ink2);font-size:14px;padding:12px 0;border-bottom:1px solid var(--line)}
.about .meta b{color:var(--ink);font-weight:600}
.cardhint{color:var(--ink3);font-size:12px;margin-top:14px}
footer{max-width:940px;margin:0 auto;padding:28px 20px 60px;color:var(--ink3);font-size:13px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px}
.toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);background:#1d1d1f;color:#fff;padding:12px 18px;border-radius:var(--pill);font-size:14px;opacity:0;pointer-events:none;transition:.25s;z-index:50}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.unclaimed{max-width:560px;margin:70px auto;text-align:center;padding:0 22px}
.unclaimed .art{width:96px;height:96px;border-radius:26px;margin:0 auto 22px;background:linear-gradient(135deg,#6d1a54,#a52c7c);display:grid;place-items:center;font-size:44px}
.unclaimed h1{font-size:32px;letter-spacing:-.025em;margin:0 0 10px}
.unclaimed .at{color:var(--accent)}
.unclaimed p{color:var(--ink2);font-size:18px;margin:0 0 26px;line-height:1.5}
`;

const SVGDEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<g id="ig"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.5" cy="6.5" r="1.3"/></g>
<g id="sc"><path d="M9.5 17.5H18a3 3 0 0 0 .2-6A5.2 5.2 0 0 0 9.8 8.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M3.2 12v5.5M5.6 10v7.5M8 9v8.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></g>
<g id="sp"><circle cx="12" cy="12" r="10"/><path d="M7 10.2c3-.9 6.6-.5 9.2 1.1M7.6 12.8c2.4-.7 5.4-.4 7.5 1M8.1 15.2c1.9-.5 4-.3 5.6.8" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></g>
<g id="v"><circle cx="12" cy="12" r="9.4" fill="currentColor"/><path d="M8.5 12.2l2.3 2.3 4.7-4.9" fill="none" stroke="#a52c7c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>
</defs></svg>`;

const NAV = `<nav><a class="brand" href="/">🕺 partyparty</a><a class="btn lt" href="/partyparty.zip">Get the app</a></nav>`;

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
<meta property="og:type" content="profile">${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : ""}
<meta name="theme-color" content="#f5f5f7"><meta name="color-scheme" content="light">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🕺</text></svg>">
<link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin>
<style>${CSS}</style></head><body>${SVGDEFS}${NAV}${body}${TOAST_JS}</body></html>`;
}

function renderProfile(handle, p) {
  const soon = "Coming soon — hosted pages are in progress.";
  const claimMsg = `This is where Sign in with Apple will let you claim @${esc(handle)}. Coming soon.`;
  const social = (id, url) => url ? `<a href="${esc(url)}" data-soon="${soon}" aria-label="${id}"><svg viewBox="0 0 24 24" fill="currentColor"><use href="#${id}"/></svg></a>` : "";

  const upcoming = (p.events || []).find((e) => e.status === "upcoming");
  const past = (p.events || []).filter((e) => e.status !== "upcoming");

  const nextCard = upcoming ? `
  <div class="card">
    <div class="seclabel">Next up</div>
    <div class="ebig">
      <div class="ebig-cov" style="background-image:url('${esc(upcoming.cover)}')"><span class="tag">Upcoming</span></div>
      <div class="body">
        <h3>${esc(upcoming.title)}</h3>
        <p>${esc(upcoming.when)} · ${esc(upcoming.where)}</p>
        <button class="btn" data-soon="${soon}">Check in &amp; share your photos</button>
      </div>
    </div>
  </div>` : "";

  const pastCard = past.length ? `
  <div class="card">
    <div class="h2"><h2>Past sets</h2></div>
    <div class="egrid">${past.map((e) => `
      <div class="ev"><div class="cov" style="background-image:url('${esc(e.cover)}')">${e.replay ? `<span class="rtag">Replay</span>` : ""}</div>
        <h4>${esc(e.title)}</h4><p>${esc(e.when)}</p></div>`).join("")}</div>
    <div class="cardhint">Replays auto-save to each event page when you stop the stream — coming soon.</div>
  </div>` : "";

  const wallCard = `
  <div class="card">
    <div class="h2"><h2>The wall</h2></div>
    <div class="wall">
      ${(p.wall || []).map((s) => `<div class="thumb" style="background-image:url('${esc(s)}')"></div>`).join("")}
      <div class="add" data-soon="${soon}"><div style="font-size:22px">＋</div>Add yours</div>
    </div>
    <div class="cardhint">Photos, videos and comments from everyone at the set — you approve what shows. Coming soon.</div>
  </div>`;

  const aboutCard = `
  <div class="card">
    <div class="h2"><h2>About</h2></div>
    <div class="about">
      <div class="meta">${esc(p.bio)}</div>
      <div>
        <div class="r"><span class="ic" style="background:#ff7700"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><use href="#sc"/></svg></span> SoundCloud</div>
        <div class="r"><span class="ic" style="background:#c13584"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><use href="#ig"/></svg></span> Instagram</div>
        <div class="r"><span class="ic" style="background:#1db954"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><use href="#sp"/></svg></span> Spotify</div>
      </div>
    </div>
  </div>`;

  const body = `<div class="page">
    <div class="hdr">
      <div class="hactions">
        <button class="btn ghost" data-soon="${soon}">＋ Follow</button>
        <button class="btn ghost" data-soon="${soon}">Share</button>
      </div>
      <div class="top">
        <img class="avatar" src="${esc(p.avatar)}" alt="${esc(p.name)}">
        <div>
          <h1 class="hname">${esc(p.name)}${p.verified ? `<span class="verified" title="Verified"><svg width="22" height="22" viewBox="0 0 24 24"><use href="#v"/></svg></span>` : ""}</h1>
          <div class="hrole">${esc(p.role)}${p.location ? ` · ${esc(p.location)}` : ""}</div>
          <div class="chips">${social("sc", p.socials?.soundcloud)}${social("ig", p.socials?.instagram)}${social("sp", p.socials?.spotify)}</div>
          <div class="hstats"><span><b>${esc(p.followers)}</b> followers</span><span><b>${esc(p.following)}</b> following</span></div>
        </div>
      </div>
      <p class="hbio">${esc(p.bio)}</p>
      <div class="hclaim"><a data-soon="${claimMsg}">This is your page? Claim it ›</a></div>
      <span class="preview">Preview · app ships today, pages in progress</span>
    </div>
    ${nextCard}${pastCard}${wallCard}${aboutCard}
  </div>
  <footer><span>🕺 partyparty</span><span>A DJ's home for their popups · <a href="/" style="color:var(--link)">what is this?</a></span></footer>`;

  return shell({ title: `${p.name} (@${handle}) · partyparty`, desc: p.bio, ogImage: p.banner, body });
}

function renderUnclaimed(handle) {
  const body = `<div class="unclaimed">
    <div class="art">🕺</div>
    <h1><span class="at">@${esc(handle)}</span> isn't on partyparty yet.</h1>
    <p>Is this you? Claim your page — your bio, socials, events, and a wall where your crowd drops the photos and videos from your sets.</p>
    <a class="btn" style="padding:13px 24px;font-size:16px" href="/partyparty.zip">Get the app to claim it</a>
    <p style="font-size:13px;margin-top:22px">Hosted pages + Sign in with Apple are in progress. <a href="/" style="color:var(--link)">See what partyparty is ›</a></p>
  </div>`;
  return shell({ title: `@${handle} · partyparty`, desc: `Claim @${handle} on partyparty.`, body });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

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
        headers.set("content-type", "application/zip");
        headers.set("content-disposition", `attachment; filename="${key}"`);
        headers.set("cache-control", key === "partyparty.zip" ? "public, max-age=300" : "public, max-age=86400, immutable");
      }
      return new Response(request.method === "HEAD" ? null : obj.body, { headers });
    }

    const m = pathname.match(HANDLE_RE);
    if (m) {
      const handle = m[1].toLowerCase();
      const p = PROFILES[handle];
      const html = p ? renderProfile(handle, p) : renderUnclaimed(handle);
      return new Response(html, {
        status: p ? 200 : 404,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
