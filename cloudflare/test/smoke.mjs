import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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

test("retired public party, profile, discovery, sign-up, and media routes stay gone", async () => {
  const env = baseEnv();
  env.ADMIN_KEY = "admin-key";
  for (const path of ["/live", "/home", "/demo", "/e/test", "/@dj", "/faq", "/api/discover", "/api/events", "/event/test/live/live.m3u8", "/api/waitlist", "/api/waitlist/list"]) {
    const response = await worker.fetch(new Request(`https://partyparty.party${path}`), env);
    assert.equal(response.status, 404, path);
  }
  // The site collects no addresses any more - the way in is the TestFlight
  // link, so there is nothing to post to and nothing to read back. POSTing is
  // the shape the old form used, and the one worth pinning.
  for (const path of ["/api/waitlist", "/api/waitlist/list"]) {
    const response = await worker.fetch(new Request(`https://partyparty.party${path}`, {
      method: "POST", body: JSON.stringify({ email: "someone@example.com", admin: "admin-key" }),
    }), env);
    assert.equal(response.status, 404, "POST " + path);
  }
  assert.equal((await env.DL.list({ prefix: "waitlist/" })).objects.length, 0);
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
  // The guest-visible host is the pretty join name now, two party words minted
  // once per install. r-<token> still resolves, for QRs already printed, but it
  // is not what anybody is handed.
  assert.match(relayBody.joinUrl, /^https:\/\/[a-z]+-[a-z]+(-\d{1,2})?\.partyparty\.party\/$/);
  assert.match(relayBody.room, /^[a-f0-9]{32}$/);
  assert.match(relayBody.relayUrl, /^https:\/\/[a-f0-9]{32}\.relay\.partyparty\.party$/);
  assert.match(relayBody.publishToken, /^[a-f0-9]{48}$/);
  assert.match(relayBody.networkKey, /^[a-f0-9]{64}$/);
  const relayToken = relayBody.room;
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

  // The join host serves the bootstrap page. It used to be a Durable Object
  // proxying media and websockets, and the assertions below used to check that
  // proxy's JSON. Guests fetch audio straight from the relay origin now, so
  // there is no proxy left to test and this checks the page that replaced it.
  const publicRoom = await worker.fetch(new Request(relayBody.joinUrl), env, { waitUntil() {} });
  assert.equal(publicRoom.status, 200);
  assert.match(publicRoom.headers.get("content-type"), /text\/html/);
  const bootstrap = await publicRoom.text();
  assert.ok(bootstrap.includes(relayBody.relayUrl),
    "the page must know where to send a guest this Wi-Fi isolates");

  // The raw r-<token> host keeps working, for codes already printed.
  const legacy = await worker.fetch(
    new Request(`https://r-${relayToken}.partyparty.party/`), env, { waitUntil() {} });
  assert.equal(legacy.status, 200);
  assert.match(legacy.headers.get("content-type"), /text\/html/);

  // A name nobody minted is not a room.
  const unknown = await worker.fetch(
    new Request(`https://r-${"b".repeat(32)}.partyparty.party/`), env, { waitUntil() {} });
  assert.equal(unknown.status, 404);
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
  // A first failed probe must not condemn a guest to relay mode: DNS can still
  // be converging, TLS starting, Wi-Fi mid-transition. The page retries on a
  // widening ladder before it gives up on the LAN. Asserted as "more than one
  // attempt, and they grow", not as exact numbers, because this test pinned
  // "[3000,5000]" and then never ran again while the ladder became
  // [2500,4000,6000].
  const ladder = html.match(/for\s*\(\s*const\s+timeout\s+of\s*\[([\d,\s]+)\]/);
  assert.ok(ladder, "the bootstrap must still retry the LAN before falling back");
  const waits = ladder[1].split(",").map((n) => Number(n.trim()));
  assert.ok(waits.length >= 2, `a transient first LAN probe must not force relay mode (got ${waits})`);
  assert.deepEqual(waits, [...waits].sort((a, b) => a - b), "each retry should wait longer");
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

test("a forgotten install is told to register again, a wrong secret is not", async () => {
  const env = baseEnv();
  const call = (path, body) => worker.fetch(new Request("https://partyparty.party" + path, {
    method: "POST", body: JSON.stringify(body),
  }), env);

  // Nothing on this side has ever heard of this id. Saying so is what lets a
  // Mac register again instead of presenting a dead credential forever - it
  // only ever registers when its OWN install.json is missing, so an opaque
  // refusal here is a Mac with no DNS, no cert and no relay, permanently.
  for (const path of ["/api/broker/a", "/api/broker/relay/register", "/api/broker/wildcard-cert"]) {
    const r = await call(path, { id: "aaaaaaaaaaaa", secret: "whatever", ip: "192.168.1.40" });
    assert.equal(r.status, 403, path);
    const d = await r.json();
    assert.equal(d.reregister, true, path + " must invite re-registration");
    assert.match(d.error, /unknown install/, path);
  }

  // Known id, wrong secret: that is an authentication failure and must NOT
  // invite a rename. Answering both the same way is how this got missed.
  await env.DL.put("broker/aaaaaaaaaaaa.json", JSON.stringify({ secret: "right", hostLabel: "host" }));
  for (const path of ["/api/broker/a", "/api/broker/relay/register", "/api/broker/wildcard-cert"]) {
    const r = await call(path, { id: "aaaaaaaaaaaa", secret: "wrong", ip: "192.168.1.40" });
    assert.equal(r.status, 403, path);
    const d = await r.json();
    assert.ok(!d.reregister, path + " must not invite re-registration on a bad secret");
  }
});

test("the web ships no broadcaster: it may listen, never transmit", async () => {
  // The platform boundary, asserted rather than assumed. The web is the
  // personal, discovery and listening client; capturing a Mac's audio and
  // pushing it is the Mac app's job and must not leak into anything served
  // from the site.
  const root = new URL("../", import.meta.url);
  // One worker, since the account backend in app/ was deleted on 2026-08-14.
  const shipped = [
    "worker.js",
    "../site/index.html",
  ];
  // Words that only ever belong to the transmitting side.
  const broadcaster = [
    "ppcapture", "ffmpeg", "mediamtx", "CoreAudio",
    "getDisplayMedia", "AudioHardwareCreateProcessTap",
  ];
  for (const file of shipped) {
    const text = readFileSync(new URL(file, root), "utf8");
    for (const word of broadcaster) {
      assert.ok(!text.includes(word),
        `${file} ships "${word}" - the web must not carry the broadcaster`);
    }
  }

  // And the console, which IS the broadcaster's UI, is not a web asset. It is
  // served by the Mac binary to its own loopback and nowhere else.
  const site = readdirSync(new URL("../site/", new URL("../", import.meta.url)));
  assert.ok(!site.includes("dj.html"), "the DJ console is not served by the web");
});

test("Apple's domain proof is served from the bucket, not from a deploy", async () => {
  const env = baseEnv();
  const path = "https://partyparty.party/.well-known/apple-developer-domain-association.txt";
  assert.equal((await worker.fetch(new Request(path), env)).status, 404,
    "absent until Apple issues one - never a fabricated body");

  await env.DL.put("apple/domain-association.txt", "apple-proof-contents");
  const served = await worker.fetch(new Request(path), env);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await served.text(), "apple-proof-contents");
});

// Actually run them.
//
// This line used to read `console.log(`PASS ${tests.length} ...`)` and nothing
// else: every test was registered into the array above and not one was ever
// called. The suite printed "PASS 14 worker smoke tests" on any worker.js at
// all, including one with the route a test asserts on deleted. It was a
// counter wearing the word PASS, and it was believed for months.
let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(`     ${(error && error.message || error).toString().split("\n").join("\n     ")}`);
  }
}
if (failed) {
  console.error(`\nFAIL ${failed} of ${tests.length} worker smoke tests`);
  process.exit(1);
}
console.log(`PASS ${tests.length} worker smoke tests`);
