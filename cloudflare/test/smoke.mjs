import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";
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
  REGISTRATION_RATE_LIMITER: { limit: async () => ({ success: true }) },
});

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("bounded JSON parsing remains strict", async () => {
  assert.deepEqual(await readJson(new Request("https://x/", { method: "POST", body: '{"ok":true}' }), 32), { ok: true });
  assert.equal(await readJson(new Request("https://x/", { method: "POST", body: '{"too":"large"}' }), 2), null);
  assert.equal(await readJson(new Request("https://x/", { method: "POST", body: "{" }), 32), null);
});

test("broker JSON envelopes are rejected before broker work", async () => {
  const env = baseEnv();
  const registerURL = "https://partyparty.party/api/broker/register";

  let response = await worker.fetch(new Request(registerURL, {
    method: "POST",
    body: "{}",
  }), env);
  assert.equal(response.status, 415);

  response = await worker.fetch(new Request(registerURL), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");

  response = await worker.fetch(new Request("https://partyparty.party/api/broker/ping", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  }), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");

  response = await worker.fetch(new Request("https://partyparty.party/api/broker/a", {
    method: "POST",
    headers: { "content-type": "Application/JSON; charset=UTF-8" },
    body: "{}",
  }), env);
  assert.equal(response.status, 400, "JSON media types are matched case-insensitively and may carry parameters");

  response = await worker.fetch(new Request(registerURL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(17000) }),
  }), env);
  assert.equal(response.status, 413, "a body without Content-Length is still bounded while streaming");

  response = await worker.fetch(new Request(registerURL, {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "16385" },
    body: "{}",
  }), env);
  assert.equal(response.status, 413, "an oversized declared body is rejected without reading it");

  assert.equal((await env.DL.list({ prefix: "broker/" })).objects.length, 0,
    "rejected envelopes must not create broker state");
});

test("registration stops before storage when the network rate limit is exhausted", async () => {
  const env = baseEnv();
  env.REGISTRATION_RATE_LIMITER = { limit: async () => ({ success: false }) };
  const response = await worker.fetch(new Request("https://partyparty.party/api/broker/register", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.8" },
    body: "{}",
  }), env);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.equal((await env.DL.list({ prefix: "broker/" })).objects.length, 0);
});

test("read-only public routes reject mutating methods before storage", async () => {
  const env = baseEnv();
  for (const path of [
    "/", "/privacy", "/support", "/api/version", "/api/relay-canary",
    "/.well-known/apple-developer-domain-association.txt", "/appcast.xml",
    "/go/testflight/test", "/go/github/test",
  ]) {
    const response = await worker.fetch(new Request(`https://partyparty.party${path}`, {
      method: "POST",
      body: "ignored",
    }), env);
    assert.equal(response.status, 405, path);
    assert.equal(response.headers.get("allow"), "GET, HEAD", path);
  }

  const ping = await worker.fetch(new Request("https://partyparty.party/api/broker/ping", {
    method: "HEAD",
  }), env);
  assert.equal(ping.status, 200);
  assert.equal(await ping.text(), "");
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
  const landing = await worker.fetch(new Request("https://partyparty.party/"), env);
  assert.equal(await landing.text(), "landing");
  assert.equal(landing.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
  assert.equal(landing.headers.get("x-content-type-options"), "nosniff");
  assert.equal(landing.headers.get("x-frame-options"), "DENY");
  assert.equal(landing.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(landing.headers.get("permissions-policy"), /microphone=\(\)/);
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

test("www redirects to the canonical product domain", async () => {
  const response = await worker.fetch(new Request("https://www.partyparty.party/support?from=test"), baseEnv());
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://partyparty.party/support?from=test");
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

  const injectedDirectURL = "https://host.party.partyparty.party:8443/</script><script>globalThis.PWNED=1</script>";
  const invalidDirectURL = await worker.fetch(new Request("https://partyparty.party/api/broker/relay/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: body.id, secret: body.secret, lanIp: "192.168.20.14",
      directUrl: injectedDirectURL,
    }),
  }), env);
  assert.equal(invalidDirectURL.status, 400);
  const installAfterRejection = await env.DL.get(`broker/${body.id}.json`);
  assert.notEqual(JSON.parse(await installAfterRejection.text()).directUrl, injectedDirectURL,
    "invalid direct URLs must never become stored bootstrap data");

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
  const ladder = html.match(/const\s+timeouts\s*=\s*\[([\d,\s]+)\]/);
  assert.ok(ladder, "the bootstrap must still retry the LAN before falling back");
  const waits = ladder[1].split(",").map((n) => Number(n.trim()));
  assert.ok(waits.length >= 2, `a transient first LAN probe must not force relay mode (got ${waits})`);
  assert.deepEqual(waits, [...waits].sort((a, b) => a - b), "each retry should wait longer");
  assert.ok(!html.includes("__pp/state"), "the state endpoint died with the Durable Object");
});

test("the relay bootstrap probes party Macs concurrently and aborts losers", async () => {
  const env = baseEnv();
  const token = "e".repeat(32);
  const party = "2026-08-30-2213-ab12";
  const slow = "https://slow.party.partyparty.party:8443/";
  const fast = "https://fast.party.partyparty.party:8443/";
  await env.DL.put(`broker/relay/${token}`, "install-slow");
  await env.DL.put("broker/install-slow.json", JSON.stringify({
    id: "install-slow", directUrl: slow, partyId: party,
  }));
  await env.DL.put(`broker/party/${party}/install-slow`, JSON.stringify({ directUrl: slow, at: Date.now() }));
  await env.DL.put(`broker/party/${party}/install-fast`, JSON.stringify({ directUrl: fast, at: Date.now() - 1 }));
  const html = await (await worker.fetch(
    new Request(`https://r-${token}.partyparty.party/`), env)).text();
  const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] || "";
  const prefix = script.slice(0, script.indexOf("async function report"));
  assert.ok(prefix.includes("async function probeRound"), "bootstrap probe implementation was not found");

  const calls = [];
  let slowAborts = 0;
  const context = {
    AbortController,
    Date,
    Promise,
    URL,
    clearTimeout,
    document: { getElementById: () => ({}) },
    setTimeout,
    fetch: async (target, options) => {
      calls.push(target.hostname);
      if (target.hostname === "fast.party.partyparty.party") {
        return { ok: true, json: async () => ({ t: Date.now() }) };
      }
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          slowAborts++;
          reject(new Error("aborted"));
        }, { once: true });
      });
    },
  };
  vm.runInNewContext(`${prefix}\nglobalThis.testProbe = probe;`, context);
  const answered = await Promise.race([
    context.testProbe(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("party probes ran serially")), 250)),
  ]);
  assert.equal(answered, fast);
  assert.deepEqual(calls.sort(), ["fast.party.partyparty.party", "slow.party.partyparty.party"]);
  assert.equal(slowAborts, 1, "the successful probe must abort the losing request");
});

test("legacy relay records cannot inject executable bootstrap markup", async () => {
  const env = baseEnv();
  const token = "d".repeat(32);
  const payload = "https://host.party.partyparty.party:8443/</script><script>globalThis.PWNED=1</script>";
  await env.DL.put(`broker/relay/${token}`, "install-legacy");
  await env.DL.put("broker/install-legacy.json", JSON.stringify({
    id: "install-legacy",
    directUrl: payload,
  }));

  const page = await worker.fetch(
    new Request(`https://r-${token}.partyparty.party/`), env);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(!html.includes("globalThis.PWNED"), "stored data must not become executable markup");
  assert.ok(!html.includes("</script><script>"), "stored data must not close the bootstrap script");
  assert.match(html, /const candidates=\[\]/,
    "invalid legacy direct URLs must be discarded rather than probed");
});

test("relay probe JSON is typed, bounded, and side-effect free when invalid", async () => {
  const env = baseEnv();
  const token = "f".repeat(32);
  const path = `https://r-${token}.partyparty.party/__pp/probe`;
  await env.DL.put(`broker/relay/${token}`, "install-1");

  let response = await worker.fetch(new Request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: JSON.stringify({ reachable: false }),
  }), env);
  assert.equal(response.status, 415);

  response = await worker.fetch(new Request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  }), env);
  assert.equal(response.status, 400);

  response = await worker.fetch(new Request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reachable: "false" }),
  }), env);
  assert.equal(response.status, 400);

  response = await worker.fetch(new Request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reachable: false, padding: "x".repeat(200) }),
  }), env);
  assert.equal(response.status, 413);

  response = await worker.fetch(new Request(path, { method: "OPTIONS" }), env);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-methods"), "POST, OPTIONS");

  response = await worker.fetch(new Request(path), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST, OPTIONS");

  assert.equal(await env.DL.head(`broker/relay-probe/${token}`), null,
    "invalid probe requests must not overwrite the Mac's next verdict");

  response = await worker.fetch(new Request(path, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ reachable: true }),
  }), env);
  assert.equal(response.status, 200, "existing listener pages use a text/plain JSON envelope");
  const compatible = await env.DL.get(`broker/relay-probe/${token}`);
  assert.equal(JSON.parse(await compatible.text()).reachable, true);
});

test("relay route dispatch avoids room and origin work for rejected requests", async () => {
  const token = "9".repeat(32);
  let heads = 0;
  let gets = 0;
  const env = {
    ...baseEnv(),
    DL: {
      async head() { heads++; return { size: 1 }; },
      async get() { gets++; throw new Error("unexpected room read"); },
    },
  };

  let response = await worker.fetch(new Request(
    `https://r-${token}.partyparty.party/not-a-bootstrap-route`), env);
  assert.equal(response.status, 404);

  response = await worker.fetch(new Request(`https://r-${token}.partyparty.party/`, {
    method: "POST",
    body: "ignored",
  }), env);
  assert.equal(response.status, 405);

  response = await worker.fetch(new Request(
    `https://r-${token}.partyparty.party/__pp/relay-live`, { method: "POST" }), env);
  assert.equal(response.status, 405);
  assert.equal(heads, 0, "rejected paths and methods must not look up a room");
  assert.equal(gets, 0, "rejected paths and methods must not load room records");

  response = await worker.fetch(new Request(
    `https://r-${token}.partyparty.party/`, { method: "HEAD" }), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.equal(heads, 1, "HEAD verifies that the room exists");
  assert.equal(gets, 0, "HEAD must not build the full room bootstrap");
});

test("a guest can report reachability exactly once per join", async () => {
  const env = baseEnv();
  const token = "b".repeat(32);
  await env.DL.put("broker/relay/" + token, "install-1");

  const reported = await worker.fetch(new Request(
    "https://r-" + token + ".partyparty.party/__pp/probe",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reachable: false }),
    }), env);
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
    headers: { "content-type": "application/json" },
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
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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

test("the product hero links to the public source repository", async () => {
  const html = readFileSync(new URL("../site/index.html", new URL("../", import.meta.url)), "utf8");
  assert.match(html, /href="\/go\/github\/hero"/);
  assert.match(html, /aria-label="Star PartyParty on GitHub, 0 stars"/);
  assert.match(html, /stargazers_count/);
});

test("launch CTAs use measurable first-party redirects", async () => {
  const env = baseEnv();
  const cases = [
    ["/go/testflight/hero", "https://testflight.apple.com/join/HPRAgyJk"],
    ["/go/github/hero", "https://github.com/tetrisgm/partyparty"],
  ];
  for (const [path, destination] of cases) {
    const response = await worker.fetch(new Request(`https://partyparty.party${path}`), env);
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get("location"), destination, path);
    assert.equal(response.headers.get("cache-control"), "no-store", path);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer", path);
  }
});

test("the product site uses the dancer favicon", async () => {
  const root = new URL("../", import.meta.url);
  const html = readFileSync(new URL("../site/index.html", root), "utf8");
  const icon = readFileSync(new URL("../site/favicon.svg", root), "utf8");
  assert.match(html, /href="\/favicon\.svg\?v=2" type="image\/svg\+xml"/);
  assert.match(icon, /🕺/u);
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
