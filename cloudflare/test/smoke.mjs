import assert from "node:assert/strict";
import worker, {
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

test("landing, legal pages, version, and the update feed - but no public download", async () => {
  const env = baseEnv();
  await env.DL.put("standalone/PartyParty-Beta.zip", new Uint8Array([80, 75, 3, 4]));
  await env.DL.put("standalone/PartyParty-124.14-216.zip", new Uint8Array([80, 75, 3, 4]));
  await env.DL.put("standalone/appcast.xml", `<rss><channel><item>
    <sparkle:shortVersionString>125.90</sparkle:shortVersionString>
    <sparkle:version>990</sparkle:version>
    <pubDate>Wed, 29 Jul 2026 12:00:00 +0000</pubDate>
  </item></channel></rss>`);
  assert.equal(await (await worker.fetch(new Request("https://partyparty.party/"), env)).text(), "landing");
  for (const path of ["/privacy", "/support"]) {
    const response = await worker.fetch(new Request(`https://partyparty.party${path}`), env);
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /PartyParty/);
  }
  const canary = await (await worker.fetch(new Request("https://partyparty.party/api/relay-canary"), env)).json();
  assert.equal(canary.healthy, null); // no check yet is reported honestly, never invented
  await env.DL.put("canary/relay.json", JSON.stringify({ healthy: false, sickSince: 123 }));
  const sick = await (await worker.fetch(new Request("https://partyparty.party/api/relay-canary"), env)).json();
  assert.equal(sick.healthy, false);
  assert.equal(sick.sickSince, 123);
  const version = await (await worker.fetch(new Request("https://partyparty.party/api/version"), env)).json();
  assert.equal(version.version, "125.90"); // derived from the appcast, never a constant
  assert.equal(version.date, "2026-07-29");
  assert.equal("standaloneBuild" in version, false);
  assert.equal("standaloneDownload" in version, false, "there is no public download to advertise");
  // The advertised download is gone: the app goes out through TestFlight by
  // invitation. The appcast stays, so a Mac already carrying a standalone
  // build keeps updating instead of being stranded silently.
  const beta = await worker.fetch(new Request("https://partyparty.party/PartyParty-Beta.zip"), env);
  assert.equal(beta.status, 404, "the public download must not be served");
  const appcast = await worker.fetch(new Request("https://partyparty.party/appcast.xml"), env);
  assert.equal(appcast.status, 200, "existing installs still need their update feed");
  const immutable = await worker.fetch(new Request("https://partyparty.party/downloads/PartyParty-124.14-216.zip"), env);
  assert.equal(immutable.status, 200);
  assert.equal(immutable.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(immutable.headers.get("content-disposition"), 'attachment; filename="PartyParty-124.14-216.zip"');
  // A release download resolves from the bucket by name, so there is no map to
  // forget: absent object is a plain 404, and nothing outside the strict
  // release shape ever reaches R2.
  assert.equal((await worker.fetch(new Request("https://partyparty.party/downloads/PartyParty-9.9-999.zip"), env)).status, 404);
  assert.equal((await worker.fetch(new Request("https://partyparty.party/downloads/PartyParty-..%2fsecret.zip"), env)).status, 404);
  assert.equal((await worker.fetch(new Request("https://partyparty.party/downloads/notparty-1.0-1.zip"), env)).status, 404);
  for (const path of ["/private-beta/PartyParty-123.88.zip", "/PartyParty.pkg", "/PartyParty.zip", "/content/manifest.json", "/content/state.json"]) {
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
  assert.ok(html.includes("[3000,5000]"), "a transient first LAN probe must not force relay mode");
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

test("a party link outlives the Mac that minted it", async () => {
  const env = baseEnv();
  const token = "c".repeat(32);
  const party = "2026-08-06-2130-ab12";
  const host = "https://host.party.partyparty.party:8443/";
  const second = "https://second.party.partyparty.party:8443/";
  await env.DL.put("broker/relay/" + token, "install-host");
  await env.DL.put("broker/install-host.json", JSON.stringify({
    secret: "s", hostLabel: "host", relayToken: token, directUrl: host, partyId: party,
  }));

  // Both Macs playing: the scanned Mac is tried first, the other is the backup.
  await env.DL.put(`broker/party/${party}/install-host`, JSON.stringify({ directUrl: host, at: Date.now() }));
  await env.DL.put(`broker/party/${party}/install-second`, JSON.stringify({ directUrl: second, at: Date.now() - 5000 }));
  let html = await (await worker.fetch(new Request("https://r-" + token + ".partyparty.party/"), env)).text();
  assert.match(html, /const candidates=\["https:\/\/host[^"]*","https:\/\/second[^"]*"\]/,
    "both live Macs must be offered, the scanned one first");

  // The host packs up and stops registering. The link must still land a guest
  // on the Mac that is still playing rather than on nobody.
  await env.DL.put(`broker/party/${party}/install-host`, JSON.stringify({ directUrl: host, at: Date.now() - 120000 }));
  html = await (await worker.fetch(new Request("https://r-" + token + ".partyparty.party/"), env)).text();
  assert.match(html, /const candidates=\["https:\/\/second[^"]*"\]/,
    "a departed host must not be offered while another Mac is playing");

  // Nobody left: fall back to the link's own Mac rather than an empty list, so
  // the page still probes and can recover when that Mac comes back.
  await env.DL.put(`broker/party/${party}/install-second`, JSON.stringify({ directUrl: second, at: Date.now() - 120000 }));
  html = await (await worker.fetch(new Request("https://r-" + token + ".partyparty.party/"), env)).text();
  assert.match(html, /const candidates=\["https:\/\/host[^"]*"\]/);
});

test("registering records party membership, and only a well-formed party id", async () => {
  const env = baseEnv();
  const register = (partyId) => worker.fetch(new Request("https://partyparty.party/api/broker/relay/register", {
    method: "POST",
    body: JSON.stringify({
      id: "aaaaaaaaaaaa", secret: "sec", lanIp: "192.168.1.40",
      directUrl: "https://host.party.partyparty.party:8443/", partyId,
    }),
  }), env);
  await env.DL.put("broker/aaaaaaaaaaaa.json", JSON.stringify({ secret: "sec", hostLabel: "host" }));

  assert.equal((await register("2026-08-06-2130-ab12")).status, 200);
  const member = await env.DL.get("broker/party/2026-08-06-2130-ab12/aaaaaaaaaaaa");
  assert.ok(member, "a live Mac must be findable by its party");
  assert.equal(JSON.parse(await member.text()).directUrl, "https://host.party.partyparty.party:8443/");

  assert.equal((await register("../../etc/passwd")).status, 200);
  const junk = await env.DL.list({ prefix: "broker/party/" });
  assert.equal(junk.objects.length, 1, "a malformed party id must never create a key");
});

test("an address for a later invite is kept once, and read back only by an admin", async () => {
  const env = baseEnv();
  env.ADMIN_KEY = "admin-key";
  const ask = (email) => worker.fetch(new Request("https://partyparty.party/api/waitlist", {
    method: "POST", body: JSON.stringify({ email }),
  }), env);

  assert.equal((await ask("Someone@Example.com")).status, 200);
  assert.equal((await ask("someone@example.com")).status, 200, "asking twice is one person");
  assert.equal((await ask("not-an-address")).status, 400);

  const listed = await env.DL.list({ prefix: "waitlist/" });
  assert.equal(listed.objects.length, 1);

  const refused = await worker.fetch(new Request("https://partyparty.party/api/waitlist/list", {
    method: "POST", body: JSON.stringify({ admin: "wrong" }),
  }), env);
  assert.equal(refused.status, 403, "the list of who wants in is not public");

  const dump = await (await worker.fetch(new Request("https://partyparty.party/api/waitlist/list", {
    method: "POST", body: JSON.stringify({ admin: "admin-key" }),
  }), env)).json();
  assert.equal(dump.count, 1);
  assert.equal(dump.people[0].email, "someone@example.com", "stored lowercased");
});

console.log(`PASS ${tests.length} worker smoke tests`);
