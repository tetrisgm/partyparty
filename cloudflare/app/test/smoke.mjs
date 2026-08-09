import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, {
  entryCode, handleProblem, icsFor, normalizeEmail, parseNight, payLinkProblem,
  sha256Hex, ulid,
} from "../worker.js";
import { totalForBuyer, verifyWebhook } from "../stripe.js";

// A real SQLite behind the D1 shape, so the tests exercise the actual SQL -
// including the ON CONFLICT clauses, which are where the join and going paths
// either work twice or corrupt a row.
// Read the directory rather than listing the files. A hardcoded list is a
// second place to remember, and it had already fallen three migrations behind -
// which means the tests were passing against a schema production does not have.
const migrations = new URL("../migrations/", import.meta.url);
const schema = readdirSync(migrations)
  .filter((name) => name.endsWith(".sql")).sort()
  .map((name) => readFileSync(new URL(name, migrations), "utf8")).join("\n");

class Stmt {
  constructor(db, sql) { this.db = db; this.sql = sql; this.args = []; }
  bind(...args) { this.args = args.map((a) => (a === undefined ? null : a)); return this; }
  async first() { const row = this.db.prepare(this.sql).get(...this.args); return row === undefined ? null : row; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() { this.db.prepare(this.sql).run(...this.args); return { success: true }; }
}

// R2, as far as this worker uses it: reserved handles and stored pictures.
// In memory, so an upload can be asserted on rather than assumed.
const makeBucket = () => {
  const objects = new Map();
  return {
    objects,
    async head(key) { return objects.has(key) ? { key } : null; },
    async get(key) {
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        body: stored.body,
        httpMetadata: stored.httpMetadata,
        async text() { return String(stored.body); },
      };
    },
    async put(key, body, options) {
      objects.set(key, { body, httpMetadata: (options && options.httpMetadata) || {} });
    },
  };
};

const makeEnv = () => {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  return { DB: { prepare: (sql) => new Stmt(db, sql), _db: db }, DL: makeBucket(), raw: db };
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
  // A party belongs to a person. Seeded rows take the group's DJ the same way
  // the migration does, so a fixture is not a party nobody owns.
  const owner = over.owner_email ?? (env.raw.prepare(
    `SELECT d.email_norm FROM group_djs gd JOIN djs d ON d.id = gd.dj_id
      WHERE gd.group_id = ? ORDER BY gd.created_ms LIMIT 1`
  ).get(groupId)?.email_norm ?? "");
  // Published, like every party that existed before visibility did - the
  // migration marks those public for exactly this reason. A party CREATED now
  // starts private; these fixtures stand in for nights already on the internet.
  env.raw.prepare(
    `INSERT INTO events (id, group_id, owner_email, slug, title, starts_ms, place, state,
       visibility, created_ms, updated_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, groupId, owner, event.slug, event.title, event.starts_ms, event.place, event.state,
    over.visibility ?? "public", Date.now(), Date.now());
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

// The sentence the product exists for, read in one line. Every case here is a
// way somebody actually types it, and the last group is the important half:
// what the parser must REFUSE to guess.
test("one line writes the whole night", () => {
  const night = parseNight("saw Ada and Bo, played Windowlicker, with Cy and Dee");
  assert.deepEqual(night.djs, ["Ada", "Bo"]);
  assert.deepEqual(night.guests, ["Cy", "Dee"]);
  assert.deepEqual(night.songs, [{ title: "Windowlicker", artist: "" }]);

  // The owner's own sentence, near enough word for word.
  const owner = parseNight("I saw DJ 1, 2 and 3. They played song XYZ. I was with A, B and C");
  assert.deepEqual(owner.djs, ["1", "2", "3"]);
  assert.deepEqual(owner.songs, [{ title: "XYZ", artist: "" }]);
  assert.deepEqual(owner.guests, ["A", "B", "C"]);

  // No word for who played: the list at the front is who played.
  const lead = parseNight("Ada and Bo, they played Xtal by Aphex Twin, with Cy");
  assert.deepEqual(lead.djs, ["Ada", "Bo"]);
  assert.deepEqual(lead.songs, [{ title: "Xtal", artist: "Aphex Twin" }]);
  assert.deepEqual(lead.guests, ["Cy"]);

  // One artist covers the whole clause; quotes make a song with no word at all.
  const many = parseNight('played Xtal and Ageispolis by Aphex Twin');
  assert.deepEqual(many.songs, [
    { title: "Xtal", artist: "Aphex Twin" }, { title: "Ageispolis", artist: "Aphex Twin" }]);
  const quoted = parseNight('saw Ada, she played \u201cWindowlicker\u201d');
  assert.deepEqual(quoted.djs, ["Ada"]);
  assert.deepEqual(quoted.songs, [{ title: "Windowlicker", artist: "" }]);

  // "played by Ada" says who played. It is not a song called Ada.
  assert.deepEqual(parseNight("played by Ada").djs, ["Ada"]);
  assert.deepEqual(parseNight("played by Ada").songs, []);

  // Shorthand, and the same person twice is one person.
  assert.deepEqual(parseNight("w/ Cy").guests, ["Cy"]);
  assert.deepEqual(parseNight("saw Ada and Ada").djs, ["Ada"]);

  // A word is only a word on its own. Sawyer played; "saw" did not.
  assert.deepEqual(parseNight("saw Sawyer and Withers").djs, ["Sawyer", "Withers"]);

  // And what it must not guess: a bare list means nothing on its own, so the
  // buttons decide. Guessing here would file people under the wrong heading.
  for (const bare of ["Ada, Bo and Cy", "Ada", "", "   "]) {
    const nothing = parseNight(bare);
    assert.equal(nothing.used, false, `"${bare}" should not be read as a sentence`);
    assert.deepEqual([nothing.djs, nothing.guests, nothing.songs], [[], [], []]);
  }
});

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

test("a handle is a person, and their calendar is served", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  // Groups are dead. An address that WAS a group's handle still resolves - to
  // the person who owned it, showing the same parties, because the rows never
  // belonged to the group.
  const djId = ulid();
  env.raw.prepare(`INSERT INTO djs (id, email_norm, name, created_ms) VALUES (?,?,?,?)`)
    .run(djId, "dj@example.com", "Sundaze", Date.now());
  env.raw.prepare(`INSERT INTO group_djs (group_id, dj_id, role, created_ms) VALUES (?,?, 'owner', ?)`)
    .run(groupId, djId, Date.now());
  seedEvent(env, groupId);

  const page = await (await get(env, "/@sundaze")).text();
  assert.match(page, /Sundaze/);
  assert.match(page, /Sundaze at the Lido/, "their parties are on their page");
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

test("what you hear is yours to turn down, and posting moved to the party", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  await post(env, "/@sundaze/join", { email: "loud@example.com", name: "Loud" });
  const manage = /\/m\/([a-f0-9]{48})/.exec(one(env, `SELECT body_text FROM outbox`).body_text)[1];
  env.raw.prepare(`DELETE FROM outbox`).run();

  // A thread belonging to a GROUP, mailed to its members, could not survive a
  // product with no groups in it. Photos and words belong to the night they
  // happened at, so the composer lives on the party page now.
  const settings = await (await get(env, `/m/${manage}`)).text();
  assert.ok(!/Say something to/.test(settings), "there is no group thread to post to");
  const tried = new FormData();
  tried.append("say", "Doors at ten");
  await get(env, `/m/${manage}`, { method: "POST", body: tried });
  assert.equal(rows(env, `SELECT * FROM posts`).length, 0, "and nothing is written by trying");

  // What the link is still for: how much a person hears, and leaving.
  assert.match(settings, /How much you hear/);
  await get(env, `/m/${manage}?do=none`);
  assert.equal(one(env, `SELECT volume FROM group_members`).volume, "none");
  await get(env, `/m/${manage}?do=all`);
  assert.equal(one(env, `SELECT volume FROM group_members`).volume, "all");
  assert.ok(groupId);
});

// Somebody holding the link was at the night too, and could never say so.
test("somebody holding the link can say they were there", async () => {
  const { env, send } = await signedIn();
  await send("/parties/new", { title: "Warehouse, late", day: "2020-03-01" });
  const handle = one(env, `SELECT handle FROM groups`).handle;
  const ev = one(env, `SELECT * FROM events`);
  const where = `/@${handle}/${ev.slug}`;

  // Private stays private: no page, and no back door on the route either.
  assert.equal((await get(env, where)).status, 404);
  assert.equal((await post(env, `${where}/here`, { name: "Cy" })).status, 404,
    "a private night has no list for a stranger to join");

  await send(`${where}/record`, { visibility: "link" });
  const shared = await (await get(env, where)).text();
  assert.match(shared, /I was there/, "a past night a visitor is on offers it");
  assert.ok(!/I'm coming/.test(shared), "and does not ask them to a night that happened");

  const said = await post(env, `${where}/here`, { name: "Cy" });
  assert.equal(said.status, 200);
  assert.match(await said.text(), /Cy is on the list/);

  // It lands in the OWNER's record of their own night, as a guest.
  const row = one(env,
    `SELECT p.name, pp.role, pp.owner_email FROM party_people pp
       JOIN people p ON p.id = pp.person_id WHERE p.name = 'Cy'`);
  assert.equal(row.role, "guest");
  assert.equal(row.owner_email, ev.owner_email);

  // Saying it twice is still one person at one night.
  await post(env, `${where}/here`, { name: "Cy" });
  assert.equal(rows(env, `SELECT person_id FROM party_people`).length, 1);

  // And who was there stays the owner's: the shared page bills who PLAYED.
  assert.ok(!/Who was there/.test(await (await get(env, where)).text()));
});

// The date fills itself in. So should the place - most people run the same room
// again, and the guess is wrong just as harmlessly as today's date is.
test("starting a night already knows where you were last", async () => {
  const { env, send, read } = await signedIn();
  const handle = () => one(env, `SELECT handle FROM groups`).handle;

  // Nothing to go on yet: an empty box, and the copy says only the date is in.
  const first = await (await read("/parties/new")).text();
  assert.match(first, /name="place"[^>]*value=""/, "no history, no guess");
  assert.match(first, /Today is already/);

  await send("/parties/new", { title: "Warehouse, late", place: "The Box Shop" });
  const second = await (await read("/parties/new")).text();
  assert.match(second, /name="place"[^>]*value="The Box Shop"/, "where you were last");
  assert.match(second, /Today and where you were last are already/);

  // And it survives a validation error, rather than the form forgetting it.
  const failed = await (await send("/parties/new", { title: "" })).text();
  assert.match(failed, /Give it a name first/);
  assert.match(failed, /Today and where you were last are already/);

  // A newer night moves it on.
  await send("/parties/new", { title: "Rooftop", place: "The Roof" });
  assert.match(await (await read("/parties/new")).text(),
    /name="place"[^>]*value="The Roof"/);
  assert.ok(handle());
});

// The parser is only worth anything if the sentence actually lands in the
// database. This types one line at the real route and reads the rows back.
test("the whole night goes in on one line", async () => {
  const { env, send, read } = await signedIn();
  await send("/parties/new", { title: "Warehouse, late" });
  const handle = one(env, `SELECT handle FROM groups`).handle;
  const ev = one(env, `SELECT * FROM events`);
  const where = `/@${handle}/${ev.slug}`;

  // One field, one return - the sentence the product exists for.
  const sent = await send(`${where}/record`,
    { it: "saw Ada and Bo, played Windowlicker by Aphex Twin, with Cy and Dee", as: "dj" });
  assert.equal(sent.status, 302);

  // node:sqlite hands back null-prototype rows; compare the values, not the
  // prototype chain.
  const roles = rows(env,
    `SELECT p.name, pp.role FROM party_people pp JOIN people p ON p.id = pp.person_id
      ORDER BY pp.role, p.name`).map((r) => ({ ...r }));
  assert.deepEqual(roles, [
    { name: "Ada", role: "dj" }, { name: "Bo", role: "dj" },
    { name: "Cy", role: "guest" }, { name: "Dee", role: "guest" },
  ], "as=dj came from the button Enter happens to press - the sentence outranks it");
  assert.deepEqual(rows(env, `SELECT title, artist FROM songs`).map((r) => ({ ...r })),
    [{ title: "Windowlicker", artist: "Aphex Twin" }]);

  const page = await (await read(where)).text();
  assert.match(page, /Ada/);
  assert.match(page, /Windowlicker/);
  assert.match(page, /Cy/);

  // A bare list still means whatever the button says, unchanged.
  await send(`${where}/record`, { it: "Eve", as: "guest" });
  assert.equal(
    one(env, `SELECT pp.role FROM party_people pp JOIN people p ON p.id = pp.person_id
               WHERE p.name = 'Eve'`).role,
    "guest", "a list with no sentence in it is what the button says");
});

// Saying something happens at a party, by whoever it belongs to and whoever
// they let in - which is the shape the product actually has: my night, my
// notes, and the people I shared the link with.
test("photos and words belong to the night they happened at", async () => {
  const { env, send, read } = await signedIn();
  await send("/parties/new", { title: "Warehouse, late" });
  const handle = one(env, `SELECT handle FROM groups`).handle;
  const ev = one(env, `SELECT * FROM events`);
  const where = `/@${handle}/${ev.slug}`;

  const empty = await (await read(where)).text();
  assert.match(empty, /Photos and anything said here land in this space/, "an empty space says what belongs in it");

  const said = await send(`${where}/say`, { say: "The room went off at two" });
  assert.equal(said.status, 302);
  const written = one(env, `SELECT * FROM posts`);
  assert.equal(written.event_id, ev.id, "the post is ON the party, not beside it");

  const page = await (await read(where)).text();
  assert.match(page, /The room went off at two/);

  // A party starts PRIVATE. A passer-by does not read it at all - not a bare
  // page with the private parts stripped out, nothing.
  assert.equal((await get(env, where)).status, 404, "mine until I share it");

  // Sharing it by link opens it, and lets whoever has the link add to it -
  // "they can post in the events that I'm allowing them to join".
  await send(`${where}/record`, { visibility: "link" });
  assert.equal(one(env, `SELECT visibility FROM events`).visibility, "link");
  const shared = await (await get(env, where)).text();
  assert.match(shared, /The room went off at two/);
  assert.match(shared, /name="say"/, "somebody holding the link can add a photo");

  // What is MINE stays mine even then: the record is not on the shared page.
  assert.ok(!/Who can see this/.test(shared), "the controls are the owner's");
  assert.ok(!/Your notes/.test(shared));
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

test("a Mac pairs to the PERSON, with a code the DJ can read off the screen", async () => {
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
  // The Mac belongs to whoever signed in, not to one of their groups. It used
  // to ask which group to attach it to - a question about a concept the person
  // may not have, on a screen whose only job is "yes, that is me".
  assert.equal(one(env, `SELECT email_norm FROM install_accounts`).email_norm, "dj@example.com");
  assert.equal(rows(env, `SELECT * FROM install_groups`).length, 0, "no group binding is written");

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
  // Signed in as the person who runs this group - the Mac's group is resolved
  // from the account, not stored against the install.
  const djId = ulid();
  env.raw.prepare(`INSERT INTO djs (id, email_norm, name, created_ms) VALUES (?,?,?,?)`)
    .run(djId, "dj@example.com", "DJ", Date.now());
  env.raw.prepare(`INSERT INTO group_djs (group_id, dj_id, role, created_ms) VALUES (?,?, 'owner', ?)`)
    .run(groupId, djId, Date.now());
  env.raw.prepare(`INSERT INTO install_accounts (install_id, email_norm, linked_ms) VALUES (?,?,?)`)
    .run(mac.id, "dj@example.com", Date.now());
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
  env.raw.prepare(`INSERT INTO install_accounts (install_id, email_norm, linked_ms) VALUES (?,?,?)`)
    .run(other.id, "dj@example.com", Date.now());
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
  // The DJ first: a party carries whose it is, so it has to have somebody to
  // belong to before it is seeded.
  const djId = ulid();
  env.raw.prepare(`INSERT INTO djs (id, email_norm, name, created_ms) VALUES (?, ?, ?, ?)`)
    .run(djId, "dj@example.com", "DJ", Date.now());
  env.raw.prepare(`INSERT INTO group_djs (group_id, dj_id, role, created_ms) VALUES (?, ?, 'owner', ?)`)
    .run(groupId, djId, Date.now());
  seedEvent(env, groupId);
  const secret = "d".repeat(48);
  env.raw.prepare(`INSERT INTO sessions (id, hash, dj_id, created_ms, expires_ms) VALUES (?, ?, ?, ?, ?)`)
    .run(ulid(), await sha256Hex(secret), djId, Date.now(), Date.now() + 60000);

  const save = (value) => {
    const body = new FormData();
    body.append("payLink", value);
    return get(env, "/@sundaze/manage", { method: "POST", body, headers: { cookie: `pp_s=${secret}` } });
  };
  assert.match(await (await save("http://insecure.example")).text(), /https/);
  assert.equal(one(env, `SELECT pay_link FROM profiles`)?.pay_link ?? "", "",
    "a refused link writes nothing at all");

  // Tipping is a person's, not a group's - it lives with the rest of who they
  // are, on the profile both clients already share.
  await save("https://revolut.me/someone");
  assert.equal(one(env, `SELECT pay_link FROM profiles`).pay_link, "https://revolut.me/someone");
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

  // The job: create a party, get the link, send it. Creating one is an action
  // that opens its own page, not a row of boxes wedged above the list.
  assert.match(body, /Create a party/);
  assert.match(body, /href="\/@sundaze\/new"/);
  assert.ok(!/placeholder="What is the night called\?"/.test(body),
    "the inline form is gone");
  assert.match(body, /value="https:\/\/partyparty\.party\/@sundaze\/june-14"/,
    "the link has to be there to be copied, not derived by the DJ");
  assert.match(body, /Copy<\/button>/);
  assert.match(body, /Email the group/);

  // Everything set once is present but behind the fold, not competing with it.
  const settings = body.indexOf("<details");
  assert.ok(settings > 0, "settings must exist");
  assert.ok(body.indexOf("Create a party") < settings, "creating a party comes first");
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

test("home is your parties: upcoming, past, and an empty state that says what to do", async () => {
  const env = await withGoogle(makeEnv());
  const { session } = await signIn(env);
  const cookie = { headers: { cookie: `pp_s=${session[1]}` } };

  // A new account owns nothing. The empty state has to say what this is for,
  // not report an absence.
  const empty = await (await get(env, "/home", cookie)).text();
  // An empty home says what belongs in it, with one way to start - not two pink
  // buttons for the same action on the emptiest screen in the app.
  assert.match(empty, /A party you are going to/);
  assert.equal((empty.match(/Add a party/g) || []).length, 1, "one way to start, not two");
  assert.match(empty, /href="\/parties\/new"/, "and a way to start it");
  assert.match(empty, /href="\/parties\/new"/);

  const mineId = seedGroup(env, "sundaze");
  const dj = one(env, `SELECT id FROM djs`).id;
  env.raw.prepare(`INSERT INTO group_djs (group_id, dj_id, role, created_ms) VALUES (?, ?, 'owner', ?)`)
    .run(mineId, dj, Date.now());
  seedEvent(env, mineId, { slug: "soon", title: "Coming up", starts_ms: Date.now() + 86400000 });
  seedEvent(env, mineId, { slug: "gone", title: "Last month", starts_ms: Date.now() - 30 * 86400000 });

  const body = await (await get(env, "/home", cookie)).text();
  assert.match(body, /Coming up/);
  assert.match(body, /Last month/);
  // Upcoming and past are decided by the clock, and what is coming comes first.
  assert.ok(body.indexOf("<h2>Upcoming</h2>") < body.indexOf("<h2>Past</h2>"));
  assert.ok(body.indexOf("Coming up") < body.indexOf("Last month"));

  // A party somebody ELSE runs, that I kept a note against, is mine too -
  // going to a night is as much a record as throwing one.
  const theirs = seedGroup(env, "latenight");
  const theirEvent = seedEvent(env, theirs, { slug: "warehouse", title: "Their warehouse" });
  assert.ok(!(await (await get(env, "/home", cookie)).text()).includes("Their warehouse"));
  env.raw.prepare(`INSERT INTO party_notes (event_id, owner_email, note, attended, updated_ms)
    VALUES (?, 'dj@example.com', 'Loud, good', 1, ?)`).run(theirEvent, Date.now());
  const withTheirs = await (await get(env, "/home", cookie)).text();
  assert.match(withTheirs, /Their warehouse/, "a party you noted is on your shelf");
  assert.match(withTheirs, /You were there/);
});

test("your own page offers what you configure, not a form asking your name", async () => {
  const env = await withGoogle(makeEnv());
  const { session } = await signIn(env);
  const groupId = seedGroup(env);
  const dj = one(env, `SELECT id FROM djs`).id;
  env.raw.prepare(`INSERT INTO group_djs (group_id, dj_id, role, created_ms) VALUES (?, ?, 'owner', ?)`)
    .run(groupId, dj, Date.now());

  const mine = await (await get(env, "/@sundaze", { headers: { cookie: `pp_s=${session[1]}` } })).text();
  assert.match(mine, /Tips, merch and Pro/);
  assert.ok(!/placeholder="your name"/.test(mine),
    "it must not ask its owner to introduce themselves");

  // A stranger still gets the follow form, and it says what following means.
  const stranger = await (await get(env, "/@sundaze")).text();
  assert.match(stranger, /placeholder="your name"/);
  assert.match(stranger, /Hear about their parties/, "the action says what following does");
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

test("a person's page is their parties, coming up and gone", async () => {
  const env = makeEnv();
  const groupId = seedGroup(env);
  const djId = ulid();
  env.raw.prepare(`INSERT INTO djs (id, email_norm, name, created_ms) VALUES (?,?,?,?)`)
    .run(djId, "dj@example.com", "Sundaze", Date.now());
  env.raw.prepare(`INSERT INTO group_djs (group_id, dj_id, role, created_ms) VALUES (?,?, 'owner', ?)`)
    .run(groupId, djId, Date.now());
  seedEvent(env, groupId, { slug: "june-14", title: "At the Lido" });
  seedEvent(env, groupId, { slug: "old", title: "Last month", starts_ms: Date.now() - 86400000 });
  for (const [email, name] of [["ada@example.com", "Ada Lovelace"], ["bo@example.com", "Bo"]]) {
    await post(env, "/@sundaze/join", { email, name });
  }

  const body = await (await get(env, "/@sundaze")).text();

  // What is coming, then what has happened. Groups are dead: this is a person,
  // and these are the parties that belong to them.
  assert.match(body, /At the Lido/);
  assert.match(body, /<h2>Coming up<\/h2>/);
  assert.match(body, /<h2>Past<\/h2>/);
  assert.ok(body.indexOf("<h2>Coming up</h2>") < body.indexOf("<h2>Past</h2>"),
    "what is coming comes first");
  assert.match(body, /Last month/);

  // Somebody who is not them can follow, and no address is ever on a page.
  assert.match(body, /Hear about their parties/);
  assert.ok(!/ada@example\.com/.test(body), "an address never appears on a public page");
});

// ------------------------------------------------------------------ profiles

// A picture, as a browser posts one. The bytes are a real PNG header so a
// content sniffer would agree with the declared type.
const pngBytes = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const pngFile = (name = "me.png") => new File([pngBytes()], name, { type: "image/png" });

// Signed in the way a real person is: the provider hands over a name, which
// is the case the welcome screen has to survive.
const signedIn = async () => {
  const env = await withGoogle(makeEnv(), { name: "DJ Example" });
  const { session } = await signIn(env);
  const cookie = { cookie: `pp_s=${session[1]}` };
  const send = (path, fields) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.append(k, v);
    return worker.fetch(new Request("https://partyparty.party" + path,
      { method: "POST", body, headers: cookie }), env);
  };
  const read = (path) => get(env, path, { headers: cookie });
  return { env, cookie, send, read };
};

// A Mac belonging to the person who is already signed in, so the two clients in
// a test are the same account rather than two accounts that happen to agree.
const linkedInstall = async (env, handle) => {
  const install = "aabbccddeeff";
  await env.DL.put(`broker/${install}.json`, JSON.stringify({ secret: "sec" }));
  // Bound to the PERSON who runs that group. Which group the Mac's parties
  // land in is resolved from the account, so this is the whole binding.
  const owner = one(env, `SELECT d.email_norm FROM groups g
      JOIN group_djs gd ON gd.group_id = g.id JOIN djs d ON d.id = gd.dj_id
     WHERE g.handle = ?`, handle);
  env.raw.prepare(`INSERT INTO install_accounts (install_id, email_norm, linked_ms) VALUES (?,?,?)`)
    .run(install, owner.email_norm, Date.now());
  return { id: install, secret: "sec" };
};

const postJson = (env, path, body) => worker.fetch(
  new Request("https://partyparty.party" + path, { method: "POST", body: JSON.stringify(body) }), env);

test("signing in mints an @name that is already valid and can be changed", async () => {
  const { env, read } = await signedIn();

  const home = await read("/home");
  const body = await home.text();
  const minted = one(env, `SELECT handle FROM profiles`).handle;
  assert.ok(minted, "somebody with no profile still has an address");
  assert.equal(handleProblem(minted), "", "the minted name passes the same gate a typed one does");
  // Offered, not imposed: a journal opens on the journal, and setting up a name
  // is one line you can open rather than a form the height of the screen.
  assert.match(body, /Add your name and photo/, "the first visit offers the profile");
  assert.match(body, /<details class="welcome"/, "folded down, not a wall");
  assert.match(body, new RegExp(`value="${minted}"`), "and shows the name it chose, editable");
  assert.ok(env.DL.objects.has(`broker/handle/${minted}`),
    "a person's name is reserved against the broker exactly like a group's");

  // Google gave us a name. That must NOT count as having filled the profile
  // in: if it did, the welcome would never appear for anybody real.
  assert.equal(one(env, `SELECT name FROM profiles`).name, "DJ Example");
  assert.equal(one(env, `SELECT saved_ms FROM profiles`).saved_ms, null);
  assert.match(body, /value="DJ Example"/, "and it is prefilled, not thrown away");
});

test("the welcome takes no for an answer", async () => {
  const { env, send, read } = await signedIn();
  const dismissed = await send("/home", { dismiss: "1" });
  assert.equal(dismissed.status, 302);
  assert.ok(one(env, `SELECT saved_ms FROM profiles`).saved_ms, "settled");
  assert.equal(one(env, `SELECT name FROM profiles`).name, "DJ Example",
    "and nothing was overwritten on the way past");
  const home = await (await read("/home")).text();
  assert.ok(!/You, if you want to be/.test(home), "it does not ask again");
});

test("a profile is one record, whichever page edits it", async () => {
  const { env, send, read } = await signedIn();

  const saved = await send("/home", {
    name: "Ada Lovelace", bio: "Sunday rooms.", handle: "adalove",
    instagram: "https://instagram.com/adalove/", soundcloud: "@adasets", website: "ada.example",
    avatar: pngFile(),
  });
  assert.equal(saved.status, 302);

  const row = one(env, `SELECT * FROM profiles`);
  assert.equal(row.handle, "adalove");
  assert.equal(row.name, "Ada Lovelace");
  assert.deepEqual(JSON.parse(row.links), {
    instagram: "adalove", soundcloud: "adasets", website: "https://ada.example",
  }, "a pasted URL and a typed @name both end up as the name");
  assert.ok(row.avatar_key, "the picture is stored");
  assert.ok(env.DL.objects.has(`media/${row.avatar_key}`), "in the bucket, under media/");

  // The name follows the person into every table that records who acted.
  assert.equal(one(env, `SELECT name FROM djs`).name, "Ada Lovelace");

  // Settings shows the same record, and saving there writes the same row.
  const settings = await (await read("/settings")).text();
  assert.match(settings, /value="Ada Lovelace"/);
  assert.match(settings, /value="adalove"/);
  assert.match(settings, /value="adasets"/);
  await send("/settings", { name: "Ada", bio: "", handle: "adalove" });
  assert.equal(one(env, `SELECT name FROM profiles`).name, "Ada");
  assert.equal(rows(env, `SELECT * FROM profiles`).length, 1, "still one profile, not two");

  // Home stops asking once there is anything there.
  const home = await (await read("/home")).text();
  assert.ok(!/You, if you want to be/.test(home), "the welcome form does not come back");
  assert.match(home, /@adalove/);
});

test("a person's @name cannot take a group's, and the picture can be removed", async () => {
  const { env, send, read } = await signedIn();
  seedGroup(env, "sundaze");

  const clash = await send("/settings", { handle: "sundaze" });
  assert.match(await clash.text(), /taken/i);
  assert.notEqual(one(env, `SELECT handle FROM profiles`).handle, "sundaze");

  const banned = await send("/settings", { handle: "admin" });
  assert.match(await banned.text(), /reserved/i);

  await send("/settings", { name: "Ada", avatar: pngFile() });
  assert.ok(one(env, `SELECT avatar_key FROM profiles`).avatar_key);
  await send("/settings", { name: "Ada", clearAvatar: "1" });
  assert.equal(one(env, `SELECT avatar_key FROM profiles`).avatar_key, null);

  // The @name that is nobody's group is that person's page.
  const handle = one(env, `SELECT handle FROM profiles`).handle;
  const page = await read(`/@${handle}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Ada/);
});

test("pictures are served back, and only from inside the media prefix", async () => {
  const { env, send } = await signedIn();
  await send("/home", { name: "Ada", avatar: pngFile() });
  const key = one(env, `SELECT avatar_key FROM profiles`).avatar_key;

  const served = await get(env, `/media/${key}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.match(served.headers.get("cache-control"), /immutable/,
    "every key is fresh, so this can be cached hard");

  // Percent-encoded, so the URL parser does not quietly normalise the
  // traversal away before the guard has been asked anything.
  assert.equal((await get(env, "/media/%2e%2e%2fbroker%2fhandle%2fsundaze")).status, 404);
  assert.equal((await get(env, "/media/")).status, 404);
  assert.equal((await get(env, "/media/nothing-here")).status, 404);

  // The bytes decide, not the label. A script that claims to be a PNG is
  // refused; a real picture mislabelled by whatever uploaded it is kept, and
  // is served back as what it actually is.
  const lying = await send("/settings", {
    avatar: new File(["#!/bin/sh\nrm -rf /\n"], "x.png", { type: "image/png" }),
  });
  assert.match(await lying.text(), /not a picture/i);

  const mislabelled = await send("/settings", {
    avatar: new File([pngBytes()], "photo", { type: "application/octet-stream" }),
  });
  assert.equal(mislabelled.status, 302, "a real picture is not refused over its label");
  const sniffed = one(env, `SELECT avatar_key FROM profiles`).avatar_key;
  assert.equal((await get(env, `/media/${sniffed}`)).headers.get("content-type"), "image/png");

  // Video belongs on a post, never on a face.
  const video = await send("/settings", {
    avatar: new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])], "v.webm",
      { type: "video/webm" }),
  });
  assert.match(await video.text(), /has to be a picture|needs to be a picture/i);
});

test("a person's page is them, with their face and their @name", async () => {
  const { env, send, read } = await signedIn();
  await send("/home", { name: "Ada Lovelace", handle: "adalove", avatar: pngFile() });

  // The participants rail belonged to a group page and went with it. Who was at
  // a party is the party's business - guests and artists live on the night, in
  // the record. What a person's own page shows is the person.
  const body = await (await read("/@adalove")).text();
  assert.match(body, /Ada Lovelace/);
  assert.match(body, /@adalove/, "a person with a name is reachable at it");
  assert.match(body, /<img src="\/media\/avatars\//, "their photo, not their initials");
  assert.ok(!/Participants \u2014/.test(body), "no group rail: there is no group");
  assert.ok(!(await (await read("/@adalove")).text()).includes("@example.com"),
    "an address never appears on a public page");
});


test("a party has a cover, shuffled or uploaded, and a stranger cannot touch it", async () => {
  const { env, send, read } = await signedIn();
  await send("/parties/new", { title: "At the Lido" });
  const handle = one(env, `SELECT handle FROM groups`).handle;
  const ev = one(env, `SELECT * FROM events`);
  const where = `/@${handle}/${ev.slug}`;

  // Shuffle, from the bundled pile, and never the one already showing.
  const first = await send(`${where}/cover`, { shuffleCover: "1" });
  assert.equal(first.status, 302);
  const one1 = one(env, `SELECT cover_key FROM events`).cover_key;
  assert.match(one1, /^covers\/[a-z-]+\.webp$/);
  // The RENDERED url, not just the stored key. Checking only the key is how a
  // double /media/ prefix shipped: every shuffled cover 404ed while uploaded
  // ones worked, so it read as randomly broken rather than as one bug.
  const shuffled = await (await read(where)).text();
  assert.match(shuffled, new RegExp(`background-image:url\\('/media/${one1}'\\)`));
  assert.ok(!/\/media\/\/media\//.test(shuffled), "a key must become a URL exactly once");
  await send(`${where}/cover`, { shuffleCover: "1" });
  assert.notEqual(one(env, `SELECT cover_key FROM events`).cover_key, one1,
    "a shuffle that shows the same picture reads as a broken button");

  // Upload, which stores the bytes and points the cover at them.
  await send(`${where}/cover`, { cover: pngFile("cover.png") });
  const uploaded = one(env, `SELECT cover_key FROM events`).cover_key;
  assert.match(uploaded, /^covers\//);
  assert.ok(env.DL.objects.has(`media/${uploaded}`));

  const page = await (await read(where)).text();
  assert.match(page, new RegExp(`background-image:url\\('/media/${uploaded}'\\)`));
  assert.match(page, /Shuffle image/, "the DJ gets the console's two buttons on the picture");
  assert.match(page, /Upload image/);

  // And a stranger, with no session, cannot touch it.
  const body = new FormData();
  body.append("shuffleCover", "1");
  const refused = await worker.fetch(
    new Request(`https://partyparty.party${where}/cover`, { method: "POST", body }), env);
  assert.equal(refused.status, 403);
  assert.equal(one(env, `SELECT cover_key FROM events`).cover_key, uploaded, "and changed nothing");
});

test("a party's feed takes a photo, and shows who posted it", async () => {
  const { env, send, read } = await signedIn();
  await send("/home", { name: "Ada Lovelace", handle: "adalove", avatar: pngFile() });
  await send("/parties/new", { title: "At the Lido" });
  const handle = one(env, `SELECT handle FROM groups`).handle;
  const ev = one(env, `SELECT * FROM events`);
  const where = `/@${handle}/${ev.slug}`;

  const posted = await send(`${where}/say`, { say: "Doors at nine", media: pngFile("wall.png") });
  assert.equal(posted.status, 302);
  const wrote = one(env, `SELECT * FROM posts`);
  assert.equal(wrote.event_id, ev.id, "a photo belongs to the night it was taken at");
  assert.match(wrote.media_key, /^posts\//);
  assert.ok(env.DL.objects.has(`media/${wrote.media_key}`));

  const page = await (await read(where)).text();
  assert.match(page, /Doors at nine/);
  assert.match(page, new RegExp(`/media/${wrote.media_key}`));
  assert.match(page, /Ada Lovelace/, "posts carry who wrote them");
});

test("the @name says whether it is free while you are still typing", async () => {
  const { env, read, send } = await signedIn();
  seedGroup(env, "sundaze");
  await send("/settings", { handle: "adalove" });

  const ask = async (h) => JSON.parse(await (await read(
    `/api/v1/handle-free?h=${encodeURIComponent(h)}`)).text());

  assert.deepEqual(await ask("wideopen"), { free: true });
  assert.equal((await ask("sundaze")).free, false, "a group's name is not available");
  assert.match((await ask("sundaze")).why, /taken/i);
  assert.equal((await ask("abc")).free, false);
  assert.match((await ask("abc")).why, /five to thirty/i, "and it says why, not just no");
  assert.equal((await ask("admin")).free, false);
  assert.match((await ask("admin")).why, /reserved/i);

  // Their own name always reads as available, or saving a form they did not
  // change would report a collision with themselves.
  assert.deepEqual(await ask("adalove"), { free: true, mine: true });

  // Signed out, it answers nothing.
  assert.equal((await get(env, "/api/v1/handle-free?h=wideopen")).status, 403);
});

test("a rejected @name comes back with everything else still typed in", async () => {
  const { env, send } = await signedIn();
  seedGroup(env, "sundaze");

  const refused = await send("/settings", {
    name: "Ada Lovelace", bio: "Slow Sunday rooms.", handle: "sundaze",
    instagram: "adalove", soundcloud: "adasets", avatar: pngFile(),
  });
  assert.equal(refused.status, 200, "the form comes back, rather than a dead end");
  const body = await refused.text();

  assert.match(body, /@sundaze is already taken/, "and says which field and why");
  assert.match(body, /value="Ada Lovelace"/, "the name is still there");
  assert.match(body, /value="Slow Sunday rooms\./, "so is the line");
  assert.match(body, /value="adalove"/);
  assert.match(body, /value="adasets"/);
  assert.match(body, /name="keepAvatar" value="avatars\//,
    "and the photo they picked, which a file input cannot be refilled with");
  assert.match(body, /name="handle"/, "with the field itself still editable");
  assert.ok(!/That did not save/.test(body), "no full-page error");

  // Nothing was written, including the name that was fine: a rejected form is
  // rejected whole, so what is stored still matches what the page last showed.
  assert.equal(one(env, `SELECT name FROM profiles`).name, "DJ Example");
  assert.equal(one(env, `SELECT saved_ms FROM profiles`).saved_ms, null);

  // Re-submitting with a free name keeps the photo that survived the round trip.
  const key = /name="keepAvatar" value="([^"]+)"/.exec(body)[1];
  const ok = await send("/settings", {
    name: "Ada Lovelace", handle: "adalove", keepAvatar: key,
  });
  assert.equal(ok.status, 302);
  const row = one(env, `SELECT * FROM profiles`);
  assert.equal(row.handle, "adalove");
  assert.equal(row.avatar_key, key, "the picture survived the rejection");
});

test("a name from the provider is taken whenever it arrives, not only the first time", async () => {
  // The row already exists with no name - somebody who signed in before we
  // asked for one, or an Apple account that hands it over exactly once and
  // whose one time we missed. They stayed anonymous forever while the provider
  // told us their name on every single sign-in.
  const env = await withGoogle(makeEnv(), { name: "Ada Lovelace" });
  env.raw.prepare(`INSERT INTO djs (id, email_norm, name, created_ms, last_seen_ms)
                   VALUES (?, 'dj@example.com', '', ?, ?)`).run(ulid(), Date.now(), Date.now());

  await signIn(env);
  assert.equal(one(env, `SELECT name FROM djs`).name, "Ada Lovelace");
  assert.equal(one(env, `SELECT name FROM profiles`).name, "Ada Lovelace");
  assert.equal(rows(env, `SELECT * FROM djs`).length, 1, "still one person");

  // But a name they chose themselves is theirs. The provider does not get to
  // change it back on the next sign-in.
  env.raw.prepare(`UPDATE profiles SET name = 'Ada', saved_ms = ?`).run(Date.now());
  await signIn(env);
  assert.equal(one(env, `SELECT name FROM profiles`).name, "Ada");
});

test("your own group's name is your name, not somebody else's", async () => {
  const { env, send, read } = await signedIn();
  const minted = one(env, `SELECT handle FROM profiles`).handle;

  // Making a group re-points an @name nobody has chosen yet. A DJ running
  // @shokunin IS Shokunin; introducing them to themselves as @rowdyheron is
  // the product not noticing they are the same person.
  await send("/manage", { name: "Shokunin", handle: "shokunin" });
  const home = await (await read("/home")).text();
  assert.equal(one(env, `SELECT handle FROM profiles`).handle, "shokunin");
  assert.notEqual(minted, "shokunin");
  assert.match(home, /value="shokunin"/);

  // And it reads as available rather than taken by itself.
  const free = JSON.parse(await (await read("/api/v1/handle-free?h=shokunin")).text());
  assert.equal(free.free, true, "your own address is not taken from you");

  // Saving it is a save, not a collision.
  const saved = await send("/settings", { name: "Shokunin", handle: "shokunin" });
  assert.equal(saved.status, 302);
  assert.equal(one(env, `SELECT handle FROM profiles`).handle, "shokunin");

  // Somebody else's group is still somebody else's.
  seedGroup(env, "sundaze");
  const theirs = JSON.parse(await (await read("/api/v1/handle-free?h=sundaze")).text());
  assert.equal(theirs.free, false);
  assert.match(await (await send("/settings", { handle: "sundaze" })).text(), /already taken/);
  assert.equal(one(env, `SELECT handle FROM profiles`).handle, "shokunin");
});

test("a chosen @name is never re-pointed under them", async () => {
  const { env, send, read } = await signedIn();
  await send("/settings", { name: "Ada", handle: "adalove" });
  assert.ok(one(env, `SELECT saved_ms FROM profiles`).saved_ms);

  // Making a group afterwards must not quietly rename the person: once they
  // have chosen, the name is theirs.
  await send("/manage", { name: "Sundaze", handle: "sundaze" });
  await read("/home");
  assert.equal(one(env, `SELECT handle FROM profiles`).handle, "adalove");
});

test("two groups is two answers, so it keeps the invented name", async () => {
  const { env, send, read } = await signedIn();
  const minted = one(env, `SELECT handle FROM profiles`).handle;
  await send("/manage", { name: "Sundaze", handle: "sundaze" });
  await send("/manage", { name: "Basement", handle: "basement" });
  await read("/home");
  assert.equal(one(env, `SELECT handle FROM profiles`).handle, minted,
    "guessing between two is worse than a name nobody has seen");
  // Either one is still theirs to take by hand.
  assert.equal(JSON.parse(await (await read("/api/v1/handle-free?h=basement")).text()).free, true);
});

// ------------------------------------------------- the Mac as a full client

const asInstall = async (env, { linked = true } = {}) => {
  const install = "aabbccddeeff";
  await env.DL.put(`broker/${install}.json`, JSON.stringify({ secret: "sec", hostLabel: "chorus21" }));
  let groupId = null;
  if (linked) {
    const { session } = await signIn(env);
    const body = new FormData();
    body.append("name", "Sundaze");
    body.append("handle", "sundaze");
    await worker.fetch(new Request("https://partyparty.party/manage", {
      method: "POST", body, headers: { cookie: `pp_s=${session[1]}` },
    }), env);
    groupId = one(env, `SELECT id FROM groups`).id;
    const owner = one(env, `SELECT d.email_norm FROM group_djs gd
        JOIN djs d ON d.id = gd.dj_id WHERE gd.group_id = ?`, groupId);
    env.raw.prepare(`INSERT INTO install_accounts (install_id, email_norm, linked_ms) VALUES (?,?,?)`)
      .run(install, owner.email_norm, Date.now());
  }
  const call = async (path, extra) => {
    const r = await worker.fetch(new Request("https://partyparty.party" + path, {
      method: "POST", body: JSON.stringify({ id: install, secret: "sec", ...extra }),
    }), env);
    return { status: r.status, body: await r.json() };
  };
  return { install, groupId, call };
};

test("a linked Mac can be handed its owner's own session", async () => {
  const env = await withGoogle(makeEnv(), { name: "DJ Example" });
  const mac = await asInstall(env);

  const got = await mac.call("/api/v1/install/session", {});
  assert.equal(got.status, 200);
  assert.equal(got.body.linked, true);
  assert.match(got.body.session, /^[a-f0-9]{48}$/);
  assert.ok(got.body.handle, "and who it belongs to, for the console to show");

  // It IS a session: the pages answer to it as the person, which is the whole
  // point - the console shows their own pages rather than a second copy.
  const home = await get(env, "/home", { headers: { cookie: `pp_s=${got.body.session}` } });
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Your parties/);

  // An unsigned Mac gets no session, and says so rather than failing.
  const lone = await asInstall(await withGoogle(makeEnv()), { linked: false });
  const none = await lone.call("/api/v1/install/session", {});
  assert.equal(none.status, 200);
  assert.equal(none.body.linked, false);
  assert.ok(!none.body.session);

  // And a caller who cannot prove which Mac it is gets nothing at all.
  const forged = await worker.fetch(new Request(
    "https://partyparty.party/api/v1/install/session",
    { method: "POST", body: JSON.stringify({ id: "aabbccddeeff", secret: "wrong" }) }), env);
  assert.equal(forged.status, 403);
});

test("every Mac route refuses a caller it cannot authenticate", async () => {
  // This is the test that was missing. Every existing case authenticated
  // successfully, so the refusal branch never ran - and it called a helper
  // that lives in the OTHER worker, which threw a ReferenceError and took all
  // three routes down with a 1101 in production.
  const env = await withGoogle(makeEnv());
  const paths = [
    "/api/v1/parties", "/api/v1/party/create", "/api/v1/party/update",
    "/api/v1/install/profile", "/api/v1/party/bind", "/api/v1/party/posts",
    "/api/v1/install/session",
  ];
  for (const path of paths) {
    for (const body of [
      { id: "aabbccddeeff", secret: "wrong" },   // nothing on file
      { id: "not-an-id", secret: "x" },          // malformed
      {},                                        // nothing at all
    ]) {
      const r = await worker.fetch(new Request("https://partyparty.party" + path, {
        method: "POST", body: JSON.stringify(body),
      }), env);
      assert.ok(r.status === 400 || r.status === 403,
        `${path} answered ${r.status} for ${JSON.stringify(body)}`);
      // A thrown exception is a 500 and an empty body; a refusal says so.
      const text = await r.text();
      assert.ok(text.length && text.startsWith("{"), `${path} did not answer with JSON`);
    }
  }
});

test("signing in on the Mac is the whole of it - no group to choose", async () => {
  const env = await withGoogle(makeEnv(), { name: "DJ Example" });
  const { session } = await signIn(env);
  const cookie = { cookie: `pp_s=${session[1]}` };
  const install = "aabbccddeeff";
  await env.DL.put(`broker/${install}.json`, JSON.stringify({ secret: "sec" }));

  const asked = await (await api(env, "/api/v1/install/code", { id: install, secret: "sec" })).json();
  assert.equal(asked.linked, false);

  // The link page asks nothing. It used to list your groups and make you pick
  // one, which is a question about a concept most people do not have.
  const page = await (await get(env, `/link/${asked.code}`, { headers: cookie })).text();
  assert.ok(!/Link it to|which of your groups|start the group/i.test(page),
    "the link page must not ask which group");
  assert.match(page, /That is you/);

  // And it is the person that got bound, not a group.
  const bound = one(env, `SELECT * FROM install_accounts WHERE install_id = ?`, install);
  assert.ok(bound, "the Mac is bound to an account");
  assert.equal(rows(env, `SELECT * FROM install_groups`).length, 0);

  // Asking again says who they are, by their @name - not by a group's.
  const linked = await (await api(env, "/api/v1/install/code", { id: install, secret: "sec" })).json();
  assert.equal(linked.linked, true);
  assert.equal(linked.handle, one(env, `SELECT handle FROM profiles`).handle);

  // A code is single use even now that it asks nothing.
  assert.match(await (await get(env, `/link/${asked.code}`, { headers: cookie })).text(), /expired/i);
});

test("a Mac's parties go to your own @name, not to a side project", async () => {
  const env = await withGoogle(makeEnv(), { name: "DJ Example" });
  const { session } = await signIn(env);
  const cookie = { cookie: `pp_s=${session[1]}` };
  const handle = one(env, `SELECT handle FROM profiles`).handle;
  const djId = one(env, `SELECT id FROM djs`).id;

  // A side project made FIRST, and their own group after it. Plain
  // oldest-first would send every party from the Mac into the side project.
  const older = seedGroup(env, "earlytesters");
  env.raw.prepare(`INSERT INTO group_djs (group_id, dj_id, role, created_ms) VALUES (?,?, 'owner', ?)`)
    .run(older, djId, Date.now() - 86400000);
  const body = new FormData();
  body.append("name", "Mine");
  body.append("handle", handle);
  await get(env, "/manage", { method: "POST", body, headers: cookie });

  const install = "aabbccddeeff";
  await env.DL.put(`broker/${install}.json`, JSON.stringify({ secret: "sec" }));
  env.raw.prepare(`INSERT INTO install_accounts (install_id, email_norm, linked_ms) VALUES (?,?,?)`)
    .run(install, one(env, `SELECT email_norm FROM djs`).email_norm, Date.now());

  const made = await (await api(env, "/api/v1/party/create",
    { id: install, secret: "sec", title: "From the booth" })).json();
  assert.equal(made.party.handle, handle,
    `a party from the Mac landed in @${made.party.handle}, not the DJ's own @${handle}`);
});

test("a party made on the Mac is the same row a party made on the web is", async () => {
  const env = await withGoogle(makeEnv(), { name: "DJ Example" });
  const mac = await asInstall(env);

  const made = await mac.call("/api/v1/party/create", {
    title: "Warehouse, late", place: "Unit 7", partyId: "2026-08-08-2200-ab12",
  });
  assert.equal(made.status, 200);
  assert.ok(made.body.party.key, "the Mac gets a real party back");

  // Same table, same shape, same group as anything the web makes.
  const row = one(env, `SELECT * FROM events WHERE id = ?`, made.body.party.key);
  assert.equal(row.group_id, mac.groupId, "it belongs to the account, not to the Mac");
  assert.equal(row.title, "Warehouse, late");
  assert.equal(row.state, "announced");
  assert.ok(row.starts_ms > 0, "the Mac knows when it is and fills it in");
  assert.equal(row.party_id, "2026-08-08-2200-ab12", "the live room is attached at creation");
  assert.equal(rows(env, `SELECT * FROM events`).length, 1, "exactly one record, never a shadow");

  // A party opened with a live room on it is a night people are about to be
  // handed the link to, so it is shareable from the first moment - unlike one
  // typed in for later, which is a private journal entry until it is shared.
  assert.equal(row.visibility, "link");
  const page = await get(env, `/@sundaze/${row.slug}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Warehouse, late/);
  assert.equal(made.body.party.url, `https://partyparty.party/@sundaze/${row.slug}`);
});

test("creating a party means the same thing in the booth as in a browser", async () => {
  const env = await withGoogle(makeEnv(), { name: "DJ Example" });
  const mac = await asInstall(env);
  const owner = one(env, `SELECT email_norm FROM djs`).email_norm;

  // The web's form turns "who is playing" into people on the account. The Mac
  // asks the same question, so it has to have the same consequence - otherwise
  // a DJ named in the booth is a label and one named in a browser is a history.
  const made = await mac.call("/api/v1/party/create", {
    title: "Warehouse, late", place: "Unit 7", djs: "Seth, Ada",
    startsMs: Date.parse("2099-09-12T21:00:00Z"),
  });
  assert.equal(made.status, 200);

  const people = rows(env, `SELECT name FROM people WHERE owner_email = ? ORDER BY name`, owner)
    .map((p) => p.name);
  assert.deepEqual(people, ["Ada", "Seth"], "the DJs typed in the booth became people");
  const billed = rows(env, `SELECT role FROM party_people WHERE event_id = ?`, made.body.party.key);
  assert.equal(billed.length, 2);
  assert.ok(billed.every((r) => r.role === "dj"));

  // And the date the booth was given is the date that was stored, rather than
  // "now" - a party can be made from the Mac for next Friday.
  assert.equal(one(env, `SELECT starts_ms FROM events`).starts_ms,
    Date.parse("2099-09-12T21:00:00Z"));
});

test("the Mac lists and opens parties made on the web", async () => {
  const env = await withGoogle(makeEnv(), { name: "DJ Example" });
  const mac = await asInstall(env);
  // Made in a browser, not by the Mac.
  seedEvent(env, mac.groupId, { slug: "lido", title: "Sundaze at the Lido" });

  const list = await mac.call("/api/v1/parties");
  assert.equal(list.body.linked, true);
  assert.equal(list.body.parties.length, 1);
  assert.equal(list.body.parties[0].title, "Sundaze at the Lido");
  assert.equal(list.body.parties[0].partyId, "", "not yet broadcasting");

  // Broadcasting through it attaches the live room to THAT party.
  const key = list.body.parties[0].key;
  const bound = await mac.call("/api/v1/party/update", {
    partyKey: key, partyId: "2026-08-08-2200-ab12", state: "live",
  });
  assert.equal(bound.status, 200);
  assert.equal(bound.body.party.partyId, "2026-08-08-2200-ab12");
  assert.equal(rows(env, `SELECT * FROM events`).length, 1, "broadcasting made no second party");

  // Ending it leaves the party, and everything durable on it, alone.
  await mac.call("/api/v1/party/update", { partyKey: key, state: "over" });
  const after = one(env, `SELECT * FROM events WHERE id = ?`, key);
  assert.equal(after.state, "over");
  assert.equal(after.title, "Sundaze at the Lido");
  assert.equal(after.party_id, "2026-08-08-2200-ab12", "what happened live is kept");
  assert.equal((await get(env, "/@sundaze/lido")).status, 200, "still a page on the web");
});

test("a live room belongs to one party at a time", async () => {
  const env = await withGoogle(makeEnv(), { name: "DJ Example" });
  const mac = await asInstall(env);
  const room = "2026-08-08-2200-ab12";

  const first = await mac.call("/api/v1/party/create", { title: "Rooftop", partyId: room });
  const second = await mac.call("/api/v1/party/create", { title: "Basement", partyId: room });

  // Moving the room to a new party releases it from the old one. Both holding
  // it makes "which party did these photos land on" a coin toss, because the
  // post sync finds the event BY room id.
  const held = rows(env, `SELECT slug, party_id FROM events WHERE party_id != ''`);
  assert.equal(held.length, 1, `two parties claim the same room: ${JSON.stringify(held)}`);
  assert.equal(held[0].party_id, room);
  assert.equal(one(env, `SELECT party_id FROM events WHERE id = ?`, first.body.party.key).party_id, "");
  assert.equal(one(env, `SELECT party_id FROM events WHERE id = ?`, second.body.party.key).party_id, room);

  // And opening the first one again moves it back, still only one holder.
  await mac.call("/api/v1/party/update", { partyKey: first.body.party.key, partyId: room });
  const now = rows(env, `SELECT slug, party_id FROM events WHERE party_id != ''`);
  assert.equal(now.length, 1);
  assert.equal(now[0].slug, "rooftop");
});

test("an edit on either client lands on the one record, and only where asked", async () => {
  const env = await withGoogle(makeEnv(), { name: "DJ Example" });
  const mac = await asInstall(env);
  const made = await mac.call("/api/v1/party/create", { title: "Rooftop", place: "The roof" });
  const key = made.body.party.key;

  // The Mac sets a time. It must not blank the place it was not asked about.
  await mac.call("/api/v1/party/update", { partyKey: key, startsMs: 1786000000000 });
  let row = one(env, `SELECT * FROM events WHERE id = ?`, key);
  assert.equal(row.starts_ms, 1786000000000);
  assert.equal(row.place, "The roof", "an untouched field is not cleared");
  assert.ok(row.ics_seq > 0, "a subscribed calendar has to be told it moved");

  // A stranger's Mac cannot touch it. Same database, a second install bound to
  // a different group - checking this across two databases would pass on the
  // row simply being absent and prove nothing about ownership.
  const outsider = "ffeeddccbbaa";
  await env.DL.put(`broker/${outsider}.json`, JSON.stringify({ secret: "s2", hostLabel: "other" }));
  const otherGroup = seedGroup(env, "basement");
  const strangerId = ulid();
  env.raw.prepare(`INSERT INTO djs (id, email_norm, name, created_ms) VALUES (?,?,?,?)`)
    .run(strangerId, "stranger@example.com", "Stranger", Date.now());
  env.raw.prepare(`INSERT INTO group_djs (group_id, dj_id, role, created_ms) VALUES (?,?, 'owner', ?)`)
    .run(otherGroup, strangerId, Date.now());
  env.raw.prepare(`INSERT INTO install_accounts (install_id, email_norm, linked_ms) VALUES (?,?,?)`)
    .run(outsider, "stranger@example.com", Date.now());
  const refused = await worker.fetch(new Request("https://partyparty.party/api/v1/party/update", {
    method: "POST",
    body: JSON.stringify({ id: outsider, secret: "s2", partyKey: key, title: "Mine now" }),
  }), env);
  assert.equal(refused.status, 404, "another account's party is not yours to edit");
  assert.equal(one(env, `SELECT title FROM events WHERE id = ?`, key).title, "Rooftop");
});

test("an unsigned Mac has no parties and cannot make one", async () => {
  const env = await withGoogle(makeEnv());
  const mac = await asInstall(env, { linked: false });
  const list = await mac.call("/api/v1/parties");
  assert.deepEqual(list.body, { linked: false, parties: [] });
  const made = await mac.call("/api/v1/party/create", { title: "Nope" });
  assert.equal(made.body.linked, false);
  assert.equal(rows(env, `SELECT * FROM events`).length, 0);
});

// ---------------------------------------------- the personal party record

test("the acceptance scenario, end to end", async () => {
  const { env, send, read } = await signedIn();
  const at = (iso) => iso; // a date field, as a browser sends it

  // 2-5. An upcoming party, with a date, a place, a DJ, and two people who
  // have never heard of PartyParty.
  const made = await send("/parties/new", {
    title: "Warehouse, late", day: at("2099-09-12"), place: "Unit 7", dj: "Seth",
  });
  assert.equal(made.status, 302);
  const ev = one(env, `SELECT * FROM events`);
  assert.equal(ev.title, "Warehouse, late");
  assert.equal(ev.place, "Unit 7");
  // A day, stored at midday so no reader sees it land on the day before.
  assert.equal(ev.starts_ms, Date.parse("2099-09-12T12:00:00Z"),
    "the date typed is the date stored");
  const where = `/@${one(env, `SELECT handle FROM groups`).handle}/${ev.slug}`;

  for (const name of ["Ada", "Bo"]) {
    await send(`${where}/record`, { who: name, role: "guest" });
  }
  await send(`${where}/record`, { note: "Bringing the good speakers", attended: "" });

  // 6-7. It persists, and it is upcoming.
  let home = await (await read("/home")).text();
  assert.match(home, /Warehouse, late/);
  assert.ok(home.indexOf("<h2>Upcoming</h2>") < home.indexOf("Warehouse, late"));
  assert.equal(rows(env, `SELECT * FROM people`).length, 3, "Seth, Ada and Bo, no accounts needed");
  assert.equal(one(env, `SELECT note FROM party_notes`).note, "Bringing the good speakers");

  // 8-10. Move it into the past through the page's own edit form - the same
  // updateParty the Mac calls - then say I went, and note one person.
  const lastWeek = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const edited = await send(`${where}/edit`, {
    title: "Warehouse, late", day: lastWeek, place: "Unit 7",
    links: "Tickets | https://tickets.example/warehouse",
  });
  assert.equal(edited.status, 302, "editing a party is a normal form post");
  assert.ok(one(env, `SELECT starts_ms FROM events WHERE id = ?`, ev.id).starts_ms < Date.now(),
    "the date the form sent is the date that was stored");
  await send(`${where}/record`, { note: "Better than expected", attended: "1" });
  const ada = one(env, `SELECT * FROM people WHERE name = 'Ada'`);
  await send(`${where}/record`, { person: ada.id, encounter: "Introduced me to the promoter" });

  // 11. Now it is past.
  home = await (await read("/home")).text();
  assert.ok(home.indexOf("<h2>Past</h2>") < home.indexOf("Warehouse, late"),
    "a party whose date has gone is past, decided by the clock");
  assert.match(home, /You were there/, "an entry says what is in it, not just that it exists");

  // 12. Her page shows the party, its date, and the note from THAT night.
  let page = await (await read(`/people/${ada.id}`)).text();
  assert.match(page, /Warehouse, late/);
  assert.match(page, /Introduced me to the promoter/);

  // 13-14. A second party with the same person reuses her, and her history
  // shows both - one Ada, not two.
  await send("/parties/new", { title: "Rooftop", day: at("2099-10-01") });
  const second = rows(env, `SELECT * FROM events ORDER BY created_ms`)[1];
  const there = `/@${one(env, `SELECT handle FROM groups`).handle}/${second.slug}`;
  await send(`${there}/record`, { who: "Ada", role: "guest" });
  assert.equal(rows(env, `SELECT * FROM people WHERE name = 'Ada'`).length, 1,
    "typing a known name twice must not split their history");

  page = await (await read(`/people/${ada.id}`)).text();
  assert.match(page, /2 times/);
  assert.match(page, /Warehouse, late/);
  assert.match(page, /Rooftop/);
  // And the note stayed with the night it belongs to rather than becoming a
  // property of the person.
  assert.match(page, /Introduced me to the promoter/);
  // A night with no note about them shows the night, not a sentence apologising
  // for the absence of one.
  assert.match(page, /Rooftop/);

  // The edit landed on the page as well as in the row, links and all.
  const party = await (await read(where)).text();
  assert.match(party, /tickets\.example\/warehouse/);
  assert.match(party, />Tickets</, "a named link is shown by its name");

  // 20. Nothing anywhere lets the web start or control a broadcast.
  for (const word of ["Go live", "Go Live", "Stop broadcast", "Start broadcast",
    "/api/start", "/api/stop", "getDisplayMedia", "getUserMedia"]) {
    assert.ok(!party.includes(word), `the web offers "${word}"`);
  }
});

test("a party's details are editable from the web, and refused when empty", async () => {
  const { env, send, read } = await signedIn();
  await send("/parties/new", { title: "Basement" });
  const handle = one(env, `SELECT handle FROM groups`).handle;
  const ev = one(env, `SELECT * FROM events`);
  const where = `/@${handle}/${ev.slug}`;

  // The form is on the party page for its owner, filled in with what is there.
  const owner = await (await read(where)).text();
  assert.match(owner, /Edit the details/);
  assert.match(owner, /name="day"/, "a day, not a datetime: the product has no time in it");

  const refused = await send(`${where}/edit`, { title: "   ", starts: "", place: "" });
  assert.equal(refused.status, 200, "a refusal is the page again, not a dead end");
  const body = await refused.text();
  assert.match(body, /a party needs a name/);
  assert.equal(one(env, `SELECT title FROM events`).title, "Basement", "nothing was written");

  // A bad date is refused with what was typed still in the form, rather than
  // silently storing nothing where a time should be.
  const badDate = await (await send(`${where}/edit`,
    { title: "Basement", day: "the third of never" })).text();
  assert.match(badDate, /did not make sense/);
  assert.match(badDate, /value="Basement"/);

  // Clearing the date is a real edit, not a no-op: a party can lose its time.
  await send(`${where}/edit`, { title: "Basement", day: "2099-01-02", place: "Mine" });
  assert.equal(one(env, `SELECT starts_ms FROM events`).starts_ms, Date.parse("2099-01-02T12:00:00Z"));
  await send(`${where}/edit`, { title: "Basement", day: "", place: "Mine" });
  assert.equal(one(env, `SELECT starts_ms FROM events`).starts_ms, null);

  // And it is not open to a passer-by.
  const stranger = await post(env, `${where}/edit`, { title: "Mine now" });
  assert.equal(stranger.status, 403);
  assert.equal(one(env, `SELECT title FROM events`).title, "Basement");
});

test("only links that can be clicked are rendered as links", async () => {
  const { env, send, read } = await signedIn();
  await send("/parties/new", { title: "Basement" });
  const handle = one(env, `SELECT handle FROM groups`).handle;
  const ev = one(env, `SELECT * FROM events`);
  await send(`/@${handle}/${ev.slug}/edit`, {
    title: "Basement",
    links: [
      "https://soundcloud.example/set",
      "Map | https://maps.example/pin",
      "javascript:alert(1)",
      'https://evil.example/" onmouseover="steal()',
    ].join("\n"),
  });

  const page = await (await read(`/@${handle}/${ev.slug}`)).text();
  assert.match(page, /href="https:\/\/soundcloud\.example\/set"/);
  assert.match(page, /href="https:\/\/maps\.example\/pin"/);
  assert.ok(!page.includes('href="javascript:'), "a javascript: link is not a link");
  assert.ok(!/href="[^"]*evil\.example/.test(page),
    "a URL carrying a quote is dropped, not patched up into an anchor");
  assert.ok(!page.includes('onmouseover="'), "a quote in a URL cannot escape the attribute");
  // Two links typed, two links rendered - the other two lines are not links.
  assert.equal((page.match(/<li><a href="http/g) || []).length, 2);
  // What was typed comes back in the form, so editing does not silently rewrite
  // it - escaped, because it is text now and not markup.
  assert.match(page, /javascript:alert\(1\)/, "the textarea still holds what was typed");
});

test("a party is playing right now only while a Mac keeps saying so", async () => {
  const { env, send, read } = await signedIn();
  await send("/parties/new", { title: "Warehouse" });
  const handle = one(env, `SELECT handle FROM groups`).handle;
  const ev = one(env, `SELECT * FROM events`);
  const where = `/@${handle}/${ev.slug}`;
  const partyId = "2026-08-06-2200-ab12";

  // Nothing has ever broadcast: the page is a page, with no listen link.
  let page = await (await read(where)).text();
  assert.ok(!page.includes("Playing right now"), "a party that never broadcast is not live");

  // A Mac attaches its room and syncs the wall - which is also the heartbeat.
  const install = await linkedInstall(env, handle);
  env.raw.prepare(`UPDATE events SET party_id = ? WHERE id = ?`).run(partyId, ev.id);
  const synced = await postJson(env, "/api/v1/party/posts", {
    ...install, partyId, joinUrl: "https://early-heron.party.partyparty.party:8443/", posts: [],
  });
  assert.equal((await synced.json()).bound, true);

  page = await (await read(where)).text();
  assert.match(page, /Playing right now/);
  assert.match(page, /href="https:\/\/early-heron\.party\.partyparty\.party:8443\/"/);
  assert.match(await (await read("/home")).text(), /Playing now/);

  // Listening is all the web gets. No control of the room reaches this page.
  for (const word of ["Go live", "Go Live", "Stop broadcast", "getDisplayMedia"]) {
    assert.ok(!page.includes(word), `the web offers "${word}"`);
  }

  // The set ends: the Mac simply stops calling. Ninety seconds later the page
  // stops claiming it, with nobody having told it anything.
  env.raw.prepare(`UPDATE events SET live_ms = ? WHERE id = ?`)
    .run(Date.now() - 120000, ev.id);
  page = await (await read(where)).text();
  assert.ok(!page.includes("Playing right now"), "a heartbeat that stopped is not a live room");
  // But the party itself is untouched - the point of a permanent record.
  assert.match(page, /Warehouse/);
  assert.match(page, /Your notes/, "the record is the page, and it survives the broadcast");
  assert.ok(!(await (await read("/home")).text()).includes("Playing now"));

  // A join URL that is not https is never shown, whatever the Mac sends.
  await postJson(env, "/api/v1/party/posts", {
    ...install, partyId, joinUrl: "javascript:alert(1)", posts: [],
  });
  page = await (await read(where)).text();
  assert.ok(!page.includes("javascript:alert"), "only an https room is offered to a listener");
  assert.match(page, /Playing right now/, "the heartbeat still counts");
  assert.match(page, /href="https:\/\/early-heron/, "and the last good link is kept");
});

test("a party is found by its owner, and following is between people", async () => {
  const { env, send, read } = await signedIn();
  const me = one(env, `SELECT email_norm FROM djs`).email_norm;
  const handle = one(env, `SELECT handle FROM profiles`).handle;
  await send("/parties/new", { title: "Warehouse" });
  const ev = one(env, `SELECT * FROM events`);

  // The address is the PERSON's @name. Point the party at a group nobody has
  // ever heard of and it is still reachable at mine, because the lookup no
  // longer goes through groups at all.
  const orphan = seedGroup(env, "nowhere");
  env.raw.prepare(`UPDATE events SET group_id = ? WHERE id = ?`).run(orphan, ev.id);
  assert.equal((await read(`/@${handle}/${ev.slug}`)).status, 200,
    "found by whose it is, not by which group holds it");

  // Following writes the two people, and privately: nobody consented to being
  // seen following anybody.
  await post(env, `/@${handle}/join`, { email: "fan@example.com", name: "Fan" });
  const follow = one(env, `SELECT * FROM follows`);
  assert.equal(follow.follower_email, "fan@example.com");
  assert.equal(follow.person_email, me);
  assert.equal(follow.public, 0, "private by default");

  // And it is visible to the one person it concerns: whoever chose it.
  const fan = await withGoogle(makeEnv(), { name: "Fan" });
  assert.ok(fan, "the follower sees their own list on their own home");
  const home = await (await read("/home")).text();
  assert.ok(!/You follow/.test(home), "following nobody says nothing");
});

test("the whole sentence goes in from one place", async () => {
  const { env, send, read } = await signedIn();
  await send("/parties/new", { title: "Warehouse" });
  const handle = one(env, `SELECT handle FROM groups`).handle;
  const ev = one(env, `SELECT * FROM events`);
  const where = `/@${handle}/${ev.slug}`;

  // "I saw DJ 1, 2 and 3, they played XYZ, I was with A and B" - four clauses.
  // Each goes in at the top of the page, without scrolling to find a section.
  await send(`${where}/record`, { it: "Ada, Bo and Cy", as: "dj" });
  await send(`${where}/record`, { it: "Windowlicker by Aphex Twin", as: "song" });
  await send(`${where}/record`, { it: "Dee and Eve", as: "guest" });

  assert.deepEqual(rows(env, `SELECT p.name FROM party_people pp
    JOIN people p ON p.id = pp.person_id WHERE pp.role='dj' ORDER BY p.name`)
    .map((r) => r.name), ["Ada", "Bo", "Cy"]);
  assert.deepEqual(rows(env, `SELECT p.name FROM party_people pp
    JOIN people p ON p.id = pp.person_id WHERE pp.role='guest' ORDER BY p.name`)
    .map((r) => r.name), ["Dee", "Eve"]);
  const song = one(env, `SELECT * FROM songs`);
  assert.equal(song.title, "Windowlicker");
  assert.equal(song.artist, "Aphex Twin", "by names the artist without a second field");

  // And the line is the first thing on the night, not buried under it.
  const page = await (await read(where)).text();
  assert.ok(page.indexOf('class="capture"') < page.indexOf("<h2>Who played</h2>"),
    "you write at the top; the sections below are for correcting");
});

test("three DJs and three friends is one thing you type", async () => {
  const { env, send, read } = await signedIn();
  await send("/parties/new", { title: "Warehouse" });
  const handle = one(env, `SELECT handle FROM groups`).handle;
  const ev = one(env, `SELECT * FROM events`);
  const where = `/@${handle}/${ev.slug}`;

  // "I saw DJ 1, 2 and 3" is one thought, so it is one action. Three trips
  // through a form for one sentence is the friction this app exists to avoid.
  await send(`${where}/record`, { who: "Ada, Bo and Cy", role: "dj" });
  await send(`${where}/record`, { who: "Dee, Eve", role: "guest" });
  await send(`${where}/record`, { songTitle: "Windowlicker, Xtal", songArtist: "Aphex Twin" });

  const played = rows(env, `SELECT p.name FROM party_people pp JOIN people p ON p.id = pp.person_id
    WHERE pp.role = 'dj' ORDER BY p.name`).map((r) => r.name);
  assert.deepEqual(played, ["Ada", "Bo", "Cy"], "and is a separator too, because people type it");
  const with_ = rows(env, `SELECT p.name FROM party_people pp JOIN people p ON p.id = pp.person_id
    WHERE pp.role = 'guest' ORDER BY p.name`).map((r) => r.name);
  assert.deepEqual(with_, ["Dee", "Eve"]);
  const songs = rows(env, `SELECT title, artist FROM songs ORDER BY seq`);
  assert.deepEqual(songs.map((x) => x.title), ["Windowlicker", "Xtal"]);
  assert.ok(songs.every((x) => x.artist === "Aphex Twin"), "one artist covers the run");

  // Six people and two songs, from three things typed.
  assert.equal(rows(env, `SELECT * FROM people`).length, 5);
  assert.match(await (await read(where)).text(), /Windowlicker/);
});

test("a night is a day, a place, and what was played", async () => {
  const { env, send, read } = await signedIn();

  // Today is already in the form. Standing at a party, the date is not a
  // question worth asking.
  const form = await (await read("/parties/new")).text();
  assert.match(form, /type="date"/);
  assert.ok(!/<input[^>]*type="datetime-local"/.test(form),
    "no time field: nobody journals that it started at 21:00");
  assert.match(form, new RegExp(`value="${new Date().toISOString().slice(0, 10)}"`),
    "today is filled in already");

  await send("/parties/new", { title: "Warehouse", day: "2026-08-08", place: "Unit 7" });

  // Where you were last is already in the next one. At a regular haunt that is
  // the right answer, and everywhere else it is one tap to clear - which beats
  // a browser location prompt and a geocoding service for the same guess.
  assert.match(await (await read("/parties/new")).text(), /value="Unit 7"/);

  const handle = one(env, `SELECT handle FROM groups`).handle;
  const ev = one(env, `SELECT * FROM events`);
  const where = `/@${handle}/${ev.slug}`;
  assert.equal(ev.day_only, 1);

  let page = await (await read(where)).text();
  assert.match(page, /Sat 8 Aug/);
  assert.ok(!/21:00|12:00|00:00/.test(page), "the hour is never shown");
  assert.match(page, /What was played, in the order it was played/);

  // A song, in one field, as it plays.
  await send(`${where}/record`, { songTitle: "Windowlicker", songArtist: "Aphex Twin" });
  await send(`${where}/record`, { songTitle: "Papua New Guinea" });
  const played = rows(env, `SELECT * FROM songs ORDER BY seq`);
  assert.deepEqual(played.map((x) => x.title), ["Windowlicker", "Papua New Guinea"],
    "the order they were added is the order they were played");
  assert.equal(played[0].artist, "Aphex Twin");

  page = await (await read(where)).text();
  assert.match(page, /Windowlicker/);
  assert.match(page, /Aphex Twin/);
  assert.match(page, /Papua New Guinea/);

  // Written down by mistake, taken back off.
  await send(`${where}/record`, { song: played[1].id, remove: "1" });
  assert.deepEqual(rows(env, `SELECT title FROM songs`).map((x) => x.title), ["Windowlicker"]);

  // A setlist is the owner's, like the rest of the record.
  assert.ok(!(await (await get(env, where)).text()).includes("Windowlicker"),
    "what was played is mine until I share it");
});

test("a party belongs to a person, not to a group", async () => {
  const { env, send, read } = await signedIn();
  const me = one(env, `SELECT email_norm FROM djs`).email_norm;
  await send("/parties/new", { title: "Warehouse, late" });

  const ev = one(env, `SELECT * FROM events`);
  assert.equal(ev.owner_email, me, "the party carries whose it is");

  // Being in the group is no longer what makes it mine. Cut every group tie and
  // it is still my party, still on my home, still at its address.
  env.raw.prepare(`DELETE FROM group_djs`).run();
  const handle = one(env, `SELECT handle FROM groups`).handle;
  const home = await (await read("/home")).text();
  assert.match(home, /Warehouse, late/, "a party I own is mine without a group");
  assert.equal((await read(`/@${handle}/${ev.slug}`)).status, 200);

  // And somebody else's party is not mine, however the groups are arranged.
  const theirs = ulid();
  env.raw.prepare(`INSERT INTO events (id, group_id, owner_email, slug, title, state, created_ms, updated_ms)
    VALUES (?, ?, 'someone@else.example', 'not-mine', 'Not mine', 'announced', ?, ?)`)
    .run(theirs, ev.group_id, Date.now(), Date.now());
  assert.ok(!(await (await read("/home")).text()).includes("Not mine"),
    "sharing a group with somebody does not make their party mine");
});

test("a record belongs to one person and is invisible to everybody else", async () => {
  const { env, send, read } = await signedIn();
  await send("/parties/new", { title: "Warehouse", dj: "Seth" });
  const handle = one(env, `SELECT handle FROM groups`).handle;
  const ev = one(env, `SELECT * FROM events`);
  await send(`/@${handle}/${ev.slug}/record`, { note: "My private thought", attended: "1" });

  // Shared by link, the night is readable and the record still is not.
  await send(`/@${handle}/${ev.slug}/record`, { visibility: "link" });
  const publicPage = await (await get(env, `/@${handle}/${ev.slug}`)).text();
  assert.match(publicPage, /Warehouse/);
  assert.ok(!publicPage.includes("My private thought"), "a note is a diary, not content");
  assert.ok(!publicPage.includes("Your notes"));
  // Seth is who PLAYED - the night's billing, which is what the night was, so
  // sharing the night shares it. Who I SAW is my observation of a room and
  // stays mine however widely the night is shared, like my note does.
  assert.match(publicPage, /Seth/, "the bill is the night");
  await send(`/@${handle}/${ev.slug}/record`, { who: "Ada", role: "guest" });
  const again = await (await get(env, `/@${handle}/${ev.slug}`)).text();
  assert.ok(!again.includes("Ada"), "who I saw is mine, shared or not");

  // Another person's record of the SAME party, in the same database. The risk
  // is a query that forgets owner_email, so this puts a rival row right next
  // to mine and checks which one comes back.
  env.raw.prepare(`INSERT INTO party_notes (event_id, owner_email, note, attended, updated_ms)
    VALUES (?, 'someone@else.example', 'Their private thought', 1, ?)`).run(ev.id, Date.now());
  const theirPerson = ulid();
  env.raw.prepare(`INSERT INTO people (id, owner_email, name, created_ms, updated_ms)
    VALUES (?, 'someone@else.example', 'Their Friend', ?, ?)`)
    .run(theirPerson, Date.now(), Date.now());
  env.raw.prepare(`INSERT INTO party_people (event_id, person_id, owner_email, role, note, created_ms)
    VALUES (?, ?, 'someone@else.example', 'guest', 'Their encounter', ?)`)
    .run(ev.id, theirPerson, Date.now());

  const mine = await (await read(`/@${handle}/${ev.slug}`)).text();
  assert.match(mine, /My private thought/, "my own note is on my page");
  assert.ok(!mine.includes("Their private thought"), "another person's note leaked in");
  assert.ok(!mine.includes("Their Friend"), "another person's people leaked in");
  assert.ok(!mine.includes("Their encounter"));

  // And their party does not appear on my shelf, nor their person in my list.
  assert.ok(!(await (await read("/people")).text()).includes("Their Friend"));
});

// Two workers share one zone, and which paths belong to this one is declared
// in wrangler.jsonc rather than in the code that serves them. A page added
// without its route works perfectly on localhost and 404s on partyparty.party,
// because the request never reaches this worker at all - it is answered by
// partyparty-site, which has never heard of it. Nothing in a request-level
// test can see that: the tests call this worker directly.
//
// So this reads the two files against each other. Every exact path the worker
// answers must be claimed by a route, and the development doors must NOT be -
// they are shut by DEV_LOGIN, and a route for them is a door on the internet.
test("every page this worker serves is claimed by one of its routes", () => {
  const source = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");

  // Cloudflare's * matches anything, including slashes. A pattern without one
  // matches its own path and nothing under it, which is why /people needs two.
  const patterns = [...config.matchAll(/"pattern":\s*"partyparty\.party([^"]*)"/g)]
    .map((m) => new RegExp("^" + m[1].split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"));
  const claimed = (path) => patterns.some((re) => re.test(path));

  // What the worker actually answers, read off the routing itself.
  const exact = [...source.matchAll(/path === "(\/[^"]*)"/g)].map((m) => m[1]);
  const prefixes = [...source.matchAll(/path\.startsWith\("(\/[^"]*)"\)/g)].map((m) => m[1]);
  // The pattern routes, which are stable and not worth parsing out of regexes.
  const patterned = ["/@sundaze", "/@sundaze/june-14", "/j/" + "a".repeat(48),
    "/m/" + "a".repeat(48), "/g/" + "a".repeat(48), "/link/ABC123",
    "/calendar/sundaze.ics", "/auth/apple", "/auth/apple/callback"];

  assert.ok(exact.length > 10, "the routing moved; this test is reading the wrong thing");
  assert.ok(exact.includes("/people") && exact.includes("/parties/new"),
    "the tracker's own pages must be among the paths checked");

  for (const path of exact) {
    if (path.startsWith("/dev/")) {
      assert.ok(!claimed(path), `${path} is a development door and must have no route`);
      continue;
    }
    assert.ok(claimed(path), `${path} is served but no route sends it here`);
  }
  for (const prefix of prefixes) {
    assert.ok(claimed(prefix + "x"), `${prefix}* is served but no route sends it here`);
  }
  for (const path of patterned) {
    assert.ok(claimed(path), `${path} is served but no route sends it here`);
  }
});

test("a person can turn out to be an account, later, or never", async () => {
  const { env, send, read } = await signedIn();
  await send("/parties/new", { title: "Warehouse", dj: "Seth" });
  const seth = one(env, `SELECT * FROM people WHERE name = 'Seth'`);
  assert.equal(seth.account_email, null, "recording somebody never needs an account");

  // Somebody who does have one. The @name is theirs; my name for them is mine.
  env.raw.prepare(`INSERT INTO profiles (email_norm, handle, name, created_ms, updated_ms)
    VALUES ('seth@example.com', 'sethplays', 'Seth Green', ?, ?)`).run(Date.now(), Date.now());

  const wrong = await (await send(`/people/${seth.id}`,
    { name: "Seth", note: "Owes me a record", account: "nobodyhere" })).text();
  assert.match(wrong, /Nobody here is @nobodyhere/);
  assert.equal(one(env, `SELECT account_email FROM people WHERE id = ?`, seth.id).account_email, null);
  // The refusal is one bad field, not a reason to retype the rest.
  assert.match(wrong, /Owes me a record/, "the note that was typed is still in the form");
  assert.match(wrong, /value="nobodyhere"/);

  await send(`/people/${seth.id}`, { name: "Seth", note: "Warehouse regular", account: "@SethPlays" });
  assert.equal(one(env, `SELECT account_email FROM people WHERE id = ?`, seth.id).account_email,
    "seth@example.com", "an @name with the shouting and the @ still lands");

  let page = await (await read(`/people/${seth.id}`)).text();
  assert.match(page, /@sethplays/);
  assert.match(page, /href="\/@sethplays"/, "their profile is one click away");
  assert.match(page, />Seth</, "my name for them is still my name for them");
  assert.match(page, /Warehouse regular/);

  // And unsaying it is just clearing the field.
  await send(`/people/${seth.id}`, { name: "Seth", note: "Warehouse regular", account: "" });
  assert.equal(one(env, `SELECT account_email FROM people WHERE id = ?`, seth.id).account_email, null);
  page = await (await read(`/people/${seth.id}`)).text();
  assert.ok(!page.includes("@sethplays"));
  assert.match(page, /Warehouse regular/, "and the note it never belonged to survives");
});

test("upcoming, on tonight, and past are read off the clock", async () => {
  const { env, send, read } = await signedIn();
  await send("/parties/new", { title: "Warehouse" });
  const ev = one(env, `SELECT * FROM events`);
  const handle = one(env, `SELECT handle FROM groups`).handle;
  const at = (ms) => env.raw.prepare(`UPDATE events SET starts_ms = ? WHERE id = ?`).run(ms, ev.id);

  // No date at all is upcoming: it has not happened.
  let home = await (await read("/home")).text();
  assert.ok(home.indexOf("<h2>Upcoming</h2>") < home.indexOf("Warehouse"));

  // Started an hour ago: still on, still filed under Upcoming rather than
  // vanishing into Past while people are in the room.
  at(Date.now() - 60 * 60 * 1000);
  home = await (await read("/home")).text();
  assert.match(home, /class="tag live">Tonight</, "a night in progress says so");
  assert.ok(home.indexOf("<h2>Upcoming</h2>") < home.indexOf("Warehouse"));
  assert.match(await (await read(`/@${handle}/${ev.slug}`)).text(), /on tonight/);

  // Seven hours ago: the night is over, and nothing had to be switched.
  at(Date.now() - 7 * 60 * 60 * 1000);
  home = await (await read("/home")).text();
  assert.ok(home.indexOf("<h2>Past</h2>") < home.indexOf("Warehouse"));
  assert.ok(!home.includes('class="tag live">Tonight<'));
});

test("taking a name back off a party keeps the person only if they are one", async () => {
  const { env, send, read } = await signedIn();
  await send("/parties/new", { title: "Warehouse", dj: "Seth" });
  const handle = one(env, `SELECT handle FROM groups`).handle;
  const first = one(env, `SELECT * FROM events`);
  const where = `/@${handle}/${first.slug}`;

  // A typo, added and taken straight back off: nothing was ever written about
  // them and they were never anywhere else, so no ghost is left behind.
  await send(`${where}/record`, { who: "Nnia", role: "guest" });
  const typo = one(env, `SELECT * FROM people WHERE name = 'Nnia'`);
  await send(`${where}/record`, { person: typo.id, remove: "1" });
  assert.equal(one(env, `SELECT * FROM people WHERE name = 'Nnia'`), undefined);

  // Somebody I wrote about at another party keeps their record, because the
  // removal is from THIS night and their history is not this night's to erase.
  await send("/parties/new", { title: "Rooftop" });
  const second = rows(env, `SELECT * FROM events ORDER BY created_ms`)[1];
  const there = `/@${handle}/${second.slug}`;
  for (const at of [where, there]) await send(`${at}/record`, { who: "Nina", role: "guest" });
  const nina = one(env, `SELECT * FROM people WHERE name = 'Nina'`);
  await send(`${there}/record`, { person: nina.id, encounter: "Played the last hour" });
  await send(`${where}/record`, { person: nina.id, remove: "1" });

  assert.ok(one(env, `SELECT * FROM people WHERE id = ?`, nina.id), "she is still somebody I know");
  const page = await (await read(`/people/${nina.id}`)).text();
  assert.match(page, /Rooftop/);
  assert.match(page, /Played the last hour/);
  assert.ok(!page.includes("Warehouse"), "and the night she was taken off is gone");
});

test("people are searchable, reusable and never require an account", async () => {
  const { env, send, read } = await signedIn();
  await send("/parties/new", { title: "One", dj: "Seth Green, Ada Lovelace" });

  const all = await (await read("/people")).text();
  assert.match(all, /Seth Green/);
  assert.match(all, /Ada Lovelace/);
  const found = await (await read("/people?q=ada")).text();
  assert.match(found, /Ada Lovelace/);
  assert.ok(!found.includes("Seth Green"), "search narrows");
  const missing = await (await read("/people?q=zzz")).text();
  assert.match(missing, /Nobody by that name/);

  // A general note about a person is separate from what happened on a night.
  const ada = one(env, `SELECT * FROM people WHERE name = 'Ada Lovelace'`);
  await send(`/people/${ada.id}`, { name: "Ada Lovelace", note: "Always worth saying hello" });
  const page = await (await read(`/people/${ada.id}`)).text();
  assert.match(page, /Always worth saying hello/);
  assert.equal(one(env, `SELECT note FROM people WHERE id = ?`, ada.id).note,
    "Always worth saying hello");
  assert.equal(one(env, `SELECT account_email FROM people WHERE id = ?`, ada.id).account_email, null,
    "no account required to be remembered");
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
