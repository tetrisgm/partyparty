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

// -------------------------------------------------------------------- fetch

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const base = `${url.protocol}//${url.host}`;
    const now = Date.now();
    const path = decodeURIComponent(url.pathname);

    if (path === "/__pp/app-health") return json(200, { ok: true });

    // A group's calendar. Subscribed once, correct forever after - which is why
    // it is a first-class URL and not a download.
    let match = path.match(/^\/@([a-z0-9]+)\.ics$/);
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
