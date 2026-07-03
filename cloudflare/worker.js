// party.ramine.net
//
// Routes:
//   GET /appcast.xml            -> R2 (Sparkle update feed)
//   GET /partyparty.zip         -> R2 (latest build)
//   GET /partyparty-<ver>.zip   -> R2 (immutable, Sparkle enclosures)
//   GET /e/<slug>               -> server-rendered EVENT page (gathers the night)
//   GET /@<handle>              -> server-rendered DJ PROFILE page
//   GET /demo                   -> demo event
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
const RSVP_RE = /^\/api\/e\/([A-Za-z0-9_.-]{1,48})\/rsvp$/;
const HANDLE_RE = /^\/@([A-Za-z0-9_.]{1,30})$/;
const POST_MEDIA_RE = /^\/event\/([A-Za-z0-9_.-]{1,48})\/media\/([A-Za-z0-9_-]{1,64})$/;
// Published set media (audio + waveform) and event cover, served range-aware
// from R2 under event/<slug>/. File shapes are pinned so a slug can only reach
// its own set/cover objects.
const MEDIA_RE = /^\/event\/([A-Za-z0-9_.-]{1,48})\/([a-f0-9]{1,32}\.m4a|[a-f0-9]{1,32}\.peaks\.json|cover\.jpg)$/;
const SLUG_RE = /^[A-Za-z0-9_.-]{1,48}$/;
const SETID_RE = /^[a-f0-9]{1,32}$/;
const POST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const POST_MEDIA_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// OTA content: the signed manifest (pointer, short cache) and immutable,
// versioned payload bundles. Served from R2 under the content/ prefix.
const CONTENT_RE = /^\/content\/(manifest\.json|payload-\d+\.tar\.gz)$/;
const SITE_ORIGIN = "https://party.ramine.net";
const DEFAULT_OG_IMAGE = "/img/og-default.jpg";
const SESSION_COOKIE = "pp_session";
const POST_MEDIA_MIME = {
  image: ["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic"],
  video: ["video/mp4", "video/quicktime", "video/webm"],
  audio: ["audio/mpeg", "audio/mp4", "audio/aac", "audio/wav"],
};
const MAX_IMPORT_FUTURE_MS = 24 * 60 * 60 * 1000;
const MAX_POSTS_PER_IMPORT = 200;
const MAX_COMMENTS_PER_IMPORT = 2000;
const WALL_MEDIA_LIMIT = 240;
const WALL_COMMENTS_PER_POST = 50;
const READ_JSON_TOO_LARGE = new WeakSet();
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const MAGIC_LINK_RATE_WINDOW_MS = 15 * 60 * 1000;
const MAGIC_LINK_IP_CAP = 5;
const MAGIC_LINK_EMAIL_CAP = 3;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_CLEANUP_GRACE_MS = 24 * 60 * 60 * 1000;

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);
const randHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
const absUrl = (s) => {
  try { return new URL(s || "/", SITE_ORIGIN).href; }
  catch (_) { return SITE_ORIGIN + "/"; }
};

function normalizeEmail(s) {
  const email = String(s == null ? "" : s).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320 ? email : "";
}

function safeRedirectPath(s) {
  const path = String(s || "/").trim() || "/";
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return "/";
  try {
    const u = new URL(path, SITE_ORIGIN);
    return u.origin === SITE_ORIGIN ? `${u.pathname}${u.search}${u.hash}` : "/";
  } catch (_) {
    return "/";
  }
}

function allowedPostMime(mediaType, mime) {
  const allowed = POST_MEDIA_MIME[mediaType] || [];
  const raw = String(mime || "").trim().toLowerCase();
  if (!raw) return allowed[0] || "";
  return allowed.includes(raw) ? raw : "";
}

function clampImportTs(value, now = nowMs()) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, now + MAX_IMPORT_FUTURE_MS);
}

function safeIso(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0 || n > 8640000000000000) return "";
  try {
    return new Date(n).toISOString();
  } catch (_) {
    return "";
  }
}

function safeExternalUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(String(url));
    return (u.protocol === "http:" || u.protocol === "https:") ? u.href : "";
  } catch (_) {
    return "";
  }
}

export function parseCookies(request) {
  const out = {};
  const header = request?.headers?.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name) continue;
    const raw = part.slice(i + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch (_) {
      out[name] = raw;
    }
  }
  return out;
}

export function cookieHeader(name, value, opts = {}) {
  const cookieName = String(name || "").replace(/[\r\n;=]/g, "");
  if (!cookieName) return "";
  const o = opts || {};
  const parts = [`${cookieName}=${encodeURIComponent(String(value == null ? "" : value))}`];
  const maxAge = Number(o.maxAge);
  if (Number.isFinite(maxAge)) parts.push(`Max-Age=${Math.trunc(maxAge)}`);
  parts.push(`Path=${String(o.path || "/").replace(/[\r\n;]/g, "") || "/"}`);
  if (o.httpOnly !== false) parts.push("HttpOnly");
  if (o.secure !== false) parts.push("Secure");
  parts.push(`SameSite=${String(o.sameSite || "Lax").replace(/[\r\n;]/g, "") || "Lax"}`);
  return parts.join("; ");
}

export function normalizeHandle(s) {
  const raw = String(s == null ? "" : s).trim().toLowerCase();
  let out = "", lastSep = false;
  for (const ch of raw) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === ".") {
      out += ch;
      lastSep = false;
    } else if (out && !lastSep) {
      out += ".";
      lastSep = true;
    }
  }
  out = out.replace(/^[._]+|[._]+$/g, "");
  if (out.length > 30) out = out.slice(0, 30).replace(/[._]+$/g, "");
  return /^[a-z0-9_.]{1,30}$/.test(out) ? out : "";
}

export async function readJson(request, maxBytes = 16384) {
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
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) {
          await reader.cancel().catch(() => {});
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

export async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(String(str == null ? "" : str));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getEventBySlug(env, slug) {
  if (!env?.DB || !SLUG_RE.test(String(slug || ""))) return null;
  return await env.DB.prepare("SELECT * FROM events WHERE slug=?").bind(slug).first();
}

export async function getProfileByHandle(env, handle) {
  const h = normalizeHandle(handle);
  if (!env?.DB || !h) return null;
  return await env.DB.prepare("SELECT * FROM dj_profiles WHERE handle=? AND published=1 LIMIT 1").bind(h).first();
}

export async function getLatestReadySet(env, slug) {
  if (!env?.DB || !SLUG_RE.test(String(slug || ""))) return null;
  return await env.DB.prepare(
    "SELECT * FROM event_sets WHERE slug=? AND state='ready' AND audio_key IS NOT NULL ORDER BY published_ms DESC LIMIT 1"
  ).bind(slug).first();
}

export async function getApprovedPosts(env, slug, limit) {
  if (!env?.DB || !SLUG_RE.test(String(slug || ""))) return [];
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  const rows = await env.DB.prepare(
    "SELECT * FROM posts WHERE slug=? AND approved=1 AND deleted_ms IS NULL ORDER BY activity_ms DESC LIMIT ?"
  ).bind(slug, n).all();
  return rows?.results || [];
}

export async function getPostMedia(env, postIds) {
  if (!env?.DB || !Array.isArray(postIds)) return [];
  const ids = postIds.map((id) => String(id || "")).filter(Boolean).slice(0, 100);
  if (!ids.length) return [];
  const rows = await env.DB.prepare(
    "SELECT * FROM post_media WHERE post_id IN (SELECT value FROM json_each(?)) ORDER BY post_id, sort_order LIMIT ?"
  ).bind(JSON.stringify(ids), WALL_MEDIA_LIMIT).all();
  return rows?.results || [];
}

export async function getPostComments(env, postIds) {
  if (!env?.DB || !Array.isArray(postIds)) return [];
  const ids = postIds.map((id) => String(id || "")).filter(Boolean).slice(0, 100);
  if (!ids.length) return [];
  const batches = await Promise.all(ids.map((id) => env.DB.prepare(
    "SELECT * FROM post_comments WHERE post_id=? AND approved=1 AND deleted_ms IS NULL ORDER BY ts_ms LIMIT ?"
  ).bind(id, WALL_COMMENTS_PER_POST).all()));
  return batches.flatMap((rows) => rows?.results || []);
}

export async function getSessionUser(env, request) {
  if (!env?.DB) return null;
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE] || "";
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  return await env.DB.prepare(
    `SELECT u.*
     FROM auth_sessions s
     JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=? AND s.expires_ms>? AND s.revoked_ms IS NULL AND u.disabled_ms IS NULL
     LIMIT 1`
  ).bind(tokenHash, nowMs()).first();
}

export function nowMs() {
  return Date.now();
}

async function bumpDjProfileActivity(env, profileId, activityMs = nowMs()) {
  if (!env?.DB || !profileId) return;
  try {
    await env.DB.prepare(
      "UPDATE dj_profiles SET last_activity_ms=? WHERE id=?"
    ).bind(activityMs, profileId).run();
  } catch (_) {
    // Best-effort freshness; never fail the broker write on profile denormalization.
  }
}

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
.wall.posts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.wallpost{min-width:0}
.wallpost .who{display:flex;gap:8px;align-items:baseline;color:var(--ink2);font-size:13px;margin-bottom:8px}
.wallpost .who b{color:var(--ink);font-weight:600}.wallpost .who time{margin-left:auto;color:var(--ink3);white-space:nowrap}
.walltext{font-size:15px;line-height:1.5;margin:0 0 12px;white-space:pre-wrap;overflow-wrap:anywhere}
.wallmedia{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px}
.wallmedia img,.wallmedia video{width:100%;max-width:100%;border-radius:12px;background:var(--bg);object-fit:cover}.wallmedia img{aspect-ratio:1}.wallmedia video{aspect-ratio:16/10}
.wallmedia audio{grid-column:1/-1;width:100%}
.comments{border-top:1px solid var(--line);margin-top:12px;padding-top:10px;display:grid;gap:7px}
.comment{font-size:13px;color:var(--ink2);line-height:1.4}.comment b{color:var(--ink);font-weight:600}
@media(max-width:640px){.wall.posts{grid-template-columns:1fr}.wallpost .who{flex-wrap:wrap}.wallpost .who time{margin-left:0}}
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
.homehero{padding:52px 0 18px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:end}
.homehero h1{font-size:clamp(38px,7vw,68px);line-height:.98;letter-spacing:-.04em;margin:0 0 14px;max-width:760px}
.homehero p{color:var(--ink2);font-size:19px;line-height:1.42;margin:0;max-width:620px}
.homehero .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:24px}
.sectionhead{display:flex;justify-content:space-between;align-items:end;gap:18px;margin:30px 0 10px}
.sectionhead h2{font-size:24px;letter-spacing:-.025em;margin:0}.sectionhead p{color:var(--ink2);font-size:14px;margin:4px 0 0}
.eventgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.eventcard{display:grid;grid-template-columns:112px minmax(0,1fr);gap:16px;align-items:center}
.eventcard .cov{aspect-ratio:1.25;border-radius:16px;background-size:cover;background-position:center;background-color:var(--bg)}
.eventcard h3,.djcard h3{font-size:17px;line-height:1.18;margin:0 0 6px;letter-spacing:-.01em}
.eventcard .meta,.djcard p{color:var(--ink2);font-size:13px;line-height:1.35;margin:0}
.eventcard .statuspill{background:var(--bg);backdrop-filter:none;border-color:var(--line);color:var(--ink2);font-size:11px;gap:6px;padding:4px 9px;margin-bottom:9px}
.eventcard .statuspill .dot{width:7px;height:7px;box-shadow:none;animation:none}
.eventcard .statuspill.live{background:rgba(255,59,92,.1);border-color:rgba(255,59,92,.18);color:var(--live)}
.eventcard .statuspill.upcoming{background:rgba(52,199,89,.1);border-color:rgba(52,199,89,.18);color:var(--good)}
.eventcard .statuspill.replay{background:rgba(255,45,111,.08);border-color:rgba(255,45,111,.16);color:var(--accent)}
.djstrip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.djcard .av{width:58px;height:58px;border-radius:18px;background:linear-gradient(135deg,#ff2d6f,#ff9500);background-size:cover;background-position:center;margin-bottom:14px}
.profilehdr{min-height:380px}.profileav{width:92px;height:92px;border-radius:26px;background:linear-gradient(135deg,#ff2d6f,#ff9500);background-size:cover;background-position:center;border:2px solid rgba(255,255,255,.7);box-shadow:0 12px 34px rgba(0,0,0,.26);margin-bottom:14px}
.profilebio{max-width:64ch;margin:12px 0 0;font-size:15px;line-height:1.55;opacity:.94}.profilehdr .slist{margin-top:16px}
.emptyline{color:var(--ink2);font-size:14px;margin:0}.postlist{display:grid;gap:12px}.postitem{border-top:1px solid var(--line);padding-top:12px}
.postitem:first-child{border-top:0;padding-top:0}.postitem p{font-size:15px;line-height:1.45;margin:0 0 6px}.postitem a{color:var(--link);font-size:13px}
.emptyhome{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,.55fr);gap:16px;align-items:stretch}
.emptyhome .big{font-size:22px;font-weight:600;letter-spacing:-.02em;margin:0 0 8px}.emptyhome p{color:var(--ink2);margin:0 0 18px}
.rsvp{display:grid;gap:14px}.rsvphead{display:flex;justify-content:space-between;gap:16px;align-items:start}.rsvphead .sub{margin-bottom:0}.rsvpcounts{display:flex;gap:14px;align-items:center;color:var(--ink2);font-size:12px;white-space:nowrap}.rsvpcounts b{display:block;color:var(--ink);font-size:22px;line-height:1}.rsvprow{display:flex;gap:10px;flex-wrap:wrap}.rsvp .btn.active{background:var(--accent);color:#fff;border-color:transparent}.rsvpfields{display:grid;grid-template-columns:minmax(0,1fr) 78px;gap:10px}.rsvpfields input{width:100%;border:1px solid var(--line);border-radius:12px;padding:10px 12px;font:inherit;font-size:14px;background:#fff;color:var(--ink)}.rsvpfields input:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px rgba(255,45,111,.12)}
@media(max-width:760px){.homehero{grid-template-columns:1fr;padding-top:26px}.eventgrid,.djstrip,.emptyhome{grid-template-columns:1fr}.eventcard{grid-template-columns:92px minmax(0,1fr)}}
@media(max-width:560px){.rsvphead{display:grid}.rsvpcounts{justify-content:space-between}.rsvpfields{grid-template-columns:1fr 70px}}
`;

const SVGDEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<g id="ig"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.5" cy="6.5" r="1.3"/></g>
<g id="sc"><path d="M9.5 17.5H18a3 3 0 0 0 .2-6A5.2 5.2 0 0 0 9.8 8.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M3.2 12v5.5M5.6 10v7.5M8 9v8.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></g>
<g id="sp"><circle cx="12" cy="12" r="10"/><path d="M7 10.2c3-.9 6.6-.5 9.2 1.1M7.6 12.8c2.4-.7 5.4-.4 7.5 1M8.1 15.2c1.9-.5 4-.3 5.6.8" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></g>
<g id="web"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 12h17M12 3.2c2.2 2.4 3.3 5.3 3.3 8.8s-1.1 6.4-3.3 8.8M12 3.2C9.8 5.6 8.7 8.5 8.7 12s1.1 6.4 3.3 8.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></g>
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

function fmtWhen(ms) {
  const n = Number(ms) || 0;
  if (!n) return "Date TBA";
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(n));
  } catch (_) {
    return "Date TBA";
  }
}

function social(id, url, bg, label = id, soon = "") {
  const href = safeExternalUrl(url);
  if (!href) return "";
  const attrs = soon ? ` data-soon="${esc(soon)}"` : ` target="_blank" rel="noopener noreferrer"`;
  return `<a href="${esc(href)}"${attrs} style="background:${bg}" aria-label="${esc(label)}"><svg viewBox="0 0 24 24" fill="currentColor"><use href="#${esc(id)}"/></svg></a>`;
}

async function getHomeEvents(env) {
  if (!env?.DB) return [];
  const rows = await env.DB.prepare(
    `SELECT e.*, p.handle AS dj_handle, p.display_name AS dj_display_name
     FROM events e
     LEFT JOIN dj_profiles p ON p.id=e.dj_profile_id AND p.published=1
     WHERE e.visibility=? AND e.status IN (?,?)
     ORDER BY CASE WHEN e.status=? THEN 0 ELSE 1 END, e.scheduled_at_ms ASC, e.slug ASC
     LIMIT ?`
  ).bind("public", "upcoming", "live", "live", 12).all();
  return rows?.results || [];
}

async function getFeaturedProfiles(env) {
  if (!env?.DB) return [];
  const now = nowMs();
  const rows = await env.DB.prepare(
    `SELECT p.*, f.label AS featured_label
     FROM featured_profiles f
     JOIN dj_profiles p ON p.id=f.profile_id
     WHERE p.published=? AND (f.starts_ms IS NULL OR f.starts_ms<=?) AND (f.ends_ms IS NULL OR f.ends_ms>?)
     ORDER BY f.rank ASC, p.last_activity_ms DESC, p.display_name ASC
     LIMIT ?`
  ).bind(1, now, now, 8).all();
  return rows?.results || [];
}

async function getReplayEvents(env) {
  if (!env?.DB) return [];
  const rows = await env.DB.prepare(
    `SELECT e.*, p.handle AS dj_handle, p.display_name AS dj_display_name
     FROM events e
     LEFT JOIN dj_profiles p ON p.id=e.dj_profile_id AND p.published=1
     WHERE e.visibility=? AND e.status=?
     ORDER BY COALESCE(e.last_activity_ms, e.published_ms, e.scheduled_at_ms, e.updated_ms, e.created_ms, 0) DESC, e.slug ASC
     LIMIT ?`
  ).bind("public", "replay", 6).all();
  return rows?.results || [];
}

function eventHost(row) {
  return row.dj_display_name || row.host || (row.dj_handle ? "@" + row.dj_handle : "partyparty");
}

function eventCard(row) {
  const slug = String(row.slug || "");
  const cover = row.cover_key ? `/event/${esc(slug)}/cover.jpg` : "/img/dance.jpg";
  const location = row.location_name || row.where_txt || "Location TBA";
  const status = String(row.status || "upcoming");
  const statusPill = status === "live"
    ? `<span class="statuspill live"><span class="dot"></span>Live</span>`
    : status === "replay"
      ? `<span class="statuspill replay">Replay</span>`
      : `<span class="statuspill upcoming">Upcoming</span>`;
  return `<a class="card eventcard" href="/e/${esc(slug)}">
    <div class="cov" style="background-image:url('${cover}')"></div>
    <div>
      ${statusPill}
      <h3>${esc(row.title || "A partyparty popup")}</h3>
      <p class="meta">${esc(eventHost(row))} · ${esc(fmtWhen(row.scheduled_at_ms))}</p>
      <p class="meta">${esc(location)}</p>
    </div>
  </a>`;
}

function profileCard(row) {
  const handle = normalizeHandle(row.handle);
  if (!handle) return "";
  const avatar = row.avatar_key ? `background-image:url('/dj/${esc(handle)}/avatar.jpg')` : "";
  const name = row.display_name || "@" + handle;
  return `<a class="card djcard" href="/@${esc(handle)}">
    <div class="av" style="${avatar}"></div>
    <h3>${esc(name)}</h3>
    <p>@${esc(handle)}</p>
    ${row.bio ? `<p>${esc(clip(row.bio, 110))}</p>` : ""}
  </a>`;
}

async function getProfileUpcomingEvents(env, profileId) {
  if (!env?.DB || !profileId) return [];
  const rows = await env.DB.prepare(
    `SELECT *
     FROM events
     WHERE dj_profile_id=? AND visibility=? AND status IN (?,?)
     ORDER BY CASE WHEN status=? THEN 0 ELSE 1 END, scheduled_at_ms ASC, slug ASC`
  ).bind(profileId, "public", "upcoming", "live", "live").all();
  return rows?.results || [];
}

async function getProfileRecentEvents(env, profileId) {
  if (!env?.DB || !profileId) return [];
  const rows = await env.DB.prepare(
    `SELECT *
     FROM events
     WHERE dj_profile_id=? AND visibility=? AND status=?
     ORDER BY COALESCE(last_activity_ms, published_ms, scheduled_at_ms, updated_ms, created_ms, 0) DESC, slug ASC
     LIMIT ?`
  ).bind(profileId, "public", "replay", 12).all();
  return rows?.results || [];
}

async function getProfilePosts(env, profileId) {
  if (!env?.DB || !profileId) return [];
  const rows = await env.DB.prepare(
    `SELECT p.*, e.title AS event_title
     FROM posts p
     JOIN events e ON e.slug=p.slug
     WHERE e.dj_profile_id=? AND e.visibility=? AND p.approved=? AND p.deleted_ms IS NULL AND p.dj=?
     ORDER BY p.activity_ms DESC
     LIMIT ?`
  ).bind(profileId, "public", 1, 1, 6).all();
  return rows?.results || [];
}

async function profileResponse(env, handle) {
  const h = normalizeHandle(handle);
  const htmlHeaders = { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" };
  if (!env.DB) return new Response(renderNotFound(), { status: 503, headers: htmlHeaders });
  const profile = await getProfileByHandle(env, h);
  if (!profile) {
    return new Response(renderNotFound(), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=30" },
    });
  }
  const [upcoming, recent, posts] = await Promise.all([
    getProfileUpcomingEvents(env, profile.id),
    getProfileRecentEvents(env, profile.id),
    getProfilePosts(env, profile.id),
  ]);
  return new Response(renderProfile({ profile, upcoming, recent, posts }), { headers: htmlHeaders });
}

function profileEventSection(title, sub, rows, empty) {
  return `<section>
    <div class="sectionhead"><div><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ""}</div></div>
    ${rows.length ? `<div class="eventgrid">${rows.map(eventCard).join("")}</div>` : `<div class="card"><p class="emptyline">${esc(empty)}</p></div>`}
  </section>`;
}

function renderProfile({ profile, upcoming, recent, posts }) {
  const handle = normalizeHandle(profile.handle);
  const displayName = profile.display_name || handle;
  const heroStyle = profile.hero_key
    ? `background-image:url('/dj/${esc(handle)}/hero.jpg')`
    : "background:linear-gradient(135deg,#30123f 0%,#a52c7c 48%,#ff9500 100%)";
  const avatarStyle = profile.avatar_key ? `background-image:url('/dj/${esc(handle)}/avatar.jpg')` : "";
  const meta = [profile.location].filter(Boolean).map(esc);
  const socials = [
    social("web", profile.website_url, "#111827", "Website"),
    social("ig", profile.instagram_url, "#c13584", "Instagram"),
    social("sc", profile.soundcloud_url, "#ff7700", "SoundCloud"),
    social("sp", profile.spotify_url, "#1db954", "Spotify"),
  ].join("");
  const postsCard = `<section>
    <div class="sectionhead"><div><h2>Posts</h2><p>Notes from the DJ across their public nights.</p></div></div>
    <div class="card">
      ${posts.length ? `<div class="postlist">${posts.map((p) => `<div class="postitem">
        <p>${p.emoji ? `<span>${esc(p.emoji)}</span> ` : ""}${esc(p.text || "")}</p>
        ${p.slug ? `<a href="/e/${esc(p.slug)}">${esc(p.event_title || p.slug)}</a>` : ""}
      </div>`).join("")}</div>` : `<p class="emptyline">No posts yet.</p>`}
    </div>
  </section>`;
  const body = `<div class="page">
    <div class="hdr profilehdr">
      <div class="cover" style="${heroStyle}"></div>
      <div class="in">
        <div class="profileav" style="${avatarStyle}"></div>
        <h1 class="etitle">${esc(displayName)}</h1>
        <div class="emeta">@${esc(handle)}${meta.length ? " · " + meta.join(" · ") : ""}</div>
        ${profile.bio ? `<p class="profilebio">${esc(profile.bio)}</p>` : ""}
        ${socials ? `<div class="slist">${socials}</div>` : ""}
      </div>
    </div>
    ${profileEventSection("Upcoming", "Public parties coming up next.", upcoming, "No upcoming public events yet.")}
    ${profileEventSection("Recent", "Replay pages from finished sets.", recent, "No public replays yet.")}
    ${postsCard}
  </div>
  <footer><span>🕺 partyparty</span><span>Silent-disco popups on your Mac · <a href="/" style="color:var(--link)">what is this?</a></span></footer>`;
  const ogImage = profile.hero_key ? `/dj/${handle}/hero.jpg` : profile.avatar_key ? `/dj/${handle}/avatar.jpg` : DEFAULT_OG_IMAGE;
  return shell({
    title: `${displayName} (@${handle}) · partyparty`,
    desc: profile.bio || `${displayName} on partyparty.`,
    ogImage,
    url: `/@${handle}`,
    body,
  });
}

function emptyHome() {
  return `<div class="emptyhome">
    <div class="card">
      <p class="big">Throw a silent-disco popup from your Mac.</p>
      <p>partyparty gives each night a shareable page for the set replay, photos, clips and guest posts after the room clears.</p>
      <a class="btn" href="/partyparty.zip">Get the app</a>
    </div>
    <div class="card">
      <h2>Event pages are warming up</h2>
      <p class="sub">Public parties and featured DJs will appear here as hosts publish them.</p>
      <a class="btn lt sm" href="/about">About partyparty</a>
    </div>
  </div>`;
}

function renderHome({ events, profiles, replays }) {
  const hasRows = events.length || profiles.length || replays.length;
  const body = `<div class="page home">
    <section class="homehero">
      <div>
        <h1>silent-disco popups, gathered after the night</h1>
        <p>partyparty turns a Mac into a local silent-disco station, then gives every event a page for the replay and what guests captured.</p>
        <div class="actions"><a class="btn" href="/partyparty.zip">Get the app</a><a class="btn lt" href="/about">About</a></div>
      </div>
    </section>
    ${events.length ? `<section><div class="sectionhead"><div><h2>Upcoming &amp; live</h2><p>Public popups you can follow or revisit after the set.</p></div></div><div class="eventgrid">${events.map(eventCard).join("")}</div></section>` : ""}
    ${profiles.length ? `<section><div class="sectionhead"><div><h2>Featured DJs</h2><p>Hosts shaping the next rooms.</p></div></div><div class="djstrip">${profiles.map(profileCard).join("")}</div></section>` : ""}
    ${replays.length ? `<section><div class="sectionhead"><div><h2>Recent replays</h2><p>Sets that already landed.</p></div></div><div class="eventgrid">${replays.map(eventCard).join("")}</div></section>` : ""}
    ${hasRows ? "" : emptyHome()}
  </div>
  <footer><span>🕺 partyparty</span><span>Silent-disco popups on your Mac</span></footer>`;
  return shell({
    title: "partyparty — silent-disco popups",
    desc: "Mac-powered silent-disco popups with shareable event pages for replays, photos and clips.",
    ogImage: DEFAULT_OG_IMAGE,
    url: "/",
    body,
  });
}

async function homeResponse(env) {
  const [events, profiles, replays] = await Promise.all([
    getHomeEvents(env),
    getFeaturedProfiles(env),
    getReplayEvents(env),
  ]);
  return new Response(renderHome({ events, profiles, replays }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
  });
}

// eventFromRow projects a D1 events row (+ its latest ready set) into the shape
// renderEvent expects. A missing set yields an "upcoming" empty state.
function eventFromRow(row, set, slug, wall = {}) {
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
    wall: Array.isArray(wall) ? wall : [],
    posts: Array.isArray(wall.posts) ? wall.posts : [],
    media: Array.isArray(wall.media) ? wall.media : [],
    comments: Array.isArray(wall.comments) ? wall.comments : [],
    socials: {},
    set: set ? { id: set.id, durationMs: set.duration_ms } : null,
    rsvp_enabled: Number(row.rsvp_enabled) === 1 ? 1 : 0,
  };
}

function fmtPostTime(ms) {
  const n = Number(ms) || 0;
  if (!Number.isFinite(n) || n < 0 || n > 8640000000000000) return "";
  if (!n) return "";
  const delta = Math.max(0, nowMs() - n);
  const min = 60000, hour = 60 * min, day = 24 * hour;
  if (delta < min) return "just now";
  if (delta < hour) return `${Math.floor(delta / min)}m ago`;
  if (delta < day) return `${Math.floor(delta / hour)}h ago`;
  if (delta < 7 * day) return `${Math.floor(delta / day)}d ago`;
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(n));
  } catch (_) {
    return "";
  }
}

function mediaUrl(slug, mediaId) {
  return `/event/${encodeURIComponent(String(slug || ""))}/media/${encodeURIComponent(String(mediaId || ""))}`;
}

function renderWallMedia(slug, media) {
  if (!media?.length) return "";
  const items = media.map((m) => {
    const src = esc(mediaUrl(slug, m.id));
    const name = esc(m.name || "Event media");
    if (m.media_type === "image") {
      return `<img loading="lazy" src="${src}" alt="${name}">`;
    }
    if (m.media_type === "video") {
      return `<video controls preload="none" src="${src}"></video>`;
    }
    if (m.media_type === "audio") {
      return `<audio controls preload="none" src="${src}"></audio>`;
    }
    return "";
  }).filter(Boolean).join("");
  return items ? `<div class="wallmedia">${items}</div>` : "";
}

function renderWallPost(post, slug, media, comments) {
  const who = post.author || (post.dj ? "DJ" : "Guest");
  const timeMs = post.activity_ms || post.created_ms || post.ts_ms;
  const timeText = fmtPostTime(timeMs);
  const datetime = safeIso(timeMs);
  const text = post.text ? `<p class="walltext">${esc(post.text)}</p>` : "";
  const commentHtml = comments.length ? `<div class="comments">${comments.map((c) => `<div class="comment">${c.emoji ? `<span>${esc(c.emoji)}</span> ` : ""}<b>${esc(c.author || (c.dj ? "DJ" : "Guest"))}</b> ${esc(c.text || "")}</div>`).join("")}</div>` : "";
  return `<article class="card wallpost">
    <div class="who">${post.emoji ? `<span>${esc(post.emoji)}</span>` : ""}<b>${esc(who)}</b>${timeText && datetime ? `<time datetime="${esc(datetime)}">${esc(timeText)}</time>` : ""}</div>
    ${text}
    ${renderWallMedia(slug, media)}
    ${commentHtml}
  </article>`;
}

function renderRsvpBlock(e) {
  if (Number(e.rsvp_enabled) !== 1 || !e.slug) return "";
  const endpoint = `/api/e/${encodeURIComponent(String(e.slug))}/rsvp`;
  return `<div class="card rsvp" data-rsvp data-rsvp-api="${esc(endpoint)}">
    <div class="rsvphead">
      <div><h2>RSVP</h2><p class="sub">Let the host know if you can make it.</p></div>
      <div class="rsvpcounts" aria-live="polite">
        <span><b data-rsvp-coming>0</b> coming</span>
        <span><b data-rsvp-not>0</b> can't</span>
      </div>
    </div>
    <div class="rsvprow">
      <button type="button" class="btn lt sm" data-rsvp-choice="coming">I'm coming</button>
      <button type="button" class="btn lt sm" data-rsvp-choice="not">Can't make it</button>
    </div>
    <div class="rsvpfields">
      <input data-rsvp-name maxlength="40" autocomplete="name" placeholder="Name (optional)">
      <input data-rsvp-emoji maxlength="8" inputmode="text" autocomplete="off" placeholder="Emoji">
    </div>
  </div>`;
}

function rsvpScript(enabled) {
  if (!enabled) return "";
  return `<script>
(function(){var root=document.querySelector('[data-rsvp]');if(!root)return;var api=root.getAttribute('data-rsvp-api'),coming=root.querySelector('[data-rsvp-coming]'),not=root.querySelector('[data-rsvp-not]'),name=root.querySelector('[data-rsvp-name]'),emoji=root.querySelector('[data-rsvp-emoji]'),buttons=[].slice.call(root.querySelectorAll('[data-rsvp-choice]'));
function paint(d){if(!d)return;var c=d.counts||{};coming.textContent=String(c.coming||0);not.textContent=String(c.not||0);buttons.forEach(function(b){b.classList.toggle('active',b.getAttribute('data-rsvp-choice')===d.mine||b.getAttribute('data-rsvp-choice')===d.response)})}
fetch(api,{headers:{accept:'application/json'}}).then(function(r){return r.ok?r.json():null}).then(paint).catch(function(){});
buttons.forEach(function(b){b.addEventListener('click',function(){var choice=b.getAttribute('data-rsvp-choice');buttons.forEach(function(x){x.disabled=true});fetch(api,{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({response:choice,name:name&&name.value||'',emoji:emoji&&emoji.value||''})}).then(function(r){return r.ok?r.json():Promise.reject()}).then(function(d){d.mine=d.response;paint(d)}).catch(function(){if(typeof toast==='function')toast('RSVP did not save')}).finally(function(){buttons.forEach(function(x){x.disabled=false})})})});
})();
</script>`;
}

function renderEvent(e) {
  const soon = "Coming soon — event pages are in progress.";
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
    (social("sc", e.socials?.soundcloud, "#ff7700", "SoundCloud", soon) + social("ig", e.socials?.instagram, "#c13584", "Instagram", soon) + social("sp", e.socials?.spotify, "#1db954", "Spotify", soon)
      ? `<div class="slist">${social("sc", e.socials?.soundcloud, "#ff7700", "SoundCloud", soon)}${social("ig", e.socials?.instagram, "#c13584", "Instagram", soon)}${social("sp", e.socials?.spotify, "#1db954", "Spotify", soon)}</div>` : "");
  const aboutCard = aboutInner ? `<div class="card about"><h2>About this set</h2>${aboutInner}</div>` : "";
  const previewBadge = e.set ? "" : `<span class="preview">Preview · event pages in progress</span>`;
  const shareUrl = e.slug ? `${SITE_ORIGIN}/e/${esc(e.slug)}` : "";
  const shareButton = e.slug
    ? `<button class="btn ghost sm" data-share data-share-url="${shareUrl}" data-share-title="${esc(e.title)} · partyparty" data-share-text="${esc(e.tagline || "A partyparty set")}">Share</button>`
    : `<button class="btn ghost sm" data-soon="${soon}">Share</button>`;
  const upcomingCard = !e.set && e.status === "upcoming" ? `
  <div class="card"><p class="sub" style="margin:0">The set replay lands here once ${esc(e.dj || "the DJ")} plays. Check back after the party.</p></div>` : "";
  const rsvpCard = renderRsvpBlock(e);

  const posts = Array.isArray(e.posts) ? e.posts : [];
  const mediaByPost = new Map();
  for (const m of (Array.isArray(e.media) ? e.media : [])) {
    const pid = String(m.post_id || "");
    if (!pid) continue;
    const list = mediaByPost.get(pid) || [];
    list.push(m);
    mediaByPost.set(pid, list);
  }
  const commentsByPost = new Map();
  for (const c of (Array.isArray(e.comments) ? e.comments : [])) {
    const pid = String(c.post_id || "");
    if (!pid) continue;
    const list = commentsByPost.get(pid) || [];
    list.push(c);
    commentsByPost.set(pid, list);
  }
  const wallSection = posts.length ? `
  <section>
    <div class="sectionhead"><div><h2>The wall</h2><p>Everything the room shot tonight — approved by the DJ.</p></div></div>
    <div class="wall posts">
      ${posts.map((p) => renderWallPost(p, e.slug, mediaByPost.get(String(p.id || "")) || [], commentsByPost.get(String(p.id || "")) || [])).join("")}
    </div>
  </section>` : (e.wall || []).length ? `
  <div class="card">
    <h2>The wall</h2>
    <p class="sub">Everything the room shot tonight — you approve what shows.</p>
    <div class="wall">
      ${(e.wall || []).map((s) => `<div class="thumb" style="background-image:url('${esc(s)}')"></div>`).join("")}
      <div class="add" data-soon="${soon}"><div style="font-size:22px">＋</div>Add yours</div>
    </div>
    <div class="cardhint">Guests drop photos, videos and comments straight from their phone — moderated by the DJ. Coming soon.</div>
  </div>` : `
  <div class="card">
    <h2>The wall</h2>
    <p class="sub">No posts yet.</p>
    <div class="cardhint">Guests drop photos, videos and comments straight from their phone — moderated by the DJ.</div>
  </div>`;

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
    ${liveCard}${playerCard}${upcomingCard}${rsvpCard}
    ${wallSection}
    ${aboutCard}
  </div>
  <footer><span>🕺 partyparty</span><span>Silent-disco popups on your Mac · <a href="/" style="color:var(--link)">what is this?</a></span></footer>${waveScript}${rsvpScript(Number(e.rsvp_enabled) === 1)}`;

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

function expiredLinkResponse(status = 400) {
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PartyParty sign-in link expired</title>
<style>
body{margin:0;font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#111;color:#fff;display:grid;min-height:100vh;place-items:center}
main{max-width:420px;padding:32px;text-align:center}
a{color:#9ad7ff}
</style>
</head>
<body><main><h1>That sign-in link expired.</h1><p>Request a new link to continue to PartyParty.</p><p><a href="/">Back to PartyParty</a></p></main></body>
</html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function verifyConfirmResponse(rawToken) {
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to partyparty</title>
<style>
body{margin:0;font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#111;color:#fff;display:grid;min-height:100vh;place-items:center}
main{max-width:420px;padding:32px;text-align:center}
button{border:0;border-radius:8px;background:#fff;color:#111;font:600 16px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:14px 22px;cursor:pointer}
</style>
</head>
<body><main><h1>Sign in to partyparty</h1><form method="POST" action="/auth/verify"><input type="hidden" name="token" value="${esc(rawToken)}"><button type="submit">Continue</button></form></main></body>
</html>`, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function sendViaMXroute(_env, _toEmail, _link) {
  // U13: implement sendViaMXroute (SMTP over cloudflare:sockets)
  throw new Error("mxroute sender not wired (U13)");
}

async function sendAuthEmail(env, toEmail, link, devMode = false) {
  if (devMode) return true;
  if (env.MXROUTE_SMTP_HOST && env.MXROUTE_SMTP_USER && env.MXROUTE_SMTP_PASS) {
    return await sendViaMXroute(env, toEmail, link);
  }
  return false;
}

function authDevMode(request, env) {
  return Boolean(
    env.AUTH_DEV_LINKS === "1" &&
    env.AUTH_DEV_SECRET &&
    request.headers.get("x-auth-dev-secret") === env.AUTH_DEV_SECRET
  );
}

function authLazyCleanup(env, now) {
  if (!env?.DB || Math.random() >= 0.05) return;
  const cutoff = now - AUTH_CLEANUP_GRACE_MS;
  Promise.all([
    env.DB.prepare("DELETE FROM auth_magic_tokens WHERE expires_ms < ? LIMIT 200").bind(cutoff).run(),
    env.DB.prepare("DELETE FROM auth_sessions WHERE expires_ms < ? LIMIT 200").bind(cutoff).run(),
  ]).catch(() => {});
}

async function readVerifyToken(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const body = await readJson(request, 2048);
    return String(body?.token || "");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 2048) return "";
  return String(new URLSearchParams(text).get("token") || "");
}

async function authRequestLink(request, env) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }
  if (!env.DB) return jsonResp(503, { error: "auth db not configured" });
  const body = await readJson(request, 2048);
  if (!body) return READ_JSON_TOO_LARGE.has(request) ? jsonResp(413, { error: "too large" }) : jsonResp(400, { error: "bad json" });
  const emailNorm = normalizeEmail(body.email);
  if (!emailNorm) return jsonResp(400, { error: "bad email" });

  const now = nowMs();
  const since = now - MAGIC_LINK_RATE_WINDOW_MS;
  const ipHash = await sha256Hex(`ip:${request.headers.get("cf-connecting-ip") || ""}`);
  const uaHash = await sha256Hex(request.headers.get("user-agent") || "");
  authLazyCleanup(env, now);
  // Soft, best-effort throttling: the count/insert pair is not atomic until this
  // route gets a Durable Object gate, so the indexes and cleanup bound abuse cost.
  const [ipCountRow, emailCountRow] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM auth_magic_tokens WHERE request_ip_hash=? AND created_ms>=?").bind(ipHash, since).first(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM auth_magic_tokens WHERE email_norm=? AND created_ms>=?").bind(emailNorm, since).first(),
  ]);
  if ((Number(ipCountRow?.n) || 0) >= MAGIC_LINK_IP_CAP || (Number(emailCountRow?.n) || 0) >= MAGIC_LINK_EMAIL_CAP) {
    return jsonResp(429, { error: "rate limited" });
  }

  const rawToken = randHex(32);
  const tokenHash = await sha256Hex(rawToken);
  const redirectPath = safeRedirectPath(body.redirect);
  await env.DB.prepare(
    `INSERT INTO auth_magic_tokens
       (id, token_hash, email_norm, user_id, purpose, redirect_path, created_ms, expires_ms, used_ms, request_ip_hash, user_agent_hash)
     VALUES (?, ?, ?, NULL, 'login', ?, ?, ?, NULL, ?, ?)`
  ).bind(randHex(16), tokenHash, emailNorm, redirectPath, now, now + MAGIC_LINK_TTL_MS, ipHash, uaHash).run();

  const link = `${SITE_ORIGIN}/auth/verify?token=${encodeURIComponent(rawToken)}`;
  const devMode = authDevMode(request, env);
  let queued = true;
  try {
    queued = await sendAuthEmail(env, emailNorm, link, devMode) !== false;
  } catch (_) {
    queued = false;
  }
  const out = { ok: true };
  if (devMode) out.devLink = link;
  else if (!queued) out.queued = false;
  return jsonResp(200, out);
}

async function authVerify(request, env) {
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, POST" } });
  }
  if (!env.DB) return expiredLinkResponse(400);
  const rawToken = request.method === "GET"
    ? String(new URL(request.url).searchParams.get("token") || "")
    : await readVerifyToken(request);
  if (!/^[a-f0-9]{64}$/i.test(rawToken)) return expiredLinkResponse(400);
  const now = nowMs();
  const tokenHash = await sha256Hex(rawToken);
  const row = await env.DB.prepare("SELECT * FROM auth_magic_tokens WHERE token_hash=? LIMIT 1").bind(tokenHash).first();
  if (!row || row.used_ms != null || Number(row.expires_ms) < now) return expiredLinkResponse(400);
  if (request.method === "GET") return verifyConfirmResponse(rawToken);

  const mark = await env.DB.prepare("UPDATE auth_magic_tokens SET used_ms=? WHERE id=? AND used_ms IS NULL").bind(now, row.id).run();
  if ((Number(mark?.meta?.changes) || 0) < 1) return expiredLinkResponse(400);

  const emailNorm = normalizeEmail(row.email_norm);
  if (!emailNorm) return expiredLinkResponse(400);
  const displayName = clip(emailNorm.split("@")[0] || "Guest", 80);
  await env.DB.prepare(
    `INSERT INTO users (id, email, email_norm, display_name, created_ms, updated_ms, email_verified_ms, last_login_ms, disabled_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(email_norm) DO NOTHING`
  ).bind(randHex(16), emailNorm, emailNorm, displayName, now, now, now, now).run();
  let user = await env.DB.prepare("SELECT * FROM users WHERE email_norm=? LIMIT 1").bind(emailNorm).first();
  if (!user?.id) return expiredLinkResponse(400);
  await env.DB.prepare(
    "UPDATE users SET last_login_ms=?, email_verified_ms=COALESCE(email_verified_ms, ?), updated_ms=? WHERE id=?"
  ).bind(now, now, now, user.id).run();
  user = { ...user, last_login_ms: now, email_verified_ms: user.email_verified_ms || now, updated_ms: now };

  const sessionToken = randHex(32);
  const ipHash = await sha256Hex(`ip:${request.headers.get("cf-connecting-ip") || ""}`);
  const uaHash = await sha256Hex(request.headers.get("user-agent") || "");
  await env.DB.prepare(
    `INSERT INTO auth_sessions
       (id, token_hash, user_id, created_ms, expires_ms, last_seen_ms, revoked_ms, request_ip_hash, user_agent_hash)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  ).bind(randHex(16), await sha256Hex(sessionToken), user.id, now, now + SESSION_TTL_MS, now, ipHash, uaHash).run();

  const headers = new Headers({ location: safeRedirectPath(row.redirect_path) });
  headers.append("set-cookie", cookieHeader(SESSION_COOKIE, sessionToken, {
    maxAge: SESSION_TTL_MS / 1000,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  }));
  headers.set("cache-control", "no-store");
  return new Response(null, { status: 302, headers });
}

async function authLogout(request, env) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE] || "";
  if (env.DB && token) {
    await env.DB.prepare("UPDATE auth_sessions SET revoked_ms=? WHERE token_hash=? AND revoked_ms IS NULL")
      .bind(nowMs(), await sha256Hex(token)).run();
  }
  const headers = new Headers({ "content-type": "application/json" });
  headers.append("set-cookie", cookieHeader(SESSION_COOKIE, "", { maxAge: 0, httpOnly: true, secure: true, sameSite: "Lax" }));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function authMe(request, env) {
  const user = await getSessionUser(env, request);
  if (!user) return jsonResp(200, { user: null });
  return jsonResp(200, {
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name,
    },
  });
}

async function rsvpCounts(env, slug) {
  const out = { coming: 0, not: 0 };
  const rows = await env.DB.prepare(
    "SELECT response, COUNT(*) AS n FROM event_rsvps WHERE slug=? GROUP BY response"
  ).bind(slug).all();
  for (const row of (rows?.results || [])) {
    if (row.response === "coming") out.coming = Number(row.n) || 0;
    if (row.response === "not") out.not = Number(row.n) || 0;
  }
  return out;
}

async function rsvpIdentity(env, request, slug, mintAnon) {
  const user = await getSessionUser(env, request);
  if (user?.id) return { userId: String(user.id), anonHash: "", cookieId: "", minted: false };
  const cookies = parseCookies(request);
  let cookieId = cookies.pp_rsvp || "";
  const cookieAnonHash = /^ip\.([a-f0-9]{64})$/.exec(cookieId)?.[1] || "";
  if (cookieId && !cookieAnonHash && !/^[a-f0-9]{32}$/.test(cookieId)) cookieId = "";
  let minted = false;
  let ipAnonHash = "";
  if (!cookieId && mintAnon) {
    ipAnonHash = await sha256Hex(`ip:${request.headers.get("cf-connecting-ip") || ""}:${slug}`);
    cookieId = `ip.${ipAnonHash}`;
    minted = true;
  }
  const anonHash = cookieAnonHash || ipAnonHash || (cookieId ? await sha256Hex(cookieId) : "");
  return {
    userId: "",
    anonHash,
    cookieId,
    minted,
  };
}

async function rsvpMine(env, slug, identity) {
  if (identity.userId) {
    const row = await env.DB.prepare(
      "SELECT response FROM event_rsvps WHERE slug=? AND user_id=? LIMIT 1"
    ).bind(slug, identity.userId).first();
    return row?.response || null;
  }
  if (identity.anonHash) {
    const row = await env.DB.prepare(
      "SELECT response FROM event_rsvps WHERE slug=? AND anon_key_hash=? LIMIT 1"
    ).bind(slug, identity.anonHash).first();
    return row?.response || null;
  }
  return null;
}

async function eventRsvp(request, env, slug) {
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, POST" } });
  }
  if (!env.DB) return jsonResp(503, { error: "events db not configured" });
  const event = await getEventBySlug(env, slug);
  if (!event) return jsonResp(404, { error: "event not found" });
  if (Number(event.rsvp_enabled) !== 1) return jsonResp(403, { error: "rsvp disabled" });

  if (request.method === "GET") {
    const identity = await rsvpIdentity(env, request, slug, false);
    const [counts, mine] = await Promise.all([
      rsvpCounts(env, slug),
      rsvpMine(env, slug, identity),
    ]);
    return jsonResp(200, { counts, mine });
  }

  const body = await readJson(request, 2048);
  const response = String(body?.response || "");
  if (response !== "coming" && response !== "not") return jsonResp(400, { error: "bad response" });
  const identity = await rsvpIdentity(env, request, slug, true);
  const now = nowMs();
  const name = clip(body?.name, 40);
  const emoji = clip(body?.emoji, 8);
  const note = clip(body?.note, 140);
  if (identity.userId) {
    await env.DB.prepare(
      `INSERT INTO event_rsvps (id, slug, user_id, anon_key_hash, name, emoji, response, note, created_ms, updated_ms)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug,user_id) WHERE user_id NOT NULL DO UPDATE SET
         response=excluded.response, name=excluded.name, emoji=excluded.emoji, note=excluded.note, updated_ms=excluded.updated_ms`
    ).bind(randHex(16), slug, identity.userId, name, emoji, response, note, now, now).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO event_rsvps (id, slug, user_id, anon_key_hash, name, emoji, response, note, created_ms, updated_ms)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug,anon_key_hash) WHERE anon_key_hash NOT NULL DO UPDATE SET
         response=excluded.response, name=excluded.name, emoji=excluded.emoji, note=excluded.note, updated_ms=excluded.updated_ms`
    ).bind(randHex(16), slug, identity.anonHash, name, emoji, response, note, now, now).run();
  }

  const counts = await rsvpCounts(env, slug);
  const headers = new Headers({ "content-type": "application/json" });
  if (identity.minted) headers.append("set-cookie", cookieHeader("pp_rsvp", identity.cookieId, { maxAge: 60 * 60 * 24 * 365 }));
  return new Response(JSON.stringify({ ok: true, response, counts }), { status: 200, headers });
}

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

async function publishPostMedia(request, env) {
  if (request.method !== "PUT") return jsonResp(405, { error: "PUT required" });
  if (!env.DB) return jsonResp(503, { error: "events db not configured" });
  const id = request.headers.get("x-pp-id") || "";
  const rec = await authInstall(env, id, request.headers.get("x-pp-secret") || "");
  if (!rec) return jsonResp(403, { error: "bad credentials" });

  const slug = request.headers.get("x-pp-slug") || "";
  const postId = request.headers.get("x-pp-post") || "";
  const mediaId = request.headers.get("x-pp-media") || "";
  const mediaType = request.headers.get("x-pp-media-type") || "";
  if (!SLUG_RE.test(slug) || !POST_ID_RE.test(postId) || !POST_MEDIA_ID_RE.test(mediaId)) {
    return jsonResp(400, { error: "bad slug/post/media" });
  }
  if (mediaType !== "image" && mediaType !== "video" && mediaType !== "audio") {
    return jsonResp(400, { error: "bad media type" });
  }

  const rawMime = request.headers.get("x-pp-mime") || "";
  const mimeType = allowedPostMime(mediaType, rawMime);
  if (!mimeType) {
    return jsonResp(400, { error: "bad mime" });
  }
  const name = request.headers.get("x-pp-name") || "";
  if (name.length > 240 || /[\x00-\x1F\x7F]/.test(name)) return jsonResp(400, { error: "bad name" });
  const sortHeader = request.headers.get("x-pp-sort");
  if (sortHeader != null && !/^-?\d+$/.test(sortHeader)) return jsonResp(400, { error: "bad sort" });
  const sortOrder = sortHeader == null ? 0 : Number(sortHeader);
  if (!Number.isSafeInteger(sortOrder)) return jsonResp(400, { error: "bad sort" });

  const owner = await env.DB.prepare("SELECT install_id FROM events WHERE slug=?").bind(slug).first();
  if (!owner || owner.install_id !== id) return jsonResp(403, { error: "not your event" });
  const post = await env.DB.prepare("SELECT id FROM posts WHERE id=? AND slug=?").bind(postId, slug).first();
  if (!post) return jsonResp(404, { error: "no such post" });
  const existing = await env.DB.prepare("SELECT slug, post_id FROM post_media WHERE id=?").bind(mediaId).first();
  if (existing && (existing.slug !== slug || existing.post_id !== postId)) {
    return jsonResp(403, { error: "media id taken" });
  }

  const cap = 200_000_000;
  const cl = Number(request.headers.get("content-length") || "0");
  if (!cl || cl > cap) return jsonResp(413, { error: "bad size" });
  const key = `event/${slug}/posts/${postId}/${mediaId}`;
  const put = await env.DL.put(key, request.body, { httpMetadata: { contentType: mimeType } });
  const size = (put && typeof put.size === "number") ? put.size : cl;
  if (size > cap) {
    await env.DL.delete(key);
    return jsonResp(413, { error: "too large" });
  }

  const now = nowMs();
  await env.DB.prepare(
    `INSERT INTO post_media (
       id, slug, post_id, media_key, media_type, mime_type, name, size_bytes, sort_order, created_ms
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       media_key=excluded.media_key,
       media_type=excluded.media_type,
       mime_type=excluded.mime_type,
       name=excluded.name,
       size_bytes=excluded.size_bytes,
       sort_order=excluded.sort_order
     WHERE post_media.slug=excluded.slug AND post_media.post_id=excluded.post_id`
  ).bind(mediaId, slug, postId, key, mediaType, mimeType, name, size, sortOrder, now).run();
  const saved = await env.DB.prepare("SELECT slug, post_id FROM post_media WHERE id=?").bind(mediaId).first();
  if (!saved || saved.slug !== slug || saved.post_id !== postId) {
    await env.DL.delete(key);
    return jsonResp(403, { error: "media id taken" });
  }
  await env.DB.prepare("UPDATE events SET last_activity_ms=? WHERE slug=? AND install_id=?").bind(now, slug, id).run();
  await auditPublish(env, id, slug, "publish-post-media");
  return jsonResp(200, { ok: true, key, mediaId });
}

async function publishPosts(env, id, body) {
  if (!env.DB) return jsonResp(503, { error: "events db not configured" });
  const slug = String(body.slug || "");
  if (!SLUG_RE.test(slug)) return jsonResp(400, { error: "bad slug" });
  const posts = Array.isArray(body.posts) ? body.posts : null;
  if (!posts) return jsonResp(400, { error: "bad posts" });
  if (posts.length > MAX_POSTS_PER_IMPORT) return jsonResp(413, { error: "too many posts" });
  let totalComments = 0;
  for (const post of posts) {
    const localId = String(post?.localId || "");
    if (!localId || localId.length > 200) return jsonResp(400, { error: "bad post localId" });
    const comments = Array.isArray(post.comments) ? post.comments : [];
    totalComments += comments.length;
    if (comments.length > 500 || totalComments > MAX_COMMENTS_PER_IMPORT) return jsonResp(413, { error: "too many comments" });
    for (const comment of comments) {
      const commentLocalId = String(comment?.localId || "");
      if (!commentLocalId || commentLocalId.length > 200) return jsonResp(400, { error: "bad comment localId" });
    }
  }

  const owner = await env.DB.prepare("SELECT install_id, dj_profile_id FROM events WHERE slug=?").bind(slug).first();
  if (!owner || owner.install_id !== id) return jsonResp(403, { error: "not owner" });

  const now = nowMs();
  let imported = 0;
  let approvedCount = 0;
  for (const post of posts) {
    const localId = String(post?.localId || "");
    if (!localId || localId.length > 200) return jsonResp(400, { error: "bad post localId" });
    const comments = Array.isArray(post.comments) ? post.comments : [];
    if (comments.length > 500) return jsonResp(413, { error: "too many comments" });

    const postId = (await sha256Hex(`${slug}:${id}:${localId}`)).slice(0, 32);
    const ts = clampImportTs(post.ts, now);
    const deletedMs = post.deleted ? now : null;
    const approved = post.noPublish ? 0 : 1;
    const approvedMs = approved ? now : null;
    let activityMs = ts;
    for (const comment of comments) activityMs = Math.max(activityMs, clampImportTs(comment?.ts, now));

    await env.DB.prepare(
      `INSERT INTO posts (
         id, slug, author, emoji, text, media_key, media_type, approved, ts_ms, created_ms,
         author_cid_hash, source, source_install_id, dj, activity_ms, updated_ms, approved_ms, deleted_ms
       )
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 'mac_sync', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         author=excluded.author,
         emoji=excluded.emoji,
         text=excluded.text,
         approved=excluded.approved,
         ts_ms=excluded.ts_ms,
         author_cid_hash=excluded.author_cid_hash,
         source=excluded.source,
         source_install_id=excluded.source_install_id,
         dj=excluded.dj,
         activity_ms=excluded.activity_ms,
         updated_ms=excluded.updated_ms,
         approved_ms=excluded.approved_ms,
         deleted_ms=excluded.deleted_ms`
    ).bind(
      postId, slug, clip(post.author, 40), clip(post.emoji, 8), clip(post.text, 2000),
      approved, ts, now, post.cidHash ? clip(post.cidHash, 128) : null, id,
      post.dj ? 1 : 0, activityMs, now, approvedMs, deletedMs
    ).run();

    for (const comment of comments) {
      const commentLocalId = String(comment?.localId || "");
      if (!commentLocalId || commentLocalId.length > 200) return jsonResp(400, { error: "bad comment localId" });
      const commentId = (await sha256Hex(`${postId}:${commentLocalId}`)).slice(0, 32);
      const commentTs = clampImportTs(comment.ts, now);
      await env.DB.prepare(
        `INSERT INTO post_comments (
           id, slug, post_id, author, emoji, text, dj, approved, ts_ms, created_ms, updated_ms, deleted_ms
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           author=excluded.author,
           emoji=excluded.emoji,
           text=excluded.text,
           dj=excluded.dj,
           approved=excluded.approved,
           ts_ms=excluded.ts_ms,
           updated_ms=excluded.updated_ms,
           deleted_ms=excluded.deleted_ms`
      ).bind(
        commentId, slug, postId, clip(comment.author, 40), clip(comment.emoji, 8), clip(comment.text, 2000),
        comment.dj ? 1 : 0, approved, commentTs, now, now, deletedMs
      ).run();
    }

    imported += 1;
    if (approved) approvedCount += 1;
  }

  await env.DB.prepare(
    "UPDATE events SET updated_ms=?, last_activity_ms=? WHERE slug=? AND install_id=?"
  ).bind(now, now, slug, id).run();
  await bumpDjProfileActivity(env, owner.dj_profile_id, now);
  return jsonResp(200, { ok: true, slug, imported, approved: approvedCount });
}

function brokerJsonCap(pathname) {
  if (pathname === "/api/broker/publish-posts") return 1_000_000;
  if (pathname === "/api/broker/log") return 8_100_000;
  if (pathname === "/api/broker/telemetry") return 128_000;
  if (pathname === "/api/broker/events-window") return 2_048;
  return 16_384;
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
  if (pathname === "/api/broker/publish-post-media") {
    return await publishPostMedia(request, env);
  }
  if (request.method !== "POST") return jsonResp(405, { error: "POST required" });
  if (!env.CF_DNS_TOKEN || !env.CF_ZONE_ID || !env.BROKER_BASE) return jsonResp(503, { error: "broker not configured" });
  const jsonCap = brokerJsonCap(pathname);
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength && contentLength > jsonCap) return jsonResp(413, { error: "too large" });
  const body = await readJson(request, jsonCap);
  if (!body) return READ_JSON_TOO_LARGE.has(request) ? jsonResp(413, { error: "too large" }) : jsonResp(400, { error: "bad json" });

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

  if (pathname === "/api/broker/publish-posts") {
    return await publishPosts(env, id, body);
  }

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
    const now = nowMs();
    await env.DB.prepare(
      `INSERT INTO events (slug, install_id, title, host, starts, where_txt, tagline, about, status, created_ms, updated_ms, last_activity_ms)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'replay',?9,?9,?9)
       ON CONFLICT(slug) DO UPDATE SET title=?3, host=?4, starts=?5, where_txt=?6, tagline=?7, about=?8, status='replay', updated_ms=?9, last_activity_ms=?9
       WHERE events.install_id=?2`
    ).bind(slug, id, clip(body.title, 200), clip(body.host, 80), clip(body.starts, 120),
      clip(body.where, 120), clip(body.tagline, 200), clip(body.about, 4000), now).run();
    // Re-verify ownership post-upsert (closes any claim race) before minting a set.
    const check = await env.DB.prepare("SELECT install_id, dj_profile_id FROM events WHERE slug=?").bind(slug).first();
    if (!check || check.install_id !== id) return jsonResp(409, { error: "slug taken" });
    await bumpDjProfileActivity(env, check.dj_profile_id, now);
    const setId = randHex(12);
    await env.DB.prepare(
      `INSERT INTO event_sets (id, slug, duration_ms, size_bytes, recorded_ms, published_ms, state)
       VALUES (?,?,?,?,?,?, 'pending')`
    ).bind(setId, slug, Math.max(0, Number(body.duration_ms) || 0),
      Math.max(0, Number(body.size_bytes) || 0), Math.max(0, Number(body.recorded_ms) || 0), now).run();
    await auditPublish(env, id, slug, "publish-meta");
    return jsonResp(200, { ok: true, slug, setId, url: `https://${env.BROKER_BASE}/e/${slug}` });
  }

  if (pathname === "/api/broker/event-upsert") {
    if (!env.DB) return jsonResp(503, { error: "events db not configured" });
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    const slug = String(body.slug || "");
    if (!SLUG_RE.test(slug)) return jsonResp(400, { error: "bad slug" });

    const owner = await env.DB.prepare("SELECT install_id FROM events WHERE slug=?").bind(slug).first();
    if (owner && owner.install_id !== id) return jsonResp(409, { error: "slug taken" });

    const textSpecs = [
      ["title", "title", 200],
      ["host", "host", 80],
      ["starts", "starts", 120],
      ["where", "where_txt", 160],
      ["location_name", "location_name", 200],
      ["location_address", "location_address", 300],
      ["tagline", "tagline", 200],
      ["about", "about", 4000],
      ["timezone", "timezone", 80],
    ];
    const vals = {};
    const updateCols = [];
    for (const [key, col, len] of textSpecs) {
      vals[col] = has(key) ? clip(body[key], len) : "";
      if (has(key)) updateCols.push([col, vals[col]]);
    }

    for (const key of ["scheduled_at_ms", "end_at_ms"]) {
      if (has(key)) {
        const n = Number(body[key]);
        if (!Number.isSafeInteger(n) || n < 0) return jsonResp(400, { error: `bad ${key}` });
        vals[key] = n;
        updateCols.push([key, n]);
      } else {
        vals[key] = null;
      }
    }

    const visibility = has("visibility") ? String(body.visibility || "") : "unlisted";
    if (visibility !== "public" && visibility !== "unlisted") return jsonResp(400, { error: "bad visibility" });
    vals.visibility = visibility;
    if (has("visibility")) updateCols.push(["visibility", visibility]);

    const rsvpEnabled = has("rsvp_enabled") ? Number(body.rsvp_enabled) : 1;
    if (!Number.isInteger(rsvpEnabled) || (rsvpEnabled !== 0 && rsvpEnabled !== 1)) {
      return jsonResp(400, { error: "bad rsvp_enabled" });
    }
    vals.rsvp_enabled = rsvpEnabled;
    if (has("rsvp_enabled")) updateCols.push(["rsvp_enabled", rsvpEnabled]);

    const linked = await env.DB.prepare(
      "SELECT user_id, profile_id FROM device_installs WHERE install_id=? LIMIT 1"
    ).bind(id).first();
    const ownerUserId = linked?.user_id || null;
    const djProfileId = linked?.profile_id || null;
    if (ownerUserId) updateCols.push(["owner_user_id", ownerUserId]);
    if (djProfileId) updateCols.push(["dj_profile_id", djProfileId]);

    const now = nowMs();
    const insertCols = [
      "slug", "install_id", "title", "host", "starts", "tagline", "about", "where_txt",
      "location_name", "location_address", "scheduled_at_ms", "end_at_ms", "timezone",
      "visibility", "rsvp_enabled", "status", "source", "owner_user_id", "dj_profile_id",
      "created_ms", "updated_ms", "last_activity_ms",
    ];
    const insertVals = [
      slug, id, vals.title, vals.host, vals.starts, vals.tagline, vals.about, vals.where_txt,
      vals.location_name, vals.location_address, vals.scheduled_at_ms, vals.end_at_ms, vals.timezone,
      vals.visibility, vals.rsvp_enabled, "upcoming", "install", ownerUserId, djProfileId,
      now, now, now,
    ];
    const updateSet = updateCols.map(([col]) => `${col}=?`).concat(["updated_ms=?", "last_activity_ms=?"]);
    await env.DB.prepare(
      `INSERT INTO events (${insertCols.join(", ")})
       VALUES (${insertCols.map(() => "?").join(", ")})
       ON CONFLICT(slug) DO UPDATE SET ${updateSet.join(", ")}
       WHERE events.install_id=?`
    ).bind(...insertVals, ...updateCols.map(([, value]) => value), now, now, id).run();

    const check = await env.DB.prepare("SELECT install_id, status, dj_profile_id FROM events WHERE slug=?").bind(slug).first();
    if (!check || check.install_id !== id) return jsonResp(409, { error: "slug taken" });
    await bumpDjProfileActivity(env, check.dj_profile_id, now);
    return jsonResp(200, { ok: true, slug, url: `https://party.ramine.net/e/${slug}`, status: check.status || "upcoming" });
  }

  if (pathname === "/api/broker/events-window") {
    if (!env.DB) return jsonResp(503, { error: "events db not configured" });
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
    const maxMs = 8640000000000000;
    let sinceMs;
    let untilMs;
    if (has("since_ms")) {
      sinceMs = Number(body.since_ms);
      if (!Number.isSafeInteger(sinceMs) || sinceMs < 0) return jsonResp(400, { error: "bad since_ms" });
    }
    if (has("until_ms")) {
      untilMs = Number(body.until_ms);
      if (!Number.isSafeInteger(untilMs) || untilMs < 0) return jsonResp(400, { error: "bad until_ms" });
    }
    const serverMs = nowMs();
    if (!has("since_ms") && !has("until_ms")) {
      sinceMs = Math.max(0, serverMs - 7 * 24 * 60 * 60 * 1000);
      untilMs = maxMs;
    } else {
      sinceMs = sinceMs ?? 0;
      untilMs = untilMs ?? maxMs;
    }
    if (sinceMs > untilMs) return jsonResp(400, { error: "bad window" });

    let limit = 50;
    if (has("limit")) {
      limit = Number(body.limit);
      if (!Number.isSafeInteger(limit) || limit < 1) return jsonResp(400, { error: "bad limit" });
    }
    limit = Math.min(100, limit);

    const linked = await env.DB.prepare(
      "SELECT profile_id FROM device_installs WHERE install_id=? LIMIT 1"
    ).bind(id).first();
    const profileId = linked?.profile_id || null;
    const rows = await env.DB.prepare(
      `SELECT
         e.slug, e.title, e.host, e.status, e.visibility, e.scheduled_at_ms, e.end_at_ms,
         e.timezone, e.location_name, e.updated_ms, e.last_activity_ms,
         COALESCE(rs.has_replay, 0) AS has_replay,
         COALESCE(rv.coming, 0) AS rsvp_coming,
         COALESCE(rv.not_count, 0) AS rsvp_not
       FROM events e
       LEFT JOIN (
         SELECT slug, 1 AS has_replay
         FROM event_sets
         WHERE state='ready'
         GROUP BY slug
       ) rs ON rs.slug=e.slug
       LEFT JOIN (
         SELECT slug,
                SUM(CASE WHEN response='coming' THEN 1 ELSE 0 END) AS coming,
                SUM(CASE WHEN response='not' THEN 1 ELSE 0 END) AS not_count
         FROM event_rsvps
         GROUP BY slug
       ) rv ON rv.slug=e.slug
       WHERE (e.install_id=? OR (? IS NOT NULL AND e.dj_profile_id=?))
         AND COALESCE(e.scheduled_at_ms, e.published_ms, e.updated_ms) BETWEEN ? AND ?
       ORDER BY
         CASE WHEN e.status='live' THEN 0 WHEN e.status='upcoming' THEN 1 ELSE 2 END,
         CASE WHEN e.status='upcoming' THEN COALESCE(e.scheduled_at_ms, e.published_ms, e.updated_ms) END ASC,
         CASE WHEN e.status NOT IN ('live', 'upcoming') THEN COALESCE(e.last_activity_ms, e.published_ms, e.updated_ms) END DESC,
         e.slug ASC
       LIMIT ?`
    ).bind(id, profileId, profileId, sinceMs, untilMs, limit).all();
    const events = (rows?.results || []).map((row) => ({
      slug: row.slug,
      title: row.title || "",
      host: row.host || "",
      status: row.status || "upcoming",
      visibility: row.visibility || "unlisted",
      scheduled_at_ms: row.scheduled_at_ms ?? null,
      end_at_ms: row.end_at_ms ?? null,
      timezone: row.timezone || "",
      location_name: row.location_name || "",
      updated_ms: row.updated_ms ?? null,
      last_activity_ms: row.last_activity_ms ?? null,
      url: `https://party.ramine.net/e/${row.slug}`,
      hasReplay: !!row.has_replay,
      rsvp: {
        coming: Number(row.rsvp_coming) || 0,
        not: Number(row.rsvp_not) || 0,
      },
    }));
    return jsonResp(200, { ok: true, events, serverMs });
  }

  if (pathname === "/api/broker/event-status") {
    if (!env.DB) return jsonResp(503, { error: "events db not configured" });
    const slug = String(body.slug || "");
    const status = String(body.status || "");
    if (!SLUG_RE.test(slug)) return jsonResp(400, { error: "bad slug" });
    if (!["upcoming", "live", "ended", "replay"].includes(status)) return jsonResp(400, { error: "bad status" });

    const owner = await env.DB.prepare("SELECT install_id, dj_profile_id FROM events WHERE slug=?").bind(slug).first();
    if (!owner || owner.install_id !== id) return jsonResp(403, { error: "not owner" });

    const now = nowMs();
    if (status === "live") {
      await env.DB.prepare(
        `UPDATE events
         SET status=?, updated_ms=?, last_activity_ms=?, live_started_ms=COALESCE(live_started_ms, ?)
         WHERE slug=? AND install_id=?`
      ).bind(status, now, now, now, slug, id).run();
    } else if (status === "ended" || status === "replay") {
      await env.DB.prepare(
        `UPDATE events
         SET status=?, updated_ms=?, last_activity_ms=?, live_ended_ms=COALESCE(live_ended_ms, ?)
         WHERE slug=? AND install_id=?`
      ).bind(status, now, now, now, slug, id).run();
    } else {
      await env.DB.prepare(
        `UPDATE events
         SET status=?, updated_ms=?, last_activity_ms=?
         WHERE slug=? AND install_id=?`
      ).bind(status, now, now, slug, id).run();
    }
    await bumpDjProfileActivity(env, owner.dj_profile_id, now);
    return jsonResp(200, { ok: true, slug, status });
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

    if (pathname === "/api/auth/request-link") {
      try {
        return await authRequestLink(request, env);
      } catch (_) {
        return jsonResp(500, { error: "auth unavailable" });
      }
    }

    if (pathname === "/auth/verify") {
      try {
        return await authVerify(request, env);
      } catch (_) {
        return expiredLinkResponse(400);
      }
    }

    if (pathname === "/api/auth/logout") {
      try {
        return await authLogout(request, env);
      } catch (_) {
        return jsonResp(200, { ok: true });
      }
    }

    if (pathname === "/api/me") {
      try {
        return await authMe(request, env);
      } catch (_) {
        return jsonResp(200, { user: null });
      }
    }

    if (pathname.startsWith("/api/broker/")) {
      try {
        return await broker(request, env, pathname);
      } catch (e) {
        return jsonResp(500, { error: String((e && e.message) || e) });
      }
    }

    const rsvp = pathname.match(RSVP_RE);
    if (rsvp) {
      try {
        return await eventRsvp(request, env, rsvp[1]);
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

    // Approved guest post media. The D1 join is the privacy gate: media from
    // unapproved/deleted posts or another slug is indistinguishable from missing.
    const postMedia = pathname.match(POST_MEDIA_RE);
    if (postMedia) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const row = await env.DB.prepare(
        `SELECT pm.media_key, pm.mime_type, pm.media_type
         FROM post_media pm
         JOIN posts p ON p.id=pm.post_id
         WHERE pm.id=? AND pm.slug=? AND p.approved=1 AND p.deleted_ms IS NULL`
      ).bind(postMedia[2], postMedia[1]).first();
      if (!row?.media_key) return new Response("Not found", { status: 404 });

      const mediaType = String(row.media_type || "");
      const ctype = allowedPostMime(mediaType, row.mime_type) || allowedPostMime(mediaType, "");
      if (!ctype) return new Response("Not found", { status: 404 });
      const cache = "public, max-age=31536000, immutable";
      const isRangeAware = mediaType === "video" || mediaType === "audio";
      const rangeHdr = isRangeAware ? request.headers.get("range") : null;
      if (rangeHdr) {
        const head = await env.DL.head(row.media_key);
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
          const obj = await env.DL.get(row.media_key, { range: { offset: start, length: end - start + 1 } });
          if (!obj) return new Response("Not found", { status: 404 });
          const h = new Headers();
          h.set("content-type", ctype);
          h.set("accept-ranges", "bytes");
          h.set("content-range", `bytes ${start}-${end}/${size}`);
          h.set("content-length", String(end - start + 1));
          h.set("cache-control", cache);
          h.set("etag", obj.httpEtag);
          h.set("x-content-type-options", "nosniff");
          return new Response(request.method === "HEAD" ? null : obj.body, { status: 206, headers: h });
        }
        // malformed/unsatisfiable range → fall through to whole-object 200
      }
      const obj = await env.DL.get(row.media_key);
      if (!obj) return new Response("Not found", { status: 404 });
      const h = new Headers();
      obj.writeHttpMetadata(h);
      h.set("content-type", ctype);
      h.set("accept-ranges", "bytes");
      h.set("cache-control", cache);
      h.set("etag", obj.httpEtag);
      h.set("x-content-type-options", "nosniff");
      return new Response(request.method === "HEAD" ? null : obj.body, { headers: h });
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

    if (pathname === "/about" || pathname === "/app") {
      const u = new URL(request.url);
      u.pathname = "/";
      return env.ASSETS.fetch(new Request(u, request));
    }

    if (pathname === "/") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      return await homeResponse(env);
    }

    // Event pages: /e/<slug> is real (D1-backed). /demo keeps the original
    // seed page around for smoke tests and examples.
    if (pathname === "/demo") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      return new Response(renderEvent(DEMO), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
    }

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
      const posts = await getApprovedPosts(env, slug, 60);
      const postIds = posts.map((p) => p.id).filter(Boolean);
      const [media, comments] = await Promise.all([
        getPostMedia(env, postIds),
        getPostComments(env, postIds),
      ]);
      return new Response(renderEvent(eventFromRow(row, set, slug, { posts, media, comments })), { headers: htmlHeaders });
    }
    const hm = pathname.match(HANDLE_RE);
    if (hm) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      return await profileResponse(env, hm[1]);
    }

    return env.ASSETS.fetch(request);
  },
};
