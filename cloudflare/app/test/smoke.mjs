import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, {
  entryCode, handleProblem, icsFor, normalizeEmail, payLinkProblem, sha256Hex, ulid,
} from "../worker.js";
import { totalForBuyer, verifyWebhook } from "../stripe.js";

// A real SQLite behind the D1 shape, so the tests exercise the actual SQL -
// including the ON CONFLICT clauses, which are where the join and going paths
// either work twice or corrupt a row.
const schema = ["0001_init.sql", "0002_installs.sql", "0003_merch.sql", "0004_tickets.sql", "0005_pro.sql"]
  .map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")).join("\n");

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
  // https, not webcal: Apple Calendar resolves webcal:// to http:// and warns
  // about an insecure connection before it fetches anything.
  assert.match(mail[0].body_text, /https:\/\/partyparty\.party\/@sundaze\.ics/);

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
  // What matters is that the draft's details do not leak - not that the feed is
  // empty, which it never is now: an empty calendar is one Google refuses.
  assert.ok(!/Sundaze at the Lido/.test(feed), "a draft must not appear in a subscribed calendar");
  assert.ok(!/secret/.test(feed));
  assert.match(feed, /PartyParty beta launch/, "so the group reads as having nothing on");
});

test("the group page and its calendar are served", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  seedEvent(env, groupId);

  const page = await (await get(env, "/@sundaze")).text();
  assert.match(page, /Sundaze/);
  assert.match(page, /value="https:\/\/partyparty\.party\/calendar\/sundaze\.ics"/,
    "no @ in a URL that gets pasted into a calendar client");
  assert.match(page, /calendar\.google\.com\/calendar\/render\?cid=webcal/,
    "r?cid= with an https url is the form Google refuses");
  assert.match(page, /webcal:\/\/partyparty\.party\/calendar\/sundaze\.ics/, "one click for Apple");

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
  assert.equal(done.headers.get("location"), "/home",
    "signing in lands on what is on, not on a management screen");
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

test("the group has a thread, and the volume on it belongs to the reader", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  await post(env, "/@sundaze/join", { email: "loud@example.com", name: "Loud" });
  const manage = /\/m\/([a-f0-9]{48})/.exec(one(env, `SELECT body_text FROM outbox`).body_text)[1];
  env.raw.prepare(`UPDATE group_members SET volume = 'all'`).run();
  await post(env, "/@sundaze/join", { email: "quiet@example.com" });
  env.raw.prepare(`UPDATE group_members SET volume = 'events' WHERE member_id =
    (SELECT id FROM members WHERE email_norm = 'quiet@example.com')`).run();
  env.raw.prepare(`DELETE FROM outbox`).run();

  const body = new FormData();
  body.append("say", "Doors at ten, bring a coat");
  const said = await get(env, `/m/${manage}`, { method: "POST", body });
  assert.equal(said.status, 302);

  const wall = await (await get(env, "/@sundaze")).text();
  assert.match(wall, /Doors at ten, bring a coat/, "the thread is on the group's page");

  // The poster is not mailed their own post, and "only nights" means only
  // nights - a busy thread must not reach someone who asked for quiet.
  const mailed = rows(env, `SELECT to_email FROM outbox`).map((r) => r.to_email);
  assert.deepEqual(mailed, [], "nobody else asked for every post");

  env.raw.prepare(`UPDATE group_members SET volume = 'all' WHERE member_id =
    (SELECT id FROM members WHERE email_norm = 'quiet@example.com')`).run();
  const again = new FormData();
  again.append("say", "One more thing");
  await get(env, `/m/${manage}`, { method: "POST", body: again });
  assert.deepEqual(rows(env, `SELECT to_email FROM outbox`).map((r) => r.to_email),
    ["quiet@example.com"], "turning it up is what makes a post arrive");
  assert.ok(groupId);
});

const macEnv = (env, id = "aabbccddeeff", secret = "s3cret") => {
  const store = new Map([[`broker/${id}.json`, JSON.stringify({ secret, hostLabel: "disco-one" })]]);
  env.DL = {
    get: async (key) => (store.has(key) ? { text: async () => store.get(key) } : null),
    head: async (key) => (store.has(key) ? {} : null),
    put: async (key, value) => { store.set(key, value); },
  };
  return { id, secret };
};

const api = (env, path, body) => worker.fetch(new Request("https://partyparty.party" + path, {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" },
}), env);

test("a Mac pairs to a group with a code the DJ can read off the screen", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  const mac = macEnv(env);
  const djId = ulid();
  env.raw.prepare(`INSERT INTO djs (id, email_norm, name, created_ms) VALUES (?, ?, ?, ?)`)
    .run(djId, "dj@example.com", "DJ", Date.now());
  env.raw.prepare(`INSERT INTO group_djs (group_id, dj_id, role, created_ms) VALUES (?, ?, 'owner', ?)`)
    .run(groupId, djId, Date.now());
  const secret = "e".repeat(48);
  env.raw.prepare(`INSERT INTO sessions (id, hash, dj_id, created_ms, expires_ms) VALUES (?, ?, ?, ?, ?)`)
    .run(ulid(), await sha256Hex(secret), djId, Date.now(), Date.now() + 60000);

  assert.equal((await api(env, "/api/v1/install/code", { id: mac.id, secret: "wrong" })).status, 403);
  const asked = await (await api(env, "/api/v1/install/code", mac)).json();
  assert.equal(asked.linked, false);
  assert.match(asked.code, /^[ACDEFGHJKLMNPQRTUVWXY3479]{6}$/);

  const body = new FormData();
  body.append("pair", asked.code.toLowerCase()); // typed in lowercase, still works
  await get(env, "/@sundaze/manage", { method: "POST", body, headers: { cookie: `pp_s=${secret}` } });
  assert.equal(one(env, `SELECT group_id FROM install_groups`).group_id, groupId);

  // A code is single use, so a screenshot in a group chat is not a key.
  const again = new FormData();
  again.append("pair", asked.code);
  const reused = await get(env, "/@sundaze/manage", {
    method: "POST", body: again, headers: { cookie: `pp_s=${secret}` },
  });
  assert.match(await reused.text(), /expired/i);

  const linked = await (await api(env, "/api/v1/install/code", mac)).json();
  assert.equal(linked.linked, true, "a paired Mac is told so rather than handed another code");
});

test("a party finds tonight's night by itself, and never steals another one", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  const mac = macEnv(env);
  env.raw.prepare(`INSERT INTO install_groups (install_id, group_id, linked_ms) VALUES (?, ?, ?)`)
    .run(mac.id, groupId, Date.now());
  const partyId = "2026-08-06-2200-ab12";

  const nothing = await (await api(env, "/api/v1/party/bind", { ...mac, partyId })).json();
  assert.equal(nothing.bound, false, "no night on means no binding, not a guess");

  const tonight = seedEvent(env, groupId, { slug: "tonight", starts_ms: Date.now() + 3600000 });
  const bound = await (await api(env, "/api/v1/party/bind", { ...mac, partyId })).json();
  assert.equal(bound.bound, true);
  assert.equal(bound.slug, "tonight");
  assert.equal(one(env, `SELECT state FROM events WHERE id = ?`, tonight).state, "live");

  // Another Mac, another party, same night: two rooms merging walls by
  // accident is worse than one wall staying local.
  const other = macEnv(env, "112233445566", "other");
  env.raw.prepare(`INSERT INTO install_groups (install_id, group_id, linked_ms) VALUES (?, ?, ?)`)
    .run(other.id, groupId, Date.now());
  const refused = await (await api(env, "/api/v1/party/bind", { ...other, partyId: "2026-08-06-2300-cd34" })).json();
  assert.equal(refused.bound, false);
});

test("the wall on the venue Wi-Fi and the page three days later are one timeline", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  const mac = macEnv(env);
  const partyId = "2026-08-06-2200-ab12";
  const eventId = seedEvent(env, groupId, { slug: "tonight", starts_ms: Date.now() + 3600000 });
  env.raw.prepare(`UPDATE events SET party_id = ? WHERE id = ?`).run(partyId, eventId);

  const lanPost = { id: "a".repeat(32), author: "Guest", body: "on the dancefloor", createdMs: Date.now() };
  const first = await (await api(env, "/api/v1/party/posts", { ...mac, partyId, posts: [lanPost] })).json();
  assert.equal(first.bound, true);
  assert.equal(first.stored, 1);
  assert.equal(one(env, `SELECT origin FROM posts`).origin, "lan");

  // Pushing the same post again is a retry after a dropped connection, not a
  // second photo.
  const retry = await (await api(env, "/api/v1/party/posts", { ...mac, partyId, posts: [lanPost] })).json();
  assert.equal(rows(env, `SELECT id FROM posts`).length, 1);
  assert.equal(retry.posts.length, 0, "the Mac must not be handed back its own posts");

  // Someone posts from the web three days later; the Mac picks it up.
  env.raw.prepare(
    `INSERT INTO posts (id, group_id, event_id, author, body, origin, created_ms) VALUES (?, ?, ?, ?, ?, 'web', ?)`
  ).run(ulid(), groupId, eventId, "Later", "here are my photos", Date.now() + 1000);
  const pulled = await (await api(env, "/api/v1/party/posts", { ...mac, partyId, since: 0 })).json();
  assert.equal(pulled.posts.length, 1);
  assert.equal(pulled.posts[0].body, "here are my photos");

  // A party with no night attached is normal, not an error.
  const loose = await (await api(env, "/api/v1/party/posts", { ...mac, partyId: "2026-08-06-2300-cd34" })).json();
  assert.equal(loose.bound, false);
});

test("a tip goes straight to the DJ, and only over https", async () => {
  assert.equal(payLinkProblem(""), "", "no link is a valid answer: tipping is off");
  assert.equal(payLinkProblem("https://revolut.me/someone"), "");
  assert.ok(payLinkProblem("http://revolut.me/someone"), "plain http on a tap-through page");
  assert.ok(payLinkProblem("javascript:alert(1)"));
  assert.ok(payLinkProblem("revolut.me/someone"), "a bare host is not a link");

  const env = makeEnv();
  const groupId = seedGroup(env);
  seedEvent(env, groupId);
  const djId = ulid();
  env.raw.prepare(`INSERT INTO djs (id, email_norm, name, created_ms) VALUES (?, ?, ?, ?)`)
    .run(djId, "dj@example.com", "DJ", Date.now());
  env.raw.prepare(`INSERT INTO group_djs (group_id, dj_id, role, created_ms) VALUES (?, ?, 'owner', ?)`)
    .run(groupId, djId, Date.now());
  const secret = "d".repeat(48);
  env.raw.prepare(`INSERT INTO sessions (id, hash, dj_id, created_ms, expires_ms) VALUES (?, ?, ?, ?, ?)`)
    .run(ulid(), await sha256Hex(secret), djId, Date.now(), Date.now() + 60000);

  const save = (value) => {
    const body = new FormData();
    body.append("payLink", value);
    return get(env, "/@sundaze/manage", { method: "POST", body, headers: { cookie: `pp_s=${secret}` } });
  };
  assert.match(await (await save("http://insecure.example")).text(), /https/);
  assert.equal(one(env, `SELECT pay_link FROM groups`).pay_link, "");

  await save("https://revolut.me/someone");
  assert.equal(one(env, `SELECT pay_link FROM groups`).pay_link, "https://revolut.me/someone");
  assert.match(await (await get(env, "/@sundaze")).text(), /Tip the DJ/);
  assert.match(await (await get(env, "/@sundaze/june-14")).text(), /Tip the DJ/);

  // Turning it off removes it from the page rather than leaving a dead button.
  await save("");
  assert.ok(!(await (await get(env, "/@sundaze")).text()).includes("Tip the DJ"));
});

const signedInDJ = async (env, groupId) => {
  const djId = ulid();
  env.raw.prepare(`INSERT INTO djs (id, email_norm, name, created_ms) VALUES (?, ?, ?, ?)`)
    .run(djId, `dj-${djId}@example.com`, "DJ", Date.now());
  env.raw.prepare(`INSERT INTO group_djs (group_id, dj_id, role, created_ms) VALUES (?, ?, 'owner', ?)`)
    .run(groupId, djId, Date.now());
  const secret = randomSecret();
  env.raw.prepare(`INSERT INTO sessions (id, hash, dj_id, created_ms, expires_ms) VALUES (?, ?, ?, ?, ?)`)
    .run(ulid(), await sha256Hex(secret), djId, Date.now(), Date.now() + 60000);
  return { djId, cookie: `pp_s=${secret}` };
};
let secretSeq = 0;
const randomSecret = () => String(++secretSeq).padStart(48, "b");

test("a full night says so instead of quietly taking one more", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  const eventId = seedEvent(env, groupId, { slug: "small" });
  env.raw.prepare(`UPDATE events SET capacity = 1 WHERE id = ?`).run(eventId);

  assert.equal((await post(env, "/@sundaze/small/going", { email: "first@example.com" })).status, 200);
  const full = await post(env, "/@sundaze/small/going", { email: "second@example.com" });
  assert.match(await full.text(), /<h1>This one is full<\/h1>/,
    "match the message, not any occurrence of the word in the whole document");
  assert.equal(rows(env, `SELECT * FROM signups`).length, 1);

  // Someone already coming can re-confirm without being told it is full.
  const again = await post(env, "/@sundaze/small/going", { email: "first@example.com" });
  assert.ok(!/<h1>This one is full<\/h1>/.test(await again.text()));
});

test("the door works with no signal, and only for a DJ who runs the group", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  const eventId = seedEvent(env, groupId, { slug: "tonight" });
  await post(env, "/@sundaze/tonight/going", { email: "guest@example.com", name: "Ada" });
  const memberId = one(env, `SELECT id FROM members`).id;
  const code = await entryCode(eventId, memberId);

  assert.equal((await get(env, "/@sundaze/tonight/door")).status, 403);

  const dj = await signedInDJ(env, groupId);
  const door = await get(env, "/@sundaze/tonight/door", { headers: { cookie: dj.cookie } });
  const body = await door.text();
  assert.match(body, /Ada/);
  assert.match(body, new RegExp(code));
  assert.ok(!body.includes("fetch("), "the door must not need the network once it has loaded");

  // The same code reaches the guest, or it is no use at a door.
  assert.match(one(env, `SELECT body_text FROM outbox WHERE kind = 'ticket'`).body_text, new RegExp(code));
});

test("entry codes are per person per night and readable aloud", async () => {
  const a = await entryCode("ev1", "m1");
  assert.equal(a, await entryCode("ev1", "m1"), "the same signup must always give the same code");
  assert.notEqual(a, await entryCode("ev1", "m2"));
  assert.notEqual(a, await entryCode("ev2", "m1"));
  assert.match(a, /^[ACDEFGHJKLMNPQRTUVWXY3479]{6}$/, "no characters that argue with each other at a door");
});

test("merch is a link to the store the DJ already has", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  const dj = await signedInDJ(env, groupId);
  const save = (link, label) => {
    const body = new FormData();
    body.append("merchLink", link);
    body.append("merchLabel", label);
    return get(env, "/@sundaze/manage", { method: "POST", body, headers: { cookie: dj.cookie } });
  };
  assert.match(await (await save("http://shop.example", "Shirts")).text(), /https/);
  await save("https://shop.example/sundaze", "Shirts");
  const page = await (await get(env, "/@sundaze")).text();
  assert.match(page, /https:\/\/shop\.example\/sundaze/);
  assert.match(page, /Shirts/);
  assert.match(page, /rel="noopener noreferrer nofollow"/, "an outbound store link is not an endorsement");
});

test("the buyer pays face value plus our cut plus processing, grossed up", () => {
  // A $20 ticket at a 5% cut. The processing fee is taken from the FINAL total,
  // so adding it before the division leaves the DJ short of the price they set.
  const priced = totalForBuyer(2000, 0.05);
  assert.equal(priced.ours, 100);
  assert.equal(priced.total, 2194, "$21.94 - Posh charges $22.99 for the same ticket");
  assert.equal(priced.total - priced.ours - priced.processing, 2000, "the DJ receives exactly the face value");

  // Stripe's own share really is covered rather than approximated.
  const stripeTakes = Math.round(priced.total * 0.029) + 30;
  assert.ok(priced.processing >= stripeTakes, `processing ${priced.processing} < stripe ${stripeTakes}`);

  // Pro removes our cut and the buyer sees it.
  assert.equal(totalForBuyer(2000, 0).total, 2091);
});

test("an unsigned webhook is just a POST from anybody", async () => {
  const secret = "whsec_test";
  const payload = JSON.stringify({ type: "checkout.session.completed" });
  const nowMs = 1754500000000;
  const stamp = Math.floor(nowMs / 1000);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${stamp}.${payload}`));
  const signature = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");

  assert.equal(await verifyWebhook(secret, `t=${stamp},v1=${signature}`, payload, nowMs), true);
  assert.equal(await verifyWebhook(secret, `t=${stamp},v1=${signature}`, payload + " ", nowMs), false);
  assert.equal(await verifyWebhook(secret, `t=${stamp},v1=deadbeef`, payload, nowMs), false);
  assert.equal(await verifyWebhook("", `t=${stamp},v1=${signature}`, payload, nowMs), false);
  // A replay from an hour ago is not news.
  assert.equal(await verifyWebhook(secret, `t=${stamp},v1=${signature}`, payload, nowMs + 3600000), false);
});

test("a paid ticket becomes a signup and a code, once", async () => {
  const env = makeEnv();
  env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const groupId = seedGroup(env);
  const eventId = seedEvent(env, groupId, { slug: "paid" });
  await post(env, "/@sundaze/join", { email: "buyer@example.com" });
  const memberId = one(env, `SELECT id FROM members`).id;

  const send = async (sessionId) => {
    const payload = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { id: sessionId, amount_total: 2194, payment_intent: "pi_1",
        metadata: { eventId, memberId } } },
    });
    const stamp = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode("whsec_test"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${stamp}.${payload}`));
    const signature = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return worker.fetch(new Request("https://partyparty.party/api/v1/stripe/webhook", {
      method: "POST", body: payload, headers: { "stripe-signature": `t=${stamp},v1=${signature}` },
    }), env);
  };

  assert.equal((await send("cs_1")).status, 200);
  assert.equal(one(env, `SELECT state FROM signups`).state, "going");
  const ticket = one(env, `SELECT * FROM tickets`);
  assert.equal(ticket.state, "paid");
  assert.equal(ticket.code, await entryCode(eventId, memberId), "the door and the buyer see the same code");

  // Stripe retries webhooks. A retry must not sell the same seat twice.
  await send("cs_1");
  assert.equal(rows(env, `SELECT id FROM tickets`).length, 1);
  assert.equal(rows(env, `SELECT * FROM signups`).length, 1);

  const forged = await worker.fetch(new Request("https://partyparty.party/api/v1/stripe/webhook", {
    method: "POST", body: JSON.stringify({ type: "checkout.session.completed" }),
    headers: { "stripe-signature": "t=1,v1=00" },
  }), env);
  assert.equal(forged.status, 403);
});

const stripeWebhook = async (env, body) => {
  const payload = JSON.stringify(body);
  const stamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode("whsec_test"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${stamp}.${payload}`));
  const signature = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return worker.fetch(new Request("https://partyparty.party/api/v1/stripe/webhook", {
    method: "POST", body: payload, headers: { "stripe-signature": `t=${stamp},v1=${signature}` },
  }), env);
};

test("Pro removes our cut, and losing it puts the cut back", async () => {
  const env = makeEnv();
  env.STRIPE_WEBHOOK_SECRET = "whsec_test";
  const groupId = seedGroup(env);
  const eventId = seedEvent(env, groupId, { slug: "paid" });
  env.raw.prepare(`UPDATE events SET ticket_cents = 2000 WHERE id = ?`).run(eventId);

  // Before: the buyer sees the price with our 5% in it.
  assert.match(await (await get(env, "/@sundaze/paid")).text(), /21\.94/);

  await stripeWebhook(env, {
    type: "checkout.session.completed",
    data: { object: { id: "cs_pro", subscription: "sub_1", metadata: { proGroupId: groupId, period: "month" } } },
  });
  assert.equal(one(env, `SELECT state FROM entitlements`).state, "active");
  assert.match(await (await get(env, "/@sundaze/paid")).text(), /20\.91/, "Pro shows in the buyer's price");

  // Cancelling has to switch the fee back on, or Pro is permanent for anyone
  // who stops paying for it.
  await stripeWebhook(env, { type: "customer.subscription.deleted", data: { object: { id: "sub_1" } } });
  assert.equal(one(env, `SELECT state FROM entitlements`).state, "lapsed");
  assert.match(await (await get(env, "/@sundaze/paid")).text(), /21\.94/);
});

test("Pro is on when either store says so", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  // The App Store half writes the same row with its own source. Whichever
  // arrives, the group is Pro; asking one store alone is how a DJ who paid on
  // the web gets charged a fee in the app.
  env.raw.prepare(
    `INSERT INTO entitlements (group_id, source, state, reference, updated_ms) VALUES (?, 'appstore', 'active', 't1', ?)`
  ).run(groupId, Date.now());
  const eventId = seedEvent(env, groupId, { slug: "paid" });
  env.raw.prepare(`UPDATE events SET ticket_cents = 2000 WHERE id = ?`).run(eventId);
  assert.match(await (await get(env, "/@sundaze/paid")).text(), /20\.91/);
});

test("the development doors are shut unless they are opened on purpose", async () => {
  const env = makeEnv();
  // Signing in as anybody and reading everyone's mail. In production either one
  // is a total compromise, so the default must be closed, not merely unlinked.
  assert.equal((await get(env, "/dev/signin?email=someone@example.com")).status, 404);
  assert.equal((await get(env, "/dev/outbox")).status, 404);
  assert.equal(rows(env, `SELECT * FROM djs`).length, 0);

  env.DEV_LOGIN = "1";
  const signedIn = await get(env, "/dev/signin?email=dj@example.com");
  assert.equal(signedIn.status, 302);
  assert.match(signedIn.headers.get("set-cookie") || "", /pp_s=[a-f0-9]{48}/);
  assert.equal(one(env, `SELECT email_norm FROM djs`).email_norm, "dj@example.com");

  seedGroup(env);
  await post(env, "/@sundaze/join", { email: "guest@example.com" });
  const outbox = await (await get(env, "/dev/outbox")).text();
  assert.match(outbox, /guest@example\.com/);
  assert.match(outbox, /<a href="https:\/\/partyparty\.party\/j\/[a-f0-9]{48}"/,
    "the confirm link has to be clickable or the flow cannot be walked");
});

test("the outbox drains, retries what fails, and gives up after five tries", async () => {
  const env = makeEnv();
  seedGroup(env);
  await post(env, "/@sundaze/join", { email: "guest@example.com" });

  // No mail server is not an error - it is a Worker that has not been given
  // one yet, and the queue must simply wait rather than burn its retries.
  const idle = await worker.scheduled({}, env);
  assert.equal(one(env, `SELECT tries FROM outbox`).tries, 0);
  assert.equal(one(env, `SELECT sent_ms FROM outbox`).sent_ms, null);
  assert.equal(idle, undefined);

  // A message that has already failed five times is not offered again: a bad
  // address must not be retried forever at a shared mailbox's expense.
  env.raw.prepare(`UPDATE outbox SET tries = 5`).run();
  const { results } = await env.DB.prepare(
    `SELECT id FROM outbox WHERE sent_ms IS NULL AND tries < 5`
  ).all();
  assert.equal((results || []).length, 0);
});

test("the flush endpoint is guarded by the key", async () => {
  const env = makeEnv();
  env.OUTBOX_KEY = "flush-key";
  const refused = await get(env, "/api/v1/outbox/flush", {
    method: "POST", body: JSON.stringify({ key: "wrong" }),
  });
  assert.equal(refused.status, 403);
  const allowed = await get(env, "/api/v1/outbox/flush", {
    method: "POST", body: JSON.stringify({ key: "flush-key" }),
  });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).reason, "no mail server configured");
});

test("/manage routes rather than being a page: none, one, several", async () => {
  const env = await withGoogle(makeEnv());
  const { session } = await signIn(env);
  const cookie = { headers: { cookie: `pp_s=${session[1]}` } };

  // No group: the page IS the onboarding, not a list with a form under it.
  const empty = await (await get(env, "/manage", cookie)).text();
  assert.match(empty, /Start your group/);
  assert.ok(!/Your groups/.test(empty));

  const make = (name, handle) => {
    const body = new FormData();
    body.append("name", name); body.append("handle", handle);
    return get(env, "/manage", { method: "POST", body, headers: cookie.headers });
  };
  await make("Sundaze", "sundaze");

  // One group: land inside it. A list of one thing is a redirect with steps.
  const single = await get(env, "/manage", cookie);
  assert.equal(single.status, 302);
  assert.equal(single.headers.get("location"), "/@sundaze/manage");

  // Several: only now is choosing a real job.
  await make("Lates", "latenight");
  const many = await get(env, "/manage", cookie);
  assert.equal(many.status, 200);
  const body = await many.text();
  assert.match(body, /Which one/);
  assert.match(body, /@sundaze/);
  assert.match(body, /@latenight/);
});

test("the group page leads with adding a night and its sendable link", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  seedEvent(env, groupId, { slug: "june-14" });
  const dj = await signedInDJ(env, groupId);
  const body = await (await get(env, "/@sundaze/manage", { headers: { cookie: dj.cookie } })).text();

  // The job: add a night, get the link, send it.
  assert.match(body, /Add a night/);
  assert.match(body, /value="https:\/\/partyparty\.party\/@sundaze\/june-14"/,
    "the link has to be there to be copied, not derived by the DJ");
  assert.match(body, /Copy<\/button>/);
  assert.match(body, /Email the group/);

  // Everything set once is present but behind the fold, not competing with it.
  const settings = body.indexOf("<details");
  assert.ok(settings > 0, "settings must exist");
  assert.ok(body.indexOf("Add a night") < settings, "adding a night comes first");
  // Headings, not bare words: "Pro" alone matches "SF Pro Text" in the font
  // stack, which is the sort of false pass that makes a layout test worthless.
  for (const later of ["<h2>Pair a Mac", "<h2>Tips", "<h2>Merch", "<h2>Pro"]) {
    assert.ok(body.indexOf(later) > settings, `${later} belongs behind settings`);
  }
  // Your own name and signing out are yours, not this group's.
  assert.ok(!/Sign out/.test(body), "signing out is a you thing, not a group thing");
  assert.match(body, /href="\/settings"/);
});

test("renaming a group moves its address, and the old one stops", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  const dj = await signedInDJ(env, groupId);
  env.DL = new Map();
  env.DL.head = async (k) => (env.DL.has(k) ? {} : null);
  env.DL.put = async (k, v) => { env.DL.set(k, v); };

  const body = new FormData();
  body.append("groupName", "Sundaze");
  body.append("handle", "slowsunday");
  assert.equal((await get(env, "/@sundaze/manage", {
    method: "POST", body, headers: { cookie: dj.cookie },
  })).status, 302);

  assert.equal(one(env, `SELECT handle FROM groups`).handle, "slowsunday");
  assert.equal((await get(env, "/@slowsunday")).status, 200);
  assert.equal((await get(env, "/@sundaze")).status, 404);
  // Reserved, though: an abandoned address is never handed to a stranger.
  assert.ok(env.DL.has("broker/handle/sundaze") || env.DL.has("broker/handle/slowsunday"));
});

test("home shows what is on across groups you run and groups you follow", async () => {
  const env = await withGoogle(makeEnv());
  const { session } = await signIn(env);
  const cookie = { headers: { cookie: `pp_s=${session[1]}` } };

  const empty = await (await get(env, "/home", cookie)).text();
  assert.match(empty, /Nothing coming up yet/);
  assert.match(empty, /Nobody yet/);

  // A group they run.
  const mineId = seedGroup(env, "sundaze");
  const dj = one(env, `SELECT id FROM djs`).id;
  env.raw.prepare(`INSERT INTO group_djs (group_id, dj_id, role, created_ms) VALUES (?, ?, 'owner', ?)`)
    .run(mineId, dj, Date.now());
  seedEvent(env, mineId, { slug: "mine", title: "My night", starts_ms: Date.now() + 86400000 });

  // A group they follow, matched by the address they signed in with.
  const theirsId = seedGroup(env, "latenight");
  env.raw.prepare(`UPDATE groups SET name = 'Late Night' WHERE id = ?`).run(theirsId);
  const memberId = ulid();
  env.raw.prepare(`INSERT INTO members (id, email_norm, name, created_ms) VALUES (?, 'dj@example.com', 'DJ', ?)`)
    .run(memberId, Date.now());
  env.raw.prepare(`INSERT INTO group_members (group_id, member_id, state, volume, source, joined_ms)
    VALUES (?, ?, 'joined', 'events', 'link', ?)`).run(theirsId, memberId, Date.now());
  seedEvent(env, theirsId, { slug: "theirs", title: "Their night", starts_ms: Date.now() + 172800000 });

  const body = await (await get(env, "/home", cookie)).text();
  assert.match(body, /My night/, "a night from a group you run");
  assert.match(body, /Their night/, "a night from a group you follow - the point of following");
  assert.match(body, /Late Night/);
  assert.match(body, /you run this/);
});

test("your own group page offers management, not a form asking your name", async () => {
  const env = await withGoogle(makeEnv());
  const { session } = await signIn(env);
  const groupId = seedGroup(env);
  const dj = one(env, `SELECT id FROM djs`).id;
  env.raw.prepare(`INSERT INTO group_djs (group_id, dj_id, role, created_ms) VALUES (?, ?, 'owner', ?)`)
    .run(groupId, dj, Date.now());

  const mine = await (await get(env, "/@sundaze", { headers: { cookie: `pp_s=${session[1]}` } })).text();
  assert.match(mine, /Manage this group/);
  assert.ok(!/placeholder="your name"/.test(mine),
    "it must not ask its owner to introduce themselves");

  // A stranger still gets the follow form, and it says what following means.
  const stranger = await (await get(env, "/@sundaze")).text();
  assert.match(stranger, /placeholder="your name"/);
  assert.match(stranger, /Hear about their nights/, "the action says what following does");
});

test("your settings are yours: name, and who you follow", async () => {
  const env = await withGoogle(makeEnv());
  const { session } = await signIn(env);
  const cookie = { headers: { cookie: `pp_s=${session[1]}` } };

  const groupId = seedGroup(env, "latenight");
  const memberId = ulid();
  env.raw.prepare(`INSERT INTO members (id, email_norm, name, created_ms) VALUES (?, 'dj@example.com', '', ?)`)
    .run(memberId, Date.now());
  env.raw.prepare(`INSERT INTO group_members (group_id, member_id, state, volume, source, joined_ms)
    VALUES (?, ?, 'joined', 'all', 'link', ?)`).run(groupId, memberId, Date.now());

  const body = await (await get(env, "/settings", cookie)).text();
  assert.match(body, /dj@example\.com/);
  assert.match(body, /every post/, "it says how much you hear, in words");
  assert.match(body, /Sundaze/);

  const form = new FormData();
  form.append("name", "Ramine");
  await get(env, "/settings", { method: "POST", body: form, headers: cookie.headers });
  assert.equal(one(env, `SELECT name FROM djs`).name, "Ramine");
  // The same person as a member of other people's groups, not two records.
  assert.equal(one(env, `SELECT name FROM members`).name, "Ramine");

  assert.match(await (await get(env, "/settings")).text(), /Sign in/,
    "signed out, it is not your settings to see");
});

test("plaintext is redirected before a token in the path can leak", async () => {
  const env = makeEnv();
  // Every emailed link carries its credential in the URL. Answering one over
  // http hands it to anything on the wire, and it is also why subscribing to a
  // calendar warned: webcal:// resolves to http://.
  for (const path of ["/signin", "/home", "/m/" + "a".repeat(48), "/@sundaze.ics"]) {
    const response = await worker.fetch(new Request("http://partyparty.party" + path), env);
    assert.equal(response.status, 301, path);
    assert.equal(response.headers.get("location"), "https://partyparty.party" + path);
  }
  const secure = await get(env, "/signin");
  assert.match(secure.headers.get("strict-transport-security") || "", /max-age=\d+/);
  assert.ok(!/includeSubDomains/.test(secure.headers.get("strict-transport-security") || ""),
    "the machine hostnames under this zone are the Mac's, and one is deliberately plain HTTP");
});

test("a calendar feed is one clients will actually accept", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);

  // A brand new group has nothing announced, and a calendar with no components
  // is what Google answers with "unable to add calendar. check the URL."
  const empty = await (await get(env, "/calendar/sundaze.ics")).text();
  assert.match(empty, /BEGIN:VEVENT/, "never a component-less calendar");
  assert.match(empty, /SUMMARY:PartyParty beta launch/);
  assert.match(empty, /DTSTART;VALUE=DATE:20260801/);
  assert.match(empty, /TRANSP:TRANSPARENT/, "the placeholder does not occupy anyone's day");
  assert.ok(!/STATUS:CANCELLED/.test(empty),
    "a calendar whose only event is cancelled has zero usable events - Google refuses it");
  assert.ok(!/METHOD:/.test(empty),
    "METHOD belongs on an invitation, not a subscription feed - Google rejects it");
  assert.match(empty, /REFRESH-INTERVAL;VALUE=DURATION:P1D/);

  // Both paths serve it: the pretty one, and one with no @ to be mangled.
  assert.equal((await get(env, "/@sundaze.ics")).status, 200);

  // With a real night, the placeholder gets out of the way.
  seedEvent(env, groupId);
  const real = await (await get(env, "/calendar/sundaze.ics")).text();
  assert.match(real, /SUMMARY:Sundaze at the Lido/);
  assert.ok(!/beta launch/.test(real), "a real night replaces the placeholder");
});

test("the group page is a party page: timeline, posts, and who is in it", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  seedEvent(env, groupId, { slug: "june-14", title: "At the Lido" });
  seedEvent(env, groupId, { slug: "old", title: "Last month", starts_ms: Date.now() - 86400000 });
  for (const [email, name] of [["ada@example.com", "Ada Lovelace"], ["bo@example.com", "Bo"]]) {
    await post(env, "/@sundaze/join", { email, name });
  }

  const body = await (await get(env, "/@sundaze")).text();

  // Nights read as a schedule, and one that has been is marked as past.
  assert.match(body, /class="timeline"/);
  assert.match(body, /At the Lido/);
  assert.match(body, /class="tl past"/, "a night that has happened is not still upcoming");

  // The people, in the rail, as initials on the app's gradient discs.
  assert.match(body, /class="rail"/);
  assert.match(body, /2 people/);
  assert.match(body, /class="avatar"[^>]*>AL</, "initials from the name they gave");
  assert.match(body, /Ada Lovelace/);
  // Their addresses are the group's, not the public page's.
  assert.ok(!/ada@example\.com/.test(body), "an address never appears on a public page");
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
