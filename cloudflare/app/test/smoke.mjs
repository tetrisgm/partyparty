import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { handleProblem, icsFor, normalizeEmail, ulid } from "../worker.js";

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

for (const [name, fn] of tests) {
  try {
    await fn();
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}
console.log(`PASS ${tests.length} platform tests`);
