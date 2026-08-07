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

const HANDLE_RE = /^[a-z0-9]{5,30}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
    headers: { "content-type": "application/json", "cache-control": "no-store", ...(headers || {}) },
  });
}

function html(status, body, headers) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store", ...(headers || {}) },
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
:root{color-scheme:light dark;--ink:CanvasText;--bg:Canvas;--accent:#ff2d6f;
--muted:color-mix(in srgb,CanvasText 60%,transparent);
--line:color-mix(in srgb,CanvasText 14%,transparent)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif}
main{max-width:640px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:28px;margin:0 0 4px;text-wrap:balance}
h2{font-size:18px;margin:32px 0 12px}
p{margin:0 0 12px}
.muted{color:var(--muted)}
.card{border:1px solid var(--line);border-radius:14px;padding:16px;margin:0 0 12px;display:block;
color:inherit;text-decoration:none}
.card:hover{border-color:var(--accent)}
.when{font-variant-numeric:tabular-nums;color:var(--muted);font-size:14px}
.btn{display:inline-block;border:0;border-radius:999px;padding:12px 20px;background:var(--accent);
color:#fff;font:inherit;font-weight:650;text-decoration:none;cursor:pointer}
.btn.plain{background:transparent;color:var(--ink);border:1px solid var(--line)}
form.join{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}
input[type=email],input[type=text]{flex:1 1 220px;padding:12px 14px;border-radius:12px;
border:1px solid var(--line);background:transparent;color:inherit;font:inherit}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.post{border-top:1px solid var(--line);padding:14px 0}
.post .who{font-weight:620}
footer{margin-top:48px;color:var(--muted);font-size:13px}
`;

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><main>${body}
<footer><a class="muted" href="/">PartyParty</a></footer></main></body></html>`;
}

function whenText(event) {
  if (!event.starts_ms) return "Date to come";
  const date = new Date(event.starts_ms);
  return date.toLocaleString("en-GB", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    timeZone: event.timezone || "UTC",
  });
}

function groupPage(group, events, base) {
  const list = events.length
    ? events.map((event) => `<a class="card" href="/@${esc(group.handle)}/${esc(event.slug)}">
        <div class="when">${esc(whenText(event))}</div>
        <div><strong>${esc(event.title || "Untitled night")}</strong></div>
        ${event.place ? `<div class="muted">${esc(event.place)}</div>` : ""}
      </a>`).join("")
    : `<p class="muted">No nights announced yet.</p>`;
  return page(group.name || group.handle, `
    <h1>${esc(group.name || group.handle)}</h1>
    <p class="muted">@${esc(group.handle)}</p>
    ${group.bio ? `<p>${esc(group.bio)}</p>` : ""}
    <form class="join" method="post" action="/@${esc(group.handle)}/join">
      <input type="email" name="email" placeholder="your email" required>
      <input type="text" name="name" placeholder="your name">
      <button class="btn" type="submit">Join</button>
    </form>
    <p class="muted">You will get one email to confirm. No account, and you can
    leave from any message we send.</p>
    <h2>Nights</h2>
    ${list}
    <p><a class="btn plain" href="webcal://${esc(new URL(base).host)}/@${esc(group.handle)}.ics">Subscribe in your calendar</a></p>
  `);
}

function eventPage(group, event, going, base) {
  return page(`${event.title || "A night"} - ${group.name || group.handle}`, `
    <p class="muted"><a class="muted" href="/@${esc(group.handle)}">${esc(group.name || group.handle)}</a></p>
    <h1>${esc(event.title || "A night")}</h1>
    <p class="when">${esc(whenText(event))}</p>
    ${event.place ? `<p>${esc(event.place)}${event.address ? `<br><span class="muted">${esc(event.address)}</span>` : ""}</p>` : ""}
    ${event.state === "cancelled" ? `<p><strong>This night is cancelled.</strong></p>` : ""}
    ${event.description ? `<p>${esc(event.description)}</p>` : ""}
    <p class="muted">${going} going</p>
    <form class="join" method="post" action="/@${esc(group.handle)}/${esc(event.slug)}/going">
      <input type="email" name="email" placeholder="your email" required>
      <input type="text" name="name" placeholder="your name">
      <button class="btn" type="submit">I'm coming</button>
    </form>
    <p><a class="btn plain" href="/@${esc(group.handle)}/${esc(event.slug)}.ics">Add to calendar</a></p>
    <p class="muted">Organised by <a href="/@${esc(group.handle)}">${esc(group.name || group.handle)}</a> -
    join the group to hear about their other nights.</p>
  `);
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

// -------------------------------------------------------------------- fetch

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const base = `${url.protocol}//${url.host}`;
    const now = Date.now();
    const path = decodeURIComponent(url.pathname);

    if (path === "/__pp/app-health") return json(200, { ok: true });

    // ---- sign-in ----------------------------------------------------------
    let match = path.match(/^\/auth\/(apple|google)$/);
    if (match) {
      const provider = match[1];
      if (!configured(env, provider)) return notice("Not available yet", "That sign-in is not configured.");
      const nonce = randomHex(16);
      const state = await signState(env, {
        p: provider, n: nonce, exp: now + 10 * 60 * 1000,
        to: url.searchParams.get("to") || "/manage",
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
          location: String(state.to || "/manage"),
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
      const mine = (results || []).map((g) => `<a class="card" href="/@${esc(g.handle)}/manage">
        <strong>${esc(g.name || g.handle)}</strong><div class="muted">@${esc(g.handle)}</div></a>`).join("");
      return html(200, page("Your groups", `
        <h1>Your groups</h1>
        ${mine || `<p class="muted">Nothing yet. A group is you and the people who come to your nights.</p>`}
        <h2>Start one</h2>
        <form class="join" method="post" action="/manage">
          <input type="text" name="name" placeholder="Name, e.g. Sundaze" required>
          <input type="text" name="handle" placeholder="handle" required>
          <button class="btn" type="submit">Create</button>
        </form>
        <p class="muted">The handle is the address: partyparty.party/@yourhandle. Five
        characters or more, letters and numbers.</p>
        <p><a class="muted" href="/auth/signout">Sign out</a></p>
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
        const title = String((form && form.get("title")) || "").slice(0, 120);
        const startsRaw = String((form && form.get("starts")) || "");
        const starts = startsRaw ? Date.parse(startsRaw + "Z") : null;
        await env.DB.prepare(
          `INSERT INTO events (id, group_id, slug, title, starts_ms, place, state, created_ms, updated_ms)
           VALUES (?, ?, ?, ?, ?, ?, 'announced', ?, ?)`
        ).bind(ulid(now), group.id, slugify(title, now), title, Number.isFinite(starts) ? starts : null,
          String((form && form.get("place")) || "").slice(0, 120), now, now).run();
        return new Response(null, { status: 302, headers: { location: `/@${group.handle}/manage` } });
      }
      const events = await upcomingEvents(env, group.id, 0);
      const members = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM group_members WHERE group_id = ? AND state = 'joined'`
      ).bind(group.id).first();
      return html(200, page(`Manage ${group.name || group.handle}`, `
        <h1>${esc(group.name || group.handle)}</h1>
        <p class="muted">${Number((members && members.n) || 0)} members ·
          <a class="muted" href="/@${esc(group.handle)}">public page</a></p>
        <h2>Nights</h2>
        ${events.map((e) => `<div class="card"><div class="when">${esc(whenText(e))}</div>
          <strong>${esc(e.title || "Untitled")}</strong></div>`).join("")
          || `<p class="muted">No nights yet.</p>`}
        <h2>Add one</h2>
        <form class="join" method="post" action="/@${esc(group.handle)}/manage">
          <input type="text" name="title" placeholder="What is it called?" required>
          <input type="text" name="starts" placeholder="2026-09-12T21:00">
          <input type="text" name="place" placeholder="Where?">
          <button class="btn" type="submit">Announce</button>
        </form>
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

      const link = (q, label) => `<p><a class="btn plain" href="/m/${match[1]}?do=${q}">${esc(label)}</a></p>`;
      return html(200, page("Your settings", `
        <h1>Your settings</h1>
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

    // A night.
    match = path.match(/^\/@([a-z0-9]+)\/([a-z0-9-]+)$/);
    if (match) {
      const group = await groupByHandle(env, match[1]);
      if (!group) return new Response("Not Found", { status: 404 });
      const event = await env.DB.prepare(
        `SELECT * FROM events WHERE group_id = ? AND slug = ? AND state != 'draft'`
      ).bind(group.id, match[2]).first();
      if (!event) return new Response("Not Found", { status: 404 });
      return html(200, eventPage(group, event, await goingCount(env, event.id), base));
    }

    // A group.
    match = path.match(/^\/@([a-z0-9]+)$/);
    if (match) {
      const group = await groupByHandle(env, match[1]);
      if (!group) return new Response("Not Found", { status: 404 });
      return html(200, groupPage(group, await upcomingEvents(env, group.id, now), base));
    }

    return new Response("Not Found", { status: 404 });
  },
};
