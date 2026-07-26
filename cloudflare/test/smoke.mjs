import assert from "node:assert/strict";
import worker, {
  APP_VERSION,
  cookieHeader,
  normalizeHandle,
  parseCookies,
  readJson,
  sha256Hex,
} from "../worker.js";

class MemoryR2 {
  constructor(entries = {}) {
    this.items = new Map(Object.entries(entries));
  }
  async get(key) {
    if (!this.items.has(key)) return null;
    const value = this.items.get(key);
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    return {
      body: bytes,
      size: bytes.byteLength,
      uploaded: new Date("2026-07-25T00:00:00Z"),
      httpEtag: `"${await sha256Hex(key)}"`,
      text: async () => new TextDecoder().decode(bytes),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      writeHttpMetadata() {},
    };
  }
  async put(key, value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer());
    this.items.set(key, bytes);
  }
  async delete(key) { this.items.delete(key); }
  async list({ prefix = "" } = {}) {
    return {
      objects: [...this.items.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, size: value.byteLength || String(value).length, uploaded: new Date() })),
    };
  }
}

const assets = {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    return path === "/" ? new Response("landing", { headers: { "content-type": "text/html" } }) : new Response("asset missing", { status: 404 });
  },
};

const baseEnv = () => ({
  ASSETS: assets,
  DL: new MemoryR2({
    "appcast.xml": "<rss/>",
    "partyparty.pkg": new Uint8Array([1, 2, 3]),
    "content/manifest.json": JSON.stringify({ version: 9 }),
    "content/app-version": APP_VERSION,
  }),
  BROKER_BASE: "partyparty.party",
  CF_DNS_TOKEN: "token",
  CF_ZONE_ID: "0123456789abcdef0123456789abcdef",
});

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("cookie helpers keep secure session defaults", () => {
  const parsed = parseCookies(new Request("https://partyparty.party/", { headers: { cookie: "a=one%20two; b=3" } }));
  assert.deepEqual(parsed, { a: "one two", b: "3" });
  assert.match(cookieHeader("pp", "x"), /HttpOnly; Secure; SameSite=Lax/);
});

test("normalization and bounded JSON parsing remain strict", async () => {
  assert.equal(normalizeHandle("  DJ Name  "), "dj.name");
  assert.equal(normalizeHandle("!"), "");
  assert.deepEqual(await readJson(new Request("https://x/", { method: "POST", body: '{"ok":true}' }), 32), { ok: true });
  assert.equal(await readJson(new Request("https://x/", { method: "POST", body: '{"too":"large"}' }), 2), null);
});

test("landing, version, appcast, installer, and OTA artifacts are served", async () => {
  const env = baseEnv();
  assert.equal(await (await worker.fetch(new Request("https://partyparty.party/"), env)).text(), "landing");
  const version = await (await worker.fetch(new Request("https://partyparty.party/api/version"), env)).json();
  assert.equal(version.version, APP_VERSION);
  assert.equal((await worker.fetch(new Request("https://partyparty.party/appcast.xml"), env)).status, 200);
  assert.equal((await worker.fetch(new Request("https://partyparty.party/partyparty.pkg"), env)).status, 200);
  assert.equal((await worker.fetch(new Request("https://partyparty.party/content/manifest.json"), env)).status, 200);
});

test("retired public party, profile, discovery, and media routes stay gone", async () => {
  const env = baseEnv();
  for (const path of ["/live", "/home", "/demo", "/e/test", "/@dj", "/api/discover", "/api/events", "/event/test/live/live.m3u8"]) {
    const response = await worker.fetch(new Request(`https://partyparty.party${path}`), env);
    assert.equal(response.status, 404, path);
  }
});

test("broker ping remains public and registration remains available", async () => {
  const env = baseEnv();
  const ping = await worker.fetch(new Request("https://partyparty.party/api/broker/ping"), env);
  assert.equal(ping.status, 200);
  const registered = await worker.fetch(new Request("https://partyparty.party/api/broker/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }), env);
  assert.equal(registered.status, 200);
  const body = await registered.json();
  assert.match(body.id, /^[a-f0-9]{12}$/);
  assert.match(body.secret, /^[a-f0-9]{48}$/);
});

test("retired cloud ingest endpoints reject requests", async () => {
  const env = baseEnv();
  for (const path of ["/api/broker/live", "/api/broker/offline", "/api/broker/publish-meta", "/api/broker/publish-posts"]) {
    const response = await worker.fetch(new Request(`https://partyparty.party${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }), env);
    assert.equal(response.status, 400, path);
  }
  const binary = await worker.fetch(new Request("https://partyparty.party/api/broker/live-segment", {
    method: "PUT",
    body: new Uint8Array([1]),
  }), env);
  assert.equal(binary.status, 405);
});

test("account pages still gate anonymous users", async () => {
  const env = { ...baseEnv(), DB: { prepare() { throw new Error("session query should fail closed"); } } };
  const response = await worker.fetch(new Request("https://partyparty.party/account"), env);
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location") || "", /^\/login/);
});

let failures = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}
if (failures) process.exit(1);
console.log(`PASS ${tests.length} worker smoke tests`);
