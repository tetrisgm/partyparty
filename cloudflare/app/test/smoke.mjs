import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { handleProblem, icsFor, normalizeEmail, sha256Hex, ulid } from "../worker.js";

// A real SQLite behind the D1 shape, so the tests exercise the actual SQL -
// including the ON CONFLICT clauses, which are where the join and going paths
// either work twice or corrupt a row.
const schema = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args.map((a) => (a === undefined ? null : a)); return this; }
  async first() { const row = this.db.prepare(this.sql).get(...this.args); return row === undefined ? null : row; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() { this.db.prepare(this.sql).run(...this.args); return { success: true }; }
}

const makeEnv = () => {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  return { DB: { prepare: (sql) => new Stmt(db, sql), _db: db }, raw: db };
};

const rows = (env, sql, ...args) => env.raw.prepare(sql).all(...args);
const one = (env, sql, ...args) => env.raw.prepare(sql).get(...args);

const seedGroup = (env, handle = "sundaze") => {
  const id = ulid();
  env.raw.prepare(
    `INSERT INTO groups (id, handle, name, bio, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, handle, "Sundaze", "Slow Sunday rooms.", Date.now(), Date.now());
  return id;
};

const seedEvent = (env, groupId, over = {}) => {
  const id = ulid();
  const event = {
    slug: "june-14", title: "Sundaze at the Lido", starts_ms: Date.parse("2026-09-12T21:00:00Z"),
    place: "The Lido", state: "announced", ...over,
  };
  env.raw.prepare(
    `INSERT INTO events (id, group_id, slug, title, starts_ms, place, state, created_ms, updated_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, groupId, event.slug, event.title, event.starts_ms, event.place, event.state, Date.now(), Date.now());
  return id;
};

const get = (env, path, init) => worker.fetch(new Request("https://partyparty.party" + path, init), env);
const post = (env, path, fields) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return worker.fetch(new Request("https://partyparty.party" + path, { method: "POST", body: form }), env);
};

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("handles are gated before anything can claim one", () => {
  assert.equal(handleProblem("sundaze"), "");
  assert.ok(handleProblem("abcd"), "four characters is too short");
  assert.ok(handleProblem("Sundaze"), "uppercase is not a different name");
  assert.ok(handleProblem("sun-daze"), "punctuation would break the join hostname");
  assert.ok(handleProblem("admin"), "reserved");
  assert.ok(handleProblem("privacy"), "reserved: a real page lives there");
  assert.ok(handleProblem("shitshow"), "banned fragment");
  assert.equal(normalizeEmail("  Someone@Example.COM "), "someone@example.com");
  assert.equal(normalizeEmail("not-an-email"), "");
});

test("a calendar feed says enough for a subscription to stay correct", () => {
  const group = { handle: "sundaze", name: "Sundaze" };
  const event = {
    id: "ev1", slug: "june-14", title: "Sundaze, with a comma", ics_seq: 3,
    starts_ms: Date.parse("2026-09-12T21:00:00Z"), ends_ms: Date.parse("2026-09-13T03:00:00Z"),
    place: "The Lido", address: "1 Water Lane", created_ms: 1, updated_ms: 2, state: "announced",
    description: "x".repeat(200),
  };
  const ics = icsFor(group, [event], "https://partyparty.party");
  assert.match(ics, /UID:ev1@partyparty\.party/);
  assert.match(ics, /SEQUENCE:3/, "a calendar that never sees a higher SEQUENCE keeps the old date");
  assert.match(ics, /DTSTART:20260912T210000Z/);
  assert.match(ics, /SUMMARY:Sundaze\\, with a comma/, "commas must be escaped or the line splits");
  assert.match(ics, /STATUS:CONFIRMED/);
  for (const line of ics.split("\r\n")) assert.ok(line.length <= 75, `unfolded line: ${line.slice(0, 40)}`);

  const cancelled = icsFor(group, [{ ...event, state: "cancelled" }], "https://partyparty.party");
  assert.match(cancelled, /STATUS:CANCELLED/, "cancelling is published, never a deletion");
});

test("joining a group creates a membership and exactly one confirmable email", async () => {
  const env = makeEnv();
  seedGroup(env);
  const response = await post(env, "/@sundaze/join", { email: "Guest@Example.com ", name: "Guest" });
  assert.equal(response.status, 200);

  const member = one(env, `SELECT * FROM members`);
  assert.equal(member.email_norm, "guest@example.com", "the address is normalised before it is stored");
  assert.equal(member.confirmed_ms, null, "confirmation is the mail's job, not the form's");
  const membership = one(env, `SELECT * FROM group_members`);
  assert.equal(membership.state, "joined");
  assert.equal(membership.volume, "events", "the quiet default: nights only");

  const mail = rows(env, `SELECT * FROM outbox`);
  assert.equal(mail.length, 1);
  assert.equal(mail[0].kind, "confirm");
  const headers = JSON.parse(mail[0].headers);
  assert.match(headers["List-Unsubscribe"], /\/m\/[a-f0-9]{48}\?stop=1/);
  assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.match(mail[0].body_text, /webcal:\/\/partyparty\.party\/@sundaze\.ics/);

  // Joining twice is a person tapping the button again, not an error.
  await post(env, "/@sundaze/join", { email: "guest@example.com", name: "Guest" });
  assert.equal(rows(env, `SELECT * FROM members`).length, 1);
  assert.equal(rows(env, `SELECT * FROM group_members`).length, 1);
});

test("the confirm link confirms, and cannot be replayed as anything else", async () => {
  const env = makeEnv();
  seedGroup(env);
  await post(env, "/@sundaze/join", { email: "guest@example.com", name: "Guest" });
  const secret = /\/j\/([a-f0-9]{48})/.exec(one(env, `SELECT body_text FROM outbox`).body_text)[1];

  assert.equal((await get(env, `/j/${secret}`)).status, 200);
  assert.ok(one(env, `SELECT confirmed_ms FROM members`).confirmed_ms, "the address is confirmed");

  // Purpose scoping: the same secret must not work as a settings link.
  const asManage = await get(env, `/m/${secret}`);
  assert.match(await asManage.text(), /expired/i, "a confirm token is not a settings token");
});

test("a member can leave, mute, or stop everything, from one link", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  await post(env, "/@sundaze/join", { email: "guest@example.com", name: "Guest" });
  const body = one(env, `SELECT body_text FROM outbox`).body_text;
  const manage = /\/m\/([a-f0-9]{48})/.exec(body)[1];

  assert.match(await (await get(env, `/m/${manage}`)).text(), /Your settings/);

  await get(env, `/m/${manage}?do=none`);
  assert.equal(one(env, `SELECT volume FROM group_members`).volume, "none");
  await get(env, `/m/${manage}?do=all`);
  assert.equal(one(env, `SELECT volume FROM group_members`).volume, "all");

  await get(env, `/m/${manage}?do=leave`);
  const left = one(env, `SELECT * FROM group_members`);
  assert.equal(left.state, "left");
  assert.ok(left.left_ms, "leaving is dated, so rejoining is a different event");

  await get(env, `/m/${manage}?stop=1`);
  assert.ok(one(env, `SELECT suppressed_ms FROM members`).suppressed_ms);

  // Suppression is checked when mail is QUEUED, so nothing can outrun it.
  const before = rows(env, `SELECT id FROM outbox`).length;
  await post(env, "/@sundaze/join", { email: "guest@example.com", name: "Guest" });
  assert.equal(rows(env, `SELECT id FROM outbox`).length, before,
    "a suppressed member must never be queued another message");
  assert.ok(groupId);
});

test("blocking one person is not the same as leaving", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  const djId = ulid();
  env.raw.prepare(`INSERT INTO djs (id, email_norm, name, created_ms) VALUES (?, ?, ?, ?)`)
    .run(djId, "dj@example.com", "The DJ", Date.now());
  await post(env, "/@sundaze/join", { email: "guest@example.com" });
  const manage = /\/m\/([a-f0-9]{48})/.exec(one(env, `SELECT body_text FROM outbox`).body_text)[1];

  await get(env, `/m/${manage}?do=block:${djId}`);
  assert.equal(rows(env, `SELECT * FROM blocks`).length, 1);
  assert.equal(one(env, `SELECT state FROM group_members`).state, "joined",
    "a block leaves the membership alone - that is the whole point of having both");
  assert.ok(groupId);
});

test("saying you are coming to a night, and the count that follows", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  seedEvent(env, groupId);

  const page = await (await get(env, "/@sundaze/june-14")).text();
  assert.match(page, /Sundaze at the Lido/);
  assert.match(page, /0 going/);

  assert.equal((await post(env, "/@sundaze/june-14/going", { email: "guest@example.com" })).status, 200);
  assert.equal(one(env, `SELECT state FROM signups`).state, "going");
  assert.match(await (await get(env, "/@sundaze/june-14")).text(), /1 going/);

  const mail = one(env, `SELECT * FROM outbox WHERE kind = 'ticket'`);
  assert.match(mail.body_text, /\/@sundaze\/june-14\.ics/, "the details mail carries the calendar link");

  // Coming twice is one person, not two.
  await post(env, "/@sundaze/june-14/going", { email: "guest@example.com" });
  assert.equal(rows(env, `SELECT * FROM signups`).length, 1);
});

test("a draft night is not a public night, and its calendar is not published", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  seedEvent(env, groupId, { slug: "secret", state: "draft" });
  assert.equal((await get(env, "/@sundaze/secret")).status, 404);
  const feed = await (await get(env, "/@sundaze.ics")).text();
  assert.ok(!feed.includes("BEGIN:VEVENT"), "a draft must not appear in a subscribed calendar");
});

test("the group page and its calendar are served", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  seedEvent(env, groupId);

  const page = await (await get(env, "/@sundaze")).text();
  assert.match(page, /Sundaze/);
  assert.match(page, /webcal:\/\/partyparty\.party\/@sundaze\.ics/);

  const feed = await get(env, "/@sundaze.ics");
  assert.equal(feed.headers.get("content-type"), "text/calendar;charset=utf-8");
  assert.match(await feed.text(), /BEGIN:VEVENT/);

  assert.equal((await get(env, "/@nobody")).status, 404);
});

// A real RSA key pair, so the sign-in tests exercise the actual signature
// check. A stubbed "trust me" verifier would pass while accepting a token
// anybody could mint claiming any address they liked.
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
let kidSeq = 0;
const idTokenFor = async (keys, kid, claims) => {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid })));
  const body = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${b64url(new Uint8Array(signature))}`;
};

const withGoogle = async (env, claimsOver = {}) => {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  // A fresh key id per pair, as a real provider does. Reusing one id for two
  // different keys is the one thing a signature cache is entitled to trust.
  const kid = `test-key-${++kidSeq}`;
  env.GOOGLE_CLIENT_ID = "client.example";
  env.GOOGLE_CLIENT_SECRET = "secret";
  env.STATE_SECRET = "test-state";
  env.__token = async (nonce) => idTokenFor(keys, kid, {
    iss: "https://accounts.google.com", aud: "client.example", sub: "google-sub-1",
    email: "dj@example.com", nonce, exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000), ...claimsOver,
  });
  env.FETCH = async (input) => {
    const target = String(input && input.url ? input.url : input);
    if (target.includes("oauth2/v3/certs")) {
      return new Response(JSON.stringify({ keys: [{ ...jwk, kid }] }), { status: 200 });
    }
    if (target.includes("oauth2.googleapis.com/token")) {
      return new Response(JSON.stringify({ id_token: env.__pendingToken }), { status: 200 });
    }
    return new Response("no", { status: 404 });
  };
  return env;
};

const signIn = async (env) => {
  const start = await get(env, "/auth/google");
  assert.equal(start.status, 302);
  const state = /pp_auth=([^;]+)/.exec(start.headers.get("set-cookie"))[1];
  const nonce = JSON.parse(Buffer.from(state.split(".")[0], "base64url").toString()).n;
  env.__pendingToken = await env.__token(nonce);
  const done = await get(env, `/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`, {
    headers: { cookie: `pp_auth=${state}` },
  });
  return { done, session: /pp_s=([a-f0-9]{48})/.exec(done.headers.get("set-cookie") || "") };
};

test("a DJ signs in with a verified token, and a forged one is refused", async () => {
  const env = await withGoogle(makeEnv());
  const { done, session } = await signIn(env);
  assert.equal(done.status, 302);
  assert.equal(done.headers.get("location"), "/manage");
  assert.ok(session, "a session cookie is set");
  assert.equal(one(env, `SELECT email_norm FROM djs`).email_norm, "dj@example.com");

  // Same flow, but the payload is rewritten after signing.
  const forged = await withGoogle(makeEnv());
  const start = await get(forged, "/auth/google");
  const state = /pp_auth=([^;]+)/.exec(start.headers.get("set-cookie"))[1];
  const nonce = JSON.parse(Buffer.from(state.split(".")[0], "base64url").toString()).n;
  const real = await forged.__token(nonce);
  const [header, , signature] = real.split(".");
  const tampered = JSON.parse(Buffer.from(real.split(".")[1], "base64url").toString());
  tampered.email = "someone.else@example.com";
  forged.__pendingToken = `${header}.${Buffer.from(JSON.stringify(tampered)).toString("base64url")}.${signature}`;
  const refused = await get(forged, `/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`, {
    headers: { cookie: `pp_auth=${state}` },
  });
  assert.equal(refused.status, 200);
  assert.match(await refused.text(), /did not verify|did not complete/i);
  assert.equal(rows(forged, `SELECT * FROM djs`).length, 0, "no account from a forged token");
});

test("a callback without the matching state cookie is refused", async () => {
  const env = await withGoogle(makeEnv());
  const start = await get(env, "/auth/google");
  const state = /pp_auth=([^;]+)/.exec(start.headers.get("set-cookie"))[1];
  env.__pendingToken = await env.__token("whatever");
  const noCookie = await get(env, `/auth/google/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.match(await noCookie.text(), /did not complete/i);
  assert.equal(rows(env, `SELECT * FROM djs`).length, 0);
});

test("a signed-in DJ makes a group, and the name is reserved against the broker", async () => {
  const env = await withGoogle(makeEnv());
  env.DL = new Map();
  env.DL.head = async (key) => (env.DL.has(key) ? {} : null);
  env.DL.put = async (key, value) => { env.DL.set(key, value); };
  const { session } = await signIn(env);
  const cookie = { headers: { cookie: `pp_s=${session[1]}` } };

  const form = (fields) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.append(k, v);
    return { method: "POST", body, headers: cookie.headers };
  };

  // Typed with a capital, stored canonical: the form normalises before it
  // validates, so what is saved is exactly what a URL will later match.
  const ok = await get(env, "/manage", form({ name: "Sundaze", handle: " Sundaze " }));
  assert.equal(ok.status, 302);
  assert.equal(one(env, `SELECT handle FROM groups`).handle, "sundaze");
  assert.equal((await get(env, "/@sundaze")).status, 200);
  assert.equal(one(env, `SELECT role FROM group_djs`).role, "owner");
  assert.ok(env.DL.has("broker/handle/sundaze"),
    "the broker mints machine names from this keyspace and must see the claim");

  // A name the broker already gave to a Mac cannot become a group.
  env.DL.set("broker/join/discotaken", "r-token");
  const clash = await get(env, "/manage", form({ name: "Nope", handle: "discotaken" }));
  assert.match(await clash.text(), /taken/i);
  assert.equal(rows(env, `SELECT * FROM groups`).length, 1);

  // And an unauthenticated visitor gets the sign-in page, not a group.
  const anon = await post(env, "/manage", { name: "Sneaky", handle: "sneaky" });
  assert.match(await anon.text(), /Sign in/);
  assert.equal(rows(env, `SELECT * FROM groups`).length, 1);
});

test("only a DJ who runs the group can announce its nights", async () => {
  const env = await withGoogle(makeEnv());
  const groupId = seedGroup(env);
  const outsider = await signIn(env);
  const body = new FormData();
  body.append("title", "Not yours");
  const refused = await get(env, "/@sundaze/manage", {
    method: "POST", body, headers: { cookie: `pp_s=${outsider.session[1]}` },
  });
  assert.equal(refused.status, 403);
  assert.equal(rows(env, `SELECT * FROM events`).length, 0);
  assert.ok(groupId);
});

const joinAs = async (env, email, volume) => {
  await post(env, "/@sundaze/join", { email });
  if (volume) {
    env.raw.prepare(`UPDATE group_members SET volume = ? WHERE member_id = (SELECT id FROM members WHERE email_norm = ?)`)
      .run(volume, email);
  }
  env.raw.prepare(`DELETE FROM outbox`).run();
};

test("an invitation reaches the group, and skips everyone entitled to be skipped", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  const eventId = seedEvent(env, groupId);
  const djId = ulid();
  env.raw.prepare(`INSERT INTO djs (id, email_norm, name, created_ms) VALUES (?, ?, ?, ?)`)
    .run(djId, "dj@example.com", "The DJ", Date.now());

  await joinAs(env, "everything@example.com", "all");
  await joinAs(env, "nights@example.com", "events");
  await joinAs(env, "muted@example.com", "none");
  await joinAs(env, "gone@example.com");
  await joinAs(env, "blocker@example.com");
  await joinAs(env, "stopped@example.com");
  env.raw.prepare(`UPDATE group_members SET state = 'left' WHERE member_id = (SELECT id FROM members WHERE email_norm = 'gone@example.com')`).run();
  env.raw.prepare(`INSERT INTO blocks (member_id, dj_id, created_ms) SELECT id, ?, ? FROM members WHERE email_norm = 'blocker@example.com'`).run(djId, Date.now());
  env.raw.prepare(`UPDATE members SET suppressed_ms = ? WHERE email_norm = 'stopped@example.com'`).run(Date.now());

  // Driven the way a DJ does it: the button on their own page.
  env.raw.prepare(`INSERT INTO group_djs (group_id, dj_id, role, created_ms) VALUES (?, ?, 'owner', ?)`)
    .run(groupId, djId, Date.now());
  const secret = "f".repeat(48);
  env.raw.prepare(`INSERT INTO sessions (id, hash, dj_id, created_ms, expires_ms) VALUES (?, ?, ?, ?, ?)`)
    .run(ulid(), await sha256Hex(secret), djId, Date.now(), Date.now() + 60000);

  const body = new FormData();
  body.append("invite", eventId);
  const response = await get(env, "/@sundaze/manage", {
    method: "POST", body, headers: { cookie: `pp_s=${secret}` },
  });
  assert.match(await response.text(), /2 people/, "only the two who asked to hear should be counted");

  const to = rows(env, `SELECT to_email FROM outbox WHERE kind = 'invite'`).map((r) => r.to_email).sort();
  assert.deepEqual(to, ["everything@example.com", "nights@example.com"]);

  // Pressing it twice is a DJ being unsure, not a reason to mail twice.
  const again = new FormData();
  again.append("invite", eventId);
  await get(env, "/@sundaze/manage", { method: "POST", body: again, headers: { cookie: `pp_s=${secret}` } });
  assert.equal(rows(env, `SELECT id FROM outbox WHERE kind = 'invite'`).length, 2);
});

test("the day-of reminder goes once, to the people who said they are coming", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  const soon = Date.now() + 6 * 60 * 60 * 1000;
  const eventId = seedEvent(env, groupId, { slug: "tonight", starts_ms: soon });
  await post(env, "/@sundaze/tonight/going", { email: "coming@example.com" });
  await post(env, "/@sundaze/join", { email: "notcoming@example.com" });
  env.raw.prepare(`DELETE FROM outbox`).run();

  await worker.scheduled({}, env);
  await worker.scheduled({}, env);

  const reminders = rows(env, `SELECT to_email FROM outbox WHERE kind = 'reminder'`);
  assert.deepEqual(reminders.map((r) => r.to_email), ["coming@example.com"],
    "a reminder is for people who are coming, and a second run must not repeat it");
  assert.ok(eventId);
});

test("the sender takes messages and marks them done", async () => {
  const env = makeEnv();
  env.OUTBOX_KEY = "sender-key";
  seedGroup(env);
  await post(env, "/@sundaze/join", { email: "guest@example.com" });

  const refused = await get(env, "/api/v1/outbox", {
    method: "POST", body: JSON.stringify({ key: "wrong" }),
  });
  assert.equal(refused.status, 403);

  const claim = await get(env, "/api/v1/outbox", {
    method: "POST", body: JSON.stringify({ key: "sender-key" }),
  });
  const { messages } = await claim.json();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to_email, "guest@example.com");

  await get(env, "/api/v1/outbox", {
    method: "POST", body: JSON.stringify({ key: "sender-key", sent: [messages[0].id] }),
  });
  assert.ok(one(env, `SELECT sent_ms FROM outbox`).sent_ms, "a sent message is not handed out again");
  const empty = await (await get(env, "/api/v1/outbox", {
    method: "POST", body: JSON.stringify({ key: "sender-key" }),
  })).json();
  assert.equal(empty.messages.length, 0);
});

for (const [name, fn] of tests) {
  try {
    await fn();
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}
console.log(`PASS ${tests.length} platform tests`);
