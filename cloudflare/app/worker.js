// PartyParty platform: groups, the nights they run, and the people who come.
//
// Deliberately a SECOND Worker. partyparty-site holds the certificate broker,
// DNS and relay registration, all of which a live party depends on minute to
// minute; nothing here may be able to take those down by being deployed badly.
// The only thing the two share is the R2 keyspace where names are reserved.
//
// The shape of everything below follows one rule: a member never needs an
// account. Every action a person can take on their own membership arrives as a
// single-use token in a message, and works on a phone with no app.

import {
  appleNameFrom, authorizeURL, configured, exchangeCode, PROVIDERS, readState, signState,
} from "./auth.js";
import { accountLink, checkout, stripeConfigured, totalForBuyer, verifyWebhook } from "./stripe.js";

// Our cut of a ticket. Nothing on tips: a fixed 30c on a five dollar tip is
// already 6% before anybody else takes a share.
const TICKET_TAKE = 0.05;
// $12 a month or $99 a year, the same on both surfaces. Undercutting the App
// Store price on the web invites attention worth more than the few dollars.
const PRO_MONTHLY_CENTS = 1200;
const PRO_YEARLY_CENTS = 9900;

const HANDLE_RE = /^[a-z0-9]{5,30}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Minted by the Mac, in the shape the broker validates.
const PARTY_ID_RE = /^\d{4}-\d{2}-\d{2}-\d{4}-[a-f0-9]{4}$/;
// Read off a screen, so no letters that argue with each other at a distance.
const CODE_ALPHABET = "ACDEFGHJKLMNPQRTUVWXY3479";

// Names that must never become a group, either because a path already means
// something or because a machine name could collide with them.
const RESERVED_HANDLES = new Set([
  "about", "admin", "account", "api", "app", "apple", "assets", "auth", "beta",
  "billing", "blog", "contact", "dashboard", "docs", "download", "event",
  "events", "google", "group", "groups", "help", "home", "images", "invite",
  "legal", "live", "login", "logout", "mail", "manage", "media", "member",
  "members", "party", "partyparty", "press", "pricing", "privacy", "public",
  "relay", "root", "search", "security", "settings", "signin", "signup",
  "static", "status", "store", "support", "system", "terms", "ticket",
  "tickets", "upload", "user", "users", "webhook", "webhooks", "www",
]);

// Kept deliberately short and dull. A longer list is a maintenance burden that
// still misses things; this catches the obvious and the rest is reported.
const BANNED_FRAGMENTS = ["fuck", "shit", "cunt", "nigg", "rape", "faggot", "kike", "spic"];

// Handles are stored exactly as they are matched. Callers normalise first and
// validate second, so "Sundaze" cannot be accepted here and then stored in a
// form that no URL will ever find again.
export function normalizeHandle(handle) {
  return String(handle || "").trim().toLowerCase();
}

export function handleProblem(handle) {
  const value = String(handle || "");
  if (value !== normalizeHandle(value)) return "lowercase, with no spaces";
  if (!HANDLE_RE.test(value)) return "five to thirty characters, letters and numbers only";
  if (RESERVED_HANDLES.has(value)) return "that name is reserved";
  for (const bad of BANNED_FRAGMENTS) if (value.includes(bad)) return "pick another name";
  return "";
}

// ---------------------------------------------------------------- primitives

const enc = new TextEncoder();

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Sortable ids, so a Mac with no internet can mint one that never collides with
// the cloud's and still sorts into the right place in the timeline.
export function ulid(now) {
  const time = (now || Date.now()).toString(16).padStart(12, "0");
  return `${time}${randomHex(10)}`;
}

export function normalizeEmail(email) {
  const value = String(email || "").trim().toLowerCase();
  if (value.length > 254) return "";
  // Deliberately permissive: the confirmation mail is the real check, and a
  // clever regex mostly rejects addresses that work.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : "";
}

function esc(text) {
  return String(text == null ? "" : text).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function json(status, body, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json", "cache-control": "no-store",
      "strict-transport-security": HSTS, ...(headers || {}),
    },
  });
}

const HSTS = "max-age=31536000";

function html(status, body, headers) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html;charset=utf-8", "cache-control": "no-store",
      "strict-transport-security": HSTS, ...(headers || {}),
    },
  });
}

async function readJson(request, cap) {
  const length = Number(request.headers.get("content-length") || "0");
  if (length && length > cap) return null;
  try {
    const text = await request.text();
    if (text.length > cap) return null;
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------------- tokens

// A token is random, mailed once, and stored only as a hash - a leaked database
// row cannot be used to act as somebody.
async function mintToken(env, { memberId, groupId, eventId, purpose, now }) {
  const secret = randomHex(24);
  await env.DB.prepare(
    `INSERT INTO tokens (id, hash, member_id, group_id, event_id, purpose, created_ms, expires_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(ulid(now), await sha256Hex(secret), memberId || null, groupId || null,
    eventId || null, purpose, now, now + TOKEN_TTL_MS).run();
  return secret;
}

// Purpose-scoped lookup: a "tell us you are coming" link can never be replayed
// as "leave this group", however it is forwarded.
async function readToken(env, secret, purposes, now) {
  if (!/^[a-f0-9]{48}$/.test(String(secret || ""))) return null;
  const row = await env.DB.prepare(
    `SELECT * FROM tokens WHERE hash = ?`
  ).bind(await sha256Hex(secret)).first();
  if (!row) return null;
  if (row.expires_ms < now) return null;
  if (!purposes.includes(row.purpose)) return null;
  return row;
}

// A Mac proves itself with the credential the broker minted for it at
// registration, read straight from the broker's own record. A second
// credential would be a second thing to leak for no extra safety.
async function installAuth(env, id, secret) {
  if (!env.DL || !/^[a-f0-9]{12}$/.test(String(id || ""))) return null;
  const raw = await env.DL.get(`broker/${id}.json`);
  if (!raw) return null;
  try {
    const record = JSON.parse(await raw.text());
    return record.secret && record.secret === String(secret || "") ? record : null;
  } catch (e) {
    return null;
  }
}

function pairingCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

// ----------------------------------------------------------------- sessions

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function cookies(request) {
  const jar = {};
  for (const part of String(request.headers.get("cookie") || "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name) jar[name] = rest.join("=");
  }
  return jar;
}

async function startSession(env, { djId, memberId, now }) {
  const secret = randomHex(24);
  await env.DB.prepare(
    `INSERT INTO sessions (id, hash, dj_id, member_id, created_ms, expires_ms) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(ulid(now), await sha256Hex(secret), djId || null, memberId || null, now, now + SESSION_TTL_MS).run();
  return `pp_s=${secret}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

async function currentDJ(env, request, now) {
  const secret = cookies(request).pp_s;
  if (!/^[a-f0-9]{48}$/.test(String(secret || ""))) return null;
  const session = await env.DB.prepare(
    `SELECT * FROM sessions WHERE hash = ?`
  ).bind(await sha256Hex(secret)).first();
  if (!session || session.revoked_ms || session.expires_ms < now || !session.dj_id) return null;
  return env.DB.prepare(`SELECT * FROM djs WHERE id = ?`).bind(session.dj_id).first();
}

// ------------------------------------------------------------------ members

async function memberByEmail(env, emailNorm) {
  return env.DB.prepare(`SELECT * FROM members WHERE email_norm = ?`).bind(emailNorm).first();
}

async function upsertMember(env, emailNorm, name, now) {
  const existing = await memberByEmail(env, emailNorm);
  if (existing) {
    if (name && !existing.name) {
      await env.DB.prepare(`UPDATE members SET name = ? WHERE id = ?`).bind(name, existing.id).run();
    }
    return existing;
  }
  const id = ulid(now);
  await env.DB.prepare(
    `INSERT INTO members (id, email_norm, name, created_ms) VALUES (?, ?, ?, ?)`
  ).bind(id, emailNorm, name || "", now).run();
  return memberByEmail(env, emailNorm);
}

// ------------------------------------------------------------------- outbox

// Nothing is sent from here. Rows wait for the sender on the origin box, which
// holds the MXroute credentials. A suppressed member is skipped at write time,
// so an unsubscribe cannot be outrun by a queued message.
async function queueMail(env, { to, subject, text, kind, groupId, eventId, ics, unsubscribe, now }) {
  const member = await memberByEmail(env, to);
  if (member && member.suppressed_ms) return false;
  const headers = {};
  if (unsubscribe) {
    headers["List-Unsubscribe"] = `<${unsubscribe}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  await env.DB.prepare(
    `INSERT INTO outbox (id, to_email, subject, body_text, headers, attach_ics, kind, group_id, event_id, created_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(ulid(now), to, subject, text, JSON.stringify(headers), ics || "",
    kind, groupId || null, eventId || null, now).run();
  return true;
}

// --------------------------------------------------------------------- ICS

function icsTime(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function icsEscape(text) {
  return String(text || "").replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
}

// Folding at 75 octets is not decoration: unfolded long lines are why a
// description silently disappears in some calendars.
function icsFold(line) {
  if (line.length <= 73) return line;
  const parts = [line.slice(0, 73)];
  let rest = line.slice(73);
  while (rest.length > 72) {
    parts.push(" " + rest.slice(0, 72));
    rest = rest.slice(72);
  }
  if (rest) parts.push(" " + rest);
  return parts.join("\r\n");
}

export function icsFor(group, events, base) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//PartyParty//EN",
    "CALSCALE:GREGORIAN",
    // No METHOD. METHOD:PUBLISH belongs on an iTIP message - an invitation sent
    // to somebody - not on a feed people subscribe to, and Google rejects the
    // combination outright ("unable to add calendar").
    `X-WR-CALNAME:${icsEscape(group.name || group.handle)}`,
    // How often a subscriber should come back. Daily (owner). It is only a
    // hint: Google fetches on its own schedule and Apple lets the subscriber
    // choose per calendar, so this reaches the minority of clients that honour
    // it - which is reason enough to say something true rather than nothing.
    // Nights announced today reach people by email, not by this.
    "REFRESH-INTERVAL;VALUE=DURATION:P1D",
    "X-PUBLISHED-TTL:P1D",
  ];
  for (const event of events) {
    if (!event.starts_ms) continue;
    const url = `${base}/@${group.handle}/${event.slug}`;
    lines.push("BEGIN:VEVENT");
    // A stable UID and a SEQUENCE that climbs are the whole contract with a
    // subscribed calendar. Without them a moved night keeps its old time on
    // every phone that subscribed, and nobody finds out until they arrive.
    lines.push(`UID:${event.id}@partyparty.party`);
    lines.push(`SEQUENCE:${Number(event.ics_seq || 0)}`);
    lines.push(`DTSTAMP:${icsTime(event.updated_ms || event.created_ms)}`);
    lines.push(`DTSTART:${icsTime(event.starts_ms)}`);
    if (event.ends_ms) lines.push(`DTEND:${icsTime(event.ends_ms)}`);
    lines.push(icsFold(`SUMMARY:${icsEscape(event.title || group.name)}`));
    const where = [event.place, event.address].filter(Boolean).join(", ");
    if (where) lines.push(icsFold(`LOCATION:${icsEscape(where)}`));
    if (event.description) lines.push(icsFold(`DESCRIPTION:${icsEscape(event.description)}`));
    lines.push(`URL:${url}`);
    // Cancelled nights are published as cancelled rather than deleted: a
    // deletion is invisible to a calendar that already has the event.
    lines.push(`STATUS:${event.state === "cancelled" ? "CANCELLED" : "CONFIRMED"}`);
    lines.push("END:VEVENT");
  }
  // A calendar with no components is valid iCalendar and is treated as a broken
  // feed by several clients, Google among them. A group with nothing announced
  // yet is the normal first state, so it gets one placeholder that says so and
  // disappears the moment there is a real night.
  if (!lines.some((line) => line === "BEGIN:VEVENT")) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:beta-launch-${group.handle}@partyparty.party`);
    lines.push("SEQUENCE:0");
    lines.push(`DTSTAMP:${icsTime(Date.parse("2026-08-01T00:00:00Z"))}`);
    lines.push("DTSTART;VALUE=DATE:20260801");
    lines.push("DTEND;VALUE=DATE:20260802");
    lines.push("SUMMARY:PartyParty beta launch");
    lines.push(icsFold(`DESCRIPTION:${icsEscape(group.name || group.handle)} has not announced a night yet. New ones appear here.`));
    // CONFIRMED, not CANCELLED. A calendar whose only event is cancelled has
    // zero usable events, which is the same thing an empty feed looks like to a
    // client deciding whether this URL is a calendar at all - Apple accepted it,
    // Google did not. TRANSPARENT so it still occupies nobody's day.
    lines.push("STATUS:CONFIRMED");
    lines.push("TRANSP:TRANSPARENT");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

// ------------------------------------------------------------------- pages

const STYLE = `
/* The console's palette and shapes, copied from web/dj.html: dark #0e0e10,
   elevated panels, accent #ff2d6f, uppercase rail labels, and a rounded
   image card for the header. The product is dark; these pages were not. */
@font-face{font-family:Geist;src:url(/fonts/Geist-Variable.woff2) format('woff2-variations');
font-weight:100 900;font-display:swap}
/* The swap used to be visible: every line painted in the system face and then
   resized a moment later when Geist arrived. The face is preloaded in the head
   so it is usually there before first paint, and this metric-matched stand-in
   covers the times it is not - same cap height and line box, so nothing moves. */
@font-face{font-family:"Geist stand-in";src:local("Helvetica Neue"),local("Arial"),local("Roboto");
size-adjust:104%;ascent-override:95%;descent-override:24%;line-gap-override:0%}
:root{
  color-scheme:dark;
  --sans:Geist,"Geist stand-in",-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;
  --mono:"Geist Mono",ui-monospace,"SF Mono",Menlo,monospace;
  --bg:#0e0e10; --bg-elevated:#1a1a1d; --bg-elevated-2:#202024;
  --label:#f2f2f4; --label-secondary:#a3a3ac; --label-tertiary:#77777f;
  --separator:rgba(255,255,255,.09); --fill:rgba(255,255,255,.07);
  --fill-hover:rgba(255,255,255,.12);
  --accent:#ff2d6f; --success:#34c759; --danger:#ff3b30;
  --shadow:0 18px 50px rgba(0,0,0,.24), 0 1px 0 rgba(255,255,255,.04) inset;
  --r-sm:10px; --r-md:14px; --r-lg:20px; --r-pill:980px;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--label);font-family:var(--sans);
font-size:15px;line-height:1.45;font-synthesis:none}

/* The header is a card, not a band: an image with the name on it, inset from
   the edges and rounded, the way the console's cover sits. */
.hero{position:relative;max-width:1180px;margin:20px auto 0;padding:0 20px}
/* The same box the console draws: same height curve, same corner, same scrim,
   so a DJ moving between the app and the site is looking at one thing. */
.hero .cover{position:relative;min-height:clamp(200px,21vw,300px);display:flex;
align-items:flex-end;padding:28px 24px 20px;border-radius:var(--r-lg);overflow:hidden;
background:linear-gradient(135deg,#3a1f2a,#1d1a22);background-size:cover;
background-position:center;box-shadow:var(--shadow)}
.hero .cover::after{content:'';position:absolute;inset:0;pointer-events:none;
background:linear-gradient(180deg,rgba(0,0,0,.14),rgba(0,0,0,.32) 55%,rgba(0,0,0,.58))}
.hero .cover.bare::after{background:none}
/* Remove, top right, only once there is something to remove. */
/* Back with the other actions on the right; the left corner belongs to the
   brand, which is the way home from anywhere. */
.coverx{position:absolute;top:26px;right:26px;z-index:4;width:38px;height:38px;
border-radius:50%;display:grid;place-items:center;padding:0;border:0;
background:rgba(18,18,22,.5);-webkit-backdrop-filter:blur(20px);backdrop-filter:blur(20px);
box-shadow:inset 0 0 0 1px rgba(255,255,255,.16);color:#fff;font-size:15px;cursor:pointer}
.coverx:hover{background:rgba(18,18,22,.68)}
.cover.bare .coverx{display:none}
.hero:has(.coverx) .toptools{right:92px}
.hero:has(.cover.bare) .toptools{right:46px}
.hero .titles{position:relative;z-index:1}
.hero h1{font-size:clamp(34px,3.4vw,46px);font-weight:800;line-height:1.04;
letter-spacing:-.03em;color:#fff;margin:0 0 4px;overflow-wrap:anywhere}
.hero h1 [contenteditable]{outline:none;display:inline-block;min-width:2ch;
border-radius:var(--r-sm);padding:0 2px}
.hero h1 [contenteditable]:focus{background:rgba(0,0,0,.35);
box-shadow:inset 0 0 0 1px rgba(255,255,255,.25)}
.fieldedit{width:34px;height:34px;padding:0;margin-left:10px;border-radius:50%;
display:inline-grid;place-items:center;vertical-align:middle;border:0;cursor:pointer;
background:rgba(0,0,0,.35);box-shadow:inset 0 0 0 1px rgba(255,255,255,.16);
color:rgba(255,255,255,.72)}
.fieldedit:hover{background:rgba(255,255,255,.18);color:#fff}
.fieldedit svg{width:15px;height:15px;display:block}
.coversays{position:absolute;right:24px;bottom:66px;z-index:3;font-size:12px;
color:rgba(255,255,255,.85)}
.coversays.bad{color:#ff7a7a}
.hero .sub{margin:0;color:rgba(255,255,255,.72);font-weight:700;font-size:15px}
.toptools{position:absolute;top:26px;right:46px;display:flex;gap:8px;z-index:2}
/* The way home, in the corner every site puts it. */
.brandchip{position:absolute;top:26px;left:46px;z-index:3;display:inline-flex;
align-items:center;gap:7px;height:38px;padding:0 16px;border-radius:var(--r-pill);
background:rgba(0,0,0,.45);color:#fff;font-size:14px;font-weight:750;
-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);
border:1px solid rgba(255,255,255,.14)}
.brandchip:hover{text-decoration:none;background:rgba(0,0,0,.62)}
@media (max-width:520px){.brandchip{left:26px}}
.toptools a{display:grid;place-items:center;min-width:38px;height:38px;padding:0 14px;
border-radius:var(--r-pill);background:rgba(0,0,0,.45);color:#fff;font-size:13px;
font-weight:650;text-decoration:none;-webkit-backdrop-filter:blur(18px);
backdrop-filter:blur(18px);border:1px solid rgba(255,255,255,.14)}
.toptools a:hover{text-decoration:none;background:rgba(0,0,0,.62)}

main{max-width:680px;margin:0 auto;padding:28px 20px 96px}
main.wide{max-width:940px}
.withrail{max-width:1180px;margin:0 auto;padding:28px 20px 96px;
display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:40px;align-items:start}
.rail{position:sticky;top:24px;display:grid;gap:26px}

h1{font-size:26px;font-weight:800;letter-spacing:-.015em;margin:0 0 4px}
h2{font-size:17px;font-weight:700;letter-spacing:-.01em;margin:32px 0 12px}
/* Rail headings are the console's eyebrows, not headlines. */
/* A heading with its action on the same line. */
.sectionhead{display:flex;align-items:center;justify-content:space-between;gap:16px;
margin:32px 0 12px}
.sectionhead h2{margin:0}
.rail h2{margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:.05em;
text-transform:uppercase;color:var(--label-tertiary)}
p{margin:0 0 12px}
a{color:var(--accent);text-decoration:none;font-weight:600}
a:hover{text-decoration:underline}
.muted{color:var(--label-secondary);font-size:13px;font-weight:400}
a.muted{color:var(--label-secondary)}

.card{display:block;background:var(--bg-elevated);border:1px solid var(--separator);
border-radius:var(--r-md);padding:16px;margin:0 0 12px;color:inherit;text-decoration:none}
a.card:hover{text-decoration:none;background:var(--bg-elevated-2)}
.when{font-size:12px;color:var(--label-tertiary);font-variant-numeric:tabular-nums;
font-weight:650;letter-spacing:.02em}
.card strong{display:block;font-size:16px;font-weight:700;margin:2px 0}

.actionbar{display:flex;align-items:center;gap:14px;width:100%;
background:var(--accent);color:#fff;border:none;border-radius:var(--r-md);
padding:15px 18px;margin:18px 0 10px;font:inherit;font-size:16px;font-weight:750;
cursor:pointer;text-decoration:none;transition:filter .15s}
.actionbar:hover{text-decoration:none;filter:brightness(1.06)}
.actionbar .tile{display:grid;place-items:center;width:42px;height:42px;flex:0 0 42px;
border-radius:12px;background:rgba(255,255,255,.2);font-size:20px}
.actionbar .lines{display:grid;gap:1px;text-align:left;min-width:0}
.actionbar .lines small{font-weight:550;font-size:12px;opacity:.88}
.actionbar.quiet{background:var(--bg-elevated);color:var(--label);
border:1px solid var(--separator)}
.actionbar.quiet .tile{background:var(--fill)}

.btn{display:inline-flex;align-items:center;justify-content:center;min-height:40px;
padding:11px 20px;border:none;border-radius:var(--r-pill);background:var(--accent);
color:#fff;font:inherit;font-size:15px;font-weight:700;cursor:pointer;
transition:filter .15s}
.btn:hover{text-decoration:none;filter:brightness(1.06)}
.btn.plain{background:var(--fill);color:var(--label);border:1px solid var(--separator)}
.btn.plain:hover{background:var(--fill-hover)}
.btn.small{min-height:34px;padding:8px 14px;font-size:13px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

input[type=email],input[type=text]{width:100%;min-height:44px;padding:11px 14px;
border-radius:var(--r-sm);border:1px solid var(--separator);background:var(--bg-elevated);
color:var(--label);font:inherit;font-size:15px;outline:none}
input::placeholder{color:var(--label-tertiary)}
input:focus{border-color:var(--accent)}
form.join{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 8px}
form.join input{flex:1 1 200px;min-width:0;width:auto}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}

.post{background:var(--bg-elevated);border:1px solid var(--separator);
border-radius:var(--r-md);padding:14px;margin:0 0 10px}
.post .who{font-weight:700;font-size:14px}
.post .who a{color:inherit;font-weight:inherit}
.posthead{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.posthead .avatar{width:34px;height:34px;flex:0 0 34px;font-size:13px;margin:0}
.posthead .grow{min-width:0}
.postmedia{display:block;width:100%;max-height:520px;object-fit:cover;margin-top:10px;
border-radius:var(--r-sm);background:var(--bg-elevated-2)}

/* Saying something, with or without a picture, the way the console's party
   feed does it: one box, the camera on the left, Post on the right. */
form.say{background:var(--bg-elevated);border:1px solid var(--separator);
border-radius:var(--r-md);padding:14px;margin:0 0 14px;display:grid;gap:10px}
form.say textarea{width:100%;min-height:64px;padding:11px 14px;border-radius:var(--r-sm);
border:1px solid var(--separator);background:var(--bg-elevated-2);color:var(--label);
font:inherit;font-size:15px;outline:none;resize:vertical}
form.say textarea:focus{border-color:var(--accent)}
form.say .sayrow{display:flex;gap:10px;align-items:center;justify-content:space-between}
form.say .pickfile{display:inline-flex;align-items:center;gap:8px;min-height:40px;
padding:0 16px;border-radius:var(--r-pill);background:var(--accent);color:#fff;
font-size:14px;font-weight:700;cursor:pointer}
form.say .pickfile input{display:none}
form.say .picked{font-size:12px;color:var(--label-secondary)}
footer{max-width:1180px;margin:48px auto 0;padding:20px;
border-top:1px solid var(--separator);font-size:13px}

form.newnight{display:grid;gap:10px;margin:16px 0 28px;padding:16px;
background:var(--bg-elevated);border:1px solid var(--separator);border-radius:var(--r-md)}
form.newnight .row input{flex:1 1 140px;width:auto}
form.newnight .btn{justify-self:start}

.linkrow{display:flex;gap:8px;align-items:center;margin:10px 0}
.linkbox{flex:1 1 auto;min-width:0;font-size:12px;padding:9px 12px;min-height:0;
color:var(--label-secondary);border-radius:var(--r-sm);font-family:var(--mono)}

/* Participants, as the console lists them: a disc, a name, what they are. */
.avatars{display:flex;align-items:center;flex-wrap:wrap;margin:0 0 12px}
.avatar{width:34px;height:34px;border-radius:50%;display:grid;place-items:center;
margin-left:-7px;border:2px solid var(--bg-elevated);
background:linear-gradient(135deg,#ff2d6f,#ff8a4c);color:#fff;font-size:12px;
font-weight:800}
.avatar:first-child{margin-left:0}
.avatar.more{background:var(--fill);color:var(--label-secondary)}
.avatar{overflow:hidden}
.avatar img{width:100%;height:100%;object-fit:cover;display:block}
.avatar.big{width:52px;height:52px;flex:0 0 52px;font-size:18px;margin:0}
.who-list{display:grid;gap:12px;margin:0;padding:0;list-style:none}
.who-list li{display:flex;align-items:center;gap:10px}
.who-list .avatar{width:32px;height:32px;font-size:12px;margin:0;flex:0 0 32px}
.who-list b{display:block;font-size:14px;font-weight:650}
.who-list b a{color:inherit;font-weight:inherit}
.who-list small{display:block;font-size:11px;color:var(--label-tertiary);
letter-spacing:.04em;text-transform:uppercase}
.who-list small.at{text-transform:none;letter-spacing:0;font-size:12px;
font-family:var(--mono)}
/* A section per kind of person, the way the guest's phone heads a DJ above the
   room listening to them. */
.whogroup + .whogroup{margin-top:18px}
.whohead{display:flex;align-items:baseline;gap:6px;margin:0 0 10px;font-size:11px;
font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--label-secondary)}
.whohead small{font-size:11px;color:var(--label-tertiary);font-weight:600}

/* "About You", as the console draws it: a round picture you can replace, your
   name and a line about you side by side, and the three link pills under them.
   Optional throughout - a profile with nothing filled in is a finished one. */
.you{background:var(--bg-elevated);border:1px solid var(--separator);
border-radius:var(--r-md);padding:18px;margin:0 0 14px}
.yourow{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
.yourow .grow{flex:1 1 190px;min-width:0;display:grid;gap:10px}
.twoup{display:grid;grid-template-columns:1fr 1fr;gap:10px}
/* Sized by what is in it, not pinned to the disc: a fixed 76px box left the
   "Add a photo" line hanging outside it, over whatever wrapped underneath. */
.avatarpick{position:relative;flex:0 0 76px;width:76px;cursor:pointer;display:block}
.avatarpick .disc{width:76px;height:76px;border-radius:50%;overflow:hidden;
display:grid;place-items:center;background:linear-gradient(135deg,#ff2d6f,#ff8a4c);
color:#fff;font-size:26px;font-weight:800;border:1px solid var(--separator)}
.avatarpick .disc img{width:100%;height:100%;object-fit:cover;display:block}
.avatarpick input{position:absolute;inset:0;opacity:0;cursor:pointer}
.avatarpick .hintline{display:block;margin-top:6px;text-align:center;font-size:11px;
color:var(--label-tertiary)}
.dropx{position:absolute;top:-4px;right:-4px;width:24px;height:24px;border-radius:50%;
display:grid;place-items:center;background:rgba(0,0,0,.72);color:#fff;border:0;
font-size:12px;cursor:pointer;z-index:2}
/* Three across, as the console has them. The minimum is what one pill needs
   for its label plus a readable field, not what looks comfortable alone -
   set any higher and the third wraps onto a row of its own. */
.socials{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:10px}
.pill{display:flex;align-items:center;gap:0;background:var(--bg-elevated-2);
border:1px solid var(--separator);border-radius:var(--r-pill);padding:0 6px 0 14px;
min-height:44px;overflow:hidden}
.pill span{flex:0 0 auto;font-size:14px;font-weight:650;color:var(--label-secondary);
padding-right:10px;margin-right:10px;border-right:1px solid var(--separator)}
.pill input{border:0;background:transparent;min-height:40px;padding:0;
border-radius:0;font-size:14px}
.pill input:focus{border:0}
.youbar{display:flex;gap:10px;align-items:center;margin-top:14px;flex-wrap:wrap}
.youbar .muted{margin:0}
/* What the @name field has to say about itself, while it is still in front of
   the person typing it. */
.handlesays{font-size:13px;font-weight:650;color:var(--label-tertiary)}
/* A party in a list: the date above the name, the way a diary reads. */
.partyrow{display:flex;align-items:center;gap:14px}
.partyrow .grow{min-width:0}
.tag{display:inline-block;margin:6px 6px 0 0;padding:2px 9px;border-radius:var(--r-pill);
font-size:11px;font-weight:700;letter-spacing:.02em;background:var(--fill);
color:var(--label-secondary)}
.tag.quiet{background:transparent;box-shadow:inset 0 0 0 1px var(--separator)}
.tag.live{background:rgba(255,45,111,.16);color:var(--accent)}
/* A night has a colour. Derived from the cover's own name rather than its
   pixels - a Worker has no image pipeline, and a stable hue per picture is the
   honest version of the same idea: every party looks like itself, and looks the
   same every time you open it. */
.nightlit{--night:var(--accent)}
.nightlit .hero .cover{box-shadow:var(--shadow),0 0 90px -30px var(--night)}
.nightlit h2{color:var(--label)}
.nightlit .entry:hover,.nightlit .people li:hover{
background:color-mix(in srgb,var(--night) 7%,var(--bg-elevated))}
.nightlit .addline:focus-within{border-color:var(--night)}
.nightlit .addline:focus-within button,.nightlit button.onfocus{background:var(--night)}

/* Photos first: a night is mostly pictures, and a grid is how you look back at
   one. Two up on a phone, three where there is room. */
.roll{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));
gap:6px;margin:0 0 16px}
.roll figure{margin:0;position:relative;border-radius:var(--r-sm);overflow:hidden;
background:var(--bg-elevated);aspect-ratio:1}
.roll img,.roll video{width:100%;height:100%;object-fit:cover;display:block}
.roll figcaption{position:absolute;left:0;right:0;bottom:0;padding:16px 10px 8px;
font-size:12px;color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.72));
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* An empty space says what belongs in it, not that it is empty. */
.blank{margin:0 0 10px;padding:14px 12px;border-radius:var(--r-sm);
background:var(--bg-elevated);color:var(--label-tertiary);font-size:14px;line-height:1.5}

/* Somebody you know, and the last night you saw them at - the fact this page
   exists to answer, with their face on it like everywhere else. */
.seen{display:grid;grid-template-columns:36px minmax(0,1fr) auto;gap:12px;
align-items:center;padding:13px 12px;border-bottom:1px solid var(--separator);
text-decoration:none;color:var(--label)}
.seen:hover{background:var(--bg-elevated);text-decoration:none}
.seen .entrybody b{font-size:16px}

/* The capture line. The sentence the app exists for goes in here without
   scrolling to find the right section: type the names or the tracks, say what
   they are. The sections below are for correcting, not for entering. */
.capture{position:sticky;top:8px;z-index:5;margin:0 0 26px;padding:10px 12px;
border-radius:var(--r-md);background:var(--bg-elevated-2);
box-shadow:0 8px 24px -18px #000;backdrop-filter:blur(18px)}
.capture input{width:100%;border:0;background:none;padding:4px 2px;min-height:32px;
font:inherit;font-size:16px;color:var(--label);outline:none}
.capture input::placeholder{color:var(--label-tertiary)}
.as{display:flex;gap:6px;margin-top:6px}
.as button{flex:1 1 0;border:0;border-radius:var(--r-pill);padding:8px 4px;
background:var(--bg-elevated);color:var(--label-secondary);font:inherit;
font-size:13px;font-weight:650;cursor:pointer}
.as button:hover{background:var(--night,var(--accent));color:#fff}

/* The welcome, folded down to one line. */
details.welcome{margin:0 0 18px}
details.welcome summary{display:flex;align-items:center;gap:12px;cursor:pointer;
padding:10px 12px;border-radius:var(--r-md);list-style:none}
details.welcome summary::-webkit-details-marker{display:none}
details.welcome summary:hover{background:var(--bg-elevated)}
details.welcome summary span{display:grid;gap:1px;min-width:0}
details.welcome summary b{font-size:15px}
details.welcome summary small{font-size:13px;color:var(--label-tertiary)}
details.welcome[open] summary{margin-bottom:6px}

/* One scale, everywhere. Three sections were designed on three different days
   and it read like it: headings at four sizes, secondary text at three. */
h1{font-size:clamp(28px,4.4vw,34px);letter-spacing:-.025em;line-height:1.08}
h2{font-size:19px;letter-spacing:-.02em}
.muted{font-size:14px;line-height:1.5}

/* Motion, of the kind you notice only when it is missing: entries settle in
   rather than appearing, and each one a beat after the last. Nothing moves for
   somebody who asked for less. */
@keyframes settle{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.entry,.people li,.setlist li{animation:settle .28s cubic-bezier(.22,.61,.36,1) both}
.entry:nth-child(2){animation-delay:.03s}
.entry:nth-child(3){animation-delay:.06s}
.entry:nth-child(4){animation-delay:.09s}
.entry:nth-child(n+5){animation-delay:.12s}
.btn,.entry,.people li,.x,.addline{transition:background .14s ease,color .14s ease,
border-color .14s ease,opacity .14s ease}
@media (prefers-reduced-motion:reduce){
  .entry,.people li,.setlist li{animation:none}
}

/* Home as a journal timeline. A row in a table tells you nothing; an entry
   says when, where, and what is in it, and is a whole tap target. */
.entries{display:grid;margin:0 0 8px;border-top:1px solid var(--separator)}
.entry{display:grid;grid-template-columns:88px minmax(0,1fr) auto;gap:14px;
align-items:baseline;padding:16px 12px;border-bottom:1px solid var(--separator);
text-decoration:none;color:var(--label)}
.entry:hover{background:var(--bg-elevated);text-decoration:none}
.entrywhen{font-size:13px;font-weight:650;color:var(--label-tertiary);
font-variant-numeric:tabular-nums;line-height:1.5}
.entrybody{display:grid;gap:3px;min-width:0}
.entrybody b{font-size:17px;letter-spacing:-.01em;line-height:1.25}
.entrywhere{font-size:14px;color:var(--label-secondary)}
.entryinside{font-size:13px;color:var(--label-tertiary);overflow:hidden;
text-overflow:ellipsis;white-space:nowrap}
@media (max-width:520px){
  .entry{grid-template-columns:minmax(0,1fr) auto;gap:4px 10px;padding:14px 10px}
  .entry .entrywhen{grid-column:1/-1;order:-1}
}
.tracker{margin-top:4px}
.tracker h2:first-child{margin-top:18px}
.wentrow{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:650}
.wentrow input{width:20px;height:20px;accent-color:var(--accent)}
.notemini{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
.notemini input[type=text]{flex:1 1 200px;min-width:0;width:auto;min-height:36px;
padding:7px 12px;font-size:13px}
.who-list li{align-items:flex-start}
.eventfield{display:grid;gap:6px}
.eventfield span{font-size:12px;font-weight:700;letter-spacing:.03em;
text-transform:uppercase;color:var(--label-tertiary)}
textarea{width:100%;padding:11px 14px;border-radius:var(--r-sm);
border:1px solid var(--separator);background:var(--bg-elevated);color:var(--label);
font:inherit;font-size:15px;outline:none;resize:vertical}
textarea:focus{border-color:var(--accent)}
input[type=datetime-local],input[type=search]{width:100%;min-height:44px;padding:11px 14px;
border-radius:var(--r-sm);border:1px solid var(--separator);background:var(--bg-elevated);
color:var(--label);font:inherit;font-size:15px;outline:none}
input[type=datetime-local]:focus,input[type=search]:focus{border-color:var(--accent)}
/* The record, as a journal rather than a form.
   Nothing here announces itself as an input until it is touched: a note reads
   as the note it holds, an empty one as grey placeholder text, and the borders
   and the Save button appear on focus. Four stacked controls per person is
   what a form looks like; one line with a name on it is what a page you write
   on looks like. */
.tracker h2{font-size:19px;letter-spacing:-.02em;margin:34px 0 10px}
.people{list-style:none;padding:0;margin:0 0 6px;display:grid;gap:2px}
.people li{display:grid;grid-template-columns:36px minmax(0,1fr);gap:12px;
align-items:start;padding:10px 12px;border-radius:var(--r-sm)}
.people li:hover{background:var(--bg-elevated)}
.personline{display:grid;gap:2px;min-width:0}
.nameline{display:flex;align-items:center;gap:8px}
.nameline a{font-weight:700;text-decoration:none;color:var(--label)}
.nameline a:hover{color:var(--accent)}
.x{margin-left:auto;border:0;background:none;color:var(--label-tertiary);
font-size:13px;line-height:1;padding:4px 6px;border-radius:var(--r-sm);
cursor:pointer;opacity:0;transition:opacity .12s}
.people li:hover .x,.x:focus{opacity:1}
input.quiet{width:100%;border:0;background:none;padding:2px 0;min-height:0;
font:inherit;font-size:14px;color:var(--label-secondary);outline:none}
input.quiet::placeholder{color:var(--label-tertiary)}
input.quiet:focus{color:var(--label)}
/* The save only exists once you are typing. */
button.onfocus{display:none;justify-self:start;margin-top:6px;border:0;
background:var(--accent);color:#fff;font:inherit;font-size:13px;font-weight:700;
padding:6px 14px;border-radius:var(--r-pill);cursor:pointer}
.personline:focus-within button.onfocus{display:block}

/* One line to add anything: type, press +. */
.addline{display:flex;flex-wrap:nowrap;align-items:center;gap:8px;margin:0 0 4px;
padding:9px 12px;border-radius:var(--r-sm);border:1px dashed var(--separator)}
.addline:focus-within{border-style:solid;border-color:var(--accent)}
.addline input{flex:1 1 auto;min-width:0;width:auto;border:0;background:none;
padding:0;min-height:26px;font:inherit;font-size:15px;color:var(--label);outline:none}
.addline.two input:last-of-type{flex:0 1 38%;font-size:14px;color:var(--label-secondary)}
.addline button{flex:0 0 auto;width:30px;height:30px;border:0;border-radius:50%;
background:var(--bg-elevated-2);color:var(--label-secondary);font-size:17px;
line-height:1;cursor:pointer}
.addline:focus-within button{background:var(--accent);color:#fff}
.seenby{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 8px}
hr.soft{border:0;border-top:1px solid var(--separator);margin:34px 0}

/* What was played, in the order it was played. Numbers in the margin so the
   list reads as a record rather than as another form. */
.setlist{list-style:none;counter-reset:song;padding:0;margin:0 0 12px;display:grid;gap:2px}
.setlist li{counter-increment:song;display:flex;align-items:center;gap:10px;
padding:9px 12px;border-radius:var(--r-sm);min-width:0}
.setlist li:nth-child(odd){background:var(--bg-elevated)}
.setlist li::before{content:counter(song);font-variant-numeric:tabular-nums;
font-size:12px;font-weight:700;color:var(--label-tertiary);min-width:1.4em}
.setlist .grow{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.setlist form{margin:0;flex:0 0 auto}
.setlist li:hover .x,.setlist .x:focus{opacity:1}
.addline .camera{background:none;color:var(--label-tertiary);width:30px;height:30px;
display:grid;place-items:center}
.addline .camera svg{width:19px;height:19px}
.addline .camera:hover{color:var(--label)}
.handlesays[data-state="ok"]{color:var(--success)}
.handlesays[data-state="bad"]{color:var(--accent)}

/* A room that is playing right now, and the way back into it. */
.nowplaying{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 14px;
padding:12px 16px;border-radius:var(--r-sm);background:rgba(255,45,111,.12);
border:1px solid rgba(255,45,111,.32);font-weight:700}
.nowplaying .dot{width:9px;height:9px;border-radius:50%;background:var(--accent);
box-shadow:0 0 0 0 rgba(255,45,111,.55);animation:pulse 1.8s ease-out infinite}
@keyframes pulse{70%{box-shadow:0 0 0 9px rgba(255,45,111,0)}
100%{box-shadow:0 0 0 0 rgba(255,45,111,0)}}
@media (prefers-reduced-motion:reduce){.nowplaying .dot{animation:none}}
.linklist{list-style:none;padding:0;margin:0 0 14px;display:flex;flex-wrap:wrap;gap:8px}
.linklist a{display:inline-block;padding:7px 14px;border-radius:var(--r-pill);
background:var(--bg-elevated);border:1px solid var(--separator);
font-size:14px;font-weight:650;text-decoration:none;max-width:100%;
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
details.edit{margin:0}
details.edit summary{padding:5px 0}
/* Who may see it, as one chip with the night. */
/* One row of quiet controls under the night, not a stack of them. Either can
   open, and opening one takes the whole row's width. */
.nightbar{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:0 0 6px}
.nightbar details[open]{flex:1 1 100%}
details.seen{display:inline-block}
details.seen summary{display:inline-flex;align-items:center;gap:7px;cursor:pointer;
list-style:none;font-size:13px;font-weight:600;color:var(--label-secondary);
padding:5px 12px;border-radius:var(--r-pill);background:var(--bg-elevated)}
details.seen summary::-webkit-details-marker{display:none}
details.seen summary:hover{color:var(--label)}
.dotv{width:7px;height:7px;border-radius:50%;background:var(--label-tertiary)}
.dotv.link{background:#f0b429}
.dotv.public{background:var(--success,#3ddc84)}
details.seen[open]{display:block;margin-bottom:10px}
details.edit summary{cursor:pointer;font-size:13px;font-weight:600;
color:var(--label-secondary);padding:6px 0;list-style:none}
details.edit summary::-webkit-details-marker{display:none}
details.edit summary::before{content:'\\2699\\FE0E';padding-right:8px}
details.edit summary:hover{color:var(--label)}
details.edit[open] summary{margin-bottom:12px}
/* Once a photo is waiting, Save is the only thing left to do. */
@keyframes nudge{0%,100%{transform:scale(1)}50%{transform:scale(1.05)}}
.btn.nudge{animation:nudge .9s ease-in-out 2}
@media (prefers-reduced-motion:reduce){.btn.nudge{animation:none}}
.btn:disabled{opacity:.45;cursor:not-allowed;filter:none}
.formerror{margin:0 0 14px;padding:11px 14px;border-radius:var(--r-sm);
background:rgba(255,45,111,.12);border:1px solid rgba(255,45,111,.35);
color:var(--label);font-size:14px;font-weight:650}
.handlepill{display:inline-flex;align-items:center;background:var(--bg-elevated-2);
border:1px solid var(--separator);border-radius:var(--r-pill);padding:0 14px;
min-height:44px;font-weight:700}
.handlepill span{color:var(--label-tertiary);padding-right:2px}
.handlepill input{border:0;background:transparent;min-height:42px;padding:0;
font-weight:700;width:auto;flex:1 1 auto}
.handlepill input:focus{border:0}

/* Changing the picture on a cover, the way the console does it: the buttons
   sit on the image itself rather than in a settings drawer below it. */
.coveractions{position:absolute;right:26px;bottom:26px;display:flex;gap:8px;z-index:2}
.coveractions{right:20px;bottom:auto;top:20px}
.coveractions button{width:32px;height:32px;padding:0;border-radius:50%;
background:rgba(0,0,0,.34);color:rgba(255,255,255,.78);font:inherit;font-size:15px;
cursor:pointer;-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);
border:1px solid rgba(255,255,255,.14)}
.coveractions button:hover{background:rgba(0,0,0,.62)}
.coveractions input{display:none}

/* Nights as a schedule. */
.timeline{position:relative;margin:8px 0 4px;padding-left:22px}
.timeline::before{content:'';position:absolute;left:5px;top:6px;bottom:6px;width:2px;
background:var(--separator);border-radius:2px}
.tl{position:relative;display:block;padding:0 0 18px;color:inherit;text-decoration:none}
.tl::before{content:'';position:absolute;left:-21px;top:6px;width:12px;height:12px;
border-radius:50%;background:var(--accent);border:2px solid var(--bg)}
.tl.past::before{background:var(--label-tertiary)}
.tl:hover{text-decoration:none}
.tl:hover .tlname{text-decoration:underline}
.tlname{display:block;font-size:16px;font-weight:700}

details.settings{margin-top:44px;border-top:1px solid var(--separator)}
details.settings summary{cursor:pointer;padding:16px 0;color:var(--label-secondary);
font-weight:650;list-style:none}
details.settings summary::-webkit-details-marker{display:none}
details.settings summary::before{content:"› ";display:inline-block;transition:transform .15s}
details.settings[open] summary::before{transform:rotate(90deg)}
details.settings h2{font-size:15px;margin:24px 0 6px}
details.tinyhelp summary{cursor:pointer;font-size:12px;font-weight:600;
color:var(--label-tertiary);margin-top:6px}
details.tinyhelp p{margin:8px 0 0}

@media (max-width:900px){
  .withrail{grid-template-columns:minmax(0,1fr);gap:8px}
  .rail{position:static}
}
@media (max-width:520px){
  .hero{padding:0 12px}
  /* The cover becomes a column on a phone. Left as a bottom-aligned row, a
     two-line title runs straight under the Shuffle/Upload buttons pinned in
     the corner - there is no room for both on 375px, so the buttons stop
     floating and take a line of their own under the name. */
  .hero .cover{min-height:180px;padding:16px;flex-direction:column;
  align-items:stretch;justify-content:flex-end;gap:14px}
  .hero h1{font-size:30px}
  .hero .cover .titles{margin-top:56px}
  .coveractions{right:14px;top:14px}
  .coversays{position:static;order:-1}
  .toptools{top:16px;right:16px}
  .brandchip{top:16px;left:16px}
  .coverx{top:16px;right:16px}
  .hero:has(.coverx) .toptools{right:62px}
  .hero:has(.cover.bare) .toptools{right:16px}
}
@media (prefers-reduced-motion:reduce){*{transition:none !important}}
`;

// `wide` is for the pages that are a form rather than something to read. 680px
// is the right measure for prose and too narrow for the profile row, where it
// clips three link fields down to "@use".
// The sign-in door only. Two columns on a laptop, and on a phone the picture
// becomes a band across the top rather than half a tall screen of crowd.
const DOOR_STYLE = `
body.door{min-height:100dvh;display:grid;grid-template-columns:1fr 1fr}
.doorleft{max-width:none;display:grid;place-items:center;padding:40px 32px}
.doorbox{width:100%;max-width:380px}
.doorbrand{display:inline-block;font-size:15px;font-weight:800;letter-spacing:-.01em;
color:var(--label);margin-bottom:48px}
.doorbrand:hover{text-decoration:none;color:var(--accent)}
.door h1{font-size:34px;line-height:1.05;margin:0 0 10px}
.door .muted{font-size:14px;line-height:1.5}
.ssorow{display:grid;gap:10px;margin:28px 0 0}
.ssobtn{display:flex;align-items:center;justify-content:center;gap:10px;min-height:52px;
padding:0 20px;border-radius:var(--r-pill);background:var(--bg-elevated);
border:1px solid var(--separator);color:var(--label);font-size:15px;font-weight:700;
transition:background .15s,border-color .15s}
.ssobtn:hover{text-decoration:none;background:var(--bg-elevated-2);border-color:var(--fill-hover)}
.ssobtn svg{width:19px;height:19px;flex:0 0 19px}
.doorfine{margin:22px 0 0;font-size:12px;line-height:1.5;color:var(--label-tertiary)}
.doorart{background-size:cover;background-position:center;position:relative}
/* The crowd sits behind a wash of the accent, so the two halves read as one
   page rather than a form pasted beside a stock photo. */
.doorart::after{content:'';position:absolute;inset:0;
background:linear-gradient(200deg,rgba(255,45,111,.26),rgba(10,10,12,.38))}
@media (max-width:820px){
  body.door{grid-template-columns:1fr;grid-template-rows:32vh auto}
  .doorart{order:-1}
  .doorleft{padding:32px 24px 64px}
  .doorbrand{margin-bottom:28px}
  .door h1{font-size:29px}
}
`;

function page(title, body, heroHtml, rail, wide, lit) {
  const shell = rail
    ? `<div class="withrail"><div>${body}</div>${rail}</div>`
    : `<main${wide ? ` class="wide"` : ""}>${body}</main>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="preload" href="/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body${lit ? ` class="nightlit"` : ""}>${heroHtml || ""}${shell}
<footer><a href="/home">PartyParty</a></footer></body></html>`;
}

// The hero the guest page opens with: the group's own picture if it has one,
// the warm party gradient if it does not, with the name sitting on it and the
// round floating chrome the app uses for secondary actions.
function hero(title, sub, cover, tools, coverForm, editable) {
  const url = mediaUrl(cover);
  const image = url ? ` style="background-image:url('${esc(url)}')"` : "";
  const pencil = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>`;
  const name = editable
    ? `<span id="groupName" contenteditable="plaintext-only" role="textbox"
         aria-label="Group name" spellcheck="false">${esc(title)}</span>
       <button class="fieldedit" type="button" id="groupNamePencil"
         aria-label="Edit the group name" title="Edit the group name">${pencil}</button>`
    : esc(title);
  return `<header class="hero">
    <a class="brandchip" href="/home" title="Back to your home">\u{1FAA9} PartyParty</a>
    ${tools ? `<div class="toptools">${tools}</div>` : ""}
    <div class="cover${url ? "" : " bare"}"${image} id="heroCover">
      ${editable ? `<button class="coverx" type="button" id="coverRemove"
        aria-label="Remove the cover" title="Remove the cover">✕</button>` : ""}
      <div class="titles">
        <h1>${name}</h1>
        ${sub ? `<p class="sub">${sub}</p>` : ""}
      </div>
      ${coverForm || ""}
    </div>
  </header>`;
}

// Shuffle and Upload, sitting on the picture itself - the console's two
// buttons, in the same corner, doing the same two things. Shuffle is a plain
// submit so it works with no JavaScript at all; Upload is a file input dressed
// as a button that submits the moment a picture is chosen.
function coverTools(action, fromPublic) {
  return `<span class="coversays" id="coverSays"></span>
    <form class="coveractions" method="post" action="${esc(action)}"
      enctype="multipart/form-data" id="coverForm">
    ${fromPublic ? `<input type="hidden" name="fromPublic" value="1">` : ""}
    <button type="submit" name="shuffleCover" value="1"
      aria-label="Shuffle image" title="Shuffle image">\u21bb</button>
    <button type="button" onclick="this.nextElementSibling.click()"
      aria-label="Upload image" title="Upload image">\u2191</button>
    <input type="file" name="cover" accept="image/*"
      onchange="this.form.requestSubmit ? this.form.requestSubmit() : this.form.submit()">
  </form>`;
}

// Changing the picture, and the name, without the page going anywhere.
//
// Shuffling used to be a form post and a redirect: the whole page tore down and
// came back to look at one different image, which is a lot of blinking for
// "show me another". The form still works with no JavaScript - this only
// intercepts it.
// The new-party page has nothing to save to yet, so Shuffle only changes what
// is on screen and what will be submitted. The title is typed straight into the
// hero and carried along as a hidden field.
function newPartyScript() {
  return `<script>
  (() => {
    const form = document.getElementById('newParty');
    const cover = document.getElementById('heroCover');
    const pick = document.getElementById('coverPick');
    const name = document.getElementById('groupName');
    if (!form || !cover || !pick) return;

    const PILE = ${JSON.stringify(COVER_PILE)};
    const shuffle = document.querySelector('#coverForm button[name=shuffleCover]');
    const upload = document.querySelector('#coverForm input[type=file]');
    const remove = document.getElementById('coverRemove');
    const show = (url) => {
      cover.style.backgroundImage = url ? "url('" + url + "')" : '';
      cover.classList.toggle('bare', !url);
    };
    if (shuffle) shuffle.addEventListener('click', (event) => {
      event.preventDefault();
      let next = pick.value;
      while (PILE.length > 1 && next === pick.value) {
        next = '/media/covers/' + PILE[Math.floor(Math.random() * PILE.length)] + '.webp';
      }
      pick.value = next;
      show(next);
    });
    if (remove) remove.addEventListener('click', (event) => {
      event.preventDefault(); pick.value = ''; show('');
    });
    if (upload) upload.addEventListener('change', () => {
      const file = upload.files && upload.files[0];
      if (!file) return;
      // Move the chosen file onto the form that actually submits.
      const carried = form.querySelector('input[name=cover]') || (() => {
        const input = document.createElement('input');
        input.type = 'file'; input.name = 'cover'; input.hidden = true;
        form.appendChild(input);
        return input;
      })();
      const swap = new DataTransfer();
      swap.items.add(file);
      carried.files = swap.files;
      pick.value = '';
      show(URL.createObjectURL(file));
    });

    // The title lives in the hero; carry it with the rest on submit.
    if (name) {
      const carried = document.createElement('input');
      carried.type = 'hidden'; carried.name = 'title';
      form.appendChild(carried);
      const sync = () => { carried.value = name.textContent.trim(); };
      name.addEventListener('input', sync);
      name.addEventListener('blur', sync);
      form.addEventListener('submit', sync);
      // A placeholder is not a name. Clear it the moment they start.
      name.addEventListener('focus', () => {
        if (name.textContent.trim() === 'Name your party') {
          name.textContent = '';
        }
      }, { once: true });
      sync();
    }
  })();
  </script>`;
}

function coverScript(action) {
  return `<script>
  (() => {
    const form = document.getElementById('coverForm');
    const cover = document.getElementById('heroCover');
    const says = document.getElementById('coverSays');
    const remove = document.getElementById('coverRemove');
    if (!form || !cover) return;
    const tell = (text, bad) => {
      if (!says) return;
      says.textContent = text || '';
      says.classList.toggle('bad', !!bad);
    };
    const paint = (url) => {
      cover.style.backgroundImage = url ? "url('" + url + "')" : '';
      cover.classList.toggle('bare', !url);
    };
    const send = async (data) => {
      form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      tell('Working…');
      try {
        const r = await fetch(${JSON.stringify(action)}, {
          method: 'POST', body: data, headers: { accept: 'application/json' },
        });
        const d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || 'that did not take');
        paint(d.coverUrl || '');
        tell('');
      } catch (e) {
        tell(String(e.message || e), true);
      } finally {
        form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      }
    };
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const data = new FormData(form);
      // A submit button's own name/value is not in FormData; the shuffle button
      // is the only one that submits, so say so explicitly.
      if (!data.get('cover') || !data.get('cover').size) {
        data.delete('cover');
        data.set('shuffleCover', '1');
      }
      send(data);
      form.querySelector('input[type=file]').value = '';
    });
    if (remove) remove.addEventListener('click', () => {
      const data = new FormData();
      data.set('clearCover', '1');
      send(data);
    });

    // The name, edited in place: Enter or clicking away saves it, Escape puts
    // it back. Same as naming an event in the app.
    const name = document.getElementById('groupName');
    const pencil = document.getElementById('groupNamePencil');
    if (!name) return;
    let was = name.textContent.trim();
    let saving = false;
    const save = async () => {
      const now = name.textContent.trim().slice(0, 80);
      // Enter saves and then blurs, so without this the blur that follows
      // would send the same name a second time.
      if (saving) return;
      if (!now || now === was) { name.textContent = was; return; }
      saving = true;
      try {
        const body = new FormData();
        body.set('groupName', now);
        const r = await fetch(${JSON.stringify(action)}, {
          method: 'POST', body, headers: { accept: 'application/json' },
        });
        const d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || 'that did not save');
        was = d.name || now;
        name.textContent = was;
        document.title = was;
      } catch (e) {
        name.textContent = was;
        tell(String(e.message || e), true);
      } finally {
        saving = false;
      }
    };
    if (pencil) pencil.addEventListener('click', () => {
      name.focus();
      const range = document.createRange();
      range.selectNodeContents(name);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    name.addEventListener('keydown', (event) => {
      // Enter saves on its own rather than leaning on the blur that follows:
      // a blur event is not guaranteed to arrive when the window itself is not
      // focused, and Enter means save now in any case.
      if (event.key === 'Enter') { event.preventDefault(); save(); name.blur(); }
      if (event.key === 'Escape') { name.textContent = was; name.blur(); }
    });
    name.addEventListener('blur', save);
  })();
  </script>`;
}

// The cover half of a form post, shared by groups and nights so the two cannot
// drift apart. Returns undefined when the post was not about the cover.
async function coverFromForm(env, form, current) {
  if (form.get("shuffleCover")) {
    // Never the one it is already showing: a shuffle that appears to do
    // nothing is indistinguishable from a broken button.
    const options = COVER_PILE.map(coverPileUrl).filter((url) => url !== current);
    return { key: options[crypto.getRandomValues(new Uint32Array(1))[0] % options.length] };
  }
  if (form.get("clearCover")) return { key: null };
  const file = form.get("cover");
  if (file && typeof file.arrayBuffer === "function" && Number(file.size) > 0) {
    const stored = await storeMedia(env, file, "covers", MAX_COVER);
    return stored.error ? { error: stored.error } : { key: stored.key };
  }
  return null;
}

// A party is a DAY. Nobody journalling a night remembers that it started at
// 21:00, and being asked for a time is one more field between standing in a
// room and writing down that you were there. The hour is kept on the row for
// upcoming/past and for a broadcast, and simply not shown.
function whenText(event) {
  if (!event.starts_ms) return "Date to come";
  const date = new Date(event.starts_ms);
  const parts = { weekday: "short", day: "numeric", month: "short", timeZone: event.timezone || "UTC" };
  // A party from before the change carried a real time somebody typed, so it
  // still gets one. Everything made since is a day.
  if (!event.day_only) parts.hour = "2-digit", parts.minute = "2-digit";
  const stamp = date.toLocaleString("en-GB", parts);
  // The year, once it is not this one - a journal is read years later.
  const year = date.getUTCFullYear();
  return year === new Date().getUTCFullYear() ? stamp : `${stamp} ${year}`;
}

// What was played. The order they were added is the order they were played,
// which is what somebody standing at a party can actually produce.
async function songsFor(env, eventId) {
  const { results } = await env.DB.prepare(
    `SELECT s.*, p.name AS person_name FROM songs s
       LEFT JOIN people p ON p.id = s.person_id
      WHERE s.event_id = ? ORDER BY s.seq, s.created_ms`
  ).bind(eventId).all();
  return results || [];
}

async function addSong(env, emailNorm, eventId, { title, artist, personId }, now) {
  const clean = String(title || "").trim().slice(0, 200);
  if (!clean) return null;
  const next = await env.DB.prepare(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM songs WHERE event_id = ?`
  ).bind(eventId).first();
  const id = ulid(now);
  await env.DB.prepare(
    `INSERT INTO songs (id, event_id, owner_email, title, artist, person_id, seq, created_ms)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(id, eventId, emailNorm, clean, String(artist || "").trim().slice(0, 120),
    personId || null, next ? next.n : 1, now).run();
  return id;
}

function initials(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "·";
  return (parts[0][0] + (parts[1] ? parts[1][0] : "")).toUpperCase();
}

// One person, one disc. Their picture if they set one, their initials if they
// did not - never an empty circle, and never a stranger's placeholder face.
function personDisc(person, extraClass) {
  const url = mediaUrl(person && person.avatar_key);
  const label = (person && (person.name || person.handle)) || "Someone";
  return `<span class="avatar${extraClass ? " " + extraClass : ""}" title="${esc(label)}">${
    url ? `<img src="${esc(url)}" alt="" loading="lazy">` : esc(initials(label))}</span>`;
}

// The profile form. One component, because the whole promise is that the thing
// you edit on first sight is the same thing you edit later - a settings page
// with different fields to the welcome page is two profiles wearing one name.
function profileEditor(profile, { action, heading, note, dismiss, error }) {
  const links = (profile && profile.linksObj) || {};
  const avatar = mediaUrl(profile && profile.avatar_key);
  return `<form class="you" method="post" action="${esc(action)}" enctype="multipart/form-data">
    ${heading ? `<h2 style="margin:0 0 14px">${esc(heading)}</h2>` : ""}
    ${error ? `<p class="formerror" role="alert">${esc(error)}</p>` : ""}
    ${profile && profile.avatar_key
      ? `<input type="hidden" name="keepAvatar" value="${esc(profile.avatar_key)}">` : ""}
    <div class="yourow">
      <label class="avatarpick" title="Choose a picture">
        <span class="disc">${avatar
          ? `<img src="${esc(avatar)}" alt="">`
          : esc(initials(profile && profile.name))}</span>
        <input type="file" name="avatar" accept="image/*">
        <small class="hintline">${avatar ? "Change" : "Add a photo"}</small>
      </label>
      <div class="grow">
        <div class="twoup">
          <input type="text" name="name" maxlength="60" placeholder="Your name"
            value="${esc((profile && profile.name) || "")}" autocomplete="name">
          <input type="text" name="bio" maxlength="200" placeholder="A line about you"
            value="${esc((profile && profile.bio) || "")}">
        </div>
        <div class="socials">
          ${SOCIAL_FIELDS.map((field) => `<label class="pill">
            <span>${esc(field.label)}</span>
            <input type="text" name="${esc(field.key)}" placeholder="${esc(field.place)}"
              value="${esc(links[field.key] || "")}" autocomplete="off" spellcheck="false">
          </label>`).join("")}
        </div>
      </div>
    </div>
    <div class="youbar">
      <label class="handlepill" title="Your address here">
        <span>@</span>
        <input type="text" name="handle" maxlength="30" spellcheck="false"
          autocapitalize="none" autocomplete="off" data-handle
          value="${esc((profile && profile.handle) || "")}"
          size="${Math.max(8, ((profile && profile.handle) || "").length)}">
      </label>
      <button class="btn" type="submit" data-save>Save</button>
      ${dismiss
        ? `<button class="btn plain" type="submit" name="dismiss" value="1"
            formnovalidate>${esc(dismiss)}</button>`
        : ""}
      ${profile && profile.avatar_key
        ? `<button class="btn plain small" type="submit" name="clearAvatar" value="1">Remove photo</button>`
        : ""}
      <span class="handlesays" data-says aria-live="polite"></span>
      ${note ? `<p class="muted">${note}</p>` : ""}
    </div>
    ${profileEditorScript()}
  </form>`;
}

// Ask while they are still typing.
//
// The old behaviour was to accept the form, fail on the server and replace the
// whole page with "That @name is taken" - which is the answer arriving after
// the question stopped being useful, on a page that no longer holds anything
// they wrote. Now the field answers itself, and Save is not a thing you can
// press into a wall.
//
// The server still checks. This is a courtesy, not a gate: two people can pick
// the same name a second apart, and only the database can settle that.
function profileEditorScript() {
  return `<script>
  (() => {
    const form = document.currentScript.closest('form');
    const field = form.querySelector('[data-handle]');
    const says = form.querySelector('[data-says]');
    const save = form.querySelector('[data-save]');
    if (!field || !says || !save) return;
    const was = field.value;
    let timer = 0, seq = 0;
    const show = (text, state) => {
      says.textContent = text;
      says.dataset.state = state || '';
      // Never block the way out. A name that cannot be saved must not also
      // trap somebody on the page with no way to put the old one back.
      save.disabled = state === 'bad';
    };
    const ask = async () => {
      const value = field.value.trim().toLowerCase();
      if (!value || value === was) return show('', '');
      const mine = ++seq;
      show('checking…', '');
      try {
        const r = await fetch('/api/v1/handle-free?h=' + encodeURIComponent(value));
        const d = await r.json();
        if (mine !== seq) return;
        show(d.free ? '@' + value + ' is free' : 'Not available - ' + (d.why || 'taken'),
          d.free ? 'ok' : 'bad');
      } catch (e) {
        // Offline or blocked: say nothing and let the server decide. A false
        // "taken" because a fetch failed would be worse than no answer.
        if (mine === seq) show('', '');
      }
    };
    field.addEventListener('input', () => {
      field.value = field.value.toLowerCase().replace(/[^a-z0-9]/g, '');
      show('', '');
      clearTimeout(timer);
      timer = setTimeout(ask, 300);
    });
    field.addEventListener('blur', ask);

    // The photo. Choosing one used to do nothing visible at all: the disc kept
    // showing initials, so there was no sign a Save was pending and no reason
    // to press it. Every "the picture does not save" is really this.
    const picker = form.querySelector('[name=avatar]');
    const disc = form.querySelector('.avatarpick .disc');
    const hint = form.querySelector('.avatarpick .hintline');
    if (!picker || !disc) return;

    const shown = (url, label) => {
      disc.innerHTML = '';
      const img = document.createElement('img');
      img.alt = '';
      // HEIC decodes in Safari and not in Chrome. If the preview cannot render
      // we still say plainly that a file is attached, rather than showing a
      // broken frame that reads as another failure.
      img.onerror = () => { disc.textContent = '✓'; };
      img.src = url;
      disc.appendChild(img);
      if (hint) { hint.textContent = label; hint.style.color = 'var(--accent)'; }
      save.classList.add('nudge');
    };

    // Re-encoded to something modest before it ever leaves the browser: a
    // 5MB photo from a phone becomes a ~60KB square, HEIC becomes JPEG
    // wherever the browser can decode it, and the upload is instant on venue
    // Wi-Fi. Falls back to the original bytes when the canvas cannot help.
    const shrink = (file) => new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const side = Math.min(512, Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = side;
          const ctx = canvas.getContext('2d');
          // Square crop from the middle: the disc is a circle, so anything
          // outside that square was never going to be seen.
          const cut = Math.min(img.width, img.height);
          ctx.drawImage(img, (img.width - cut) / 2, (img.height - cut) / 2, cut, cut, 0, 0, side, side);
          canvas.toBlob((blob) => {
            URL.revokeObjectURL(url);
            resolve(blob ? new File([blob], 'avatar.jpg', { type: 'image/jpeg' }) : null);
          }, 'image/jpeg', 0.85);
        } catch (e) {
          URL.revokeObjectURL(url);
          resolve(null);
        }
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });

    picker.addEventListener('change', async () => {
      const file = picker.files && picker.files[0];
      if (!file) return;
      shown(URL.createObjectURL(file), 'Press Save');
      const smaller = await shrink(file);
      if (!smaller || typeof DataTransfer !== 'function') return;
      const swap = new DataTransfer();
      swap.items.add(smaller);
      picker.files = swap.files;
      shown(URL.createObjectURL(smaller), 'Press Save');
    });
  })();
  </script>`;
}

// Reading the profile form back. Every field is optional and a blank one means
// blank, so this writes what it is given rather than merging - except the
// handle, which is refused rather than cleared: a person with no address is not
// a state this has any use for.
async function saveProfileForm(env, emailNorm, form, now) {
  const profile = await profileFor(env, emailNorm, now);
  if (!profile) return { error: "no profile" };

  // "Not now" is a real answer. It settles the welcome without pretending the
  // person filled anything in, and Settings is still there when they want it.
  if (form.get("dismiss")) {
    await env.DB.prepare(`UPDATE profiles SET saved_ms = ? WHERE email_norm = ?`)
      .bind(now, emailNorm).run();
    return { ok: true };
  }

  // Read the whole form first, so a rejection can hand back exactly what they
  // typed. Failing early and rendering a bare error page threw away the name,
  // the bio and the links along with the one field that was wrong.
  const links = {};
  for (const field of SOCIAL_FIELDS) {
    const value = field.key === "website"
      ? websiteUrl(form.get(field.key))
      : socialName(form.get(field.key));
    if (value) links[field.key] = value;
  }
  const name = String(form.get("name") || "").slice(0, 60).trim();
  const bio = String(form.get("bio") || "").slice(0, 200).trim();
  const wanted = normalizeHandle(form.get("handle"));

  // The photo is stored before anything can be rejected, and its key is carried
  // back on the form, so a bad @name does not also cost them the picture they
  // just chose - a file input cannot be refilled from the server.
  let avatarKey = profile.avatar_key;
  let photoProblem = "";
  if (form.get("clearAvatar")) {
    avatarKey = null;
  } else {
    const keep = String(form.get("keepAvatar") || "");
    if (keep && /^avatars\/[a-f0-9]+$/.test(keep)) avatarKey = keep;
    const file = form.get("avatar");
    if (file && typeof file.arrayBuffer === "function" && Number(file.size) > 0) {
      const stored = await storeMedia(env, file, "avatars", MAX_AVATAR);
      if (stored.error) photoProblem = stored.error;
      else avatarKey = stored.key;
    }
  }
  // What they submitted, in the shape the editor renders, ready to hand back.
  const pending = {
    ...profile, name, bio, avatar_key: avatarKey,
    handle: wanted || profile.handle, linksObj: links,
  };
  if (photoProblem) return { error: photoProblem, pending };

  let handle = profile.handle;
  if (wanted && wanted !== profile.handle) {
    const problem = handleProblem(wanted);
    if (problem) return { error: `That @name has to be ${problem}.`, pending };
    if (!await handleFree(env, wanted, emailNorm)) {
      return { error: `@${wanted} is already taken - pick another.`, pending };
    }
    handle = wanted;
    await reserveHandle(env, wanted);
  }

  await env.DB.prepare(
    `UPDATE profiles SET handle = ?, name = ?, bio = ?, avatar_key = ?, links = ?,
       saved_ms = ?, updated_ms = ? WHERE email_norm = ?`
  ).bind(handle, name, bio, avatarKey, JSON.stringify(links), now, now, emailNorm).run();

  // The name a person is called by, everywhere they act. Kept in step so the
  // roster at a party and the profile page do not disagree about who came.
  if (name) {
    await env.DB.prepare(`UPDATE djs SET name = ? WHERE email_norm = ?`).bind(name, emailNorm).run();
    await env.DB.prepare(`UPDATE members SET name = ? WHERE email_norm = ?`).bind(name, emailNorm).run();
  }
  return { ok: true };
}

// Who is in this group, beside the page.
//
// The people who RUN it come first under their own heading, the way the guest's
// phone lists a DJ above the room listening to them - a group is somebody's
// before it is everybody's, and a rail that mixes them into one alphabetical
// soup does not say that.
function peopleRail(people, base, handle, canManage) {
  const all = people || [];
  const djs = all.filter((p) => p.role === "owner" || p.role === "host");
  const rest = all.filter((p) => p.role !== "owner" && p.role !== "host").slice(0, 24);

  const row = (m, under) => `<li>${personDisc(m)}
    <span><b>${m.handle
      ? `<a href="/@${esc(m.handle)}">${esc(m.name || "@" + m.handle)}</a>`
      : esc(m.name || "Someone")}</b>
    <small${under.startsWith("@") ? ` class="at"` : ""}>${esc(under)}</small></span></li>`;

  const section = (label, list, under) => (list.length
    ? `<div class="whogroup">
         <div class="whohead">${esc(label)}<small>\u2014 ${list.length}</small></div>
         <ul class="who-list">${list.map((m) => row(m, under(m))).join("")}</ul>
       </div>`
    : "");

  return `<aside class="rail">
      <div class="card">
        <h2>Participants${all.length ? ` \u2014 ${all.length}` : ""}</h2>
        ${all.length
          ? `${section(djs.length === 1 ? "Admin" : "Admins", djs, () => "Admin")}
             ${section("Members", rest, (m) => m.handle ? "@" + m.handle : "Following")}`
          : `<p class="muted">Nobody yet. The first person to follow shows up here.</p>`}
      </div>
      ${canManage ? `<div class="card">
        <h2>Yours to run</h2>
        <p class="muted">Only you can see this.</p>
        <p><a class="btn plain small" href="/@${esc(handle)}/manage">Manage this group</a></p>
      </div>` : ""}
    </aside>`;
}

// A person at their @name. Not a second group page: a person is who they are
// and what they run, and the parties themselves live on the group's page where
// somebody can follow them.
// Somebody's page: who they are, and their parties. This replaced a group page
// that showed the same rows under a borrowed name - groups are dead, and a
// person was always what the address meant.
function personPage(profile, upcoming, past, isMe, base, followHandle, following) {
  const links = profile.linksObj || {};
  const shown = SOCIAL_FIELDS
    .map((field) => ({ field, value: links[field.key], href: linkHref(field.key, links[field.key]) }))
    .filter((entry) => entry.value && entry.href);

  const row = (e) => `<a class="card partyrow" href="/@${esc(profile.handle)}/${esc(e.slug)}">
    <div class="grow">
      <div class="when">${esc(whenText(e))}${e.place ? " \u00b7 " + esc(e.place) : ""}</div>
      <strong>${esc(e.title || "Untitled party")}</strong>
    </div>
  </a>`;
  const section = (label, list, empty) => `<h2>${esc(label)}</h2>
    ${list.length ? list.map(row).join("") : `<p class="muted">${empty}</p>`}`;

  return page(profile.name || `@${profile.handle}`, `
    <div class="you"><div class="yourow" style="align-items:center">
      ${personDisc(profile, "big")}
      <div class="grow" style="gap:2px">
        <b style="font-size:16px">${esc(profile.name || "@" + profile.handle)}</b>
        <span class="muted">@${esc(profile.handle)}${
          profile.bio ? " \u00b7 " + esc(profile.bio) : ""}</span>
      </div>
      ${isMe ? `<a class="btn plain small" href="/settings">Edit</a>` : ""}
    </div></div>
    ${shown.length ? `<p class="row">${shown.map((entry) =>
      `<a class="btn plain small" href="${esc(entry.href)}" rel="noopener noreferrer nofollow"
        target="_blank">${esc(entry.field.label)}</a>`).join("")}</p>` : ""}
    ${profile.pay_link || profile.merch_link ? `<p class="row">
      ${profile.pay_link ? `<a class="btn plain" href="${esc(profile.pay_link)}"
        rel="noopener noreferrer nofollow" target="_blank">Tip the DJ</a>` : ""}
      ${profile.merch_link ? `<a class="btn plain" href="${esc(profile.merch_link)}"
        rel="noopener noreferrer nofollow" target="_blank">${
          esc(profile.merch_label || "Merch")}</a>` : ""}
    </p>` : ""}
    ${isMe || following ? "" : !followHandle ? "" : `<form class="join" method="post"
      action="/@${esc(followHandle)}/join">
      <div class="row">
        <input type="email" name="email" placeholder="your email" required>
        <input type="text" name="name" placeholder="your name">
      </div>
      <button class="actionbar" type="submit">
        <span class="tile">\u2605</span>
        <span class="lines">Follow<small>Hear about their parties</small></span>
      </button>
    </form>
    <p class="muted">One email to confirm. No account, and you can stop from any
    message we send.</p>`}
    ${following ? `<p class="muted">\u2605 You follow ${esc(profile.name || "@" + profile.handle)}.
      Only you can see that.</p>` : ""}
    ${section("Coming up", upcoming, isMe ? "Nothing coming up." : "Nothing announced.")}
    ${section("Past", past, "Nothing yet.")}
    <h2>Add to your calendar</h2>
    <p class="muted">Their parties, in your own calendar, without an account.</p>
    ${calendarBlock(base, profile.handle)}
    ${isMe ? `<p class="muted" style="margin-top:32px"><a href="/home">Your parties</a> ·
      <a href="/manage">Tips, merch and Pro</a></p>` : ""}
  `, "", "", true);
}

// Everything one person is throwing, newest first for what has happened and
// soonest first for what has not. Owned by them: groups no longer decide.
async function partiesOwnedBy(env, emailNorm, now) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM events WHERE owner_email = ? AND state != 'draft'
      ORDER BY COALESCE(starts_ms, created_ms) DESC LIMIT 200`
  ).bind(emailNorm).all();
  const all = results || [];
  return {
    upcoming: all.filter((e) => !partyIsPast(e, now))
      .sort((a, b) => (a.starts_ms || Infinity) - (b.starts_ms || Infinity)),
    past: all.filter((e) => partyIsPast(e, now)),
  };
}

// My half of a party page: whether I went, what I thought, who played, who I
// saw, and what I want to remember about running into each of them HERE.
//
// Only ever rendered for the person it belongs to. A note is a diary entry, not
// content, and nothing in here appears on anybody else's screen.
// The record: the whole reason the app exists.
//
// Five things, each one line to add - who played, who was there, what they
// played, what you thought, and who may see any of it. No sub-forms, no modes,
// no save button you have to find. The bar is Apple's Journal: if it cannot be
// done one-handed while a room is loud and dark, it does not get done at all.
function trackerBlock(event, group, note, people, allNames, songs) {
  const action = `/@${esc(group.handle)}/${esc(event.slug)}/record`;
  const attended = note && note.attended === 1;

  // One row per person: their face, their name, and a note about them from
  // THIS night, which is a different thought from a note about them generally.
  const list = (role, empty) => {
    const rows = people.filter((p) => p.role === role);
    return `${rows.length ? `<ul class="people">${rows.map((p) => `<li>
      ${personDisc(p)}
      <form method="post" action="${action}" class="personline">
        <input type="hidden" name="person" value="${esc(p.id)}">
        <div class="nameline">
          <a href="/people/${esc(p.id)}">${esc(p.name)}</a>
          <button class="x" type="submit" name="remove" value="1"
            formnovalidate aria-label="Remove ${esc(p.name)}">\u2715</button>
        </div>
        <input class="quiet" type="text" name="encounter" maxlength="2000"
          value="${esc(p.note || "")}" placeholder="Add a note about them">
        <button class="onfocus" type="submit">Save</button>
      </form></li>`).join("")}</ul>` : `<p class="blank">${empty}</p>`}`;
  };


  return `<section class="tracker">
    <form class="capture" method="post" action="${esc(action)}">
      <input type="text" name="it" list="knownpeople" autocomplete="off"
        placeholder="Ada, Bo and Cy\u2026" aria-label="Add to this night">
      <div class="as">
        <button type="submit" name="as" value="dj">played</button>
        <button type="submit" name="as" value="guest">with me</button>
        <button type="submit" name="as" value="song">on now</button>
      </div>
    </form>

    <h2>Who played</h2>
    ${list("dj", "Whoever was on. They need no account - a name is enough.")}

    <h2>Who was there</h2>
    ${list("guest", "Who you were with. Next time you type their name, it is the same person.")}

    <h2>Songs</h2>
    ${songs && songs.length ? `<ol class="setlist">${songs.map((song) => `<li>
      <span class="grow"><b>${esc(song.title)}</b>${
        song.artist ? ` <span class="muted">${esc(song.artist)}</span>` : ""}${
        song.person_name ? ` <span class="tag quiet">${esc(song.person_name)}</span>` : ""}</span>
      <form method="post" action="${action}">
        <input type="hidden" name="song" value="${esc(song.id)}">
        <button class="x" type="submit" name="remove" value="1"
          formnovalidate aria-label="Remove ${esc(song.title)}">\u2715</button>
      </form>
    </li>`).join("")}</ol>` : `<p class="blank">What was played, in the order it was played.</p>`}

    <h2>Your notes</h2>
    <form class="you" method="post" action="${esc(action)}">
      <div class="grow" style="display:grid;gap:10px">
        <textarea name="note" maxlength="4000" style="min-height:92px"
          placeholder="What you thought">${esc((note && note.note) || "")}</textarea>
        <label class="wentrow">
          <input type="checkbox" name="attended" value="1"${attended ? " checked" : ""}>
          <span>I was there</span>
        </label>
      </div>
      <div class="youbar"><button class="btn" type="submit">Save</button></div>
    </form>

    <datalist id="knownpeople">${allNames.map((n) =>
      `<option value="${esc(n.name)}"></option>`).join("")}</datalist>
  </section>`;
}

// Editing a party from the web: the same fields the Mac writes, through the
// same updateParty. Folded away by default because the page's job is to show
// the night, not to be a form - but one click from anywhere the owner is
// looking, rather than a separate settings screen to go and find.
function partyEditor(group, event, error, typed) {
  const was = (name, fallback) => esc(
    typed && typed.get(name) !== null ? typed.get(name) : fallback);
  // datetime-local wants the wall clock it will show back. Everything stored is
  // UTC ms, so this is the same conversion the create form does, in reverse.
  const localValue = event.starts_ms
    ? new Date(event.starts_ms).toISOString().slice(0, 10) : "";
  return `<details class="edit"${error ? " open" : ""}>
    <summary>Edit the details</summary>
    ${error ? `<p class="formerror" role="alert">${esc(error)}</p>` : ""}
    <form class="newnight" method="post" action="/@${esc(group.handle)}/${esc(event.slug)}/edit">
      <label class="eventfield"><span>What is it called?</span>
        <input type="text" name="title" maxlength="120" required
          value="${was("title", event.title || "")}"></label>
      <label class="eventfield"><span>When</span>
        <input type="date" name="day" value="${was("day", localValue)}"></label>
      <label class="eventfield"><span>Where</span>
        <input type="text" name="place" maxlength="120"
          value="${was("place", event.place || "")}"></label>
      <label class="eventfield"><span>Links</span>
        <textarea name="links" maxlength="2000" style="min-height:76px"
          placeholder="One per line. Tickets | https://...">${was("links", event.links || "")}</textarea></label>
      <button class="btn" type="submit">Save the details</button>
    </form>
  </details>`;
}

// A night, as the person who was at it reads it.
//
// This used to be a promotion page with a journal stapled underneath: on your
// own entry it asked for your email so you could RSVP to your own party,
// offered to add it to your calendar, and told you who had organised it. The
// page IS the record now. Everything on it is one line to add - a name, a song,
// a thought, a photo - because the whole thing gets written standing up, in a
// dark room, on a phone.
//
// A visitor sees the night and what was shared of it, and the going/tickets/
// calendar machinery that only means anything to somebody who was not there.
// Who may see this night. A fact about the night, so it belongs with it - one
// chip that says the answer and opens to the three of them. As a section in the
// middle of the record it was a settings screen interrupting a diary.
function seenBy(group, event) {
  const seen = { private: "Only you", link: "Anyone with the link", public: "Anyone" };
  const now = event.visibility || "private";
  const says = {
    private: "Yours. Nobody else can open this page.",
    link: "Anybody you send the link to can open it, and add photos.",
    public: "On your profile, for anyone.",
  };
  return `<details class="seen">
    <summary><span class="dotv ${now}"></span>${esc(seen[now])}</summary>
    <form class="seenby" method="post"
      action="/@${esc(group.handle)}/${esc(event.slug)}/record">
      ${Object.entries(seen).map(([value, label]) => `<button
        class="btn ${value === now ? "" : "plain "}small" type="submit"
        name="visibility" value="${value}"${value === now ? ' aria-current="true"' : ""}
        >${esc(label)}</button>`).join("")}
    </form>
    <p class="muted">${says[now]}</p>
  </details>`;
}

function nightHue(key) {
  let n = 0;
  for (const ch of String(key || "")) n = (n * 31 + ch.charCodeAt(0)) % 360;
  return n;
}

function eventPage(group, event, going, base, takeRate, canEdit, tracker, extra) {
  const { live, editError, typed, phase, posts, canPost, payLink, ownerName,
    billed, setlist } = extra || {};
  const links = partyLinks(event.links);
  const where = `/@${esc(group.handle)}/${esc(event.slug)}`;

  // A night you shared shows the night: who was on, and what they played. Those
  // are the interesting parts and they are not secrets once you have handed
  // somebody the link. What stays yours is what you thought - your note, and
  // your notes about the people.
  // Who PLAYED is the night's billing: it is what the night was, and sharing
  // the night shares it. Who I SAW is my observation of a room, and stays mine
  // however widely the night is shared - the same reason my note does.
  const bill = (billed || []).filter((p) => p.role === "dj");
  const named = (rows) => `<ul class="who-list">${rows.map((p) => `<li>
    ${personDisc(p)}<span><b>${esc(p.name)}</b></span></li>`).join("")}</ul>`;

  const shared = `
    ${bill.length ? `<h2>Who played</h2>${named(bill)}` : ""}
    ${(setlist || []).length ? `<h2>Songs</h2><ol class="setlist">${setlist.map((song) =>
      `<li><span class="grow"><b>${esc(song.title)}</b>${
        song.artist ? ` <span class="muted">${esc(song.artist)}</span>` : ""}</span></li>`)
      .join("")}</ol>` : ""}
    ${links.length ? `<ul class="linklist">${links.map((l) =>
      `<li><a href="${esc(l.href)}" rel="noopener noreferrer nofollow"
        target="_blank">${esc(l.label)}</a></li>`).join("")}</ul>` : ""}
    ${event.state === "cancelled" ? `<p><strong>This night is cancelled.</strong></p>` : ""}

    <h2>Photos</h2>
    ${canPost ? `<form class="addline say" method="post" enctype="multipart/form-data"
      action="${where}/say">
      <input type="text" name="say" maxlength="2000" placeholder="Say something">
      <button class="camera" type="button" aria-label="Add a photo"
        onclick="this.nextElementSibling.click()"><svg viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path
        d="M3 8.5A1.5 1.5 0 0 1 4.5 7h2.2l1.1-1.7A1 1 0 0 1 8.6 5h6.8a1 1 0 0 1 .8.3L17.3 7h2.2A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5Z"/><circle
        cx="12" cy="13" r="3.2"/></svg></button>
      <input type="file" name="media" accept="image/*,video/*" hidden
        onchange="this.form.requestSubmit ? this.form.requestSubmit() : this.form.submit()">
      <button type="submit" aria-label="Post">+</button>
    </form>` : ""}
    ${posts && posts.length ? nightRoll(posts)
      : `<p class="blank">Photos and anything said here land in this space.</p>`}`;

  // Everything a visitor needs and an owner does not: whether they are coming,
  // a ticket, the date in their own calendar, a way to tip whoever threw it.
  const forVisitors = `
    <hr class="soft">
    <p class="muted">${going} going</p>
    ${event.ticket_cents ? `<form class="join" method="post" action="${where}/buy">
      <input type="email" name="email" placeholder="your email" required>
      <button class="btn" type="submit">Buy a ticket -
        ${esc((totalForBuyer(event.ticket_cents, takeRate).total / 100).toFixed(2))}</button>
    </form>` : `<form class="join" method="post" action="${where}/going">
      <input type="email" name="email" placeholder="your email" required>
      <input type="text" name="name" placeholder="your name">
      <button class="btn" type="submit">I'm coming</button>
    </form>`}
    <p><a class="btn plain small" href="${where}.ics">Add this night to your calendar</a></p>
    ${payLink ? `<p><a class="btn plain" href="${esc(payLink)}"
      rel="noopener noreferrer nofollow" target="_blank">Tip the DJ</a></p>` : ""}
    <p class="muted">Kept by <a href="/@${esc(group.handle)}">${esc(ownerName || group.handle)}</a> -
    follow them to hear about their other nights.</p>`;

  const tint = event.cover_key
    ? `<style>body{--night:hsl(${nightHue(event.cover_key)} 78% 62%)}</style>` : "";
  return page(`${event.title || "A night"} - ${ownerName || group.handle}`, `
    ${tint}
    ${live ? `<p class="nowplaying"><span class="dot"></span> Playing right now
      <a class="btn small" href="${esc(event.live_url)}" rel="noopener">Listen</a></p>` : ""}

    ${canEdit ? `<div class="nightbar">${seenBy(group, event)}${
      partyEditor(group, event, editError, typed)}</div>` : ""}

    ${canEdit ? (tracker || "") + shared : shared + forVisitors}
  `, hero(event.title || "A night",
      `${esc(whenText(event))}${event.place ? ` \u00b7 ${esc(event.place)}` : ""}${
        phase === "now" ? ` \u00b7 <b>on tonight</b>` : ""}`,
      event.cover_key,
      canEdit ? "" : `<a href="/@${esc(group.handle)}">${esc(ownerName || group.handle)}</a>`,
      canEdit ? coverTools(`/@${group.handle}/${event.slug}/cover`) : ""),
    "", false, true);
}

// Subscribing to a calendar, without the security warning.
//
// webcal:// is the one-click scheme, and Apple Calendar resolves it to http://
// - so it asks "the connection is not secure" before it fetches anything, and
// no redirect on our side can prevent that: the first hop is already cleartext.
// So we hand out the https URL instead. Google takes it in one click; Apple
// takes it pasted into New Calendar Subscription, which is two steps and no
// alarming dialog about the thing you were about to trust.
function calendarBlock(base, handle) {
  // No @ in the subscription URL. It is legal in a path and it is also the kind
  // of character that a calendar client's URL field, or whatever pastes into
  // it, may or may not survive - and when it does not, the error is "check the
  // URL" with nothing to check.
  const icsUrl = `${base}/calendar/${handle}.ics`;
  const apple = icsUrl.replace(/^https:/, "webcal:");
  // render?cid= with the webcal form. The r?cid= route with an https URL is the
  // one that answers "unable to add calendar - check the URL" while the feed is
  // perfectly good, which cost an afternoon to pin on the link rather than the
  // calendar. Google rewrites webcal to https itself.
  const google = "https://calendar.google.com/calendar/render?cid=" + encodeURIComponent(apple);
  return `<div class="linkrow">
      <input class="linkbox" type="text" readonly value="${esc(icsUrl)}"
        onclick="this.select()" aria-label="Calendar link">
      <button class="btn plain small copy" type="button" data-copy="${esc(icsUrl)}">Copy</button>
    </div>
    <div class="row">
      <a class="btn plain small" href="${esc(apple)}">Apple</a>
      <a class="btn plain small" href="${esc(google)}" rel="noopener">Google</a>
    </div>
    <details class="tinyhelp"><summary>If a button does not take</summary>
      <p class="muted">Paste the link above: Google Calendar → Other calendars →
        + → From URL, or Apple Calendar → File → New Calendar Subscription.
        Apple's button warns about an "insecure connection" first - that is its
        webcal: link opening over http before it upgrades, and it is safe.</p>
    </details>
    <script>
    for (const button of document.querySelectorAll('.copy')) {
      button.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(button.dataset.copy);
          const was = button.textContent;
          button.textContent = 'Copied';
          setTimeout(() => { button.textContent = was; }, 1500);
        } catch (e) { button.previousElementSibling.select(); }
      });
    }
    </script>`;
}

function notice(title, message) {
  return html(200, page(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`));
}

// ------------------------------------------------------------------ queries

// The handle in an address. A person's @name now: groups are dead, and the one
// thing they still supply is a home for parties made before the change. Their
// own @name is tried first so somebody who has both - which is everybody who
// ever made a group - is found as themselves.
// The party at /@handle/<slug>. Found by its OWNER, which is what an address
// means now - the group behind it is only how a party made before the change
// can still be reached. Returns the row and the person it belongs to.
async function partyAt(env, handle, slug) {
  const profile = await profileByHandle(env, handle);
  if (profile) {
    const event = await env.DB.prepare(
      `SELECT * FROM events WHERE owner_email = ? AND slug = ?`
    ).bind(profile.email_norm, slug).first();
    if (event) return { event, profile };
  }
  // An address that was a group's handle, or a party from before owners.
  const group = await groupByHandle(env, handle);
  if (!group) return null;
  const event = await env.DB.prepare(
    `SELECT * FROM events WHERE group_id = ? AND slug = ?`
  ).bind(group.id, slug).first();
  if (!event) return null;
  return { event, profile: profile || (event.owner_email
    ? await profileByHandle(env, handle) : null) };
}

async function groupByHandle(env, handle) {
  const clean = String(handle || "").toLowerCase();
  const profile = await env.DB.prepare(`SELECT * FROM profiles WHERE handle = ?`)
    .bind(clean).first();
  if (profile) {
    const owned = await env.DB.prepare(
      `SELECT g.* FROM groups g JOIN group_djs gd ON gd.group_id = g.id
         JOIN djs d ON d.id = gd.dj_id
        WHERE d.email_norm = ? AND g.handle = ?`
    ).bind(profile.email_norm, clean).first();
    if (owned) return owned;
  }
  return env.DB.prepare(`SELECT * FROM groups WHERE handle = ?`).bind(clean).first();
}

async function upcomingEvents(env, groupId, now) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM events WHERE group_id = ? AND state != 'draft'
       AND (starts_ms IS NULL OR starts_ms > ?) ORDER BY starts_ms ASC LIMIT 50`
  ).bind(groupId, now - 12 * 60 * 60 * 1000).all();
  return results || [];
}

async function goingCount(env, eventId) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM signups WHERE event_id = ? AND state = 'going'`
  ).bind(eventId).first();
  return Number((row && row.n) || 0);
}

// ------------------------------------------------------------------ actions

async function joinGroup(env, group, emailNorm, name, source, base, now) {
  const member = await upsertMember(env, emailNorm, name, now);
  await env.DB.prepare(
    `INSERT INTO group_members (group_id, member_id, state, volume, source, joined_ms)
     VALUES (?, ?, 'joined', 'events', ?, ?)
     ON CONFLICT(group_id, member_id) DO UPDATE SET state = 'joined', left_ms = NULL`
  ).bind(group.id, member.id, source, now).run();

  const confirm = await mintToken(env, { memberId: member.id, groupId: group.id, purpose: "confirm", now });
  const manage = await mintToken(env, { memberId: member.id, groupId: group.id, purpose: "manage", now });
  await queueMail(env, {
    to: emailNorm,
    subject: `Confirm you want to hear from ${group.name || group.handle}`,
    text: `Tap to confirm: ${base}/j/${confirm}\n\n`
      + `Their nights: ${base}/@${group.handle}\n`
      + `Their nights in your calendar: ${base}/@${group.handle}.ics\n\n`
      + `Not you, or changed your mind? ${base}/m/${manage}`,
    kind: "confirm",
    groupId: group.id,
    unsubscribe: `${base}/m/${manage}?stop=1`,
    now,
  });
  return member;
}

// A handle is claimed in the broker's keyspace as well as this database. The
// broker mints two-word names for Macs out of the same namespace and checks
// those keys before handing one out; a group reserved only here would
// eventually be given away to a machine.
async function claimHandle(env, handle) {
  if (env.DL) {
    for (const key of ["handle", "host", "join", "slug"]) {
      if (await env.DL.head(`broker/${key}/${handle}`)) return false;
    }
  }
  return true;
}

async function reserveHandle(env, handle) {
  if (env.DL) await env.DL.put(`broker/handle/${handle}`, "group");
}

async function createGroup(env, dj, handle, name, now) {
  const problem = handleProblem(handle);
  if (problem) return { error: problem };
  // A group cannot take a name another group already has, even one of yours.
  const existing = await env.DB.prepare(`SELECT 1 AS ok FROM groups WHERE handle = ?`)
    .bind(handle).first();
  if (existing) return { error: "that name is taken" };
  // Everything else asks on this person's behalf. Their own @name is reserved
  // in the broker keyspace by their own profile, so a plain claimHandle refused
  // to let anybody name a group after themselves - which is the default the
  // sign-in flow offers, so linking a Mac failed on the obvious answer.
  if (!await handleFree(env, handle, dj && dj.email_norm)) {
    return { error: "that name is taken" };
  }
  const id = ulid(now);
  try {
    await env.DB.prepare(
      `INSERT INTO groups (id, handle, name, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?)`
    ).bind(id, handle, String(name || "").slice(0, 80), now, now).run();
  } catch (e) {
    // The UNIQUE index is the real arbiter, so two people claiming the same
    // name at the same moment resolve here rather than both being told yes.
    return { error: "that name is taken" };
  }
  await reserveHandle(env, handle);
  await env.DB.prepare(
    `INSERT INTO group_djs (group_id, dj_id, role, created_ms) VALUES (?, ?, 'owner', ?)`
  ).bind(id, dj.id, now).run();
  return { id, handle };
}

// ----------------------------------------------------------------- profiles

// Two halves of a name that reads like somebody chose it. The point of minting
// one is that a new arrival is already somebody - anonymous, but not a blank
// form - and can rename themselves later if they care to.
const HANDLE_FIRST = [
  "neon", "velvet", "midnight", "glitter", "disco", "amber", "electric",
  "golden", "silver", "ruby", "cosmic", "lunar", "sunset", "crimson", "indigo",
  "mellow", "rowdy", "quiet", "swift", "copper", "hazy", "wild", "little",
];
const HANDLE_SECOND = [
  "heron", "otter", "fox", "moth", "comet", "ember", "willow", "harbor",
  "meadow", "lantern", "echo", "tide", "drift", "orbit", "prism", "canyon",
  "thistle", "badger", "falcon", "marlin", "sparrow", "juniper", "quartz",
];

function pick(list) {
  return list[crypto.getRandomValues(new Uint32Array(1))[0] % list.length];
}

// Free everywhere it has to be free: this database's two namespaces and the
// broker's, which hands out names to Macs and knows nothing about people.
//
// `forEmail` is the person asking, and it matters. A name is not taken from
// somebody by their own group: a solo DJ running @shokunin IS Shokunin, and
// telling them their own address belongs to someone else is the system failing
// to notice they are the same person. Called without an email - minting a name
// out of nothing - the check is strict, because an invented name must not land
// on anybody.
async function handleFree(env, handle, forEmail) {
  if (handleProblem(handle)) return false;

  const group = await env.DB.prepare(`SELECT id FROM groups WHERE handle = ?`).bind(handle).first();
  if (group) {
    if (!forEmail) return false;
    const yours = await env.DB.prepare(
      `SELECT 1 AS ok FROM group_djs gd JOIN djs d ON d.id = gd.dj_id
        WHERE gd.group_id = ? AND d.email_norm = ?`
    ).bind(group.id, forEmail).first();
    // Already reserved in the broker keyspace when the group claimed it, and
    // reserved by this same person, so there is nothing further to ask.
    return !!yours;
  }

  const person = await env.DB.prepare(
    `SELECT email_norm FROM profiles WHERE handle = ?`
  ).bind(handle).first();
  if (person) return !!forEmail && person.email_norm === forEmail;

  return claimHandle(env, handle);
}

// The name somebody already answers to. Minting `rowdyheron` for a DJ whose
// group is @shokunin is the product introducing them to themselves under a
// different name; when they run exactly one group, that group's handle is the
// address they already hand out and already own.
async function ownHandleFor(env, emailNorm) {
  const { results } = await env.DB.prepare(
    `SELECT g.handle FROM groups g
       JOIN group_djs gd ON gd.group_id = g.id
       JOIN djs d ON d.id = gd.dj_id
      WHERE d.email_norm = ? ORDER BY g.created_ms LIMIT 2`
  ).bind(emailNorm).all();
  // Two groups is two answers, and guessing between them is worse than an
  // invented name nobody has seen.
  return (results || []).length === 1 ? results[0].handle : "";
}

async function mintHandle(env) {
  for (let attempt = 0; attempt < 12; attempt++) {
    // Two words first, and only then a number: "neonfox" is a name somebody
    // might keep, "neonfox4817" is one they will certainly replace.
    const suffix = attempt < 4 ? "" : String(10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 89));
    const candidate = `${pick(HANDLE_FIRST)}${pick(HANDLE_SECOND)}${suffix}`.slice(0, 30);
    if (await handleFree(env, candidate)) return candidate;
  }
  return `guest${randomHex(4)}`;
}

function parseLinks(raw) {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" ? value : {};
  } catch (e) {
    return {};
  }
}

// The links that belong with a night - tickets, the set, a map pin - typed one
// per line. A bare URL is its own label; "Tickets | https://..." names it.
// Anything that is not http(s) is dropped rather than rendered: a link nobody
// can click is worse than no link, and a javascript: one is worse than that.
function partyLinks(raw) {
  const out = [];
  for (const line of String(raw || "").split("\n")) {
    const text = line.trim();
    if (!text) continue;
    const bar = text.indexOf("|");
    const label = bar > 0 ? text.slice(0, bar).trim().slice(0, 60) : "";
    const href = (bar > 0 ? text.slice(bar + 1) : text).trim();
    if (!/^https?:\/\/[^\s"'<>]+$/i.test(href)) continue;
    out.push({
      href,
      label: label || href.replace(/^https?:\/\//i, "").replace(/\/$/, ""),
    });
    if (out.length >= 12) break;
  }
  return out;
}

// "Playing right now", answered by a heartbeat rather than by a flag. The Mac
// syncs the party's timeline every twenty seconds for as long as it is live, so
// a room that stopped - crashed, closed the lid, went home - stops being live
// here by itself within a minute and a half. A flag would still be saying
// "listen now" the next morning, which is the false-live bug in a new place.
const LIVE_FOR = 90 * 1000;
function liveNow(event, now) {
  return !!event && Number(event.live_ms || 0) > now - LIVE_FOR &&
    /^https:\/\//.test(String(event.live_url || ""));
}

// The one identity, read or created. Creating it here rather than at sign-up
// means every person who already existed gets one the first time they are
// looked at, with no backfill to run and nothing to miss.
async function profileFor(env, emailNorm, now, fallbackName) {
  if (!emailNorm) return null;
  let row = await env.DB.prepare(`SELECT * FROM profiles WHERE email_norm = ?`)
    .bind(emailNorm).first();
  if (!row) {
    // Whatever Apple or Google already told us, wherever it landed. Seeding
    // this only on the page that happens to create the row leaves anybody who
    // arrives by another route anonymous for no reason.
    let name = String(fallbackName || "").slice(0, 60);
    if (!name) {
      const known = await env.DB.prepare(
        `SELECT name FROM djs WHERE email_norm = ? AND name != ''
         UNION ALL SELECT name FROM members WHERE email_norm = ? AND name != '' LIMIT 1`
      ).bind(emailNorm, emailNorm).first();
      name = (known && known.name) || "";
    }
    await env.DB.prepare(
      `INSERT OR IGNORE INTO profiles (email_norm, name, created_ms, updated_ms)
       VALUES (?, ?, ?, ?)`
    ).bind(emailNorm, name, now, now).run();
    row = await env.DB.prepare(`SELECT * FROM profiles WHERE email_norm = ?`)
      .bind(emailNorm).first();
  }
  // The @name. Their own group's if they run one, an invented pair of words if
  // they do not - and an invented one is replaced by their group's if a group
  // turns up later, right up until they save the profile themselves. After
  // that the name is theirs and nothing here touches it: `saved_ms` is the line
  // between a name we guessed and a name they chose.
  if (row && (!row.handle || !row.saved_ms)) {
    const own = await ownHandleFor(env, emailNorm);
    const wanted = own || row.handle || await mintHandle(env);
    if (wanted !== row.handle) {
      try {
        await env.DB.prepare(`UPDATE profiles SET handle = ?, updated_ms = ? WHERE email_norm = ?`)
          .bind(wanted, now, emailNorm).run();
        await reserveHandle(env, wanted);
        row.handle = wanted;
      } catch (e) {
        // Lost the race to another request for the same person. Whatever the
        // other one wrote is just as good a name as this one.
        row = await env.DB.prepare(`SELECT * FROM profiles WHERE email_norm = ?`)
          .bind(emailNorm).first();
      }
    }
  }
  if (row) row.linksObj = parseLinks(row.links);
  return row;
}

async function profileByHandle(env, handle) {
  const row = await env.DB.prepare(`SELECT * FROM profiles WHERE handle = ?`).bind(handle).first();
  if (row) row.linksObj = parseLinks(row.links);
  return row;
}

// Profiles for a set of addresses, in one query. The participants rail asks for
// a dozen at a time and a query each would be a dozen round trips.
async function profilesFor(env, emails) {
  const list = [...new Set((emails || []).filter(Boolean))];
  if (!list.length) return new Map();
  const { results } = await env.DB.prepare(
    `SELECT * FROM profiles WHERE email_norm IN (${list.map(() => "?").join(",")})`
  ).bind(...list).all();
  const map = new Map();
  for (const row of results || []) {
    row.linksObj = parseLinks(row.links);
    map.set(row.email_norm, row);
  }
  return map;
}

// A social handle, however it was pasted. People paste the whole URL as often
// as the name, and rejecting either one is a form that argues with you.
function socialName(raw) {
  let value = String(raw || "").trim();
  if (!value) return "";
  value = value.replace(/^https?:\/\/(www\.)?[^/]+\//i, "").replace(/^@/, "");
  return value.split(/[/?#]/)[0].slice(0, 40);
}

function websiteUrl(raw) {
  const value = String(raw || "").trim().slice(0, 200);
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/i.test(value) ? `https://${value}` : "";
}

const SOCIAL_FIELDS = [
  { key: "instagram", label: "Instagram", place: "@username", prefix: "https://instagram.com/" },
  { key: "soundcloud", label: "SoundCloud", place: "@username", prefix: "https://soundcloud.com/" },
  { key: "website", label: "Website", place: "yoursite.com", prefix: "" },
];

function linkHref(key, value) {
  if (!value) return "";
  if (key === "website") return websiteUrl(value);
  const field = SOCIAL_FIELDS.find((f) => f.key === key);
  return field ? field.prefix + encodeURIComponent(value) : "";
}

// ------------------------------------------------------------- the record
//
// Who I saw, and what I thought. All of it belongs to one person: every query
// here is scoped by the owner's verified address, and none of it is ever
// rendered on a page somebody else can open.

// My parties: the ones I run, and the ones I have kept a note or an encounter
// against. Recording that I went to somebody else's night is exactly as valid
// as throwing one, so both belong on the same shelf.
async function myParties(env, emailNorm) {
  const { results } = await env.DB.prepare(
    `SELECT e.*, g.handle, g.name AS group_name,
            n.attended AS attended, n.note AS my_note,
            (SELECT COUNT(*) FROM songs sg WHERE sg.event_id = e.id) AS song_count,
            (SELECT GROUP_CONCAT(p.name, ', ') FROM party_people pp
               JOIN people p ON p.id = pp.person_id
              WHERE pp.event_id = e.id AND pp.owner_email = ? AND pp.role = 'dj') AS bill
       FROM events e
       JOIN groups g ON g.id = e.group_id
       LEFT JOIN party_notes n ON n.event_id = e.id AND n.owner_email = ?
      WHERE e.state != 'draft' AND (
        e.owner_email = ?
        OR n.event_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM party_people pp
                    WHERE pp.event_id = e.id AND pp.owner_email = ?))
      ORDER BY COALESCE(e.starts_ms, e.created_ms) DESC
      LIMIT 200`
  ).bind(emailNorm, emailNorm, emailNorm, emailNorm).all();
  return results || [];
}

// Where a party is in its own life, decided by the clock rather than by a field
// somebody has to remember to change. A party with no date yet is upcoming: it
// has not happened. Six hours is a night - a party that started at eleven is
// still on at three, and is over by lunchtime.
//
// This is deliberately separate from whether a Mac is broadcasting: "the party
// is on tonight" and "there is music coming out of it right now" are different
// facts, and a party with no Mac in the room is still a party.
const A_NIGHT = 6 * 60 * 60 * 1000;
function partyPhase(event, now) {
  if (!event.starts_ms) return "upcoming";
  if (event.starts_ms > now) return "upcoming";
  return event.starts_ms < now - A_NIGHT ? "past" : "now";
}

function partyIsPast(event, now) {
  return partyPhase(event, now) === "past";
}

async function peopleFor(env, emailNorm, query) {
  const like = `%${String(query || "").trim().toLowerCase()}%`;
  const { results } = await env.DB.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM party_people pp WHERE pp.person_id = p.id) AS times,
            (SELECT e.title FROM party_people pp JOIN events e ON e.id = pp.event_id
              WHERE pp.person_id = p.id
              ORDER BY COALESCE(e.starts_ms, e.created_ms) DESC LIMIT 1) AS last_at,
            (SELECT COALESCE(e.starts_ms, e.created_ms) FROM party_people pp
               JOIN events e ON e.id = pp.event_id WHERE pp.person_id = p.id
              ORDER BY COALESCE(e.starts_ms, e.created_ms) DESC LIMIT 1) AS last_ms
       FROM people p
      WHERE p.owner_email = ? AND (? = '%%' OR lower(p.name) LIKE ?)
      ORDER BY p.name LIMIT 200`
  ).bind(emailNorm, like, like).all();
  return results || [];
}

// One person, by name, reused rather than duplicated. Typing "Seth" twice must
// not produce two Seths, or their history splits in half and the point of
// keeping it is lost.
async function personByName(env, emailNorm, name) {
  return env.DB.prepare(
    `SELECT * FROM people WHERE owner_email = ? AND lower(name) = lower(?)`
  ).bind(emailNorm, String(name || "").trim()).first();
}

async function findOrMakePerson(env, emailNorm, name, now) {
  const clean = String(name || "").trim().slice(0, 80);
  if (!clean) return null;
  const already = await personByName(env, emailNorm, clean);
  if (already) return already;
  const id = ulid(now);
  await env.DB.prepare(
    `INSERT INTO people (id, owner_email, name, created_ms, updated_ms) VALUES (?,?,?,?,?)`
  ).bind(id, emailNorm, clean, now, now).run();
  return env.DB.prepare(`SELECT * FROM people WHERE id = ?`).bind(id).first();
}

// Everyone recorded at one party, with the note I wrote about each of them
// THERE. DJs first, because that is what the night was.
async function partyPeople(env, emailNorm, eventId) {
  const { results } = await env.DB.prepare(
    `SELECT pp.role, pp.note, pp.created_ms, p.id, p.name, p.account_email
       FROM party_people pp JOIN people p ON p.id = pp.person_id
      WHERE pp.event_id = ? AND pp.owner_email = ?
      ORDER BY CASE pp.role WHEN 'dj' THEN 0 ELSE 1 END, p.name`
  ).bind(eventId, emailNorm).all();
  return results || [];
}

// One person's history: every night I recorded them at, newest first, each with
// the note from that night.
async function personHistory(env, emailNorm, personId) {
  const { results } = await env.DB.prepare(
    `SELECT pp.role, pp.note, e.id, e.slug, e.title, e.starts_ms, e.place, e.day_only, g.handle
       FROM party_people pp
       JOIN events e ON e.id = pp.event_id
       JOIN groups g ON g.id = e.group_id
      WHERE pp.person_id = ? AND pp.owner_email = ?
      ORDER BY COALESCE(e.starts_ms, e.created_ms) DESC`
  ).bind(personId, emailNorm).all();
  return results || [];
}

async function myPartyNote(env, emailNorm, eventId) {
  return env.DB.prepare(
    `SELECT * FROM party_notes WHERE event_id = ? AND owner_email = ?`
  ).bind(eventId, emailNorm).first();
}

async function setPartyNote(env, emailNorm, eventId, fields, now) {
  const existing = await myPartyNote(env, emailNorm, eventId);
  const note = fields.note === undefined
    ? (existing ? existing.note : "") : String(fields.note || "").slice(0, 4000);
  const attended = fields.attended === undefined
    ? (existing ? existing.attended : null) : fields.attended;
  await env.DB.prepare(
    `INSERT INTO party_notes (event_id, owner_email, note, attended, updated_ms)
     VALUES (?,?,?,?,?)
     ON CONFLICT(event_id, owner_email) DO UPDATE SET
       note = excluded.note, attended = excluded.attended, updated_ms = excluded.updated_ms`
  ).bind(eventId, emailNorm, note, attended, now).run();
}

// -------------------------------------------------------------------- media

// Pictures live in the broker's bucket under their own prefix, served back
// through /media/. Stored as they arrive: a Worker has no image pipeline, and
// a cap plus knowing what the bytes actually are is the honest version of one.
const MAX_AVATAR = 8 << 20;
const MAX_COVER = 15 << 20;

// What a file IS, not what it says it is. The declared type is whatever the
// client felt like sending - plenty of real tools upload a perfectly good
// image as application/octet-stream, and anything at all can claim image/png.
// Reading the first few bytes answers both, and the answer is what gets served
// back later, so a stored object can never carry a type its bytes contradict.
function sniffMedia(bytes) {
  const head = new Uint8Array(bytes, 0, Math.min(16, bytes.byteLength));
  const at = (offset, ...values) => values.every((v, i) => head[offset + i] === v);
  const ascii = (offset, text) => [...text].every((c, i) => head[offset + i] === c.charCodeAt(0));

  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF8")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(4, "ftyp")) {
    // One container, several things inside it. The brand says which.
    const brand = String.fromCharCode(head[8], head[9], head[10], head[11]);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (["heic", "heix", "hevc", "mif1", "msf1"].includes(brand)) return "image/heic";
    if (["mp42", "mp41", "isom", "iso2", "avc1", "qt  "].includes(brand)) return "video/mp4";
  }
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return "video/webm";
  return "";
}

// A stored key becomes a URL exactly once.
//
// The pile writes "/media/covers/x.webp" and an upload writes "covers/<hex>",
// and this used to prefix both - so every SHUFFLED cover rendered
// /media//media/covers/x.webp and 404ed while uploaded ones worked, which
// looked like the feature was randomly broken. Anything already absolute is
// already a URL.
function mediaUrl(key) {
  if (!key) return "";
  return /^(https?:)?\/\//.test(key) || key.startsWith("/") ? key : `/media/${key}`;
}

// The bundled pile, the same pictures the Mac shuffles through, published to
// R2 by scripts/publish-covers.sh. Kept as bare names so the list is readable
// and one place decides where they are served from.
const COVER_PILE = [
  "amber-festival", "arcade-afterhours", "arena-beams", "ballroom-dance",
  "band-stage", "basement-house", "beach-dusk", "block-party", "blue-wash",
  "boat-deck", "brass-section", "cabin-party", "club-lights", "community-hall",
  "concert", "crowd-surfer", "crowd", "dance", "dancefloor", "decks",
  "desert-dusk", "disco-ceiling", "dj-booth", "dj-close", "emerald-crowd",
  "festival-tent", "garden-day", "golden-crowd", "haze-screens",
  "kitchen-dance", "lanterns", "laser-warehouse", "led-canopy",
  "midnight-stage", "open-air-blue", "pedalboard", "phone-glow",
  "poolside-night", "record-store", "roller-disco", "rooftop-sunrise",
  "rooftop", "soundcheck", "streamers", "tiny-club", "tunnel-party",
  "turntable", "vinyl-loft", "warehouse",
];

function coverPileUrl(name) {
  return `covers/${name}.webp`;
}

async function storeMedia(env, file, prefix, maxBytes, allowVideo) {
  if (!env.DL || !file || typeof file.arrayBuffer !== "function") return { error: "no file" };
  if (Number(file.size) > maxBytes) return { error: "that file is too big" };
  const bytes = await file.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > maxBytes) return { error: "that file is too big" };
  const type = sniffMedia(bytes);
  if (!type) return { error: "that is not a picture we can use" };
  if (!allowVideo && type.startsWith("video/")) return { error: "that needs to be a picture" };
  const key = `${prefix}/${randomHex(16)}`;
  await env.DL.put(`media/${key}`, bytes, { httpMetadata: { contentType: type } });
  return { key, type };
}

// Pro is on when EITHER store says so. Asking one of them alone is how a DJ
// who paid on the web ends up being charged a fee in the app.
async function isPro(env, groupId) {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM entitlements WHERE group_id = ? AND state = 'active' LIMIT 1`
  ).bind(groupId).first();
  return !!row;
}

async function takeRateFor(env, groupId) {
  return await isPro(env, groupId) ? 0 : TICKET_TAKE;
}

// What this visitor is to this group. Cheap, and it is what stops the page
// asking a DJ for their own name.
async function viewerOf(env, request, group, now) {
  const dj = await currentDJ(env, request, now);
  if (!dj) return null;
  const runs = await env.DB.prepare(
    `SELECT 1 AS ok FROM group_djs WHERE group_id = ? AND dj_id = ?`
  ).bind(group.id, dj.id).first();
  if (runs) return { dj, runsThisGroup: true };
  const follows = await env.DB.prepare(
    `SELECT 1 AS ok FROM group_members gm JOIN members m ON m.id = gm.member_id
      WHERE gm.group_id = ? AND m.email_norm = ? AND gm.state = 'joined'`
  ).bind(group.id, dj.email_norm).first();
  return { dj, runsThisGroup: false, follows: !!follows };
}

async function djRunsGroup(env, dj, groupId) {
  if (!dj) return false;
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM group_djs WHERE group_id = ? AND dj_id = ?`
  ).bind(groupId, dj.id).first();
  return !!row;
}

// Creating a party. ONE implementation, called by the web form and by the Mac.
//
// The Mac is a full client, not a broadcast utility: a party it makes is the
// same row, with the same validation and the same defaults, as one made in a
// browser. Two creation paths would drift on the first field either side added,
// and the Mac's copy would quietly become a lesser kind of party.
//
// Everything the caller does not supply is left alone rather than invented -
// the Mac fills in what it genuinely knows (who is playing, when it started)
// and nothing else.
async function createParty(env, group, fields, now) {
  const title = String(fields.title || "").slice(0, 120).trim();
  if (!title) return { error: "a party needs a name" };

  const startsMs = Number.isFinite(fields.startsMs) ? Number(fields.startsMs) : null;
  const capacity = Math.max(0, Math.min(100000, parseInt(String(fields.capacity || "0"), 10) || 0));
  const slug = slugify(title, now);
  const id = ulid(now);

  // A group can only hold one party per slug, and two parties named the same
  // thing on one day is an ordinary accident rather than an error worth
  // stopping for.
  let unique = slug;
  for (let n = 2; n < 40; n++) {
    const clash = await env.DB.prepare(
      `SELECT 1 AS ok FROM events WHERE group_id = ? AND slug = ?`
    ).bind(group.id, unique).first();
    if (!clash) break;
    unique = `${slug}-${n}`;
  }

  // Whose party it is, on the party. Groups are dead; the group_id below is
  // still written only so this is reversible by deploying the previous worker.
  const ownerEmail = String(fields.ownerEmail || "");
  // Private, because a journal entry is. The exception is a party opened with a
  // live room already on it: that is a night being played to people who are
  // about to be handed its link, and starting it invisible would mean the DJ
  // has to go and turn it on before anybody can see where they are.
  const visibility = fields.visibility ||
    (PARTY_ID_RE.test(String(fields.partyId || "")) ? "link" : "private");
  await env.DB.prepare(
    `INSERT INTO events (id, group_id, owner_email, slug, title, starts_ms, place, capacity,
       cover_key, state, party_id, links, visibility, created_ms, updated_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'announced', ?, ?, ?, ?, ?)`
  ).bind(id, group.id, ownerEmail, unique, title, startsMs,
    String(fields.place || "").slice(0, 120), capacity,
    fields.coverKey || null, String(fields.partyId || ""),
    String(fields.links || "").slice(0, 2000), visibility, now, now).run();

  return { id, slug: unique, title, startsMs, handle: group.handle };
}

// Editing one, from either client. Only the fields actually supplied move, so
// the Mac writing a start time cannot blank a place typed on the web.
async function updateParty(env, event, fields, now) {
  const sets = [];
  const args = [];
  if (fields.title !== undefined) {
    const title = String(fields.title || "").slice(0, 120).trim();
    if (!title) return { error: "a party needs a name" };
    sets.push("title = ?");
    args.push(title);
  }
  if (fields.startsMs !== undefined) {
    sets.push("starts_ms = ?");
    args.push(Number.isFinite(fields.startsMs) ? Number(fields.startsMs) : null);
  }
  if (fields.place !== undefined) {
    sets.push("place = ?");
    args.push(String(fields.place || "").slice(0, 120));
  }
  if (fields.coverKey !== undefined) {
    sets.push("cover_key = ?");
    args.push(fields.coverKey || null);
  }
  if (fields.links !== undefined) {
    sets.push("links = ?");
    args.push(String(fields.links || "").slice(0, 2000));
  }
  if (fields.state !== undefined && ["announced", "live", "over"].includes(fields.state)) {
    sets.push("state = ?");
    args.push(fields.state);
  }
  if (!sets.length) return { ok: true };
  // Every change bumps the calendar sequence, or a subscribed calendar keeps
  // showing the old time forever.
  sets.push("ics_seq = ics_seq + 1", "updated_ms = ?");
  args.push(now, event.id);
  await env.DB.prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = ?`).bind(...args).run();
  return { ok: true };
}

// A party in the shape the Mac reads. Same row the web renders, minus nothing
// the console needs and plus the two links it hands to guests.
// A live room belongs to one party at a time.
//
// The Mac's room id is stable for the night, so moving from one party to
// another left BOTH claiming it - and the post sync finds an event by room id,
// so which party the photos landed on became a coin toss. Attaching releases
// wherever it was before.
async function attachRoom(env, groupId, eventId, partyId, now) {
  if (!PARTY_ID_RE.test(String(partyId || ""))) return;
  await env.DB.prepare(
    `UPDATE events SET party_id = '', updated_ms = ?
      WHERE group_id = ? AND party_id = ? AND id != ?`
  ).bind(now, groupId, partyId, eventId).run();
  await env.DB.prepare(
    `UPDATE events SET party_id = ?, updated_ms = ? WHERE id = ?`
  ).bind(partyId, now, eventId).run();
}

function partyForMac(event, group, base) {
  if (!event) return null;
  return {
    key: event.id,
    slug: event.slug,
    title: event.title || "",
    startsMs: event.starts_ms || 0,
    place: event.place || "",
    coverUrl: mediaUrl(event.cover_key),
    state: event.state,
    partyId: event.party_id || "",
    links: event.links || "",
    url: `${base}/@${group.handle}/${event.slug}`,
    handle: group.handle,
  };
}

// Whose Mac this is. The install is bound to a PERSON, so this is the whole of
// "who is asking" - no group in the middle, and no question for the DJ to
// answer at sign-in beyond which account they are.
async function installOwner(env, installId) {
  const link = await env.DB.prepare(
    `SELECT email_norm FROM install_accounts WHERE install_id = ?`
  ).bind(String(installId || "")).first();
  if (!link) return null;
  return env.DB.prepare(`SELECT * FROM djs WHERE email_norm = ?`)
    .bind(link.email_norm).first();
}

// Where this Mac's parties go. A party needs an address, so it needs a group -
// but that is this code's problem to solve, not something to interrupt a DJ
// about. Resolved from the account and made from their @name if they have none,
// exactly as the web does when somebody adds their first party.
async function installGroup(env, installId, now) {
  const dj = await installOwner(env, installId);
  if (!dj) return null;
  return homeGroupFor(env, dj, now);
}

// Where a person's own parties live. Everybody who signs in gets one, made on
// demand from their @name, so adding a party never begins with "first create a
// group" - a concept the personal tracker does not need them to hold.
async function homeGroupFor(env, dj, now) {
  const profile = await profileFor(env, dj.email_norm, now, dj.name);
  // The one at their own @name is home, whenever it exists. Plain
  // oldest-first put somebody whose first group was a side project - "early
  // testers", made once and forgotten - into that side project every time
  // they added a party, which is the wrong place and reads as a bug.
  const existing = await env.DB.prepare(
    `SELECT g.* FROM groups g JOIN group_djs d ON d.group_id = g.id
      WHERE d.dj_id = ?
      ORDER BY CASE WHEN g.handle = ? THEN 0 ELSE 1 END, g.created_ms LIMIT 1`
  ).bind(dj.id, profile.handle).first();
  if (existing) return existing;
  let made = await createGroup(env, dj, profile.handle, profile.name || profile.handle, now);
  if (made.error) {
    // Their @name is somehow unusable as a group name. Mint a fresh one rather
    // than making them solve it before they can write anything down.
    made = await createGroup(env, dj, await mintHandle(env), profile.name || "My parties", now);
  }
  if (made.error) return null;
  return env.DB.prepare(`SELECT * FROM groups WHERE id = ?`).bind(made.id).first();
}

// Adding a party: a name, and everything else optional. Somebody standing
// outside a club typing this on a phone will not fill in six fields.
function newPartyPage(group, state, form, today, lastPlace) {
  const was = (name) => esc((form && form.get(name)) || "");
  return page("Add a party", `
    <h1>Add a party</h1>
    <p class="muted">Today, and where you were last, are already in. Only the
    name is needed - fill the rest in whenever, or never.</p>
    ${state.error ? `<p class="formerror" role="alert">${esc(state.error)}</p>` : ""}
    <form class="newnight" method="post" action="/parties/new">
      <label class="eventfield"><span>What is it called?</span>
        <input type="text" name="title" maxlength="120" required autofocus
          value="${was("title")}" placeholder="Warehouse, late"></label>
      <label class="eventfield"><span>When</span>
        <input type="date" name="day" value="${was("day") || esc(today)}"></label>
      <label class="eventfield"><span>Where</span>
        <input type="text" name="place" maxlength="120"
          value="${was("place") || esc(lastPlace || "")}"
          placeholder="Unit 7, or a friend's kitchen"></label>
      <label class="eventfield"><span>Who is playing</span>
        <input type="text" name="dj" maxlength="200" value="${was("dj")}"
          placeholder="Seth, and anyone else - separate with commas"></label>
      <button class="btn" type="submit">Add it</button>
    </form>
    <p class="muted"><a href="/home">Back to your parties</a></p>
  `, "", "", true);
}

// Today, as a date field wants it.
function todayISO(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function slugify(title, now) {
  const base = String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 40);
  return SLUG_RE.test(base) ? base : `night-${new Date(now).toISOString().slice(0, 10)}`;
}

// Who should hear about this night, and who should not. Three separate ways a
// person can be spared, all of them theirs rather than the DJ's: they left,
// they turned the volume down, or they blocked this particular person. A fourth
// is platform-wide and lives in queueMail.
async function audienceFor(env, group, djId, wantVolumes) {
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.email_norm FROM group_members gm
       JOIN members m ON m.id = gm.member_id
      WHERE gm.group_id = ? AND gm.state = 'joined'
        AND gm.volume IN (${wantVolumes.map(() => "?").join(",")})
        AND m.suppressed_ms IS NULL
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.member_id = m.id AND b.dj_id = ?)`
  ).bind(group.id, ...wantVolumes, djId || "").all();
  return results || [];
}

// One send per member per event, ever. The ledger is the outbox itself: a
// reminder that runs twice because a cron overlapped is the fastest way to
// teach people to unsubscribe.
async function alreadySent(env, kind, eventId, email) {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM outbox WHERE kind = ? AND event_id = ? AND to_email = ?`
  ).bind(kind, eventId, email).first();
  return !!row;
}

async function sendInvites(env, group, event, dj, base, now) {
  const audience = await audienceFor(env, group, dj && dj.id, ["all", "events"]);
  let sent = 0;
  for (const member of audience) {
    if (await alreadySent(env, "invite", event.id, member.email_norm)) continue;
    const going = await mintToken(env, {
      memberId: member.id, groupId: group.id, eventId: event.id, purpose: "going", now,
    });
    const manage = await mintToken(env, { memberId: member.id, groupId: group.id, purpose: "manage", now });
    const queued = await queueMail(env, {
      to: member.email_norm,
      subject: `${group.name || group.handle}: ${event.title || "a night"}`,
      text: `${whenText(event)}\n${[event.place, event.address].filter(Boolean).join("\n")}\n\n`
        + `${event.description ? event.description + "\n\n" : ""}`
        + `Coming? ${base}/g/${going}\n`
        + `Can't make it: ${base}/g/${going}?no=1\n\n`
        + `The night: ${base}/@${group.handle}/${event.slug}\n`
        + `Add to your calendar: ${base}/@${group.handle}/${event.slug}.ics\n\n`
        + `Fewer emails, or leave: ${base}/m/${manage}`,
      kind: "invite",
      groupId: group.id,
      eventId: event.id,
      ics: `${base}/@${group.handle}/${event.slug}.ics`,
      unsubscribe: `${base}/m/${manage}?stop=1`,
      now,
    });
    if (queued) sent++;
  }
  return sent;
}

// The group's own thread. Whoever writes it is identified by the link they
// already hold - a member by their settings token, a DJ by their session - so
// taking part still needs no account.
async function addPost(env, { group, event, dj, member, body, mediaKey, mediaType, base, now }) {
  const text = String(body || "").trim().slice(0, 2000);
  // A picture on its own is a post. At a party most of them are.
  if (!text && !mediaKey) return 0;
  const author = dj ? (dj.name || "The DJ") : (member && member.name) || "Someone";
  await env.DB.prepare(
    `INSERT INTO posts (id, group_id, event_id, member_id, dj_id, author, body, media_key, media_type, origin, created_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'web', ?)`
  ).bind(ulid(now), group.id, event ? event.id : null,
    member ? member.id : null, dj ? dj.id : null, author, text,
    mediaKey || null, mediaType || null, now).run();
  if (!text) return 0;

  // Only the people who asked for every post. This is the whole difference
  // between a group here and a group chat: the volume is theirs, not the
  // poster's, so a busy thread cannot colonise anybody's phone.
  const audience = await audienceFor(env, group, dj && dj.id, ["all"]);
  let mailed = 0;
  for (const person of audience) {
    if (member && person.id === member.id) continue;
    const manage = await mintToken(env, { memberId: person.id, groupId: group.id, purpose: "manage", now });
    const queued = await queueMail(env, {
      to: person.email_norm,
      subject: `${group.name || group.handle}: ${author} posted`,
      text: `${text}\n\n${base}/@${group.handle}\n\nFewer emails: ${base}/m/${manage}`,
      kind: "note",
      groupId: group.id,
      unsubscribe: `${base}/m/${manage}?stop=1`,
      now,
    });
    if (queued) mailed++;
  }
  return mailed;
}

// Who is in this group, as people rather than rows: their picture, the name
// they chose and the @name they can be found at. The DJs come first because
// they are the reason anybody else is here.
async function groupPeople(env, groupId) {
  const { results } = await env.DB.prepare(
    // The union is wrapped because a compound SELECT can only be ordered by a
    // plain result column, and the ordering here is an expression.
    `SELECT * FROM (
       SELECT m.name AS name, m.email_norm AS email_norm, 'follower' AS role,
              gm.joined_ms AS since
         FROM group_members gm JOIN members m ON m.id = gm.member_id
        WHERE gm.group_id = ? AND gm.state = 'joined'
       UNION ALL
       SELECT d.name AS name, d.email_norm AS email_norm, gd.role AS role,
              gd.created_ms AS since
         FROM group_djs gd JOIN djs d ON d.id = gd.dj_id
        WHERE gd.group_id = ?
     )
     ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'host' THEN 1 ELSE 2 END, since DESC
     LIMIT 60`
  ).bind(groupId, groupId).all();

  const rows = results || [];
  const profiles = await profilesFor(env, rows.map((r) => r.email_norm));
  const seen = new Set();
  const people = [];
  for (const row of rows) {
    // A DJ who also follows their own group is one person on this list.
    if (seen.has(row.email_norm)) continue;
    seen.add(row.email_norm);
    const profile = profiles.get(row.email_norm);
    people.push({
      name: (profile && profile.name) || row.name || "",
      handle: (profile && profile.handle) || "",
      avatar_key: (profile && profile.avatar_key) || null,
      role: row.role,
    });
  }
  return people;
}

// The feed, with the people on it. The author column is what somebody was
// called when they wrote it; the profile is who they are now, and the live one
// wins on screen so a person who fills in their name does not have to look at
// thirty posts signed "Someone".
// Everything said and shown at one party. Posts used to hang off a group
// thread; they belong to the night they happened at, which is where the photos
// were always going to be looked for.
async function eventPosts(env, eventId) {
  const { results } = await env.DB.prepare(
    `SELECT p.*,
            COALESCE(pd.name, pm.name) AS profile_name,
            COALESCE(pd.handle, pm.handle) AS handle,
            COALESCE(pd.avatar_key, pm.avatar_key) AS avatar_key
       FROM posts p
       LEFT JOIN members m ON m.id = p.member_id
       LEFT JOIN djs d ON d.id = p.dj_id
       LEFT JOIN profiles pm ON pm.email_norm = m.email_norm
       LEFT JOIN profiles pd ON pd.email_norm = d.email_norm
      WHERE p.event_id = ? AND p.deleted_ms IS NULL
      ORDER BY p.created_ms DESC LIMIT 200`
  ).bind(eventId).all();
  return results || [];
}

function agoText(ms) {
  const seconds = Math.max(0, Math.round((Date.now() - Number(ms || 0)) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(Number(ms)).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// A night, as pictures first. The photos become a grid you can take in at a
// glance - which is what looking back at a party actually is - and the things
// people wrote stay below as words. A column of full-width images each under
// its own little header is a social feed, and this is not one.
function nightRoll(posts) {
  const shots = posts.filter((p) => p.media_key);
  const said = posts.filter((p) => !p.media_key);
  return `${shots.length ? `<div class="roll">${shots.map((post) => {
    const media = mediaUrl(post.media_key);
    const isVideo = String(post.media_type || "").startsWith("video/");
    return `<figure>${isVideo
      ? `<video src="${esc(media)}" controls playsinline preload="metadata"></video>`
      : `<img src="${esc(media)}" alt="" loading="lazy">`}${
      post.body ? `<figcaption>${esc(post.body)}</figcaption>` : ""}</figure>`;
  }).join("")}</div>` : ""}
  ${said.length ? postList(said) : ""}`;
}

function postList(posts) {
  if (!posts.length) return `<p class="muted">No posts yet!</p>`;
  return posts.map((post) => {
    const name = post.profile_name || post.author || "Someone";
    const media = mediaUrl(post.media_key);
    const isVideo = String(post.media_type || "").startsWith("video/");
    return `<div class="post">
      <div class="posthead">
        ${personDisc({ name, avatar_key: post.avatar_key })}
        <div class="grow">
          <div class="who">${post.handle
            ? `<a href="/@${esc(post.handle)}">${esc(name)}</a>`
            : esc(name)}</div>
          <div class="when">${esc(agoText(post.created_ms))}</div>
        </div>
      </div>
      ${post.body ? `<div>${esc(post.body).replace(/\n/g, "<br>")}</div>` : ""}
      ${media ? (isVideo
        ? `<video class="postmedia" src="${esc(media)}" controls playsinline preload="metadata"></video>`
        : `<img class="postmedia" src="${esc(media)}" alt="" loading="lazy">`) : ""}
    </div>`;
  }).join("");
}

// A tip link is the DJ's own Venmo, Revolut, PayPal or whatever they already
// use. We display it and take nothing: no onboarding, no processor, no holding
// anybody's money. Only https, because the alternatives on a page people tap
// through at a party are all bad.
export function payLinkProblem(url) {
  const value = String(url || "").trim();
  if (!value) return "";
  let parsed;
  try {
    parsed = new URL(value);
  } catch (e) {
    return "that does not look like a link";
  }
  if (parsed.protocol !== "https:") return "the link has to start with https";
  if (value.length > 300) return "that link is too long";
  return "";
}

// An entry code is short because it gets read aloud at a door, and derived
// from the signup rather than stored so it cannot drift from it.
export async function entryCode(eventId, memberId) {
  const digest = await sha256Hex(`pp-entry:${eventId}:${memberId}`);
  let code = "";
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[parseInt(digest.slice(i * 2, i * 2 + 2), 16) % CODE_ALPHABET.length];
  return code;
}

// Capacity is checked at the moment of signing up, and a night that is full
// says so rather than quietly taking one more.
async function spaceLeft(env, event) {
  if (!event.capacity) return Infinity;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM signups WHERE event_id = ? AND state = 'going'`
  ).bind(event.id).first();
  return Math.max(0, event.capacity - Number((row && row.n) || 0));
}

// The door: the two buttons on the left, a room full of people on the right.
//
// The picture is one of the same covers a DJ shuffles through for their own
// nights - the product showing what it is for rather than describing it. Picked
// per request, so the page is a different party each time you arrive.
function signInPage(env, heading, to) {
  const apple = `<svg viewBox="0 0 384 512" aria-hidden="true" fill="currentColor"><path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z"/></svg>`;
  const google = `<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-2.7-.4-4H24v7.3h12.1c-.2 2-1.6 5-4.5 7l-.1.3 6.5 5 .5.1c4.1-3.8 6.6-9.4 6.6-15.7"/><path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.9-5.4c-1.8 1.3-4.3 2.2-7.6 2.2-5.8 0-10.7-3.8-12.5-9.1l-7 5.4C7.9 40.8 15.4 46 24 46"/><path fill="#FBBC05" d="M11.5 28.4c-.5-1.4-.7-2.9-.7-4.4s.3-3 .7-4.4v-.3l-6.8-5.3-.2.1C2.9 17 2 20.4 2 24s.9 7 2.5 10z"/><path fill="#EA4335" d="M24 10.7c4.1 0 6.9 1.8 8.5 3.3l6.2-6C34.9 4.5 29.9 2 24 2 15.4 2 7.9 7.2 4.5 14l7 5.5c1.8-5.3 6.7-9.1 12.5-9.1"/></svg>`;

  // Carry where they were heading through the round trip, so signing in from a
  // Mac's link lands back on that link rather than dumping them on the home
  // page with the thing they were doing forgotten.
  const back = to ? `?to=${encodeURIComponent(to)}` : "";
  const button = (provider, mark, label) => (configured(env, provider)
    ? `<a class="ssobtn" href="/auth/${provider}${back}">${mark}<span>${esc(label)}</span></a>`
    : `<p class="muted">${esc(label)} is not configured yet.</p>`);

  const cover = coverPileUrl(COVER_PILE[
    crypto.getRandomValues(new Uint32Array(1))[0] % COVER_PILE.length]);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="preload" href="/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>
<title>${esc(heading || "Sign in")} · PartyParty</title><style>${STYLE}${DOOR_STYLE}</style></head>
<body class="door">
  <main class="doorleft">
    <div class="doorbox">
      <a class="doorbrand" href="/">PartyParty</a>
      <h1>${esc(heading || "Sign in")}</h1>
      <p class="muted">Only DJs need an account. Guests scan a code and they are in -
      no sign-in, no app, nothing to install.</p>
      <div class="ssorow">
        ${button("apple", apple, "Continue with Apple")}
        ${button("google", google, "Continue with Google")}
      </div>
      <p class="doorfine">We ask Apple and Google for your name and email, and
      nothing else. You can change or clear both afterwards.</p>
    </div>
  </main>
  <aside class="doorart" style="background-image:url('${esc(cover)}')" role="img"
    aria-label="A crowd at a party"></aside>
</body></html>`;
}

// Sending. The stack already speaks SMTP from a Worker (web-kit/worker-smtp.js,
// vendored here as smtp.js) against the shared MXroute mailbox, so there is no
// box, no daemon and no second deploy lane in this path - just this cron.
//
// A small batch per tick on purpose: the cron runs every minute, and a burst of
// hundreds of sequential TLS handshakes is how a shared mailbox gets throttled.
const OUTBOX_BATCH = 20;
const OUTBOX_MAX_TRIES = 5;

async function drainOutbox(env, now) {
  const server = env.AUTH_EMAIL_SERVER && env.AUTH_EMAIL_SERVER.get
    ? await env.AUTH_EMAIL_SERVER.get()
    : String(env.AUTH_EMAIL_SERVER || "");
  if (!server) return { sent: 0, failed: 0, reason: "no mail server configured" };
  // Imported here rather than at the top because it pulls in cloudflare:sockets,
  // which only exists inside a Worker. A static import would make this module
  // unloadable anywhere else - including the tests.
  const { sendSmtp } = await import("./smtp.js");

  const { results } = await env.DB.prepare(
    `SELECT id, to_email, subject, body_text, headers FROM outbox
      WHERE sent_ms IS NULL AND tries < ? ORDER BY created_ms LIMIT ?`
  ).bind(OUTBOX_MAX_TRIES, OUTBOX_BATCH).all();

  let sent = 0, failed = 0;
  for (const message of results || []) {
    let headers = {};
    try { headers = JSON.parse(message.headers || "{}"); } catch (e) {}
    const result = await sendSmtp(server, "PartyParty", message.to_email,
      message.subject, message.body_text, headers);
    if (result.sent) {
      // Marked the moment it lands, so a cron that overlaps its predecessor
      // cannot hand the same message to a second sender.
      await env.DB.prepare(`UPDATE outbox SET sent_ms = ? WHERE id = ?`).bind(now, message.id).run();
      sent++;
    } else {
      await env.DB.prepare(
        `UPDATE outbox SET tries = tries + 1, last_error = ? WHERE id = ?`
      ).bind(String(result.reason || "").slice(0, 300), message.id).run();
      failed++;
    }
  }
  return { sent, failed };
}

// -------------------------------------------------------------------- fetch

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Where links in emails point. Taken from the request unless PUBLIC_BASE
    // says otherwise, which matters twice: locally, where wrangler rewrites the
    // host to match the configured route and every link would otherwise aim at
    // production; and in production, where pinning it means a request arriving
    // on an unexpected host cannot mint links to that host.
    const base = String(env.PUBLIC_BASE || "").replace(/\/$/, "") || `${url.protocol}//${url.host}`;
    const now = Date.now();
    const path = decodeURIComponent(url.pathname);

    // HTTPS only. Every emailed link carries a single-use token IN THE PATH, so
    // a plaintext request hands that token to anything on the wire - and the
    // webcal:// scheme resolves to http://, which is why subscribing to a
    // calendar warned about an insecure connection. Redirect first, then HSTS
    // so a browser never tries plaintext here again. No includeSubDomains: the
    // machine hostnames under this zone are the Mac's business, and one of them
    // is deliberately plain HTTP when a venue has no way to validate a cert.
    if (url.protocol !== "https:") {
      url.protocol = "https:";
      return new Response(null, { status: 301, headers: { location: url.toString() } });
    }

    // Is the platform worker up. On /api/v1/ because that prefix is routed to
    // this worker; the old /__pp/app-health was inside the SITE worker's
    // namespace and had no route of its own, so it had never once answered on
    // the real domain - a health check that only works locally is worse than
    // none, because it reports health for something nobody is asking about.
    if (path === "/api/v1/health") return json(200, { ok: true });

    // Pictures. Immutable: every key is random and a new upload is a new key,
    // so this can be cached hard and a changed photo still appears at once.
    if (path.startsWith("/media/")) {
      const key = path.slice("/media/".length);
      if (!key || key.includes("..") || !/^[a-z0-9/_.-]+$/i.test(key)) {
        return new Response("Not Found", { status: 404 });
      }
      if (!env.DL) return new Response("Not Found", { status: 404 });
      const object = await env.DL.get(`media/${key}`);
      if (!object) return new Response("Not Found", { status: 404 });
      return new Response(object.body, {
        headers: {
          "content-type": (object.httpMetadata && object.httpMetadata.contentType) || "image/jpeg",
          "cache-control": "public, max-age=31536000, immutable",
          "strict-transport-security": HSTS,
        },
      });
    }

    // Flush now rather than on the next minute. Used to prove sending works
    // right after a deploy; guarded by the same key the sender used to hold.
    if (path === "/api/v1/outbox/flush" && request.method === "POST") {
      const body = await readJson(request, 2048);
      if (!env.OUTBOX_KEY || !body || body.key !== env.OUTBOX_KEY) return json(403, { error: "no" });
      return json(200, await drainOutbox(env, now));
    }

    // ---- local development only --------------------------------------------
    // Two doors that would be a total compromise in production: signing in as
    // anybody, and reading everyone's mail. Both are shut unless DEV_LOGIN is
    // set, which only ever happens in .dev.vars - a file wrangler reads for
    // `wrangler dev` and never uploads. There is no way to set it by accident
    // on a deploy, and the tests assert both routes 404 without it.
    if (path === "/dev/signin" && env.DEV_LOGIN === "1") {
      const emailNorm = normalizeEmail(url.searchParams.get("email") || "dj@example.com");
      if (!emailNorm) return notice("Bad address", "Pass ?email=you@example.com");
      let dj = await env.DB.prepare(`SELECT * FROM djs WHERE email_norm = ?`).bind(emailNorm).first();
      if (!dj) {
        await env.DB.prepare(
          `INSERT INTO djs (id, email_norm, name, created_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?)`
        // ?name= with nothing after it means nobody, which is the state a real
        // provider never hands us and the one worth being able to look at.
        ).bind(ulid(now), emailNorm,
          url.searchParams.has("name") ? url.searchParams.get("name") : "Test DJ", now, now).run();
        dj = await env.DB.prepare(`SELECT * FROM djs WHERE email_norm = ?`).bind(emailNorm).first();
      }
      return new Response(null, {
        status: 302,
        headers: { location: "/manage", "set-cookie": await startSession(env, { djId: dj.id, now }) },
      });
    }

    // Every message the platform would have sent, with its links live. Nothing
    // is delivered in development, so without this the join, confirm, invite
    // and settings flows cannot be walked at all.
    if (path === "/dev/outbox" && env.DEV_LOGIN === "1") {
      const { results } = await env.DB.prepare(
        `SELECT * FROM outbox ORDER BY created_ms DESC LIMIT 50`
      ).all();
      const linkify = (text) => esc(text).replace(
        /(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
      return html(200, page("Outbox", `
        <h1>Outbox</h1>
        <p class="muted">${(results || []).length} messages. Nothing is sent in development -
          the links below are the real ones.</p>
        ${(results || []).map((m) => `<div class="card">
          <div class="muted">${esc(m.kind)} - ${esc(m.to_email)}${m.sent_ms ? " (sent)" : ""}</div>
          <strong>${esc(m.subject)}</strong>
          <pre style="white-space:pre-wrap;font:inherit;margin:8px 0 0">${linkify(m.body_text)}</pre>
        </div>`).join("") || `<p class="muted">Nothing yet.</p>`}
      `));
    }

    if (path === "/api/v1/install/code" && request.method === "POST") {
      const body = await readJson(request, 4096);
      if (!body) return json(400, { error: "bad json" });
      if (!await installAuth(env, body.id, body.secret)) return json(403, { error: "bad install auth" });
      // Already signed in? Answer with the PERSON. The console shows this as
      // "you are signed in", and who they are is their profile, not the name of
      // some group they once made.
      const owner = await installOwner(env, body.id);
      if (owner) {
        const profile = await profileFor(env, owner.email_norm, now, owner.name);
        return json(200, {
          linked: true, handle: profile.handle, name: profile.name || profile.handle,
        });
      }
      const code = pairingCode();
      await env.DB.prepare(
        `INSERT INTO install_codes (code, install_id, created_ms, expires_ms) VALUES (?, ?, ?, ?)`
      ).bind(code, String(body.id), now, now + 15 * 60 * 1000).run();
      return json(200, { linked: false, code, expiresMs: now + 15 * 60 * 1000 });
    }

    // ---- the party's own timeline -----------------------------------------
    // One link means the wall on the venue Wi-Fi and the page people open three
    // days later are the same timeline. The Mac pushes what it collected and
    // pulls what was written on the web; posts carry ULIDs minted by whoever
    // wrote them, so a Mac with no internet still makes ids that never collide.
    //
    // The Mac proves itself with the credential the broker already gave it at
    // registration. Inventing a second one would mean a second thing to leak.
    if (path === "/api/v1/party/posts" && request.method === "POST") {
      const body = await readJson(request, 262144);
      if (!body) return json(400, { error: "bad json" });
      const install = await installAuth(env, body.id, body.secret);
      if (!install) return json(403, { error: "bad install auth" });
      if (!PARTY_ID_RE.test(String(body.partyId || ""))) return json(400, { error: "bad party id" });

      const event = await env.DB.prepare(
        `SELECT e.*, g.handle FROM events e JOIN groups g ON g.id = e.group_id WHERE e.party_id = ?`
      ).bind(String(body.partyId)).first();
      // A party with no night attached is not an error: plenty of parties are
      // just a Mac in a room. It keeps its wall locally and syncs nothing.
      if (!event) return json(200, { bound: false, posts: [] });

      // This call IS the liveness. The Mac makes it every twenty seconds for as
      // long as it is broadcasting and stops the moment it is not, so stamping
      // the clock here is the whole of "is this party playing right now" - no
      // flag to set, and nothing left behind claiming a set that ended.
      const joinUrl = String(body.joinUrl || "").slice(0, 300);
      await env.DB.prepare(
        `UPDATE events SET live_ms = ?, live_url = ? WHERE id = ?`
      ).bind(now, /^https:\/\//.test(joinUrl) ? joinUrl : event.live_url || "",
        event.id).run();

      let stored = 0;
      for (const post of (Array.isArray(body.posts) ? body.posts : []).slice(0, 200)) {
        const id = String(post.id || "");
        if (!/^[a-f0-9]{32}$/.test(id)) continue;
        const result = await env.DB.prepare(
          `INSERT INTO posts (id, group_id, event_id, author, body, media_key, media_type, origin, created_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'lan', ?)
           ON CONFLICT(id) DO NOTHING`
        ).bind(id, event.group_id, event.id, String(post.author || "").slice(0, 60),
          String(post.body || "").slice(0, 2000), post.mediaKey || null, post.mediaType || null,
          Number(post.createdMs) || now).run();
        if (result) stored++;
      }

      // Only what the web added. Sending the Mac its own posts back would have
      // it merge duplicates of everything it just pushed.
      const since = Number(body.since) || 0;
      const { results } = await env.DB.prepare(
        `SELECT id, author, body, media_key, media_type, created_ms FROM posts
          WHERE event_id = ? AND origin = 'web' AND deleted_ms IS NULL AND created_ms > ?
          ORDER BY created_ms LIMIT 200`
      ).bind(event.id, since).all();
      return json(200, {
        bound: true,
        event: { slug: event.slug, handle: event.handle, title: event.title },
        stored,
        posts: results || [],
      });
    }

    // Is this @name free? Asked as somebody types, so the answer arrives while
    // the field is still in front of them rather than after they press Save and
    // lose the page. Signed in only, and it says nothing a guess would not:
    // whether a name can be taken is exactly what the sign-up form tells you.
    if (path === "/api/v1/handle-free") {
      const dj = await currentDJ(env, request, now);
      if (!dj) return json(403, { error: "sign in first" });
      const wanted = normalizeHandle(url.searchParams.get("h"));
      const profile = await profileFor(env, dj.email_norm, now, dj.name);
      // Their own name is always available to them - otherwise saving a form
      // they did not change reads as a collision with themselves.
      if (profile && wanted === profile.handle) return json(200, { free: true, mine: true });
      const problem = handleProblem(wanted);
      if (problem) return json(200, { free: false, why: problem });
      return await handleFree(env, wanted, dj.email_norm)
        ? json(200, { free: true })
        : json(200, { free: false, why: "already taken" });
    }

    // The DJ's profile, as the Mac sees it.
    //
    // The Mac has no sign-in and never will - it is a machine in a booth, not
    // an account. It knows itself by its install id, that id is paired to a
    // group, and the group has an owner. That owner is the person whose face
    // and name belong on the console, so this is the same record the web edits
    // and there is only ever one of it.
    //
    // Sent with `set`, it writes; without, it reads. Writes are applied only
    // when the Mac's copy is NEWER than ours, so a console left open for a week
    // cannot undo something changed on the web this morning.
    if (path === "/api/v1/install/profile" && request.method === "POST") {
      const body = await readJson(request, 8192);
      if (!body) return json(400, { error: "bad json" });
      if (!await installAuth(env, body.id, body.secret)) return json(403, { error: "bad install auth" });

      // Straight to the person. This used to join through the Mac's group to
      // reach the DJ who owned it - a group in the middle of a question that
      // was only ever about who this Mac belongs to.
      const owner = await installOwner(env, body.id);
      // Not paired to anything. The console keeps whatever it has locally,
      // which is the whole behaviour of an unpaired Mac.
      if (!owner) return json(200, { linked: false });

      const profile = await profileFor(env, owner.email_norm, now);
      if (body.set && typeof body.set === "object") {
        const sentMs = Number(body.updatedMs) || 0;
        if (sentMs > Number(profile.updated_ms || 0)) {
          const links = {};
          for (const field of SOCIAL_FIELDS) {
            const value = field.key === "website"
              ? websiteUrl(body.set[field.key])
              : socialName(body.set[field.key]);
            if (value) links[field.key] = value;
          }
          const name = String(body.set.name || "").slice(0, 60).trim();
          await env.DB.prepare(
            `UPDATE profiles SET name = ?, bio = ?, links = ?, saved_ms = COALESCE(saved_ms, ?),
               updated_ms = ? WHERE email_norm = ?`
          ).bind(name, String(body.set.bio || "").slice(0, 200).trim(),
            JSON.stringify(links), sentMs, sentMs, owner.email_norm).run();
          if (name) {
            await env.DB.prepare(`UPDATE djs SET name = ? WHERE email_norm = ?`)
              .bind(name, owner.email_norm).run();
            await env.DB.prepare(`UPDATE members SET name = ? WHERE email_norm = ?`)
              .bind(name, owner.email_norm).run();
          }
        }
      }

      const fresh = await profileFor(env, owner.email_norm, now);
      return json(200, {
        linked: true,
        profile: {
          handle: fresh.handle || "",
          name: fresh.name || "",
          bio: fresh.bio || "",
          links: fresh.linksObj || {},
          // Absolute, because the Mac serves its own pages and a /media/ path
          // would resolve against the Mac rather than against us.
          avatarUrl: fresh.avatar_key ? base + mediaUrl(fresh.avatar_key) : "",
          updatedMs: Number(fresh.updated_ms || 0),
        },
      });
    }

    // The photo, which is bytes rather than JSON and so has its own door.
    if (path === "/api/v1/install/avatar" && request.method === "POST") {
      const form = await request.formData().catch(() => null);
      if (!form) return json(400, { error: "bad form" });
      if (!await installAuth(env, form.get("id"), form.get("secret"))) {
        return json(403, { error: "bad install auth" });
      }
      const owner = await installOwner(env, form.get("id"));
      if (!owner) return json(200, { linked: false });

      await profileFor(env, owner.email_norm, now);
      let key = null;
      if (!form.get("clear")) {
        const stored = await storeMedia(env, form.get("avatar"), "avatars", MAX_AVATAR);
        if (stored.error) return json(400, { error: stored.error });
        key = stored.key;
      }
      await env.DB.prepare(
        `UPDATE profiles SET avatar_key = ?, updated_ms = ? WHERE email_norm = ?`
      ).bind(key, now, owner.email_norm).run();
      return json(200, { linked: true, avatarUrl: key ? base + mediaUrl(key) : "" });
    }

    // ---- the Mac, as a full client ---------------------------------------
    //
    // The Mac is not a broadcast utility with its own idea of a party. These
    // routes are how it reads and writes the SAME rows the web does, through
    // the same createParty/updateParty used by the browser form. Authenticated
    // by the install, which is bound to a group, which is owned by a person -
    // so "may this Mac touch this party" is the same question as on the web.
    if (path.startsWith("/api/v1/party/") || path === "/api/v1/parties") {
      const macRoutes = ["/api/v1/parties", "/api/v1/party/create", "/api/v1/party/update"];
      if (macRoutes.includes(path)) {
        if (request.method !== "POST") return json(405, { error: "POST required" });
        const body = await readJson(request, 8192);
        if (!body) return json(400, { error: "bad json" });
        // A plain refusal. The "unknown install, register again" signal belongs
        // to the BROKER, which is the worker a Mac's activation talks to;
        // installAuthFailure lives there and calling it from here was a
        // ReferenceError that took these routes down with a 1101.
        if (!await installAuth(env, body.id, body.secret)) {
          return json(403, { error: "bad install auth" });
        }
        // Not signed in on this Mac yet. Not an error - there is simply no
        // account whose parties these would be. Signed in, the group is
        // resolved from the account and made on demand if they have none.
        const group = await installGroup(env, body.id, now);
        if (!group) return json(200, { linked: false, parties: [] });

        // Everything this account has, so the Mac can open one made on the web.
        if (path === "/api/v1/parties") {
          const { results } = await env.DB.prepare(
            `SELECT id, slug, title, starts_ms, place, cover_key, state, party_id, links
               FROM events WHERE group_id = ? AND state != 'draft'
              ORDER BY COALESCE(starts_ms, created_ms) DESC LIMIT 60`
          ).bind(group.id).all();
          return json(200, {
            linked: true,
            group: { handle: group.handle, name: group.name },
            parties: (results || []).map((e) => partyForMac(e, group, base)),
          });
        }

        if (path === "/api/v1/party/create") {
          const maker = await installOwner(env, body.id);
          const made = await createParty(env, group, {
            ownerEmail: maker ? maker.email_norm : "",
            title: body.title,
            // The Mac knows when a party is actually starting, because it is
            // standing in the room. The web has to be told.
            startsMs: Number.isFinite(Number(body.startsMs)) ? Number(body.startsMs) : now,
            place: body.place,
            capacity: body.capacity,
            coverKey: body.coverKey,
            links: body.links,
            // Attaching the live room at creation, so a broadcast never has to
            // mint a second record to hang itself off.
            partyId: PARTY_ID_RE.test(String(body.partyId || "")) ? body.partyId : "",
          }, now);
          if (made.error) return json(400, { error: made.error });
          await attachRoom(env, group.id, made.id, body.partyId, now);
          // Whoever is playing becomes a person, exactly as typing them into the
          // web's own form does. Creating a party has to MEAN the same thing on
          // both clients, not merely look similar: a DJ named in the booth has
          // to turn up in the same history as one named in a browser.
          if (maker) {
            for (const name of String(body.djs || "").split(",")) {
              const person = await findOrMakePerson(env, maker.email_norm, name, now);
              if (!person) continue;
              await env.DB.prepare(
                `INSERT OR IGNORE INTO party_people (event_id, person_id, owner_email, role, created_ms)
                 VALUES (?,?,?,'dj',?)`
              ).bind(made.id, person.id, maker.email_norm, now).run();
            }
          }
          const row = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(made.id).first();
          return json(200, { linked: true, party: partyForMac(row, group, base) });
        }

        // Editing, from the booth. Same rules as the web: it has to be yours.
        const event = await env.DB.prepare(
          `SELECT * FROM events WHERE id = ? AND group_id = ?`
        ).bind(String(body.partyKey || ""), group.id).first();
        if (!event) return json(404, { error: "no such party" });
        const done = await updateParty(env, event, {
          title: body.title,
          startsMs: body.startsMs === undefined ? undefined
            : (Number.isFinite(Number(body.startsMs)) ? Number(body.startsMs) : null),
          place: body.place,
          coverKey: body.coverKey,
          links: body.links,
          state: body.state,
        }, now);
        if (done.error) return json(400, { error: done.error });
        // Binding the live room to a party made earlier, on either client.
        await attachRoom(env, group.id, event.id, body.partyId, now);
        const fresh = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(event.id).first();
        return json(200, { linked: true, party: partyForMac(fresh, group, base) });
      }
    }

    // The Mac asks which night it is playing. Answered from the group the
    // install belongs to and the clock, so a DJ never has to pair anything: if
    // one of their nights is happening now, this is that night.
    if (path === "/api/v1/party/bind" && request.method === "POST") {
      const body = await readJson(request, 4096);
      if (!body) return json(400, { error: "bad json" });
      const install = await installAuth(env, body.id, body.secret);
      if (!install) return json(403, { error: "bad install auth" });
      if (!PARTY_ID_RE.test(String(body.partyId || ""))) return json(400, { error: "bad party id" });

      const bindGroup = await installGroup(env, body.id, now);
      if (!bindGroup) return json(200, { bound: false, reason: "this Mac is not signed in" });

      const window = 12 * 60 * 60 * 1000;
      const night = await env.DB.prepare(
        `SELECT * FROM events WHERE group_id = ? AND state = 'announced'
           AND starts_ms IS NOT NULL AND starts_ms > ? AND starts_ms < ?
         ORDER BY ABS(starts_ms - ?) LIMIT 1`
      ).bind(bindGroup.id, now - window, now + window, now).first();
      if (!night) return json(200, { bound: false, reason: "no night on now" });

      // First Mac to claim it wins, and a night already tied to another party
      // is left alone: two rooms merging their walls by accident is worse than
      // one wall staying local.
      if (night.party_id && night.party_id !== String(body.partyId)) {
        return json(200, { bound: false, reason: "another party is already on this night" });
      }
      if (!night.party_id) {
        await env.DB.prepare(`UPDATE events SET party_id = ?, state = 'live', updated_ms = ? WHERE id = ?`)
          .bind(String(body.partyId), now, night.id).run();
      }
      return json(200, { bound: true, slug: night.slug, handle: bindGroup.handle, title: night.title });
    }

    // ---- sign-in ----------------------------------------------------------
    let match = path.match(/^\/auth\/(apple|google)$/);
    if (match) {
      const provider = match[1];
      if (!configured(env, provider)) return notice("Not available yet", "That sign-in is not configured.");
      const nonce = randomHex(16);
      const state = await signState(env, {
        p: provider, n: nonce, exp: now + 10 * 60 * 1000,
        to: url.searchParams.get("to") || "/home",
      });
      // SameSite=None because Apple posts the result back cross-site; a Lax
      // cookie is simply not sent and every sign-in fails on state mismatch.
      return new Response(null, {
        status: 302,
        headers: {
          location: authorizeURL(env, provider, {
            redirectUri: `${base}/auth/${provider}/callback`, state, nonce,
          }),
          "set-cookie": `pp_auth=${state}; Path=/auth; HttpOnly; Secure; SameSite=None; Max-Age=600`,
        },
      });
    }

    match = path.match(/^\/auth\/(apple|google)\/callback$/);
    if (match) {
      const provider = match[1];
      const form = PROVIDERS[provider].formPost && request.method === "POST"
        ? await request.formData().catch(() => null)
        : null;
      const code = String((form && form.get("code")) || url.searchParams.get("code") || "");
      const returned = String((form && form.get("state")) || url.searchParams.get("state") || "");
      const stored = cookies(request).pp_auth || "";
      if (!code || !returned || returned !== stored) {
        return notice("That sign-in did not complete", "Start again from the sign-in page.");
      }
      const state = await readState(env, returned, now);
      if (!state || state.p !== provider) {
        return notice("That sign-in did not complete", "Start again from the sign-in page.");
      }
      let claims;
      try {
        claims = await exchangeCode(env, provider, {
          code, redirectUri: `${base}/auth/${provider}/callback`, now,
          fetchImpl: env.FETCH || undefined,
        });
      } catch (e) {
        return notice("That sign-in did not complete", String(e.message || e));
      }
      if (claims.nonce && claims.nonce !== state.n) {
        return notice("That sign-in did not complete", "The reply did not match the request.");
      }
      const emailNorm = normalizeEmail(claims.email);
      if (!emailNorm) return notice("No email address", "We need an address to reach you about your nights.");

      // Apple hands the name over exactly once, in a form field, on the first
      // authorization. Take it or the DJ has no name for good.
      const name = appleNameFrom(form) || String(claims.name || "").slice(0, 60);
      let dj = await env.DB.prepare(`SELECT * FROM djs WHERE email_norm = ?`).bind(emailNorm).first();
      if (!dj) {
        await env.DB.prepare(
          `INSERT INTO djs (id, email_norm, name, created_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?)`
        ).bind(ulid(now), emailNorm, name, now, now).run();
        dj = await env.DB.prepare(`SELECT * FROM djs WHERE email_norm = ?`).bind(emailNorm).first();
      } else {
        await env.DB.prepare(`UPDATE djs SET last_seen_ms = ? WHERE id = ?`).bind(now, dj.id).run();
      }

      // Take the name whenever it turns up, not only the first time we ever saw
      // this person. Writing it on INSERT alone meant anybody whose row already
      // existed - signed in before we asked for the name, or an Apple account
      // that hands it over exactly once - stayed permanently anonymous while we
      // were being told their name on every single sign-in.
      //
      // Filling a blank, never overwriting: once somebody has chosen their own
      // name, the provider does not get to change it back.
      if (name) {
        if (!dj.name) {
          await env.DB.prepare(`UPDATE djs SET name = ? WHERE id = ?`).bind(name, dj.id).run();
          dj.name = name;
        }
        const profile = await profileFor(env, emailNorm, now, name);
        if (profile && !profile.name && !profile.saved_ms) {
          await env.DB.prepare(
            `UPDATE profiles SET name = ?, updated_ms = ? WHERE email_norm = ?`
          ).bind(name, now, emailNorm).run();
        }
      }
      // A member who signs in with the same verified address is the same
      // person: they keep every group they joined from a link.
      await env.DB.prepare(
        `UPDATE members SET ${provider === "apple" ? "apple_sub" : "google_sub"} = ?, confirmed_ms = COALESCE(confirmed_ms, ?)
         WHERE email_norm = ?`
      ).bind(String(claims.sub || ""), now, emailNorm).run();

      const cookie = await startSession(env, { djId: dj.id, now });
      return new Response(null, {
        status: 302,
        headers: {
          location: String(state.to || "/home"),
          "set-cookie": cookie,
        },
      });
    }

    if (path === "/auth/signout") {
      const secret = cookies(request).pp_s;
      if (/^[a-f0-9]{48}$/.test(String(secret || ""))) {
        await env.DB.prepare(`UPDATE sessions SET revoked_ms = ? WHERE hash = ?`)
          .bind(now, await sha256Hex(secret)).run();
      }
      return new Response(null, {
        status: 302,
        headers: { location: "/", "set-cookie": "pp_s=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" },
      });
    }

    if (path === "/signin") return html(200, signInPage(env));

    // Signing in ON the Mac.
    //
    // The Mac used to show a code for the DJ to retype into a settings drawer
    // on the web - machinery for a problem signing in already solves, and it
    // was never even wired: nothing in the app ever asked for a code, so the
    // box on the web was asking people to type something no Mac had shown them.
    //
    // Now the app opens this URL with its own code already in it. The person
    // signs in if they are not, presses one button, and the Mac belongs to
    // them. The code is still what proves WHICH Mac is asking - it is minted by
    // an install-authed call and single use - but nobody ever reads it out.
    match = path.match(/^\/link\/([A-Z0-9]{6})$/);
    if (match) {
      const code = await env.DB.prepare(
        `SELECT * FROM install_codes WHERE code = ? AND used_ms IS NULL AND expires_ms > ?`
      ).bind(match[1], now).first();
      if (!code) {
        return notice("That link has expired",
          "Open PartyParty on the Mac and press Sign in again - it makes a fresh one.");
      }
      const dj = await currentDJ(env, request, now);
      if (!dj) {
        // The Mac's door already asked which provider, so go straight there
        // rather than showing a second identical pair of buttons.
        const withProvider = url.searchParams.get("with");
        if ((withProvider === "apple" || withProvider === "google") && configured(env, withProvider)) {
          return new Response(null, {
            status: 302,
            headers: { location: `/auth/${withProvider}?to=${encodeURIComponent(path)}` },
          });
        }
        return html(200, signInPage(env, "Sign in to link this Mac", path));
      }

      // Signing in IS the linking. There is no question to answer: this Mac
      // belongs to the person who just proved who they are. It used to ask
      // which of your groups to attach it to, which is a question about a
      // concept most people do not have, on a screen whose only job is "yes,
      // that is me".
      await env.DB.prepare(`UPDATE install_codes SET used_ms = ? WHERE code = ?`)
        .bind(now, match[1]).run();
      await env.DB.prepare(
        `INSERT INTO install_accounts (install_id, email_norm, linked_ms) VALUES (?, ?, ?)
         ON CONFLICT(install_id) DO UPDATE SET email_norm = excluded.email_norm,
           linked_ms = excluded.linked_ms`
      ).bind(code.install_id, dj.email_norm, now).run();

      const profile = await profileFor(env, dj.email_norm, now, dj.name);
      return html(200, page("This Mac is yours", `
        <div class="you"><div class="yourow" style="align-items:center">
          ${personDisc(profile, "big")}
          <div class="grow" style="gap:2px">
            <b style="font-size:16px">${esc(profile.name || "@" + profile.handle)}</b>
            <span class="muted">@${esc(profile.handle)}</span>
          </div>
        </div></div>
        <h1>That is you</h1>
        <p>This Mac is signed in as you. Your name and photo are already in the
        app, and anything you change in either place shows up in the other.</p>
        <p class="muted">You can close this tab and go back to the Mac.</p>
        <p><a class="btn plain" href="/home">Your parties</a></p>
      `, "", "", true));
    }

    // ---- the DJ's own pages -----------------------------------------------
    // You, not one of your groups. Your name and how you sign in are yours and
    // follow you across every group you run or follow, so they do not belong
    // folded inside one group's page.
    if (path === "/settings") {
      const dj = await currentDJ(env, request, now);
      if (!dj) return html(200, signInPage(env));
      let problem = "", pending = null;
      if (request.method === "POST") {
        const form = await request.formData().catch(() => null);
        if (!form) return notice("That did not save", "Try again.");
        const saved = await saveProfileForm(env, dj.email_norm, form, now);
        if (!saved.error) {
          return new Response(null, { status: 302, headers: { location: "/settings" } });
        }
        // Back to the same page with everything they typed still in it, and the
        // one bad field named. Never a dead end that costs them the rest.
        problem = saved.error;
        pending = saved.pending;
      }
      const profile = pending || await profileFor(env, dj.email_norm, now, dj.name);
      const { results: following } = await env.DB.prepare(
        `SELECT g.handle, g.name, gm.volume FROM groups g
           JOIN group_members gm ON gm.group_id = g.id
           JOIN members m ON m.id = gm.member_id
          WHERE m.email_norm = ? AND gm.state = 'joined' ORDER BY gm.joined_ms DESC`
      ).bind(dj.email_norm).all();

      const volumeWord = { all: "every post", events: "nights only", none: "nothing" };
      return html(200, page("Your settings", `
        <h1>You</h1>
        <p class="muted">All of this is optional. You already have an @name, and
        nothing here has to be your real one.</p>
        ${profileEditor(profile, { action: "/settings", error: problem })}
        <p class="muted">Signed in as ${esc(dj.email_norm)}. That address came from
        ${esc(dj.apple_sub ? "Apple" : "your sign-in")} and cannot be changed here -
        sign in with a different one and you are a different person to us.
        ${profile.handle ? `Your page is
          <a href="/@${esc(profile.handle)}">partyparty.party/@${esc(profile.handle)}</a>.` : ""}</p>

        <h2>Following</h2>
        ${(following || []).length
          ? (following).map((g) => `<div class="card">
              <strong>${esc(g.name || g.handle)}</strong>
              <div class="muted">You hear ${esc(volumeWord[g.volume] || g.volume)} ·
                <a class="muted" href="/@${esc(g.handle)}">their page</a></div>
            </div>`).join("")
          : `<p class="muted">Nobody yet. Following someone puts their nights on your
             home page.</p>`}
        <p class="muted">How much you hear from each one is set from any message they
        send you - that link works without signing in, which is the point.</p>

        <p style="margin-top:40px"><a class="muted" href="/home">Home</a> ·
          <a class="muted" href="/auth/signout">Sign out</a></p>
      `, "", "", true));
    }

    // Home for someone signed in: what is coming up, across the groups they run
    // and the groups they follow. Signed out it is the sign-in page, because
    // there is nothing here that is about nobody in particular.
    if (path === "/home") {
      const dj = await currentDJ(env, request, now);
      if (!dj) return html(200, signInPage(env));
      let problem = "", pending = null;
      if (request.method === "POST") {
        const form = await request.formData().catch(() => null);
        if (!form) return notice("That did not save", "Try again.");
        const saved = await saveProfileForm(env, dj.email_norm, form, now);
        if (!saved.error) {
          return new Response(null, { status: 302, headers: { location: "/home" } });
        }
        problem = saved.error;
        pending = saved.pending;
      }
      const stored = await profileFor(env, dj.email_norm, now, dj.name);
      // On a rejection the form shows what they typed, but the sentence about
      // what they are called must name the @name they actually HAVE - quoting
      // the one that was just refused back at them is nonsense.
      const profile = pending || stored;

      // First sight: the profile, open and ready to fill in, prefilled with
      // whatever Apple or Google told us. It is already valid - the @name was
      // minted with the account - so this is an invitation rather than a gate,
      // and answering it either way puts it away for good. Editing stays at
      // /settings, which is where somebody who wants it later will look.
      //
      // A rejected save keeps the welcome open, whatever the stored flag says:
      // the person is mid-edit and closing the form under them would be worse
      // than the error they are already looking at.
      // A journal opens on the journal. Asking somebody to fill in a profile
      // before they can see their own parties is a wall, and a form the height
      // of the screen was exactly that - so it is a line that opens now, and
      // only opens itself when something needs fixing.
      const you = (!stored.saved_ms || problem)
        ? `<details class="welcome"${problem ? " open" : ""}>
             <summary>${personDisc(profile)}<span>
               <b>${esc(profile.name || "@" + profile.handle)}</b>
               <small>Add your name and photo - optional, and you are already
                 @${esc(stored.handle)}</small></span></summary>
             ${profileEditor(profile, {
               action: "/home",
               dismiss: "Not now",
               error: problem,
               note: `All optional. Skip it and you are <b>@${esc(stored.handle)}</b> to everyone.`,
             })}
           </details>`
        : `<div class="you"><div class="yourow" style="align-items:center">
            ${personDisc(profile, "big")}
            <div class="grow" style="gap:2px">
              <b style="font-size:16px">${esc(profile.name || "@" + profile.handle)}</b>
              <span class="muted">@${esc(profile.handle)}${
                profile.bio ? " \u00b7 " + esc(profile.bio) : ""}</span>
            </div>
            <a class="btn plain small" href="/settings">Edit</a>
          </div></div>`;

      // My parties. Everything I run, plus everything I have kept a note or an
      // encounter against - going to somebody else's night is as much a party
      // of mine as throwing one.
      const mine = await myParties(env, dj.email_norm);
      const { results: follows = [] } = await env.DB.prepare(
        `SELECT p.handle, p.name FROM follows f
           JOIN profiles p ON p.email_norm = f.person_email
          WHERE f.follower_email = ? ORDER BY p.handle`
      ).bind(dj.email_norm).all();
      const upcoming = mine.filter((e) => !partyIsPast(e, now))
        .sort((a, b) => (a.starts_ms || Infinity) - (b.starts_ms || Infinity));
      const past = mine.filter((e) => partyIsPast(e, now));

      // What is in a night, in one line, so a list of parties is worth reading
      // a year later: who played, how much of the set you wrote down, and the
      // opening of what you thought.
      const inside = (e) => {
        const bits = [];
        if (e.attended === 1) bits.push("You were there");
        if (e.bill) bits.push(esc(e.bill));
        if (e.song_count) bits.push(`${e.song_count} ${e.song_count === 1 ? "song" : "songs"}`);
        if (e.my_note) {
          const line = String(e.my_note).replace(/\s+/g, " ").trim();
          bits.push(esc(line.length > 68 ? line.slice(0, 67) + "\u2026" : line));
        }
        return bits.join(" \u00b7 ");
      };
      const row = (e) => `<a class="entry" href="/@${esc(e.handle)}/${esc(e.slug)}">
        <span class="entrywhen">${esc(whenText(e))}</span>
        <span class="entrybody">
          <b>${esc(e.title || "Untitled party")}</b>
          ${e.place ? `<span class="entrywhere">${esc(e.place)}</span>` : ""}
          ${inside(e) ? `<span class="entryinside">${inside(e)}</span>` : ""}
        </span>
        ${liveNow(e, now) ? `<span class="tag live">Playing now</span>`
          : partyPhase(e, now) === "now" ? `<span class="tag live">Tonight</span>` : ""}
      </a>`;

      const section = (label, list, empty) => `<h2>${esc(label)}</h2>
        ${list.length ? `<div class="entries">${list.map(row).join("")}</div>`
          : `<p class="blank">${empty}</p>`}`;

      return html(200, page("Your parties", `
        ${you}
        <div class="sectionhead"><h1>Your parties</h1>
          <a class="btn" href="/parties/new">Add a party</a></div>
        ${mine.length === 0
          ? `<div class="card">
               <p><b>Nothing here yet.</b></p>
               <p class="muted">Add a party you are going to, or one you already
               went to. Keep who played, who you saw, and what you thought - it is
               yours and nobody else sees it.</p>
               <p><a class="btn" href="/parties/new">Add your first party</a></p>
             </div>`
          : `${section("Upcoming", upcoming, "Nothing coming up.")}
             ${section("Past", past, "Nothing yet.")}`}

        <p class="muted" style="margin-top:40px">
          <a href="/people">People you have seen</a> ·
          <a href="/settings">Settings</a> ·
          <a href="/auth/signout">Sign out</a></p>
      `, "", "", true));
    }

    // Adding a party. Deliberately two fields and a button: an incomplete party
    // now is worth more than a complete one you did not bother to make.
    if (path === "/parties/new") {
      const dj = await currentDJ(env, request, now);
      if (!dj) return html(200, signInPage(env, "Sign in", path));
      const group = await homeGroupFor(env, dj, now);
      if (!group) return notice("Something went wrong", "Could not find your parties.");

      if (request.method === "POST") {
        const form = await request.formData().catch(() => null);
        if (!form) return notice("That did not save", "Try again.");
        const title = String(form.get("title") || "").trim();
        if (!title) {
          return html(200, newPartyPage(group, { error: "Give it a name first." }, form, todayISO(now)));
        }
        // A day, at midday. Storing midnight means a reader an hour west sees
        // the party on the day before, which in a journal is simply wrong.
        const dayRaw = String(form.get("day") || "");
        const starts = dayRaw ? Date.parse(dayRaw + "T12:00:00Z") : null;
        const made = await createParty(env, group, {
          ownerEmail: dj.email_norm,
          title,
          startsMs: Number.isFinite(starts) ? starts : null,
          place: form.get("place"),
        }, now);
        if (made.error) {
          return html(200, newPartyPage(group, { error: made.error }, form, todayISO(now)));
        }
        // The DJ, typed as a name, becomes a person - so their history starts
        // accruing from the first party rather than from whenever I first
        // thought to make a contact record.
        for (const name of String(form.get("dj") || "").split(",")) {
          const person = await findOrMakePerson(env, dj.email_norm, name, now);
          if (!person) continue;
          await env.DB.prepare(
            `INSERT OR IGNORE INTO party_people (event_id, person_id, owner_email, role, created_ms)
             VALUES (?,?,?,'dj',?)`
          ).bind(made.id, person.id, dj.email_norm, now).run();
        }
        return new Response(null, {
          status: 302, headers: { location: `/@${group.handle}/${made.slug}` },
        });
      }
      const lastPlace = await env.DB.prepare(
        `SELECT place FROM events WHERE owner_email = ? AND place != ''
          ORDER BY created_ms DESC LIMIT 1`
      ).bind(dj.email_norm).first();
      return html(200, newPartyPage(group, {}, null, todayISO(now),
        lastPlace && lastPlace.place));
    }

    // Everyone I have recorded, and one person's whole history.
    if (path === "/people" || path.startsWith("/people/")) {
      const dj = await currentDJ(env, request, now);
      if (!dj) return html(200, signInPage(env, "Sign in", path));

      const who = path === "/people" ? "" : path.slice("/people/".length);
      if (!who) {
        const q = url.searchParams.get("q") || "";
        const list = await peopleFor(env, dj.email_norm, q);
        return html(200, page("People", `
          <div class="sectionhead"><h1>People</h1></div>
          <form class="join" method="get" action="/people">
            <input type="search" name="q" placeholder="Search by name" value="${esc(q)}">
            <button class="btn plain" type="submit">Search</button>
          </form>
          ${list.length ? `<div class="entries">${list.map((p) => `<a class="seen" href="/people/${esc(p.id)}">
              ${personDisc(p)}
              <span class="entrybody">
                <b>${esc(p.name)}</b>
                <span class="entryinside">${p.last_at
                  ? `Last at ${esc(p.last_at)}${p.last_ms
                      ? " \u00b7 " + esc(whenText({ starts_ms: p.last_ms, day_only: 1 })) : ""}`
                  : "Not at a party yet"}</span>
              </span>
              <span class="entrywhen">${p.times}</span>
            </a>`).join("")}</div>`
            : q
              ? `<p class="muted">Nobody by that name.</p>`
              : `<div class="card"><p><b>Nobody yet.</b></p>
                 <p class="muted">People turn up here as you add them to parties -
                 who played, and who you saw. They do not need accounts.</p></div>`}
          <p class="muted" style="margin-top:32px"><a href="/home">Your parties</a></p>
        `, "", "", true));
      }

      const person = await env.DB.prepare(
        `SELECT * FROM people WHERE id = ? AND owner_email = ?`
      ).bind(who, dj.email_norm).first();
      if (!person) return new Response("Not Found", { status: 404 });

      // Saying who they turned out to be. The name I typed years ago stays my
      // name for them; the @name only says which account it is, and clearing
      // the field unsays it. A person is never required to have one.
      let linkError = "";
      let typed = null;
      if (request.method === "POST") {
        const form = await request.formData().catch(() => null);
        if (form) {
          typed = form;
          const wanted = String(form.get("account") || "").trim().replace(/^@/, "").toLowerCase();
          let accountEmail = null;
          if (wanted) {
            const profile = await profileByHandle(env, wanted);
            if (!profile) linkError = `Nobody here is @${wanted}.`;
            else accountEmail = profile.email_norm;
          }
          if (!linkError) {
            await env.DB.prepare(
              `UPDATE people SET name = ?, note = ?, account_email = ?, updated_ms = ?
                WHERE id = ? AND owner_email = ?`
            ).bind(String(form.get("name") || person.name).slice(0, 80).trim() || person.name,
              String(form.get("note") || "").slice(0, 4000), accountEmail, now,
              who, dj.email_norm).run();
            return new Response(null, { status: 302, headers: { location: `/people/${who}` } });
          }
        }
      }

      // Their profile, if I have said which account they are. It is theirs, so
      // it is whatever they have chosen to be called today - my note about them
      // is mine and does not change when they rename themselves.
      const account = person.account_email
        ? await env.DB.prepare(`SELECT * FROM profiles WHERE email_norm = ?`)
            .bind(person.account_email).first()
        : null;
      // A refusal keeps what was typed. Handing back the stored values instead
      // makes the person retype the note they had just written because one
      // other field was wrong.
      const was = (name, fallback) => esc(
        typed && typed.get(name) !== null ? typed.get(name) : fallback);
      const history = await personHistory(env, dj.email_norm, who);
      return html(200, page(person.name, `
        <div class="you"><div class="yourow" style="align-items:center">
          ${personDisc(person, "big")}
          <div class="grow" style="gap:2px">
            <b style="font-size:19px;letter-spacing:-.02em">${esc(person.name)}</b>
            <span class="muted">${history.length} ${history.length === 1 ? "time" : "times"}${
          account ? ` \u00b7 <a href="/@${esc(account.handle)}">@${esc(account.handle)}</a>` : ""}</span>
          </div>
        </div></div>

        <details class="edit"${linkError ? " open" : ""}>
        <summary>Edit</summary>
        ${linkError ? `<p class="formerror" role="alert">${esc(linkError)}</p>` : ""}
        <form class="you" method="post" action="/people/${esc(who)}">
          <div class="grow" style="display:grid;gap:10px">
            <input type="text" name="name" value="${
              was("name", person.name)}" maxlength="80">
            <textarea name="note" maxlength="4000" placeholder="Anything you want to remember about them"
              style="min-height:64px">${was("note", person.note || "")}</textarea>
            <label class="handlepill"><span>@</span>
              <input type="text" name="account" maxlength="30" autocapitalize="off"
                autocorrect="off" spellcheck="false" placeholder="their name here, if they have one"
                value="${was("account", account ? account.handle : "")}"></label>
          </div>
          <div class="youbar"><button class="btn" type="submit">Save</button>
            <p class="muted">This is the general note. What happened on a
            particular night stays on that night. The @name is optional -
            they do not need an account to be here.</p></div>
        </form></details>

        <h2>Where you saw them</h2>
        ${history.length ? `<div class="entries">${history.map((h) => `<a class="entry"
            href="/@${esc(h.handle)}/${esc(h.slug)}">
            <span class="entrywhen">${esc(whenText(h))}</span>
            <span class="entrybody">
              <b>${esc(h.title || "Untitled party")}</b>
              ${h.place ? `<span class="entrywhere">${esc(h.place)}</span>` : ""}
              ${h.note ? `<span class="entryinside">${esc(h.note)}</span>` : ""}
            </span>
            ${h.role === "dj" ? `<span class="tag">Played</span>` : ""}
          </a>`).join("")}</div>`
          : `<p class="blank">Nights you saw them at will collect here.</p>`}
        <p class="muted" style="margin-top:32px"><a href="/people">All people</a> ·
          <a href="/home">Your parties</a></p>
      `, "", "", true));
    }

    // /manage is a ROUTER, not a destination. A list of your groups is a list
    // of one thing for almost everybody, which is a redirect with extra steps.
    // No group: make one, which is also the onboarding. One group: land inside
    // it, where the work is. Several: only then is choosing a real job.
    if (path === "/manage") {
      const dj = await currentDJ(env, request, now);
      if (!dj) return html(200, signInPage(env));
      if (request.method === "POST") {
        const form = await request.formData().catch(() => null);
        const handle = normalizeHandle(form && form.get("handle"));
        const made = await createGroup(env, dj, handle, form && form.get("name"), now);
        if (made.error) return notice("That name will not work", made.error);
        return new Response(null, { status: 302, headers: { location: `/@${made.handle}/manage` } });
      }
      const { results } = await env.DB.prepare(
        `SELECT g.* FROM groups g JOIN group_djs d ON d.group_id = g.id WHERE d.dj_id = ? ORDER BY g.created_ms`
      ).bind(dj.id).all();
      const mine = results || [];
      if (mine.length === 1) {
        return new Response(null, { status: 302, headers: { location: `/@${mine[0].handle}/manage` } });
      }
      if (mine.length > 1) {
        return html(200, page("Which one", `
          <h1>Which one?</h1>
          ${mine.map((g) => `<a class="card" href="/@${esc(g.handle)}/manage">
            <strong>${esc(g.name || g.handle)}</strong>
            <div class="muted">@${esc(g.handle)}</div></a>`).join("")}
          <p><a class="muted" href="/auth/signout">Sign out</a></p>
        `));
      }
      return html(200, page("Start your group", `
        <h1>Start your group</h1>
        <p>A group is you and the people who come to your nights. You announce a
        night, they get the link, and next time they are already there.</p>
        <form class="join" method="post" action="/manage">
          <input type="text" name="name" placeholder="What is it called?" required>
          <input type="text" name="handle" placeholder="handle" required>
          <button class="btn" type="submit">Create</button>
        </form>
        <p class="muted">The handle is your address: partyparty.party/@yourhandle.
        Five characters or more, letters and numbers.</p>
        <p><a class="muted" href="/auth/signout">Sign out</a></p>
      `));
    }

    // The door. It loads the whole list once and checks codes in the page,
    // because the one place a venue reliably has no signal is the door.
    match = path.match(/^\/@([a-z0-9]+)\/([a-z0-9-]+)\/door$/);
    if (match) {
      const at = await partyAt(env, match[1], match[2]);
      if (!at) return new Response("Not Found", { status: 404 });
      const event = at.event;
      const group = await env.DB.prepare(`SELECT * FROM groups WHERE id = ?`)
        .bind(event.group_id).first();
      if (!group) return new Response("Not Found", { status: 404 });
      const dj = await currentDJ(env, request, now);
      if (!await djRunsGroup(env, dj, group.id)) return html(403, signInPage(env));
      const { results } = await env.DB.prepare(
        `SELECT m.id, m.name, m.email_norm FROM signups s JOIN members m ON m.id = s.member_id
          WHERE s.event_id = ? AND s.state = 'going' ORDER BY m.name, m.email_norm`
      ).bind(event.id).all();
      const list = [];
      for (const person of results || []) {
        list.push({ name: person.name || person.email_norm, code: await entryCode(event.id, person.id) });
      }
      return html(200, page(`Door: ${event.title || group.handle}`, `
        <h1>At the door</h1>
        <p class="muted">${list.length} coming${event.capacity ? ` of ${event.capacity}` : ""}</p>
        <input type="text" id="q" placeholder="Name or code" autocomplete="off"
          style="width:100%;padding:14px;font-size:18px;margin:12px 0">
        <div id="list"></div>
        <script>
        // Everything is in the page already. No request is made after this
        // loads, so a dead signal at the door changes nothing.
        const people = ${JSON.stringify(list)};
        const box = document.getElementById('list');
        const draw = (term) => {
          const t = term.trim().toLowerCase();
          box.innerHTML = people
            .filter((p) => !t || p.name.toLowerCase().includes(t) || p.code.toLowerCase().startsWith(t))
            .map((p) => '<div class="post"><span class="who">' + p.name +
              '</span> <span class="muted">' + p.code + '</span></div>').join('') ||
            '<p class="muted">Nobody by that name.</p>';
        };
        document.getElementById('q').addEventListener('input', (e) => draw(e.target.value));
        draw('');
        </script>
      `));
    }

    // A new party, as an empty party page rather than a row of boxes.
    //
    // Same shape as naming one in the app: a picture already chosen, a title
    // you type over, and the details under it. The cover shuffles without
    // touching the server because there is nothing to save to yet - it rides
    // along as a hidden field and lands with everything else.
    match = path.match(/^\/@([a-z0-9]+)\/new$/);
    if (match) {
      const at = await partyAt(env, match[1], match[2]);
      if (!at) return new Response("Not Found", { status: 404 });
      const event = at.event;
      const group = await env.DB.prepare(`SELECT * FROM groups WHERE id = ?`)
        .bind(event.group_id).first();
      if (!group) return new Response("Not Found", { status: 404 });
      const dj = await currentDJ(env, request, now);
      if (!await djRunsGroup(env, dj, group.id)) return html(403, signInPage(env, "Sign in", path));

      if (request.method === "POST") {
        const form = await request.formData().catch(() => null);
        if (!form) return notice("That did not save", "Try again.");
        const title = String(form.get("title") || "").slice(0, 120).trim();
        if (!title) return notice("It needs a name", "Give the party a name first.");
        const startsRaw = String(form.get("starts") || "");
        const starts = startsRaw ? Date.parse(startsRaw + "Z") : null;
        const cover = await coverFromForm(env, form, "");
        if (cover && cover.error) return notice("That picture did not take", cover.error);
        const made = await createParty(env, group, {
          ownerEmail: dj.email_norm,
          title,
          startsMs: Number.isFinite(starts) ? starts : null,
          place: form.get("place"),
          capacity: form.get("capacity"),
          coverKey: (cover && cover.key) || String(form.get("coverPick") || "") || null,
        }, now);
        if (made.error) return notice("That did not save", made.error);
        return new Response(null, {
          status: 302, headers: { location: `/@${group.handle}/${made.slug}` },
        });
      }

      const pick = COVER_PILE[crypto.getRandomValues(new Uint32Array(1))[0] % COVER_PILE.length];
      return html(200, page("A new party", `
        <form class="newnight" method="post" action="/@${esc(group.handle)}/new"
          enctype="multipart/form-data" id="newParty">
          <input type="hidden" name="coverPick" id="coverPick" value="${esc(coverPileUrl(pick))}">
          <label class="eventfield"><span>When</span>
            <input type="datetime-local" name="starts"></label>
          <label class="eventfield"><span>Where</span>
            <input type="text" name="place" placeholder="The Lido, or a friend's kitchen"></label>
          <label class="eventfield"><span>Capacity</span>
            <input type="text" name="capacity" placeholder="Leave empty for no limit"></label>
          <button class="btn" type="submit">Create the party</button>
        </form>
        <p class="muted">You get a link to send the moment it exists. Nothing is announced
        to anybody until you send it.</p>
        ${newPartyScript()}
      `, hero("Name your party", "", coverPileUrl(pick),
          `<a href="/@${esc(group.handle)}/manage">Back</a>`,
          coverTools(`/@${group.handle}/new`), true), peopleRail(
            await groupPeople(env, group.id), base, group.handle, true)));
    }

    match = path.match(/^\/@([a-z0-9]+)\/manage$/);
    if (match) {
      const group = await groupByHandle(env, match[1]);
      if (!group) return new Response("Not Found", { status: 404 });
      const dj = await currentDJ(env, request, now);
      if (!await djRunsGroup(env, dj, group.id)) return html(403, signInPage(env));
      if (request.method === "POST") {
        const form = await request.formData().catch(() => null);
        // The cover, first: it is posted from the public page as well as this
        // one, and it is the only form here that arrives with a file on it.
        // The console asks for JSON so the picture can change without the page
        // going anywhere; a browser with no JavaScript posts the same form and
        // gets the redirect it expects.
        const wantsJson = (request.headers.get("accept") || "").includes("application/json");
        if (form && (form.get("shuffleCover") || form.get("clearCover") || form.get("cover"))) {
          const cover = await coverFromForm(env, form, group.cover_key);
          if (cover) {
            if (cover.error) {
              return wantsJson
                ? json(400, { error: cover.error })
                : notice("That picture did not take", cover.error);
            }
            await env.DB.prepare(`UPDATE groups SET cover_key = ?, updated_ms = ? WHERE id = ?`)
              .bind(cover.key, now, group.id).run();
            if (wantsJson) return json(200, { ok: true, coverUrl: mediaUrl(cover.key) });
            return new Response(null, {
              status: 302,
              headers: { location: `/@${group.handle}${form.get("fromPublic") ? "" : "/manage"}` },
            });
          }
        }
        // Renaming in place, from the pencil on the cover.
        if (wantsJson && form && form.has("groupName") && !form.has("handle")) {
          const wanted = String(form.get("groupName") || "").slice(0, 80).trim();
          if (!wanted) return json(400, { error: "a group needs a name" });
          await env.DB.prepare(`UPDATE groups SET name = ?, updated_ms = ? WHERE id = ?`)
            .bind(wanted, now, group.id).run();
          return json(200, { ok: true, name: wanted });
        }
        const invite = String((form && form.get("invite")) || "");
        if (invite) {
          const event = await env.DB.prepare(
            `SELECT * FROM events WHERE id = ? AND group_id = ?`
          ).bind(invite, group.id).first();
          if (!event) return notice("No such night", "It may have been removed.");
          const sent = await sendInvites(env, group, event, dj, base, now);
          return notice("Invitations queued", sent
            ? `${sent} ${sent === 1 ? "person" : "people"} will hear about it.`
            : "Everyone in the group has already had this one.");
        }
        if (form && form.get("pro")) {
          if (!stripeConfigured(env)) return notice("Not available yet", "Subscriptions are not configured.");
          const yearly = String(form.get("pro")) === "year";
          try {
            const session = await checkout(env, {
              account: "",
              amountCents: yearly ? PRO_YEARLY_CENTS : PRO_MONTHLY_CENTS,
              feeCents: 0,
              name: yearly ? "PartyParty Pro, one year" : "PartyParty Pro, one month",
              successUrl: `${base}/@${group.handle}/manage`,
              cancelUrl: `${base}/@${group.handle}/manage`,
              metadata: { proGroupId: group.id, period: yearly ? "year" : "month" },
              fetchImpl: env.FETCH || undefined,
            });
            return new Response(null, { status: 302, headers: { location: session.url } });
          } catch (e) {
            return notice("That did not go through", String(e.message || e));
          }
        }
        if (form && form.get("connectStripe")) {
          if (!stripeConfigured(env)) return notice("Not available yet", "Card payments are not configured.");
          try {
            const link = await accountLink(env, {
              account: group.stripe_acct || "",
              refreshUrl: `${base}/@${group.handle}/manage`,
              returnUrl: `${base}/@${group.handle}/manage`,
              fetchImpl: env.FETCH || undefined,
            });
            if (link.account !== group.stripe_acct) {
              await env.DB.prepare(`UPDATE groups SET stripe_acct = ?, updated_ms = ? WHERE id = ?`)
                .bind(link.account, now, group.id).run();
            }
            return new Response(null, { status: 302, headers: { location: link.url } });
          } catch (e) {
            return notice("Stripe said no", String(e.message || e));
          }
        }
        if (form && form.has("merchLink")) {
          const link = String(form.get("merchLink") || "").trim();
          const problem = payLinkProblem(link);
          if (problem) return notice("That link will not work", problem);
          await profileFor(env, dj.email_norm, now, dj.name);
          await env.DB.prepare(
            `UPDATE profiles SET merch_link = ?, merch_label = ?, updated_ms = ? WHERE email_norm = ?`
          ).bind(link, String(form.get("merchLabel") || "").slice(0, 40), now, dj.email_norm).run();
          return notice("Saved", link ? "Your store is linked." : "The store link is off.");
        }
        if (form && form.has("payLink")) {
          const link = String(form.get("payLink") || "").trim();
          const problem = payLinkProblem(link);
          if (problem) return notice("That link will not work", problem);
          await profileFor(env, dj.email_norm, now, dj.name);
          await env.DB.prepare(`UPDATE profiles SET pay_link = ?, updated_ms = ? WHERE email_norm = ?`)
            .bind(link, now, dj.email_norm).run();
          return notice("Saved", link ? "Guests can tip you now." : "Tipping is off.");
        }
        if (form && form.has("groupName")) {
          const newHandle = normalizeHandle(form.get("handle"));
          if (newHandle && newHandle !== group.handle) {
            const problem = handleProblem(newHandle);
            if (problem) return notice("That handle will not work", problem);
            if (!await claimHandle(env, newHandle)) return notice("That handle is taken", "Pick another.");
            try {
              await env.DB.prepare(`UPDATE groups SET handle = ? WHERE id = ?`)
                .bind(newHandle, group.id).run();
            } catch (e) {
              return notice("That handle is taken", "Pick another.");
            }
            await reserveHandle(env, newHandle);
            // The old handle stops answering. It stays reserved, so it is never
            // handed to a stranger, but nothing forwards: changing your address
            // changes your address.
          }
          await env.DB.prepare(`UPDATE groups SET name = ?, bio = ?, updated_ms = ? WHERE id = ?`)
            .bind(String(form.get("groupName") || "").slice(0, 80),
              String(form.get("bio") || "").slice(0, 500), now, group.id).run();
          return new Response(null, {
            status: 302,
            headers: { location: `/@${newHandle || group.handle}/manage` },
          });
        }
        if (form && form.has("djName")) {
          await env.DB.prepare(`UPDATE djs SET name = ? WHERE id = ?`)
            .bind(String(form.get("djName") || "").slice(0, 60), dj.id).run();
          return new Response(null, { status: 302, headers: { location: `/@${group.handle}/manage` } });
        }
        const pair = String((form && form.get("pair")) || "").trim().toUpperCase();
        if (pair) {
          const code = await env.DB.prepare(
            `SELECT * FROM install_codes WHERE code = ? AND used_ms IS NULL AND expires_ms > ?`
          ).bind(pair, now).first();
          if (!code) return notice("That code has expired", "The Mac shows a fresh one every few minutes.");
          await env.DB.prepare(`UPDATE install_codes SET used_ms = ? WHERE code = ?`).bind(now, pair).run();
          // Same rule as the link page: the Mac becomes the PERSON'S, not this
          // group's. Typing the code here is just another way of saying "that
          // Mac is mine" from a page you happened to already have open.
          await env.DB.prepare(
            `INSERT INTO install_accounts (install_id, email_norm, linked_ms) VALUES (?, ?, ?)
             ON CONFLICT(install_id) DO UPDATE SET email_norm = excluded.email_norm,
               linked_ms = excluded.linked_ms`
          ).bind(code.install_id, dj.email_norm, now).run();
          return notice("That Mac is yours", "It is signed in as you.");
        }
        const say = String((form && form.get("say")) || "");
        if (say) {
          const mailed = await addPost(env, { group, dj, body: say, base, now });
          return notice("Posted", mailed
            ? `${mailed} ${mailed === 1 ? "person" : "people"} asked to hear every post.`
            : "It is on the group's page.");
        }
        const title = String((form && form.get("title")) || "").slice(0, 120);
        const startsRaw = String((form && form.get("starts")) || "");
        const starts = startsRaw ? Date.parse(startsRaw + "Z") : null;
        const capacity = Math.max(0, Math.min(100000, parseInt(String((form && form.get("capacity")) || "0"), 10) || 0));
        // Through createParty like everything else, so it carries an owner. A
        // raw insert here made parties that belonged to nobody.
        await createParty(env, group, {
          ownerEmail: dj.email_norm, title,
          startsMs: Number.isFinite(starts) ? starts : null,
          place: (form && form.get("place")) || "", capacity,
        }, now);
        return new Response(null, { status: 302, headers: { location: `/@${group.handle}/manage` } });
      }
      const events = await upcomingEvents(env, group.id, 0);
      const meNow = await profileFor(env, dj.email_norm, now, dj.name);
      const payLinkNow = meNow.pay_link || "";
      const merchNow = { link: meNow.merch_link || "", label: meNow.merch_label || "" };
      const pro = await isPro(env, group.id);
      const members = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND state = 'joined'`
      ).bind(group.id).first();
      const night = (e) => {
        const link = `${base}/@${group.handle}/${e.slug}`;
        return `<div class="card">
          <div class="when">${esc(whenText(e))}</div>
          <strong>${esc(e.title || "Untitled")}</strong>
          ${e.place ? `<div class="muted">${esc(e.place)}</div>` : ""}
          <div class="linkrow">
            <input class="linkbox" type="text" readonly value="${esc(link)}"
              onclick="this.select()" aria-label="Link to this night">
            <button class="btn plain copy" type="button" data-copy="${esc(link)}">Copy</button>
          </div>
          <div class="row">
            <form method="post" action="/@${esc(group.handle)}/manage">
              <input type="hidden" name="invite" value="${esc(e.id)}">
              <button class="btn plain" type="submit">Email the group</button>
            </form>
            <a class="btn plain" href="/@${esc(group.handle)}/${esc(e.slug)}/door">At the door</a>
          </div>
        </div>`;
      };

      // One job on the surface: add a night, get its link, send it. Everything
      // else a DJ configures once - money, merch, a paired Mac - is real but is
      // not what they came here to do, so it waits behind one summary.
      return html(200, page(group.name || group.handle, `
        <p class="muted"><a class="muted" href="/@${esc(group.handle)}">partyparty.party/@${esc(group.handle)}</a>
          · ${Number((members && members.n) || 0)} ${Number((members && members.n) || 0) === 1 ? "member" : "members"}</p>

        <a class="actionbar" href="/@${esc(group.handle)}/new">
          <span class="tile">\u2728</span>
          <span class="lines">Create a party<small>Name it, pick a picture, get the link</small></span>
        </a>

        ${events.length ? `<h2>Parties</h2>${events.map(night).join("")}`
          : `<p class="muted">No parties yet. The link to send comes with the first one.</p>`}

        <details class="settings">
          <summary>Settings</summary>
          <h2>This group</h2>
          <form class="newnight" method="post" action="/@${esc(group.handle)}/manage">
            <input type="text" name="groupName" placeholder="Name" value="${esc(group.name || "")}" required>
            <input type="text" name="handle" placeholder="handle" value="${esc(group.handle)}">
            <input type="text" name="bio" placeholder="A line about your nights" value="${esc(group.bio || "")}">
            <button class="btn plain" type="submit">Save</button>
          </form>
          <p class="muted">Changing the handle changes your address. Links to the old
          one stop working.</p>

          <h2>Pair a Mac</h2>
          <p class="muted">Type the code the Mac shows, and its parties find your nights.</p>
          <form class="join" method="post" action="/@${esc(group.handle)}/manage">
            <input type="text" name="pair" placeholder="Code from the Mac" required>
            <button class="btn plain" type="submit">Pair</button>
          </form>

          <h2>Tips</h2>
          <p class="muted">Your own link. It goes straight to you; we take nothing.</p>
          <form class="join" method="post" action="/@${esc(group.handle)}/manage">
            <input type="text" name="payLink" placeholder="Your Venmo, Revolut or PayPal link"
              value="${esc(payLinkNow)}">
            <button class="btn plain" type="submit">Save</button>
          </form>

          <h2>Merch</h2>
          <form class="join" method="post" action="/@${esc(group.handle)}/manage">
            <input type="text" name="merchLink" placeholder="Link to your store"
              value="${esc(merchNow.link)}">
            <input type="text" name="merchLabel" placeholder="Label, e.g. Shirts"
              value="${esc(merchNow.label)}">
            <button class="btn plain" type="submit">Save</button>
          </form>

          <h2>Selling tickets</h2>
          <p class="muted">${group.stripe_acct
            ? "Connected. Money goes to your own Stripe account; we never hold it."
            : "Optional, and only if you charge. Your own Stripe account."}</p>
          <form class="join" method="post" action="/@${esc(group.handle)}/manage">
            <input type="hidden" name="connectStripe" value="1">
            <button class="btn plain" type="submit">${group.stripe_acct ? "Manage" : "Connect Stripe"}</button>
          </form>

          <h2>Pro</h2>
          <p class="muted">${pro
            ? "On. We take nothing from your tickets."
            : "$12 a month or $99 a year, and we stop taking 5% of your tickets."}</p>
          ${pro ? "" : `<form class="join" method="post" action="/@${esc(group.handle)}/manage">
            <button class="btn plain" type="submit" name="pro" value="month">$12 a month</button>
            <button class="btn plain" type="submit" name="pro" value="year">$99 a year</button>
          </form>`}

          <p class="muted"><a class="muted" href="/settings">Your own settings</a></p>
        </details>
        <script>
        // Copying the link is the whole point of the page, so it says it worked.
        for (const button of document.querySelectorAll('.copy')) {
          button.addEventListener('click', async () => {
            try {
              await navigator.clipboard.writeText(button.dataset.copy);
              const was = button.textContent;
              button.textContent = 'Copied';
              setTimeout(() => { button.textContent = was; }, 1500);
            } catch (e) {
              button.previousElementSibling.select();
            }
          });
        }
        </script>
        ${coverScript(`/@${esc(group.handle)}/manage`)}
      `, hero(group.name || group.handle, "", group.cover_key,
          `<a href="/@${esc(group.handle)}">The public page</a>`,
          coverTools(`/@${group.handle}/manage`), true),
        peopleRail(await groupPeople(env, group.id), base, group.handle)));
    }

    // A group's calendar. Subscribed once, correct forever after - which is why
    // it is a first-class URL and not a download.
    match = path.match(/^\/(?:@|calendar\/)([a-z0-9]+)\.ics$/);
    if (match) {
      const group = await groupByHandle(env, match[1]);
      if (!group) return new Response("Not Found", { status: 404 });
      const events = await upcomingEvents(env, group.id, 0);
      return new Response(icsFor(group, events, base), {
        headers: {
          "content-type": "text/calendar;charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }

    match = path.match(/^\/@([a-z0-9]+)\/([a-z0-9-]+)\.ics$/);
    if (match) {
      const group = await groupByHandle(env, match[1]);
      if (!group) return new Response("Not Found", { status: 404 });
      return new Response(icsFor(group, [event], base), {
        headers: {
          "content-type": "text/calendar;charset=utf-8",
          "content-disposition": `attachment; filename="${event.slug}.ics"`,
        },
      });
    }

    // Confirming an address. Nothing else happens here: the membership already
    // exists, because someone who typed their address into a join form has said
    // what they want and should not lose it if they never open the mail.
    match = path.match(/^\/j\/([a-f0-9]{48})$/);
    if (match) {
      const token = await readToken(env, match[1], ["confirm"], now);
      if (!token) return notice("That link has expired", "Ask for a new one from the group's page.");
      await env.DB.prepare(`UPDATE members SET confirmed_ms = ? WHERE id = ? AND confirmed_ms IS NULL`)
        .bind(now, token.member_id).run();
      await env.DB.prepare(`UPDATE tokens SET used_ms = ? WHERE id = ?`).bind(now, token.id).run();
      const group = token.group_id
        ? await env.DB.prepare(`SELECT * FROM groups WHERE id = ?`).bind(token.group_id).first()
        : null;
      return notice("You're in", group
        ? `You'll hear about ${group.name || group.handle}'s nights.`
        : "Your address is confirmed.");
    }

    // Everything a member can do to their own membership, from one link that
    // keeps working. No account, no password, no asking the DJ.
    match = path.match(/^\/m\/([a-f0-9]{48})$/);
    if (match) {
      const token = await readToken(env, match[1], ["manage"], now);
      if (!token) return notice("That link has expired", "Any newer message from the group has a fresh one.");
      const action = url.searchParams.get("stop") ? "stop"
        : (url.searchParams.get("do") || "");
      const group = token.group_id
        ? await env.DB.prepare(`SELECT * FROM groups WHERE id = ?`).bind(token.group_id).first()
        : null;

      if (action === "stop" || action === "unsubscribe") {
        // Platform-wide, as the header promises. Leaving one group is a
        // different, smaller thing and has its own action.
        await env.DB.prepare(`UPDATE members SET suppressed_ms = ? WHERE id = ?`).bind(now, token.member_id).run();
        return notice("No more email", "We have stopped every message from every group.");
      }
      if (action === "leave" && group) {
        await env.DB.prepare(
          `UPDATE group_members SET state = 'left', left_ms = ? WHERE group_id = ? AND member_id = ?`
        ).bind(now, group.id, token.member_id).run();
        return notice("You've left", `You are no longer in ${group.name || group.handle}.`);
      }
      if ((action === "all" || action === "events" || action === "none") && group) {
        await env.DB.prepare(
          `UPDATE group_members SET volume = ? WHERE group_id = ? AND member_id = ?`
        ).bind(action, group.id, token.member_id).run();
        return notice("Saved", action === "none"
          ? "Muted. You stay in the group and can still open its page any time."
          : action === "all" ? "You'll hear every post." : "You'll hear about nights only.");
      }
      if (action.startsWith("block:")) {
        const djId = action.slice(6);
        const dj = await env.DB.prepare(`SELECT id FROM djs WHERE id = ?`).bind(djId).first();
        if (dj) {
          await env.DB.prepare(
            `INSERT OR IGNORE INTO blocks (member_id, dj_id, created_ms) VALUES (?, ?, ?)`
          ).bind(token.member_id, dj.id, now).run();
        }
        return notice("Blocked", "You will not get invitations from them. You are still in the group.");
      }

      // Posting from here is gone with groups. A thread belonging to a group,
      // mailed to its members, cannot survive a product with no groups in it -
      // and photos and words belong to the night they happened at, which is
      // where they are now. This link's remaining job is how much you hear.
      const link = (q, label) => `<p><a class="btn plain" href="/m/${match[1]}?do=${q}">${esc(label)}</a></p>`;
      return html(200, page("Your settings", `
        <h1>Your settings</h1>
        <h2>How much you hear</h2>
        ${link("all", "Every post")}
        ${link("events", "Only nights")}
        ${link("none", "Nothing, but stay in the group")}
        <h2>Leaving</h2>
        ${group ? link("leave", `Leave ${group.name || group.handle}`) : ""}
        ${link("stop", "Stop all email from PartyParty")}
      `));
    }

    // Saying you are coming, from an emailed link rather than a form.
    match = path.match(/^\/g\/([a-f0-9]{48})$/);
    if (match) {
      const token = await readToken(env, match[1], ["going"], now);
      if (!token || !token.event_id) return notice("That link has expired", "Open the night's page instead.");
      const state = url.searchParams.get("no") ? "not" : "going";
      await env.DB.prepare(
        `INSERT INTO signups (event_id, member_id, state, created_ms, updated_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(event_id, member_id) DO UPDATE SET state = ?, updated_ms = ?`
      ).bind(token.event_id, token.member_id, state, now, now, state, now).run();
      return notice(state === "going" ? "See you there" : "Thanks for saying",
        state === "going" ? "It's in your calendar link on the night's page." : "You are marked as not coming.");
    }

    // Joining a group from its page.
    // Following a PERSON. Membership of a group was how this worked and groups
    // are dead; the follow is recorded against the two people, and privately -
    // whether it is anybody else's business is the follower's to decide.
    match = path.match(/^\/@([a-z0-9]+)\/join$/);
    if (match && request.method === "POST") {
      const them = await profileByHandle(env, match[1]);
      const group = await groupByHandle(env, match[1]);
      if (!them && !group) return new Response("Not Found", { status: 404 });
      const form = await request.formData().catch(() => null);
      const emailNorm = normalizeEmail(form && form.get("email"));
      if (!emailNorm) return notice("That address did not look right", "Go back and try again.");
      if (them && them.email_norm !== emailNorm) {
        await env.DB.prepare(
          `INSERT OR IGNORE INTO follows (follower_email, person_email, public, created_ms)
           VALUES (?,?,0,?)`
        ).bind(emailNorm, them.email_norm, now).run();
      }
      // The confirmation email, and the settings link in it, still ride on the
      // member record. That machinery outlives groups; it is how somebody with
      // no account hears anything at all.
      if (group) {
        await joinGroup(env, group, emailNorm,
          String((form && form.get("name")) || "").slice(0, 60), "link", base, now);
      }
      return notice("Check your email", `We sent one message to ${emailNorm}. Tap the link in it and you are in.`);
    }

    // Saying you are coming, from the night's own page.
    match = path.match(/^\/@([a-z0-9]+)\/([a-z0-9-]+)\/going$/);
    if (match && request.method === "POST") {
      const at = await partyAt(env, match[1], match[2]);
      if (!at) return new Response("Not Found", { status: 404 });
      const event = at.event;
      const group = await env.DB.prepare(`SELECT * FROM groups WHERE id = ?`)
        .bind(event.group_id).first();
      if (!group) return new Response("Not Found", { status: 404 });
      const form = await request.formData().catch(() => null);
      const emailNorm = normalizeEmail(form && form.get("email"));
      if (!emailNorm) return notice("That address did not look right", "Go back and try again.");
      const member = await upsertMember(env, emailNorm, String((form && form.get("name")) || "").slice(0, 60), now);
      const already = await env.DB.prepare(
        `SELECT state FROM signups WHERE event_id = ? AND member_id = ?`
      ).bind(event.id, member.id).first();
      if (!already || already.state !== "going") {
        if (await spaceLeft(env, event) <= 0) {
          return notice("This one is full", "Nothing more we can do here - ask the DJ.");
        }
      }
      await env.DB.prepare(
        `INSERT INTO signups (event_id, member_id, state, created_ms, updated_ms)
         VALUES (?, ?, 'going', ?, ?)
         ON CONFLICT(event_id, member_id) DO UPDATE SET state = 'going', updated_ms = ?`
      ).bind(event.id, member.id, now, now, now).run();
      const manage = await mintToken(env, { memberId: member.id, groupId: group.id, purpose: "manage", now });
      await queueMail(env, {
        to: emailNorm,
        subject: `You're coming to ${event.title || group.name || group.handle}`,
        text: `${whenText(event)}\n${[event.place, event.address].filter(Boolean).join("\n")}\n\n`
          + `Your code at the door: ${await entryCode(event.id, member.id)}\n\n`
          + `The night: ${base}/@${group.handle}/${event.slug}\n`
          + `Add to your calendar: ${base}/@${group.handle}/${event.slug}.ics\n\n`
          + `Settings: ${base}/m/${manage}`,
        kind: "ticket",
        groupId: group.id,
        eventId: event.id,
        ics: `${base}/@${group.handle}/${event.slug}.ics`,
        unsubscribe: `${base}/m/${manage}?stop=1`,
        now,
      });
      return notice("See you there", "We emailed you the details and a calendar link.");
    }

    match = path.match(/^\/@([a-z0-9]+)\/([a-z0-9-]+)\/buy$/);
    if (match && request.method === "POST") {
      const at = await partyAt(env, match[1], match[2]);
      if (!at) return new Response("Not Found", { status: 404 });
      const event = at.event;
      const group = await env.DB.prepare(`SELECT * FROM groups WHERE id = ?`)
        .bind(event.group_id).first();
      if (!group) return new Response("Not Found", { status: 404 });
      if (event.state === "draft" || !event.ticket_cents) {
        return new Response("Not Found", { status: 404 });
      }
      if (!group.stripe_acct || !stripeConfigured(env)) {
        return notice("Tickets are not on sale", "The DJ has not connected a payment account.");
      }
      if (await spaceLeft(env, event) <= 0) return notice("This one is full", "Ask the DJ.");
      const formData = await request.formData().catch(() => null);
      const emailNorm = normalizeEmail(formData && formData.get("email"));
      if (!emailNorm) return notice("That address did not look right", "Go back and try again.");
      const member = await upsertMember(env, emailNorm, "", now);
      const price = totalForBuyer(event.ticket_cents, await takeRateFor(env, group.id));
      try {
        const session = await checkout(env, {
          account: group.stripe_acct,
          amountCents: price.total,
          feeCents: price.ours,
          name: `${event.title || group.name || group.handle}`,
          successUrl: `${base}/@${group.handle}/${event.slug}`,
          cancelUrl: `${base}/@${group.handle}/${event.slug}`,
          metadata: { eventId: event.id, memberId: member.id },
          fetchImpl: env.FETCH || undefined,
        });
        return new Response(null, { status: 302, headers: { location: session.url } });
      } catch (e) {
        return notice("That did not go through", String(e.message || e));
      }
    }

    // Stripe telling us a ticket was paid for. Unverified, this route is a POST
    // from anybody claiming exactly that.
    if (path === "/api/v1/stripe/webhook" && request.method === "POST") {
      const payload = await request.text();
      const ok = await verifyWebhook(env.STRIPE_WEBHOOK_SECRET, request.headers.get("stripe-signature"), payload, now);
      if (!ok) return json(403, { error: "signature" });
      let body = {};
      try { body = JSON.parse(payload); } catch (e) { return json(400, { error: "bad json" }); }
      const object = (body.data && body.data.object) || {};
      // A subscription that lapses has to switch the fee back on, or Pro is
      // permanent for anyone who cancels.
      if (body.type === "customer.subscription.deleted") {
        await env.DB.prepare(
          `UPDATE entitlements SET state = 'lapsed', updated_ms = ? WHERE source = 'web' AND reference = ?`
        ).bind(now, String(object.id || "")).run();
        return json(200, { ok: true });
      }
      if (body.type !== "checkout.session.completed") return json(200, { ignored: true });
      const session = object;
      const meta = session.metadata || {};
      if (meta.proGroupId) {
        const period = meta.period === "year" ? 365 : 31;
        await env.DB.prepare(
          `INSERT INTO entitlements (group_id, source, state, reference, renews_ms, updated_ms)
           VALUES (?, 'web', 'active', ?, ?, ?)
           ON CONFLICT(group_id, source) DO UPDATE SET state = 'active',
             reference = excluded.reference, renews_ms = excluded.renews_ms, updated_ms = excluded.updated_ms`
        ).bind(meta.proGroupId, String(session.subscription || session.id || ""),
          now + period * 24 * 60 * 60 * 1000, now).run();
        return json(200, { ok: true });
      }
      if (!meta.eventId || !meta.memberId) return json(200, { ignored: true });
      await env.DB.prepare(
        `INSERT INTO signups (event_id, member_id, state, created_ms, updated_ms)
         VALUES (?, ?, 'going', ?, ?)
         ON CONFLICT(event_id, member_id) DO UPDATE SET state = 'going', updated_ms = ?`
      ).bind(meta.eventId, meta.memberId, now, now, now).run();
      await env.DB.prepare(
        `INSERT INTO tickets (id, event_id, member_id, code, amount, stripe_payment, state)
         VALUES (?, ?, ?, ?, ?, ?, 'paid') ON CONFLICT(id) DO NOTHING`
      ).bind(String(session.id || ulid(now)).slice(0, 80), meta.eventId, meta.memberId,
        await entryCode(meta.eventId, meta.memberId), Number(session.amount_total || 0),
        String(session.payment_intent || "")).run();
      return json(200, { ok: true });
    }

    // Saying something on the group's own page. Signed in only - the way a
    // member without an account posts is the link in their own email, which
    // already carries who they are and needs no password.
    match = path.match(/^\/@([a-z0-9]+)\/([a-z0-9-]+)\/say$/);
    if (match && request.method === "POST") {
      const at = await partyAt(env, match[1], match[2]);
      if (!at) return new Response("Not Found", { status: 404 });
      const event = at.event;
      const group = await env.DB.prepare(`SELECT * FROM groups WHERE id = ?`)
        .bind(event.group_id).first();
      if (!group) return new Response("Not Found", { status: 404 });
      const viewer = await viewerOf(env, request, group, now);
      if (!viewer || (!viewer.runsThisGroup && !viewer.follows)) {
        return notice("Not yours to post to", "Ask for the link to this party.");
      }
      const form = await request.formData().catch(() => null);
      if (!form) return notice("That did not post", "Try again.");

      // Photos and video both, and neither is transcoded - a Worker is not the
      // place for that, so the cap is the whole policy.
      let mediaKey = null;
      let mediaType = null;
      const file = form.get("media");
      if (file && typeof file.arrayBuffer === "function" && Number(file.size) > 0) {
        const stored = await storeMedia(env, file, "posts", MAX_COVER, true);
        if (stored.error) return notice("That did not post", stored.error);
        mediaKey = stored.key;
        mediaType = stored.type;
      }

      const member = viewer.runsThisGroup
        ? null
        : await memberByEmail(env, viewer.dj.email_norm);
      await addPost(env, {
        group,
        event,
        dj: viewer.runsThisGroup ? viewer.dj : null,
        member,
        body: form.get("say"),
        mediaKey,
        mediaType,
        base,
        now,
      });
      return new Response(null, {
        status: 302, headers: { location: `/@${group.handle}/${event.slug}` },
      });
    }

    // A night.
    match = path.match(/^\/@([a-z0-9]+)\/([a-z0-9-]+)$/);
    if (match) {
      const at = await partyAt(env, match[1], match[2]);
      if (!at) return new Response("Not Found", { status: 404 });
      const event = at.event;
      if (event.state === "draft") return new Response("Not Found", { status: 404 });
      const group = await env.DB.prepare(`SELECT * FROM groups WHERE id = ?`)
        .bind(event.group_id).first();
      if (!group) return new Response("Not Found", { status: 404 });
      const viewer = await currentDJ(env, request, now);
      // The tracker is the signed-in person's own record OF this party -
      // available whether or not the party is theirs, because going to
      // somebody else's night is the commonest case there is.
      const tracker = viewer
        ? trackerBlock(event, group,
            await myPartyNote(env, viewer.email_norm, event.id),
            await partyPeople(env, viewer.email_norm, event.id),
            await peopleFor(env, viewer.email_norm, ""),
            await songsFor(env, event.id))
        : "";
      const mineToKeep = !!viewer && viewer.email_norm === event.owner_email;
      // Private means private. A night nobody has been given is not on the
      // internet for anybody who guesses its address.
      const visibility = event.visibility || "private";
      if (!mineToKeep && visibility === "private" &&
          !await djRunsGroup(env, viewer, group.id)) {
        return new Response("Not Found", { status: 404 });
      }
      const owner = event.owner_email
        ? await profileFor(env, event.owner_email, now) : null;
      return html(200, eventPage(group, event, await goingCount(env, event.id), base,
        await takeRateFor(env, group.id),
        mineToKeep || await djRunsGroup(env, viewer, group.id), tracker,
        {
          ownerName: owner ? (owner.name || "@" + owner.handle) : group.handle,
          billed: mineToKeep ? [] : await partyPeople(env, event.owner_email, event.id),
          setlist: mineToKeep ? [] : await songsFor(env, event.id),
          live: liveNow(event, now), phase: partyPhase(event, now),
          posts: await eventPosts(env, event.id),
          // Whoever it belongs to, and whoever they let in. The tracker above
          // is private; this is the part of a party other people can add to.
          canPost: mineToKeep || visibility !== "private",
          // Tipping belongs to whoever threw it, wherever their page is.
          payLink: event.owner_email
            ? (await profileFor(env, event.owner_email, now)).pay_link : "",
        }));
    }

    // Editing the party from the web. The same fields, the same updateParty and
    // the same rules as the Mac's own edit route - one party, two clients.
    match = path.match(/^\/@([a-z0-9]+)\/([a-z0-9-]+)\/edit$/);
    if (match && request.method === "POST") {
      const at = await partyAt(env, match[1], match[2]);
      if (!at) return new Response("Not Found", { status: 404 });
      const event = at.event;
      const group = await env.DB.prepare(`SELECT * FROM groups WHERE id = ?`)
        .bind(event.group_id).first();
      if (!group) return new Response("Not Found", { status: 404 });
      const dj = await currentDJ(env, request, now);
      if (!await djRunsGroup(env, dj, group.id)) {
        return html(403, signInPage(env, "Sign in", `/@${match[1]}/${match[2]}`));
      }
      const form = await request.formData().catch(() => null);
      if (!form) return notice("That did not save", "Try again.");

      // Re-rendering the whole page with the form still filled in, rather than
      // a bare error page with a Back button that loses what was typed.
      const refuse = async (why) => html(200, eventPage(group, event,
        await goingCount(env, event.id), base, await takeRateFor(env, group.id),
        true,
        trackerBlock(event, group,
          await myPartyNote(env, dj.email_norm, event.id),
          await partyPeople(env, dj.email_norm, event.id),
          await peopleFor(env, dj.email_norm, ""),
          await songsFor(env, event.id)),
        { live: liveNow(event, now), phase: partyPhase(event, now),
          editError: why, typed: form, posts: await eventPosts(env, event.id), canPost: true }));

      const dayRaw = String(form.get("day") || "");
      const starts = dayRaw ? Date.parse(dayRaw + "T12:00:00Z") : null;
      if (dayRaw && !Number.isFinite(starts)) {
        return refuse("That date did not make sense.");
      }
      const done = await updateParty(env, event, {
        title: form.get("title"),
        startsMs: dayRaw ? starts : null,
        place: form.get("place"),
        links: form.get("links"),
      }, now);
      if (done.error) return refuse(done.error);
      return new Response(null, {
        status: 302, headers: { location: `/@${group.handle}/${event.slug}` },
      });
    }

    // Writing the record: went/note, adding a person, an encounter note, or
    // removing somebody. All of it belongs to whoever is signed in.
    match = path.match(/^\/@([a-z0-9]+)\/([a-z0-9-]+)\/record$/);
    if (match && request.method === "POST") {
      const at = await partyAt(env, match[1], match[2]);
      if (!at) return new Response("Not Found", { status: 404 });
      const event = at.event;
      const group = await env.DB.prepare(`SELECT * FROM groups WHERE id = ?`)
        .bind(event.group_id).first();
      if (!group) return new Response("Not Found", { status: 404 });
      const dj = await currentDJ(env, request, now);
      if (!dj) return html(200, signInPage(env, "Sign in", `/@${match[1]}/${match[2]}`));
      const form = await request.formData().catch(() => null);
      if (!form) return notice("That did not save", "Try again.");
      const back = `/@${group.handle}/${event.slug}`;

      // Somebody new on the bill or in the room.
      const who = String(form.get("who") || "").trim();
      if (who) {
        const role = form.get("role") === "dj" ? "dj" : "guest";
        let added = 0;
        for (const name of who.split(/,| and /i)) {
          const person = await findOrMakePerson(env, dj.email_norm, name, now);
          if (!person) continue;
          await env.DB.prepare(
            `INSERT INTO party_people (event_id, person_id, owner_email, role, created_ms)
             VALUES (?,?,?,?,?)
             ON CONFLICT(event_id, person_id) DO UPDATE SET role = excluded.role`
          ).bind(event.id, person.id, dj.email_norm, role, now).run();
          added++;
        }
        if (!added) return notice("That needs a name", "Type who it was.");
        return new Response(null, { status: 302, headers: { location: back } });
      }

      // Who may see it. One tap, three answers, no dialog.
      const wantSeen = String(form.get("visibility") || "");
      if (["private", "link", "public"].includes(wantSeen)) {
        if (event.owner_email === dj.email_norm) {
          await env.DB.prepare(`UPDATE events SET visibility = ?, updated_ms = ? WHERE id = ?`)
            .bind(wantSeen, now, event.id).run();
        }
        return new Response(null, { status: 302, headers: { location: back } });
      }

      // The capture line: one thing typed, one word for what it is.
      const it = String(form.get("it") || "").trim();
      const as = String(form.get("as") || "");
      if (it && as) {
        if (as === "song") {
          const artistPart = it.split(" by ");
          const titles = artistPart[0];
          for (const one of titles.split(/,| and /i)) {
            await addSong(env, dj.email_norm, event.id,
              { title: one, artist: artistPart[1] || "" }, now);
          }
        } else {
          for (const name of it.split(/,| and /i)) {
            const person = await findOrMakePerson(env, dj.email_norm, name, now);
            if (!person) continue;
            await env.DB.prepare(
              `INSERT INTO party_people (event_id, person_id, owner_email, role, created_ms)
               VALUES (?,?,?,?,?)
               ON CONFLICT(event_id, person_id) DO UPDATE SET role = excluded.role`
            ).bind(event.id, person.id, dj.email_norm, as === "dj" ? "dj" : "guest", now).run();
          }
        }
        return new Response(null, { status: 302, headers: { location: back } });
      }

      // A song, as it plays. One field and a button: anything more and it does
      // not get written down while the room is dark and loud.
      const songTitle = String(form.get("songTitle") || "").trim();
      if (songTitle) {
        // "Windowlicker, Xtal, Papua New Guinea" is one thing somebody types.
        const artist = form.get("songArtist");
        for (const one of songTitle.split(",")) {
          await addSong(env, dj.email_norm, event.id, { title: one, artist }, now);
        }
        return new Response(null, { status: 302, headers: { location: back } });
      }
      const songId = String(form.get("song") || "");
      if (songId) {
        await env.DB.prepare(`DELETE FROM songs WHERE id = ? AND owner_email = ?`)
          .bind(songId, dj.email_norm).run();
        return new Response(null, { status: 302, headers: { location: back } });
      }

      // An encounter note, or removing somebody recorded by mistake.
      const personId = String(form.get("person") || "");
      if (personId) {
        if (form.get("remove")) {
          await env.DB.prepare(
            `DELETE FROM party_people WHERE event_id = ? AND person_id = ? AND owner_email = ?`
          ).bind(event.id, personId, dj.email_norm).run();
          // A misspelled name, taken back off the only party it was ever on and
          // never written about, is a typo rather than somebody I know. Leaving
          // it would fill the people list with ghosts nobody can explain. A
          // person with any encounter left, or a note, is kept.
          await env.DB.prepare(
            `DELETE FROM people WHERE id = ? AND owner_email = ? AND note = ''
               AND NOT EXISTS (SELECT 1 FROM party_people WHERE person_id = ?)`
          ).bind(personId, dj.email_norm, personId).run();
        } else {
          await env.DB.prepare(
            `UPDATE party_people SET note = ?
              WHERE event_id = ? AND person_id = ? AND owner_email = ?`
          ).bind(String(form.get("encounter") || "").slice(0, 2000),
            event.id, personId, dj.email_norm).run();
        }
        return new Response(null, { status: 302, headers: { location: back } });
      }

      // Went, and what I thought.
      await setPartyNote(env, dj.email_norm, event.id, {
        note: form.get("note"),
        attended: form.get("attended") ? 1 : 0,
      }, now);
      return new Response(null, { status: 302, headers: { location: back } });
    }

    // A night's cover. Its own route because the night's page is public and
    // this is the one thing on it only the DJ may do.
    match = path.match(/^\/@([a-z0-9]+)\/([a-z0-9-]+)\/cover$/);
    if (match && request.method === "POST") {
      const at = await partyAt(env, match[1], match[2]);
      if (!at) return new Response("Not Found", { status: 404 });
      const event = at.event;
      const group = await env.DB.prepare(`SELECT * FROM groups WHERE id = ?`)
        .bind(event.group_id).first();
      if (!group) return new Response("Not Found", { status: 404 });
      const dj = await currentDJ(env, request, now);
      if (!await djRunsGroup(env, dj, group.id)) return html(403, signInPage(env));
      const form = await request.formData().catch(() => null);
      const cover = form && await coverFromForm(env, form, event.cover_key);
      if (cover && cover.error) return notice("That picture did not take", cover.error);
      if (cover) {
        await env.DB.prepare(`UPDATE events SET cover_key = ?, updated_ms = ? WHERE id = ?`)
          .bind(cover.key, now, event.id).run();
      }
      return new Response(null, {
        status: 302,
        headers: { location: `/@${group.handle}/${event.slug}` },
      });
    }

    // A group, or failing that a person - one namespace, so /@x means exactly
    // one thing and a group can never be shadowed by somebody's @name.
    match = path.match(/^\/@([a-z0-9]+)$/);
    if (match) {
      // A person. Groups are dead: an address that was a group's handle still
      // resolves, to the person who owned it, showing the same parties - the
      // rows never belonged to the group in the first place.
      let profile = await profileByHandle(env, match[1]);
      if (!profile) {
        const group = await groupByHandle(env, match[1]);
        const owner = group && await env.DB.prepare(
          `SELECT d.email_norm FROM group_djs gd JOIN djs d ON d.id = gd.dj_id
            WHERE gd.group_id = ? ORDER BY gd.created_ms LIMIT 1`
        ).bind(group.id).first();
        if (owner) profile = await profileFor(env, owner.email_norm, now);
      }
      if (!profile) return new Response("Not Found", { status: 404 });
      const mine = await partiesOwnedBy(env, profile.email_norm, now);
      const viewer = await currentDJ(env, request, now);
      // Following is still stored as membership of the person's own group while
      // that table exists. The model pass makes it person-to-person; the button
      // means the same thing either way.
      const home = await env.DB.prepare(
        `SELECT g.handle FROM groups g JOIN group_djs gd ON gd.group_id = g.id
           JOIN djs d ON d.id = gd.dj_id
          WHERE d.email_norm = ?
          ORDER BY CASE WHEN g.handle = ? THEN 0 ELSE 1 END, g.created_ms LIMIT 1`
      ).bind(profile.email_norm, profile.handle).first();
      const following = viewer ? await env.DB.prepare(
        `SELECT 1 AS yes FROM follows WHERE follower_email = ? AND person_email = ?`
      ).bind(viewer.email_norm, profile.email_norm).first() : null;
      return html(200, personPage(profile, mine.upcoming, mine.past,
        !!viewer && viewer.email_norm === profile.email_norm, base,
        home && home.handle, !!following));
    }

    return new Response("Not Found", { status: 404 });
  },

  // The day-of nudge, so nobody has to remember to send it and the DJ stops
  // being an information desk. Only people who said they are coming, only once
  // each, and only for nights that are actually happening.
  async scheduled(event, env) {
    const now = Date.now();
    const base = String(env.PUBLIC_BASE || "").replace(/\/$/, "") || "https://partyparty.party";
    await drainOutbox(env, now);
    const { results } = await env.DB.prepare(
      `SELECT e.*, g.handle, g.name AS group_name FROM events e JOIN groups g ON g.id = e.group_id
        WHERE e.state = 'announced' AND e.starts_ms IS NOT NULL
          AND e.starts_ms > ? AND e.starts_ms < ?`
    ).bind(now, now + 24 * 60 * 60 * 1000).all();

    for (const night of results || []) {
      const { results: coming } = await env.DB.prepare(
        `SELECT m.id, m.email_norm FROM signups s JOIN members m ON m.id = s.member_id
          WHERE s.event_id = ? AND s.state = 'going' AND m.suppressed_ms IS NULL`
      ).bind(night.id).all();
      for (const member of coming || []) {
        if (await alreadySent(env, "reminder", night.id, member.email_norm)) continue;
        const manage = await mintToken(env, {
          memberId: member.id, groupId: night.group_id, purpose: "manage", now,
        });
        await queueMail(env, {
          to: member.email_norm,
          subject: `Tonight: ${night.title || night.group_name || night.handle}`,
          text: `${whenText(night)}\n${[night.place, night.address].filter(Boolean).join("\n")}\n\n`
            + `${base}/@${night.handle}/${night.slug}\n\nSettings: ${base}/m/${manage}`,
          kind: "reminder",
          groupId: night.group_id,
          eventId: night.id,
          unsubscribe: `${base}/m/${manage}?stop=1`,
          now,
        });
      }
    }
  },
};
