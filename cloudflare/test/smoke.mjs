import assert from "node:assert/strict";
import worker, { cookieHeader, normalizeHandle, parseCookies, readJson } from "../worker.js";

globalThis.caches ??= {
  default: {
    match: async () => null,
    put: async () => {},
  },
};

const KNOWN_SLUG = "known-set";
const SET_ID = "abcdef123456";

const eventActivity = (row) =>
  Number(row.last_activity_ms ?? row.published_ms ?? row.scheduled_at_ms ?? row.updated_ms ?? row.created_ms ?? 0) || 0;

const bySlug = (a, b) => String(a.slug || "").localeCompare(String(b.slug || ""));

class FakeD1 {
  constructor({
    knownSlug = KNOWN_SLUG,
    homeEvents = [],
    featuredProfiles = [],
    replayEvents = [],
    profiles = [],
    profileUpcomingEvents = [],
    profileRecentEvents = [],
    profilePosts = [],
    wallPosts = [],
    wallMedia = [],
    wallComments = [],
    rsvpEnabled = 0,
    rsvps = [],
    events = [],
    deviceInstalls = [],
  } = {}) {
    this.knownSlug = knownSlug;
    this.homeEvents = homeEvents;
    this.featuredProfiles = featuredProfiles;
    this.replayEvents = replayEvents;
    this.profiles = profiles;
    this.profileUpcomingEvents = profileUpcomingEvents;
    this.profileRecentEvents = profileRecentEvents;
    this.profilePosts = profilePosts;
    this.wallPosts = wallPosts;
    this.wallMedia = wallMedia;
    this.wallComments = wallComments;
    this.importedPosts = new Map(wallPosts.map((row) => [row.id, { ...row }]));
    this.importedComments = new Map(wallComments.map((row) => [row.id, { ...row }]));
    this.importedPostMedia = new Map(wallMedia.map((row) => [row.id, { ...row }]));
    this.rsvpEnabled = rsvpEnabled;
    this.events = new Map();
    this.events.set(knownSlug, {
      slug: knownSlug,
      install_id: "abc123abc123",
      title: "Smoke Test Rooftop",
      host: "Test DJ",
      starts: "Tonight",
      where_txt: "Test Venue",
      tagline: "Harness replay",
      about: "A minimal event row for the smoke harness.",
      cover_key: "event/known-set/cover.jpg",
      status: "replay",
      rsvp_enabled: rsvpEnabled,
    });
    for (const row of events) this.events.set(row.slug, { ...row });
    this.deviceInstalls = new Map(deviceInstalls.map((row) => [row.install_id, { ...row }]));
    this.profileActivityBumps = [];
    this.rsvps = new Map();
    for (const row of rsvps) {
      const key = row.user_id ? `${row.slug}:user:${row.user_id}` : `${row.slug}:anon:${row.anon_key_hash}`;
      this.rsvps.set(key, { ...row });
    }
  }

  prepare(sql) {
    return new FakeD1Statement(this, sql);
  }
}

class FakeD1Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.args = [];
  }

  bind(...args) {
    this.args = args;
    return this;
  }

  async first() {
    const sql = this.sql.replace(/\s+/g, " ");
    if (sql.includes("FROM post_media pm JOIN posts p")) {
      const [mediaId, slug] = this.args;
      const media = this.db.importedPostMedia.get(mediaId);
      if (!media || media.slug !== slug) return null;
      const post = this.db.importedPosts.get(media.post_id);
      if (!post || post.approved !== 1 || post.deleted_ms != null) return null;
      return {
        media_key: media.media_key,
        mime_type: media.mime_type,
        media_type: media.media_type,
      };
    }
    if (sql.includes("FROM events WHERE slug=?")) {
      const slug = this.args[0];
      const row = this.db.events.get(slug);
      return row ? { ...row } : null;
    }
    if (sql.includes("FROM event_rsvps WHERE slug=? AND user_id=?")) {
      const [slug, userId] = this.args;
      return this.db.rsvps.get(`${slug}:user:${userId}`) || null;
    }
    if (sql.includes("FROM event_rsvps WHERE slug=? AND anon_key_hash=?")) {
      const [slug, anonHash] = this.args;
      return this.db.rsvps.get(`${slug}:anon:${anonHash}`) || null;
    }
    if (sql.includes("FROM event_sets WHERE slug=?")) {
      const slug = this.args[0];
      if (slug !== this.db.knownSlug) return null;
      return {
        id: SET_ID,
        slug,
        duration_ms: 185000,
        size_bytes: 1024,
        recorded_ms: 0,
        published_ms: 1,
        state: "ready",
        audio_key: `event/${slug}/${SET_ID}.m4a`,
        peaks_key: `event/${slug}/${SET_ID}.peaks.json`,
      };
    }
    if (sql.includes("SELECT install_id FROM events WHERE slug=?")) {
      const slug = this.args[0];
      const row = this.db.events.get(slug);
      return row ? { install_id: row.install_id } : null;
    }
    if (sql.includes("FROM device_installs WHERE install_id=?")) {
      return this.db.deviceInstalls.get(this.args[0]) || null;
    }
    if (sql.includes("SELECT id FROM posts WHERE id=? AND slug=?")) {
      const [postId, slug] = this.args;
      const row = this.db.importedPosts.get(postId);
      return row && row.slug === slug ? { id: row.id } : null;
    }
    if (sql.includes("SELECT slug, post_id FROM post_media WHERE id=?")) {
      const row = this.db.importedPostMedia.get(this.args[0]);
      return row ? { slug: row.slug, post_id: row.post_id } : null;
    }
    if (sql.includes("SELECT slug FROM event_sets WHERE id=?")) {
      const setId = this.args[0];
      return setId === SET_ID ? { slug: this.db.knownSlug } : null;
    }
    if (sql.includes("FROM dj_profiles WHERE handle=?")) {
      const handle = this.args[0];
      return this.db.profiles.find((row) => row.handle === handle && row.published === 1) || null;
    }
    return null;
  }

  async all() {
    const sql = this.sql.replace(/\s+/g, " ");
    if (sql.includes("WHERE e.visibility=? AND e.status IN")) {
      return {
        results: [...this.db.homeEvents].sort((a, b) =>
          (a.status === "live" ? 0 : 1) - (b.status === "live" ? 0 : 1) ||
          (Number(a.scheduled_at_ms) || 0) - (Number(b.scheduled_at_ms) || 0) ||
          bySlug(a, b)
        ),
      };
    }
    if (sql.includes("FROM featured_profiles f")) {
      return {
        results: [...this.db.featuredProfiles].sort((a, b) =>
          (Number(a.rank) || 0) - (Number(b.rank) || 0) ||
          (Number(b.last_activity_ms) || 0) - (Number(a.last_activity_ms) || 0) ||
          String(a.display_name || "").localeCompare(String(b.display_name || ""))
        ),
      };
    }
    if (sql.includes("WHERE e.visibility=? AND e.status=?")) {
      return { results: [...this.db.replayEvents].sort((a, b) => eventActivity(b) - eventActivity(a) || bySlug(a, b)) };
    }
    if (sql.includes("WHERE dj_profile_id=? AND visibility=? AND status IN")) {
      return {
        results: [...this.db.profileUpcomingEvents].sort((a, b) =>
          (a.status === "live" ? 0 : 1) - (b.status === "live" ? 0 : 1) ||
          (Number(a.scheduled_at_ms) || 0) - (Number(b.scheduled_at_ms) || 0) ||
          bySlug(a, b)
        ),
      };
    }
    if (sql.includes("WHERE dj_profile_id=? AND visibility=? AND status=?")) {
      return { results: [...this.db.profileRecentEvents].sort((a, b) => eventActivity(b) - eventActivity(a) || bySlug(a, b)) };
    }
    if (sql.includes("FROM posts p JOIN events e")) {
      return { results: this.db.profilePosts };
    }
    if (sql.includes("FROM posts WHERE slug=?")) {
      const slug = this.args[0];
      const limit = Number(this.args[1]) || this.db.wallPosts.length;
      return { results: this.db.wallPosts.filter((row) => row.slug === slug).slice(0, limit) };
    }
    if (sql.includes("FROM post_media WHERE post_id IN")) {
      const ids = new Set(JSON.parse(this.args[0] || "[]"));
      return { results: [...this.db.importedPostMedia.values()].filter((row) => ids.has(row.post_id)) };
    }
    if (sql.includes("FROM post_comments WHERE post_id IN")) {
      const ids = new Set(JSON.parse(this.args[0] || "[]"));
      return { results: this.db.wallComments.filter((row) => ids.has(row.post_id)) };
    }
    if (sql.includes("FROM event_rsvps WHERE slug=? GROUP BY response")) {
      const slug = this.args[0];
      const counts = new Map();
      for (const row of this.db.rsvps.values()) {
        if (row.slug !== slug) continue;
        counts.set(row.response, (counts.get(row.response) || 0) + 1);
      }
      return { results: [...counts.entries()].map(([response, n]) => ({ response, n })) };
    }
    return { results: [] };
  }

  async run() {
    const sql = this.sql.replace(/\s+/g, " ");
    if (sql.includes("UPDATE dj_profiles SET last_activity_ms=? WHERE id=?")) {
      const [lastActivityMs, profileId] = this.args;
      this.db.profileActivityBumps.push({ profileId, lastActivityMs });
      const row = this.db.profiles.find((profile) => profile.id === profileId);
      if (row) row.last_activity_ms = lastActivityMs;
    }
    if (sql.includes("INSERT INTO posts") && sql.includes("source_install_id")) {
      const [
        id, slug, author, emoji, text, approved, tsMs, createdMs, authorCidHash, sourceInstallId,
        dj, activityMs, updatedMs, approvedMs, deletedMs,
      ] = this.args;
      const old = this.db.importedPosts.get(id);
      this.db.importedPosts.set(id, {
        id,
        slug,
        author,
        emoji,
        text,
        media_key: null,
        media_type: null,
        approved,
        ts_ms: tsMs,
        created_ms: old?.created_ms || createdMs,
        author_cid_hash: authorCidHash,
        source: "mac_sync",
        source_install_id: sourceInstallId,
        dj,
        activity_ms: activityMs,
        updated_ms: updatedMs,
        approved_ms: approvedMs,
        deleted_ms: deletedMs,
      });
      return { success: true };
    }
    if (sql.includes("INSERT INTO post_comments")) {
      const [id, slug, postId, author, emoji, text, dj, approved, tsMs, createdMs, updatedMs, deletedMs] = this.args;
      const old = this.db.importedComments.get(id);
      this.db.importedComments.set(id, {
        id,
        slug,
        post_id: postId,
        author,
        emoji,
        text,
        dj,
        approved,
        ts_ms: tsMs,
        created_ms: old?.created_ms || createdMs,
        updated_ms: updatedMs,
        deleted_ms: deletedMs,
      });
      return { success: true };
    }
    if (sql.includes("INSERT INTO post_media")) {
      const [id, slug, postId, mediaKey, mediaType, mimeType, name, sizeBytes, sortOrder, createdMs] = this.args;
      const old = this.db.importedPostMedia.get(id);
      this.db.importedPostMedia.set(id, {
        id,
        slug,
        post_id: postId,
        media_key: mediaKey,
        media_type: mediaType,
        mime_type: mimeType,
        name,
        size_bytes: sizeBytes,
        width: old?.width,
        height: old?.height,
        duration_ms: old?.duration_ms,
        sort_order: sortOrder,
        source_local_id: old?.source_local_id || "",
        created_ms: old?.created_ms || createdMs,
      });
      return { success: true };
    }
    if (sql.includes("UPDATE events SET last_activity_ms=? WHERE slug=? AND install_id=?")) {
      const [lastActivityMs, slug, installId] = this.args;
      const old = this.db.events.get(slug);
      if (old && old.install_id === installId) {
        this.db.events.set(slug, { ...old, last_activity_ms: lastActivityMs });
      }
      return { success: true };
    }
    if (sql.includes("UPDATE events SET updated_ms=?, last_activity_ms=?")) {
      const [updatedMs, lastActivityMs, slug, installId] = this.args;
      const old = this.db.events.get(slug);
      if (old && old.install_id === installId) {
        this.db.events.set(slug, { ...old, updated_ms: updatedMs, last_activity_ms: lastActivityMs });
      }
      return { success: true };
    }
    if (sql.includes("INSERT INTO events") && sql.includes("?1") && sql.includes("last_activity_ms")) {
      const [slug, installId, title, host, starts, whereTxt, tagline, about, now] = this.args;
      const old = this.db.events.get(slug);
      if (!old) {
        this.db.events.set(slug, {
          slug,
          install_id: installId,
          title,
          host,
          starts,
          where_txt: whereTxt,
          tagline,
          about,
          status: "replay",
          created_ms: now,
          updated_ms: now,
          last_activity_ms: now,
        });
      } else if (old.install_id === installId) {
        this.db.events.set(slug, {
          ...old,
          title,
          host,
          starts,
          where_txt: whereTxt,
          tagline,
          about,
          status: "replay",
          updated_ms: now,
          last_activity_ms: now,
        });
      }
      return { success: true };
    }
    if (sql.includes("INSERT INTO events") && sql.includes("last_activity_ms")) {
      const insertCols = (this.sql.match(/INSERT INTO events \(([^)]+)\)/)?.[1] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const insertVals = this.args.slice(0, insertCols.length);
      const row = Object.fromEntries(insertCols.map((col, i) => [col, insertVals[i]]));
      const ownerId = this.args[this.args.length - 1];
      const old = this.db.events.get(row.slug);
      if (!old) {
        this.db.events.set(row.slug, row);
      } else if (old.install_id === ownerId) {
        const setCols = (this.sql.match(/DO UPDATE SET ([\s\S]+?)\s+WHERE events\.install_id=\?/)?.[1] || "")
          .split(",")
          .map((s) => s.trim().split("=")[0].trim())
          .filter(Boolean);
        const updateVals = this.args.slice(insertCols.length, this.args.length - 1);
        const next = { ...old };
        for (let i = 0; i < setCols.length; i++) next[setCols[i]] = updateVals[i];
        this.db.events.set(row.slug, next);
      }
    }
    if (sql.includes("UPDATE events") && sql.includes("SET status=?")) {
      const [status, updatedMs, lastActivityMs, maybeStamp, maybeSlug, maybeInstallId] = this.args;
      const hasLiveStamp = sql.includes("live_started_ms=COALESCE") || sql.includes("live_ended_ms=COALESCE");
      const slug = hasLiveStamp ? maybeSlug : this.args[3];
      const installId = hasLiveStamp ? maybeInstallId : this.args[4];
      const old = this.db.events.get(slug);
      if (old && old.install_id === installId) {
        const next = { ...old, status, updated_ms: updatedMs, last_activity_ms: lastActivityMs };
        if (sql.includes("live_started_ms=COALESCE") && next.live_started_ms == null) next.live_started_ms = maybeStamp;
        if (sql.includes("live_ended_ms=COALESCE") && next.live_ended_ms == null) next.live_ended_ms = maybeStamp;
        this.db.events.set(slug, next);
      }
    }
    if (sql.includes("INSERT INTO event_rsvps")) {
      const isUser = sql.includes("ON CONFLICT(slug,user_id)");
      if (isUser) {
        const [id, slug, userId, name, emoji, response, note, createdMs, updatedMs] = this.args;
        const key = `${slug}:user:${userId}`;
        const old = this.db.rsvps.get(key);
        this.db.rsvps.set(key, {
          id: old?.id || id,
          slug,
          user_id: userId,
          anon_key_hash: null,
          name,
          emoji,
          response,
          note,
          created_ms: old?.created_ms || createdMs,
          updated_ms: updatedMs,
        });
      } else {
        const [id, slug, anonHash, name, emoji, response, note, createdMs, updatedMs] = this.args;
        const key = `${slug}:anon:${anonHash}`;
        const old = this.db.rsvps.get(key);
        this.db.rsvps.set(key, {
          id: old?.id || id,
          slug,
          user_id: null,
          anon_key_hash: anonHash,
          name,
          emoji,
          response,
          note,
          created_ms: old?.created_ms || createdMs,
          updated_ms: updatedMs,
        });
      }
    }
    return { success: true };
  }
}

class FakeR2Object {
  constructor(body, { contentType = "application/octet-stream", etag = '"smoke-etag"' } = {}) {
    this.body = body;
    this.size = typeof body === "string"
      ? new TextEncoder().encode(body).byteLength
      : body instanceof ArrayBuffer
        ? body.byteLength
        : body.byteLength;
    this.httpEtag = etag;
    this.httpMetadata = { contentType };
  }

  writeHttpMetadata(headers) {
    if (this.httpMetadata.contentType) headers.set("content-type", this.httpMetadata.contentType);
  }

  async text() {
    return typeof this.body === "string" ? this.body : new TextDecoder().decode(this.body);
  }

  async json() {
    return JSON.parse(await this.text());
  }

  async arrayBuffer() {
    if (typeof this.body === "string") return new TextEncoder().encode(this.body).buffer;
    if (this.body instanceof ArrayBuffer) return this.body;
    return this.body.buffer.slice(this.body.byteOffset, this.body.byteOffset + this.body.byteLength);
  }
}

class FakeR2 {
  constructor(objects = {}) {
    this.objects = new Map(Object.entries(objects));
  }

  async get(key, opts = {}) {
    const obj = this.objects.get(key);
    if (!obj) return null;
    if (!opts.range) return obj;

    const bytes = new Uint8Array(await obj.arrayBuffer());
    const offset = opts.range.offset || 0;
    const length = opts.range.length ?? bytes.length - offset;
    return new FakeR2Object(bytes.slice(offset, offset + length), {
      contentType: obj.httpMetadata.contentType,
      etag: obj.httpEtag,
    });
  }

  async head(key) {
    const obj = this.objects.get(key);
    if (!obj) return null;
    return { size: obj.size, httpEtag: obj.httpEtag, writeHttpMetadata: obj.writeHttpMetadata.bind(obj) };
  }

  async put(key, body, opts = {}) {
    const contentType = opts.httpMetadata?.contentType || "application/octet-stream";
    const stored = body?.getReader ? new Uint8Array(await new Response(body).arrayBuffer()) : (body || "");
    const obj = new FakeR2Object(stored, { contentType });
    this.objects.set(key, obj);
    return { size: obj.size };
  }

  async delete(key) {
    this.objects.delete(key);
  }

  async list() {
    return { objects: [] };
  }
}

function makeEnv(opts = {}) {
  const r2Objects = {
    [`event/${KNOWN_SLUG}/${SET_ID}.m4a`]: new FakeR2Object("fake-audio", { contentType: "audio/mp4" }),
    [`event/${KNOWN_SLUG}/${SET_ID}.peaks.json`]: new FakeR2Object('{"peaks":[10,50,80]}', { contentType: "application/json" }),
    [`event/${KNOWN_SLUG}/cover.jpg`]: new FakeR2Object("fake-jpeg", { contentType: "image/jpeg" }),
    "broker/abc123abc123.json": new FakeR2Object(JSON.stringify({ secret: "secret-a", slug: "disco12", created: 1 }), { contentType: "application/json" }),
    "broker/def456def456.json": new FakeR2Object(JSON.stringify({ secret: "secret-b", slug: "groove34", created: 1 }), { contentType: "application/json" }),
    ...(opts.r2Objects || {}),
  };
  return {
    DB: opts.DB || new FakeD1(opts.db || {}),
    DL: new FakeR2(r2Objects),
    ASSETS: {
      fetch: async () => new Response(opts.assetBody || "landing", { status: 200 }),
    },
    BROKER_BASE: "party.example.test",
    CF_DNS_TOKEN: "token-test",
    CF_ZONE_ID: "zone-test",
  };
}

async function fetchPath(path, init = {}, envOpts = {}) {
  return worker.fetch(new Request(`https://party.ramine.net${path}`, init), makeEnv(envOpts));
}

const contentLength = (body) => String(new TextEncoder().encode(String(body)).byteLength);

const tests = [
  ["parseCookies decodes cookie header", async () => {
    const req = new Request("https://party.ramine.net/", {
      headers: { cookie: "sid=abc123; theme=dark%20mode; empty=; broken=%E0%A4%A" },
    });
    assert.deepEqual(parseCookies(req), {
      sid: "abc123",
      theme: "dark mode",
      empty: "",
      broken: "%E0%A4%A",
    });
  }],
  ["cookieHeader emits secure defaults", async () => {
    assert.equal(cookieHeader("sid", "a b", { maxAge: 60 }), "sid=a%20b; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Lax");
    assert.equal(cookieHeader("sid", "", { httpOnly: false, secure: false, sameSite: "Strict", path: "/auth" }), "sid=; Path=/auth; SameSite=Strict");
  }],
  ["normalizeHandle gates and clips handles", async () => {
    assert.equal(normalizeHandle(" DJ Ramine!! "), "dj.ramine");
    assert.equal(normalizeHandle("already_good.name"), "already_good.name");
    assert.equal(normalizeHandle("!!!"), "");
    assert.equal(normalizeHandle("aaaaaaaaaa.bbbbbbbbbb.cccccccccc.dddddddddd"), "aaaaaaaaaa.bbbbbbbbbb.cccccccc");
  }],
  ["readJson parses valid small bodies only", async () => {
    const good = new Request("https://party.ramine.net/api", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
      headers: { "content-type": "application/json" },
    });
    assert.deepEqual(await readJson(good), { ok: true });

    const bad = new Request("https://party.ramine.net/api", { method: "POST", body: "{" });
    assert.equal(await readJson(bad), null);

    const tooLarge = new Request("https://party.ramine.net/api", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
      headers: { "content-length": "999" },
    });
    assert.equal(await readJson(tooLarge, 10), null);
  }],
  ["home renders useful empty state", async () => {
    const resp = await fetchPath("/");
    const html = await resp.text();
    assert.equal(resp.status, 200);
    assert.match(html, /silent-disco popups/);
    assert.match(html, /Get the app/);
    assert.match(html, /\/partyparty\.zip/);
    assert.notEqual(html.trim(), "");
  }],
  ["home renders public events and featured DJs", async () => {
    const resp = await fetchPath("/", {}, {
      db: {
        homeEvents: [{
          slug: "saturday-live",
          title: "Saturday Live",
          host: "DJ Now",
          scheduled_at_ms: 1893542400000,
          location_name: "Warehouse",
          status: "live",
          visibility: "public",
          cover_key: "event/saturday-live/cover.jpg",
        }, {
          slug: "friday-rooftop",
          title: "Friday Rooftop",
          host: "Ramine",
          scheduled_at_ms: 1893456000000,
          location_name: "Mission Roof",
          status: "upcoming",
          visibility: "public",
          cover_key: "event/friday-rooftop/cover.jpg",
        }],
        featuredProfiles: [{
          id: "profile1",
          handle: "dj.ramine",
          display_name: "DJ Ramine",
          bio: "House and rooftop sessions.",
          published: 1,
        }],
      },
    });
    const html = await resp.text();
    assert.equal(resp.status, 200);
    assert.ok(html.indexOf("Saturday Live") < html.indexOf("Friday Rooftop"));
    assert.match(html, /<span class="statuspill live"><span class="dot"><\/span>Live<\/span>/);
    assert.match(html, /<span class="statuspill upcoming">Upcoming<\/span>/);
    assert.match(html, /Friday Rooftop/);
    assert.match(html, /href="\/e\/saturday-live"/);
    assert.match(html, /href="\/e\/friday-rooftop"/);
    assert.match(html, /@dj\.ramine/);
    assert.match(html, /href="\/@dj\.ramine"/);
  }],
  ["about delegates to ASSETS", async () => {
    const resp = await fetchPath("/about");
    assert.equal(resp.status, 200);
    assert.equal(await resp.text(), "landing");
  }],
  ["known event renders replay page", async () => {
    const resp = await fetchPath(`/e/${KNOWN_SLUG}`);
    const html = await resp.text();
    assert.equal(resp.status, 200);
    assert.match(html, /Smoke Test Rooftop/);
    assert.match(html, /<audio id="setaudio"/);
  }],
  ["event RSVP POST mints anonymous cookie and counts coming", async () => {
    const db = new FakeD1({ rsvpEnabled: 1 });
    const resp = await worker.fetch(new Request(`https://party.ramine.net/api/e/${KNOWN_SLUG}/rsvp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: "coming", name: "Ava", emoji: "\u2728", note: "See you there" }),
    }), makeEnv({ DB: db }));
    const json = await resp.json();
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("set-cookie") || "", /pp_rsvp=/);
    assert.deepEqual(json, { ok: true, response: "coming", counts: { coming: 1, not: 0 } });
    assert.equal(db.rsvps.size, 1);
  }],
  ["event RSVP POST with same cookie updates same anonymous row", async () => {
    const db = new FakeD1({ rsvpEnabled: 1 });
    const first = await worker.fetch(new Request(`https://party.ramine.net/api/e/${KNOWN_SLUG}/rsvp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: "coming" }),
    }), makeEnv({ DB: db }));
    const cookie = (first.headers.get("set-cookie") || "").split(";")[0];
    const second = await worker.fetch(new Request(`https://party.ramine.net/api/e/${KNOWN_SLUG}/rsvp`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ response: "not", name: "Ava" }),
    }), makeEnv({ DB: db }));
    const json = await second.json();
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("set-cookie"), null);
    assert.deepEqual(json, { ok: true, response: "not", counts: { coming: 0, not: 1 } });
    assert.equal(db.rsvps.size, 1);
  }],
  ["event RSVP GET returns counts and mine", async () => {
    const db = new FakeD1({ rsvpEnabled: 1 });
    const first = await worker.fetch(new Request(`https://party.ramine.net/api/e/${KNOWN_SLUG}/rsvp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: "coming" }),
    }), makeEnv({ DB: db }));
    const cookie = (first.headers.get("set-cookie") || "").split(";")[0];
    const resp = await worker.fetch(new Request(`https://party.ramine.net/api/e/${KNOWN_SLUG}/rsvp`, {
      headers: { cookie },
    }), makeEnv({ DB: db }));
    const json = await resp.json();
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get("set-cookie"), null);
    assert.deepEqual(json, { counts: { coming: 1, not: 0 }, mine: "coming" });
  }],
  ["event RSVP POST rejects disabled event", async () => {
    const resp = await fetchPath(`/api/e/${KNOWN_SLUG}/rsvp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: "coming" }),
    }, { DB: new FakeD1({ rsvpEnabled: 0 }) });
    assert.equal(resp.status, 403);
  }],
  ["event page renders RSVP only when enabled", async () => {
    const enabled = await fetchPath(`/e/${KNOWN_SLUG}`, {}, { DB: new FakeD1({ rsvpEnabled: 1 }) });
    const enabledHtml = await enabled.text();
    assert.equal(enabled.status, 200);
    assert.match(enabledHtml, /data-rsvp/);
    assert.match(enabledHtml, /I'm coming/);
    assert.match(enabledHtml, /Can't make it/);

    const disabled = await fetchPath(`/e/${KNOWN_SLUG}`, {}, { DB: new FakeD1({ rsvpEnabled: 0 }) });
    const disabledHtml = await disabled.text();
    assert.equal(disabled.status, 200);
    assert.doesNotMatch(disabledHtml, /data-rsvp/);
    assert.doesNotMatch(disabledHtml, /I'm coming/);
  }],
  ["event wall renders approved posts and media without losing replay", async () => {
    const resp = await fetchPath(`/e/${KNOWN_SLUG}`, {}, {
      db: {
        wallPosts: [{
          id: "post-img",
          slug: KNOWN_SLUG,
          author: "Ava",
          emoji: "\u2728",
          text: "The lights hit right at midnight.",
          approved: 1,
          deleted_ms: null,
          activity_ms: 1893456000000,
          created_ms: 1893456000000,
        }, {
          id: "post-text",
          slug: KNOWN_SLUG,
          author: "Ben",
          emoji: "",
          text: "Bassline stayed locked.",
          approved: 1,
          deleted_ms: null,
          activity_ms: 1893455900000,
          created_ms: 1893455900000,
        }],
        wallMedia: [{
          id: "media-img",
          slug: KNOWN_SLUG,
          post_id: "post-img",
          media_key: `event/${KNOWN_SLUG}/media-img`,
          media_type: "image",
          mime_type: "image/jpeg",
          name: "dancefloor.jpg",
          sort_order: 0,
        }],
      },
    });
    const html = await resp.text();
    assert.equal(resp.status, 200);
    assert.match(html, /<audio id="setaudio"/);
    assert.match(html, /<div class="wave" id="wave"/);
    assert.match(html, /The lights hit right at midnight\./);
    assert.match(html, /Bassline stayed locked\./);
    assert.match(html, /<img loading="lazy" src="\/event\/known-set\/media\/media-img"/);
  }],
  ["event wall handles ready set with no posts", async () => {
    const resp = await fetchPath(`/e/${KNOWN_SLUG}`);
    const html = await resp.text();
    assert.equal(resp.status, 200);
    assert.match(html, /<audio id="setaudio"/);
    assert.match(html, /<div class="wave" id="wave"/);
    assert.match(html, /No posts yet\./);
  }],
  ["unknown event returns 404", async () => {
    const resp = await fetchPath("/e/unknown-set");
    assert.equal(resp.status, 404);
  }],
  ["profile route renders real DJ profile", async () => {
    const resp = await fetchPath("/@someone", {}, {
      db: {
        profiles: [{
          id: "profile-someone",
          handle: "someone",
          display_name: "DJ Someone",
          bio: "Late-night house and balcony replays.",
          location: "Oakland",
          avatar_key: "dj/someone/avatar.jpg",
          hero_key: "dj/someone/hero.jpg",
          website_url: "https://example.test",
          instagram_url: "",
          soundcloud_url: "",
          spotify_url: "",
          published: 1,
        }],
        profileUpcomingEvents: [{
          slug: "someone-live",
          title: "Someone Live",
          host: "DJ Someone",
          scheduled_at_ms: 1893542400000,
          location_name: "Floor Room",
          status: "live",
          visibility: "public",
          cover_key: "event/someone-live/cover.jpg",
        }, {
          slug: "someone-rooftop",
          title: "Someone Rooftop",
          host: "DJ Someone",
          scheduled_at_ms: 1893456000000,
          location_name: "Roof Room",
          status: "upcoming",
          visibility: "public",
          cover_key: "event/someone-rooftop/cover.jpg",
        }],
      },
    });
    const html = await resp.text();
    assert.equal(resp.status, 200);
    assert.match(html, /DJ Someone/);
    assert.match(html, /@someone/);
    assert.ok(html.indexOf("Someone Live") < html.indexOf("Someone Rooftop"));
    assert.match(html, /<span class="statuspill live"><span class="dot"><\/span>Live<\/span>/);
    assert.match(html, /<span class="statuspill upcoming">Upcoming<\/span>/);
    assert.match(html, /href="\/e\/someone-rooftop"/);
    assert.doesNotMatch(html, /Rooftop Sessions/);
  }],
  ["unknown profile returns 404", async () => {
    const resp = await fetchPath("/@nobody");
    assert.equal(resp.status, 404);
  }],
  ["demo route renders demo", async () => {
    const resp = await fetchPath("/demo");
    const html = await resp.text();
    assert.equal(resp.status, 200);
    assert.match(html, /Rooftop Sessions/);
  }],
  ["approved post media returns object with stored content-type", async () => {
    const resp = await fetchPath(`/event/${KNOWN_SLUG}/media/media-img`, {}, {
      db: {
        wallPosts: [{
          id: "post-img",
          slug: KNOWN_SLUG,
          approved: 1,
          deleted_ms: null,
        }],
        wallMedia: [{
          id: "media-img",
          slug: KNOWN_SLUG,
          post_id: "post-img",
          media_key: `event/${KNOWN_SLUG}/post-media/media-img`,
          media_type: "image",
          mime_type: "image/png",
        }],
      },
      r2Objects: {
        [`event/${KNOWN_SLUG}/post-media/media-img`]: new FakeR2Object("fake-png", { contentType: "image/png" }),
      },
    });
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get("content-type"), "image/png");
    assert.equal(await resp.text(), "fake-png");
  }],
  ["unapproved post media returns 404", async () => {
    const resp = await fetchPath(`/event/${KNOWN_SLUG}/media/media-img`, {}, {
      db: {
        wallPosts: [{
          id: "post-img",
          slug: KNOWN_SLUG,
          approved: 0,
          deleted_ms: null,
        }],
        wallMedia: [{
          id: "media-img",
          slug: KNOWN_SLUG,
          post_id: "post-img",
          media_key: `event/${KNOWN_SLUG}/post-media/media-img`,
          media_type: "image",
          mime_type: "image/jpeg",
        }],
      },
      r2Objects: {
        [`event/${KNOWN_SLUG}/post-media/media-img`]: new FakeR2Object("fake-jpeg", { contentType: "image/jpeg" }),
      },
    });
    assert.equal(resp.status, 404);
  }],
  ["post media with wrong slug returns 404", async () => {
    const resp = await fetchPath("/event/other-set/media/media-img", {}, {
      db: {
        wallPosts: [{
          id: "post-img",
          slug: KNOWN_SLUG,
          approved: 1,
          deleted_ms: null,
        }],
        wallMedia: [{
          id: "media-img",
          slug: KNOWN_SLUG,
          post_id: "post-img",
          media_key: `event/${KNOWN_SLUG}/post-media/media-img`,
          media_type: "image",
          mime_type: "image/jpeg",
        }],
      },
      r2Objects: {
        [`event/${KNOWN_SLUG}/post-media/media-img`]: new FakeR2Object("fake-jpeg", { contentType: "image/jpeg" }),
      },
    });
    assert.equal(resp.status, 404);
  }],
  ["video post media supports byte ranges", async () => {
    const resp = await fetchPath(`/event/${KNOWN_SLUG}/media/media-video`, {
      headers: { range: "bytes=2-5" },
    }, {
      db: {
        wallPosts: [{
          id: "post-video",
          slug: KNOWN_SLUG,
          approved: 1,
          deleted_ms: null,
        }],
        wallMedia: [{
          id: "media-video",
          slug: KNOWN_SLUG,
          post_id: "post-video",
          media_key: `event/${KNOWN_SLUG}/post-media/media-video`,
          media_type: "video",
          mime_type: "video/mp4",
        }],
      },
      r2Objects: {
        [`event/${KNOWN_SLUG}/post-media/media-video`]: new FakeR2Object("0123456789", { contentType: "video/mp4" }),
      },
    });
    assert.equal(resp.status, 206);
    assert.equal(resp.headers.get("content-type"), "video/mp4");
    assert.equal(resp.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(resp.headers.get("content-length"), "4");
    assert.equal(await resp.text(), "2345");
  }],
  ["set audio range still returns 206", async () => {
    const resp = await fetchPath(`/event/${KNOWN_SLUG}/${SET_ID}.m4a`, {
      headers: { range: "bytes=0-3" },
    });
    assert.equal(resp.status, 206);
    assert.equal(resp.headers.get("content-type"), "audio/mp4");
    assert.equal(resp.headers.get("content-range"), "bytes 0-3/10");
    assert.equal(resp.headers.get("content-length"), "4");
    assert.equal(await resp.text(), "fake");
  }],
  ["missing event media returns 404", async () => {
    const resp = await fetchPath(`/event/${KNOWN_SLUG}/deadbeef.m4a`);
    assert.equal(resp.status, 404);
  }],
  ["broker publish-cover rejects missing auth", async () => {
    const resp = await fetchPath("/api/broker/publish-cover", { method: "PUT", body: "cover" });
    assert.equal(resp.status, 403);
  }],
  ["broker event-upsert rejects bad secret", async () => {
    const resp = await fetchPath("/api/broker/event-upsert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "wrong", slug: "ahead-bad-secret" }),
    });
    assert.equal(resp.status, 403);
  }],
  ["broker event-upsert creates fresh upcoming event", async () => {
    const db = new FakeD1({
      deviceInstalls: [{ install_id: "abc123abc123", user_id: "user-1", profile_id: "profile-1" }],
    });
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/event-upsert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "abc123abc123",
        secret: "secret-a",
        slug: "ahead-new",
        title: "Ahead New",
        host: "DJ Ahead",
        starts: "Friday",
        scheduled_at_ms: 1893456000000,
        visibility: "public",
      }),
    }), makeEnv({ DB: db }));
    const json = await resp.json();
    const row = db.events.get("ahead-new");
    assert.equal(resp.status, 200);
    assert.deepEqual(json, { ok: true, slug: "ahead-new", url: "https://party.ramine.net/e/ahead-new", status: "upcoming" });
    assert.equal(row.status, "upcoming");
    assert.equal(row.source, "install");
    assert.equal(row.title, "Ahead New");
    assert.equal(row.visibility, "public");
    assert.equal(row.rsvp_enabled, 1);
    assert.equal(row.owner_user_id, "user-1");
    assert.equal(row.dj_profile_id, "profile-1");
    assert.equal(db.profileActivityBumps.length, 1);
    assert.equal(db.profileActivityBumps[0].profileId, "profile-1");
    assert.equal(db.profileActivityBumps[0].lastActivityMs, row.last_activity_ms);
  }],
  ["broker event-upsert returns 409 for slug owned by another install", async () => {
    const db = new FakeD1({
      events: [{ slug: "taken-ahead", install_id: "def456def456", title: "Taken", status: "upcoming" }],
    });
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/event-upsert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "taken-ahead", title: "Nope" }),
    }), makeEnv({ DB: db }));
    assert.equal(resp.status, 409);
    assert.equal(db.events.get("taken-ahead").title, "Taken");
  }],
  ["broker event-upsert updates owned title without clobbering replay status", async () => {
    const db = new FakeD1({
      events: [{ slug: "owned-replay", install_id: "abc123abc123", title: "Old Title", status: "replay" }],
    });
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/event-upsert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "owned-replay", title: "New Title" }),
    }), makeEnv({ DB: db }));
    const json = await resp.json();
    const row = db.events.get("owned-replay");
    assert.equal(resp.status, 200);
    assert.equal(json.status, "replay");
    assert.equal(row.title, "New Title");
    assert.equal(row.status, "replay");
  }],
  ["broker publish-meta stamps replay activity and bumps DJ profile", async () => {
    const db = new FakeD1({
      events: [{
        slug: "owned-publish",
        install_id: "abc123abc123",
        title: "Old Publish",
        status: "live",
        dj_profile_id: "profile-publish",
        last_activity_ms: 1,
      }],
    });
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-meta", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "abc123abc123",
        secret: "secret-a",
        slug: "owned-publish",
        title: "Published Replay",
        host: "DJ Publish",
        starts: "Tonight",
      }),
    }), makeEnv({ DB: db }));
    const json = await resp.json();
    const row = db.events.get("owned-publish");
    assert.equal(resp.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.slug, "owned-publish");
    assert.equal(row.title, "Published Replay");
    assert.equal(row.status, "replay");
    assert.equal(typeof row.last_activity_ms, "number");
    assert.equal(row.updated_ms, row.last_activity_ms);
    assert.equal(db.profileActivityBumps.length, 1);
    assert.deepEqual(db.profileActivityBumps[0], { profileId: "profile-publish", lastActivityMs: row.last_activity_ms });
  }],
  ["broker publish-posts imports curated posts and is idempotent", async () => {
    const db = new FakeD1({
      events: [{ slug: "owned-posts", install_id: "abc123abc123", title: "Owned Posts", status: "replay" }],
    });
    const body = {
      id: "abc123abc123",
      secret: "secret-a",
      slug: "owned-posts",
      posts: [{
        localId: "post-one",
        ts: 1000,
        author: "Guest One",
        emoji: "✨",
        text: "Visible",
        dj: false,
        noPublish: false,
        comments: [{ localId: "comment-one", ts: 1500, author: "DJ", emoji: "🎧", text: "Nice", dj: true }],
      }, {
        localId: "post-two",
        ts: 2000,
        author: "Guest Two",
        emoji: "🙈",
        text: "Hidden",
        dj: false,
        noPublish: true,
        comments: [],
      }],
    };
    const first = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }), makeEnv({ DB: db }));
    const firstJson = await first.json();
    const ids = [...db.importedPosts.keys()];
    const visible = [...db.importedPosts.values()].find((row) => row.text === "Visible");
    const hidden = [...db.importedPosts.values()].find((row) => row.text === "Hidden");
    assert.equal(first.status, 200);
    assert.deepEqual(firstJson, { ok: true, slug: "owned-posts", imported: 2, approved: 1 });
    assert.equal(db.importedPosts.size, 2);
    assert.equal(db.importedComments.size, 1);
    assert.equal(visible.approved, 1);
    assert.equal(hidden.approved, 0);
    assert.equal(visible.activity_ms, 1500);

    const second = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }), makeEnv({ DB: db }));
    assert.equal(second.status, 200);
    assert.equal(db.importedPosts.size, 2);
    assert.deepEqual([...db.importedPosts.keys()], ids);
  }],
  ["broker publish-posts rejects slug owned by another install", async () => {
    const db = new FakeD1({
      events: [{ slug: "other-posts", install_id: "def456def456", title: "Other", status: "replay" }],
    });
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "abc123abc123",
        secret: "secret-a",
        slug: "other-posts",
        posts: [{ localId: "post-one", ts: 1, author: "Guest", emoji: "x", text: "Nope", comments: [] }],
      }),
    }), makeEnv({ DB: db }));
    assert.equal(resp.status, 403);
    assert.equal(db.importedPosts.size, 0);
  }],
  ["broker publish-posts tombstones deleted posts", async () => {
    const db = new FakeD1({
      events: [{ slug: "deleted-posts", install_id: "abc123abc123", title: "Deleted Posts", status: "replay" }],
    });
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "abc123abc123",
        secret: "secret-a",
        slug: "deleted-posts",
        posts: [{
          localId: "deleted-one",
          ts: 3000,
          author: "Guest",
          emoji: "🗑️",
          text: "Gone",
          deleted: true,
          comments: [{ localId: "comment-deleted", ts: 3500, author: "Guest", emoji: "x", text: "Also gone" }],
        }],
      }),
    }), makeEnv({ DB: db }));
    const row = [...db.importedPosts.values()][0];
    const comment = [...db.importedComments.values()][0];
    assert.equal(resp.status, 200);
    assert.equal(typeof row.deleted_ms, "number");
    assert.equal(comment.deleted_ms, row.deleted_ms);
  }],
  ["broker publish-post-media rejects missing auth headers", async () => {
    const resp = await fetchPath("/api/broker/publish-post-media", {
      method: "PUT",
      headers: {
        "x-pp-slug": "owned-media",
        "x-pp-post": "post-one",
        "x-pp-media": "media-one",
        "x-pp-media-type": "image",
        "content-length": contentLength("image"),
      },
      body: "image",
    });
    assert.equal(resp.status, 403);
  }],
  ["broker publish-post-media rejects slug owned by another install", async () => {
    const db = new FakeD1({
      events: [{ slug: "other-media", install_id: "def456def456", title: "Other", status: "replay" }],
      wallPosts: [{ id: "post-one", slug: "other-media", approved: 1, deleted_ms: null }],
    });
    const env = makeEnv({ DB: db });
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-post-media", {
      method: "PUT",
      headers: {
        "x-pp-id": "abc123abc123",
        "x-pp-secret": "secret-a",
        "x-pp-slug": "other-media",
        "x-pp-post": "post-one",
        "x-pp-media": "media-one",
        "x-pp-media-type": "image",
        "content-length": contentLength("image"),
      },
      body: "image",
    }), env);
    assert.equal(resp.status, 403);
    assert.equal(env.DL.objects.has("event/other-media/posts/post-one/media-one"), false);
    assert.equal(db.importedPostMedia.size, 0);
  }],
  ["broker publish-post-media rejects missing post", async () => {
    const db = new FakeD1({
      events: [{ slug: "owned-media", install_id: "abc123abc123", title: "Owned", status: "replay" }],
    });
    const env = makeEnv({ DB: db });
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-post-media", {
      method: "PUT",
      headers: {
        "x-pp-id": "abc123abc123",
        "x-pp-secret": "secret-a",
        "x-pp-slug": "owned-media",
        "x-pp-post": "missing-post",
        "x-pp-media": "media-one",
        "x-pp-media-type": "image",
        "content-length": contentLength("image"),
      },
      body: "image",
    }), env);
    assert.equal(resp.status, 404);
    assert.equal(env.DL.objects.has("event/owned-media/posts/missing-post/media-one"), false);
    assert.equal(db.importedPostMedia.size, 0);
  }],
  ["broker publish-post-media writes R2 key and upserts post_media", async () => {
    const db = new FakeD1({
      events: [{ slug: "owned-media", install_id: "abc123abc123", title: "Owned", status: "replay" }],
      wallPosts: [{ id: "post-one", slug: "owned-media", approved: 1, deleted_ms: null }],
    });
    const env = makeEnv({ DB: db });
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-post-media", {
      method: "PUT",
      headers: {
        "x-pp-id": "abc123abc123",
        "x-pp-secret": "secret-a",
        "x-pp-slug": "owned-media",
        "x-pp-post": "post-one",
        "x-pp-media": "media-one",
        "x-pp-media-type": "image",
        "x-pp-mime": "image/png",
        "x-pp-name": "photo.png",
        "x-pp-sort": "2",
        "content-length": contentLength("image-one"),
      },
      body: "image-one",
    }), env);
    const json = await resp.json();
    const key = "event/owned-media/posts/post-one/media-one";
    const obj = env.DL.objects.get(key);
    const row = db.importedPostMedia.get("media-one");
    assert.equal(resp.status, 200);
    assert.deepEqual(json, { ok: true, key, mediaId: "media-one" });
    assert.equal(await obj.text(), "image-one");
    assert.equal(obj.httpMetadata.contentType, "image/png");
    assert.equal(row.media_key, key);
    assert.equal(row.media_type, "image");
    assert.equal(row.mime_type, "image/png");
    assert.equal(row.name, "photo.png");
    assert.equal(row.size_bytes, 9);
    assert.equal(row.sort_order, 2);
    assert.equal(typeof db.events.get("owned-media").last_activity_ms, "number");
  }],
  ["broker publish-post-media second PUT updates existing media row", async () => {
    const db = new FakeD1({
      events: [{ slug: "owned-media", install_id: "abc123abc123", title: "Owned", status: "replay" }],
      wallPosts: [{ id: "post-one", slug: "owned-media", approved: 1, deleted_ms: null }],
    });
    const env = makeEnv({ DB: db });
    const upload = (body, name, sort) => worker.fetch(new Request("https://party.ramine.net/api/broker/publish-post-media", {
      method: "PUT",
      headers: {
        "x-pp-id": "abc123abc123",
        "x-pp-secret": "secret-a",
        "x-pp-slug": "owned-media",
        "x-pp-post": "post-one",
        "x-pp-media": "media-one",
        "x-pp-media-type": "audio",
        "x-pp-mime": "audio/mpeg",
        "x-pp-name": name,
        "x-pp-sort": String(sort),
        "content-length": contentLength(body),
      },
      body,
    }), env);
    const first = await upload("audio-one", "first.mp3", 1);
    const firstRow = db.importedPostMedia.get("media-one");
    const second = await upload("audio-two-longer", "second.mp3", 7);
    const row = db.importedPostMedia.get("media-one");
    const key = "event/owned-media/posts/post-one/media-one";
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(db.importedPostMedia.size, 1);
    assert.equal(row.created_ms, firstRow.created_ms);
    assert.equal(row.name, "second.mp3");
    assert.equal(row.sort_order, 7);
    assert.equal(row.size_bytes, 16);
    assert.equal(await env.DL.objects.get(key).text(), "audio-two-longer");
  }],
  ["broker event-status rejects non-owner install", async () => {
    const db = new FakeD1({
      events: [{ slug: "owned-by-b", install_id: "def456def456", title: "Owned B", status: "upcoming" }],
    });
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/event-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "owned-by-b", status: "live" }),
    }), makeEnv({ DB: db }));
    assert.equal(resp.status, 403);
    assert.equal(db.events.get("owned-by-b").status, "upcoming");
    assert.equal(db.events.get("owned-by-b").live_started_ms, undefined);
  }],
  ["broker event-status owner sets live and stamps start", async () => {
    const db = new FakeD1({
      events: [{ slug: "owned-live", install_id: "abc123abc123", title: "Owned Live", status: "upcoming", dj_profile_id: "profile-live" }],
    });
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/event-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "owned-live", status: "live" }),
    }), makeEnv({ DB: db }));
    const json = await resp.json();
    const row = db.events.get("owned-live");
    assert.equal(resp.status, 200);
    assert.deepEqual(json, { ok: true, slug: "owned-live", status: "live" });
    assert.equal(row.status, "live");
    assert.equal(typeof row.live_started_ms, "number");
    assert.equal(row.updated_ms, row.live_started_ms);
    assert.equal(row.last_activity_ms, row.live_started_ms);
    assert.equal(db.profileActivityBumps.length, 1);
    assert.deepEqual(db.profileActivityBumps[0], { profileId: "profile-live", lastActivityMs: row.last_activity_ms });
  }],
  ["broker event-status rejects invalid status", async () => {
    const db = new FakeD1({
      events: [{ slug: "owned-invalid-status", install_id: "abc123abc123", title: "Owned", status: "upcoming" }],
    });
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/event-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "owned-invalid-status", status: "paused" }),
    }), makeEnv({ DB: db }));
    assert.equal(resp.status, 400);
    assert.equal(db.events.get("owned-invalid-status").status, "upcoming");
  }],
];

let failed = 0;

for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

if (failed) process.exit(1);
