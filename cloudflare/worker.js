// party.ramine.net
//
// Routes:
//   GET /appcast.xml            -> R2 (Sparkle update feed)
//   GET /partyparty.zip         -> R2 (latest build, for the download button)
//   GET /partyparty-<ver>.zip   -> R2 (immutable, Sparkle enclosures)
//   GET /@<handle>              -> server-rendered DJ page (the "your page" half)
//   GET /*                      -> static landing page (../site assets)
//
// The DJ page is the first slice of the hosted platform. It's server-rendered so a
// shared link carries real content + OG tags. Data is a seed object today; it swaps
// for a DB (D1) + media (R2) + Sign-in-with-Apple ("claim your page") later. The
// Event shape mirrors docs/product-architecture.md. Interactive bits are marked
// coming-soon (this is a live preview, honestly labelled).

const ZIP_RE = /^\/[A-Za-z0-9._-]+\.zip$/;      // single path segment, no traversal
const HANDLE_RE = /^\/@([A-Za-z0-9_.]{1,30})$/; // /@ramine

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// --- seed data (stands in for the DB) ---
const PROFILES = {
  ramine: {
    name: "Ramine", verified: true,
    avatar: "/img/portrait.jpg", banner: "/img/party.jpg",
    bio: "DJ · house & techno · silent rooftop popups you won't get shut down.",
    location: "Paris", followers: "1,204", following: "318",
    socials: { soundcloud: "#", instagram: "#", spotify: "#" },
    events: [
      { title: "Rooftop Sessions", when: "This Saturday · 11pm", where: "Le Toit — Paris", status: "upcoming", cover: "/img/dance.jpg" },
      { title: "Warehouse, NYE", when: "Dec 31 · 10pm", where: "Somewhere east", status: "ended", cover: "/img/crowd.jpg", replay: true },
      { title: "Beach sunset set", when: "Aug 12", where: "Calanques", status: "ended", cover: "/img/hero.jpg", replay: true },
    ],
    wall: ["/img/party.jpg", "/img/dance.jpg", "/img/crowd.jpg", "/img/decks.jpg", "/img/hero.jpg"],
  },
};

const CSS = `
:root{--bg:#fff;--bg2:#f5f5f7;--ink:#1d1d1f;--ink2:#6e6e73;--ink3:#86868b;--line:#d2d2d7;--accent:#ff2d6f;--link:#0066cc;--success:#34c759;--warn:#ff9500;--r:12px;--pill:980px;--sans:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text","Inter","Helvetica Neue",Helvetica,Arial,system-ui,sans-serif}
@font-face{font-family:'Inter';src:url('/fonts/inter.woff2') format('woff2');font-weight:100 900;font-display:swap}
*{box-sizing:border-box}body{margin:0;font-family:var(--sans);color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased;letter-spacing:-.011em;line-height:1.47}
a{color:inherit;text-decoration:none}img{display:block;max-width:100%}
.wrap{max-width:920px;margin:0 auto;padding:0 22px}
nav{height:52px;display:flex;align-items:center;justify-content:space-between;max-width:920px;margin:0 auto;padding:0 22px;border-bottom:1px solid var(--line)}
.brand{font-weight:600;font-size:19px;letter-spacing:-.02em}
.btn{display:inline-flex;align-items:center;gap:8px;font-size:15px;font-weight:600;padding:9px 18px;border-radius:var(--pill);border:1px solid transparent;cursor:pointer;background:var(--accent);color:#fff;transition:filter .15s,border-color .15s}
.btn:hover{filter:brightness(1.04)}
.btn.small{padding:7px 14px;font-size:13px}
.btn.ghost{background:transparent;border-color:var(--line);color:var(--ink)}
.btn.ghost:hover{border-color:var(--accent);filter:none}
.banner{height:260px;background-size:cover;background-position:center;background-color:#111}
@supports(corner-shape:superellipse(2)){.avatar,.ev,.ev .cov,.wall .cell,.wall .add{corner-shape:superellipse(2)}}
.avatar{width:120px;height:120px;border-radius:50%;border:4px solid var(--bg);object-fit:cover;margin-top:-60px;background:#eee;position:relative;z-index:1}
.name{font-size:28px;font-weight:600;letter-spacing:-.02em;display:flex;align-items:center;gap:8px;margin:12px 0 2px}
.verified{color:var(--link);display:inline-flex}
.handle{color:var(--ink2)}
.idrow{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
.bio{margin:10px 0 0;max-width:56ch;color:var(--ink)}
.meta{color:var(--ink2);font-size:14px;margin-top:4px}
.socials{display:flex;gap:14px;margin-top:12px;color:var(--ink2)}
.socials a:hover{color:var(--ink)}.socials svg{width:20px;height:20px}
.stats{display:flex;gap:22px;margin-top:14px;font-size:14px;color:var(--ink2)}
.stats b{color:var(--ink);font-size:16px}
.actions{display:flex;gap:10px;align-items:center;flex-shrink:0}
.claim{font-size:13px;color:var(--link);margin-top:12px;display:inline-block;cursor:pointer}
.preview{display:inline-block;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#a15c00;border:1px solid #ffd9a3;background:#fff8ee;border-radius:var(--pill);padding:4px 11px;margin-top:16px}
section{padding:38px 0}
.hair{height:1px;background:var(--line);border:0;margin:0;max-width:920px;margin-inline:auto}
h2{font-size:22px;font-weight:600;letter-spacing:-.02em;margin:0 0 18px}
.events{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px}
.ev{border:1px solid var(--line);border-radius:var(--r);overflow:hidden;background:var(--bg)}
.ev .cov{height:132px;background-size:cover;background-position:center;position:relative}
.ev .tag{position:absolute;top:10px;left:10px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;border-radius:var(--pill);padding:3px 9px;color:#fff}
.tag.up{background:var(--accent)}.tag.end{background:rgba(0,0,0,.55)}
.ev .evb{padding:15px}
.ev h3{margin:0 0 3px;font-size:16px;font-weight:600}
.ev p{margin:0;color:var(--ink2);font-size:13px}
.ev .eva{margin-top:13px}
.wall{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:8px}
.wall .cell{aspect-ratio:1;border-radius:10px;overflow:hidden;background:var(--bg2);background-size:cover;background-position:center}
.wall .add{aspect-ratio:1;border-radius:10px;border:1px dashed var(--line);display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--ink2);font-size:13px;cursor:pointer;gap:6px;text-align:center;padding:10px}
.wall .add:hover{border-color:var(--accent);color:var(--accent)}
footer{border-top:1px solid var(--line);margin-top:36px;padding:30px 0 60px;color:var(--ink3);font-size:13px}
footer .wrap{display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px}
.toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);background:#1d1d1f;color:#fff;padding:12px 18px;border-radius:var(--pill);font-size:14px;opacity:0;pointer-events:none;transition:.25s;z-index:50}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.unclaimed{max-width:540px;margin:90px auto;text-align:center;padding:0 22px}
.unclaimed h1{font-size:34px;letter-spacing:-.025em;margin:0 0 10px}
.unclaimed .at{color:var(--accent)}
.unclaimed p{color:var(--ink2);font-size:18px;margin:0 0 26px;line-height:1.5}
`;

const SVGDEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<g id="ig"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.5" cy="6.5" r="1.3"/></g>
<g id="sc"><path d="M9.5 17.5H18a3 3 0 0 0 .2-6A5.2 5.2 0 0 0 9.8 8.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M3.2 12v5.5M5.6 10v7.5M8 9v8.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></g>
<g id="sp"><circle cx="12" cy="12" r="10"/><path d="M7 10.2c3-.9 6.6-.5 9.2 1.1M7.6 12.8c2.4-.7 5.4-.4 7.5 1M8.1 15.2c1.9-.5 4-.3 5.6.8" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></g>
<g id="v"><path d="M9 12l2 2 4-4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="1.6"/></g>
</defs></svg>`;

const NAV = `<nav><a class="brand" href="/">🕺 partyparty</a><a class="btn small" href="/partyparty.zip">Get the app</a></nav>`;

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
<meta name="theme-color" content="#ffffff"><meta name="color-scheme" content="light">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🕺</text></svg>">
<link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin>
<style>${CSS}</style></head><body>${SVGDEFS}${NAV}${body}${TOAST_JS}</body></html>`;
}

function renderProfile(handle, p) {
  const soon = "Coming soon — hosted pages are in progress.";
  const social = (id, url) => url ? `<a href="${esc(url)}" data-soon="${soon}" aria-label="${id}"><svg viewBox="0 0 24 24" fill="currentColor"><use href="#${id}"/></svg></a>` : "";
  const events = (p.events || []).map((e) => `
    <div class="ev"><div class="cov" style="background-image:url('${esc(e.cover)}')"><span class="tag ${e.status === "upcoming" ? "up" : "end"}">${e.status === "upcoming" ? "Upcoming" : (e.replay ? "Replay" : "Ended")}</span></div>
      <div class="evb"><h3>${esc(e.title)}</h3><p>${esc(e.when)} · ${esc(e.where)}</p>
      <div class="eva">${e.status === "upcoming"
        ? `<button class="btn small" data-soon="${soon}">Check in</button>`
        : (e.replay ? `<button class="btn small ghost" data-soon="${soon}">▶ Watch replay</button>` : "")}</div></div></div>`).join("");
  const wall = (p.wall || []).map((src) => `<div class="cell" style="background-image:url('${esc(src)}')"></div>`).join("")
    + `<div class="add" data-soon="${soon}"><div style="font-size:22px">＋</div>Add your photos &amp; videos</div>`;

  const body = `
  <div class="banner" style="background-image:url('${esc(p.banner)}')"></div>
  <div class="wrap">
    <img class="avatar" src="${esc(p.avatar)}" alt="${esc(p.name)}">
    <div class="idrow">
      <div>
        <div class="name">${esc(p.name)}${p.verified ? `<span class="verified" title="Verified"><svg width="22" height="22" viewBox="0 0 24 24" fill="none"><use href="#v"/></svg></span>` : ""}</div>
        <div class="handle">@${esc(handle)}${p.location ? ` · ${esc(p.location)}` : ""}</div>
        <p class="bio">${esc(p.bio)}</p>
        <div class="socials">${social("sc", p.socials?.soundcloud)}${social("ig", p.socials?.instagram)}${social("sp", p.socials?.spotify)}</div>
        <div class="stats"><span><b>${esc(p.followers)}</b> followers</span><span><b>${esc(p.following)}</b> following</span></div>
      </div>
      <div class="actions">
        <button class="btn" data-soon="${soon}">＋ Follow</button>
        <button class="btn ghost small" data-soon="${soon}">Share</button>
      </div>
    </div>
    <span class="claim" data-soon="This is where Sign in with Apple will let you claim @${esc(handle)}. Coming soon.">This is your page? Claim it ›</span><br>
    <span class="preview">Preview · the app ships today, hosted pages are in progress</span>
  </div>
  <hr class="hair" style="margin-top:30px">
  <section><div class="wrap"><h2>Events</h2><div class="events">${events}</div></div></section>
  <hr class="hair">
  <section><div class="wrap"><h2>The wall</h2><div class="wall">${wall}</div></div></section>
  <footer><div class="wrap"><span>🕺 partyparty</span><span>A DJ's home for their popups · <a href="/" style="color:var(--link)">what is this?</a></span></div></footer>`;

  return shell({
    title: `${p.name} (@${handle}) · partyparty`,
    desc: p.bio, ogImage: p.banner, body,
  });
}

function renderUnclaimed(handle) {
  const body = `<div class="unclaimed">
    <h1><span class="at">@${esc(handle)}</span> isn't on partyparty yet.</h1>
    <p>Is this you? Claim your page — your bio, socials, events, and a wall where your crowd drops the photos and videos from your sets.</p>
    <a class="btn" href="/partyparty.zip">Get the app to claim it</a>
    <p style="font-size:13px;margin-top:22px">Hosted pages + Sign in with Apple are in progress. <a href="/" style="color:var(--link)">See what partyparty is ›</a></p>
  </div>`;
  return shell({ title: `@${handle} · partyparty`, desc: `Claim @${handle} on partyparty.`, body });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    // Big files from R2 (Sparkle feed + app zips).
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

    // DJ pages: /@handle  (server-rendered so shared links carry content + OG tags).
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

    // Everything else: the static landing page.
    return env.ASSETS.fetch(request);
  },
};
