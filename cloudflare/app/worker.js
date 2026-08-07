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
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(group.name || group.handle)}`,
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
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

// ------------------------------------------------------------------- pages

const STYLE = `
/* The values and the SHAPES that web/listener.html ships: Geist, #ff2d55, the
   warm party gradient behind a hero, floating round chrome over it, heavy
   weights, and one big action bar. Copied from the page, not from a document. */
@font-face{font-family:Geist;src:url(/fonts/Geist-Variable.woff2) format('woff2-variations');
font-weight:100 900;font-display:swap}
:root{
  color-scheme:light;
  --sans:Geist,-apple-system,BlinkMacSystemFont,system-ui,"Segoe UI",sans-serif;
  --bg:#f5f5f7; --card:#ffffff;
  --label:#1d1d1f; --label-secondary:#6e6e73; --label-tertiary:#86868b;
  --separator:rgba(0,0,0,.08); --fill:rgba(120,120,128,.10);
  --accent:#ff2d55; --success:#34c759;
  --shadow:0 4px 20px rgba(0,0,0,.07), 0 1px 3px rgba(0,0,0,.05);
  --party-bg:#f9c3aa; --party-bg-2:#ffd1c0; --party-ink:#161315;
  --party-muted:rgba(22,19,21,.64); --party-line:rgba(70,34,32,.13);
}
@media (prefers-color-scheme:dark){
  :root{
    color-scheme:dark;
    --bg:#141719; --card:#1b1f21;
    --label:#f5f5f7; --label-secondary:#b6b6ba; --label-tertiary:#85858b;
    --separator:rgba(255,255,255,.10); --fill:rgba(255,255,255,.08);
    --shadow:none;
    --party-bg:#141719; --party-bg-2:#141719; --party-ink:#f5f5f7;
    --party-muted:#a9a9ae; --party-line:rgba(255,255,255,.10);
  }
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--label);
font-family:var(--sans);font-size:16px;line-height:1.45;font-synthesis:none}

/* The hero: full-bleed, the party gradient or the group's own picture, with the
   name sitting on it. This is the shape the guest page opens with. */
.hero{position:relative;padding:64px 20px 22px;
background:linear-gradient(180deg,var(--party-bg),var(--party-bg-2));
background-size:cover;background-position:center}
.hero.photo::after{content:'';position:absolute;inset:0;
background:linear-gradient(180deg,rgba(0,0,0,.15) 0%,rgba(0,0,0,.62) 100%)}
.hero>*{position:relative;z-index:1;max-width:640px;margin-left:auto;margin-right:auto}
.hero h1{font-size:40px;font-weight:800;line-height:1.02;letter-spacing:0;
color:var(--party-ink);margin:0 0 6px;overflow-wrap:anywhere}
.hero .sub{color:var(--party-muted);font-weight:800;font-size:16px;margin:0}
.hero.photo h1{color:#fff}
.hero.photo .sub{color:rgba(255,255,255,.82)}

/* Floating round chrome over the hero, the way the guest page's tools sit. */
.toptools{position:absolute;top:12px;right:12px;display:flex;gap:8px;z-index:2}
.toptools a{display:grid;place-items:center;min-width:38px;height:38px;padding:0 12px;
border-radius:999px;background:rgba(20,20,22,.72);color:#fff;font-size:13px;
font-weight:700;text-decoration:none;-webkit-backdrop-filter:blur(18px);
backdrop-filter:blur(18px)}
.toptools a:hover{text-decoration:none;background:rgba(20,20,22,.85)}

main{max-width:640px;margin:0 auto;padding:24px 20px 96px}
h1{font-size:30px;font-weight:800;letter-spacing:-.02em;line-height:1.1;margin:0 0 4px}
h2{font-size:19px;font-weight:800;letter-spacing:-.01em;margin:32px 0 12px}
p{margin:0 0 12px}
a{color:var(--accent);text-decoration:none;font-weight:600}
a:hover{text-decoration:underline}
.muted{color:var(--label-secondary);font-size:14px;font-weight:400}
a.muted{color:var(--label-secondary)}

.card{display:block;background:var(--card);border:1px solid var(--separator);
border-radius:16px;padding:16px;margin:0 0 12px;color:inherit;text-decoration:none;
box-shadow:var(--shadow)}
a.card{transition:transform .15s cubic-bezier(.25,.1,.25,1)}
a.card:hover{text-decoration:none;transform:translateY(-1px)}
.when{font-size:13px;color:var(--label-secondary);font-variant-numeric:tabular-nums;
font-weight:600}
.card strong{display:block;font-size:17px;font-weight:800;letter-spacing:-.01em;margin:2px 0}

/* The one big action, shaped like the listen bar: a coloured slab with a tile
   in it, not a small button hiding in a paragraph. */
.actionbar{display:flex;align-items:center;gap:14px;width:100%;
background:var(--accent);color:#fff;border:none;border-radius:18px;
padding:16px 18px;margin:20px 0 10px;font:inherit;font-size:17px;font-weight:800;
cursor:pointer;text-decoration:none;box-shadow:0 8px 24px rgba(255,45,85,.28);
transition:transform .15s cubic-bezier(.25,.1,.25,1),filter .15s}
.actionbar:hover{text-decoration:none;transform:translateY(-1px);filter:brightness(1.03)}
.actionbar .tile{display:grid;place-items:center;width:46px;height:46px;flex:0 0 46px;
border-radius:14px;background:rgba(255,255,255,.22);font-size:22px}
.actionbar .lines{display:grid;gap:2px;text-align:left;min-width:0}
.actionbar .lines small{font-weight:600;font-size:13px;opacity:.9}
.actionbar.quiet{background:var(--card);color:var(--label);
border:1px solid var(--separator);box-shadow:var(--shadow)}
.actionbar.quiet .tile{background:var(--fill)}

.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;
padding:14px 24px;border:none;border-radius:999px;background:var(--accent);color:#fff;
font:inherit;font-size:17px;font-weight:800;cursor:pointer;
box-shadow:0 8px 24px rgba(255,45,85,.28);
transition:transform .15s cubic-bezier(.25,.1,.25,1),filter .15s}
.btn:hover{text-decoration:none;transform:translateY(-1px);filter:brightness(1.03)}
.btn.plain{background:var(--card);color:var(--label);border:1px solid var(--separator);
box-shadow:0 1px 3px rgba(0,0,0,.05);font-weight:700}
.btn.small{min-height:40px;padding:10px 18px;font-size:15px;box-shadow:none}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

input[type=email],input[type=text]{width:100%;min-height:48px;padding:12px 14px;
border-radius:14px;border:1px solid var(--separator);background:var(--card);
color:var(--label);font:inherit;font-size:16px;outline:none;
box-shadow:0 1px 3px rgba(0,0,0,.05)}
input::placeholder{color:var(--label-tertiary)}
input:focus{border-color:var(--accent)}
form.join{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0 8px}
form.join input{flex:1 1 200px;min-width:0;width:auto}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}

.post{background:var(--card);border:1px solid var(--separator);border-radius:16px;
padding:14px;margin:0 0 10px;box-shadow:var(--shadow)}
.post .who{font-weight:800;font-size:15px}
footer{max-width:640px;margin:56px auto 0;padding:20px;
border-top:1px solid var(--separator);font-size:14px}

form.newnight{display:grid;gap:10px;margin:16px 0 28px;padding:16px;
background:var(--card);border:1px solid var(--separator);border-radius:16px;
box-shadow:var(--shadow)}
form.newnight .row input{flex:1 1 140px;width:auto}
form.newnight .btn{justify-self:start}

.linkrow{display:flex;gap:8px;align-items:center;margin:12px 0 10px}
.linkbox{flex:1 1 auto;min-width:0;font-size:13px;padding:10px 12px;min-height:0;
color:var(--label-secondary);border-radius:12px;
font-family:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace}

details.settings{margin-top:48px;border-top:1px solid var(--separator)}
details.settings summary{cursor:pointer;padding:16px 0;color:var(--label-secondary);
font-weight:700;list-style:none}
details.settings summary::-webkit-details-marker{display:none}
details.settings summary::before{content:"› ";display:inline-block;transition:transform .15s}
details.settings[open] summary::before{transform:rotate(90deg)}
details.settings h2{font-size:17px;margin:24px 0 6px}

@media (max-width:520px){
  .hero{padding:56px 18px 20px}
  .hero h1{font-size:34px}
}
@media (prefers-reduced-motion:reduce){*{transition:none !important}}
`;

function page(title, body, heroHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body>${heroHtml || ""}<main>${body}</main>
<footer><a href="/home">PartyParty</a></footer></body></html>`;
}

// The hero the guest page opens with: the group's own picture if it has one,
// the warm party gradient if it does not, with the name sitting on it and the
// round floating chrome the app uses for secondary actions.
function hero(title, sub, cover, tools) {
  const photo = cover ? ` photo" style="background-image:url('${esc(cover)}')` : "";
  return `<header class="hero${photo}">
    ${tools ? `<div class="toptools">${tools}</div>` : ""}
    <h1>${esc(title)}</h1>
    ${sub ? `<p class="sub">${esc(sub)}</p>` : ""}
  </header>`;
}

function whenText(event) {
  if (!event.starts_ms) return "Date to come";
  const date = new Date(event.starts_ms);
  return date.toLocaleString("en-GB", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    timeZone: event.timezone || "UTC",
  });
}

function groupPage(group, events, base, posts, viewer) {
  const list = events.length
    ? events.map((event) => `<a class="card" href="/@${esc(group.handle)}/${esc(event.slug)}">
        <div class="when">${esc(whenText(event))}</div>
        <div><strong>${esc(event.title || "Untitled night")}</strong></div>
        ${event.place ? `<div class="muted">${esc(event.place)}</div>` : ""}
      </a>`).join("")
    : `<p class="muted">No nights announced yet.</p>`;

  // Who is looking. Showing a DJ a form asking for their own name on their own
  // page is the kind of thing that makes a product feel like it does not know
  // you - and it is exactly what this page did.
  const follow = viewer && viewer.runsThisGroup
    ? `<a class="actionbar quiet" href="/@${esc(group.handle)}/manage">
         <span class="tile">\u2699\uFE0F</span>
         <span class="lines">Manage this group<small>This is your public page</small></span>
       </a>`
    : viewer && viewer.follows
      ? `<div class="actionbar quiet">
           <span class="tile">\u2713</span>
           <span class="lines">Following<small>Their nights reach you</small></span>
         </div>`
      : `<form method="post" action="/@${esc(group.handle)}/join">
           <div class="row" style="margin-top:18px">
             <input type="email" name="email" placeholder="your email" required>
             <input type="text" name="name" placeholder="your name">
           </div>
           <button class="actionbar" type="submit">
             <span class="tile">\u2605</span>
             <span class="lines">Follow<small>Hear about their nights</small></span>
           </button>
         </form>
         <p class="muted">One email to confirm. No account, and you can stop from any
         message we send.</p>`;

  return page(group.name || group.handle, `
    ${group.bio ? `<p>${esc(group.bio)}</p>` : ""}
    ${follow}
    ${group.pay_link ? `<p><a class="btn plain" href="${esc(group.pay_link)}"
      rel="noopener noreferrer nofollow" target="_blank">Tip the DJ</a></p>` : ""}
    ${group.merch_link ? `<p><a class="btn plain" href="${esc(group.merch_link)}"
      rel="noopener noreferrer nofollow" target="_blank">${esc(group.merch_label || "Merch")}</a></p>` : ""}
    <h2>Nights</h2>
    ${list}
    <p><a class="btn plain small" href="webcal://${esc(new URL(base).host)}/@${esc(group.handle)}.ics">Add these to your calendar</a></p>
    <h2>Talk</h2>
    ${postList(posts || [])}
  `, hero(group.name || group.handle, "@" + group.handle, group.cover_key,
      `<a href="/home">Home</a>`));
}

function eventPage(group, event, going, base, takeRate) {
  return page(`${event.title || "A night"} - ${group.name || group.handle}`, `
    <p class="when">${esc(whenText(event))}</p>
    ${event.place ? `<p>${esc(event.place)}${event.address ? `<br><span class="muted">${esc(event.address)}</span>` : ""}</p>` : ""}
    ${event.state === "cancelled" ? `<p><strong>This night is cancelled.</strong></p>` : ""}
    ${event.description ? `<p>${esc(event.description)}</p>` : ""}
    <p class="muted">${going} going</p>
    ${event.ticket_cents ? `<form class="join" method="post" action="/@${esc(group.handle)}/${esc(event.slug)}/buy">
      <input type="email" name="email" placeholder="your email" required>
      <button class="btn" type="submit">Buy a ticket -
        ${esc((totalForBuyer(event.ticket_cents, takeRate).total / 100).toFixed(2))}</button>
    </form>` : `<form class="join" method="post" action="/@${esc(group.handle)}/${esc(event.slug)}/going">
      <input type="email" name="email" placeholder="your email" required>
      <input type="text" name="name" placeholder="your name">
      <button class="btn" type="submit">I'm coming</button>
    </form>`}
    <p><a class="btn plain" href="/@${esc(group.handle)}/${esc(event.slug)}.ics">Add to calendar</a></p>
    ${group.pay_link ? `<p><a class="btn plain" href="${esc(group.pay_link)}"
      rel="noopener noreferrer nofollow" target="_blank">Tip the DJ</a></p>` : ""}
    <p class="muted">Organised by <a href="/@${esc(group.handle)}">${esc(group.name || group.handle)}</a> -
    follow them to hear about their other nights.</p>
  `, hero(event.title || "A night", group.name || group.handle, event.cover_key,
      `<a href="/@${esc(group.handle)}">The group</a>`));
}

function notice(title, message) {
  return html(200, page(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`));
}

// ------------------------------------------------------------------ queries

async function groupByHandle(env, handle) {
  return env.DB.prepare(`SELECT * FROM groups WHERE handle = ?`).bind(handle).first();
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
      + `Subscribe in your calendar: webcal://${new URL(base).host}/@${group.handle}.ics\n\n`
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
  if (!await claimHandle(env, handle)) return { error: "that name is taken" };
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
async function addPost(env, { group, dj, member, body, base, now }) {
  const text = String(body || "").trim().slice(0, 2000);
  if (!text) return 0;
  const author = dj ? (dj.name || "The DJ") : (member && member.name) || "Someone";
  await env.DB.prepare(
    `INSERT INTO posts (id, group_id, member_id, dj_id, author, body, origin, created_ms)
     VALUES (?, ?, ?, ?, ?, ?, 'web', ?)`
  ).bind(ulid(now), group.id, member ? member.id : null, dj ? dj.id : null, author, text, now).run();

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

async function recentPosts(env, groupId) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM posts WHERE group_id = ? AND event_id IS NULL AND deleted_ms IS NULL
      ORDER BY created_ms DESC LIMIT 30`
  ).bind(groupId).all();
  return results || [];
}

function postList(posts) {
  if (!posts.length) return `<p class="muted">Nothing said yet.</p>`;
  return posts.map((post) => `<div class="post">
    <div class="who">${esc(post.author)}</div>
    <div>${esc(post.body).replace(/\n/g, "<br>")}</div>
  </div>`).join("");
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

function signInPage(env) {
  const button = (provider, label) => (configured(env, provider)
    ? `<p><a class="btn" href="/auth/${provider}">${esc(label)}</a></p>`
    : `<p class="muted">${esc(label)} is not configured yet.</p>`);
  return page("Sign in", `
    <h1>Sign in</h1>
    <p class="muted">Only DJs need an account. Guests never do.</p>
    ${button("apple", "Continue with Apple")}
    ${button("google", "Continue with Google")}
  `);
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

    if (path === "/__pp/app-health") return json(200, { ok: true });

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
        ).bind(ulid(now), emailNorm, url.searchParams.get("name") || "Test DJ", now, now).run();
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
      const existing = await env.DB.prepare(
        `SELECT group_id FROM install_groups WHERE install_id = ?`
      ).bind(String(body.id)).first();
      if (existing) {
        const group = await env.DB.prepare(`SELECT handle, name FROM groups WHERE id = ?`)
          .bind(existing.group_id).first();
        return json(200, { linked: true, handle: group && group.handle, name: group && group.name });
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

    // The Mac asks which night it is playing. Answered from the group the
    // install belongs to and the clock, so a DJ never has to pair anything: if
    // one of their nights is happening now, this is that night.
    if (path === "/api/v1/party/bind" && request.method === "POST") {
      const body = await readJson(request, 4096);
      if (!body) return json(400, { error: "bad json" });
      const install = await installAuth(env, body.id, body.secret);
      if (!install) return json(403, { error: "bad install auth" });
      if (!PARTY_ID_RE.test(String(body.partyId || ""))) return json(400, { error: "bad party id" });

      const link = await env.DB.prepare(
        `SELECT group_id FROM install_groups WHERE install_id = ?`
      ).bind(String(body.id)).first();
      if (!link) return json(200, { bound: false, reason: "this Mac is not linked to a group" });

      const window = 12 * 60 * 60 * 1000;
      const night = await env.DB.prepare(
        `SELECT * FROM events WHERE group_id = ? AND state = 'announced'
           AND starts_ms IS NOT NULL AND starts_ms > ? AND starts_ms < ?
         ORDER BY ABS(starts_ms - ?) LIMIT 1`
      ).bind(link.group_id, now - window, now + window, now).first();
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
      const group = await env.DB.prepare(`SELECT handle FROM groups WHERE id = ?`).bind(link.group_id).first();
      return json(200, { bound: true, slug: night.slug, handle: group && group.handle, title: night.title });
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

    // ---- the DJ's own pages -----------------------------------------------
    // You, not one of your groups. Your name and how you sign in are yours and
    // follow you across every group you run or follow, so they do not belong
    // folded inside one group's page.
    if (path === "/settings") {
      const dj = await currentDJ(env, request, now);
      if (!dj) return html(200, signInPage(env));
      if (request.method === "POST") {
        const form = await request.formData().catch(() => null);
        await env.DB.prepare(`UPDATE djs SET name = ? WHERE id = ?`)
          .bind(String((form && form.get("name")) || "").slice(0, 60), dj.id).run();
        // The same person, as a member of other people's groups.
        await env.DB.prepare(`UPDATE members SET name = ? WHERE email_norm = ?`)
          .bind(String((form && form.get("name")) || "").slice(0, 60), dj.email_norm).run();
        return new Response(null, { status: 302, headers: { location: "/settings" } });
      }
      const { results: following } = await env.DB.prepare(
        `SELECT g.handle, g.name, gm.volume FROM groups g
           JOIN group_members gm ON gm.group_id = g.id
           JOIN members m ON m.id = gm.member_id
          WHERE m.email_norm = ? AND gm.state = 'joined' ORDER BY gm.joined_ms DESC`
      ).bind(dj.email_norm).all();

      const volumeWord = { all: "every post", events: "nights only", none: "nothing" };
      return html(200, page("Your settings", `
        <h1>You</h1>
        <p class="muted">Signed in as ${esc(dj.email_norm)}. That address came from
        ${esc(dj.apple_sub ? "Apple" : "your sign-in")} and cannot be changed here -
        sign in with a different one and you are a different person to us.</p>
        <form class="join" method="post" action="/settings">
          <input type="text" name="name" placeholder="Your name" value="${esc(dj.name || "")}">
          <button class="btn plain" type="submit">Save</button>
        </form>

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
      `));
    }

    // Home for someone signed in: what is coming up, across the groups they run
    // and the groups they follow. Signed out it is the sign-in page, because
    // there is nothing here that is about nobody in particular.
    if (path === "/home") {
      const dj = await currentDJ(env, request, now);
      if (!dj) return html(200, signInPage(env));

      const { results: mine } = await env.DB.prepare(
        `SELECT g.* FROM groups g JOIN group_djs d ON d.group_id = g.id WHERE d.dj_id = ?`
      ).bind(dj.id).all();
      const { results: following } = await env.DB.prepare(
        `SELECT g.* FROM groups g
           JOIN group_members gm ON gm.group_id = g.id
           JOIN members m ON m.id = gm.member_id
          WHERE m.email_norm = ? AND gm.state = 'joined'`
      ).bind(dj.email_norm).all();

      const ids = [...(mine || []), ...(following || [])].map((g) => g.id);
      let upcoming = [];
      if (ids.length) {
        const { results } = await env.DB.prepare(
          `SELECT e.*, g.handle, g.name AS group_name FROM events e JOIN groups g ON g.id = e.group_id
            WHERE e.group_id IN (${ids.map(() => "?").join(",")})
              AND e.state IN ('announced','live')
              AND (e.starts_ms IS NULL OR e.starts_ms > ?)
            ORDER BY e.starts_ms LIMIT 30`
        ).bind(...ids, now - 12 * 60 * 60 * 1000).all();
        upcoming = results || [];
      }

      const groupRow = (g, note) => `<a class="card" href="/@${esc(g.handle)}">
        <strong>${esc(g.name || g.handle)}</strong>
        <div class="muted">@${esc(g.handle)}${note ? " · " + esc(note) : ""}</div></a>`;

      return html(200, page("PartyParty", `
        <h1>What's on</h1>
        ${upcoming.length ? upcoming.map((e) => `<a class="card" href="/@${esc(e.handle)}/${esc(e.slug)}">
            <div class="when">${esc(whenText(e))}</div>
            <strong>${esc(e.title || "A night")}</strong>
            <div class="muted">${esc(e.group_name || e.handle)}${e.place ? " · " + esc(e.place) : ""}</div>
          </a>`).join("")
          : `<p class="muted">Nothing coming up yet - from your own groups or the ones
             you follow.</p>`}

        ${(mine || []).length ? `<h2>Yours</h2>
          ${mine.map((g) => groupRow(g, "you run this")).join("")}` : ""}

        ${(following || []).length ? `<h2>Following</h2>
          ${following.map((g) => groupRow(g)).join("")}`
          : `<h2>Following</h2><p class="muted">Nobody yet. Open someone's page and
             follow them, and their nights show up here.</p>`}

        <p class="muted" style="margin-top:40px">
          <a href="/manage">Run a group</a> · <a href="/settings">Settings</a> ·
          <a href="/auth/signout">Sign out</a></p>
      `));
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
      const group = await groupByHandle(env, match[1]);
      if (!group) return new Response("Not Found", { status: 404 });
      const dj = await currentDJ(env, request, now);
      if (!await djRunsGroup(env, dj, group.id)) return html(403, signInPage(env));
      const event = await env.DB.prepare(
        `SELECT * FROM events WHERE group_id = ? AND slug = ?`
      ).bind(group.id, match[2]).first();
      if (!event) return new Response("Not Found", { status: 404 });
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

    match = path.match(/^\/@([a-z0-9]+)\/manage$/);
    if (match) {
      const group = await groupByHandle(env, match[1]);
      if (!group) return new Response("Not Found", { status: 404 });
      const dj = await currentDJ(env, request, now);
      if (!await djRunsGroup(env, dj, group.id)) return html(403, signInPage(env));
      if (request.method === "POST") {
        const form = await request.formData().catch(() => null);
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
          await env.DB.prepare(`UPDATE groups SET merch_link = ?, merch_label = ?, updated_ms = ? WHERE id = ?`)
            .bind(link, String(form.get("merchLabel") || "").slice(0, 40), now, group.id).run();
          return notice("Saved", link ? "Your store is linked." : "The store link is off.");
        }
        if (form && form.has("payLink")) {
          const link = String(form.get("payLink") || "").trim();
          const problem = payLinkProblem(link);
          if (problem) return notice("That link will not work", problem);
          await env.DB.prepare(`UPDATE groups SET pay_link = ?, updated_ms = ? WHERE id = ?`)
            .bind(link, now, group.id).run();
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
          await env.DB.prepare(
            `INSERT INTO install_groups (install_id, group_id, linked_ms) VALUES (?, ?, ?)
             ON CONFLICT(install_id) DO UPDATE SET group_id = excluded.group_id, linked_ms = excluded.linked_ms`
          ).bind(code.install_id, group.id, now).run();
          return notice("That Mac is yours", `Its parties will find ${group.name || group.handle}'s nights.`);
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
        await env.DB.prepare(
          `INSERT INTO events (id, group_id, slug, title, starts_ms, place, capacity, state, created_ms, updated_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'announced', ?, ?)`
        ).bind(ulid(now), group.id, slugify(title, now), title, Number.isFinite(starts) ? starts : null,
          String((form && form.get("place")) || "").slice(0, 120), capacity, now, now).run();
        return new Response(null, { status: 302, headers: { location: `/@${group.handle}/manage` } });
      }
      const events = await upcomingEvents(env, group.id, 0);
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
        <h1>${esc(group.name || group.handle)}</h1>

        <form class="newnight" method="post" action="/@${esc(group.handle)}/manage">
          <input type="text" name="title" placeholder="What is the night called?" required>
          <div class="row">
            <input type="text" name="starts" placeholder="2026-09-12T21:00">
            <input type="text" name="place" placeholder="Where?">
            <input type="text" name="capacity" placeholder="Capacity">
          </div>
          <button class="btn" type="submit">Add a night</button>
        </form>

        ${events.length ? events.map(night).join("") : `<p class="muted">No nights yet.
          Add one above and you will get a link to send.</p>`}

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
              value="${esc(group.pay_link || "")}">
            <button class="btn plain" type="submit">Save</button>
          </form>

          <h2>Merch</h2>
          <form class="join" method="post" action="/@${esc(group.handle)}/manage">
            <input type="text" name="merchLink" placeholder="Link to your store"
              value="${esc(group.merch_link || "")}">
            <input type="text" name="merchLabel" placeholder="Label, e.g. Shirts"
              value="${esc(group.merch_label || "")}">
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
      `));
    }

    // A group's calendar. Subscribed once, correct forever after - which is why
    // it is a first-class URL and not a download.
    match = path.match(/^\/@([a-z0-9]+)\.ics$/);
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
      const event = await env.DB.prepare(
        `SELECT * FROM events WHERE group_id = ? AND slug = ?`
      ).bind(group.id, match[2]).first();
      if (!event) return new Response("Not Found", { status: 404 });
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

      if (request.method === "POST" && group) {
        const form = await request.formData().catch(() => null);
        const member = await env.DB.prepare(`SELECT * FROM members WHERE id = ?`).bind(token.member_id).first();
        await addPost(env, { group, member, body: form && form.get("say"), base, now });
        return new Response(null, { status: 302, headers: { location: `/@${group.handle}` } });
      }
      const link = (q, label) => `<p><a class="btn plain" href="/m/${match[1]}?do=${q}">${esc(label)}</a></p>`;
      return html(200, page("Your settings", `
        <h1>Your settings</h1>
        ${group ? `<h2>Say something to ${esc(group.name || group.handle)}</h2>
        <form class="join" method="post" action="/m/${match[1]}">
          <input type="text" name="say" placeholder="Anything" required>
          <button class="btn" type="submit">Post</button>
        </form>` : ""}
        ${group ? `<p class="muted">For ${esc(group.name || group.handle)}</p>` : ""}
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
    match = path.match(/^\/@([a-z0-9]+)\/join$/);
    if (match && request.method === "POST") {
      const group = await groupByHandle(env, match[1]);
      if (!group) return new Response("Not Found", { status: 404 });
      const form = await request.formData().catch(() => null);
      const emailNorm = normalizeEmail(form && form.get("email"));
      if (!emailNorm) return notice("That address did not look right", "Go back and try again.");
      await joinGroup(env, group, emailNorm, String((form && form.get("name")) || "").slice(0, 60), "link", base, now);
      return notice("Check your email", `We sent one message to ${emailNorm}. Tap the link in it and you are in.`);
    }

    // Saying you are coming, from the night's own page.
    match = path.match(/^\/@([a-z0-9]+)\/([a-z0-9-]+)\/going$/);
    if (match && request.method === "POST") {
      const group = await groupByHandle(env, match[1]);
      if (!group) return new Response("Not Found", { status: 404 });
      const event = await env.DB.prepare(
        `SELECT * FROM events WHERE group_id = ? AND slug = ?`
      ).bind(group.id, match[2]).first();
      if (!event) return new Response("Not Found", { status: 404 });
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
      const group = await groupByHandle(env, match[1]);
      if (!group) return new Response("Not Found", { status: 404 });
      const event = await env.DB.prepare(
        `SELECT * FROM events WHERE group_id = ? AND slug = ? AND state != 'draft'`
      ).bind(group.id, match[2]).first();
      if (!event || !event.ticket_cents) return new Response("Not Found", { status: 404 });
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

    // A night.
    match = path.match(/^\/@([a-z0-9]+)\/([a-z0-9-]+)$/);
    if (match) {
      const group = await groupByHandle(env, match[1]);
      if (!group) return new Response("Not Found", { status: 404 });
      const event = await env.DB.prepare(
        `SELECT * FROM events WHERE group_id = ? AND slug = ? AND state != 'draft'`
      ).bind(group.id, match[2]).first();
      if (!event) return new Response("Not Found", { status: 404 });
      return html(200, eventPage(group, event, await goingCount(env, event.id), base,
        await takeRateFor(env, group.id)));
    }

    // A group.
    match = path.match(/^\/@([a-z0-9]+)$/);
    if (match) {
      const group = await groupByHandle(env, match[1]);
      if (!group) return new Response("Not Found", { status: 404 });
      return html(200, groupPage(group, await upcomingEvents(env, group.id, now), base,
        await recentPosts(env, group.id), await viewerOf(env, request, group, now)));
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
