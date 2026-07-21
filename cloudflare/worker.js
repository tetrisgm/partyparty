// partyparty.party
//
// Routes:
//   GET /appcast.xml            -> R2 (Sparkle update feed)
//   GET /partyparty.pkg         -> R2 (canonical user download)
//   GET /api/version            -> JSON app version + freshness for download CTAs
//   GET /partyparty.zip         -> R2 (legacy Sparkle update alias)
//   GET /partyparty-<ver>.zip   -> R2 (immutable, Sparkle enclosures)
//   GET /e/<slug>               -> server-rendered EVENT page (gathers the night)
//   GET /@<handle>              -> server-rendered DJ PROFILE page
//   GET /demo                   -> demo event
//   GET /*                      -> static landing page (../site assets)
//
// Scope: partyparty is a Mac app for Wi-Fi silent-disco popups: no speakers, no
// guest app, local Wi-Fi audio. Event keepsakes/replays are coming soon and are
// marked as preview surfaces. NOT a social platform: no follower feed.

const ZIP_RE = /^\/[A-Za-z0-9._-]+\.(zip|pkg|dmg)$/;
const EVENT_RE = /^\/e\/([A-Za-z0-9_.-]{1,48})$/;
const WEB_EVENT_API_RE = /^\/api\/events\/([A-Za-z0-9_.-]{1,48})$/;
const RSVP_RE = /^\/api\/e\/([A-Za-z0-9_.-]{1,48})\/rsvp$/;
const JOIN_RE = /^\/api\/e\/([A-Za-z0-9_.-]{1,48})\/join$/;
const PRESENCE_RE = /^\/api\/e\/([A-Za-z0-9_.-]{1,48})\/presence$/;
const WEBPOST_RE = /^\/api\/e\/([A-Za-z0-9_.-]{1,48})\/post$/;
const HANDLE_RE = /^\/@([A-Za-z0-9_.]{1,30})$/;
const POST_MEDIA_RE = /^\/event\/([A-Za-z0-9_.-]{1,48})\/media\/([A-Za-z0-9_-]{1,64})$/;
// Published set media (audio + waveform) and event cover, served range-aware
// from R2 under event/<slug>/. File shapes are pinned so a slug can only reach
// its own set/cover objects.
const MEDIA_RE = /^\/event\/([A-Za-z0-9_.-]{1,48})\/([a-f0-9]{1,32}\.m4a|[a-f0-9]{1,32}\.peaks\.json|cover\.jpg)$/;
// Cloud HLS live mirror: the ephemeral rolling window served to REMOTE guests
// from R2 under event/<slug>/live/. `<x>.m3u8` is the media playlist (no-store,
// always the live edge); `<x>.ts` are MPEG-TS AAC segments (CDN-cacheable).
const LIVE_MEDIA_RE = /^\/event\/([A-Za-z0-9_.-]{1,48})\/live\/([A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.(?:m3u8|ts))$/;
// The x-pp-file a Mac may write into event/<slug>/live/ — segment or playlist only.
const LIVE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}\.(?:ts|m3u8)$/;
// Live presence TTL: a heartbeat lands every ~30s, so 90s rides out one dropped
// beat without the party flickering; a crashed Mac is gone within ~1.5 min.
const LIVE_PRESENCE_TTL_MS = 90_000;
const SLUG_RE = /^[A-Za-z0-9_.-]{1,48}$/;
const SETID_RE = /^[a-f0-9]{1,32}$/;
const POST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const POST_MEDIA_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// OTA content: the signed manifest (pointer, short cache) and immutable,
// versioned payload bundles. Served from R2 under the content/ prefix.
const CONTENT_RE = /^\/content\/(manifest\.json|payload-\d+\.tar\.gz)$/;
const SITE_ORIGIN = "https://partyparty.party";
const DEFAULT_OG_IMAGE = "/img/og-default.jpg";
// Fallback only — /api/version reads the live content/app-version R2 marker at
// runtime (release.sh keeps it current). Keep this ~current so the fallback path
// is never badly stale.
const APP_VERSION = "80.78";
const APP_VERSION_DATE = "2026-07-20";
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
const POST_MEDIA_CAP_BYTES = 350_000_000;
const POST_MEDIA_MULTIPART_MIN_PART_BYTES = 5_000_000;
const POST_MEDIA_MULTIPART_MAX_PART_BYTES = 16_000_000;
const READ_JSON_TOO_LARGE = new WeakSet();
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const MAGIC_LINK_RATE_WINDOW_MS = 15 * 60 * 1000;
const MAGIC_LINK_IP_CAP = 5;
const MAGIC_LINK_EMAIL_CAP = 3;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_CLEANUP_GRACE_MS = 24 * 60 * 60 * 1000;
const INSTALL_LINK_TTL_MS = 10 * 60 * 1000;
const INSTALL_LINK_USER_CAP = 5;
const INSTALL_LINK_CLEANUP_GRACE_MS = 60 * 60 * 1000;
const INSTALL_LINK_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const INSTALL_LINK_ATTEMPT_CAP = 10;
const INSTALL_BROWSER_LINK_TTL_MS = 10 * 60 * 1000;
const INSTALL_BROWSER_LINK_INSTALL_CAP = 5;

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);
// Strip C0/C1 controls and Unicode bidi/direction overrides (U+202A-E,
// U+2066-69, LRM/RLM) from guest-authored text: a bidi override in a "name"
// can visually reorder everything rendered after it on the wall.
const stripControl = (s) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
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

function slugifyTitle(s) {
  const raw = String(s == null ? "" : s).trim().toLowerCase();
  let out = "", lastSep = false;
  for (const ch of raw) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      out += ch;
      lastSep = false;
    } else if (out && !lastSep) {
      out += "-";
      lastSep = true;
    }
  }
  out = out.replace(/^-+|-+$/g, "");
  return out.slice(0, 48).replace(/-+$/g, "") || "event";
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

// Handles that would shadow a top-level route or the product's own words. A
// handle can never equal one of these — checked at mint, at /welcome, in
// /settings, and by /api/handle-available.
export const RESERVED_HANDLES = new Set([
  "account", "login", "logout", "welcome", "settings", "signup", "signin",
  "api", "e", "live", "discover", "broker", "www", "admin", "root", "mail", "m",
  "about", "help", "support", "terms", "privacy", "profile", "profiles",
  "edit", "new", "event", "events", "me", "home", "app", "assets", "static",
  "favicon", "robots", "sitemap", "auth", "partyparty", "party",
]);
export function handleReserved(h) {
  const n = normalizeHandle(h);
  return !n || RESERVED_HANDLES.has(n);
}

// Single source of truth for "is this handle free to claim": valid, not
// reserved, not an existing profile handle, and not a retired alias.
export async function handleAvailable(env, h) {
  const n = normalizeHandle(h);
  if (!n || RESERVED_HANDLES.has(n)) return false;
  if (!env?.DB) return false;
  const inProfiles = await env.DB.prepare("SELECT 1 FROM dj_profiles WHERE handle=? LIMIT 1").bind(n).first();
  if (inProfiles) return false;
  try {
    const inAliases = await env.DB.prepare("SELECT 1 FROM handle_aliases WHERE handle=? LIMIT 1").bind(n).first();
    if (inAliases) return false;
  } catch (_) { /* aliases table may predate migration 0007; treat as no alias */ }
  return true;
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

async function getEventAliasTarget(env, oldSlug) {
  if (!env?.DB || !SLUG_RE.test(String(oldSlug || ""))) return "";
  const alias = await env.DB.prepare("SELECT slug FROM event_aliases WHERE old_slug=?").bind(oldSlug).first();
  const slug = String(alias?.slug || "");
  if (!SLUG_RE.test(slug) || slug === oldSlug) return "";
  const event = await env.DB.prepare("SELECT slug FROM events WHERE slug=?").bind(slug).first();
  return event ? slug : "";
}

// A slug that already has a keepsake alias (someone renamed away from it, so old
// /e/<slug> links still redirect) is RESERVED — so those links never break or get
// silently repointed to a different owner's event. Only the event the alias
// currently points TO may reclaim the old slug (this lets an owner undo their own
// rename). `currentSlug` is the slug of the event trying to claim it — "" for a
// brand-new event. Returns true when the slug is reserved against that event.
async function slugReservedByAlias(env, slug, currentSlug = "") {
  if (!env?.DB || !SLUG_RE.test(String(slug || ""))) return false;
  const alias = await env.DB.prepare("SELECT slug FROM event_aliases WHERE old_slug=?").bind(String(slug)).first();
  if (!alias) return false;
  return String(alias.slug || "") !== String(currentSlug || "");
}

async function recordEventAlias(env, oldSlug, slug, now, target = {}) {
  oldSlug = String(oldSlug || "").trim();
  slug = String(slug || "").trim();
  if (!env?.DB || !SLUG_RE.test(oldSlug) || !SLUG_RE.test(slug) || oldSlug === slug) return false;

  const event = await env.DB.prepare("SELECT slug, install_id, owner_user_id FROM events WHERE slug=?").bind(slug).first();
  if (!event) return false;
  if (target.install_id != null && event.install_id !== target.install_id) return false;
  if (target.owner_user_id != null && event.owner_user_id !== target.owner_user_id) return false;

  // Only aliases for retired slugs redirect. Active event slugs keep their own pages.
  const oldEvent = await env.DB.prepare("SELECT slug FROM events WHERE slug=?").bind(oldSlug).first();
  if (oldEvent) return false;

  // Reclaiming a live event at `slug` shadows any alias whose old_slug == slug
  // (the live event always wins in getEventAliasTarget), so clear that alias —
  // but ONLY if it is already dead (its target no longer resolves). Never
  // destroy another owner's LIVE keepsake redirect that happens to share this
  // old_slug. (Deeper cross-owner slug-reuse is tracked for a reservation model.)
  const shadowed = await env.DB.prepare("SELECT slug FROM event_aliases WHERE old_slug=?").bind(slug).first();
  if (shadowed) {
    const stillLive = await env.DB.prepare("SELECT 1 FROM events WHERE slug=?").bind(String(shadowed.slug || "")).first();
    if (!stillLive) {
      await env.DB.prepare("DELETE FROM event_aliases WHERE old_slug=?").bind(slug).run();
    }
  }
  await env.DB.prepare("UPDATE event_aliases SET slug=? WHERE slug=?").bind(slug, oldSlug).run();
  await env.DB.prepare(
    `INSERT INTO event_aliases (old_slug, slug, created_ms)
     VALUES (?, ?, ?)
     ON CONFLICT(old_slug) DO UPDATE SET slug=excluded.slug`
  ).bind(oldSlug, slug, now || nowMs()).run();
  return true;
}

// Slug changes are safe only before an event has acquired durable activity.
// D1 child tables reference events.slug without ON UPDATE CASCADE, and R2 media
// keys are rooted under the slug, so moving a populated event would either fail
// its foreign-key update or strand its published objects at the old paths.
async function eventRenameBlocked(env, slug) {
  const row = await env.DB.prepare(
    `SELECT e.status, e.cover_key,
            EXISTS(SELECT 1 FROM event_sets s WHERE s.slug=e.slug) AS has_sets,
            EXISTS(SELECT 1 FROM posts p WHERE p.slug=e.slug) AS has_posts,
            EXISTS(SELECT 1 FROM event_rsvps r WHERE r.slug=e.slug) AS has_rsvps,
            EXISTS(SELECT 1 FROM event_guest_claims c WHERE c.slug=e.slug) AS has_claims,
            EXISTS(SELECT 1 FROM event_guests g WHERE g.slug=e.slug) AS has_guests
     FROM events e WHERE e.slug=?1 LIMIT 1`
  ).bind(slug).first();
  if (!row) return false;
  return row.status !== "upcoming" || !!row.cover_key || !!row.has_sets || !!row.has_posts ||
    !!row.has_rsvps || !!row.has_claims || !!row.has_guests;
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
    "SELECT * FROM posts WHERE slug=? AND approved=1 AND deleted_ms IS NULL ORDER BY COALESCE(activity_ms, created_ms, ts_ms, 0) ASC LIMIT ?"
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

function compareProductVersions(a, b) {
  const pa = /^(\d+)\.(\d+)$/.exec(String(a || "").trim());
  const pb = /^(\d+)\.(\d+)$/.exec(String(b || "").trim());
  if (!pa || !pb) return Number.NEGATIVE_INFINITY;
  const major = Number(pa[1]) - Number(pb[1]);
  return major || (Number(pa[2]) - Number(pb[2]));
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
.navlinks{display:flex;align-items:center;gap:8px}
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
.eventtop{display:grid;grid-template-columns:minmax(0,1fr) minmax(230px,320px);gap:20px;align-items:stretch;margin-top:12px}
.eventintro{min-width:0;padding:14px 0 10px;display:flex;flex-direction:column;justify-content:center}
.eventactions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.eventactions .btn.ghost{background:#fff;color:var(--ink);border-color:var(--line);box-shadow:0 1px 2px rgba(0,0,0,.03)}
.eventactions .btn.ghost:hover{border-color:var(--accent)}
.eventeyebrow{margin:0 0 12px;color:var(--accent);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}
.eventintro .statuspill{background:rgba(255,45,111,.08);backdrop-filter:none;border-color:rgba(255,45,111,.18);color:var(--accent);margin:0 0 12px}
.eventintro .statuspill .dot{box-shadow:none;animation:none}
.eventtitle{font-size:44px;line-height:1.04;font-weight:700;margin:0;color:var(--ink);letter-spacing:0;overflow-wrap:anywhere}
.eventtagline{color:var(--ink2);font-size:17px;line-height:1.45;margin:14px 0 0;max-width:58ch}
.eventmeta{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
.eventmeta span{display:inline-flex;align-items:center;gap:6px;min-height:32px;border:1px solid var(--line);border-radius:var(--pill);padding:6px 11px;background:#fff;color:var(--ink2);font-size:13px;line-height:1.2}
.eventmeta b{font-weight:600;color:var(--ink)}
.eventcover{min-height:260px;border-radius:24px;overflow:hidden;background:linear-gradient(135deg,#fff 0%,#f5f5f7 48%,#ffe8f0 100%);box-shadow:0 1px 2px rgba(0,0,0,.04),0 0 0 1px var(--hair)}
.eventcover img{width:100%;height:100%;min-height:260px;object-fit:cover}
.eventcover.fallback{display:grid;place-items:end;padding:22px;color:var(--ink)}
.eventcover.fallback span{font-size:13px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.08em}
.replayhero{position:relative;overflow:hidden;padding:28px;border-color:rgba(255,45,111,.16);background:linear-gradient(180deg,#fff 0%,#fff8fb 100%)}
.replayhero:before{content:"";position:absolute;top:0;left:0;right:0;height:4px;background:var(--accent)}
.replayhead{position:relative;display:flex;justify-content:space-between;align-items:flex-start;gap:18px;margin-bottom:18px}
.replaylabel{margin:0 0 6px;color:var(--accent);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em}
.replayhero h2{font-size:28px;line-height:1.08;letter-spacing:0;margin:0}
.replaymeta{color:var(--ink2);font-size:14px;line-height:1.35;margin:8px 0 0}
.replayduration{white-space:nowrap;border:1px solid var(--line);border-radius:var(--pill);background:#fff;color:var(--ink);font-size:13px;font-weight:600;padding:8px 12px}
.replayhero .wave{height:108px;margin:0 0 16px;padding:12px;border:1px solid var(--line);border-radius:16px;background:#fff}
.replayhero .wave i{background:#ececf0}
.replayhero audio{width:100%;display:block}
.media-card .sectionhead,.commentcard .sectionhead{margin:0 0 14px}
.media-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.media-tile{margin:0;border-radius:14px;overflow:hidden;background:var(--bg);position:relative;box-shadow:0 0 0 1px var(--line)}
.media-tile img,.media-tile video{width:100%;aspect-ratio:1;object-fit:cover;background:var(--bg);display:block}
.media-tile video{cursor:pointer}
.media-tile figcaption{position:absolute;left:0;right:0;bottom:0;padding:18px 10px 9px;background:linear-gradient(180deg,transparent,rgba(0,0,0,.52));color:#fff;font-size:12px;font-weight:600;line-height:1.2;opacity:0;transition:opacity .15s;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.media-tile:hover figcaption,.media-tile:focus-within figcaption{opacity:1}
.commentcard .timeline{margin-top:4px}
.commentcard .comments{background:var(--bg);border-left:0;border-radius:12px;margin:12px 0 0;padding:10px 12px}
.commentcard .comment{font-size:13px}
.emptykeepsake{display:grid;gap:8px;color:var(--ink2);font-size:14px;line-height:1.45;margin:0}
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
.timeline{position:relative;display:grid;gap:18px;margin-top:18px}
.timeline:before{content:"";position:absolute;left:18px;top:18px;bottom:18px;width:1px;background:var(--line)}
.tl-entry{position:relative;display:grid;grid-template-columns:38px minmax(0,1fr);gap:14px}
.tl-dot{position:relative;z-index:1;width:36px;height:36px;border-radius:50%;background:var(--bg);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;font-size:17px;box-shadow:0 0 0 4px var(--card)}
.tl-dot.dj{border-color:var(--accent);box-shadow:0 0 0 4px var(--card),0 0 0 6px color-mix(in srgb,var(--accent) 20%,transparent)}
.tl-body{min-width:0;padding-bottom:2px}
.tl-who{display:flex;gap:8px;align-items:center;color:var(--ink2);font-size:13px;margin-bottom:7px}
.tl-who b{color:var(--ink);font-weight:600}.tl-who time{color:var(--ink3);white-space:nowrap}.djchip{font-size:10px;font-weight:700;letter-spacing:.05em;color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 36%,var(--line));border-radius:var(--pill);padding:2px 6px}
.walltext{font-size:15px;line-height:1.5;margin:0 0 12px;white-space:pre-wrap;overflow-wrap:anywhere}
.tl-media{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px}
.tl-media img,.tl-media video{width:100%;max-width:100%;border-radius:12px;background:var(--bg);object-fit:cover}.tl-media img{aspect-ratio:1}.tl-media video{aspect-ratio:16/10}
.tl-media audio{grid-column:1/-1;width:100%}
.comments{border-left:1px solid var(--line);margin:12px 0 0 6px;padding-left:12px;display:grid;gap:7px}
.comment{font-size:13px;color:var(--ink2);line-height:1.4}.comment b{color:var(--ink);font-weight:600}
@media(max-width:640px){.tl-entry{gap:12px}.tl-who{flex-wrap:wrap}}
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
.faqhero{padding:56px 0 18px}
.faqhero h1{font-size:clamp(42px,7vw,72px);line-height:.98;letter-spacing:-.045em;margin:0 0 16px;max-width:760px}
.faqhero p{color:var(--ink2);font-size:20px;line-height:1.42;margin:0;max-width:660px}
.faqgrid{display:grid;gap:18px;margin-top:18px}
.faqgroup{padding:28px}
.faqgroup h2{font-size:24px;letter-spacing:-.025em;margin:0 0 6px}
.faqintro{color:var(--ink2);font-size:14px;margin:0 0 4px}
.faqitem{border-top:1px solid var(--line);padding-top:20px;margin-top:20px}
.faqitem:first-of-type{border-top:0;padding-top:0}
.faqitem h3{font-size:20px;line-height:1.2;letter-spacing:-.02em;margin:0 0 8px}
.faqitem p{color:var(--ink2);font-size:15px;line-height:1.55;margin:0 0 10px;max-width:72ch}
.faqitem p:last-child{margin-bottom:0}
.faqlist{display:grid;gap:10px;margin:12px 0 0;padding:0;list-style:none}
.faqlist li{color:var(--ink2);font-size:15px;line-height:1.5;margin:0;padding-left:18px;position:relative;max-width:74ch}
.faqlist li:before{content:"";position:absolute;left:0;top:.7em;width:5px;height:5px;border-radius:50%;background:var(--accent)}
.faqlist b{color:var(--ink);font-weight:600}
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
.authcard{max-width:520px;margin:48px auto 0}.authform{display:grid;gap:12px;margin-top:16px}.authform input,.authform textarea{width:100%;border:1px solid var(--line);border-radius:12px;padding:12px 14px;font:inherit;font-size:15px;background:#fff;color:var(--ink)}.authform textarea{min-height:104px;resize:vertical;line-height:1.45}.authform input:focus,.authform textarea:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px rgba(255,45,111,.12)}.authform label{display:grid;gap:6px;color:var(--ink2);font-size:13px}.authform label span{font-weight:600;color:var(--ink)}.authform .checkrow{display:flex;align-items:center;gap:10px;color:var(--ink);font-size:14px}.authform .checkrow input{width:18px;height:18px;padding:0;accent-color:var(--accent)}.authform details{color:var(--ink2);font-size:13px}.authform summary{cursor:pointer;display:inline-flex;margin:2px 0 8px}.accounthead{display:flex;justify-content:space-between;align-items:start;gap:16px}.accounthead p{margin:4px 0 0;color:var(--ink2)}.accountgrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.accountgrid .card{margin-top:0}.stat{font-size:34px;font-weight:700;letter-spacing:-.03em;margin:10px 0 2px}.minirow{border-top:1px solid var(--line);padding-top:12px;margin-top:12px}.minirow:first-child{border-top:0;padding-top:0;margin-top:0}.minirow b{display:block;font-size:15px}.minirow span{display:block;color:var(--ink2);font-size:13px;margin-top:2px}
.rsvp{display:grid;gap:14px}.rsvphead{display:flex;justify-content:space-between;gap:16px;align-items:start}.rsvphead .sub{margin-bottom:0}.rsvpcounts{display:flex;gap:14px;align-items:center;color:var(--ink2);font-size:12px;white-space:nowrap}.rsvpcounts b{display:block;color:var(--ink);font-size:22px;line-height:1}.rsvprow{display:flex;gap:10px;flex-wrap:wrap}.rsvp .btn.active{background:var(--accent);color:#fff;border-color:transparent}.rsvpfields{display:grid;grid-template-columns:minmax(0,1fr) 78px;gap:10px}.rsvpfields input{width:100%;border:1px solid var(--line);border-radius:12px;padding:10px 12px;font:inherit;font-size:14px;background:#fff;color:var(--ink)}.rsvpfields input:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px rgba(255,45,111,.12)}
@media(max-width:760px){.homehero{grid-template-columns:1fr;padding-top:26px}.eventgrid,.djstrip,.emptyhome{grid-template-columns:1fr}.eventcard{grid-template-columns:92px minmax(0,1fr)}}
@media(max-width:760px){.accountgrid{grid-template-columns:1fr}.accounthead{display:grid}.navlinks{gap:6px}.navlinks .btn.sm{padding:8px 12px}}
@media(max-width:760px){.eventtop{grid-template-columns:1fr;gap:14px}.eventcover{order:-1;min-height:220px}.eventcover img{min-height:220px}.eventtitle{font-size:36px}.eventtagline{font-size:16px}.replayhead{display:grid}.replayduration{justify-self:start}.media-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.media-tile figcaption{display:none}}
@media(max-width:560px){.rsvphead{display:grid}.rsvpcounts{justify-content:space-between}.rsvpfields{grid-template-columns:1fr 70px}}
@media(max-width:560px){.eventpage{padding-left:16px;padding-right:16px}.eventactions{margin-bottom:14px}.eventtitle{font-size:32px}.eventmeta span{font-size:12px}.replayhero{padding:22px}.replayhero h2{font-size:24px}.replayhero .wave{height:86px}.commentcard .tl-entry{grid-template-columns:32px minmax(0,1fr)}.commentcard .tl-dot{width:30px;height:30px;font-size:15px}.commentcard .timeline:before{left:15px}}
`;

const SVGDEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<g id="ig"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.5" cy="6.5" r="1.3"/></g>
<g id="sc"><path d="M9.5 17.5H18a3 3 0 0 0 .2-6A5.2 5.2 0 0 0 9.8 8.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M3.2 12v5.5M5.6 10v7.5M8 9v8.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></g>
<g id="sp"><circle cx="12" cy="12" r="10"/><path d="M7 10.2c3-.9 6.6-.5 9.2 1.1M7.6 12.8c2.4-.7 5.4-.4 7.5 1M8.1 15.2c1.9-.5 4-.3 5.6.8" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></g>
<g id="web"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 12h17M12 3.2c2.2 2.4 3.3 5.3 3.3 8.8s-1.1 6.4-3.3 8.8M12 3.2C9.8 5.6 8.7 8.5 8.7 12s1.1 6.4 3.3 8.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></g>
</defs></svg>`;

const NAV = `<nav><a class="brand" href="/">🕺 partyparty</a><div class="navlinks"><a class="btn lt sm" href="/live">Home</a><a class="btn lt sm" href="/partyparty.pkg">Get the app</a><a class="btn lt sm" id="nav-auth" href="/login">Sign in</a></div></nav>`;

const NAV_AUTH_JS = `<script>
(function(){var a=document.getElementById('nav-auth');if(!a||!window.fetch)return;fetch('/api/me',{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(j){if(j&&j.user){a.textContent='Account';a.href='/account'}else{a.textContent='Sign in';a.href='/login'}}).catch(function(){})})();
</script>`;

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
<style>${CSS}</style></head><body>${SVGDEFS}${NAV}${body}${NAV_AUTH_JS}${TOAST_JS}</body></html>`;
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

async function isFollowing(env, userId, profileId) {
  if (!env?.DB || !userId || !profileId) return false;
  const row = await env.DB.prepare(
    "SELECT 1 FROM follows WHERE follower_user_id=? AND dj_profile_id=? LIMIT 1"
  ).bind(userId, profileId).first();
  return !!row;
}

async function getFollowedProfiles(env, userId) {
  if (!env?.DB || !userId) return [];
  const rows = await env.DB.prepare(
    `SELECT p.*
     FROM follows f
     JOIN dj_profiles p ON p.id=f.dj_profile_id AND p.published=1
     WHERE f.follower_user_id=?
     ORDER BY f.created_ms DESC
     LIMIT 24`
  ).bind(userId).all();
  return rows?.results || [];
}

// POST = follow, DELETE = unfollow. Auth required; local party never depends on this.
async function followApi(request, env) {
  if (request.method !== "POST" && request.method !== "DELETE") {
    return jsonResp(405, { error: "POST or DELETE" });
  }
  if (!env.DB) return jsonResp(503, { error: "not configured" });
  const user = await getSessionUser(env, request);
  if (!user) return jsonResp(401, { error: "sign in required" });
  const body = await readJson(request, 512);
  const handle = normalizeHandle(body?.handle || "");
  if (!handle) return jsonResp(400, { error: "handle required" });
  const profile = await getProfileByHandle(env, handle);
  if (!profile) return jsonResp(404, { error: "not found" });
  if (profile.user_id === user.id) return jsonResp(400, { error: "cannot follow yourself" });
  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM follows WHERE follower_user_id=? AND dj_profile_id=?").bind(user.id, profile.id).run();
    return jsonResp(200, { ok: true, following: false });
  }
  await env.DB.prepare(
    "INSERT INTO follows (follower_user_id, dj_profile_id, created_ms) VALUES (?,?,?) ON CONFLICT(follower_user_id, dj_profile_id) DO NOTHING"
  ).bind(user.id, profile.id, nowMs()).run();
  return jsonResp(200, { ok: true, following: true });
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
  // Also pull each event's latest READY set (id + duration) so the profile can
  // play the recording INLINE — not just link out to the /e/<slug> page.
  const rows = await env.DB.prepare(
    `SELECT e.*,
       (SELECT s.id          FROM event_sets s WHERE s.slug=e.slug AND s.state='ready' ORDER BY s.published_ms DESC LIMIT 1) AS set_id,
       (SELECT s.duration_ms FROM event_sets s WHERE s.slug=e.slug AND s.state='ready' ORDER BY s.published_ms DESC LIMIT 1) AS set_duration_ms
     FROM events e
     WHERE e.dj_profile_id=? AND e.visibility=? AND e.status=?
     ORDER BY COALESCE(e.last_activity_ms, e.published_ms, e.scheduled_at_ms, e.updated_ms, e.created_ms, 0) DESC, e.slug ASC
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

async function profileResponse(env, request, handle) {
  const h = normalizeHandle(handle);
  const htmlHeaders = { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" };
  if (!env.DB) return new Response(renderNotFound(), { status: 503, headers: htmlHeaders });
  const profile = await getProfileByHandle(env, h);
  if (!profile) {
    // A renamed DJ's old /@handle keeps working: 301 to their current handle.
    const aliasTarget = await getHandleAliasTarget(env, h);
    if (aliasTarget) {
      return new Response(null, {
        status: 301,
        headers: { location: `/@${aliasTarget}`, "cache-control": "public, max-age=300" },
      });
    }
    return new Response(renderNotFound(), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=30" },
    });
  }
  const viewer = await getSessionUser(env, request);
  const isOwner = !!(viewer && profile.user_id && viewer.id === profile.user_id);
  const [upcoming, recent, posts, following] = await Promise.all([
    getProfileUpcomingEvents(env, profile.id),
    getProfileRecentEvents(env, profile.id),
    getProfilePosts(env, profile.id),
    viewer && !isOwner ? isFollowing(env, viewer.id, profile.id) : Promise.resolve(false),
  ]);
  // Any signed-in view is personalized (owner actions, or the Follow/Following
  // state), so it must never be served from a shared public cache. Anonymous
  // views are identical for everyone and stay cacheable.
  return new Response(renderProfile({ profile, upcoming, recent, posts, isOwner, viewerSignedIn: !!viewer, following }), {
    headers: viewer ? { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } : htmlHeaders,
  });
}

function profileEventSection(title, sub, rows, empty) {
  return `<section>
    <div class="sectionhead"><div><h2>${esc(title)}</h2>${sub ? `<p>${esc(sub)}</p>` : ""}</div></div>
    ${rows.length ? `<div class="eventgrid">${rows.map(eventCard).join("")}</div>` : `<div class="card"><p class="emptyline">${esc(empty)}</p></div>`}
  </section>`;
}

// Recent replays, playable INLINE on the profile (native <audio> per set, fed by
// the same /event/<slug>/<setId>.m4a R2 endpoint the event page uses). Events
// without a ready set yet fall back to the plain card link. Inline styles keep
// this self-contained — no change to the shared stylesheet.
function profileReplaySection(rows) {
  const items = (rows || []).map((row) => {
    const slug = String(row.slug || "");
    const setId = row.set_id ? String(row.set_id) : "";
    if (!setId) return eventCard(row);
    const dur = row.set_duration_ms
      ? `<span class="meta" style="white-space:nowrap;margin:0">${esc(fmtDur(row.set_duration_ms))}</span>` : "";
    return `<div class="card" style="display:grid;gap:12px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px">
        <div><h3 style="margin:0">${esc(row.title || "A partyparty set")}</h3><p class="meta" style="margin:2px 0 0">${esc(fmtWhen(row.scheduled_at_ms))}</p></div>
        ${dur}
      </div>
      <audio controls preload="none" src="/event/${esc(slug)}/${esc(setId)}.m4a" style="width:100%"></audio>
      <a class="btn lt sm" href="/e/${esc(slug)}" style="justify-self:start">Open event page</a>
    </div>`;
  }).join("");
  return `<section>
    <div class="sectionhead"><div><h2>Recent</h2><p>Play a finished set right here.</p></div></div>
    ${(rows || []).length ? `<div style="display:grid;gap:14px">${items}</div>` : `<div class="card"><p class="emptyline">No public replays yet.</p></div>`}
  </section>`;
}

function renderProfile({ profile, upcoming, recent, posts, isOwner, viewerSignedIn, following }) {
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
  // Header actions vary by viewer: the owner gets Create event / Edit profile; a
  // signed-in visitor gets Follow/Following; a signed-out visitor gets a sign-in
  // prompt. A stranger must never see "Create event" (that made every visitor look
  // like the owner).
  let viewerActions = "";
  let followScript = "";
  if (isOwner) {
    viewerActions = `<div class="ecta"><a class="btn" href="/events/new">＋ Create event</a><a class="btn ghost" href="/profile/edit">Edit profile</a></div>`;
  } else if (viewerSignedIn) {
    viewerActions = `<div class="ecta"><button class="btn${following ? " ghost" : ""}" id="followbtn" data-follow="${esc(handle)}" data-following="${following ? "1" : "0"}">${following ? "Following" : "＋ Follow"}</button></div>`;
    followScript = `<script>
(function(){var b=document.getElementById('followbtn');if(!b||!window.fetch)return;b.addEventListener('click',function(){var on=b.getAttribute('data-following')==='1';b.disabled=true;fetch('/api/follow',{method:on?'DELETE':'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({handle:b.getAttribute('data-follow')})}).then(function(r){return r.ok?r.json():Promise.reject()}).then(function(d){var f=!!d.following;b.setAttribute('data-following',f?'1':'0');b.textContent=f?'Following':'＋ Follow';b.className=f?'btn ghost':'btn'}).catch(function(){}).finally(function(){b.disabled=false})})})();
</script>`;
  } else {
    viewerActions = `<div class="ecta"><a class="btn" href="/login?redirect=${encodeURIComponent("/@" + handle)}">Sign in to follow</a></div>`;
  }
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
        ${viewerActions}
      </div>
    </div>
    ${profileEventSection("Upcoming", "Public parties coming up next.", upcoming, "No upcoming public events yet.")}
    ${profileReplaySection(recent)}
    ${postsCard}
  </div>
  <footer><span>🕺 partyparty</span><span>Silent-disco popups on your Mac · <a href="/" style="color:var(--link)">what is this?</a></span></footer>
  ${followScript}`;
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
      <p class="big">Throw a party where speakers would get you shut down.</p>
      <p>partyparty turns your Mac into a local silent-disco rig: guests scan a QR, listen in their browser, and the live audio stays on the room's Wi-Fi. Keepsake event pages for replays, photos and clips are coming soon.</p>
      <div class="ecta"><a class="btn" href="/partyparty.pkg">Get the app</a><a class="btn lt" href="/login">Sign in</a></div>
    </div>
    <div class="card">
      <h2>Link your Mac</h2>
      <p class="sub">Sign in to create your account, generate a one-time code, and paste it into the Mac app.</p>
      <a class="btn lt sm" href="/login">Account access</a>
    </div>
  </div>`;
}

const FAQ_GROUPS = [{
  title: "Getting started",
  intro: "The short version: the DJ runs the room from a Mac, guests listen from their phones.",
  items: [{
    q: "What is partyparty?",
    p: [
      "A pop-up listening party. The DJ plays from their Mac; everyone nearby tunes in on their own phone and listens through their earbuds — a silent disco with no speakers and no shutdown. No app for guests: scan the QR, tap play.",
    ],
  }, {
    q: "How do guests join?",
    p: [
      "Scan the QR (or open the link) in any phone browser — iPhone or Android. No app, no account, no sign-up. Tap play and you're in, in sync with the room.",
    ],
  }, {
    q: "What do I need to host as the DJ?",
    p: [
      "A Mac with the partyparty app, and whatever you want to play. For bigger crowds, a small travel Wi-Fi router. That's it.",
    ],
  }],
}, {
  title: "Setups & networks",
  intro: "partyparty is local first, so the network matters more than the internet.",
  items: [{
    q: "Do I need internet?",
    p: [
      "partyparty runs on your local network — the Mac streams the audio straight to nearby phones, not through the cloud. On any Wi-Fi with internet it just works. And the Mac can host its own network so you can throw a party with little or no internet — the goal is a party anywhere, even off the grid. Fully off-grid hosting is rolling out; see Setups below.",
    ],
  }, {
    q: "What setups work?",
    bullets: [
      { title: "Everyone on the same Wi-Fi (home, apartment, venue):", body: "the simplest — guests join your Wi-Fi, scan, play." },
      { title: "The Mac's own hotspot:", body: "host straight from the Mac for a small group, no extra gear." },
      { title: "A travel Wi-Fi router you bring:", body: "the best option for a real party — most reliable, most phones." },
      { title: "An iPhone Personal Hotspot:", body: "works for up to 5 phones." },
      { title: "After the party:", body: "publish the set (and the night's photos & clips) to a shareable replay page online." },
    ],
  }, {
    q: "Does it work with no internet?",
    p: [
      "Yes. Your Mac can host its own Wi-Fi and run the whole party with zero internet — it becomes the network. Guests join that Wi-Fi and listen. Two honest notes: while they're on it their phones won't have internet, and it's best for a small group (a laptop's radio handles a handful of people — for a bigger crowd, bring a small travel router). One click starts it; if your Mac needs a nudge, it shows you the single setting to flip.",
    ],
  }, {
    q: "What if the venue Wi-Fi is bad?",
    p: [
      "If guests can't reach you, the app notices and offers to switch to hosting your own Wi-Fi in one tap. It never quietly fails — you'll see exactly what's wrong.",
    ],
  }],
}, {
  title: "Capacity & limits",
  intro: "Capacity depends on the Wi-Fi radio carrying the room.",
  items: [{
    q: "How many people can join?",
    p: [
      "It depends on the network, not the app:",
    ],
    bullets: [
      { title: "Real Wi-Fi (home / venue / a travel router):", body: "plenty." },
      { title: "The Mac's own hotspot:", body: "a handful — it's the Mac's Wi-Fi radio doing double duty." },
      { title: "An iPhone hotspot:", body: "5 (Apple's limit, not ours)." },
    ],
    after: [
      "The DJ console shows a live capacity meter, so you can see if you're crowding the network — if so, bring a small travel router and you're golden.",
    ],
  }, {
    q: "Is the audio good? Is it in sync?",
    p: [
      "Yes — it's low-latency, so the room hears the music together (about a second or two apart), each through their own earbuds. The connection is secure (HTTPS).",
    ],
  }, {
    q: "Does it drain my guests' phones or use their data?",
    p: [
      "It's just a web page playing audio on your local network — no app, and on a local/offline network it uses no cellular data at all.",
    ],
  }],
}, {
  title: "At the party",
  intro: "Turn the page into tonight's party — every feature is yours to switch on or off.",
  items: [{
    q: "Can people do more than listen?",
    p: [
      "Yes, when you turn it on: guests can drop photos and short videos to the party wall, tap reactions (🔥 louder / rewind…) so you can read the room, request a track, and ask \"what's this?\" for the current song. Every one of these is a switch you control — flip any of them off instantly, mid-set.",
    ],
  }, {
    q: "Is there a big-screen mode?",
    p: [
      "Yes — open the Wall on a TV or projector. It shows the join QR, the night's photos, live reactions, and what's playing. It's display-only, and shows only what you've approved.",
    ],
  }, {
    q: "Who sees the photos — can I moderate?",
    p: [
      "You decide. Approve items before they appear, or let them post and hide anything after; remove any photo or comment; and turn uploads or comments off with one toggle. Nothing reaches the wall or the recap without your say-so.",
    ],
  }, {
    q: "Do my photos and videos end up online after?",
    p: [
      "Yes. After the party, everything people captured — photos, videos, comments, and your set — mirrors to your event page automatically (uploaded once the set ends, so it never slows the music), and you get a shareable link. You can also export a self-contained recap to keep offline.",
    ],
  }],
}, {
  title: "Good to know",
  intro: "The honest limitations, plus what stays private.",
  items: [{
    q: "What doesn't work — the honest limitations:",
    bullets: [
      { title: "Client-isolation Wi-Fi.", body: "Some guest, hotel, and corporate networks deliberately block devices from talking to each other. On those, phones can't reach the Mac. The fix: host from the Mac's own hotspot or a travel router you control." },
      { title: "A first-time online setup.", body: "The very first time, the Mac needs internet once to set up its secure certificate. After that, it can run offline." },
      { title: "Guests must be on the same network as the Mac.", body: "It's local audio, not a cloud radio station — bring guests onto your Wi-Fi or hotspot (share the network name, or they scan the QR after joining)." },
      { title: "iPhone hotspot caps at 5 devices.", body: "That's an Apple limit no app can change — use a travel router for more." },
    ],
  }, {
    q: "Is it private?",
    p: [
      "The audio streams over your own local network between the Mac and the phones in the room. Nothing about the live party requires the cloud.",
    ],
  }, {
    q: "How do I uninstall it?",
    p: [
      "Quit partyparty and drag the app from ~/Applications to the Trash. The app's footprint is the .app bundle, Sparkle's updater/XPC registration, an optional login item, and the FFmpeg, MediaMTX, and system-audio helpers inside the bundle. Nothing is installed to /Library, and no audio driver or kext is left behind.",
    ],
  }],
}];

function renderFaqParagraphs(lines) {
  return (lines || []).map((line) => `<p>${esc(line)}</p>`).join("");
}

function renderFaqBullets(items) {
  if (!items?.length) return "";
  return `<ul class="faqlist">${items.map((item) => `<li>${item.title ? `<b>${esc(item.title)}</b> ` : ""}${esc(item.body || "")}</li>`).join("")}</ul>`;
}

function renderFaqItem(item) {
  return `<article class="faqitem">
    <h3>${esc(item.q)}</h3>
    ${renderFaqParagraphs(item.p)}
    ${renderFaqBullets(item.bullets)}
    ${renderFaqParagraphs(item.after)}
  </article>`;
}

function renderFaq() {
  const title = "FAQ · How partyparty works";
  const desc = "How to host a partyparty silent-disco popup from your Mac, including setup options, capacity and honest limitations.";
  const pageUrl = absUrl("/faq");
  const imageUrl = absUrl(DEFAULT_OG_IMAGE);
  const faqCss = `
body.faqbody{margin:0;background:#fff;color:#1d1d1f;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Helvetica Neue",Helvetica,Arial,sans-serif;font-size:17px;line-height:1.47;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
body.faqbody *{box-sizing:border-box}
body.faqbody a{color:inherit;text-decoration:none}
.faqpage{--ink:#1d1d1f;--ink-2:#424245;--muted:#6e6e73;--hairline:#d2d2d7;--hairline-2:#e8e8ed;--bg:#ffffff;--bg-soft:#f5f5f7;--accent:#0066cc;--display:"Fraunces","SF Pro Display",-apple-system,Georgia,serif;max-width:820px;margin:0 auto;padding:0 24px 68px;background:var(--bg);color:var(--ink)}
.faqpage a{color:var(--accent)}
.faqback{display:inline-flex;align-items:center;gap:7px;margin:24px 0 0;color:var(--accent);font-size:14px;line-height:1.2}
.faqback span{font-size:15px;transform:translateY(-1px)}
.faqhero{position:relative;isolation:isolate;padding:80px 0 40px;text-align:center}
.faqhero::before{content:"";position:absolute;z-index:-1;pointer-events:none;top:-52px;left:-24px;right:-24px;height:340px;background:radial-gradient(80% 320px at 50% 0,color-mix(in srgb,var(--accent) 7%,transparent),transparent 70%)}
.faqeyebrow{font-family:var(--display);font-size:12px;font-weight:600;letter-spacing:.14em;line-height:1.2;text-transform:uppercase;color:var(--muted);margin:0}
.faqeyebrow::after{content:"";display:block;width:28px;height:2px;margin:10px auto 0;background:var(--accent)}
.faqhero h1{font-family:var(--display);font-weight:600;font-size:clamp(38px,4.6vw,56px);line-height:1.04;letter-spacing:-.018em;text-wrap:balance;margin:14px 0 16px;color:var(--ink)}
.faqdek{max-width:560px;margin:0 auto;color:var(--muted);font-size:20px;line-height:1.45}
.faqcontent{padding:8px 0 0}
.faqsection{margin-top:64px;padding-top:34px;border-top:1px solid var(--hairline)}
.faqsection:first-child{margin-top:0}
.faqsection h2{font-family:var(--display);font-size:clamp(26px,3.1vw,30px);font-weight:600;line-height:1.14;letter-spacing:-.01em;margin:0;color:var(--ink)}
.faqintro{max-width:620px;margin:8px 0 0;color:var(--muted);font-size:16px;line-height:1.55}
.faqitem{margin-top:30px}
.faqitem h3{font-size:19px;font-weight:600;line-height:1.28;letter-spacing:0;margin:0 0 9px;color:var(--ink)}
.faqitem p{max-width:72ch;margin:0 0 12px;color:var(--ink-2);font-size:17px;line-height:1.6}
.faqitem p:last-child{margin-bottom:0}
.faqlist{display:grid;gap:12px;margin:14px 0 0;padding:0;list-style:none}
.faqlist li{position:relative;max-width:74ch;margin:0;padding-left:18px;color:var(--ink-2);font-size:17px;line-height:1.58}
.faqlist li::before{content:"";position:absolute;left:0;top:.72em;width:5px;height:5px;background:var(--accent)}
.faqlist b{color:var(--ink);font-weight:600}
.faqfooter{border-top:1px solid var(--hairline);margin-top:72px;padding:22px 0 0;color:var(--muted);font-size:14px;display:flex;justify-content:space-between;gap:18px;flex-wrap:wrap}
.faqfooter b{font-weight:600;color:var(--ink)}
.faqfooter p{margin:0}
@media(max-width:640px){.faqpage{padding:0 24px 52px}.faqback{margin-top:18px}.faqhero{padding:58px 0 34px}.faqhero::before{top:-38px;height:270px}.faqdek{font-size:18px}.faqsection{margin-top:52px;padding-top:28px}.faqitem{margin-top:26px}.faqfooter{display:grid;margin-top:58px}}
`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:url" content="${esc(pageUrl)}"><meta property="og:site_name" content="partyparty"><meta property="og:image" content="${esc(imageUrl)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(imageUrl)}">
<meta name="theme-color" content="#ffffff"><meta name="color-scheme" content="light">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🕺</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&display=swap" rel="stylesheet">
<style>${faqCss}</style></head><body class="faqbody"><main class="faqpage">
  <a class="faqback" href="/"><span aria-hidden="true">&larr;</span>${esc("Back to partyparty")}</a>
  <section class="faqhero" aria-labelledby="faq-title">
    <p class="faqeyebrow">${esc("PARTYPARTY · HELP")}</p>
    <h1 id="faq-title">${esc("How partyparty works")}</h1>
    <p class="faqdek">${esc("A pop-up listening party you host from your Mac. No app for guests — scan, tap, listen.")}</p>
  </section>
  <div class="faqcontent">
    ${FAQ_GROUPS.map((group, i) => `<section class="faqsection" aria-labelledby="faq-section-${i}">
      <h2 id="faq-section-${i}">${esc(group.title)}</h2>
      <p class="faqintro">${esc(group.intro)}</p>
      ${group.items.map(renderFaqItem).join("")}
    </section>`).join("")}
  </div>
  <footer class="faqfooter">
    <p><b>${esc("partyparty")}</b></p>
    <p>${esc("Questions we didn't answer?")} <a href="/">${esc("Back to partyparty")}</a></p>
  </footer>
</main></body></html>`;
}

function renderHome({ events, profiles, replays, followed, viewerSignedIn }) {
  const followedRows = Array.isArray(followed) ? followed : [];
  const hasRows = events.length || profiles.length || replays.length || followedRows.length;
  const heroActions = viewerSignedIn
    ? `<a class="btn" href="/partyparty.pkg">Get the app</a><a class="btn lt" href="/account">Your account</a><a class="btn lt" href="/about">About</a>`
    : `<a class="btn" href="/partyparty.pkg">Get the app</a><a class="btn lt" href="/login">Sign in</a><a class="btn lt" href="/about">About</a>`;
  const body = `<div class="page home">
    <section class="homehero">
      <div>
        <h1>throw a party where speakers would get you shut down</h1>
        <p>partyparty turns a Mac into a local silent-disco rig. Guests scan a QR, listen in their phone browser, and the music runs on the room's Wi-Fi with zero internet. Keepsake event pages for replays, photos and clips are coming soon.</p>
        <div class="actions">${heroActions}</div>
      </div>
    </section>
    ${followedRows.length ? `<section><div class="sectionhead"><div><h2>DJs you follow</h2><p>New nights from the hosts you follow.</p></div></div><div class="djstrip">${followedRows.map(profileCard).join("")}</div></section>` : ""}
    ${events.length ? `<section><div class="sectionhead"><div><h2>Upcoming &amp; live</h2><p>Public popups you can follow or revisit after the set.</p></div></div><div class="eventgrid">${events.map(eventCard).join("")}</div></section>` : ""}
    ${profiles.length ? `<section><div class="sectionhead"><div><h2>Featured DJs</h2><p>Hosts shaping the next rooms.</p></div></div><div class="djstrip">${profiles.map(profileCard).join("")}</div></section>` : ""}
    ${replays.length ? `<section><div class="sectionhead"><div><h2>Recent replays</h2><p>Sets that already landed.</p></div></div><div class="eventgrid">${replays.map(eventCard).join("")}</div></section>` : ""}
    ${hasRows ? "" : emptyHome()}
  </div>
  <footer><span>🕺 partyparty</span><span>Silent-disco popups on your Mac · <a href="/login" style="color:var(--link)">Sign in</a> · <a href="/faq" style="color:var(--link)">FAQ</a></span></footer>`;
  return shell({
    title: "partyparty — silent-disco popups without speakers",
    desc: "Mac-powered silent-disco popups: no speakers, no guest app, local Wi-Fi audio. Keepsake event pages are coming soon.",
    ogImage: DEFAULT_OG_IMAGE,
    url: "/",
    body,
  });
}

async function homeResponse(env, request) {
  const viewer = await getSessionUser(env, request);
  const [events, profiles, replays, followed] = await Promise.all([
    getHomeEvents(env),
    getFeaturedProfiles(env),
    getReplayEvents(env),
    viewer ? getFollowedProfiles(env, viewer.id) : Promise.resolve([]),
  ]);
  // A signed-in home carries the personalized "DJs you follow" strip, so it can't
  // be shared from a public cache; the signed-out home is identical for everyone.
  return new Response(renderHome({ events, profiles, replays, followed, viewerSignedIn: !!viewer }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": viewer ? "private, no-store" : "public, max-age=60" },
  });
}

function redirectResp(location) {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

function defaultDisplayName(user) {
  return clip(String(user?.email || "").split("@")[0] || user?.display_name || "DJ", 80);
}

function defaultHandle(user) {
  return normalizeHandle(String(user?.email || "").split("@")[0] || user?.display_name || "dj") || "dj";
}

function handleCandidate(base, suffix) {
  const tail = suffix ? `.${suffix}` : "";
  const stem = String(base || "dj").slice(0, 30 - tail.length).replace(/[._]+$/g, "") || "dj";
  return normalizeHandle(stem + tail) || `dj.${suffix || "1"}`;
}

async function ensureUserDjProfile(env, user, now = nowMs()) {
  let profile = await env.DB.prepare("SELECT * FROM dj_profiles WHERE user_id=? LIMIT 1").bind(user.id).first();
  if (profile?.id) return profile;

  const base = defaultHandle(user);
  const displayName = defaultDisplayName(user);
  for (let i = 0; i < 10; i += 1) {
    const handle = handleCandidate(base, i ? i + 1 : 0);
    if (handleReserved(handle)) continue; // never auto-mint a route-shadowing handle
    try {
      // handle_confirmed_ms stays NULL: an auto-derived default the DJ confirms
      // (or changes) once at /welcome. Published so the profile exists; the
      // /welcome soft-gate is presentation, not a hard block.
      await env.DB.prepare(
        `INSERT INTO dj_profiles (id, user_id, handle, display_name, bio, location, published, created_ms, updated_ms, last_activity_ms)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      ).bind(randHex(16), user.id, handle, displayName, "", "", now, now, now).run();
      profile = await env.DB.prepare("SELECT * FROM dj_profiles WHERE user_id=? LIMIT 1").bind(user.id).first();
      if (profile?.id) return profile;
    } catch (e) {
      if (!/unique|constraint|dj_profiles\.handle/i.test(String(e?.message || e || ""))) throw e;
    }
  }
  throw new Error("could not create DJ profile");
}

// One username change per 30 days once the account is settled. The very first
// confirm out of /welcome is exempt (handle_changed_ms is still NULL at that
// point), so a brand-new DJ can always keep or pick their name.
const HANDLE_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

// Rename a profile's handle. The current handle is retired into handle_aliases
// so its /@links 301 forever and the name stays reserved (never re-issued), then
// dj_profiles is repointed at the new handle and the confirm stamp is set if it
// was still pending. Rate-limited to one change per 30 days, except the first
// confirm (handle_changed_ms NULL) which is always free. Returns {ok:true} or
// {error, status}. The caller owns the profile (checked upstream via the session).
async function changeHandle(env, profile, user, newHandle, now = nowMs()) {
  const handle = normalizeHandle(newHandle);
  if (!handle) return { error: "invalid username", status: 400 };
  if (RESERVED_HANDLES.has(handle)) return { error: "that username is reserved", status: 409 };
  const current = normalizeHandle(profile?.handle);
  if (handle === current) return { ok: true };

  // Cooldown is keyed on the last change; a never-changed profile (including the
  // first confirm out of /welcome) skips it.
  if (profile?.handle_confirmed_ms != null && profile?.handle_changed_ms != null &&
      now - Number(profile.handle_changed_ms) < HANDLE_CHANGE_COOLDOWN_MS) {
    return { error: "you can only change your username once every 30 days", status: 429 };
  }

  if (!(await handleAvailable(env, handle))) return { error: "that username is taken", status: 409 };

  // Retire the old handle first so a concurrent claim of it fails the uniqueness
  // check; ON CONFLICT keeps an already-retired handle stable.
  if (current) {
    await env.DB.prepare(
      `INSERT INTO handle_aliases (handle, profile_id, user_id, created_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(handle) DO NOTHING`
    ).bind(current, profile.id, user.id, now).run();
  }

  try {
    await env.DB.prepare(
      `UPDATE dj_profiles
       SET handle=?, handle_changed_ms=?, handle_confirmed_ms=COALESCE(handle_confirmed_ms, ?), updated_ms=?
       WHERE id=?`
    ).bind(handle, now, now, now, profile.id).run();
  } catch (e) {
    const msg = String(e?.message || e || "");
    if (/unique|constraint|dj_profiles\.handle/i.test(msg)) return { error: "that username is taken", status: 409 };
    throw e;
  }
  return { ok: true };
}

// A retired handle (someone renamed away from it) resolves to the profile's
// current handle so old /@links keep working. Returns the current handle, or ""
// when there is no alias / it points nowhere useful.
async function getHandleAliasTarget(env, handle) {
  const h = normalizeHandle(handle);
  if (!env?.DB || !h) return "";
  let alias = null;
  try {
    alias = await env.DB.prepare("SELECT profile_id FROM handle_aliases WHERE handle=? LIMIT 1").bind(h).first();
  } catch (_) { return ""; }
  if (!alias?.profile_id) return "";
  const profile = await env.DB.prepare("SELECT handle FROM dj_profiles WHERE id=? AND published=1 LIMIT 1").bind(alias.profile_id).first();
  const target = normalizeHandle(profile?.handle);
  return target && target !== h ? target : "";
}

// The soft-gate landing after any successful sign-in: make sure the account has
// a dj_profile (its permanent username) and, until that handle is confirmed,
// route through /welcome. Best-effort — a mint failure never blocks sign-in, the
// guest just lands on their original destination. `redirectPath` is the caller's
// post-login target (already run through safeRedirectPath is fine; re-checked here).
async function signInLanding(env, user, redirectPath) {
  const dest = safeRedirectPath(redirectPath || "/account") || "/account";
  if (!env?.DB || !user?.id) return dest;
  try {
    const profile = await ensureUserDjProfile(env, user);
    if (profile && profile.handle_confirmed_ms == null && !/^\/welcome(\?|$)/.test(dest)) {
      return `/welcome?redirect=${encodeURIComponent(dest)}`;
    }
  } catch (_) {
    // Never block sign-in on profile minting.
  }
  return dest;
}

function cleanProfileUrl(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") ? clip(u.href, 500) : null;
  } catch (_) {
    return null;
  }
}

async function profileApi(request, env) {
  if (request.method !== "POST") return jsonResp(405, { error: "POST required" });
  if (!env.DB) return jsonResp(503, { error: "profiles db not configured" });
  const user = await getSessionUser(env, request);
  if (!user) return jsonResp(401, { error: "sign in required" });
  const body = await readJson(request, 4096);
  if (!body) return READ_JSON_TOO_LARGE.has(request) ? jsonResp(413, { error: "too large" }) : jsonResp(400, { error: "bad json" });

  const existing = await env.DB.prepare("SELECT * FROM dj_profiles WHERE user_id=? LIMIT 1").bind(user.id).first();
  const hasHandle = Object.prototype.hasOwnProperty.call(body, "handle") && String(body.handle ?? "").trim() !== "";
  if (!existing && !hasHandle) return jsonResp(400, { error: "bad handle" });

  const handle = hasHandle ? normalizeHandle(body.handle) : normalizeHandle(existing?.handle);
  if (!handle) return jsonResp(400, { error: "bad handle" });
  if (RESERVED_HANDLES.has(handle)) return jsonResp(409, { error: "that username is reserved" });

  const hasDisplay = Object.prototype.hasOwnProperty.call(body, "display_name");
  const hasBio = Object.prototype.hasOwnProperty.call(body, "bio");
  const hasLocation = Object.prototype.hasOwnProperty.call(body, "location");
  const displayName = hasDisplay
    ? (clip(body.display_name, 80).trim() || defaultDisplayName(user))
    : (existing?.display_name || defaultDisplayName(user));
  const bio = hasBio ? clip(body.bio, 500) : (existing?.bio || "");
  const location = hasLocation ? clip(body.location, 80) : (existing?.location || "");
  const now = nowMs();

  if (existing && handle !== normalizeHandle(existing.handle)) {
    const renamed = await changeHandle(env, existing, user, handle, now);
    if (renamed.error) return jsonResp(renamed.status || 409, { error: renamed.error });
  } else if (!existing && !(await handleAvailable(env, handle))) {
    return jsonResp(409, { error: "handle taken" });
  }

  try {
    await env.DB.prepare(
      `INSERT INTO dj_profiles (id, user_id, handle, display_name, bio, location, published, created_ms, updated_ms, last_activity_ms)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         display_name=excluded.display_name,
         bio=excluded.bio,
         location=excluded.location,
         published=1,
         updated_ms=excluded.updated_ms,
         last_activity_ms=excluded.last_activity_ms
       WHERE dj_profiles.user_id=?`
    ).bind(randHex(16), user.id, handle, displayName, bio, location, now, now, now, user.id).run();
  } catch (e) {
    const msg = String(e?.message || e || "");
    if (/unique|constraint|dj_profiles\.handle/i.test(msg)) return jsonResp(409, { error: "handle taken" });
    throw e;
  }

  const row = await env.DB.prepare("SELECT * FROM dj_profiles WHERE user_id=? LIMIT 1").bind(user.id).first();
  const finalHandle = normalizeHandle(row?.handle || handle);
  return jsonResp(200, { ok: true, handle: finalHandle, url: `${SITE_ORIGIN}/@${finalHandle}` });
}

// Confirm the account username (the /welcome soft-gate action). Keeping the same
// handle just stamps handle_confirmed_ms (so the gate stops firing); a different
// handle renames via changeHandle (retiring the old one) and stamps confirmed.
async function handleConfirmApi(request, env) {
  if (request.method !== "POST") return jsonResp(405, { error: "POST required" });
  if (!env.DB) return jsonResp(503, { error: "profiles db not configured" });
  const user = await getSessionUser(env, request);
  if (!user) return jsonResp(401, { error: "sign in required" });
  const body = await readJson(request, 1024);
  if (!body) return READ_JSON_TOO_LARGE.has(request) ? jsonResp(413, { error: "too large" }) : jsonResp(400, { error: "bad json" });

  const handle = normalizeHandle(body.handle);
  if (!handle) return jsonResp(400, { error: "invalid username" });
  if (RESERVED_HANDLES.has(handle)) return jsonResp(409, { error: "that username is reserved" });

  const now = nowMs();
  const profile = await ensureUserDjProfile(env, user, now);
  const redirect = safeRedirectPath(body.redirect || "/account") || "/account";
  const current = normalizeHandle(profile.handle);

  if (handle === current) {
    await env.DB.prepare(
      "UPDATE dj_profiles SET handle_confirmed_ms=COALESCE(handle_confirmed_ms, ?), updated_ms=? WHERE id=?"
    ).bind(now, now, profile.id).run();
    return jsonResp(200, { ok: true, handle, redirect });
  }

  const res = await changeHandle(env, profile, user, handle, now);
  if (res.error) return jsonResp(res.status || 409, { error: res.error });
  return jsonResp(200, { ok: true, handle, redirect });
}

// Account-level identity editor (distinct from /profile/edit's public bio/socials
// surface): change the username (changeHandle) and/or display_name.
async function settingsApi(request, env) {
  if (request.method !== "POST") return jsonResp(405, { error: "POST required" });
  if (!env.DB) return jsonResp(503, { error: "profiles db not configured" });
  const user = await getSessionUser(env, request);
  if (!user) return jsonResp(401, { error: "sign in required" });
  const body = await readJson(request, 2048);
  if (!body) return READ_JSON_TOO_LARGE.has(request) ? jsonResp(413, { error: "too large" }) : jsonResp(400, { error: "bad json" });

  const now = nowMs();
  const profile = await ensureUserDjProfile(env, user, now);

  if (Object.prototype.hasOwnProperty.call(body, "handle") && String(body.handle ?? "").trim() !== "") {
    const handle = normalizeHandle(body.handle);
    if (!handle) return jsonResp(400, { error: "invalid username" });
    if (handle !== normalizeHandle(profile.handle)) {
      const res = await changeHandle(env, profile, user, handle, now);
      if (res.error) return jsonResp(res.status || 409, { error: res.error });
    } else {
      await env.DB.prepare(
        "UPDATE dj_profiles SET handle_confirmed_ms=COALESCE(handle_confirmed_ms, ?), updated_ms=? WHERE id=?"
      ).bind(now, now, profile.id).run();
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "display_name")) {
    const displayName = clip(body.display_name, 80).trim() || defaultDisplayName(user);
    await env.DB.prepare(
      "UPDATE dj_profiles SET display_name=?, updated_ms=? WHERE id=? AND user_id=?"
    ).bind(displayName, now, profile.id, user.id).run();
  }

  const row = await env.DB.prepare("SELECT * FROM dj_profiles WHERE user_id=? LIMIT 1").bind(user.id).first();
  const finalHandle = normalizeHandle(row?.handle || profile.handle);
  return jsonResp(200, {
    ok: true,
    handle: finalHandle,
    display_name: row?.display_name || "",
    url: `${SITE_ORIGIN}/@${finalHandle}`,
  });
}

async function profileSocialsApi(request, env) {
  if (request.method !== "POST") return jsonResp(405, { error: "POST required" });
  if (!env.DB) return jsonResp(503, { error: "profiles db not configured" });
  const user = await getSessionUser(env, request);
  if (!user) return jsonResp(401, { error: "sign in required" });
  const body = await readJson(request, 4096);
  if (!body) return READ_JSON_TOO_LARGE.has(request) ? jsonResp(413, { error: "too large" }) : jsonResp(400, { error: "bad json" });

  const existing = await env.DB.prepare("SELECT * FROM dj_profiles WHERE user_id=? LIMIT 1").bind(user.id).first();
  if (!existing) return jsonResp(404, { error: "profile not found" });
  const keys = ["website_url", "instagram_url", "soundcloud_url", "spotify_url"];
  const next = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      const clean = cleanProfileUrl(body[key]);
      if (clean == null) return jsonResp(400, { error: `bad ${key}` });
      next[key] = clean;
    } else {
      next[key] = existing[key] || "";
    }
  }

  const now = nowMs();
  await env.DB.prepare(
    `UPDATE dj_profiles
     SET website_url=?, instagram_url=?, soundcloud_url=?, spotify_url=?, updated_ms=?
     WHERE user_id=?`
  ).bind(next.website_url, next.instagram_url, next.soundcloud_url, next.spotify_url, now, user.id).run();
  return jsonResp(200, { ok: true, ...next });
}

async function userDjProfile(env, user) {
  if (!env?.DB || !user?.id) return null;
  return await env.DB.prepare("SELECT * FROM dj_profiles WHERE user_id=? LIMIT 1").bind(user.id).first();
}

function cleanEventFields(body, existing = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body || {}, k);
  const textSpecs = [
    ["title", 200],
    ["host", 80],
    ["timezone", 80],
    ["location_name", 200],
    ["location_address", 300],
    ["tagline", 200],
    ["about", 4000],
  ];
  const out = {};
  const provided = [];
  for (const [key, len] of textSpecs) {
    if (has(key)) {
      out[key] = clip(body[key], len);
      provided.push(key);
    } else if (existing && Object.prototype.hasOwnProperty.call(existing, key)) {
      out[key] = existing[key];
    }
  }
  for (const key of ["scheduled_at_ms", "end_at_ms"]) {
    if (has(key)) {
      const raw = body[key];
      if (raw == null || raw === "") {
        out[key] = null;
      } else {
        const n = Number(raw);
        if (!Number.isSafeInteger(n) || n < 0) return { error: `bad ${key}` };
        out[key] = n;
      }
      provided.push(key);
    } else if (existing && Object.prototype.hasOwnProperty.call(existing, key)) {
      out[key] = existing[key];
    }
  }
  if (has("visibility")) {
    const visibility = String(body.visibility || "");
    if (visibility !== "public" && visibility !== "unlisted") return { error: "bad visibility" };
    out.visibility = visibility;
    provided.push("visibility");
  } else if (existing && Object.prototype.hasOwnProperty.call(existing, "visibility")) {
    out.visibility = existing.visibility;
  }
  if (has("rsvp_enabled")) {
    const rsvpEnabled = Number(body.rsvp_enabled);
    if (!Number.isInteger(rsvpEnabled) || (rsvpEnabled !== 0 && rsvpEnabled !== 1)) {
      return { error: "bad rsvp_enabled" };
    }
    out.rsvp_enabled = rsvpEnabled;
    provided.push("rsvp_enabled");
  } else if (existing && Object.prototype.hasOwnProperty.call(existing, "rsvp_enabled")) {
    out.rsvp_enabled = existing.rsvp_enabled;
  }
  return { values: out, provided };
}

async function resolveWebEventSlug(env, body, title) {
  const raw = String(body?.slug || "").trim();
  if (raw) {
    if (!SLUG_RE.test(raw)) return { error: "bad slug" };
    const existing = await env.DB.prepare("SELECT slug FROM events WHERE slug=?").bind(raw).first();
    if (existing) return { error: "slug taken", status: 409 };
    if (await slugReservedByAlias(env, raw, "")) return { error: "slug reserved", status: 409 };
    return { slug: raw };
  }

  const base = slugifyTitle(title).slice(0, 43).replace(/-+$/g, "") || "event";
  for (let i = 0; i < 8; i += 1) {
    const suffix = i === 0 ? "" : `-${randHex(2)}`;
    const slug = (base.slice(0, 48 - suffix.length).replace(/-+$/g, "") || "event") + suffix;
    const existing = await env.DB.prepare("SELECT slug FROM events WHERE slug=?").bind(slug).first();
    if (!existing && !(await slugReservedByAlias(env, slug, ""))) return { slug };
  }
  return { error: "slug taken", status: 409 };
}

async function createEventApi(request, env) {
  if (request.method !== "POST") return jsonResp(405, { error: "POST required" });
  if (!env.DB) return jsonResp(503, { error: "events db not configured" });
  const user = await getSessionUser(env, request);
  if (!user) return jsonResp(401, { error: "sign in required" });
  const profile = await userDjProfile(env, user);
  if (!profile) return jsonResp(400, { error: "create a DJ profile first", redirect: "/profile/edit" });
  const body = await readJson(request, 8192);
  if (!body) return READ_JSON_TOO_LARGE.has(request) ? jsonResp(413, { error: "too large" }) : jsonResp(400, { error: "bad json" });

  const cleaned = cleanEventFields(body, { visibility: "public", rsvp_enabled: 1 });
  if (cleaned.error) return jsonResp(400, { error: cleaned.error });
  const title = clip(cleaned.values.title, 200).trim();
  if (!title) return jsonResp(400, { error: "bad title" });
  const slugResult = await resolveWebEventSlug(env, body, title);
  if (slugResult.error) return jsonResp(slugResult.status || 400, { error: slugResult.error });

  const now = nowMs();
  const scheduledAt = cleaned.values.scheduled_at_ms ?? null;
  const locationName = cleaned.values.location_name || "";
  const locationAddress = cleaned.values.location_address || "";
  const whereTxt = clip(locationName || locationAddress, 160);
  const starts = scheduledAt == null ? "" : fmtWhen(scheduledAt);
  try {
    await env.DB.prepare(
      `INSERT INTO events (slug, install_id, owner_user_id, dj_profile_id, title, host, starts, scheduled_at_ms, end_at_ms, timezone, where_txt, location_name, location_address, tagline, about, visibility, rsvp_enabled, status, source, created_ms, updated_ms, last_activity_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      slugResult.slug, "", user.id, profile.id, title, cleaned.values.host || "", starts, scheduledAt,
      cleaned.values.end_at_ms ?? null, cleaned.values.timezone || "", whereTxt, locationName, locationAddress,
      cleaned.values.tagline || "", cleaned.values.about || "", cleaned.values.visibility || "public",
      Number(cleaned.values.rsvp_enabled ?? 1), "upcoming", "web", now, now, now
    ).run();
  } catch (e) {
    const msg = String(e?.message || e || "");
    if (/unique|constraint|events\.slug/i.test(msg)) return jsonResp(409, { error: "slug taken" });
    throw e;
  }
  await bumpDjProfileActivity(env, profile.id, now);
  return jsonResp(200, { ok: true, slug: slugResult.slug, url: `${SITE_ORIGIN}/e/${slugResult.slug}` });
}

async function updateEventApi(request, env, slug) {
  if (request.method !== "POST") return jsonResp(405, { error: "POST required" });
  if (!env.DB) return jsonResp(503, { error: "events db not configured" });
  const user = await getSessionUser(env, request);
  if (!user) return jsonResp(401, { error: "sign in required" });
  const profile = await userDjProfile(env, user);
  if (!profile) return jsonResp(400, { error: "create a DJ profile first", redirect: "/profile/edit" });
  const owner = await env.DB.prepare("SELECT owner_user_id FROM events WHERE slug=?").bind(slug).first();
  if (!owner) return jsonResp(404, { error: "event not found" });
  if (owner.owner_user_id !== user.id) return jsonResp(403, { error: "not your event" });
  const body = await readJson(request, 8192);
  if (!body) return READ_JSON_TOO_LARGE.has(request) ? jsonResp(413, { error: "too large" }) : jsonResp(400, { error: "bad json" });

  const cleaned = cleanEventFields(body);
  if (cleaned.error) return jsonResp(400, { error: cleaned.error });
  if (cleaned.provided.includes("title") && !String(cleaned.values.title || "").trim()) {
    return jsonResp(400, { error: "bad title" });
  }
  const hasSlug = Object.prototype.hasOwnProperty.call(body, "slug");
  const nextSlug = hasSlug ? String(body.slug || "").trim() : slug;
  if (hasSlug) {
    if (!SLUG_RE.test(nextSlug)) return jsonResp(400, { error: "bad slug" });
    if (nextSlug !== slug) {
      const existing = await env.DB.prepare("SELECT slug FROM events WHERE slug=?").bind(nextSlug).first();
      if (existing) return jsonResp(409, { error: "slug taken" });
      if (await slugReservedByAlias(env, nextSlug, slug)) return jsonResp(409, { error: "slug reserved" });
      if (await eventRenameBlocked(env, slug)) return jsonResp(409, { error: "event with activity cannot be renamed" });
    }
  }
  const cols = [];
  const vals = [];
  if (nextSlug !== slug) {
    cols.push("slug=?");
    vals.push(nextSlug);
  }
  const map = {
    title: "title",
    host: "host",
    scheduled_at_ms: "scheduled_at_ms",
    end_at_ms: "end_at_ms",
    timezone: "timezone",
    location_name: "location_name",
    location_address: "location_address",
    tagline: "tagline",
    about: "about",
    visibility: "visibility",
    rsvp_enabled: "rsvp_enabled",
  };
  for (const key of cleaned.provided) {
    cols.push(`${map[key]}=?`);
    vals.push(key === "title" ? String(cleaned.values[key] || "").trim() : cleaned.values[key]);
  }
  if (Object.prototype.hasOwnProperty.call(cleaned.values, "scheduled_at_ms")) {
    cols.push("starts=?");
    vals.push(cleaned.values.scheduled_at_ms == null ? "" : fmtWhen(cleaned.values.scheduled_at_ms));
  }
  if (Object.prototype.hasOwnProperty.call(cleaned.values, "location_name") ||
      Object.prototype.hasOwnProperty.call(cleaned.values, "location_address")) {
    const existing = await env.DB.prepare("SELECT location_name, location_address FROM events WHERE slug=?").bind(slug).first();
    const locationName = Object.prototype.hasOwnProperty.call(cleaned.values, "location_name")
      ? cleaned.values.location_name
      : (existing?.location_name || "");
    const locationAddress = Object.prototype.hasOwnProperty.call(cleaned.values, "location_address")
      ? cleaned.values.location_address
      : (existing?.location_address || "");
    cols.push("where_txt=?");
    vals.push(clip(locationName || locationAddress, 160));
  }
  const now = nowMs();
  cols.push("updated_ms=?", "last_activity_ms=?");
  vals.push(now, now);
  await env.DB.prepare(
    `UPDATE events SET ${cols.join(", ")} WHERE slug=? AND owner_user_id=?`
  ).bind(...vals, slug, user.id).run();
  if (nextSlug !== slug) {
    await recordEventAlias(env, slug, nextSlug, now, { owner_user_id: user.id });
  }
  await bumpDjProfileActivity(env, profile.id, now);
  return jsonResp(200, { ok: true });
}

async function newEventResponse(request, env) {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
  }
  const user = await getSessionUser(env, request);
  if (!user) return redirectResp("/login?redirect=/events/new");
  const profile = await userDjProfile(env, user);
  if (!profile) {
    const body = `<div class="page">
      <div class="card authcard">
        <h1 style="font-size:30px;letter-spacing:-.03em;margin:0 0 6px">Create event</h1>
        <p class="sub">Create your DJ profile first, then add your event.</p>
        <div class="ecta"><a class="btn" href="/profile/edit">Create DJ profile</a></div>
      </div>
    </div>
    <footer><span>🕺 partyparty</span><span>Signed in as ${esc(user.email || "")}</span></footer>`;
    return new Response(shell({
      title: "Create event · partyparty",
      desc: "Create your partyparty event.",
      ogImage: DEFAULT_OG_IMAGE,
      url: "/events/new",
      body,
    }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  const body = `<div class="page">
    <div class="card authcard">
      <h1 style="font-size:30px;letter-spacing:-.03em;margin:0 0 6px">Create event</h1>
      <p class="sub">Signed in as ${esc(user.email || "")}</p>
      <form class="authform" id="event-form">
        <label><span>Title</span><input name="title" maxlength="200" required placeholder="Rooftop Sessions"></label>
        <label><span>Slug</span><input name="slug" maxlength="48" autocomplete="off" placeholder="rooftop-sessions"></label>
        <label><span>Date and time</span><input name="starts_at" type="datetime-local"></label>
        <label><span>Timezone</span><input name="timezone" maxlength="80" placeholder="America/Los_Angeles"></label>
        <label><span>Location name</span><input name="location_name" maxlength="200" placeholder="Mission Roof"></label>
        <label><span>Location address</span><input name="location_address" maxlength="300" placeholder="123 Party St"></label>
        <label><span>Tagline</span><input name="tagline" maxlength="200" placeholder="House, disco and sunset edits"></label>
        <label><span>Description</span><textarea name="about" maxlength="4000"></textarea></label>
        <label class="checkrow"><input name="visibility" type="checkbox" checked><span>Public</span></label>
        <label class="checkrow"><input name="rsvp_enabled" type="checkbox" checked><span>RSVP enabled</span></label>
        <div class="ecta"><button class="btn" type="submit">Create event</button><a class="btn lt" href="/account">Cancel</a></div>
      </form>
      <p class="hint" id="event-msg" role="status" style="margin:14px 0 0"></p>
      <div id="event-link" style="margin-top:14px"></div>
    </div>
  </div>
  <script>
(function(){var f=document.getElementById('event-form'),m=document.getElementById('event-msg'),l=document.getElementById('event-link');if(!f)return;f.addEventListener('submit',function(ev){ev.preventDefault();m.textContent='';l.innerHTML='';var starts=f.elements.starts_at.value;var body={title:f.elements.title.value,slug:f.elements.slug.value,timezone:f.elements.timezone.value,location_name:f.elements.location_name.value,location_address:f.elements.location_address.value,tagline:f.elements.tagline.value,about:f.elements.about.value,visibility:f.elements.visibility.checked?'public':'unlisted',rsvp_enabled:f.elements.rsvp_enabled.checked?1:0};if(starts)body.scheduled_at_ms=new Date(starts).getTime();fetch('/api/events',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return {ok:r.ok,json:j}})}).then(function(out){if(!out.ok)throw new Error(out.json&&out.json.error||'create failed');m.textContent='Created.';var a=document.createElement('a');a.className='btn lt';a.href='/e/'+out.json.slug;a.textContent='View /e/'+out.json.slug;l.appendChild(a)}).catch(function(e){m.textContent=e&&e.message?e.message:'Could not create event.'})})})();
  </script>
  <footer><span>🕺 partyparty</span><span>Signed in as ${esc(user.email || "")}</span></footer>`;
  return new Response(shell({
    title: "Create event · partyparty",
    desc: "Create your partyparty event.",
    ogImage: DEFAULT_OG_IMAGE,
    url: "/events/new",
    body,
  }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// Owner-only edit form over the existing POST /api/events/<slug> update API.
async function editEventResponse(request, env, slug) {
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
  const noStore = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
  if (!env.DB) return new Response(renderNotFound(), { status: 503, headers: noStore });
  const user = await getSessionUser(env, request);
  if (!user) return redirectResp(`/login?redirect=${encodeURIComponent("/e/" + slug + "/edit")}`);
  const ev = await env.DB.prepare("SELECT * FROM events WHERE slug=?").bind(slug).first();
  if (!ev) return new Response(renderNotFound(), { status: 404, headers: noStore });
  if (ev.owner_user_id !== user.id) {
    return new Response(shell({
      title: "Not your event · partyparty", desc: "", ogImage: DEFAULT_OG_IMAGE, url: "/e/" + slug + "/edit",
      body: `<div class="page"><div class="card authcard"><h1 style="font-size:30px;letter-spacing:-.03em;margin:0 0 6px">Not your event</h1><p class="sub">You can only edit events on your own account.</p><div class="ecta"><a class="btn lt sm" href="/e/${esc(slug)}">View event</a></div></div></div>`,
    }), { status: 403, headers: noStore });
  }
  const evData = {
    title: ev.title || "", timezone: ev.timezone || "", location_name: ev.location_name || "",
    location_address: ev.location_address || "", tagline: ev.tagline || "", about: ev.about || "",
    visibility: ev.visibility || "public", rsvp_enabled: Number(ev.rsvp_enabled) ? 1 : 0,
    scheduled_at_ms: Number(ev.scheduled_at_ms) || null,
  };
  const evJson = JSON.stringify(evData).replace(/</g, "\\u003c");
  const body = `<div class="page">
    <div class="card authcard">
      <h1 style="font-size:30px;letter-spacing:-.03em;margin:0 0 6px">Edit event</h1>
      <p class="sub">/e/${esc(slug)} · signed in as ${esc(user.email || "")}</p>
      <form class="authform" id="event-form">
        <label><span>Title</span><input name="title" maxlength="200" required></label>
        <label><span>Date and time</span><input name="starts_at" type="datetime-local"></label>
        <label><span>Timezone</span><input name="timezone" maxlength="80" placeholder="America/Los_Angeles"></label>
        <label><span>Location name</span><input name="location_name" maxlength="200"></label>
        <label><span>Location address</span><input name="location_address" maxlength="300"></label>
        <label><span>Tagline</span><input name="tagline" maxlength="200"></label>
        <label><span>Description</span><textarea name="about" maxlength="4000"></textarea></label>
        <label class="checkrow"><input name="visibility" type="checkbox"><span>Public</span></label>
        <label class="checkrow"><input name="rsvp_enabled" type="checkbox"><span>RSVP enabled</span></label>
        <div class="ecta"><button class="btn" type="submit">Save changes</button><a class="btn lt" href="/e/${esc(slug)}">Cancel</a></div>
      </form>
      <p class="hint" id="event-msg" role="status" style="margin:14px 0 0"></p>
    </div>
  </div>
  <script>
var EV = ${evJson};
(function(){var f=document.getElementById('event-form');if(!f)return;f.elements.title.value=EV.title||'';f.elements.timezone.value=EV.timezone||'';f.elements.location_name.value=EV.location_name||'';f.elements.location_address.value=EV.location_address||'';f.elements.tagline.value=EV.tagline||'';f.elements.about.value=EV.about||'';f.elements.visibility.checked=EV.visibility!=='unlisted';f.elements.rsvp_enabled.checked=!!EV.rsvp_enabled;if(EV.scheduled_at_ms){var d=new Date(EV.scheduled_at_ms),p=function(n){return (n<10?'0':'')+n};f.elements.starts_at.value=d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes())}
var m=document.getElementById('event-msg');f.addEventListener('submit',function(ev){ev.preventDefault();m.textContent='Saving...';var starts=f.elements.starts_at.value;var body={title:f.elements.title.value,timezone:f.elements.timezone.value,location_name:f.elements.location_name.value,location_address:f.elements.location_address.value,tagline:f.elements.tagline.value,about:f.elements.about.value,visibility:f.elements.visibility.checked?'public':'unlisted',rsvp_enabled:f.elements.rsvp_enabled.checked?1:0};body.scheduled_at_ms=starts?new Date(starts).getTime():null;fetch('/api/events/${esc(slug)}',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){return {ok:r.ok,json:j}})}).then(function(out){if(!out.ok)throw new Error(out.json&&out.json.error||'save failed');m.textContent='Saved.';setTimeout(function(){location.href='/e/${esc(slug)}'},500)}).catch(function(e){m.textContent=e&&e.message?e.message:'Could not save.'})})})();
  </script>
  <footer><span>🕺 partyparty</span><span>Signed in as ${esc(user.email || "")}</span></footer>`;
  return new Response(shell({
    title: `Edit ${evData.title || slug} · partyparty`,
    desc: "Edit your partyparty event.",
    ogImage: DEFAULT_OG_IMAGE,
    url: "/e/" + slug + "/edit",
    body,
  }), { headers: noStore });
}

async function profileEditResponse(request, env) {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
  }
  const user = await getSessionUser(env, request);
  if (!user) return redirectResp("/login?redirect=/profile/edit");
  const profile = env.DB
    ? await env.DB.prepare("SELECT * FROM dj_profiles WHERE user_id=? LIMIT 1").bind(user.id).first()
    : null;
  const handle = normalizeHandle(profile?.handle);
  const profileUrl = handle ? `/@${handle}` : "";
  const body = `<div class="page">
    <div class="card authcard">
      <h1 style="font-size:30px;letter-spacing:-.03em;margin:0 0 6px">DJ profile</h1>
      <p class="sub">${handle ? `Editing @${esc(handle)}` : "Create your public DJ profile."}</p>
      <form class="authform" id="profile-form">
        <label><span>Handle</span><input name="handle" maxlength="30" autocomplete="off" required value="${esc(handle)}" placeholder="dj.name"></label>
        <label><span>Display name</span><input name="display_name" maxlength="80" autocomplete="name" value="${esc(profile?.display_name || defaultDisplayName(user))}"></label>
        <label><span>Bio</span><textarea name="bio" maxlength="500">${esc(profile?.bio || "")}</textarea></label>
        <label><span>Location</span><input name="location" maxlength="80" autocomplete="address-level2" value="${esc(profile?.location || "")}"></label>
        <label><span>Website</span><input name="website_url" type="url" value="${esc(profile?.website_url || "")}"></label>
        <label><span>Instagram</span><input name="instagram_url" type="url" value="${esc(profile?.instagram_url || "")}"></label>
        <label><span>SoundCloud</span><input name="soundcloud_url" type="url" value="${esc(profile?.soundcloud_url || "")}"></label>
        <label><span>Spotify</span><input name="spotify_url" type="url" value="${esc(profile?.spotify_url || "")}"></label>
        <div class="ecta"><button class="btn" type="submit">Save profile</button>${profileUrl ? `<a class="btn lt" id="profile-link" href="${esc(profileUrl)}">View /@${esc(handle)}</a>` : `<a class="btn lt" id="profile-link" href="#" style="display:none"></a>`}</div>
      </form>
      <p class="hint" id="profile-msg" role="status" style="margin:14px 0 0"></p>
    </div>
  </div>
  <script>
(function(){var f=document.getElementById('profile-form'),m=document.getElementById('profile-msg'),l=document.getElementById('profile-link');if(!f)return;function values(names){var out={};names.forEach(function(n){out[n]=f.elements[n].value});return out}f.addEventListener('submit',function(ev){ev.preventDefault();m.textContent='';var core=values(['handle','display_name','bio','location']),socials=values(['website_url','instagram_url','soundcloud_url','spotify_url']);fetch('/api/profile',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(core)}).then(function(r){return r.json().then(function(j){return {ok:r.ok,json:j}})}).then(function(out){if(!out.ok)throw new Error(out.json&&out.json.error||'save failed');return fetch('/api/profile/socials',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(socials)}).then(function(r){return r.json().then(function(j){return {ok:r.ok,json:j,core:out.json}})})}).then(function(out){if(!out.ok)throw new Error(out.json&&out.json.error||'save failed');m.textContent='Saved.';if(l&&out.core&&out.core.handle){l.href='/@'+out.core.handle;l.textContent='View /@'+out.core.handle;l.style.display='inline-flex'}}).catch(function(e){m.textContent=e&&e.message?e.message:'Could not save profile.'})})})();
  </script>
  <footer><span>🕺 partyparty</span><span>Signed in as ${esc(user.email || "")}</span></footer>`;
  return new Response(shell({
    title: "DJ profile · partyparty",
    desc: "Create or edit your partyparty DJ profile.",
    ogImage: DEFAULT_OG_IMAGE,
    url: "/profile/edit",
    body,
  }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function loginResponse(request, env) {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
  }
  const redirectPath = safeRedirectPath(new URL(request.url).searchParams.get("redirect") || "/account");
  const user = await getSessionUser(env, request);
  if (user) return redirectResp(redirectPath || "/account");
  // The admin passcode is a support/dev fallback, not a consumer affordance — only
  // surface it when explicitly asked for via /login?admin=1.
  const showAdmin = new URL(request.url).searchParams.get("admin") != null;
  const adminField = showAdmin
    ? `<details open><summary>Admin passcode</summary><input type="password" name="devSecret" autocomplete="off" placeholder="Admin passcode" aria-label="Admin passcode"></details>`
    : "";
  const oauthRedirect = encodeURIComponent(redirectPath || "/account");
  const oauthBtnStyle = "display:block;width:100%;box-sizing:border-box;text-align:center;margin:0 0 8px";
  const hasGoogle = hasGoogleProvider(env);
  const hasApple = hasAppleProvider(env);
  const emailConfigured = authEmailConfigured(env);
  const providersAvailable = hasGoogle || hasApple || emailConfigured;
  if (!providersAvailable && !showAdmin) {
    const adminUrl = `/login?admin=1&redirect=${encodeURIComponent(redirectPath || "/account")}`;
    const body = `<div class="page">
    <div class="card authcard">
      <h1 style="font-size:30px;letter-spacing:-.03em;margin:0 0 6px">Sign in</h1>
      <p class="sub">No self-serve sign-in methods are configured for this partyparty server.</p>
      <div class="minirow" style="margin-top:14px">
        <b>Older app version only</b>
        <span>If you are already signed in, open Account and use Link your Mac → Older app version only to generate a one-time code.</span>
        <a class="btn lt sm" href="/account">Open account linking</a>
      </div>
      <p class="hint" style="margin:14px 0 0">Recovery: ask the site owner to enable Google, Apple, or MXroute SMTP sign-in, or use the admin passcode recovery link.</p>
      <div class="ecta"><a class="btn lt sm" href="${esc(adminUrl)}">Admin recovery</a></div>
    </div>
  </div>
  <footer><span>🕺 partyparty</span><span>Account access</span></footer>`;
    return new Response(shell({
      title: "Sign in · partyparty",
      desc: "Sign in to your partyparty account.",
      ogImage: DEFAULT_OG_IMAGE,
      url: "/login",
      body,
    }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  const providerBtns = [
    hasGoogle
      ? `<a class="btn lt" style="${oauthBtnStyle}" href="/auth/google?redirect=${oauthRedirect}">Continue with Google</a>`
      : "",
    hasApple
      ? `<a class="btn lt" style="${oauthBtnStyle}" href="/auth/apple?redirect=${oauthRedirect}"> Continue with Apple</a>`
      : "",
  ].filter(Boolean).join("");
  const showEmailForm = emailConfigured || showAdmin;
  const providerBlock = providerBtns && showEmailForm
    ? `<div style="margin:0 0 12px">${providerBtns}</div>
       <div style="display:flex;align-items:center;gap:10px;color:var(--ink3);font-size:12px;margin:0 0 14px"><span style="flex:1;height:1px;background:var(--line)"></span>or use email<span style="flex:1;height:1px;background:var(--line)"></span></div>`
    : providerBtns
      ? `<div style="margin:0 0 12px">${providerBtns}</div>`
    : "";
  const emailSub = showEmailForm && providerBtns
    ? "We will send a sign-in link to your email."
    : showEmailForm
      ? "Enter your email and we will send a sign-in link."
      : "Choose a sign-in provider to continue.";
  const emailForm = showEmailForm ? `<form class="authform" id="login-form">
        <input type="email" name="email" autocomplete="email" required placeholder="you@example.com" aria-label="Email">
        ${adminField}
        <button class="btn" type="submit">Send sign-in link</button>
      </form>
      <p class="hint" id="login-msg" role="status" style="margin:14px 0 0"></p>
      <div id="login-dev" style="margin-top:14px"></div>` : "";
  const body = `<div class="page">
    <div class="card authcard">
      <h1 style="font-size:30px;letter-spacing:-.03em;margin:0 0 6px">Sign in</h1>
      <p class="sub">${emailSub}</p>
      <p class="hint" style="margin:0 0 14px">New to partyparty? Your account is created automatically the first time you sign in — nothing to fill out.</p>
      ${providerBlock}
      ${emailForm}
    </div>
  </div>
  <script>
(function(){var f=document.getElementById('login-form'),m=document.getElementById('login-msg'),d=document.getElementById('login-dev'),redirect=${JSON.stringify(redirectPath)};if(!f)return;f.addEventListener('submit',function(ev){ev.preventDefault();m.textContent='';d.innerHTML='';var email=f.elements.email.value,secret=f.elements.devSecret?f.elements.devSecret.value:'',h={'content-type':'application/json'};if(secret)h['x-auth-dev-secret']=secret;fetch('/api/auth/request-link',{method:'POST',credentials:'same-origin',headers:h,body:JSON.stringify({email:email,redirect:redirect})}).then(function(r){return r.json().then(function(j){return {ok:r.ok,json:j}})}).then(function(out){if(!out.ok){m.textContent='Could not send a sign-in link. Check the email and try again.';return}if(out.json&&out.json.redirect){m.textContent='Signing in...';location.href=out.json.redirect;return}if(out.json&&out.json.devLink){m.textContent='Admin sign-in link ready.';var a=document.createElement('a');a.className='btn lt';a.href=out.json.devLink;a.textContent='Continue';d.appendChild(a);return}if(out.json&&out.json.queued===false){m.textContent='Email sign-in is temporarily unavailable. Use the admin passcode or try again later.';return}m.textContent='Check your email for your sign-in link.'}).catch(function(){m.textContent='Could not send a sign-in link. Try again.'})})})();
  </script>
  <footer><span>🕺 partyparty</span><span>Account access</span></footer>`;
  return new Response(shell({
    title: "Sign in · partyparty",
    desc: "Sign in to your partyparty account.",
    ogImage: DEFAULT_OG_IMAGE,
    url: "/login",
    body,
  }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// The username soft-gate. Every account gets a dj_profile at sign-in; until the
// handle is confirmed, sign-in lands here (carrying ?redirect). Confirmed users
// may revisit to review, but they are not auto-redirected here.
async function welcomeResponse(request, env) {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
  }
  const dest = safeRedirectPath(new URL(request.url).searchParams.get("redirect") || "/account") || "/account";
  const user = await getSessionUser(env, request);
  if (!user) {
    const self = `/welcome?redirect=${encodeURIComponent(dest)}`;
    return redirectResp(`/login?redirect=${encodeURIComponent(self)}`);
  }
  let profile = null;
  try { profile = await ensureUserDjProfile(env, user); } catch (_) { /* best effort */ }
  const handle = normalizeHandle(profile?.handle) || defaultHandle(user);
  const confirmed = !!(profile && profile.handle_confirmed_ms != null);
  const body = `<div class="page">
    <div class="card authcard">
      <h1 style="font-size:30px;letter-spacing:-.03em;margin:0 0 6px">Your username</h1>
      <p class="sub">This is your permanent party link. Guests scan or visit <b>${esc(handle)}.partyparty.party</b> to tune in — and it stays the same, forever. Pick it now; you can change it later in settings.</p>
      <form class="authform" id="welcome-form">
        <label><span>Username</span><input name="handle" id="welcome-handle" maxlength="30" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" required value="${esc(handle)}" placeholder="dj.name"></label>
        <p class="hint" id="welcome-avail" role="status" aria-live="polite" style="margin:2px 0 0;min-height:18px"></p>
        <button class="btn" id="welcome-save" type="submit">This is my username</button>
      </form>
      <p class="hint" id="welcome-msg" role="status" style="margin:14px 0 0"></p>
      ${confirmed ? `<p class="hint" style="margin:10px 0 0">Manage this any time in <a href="/settings">settings</a>.</p>` : ""}
    </div>
  </div>
  <script>
(function(){var f=document.getElementById('welcome-form'),i=document.getElementById('welcome-handle'),a=document.getElementById('welcome-avail'),m=document.getElementById('welcome-msg'),b=document.getElementById('welcome-save'),dest=${JSON.stringify(dest)},current=${JSON.stringify(handle)},t;
function norm(v){return String(v||'').trim().toLowerCase()}
function check(){var h=norm(i.value);a.textContent='';a.style.color='';if(!h){b.disabled=true;a.textContent='Pick a username.';return}if(h===current){b.disabled=false;return}b.disabled=true;a.textContent='Checking…';fetch('/api/handle-available?h='+encodeURIComponent(h),{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.json()}).then(function(j){if(norm(i.value)!==h)return;if(j&&j.available){b.disabled=false;a.style.color='var(--ok,#1a7f37)';a.textContent='✓ '+j.handle+' is available'}else{b.disabled=true;a.style.color='var(--bad,#b3261e)';a.textContent=j&&j.reason==='reserved'?'That username is reserved.':j&&j.reason==='invalid'?'Letters, numbers, dots and underscores only.':'That username is taken.'}}).catch(function(){})}
i.addEventListener('input',function(){clearTimeout(t);t=setTimeout(check,250)});check();
f.addEventListener('submit',function(ev){ev.preventDefault();m.textContent='';m.style.color='';b.disabled=true;fetch('/api/handle/confirm',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({handle:norm(i.value),redirect:dest})}).then(function(r){return r.json().then(function(j){return {ok:r.ok,json:j}})}).then(function(out){if(!out.ok){b.disabled=false;m.style.color='var(--bad,#b3261e)';m.textContent=out.json&&out.json.error?out.json.error:'Could not save your username.';return}location.href=out.json&&out.json.redirect?out.json.redirect:dest}).catch(function(){b.disabled=false;m.style.color='var(--bad,#b3261e)';m.textContent='Could not save your username.'})})})();
  </script>
  <footer><span>🕺 partyparty</span><span>Signed in as ${esc(user.email || "")}</span></footer>`;
  return new Response(shell({
    title: "Your username · partyparty",
    desc: "Choose your permanent partyparty username.",
    ogImage: DEFAULT_OG_IMAGE,
    url: "/welcome",
    body,
  }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// Account identity editor: username + display name (distinct from /profile/edit,
// which owns the public bio/photos/socials). Signed-in only.
async function settingsResponse(request, env) {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
  }
  const user = await getSessionUser(env, request);
  if (!user) return redirectResp("/login?redirect=/settings");
  let profile = null;
  try { profile = await ensureUserDjProfile(env, user); } catch (_) { /* best effort */ }
  const handle = normalizeHandle(profile?.handle) || defaultHandle(user);
  const displayName = profile?.display_name || defaultDisplayName(user);
  const body = `<div class="page">
    <div class="card authcard">
      <h1 style="font-size:30px;letter-spacing:-.03em;margin:0 0 6px">Settings</h1>
      <p class="sub">Your account identity. Your username is your permanent party link — guests visit <b>${esc(handle)}.partyparty.party</b>.</p>
      <form class="authform" id="settings-form">
        <label><span>Username</span><input name="handle" id="settings-handle" maxlength="30" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" required value="${esc(handle)}" placeholder="dj.name"></label>
        <p class="hint" id="settings-avail" role="status" aria-live="polite" style="margin:2px 0 0;min-height:18px"></p>
        <label><span>Display name</span><input name="display_name" id="settings-display" maxlength="80" autocomplete="name" value="${esc(displayName)}"></label>
        <div class="ecta"><button class="btn" id="settings-save" type="submit">Save</button><a class="btn lt" id="settings-view" href="/@${esc(handle)}">View /@${esc(handle)}</a></div>
      </form>
      <p class="hint" id="settings-msg" role="status" style="margin:14px 0 0"></p>
      <div class="minirow" style="margin-top:16px"><b>Public profile</b><span>Edit your bio, photos and social links.</span><a class="btn lt sm" href="/profile/edit">Edit public profile</a></div>
      <div class="ecta" style="margin-top:14px"><a class="btn lt sm" href="/account">Account</a><button class="btn lt sm" id="settings-signout" type="button">Sign out</button></div>
    </div>
  </div>
  <script>
(function(){var f=document.getElementById('settings-form'),i=document.getElementById('settings-handle'),a=document.getElementById('settings-avail'),m=document.getElementById('settings-msg'),b=document.getElementById('settings-save'),v=document.getElementById('settings-view'),current=${JSON.stringify(handle)},t;
function norm(v){return String(v||'').trim().toLowerCase()}
function check(){var h=norm(i.value);a.textContent='';a.style.color='';if(!h||h===current){b.disabled=false;return}b.disabled=true;a.textContent='Checking…';fetch('/api/handle-available?h='+encodeURIComponent(h),{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.json()}).then(function(j){if(norm(i.value)!==h)return;if(j&&j.available){b.disabled=false;a.style.color='var(--ok,#1a7f37)';a.textContent='✓ '+j.handle+' is available'}else{b.disabled=true;a.style.color='var(--bad,#b3261e)';a.textContent=j&&j.reason==='reserved'?'That username is reserved.':j&&j.reason==='invalid'?'Letters, numbers, dots and underscores only.':'That username is taken.'}}).catch(function(){})}
i.addEventListener('input',function(){clearTimeout(t);t=setTimeout(check,250)});
f.addEventListener('submit',function(ev){ev.preventDefault();m.textContent='';m.style.color='';b.disabled=true;fetch('/api/settings',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({handle:norm(i.value),display_name:document.getElementById('settings-display').value})}).then(function(r){return r.json().then(function(j){return {ok:r.ok,json:j}})}).then(function(out){b.disabled=false;if(!out.ok){m.style.color='var(--bad,#b3261e)';m.textContent=out.json&&out.json.error?out.json.error:'Could not save.';return}m.style.color='';m.textContent='Saved.';if(out.json&&out.json.handle){current=out.json.handle;i.value=out.json.handle;if(v){v.href='/@'+out.json.handle;v.textContent='View /@'+out.json.handle}}}).catch(function(){b.disabled=false;m.style.color='var(--bad,#b3261e)';m.textContent='Could not save.'})})})();
(function(){var b=document.getElementById('settings-signout');if(!b)return;b.addEventListener('click',function(){fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'}).finally(function(){location.href='/'})})})();
  </script>
  <footer><span>🕺 partyparty</span><span>Signed in as ${esc(user.email || "")}</span></footer>`;
  return new Response(shell({
    title: "Settings · partyparty",
    desc: "Your partyparty account identity.",
    ogImage: DEFAULT_OG_IMAGE,
    url: "/settings",
    body,
  }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function accountResponse(request, env) {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
  }
  const user = await getSessionUser(env, request);
  if (!user) return redirectResp("/login?redirect=/account");
  const [profile, installsRes, eventsRows] = await Promise.all([
    env.DB.prepare("SELECT * FROM dj_profiles WHERE user_id=? LIMIT 1").bind(user.id).first(),
    env.DB.prepare(
      `SELECT install_id, install_slug, label, linked_ms, last_seen_ms
       FROM device_installs WHERE user_id=? AND revoked_ms IS NULL
       ORDER BY COALESCE(last_seen_ms, linked_ms, 0) DESC LIMIT 20`
    ).bind(user.id).all(),
    env.DB.prepare(
      `SELECT slug, title, status, scheduled_at_ms, starts, where_txt, location_name
       FROM events
       WHERE owner_user_id=?
       ORDER BY COALESCE(scheduled_at_ms, published_ms, updated_ms, created_ms, 0) DESC, slug ASC
       LIMIT 6`
    ).bind(user.id).all(),
  ]);
  const handle = normalizeHandle(profile?.handle);
  const deviceInstalls = installsRes?.results || [];
  const events = eventsRows?.results || [];
  // A profile whose handle is still the auto-derived default hasn't been through
  // the /welcome soft-gate; nudge the DJ to lock in their permanent party link.
  const needsConfirm = !!(profile && profile.handle_confirmed_ms == null);
  const confirmNudge = needsConfirm ? `<div class="card" style="grid-column:1/-1">
    <div class="sectionhead" style="margin:0 0 8px"><div><h2>Confirm your username</h2><p>${handle ? `<b>${esc(handle)}.partyparty.party</b> is your permanent party link — confirm or change it.` : "Pick your permanent party link."}</p></div></div>
    <div class="ecta"><a class="btn sm" href="/welcome">Confirm username</a></div>
  </div>` : "";
  const profileCard = profile ? `<div class="card">
    <h2>DJ profile</h2>
    <p class="sub">${esc(profile.display_name || handle || "Your DJ profile")}</p>
    <p class="emptyline">${handle ? `@${esc(handle)}` : "Handle not set yet."}</p>
    <div class="ecta">
      ${handle ? `<a class="btn lt sm" href="/@${esc(handle)}">View profile</a>` : ""}
      <a class="btn lt sm" href="/settings">Settings</a>
      <a class="btn lt sm" href="/profile/edit">Edit profile</a>
    </div>
  </div>` : `<div class="card">
    <h2>DJ profile</h2>
    <p class="emptyline">You haven't created a DJ profile yet.</p>
    <div class="ecta"><a class="btn lt sm" href="/settings">Settings</a><a class="btn lt sm" href="/profile/edit">Create profile</a></div>
  </div>`;
  const eventList = events.length ? `<div>${events.map((ev) => {
    const when = ev.starts || fmtWhen(ev.scheduled_at_ms);
    const place = ev.location_name || ev.where_txt || "";
    return `<div class="minirow"><b>${esc(ev.title || ev.slug || "Untitled event")}</b><span>${esc([ev.status, when, place].filter(Boolean).join(" · "))}</span>${ev.slug ? `<a href="/e/${esc(ev.slug)}" style="color:var(--link);font-size:13px">View</a> <a href="/e/${esc(ev.slug)}/edit" style="color:var(--link);font-size:13px">Edit</a>` : ""}</div>`;
  }).join("")}</div>` : `<p class="emptyline">No owned events yet.</p>`;
  // Fallback-only: current apps link through the browser-token /link-mac flow.
  // Keep this paste-a-code path for older app versions and recovery cases.
  const linkMacCard = profile ? `<div class="card">
    <h2>Link your Mac</h2>
    <p class="emptyline">Open partyparty on your Mac and choose Sign in to link this Mac.</p>
    <details style="margin-top:12px">
      <summary class="emptyline" style="cursor:pointer">Older app version only</summary>
      <div class="ecta"><button class="btn lt sm" id="install-link-create" type="button">Generate code</button></div>
      <div id="install-link-out" class="minirow" style="display:none"></div>
    </details>
  </div>` : `<div class="card">
    <h2>Link your Mac</h2>
    <p class="emptyline">Open partyparty on your Mac and sign in from there. A profile will be created automatically.</p>
    <div class="ecta"><a class="btn lt sm" href="/login">Sign in here</a></div>
  </div>`;
  const deviceRows = deviceInstalls.length ? deviceInstalls.map((d) => {
    const name = d.label && String(d.label).trim() ? d.label : (d.install_slug ? "Mac · " + d.install_slug : "This Mac");
    const seen = d.last_seen_ms ? "Last seen " + fmtWhen(d.last_seen_ms) : (d.linked_ms ? "Linked " + fmtWhen(d.linked_ms) : "");
    return `<div class="minirow"><b>${esc(name)}</b><span>${esc(seen)}</span><button class="btn lt sm" data-unlink-install="${esc(d.install_id)}" type="button">Unlink</button></div>`;
  }).join("") : `<p class="emptyline">No Macs linked yet. Open partyparty on your Mac and sign in to link it.</p>`;
  const devicesCard = `<div class="card"><div class="sectionhead" style="margin:0 0 12px"><div><h2>Devices</h2><p>Macs linked to your account.</p></div></div>${deviceRows}<p class="hint" id="device-unlink-out" role="status"></p></div>`;
  const body = `<div class="page">
    <div class="card">
      <div class="accounthead">
        <div>
          <h1 style="font-size:30px;letter-spacing:-.03em;margin:0 0 6px">Account</h1>
          <p>${esc(user.email || "")}</p>
          <p>${esc(user.display_name || "")}</p>
        </div>
        <div class="ecta" style="margin:0"><a class="btn lt sm" href="/settings">Settings</a><button class="btn lt sm" id="sign-out" type="button">Sign out</button></div>
      </div>
    </div>
    <div class="accountgrid" style="margin-top:16px">
      ${confirmNudge}
      ${profileCard}
      ${devicesCard}
      ${linkMacCard}
      <div class="card" style="grid-column:1/-1"><div class="sectionhead" style="margin:0 0 12px"><div><h2>Owned events</h2></div><a class="btn sm" href="/events/new">＋ Create event</a></div>${eventList}</div>
    </div>
  </div>
  <script>
(function(){var b=document.getElementById('sign-out');if(!b)return;b.addEventListener('click',function(){fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'}).finally(function(){location.href='/'})})})();
(function(){var b=document.getElementById('install-link-create'),o=document.getElementById('install-link-out');if(!b||!o)return;b.addEventListener('click',function(){b.disabled=true;o.style.display='block';o.textContent='Generating...';fetch('/api/install-link/create',{method:'POST',credentials:'same-origin'}).then(function(r){return r.json().then(function(j){return {ok:r.ok,json:j}})}).then(function(out){if(!out.ok){o.textContent=out.json&&out.json.error?out.json.error:'Could not generate a code.';return}var code=String(out.json.code||''),safe=code.replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]});o.innerHTML='<b style="font-size:22px;letter-spacing:.08em;word-break:break-all">'+safe+'</b><span>Paste this code into the Mac app within 10 minutes.</span><button class="btn lt sm" id="install-link-copy" type="button">Copy</button>';var c=document.getElementById('install-link-copy');if(c)c.addEventListener('click',function(){if(navigator.clipboard)navigator.clipboard.writeText(code).then(function(){c.textContent='Copied'}).catch(function(){c.textContent='Copy failed'})})}).catch(function(){o.textContent='Could not generate a code.'}).finally(function(){b.disabled=false})})})();
(function(){var out=document.getElementById('device-unlink-out');document.querySelectorAll('[data-unlink-install]').forEach(function(b){b.addEventListener('click',function(){var id=b.getAttribute('data-unlink-install');b.disabled=true;if(out)out.textContent='Unlinking...';fetch('/api/install-link/unlink',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({install_id:id})}).then(function(r){return r.json().then(function(j){return {ok:r.ok,json:j}})}).then(function(o){if(!o.ok){if(out)out.textContent=o.json&&o.json.error?o.json.error:'Could not unlink.';b.disabled=false;return}if(out)out.textContent='Unlinked.';setTimeout(function(){location.reload()},400)}).catch(function(){if(out)out.textContent='Could not unlink.';b.disabled=false})})})})();
  </script>
  <footer><span>🕺 partyparty</span><span>Signed in as ${esc(user.email || "")}</span></footer>`;
  return new Response(shell({
    title: "Account · partyparty",
    desc: "Your partyparty account.",
    ogImage: DEFAULT_OG_IMAGE,
    url: "/account",
    body,
  }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

// eventFromRow projects a D1 events row (+ its latest ready set) into the shape
// renderEvent expects. A missing set yields an "upcoming" empty state.
function eventFromRow(row, set, slug, wall = {}, live = null) {
  const when = row.starts || (row.scheduled_at_ms ? fmtWhen(row.scheduled_at_ms) : "");
  const where = row.location_name || row.where_txt || row.location_address || "";
  return {
    slug,
    title: row.title || "A partyparty set",
    dj: row.host || "",
    when,
    where,
    // LIVE (the party is on right now — this page IS the off-Wi-Fi listen
    // surface) wins; otherwise drive the pill off whether a ready set exists,
    // not the D1 status column (which defaults to 'replay') — a set-less event
    // (cover/meta only) reads as "upcoming" for the empty-state card.
    status: live ? "live" : set ? "replay" : "upcoming",
    liveMirror: live?.mirror || "",
    lanUrl: live?.lanUrl || "",
    nowPlaying: live?.nowPlaying || "",
    listeners: live?.listeners || 0,
    tagline: row.tagline || "",
    cover: row.cover_key ? `/event/${slug}/cover.jpg` : "",
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

function renderGalleryMedia(slug, media) {
  if (!media?.length) return "";
  const items = media.map((m) => {
    const src = esc(mediaUrl(slug, m.id));
    const name = esc(m.name || "Guest media");
    if (m.media_type === "image") {
      return `<figure class="media-tile"><img loading="lazy" decoding="async" src="${src}" alt="${name}"><figcaption>${name}</figcaption></figure>`;
    }
    if (m.media_type === "video") {
      return `<figure class="media-tile"><video controls preload="metadata" playsinline src="${src}" aria-label="${name}"></video><figcaption>${name}</figcaption></figure>`;
    }
    return "";
  }).filter(Boolean).join("");
  return items ? `<div class="media-grid">${items}</div>` : "";
}

function renderSeedGallery(items) {
  if (!items?.length) return "";
  const html = items.map((src) => `<figure class="media-tile"><img loading="lazy" decoding="async" src="${esc(src)}" alt="Party photo"></figure>`).join("");
  return html ? `<div class="media-grid">${html}</div>` : "";
}

function renderPostAudio(slug, media) {
  if (!media?.length) return "";
  const items = media.map((m) => {
    if (m.media_type !== "audio") return "";
    const src = esc(mediaUrl(slug, m.id));
    return `<audio controls preload="none" src="${src}"></audio>`;
  }).filter(Boolean).join("");
  return items ? `<div class="tl-media">${items}</div>` : "";
}

function renderWallPost(post, slug, media, comments) {
  const isDj = Number(post.dj) === 1;
  const who = post.author || (isDj ? "DJ" : "Guest");
  const timeMs = post.activity_ms || post.created_ms || post.ts_ms;
  const timeText = fmtPostTime(timeMs);
  const datetime = safeIso(timeMs);
  const text = post.text ? `<p class="walltext">${esc(post.text)}</p>` : "";
  const commentHtml = comments.length ? `<div class="comments">${comments.map((c) => {
    const commentDj = Number(c.dj) === 1;
    return `<div class="comment">${c.emoji ? `<span>${esc(c.emoji)}</span> ` : ""}<b>${esc(c.author || (commentDj ? "DJ" : "Guest"))}</b> ${esc(c.text || "")}</div>`;
  }).join("")}</div>` : "";
  const audioHtml = renderPostAudio(slug, media);
  if (!text && !commentHtml && !audioHtml) return "";
  return `<article class="tl-entry">
    <div class="tl-dot${isDj ? " dj" : ""}" aria-hidden="true">${esc(post.emoji || "•")}</div>
    <div class="tl-body">
      <div class="tl-who"><b>${esc(who)}</b>${isDj ? `<span class="djchip">DJ</span>` : ""}${timeText && datetime ? `<time datetime="${esc(datetime)}">${esc(timeText)}</time>` : ""}</div>
      ${text}
      ${audioHtml}
      ${commentHtml}
    </div>
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

function renderEvent(e, opts = {}) {
  const soon = "Coming soon - event pages are in progress.";
  const ownerStrip = opts.isOwner && e.slug ? `<a class="btn ghost sm" href="/e/${esc(e.slug)}/edit">Edit</a>` : "";
  const statusPill = e.status === "live"
    ? `<span class="statuspill"><span class="dot"></span> Live · ${esc(e.listeners)} listening</span>`
    : e.status === "upcoming" ? `<span class="statuspill">Upcoming</span>`
    : `<span class="statuspill">Replay</span>`;
  const meta = [
    e.dj ? `<span><b>DJ</b>${esc(e.dj)}</span>` : "",
    e.when ? `<span><b>Date</b>${esc(e.when)}</span>` : "",
    e.where ? `<span><b>Place</b>${esc(e.where)}</span>` : "",
  ].filter(Boolean).join("");
  const eventMeta = meta ? `<div class="eventmeta">${meta}</div>` : "";
  const coverBlock = e.cover
    ? `<div class="eventcover"><img loading="eager" decoding="async" src="${esc(e.cover)}" alt="${esc(e.title)} cover"></div>`
    : `<div class="eventcover fallback" aria-hidden="true"><span>partyparty</span></div>`;

  // Live with a cloud mirror: the REAL off-Wi-Fi listen surface — plain <audio>
  // native HLS (locked-phone safe, same element as the LAN path) a few seconds
  // behind the room, plus the "at the party" LAN link. Live without a mirror
  // (or the demo seed) keeps the animated now-playing bar.
  const liveCard = e.status === "live" && e.liveMirror ? `
  <div class="card">
    <div class="livebar">
      <div class="eq"><i></i><i></i><i></i><i></i><i></i></div>
      <div class="np"><b>Live now</b><div>${esc(e.nowPlaying || e.tagline || "Streaming from the party")}</div></div>
      ${e.listeners ? `<div class="cnt"><b>${esc(e.listeners)}</b><span>listening, in sync</span></div>` : ""}
    </div>
    <audio id="pp-live-audio" preload="none" playsinline src="${esc(e.liveMirror)}"></audio>
    <button id="pp-live-play" type="button" class="btn" style="width:100%;margin-top:12px">Tap to listen</button>
    <!-- The same join ask as the LAN listener: name / emoji / optional email.
         Shown once at the first tap; a remembered guest skips straight to the
         music. Never gates playback ("Just listen" always works). -->
    <div id="pp-join" hidden style="margin-top:12px;display:grid;gap:10px">
      <div class="rsvpfields" style="grid-template-columns:64px minmax(0,1fr)">
        <button type="button" id="pp-join-emoji" class="btn lt sm" aria-label="Pick your emoji" style="font-size:20px;padding:8px 0">🕺</button>
        <input id="pp-join-name" maxlength="40" autocomplete="name" placeholder="Your name">
      </div>
      <div class="rsvpfields" style="grid-template-columns:1fr">
        <input id="pp-join-email" maxlength="120" type="email" inputmode="email" autocomplete="email" placeholder="Email (optional)">
      </div>
      <p class="cardhint" style="margin:0">The party host can send you updates — email is optional.</p>
      <button type="button" id="pp-join-go" class="btn" style="width:100%">Join &amp; listen</button>
      <button type="button" id="pp-join-skip" class="btn ghost sm" style="width:100%">Just listen</button>
      <p id="pp-join-err" class="cardhint" style="margin:0;color:#b3261e" hidden></p>
    </div>
    <div class="cardhint">Listening from away — a few seconds behind the room.${e.lanUrl ? ` <a href="${esc(e.lanUrl)}" style="font-weight:600">At the party? Join the live room &rarr;</a>` : ""}</div>
    <script>
    (function(){
      var a=document.getElementById('pp-live-audio'), b=document.getElementById('pp-live-play');
      if(!a||!b) return;
      var joinApi='/api/e/${encodeURIComponent(String(e.slug))}/join';
      var panel=document.getElementById('pp-join'), nameI=document.getElementById('pp-join-name'),
          emojiB=document.getElementById('pp-join-emoji'), emailI=document.getElementById('pp-join-email'),
          go=document.getElementById('pp-join-go'), skip=document.getElementById('pp-join-skip'),
          err=document.getElementById('pp-join-err');
      var EMOJI=['🕺','💃','🎧','🔥','✨','🪩','🎉','😎','🫶','🌊'];
      var ei=0;
      if(emojiB) emojiB.addEventListener('click',function(){ ei=(ei+1)%EMOJI.length; emojiB.textContent=EMOJI[ei]; });
      function saved(){ try{ return JSON.parse(localStorage.getItem('pp.guest')||'null'); }catch(_){ return null; } }
      function remember(g){ try{ localStorage.setItem('pp.guest', JSON.stringify(g)); }catch(_){} }
      function postJoin(g){ // fire-and-forget: joining never blocks the music
        try{ fetch(joinApi,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(g||{})}).catch(function(){}); }catch(_){}
      }
      function play(){
        a.play().then(function(){ b.textContent='Playing — a few seconds behind'; b.disabled=true; if(panel) panel.hidden=true; })
                .catch(function(){ b.textContent='Tap to listen'; b.disabled=false; });
      }
      b.addEventListener('click', function(){
        var g=saved();
        if(g && g.name){ postJoin(g); play(); return; }
        if(panel && panel.hidden){ panel.hidden=false; if(nameI) nameI.focus(); return; }
        play();
      });
      if(go) go.addEventListener('click', function(){
        err.hidden=true;
        var g={ name:(nameI&&nameI.value||'').trim(), emoji:(emojiB&&emojiB.textContent||'').trim(), email:(emailI&&emailI.value||'').trim() };
        if(!g.name){ err.textContent='Add your name (or tap Just listen).'; err.hidden=false; return; }
        if(g.email && !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(g.email)){ err.textContent="That email doesn't look right."; err.hidden=false; return; }
        remember(g); postJoin(g); play();
      });
      if(skip) skip.addEventListener('click', function(){ postJoin({}); play(); });
      a.addEventListener('error', function(){ b.textContent='Stream unavailable — try again in a moment'; b.disabled=false; });
      a.addEventListener('ended', function(){ b.textContent='The set ended'; b.disabled=true; });
    })();
    </script>
  </div>` : e.status === "live" ? `
  <div class="card">
    <div class="livebar">
      <div class="eq"><i></i><i></i><i></i><i></i><i></i></div>
      <div class="np"><b>Now playing</b><div>${esc(e.tagline)}</div></div>
      <div class="cnt"><b>${esc(e.listeners)}</b><span>listening, in sync</span></div>
    </div>
    <div class="cardhint">To listen, scan the QR at the party — the set plays in your browser, no app. When the DJ stops, the replay lands here.</div>
  </div>` : "";

  const playerCard = e.set ? `
  <section class="card replayhero player" aria-labelledby="replay-title">
    <div class="replayhead">
      <div>
        <p class="replaylabel">Replay player</p>
        <h2 id="replay-title">The set, saved from the room</h2>
        <p class="replaymeta">${esc(e.tagline || "A low-latency partyparty replay from the DJ's Mac.")}</p>
      </div>
      <span class="replayduration">${esc(fmtDur(e.set.durationMs))}</span>
    </div>
    <div class="wave" id="wave" data-peaks="/event/${esc(e.slug)}/${esc(e.set.id)}.peaks.json"></div>
    <audio id="setaudio" controls preload="none" src="/event/${esc(e.slug)}/${esc(e.set.id)}.m4a"></audio>
  </section>` : "";

  // Real outbound social links (no dead "coming soon" toast); absent URLs render nothing.
  const socialLinks = social("sc", e.socials?.soundcloud, "#ff7700", "SoundCloud")
    + social("ig", e.socials?.instagram, "#c13584", "Instagram")
    + social("sp", e.socials?.spotify, "#1db954", "Spotify");
  const aboutInner = (e.about ? `<p>${esc(e.about)}</p>` : "") + (socialLinks ? `<div class="slist">${socialLinks}</div>` : "");
  const aboutCard = aboutInner ? `<div class="card about"><h2>About this set</h2>${aboutInner}</div>` : "";
  const shareUrl = e.slug ? `${SITE_ORIGIN}/e/${esc(e.slug)}` : "";
  const shareButton = e.slug
    ? `<button class="btn ghost sm" data-share data-share-url="${shareUrl}" data-share-title="${esc(e.title)} · partyparty" data-share-text="${esc(e.tagline || "A partyparty set")}">Share</button>`
    : `<button class="btn ghost sm" data-soon="${soon}">Share</button>`;
  const upcomingCard = !e.set && e.status === "upcoming" ? `
  <div class="card"><p class="sub" style="margin:0">The set replay lands here once ${esc(e.dj || "the DJ")} plays. Check back after the party.</p></div>` : "";
  const rsvpCard = renderRsvpBlock(e);

  const posts = Array.isArray(e.posts) ? e.posts : [];
  const media = Array.isArray(e.media) ? e.media : [];
  const mediaByPost = new Map();
  for (const m of media) {
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
  const gallery = renderGalleryMedia(e.slug, media);
  const seedGallery = gallery ? "" : renderSeedGallery(e.wall || []);
  const gallerySection = gallery || seedGallery ? `
  <section class="card media-card" aria-labelledby="media-title">
    <div class="sectionhead"><div><h2 id="media-title">Photos &amp; video</h2><p>Guest captures approved by the DJ.</p></div></div>
    ${gallery || seedGallery}
  </section>` : `
  <section class="card media-card" aria-labelledby="media-title">
    <div class="sectionhead"><div><h2 id="media-title">Photos &amp; video</h2><p>Guest captures approved by the DJ.</p></div></div>
    <p class="emptykeepsake">No photos or clips yet. Approved guest media will collect here after the party.</p>
  </section>`;
  const timelineItems = posts.map((p) => renderWallPost(
    p,
    e.slug,
    mediaByPost.get(String(p.id || "")) || [],
    commentsByPost.get(String(p.id || "")) || []
  )).filter(Boolean).join("");
  const isLiveNow = e.status === "live";
  // While live, the wall is a shared room+web feed: web guests can post into it
  // (name/emoji come from the join sheet identity) and it refreshes itself.
  const composer = isLiveNow && e.slug ? `
    <div id="pp-composer" style="display:grid;gap:10px;margin-bottom:14px">
      <div class="rsvpfields" style="grid-template-columns:minmax(0,1fr) 96px">
        <input id="pp-comp-text" maxlength="500" autocomplete="off" placeholder="Say something to the party…">
        <button type="button" id="pp-comp-send" class="btn sm">Send</button>
      </div>
      <p id="pp-comp-err" class="cardhint" style="margin:0;color:#b3261e" hidden></p>
    </div>` : "";
  const emptyWallNote = isLiveNow
    ? `No comments yet — be the first.`
    : `No comments yet. Guest notes will appear here once the DJ approves them.`;
  const commentSection = `
  <section class="card commentcard" aria-labelledby="comments-title">
    <div class="sectionhead"><div><h2 id="comments-title">Comments</h2><p>${isLiveNow ? "One feed for the room and everyone listening from away." : "Notes and replies from the night, in order."}</p></div></div>
    ${composer}
    <div class="timeline" id="pp-wall">${timelineItems || `<p class="emptykeepsake">${emptyWallNote}</p>`}</div>
  </section>`;

  const waveScript = e.set ? `<script>
(function(){var a=document.getElementById('setaudio'),w=document.getElementById('wave');if(!a||!w)return;var bars=[];
fetch(w.getAttribute('data-peaks')).then(function(r){return r.json()}).then(function(d){var p=(d&&d.peaks)||[];w.innerHTML='';p.forEach(function(v){var b=document.createElement('i');b.style.height=Math.max(2,v)+'%';w.appendChild(b);bars.push(b)})}).catch(function(){});
function paint(){if(!bars.length||!a.duration)return;var k=Math.floor((a.currentTime/a.duration)*bars.length);for(var i=0;i<bars.length;i++)bars[i].className=i<=k?'on':''}
a.addEventListener('timeupdate',paint);
w.addEventListener('click',function(e){if(!a.duration)return;var r=w.getBoundingClientRect();a.currentTime=Math.max(0,Math.min(1,(e.clientX-r.left)/r.width))*a.duration});
})();
</script>` : "";

  // Live-page glue: the web-guest composer, the ~45s presence heartbeat while
  // the mirror is audibly playing, and a gentle wall refresh (re-fetch this
  // page, swap the wall + gallery + live count in place — the <audio> element
  // is never touched, so playback runs straight through).
  const liveScript = isLiveNow && e.slug ? `<script>
(function(){
  var SLUG=${JSON.stringify(String(e.slug)).replace(/</g, "\\u003c")};
  function guest(){ try{ return JSON.parse(localStorage.getItem('pp.guest')||'null')||{}; }catch(_){ return {}; } }
  var t=document.getElementById('pp-comp-text'), send=document.getElementById('pp-comp-send'), err=document.getElementById('pp-comp-err');
  function submit(){
    if(!t||!t.value.trim()) return;
    var g=guest();
    if(!g.name){ g.name=(prompt('Your name for the party feed?')||'').trim(); if(!g.name) return; try{ localStorage.setItem('pp.guest', JSON.stringify(g)); }catch(_){} }
    if(err) err.hidden=true;
    send.disabled=true;
    fetch('/api/e/'+encodeURIComponent(SLUG)+'/post',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({name:g.name,emoji:g.emoji||'',text:t.value.trim()})})
      .then(function(r){ if(!r.ok) throw 0; t.value=''; refresh(); })
      .catch(function(){ if(err){ err.textContent='Could not send — try again.'; err.hidden=false; } })
      .finally(function(){ send.disabled=false; });
  }
  if(send) send.addEventListener('click', submit);
  if(t) t.addEventListener('keydown', function(ev){ if(ev.key==='Enter'){ ev.preventDefault(); submit(); } });
  function playingAudio(){
    var a=document.getElementById('pp-live-audio');
    return a && !a.paused && a.currentTime>0;
  }
  setInterval(function(){
    if(!playingAudio()) return;
    fetch('/api/e/'+encodeURIComponent(SLUG)+'/presence',{method:'POST',credentials:'same-origin'}).catch(function(){});
  }, 45000);
  var refreshTimer=null;
  function refresh(){
    if(document.hidden) return; // background tabs don't need a fresh wall
    fetch(location.pathname,{credentials:'same-origin',cache:'no-store'})
      .then(function(r){ return r.ok ? r.text() : Promise.reject(); })
      .then(function(html){
        var doc=new DOMParser().parseFromString(html,'text/html');
        if(!doc.getElementById('pp-composer')){
          // The set ended (the page renders as a replay now): stop polling so an
          // abandoned tab doesn't hit the Worker every 12s forever.
          if(refreshTimer) clearInterval(refreshTimer);
          return;
        }
        var wall=doc.getElementById('pp-wall'), mine=document.getElementById('pp-wall');
        if(wall&&mine&&wall.innerHTML!==mine.innerHTML) mine.innerHTML=wall.innerHTML;
        var gal=doc.querySelector('.media-card'), myGal=document.querySelector('.media-card');
        if(gal&&myGal&&gal.innerHTML!==myGal.innerHTML) myGal.innerHTML=gal.innerHTML;
        var cnt=doc.querySelector('.livebar .cnt'), myCnt=document.querySelector('.livebar .cnt');
        if(cnt&&myCnt) myCnt.innerHTML=cnt.innerHTML;
      }).catch(function(){});
  }
  refreshTimer=setInterval(refresh, 12000);
})();
</script>` : "";

  const body = `<div class="page eventpage">
    <section class="eventtop" aria-labelledby="event-title">
      <div class="eventintro">
        <div class="eventactions">${ownerStrip}${shareButton}</div>
        <p class="eventeyebrow">partyparty keepsake</p>
        ${statusPill}
        <h1 class="eventtitle" id="event-title">${esc(e.title)}</h1>
        ${e.tagline ? `<p class="eventtagline">${esc(e.tagline)}</p>` : ""}
        ${eventMeta}
      </div>
      ${coverBlock}
    </section>
    ${liveCard}${playerCard}${upcomingCard}${rsvpCard}
    ${gallerySection}
    ${commentSection}
    ${aboutCard}
  </div>
  <footer><span>🕺 partyparty</span><span>Silent-disco popups on your Mac · <a href="/" style="color:var(--link)">what is this?</a></span></footer>${waveScript}${rsvpScript(Number(e.rsvp_enabled) === 1)}${liveScript}`;

  const descBits = [e.when, e.where].filter(Boolean).join(" · ");
  const ogImage = e.cover && e.cover.indexOf("/event/") === 0 ? e.cover : DEFAULT_OG_IMAGE;
  return shell({ title: `${e.title} · partyparty`, desc: `${e.title}${descBits ? " — " + descBits : ""}. ${e.tagline}`.trim(), ogImage, url: e.slug ? `/e/${e.slug}` : "/", body });
}

function renderNotFound() {
  const body = `<div class="nf">
    <div class="art">🕺</div>
    <h1>That event isn't here.</h1>
    <p>Every partyparty popup gets a page that gathers the night — photos, videos and clips from everyone there. Throw one and share the link.</p>
    <a class="btn" style="padding:13px 24px;font-size:16px" href="/partyparty.pkg">Get the app</a>
    <p style="font-size:13px;margin-top:22px">Event pages are in progress. <a href="/" style="color:var(--link)">See what partyparty is ›</a></p>
  </div>`;
  return shell({ title: `partyparty`, desc: `partyparty event page`, body });
}

// ---- Cert broker (the Plex pattern, vendor side) ----
//
// Lets linked partyparty installs get a real Let's Encrypt cert with zero config:
// the app registers here once (an id + bearer secret + its own namespace
// <id>.BROKER_BASE), runs ACME locally (private keys never leave the DJ's
// Mac), and asks this broker to publish the DNS-01 challenge TXT and the
// slugged A record (<slug>.BROKER_BASE -> current LAN IP). The Cloudflare DNS
// token lives ONLY here as a Worker secret; certificate DNS writes require the
// install to be linked to a signed-in account.

const jsonResp = (status, obj, headers = undefined) => {
  const h = new Headers(headers || {});
  h.set("content-type", "application/json");
  return new Response(JSON.stringify(obj), { status, headers: h });
};

const BROKER_SLUG_WORDS = ["disco", "groove", "bass", "vinyl", "tempo", "fader", "reverb", "echo", "strobe", "neon",
  "boombox", "sub", "beat", "drop", "loop", "mix", "vibe", "funk", "wave", "pulse",
  "rhythm", "deck", "fade", "amp", "chorus", "riff", "snare", "hihat", "kick", "midi"];

async function newBrokerSlug(env, id) {
  for (let tries = 0; tries < 10; tries++) {
    const cand = BROKER_SLUG_WORDS[Math.floor(Math.random() * BROKER_SLUG_WORDS.length)] + String(Math.floor(Math.random() * 90) + 10);
    if (!(await env.DL.get(`broker/slug/${cand}`))) return cand;
  }
  return "party" + id.slice(0, 6);
}

async function ensureBrokerSlug(env, id, rec) {
  if (rec.slug) return rec.slug;
  const slug = await newBrokerSlug(env, id);
  rec.slug = slug;
  await env.DL.put(`broker/slug/${slug}`, id);
  await env.DL.put(`broker/${id}.json`, JSON.stringify(rec));
  return slug;
}

// handleSlugBase: the DNS label a DJ's Mac should carry, derived from their
// handle — seth -> "seth-live" (a second Mac gets seth-live2, ...). Handles
// can never contain hyphens (normalizeHandle allows [a-z0-9_.]) so a
// handle-derived label can NEVER collide with any present or future handle's
// proxied custom domain. Dots/underscores (valid in handles, not hostnames)
// map to hyphens.
function handleSlugBase(handle) {
  const h = normalizeHandle(handle);
  if (!h) return "";
  const dns = h.replace(/[._]+/g, "-").replace(/^-+|-+$/g, "");
  return dns ? `${dns}-live` : "";
}

// ensureHandleSlug: called ONLY from /api/broker/a — the one endpoint where the
// Mac is present to ADOPT a rename (its refresh loop takes the returned host,
// notices the cached cert no longer matches, re-runs ACME, and re-advertises;
// zero client changes). Renames a linked install's machine hostname from the
// random word slug (fader91) to the handle-derived one (seth-live). Hard rules:
// - only when the profile's handle is CONFIRMED (auto-minted defaults like
//   "seth.finkin" must not churn hostnames before the DJ picks a name);
// - NEVER while the install is live — guests would be routed to a host the Mac
//   has no cert for yet; the rename waits for the next idle refresh;
// - the old reverse index stays reserved so a stale printed QR can never point
//   at a stranger's Mac; the old grey A record is deleted (link goes dead, not
//   wrong). Falls back to ensureBrokerSlug whenever renaming doesn't apply.
async function ensureHandleSlug(env, id, rec, now) {
  const current = await ensureBrokerSlug(env, id, rec);
  if (!env.DB) return current;
  const linked = await env.DB.prepare(
    "SELECT profile_id FROM device_installs WHERE install_id=? AND revoked_ms IS NULL LIMIT 1"
  ).bind(id).first();
  if (!linked?.profile_id) return current;
  const profile = await env.DB.prepare(
    "SELECT handle, handle_confirmed_ms FROM dj_profiles WHERE id=? LIMIT 1"
  ).bind(linked.profile_id).first();
  if (!profile?.handle || profile.handle_confirmed_ms == null) return current;
  const base = handleSlugBase(profile.handle);
  if (!base) return current;
  if (new RegExp(`^${base}\\d*$`).test(current)) return current; // already this handle's
  const live = await env.DB.prepare(
    "SELECT 1 FROM live_installs WHERE install_id=? AND expires_ms>? LIMIT 1"
  ).bind(id, now).first();
  if (live) return current; // mid-party: keep the name the Mac can actually serve
  const slugOwner = async (s) => {
    const o = await env.DL.get(`broker/slug/${s}`);
    return o ? await o.text() : "";
  };
  let slug = base;
  for (let n = 2; n <= 9; n++) {
    const owner = await slugOwner(slug);
    if (!owner || owner === id) break;
    slug = base + String(n); // another of this DJ's Macs holds the base
  }
  const owner = await slugOwner(slug);
  if (owner && owner !== id) return current; // 9 Macs deep — keep the word slug
  const oldSlug = rec.slug;
  rec.slug = slug;
  await env.DL.put(`broker/slug/${slug}`, id);
  await env.DL.put(`broker/${id}.json`, JSON.stringify(rec));
  if (oldSlug && oldSlug !== slug) {
    try { await deleteGreyA(env, machineHost(env, oldSlug)); } catch (e) { /* best-effort */ }
  }
  return slug;
}

async function requireLinkedInstallForDNS(env, id) {
  if (env.BROKER_ALLOW_UNLINKED_DNS === "1") return null;
  if (!env.DB) return jsonResp(503, { error: "account link required" });
  const linked = await env.DB.prepare(
    "SELECT user_id, profile_id FROM device_installs WHERE install_id=? AND revoked_ms IS NULL LIMIT 1"
  ).bind(id).first();
  if (!linked?.user_id || !linked?.profile_id) {
    return jsonResp(403, { error: "link this Mac to your account before requesting certificates" });
  }
  return null;
}

// Going live to the cloud (claiming/creating an online event) requires this Mac
// to be linked to an account. This never touches the LOCAL offline party — the
// broker is only ever called when publishing online. "License" today == linked.
async function requireLinkedInstallForPublish(env, id) {
  if (env.BROKER_ALLOW_UNLINKED_PUBLISH === "1") return null;
  if (!env.DB) return jsonResp(503, { error: "account link required" });
  const linked = await env.DB.prepare(
    "SELECT user_id, profile_id FROM device_installs WHERE install_id=? AND revoked_ms IS NULL LIMIT 1"
  ).bind(id).first();
  if (!linked?.user_id || !linked?.profile_id) {
    return jsonResp(403, { error: "link this Mac to your account to publish your party online", reason: "not_linked" });
  }
  return null;
}

// Web-created events belong to the account before they belong to a particular
// Mac (install_id=''). The first currently-linked Mac from that same account may
// adopt the row for the install-scoped publish pipeline. The conditional UPDATE
// is the race/IDOR boundary: assigned events and other accounts never move.
async function claimUnassignedAccountEvent(env, slug, id) {
  if (!env.DB) return false;
  const linked = await env.DB.prepare(
    "SELECT user_id, profile_id FROM device_installs WHERE install_id=? AND revoked_ms IS NULL LIMIT 1"
  ).bind(id).first();
  if (!linked?.user_id || !linked?.profile_id) return false;
  await env.DB.prepare(
    `UPDATE events SET install_id=?1
     WHERE slug=?2 AND install_id=''
       AND (owner_user_id=?3 OR (owner_user_id IS NULL AND dj_profile_id=?4))`
  ).bind(id, slug, linked.user_id, linked.profile_id).run();
  const owner = await env.DB.prepare("SELECT install_id FROM events WHERE slug=?").bind(slug).first();
  return owner?.install_id === id;
}

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

function safeDecodeComponent(s) {
  try { return decodeURIComponent(s || ""); }
  catch (_) { return s || ""; }
}

function mxrouteSmtpConfigPresent(env) {
  if (String(env.AUTH_EMAIL_SERVER || "").trim()) return true;
  return !!(env.MXROUTE_SMTP_HOST && env.MXROUTE_SMTP_USER && env.MXROUTE_SMTP_PASS);
}

function authEmailConfigured(env) {
  if (!env) return false;
  return !!mxrouteSmtpConfig(env) || !!(env.EMAIL && typeof env.EMAIL.send === "function");
}

function authProvidersAvailable(env) {
  return hasGoogleProvider(env) || hasAppleProvider(env) || authEmailConfigured(env);
}

function mxrouteSmtpConfig(env) {
  const rawUrl = String(env.AUTH_EMAIL_SERVER || "").trim();
  if (rawUrl) {
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== "smtps:" && u.protocol !== "smtp:") return null;
      const hostname = u.hostname;
      const port = Number(u.port || (u.protocol === "smtps:" ? 465 : 587));
      const username = safeDecodeComponent(u.username);
      const password = safeDecodeComponent(u.password);
      if (!hostname || !Number.isInteger(port) || port <= 0 || !username || !password) return null;
      return {
        hostname,
        port,
        username,
        password,
        secureTransport: u.protocol === "smtps:" ? "on" : "starttls",
      };
    } catch (_) {
      return null;
    }
  }

  const hostname = String(env.MXROUTE_SMTP_HOST || "").trim();
  const username = String(env.MXROUTE_SMTP_USER || "").trim();
  const password = String(env.MXROUTE_SMTP_PASS || "");
  const port = Number(String(env.MXROUTE_SMTP_PORT || "465").trim() || "465");
  if (!hostname || !username || !password || !Number.isInteger(port) || port <= 0) return null;
  return {
    hostname,
    port,
    username,
    password,
    secureTransport: port === 465 ? "on" : "starttls",
  };
}

function smtpSafeHeloHost(env) {
  const raw = String(env.AUTH_EMAIL_HELO || env.BROKER_BASE || "partyparty.party").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.-]{0,252}[a-z0-9]$/.test(raw) ? raw : "partyparty.party";
}

function smtpBase64(s) {
  let bin = "";
  for (const b of new TextEncoder().encode(String(s || ""))) bin += String.fromCharCode(b);
  return btoa(bin);
}

function smtpHeaderValue(s) {
  return String(s || "").replace(/[\r\n]+/g, " ").trim();
}

function smtpAddressHeader(addr) {
  const email = normalizeEmail(addr?.email) || "noreply@partyparty.party";
  const name = smtpHeaderValue(addr?.name || "");
  if (!name) return `<${email}>`;
  const quoted = name.replace(/["\\]/g, "\\$&");
  return `"${quoted}" <${email}>`;
}

function smtpNormalizeData(s) {
  return String(s || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.startsWith(".") ? `.${line}` : line)
    .join("\r\n");
}

function smtpMessageId(fromEmail) {
  const domain = String(fromEmail || "").split("@")[1] || "partyparty.party";
  return `<${randHex(16)}@${domain}>`;
}

function authEmailMimeMessage(env, toEmail, link) {
  const from = authEmailFrom(env);
  const body = authEmailBody(link);
  const boundary = `pp-${randHex(16)}`;
  const headers = [
    `From: ${smtpAddressHeader(from)}`,
    `To: <${normalizeEmail(toEmail)}>`,
    `Subject: ${smtpHeaderValue(body.subject)}`,
    "MIME-Version: 1.0",
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${smtpMessageId(from.email)}`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  return `${headers.join("\r\n")}\r\n\r\n` +
    `--${boundary}\r\n` +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    "Content-Transfer-Encoding: 7bit\r\n\r\n" +
    `${body.text}\r\n\r\n` +
    `--${boundary}\r\n` +
    "Content-Type: text/html; charset=utf-8\r\n" +
    "Content-Transfer-Encoding: 7bit\r\n\r\n" +
    `${body.html}\r\n\r\n` +
    `--${boundary}--`;
}

class SmtpReplyReader {
  constructor(reader) {
    this.reader = reader;
    this.decoder = new TextDecoder();
    this.buffer = "";
  }

  async read() {
    const lines = [];
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx < 0) {
        const { value, done } = await this.reader.read();
        if (done) throw new Error("smtp connection closed before reply");
        this.buffer += this.decoder.decode(value, { stream: true });
        continue;
      }
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      const code = Number(line.slice(0, 3));
      if (!Number.isInteger(code)) throw new Error(`smtp malformed reply: ${line}`);
      lines.push(line);
      if (line[3] !== "-") return { code, lines };
    }
  }
}

async function smtpWrite(writer, data) {
  await writer.write(new TextEncoder().encode(data));
}

async function smtpExpect(replies, expected, step) {
  const reply = await replies.read();
  const codes = Array.isArray(expected) ? expected : [expected];
  if (!codes.includes(reply.code)) {
    throw new Error(`smtp ${step} failed with ${reply.code}`);
  }
  return reply;
}

async function smtpAuthLogin(connectFn, config, message) {
  let socket = null;
  let reader = null;
  let writer = null;
  let ok = false;

  const openStreams = () => {
    reader = socket.readable.getReader();
    writer = socket.writable.getWriter();
    return new SmtpReplyReader(reader);
  };

  try {
    socket = connectFn(
      { hostname: config.hostname, port: config.port },
      { secureTransport: config.secureTransport }
    );
    if (socket.opened) await socket.opened;
    let replies = openStreams();

    await smtpExpect(replies, 220, "greeting");
    await smtpWrite(writer, `EHLO ${config.heloHost}\r\n`);
    await smtpExpect(replies, 250, "ehlo");

    if (config.secureTransport === "starttls") {
      await smtpWrite(writer, "STARTTLS\r\n");
      await smtpExpect(replies, 220, "starttls");
      try { reader.releaseLock(); } catch (_) {}
      try { writer.releaseLock(); } catch (_) {}
      socket = socket.startTls();
      if (socket.opened) await socket.opened;
      replies = openStreams();
      await smtpWrite(writer, `EHLO ${config.heloHost}\r\n`);
      await smtpExpect(replies, 250, "ehlo after starttls");
    }

    await smtpWrite(writer, "AUTH LOGIN\r\n");
    await smtpExpect(replies, 334, "auth username challenge");
    await smtpWrite(writer, `${smtpBase64(config.username)}\r\n`);
    await smtpExpect(replies, 334, "auth password challenge");
    await smtpWrite(writer, `${smtpBase64(config.password)}\r\n`);
    await smtpExpect(replies, 235, "auth");
    await smtpWrite(writer, `MAIL FROM:<${config.fromEmail}>\r\n`);
    await smtpExpect(replies, 250, "mail from");
    await smtpWrite(writer, `RCPT TO:<${config.toEmail}>\r\n`);
    await smtpExpect(replies, [250, 251], "rcpt to");
    await smtpWrite(writer, "DATA\r\n");
    await smtpExpect(replies, 354, "data");
    await smtpWrite(writer, `${smtpNormalizeData(message)}\r\n.\r\n`);
    await smtpExpect(replies, 250, "message");
    await smtpWrite(writer, "QUIT\r\n");
    await smtpExpect(replies, 221, "quit");
    ok = true;
    return true;
  } catch (_) {
    return false;
  } finally {
    try { reader?.releaseLock?.(); } catch (_) {}
    try { writer?.releaseLock?.(); } catch (_) {}
    if (!ok) {
      try { await socket?.close?.(); } catch (_) {}
    }
  }
}

async function mxrouteConnectFn(env) {
  if (typeof env.__TEST_SMTP_CONNECT === "function") return env.__TEST_SMTP_CONNECT;
  const mod = await import("cloudflare:sockets");
  return mod.connect;
}

export async function sendViaMXroute(env, toEmail, link) {
  const config = mxrouteSmtpConfig(env);
  const toNorm = normalizeEmail(toEmail);
  if (!config || !toNorm) return false;
  const from = authEmailFrom(env);
  const connectFn = await mxrouteConnectFn(env);
  return await smtpAuthLogin(connectFn, {
    ...config,
    heloHost: smtpSafeHeloHost(env),
    fromEmail: from.email,
    toEmail: toNorm,
  }, authEmailMimeMessage(env, toNorm, link));
}

function authEmailFrom(env) {
  const raw = String(env.AUTH_EMAIL_FROM || env.MXROUTE_SMTP_FROM || "noreply@partyparty.party").trim();
  const match = /^(?:"?([^"<>]*)"?\s*)?<([^<>]+)>$/.exec(raw);
  const email = normalizeEmail(match ? match[2] : raw) || "noreply@partyparty.party";
  const name = clip((match ? match[1] : env.AUTH_EMAIL_FROM_NAME) || "partyparty", 80).trim() || "partyparty";
  return { email, name };
}

function authEmailBody(link) {
  const safeLink = esc(link);
  const text = `Sign in to partyparty:\n\n${link}\n\nThis link expires in 15 minutes. If you did not request it, you can ignore this email.`;
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f7;color:#1d1d1f;font:16px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <main style="max-width:520px;margin:0 auto;padding:32px 20px">
    <h1 style="font-size:28px;line-height:1.1;margin:0 0 12px">Sign in to partyparty</h1>
    <p style="margin:0 0 20px;color:#424245">Use this link to finish signing in and link your Mac.</p>
    <p style="margin:0 0 24px"><a href="${safeLink}" style="display:inline-block;background:#ff2d6f;color:#fff;text-decoration:none;border-radius:999px;padding:12px 18px;font-weight:700">Continue to partyparty</a></p>
    <p style="margin:0;color:#6e6e73;font-size:14px">This link expires in 15 minutes. If you did not request it, you can ignore this email.</p>
  </main></body></html>`;
  return { subject: "Sign in to partyparty", text, html };
}

async function sendAuthEmail(env, toEmail, link, devMode = false) {
  if (devMode) return true;
  if (mxrouteSmtpConfigPresent(env) && await sendViaMXroute(env, toEmail, link)) {
    return true;
  }
  if (env.EMAIL && typeof env.EMAIL.send === "function") {
    const body = authEmailBody(link);
    await env.EMAIL.send({
      to: toEmail,
      from: authEmailFrom(env),
      subject: body.subject,
      text: body.text,
      html: body.html,
    });
    return true;
  }
  return false;
}

function authDevEmailAllowlist(env) {
  return String(env.AUTH_DEV_EMAILS || "")
    .split(",")
    .map((s) => normalizeEmail(s))
    .filter(Boolean);
}

function authDevMode(request, env, emailNorm = "") {
  if (env.AUTH_DEV_LINKS !== "1" || !env.AUTH_DEV_SECRET) return false;
  if (request.headers.get("x-auth-dev-secret") !== env.AUTH_DEV_SECRET) return false;
  const allowed = authDevEmailAllowlist(env);
  if (!allowed.length) return true;
  return allowed.includes(normalizeEmail(emailNorm));
}

function authDevDirectMode(request, env, emailNorm = "") {
  return env.AUTH_DEV_DIRECT === "1" && authDevMode(request, env, emailNorm);
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

async function createAuthSession(env, request, emailNorm, now = nowMs()) {
  if (!emailNorm) return null;
  const displayName = clip(emailNorm.split("@")[0] || "Guest", 80);
  await env.DB.prepare(
    `INSERT INTO users (id, email, email_norm, display_name, created_ms, updated_ms, email_verified_ms, last_login_ms, disabled_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(email_norm) DO NOTHING`
  ).bind(randHex(16), emailNorm, emailNorm, displayName, now, now, now, now).run();
  let user = await env.DB.prepare("SELECT * FROM users WHERE email_norm=? LIMIT 1").bind(emailNorm).first();
  if (!user?.id) return null;
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

  return {
    user,
    cookie: cookieHeader(SESSION_COOKIE, sessionToken, {
      maxAge: SESSION_TTL_MS / 1000,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    }),
  };
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
  const devMode = authDevMode(request, env, emailNorm);
  const devDirect = authDevDirectMode(request, env, emailNorm);
  authLazyCleanup(env, now);
  // Soft, best-effort throttling: the count/insert pair is not atomic until this
  // route gets a Durable Object gate, so the indexes and cleanup bound abuse cost.
  if (!devMode) {
    const [ipCountRow, emailCountRow] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS n FROM auth_magic_tokens WHERE request_ip_hash=? AND created_ms>=?").bind(ipHash, since).first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM auth_magic_tokens WHERE email_norm=? AND created_ms>=?").bind(emailNorm, since).first(),
    ]);
    if ((Number(ipCountRow?.n) || 0) >= MAGIC_LINK_IP_CAP || (Number(emailCountRow?.n) || 0) >= MAGIC_LINK_EMAIL_CAP) {
      return jsonResp(429, { error: "rate limited" });
    }
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
  let queued = true;
  try {
    queued = await sendAuthEmail(env, emailNorm, link, devMode) !== false;
  } catch (e) {
    console.warn("auth email send failed", {
      code: e?.code || "",
      message: e?.message || String(e || ""),
    });
    queued = false;
  }
  const out = { ok: true };
  const headers = new Headers();
  if (devMode) {
    out.devLink = link;
    if (devDirect) {
      const session = await createAuthSession(env, request, emailNorm, now);
      if (session?.cookie) {
        headers.append("set-cookie", session.cookie);
        out.redirect = await signInLanding(env, session.user, redirectPath);
      }
    }
  } else if (!queued) {
    out.queued = false;
  }
  return jsonResp(200, out, headers);
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
  const session = await createAuthSession(env, request, emailNorm, now);
  if (!session?.cookie) return expiredLinkResponse(400);

  const dest = await signInLanding(env, session.user, safeRedirectPath(row.redirect_path));
  const headers = new Headers({ location: dest });
  headers.append("set-cookie", session.cookie);
  headers.set("cache-control", "no-store");
  return new Response(null, { status: 302, headers });
}

// ---- OAuth (Google / Apple) — same accounts as magic-link, keyed by verified
// email. Both providers hand back a verified email, so each funnels into
// createAuthSession exactly like the magic-link tail. Mirrors Write's env-var
// naming (AUTH_GOOGLE_ID/SECRET, AUTH_APPLE_*). ----
const OAUTH_STATE_COOKIE = "pp_oauth";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

function hasGoogleProvider(env) { return !!(env && env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET); }
function hasAppleProvider(env) {
  return !!(env && env.AUTH_APPLE_ID && env.AUTH_APPLE_TEAM_ID && env.AUTH_APPLE_KEY_ID && env.AUTH_APPLE_PRIVATE_KEY);
}

function decodeJwtPayload(jwt) {
  try {
    const part = String(jwt || "").split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    return JSON.parse(atob(b64 + pad));
  } catch (_) { return null; }
}

// State cookie packs provider + CSRF nonce + the post-login redirect (kept
// server-side in an HttpOnly cookie, never round-tripped through the provider).
function oauthStateCookie(prov, nonce, redirect, sameSite = "Lax") {
  return cookieHeader(OAUTH_STATE_COOKIE, `${prov}|${nonce}|${encodeURIComponent(redirect)}`,
    { maxAge: 600, httpOnly: true, secure: true, sameSite });
}
function clearOauthStateCookie() {
  return cookieHeader(OAUTH_STATE_COOKIE, "", { maxAge: 0, httpOnly: true, secure: true, sameSite: "Lax" });
}
function oauthError(reason) {
  const h = new Headers({ location: `/login?error=${encodeURIComponent(reason || "oauth")}`, "cache-control": "no-store" });
  h.append("set-cookie", clearOauthStateCookie());
  return new Response(null, { status: 302, headers: h });
}
// Reads + validates the state cookie against the returned state param (CSRF).
// Returns { redirect } on success, null on mismatch.
function readOauthState(request, prov, returnedState) {
  const saved = parseCookies(request)[OAUTH_STATE_COOKIE] || "";
  const [p, nonce, enc] = saved.split("|");
  if (!p || p !== prov || !nonce || !returnedState || nonce !== returnedState) return null;
  let redirect = "/account";
  try { redirect = safeRedirectPath(decodeURIComponent(enc || "")) || "/account"; } catch (_) {}
  return { redirect };
}

async function googleAuthStart(request, env) {
  if (!hasGoogleProvider(env)) return redirectResp("/login");
  const redirect = safeRedirectPath(new URL(request.url).searchParams.get("redirect") || "/account") || "/account";
  const nonce = randHex(16);
  const params = new URLSearchParams({
    client_id: env.AUTH_GOOGLE_ID,
    redirect_uri: `${SITE_ORIGIN}/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state: nonce,
    prompt: "select_account",
  });
  const headers = new Headers({ location: `${GOOGLE_AUTH_URL}?${params.toString()}`, "cache-control": "no-store" });
  headers.append("set-cookie", oauthStateCookie("g", nonce, redirect));
  return new Response(null, { status: 302, headers });
}

async function googleAuthCallback(request, env) {
  if (!hasGoogleProvider(env) || !env.DB) return oauthError("unavailable");
  const url = new URL(request.url);
  const code = url.searchParams.get("code") || "";
  const st = readOauthState(request, "g", url.searchParams.get("state") || "");
  if (!code || !st) return oauthError("state");
  // Exchange the code server-to-server, authenticated with our client secret.
  let tok = null;
  try {
    const resp = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.AUTH_GOOGLE_ID,
        client_secret: env.AUTH_GOOGLE_SECRET,
        redirect_uri: `${SITE_ORIGIN}/auth/google/callback`,
        grant_type: "authorization_code",
      }).toString(),
    });
    if (resp.ok) tok = await resp.json();
  } catch (_) { /* fall through to error */ }
  const claims = decodeJwtPayload(tok && tok.id_token);
  // The id_token arrived directly from Google's token endpoint over TLS,
  // authenticated with our secret — validate the binding claims.
  const good = claims && claims.aud === env.AUTH_GOOGLE_ID &&
    (claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com") &&
    Number(claims.exp) * 1000 > nowMs() && claims.email && claims.email_verified === true;
  const emailNorm = good ? normalizeEmail(claims.email) : "";
  if (!emailNorm) return oauthError("verify");
  const session = await createAuthSession(env, request, emailNorm);
  if (!session || !session.cookie) return oauthError("session");
  const dest = await signInLanding(env, session.user, st.redirect);
  const headers = new Headers({ location: dest, "cache-control": "no-store" });
  headers.append("set-cookie", session.cookie);
  headers.append("set-cookie", clearOauthStateCookie());
  return new Response(null, { status: 302, headers });
}

const APPLE_AUTH_URL = "https://appleid.apple.com/auth/authorize";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_ISS = "https://appleid.apple.com";

function b64urlBytes(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(str) {
  return b64urlBytes(new TextEncoder().encode(str));
}

// Sign in with Apple's "client secret" is an ES256 (P-256) JWT we mint on the
// fly, signed with the downloaded .p8 key. Web Crypto's ECDSA sign returns raw
// r||s, which is already the JWS ES256 signature format — no DER unwrap needed.
async function importApplePrivateKey(pem) {
  const b64 = String(pem || "")
    .replace(/\\n/g, "\n")
    .replace(/-----[^-]+-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der.buffer, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}
async function appleClientSecret(env, now = nowMs()) {
  const iat = Math.floor(now / 1000);
  const header = { alg: "ES256", kid: env.AUTH_APPLE_KEY_ID, typ: "JWT" };
  const payload = { iss: env.AUTH_APPLE_TEAM_ID, iat, exp: iat + 300, aud: APPLE_ISS, sub: env.AUTH_APPLE_ID };
  const signingInput = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(payload))}`;
  const key = await importApplePrivateKey(env.AUTH_APPLE_PRIVATE_KEY);
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${b64urlBytes(sig)}`;
}

async function appleAuthStart(request, env) {
  if (!hasAppleProvider(env)) return redirectResp("/login");
  const redirect = safeRedirectPath(new URL(request.url).searchParams.get("redirect") || "/account") || "/account";
  const nonce = randHex(16);
  const params = new URLSearchParams({
    client_id: env.AUTH_APPLE_ID,
    redirect_uri: `${SITE_ORIGIN}/auth/apple/callback`,
    response_type: "code",
    scope: "name email",
    response_mode: "form_post",
    state: nonce,
  });
  const headers = new Headers({ location: `${APPLE_AUTH_URL}?${params.toString()}`, "cache-control": "no-store" });
  // form_post lands as a cross-site POST from appleid.apple.com, so the state
  // cookie must be SameSite=None to be sent back with it (Lax would be dropped).
  headers.append("set-cookie", oauthStateCookie("a", nonce, redirect, "None"));
  return new Response(null, { status: 302, headers });
}

async function appleAuthCallback(request, env) {
  if (!hasAppleProvider(env) || !env.DB) return oauthError("unavailable");
  if (request.method !== "POST") return oauthError("method");
  const form = await request.formData().catch(() => null);
  if (!form) return oauthError("form");
  const code = String(form.get("code") || "");
  const st = readOauthState(request, "a", String(form.get("state") || ""));
  if (!code || !st) return oauthError("state");
  let secret;
  try {
    secret = await appleClientSecret(env);
  } catch (_) {
    return oauthError("secret");
  }
  let tok = null;
  try {
    const resp = await fetch(APPLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.AUTH_APPLE_ID,
        client_secret: secret,
        redirect_uri: `${SITE_ORIGIN}/auth/apple/callback`,
        grant_type: "authorization_code",
      }).toString(),
    });
    if (resp.ok) tok = await resp.json();
  } catch (_) { /* fall through to error */ }
  const claims = decodeJwtPayload(tok && tok.id_token);
  // Apple reports email_verified as a boolean or the string "true".
  const emailVerified = !!claims && (claims.email_verified === true || claims.email_verified === "true");
  const good = claims && claims.aud === env.AUTH_APPLE_ID && claims.iss === APPLE_ISS &&
    Number(claims.exp) * 1000 > nowMs() && claims.email && emailVerified;
  const emailNorm = good ? normalizeEmail(claims.email) : "";
  if (!emailNorm) return oauthError("verify");
  const session = await createAuthSession(env, request, emailNorm);
  if (!session || !session.cookie) return oauthError("session");
  const dest = await signInLanding(env, session.user, st.redirect);
  const headers = new Headers({ location: dest, "cache-control": "no-store" });
  headers.append("set-cookie", session.cookie);
  headers.append("set-cookie", clearOauthStateCookie());
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

async function installLinkCreate(request, env) {
  if (request.method !== "POST") return jsonResp(405, { error: "POST required" });
  if (!env.DB) return jsonResp(503, { error: "link db not configured" });
  const user = await getSessionUser(env, request);
  if (!user) return jsonResp(401, { error: "sign in required" });
  const profile = await env.DB.prepare("SELECT * FROM dj_profiles WHERE user_id=? LIMIT 1").bind(user.id).first();
  if (!profile?.id) return jsonResp(400, { error: "create a DJ profile first", redirect: "/profile/edit" });

  const now = nowMs();
  cleanupInstallLinkTokens(env, now);
  const live = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM install_link_tokens WHERE user_id=? AND used_ms IS NULL AND expires_ms>?"
  ).bind(user.id, now).first();
  if ((Number(live?.n) || 0) >= INSTALL_LINK_USER_CAP) return jsonResp(429, { error: "rate limited" });

  let code = "";
  let expiresMs = 0;
  for (let i = 0; i < 3; i += 1) {
    code = randHex(16);
    expiresMs = now + INSTALL_LINK_TTL_MS;
    try {
      await env.DB.prepare(
        `INSERT INTO install_link_tokens
           (id, code_hash, user_id, profile_id, install_id, created_ms, expires_ms, used_ms)
         VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)`
      ).bind(randHex(16), await sha256Hex(code), user.id, profile.id, now, expiresMs).run();
      return jsonResp(200, { ok: true, code, expiresMs });
    } catch (e) {
      if (!/unique|constraint|install_link_tokens/i.test(String((e && e.message) || e))) throw e;
    }
  }
  return jsonResp(500, { error: "could not create code" });
}

async function installLinkUnlink(request, env) {
  if (request.method !== "POST") return jsonResp(405, { error: "POST required" });
  if (!env.DB) return jsonResp(503, { error: "link db not configured" });
  const user = await getSessionUser(env, request);
  if (!user) return jsonResp(401, { error: "sign in required" });
  const wantsJson = String(request.headers.get("content-type") || "").includes("application/json");
  const body = wantsJson ? await readJson(request, 1024) : {};
  if (wantsJson && !body) return READ_JSON_TOO_LARGE.has(request) ? jsonResp(413, { error: "too large" }) : jsonResp(400, { error: "bad json" });
  const installId = String(body.install_id || body.id || "");
  const now = nowMs();
  let result;
  let revokedIds = [];
  if (installId) {
    if (!/^[a-f0-9]{12}$/.test(installId)) return jsonResp(400, { error: "bad install_id" });
    result = await env.DB.prepare(
      "UPDATE device_installs SET revoked_ms=? WHERE user_id=? AND install_id=? AND revoked_ms IS NULL"
    ).bind(now, user.id, installId).run();
    if ((Number(result?.meta?.changes) || 0) > 0) revokedIds = [installId];
  } else {
    const active = await env.DB.prepare(
      "SELECT install_id FROM device_installs WHERE user_id=? AND revoked_ms IS NULL"
    ).bind(user.id).all();
    revokedIds = (active?.results || []).map((row) => String(row.install_id || "")).filter((id) => /^[a-f0-9]{12}$/.test(id));
    result = await env.DB.prepare(
      "UPDATE device_installs SET revoked_ms=? WHERE user_id=? AND revoked_ms IS NULL"
    ).bind(now, user.id).run();
  }
  for (const id of revokedIds) await clearRevokedInstallLiveState(env, id, now);
  return jsonResp(200, { ok: true, revoked: Number(result?.meta?.changes) || 0 });
}

// Revocation takes the Mac off cloud discovery immediately. It deliberately
// leaves the grey LAN hostname alone: an already-activated Mac and its local
// guests must keep working offline even when the account link is removed.
async function clearRevokedInstallLiveState(env, id, now) {
  try {
    await env.DB.prepare("DELETE FROM live_installs WHERE install_id=?").bind(id).run();
  } catch (_) { /* the expiry sweep is the backstop */ }
  try {
    await env.DB.prepare(
      "UPDATE events SET status='replay', updated_ms=?2 WHERE install_id=?1 AND status='live'"
    ).bind(id, now).run();
  } catch (_) { /* the expiry sweep is the backstop */ }
}

async function installBrowserLinkStart(env, id, rec, request) {
  if (!env.DB) return jsonResp(503, { error: "link db not configured" });
  const now = nowMs();
  cleanupInstallLinkTokens(env, now);
  const live = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM install_browser_tokens WHERE install_id=? AND used_ms IS NULL AND expires_ms>?"
  ).bind(id, now).first();
  if ((Number(live?.n) || 0) >= INSTALL_BROWSER_LINK_INSTALL_CAP) return jsonResp(429, { error: "rate limited" });

  for (let i = 0; i < 3; i += 1) {
    const token = randHex(32);
    try {
      await env.DB.prepare(
        `INSERT INTO install_browser_tokens
           (id, token_hash, install_id, install_slug, created_ms, expires_ms, used_ms, request_ip_hash)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
      ).bind(
        randHex(16),
        await sha256Hex(token),
        id,
        clip(rec?.slug || "", 64),
        now,
        now + INSTALL_BROWSER_LINK_TTL_MS,
        await sha256Hex(`ip:${request.headers.get("cf-connecting-ip") || ""}`)
      ).run();
      return jsonResp(200, {
        ok: true,
        url: `${SITE_ORIGIN}/link-mac?token=${encodeURIComponent(token)}`,
        expiresMs: now + INSTALL_BROWSER_LINK_TTL_MS,
      });
    } catch (e) {
      if (!/unique|constraint|install_browser_tokens/i.test(String((e && e.message) || e))) throw e;
    }
  }
  return jsonResp(500, { error: "could not create sign-in link" });
}

function linkMacPage(title, message, extra = "") {
  const body = `<div class="page">
    <div class="card authcard">
      <h1 style="font-size:30px;letter-spacing:-.03em;margin:0 0 8px">${esc(title)}</h1>
      <p class="sub">${esc(message)}</p>
      ${extra}
    </div>
  </div>
  <footer><span>🕺 partyparty</span><span>Mac link</span></footer>`;
  return new Response(shell({
    title: `${title} · partyparty`,
    desc: "Link your Mac to your partyparty account.",
    ogImage: DEFAULT_OG_IMAGE,
    url: "/link-mac",
    body,
  }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

// The confirmation interstitial. GET renders this (no state change); the actual
// account<->install bind only happens on the same-site POST it submits — so a
// cross-site GET carrying the victim's SameSite=Lax cookie cannot silently link
// their account to an attacker's Mac.
function linkMacConfirmPage(user, rawToken) {
  const who = esc(user.email || "your account");
  const extra = `<form method="POST" action="/link-mac" style="margin-top:16px">
      <input type="hidden" name="token" value="${esc(rawToken)}">
      <div class="ecta">
        <button class="btn" type="submit">Link this Mac to ${who}</button>
        <a class="btn lt sm" href="/account">Not now</a>
      </div>
    </form>`;
  return linkMacPage(
    "Link this Mac?",
    `Linking lets this Mac publish parties to ${user.email || "your account"} and see your events. Only do this if you just started sign-in from partyparty on this Mac.`,
    extra
  );
}

async function linkMacResponse(request, env) {
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, POST" } });
  }
  if (!env.DB) return linkMacPage("Link unavailable", "Account linking is not configured yet.");

  const isPost = request.method === "POST";
  let rawToken;
  if (isPost) {
    // Defense in depth on top of SameSite=Lax (which already stops a cross-site
    // POST from carrying the session cookie, so no bind can happen). Only reject
    // a genuinely foreign origin. WebKit sends Origin: "null" on a same-site form
    // POST when the page is served no-referrer (this confirm page is) — allow
    // that, plus a missing origin; block only a real different site.
    const origin = request.headers.get("origin") || "";
    if (origin && origin !== SITE_ORIGIN && origin !== "null") {
      return linkMacPage("Link blocked", "That request didn’t come from partyparty. Start sign-in again from the app on your Mac.");
    }
    const form = await request.formData().catch(() => null);
    rawToken = String((form && form.get("token")) || "").trim().toLowerCase();
  } else {
    rawToken = String(new URL(request.url).searchParams.get("token") || "").trim().toLowerCase();
  }
  if (!/^[a-f0-9]{64}$/.test(rawToken)) {
    return linkMacPage("Link expired", "Open partyparty on your Mac and start sign-in again.");
  }

  const tokenHash = await sha256Hex(rawToken);
  const row = await env.DB.prepare("SELECT * FROM install_browser_tokens WHERE token_hash=? LIMIT 1").bind(tokenHash).first();
  const now = nowMs();
  if (!row || row.used_ms != null || Number(row.expires_ms) <= now) {
    return linkMacPage("Link expired", "Open partyparty on your Mac and start sign-in again.");
  }

  const user = await getSessionUser(env, request);
  if (!user) {
    return redirectResp(`/login?redirect=${encodeURIComponent(`/link-mac?token=${rawToken}`)}`);
  }

  const profile = await ensureUserDjProfile(env, user, now);
  const existing = await env.DB.prepare(
    "SELECT user_id, profile_id, revoked_ms FROM device_installs WHERE install_id=? LIMIT 1"
  ).bind(row.install_id).first();
  if (existing && existing.revoked_ms == null && existing.user_id && existing.user_id !== user.id) {
    return linkMacPage(
      "Mac already linked",
      "This Mac is linked to a different account. Unlink it from that account first.",
      `<div class="ecta"><a class="btn lt sm" href="/account">Account</a></div>`
    );
  }

  // GET only confirms — no binding. The state change happens on the POST below.
  if (!isPost) {
    return linkMacConfirmPage(user, rawToken);
  }

  const mark = await env.DB.prepare(
    "UPDATE install_browser_tokens SET used_ms=? WHERE id=? AND used_ms IS NULL"
  ).bind(now, row.id).run();
  if ((Number(mark?.meta?.changes) || 0) < 1) {
    return linkMacPage("Link expired", "Open partyparty on your Mac and start sign-in again.");
  }

  await env.DB.prepare(
    `INSERT INTO device_installs
       (install_id, install_slug, user_id, profile_id, label, created_ms, linked_ms, last_seen_ms, revoked_ms)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, NULL)
     ON CONFLICT(install_id) DO UPDATE SET
       install_slug=excluded.install_slug,
       user_id=excluded.user_id,
       profile_id=excluded.profile_id,
       linked_ms=excluded.linked_ms,
       last_seen_ms=excluded.last_seen_ms,
       revoked_ms=NULL`
  ).bind(row.install_id, row.install_slug || "", user.id, profile.id, now, now, now).run();

  return linkMacPage(
    "Mac linked",
    `This Mac is now linked to ${user.email || "your account"}.`,
    // The hidden marker lets partyparty's in-app sign-in window detect that the
    // bind landed (a native-injected script watches for [data-pp-linked] and
    // signals the app to drop its activation gate). Harmless in a plain browser.
    `<span data-pp-linked="1" hidden></span>` +
      `<div class="ecta"><a class="btn sm" href="/account">View account</a><a class="btn lt sm" href="/">Go to website</a></div>`
  );
}

function cleanupInstallLinkTokens(env, now) {
  try {
    const jobs = [env.DB.prepare(
      "DELETE FROM install_link_tokens WHERE (used_ms IS NOT NULL OR expires_ms < ?) AND created_ms < ? LIMIT 200"
    ).bind(now, now - INSTALL_LINK_CLEANUP_GRACE_MS).run()];
    jobs.push(env.DB.prepare(
      "DELETE FROM install_browser_tokens WHERE (used_ms IS NOT NULL OR expires_ms < ?) AND created_ms < ? LIMIT 200"
    ).bind(now, now - INSTALL_LINK_CLEANUP_GRACE_MS).run());
    Promise.all(jobs).catch(() => {});
  } catch (_) { /* best effort */ }
}

function installLinkAttemptKey(id) {
  return `broker/link-install-attempts/${id}.json`;
}

async function installLinkAttemptState(env, id, now) {
  try {
    const row = await env.DL.get(installLinkAttemptKey(id)).then((o) => (o ? o.json() : null));
    if (!row || Number(row.start_ms) + INSTALL_LINK_ATTEMPT_WINDOW_MS <= now) return { start_ms: now, n: 0 };
    return { start_ms: Number(row.start_ms) || now, n: Number(row.n) || 0 };
  } catch (_) {
    return { start_ms: now, n: 0 };
  }
}

async function installLinkAttemptsExceeded(env, id, now) {
  const state = await installLinkAttemptState(env, id, now);
  return state.n >= INSTALL_LINK_ATTEMPT_CAP;
}

async function recordInstallLinkFailure(env, id, now) {
  try {
    const state = await installLinkAttemptState(env, id, now);
    await env.DL.put(installLinkAttemptKey(id), JSON.stringify({ start_ms: state.start_ms, n: state.n + 1 }), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (_) { /* defense-in-depth only */ }
}

async function clearInstallLinkFailures(env, id) {
  try {
    await env.DL.delete(installLinkAttemptKey(id));
  } catch (_) { /* defense-in-depth only */ }
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
  // Older builds minted deterministic ip.<hash> cookies. Those collapse every
  // browser behind the same NAT into one guest (including their private email),
  // so rotate them to a per-browser random identity on the next write.
  if (cookieId && !/^[a-f0-9]{32}$/.test(cookieId)) cookieId = "";
  let minted = false;
  if (!cookieId && mintAnon) {
    cookieId = randHex(16);
    minted = true;
  }
  const anonHash = cookieId ? await sha256Hex(cookieId) : "";
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

// eventJoin: a web guest joining a live party from the event page — the same
// identity ask as the LAN listener (name / emoji / optional email, "email
// updates from the party host"). Upserted per guest per event on the SAME
// identity the RSVP flow uses (session user or the pp_rsvp anon cookie), so a
// guest is one person across both. Email is stored for the host only — it is
// never rendered anywhere public. Never gates playback: the client treats this
// as fire-and-forget.
async function eventJoin(request, env, slug) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }
  if (!env.DB) return jsonResp(503, { error: "events db not configured" });
  const event = await getEventBySlug(env, slug);
  if (!event) return jsonResp(404, { error: "event not found" });
  if (event.status !== "live") return jsonResp(403, { error: "the party isn't live" });

  const joinIPHash = await sha256Hex(`ip:${request.headers.get("cf-connecting-ip") || ""}`);
  if (await discoverRateLimited(joinIPHash, `join/${slug}`, 2)) {
    return jsonResp(429, { error: "slow down" }, { "retry-after": "2" });
  }
  const body = await readJson(request, 2048);
  if (!body) return READ_JSON_TOO_LARGE.has(request) ? jsonResp(413, { error: "too large" }) : jsonResp(400, { error: "bad json" });
  const name = stripControl(clip(body?.name, 40)).trim();
  const emoji = clip(body?.emoji, 8);
  const email = clip(body?.email, 120).trim().toLowerCase();
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return jsonResp(400, { error: "that email doesn't look right" });
  }
  const identity = await rsvpIdentity(env, request, slug, true);
  const now = nowMs();
  if (identity.userId) {
    await env.DB.prepare(
      `INSERT INTO event_guests (id, slug, user_id, anon_key_hash, name, emoji, email, source, created_ms, updated_ms)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 'web-live', ?, ?)
       ON CONFLICT(slug,user_id) WHERE user_id NOT NULL DO UPDATE SET
         name=excluded.name, emoji=excluded.emoji,
         email=CASE WHEN excluded.email='' THEN event_guests.email ELSE excluded.email END,
         updated_ms=excluded.updated_ms`
    ).bind(randHex(16), slug, identity.userId, name, emoji, email, now, now).run();
  } else {
    await env.DB.prepare(
      `INSERT INTO event_guests (id, slug, user_id, anon_key_hash, name, emoji, email, source, created_ms, updated_ms)
       VALUES (?, ?, NULL, ?, ?, ?, ?, 'web-live', ?, ?)
       ON CONFLICT(slug,anon_key_hash) WHERE anon_key_hash NOT NULL DO UPDATE SET
         name=excluded.name, emoji=excluded.emoji,
         email=CASE WHEN excluded.email='' THEN event_guests.email ELSE excluded.email END,
         updated_ms=excluded.updated_ms`
    ).bind(randHex(16), slug, identity.anonHash, name, emoji, email, now, now).run();
  }
  const headers = new Headers({ "content-type": "application/json" });
  if (identity.minted) headers.append("set-cookie", cookieHeader("pp_rsvp", identity.cookieId, { maxAge: 60 * 60 * 24 * 365 }));
  return new Response(JSON.stringify({ ok: true, name, emoji }), { status: 200, headers });
}

// How long after their last heartbeat a web guest still counts as listening.
const WEB_PRESENCE_TTL_MS = 90_000;

// webListeners: how many web guests are listening to this event right now —
// event_guests rows whose presence heartbeat is fresh. The same rows double as
// the guest book, so "listening now" is just recency on updated_ms.
async function webListeners(env, slug, now) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM event_guests WHERE slug=? AND updated_ms>?"
  ).bind(slug, now - WEB_PRESENCE_TTL_MS).first();
  return Number(row?.n) || 0;
}

// eventPresence: the web listener heartbeat (~45s while the live player is
// playing). Bumps ONLY updated_ms on an existing join row — never name/emoji/
// email and never mints a row. That keeps per-browser guest identities private
// while a caller inventing cookies cannot inflate the public listener count.
// Live events only: a years-old keepsake page can't have its count inflated.
async function eventPresence(request, env, slug) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }
  if (!env.DB) return jsonResp(503, { error: "events db not configured" });
  const event = await getEventBySlug(env, slug);
  if (!event) return jsonResp(404, { error: "event not found" });
  if (event.status !== "live") return jsonResp(200, { ok: true, webListeners: 0 });
  const identity = await rsvpIdentity(env, request, slug, false);
  const now = nowMs();
  const key = identity.userId || identity.anonHash;
  if (key) {
    const col = identity.userId ? "user_id" : "anon_key_hash";
    await env.DB.prepare(
      `UPDATE event_guests SET updated_ms=?3 WHERE slug=?1 AND ${col}=?2`
    ).bind(slug, key, now).run();
  }
  const listeners = await webListeners(env, slug, now);
  return jsonResp(200, { ok: true, webListeners: listeners });
}

// eventWebPost: a web guest's comment on the live event page — the wall is ONE
// shared feed, so this writes a real posts row (source='web', approved like the
// room's unmoderated live feed) that renders on the event page immediately and
// flows into the ROOM via the Mac's live check-in response. Same per-IP throttle
// as /api/discover to blunt spam; identity name/emoji come from the join sheet.
async function eventWebPost(request, env, slug) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }
  if (!env.DB) return jsonResp(503, { error: "events db not configured" });
  const event = await getEventBySlug(env, slug);
  if (!event) return jsonResp(404, { error: "event not found" });
  // Live parties only (review finding): a replay keepsake must not accept new
  // unmoderated posts forever via curl — this mirrors when the composer renders.
  if (event.status !== "live") return jsonResp(403, { error: "the party isn't live" });
  const ipHash = await sha256Hex(`ip:${request.headers.get("cf-connecting-ip") || ""}`);
  if (await discoverRateLimited(ipHash, `post/${slug}`, 1)) {
    return jsonResp(429, { error: "slow down" }, { "retry-after": "1" });
  }
  const body = await readJson(request, 2048);
  const text = stripControl(clip(body?.text, 500)).trim();
  if (!text) return jsonResp(400, { error: "say something first" });
  const author = stripControl(clip(body?.name, 40)).trim() || "guest";
  const emoji = clip(body?.emoji, 8);
  const identity = await rsvpIdentity(env, request, slug, true);
  const now = nowMs();
  // Authoritative caps in D1 (the edge throttle is best-effort per-colo and
  // fail-open): one identity gets 6 posts/minute; one event's live wall takes
  // at most 300 web posts per 6h window — a rotating-cookie flood hits the
  // event ceiling instead of the room feed.
  const identityCol = identity.userId ? "author_user_id" : "author_cid_hash";
  const identityKey = identity.userId || identity.anonHash;
  const [mine, total] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM posts WHERE slug=? AND source='web' AND ts_ms>? AND ${identityCol}=?`
    ).bind(slug, now - 60_000, identityKey).first(),
    env.DB.prepare(
      "SELECT COUNT(*) AS n FROM posts WHERE slug=? AND source='web' AND ts_ms>?"
    ).bind(slug, now - 6 * 3600_000).first(),
  ]);
  if ((Number(mine?.n) || 0) >= 6) return jsonResp(429, { error: "slow down a little" }, { "retry-after": "30" });
  if ((Number(total?.n) || 0) >= 300) return jsonResp(429, { error: "the wall is full for now" });
  const guest = identity.userId
    ? await env.DB.prepare("SELECT name, emoji FROM event_guests WHERE slug=? AND user_id=? LIMIT 1").bind(slug, identity.userId).first()
    : await env.DB.prepare("SELECT name, emoji FROM event_guests WHERE slug=? AND anon_key_hash=? LIMIT 1").bind(slug, identity.anonHash).first();
  const savedAuthor = stripControl(clip(guest?.name, 40)).trim();
  const savedEmoji = clip(guest?.emoji, 8);
  const id = "web-" + randHex(12);
  await env.DB.prepare(
    `INSERT INTO posts (
       id, slug, author, emoji, text, media_key, media_type, approved, ts_ms, created_ms,
       author_user_id, author_cid_hash, source, source_install_id, dj, activity_ms, updated_ms, approved_ms, deleted_ms
     )
     VALUES (?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?, ?, ?, 'web', NULL, 0, ?, ?, ?, NULL)`
  ).bind(
    id, slug, savedAuthor || author, savedAuthor ? savedEmoji : emoji, text, now, now,
    identity.userId || null, identity.userId ? null : identity.anonHash, now, now, now
  ).run();
  const headers = new Headers({ "content-type": "application/json" });
  if (identity.minted) headers.append("set-cookie", cookieHeader("pp_rsvp", identity.cookieId, { maxAge: 60 * 60 * 24 * 365 }));
  return new Response(JSON.stringify({ ok: true, id }), { status: 200, headers });
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


// machineHost: a Mac's LAN hostname lives under party.<base>, deliberately OUTSIDE
// the *.<base> wildcard (a DNS wildcard matches exactly ONE label). So a
// machine name whose grey record does not exist is NXDOMAIN — and the browser
// LAN probe fails closed — instead of resolving to Cloudflare's proxy, which
// answers with a valid wildcard cert and would false-positively "prove" that an
// off-LAN guest can reach the Mac. Certs are unaffected: each Mac holds its own
// exact-name Let's Encrypt cert via the broker's DNS-01 flow.
function machineHost(env, label) {
  return `${label}.party.${env.BROKER_BASE}`;
}

async function cfDNS(env, method, suffix, body, zoneId) {
  const zone = zoneId || env.CF_ZONE_ID;
  const url = `https://api.cloudflare.com/client/v4/zones/${zone}/dns_records${suffix}`;
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

// writeGreyA upserts ONE grey (DNS-only, never proxied) A record for a full host
// name to a LAN IP — move-in-place if it drifted, create if absent. Same shape as
// /api/broker/a; used by the live heartbeat to keep the Mac's slug host current.
async function writeGreyA(env, name, ip) {
  const existing = await cfDNS(env, "GET", `?type=A&name=${name}`);
  if (existing && existing.length) {
    if (existing[0].content !== ip) {
      await cfDNS(env, "PUT", "/" + existing[0].id, { type: "A", name, content: ip, ttl: 60, proxied: false });
    }
  } else {
    await cfDNS(env, "POST", "", { type: "A", name, content: ip, ttl: 60, proxied: false });
  }
}

// deleteGreyA removes every A record for a host — called on /offline and by the
// cron when a live install vanishes, so a dead Mac's slug host stops resolving.
async function deleteGreyA(env, name) {
  const existing = await cfDNS(env, "GET", `?type=A&name=${name}`);
  for (const r of existing || []) await cfDNS(env, "DELETE", "/" + r.id);
}

// liveClaimant returns the ONE live install that represents a handle right now:
// most-recent go-live wins, but dj_profiles.primary_install_id (if that install
// is currently live) overrides — the manual which-Mac tiebreak. null when idle.
async function liveClaimant(env, handle, now) {
  if (!env?.DB || !handle) return null;
  const rows = (await env.DB.prepare(
    `SELECT install_id, handle, profile_id, public_ip_hash, host, lan_ip, guest_port, event_slug,
            dj_name, event_title, listeners, now_playing, live_started_ms, last_seen_ms, expires_ms
     FROM live_installs WHERE handle=? AND expires_ms>? ORDER BY live_started_ms DESC`
  ).bind(handle, now).all())?.results || [];
  if (!rows.length) return null;
  const profile = await env.DB.prepare(
    "SELECT primary_install_id FROM dj_profiles WHERE handle=? LIMIT 1"
  ).bind(handle).first();
  const primaryId = profile?.primary_install_id || null;
  if (primaryId) {
    const pinned = rows.find((r) => r.install_id === primaryId);
    if (pinned) return pinned;
  }
  return rows[0];
}

// latestEventForProfile finds a DJ's most recent event to link from the idle
// "no party live right now" page. null when the DJ has no event yet.
async function latestEventForProfile(env, profileId) {
  if (!env?.DB || !profileId) return null;
  const row = await env.DB.prepare(
    `SELECT slug, title FROM events WHERE dj_profile_id=?
     ORDER BY COALESCE(last_activity_ms, updated_ms, created_ms, 0) DESC LIMIT 1`
  ).bind(profileId).first();
  return row?.slug ? { slug: row.slug, title: row.title || "" } : null;
}

// handleRouterLabel: if hostname is a single-label subdomain <label>.<BROKER_BASE>
// that is NOT the apex and NOT a reserved word and IS a clean handle, return that
// handle (the proxied permanent-link router should handle it). Otherwise null —
// the apex, reserved labels (www/api/...), and multi-label/dotted names fall
// through to normal path dispatch. Grey slug hosts never reach here (DNS-only).
function handleRouterLabel(env, hostname) {
  const base = String(env?.BROKER_BASE || "").toLowerCase();
  const host = String(hostname || "").toLowerCase();
  if (!base || host === base) return null;
  if (!host.endsWith("." + base)) return null;
  const label = host.slice(0, host.length - base.length - 1);
  if (!label || label.includes(".")) return null; // single label only
  if (RESERVED_HANDLES.has(label)) return null;
  const handle = normalizeHandle(label);
  if (!handle || handle !== label) return null; // must already be a clean handle
  return handle;
}

// guestOrigin builds the reachable origin for a Mac's HTTPS guest listener. The
// Mac serves on a high port (default 8443 — binding 443 needs root), so a bare
// https://host (port 443) hits nothing. Fall back to 8443 for installs that
// predate the guest_port column; omit the port only for a genuine 443.
function guestOrigin(host, port) {
  const p = Number(port) || 8443;
  return p === 443 ? `https://${host}` : `https://${host}:${p}`;
}

// handleRouter serves the proxied permanent link <handle>.partyparty.party. A
// proxied request reaching the Worker for this host is inherently REMOTE or IDLE
// for the LAN — LOCAL guests resolve the grey slug host direct-to-Mac — EXCEPT a
// public-IP match, which we 302 to that grey slug host (where the tight LAN audio
// is). Never 302 to a raw LAN IP; only ever to the Mac's own slug host name.
async function handleRouter(request, env, handle) {
  const isHead = request.method === "HEAD";
  const htmlHeaders = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
  const now = nowMs();
  const claimant = await liveClaimant(env, handle, now);
  // ?pp-state: tiny JSON the live-join page polls. The live event page is
  // minted by the Mac's FIRST mirror upload, so a guest who scans during the
  // ~30-60s window after Go Live renders "no remote stream yet" — this lets
  // that page discover the event page appearing (or the party ending) instead
  // of dead-ending until a manual reload.
  if (new URL(request.url).searchParams.has("pp-state")) {
    return new Response(JSON.stringify({
      live: !!claimant,
      eventPath: claimant?.event_slug ? "/e/" + encodeURIComponent(claimant.event_slug) : "",
    }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  if (claimant) {
    // Don't decide LOCAL vs REMOTE from the cloud IP — it's unreliable (Private
    // Relay / CGNAT pools / v4-v6). The page probes the Mac's LAN host itself and
    // redirects to the tight LAN listener when reachable, else the cloud mirror.
    const lanUrl = claimant.host ? `${guestOrigin(claimant.host, claimant.guest_port)}/` : "";
    // Raw-IP escape hatch for rebind-protected venues (coworking/office
    // routers that hide private-IP DNS answers): the slug hostname is
    // unresolvable for guests there, so BOTH the probe and the "tap to join"
    // link dead-end. The raw LAN IP needs no DNS at all — same URL the
    // console's own LAN QR advertises (:8000 is the product's web port). Used
    // only as the tap link's fallback after the hostname probe fails; never a
    // server-side redirect.
    const lanIpUrl = /^\d+\.\d+\.\d+\.\d+$/.test(claimant.lan_ip || "") ? `http://${claimant.lan_ip}:8000/` : "";
    const html = renderLiveJoin({
      handle,
      lanUrl,
      lanIpUrl,
      eventSlug: claimant.event_slug || "",
      djName: claimant.dj_name || "",
      eventTitle: claimant.event_title || "",
      nowPlaying: claimant.now_playing || "",
    });
    return new Response(isHead ? null : html, { headers: htmlHeaders });
  }
  // IDLE: no party live for this handle.
  const profile = await getProfileByHandle(env, handle);
  const lastEvent = profile ? await latestEventForProfile(env, profile.id) : null;
  const html = renderIdleParty({ handle, djName: profile?.display_name || "", lastEvent });
  return new Response(isHead ? null : html, { headers: htmlHeaders });
}

// liveMirrorUpload ingests the Mac's cloud HLS mirror into R2 event/<slug>/live/.
// Header-authed + streamed like publishUpload, with the slug's D1 ownership re-
// checked on every call. The playlist PUT declares the current window; segments
// it no longer names are evicted inline (best-effort; the cron is the backstop).
async function liveMirrorUpload(request, env, pathname) {
  if (request.method !== "PUT") return jsonResp(405, { error: "PUT required" });
  if (!env.DB) return jsonResp(503, { error: "events db not configured" });
  const id = request.headers.get("x-pp-id") || "";
  const rec = await authInstall(env, id, request.headers.get("x-pp-secret") || "");
  if (!rec) return jsonResp(403, { error: "bad credentials" });
  const gate = await requireLinkedInstallForPublish(env, id);
  if (gate) return gate;
  const slug = request.headers.get("x-pp-slug") || "";
  const file = request.headers.get("x-pp-file") || "";
  if (!SLUG_RE.test(slug)) return jsonResp(400, { error: "bad slug" });
  if (!LIVE_FILE_RE.test(file)) return jsonResp(400, { error: "bad file" });
  const isPlaylistRoute = pathname === "/api/broker/live-playlist";
  if (isPlaylistRoute !== file.endsWith(".m3u8")) return jsonResp(400, { error: "file/route mismatch" });
  // Ownership: the slug must be an event this install owns (same gate as
  // publishUpload) — EXCEPT that the live mirror must be able to mint the event
  // itself. Nothing else creates the row at go-live (publish-meta only runs at
  // set END), so without this the whole mirror 403s for a fresh party — observed
  // in the field: 2.8k failed segment uploads across one set. A linked install
  // claims its own slug here (first-writer-wins vs other installs unchanged) and
  // stamps status='live' so the live check-in can hand the mirror URL to remote
  // guests. Auto-publish flips it to 'replay' at set end; /offline + the cron
  // demote it if the set never publishes.
  const owner = await env.DB.prepare("SELECT install_id, status FROM events WHERE slug=?").bind(slug).first();
  if (owner && owner.install_id !== id) return jsonResp(403, { error: "not your event" });
  if (!owner || owner.status !== "live") {
    const linked = await env.DB.prepare(
      "SELECT user_id, profile_id FROM device_installs WHERE install_id=? AND revoked_ms IS NULL LIMIT 1"
    ).bind(id).first();
    if (!owner && !linked?.user_id) return jsonResp(403, { error: "not your event" });
    const now = nowMs();
    if (!owner) {
      const liveRow = await env.DB.prepare(
        "SELECT event_title, dj_name FROM live_installs WHERE install_id=? LIMIT 1"
      ).bind(id).first();
      await env.DB.prepare(
        `INSERT INTO events (slug, install_id, title, host, status, visibility, owner_user_id, dj_profile_id,
                             live_started_ms, created_ms, updated_ms, last_activity_ms)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
         ON CONFLICT(slug) DO NOTHING`
      ).bind(
        slug, id, clip(liveRow?.event_title, 200) || "", clip(liveRow?.dj_name, 80) || "",
        "live", "public", linked?.user_id || null, linked?.profile_id || null,
        now, now, now, now
      ).run();
      // Lost a create race with another install claiming the slug? Re-check.
      const after = await env.DB.prepare("SELECT install_id FROM events WHERE slug=?").bind(slug).first();
      if (!after || after.install_id !== id) return jsonResp(403, { error: "not your event" });
    } else {
      await env.DB.prepare(
        `UPDATE events
         SET status=?, updated_ms=?, last_activity_ms=?, live_started_ms=COALESCE(live_started_ms, ?)
         WHERE slug=? AND install_id=?`
      ).bind("live", now, now, now, slug, id).run();
    }
  }

  // The live check-in can arrive before the mirror has minted the event. Once
  // the row exists, associate it immediately so the handle router sends remote
  // guests to the event page instead of waiting for the next heartbeat.
  await env.DB.prepare("UPDATE live_installs SET event_slug=? WHERE install_id=?")
    .bind(slug, id).run();

  const key = `event/${slug}/live/${file}`;
  if (isPlaylistRoute) {
    const cap = 65_536;
    const cl = Number(request.headers.get("content-length") || "0");
    if (cl > cap) return jsonResp(413, { error: "too large" });
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > cap) return jsonResp(413, { error: "too large" });
    await env.DL.put(key, text, { httpMetadata: { contentType: "application/vnd.apple.mpegurl" } });
    // Inline eviction: delete any .ts under this prefix the current window no
    // longer references (a grace margin is provided by keeping the whole window).
    try {
      const referenced = new Set();
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (t && !t.startsWith("#") && t.endsWith(".ts")) referenced.add(t.split("/").pop());
      }
      const list = await env.DL.list({ prefix: `event/${slug}/live/`, limit: 1000 });
      for (const o of (list.objects || [])) {
        const base = o.key.split("/").pop();
        if (base && base.endsWith(".ts") && !referenced.has(base)) await env.DL.delete(o.key);
      }
    } catch (e) { /* eviction is best-effort GC — the cron backstop covers crashes */ }
    return jsonResp(200, { ok: true, key });
  }
  // Segment: stream straight into R2, then verify the stored size (a lying
  // content-length is deleted rather than persisted).
  const cap = 12_000_000;
  const cl = Number(request.headers.get("content-length") || "0");
  if (!cl || cl > cap) return jsonResp(413, { error: "bad size" });
  const put = await env.DL.put(key, request.body, { httpMetadata: { contentType: "audio/mp2t" } });
  const size = (put && typeof put.size === "number") ? put.size : cl;
  if (size > cap) {
    await env.DL.delete(key);
    return jsonResp(413, { error: "too large" });
  }
  return jsonResp(200, { ok: true, key });
}

// discover is the unauth auto-discovery read. It is GLOBAL by design: it returns
// up to 8 currently-live parties to ANY caller — the caller's egress IP only
// REORDERS (IP-matched first as a likely-local hint), it never filters. The
// client then probes each joinUrl; only a party whose LAN host answers with its
// valid cert (proof of being on that Wi-Fi) is ever surfaced/joined. Cloud
// IP-matching cannot be the gate: Private Relay/CGNAT give phones a different
// public IP than the DJ's Mac on the SAME network. Go Live == discoverable (no
// privacy gate); dj_name/title/now_playing are public-by-broadcast, returned raw
// and HTML-escaped at render. Lightly rate-limited per IP to blunt farming.
async function discover(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  const noStore = { "cache-control": "no-store" };
  if (!env.DB) return jsonResp(200, { parties: [] }, noStore);
  const ipHash = await sha256Hex(`ip:${request.headers.get("cf-connecting-ip") || ""}`);
  if (await discoverRateLimited(ipHash)) {
    return jsonResp(429, { error: "slow down", parties: [] }, { ...noStore, "retry-after": "2" });
  }
  const now = nowMs();
  // Return live parties for the CLIENT to probe (it fetches each joinUrl to test
  // LAN reachability — the cloud IP-match is only a hint, unreliable behind
  // Private Relay / CGNAT). IP-matched parties sort first so the likely-local one
  // is probed first; the rest let a guest whose phone shows a different public IP
  // than the DJ's Mac (the common iPhone case) still find the party by reaching
  // its LAN host. Capped; at scale swap the tail for an IP/geo pre-filter.
  const rows = (await env.DB.prepare(
    `SELECT host, guest_port, dj_name, event_title, now_playing, event_slug, handle, public_ip_hash
     FROM live_installs WHERE expires_ms>?
     ORDER BY (public_ip_hash=?) DESC, live_started_ms DESC LIMIT 8`
  ).bind(now, ipHash).all())?.results || [];
  const parties = rows.map((r) => ({
    host: r.host || "",
    handle: r.handle || "",
    // The Mac's LAN listener on its real port — the client probes this to confirm
    // it's actually on the party's network before offering to join.
    joinUrl: r.host ? `${guestOrigin(r.host, r.guest_port)}/` : "",
    ipHint: r.public_ip_hash === ipHash, // cloud IP agrees (fast path); still probed
    djName: r.dj_name || "",
    eventTitle: r.event_title || "",
    nowPlaying: r.now_playing || "",
  }));
  return jsonResp(200, { parties }, noStore);
}

// Coarse per-IP throttle via the edge cache (best-effort per-colo; any failure
// lets the request through — authoritative caps live in D1 where they matter).
// Buckets are per-endpoint (+slug where passed) so one guest hitting discover
// and then posting isn't self-throttled, and one event's traffic can't starve
// another's.
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

// renderLiveJoin: the guest page for a live handle. It does NOT trust a cloud
// IP-match to decide LOCAL vs REMOTE (iCloud Private Relay, carrier NAT pools,
// and IPv4/IPv6 splits routinely give a phone a different public IP than the
// DJ's Mac on the SAME Wi-Fi). Instead the browser PROBES the DJ's grey LAN host
// directly: that name resolves to the Mac's private LAN IP, reachable only from
// the same network, and only the Mac holds a valid cert for it — so a no-cors
// fetch that resolves is authenticated proof of being on the party's LAN.
//   reachable  -> redirect to the tight LAN listener (locked-phone LL-HLS)
//   unreachable-> the cloud mirror (a few seconds behind), or a "join on Wi-Fi"
//                 note when the DJ isn't mirroring. A manual "tap to join" link
//                 to the LAN host is always offered as a probe-false-negative
//                 escape hatch. DJ-authored text is HTML-escaped.
function renderLiveJoin({ handle, lanUrl, lanIpUrl, eventSlug, djName, eventTitle, nowPlaying }) {
  const who = djName || "@" + handle;
  // Off-Wi-Fi guests belong on the EVENT PAGE (title/cover/feed + the delayed
  // live player), not a dead-end mini page — this page is only the router:
  // probe the LAN, then send the guest to the right place.
  const eventPath = eventSlug ? `/e/${encodeURIComponent(eventSlug)}` : "";
  const nowLine = nowPlaying ? `<p class="np">Now playing: ${esc(nowPlaying)}</p>` : "";
  const lanTap = (lanUrl || lanIpUrl)
    ? `<p class="tap"><a id="pp-lan" href="${esc(lanUrl || lanIpUrl)}">At the party? Tap to join the live room &rarr;</a></p>`
    : "";
  const remoteInner = eventPath
    ? `<p class="hint"><a href="${esc(eventPath)}" style="color:#ff77b0;font-weight:600">Open the event page &rarr;</a></p>`
    : `<p class="hint">This party is live, but there's no remote stream yet. Join the party's Wi-Fi to listen.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${esc(eventTitle || who + " — live")}</title>
<style>
  :root { color-scheme: dark; }
  html,body { margin:0; height:100%; background:#0b0b12; color:#f4f4fb; font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { min-height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:24px; gap:14px; box-sizing:border-box; }
  h1 { margin:0; font-size:26px; }
  .dj { color:#b9b9d6; margin:0; }
  .live { display:inline-block; font-size:12px; letter-spacing:.12em; text-transform:uppercase; color:#ff5da2; border:1px solid #ff5da2; border-radius:999px; padding:3px 10px; }
  .np { color:#cdcded; margin:2px 0 0; }
  button { font:inherit; font-weight:600; background:#ff2d87; color:#fff; border:0; border-radius:999px; padding:14px 28px; margin-top:6px; cursor:pointer; }
  button[disabled] { background:#3a3a52; cursor:default; }
  .hint { color:#9a9ac0; font-size:14px; max-width:22em; margin:6px 0 0; }
  .tap { margin:10px 0 0; } .tap a { color:#ff77b0; font-weight:600; text-decoration:none; }
  .upgrade { background:#1d1d30; border:1px solid #ff2d87; border-radius:12px; padding:10px 16px; }
  .spin { width:26px; height:26px; border-radius:50%; border:3px solid #2a2a40; border-top-color:#ff2d87; animation:sp 0.9s linear infinite; }
  @keyframes sp { to { transform:rotate(360deg); } }
  @media(prefers-reduced-motion:reduce){ .spin{ animation:none; } }
  [hidden] { display:none !important; }
</style></head>
<body><div class="wrap">
  <span class="live">Live now</span>
  <h1>${esc(eventTitle || who)}</h1>
  <p class="dj">with ${esc(who)}</p>
  ${nowLine}
  <div id="pp-connecting">
    <div class="spin" aria-hidden="true" style="margin:8px auto 0"></div>
    <p class="hint">Looking for the party on this Wi-Fi&hellip;</p>
  </div>
  <div id="pp-remote" hidden>${remoteInner}</div>
  ${lanTap}
  <noscript>
    <style>#pp-connecting{display:none}#pp-remote{display:block !important}</style>
    ${lanUrl ? `<p class="hint">If you're at the party, use the link above.</p>` : ""}
  </noscript>
</div>
<script>
(function(){
  var LAN=${JSON.stringify(lanUrl || "").replace(/</g, "\\u003c")};
  var LANIP=${JSON.stringify(lanIpUrl || "").replace(/</g, "\\u003c")};
  var EVENT=${JSON.stringify(eventPath || "").replace(/</g, "\\u003c")};
  var connecting=document.getElementById('pp-connecting');
  var remote=document.getElementById('pp-remote');
  function showRemote(){
    if(EVENT){ location.replace(EVENT); return; } // the event page carries the delayed live player
    if(connecting) connecting.hidden=true;
    if(remote) remote.hidden=false;
    pollState(0); // the live event page is minted by the Mac's first mirror
                  // upload — keep checking so this page never dead-ends
  }
  // Poll ?pp-state until the event page exists (jump to it), the party ends
  // (reload → idle page), or ~4 minutes pass. Only runs on the no-event branch.
  function pollState(n){
    if(n>60) return;
    setTimeout(function(){
      fetch('/?pp-state',{cache:'no-store'}).then(function(r){return r.json();}).then(function(s){
        if(s && s.eventPath){ location.replace(s.eventPath); return; }
        if(s && !s.live){ location.reload(); return; }
        pollState(n+1);
      }).catch(function(){ pollState(n+2); });
    }, 4000);
  }
  if(!LAN){ showRemote(); return; }
  // Authenticated LAN reachability probe: resolves iff we can reach the DJ's Mac
  // on this network with its valid cert (TLS name-match is the anti-spoof gate).
  // no-cors so the Mac needs no CORS; connection/TLS failure or timeout = false.
  // 3.5s: on-LAN resolves well under 1s; Chrome guests whose local-network
  // permission prompt outlives it still land on the event page, which carries
  // the same "At the party?" link as a plain navigation (never permission-gated).
  function probe(url,ms){
    return new Promise(function(resolve){
      var done=false, ctrl=new AbortController();
      var t=setTimeout(function(){ if(!done){done=true; try{ctrl.abort();}catch(e){} resolve(false);} }, ms);
      fetch(url,{mode:'no-cors',cache:'no-store',signal:ctrl.signal})
        .then(function(){ if(!done){done=true; clearTimeout(t); resolve(true);} })
        .catch(function(){ if(!done){done=true; clearTimeout(t); resolve(false);} });
    });
  }
  probe(LAN,3500).then(function(local){
    if(local){ location.replace(LAN); return; }
    // Hostname unreachable — on rebind-protected venue routers (private-IP DNS
    // answers hidden) the slug host NEVER resolves for guests, so retarget the
    // "At the party?" tap at the raw LAN IP: no DNS involved, same URL the
    // console's own LAN QR shows. A user-gesture navigation, never automatic.
    if(LANIP){ var a=document.getElementById('pp-lan'); if(a) a.href=LANIP; }
    showRemote();
  });
})();
</script>
</body></html>`;
}

// renderIdleParty: the IDLE page for a handle with no live party. Links the DJ's
// profile and, when known, their most recent event.
function renderIdleParty({ handle, djName, lastEvent }) {
  const who = djName || "@" + handle;
  const last = lastEvent && lastEvent.slug
    ? `<p><a class="btn" href="/e/${encodeURIComponent(lastEvent.slug)}">${esc(lastEvent.title || "See the last set")}</a></p>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${esc(who)} — no party live right now</title>
<style>
  :root { color-scheme: dark; }
  html,body { margin:0; height:100%; background:#0b0b12; color:#f4f4fb; font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { min-height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:24px; gap:12px; box-sizing:border-box; }
  h1 { margin:0; font-size:24px; }
  p { margin:4px 0; color:#b9b9d6; }
  a.btn { display:inline-block; margin-top:8px; font-weight:600; text-decoration:none; background:#2a2a40; color:#fff; border-radius:999px; padding:12px 24px; }
  a { color:#ff77b0; }
</style></head>
<body><div class="wrap">
  <h1>No party live right now</h1>
  <p>${esc(who)} isn't broadcasting at the moment.</p>
  <p><a class="btn" href="/@${encodeURIComponent(handle)}">Visit ${esc(who)}</a></p>
  ${last}
</div></body></html>`;
}

async function brokerAccountStatus(env, id, rec) {
  if (!env.DB) return jsonResp(503, { error: "account db not configured" });
  const providersAvailable = authProvidersAvailable(env);
  const linked = await env.DB.prepare(
    `SELECT
       di.user_id,
       di.profile_id,
       u.email,
       u.display_name AS user_display_name,
       p.handle,
       p.display_name AS profile_display_name
     FROM device_installs di
     LEFT JOIN users u ON u.id=di.user_id
     LEFT JOIN dj_profiles p ON p.id=di.profile_id
     WHERE di.install_id=? AND di.revoked_ms IS NULL
     LIMIT 1`
  ).bind(id).first();
  if (!linked?.user_id) {
    return jsonResp(200, {
      ok: true,
      providersAvailable,
      linked: false,
      install: { id, slug: rec.slug || "", host: machineHost(env, rec.slug || id) },
      license: { ok: false, reason: "sign in required" },
    });
  }
  const events = await env.DB.prepare(
    `SELECT slug, title, status, scheduled_at_ms, starts, where_txt, location_name
     FROM events
     WHERE owner_user_id=?
     ORDER BY COALESCE(scheduled_at_ms, published_ms, updated_ms, created_ms, 0) DESC, slug ASC
     LIMIT 6`
  ).bind(linked.user_id).all();
  return jsonResp(200, {
    ok: true,
    providersAvailable,
    linked: true,
    user: {
      id: linked.user_id,
      email: linked.email || "",
      displayName: linked.user_display_name || "",
    },
    profile: {
      id: linked.profile_id || "",
      handle: normalizeHandle(linked.handle),
      displayName: linked.profile_display_name || "",
    },
    install: { id, slug: rec.slug || "", host: machineHost(env, rec.slug || id) },
    license: { ok: true, source: "account" },
    events: events?.results || [],
  });
}

async function brokerAccountUnlink(env, id) {
  if (!env.DB) return jsonResp(503, { error: "account db not configured" });
  const now = nowMs();
  const result = await env.DB.prepare(
    "UPDATE device_installs SET revoked_ms=?, last_seen_ms=? WHERE install_id=? AND revoked_ms IS NULL"
  ).bind(now, now, id).run();
  if ((Number(result?.meta?.changes) || 0) > 0) await clearRevokedInstallLiveState(env, id, now);
  return jsonResp(200, { ok: true, revoked: Number(result?.meta?.changes) || 0 });
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
  const gate = await requireLinkedInstallForPublish(env, id);
  if (gate) return gate;
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
  if (request.method !== "PUT" && request.method !== "DELETE") return jsonResp(405, { error: "PUT or DELETE required" });
  if (!env.DB) return jsonResp(503, { error: "events db not configured" });
  const id = request.headers.get("x-pp-id") || "";
  const rec = await authInstall(env, id, request.headers.get("x-pp-secret") || "");
  if (!rec) return jsonResp(403, { error: "bad credentials" });
  const gate = await requireLinkedInstallForPublish(env, id);
  if (gate) return gate;
  const slug = request.headers.get("x-pp-slug") || "";
  if (!SLUG_RE.test(slug)) return jsonResp(400, { error: "bad slug" });
  if (request.method === "DELETE") {
    const row = await env.DB.prepare("SELECT install_id, cover_key FROM events WHERE slug=?").bind(slug).first();
    if (row && row.install_id !== id) return jsonResp(409, { error: "slug taken" });
    if (!row) return jsonResp(200, { ok: true });
    if (row.cover_key) await env.DL.delete(row.cover_key);
    const now = Date.now();
    await env.DB.prepare("UPDATE events SET cover_key=NULL, updated_ms=? WHERE slug=? AND install_id=?").bind(now, slug, id).run();
    await auditPublish(env, id, slug, "delete-cover");
    return jsonResp(200, { ok: true });
  }
  // First-writer-wins, matching publish-meta: a cover can create/claim the
  // event row before the set itself exists, but never steal another install's slug.
  const owner = await env.DB.prepare("SELECT install_id FROM events WHERE slug=?").bind(slug).first();
  if (owner && owner.install_id !== id) return jsonResp(409, { error: "slug taken" });
  if (!owner && await slugReservedByAlias(env, slug, "")) return jsonResp(409, { error: "slug reserved" });
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

async function readPostMediaHeaders(request, env) {
  if (!env.DB) return jsonResp(503, { error: "events db not configured" });
  const id = request.headers.get("x-pp-id") || "";
  const rec = await authInstall(env, id, request.headers.get("x-pp-secret") || "");
  if (!rec) return jsonResp(403, { error: "bad credentials" });
  const gate = await requireLinkedInstallForPublish(env, id);
  if (gate) return gate;

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

  return { id, slug, postId, mediaId, mediaType, mimeType, name, sortOrder, existing, key: `event/${slug}/posts/${postId}/${mediaId}` };
}

async function upsertPostMedia(env, meta, size, auditAction = "publish-post-media") {
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
  ).bind(meta.mediaId, meta.slug, meta.postId, meta.key, meta.mediaType, meta.mimeType, meta.name, size, meta.sortOrder, now).run();
  const saved = await env.DB.prepare("SELECT slug, post_id FROM post_media WHERE id=?").bind(meta.mediaId).first();
  if (!saved || saved.slug !== meta.slug || saved.post_id !== meta.postId) {
    await env.DL.delete(meta.key);
    return jsonResp(403, { error: "media id taken" });
  }
  await env.DB.prepare("UPDATE events SET last_activity_ms=? WHERE slug=? AND install_id=?").bind(now, meta.slug, meta.id).run();
  await auditPublish(env, meta.id, meta.slug, auditAction);
  return jsonResp(200, { ok: true, key: meta.key, mediaId: meta.mediaId });
}

async function publishPostMedia(request, env) {
  if (request.method !== "PUT") return jsonResp(405, { error: "PUT required" });
  const meta = await readPostMediaHeaders(request, env);
  if (meta instanceof Response) return meta;

  const cl = Number(request.headers.get("content-length") || "0");
  if (!cl || cl > POST_MEDIA_CAP_BYTES) return jsonResp(413, { error: "bad size" });
  const put = await env.DL.put(meta.key, request.body, { httpMetadata: { contentType: meta.mimeType } });
  const size = (put && typeof put.size === "number") ? put.size : cl;
  if (size > POST_MEDIA_CAP_BYTES) {
    await env.DL.delete(meta.key);
    return jsonResp(413, { error: "too large" });
  }

  return await upsertPostMedia(env, meta, size);
}

async function publishPostMediaMultipartInit(request, env) {
  if (request.method !== "POST") return jsonResp(405, { error: "POST required" });
  const meta = await readPostMediaHeaders(request, env);
  if (meta instanceof Response) return meta;
  const declared = Number(request.headers.get("x-pp-size") || "0");
  if (!declared || declared > POST_MEDIA_CAP_BYTES) return jsonResp(413, { error: "bad size" });
  if (meta.existing) {
    const obj = await env.DL.head(meta.key);
    if (obj) return jsonResp(200, { ok: true, complete: true, key: meta.key, mediaId: meta.mediaId, size: obj.size || declared });
  }
  const upload = await env.DL.createMultipartUpload(meta.key, { httpMetadata: { contentType: meta.mimeType } });
  return jsonResp(200, { ok: true, uploadId: upload.uploadId, key: meta.key, mediaId: meta.mediaId });
}

async function publishPostMediaMultipartPart(request, env) {
  if (request.method !== "PUT") return jsonResp(405, { error: "PUT required" });
  const meta = await readPostMediaHeaders(request, env);
  if (meta instanceof Response) return meta;
  const uploadId = request.headers.get("x-pp-upload-id") || "";
  if (!uploadId || /[\x00-\x1F\x7F]/.test(uploadId) || uploadId.length > 512) {
    return jsonResp(400, { error: "bad upload id" });
  }
  const partNumber = Number(request.headers.get("x-pp-part-number") || "0");
  if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return jsonResp(400, { error: "bad part number" });
  }
  const cl = Number(request.headers.get("content-length") || "0");
  if (!cl || cl > POST_MEDIA_MULTIPART_MAX_PART_BYTES) return jsonResp(413, { error: "bad size" });

  const upload = env.DL.resumeMultipartUpload(meta.key, uploadId);
  const part = await upload.uploadPart(partNumber, request.body);
  return jsonResp(200, { ok: true, partNumber, etag: part.etag });
}

async function publishPostMediaMultipartComplete(request, env) {
  if (request.method !== "POST") return jsonResp(405, { error: "POST required" });
  const meta = await readPostMediaHeaders(request, env);
  if (meta instanceof Response) return meta;
  const existingObj = meta.existing ? await env.DL.head(meta.key) : null;
  if (meta.existing && existingObj) {
    return jsonResp(200, { ok: true, key: meta.key, mediaId: meta.mediaId, size: existingObj.size || 0, complete: true });
  }

  const body = await readJson(request, 256_000);
  if (!body) return READ_JSON_TOO_LARGE.has(request) ? jsonResp(413, { error: "too large" }) : jsonResp(400, { error: "bad json" });
  const uploadId = String(body.uploadId || request.headers.get("x-pp-upload-id") || "");
  if (!uploadId || /[\x00-\x1F\x7F]/.test(uploadId) || uploadId.length > 512) {
    return jsonResp(400, { error: "bad upload id" });
  }
  const parts = Array.isArray(body.parts) ? body.parts.map((p) => ({
    partNumber: Number(p && p.partNumber),
    etag: String(p && p.etag || ""),
  })) : [];
  if (!parts.length || parts.length > 10000) return jsonResp(400, { error: "bad parts" });
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (!Number.isSafeInteger(p.partNumber) || p.partNumber !== i + 1 || !p.etag || p.etag.length > 256) {
      return jsonResp(400, { error: "bad parts" });
    }
  }

  const upload = env.DL.resumeMultipartUpload(meta.key, uploadId);
  const obj = await upload.complete(parts);
  const head = (obj && typeof obj.size === "number") ? obj : await env.DL.head(meta.key);
  const size = head && typeof head.size === "number" ? head.size : Number(body.size || "0");
  if (!size || size > POST_MEDIA_CAP_BYTES) {
    await env.DL.delete(meta.key);
    return jsonResp(413, { error: "too large" });
  }
  return await upsertPostMedia(env, meta, size, "publish-post-media-multipart");
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
  if (pathname === "/api/broker/link-install") return 2_048;
  if (pathname === "/api/broker/link-start") return 2_048;
  if (pathname === "/api/broker/account-status") return 2_048;
  if (pathname === "/api/broker/account-unlink") return 2_048;
  if (pathname === "/api/broker/live") return 2_048;
  if (pathname === "/api/broker/offline") return 2_048;
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
  if (pathname === "/api/broker/publish-post-media-multipart-init") {
    return await publishPostMediaMultipartInit(request, env);
  }
  if (pathname === "/api/broker/publish-post-media-multipart-part") {
    return await publishPostMediaMultipartPart(request, env);
  }
  if (pathname === "/api/broker/publish-post-media-multipart-complete") {
    return await publishPostMediaMultipartComplete(request, env);
  }
  // Cloud HLS live mirror ingest: header-authed + streamed, so (like the publish
  // uploads) they run BEFORE the POST-only guard and the request.json() parse.
  if (pathname === "/api/broker/live-segment" || pathname === "/api/broker/live-playlist") {
    return await liveMirrorUpload(request, env, pathname);
  }
  if (request.method !== "POST") return jsonResp(405, { error: "POST required" });
  if (!env.CF_DNS_TOKEN || !env.CF_ZONE_ID || !env.BROKER_BASE) return jsonResp(503, { error: "broker not configured" });
  const jsonCap = brokerJsonCap(pathname);
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength && contentLength > jsonCap) return jsonResp(413, { error: "too large" });
  const body = await readJson(request, jsonCap);
  if (!body) return READ_JSON_TOO_LARGE.has(request) ? jsonResp(413, { error: "too large" }) : jsonResp(400, { error: "bad json" });

  if (pathname === "/api/broker/register") {
    // Registration is necessarily unauthenticated, but each success allocates
    // an install record plus a slug reservation in R2. Bound cheap retry/flood
    // amplification per edge location; Cloudflare supplies this IP header.
    const ipHash = await sha256Hex(`ip:${request.headers.get("cf-connecting-ip") || ""}`);
    if (await discoverRateLimited(ipHash, "register", 10)) {
      return jsonResp(429, { error: "slow down" }, { "retry-after": "10" });
    }
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const secret = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    // Pretty, memorable hostname label (disco42, groove7…) — the guest link is
    // https://<slug>.<base>:8443/, not an IP-encoded eyesore.
    const slug = await newBrokerSlug(env, id);
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

  // Admin-only zone-record maintenance in THIS worker's zone (env.CF_ZONE_ID)
  // through the same DNS token the cert broker already holds. Exists for
  // operations the broker's own flows don't cover: deleting imported junk that
  // blocks custom-domain provisioning, bootstrapping the wildcard record. Ops:
  // list / create / delete-by-id.
  if (pathname === "/api/broker/dns-admin") {
    if (!isAdmin) return jsonResp(403, { error: "admin only" });
    const op = String(body.op || "list");
    // Optional zone override (any zone the CF_DNS_TOKEN can reach) — used for
    // one-off maintenance like sweeping a retired zone. Defaults to CF_ZONE_ID.
    const zone = body.zone != null && /^[0-9a-f]{32}$/i.test(String(body.zone)) ? String(body.zone) : undefined;
    if (body.zone != null && !zone) return jsonResp(400, { error: "bad zone" });
    try {
      if (op === "list") {
        const search = body.search ? `&search=${encodeURIComponent(String(body.search).slice(0, 120))}` : "";
        const recs = await cfDNS(env, "GET", `?per_page=100${search}`, undefined, zone);
        return jsonResp(200, { ok: true, records: (recs || []).map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied })) });
      }
      if (op === "create") {
        const rec = { type: String(body.type || "A"), name: String(body.name || ""), content: String(body.content || ""), ttl: 1, proxied: body.proxied !== false };
        if (!rec.name || !rec.content) return jsonResp(400, { error: "name and content required" });
        if (body.priority != null) rec.priority = Number(body.priority) || 0; // MX
        const made = await cfDNS(env, "POST", "", rec, zone);
        return jsonResp(200, { ok: true, id: made?.id || "" });
      }
      if (op === "delete") {
        const rid = String(body.recordId || "");
        if (!/^[0-9a-f]{32}$/i.test(rid)) return jsonResp(400, { error: "bad recordId" });
        await cfDNS(env, "DELETE", "/" + encodeURIComponent(rid), undefined, zone);
        return jsonResp(200, { ok: true });
      }
      return jsonResp(400, { error: "bad op" });
    } catch (e) {
      return jsonResp(502, { error: String((e && e.message) || e) });
    }
  }
  const id = String(body.id || "");
  if (!/^[a-f0-9]{12}$/.test(id)) return jsonResp(400, { error: "bad id" });

  if (pathname === "/api/broker/link-start") {
    const rec = await authInstall(env, id, body.secret || "");
    if (!rec) return jsonResp(403, { error: "bad credentials" });
    return await installBrowserLinkStart(env, id, rec, request);
  }

  if (pathname === "/api/broker/account-status") {
    const rec = await authInstall(env, id, body.secret || "");
    if (!rec) return jsonResp(403, { error: "bad credentials" });
    return await brokerAccountStatus(env, id, rec);
  }

  if (pathname === "/api/broker/account-unlink") {
    const rec = await authInstall(env, id, body.secret || "");
    if (!rec) return jsonResp(403, { error: "bad credentials" });
    return await brokerAccountUnlink(env, id);
  }

  if (pathname === "/api/broker/link-install") {
    if (!env.DB) return jsonResp(503, { error: "link db not configured" });
    const rec = await authInstall(env, id, body.secret || "");
    if (!rec) return jsonResp(403, { error: "bad credentials" });
    const now = nowMs();
    if (await installLinkAttemptsExceeded(env, id, now)) return jsonResp(429, { error: "rate limited" });
    const code = String(body.code || "").trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(code)) {
      await recordInstallLinkFailure(env, id, now);
      return jsonResp(400, { error: "bad code" });
    }
    const token = await env.DB.prepare("SELECT * FROM install_link_tokens WHERE code_hash=? LIMIT 1")
      .bind(await sha256Hex(code)).first();
    if (!token || token.used_ms != null || Number(token.expires_ms) <= now) {
      await recordInstallLinkFailure(env, id, now);
      return jsonResp(400, { error: "invalid code" });
    }
    const profile = await env.DB.prepare("SELECT * FROM dj_profiles WHERE id=? LIMIT 1").bind(token.profile_id).first();
    if (!profile?.id) {
      await recordInstallLinkFailure(env, id, now);
      return jsonResp(400, { error: "invalid code" });
    }
    const existing = await env.DB.prepare(
      "SELECT user_id, profile_id, revoked_ms FROM device_installs WHERE install_id=? LIMIT 1"
    ).bind(id).first();
    if (existing && existing.revoked_ms == null && existing.user_id && existing.user_id !== token.user_id) {
      return jsonResp(409, { error: "install already linked to another account; unlink it first" });
    }

    const mark = await env.DB.prepare(
      "UPDATE install_link_tokens SET used_ms=?, install_id=? WHERE id=? AND used_ms IS NULL"
    ).bind(now, id, token.id).run();
    if ((Number(mark?.meta?.changes) || 0) < 1) {
      await recordInstallLinkFailure(env, id, now);
      return jsonResp(400, { error: "invalid code" });
    }

    await env.DB.prepare(
      `INSERT INTO device_installs
         (install_id, install_slug, user_id, profile_id, label, created_ms, linked_ms, last_seen_ms, revoked_ms)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, NULL)
       ON CONFLICT(install_id) DO UPDATE SET
         install_slug=excluded.install_slug,
         user_id=excluded.user_id,
         profile_id=excluded.profile_id,
         linked_ms=excluded.linked_ms,
         last_seen_ms=excluded.last_seen_ms,
         revoked_ms=NULL`
    ).bind(id, rec.slug || "", token.user_id, token.profile_id, now, now, now).run();
    await clearInstallLinkFailures(env, id);
    return jsonResp(200, { ok: true, handle: normalizeHandle(profile.handle) });
  }

  const rec = await env.DL.get(`broker/${id}.json`).then((o) => (o ? o.json() : null));
  const READ_ONLY = ["/api/broker/telemetry-dump", "/api/broker/log-list", "/api/broker/log-get"];
  if (isAdmin && READ_ONLY.includes(pathname)) {
    // admin bypass — read-only endpoints only
  } else if (!rec || rec.secret !== body.secret) {
    return jsonResp(403, { error: "bad credentials" });
  }

  // The install's namespace label. DNS writes below upgrade pre-slug installs
  // to a pretty slug before touching Cloudflare.
  let label = rec.slug || id;

  // Every JSON route that mutates cloud event state requires a current account
  // link. A revoked install may still retain its broker secret and own old event
  // rows, so ownership alone is not an activation boundary. Header-authenticated
  // binary routes enforce the same gate in their helpers above.
  if (["/api/broker/publish-meta", "/api/broker/event-upsert", "/api/broker/publish-posts", "/api/broker/event-status"].includes(pathname)) {
    const gate = await requireLinkedInstallForPublish(env, id);
    if (gate) return gate;
  }

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
    if (owner && owner.install_id !== id && !(await claimUnassignedAccountEvent(env, slug, id))) {
      return jsonResp(409, { error: "slug taken" });
    }
    if (!owner && await slugReservedByAlias(env, slug, "")) return jsonResp(409, { error: "slug reserved" });
    const now = nowMs();
    const linked = await env.DB.prepare(
      "SELECT user_id, profile_id FROM device_installs WHERE install_id=? AND revoked_ms IS NULL LIMIT 1"
    ).bind(id).first();
    const ownerUserId = linked?.user_id || null;
    const djProfileId = linked?.profile_id || null;
    // Auto-published sets go PUBLIC by default so a finished set appears on the
    // DJ's /@handle profile automatically (the whole point: play a set -> it's
    // on your page). Only on INSERT — a re-publish never overrides a visibility
    // the DJ later set by hand (visibility is absent from the DO UPDATE SET).
    await env.DB.prepare(
      `INSERT INTO events (slug, install_id, title, host, starts, where_txt, tagline, about, status, visibility, owner_user_id, dj_profile_id, created_ms, updated_ms, last_activity_ms)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'replay','public',?9,?10,?11,?11,?11)
       ON CONFLICT(slug) DO UPDATE SET title=?3, host=?4, starts=?5, where_txt=?6, tagline=?7, about=?8, status='replay',
         owner_user_id=COALESCE(?9, owner_user_id), dj_profile_id=COALESCE(?10, dj_profile_id), updated_ms=?11, last_activity_ms=?11
       WHERE events.install_id=?2`
    ).bind(slug, id, clip(body.title, 200), clip(body.host, 80), clip(body.starts, 120),
      clip(body.where, 120), clip(body.tagline, 200), clip(body.about, 4000), ownerUserId, djProfileId, now).run();
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
    const oldSlug = String(body.old_slug || body.previous_slug || body.previousSlug || "").trim();
    if (oldSlug && !SLUG_RE.test(oldSlug)) return jsonResp(400, { error: "bad old_slug" });

    const owner = await env.DB.prepare("SELECT install_id FROM events WHERE slug=?").bind(slug).first();
    if (owner && owner.install_id !== id && !(await claimUnassignedAccountEvent(env, slug, id))) {
      return jsonResp(409, { error: "slug taken" });
    }
    if (!owner && await slugReservedByAlias(env, slug, oldSlug)) return jsonResp(409, { error: "slug reserved" });
    if (oldSlug && oldSlug !== slug && !owner) {
      const oldOwner = await env.DB.prepare("SELECT install_id FROM events WHERE slug=?").bind(oldSlug).first();
      if (oldOwner) {
        if (oldOwner.install_id !== id) return jsonResp(403, { error: "not owner" });
        if (await eventRenameBlocked(env, oldSlug)) return jsonResp(409, { error: "event with activity cannot be renamed" });
        await env.DB.prepare("UPDATE events SET slug=? WHERE slug=? AND install_id=?").bind(slug, oldSlug, id).run();
      }
    }

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
      "SELECT user_id, profile_id FROM device_installs WHERE install_id=? AND revoked_ms IS NULL LIMIT 1"
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
    if (oldSlug && oldSlug !== slug) {
      await recordEventAlias(env, oldSlug, slug, now, { install_id: id });
    }
    await bumpDjProfileActivity(env, check.dj_profile_id, now);
    return jsonResp(200, { ok: true, slug, url: `${SITE_ORIGIN}/e/${slug}`, status: check.status || "upcoming" });
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
      "SELECT profile_id FROM device_installs WHERE install_id=? AND revoked_ms IS NULL LIMIT 1"
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
      url: `${SITE_ORIGIN}/e/${row.slug}`,
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
    const linkedErr = await requireLinkedInstallForDNS(env, id);
    if (linkedErr) return linkedErr;
    label = await ensureBrokerSlug(env, id, rec);
    const value = String(body.value || "");
    if (!value || value.length > 255) return jsonResp(400, { error: "bad value" });
    const name = `_acme-challenge.${machineHost(env, label)}`;
    const old = await cfDNS(env, "GET", `?type=TXT&name=${name}`);
    for (const r of old || []) await cfDNS(env, "DELETE", "/" + r.id);
    await cfDNS(env, "POST", "", { type: "TXT", name, content: value, ttl: 60 });
    return jsonResp(200, { ok: true, name });
  }

  if (pathname === "/api/broker/a") {
    const linkedErr = await requireLinkedInstallForDNS(env, id);
    if (linkedErr) return linkedErr;
    // May RENAME the slug to the handle-derived name (seth -> seth-live): this
    // is the Mac's own refresh call, so it adopts the returned host + new cert
    // in the same cycle. Never renames while live.
    label = await ensureHandleSlug(env, id, rec, nowMs());
    const ip = String(body.ip || "");
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return jsonResp(400, { error: "bad ip" });
    // ONE slugged record per install, upserted to the current venue IP
    // (DNS-only, never proxied). The cert binds to this domain, not the IP.
    const name = machineHost(env, label);
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

  // Live presence heartbeat (~30s while broadcasting). Registers/refreshes the
  // install's live_installs row and keeps its grey slug-host A record current.
  // The PUBLIC ip is read from cf-connecting-ip ONLY — never a Mac-supplied value.
  // handle/display_name are resolved server-side (device_installs -> dj_profiles)
  // so a party can never claim another handle. This is READ-ONLY w.r.t. events —
  // it never claims a slug, so it can never 409 against the publish-meta claim.
  if (pathname === "/api/broker/live") {
    if (!env.DB) return jsonResp(503, { error: "events db not configured" });
    const linked = await env.DB.prepare(
      "SELECT user_id, profile_id FROM device_installs WHERE install_id=? AND revoked_ms IS NULL LIMIT 1"
    ).bind(id).first();
    if (!linked?.user_id || !linked?.profile_id) {
      return jsonResp(403, { error: "link this Mac to your account to go live", reason: "not_linked" });
    }
    const profile = await env.DB.prepare(
      "SELECT handle, display_name, primary_install_id FROM dj_profiles WHERE id=? LIMIT 1"
    ).bind(linked.profile_id).first();
    const handle = normalizeHandle(profile?.handle || "");
    if (!handle) return jsonResp(409, { error: "profile has no handle" });

    const publicIpHash = await sha256Hex(`ip:${request.headers.get("cf-connecting-ip") || ""}`);
    const lanIp = String(body.lan_ip || "");
    if (lanIp && !/^\d{1,3}(\.\d{1,3}){3}$/.test(lanIp)) return jsonResp(400, { error: "bad lan_ip" });
    // Guest HTTPS port (default 8443). Sanitize to a valid TCP port; 0 => stored
    // null and the reader falls back to 8443.
    const guestPort = Math.min(65535, Math.max(0, Math.floor(Number(body.guest_port) || 0))) || null;

    // The grey LAN slug host the Mac serves — resolved server-side, never the
    // proxied handle name (the handle is a proxied Worker record, never a grey A).
    label = await ensureBrokerSlug(env, id, rec);
    const host = machineHost(env, label);

    // The cloud mirror is uploaded under the install's currently-live event slug;
    // resolve it so the REMOTE listener page points at the right mirror. Read-only.
    const liveEvent = await env.DB.prepare(
      "SELECT slug FROM events WHERE install_id=? AND status='live' ORDER BY COALESCE(live_started_ms, updated_ms, 0) DESC LIMIT 1"
    ).bind(id).first();
    const eventSlug = liveEvent?.slug || "";

    const now = nowMs();
    const expiresMs = now + LIVE_PRESENCE_TTL_MS;
    await env.DB.prepare(
      `INSERT INTO live_installs
         (install_id, handle, profile_id, public_ip_hash, host, lan_ip, guest_port, event_slug,
          dj_name, event_title, listeners, now_playing, live_started_ms, last_seen_ms, expires_ms)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?13,?14)
       ON CONFLICT(install_id) DO UPDATE SET
         handle=?2, profile_id=?3, public_ip_hash=?4, host=?5, lan_ip=?6, guest_port=?7, event_slug=?8,
         dj_name=?9, event_title=?10, listeners=?11, now_playing=?12, last_seen_ms=?13, expires_ms=?14`
    ).bind(
      id, handle, linked.profile_id, publicIpHash, host, lanIp, guestPort, eventSlug,
      clip(profile?.display_name, 120), clip(body.title, 200),
      Math.max(0, Number(body.listeners) || 0), clip(body.now_playing, 200),
      now, expiresMs
    ).run();

    // Keep the LAN slug host's grey A current with the Mac's LAN IP. Best-effort:
    // a DNS hiccup must never drop the party from discovery/routing.
    if (lanIp) {
      try { await writeGreyA(env, host, lanIp); } catch (e) { /* best-effort */ }
    }

    // Which install represents this handle now (most-recent go-live, primary
    // override) — tells this Mac whether the router points at it.
    const claimant = await liveClaimant(env, handle, now);
    // The web side of the party rides back on the heartbeat the Mac already
    // makes: how many web guests are listening, and their recent wall posts —
    // the Mac injects those into the ROOM feed so both crowds see one party.
    let webCount = 0;
    let webPosts = [];
    if (eventSlug) {
      try {
        webCount = await webListeners(env, eventSlug, now);
        // Cursor (review finding): without it, >50 web posts in the window
        // starves delivery — the oldest 50 are re-sent forever and newer posts
        // never reach the room. The Mac echoes the max ts it has ingested;
        // its CID dedupe makes an approximate cursor perfectly safe.
        const webSince = Math.max(now - 6 * 3600_000, Math.floor(Number(body.web_since) || 0));
        const rows = (await env.DB.prepare(
          `SELECT id, author, emoji, text, ts_ms FROM posts
           WHERE slug=? AND source='web' AND approved=1 AND deleted_ms IS NULL AND ts_ms>?
           ORDER BY ts_ms ASC LIMIT 50`
        ).bind(eventSlug, webSince).all())?.results || [];
        webPosts = rows.map((r) => ({
          id: r.id, author: r.author || "", emoji: r.emoji || "", text: r.text || "", ts: r.ts_ms,
        }));
      } catch (e) { /* the heartbeat itself must never fail on feed reads */ }
    }
    return jsonResp(200, {
      ok: true, host, claimed: !!(claimant && claimant.install_id === id),
      webListeners: webCount, webPosts,
    });
  }

  // Clean go-offline (Stop / quit): drop this install's presence immediately and
  // remove its grey slug-host A record, then recompute the handle's claimant.
  if (pathname === "/api/broker/offline") {
    if (!env.DB) return jsonResp(503, { error: "events db not configured" });
    const row = await env.DB.prepare(
      "SELECT install_id, handle, host FROM live_installs WHERE install_id=? LIMIT 1"
    ).bind(id).first();
    await env.DB.prepare("DELETE FROM live_installs WHERE install_id=?").bind(id).run();
    // The set is over: demote this install's mirror-minted 'live' events so /e/
    // pages and the check-in's live-event lookup don't see a phantom live party.
    // Auto-publish normally does this (status='replay' + the actual set); this
    // covers short/unpublished sets. Best-effort.
    try {
      await env.DB.prepare(
        "UPDATE events SET status='replay', updated_ms=?2 WHERE install_id=?1 AND status='live'"
      ).bind(id, nowMs()).run();
    } catch (e) { /* best-effort */ }
    // Per-install slug hosts are unique, so dropping this one never strands
    // another live Mac sharing the handle.
    if (row?.host && env.CF_DNS_TOKEN && env.CF_ZONE_ID) {
      try { await deleteGreyA(env, row.host); } catch (e) { /* best-effort */ }
    }
    const handle = normalizeHandle(row?.handle || "");
    const claimant = handle ? await liveClaimant(env, handle, nowMs()) : null;
    return jsonResp(200, { ok: true, claimed: !!(claimant && claimant.install_id === id) });
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
    const url = new URL(request.url);
    const { pathname } = url;

    // WILDCARD HOSTNAME ROUTER — before any path dispatch. If the Host is the
    // proxied permanent link <handle>.partyparty.party (a single clean handle
    // label, not the apex, not a reserved word), its root serves a LAN probe:
    // reachable guests go to the Mac's grey host; everyone else goes to the
    // cloud event page, or sees the idle state. Only the root is intercepted —
    // mirror, event, asset, and API paths always fall through normally.
    if (env.DB && pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      // The handle router owns ONLY the root path of <handle>.partyparty.party.
      // Every other path falls through to the normal routes so the SAME host can
      // serve /e/<slug>, the /event/<slug>/live/* mirror files, and the APIs —
      // this is what lets the remote page's relative audio URL actually stream.
      // (Intercepting all paths here once returned the JOIN PAGE to the <audio>
      // element's playlist request — "tap to listen" silently did nothing.)
      const routerHandle = handleRouterLabel(env, url.hostname);
      if (routerHandle && url.pathname === "/") return await handleRouter(request, env, routerHandle);
    }

    // Apple Sign in with Apple domain verification. Served from a secret the
    // owner sets (wrangler secret put APPLE_DOMAIN_ASSOC < the downloaded file)
    // so the public verification token stays out of the repo.
    if (pathname === "/.well-known/apple-developer-domain-association.txt") {
      if (env.APPLE_DOMAIN_ASSOC) {
        return new Response(env.APPLE_DOMAIN_ASSOC, {
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }
      return new Response("Not configured", { status: 404 });
    }

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

    if (pathname === "/auth/google") {
      try {
        return await googleAuthStart(request, env);
      } catch (_) {
        return redirectResp("/login");
      }
    }

    if (pathname === "/auth/google/callback") {
      try {
        return await googleAuthCallback(request, env);
      } catch (_) {
        return oauthError("oauth");
      }
    }

    if (pathname === "/auth/apple") {
      try {
        return await appleAuthStart(request, env);
      } catch (_) {
        return redirectResp("/login");
      }
    }

    if (pathname === "/auth/apple/callback") {
      try {
        return await appleAuthCallback(request, env);
      } catch (_) {
        return oauthError("oauth");
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

    if (pathname === "/api/handle-available") {
      const norm = normalizeHandle(new URL(request.url).searchParams.get("h") || "");
      if (!norm) return jsonResp(200, { available: false, reason: "invalid", handle: "" });
      if (RESERVED_HANDLES.has(norm)) return jsonResp(200, { available: false, reason: "reserved", handle: norm });
      return jsonResp(200, { available: await handleAvailable(env, norm), handle: norm });
    }

    // Same-Wi-Fi auto-discovery: unauth, no privacy gate (Go Live == discoverable).
    if (pathname === "/api/discover") {
      try {
        return await discover(request, env);
      } catch (e) {
        return jsonResp(200, { parties: [] }, { "cache-control": "no-store" });
      }
    }

    if (pathname === "/api/version") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const headers = { "cache-control": "public, max-age=300" };
      if (request.method === "HEAD") {
        return new Response(null, { headers: { ...headers, "content-type": "application/json" } });
      }
      // A full native release writes content/app-version for Sparkle push. A
      // payload-only release intentionally leaves that marker alone, so an old
      // native marker must not hide the newer effective version compiled into
      // this Worker by ship.sh.
      let version = APP_VERSION, date = APP_VERSION_DATE;
      try {
        const a = await env.DL.get("content/app-version");
        if (a) {
          const v = (await a.text()).trim();
          if (v && compareProductVersions(v, version) >= 0) {
            version = v;
            if (a.uploaded) date = new Date(a.uploaded).toISOString().slice(0, 10);
          }
        }
      } catch (e) { /* keep the fallback constants */ }
      return jsonResp(200, { version, date }, headers);
    }

    if (pathname === "/api/install-link/create") {
      try {
        return await installLinkCreate(request, env);
      } catch (e) {
        return jsonResp(500, { error: String((e && e.message) || e) });
      }
    }

    if (pathname === "/api/install-link/unlink") {
      try {
        return await installLinkUnlink(request, env);
      } catch (e) {
        return jsonResp(500, { error: String((e && e.message) || e) });
      }
    }

    if (pathname === "/link-mac") {
      try {
        return await linkMacResponse(request, env);
      } catch (_) {
        return linkMacPage("Link unavailable", "Open partyparty on your Mac and start sign-in again.");
      }
    }

    if (pathname === "/login") {
      try {
        return await loginResponse(request, env);
      } catch (_) {
        return new Response(renderNotFound(), {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
    }

    if (pathname === "/account") {
      try {
        return await accountResponse(request, env);
      } catch (_) {
        return new Response(renderNotFound(), {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
    }

    if (pathname === "/welcome") {
      try {
        return await welcomeResponse(request, env);
      } catch (_) {
        return new Response(renderNotFound(), {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
    }

    if (pathname === "/settings") {
      try {
        return await settingsResponse(request, env);
      } catch (_) {
        return new Response(renderNotFound(), {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
    }

    if (pathname === "/profile/edit") {
      try {
        return await profileEditResponse(request, env);
      } catch (_) {
        return new Response(renderNotFound(), {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
    }

    if (pathname === "/events/new") {
      try {
        return await newEventResponse(request, env);
      } catch (_) {
        return new Response(renderNotFound(), {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
    }

    if (pathname === "/api/profile") {
      try {
        return await profileApi(request, env);
      } catch (e) {
        return jsonResp(500, { error: String((e && e.message) || e) });
      }
    }

    if (pathname === "/api/handle/confirm") {
      try {
        return await handleConfirmApi(request, env);
      } catch (e) {
        return jsonResp(500, { error: String((e && e.message) || e) });
      }
    }

    if (pathname === "/api/settings") {
      try {
        return await settingsApi(request, env);
      } catch (e) {
        return jsonResp(500, { error: String((e && e.message) || e) });
      }
    }

    if (pathname === "/api/profile/socials") {
      try {
        return await profileSocialsApi(request, env);
      } catch (e) {
        return jsonResp(500, { error: String((e && e.message) || e) });
      }
    }

    if (pathname === "/api/events") {
      try {
        return await createEventApi(request, env);
      } catch (e) {
        return jsonResp(500, { error: String((e && e.message) || e) });
      }
    }

    if (pathname === "/api/follow") {
      try {
        return await followApi(request, env);
      } catch (e) {
        return jsonResp(500, { error: String((e && e.message) || e) });
      }
    }

    const webEventApi = pathname.match(WEB_EVENT_API_RE);
    if (webEventApi) {
      try {
        return await updateEventApi(request, env, webEventApi[1]);
      } catch (e) {
        return jsonResp(500, { error: String((e && e.message) || e) });
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

    const join = pathname.match(JOIN_RE);
    if (join) {
      try {
        return await eventJoin(request, env, join[1]);
      } catch (e) {
        return jsonResp(500, { error: String((e && e.message) || e) });
      }
    }

    const presence = pathname.match(PRESENCE_RE);
    if (presence) {
      try {
        return await eventPresence(request, env, presence[1]);
      } catch (e) {
        return jsonResp(500, { error: String((e && e.message) || e) });
      }
    }

    const webPost = pathname.match(WEBPOST_RE);
    if (webPost) {
      try {
        return await eventWebPost(request, env, webPost[1]);
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
      // The publisher can retry/replace a media ID at this same URL, so this is
      // mutable content. A year-long immutable response would pin the first
      // object after an interrupted upload or edit.
      const cache = "public, max-age=300";
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

    // Cloud HLS live mirror, from R2 under event/<slug>/live/. The media playlist
    // is served no-store (guests must always fetch the live edge); .ts segments are
    // content-addressed by the encoder's sequence, so they're CDN-cacheable +
    // range-aware and origin reads collapse across many remote listeners.
    const liveMedia = pathname.match(LIVE_MEDIA_RE);
    if (liveMedia) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const file = liveMedia[2];
      const key = `event/${liveMedia[1]}/live/${file}`;
      const isPlaylist = file.endsWith(".m3u8");
      const ctype = isPlaylist ? "application/vnd.apple.mpegurl" : "audio/mp2t";
      if (isPlaylist) {
        const obj = await env.DL.get(key);
        if (!obj) return new Response("Not found", { status: 404 });
        const h = new Headers();
        h.set("content-type", ctype);
        h.set("cache-control", "no-store");
        h.set("etag", obj.httpEtag);
        return new Response(request.method === "HEAD" ? null : obj.body, { headers: h });
      }
      const cache = "public, max-age=30";
      const rangeHdr = request.headers.get("range");
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

    if (pathname === "/") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      // Decision C (2026-07): the polished marketing page is the landing for
      // EVERYONE (was the events aggregator). Serve the static site/index.html
      // via the ASSETS binding — same mechanism as /about below. The live/
      // upcoming/replays aggregator moved to /live (+ /home alias).
      const u = new URL(request.url);
      u.pathname = "/";
      return env.ASSETS.fetch(new Request(u, request));
    }

    if (pathname === "/live" || pathname === "/home") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      return await homeResponse(env, request);
    }

    if (pathname === "/faq") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      return new Response(request.method === "HEAD" ? null : renderFaq(), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
      });
    }

    if (pathname === "/about" || pathname === "/app") {
      const u = new URL(request.url);
      u.pathname = "/";
      return env.ASSETS.fetch(new Request(u, request));
    }

    // Event pages: /e/<slug> is real (D1-backed). /demo keeps the original
    // seed page around for smoke tests and examples.
    if (pathname === "/demo") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      return new Response(renderEvent(DEMO), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
    }

    const editm = pathname.match(/^\/e\/([A-Za-z0-9_.-]{1,48})\/edit$/);
    if (editm) {
      return await editEventResponse(request, env, editm[1]);
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
        const targetSlug = await getEventAliasTarget(env, slug);
        if (targetSlug) {
          return new Response(null, {
            status: 301,
            headers: { location: `/e/${targetSlug}`, "cache-control": "public, max-age=300" },
          });
        }
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
      // LIVE right now? This page is the off-Wi-Fi listen surface: attach the
      // cloud-mirror player (only if the playlist actually exists in R2 — a DJ
      // with the mirror off must not get a dead player) plus the LAN join link
      // and listener count from the presence row.
      let live = null;
      if (row.status === "live") {
        const playlist = env.DL ? await env.DL.head(`event/${slug}/live/live.m3u8`).catch(() => null) : null;
        const presence = await env.DB.prepare(
          "SELECT host, guest_port, listeners, now_playing FROM live_installs WHERE install_id=? AND expires_ms>? LIMIT 1"
        ).bind(row.install_id, nowMs()).first();
        live = {
          mirror: playlist ? `/event/${slug}/live/live.m3u8` : "",
          lanUrl: presence?.host ? `${guestOrigin(presence.host, presence.guest_port)}/` : "",
          // One party, one count: the room (from the Mac's heartbeat) plus the
          // web listeners (fresh presence rows).
          listeners: (Number(presence?.listeners) || 0) + await webListeners(env, slug, nowMs()),
          nowPlaying: presence?.now_playing || "",
        };
      }
      // Owner sees an Edit affordance; that personalized variant is uncached —
      // and a LIVE page must never be cached (it flips to replay when the set ends).
      const viewer = await getSessionUser(env, request);
      const isOwner = !!(viewer && row.owner_user_id && viewer.id === row.owner_user_id);
      return new Response(renderEvent(eventFromRow(row, set, slug, { posts, media, comments }, live), { isOwner }), {
        headers: (isOwner || live) ? { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" } : htmlHeaders,
      });
    }
    const hm = pathname.match(HANDLE_RE);
    if (hm) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      return await profileResponse(env, request, hm[1]);
    }

    return env.ASSETS.fetch(request);
  },

  // 1-minute cron GC. Correctness lives in the read path (every live_installs
  // read filters expires_ms>now); this is pure housekeeping: drop expired rows
  // and delete the grey slug-host A record for any install that vanished without
  // a clean /offline (a crashed Mac). Best-effort — a failed sweep just retries.
  async scheduled(event, env, ctx) {
    try {
      if (!env.DB) return;
      const now = nowMs();
      const expired = (await env.DB.prepare(
        "SELECT install_id, handle, host FROM live_installs WHERE expires_ms<=?"
      ).bind(now).all())?.results || [];
      for (const row of expired) {
        // Crashed Mac (no clean /offline): demote its mirror-minted 'live'
        // events so nothing keeps advertising a phantom live party.
        try {
          await env.DB.prepare(
            "UPDATE events SET status='replay', updated_ms=?2 WHERE install_id=?1 AND status='live'"
          ).bind(row.install_id, now).run();
        } catch (e) { /* best-effort */ }
        // Deliberately KEEP the machine host's grey A record. Deleting it on
        // expiry created an absent-name window between parties, and the
        // proxied zone wildcard (*.<base>) synthesizes LIVE-LOOKING edge-IP
        // answers for absent multi-label names — resolvers that queried in the
        // window cached that poison and guests then couldn't reach the LAN
        // room at the venue (field-diagnosed). One grey A per install is free;
        // the app upserts the fresh LAN IP at every launch.
      }
      await env.DB.prepare("DELETE FROM live_installs WHERE expires_ms<=?").bind(now).run();

      // Hourly: ensure the machine-namespace guard wildcard exists. A grey
      // *.party.<base> → 192.0.2.1 (TEST-NET, dead) makes DNS's closest-
      // encloser rule stop the proxied zone wildcard from ever answering for
      // absent machine names — the poisoning above becomes impossible even if
      // a record is somehow missing. Self-healing: a zone rebuild that loses
      // the guard gets it back within the hour.
      if (env.CF_DNS_TOKEN && env.CF_ZONE_ID && env.BROKER_BASE &&
          new Date(event.scheduledTime || nowMs()).getUTCMinutes() === 0) {
        const guard = `*.party.${env.BROKER_BASE}`;
        const existing = await cfDNS(env, "GET", `?type=A&name=${encodeURIComponent(guard)}`);
        if (!existing || !existing.length) {
          await cfDNS(env, "POST", "", { type: "A", name: guard, content: "192.0.2.1", ttl: 60, proxied: false });
        }
      }
    } catch (e) { /* best-effort GC — next tick retries */ }
  },
};
