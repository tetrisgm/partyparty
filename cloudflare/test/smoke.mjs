import assert from "node:assert/strict";
import worker, {
  APP_VERSION,
  RelayRoom,
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
  RELAY_ROOMS: {
    getByName() {
      return {
        fetch(request) {
          return new Response(JSON.stringify({
            path: new URL(request.url).pathname,
            host: request.headers.get("x-pp-public-host"),
          }), { headers: { "content-type": "application/json" } });
        },
      };
    },
  },
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
  await env.DL.put("standalone/partyparty-124.11-213.zip", new Uint8Array([80, 75, 3, 4]));
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
  const immutable = await worker.fetch(new Request("https://partyparty.party/downloads/partyparty-124.11-213.zip"), env);
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

test("relay bootstrap lets the phone report reachability while the Mac owns the mode", async () => {
  const sent = [];
  const origin = {
    readyState: 1,
    send(message) { sent.push(message); },
    deserializeAttachment() { return { role: "origin" }; },
  };
  let ready = Promise.resolve();
  const stored = new Map();
  const ctx = {
    storage: {
      get: async (key) => stored.get(key),
      put: async (key, value) => stored.set(key, value),
    },
    blockConcurrencyWhile(fn) { ready = Promise.resolve(fn()); },
    getWebSockets(tag) { return tag === "origin" ? [origin] : []; },
  };
  const room = new RelayRoom(ctx, {});
  await ready;
  room.roomState = {
    mode: "checking",
    directUrl: "https://disco-party.party.partyparty.party:8443/",
    networkKey: "network-1",
    version: "test",
    updatedAt: Date.now(),
  };

  const bootstrap = await room.fetch(new Request("https://relay.internal/room/"));
  assert.equal(bootstrap.status, 200);
  const html = await bootstrap.text();
  assert.match(html, /Checking this Wi-Fi/);
  assert.match(html, /disco-party\.party\.partyparty\.party:8443/);

  const probe = await room.fetch(new Request("https://relay.internal/probe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reachable: false }),
  }));
  assert.equal(probe.status, 202);
  assert.deepEqual(JSON.parse(sent.shift()), {
    type: "probe",
    reachable: false,
    networkKey: "network-1",
  });

  await room.webSocketMessage(origin, JSON.stringify({
    type: "state",
    mode: "relay",
    directUrl: room.roomState.directUrl,
    networkKey: "network-1",
    version: "test",
  }));
  assert.deepEqual(JSON.parse(sent.shift()), {
    type: "state_ack",
    mode: "relay",
    networkKey: "network-1",
  });
  const state = await (await room.fetch(new Request("https://relay.internal/state"))).json();
  assert.equal(state.mode, "relay");
  assert.equal(state.online, true);
});

test("relay room streams one guest request through the Mac socket", async () => {
  const sent = [];
  const origin = {
    readyState: 1,
    bufferedAmount: 0,
    send(message) { sent.push(message); },
    deserializeAttachment() { return { role: "origin" }; },
  };
  let ready = Promise.resolve();
  const stored = new Map();
  const ctx = {
    storage: {
      get: async (key) => stored.get(key),
      put: async (key, value) => stored.set(key, value),
    },
    blockConcurrencyWhile(fn) { ready = Promise.resolve(fn()); },
    getWebSockets(tag) { return tag === "origin" ? [origin] : []; },
  };
  const room = new RelayRoom(ctx, {});
  await ready;
  room.roomState.mode = "relay";

  const responsePromise = room.fetch(new Request("https://relay.internal/room/api/status", {
    headers: {
      "accept-encoding": "gzip",
      "x-pp-public-host": "r-test.partyparty.party",
      "x-pp-client-ip": "203.0.113.44",
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const request = JSON.parse(sent.shift());
  assert.equal(request.type, "request");
  assert.equal(request.path, "/api/status");
  assert.equal(request.clientIp, "203.0.113.44");
  assert.equal(request.headers["accept-encoding"], undefined);

  await room.webSocketMessage(origin, JSON.stringify({
    type: "response",
    id: request.id,
    status: 200,
    headers: { "Content-Type": ["application/octet-stream"] },
  }));
  const idBytes = new TextEncoder().encode(request.id);
  const bodyBytes = new Uint8Array(512 * 1024).fill(7);
  const frame = new Uint8Array(36 + bodyBytes.byteLength);
  frame.set(idBytes);
  frame.set(bodyBytes, 36);
  await room.webSocketMessage(origin, frame.buffer);
  assert.deepEqual(JSON.parse(sent.shift()), {
    type: "response_ack",
    id: request.id,
    bytes: 512 * 1024,
  });
  await room.webSocketMessage(origin, JSON.stringify({ type: "response_end", id: request.id }));

  const response = await responsePromise;
  assert.equal(response.status, 200);
  const responseBytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(responseBytes.byteLength, bodyBytes.byteLength);
  assert.equal(responseBytes[0], 7);
  assert.equal(responseBytes[responseBytes.length - 1], 7);
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
