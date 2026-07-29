import assert from "node:assert/strict";
import worker, {
  APP_VERSION,
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
  async head(key) {
    if (!this.items.has(key)) return null;
    return { size: this.items.get(key).byteLength || String(this.items.get(key)).length };
  }
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
  DL: new MemoryR2(),
  BROKER_BASE: "partyparty.party",
  CF_DNS_TOKEN: "token",
  CF_ZONE_ID: "0123456789abcdef0123456789abcdef",
});

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("bounded JSON parsing remains strict", async () => {
  assert.deepEqual(await readJson(new Request("https://x/", { method: "POST", body: '{"ok":true}' }), 32), { ok: true });
  assert.equal(await readJson(new Request("https://x/", { method: "POST", body: '{"too":"large"}' }), 2), null);
});

test("landing, legal pages, version, and signed standalone release files are served", async () => {
  const env = baseEnv();
  await env.DL.put("standalone/partyparty-beta.zip", new Uint8Array([80, 75, 3, 4]));
  await env.DL.put("standalone/partyparty-124.14-216.zip", new Uint8Array([80, 75, 3, 4]));
  await env.DL.put("standalone/appcast.xml", "<rss/>");
  assert.equal(await (await worker.fetch(new Request("https://partyparty.party/"), env)).text(), "landing");
  for (const path of ["/privacy", "/support"]) {
    const response = await worker.fetch(new Request(`https://partyparty.party${path}`), env);
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /partyparty/);
  }
  const version = await (await worker.fetch(new Request("https://partyparty.party/api/version"), env)).json();
  assert.equal(version.version, APP_VERSION);
  assert.equal("standaloneBuild" in version, false);
  assert.equal(version.standaloneDownload, "/partyparty-beta.zip");
  const beta = await worker.fetch(new Request("https://partyparty.party/partyparty-beta.zip"), env);
  assert.equal(beta.status, 200);
  assert.equal(beta.headers.get("content-type"), "application/zip");
  assert.equal(beta.headers.get("content-disposition"), 'attachment; filename="partyparty-beta.zip"');
  assert.equal((await beta.arrayBuffer()).byteLength, 4);
  const betaHead = await worker.fetch(new Request("https://partyparty.party/partyparty-beta.zip", { method: "HEAD" }), env);
  assert.equal(betaHead.status, 200);
  assert.equal(betaHead.headers.get("content-length"), "4");
  assert.equal((await worker.fetch(new Request("https://partyparty.party/appcast.xml"), env)).status, 200);
  const immutable = await worker.fetch(new Request("https://partyparty.party/downloads/partyparty-124.14-216.zip"), env);
  assert.equal(immutable.headers.get("cache-control"), "public, max-age=31536000, immutable");
  for (const path of ["/private-beta/partyparty-123.88.zip", "/partyparty.pkg", "/partyparty.zip", "/content/manifest.json", "/content/state.json"]) {
    assert.equal((await worker.fetch(new Request(`https://partyparty.party${path}`), env)).status, 404, path);
  }
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
  assert.match(body.hostLabel, /^[a-z]+-[a-z]+$/);

  const relay = await worker.fetch(new Request("https://partyparty.party/api/broker/relay/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.10",
    },
    body: JSON.stringify({ id: body.id, secret: body.secret, lanIp: "192.168.20.14" }),
  }), env);
  assert.equal(relay.status, 200);
  const relayBody = await relay.json();
  assert.match(relayBody.joinUrl, /^https:\/\/r-[a-f0-9]{32}\.partyparty\.party\/$/);
  assert.match(relayBody.connectUrl, /^wss:\/\/partyparty\.party\/api\/broker\/relay\/connect\/[a-f0-9]{32}$/);
  assert.match(relayBody.networkKey, /^[a-f0-9]{64}$/);
  const relayToken = new URL(relayBody.joinUrl).hostname.slice(2, 34);
  await env.DL.delete(`broker/relay/${relayToken}`);
  const repaired = await worker.fetch(new Request("https://partyparty.party/api/broker/relay/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": "203.0.113.10",
    },
    body: JSON.stringify({ id: body.id, secret: body.secret, lanIp: "192.168.20.14" }),
  }), env);
  assert.equal(repaired.status, 200);
  assert.ok(await env.DL.head(`broker/relay/${relayToken}`));

  const invalidLAN = await worker.fetch(new Request("https://partyparty.party/api/broker/relay/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: body.id, secret: body.secret, lanIp: "127.0.0.1" }),
  }), env);
  assert.equal(invalidLAN.status, 400);

  const publicRoom = await worker.fetch(
    new Request(relayBody.joinUrl),
    env,
    { waitUntil() {} },
  );
  assert.equal(publicRoom.status, 200);
  const routed = await publicRoom.json();
  assert.equal(routed.path, "/room/");
  assert.match(routed.host, /^r-[a-f0-9]{32}\.partyparty\.party$/);

  const blockedUpload = await worker.fetch(new Request(new URL("/api/upload", relayBody.joinUrl), {
    method: "POST",
    body: new Uint8Array(1024),
  }), env, { waitUntil() {} });
  assert.equal(blockedUpload.status, 409);
  assert.equal((await blockedUpload.json()).code, "relay_video_unavailable");
  const blockedMedia = await worker.fetch(
    new Request(new URL("/media/large-video.mp4", relayBody.joinUrl)),
    env,
    { waitUntil() {} },
  );
  assert.equal(blockedMedia.status, 409);
  assert.equal((await blockedMedia.json()).code, "relay_video_unavailable");
  const relayedPhoto = await worker.fetch(new Request(new URL("/api/upload", relayBody.joinUrl), {
    method: "POST",
    headers: { "content-type": "image/jpeg", "x-pp-name": "party.jpg" },
    body: new Uint8Array(1024),
  }), env, { waitUntil() {} });
  assert.equal(relayedPhoto.status, 200);
  assert.equal((await relayedPhoto.json()).path, "/room/api/upload");
  const relayedPhotoDownload = await worker.fetch(
    new Request(new URL("/media/party.jpg", relayBody.joinUrl)),
    env,
    { waitUntil() {} },
  );
  assert.equal(relayedPhotoDownload.status, 200);
  assert.equal((await relayedPhotoDownload.json()).path, "/room/media/party.jpg");

  const connect = await worker.fetch(new Request(relayBody.connectUrl.replace("wss:", "https:"), {
    headers: {
      upgrade: "websocket",
      "x-partyparty-install": body.id,
      "x-partyparty-secret": body.secret,
    },
  }), env);
  assert.equal(connect.status, 200);
  assert.equal((await connect.json()).path, "/connect");
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

test("retired identity and account routes stay gone", async () => {
  const env = baseEnv();
  for (const path of ["/login", "/account", "/auth/apple", "/auth/google", "/api/me", "/api/account/delete", "/link-mac"]) {
    const response = await worker.fetch(new Request(`https://partyparty.party${path}`), env);
    assert.equal(response.status, 404, path);
  }
});

test("the relay bootstrap is stateless and sends guests to the relay origin", async () => {
  // The Durable Object and the per-request media proxy are gone. What remains on
  // a r-<token> hostname is one page that classifies the network and hands off,
  // so a Worker is touched about once per guest join rather than 13 times a
  // second per listener.
  const env = baseEnv();
  await env.DL.put("broker/relay/" + "a".repeat(32), "install-1");
  await env.DL.put("broker/install-1.json", JSON.stringify({
    id: "install-1", directUrl: "https://disco.party.partyparty.party:8443/",
  }));

  const page = await worker.fetch(
    new Request("https://r-" + "a".repeat(32) + ".partyparty.party/"), env);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes("disco.party.partyparty.party:8443"), "bootstrap must know the direct URL");
  assert.ok(html.includes(".relay.partyparty.party"), "bootstrap must know the relay origin");
  assert.ok(!html.includes("__pp/state"), "the state endpoint died with the Durable Object");
});

test("a guest can report reachability exactly once per join", async () => {
  const env = baseEnv();
  const token = "b".repeat(32);
  await env.DL.put("broker/relay/" + token, "install-1");

  const reported = await worker.fetch(new Request(
    "https://r-" + token + ".partyparty.party/__pp/probe",
    { method: "POST", body: JSON.stringify({ reachable: false }) }), env);
  assert.equal(reported.status, 200);

  const stored = await env.DL.get("broker/relay-probe/" + token);
  assert.ok(stored, "the verdict must be readable by the Mac on its next poll");
  assert.equal(JSON.parse(await stored.text()).reachable, false);
});

console.log(`PASS ${tests.length} worker smoke tests`);
