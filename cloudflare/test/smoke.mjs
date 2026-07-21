import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker, { cookieHeader, normalizeHandle, parseCookies, readJson, sendViaMXroute, sha256Hex } from "../worker.js";

globalThis.caches ??= {
  default: {
    match: async () => null,
    put: async () => {},
  },
};

const KNOWN_SLUG = "known-set";
const SET_ID = "abcdef123456";
const LINKED_INSTALL = { install_id: "abc123abc123", user_id: "user-a", profile_id: "profile-a", revoked_ms: null };

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
    eventSets = [],
    deviceInstalls = [],
    authMagicTokens = [],
    authUsers = [],
    authSessions = [],
    installLinkTokens = [],
    installBrowserTokens = [],
    follows = [],
    eventAliases = [],
    handleAliases = [],
    liveInstalls = [],
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
    this.eventSets = eventSets.map((row) => ({ ...row }));
    this.deviceInstalls = new Map(deviceInstalls.map((row) => [row.install_id, { ...row }]));
    this.authMagicTokens = new Map(authMagicTokens.map((row) => [row.id, { ...row }]));
    this.authUsers = new Map(authUsers.map((row) => [row.id, { ...row }]));
    this.authSessions = new Map(authSessions.map((row) => [row.id, { ...row }]));
    this.installLinkTokens = new Map(installLinkTokens.map((row) => [row.id, { ...row }]));
    this.installBrowserTokens = new Map(installBrowserTokens.map((row) => [row.id, { ...row }]));
    this.follows = follows.map((row) => ({ ...row }));
    this.eventAliases = new Map(eventAliases.map((row) => [row.old_slug, { ...row }]));
    this.handleAliases = new Map(handleAliases.map((row) => [row.handle, { ...row }]));
    this.liveInstalls = new Map(liveInstalls.map((row) => [row.install_id, { ...row }]));
    this.profileActivityBumps = [];
    this.rsvps = new Map();
    for (const row of rsvps) {
      const key = row.user_id ? `${row.slug}:user:${row.user_id}` : `${row.slug}:anon:${row.anon_key_hash}`;
      this.rsvps.set(key, { ...row });
    }
    this.eventGuests = new Map();
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
    if (sql.includes("SELECT COUNT(*) AS n FROM event_guests")) {
      const [slug, cutoff] = this.args;
      let n = 0;
      for (const row of this.db.eventGuests.values()) {
        if (row.slug === slug && Number(row.updated_ms) > Number(cutoff)) n++;
      }
      return { n };
    }
    if (sql.includes("SELECT COUNT(*) AS n FROM posts") && sql.includes("source='web'")) {
      const [slug, cutoff, identity] = this.args;
      const byUser = sql.includes("author_user_id=?");
      const hasIdentity = byUser || sql.includes("author_cid_hash=?");
      const n = this.db.wallPosts.filter((row) =>
        row.slug === slug && row.source === "web" && Number(row.ts_ms) > Number(cutoff) &&
        (!hasIdentity || (byUser ? row.author_user_id === identity : row.author_cid_hash === identity))
      ).length;
      return { n };
    }
    if (sql.includes("FROM event_guests WHERE slug=?") && (sql.includes("user_id=?") || sql.includes("anon_key_hash=?"))) {
      const [slug, identity] = this.args;
      const key = sql.includes("user_id=?") ? `${slug}:user:${identity}` : `${slug}:anon:${identity}`;
      const row = this.db.eventGuests.get(key);
      return row ? { ...row } : null;
    }
    if (sql.includes("FROM live_installs WHERE install_id=?")) {
      const row = this.db.liveInstalls.get(this.args[0]);
      return row ? { ...row } : null;
    }
    if (sql.includes("FROM live_installs WHERE host=?")) {
      const [host, now] = this.args;
      const row = [...this.db.liveInstalls.values()].find(
        (r) => r.host === host && Number(r.expires_ms) > Number(now)
      );
      return row ? { ...row } : null;
    }
    if (sql.includes("FROM events WHERE install_id=? AND status='live'")) {
      const installId = this.args[0];
      const rows = [...this.db.events.values()]
        .filter((e) => e.install_id === installId && e.status === "live")
        .sort((a, b) => (Number(b.live_started_ms ?? b.updated_ms ?? 0)) - (Number(a.live_started_ms ?? a.updated_ms ?? 0)));
      return rows[0] ? { slug: rows[0].slug } : null;
    }
    if (sql.includes("FROM events WHERE dj_profile_id=?")) {
      const profileId = this.args[0];
      const rows = [...this.db.events.values()]
        .filter((e) => e.dj_profile_id === profileId)
        .sort((a, b) => eventActivity(b) - eventActivity(a));
      return rows[0] ? { slug: rows[0].slug, title: rows[0].title || "" } : null;
    }
    if (sql.includes("COUNT(*) AS n FROM auth_magic_tokens WHERE request_ip_hash=?")) {
      const [ipHash, sinceMs] = this.args;
      let n = 0;
      for (const row of this.db.authMagicTokens.values()) {
        if (row.request_ip_hash === ipHash && Number(row.created_ms) >= Number(sinceMs)) n += 1;
      }
      return { n };
    }
    if (sql.includes("COUNT(*) AS n FROM auth_magic_tokens WHERE email_norm=?")) {
      const [emailNorm, sinceMs] = this.args;
      let n = 0;
      for (const row of this.db.authMagicTokens.values()) {
        if (row.email_norm === emailNorm && Number(row.created_ms) >= Number(sinceMs)) n += 1;
      }
      return { n };
    }
    if (sql.includes("FROM auth_magic_tokens WHERE token_hash=?")) {
      const tokenHash = this.args[0];
      for (const row of this.db.authMagicTokens.values()) {
        if (row.token_hash === tokenHash) return { ...row };
      }
      return null;
    }
    if (sql.includes("FROM users WHERE email_norm=?")) {
      const emailNorm = this.args[0];
      for (const row of this.db.authUsers.values()) {
        if (row.email_norm === emailNorm) return { ...row };
      }
      return null;
    }
    if (sql.includes("FROM auth_sessions s") && sql.includes("JOIN users u")) {
      const [tokenHash, now] = this.args;
      const session = [...this.db.authSessions.values()].find((row) =>
        row.token_hash === tokenHash &&
        Number(row.expires_ms) > Number(now) &&
        row.revoked_ms == null
      );
      if (!session) return null;
      const user = this.db.authUsers.get(session.user_id);
      if (!user || user.disabled_ms != null) return null;
      return { ...user };
    }
    if (sql.includes("FROM dj_profiles WHERE user_id=?")) {
      const userId = this.args[0];
      const row = this.db.profiles.find((profile) => profile.user_id === userId);
      return row ? { ...row } : null;
    }
    if (sql.includes("COUNT(*) AS n FROM install_link_tokens WHERE user_id=?")) {
      const [userId, now] = this.args;
      let n = 0;
      for (const row of this.db.installLinkTokens.values()) {
        if (row.user_id === userId && row.used_ms == null && Number(row.expires_ms) > Number(now)) n += 1;
      }
      return { n };
    }
    if (sql.includes("COUNT(*) AS n FROM install_browser_tokens WHERE install_id=?")) {
      const [installId, now] = this.args;
      let n = 0;
      for (const row of this.db.installBrowserTokens.values()) {
        if (row.install_id === installId && row.used_ms == null && Number(row.expires_ms) > Number(now)) n += 1;
      }
      return { n };
    }
    if (sql.includes("FROM install_link_tokens WHERE code_hash=?")) {
      const codeHash = this.args[0];
      for (const row of this.db.installLinkTokens.values()) {
        if (row.code_hash === codeHash) return { ...row };
      }
      return null;
    }
    if (sql.includes("FROM install_browser_tokens WHERE token_hash=?")) {
      const tokenHash = this.args[0];
      for (const row of this.db.installBrowserTokens.values()) {
        if (row.token_hash === tokenHash) return { ...row };
      }
      return null;
    }
    if (sql.includes("FROM dj_profiles WHERE id=?")) {
      const profileId = this.args[0];
      const row = this.db.profiles.find((profile) => profile.id === profileId);
      return row ? { ...row } : null;
    }
    if (sql.includes("FROM device_installs di") && sql.includes("LEFT JOIN users u")) {
      const installId = this.args[0];
      const install = this.db.deviceInstalls.get(installId);
      if (!install || install.revoked_ms != null) return null;
      const user = this.db.authUsers.get(install.user_id) || {};
      const profile = this.db.profiles.find((row) => row.id === install.profile_id) || {};
      return {
        user_id: install.user_id,
        profile_id: install.profile_id,
        email: user.email || "",
        user_display_name: user.display_name || "",
        handle: profile.handle || "",
        profile_display_name: profile.display_name || "",
      };
    }
    if (sql.includes("COUNT(*) AS n FROM device_installs WHERE user_id=?")) {
      const userId = this.args[0];
      let n = 0;
      for (const row of this.db.deviceInstalls.values()) {
        if (row.user_id === userId && (!sql.includes("revoked_ms IS NULL") || row.revoked_ms == null)) n += 1;
      }
      return { n };
    }
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
    if (sql.includes("FROM event_aliases WHERE old_slug=?")) {
      const oldSlug = this.args[0];
      const row = this.db.eventAliases.get(oldSlug);
      return row ? { ...row } : null;
    }
    if (sql.includes("FROM events e WHERE e.slug=?1")) {
      const slug = this.args[0];
      const row = this.db.events.get(slug);
      if (!row) return null;
      return {
        status: row.status,
        cover_key: row.cover_key ?? null,
        has_sets: this.db.eventSets.some((set) => set.slug === slug) ? 1 : 0,
        has_posts: [...this.db.importedPosts.values()].some((post) => post.slug === slug) ? 1 : 0,
        has_rsvps: [...this.db.rsvps.values()].some((rsvp) => rsvp.slug === slug) ? 1 : 0,
        has_claims: 0,
        has_guests: [...this.db.eventGuests.values()].some((guest) => guest.slug === slug) ? 1 : 0,
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
      const row = this.db.eventSets.find((set) => set.slug === slug && set.state === "ready");
      if (row) return { id: row.id || SET_ID, slug, state: "ready", audio_key: row.audio_key || `event/${slug}/${row.id || SET_ID}.m4a` };
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
      const row = this.db.deviceInstalls.get(this.args[0]);
      if (!row) return null;
      if (sql.includes("revoked_ms IS NULL") && row.revoked_ms != null) return null;
      return { ...row };
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
      const row = this.db.profiles.find((profile) =>
        profile.handle === handle && (!sql.includes("published=1") || profile.published === 1)
      );
      return row ? { ...row } : null;
    }
    if (sql.includes("FROM handle_aliases WHERE handle=?")) {
      const row = this.db.handleAliases.get(this.args[0]);
      return row ? { ...row } : null;
    }
    if (sql.includes("FROM follows WHERE follower_user_id=? AND dj_profile_id=?")) {
      const [userId, profileId] = this.args;
      return this.db.follows.some((f) => f.follower_user_id === userId && f.dj_profile_id === profileId) ? { 1: 1 } : null;
    }
    return null;
  }

  async all() {
    const sql = this.sql.replace(/\s+/g, " ");
    if (sql.includes("FROM live_installs WHERE handle=?")) {
      const [handle, now] = this.args;
      const results = [...this.db.liveInstalls.values()]
        .filter((r) => r.handle === handle && Number(r.expires_ms) > Number(now))
        .sort((a, b) => Number(b.live_started_ms) - Number(a.live_started_ms))
        .map((r) => ({ ...r }));
      return { results };
    }
    if (sql.includes("FROM live_installs WHERE expires_ms>?")) {
      // /api/discover: all live parties, IP-matched first, capped — the client probes.
      const [now, ipHash] = this.args;
      const results = [...this.db.liveInstalls.values()]
        .filter((r) => Number(r.expires_ms) > Number(now))
        .sort((a, b) => {
          const am = a.public_ip_hash === ipHash ? 1 : 0;
          const bm = b.public_ip_hash === ipHash ? 1 : 0;
          if (am !== bm) return bm - am;
          return Number(b.live_started_ms) - Number(a.live_started_ms);
        })
        .slice(0, 8)
        .map((r) => ({ ...r }));
      return { results };
    }
    if (sql.includes("FROM live_installs WHERE expires_ms<=?")) {
      const cutoff = Number(this.args[0]);
      const results = [...this.db.liveInstalls.values()]
        .filter((r) => Number(r.expires_ms) <= cutoff)
        .map((r) => ({ install_id: r.install_id, handle: r.handle, host: r.host }));
      return { results };
    }
    if (sql.includes("FROM events") && sql.includes("WHERE owner_user_id=?")) {
      const userId = this.args[0];
      return {
        results: [...this.db.events.values()]
          .filter((row) => row.owner_user_id === userId)
          .sort((a, b) =>
            (Number(b.scheduled_at_ms ?? b.published_ms ?? b.updated_ms ?? b.created_ms) || 0) -
            (Number(a.scheduled_at_ms ?? a.published_ms ?? a.updated_ms ?? a.created_ms) || 0) ||
            bySlug(a, b)
          )
          .slice(0, 6),
      };
    }
    if (sql.includes("FROM events e") && sql.includes("COALESCE(rs.has_replay") && sql.includes("event_rsvps")) {
      const [installId, profileId, _profileId2, sinceMs, untilMs, limitArg] = this.args;
      const limit = Number(limitArg) || 50;
      const rows = [...this.db.events.values()]
        .filter((row) => row.install_id === installId || (profileId && row.dj_profile_id === profileId))
        .filter((row) => {
          const ts = row.scheduled_at_ms ?? row.published_ms ?? row.updated_ms;
          return ts != null && Number(ts) >= Number(sinceMs) && Number(ts) <= Number(untilMs);
        })
        .map((row) => {
          let coming = 0;
          let notCount = 0;
          for (const rsvp of this.db.rsvps.values()) {
            if (rsvp.slug !== row.slug) continue;
            if (rsvp.response === "coming") coming += 1;
            if (rsvp.response === "not") notCount += 1;
          }
          return {
            ...row,
            has_replay: this.db.eventSets.some((set) => set.slug === row.slug && set.state === "ready") ? 1 : 0,
            rsvp_coming: coming,
            rsvp_not: notCount,
          };
        })
        .sort((a, b) => {
          const group = (row) => row.status === "live" ? 0 : row.status === "upcoming" ? 1 : 2;
          const groupDiff = group(a) - group(b);
          if (groupDiff) return groupDiff;
          if (a.status === "upcoming" && b.status === "upcoming") {
            const schedDiff = (Number(a.scheduled_at_ms ?? a.published_ms ?? a.updated_ms) || 0)
              - (Number(b.scheduled_at_ms ?? b.published_ms ?? b.updated_ms) || 0);
            if (schedDiff) return schedDiff;
          }
          if (group(a) === 2 && group(b) === 2) {
            const activityDiff = (Number(b.last_activity_ms ?? b.published_ms ?? b.updated_ms) || 0)
              - (Number(a.last_activity_ms ?? a.published_ms ?? a.updated_ms) || 0);
            if (activityDiff) return activityDiff;
          }
          return bySlug(a, b);
        })
        .slice(0, limit);
      return { results: rows };
    }
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
    if (sql.includes("FROM posts WHERE slug=?") && sql.includes("source='web'")) {
      // Check-in feed read: this event's recent web posts, oldest first.
      const [slug, tsCutoff] = this.args;
      return {
        results: this.db.wallPosts
          .filter((r) => r.slug === slug && r.source === "web" && Number(r.ts_ms) > Number(tsCutoff) && !r.deleted_ms)
          .sort((a, b) => Number(a.ts_ms) - Number(b.ts_ms))
          .slice(0, 50)
          .map((r) => ({ ...r })),
      };
    }
    if (sql.includes("FROM posts WHERE slug=?")) {
      const slug = this.args[0];
      const limit = Number(this.args[1]) || this.db.wallPosts.length;
      return {
        results: this.db.wallPosts
          .filter((row) => row.slug === slug)
          .sort((a, b) =>
            (Number(a.activity_ms ?? a.created_ms ?? a.ts_ms ?? 0) || 0) -
            (Number(b.activity_ms ?? b.created_ms ?? b.ts_ms ?? 0) || 0)
          )
          .slice(0, limit),
      };
    }
    if (sql.includes("FROM post_media WHERE post_id IN")) {
      const ids = new Set(JSON.parse(this.args[0] || "[]"));
      const limit = Number(this.args[1]) || this.db.importedPostMedia.size;
      return { results: [...this.db.importedPostMedia.values()].filter((row) => ids.has(row.post_id)).slice(0, limit) };
    }
    if (sql.includes("FROM post_comments WHERE post_id=?")) {
      const [postId, limitArg] = this.args;
      const limit = Number(limitArg) || this.db.importedComments.size;
      return {
        results: [...this.db.importedComments.values()]
          .filter((row) => row.post_id === postId && row.approved === 1 && row.deleted_ms == null)
          .sort((a, b) => (Number(a.ts_ms) || 0) - (Number(b.ts_ms) || 0))
          .slice(0, limit),
      };
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
    if (sql.includes("FROM follows f") && sql.includes("JOIN dj_profiles p")) {
      const userId = this.args[0];
      const rows = this.db.follows
        .filter((f) => f.follower_user_id === userId)
        .sort((a, b) => Number(b.created_ms) - Number(a.created_ms))
        .map((f) => this.db.profiles.find((p) => p.id === f.dj_profile_id && p.published === 1))
        .filter(Boolean)
        .map((p) => ({ ...p }));
      return { results: rows };
    }
    if (sql.includes("FROM device_installs WHERE user_id=?") && sql.includes("revoked_ms IS NULL") && !sql.includes("COUNT")) {
      const userId = this.args[0];
      const rows = [...this.db.deviceInstalls.values()].filter((r) => r.user_id === userId && r.revoked_ms == null);
      return { results: rows.map((r) => ({ ...r })) };
    }
    return { results: [] };
  }

  async run() {
    const sql = this.sql.replace(/\s+/g, " ");
    if (sql.includes("UPDATE live_installs SET event_slug=? WHERE install_id=?")) {
      const [eventSlug, installId] = this.args;
      const row = this.db.liveInstalls.get(installId);
      if (row) row.event_slug = eventSlug;
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    if (sql.includes("INSERT INTO live_installs")) {
      const [
        installId, handle, profileId, publicIpHash, host, lanIp, guestPort, eventSlug,
        djName, eventTitle, listeners, nowPlaying, nowStamp, expiresMs,
      ] = this.args;
      const old = this.db.liveInstalls.get(installId);
      this.db.liveInstalls.set(installId, {
        install_id: installId,
        handle,
        profile_id: profileId,
        public_ip_hash: publicIpHash,
        host,
        lan_ip: lanIp,
        guest_port: guestPort ?? null,
        event_slug: eventSlug,
        dj_name: djName,
        event_title: eventTitle,
        listeners: Number(listeners) || 0,
        now_playing: nowPlaying,
        live_started_ms: old ? old.live_started_ms : nowStamp, // set once
        last_seen_ms: nowStamp,
        expires_ms: expiresMs,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM live_installs WHERE install_id=?")) {
      const existed = this.db.liveInstalls.delete(this.args[0]);
      return { success: true, meta: { changes: existed ? 1 : 0 } };
    }
    if (sql.includes("DELETE FROM live_installs WHERE expires_ms<=?")) {
      const cutoff = Number(this.args[0]);
      let changes = 0;
      for (const [k, r] of [...this.db.liveInstalls.entries()]) {
        if (Number(r.expires_ms) <= cutoff) {
          this.db.liveInstalls.delete(k);
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("INSERT INTO follows")) {
      const [userId, profileId, createdMs] = this.args;
      if (this.db.follows.some((f) => f.follower_user_id === userId && f.dj_profile_id === profileId)) {
        return { success: true, meta: { changes: 0 } };
      }
      this.db.follows.push({ follower_user_id: userId, dj_profile_id: profileId, created_ms: createdMs });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("DELETE FROM follows WHERE follower_user_id=? AND dj_profile_id=?")) {
      const [userId, profileId] = this.args;
      const before = this.db.follows.length;
      this.db.follows = this.db.follows.filter((f) => !(f.follower_user_id === userId && f.dj_profile_id === profileId));
      return { success: true, meta: { changes: before - this.db.follows.length } };
    }
    if (sql.includes("DELETE FROM install_link_tokens WHERE (used_ms IS NOT NULL OR expires_ms < ?)")) {
      const [now, createdCutoff] = this.args;
      let changes = 0;
      for (const [id, row] of [...this.db.installLinkTokens.entries()]) {
        if (changes >= 200) break;
        if ((row.used_ms != null || Number(row.expires_ms) < Number(now)) && Number(row.created_ms) < Number(createdCutoff)) {
          this.db.installLinkTokens.delete(id);
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("DELETE FROM install_browser_tokens WHERE (used_ms IS NOT NULL OR expires_ms < ?)")) {
      const [now, createdCutoff] = this.args;
      let changes = 0;
      for (const [id, row] of [...this.db.installBrowserTokens.entries()]) {
        if (changes >= 200) break;
        if ((row.used_ms != null || Number(row.expires_ms) < Number(now)) && Number(row.created_ms) < Number(createdCutoff)) {
          this.db.installBrowserTokens.delete(id);
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("DELETE FROM auth_magic_tokens WHERE expires_ms < ? LIMIT 200")) {
      const cutoff = Number(this.args[0]);
      let changes = 0;
      for (const [id, row] of [...this.db.authMagicTokens.entries()]) {
        if (changes >= 200) break;
        if (Number(row.expires_ms) < cutoff) {
          this.db.authMagicTokens.delete(id);
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("DELETE FROM auth_sessions WHERE expires_ms < ? LIMIT 200")) {
      const cutoff = Number(this.args[0]);
      let changes = 0;
      for (const [id, row] of [...this.db.authSessions.entries()]) {
        if (changes >= 200) break;
        if (Number(row.expires_ms) < cutoff) {
          this.db.authSessions.delete(id);
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("DELETE FROM event_aliases WHERE old_slug=?")) {
      const oldSlug = this.args[0];
      const existed = this.db.eventAliases.delete(oldSlug);
      return { success: true, meta: { changes: existed ? 1 : 0 } };
    }
    if (sql.includes("UPDATE event_aliases SET slug=? WHERE slug=?")) {
      const [slug, oldTarget] = this.args;
      let changes = 0;
      for (const row of this.db.eventAliases.values()) {
        if (row.slug === oldTarget) {
          row.slug = slug;
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("INSERT INTO event_aliases")) {
      const [oldSlug, slug, createdMs] = this.args;
      const old = this.db.eventAliases.get(oldSlug);
      this.db.eventAliases.set(oldSlug, {
        old_slug: oldSlug,
        slug,
        created_ms: old?.created_ms ?? createdMs,
      });
      return { success: true, meta: { changes: old ? 0 : 1 } };
    }
    if (sql.includes("INSERT INTO auth_magic_tokens")) {
      const [id, tokenHash, emailNorm, redirectPath, createdMs, expiresMs, ipHash, uaHash] = this.args;
      this.db.authMagicTokens.set(id, {
        id,
        token_hash: tokenHash,
        email_norm: emailNorm,
        user_id: null,
        purpose: "login",
        redirect_path: redirectPath,
        created_ms: createdMs,
        expires_ms: expiresMs,
        used_ms: null,
        request_ip_hash: ipHash,
        user_agent_hash: uaHash,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE auth_magic_tokens SET used_ms=? WHERE id=? AND used_ms IS NULL")) {
      const [usedMs, id] = this.args;
      const row = this.db.authMagicTokens.get(id);
      if (!row || row.used_ms != null) return { success: true, meta: { changes: 0 } };
      row.used_ms = usedMs;
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE users SET last_login_ms=?")) {
      const [lastLoginMs, emailVerifiedMs, updatedMs, id] = this.args;
      const row = this.db.authUsers.get(id);
      if (row) {
        row.last_login_ms = lastLoginMs;
        if (row.email_verified_ms == null) row.email_verified_ms = emailVerifiedMs;
        row.updated_ms = updatedMs;
      }
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    if (sql.includes("INSERT INTO users")) {
      const [id, email, emailNorm, displayName, createdMs, updatedMs, emailVerifiedMs, lastLoginMs] = this.args;
      if (sql.includes("ON CONFLICT(email_norm) DO NOTHING")) {
        for (const row of this.db.authUsers.values()) {
          if (row.email_norm === emailNorm) return { success: true, meta: { changes: 0 } };
        }
      }
      this.db.authUsers.set(id, {
        id,
        email,
        email_norm: emailNorm,
        display_name: displayName,
        created_ms: createdMs,
        updated_ms: updatedMs,
        email_verified_ms: emailVerifiedMs,
        last_login_ms: lastLoginMs,
        disabled_ms: null,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO auth_sessions")) {
      const [id, tokenHash, userId, createdMs, expiresMs, lastSeenMs, ipHash, uaHash] = this.args;
      this.db.authSessions.set(id, {
        id,
        token_hash: tokenHash,
        user_id: userId,
        created_ms: createdMs,
        expires_ms: expiresMs,
        last_seen_ms: lastSeenMs,
        revoked_ms: null,
        request_ip_hash: ipHash,
        user_agent_hash: uaHash,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO install_link_tokens")) {
      const [id, codeHash, userId, profileId, createdMs, expiresMs] = this.args;
      for (const row of this.db.installLinkTokens.values()) {
        if (row.code_hash === codeHash) throw new Error("UNIQUE constraint failed: install_link_tokens.code_hash");
      }
      this.db.installLinkTokens.set(id, {
        id,
        code_hash: codeHash,
        user_id: userId,
        profile_id: profileId,
        install_id: null,
        created_ms: createdMs,
        expires_ms: expiresMs,
        used_ms: null,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO install_browser_tokens")) {
      const [id, tokenHash, installId, installSlug, createdMs, expiresMs, ipHash] = this.args;
      for (const row of this.db.installBrowserTokens.values()) {
        if (row.token_hash === tokenHash) throw new Error("UNIQUE constraint failed: install_browser_tokens.token_hash");
      }
      this.db.installBrowserTokens.set(id, {
        id,
        token_hash: tokenHash,
        install_id: installId,
        install_slug: installSlug,
        created_ms: createdMs,
        expires_ms: expiresMs,
        used_ms: null,
        request_ip_hash: ipHash,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE install_link_tokens SET used_ms=?, install_id=? WHERE id=? AND used_ms IS NULL")) {
      const [usedMs, installId, id] = this.args;
      const row = this.db.installLinkTokens.get(id);
      if (!row || row.used_ms != null) return { success: true, meta: { changes: 0 } };
      row.used_ms = usedMs;
      row.install_id = installId;
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE install_browser_tokens SET used_ms=? WHERE id=? AND used_ms IS NULL")) {
      const [usedMs, id] = this.args;
      const row = this.db.installBrowserTokens.get(id);
      if (!row || row.used_ms != null) return { success: true, meta: { changes: 0 } };
      row.used_ms = usedMs;
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO device_installs")) {
      const [installId, installSlug, userId, profileId, createdMs, linkedMs, lastSeenMs] = this.args;
      const old = this.db.deviceInstalls.get(installId);
      this.db.deviceInstalls.set(installId, {
        install_id: installId,
        install_slug: installSlug,
        user_id: userId,
        profile_id: profileId,
        label: old?.label || "",
        created_ms: old?.created_ms || createdMs,
        linked_ms: linkedMs,
        last_seen_ms: lastSeenMs,
        revoked_ms: null,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE device_installs SET revoked_ms=?, last_seen_ms=? WHERE install_id=?")) {
      const [revokedMs, lastSeenMs, installId] = this.args;
      const row = this.db.deviceInstalls.get(installId);
      if (!row || row.revoked_ms != null) return { success: true, meta: { changes: 0 } };
      row.revoked_ms = revokedMs;
      row.last_seen_ms = lastSeenMs;
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE device_installs SET revoked_ms=? WHERE user_id=?")) {
      const [revokedMs, userId, installId] = this.args;
      let changes = 0;
      for (const row of this.db.deviceInstalls.values()) {
        if (row.user_id !== userId || row.revoked_ms != null) continue;
        if (sql.includes("install_id=?") && row.install_id !== installId) continue;
        row.revoked_ms = revokedMs;
        changes += 1;
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("UPDATE auth_sessions SET revoked_ms=? WHERE token_hash=? AND revoked_ms IS NULL")) {
      const [revokedMs, tokenHash] = this.args;
      let changes = 0;
      for (const row of this.db.authSessions.values()) {
        if (row.token_hash === tokenHash && row.revoked_ms == null) {
          row.revoked_ms = revokedMs;
          changes += 1;
        }
      }
      return { success: true, meta: { changes } };
    }
    if (sql.includes("INSERT INTO dj_profiles")) {
      const [id, userId, handle, displayName, bio, location, createdMs, updatedMs, lastActivityMs, scopeUserId] = this.args;
      const handleOwner = this.db.profiles.find((profile) => profile.handle === handle);
      if (handleOwner && handleOwner.user_id !== userId) {
        throw new Error("UNIQUE constraint failed: dj_profiles.handle");
      }
      const existing = this.db.profiles.find((profile) => profile.user_id === userId);
      if (existing) {
        if (scopeUserId !== userId) return { success: true, meta: { changes: 0 } };
        if (sql.includes("handle=excluded.handle")) existing.handle = handle;
        existing.display_name = displayName;
        existing.bio = bio;
        existing.location = location;
        existing.published = 1;
        existing.updated_ms = updatedMs;
        existing.last_activity_ms = lastActivityMs;
        return { success: true, meta: { changes: 1 } };
      }
      this.db.profiles.push({
        id,
        user_id: userId,
        handle,
        display_name: displayName,
        bio,
        location,
        avatar_key: null,
        hero_key: null,
        website_url: "",
        instagram_url: "",
        soundcloud_url: "",
        spotify_url: "",
        primary_install_id: null,
        published: 1,
        created_ms: createdMs,
        updated_ms: updatedMs,
        last_activity_ms: lastActivityMs,
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO handle_aliases")) {
      const [handle, profileId, userId, createdMs] = this.args;
      if (this.db.handleAliases.has(handle)) return { success: true, meta: { changes: 0 } };
      this.db.handleAliases.set(handle, { handle, profile_id: profileId, user_id: userId, created_ms: createdMs });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE dj_profiles SET handle=?, handle_changed_ms=?")) {
      const [handle, changedMs, confirmMs, updatedMs, id] = this.args;
      const row = this.db.profiles.find((profile) => profile.id === id);
      if (!row) return { success: true, meta: { changes: 0 } };
      row.handle = handle;
      row.handle_changed_ms = changedMs;
      if (row.handle_confirmed_ms == null) row.handle_confirmed_ms = confirmMs;
      row.updated_ms = updatedMs;
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE dj_profiles SET handle_confirmed_ms=COALESCE")) {
      const [confirmMs, updatedMs, id] = this.args;
      const row = this.db.profiles.find((profile) => profile.id === id);
      if (!row) return { success: true, meta: { changes: 0 } };
      if (row.handle_confirmed_ms == null) row.handle_confirmed_ms = confirmMs;
      row.updated_ms = updatedMs;
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE dj_profiles SET display_name=?, updated_ms=? WHERE id=? AND user_id=?")) {
      const [displayName, updatedMs, id, userId] = this.args;
      const row = this.db.profiles.find((profile) => profile.id === id && profile.user_id === userId);
      if (!row) return { success: true, meta: { changes: 0 } };
      row.display_name = displayName;
      row.updated_ms = updatedMs;
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("UPDATE dj_profiles") && sql.includes("website_url=?")) {
      const [websiteUrl, instagramUrl, soundcloudUrl, spotifyUrl, updatedMs, userId] = this.args;
      const row = this.db.profiles.find((profile) => profile.user_id === userId);
      if (row) {
        row.website_url = websiteUrl;
        row.instagram_url = instagramUrl;
        row.soundcloud_url = soundcloudUrl;
        row.spotify_url = spotifyUrl;
        row.updated_ms = updatedMs;
      }
      return { success: true, meta: { changes: row ? 1 : 0 } };
    }
    if (sql.includes("UPDATE dj_profiles SET last_activity_ms=? WHERE id=?")) {
      const [lastActivityMs, profileId] = this.args;
      this.db.profileActivityBumps.push({ profileId, lastActivityMs });
      const row = this.db.profiles.find((profile) => profile.id === profileId);
      if (row) row.last_activity_ms = lastActivityMs;
    }
    if (sql.includes("INSERT INTO posts") && sql.includes("'web'")) {
      // A web guest's wall post: visible to the same readers as room posts.
      // MUST precede the mac_sync branch — both SQLs name source_install_id.
      const [id, slug, author, emoji, text, tsMs, createdMs, userId, cidHash, activityMs, updatedMs, approvedMs] = this.args;
      this.db.wallPosts.push({
        id, slug, author, emoji, text, media_key: null, media_type: null,
        approved: 1, ts_ms: tsMs, created_ms: createdMs, author_user_id: userId, author_cid_hash: cidHash,
        source: "web", source_install_id: null, dj: 0,
        activity_ms: activityMs, updated_ms: updatedMs, approved_ms: approvedMs, deleted_ms: null,
      });
      return { success: true, meta: { changes: 1 } };
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
    if (sql.includes("UPDATE events SET cover_key=?, updated_ms=? WHERE slug=? AND install_id=?")) {
      const [coverKey, updatedMs, slug, installId] = this.args;
      const old = this.db.events.get(slug);
      if (old && old.install_id === installId) {
        this.db.events.set(slug, { ...old, cover_key: coverKey, updated_ms: updatedMs });
      }
      return { success: true };
    }
    if (sql.includes("UPDATE events SET cover_key=NULL, updated_ms=? WHERE slug=? AND install_id=?")) {
      const [updatedMs, slug, installId] = this.args;
      const old = this.db.events.get(slug);
      if (old && old.install_id === installId) {
        this.db.events.set(slug, { ...old, cover_key: null, updated_ms: updatedMs });
      }
      return { success: true };
    }
    if (sql.includes("UPDATE events SET slug=? WHERE slug=? AND install_id=?")) {
      const [nextSlug, slug, installId] = this.args;
      const old = this.db.events.get(slug);
      if (old && old.install_id === installId && !this.db.events.has(nextSlug)) {
        this.db.events.delete(slug);
        this.db.events.set(nextSlug, { ...old, slug: nextSlug });
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    }
    if (sql.includes("UPDATE events SET install_id=?1") && sql.includes("WHERE slug=?2 AND install_id=''")) {
      const [installId, slug, userId, profileId] = this.args;
      const row = this.db.events.get(slug);
      const sameAccount = row && (row.owner_user_id === userId || (row.owner_user_id == null && row.dj_profile_id === profileId));
      if (row && row.install_id === "" && sameAccount) {
        row.install_id = installId;
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    }
    if (sql.includes("UPDATE events SET") && sql.includes("WHERE slug=? AND owner_user_id=?")) {
      const setCols = (this.sql.match(/UPDATE events SET ([\s\S]+?)\s+WHERE slug=\? AND owner_user_id=\?/)?.[1] || "")
        .split(",")
        .map((s) => s.trim().split("=")[0].trim())
        .filter(Boolean);
      const slug = this.args[this.args.length - 2];
      const ownerUserId = this.args[this.args.length - 1];
      const old = this.db.events.get(slug);
      if (old && old.owner_user_id === ownerUserId) {
        const vals = this.args.slice(0, setCols.length);
        const next = { ...old };
        for (let i = 0; i < setCols.length; i += 1) next[setCols[i]] = vals[i];
        const nextSlug = next.slug || slug;
        if (nextSlug !== slug) this.db.events.delete(slug);
        this.db.events.set(nextSlug, next);
      }
      return { success: true };
    }
    if (sql.includes("INSERT INTO events") && sql.includes("ON CONFLICT(slug) DO NOTHING")) {
      // liveMirrorUpload minting the live event for a fresh party.
      const [slug, installId, title, host, status, visibility, ownerUserId, djProfileId, liveStartedMs, createdMs, updatedMs, lastActivityMs] = this.args;
      if (!this.db.events.get(slug)) {
        this.db.events.set(slug, {
          slug, install_id: installId, title, host, status, visibility,
          owner_user_id: ownerUserId, dj_profile_id: djProfileId,
          live_started_ms: liveStartedMs, created_ms: createdMs,
          updated_ms: updatedMs, last_activity_ms: lastActivityMs,
        });
      }
      return { success: true };
    }
    if (sql.includes("INSERT INTO events") && sql.includes("?1") && sql.includes("last_activity_ms")) {
      const [slug, installId, title, host, starts, whereTxt, tagline, about, ownerUserId, djProfileId, now] = this.args;
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
          owner_user_id: ownerUserId,
          dj_profile_id: djProfileId,
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
          owner_user_id: ownerUserId || old.owner_user_id,
          dj_profile_id: djProfileId || old.dj_profile_id,
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
    if (sql.includes("UPDATE events SET status='replay'") && sql.includes("WHERE install_id=?")) {
      // Go-offline / cron GC: demote every mirror-minted 'live' event of an install.
      const [installId, updatedMs] = this.args;
      for (const [slug, row] of this.db.events) {
        if (row.install_id === installId && row.status === "live") {
          this.db.events.set(slug, { ...row, status: "replay", updated_ms: updatedMs });
        }
      }
      return { success: true, meta: { changes: 1 } };
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
    if (sql.includes("UPDATE event_guests SET updated_ms=")) {
      // Presence heartbeat: bump ONLY updated_ms on the identity's row.
      const [slug, key, now] = this.args;
      const isUser = sql.includes("user_id=");
      const mapKey = isUser ? `${slug}:user:${key}` : `${slug}:anon:${key}`;
      const old = this.db.eventGuests.get(mapKey);
      if (old) {
        this.db.eventGuests.set(mapKey, { ...old, updated_ms: now });
        return { success: true, meta: { changes: 1 } };
      }
      return { success: true, meta: { changes: 0 } };
    }
    if (sql.includes("INSERT INTO event_guests") && sql.includes("'', '', ''")) {
      // Presence for a guest with no join row yet: nameless placeholder.
      const isUser = sql.includes("ON CONFLICT(slug,user_id)");
      const [id, slug, key, createdMs, updatedMs] = this.args;
      const mapKey = isUser ? `${slug}:user:${key}` : `${slug}:anon:${key}`;
      const old = this.db.eventGuests.get(mapKey);
      this.db.eventGuests.set(mapKey, old
        ? { ...old, updated_ms: updatedMs }
        : {
            id, slug, user_id: isUser ? key : null, anon_key_hash: isUser ? null : key,
            name: "", emoji: "", email: "", source: "web-live",
            created_ms: createdMs, updated_ms: updatedMs,
          });
      return { success: true, meta: { changes: 1 } };
    }
    if (sql.includes("INSERT INTO event_guests")) {
      // Web-live guest join: same upsert shape as rsvps, plus email with a
      // keep-old-when-blank rule (a later nameless/emailless re-join must not
      // erase a captured address).
      const isUser = sql.includes("ON CONFLICT(slug,user_id)");
      const [id, slug, key, name, emoji, email, createdMs, updatedMs] = this.args;
      const mapKey = isUser ? `${slug}:user:${key}` : `${slug}:anon:${key}`;
      const old = this.db.eventGuests.get(mapKey);
      this.db.eventGuests.set(mapKey, {
        id: old?.id || id,
        slug,
        user_id: isUser ? key : null,
        anon_key_hash: isUser ? null : key,
        name,
        emoji,
        email: email === "" ? (old?.email || "") : email,
        source: "web-live",
        created_ms: old?.created_ms || createdMs,
        updated_ms: updatedMs,
      });
      return { success: true, meta: { changes: 1 } };
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
    this.multipart = new Map();
    this.multipartSeq = 0;
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

  async createMultipartUpload(key, opts = {}) {
    const uploadId = `upload-${++this.multipartSeq}`;
    const state = {
      key,
      contentType: opts.httpMetadata?.contentType || "application/octet-stream",
      parts: new Map(),
    };
    this.multipart.set(`${key}:${uploadId}`, state);
    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key, uploadId) {
    const r2 = this;
    return {
      key,
      uploadId,
      async uploadPart(partNumber, body) {
        const state = r2.multipart.get(`${key}:${uploadId}`);
        if (!state) throw new Error("No such multipart upload");
        const bytes = new Uint8Array(await new Response(body).arrayBuffer());
        const etag = `"part-${partNumber}-${bytes.byteLength}-${uploadId}"`;
        state.parts.set(partNumber, { bytes, etag });
        return { partNumber, etag };
      },
      async complete(parts) {
        const state = r2.multipart.get(`${key}:${uploadId}`);
        if (!state) throw new Error("No such multipart upload");
        const chunks = [];
        let size = 0;
        for (let i = 0; i < parts.length; i += 1) {
          const want = i + 1;
          const part = parts[i];
          if (part.partNumber !== want) throw new Error("parts must be ordered");
          const stored = state.parts.get(want);
          if (!stored || stored.etag !== part.etag) throw new Error("missing part");
          chunks.push(stored.bytes);
          size += stored.bytes.byteLength;
        }
        const out = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          out.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const obj = new FakeR2Object(out, { contentType: state.contentType });
        r2.objects.set(key, obj);
        r2.multipart.delete(`${key}:${uploadId}`);
        return { size: obj.size };
      },
    };
  }

  async delete(key) {
    this.objects.delete(key);
  }

  async list(opts = {}) {
    const prefix = opts?.prefix || "";
    const limit = Number(opts?.limit) || 1000;
    const objects = [];
    for (const [key, obj] of this.objects) {
      if (prefix && !key.startsWith(prefix)) continue;
      objects.push({ key, size: obj.size, uploaded: new Date(0) });
      if (objects.length >= limit) break;
    }
    return { objects, truncated: false };
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
    ...(opts.env || {}),
  };
}

async function withCloudflareDNSMock(fn) {
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (!req.url.startsWith("https://api.cloudflare.com/client/v4/")) {
      return oldFetch(input, init);
    }
    const text = req.method === "GET" ? "" : await req.clone().text();
    const body = text ? JSON.parse(text) : null;
    calls.push({ method: req.method, url: req.url, body });
    return new Response(JSON.stringify({ success: true, result: req.method === "GET" ? [] : { id: "dns-record" } }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = oldFetch;
  }
}

// Like withCloudflareDNSMock but lets a test preload existing A records so the
// GET-then-DELETE path (offline / cron A-record cleanup) is actually exercised.
async function withCloudflareDNSRecords(aRecords, fn) {
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (!req.url.startsWith("https://api.cloudflare.com/client/v4/")) {
      return oldFetch(input, init);
    }
    const text = req.method === "GET" ? "" : await req.clone().text();
    const body = text ? JSON.parse(text) : null;
    calls.push({ method: req.method, url: req.url, body });
    let result;
    if (req.method === "GET") {
      const isA = req.url.includes("type=A");
      result = isA ? aRecords : [];
    } else {
      result = { id: "dns-record" };
    }
    return new Response(JSON.stringify({ success: true, result }), {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = oldFetch;
  }
}

async function fetchPath(path, init = {}, envOpts = {}) {
  return worker.fetch(new Request(`https://partyparty.party${path}`, init), makeEnv(envOpts));
}

const AUTH_DEV_SECRET = "smoke-dev-secret";

function smtpSuccessReplies() {
  return [
    "220 mxroute ESMTP ready\r\n",
    "250-mxroute greets partyparty.party\r\n250 AUTH LOGIN PLAIN\r\n",
    "334 VXNlcm5hbWU6\r\n",
    "334 UGFzc3dvcmQ6\r\n",
    "235 2.7.0 Authentication successful\r\n",
    "250 2.1.0 Sender ok\r\n",
    "250 2.1.5 Recipient ok\r\n",
    "354 End data with <CR><LF>.<CR><LF>\r\n",
    "250 2.0.0 Queued\r\n",
    "221 2.0.0 Bye\r\n",
  ];
}

function fakeSmtpConnect(replies = smtpSuccessReplies()) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const calls = [];
  const writes = [];
  let closed = false;
  const connect = (address, options) => {
    calls.push({ address, options });
    return {
      opened: Promise.resolve({ remoteAddress: address.hostname, localAddress: "127.0.0.1" }),
      readable: new ReadableStream({
        start(controller) {
          for (const reply of replies) controller.enqueue(encoder.encode(reply));
          controller.close();
        },
      }),
      writable: new WritableStream({
        write(chunk) {
          writes.push(decoder.decode(chunk));
        },
      }),
      close: async () => { closed = true; },
      startTls() {
        throw new Error("unexpected STARTTLS in implicit TLS smoke test");
      },
    };
  };
  return {
    calls,
    writes,
    connect,
    get closed() { return closed; },
  };
}

function fakeStartTlsSmtpConnect() {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const calls = [];
  const writes = [];
  let upgraded = false;
  const socketFor = (replies, startTlsSocket = null) => ({
    opened: Promise.resolve({ remoteAddress: "mail.mxrouting.test", localAddress: "127.0.0.1" }),
    readable: new ReadableStream({
      start(controller) {
        for (const reply of replies) controller.enqueue(encoder.encode(reply));
        controller.close();
      },
    }),
    writable: new WritableStream({
      write(chunk) {
        writes.push(decoder.decode(chunk));
      },
    }),
    close: async () => {},
    startTls() {
      upgraded = true;
      return startTlsSocket;
    },
  });
  const secure = socketFor([
    "250 mxroute greets partyparty.party\r\n",
    ...smtpSuccessReplies().slice(2),
  ]);
  const plain = socketFor([
    "220 mxroute ESMTP ready\r\n",
    "250-STARTTLS\r\n250 AUTH LOGIN PLAIN\r\n",
    "220 2.0.0 Ready to start TLS\r\n",
  ], secure);
  const connect = (address, options) => {
    calls.push({ address, options });
    return plain;
  };
  return {
    calls,
    writes,
    connect,
    get upgraded() { return upgraded; },
  };
}

async function requestDevLink(db, email, opts = {}) {
  const resp = await worker.fetch(new Request("https://partyparty.party/api/auth/request-link", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": opts.ip || "203.0.113.20",
      "x-auth-dev-secret": AUTH_DEV_SECRET,
    },
    body: JSON.stringify({ email, redirect: opts.redirect }),
  }), makeEnv({ DB: db, env: { AUTH_DEV_LINKS: "1", AUTH_DEV_SECRET } }));
  assert.equal(resp.status, 200);
  const json = await resp.json();
  assert.match(json.devLink, /^https:\/\/partyparty\.party\/auth\/verify\?token=[a-f0-9]{64}$/);
  return json.devLink;
}

async function postVerify(db, token, opts = {}) {
  return await worker.fetch(new Request("https://partyparty.party/auth/verify", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "cf-connecting-ip": opts.ip || "203.0.113.21",
      "user-agent": opts.userAgent || "smoke-auth",
    },
    body: new URLSearchParams({ token }).toString(),
  }), makeEnv({ DB: db }));
}

async function signInCookie(db, email, opts = {}) {
  const devLink = await requestDevLink(db, email, opts);
  const token = new URL(devLink).searchParams.get("token");
  const verify = await postVerify(db, token, opts);
  assert.equal(verify.status, 302);
  // Sign-in now mints a dj_profile (the /welcome soft-gate). Existing tests build
  // their own profile state and expect a bare session, so drop the auto-minted
  // profile here; the mint + /welcome behavior is covered by dedicated tests
  // (see "username backbone" below) that drive the raw flow.
  const emailNorm = String(email || "").trim().toLowerCase();
  const user = [...db.authUsers.values()].find((row) => row.email_norm === emailNorm);
  if (user) db.profiles = db.profiles.filter((p) => p.user_id !== user.id);
  return (verify.headers.get("set-cookie") || "").split(";")[0];
}

// The raw sign-in flow (no profile stripping), so tests can observe the mint +
// /welcome soft-gate behavior on the verify redirect itself.
async function rawSignIn(db, email, opts = {}) {
  const devLink = await requestDevLink(db, email, opts);
  const token = new URL(devLink).searchParams.get("token");
  const verify = await postVerify(db, token, opts);
  return {
    status: verify.status,
    location: verify.headers.get("location") || "",
    cookie: (verify.headers.get("set-cookie") || "").split(";")[0],
  };
}

function userByEmail(db, email) {
  const emailNorm = String(email || "").trim().toLowerCase();
  return [...db.authUsers.values()].find((row) => row.email_norm === emailNorm);
}

async function seedInstallLinkToken(db, { id, code, userId, profileId, createdMs = Date.now(), expiresMs = Date.now() + 60_000, usedMs = null, installId = null }) {
  db.installLinkTokens.set(id, {
    id,
    code_hash: await sha256Hex(code),
    user_id: userId,
    profile_id: profileId,
    install_id: installId,
    created_ms: createdMs,
    expires_ms: expiresMs,
    used_ms: usedMs,
  });
}

async function seedInstallBrowserToken(db, { id, token, installId = "abc123abc123", installSlug = "disco12", createdMs = Date.now(), expiresMs = Date.now() + 60_000, usedMs = null }) {
  db.installBrowserTokens.set(id, {
    id,
    token_hash: await sha256Hex(token),
    install_id: installId,
    install_slug: installSlug,
    created_ms: createdMs,
    expires_ms: expiresMs,
    used_ms: usedMs,
    request_ip_hash: "",
  });
}

const contentLength = (body) => String(new TextEncoder().encode(String(body)).byteLength);

// --- Google OAuth test helpers ---
const OAUTH_STATE_COOKIE_NAME = "pp_oauth";
const GOOGLE_TEST_ENV = { AUTH_GOOGLE_ID: "gid.apps.googleusercontent.com", AUTH_GOOGLE_SECRET: "gsecret" };
function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fakeIdToken(claims) {
  return `${b64urlJson({ alg: "RS256", typ: "JWT" })}.${b64urlJson(claims)}.sig`;
}
function googleClaims(extra = {}) {
  return {
    aud: GOOGLE_TEST_ENV.AUTH_GOOGLE_ID,
    iss: "https://accounts.google.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "dj@example.com",
    email_verified: true,
    sub: "google-sub-1",
    ...extra,
  };
}
async function withGoogleTokenMock(idToken, fn, { status = 200 } = {}) {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (req.url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ id_token: idToken, access_token: "at" }),
        { status, headers: { "content-type": "application/json" } });
    }
    return oldFetch(input, init);
  };
  try { return await fn(); } finally { globalThis.fetch = oldFetch; }
}
function googleCallbackReq(db, { code = "auth-code", state = "s".repeat(32), cookieState = null, redirect = "/account" } = {}) {
  const cState = cookieState === null ? state : cookieState;
  const cookie = `${OAUTH_STATE_COOKIE_NAME}=g|${cState}|${encodeURIComponent(redirect)}`;
  return worker.fetch(new Request(
    `https://partyparty.party/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    { headers: { cookie, "cf-connecting-ip": "203.0.113.30", "user-agent": "smoke-oauth" } },
  ), makeEnv({ DB: db, env: GOOGLE_TEST_ENV }));
}

// --- Apple OAuth test helpers --- (generates a real P-256 .p8 so the ES256
// client-secret signing path actually runs)
async function makeAppleEnv() {
  const kp = await globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const b64 = Buffer.from(new Uint8Array(await globalThis.crypto.subtle.exportKey("pkcs8", kp.privateKey))).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
  return { AUTH_APPLE_ID: "net.ramine.party.web", AUTH_APPLE_TEAM_ID: "TEAM123456", AUTH_APPLE_KEY_ID: "KEY1234567", AUTH_APPLE_PRIVATE_KEY: pem };
}
function appleClaims(env, extra = {}) {
  return {
    aud: env.AUTH_APPLE_ID,
    iss: "https://appleid.apple.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: "dj@icloud.com",
    email_verified: "true",
    sub: "apple-sub-1",
    ...extra,
  };
}
async function withAppleTokenMock(idToken, fn, { status = 200 } = {}) {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (req.url === "https://appleid.apple.com/auth/token") {
      return new Response(JSON.stringify({ id_token: idToken, access_token: "at" }),
        { status, headers: { "content-type": "application/json" } });
    }
    return oldFetch(input, init);
  };
  try { return await fn(); } finally { globalThis.fetch = oldFetch; }
}
function appleCallbackReq(db, env, { code = "auth-code", state = "a".repeat(32), cookieState = null, redirect = "/account" } = {}) {
  const cState = cookieState === null ? state : cookieState;
  const cookie = `${OAUTH_STATE_COOKIE_NAME}=a|${cState}|${encodeURIComponent(redirect)}`;
  const body = new URLSearchParams({ state });
  if (code !== null) body.set("code", code);
  return worker.fetch(new Request("https://partyparty.party/auth/apple/callback", {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.31", "user-agent": "smoke-oauth" },
    body: body.toString(),
  }), makeEnv({ DB: db, env }));
}
function assertOAuthFailure(resp, db, error) {
  assert.equal(resp.status, 302);
  assert.equal(resp.headers.get("location"), `/login?error=${error}`);
  const sc = resp.headers.get("set-cookie") || "";
  assert.ok(!sc.includes("pp_session="), "does not set a session cookie");
  assert.equal(db.authSessions.size, 0, "does not create an auth session");
}

const tests = [
  ["parseCookies decodes cookie header", async () => {
    const req = new Request("https://partyparty.party/", {
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
    const good = new Request("https://partyparty.party/api", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
      headers: { "content-type": "application/json" },
    });
    assert.deepEqual(await readJson(good), { ok: true });

    const bad = new Request("https://partyparty.party/api", { method: "POST", body: "{" });
    assert.equal(await readJson(bad), null);

    const tooLarge = new Request("https://partyparty.party/api", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
      headers: { "content-length": "999" },
    });
    assert.equal(await readJson(tooLarge, 10), null);
  }],
  ["sendViaMXroute walks SMTP AUTH LOGIN over implicit TLS", async () => {
    const smtp = fakeSmtpConnect();
    const ok = await sendViaMXroute({
      AUTH_EMAIL_SERVER: "smtps://signin%40mail.example.test:p%40ssword@mail.mxrouting.test:465",
      AUTH_EMAIL_FROM: "partyparty <signin@mail.example.test>",
      BROKER_BASE: "partyparty.party",
      __TEST_SMTP_CONNECT: smtp.connect,
    }, "User@Example.COM", "https://partyparty.party/auth/verify?token=abc123");

    assert.equal(ok, true);
    assert.deepEqual(smtp.calls, [{
      address: { hostname: "mail.mxrouting.test", port: 465 },
      options: { secureTransport: "on" },
    }]);
    assert.deepEqual(smtp.writes.slice(0, 7), [
      "EHLO partyparty.party\r\n",
      "AUTH LOGIN\r\n",
      `${Buffer.from("signin@mail.example.test", "utf8").toString("base64")}\r\n`,
      `${Buffer.from("p@ssword", "utf8").toString("base64")}\r\n`,
      "MAIL FROM:<signin@mail.example.test>\r\n",
      "RCPT TO:<user@example.com>\r\n",
      "DATA\r\n",
    ]);
    assert.match(smtp.writes[7], /From: "partyparty" <signin@mail\.example\.test>/);
    assert.match(smtp.writes[7], /To: <user@example\.com>/);
    assert.match(smtp.writes[7], /Content-Type: multipart\/alternative; boundary="pp-[a-f0-9]+"/);
    assert.match(smtp.writes[7], /Sign in to partyparty/);
    assert.match(smtp.writes[7], /Continue to partyparty/);
    assert.ok(smtp.writes[7].endsWith("\r\n.\r\n"));
    assert.equal(smtp.writes[8], "QUIT\r\n");
    assert.equal(smtp.closed, false);
  }],
  ["sendViaMXroute upgrades smtp URLs with STARTTLS", async () => {
    const smtp = fakeStartTlsSmtpConnect();
    const ok = await sendViaMXroute({
      AUTH_EMAIL_SERVER: "smtp://signin%40mail.example.test:p%40ssword@mail.mxrouting.test:587",
      AUTH_EMAIL_FROM: "partyparty <signin@mail.example.test>",
      BROKER_BASE: "partyparty.party",
      __TEST_SMTP_CONNECT: smtp.connect,
    }, "starttls@example.com", "https://partyparty.party/auth/verify?token=starttls");

    assert.equal(ok, true);
    assert.deepEqual(smtp.calls, [{
      address: { hostname: "mail.mxrouting.test", port: 587 },
      options: { secureTransport: "starttls" },
    }]);
    assert.equal(smtp.upgraded, true);
    assert.deepEqual(smtp.writes.slice(0, 4), [
      "EHLO partyparty.party\r\n",
      "STARTTLS\r\n",
      "EHLO partyparty.party\r\n",
      "AUTH LOGIN\r\n",
    ]);
    assert.equal(smtp.writes[7], "RCPT TO:<starttls@example.com>\r\n");
  }],
  ["auth request-link gates devLink behind dev secret", async () => {
    const db = new FakeD1();
    const noHeader = await worker.fetch(new Request("https://partyparty.party/api/auth/request-link", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.20" },
      body: JSON.stringify({ email: " Person@Example.COM ", redirect: "/dashboard" }),
    }), makeEnv({ DB: db, env: { AUTH_DEV_LINKS: "1", AUTH_DEV_SECRET } }));
    const noHeaderJson = await noHeader.json();
    assert.equal(noHeader.status, 200);
    assert.equal(noHeaderJson.ok, true);
    assert.equal("devLink" in noHeaderJson, false);
    assert.equal(noHeaderJson.queued, false);

    const withHeader = await worker.fetch(new Request("https://partyparty.party/api/auth/request-link", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.21",
        "x-auth-dev-secret": AUTH_DEV_SECRET,
      },
      body: JSON.stringify({ email: " Dev@Example.COM ", redirect: "/dashboard" }),
    }), makeEnv({ DB: db, env: { AUTH_DEV_LINKS: "1", AUTH_DEV_SECRET } }));
    const withHeaderJson = await withHeader.json();
    assert.equal(withHeader.status, 200);
    assert.equal(withHeaderJson.ok, true);
    assert.match(withHeaderJson.devLink, /^https:\/\/partyparty\.party\/auth\/verify\?token=[a-f0-9]{64}$/);
    assert.equal("queued" in withHeaderJson, false);

    const failClosed = await worker.fetch(new Request("https://partyparty.party/api/auth/request-link", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.22",
        "x-auth-dev-secret": AUTH_DEV_SECRET,
      },
      body: JSON.stringify({ email: "closed@example.com" }),
    }), makeEnv({ DB: db, env: { AUTH_DEV_LINKS: "1" } }));
    const failClosedJson = await failClosed.json();
    assert.equal(failClosed.status, 200);
    assert.equal(failClosedJson.ok, true);
    assert.equal("devLink" in failClosedJson, false);
    assert.equal(failClosedJson.queued, false);

    assert.equal(db.authMagicTokens.size, 3);
    const token = new URL(withHeaderJson.devLink).searchParams.get("token");
    const row = [...db.authMagicTokens.values()].find((item) => item.email_norm === "dev@example.com");
    assert.equal(row.email_norm, "dev@example.com");
    assert.equal(row.redirect_path, "/dashboard");
    assert.notEqual(row.token_hash, token);
  }],
  ["auth request-link limits dev secret to configured emails", async () => {
    const db = new FakeD1();
    const denied = await worker.fetch(new Request("https://partyparty.party/api/auth/request-link", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.123",
        "x-auth-dev-secret": AUTH_DEV_SECRET,
      },
      body: JSON.stringify({ email: "other@example.com", redirect: "/account" }),
    }), makeEnv({ DB: db, env: { AUTH_DEV_LINKS: "1", AUTH_DEV_DIRECT: "1", AUTH_DEV_SECRET, AUTH_DEV_EMAILS: "ramine@ramine.net" } }));
    const deniedJson = await denied.json();
    assert.equal(denied.status, 200);
    assert.equal("devLink" in deniedJson, false);
    assert.equal(deniedJson.queued, false);

    const allowed = await worker.fetch(new Request("https://partyparty.party/api/auth/request-link", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.124",
        "x-auth-dev-secret": AUTH_DEV_SECRET,
      },
      body: JSON.stringify({ email: " Ramine@Ramine.NET ", redirect: "/account" }),
    }), makeEnv({ DB: db, env: { AUTH_DEV_LINKS: "1", AUTH_DEV_DIRECT: "1", AUTH_DEV_SECRET, AUTH_DEV_EMAILS: "ramine@ramine.net" } }));
    const allowedJson = await allowed.json();
    assert.equal(allowed.status, 200);
    assert.match(allowedJson.devLink, /^https:\/\/partyparty\.party\/auth\/verify\?token=[a-f0-9]{64}$/);
    // Sign-in mints a dj_profile and, until its handle is confirmed, routes
    // through the /welcome soft-gate (carrying the original redirect).
    assert.equal(allowedJson.redirect, "/welcome?redirect=%2Faccount");
    assert.match(allowed.headers.get("set-cookie") || "", /pp_session=[a-f0-9]{64}/);
    assert.equal("queued" in allowedJson, false);
  }],
  ["auth request-link sends through AUTH_EMAIL_SERVER before EMAIL binding", async () => {
    const db = new FakeD1();
    const smtp = fakeSmtpConnect();
    const fallback = [];
    const resp = await worker.fetch(new Request("https://partyparty.party/api/auth/request-link", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.29",
      },
      body: JSON.stringify({ email: "mxroute@example.com", redirect: "/account" }),
    }), makeEnv({
      DB: db,
      env: {
        AUTH_EMAIL_SERVER: "smtps://signin%40mail.example.test:p%40ssword@mail.mxrouting.test:465",
        AUTH_EMAIL_FROM: "partyparty <signin@mail.example.test>",
        __TEST_SMTP_CONNECT: smtp.connect,
        EMAIL: {
          send: async (message) => {
            fallback.push(message);
            return { messageId: "fallback" };
          },
        },
      },
    }));
    const json = await resp.json();
    assert.equal(resp.status, 200);
    assert.deepEqual(json, { ok: true });
    assert.equal(smtp.calls.length, 1);
    assert.equal(fallback.length, 0);
    assert.equal(smtp.writes[5], "RCPT TO:<mxroute@example.com>\r\n");
    assert.match(smtp.writes[7], /https:\/\/partyparty\.party\/auth\/verify\?token=[a-f0-9]{64}/);
  }],
  ["auth request-link sends through EMAIL binding when configured", async () => {
    const db = new FakeD1();
    const sent = [];
    const resp = await worker.fetch(new Request("https://partyparty.party/api/auth/request-link", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.28",
      },
      body: JSON.stringify({ email: "mail@example.com", redirect: "/account" }),
    }), makeEnv({
      DB: db,
      env: {
        AUTH_EMAIL_FROM: "partyparty <signin@partyparty.party>",
        EMAIL: {
          send: async (message) => {
            sent.push(message);
            return { messageId: "msg-1" };
          },
        },
      },
    }));
    const json = await resp.json();
    assert.equal(resp.status, 200);
    assert.deepEqual(json, { ok: true });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "mail@example.com");
    assert.deepEqual(sent[0].from, { email: "signin@partyparty.party", name: "partyparty" });
    assert.match(sent[0].subject, /Sign in/);
    assert.match(sent[0].text, /https:\/\/partyparty\.party\/auth\/verify\?token=[a-f0-9]{64}/);
    assert.match(sent[0].html, /Continue to partyparty/);
  }],
  ["auth verify confirms on GET and consumes on POST", async () => {
    const db = new FakeD1();
    const devLink = await requestDevLink(db, "login@example.com", { ip: "203.0.113.23", redirect: "/after-login?ok=1" });
    const token = new URL(devLink).searchParams.get("token");
    const row = [...db.authMagicTokens.values()][0];

    const confirm = await worker.fetch(new Request(devLink, {
      headers: { "cf-connecting-ip": "203.0.113.21", "user-agent": "smoke-auth" },
    }), makeEnv({ DB: db }));
    const confirmHtml = await confirm.text();
    assert.equal(confirm.status, 200);
    assert.match(confirmHtml, /Sign in to partyparty/);
    assert.match(confirmHtml, /method="POST" action="\/auth\/verify"/);
    assert.equal(row.used_ms, null);
    assert.equal(db.authUsers.size, 0);
    assert.equal(db.authSessions.size, 0);

    const head = await worker.fetch(new Request(devLink, { method: "HEAD" }), makeEnv({ DB: db }));
    assert.equal(head.status, 405);
    assert.equal(row.used_ms, null);
    assert.equal(db.authSessions.size, 0);

    const anon = await worker.fetch(new Request("https://partyparty.party/api/me"), makeEnv({ DB: db }));
    assert.deepEqual(await anon.json(), { user: null });

    const verify = await postVerify(db, token, { ip: "203.0.113.21" });
    const cookie = verify.headers.get("set-cookie") || "";
    assert.equal(verify.status, 302);
    // First sign-in mints a dj_profile and routes through the /welcome soft-gate,
    // carrying the original post-login destination.
    assert.equal(verify.headers.get("location"), "/welcome?redirect=%2Fafter-login%3Fok%3D1");
    assert.match(cookie, /pp_session=[a-f0-9]{64}/);
    assert.equal(db.authUsers.size, 1);
    assert.equal(db.authSessions.size, 1);
    assert.equal([...db.authUsers.values()][0].email, "login@example.com");

    const reused = await postVerify(db, token);
    assert.equal(reused.status, 400);
    assert.match(await reused.text(), /sign-in link expired/i);
  }],
  ["auth verify rejects expired token", async () => {
    const db = new FakeD1();
    const rawToken = "a".repeat(64);
    db.authMagicTokens.set("expired-token", {
      id: "expired-token",
      token_hash: await sha256Hex(rawToken),
      email_norm: "expired@example.com",
      user_id: null,
      purpose: "login",
      redirect_path: "/",
      created_ms: Date.now() - 1200000,
      expires_ms: Date.now() - 1000,
      used_ms: null,
      request_ip_hash: await sha256Hex("ip:203.0.113.22"),
      user_agent_hash: await sha256Hex("smoke"),
    });
    const resp = await worker.fetch(new Request(`https://partyparty.party/auth/verify?token=${rawToken}`), makeEnv({ DB: db }));
    assert.equal(resp.status, 400);
    assert.equal(db.authUsers.size, 0);
    assert.equal(db.authSessions.size, 0);
  }],
  ["auth me and logout use session cookie without leaking tokens", async () => {
    const db = new FakeD1();
    const devLink = await requestDevLink(db, "me@example.com", { ip: "203.0.113.24" });
    const token = new URL(devLink).searchParams.get("token");
    const verify = await postVerify(db, token, { ip: "203.0.113.24" });
    const cookie = (verify.headers.get("set-cookie") || "").split(";")[0];

    const anon = await worker.fetch(new Request("https://partyparty.party/api/me"), makeEnv({ DB: db }));
    assert.deepEqual(await anon.json(), { user: null });

    const me = await worker.fetch(new Request("https://partyparty.party/api/me", {
      headers: { cookie },
    }), makeEnv({ DB: db }));
    const meJson = await me.json();
    assert.equal(me.status, 200);
    assert.deepEqual(Object.keys(meJson.user).sort(), ["display_name", "email", "id"]);
    assert.equal(meJson.user.email, "me@example.com");

    const logout = await worker.fetch(new Request("https://partyparty.party/api/auth/logout", {
      method: "POST",
      headers: { cookie },
    }), makeEnv({ DB: db }));
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") || "", /pp_session=; Max-Age=0/);

    const after = await worker.fetch(new Request("https://partyparty.party/api/me", {
      headers: { cookie },
    }), makeEnv({ DB: db }));
    assert.deepEqual(await after.json(), { user: null });
  }],
  ["auth verify signs in existing user through conflict-safe insert", async () => {
    const db = new FakeD1({
      authUsers: [{
        id: "existing-user",
        email: "existing@example.com",
        email_norm: "existing@example.com",
        display_name: "Existing",
        created_ms: 1,
        updated_ms: 1,
        email_verified_ms: 1,
        last_login_ms: 1,
        disabled_ms: null,
      }],
    });
    const devLink = await requestDevLink(db, "existing@example.com", { ip: "203.0.113.25" });
    const token = new URL(devLink).searchParams.get("token");
    const verify = await postVerify(db, token, { ip: "203.0.113.25" });
    assert.equal(verify.status, 302);
    assert.equal(db.authUsers.size, 1);
    assert.equal([...db.authSessions.values()][0].user_id, "existing-user");
    assert.ok(Number(db.authUsers.get("existing-user").last_login_ms) > 1);
  }],
  ["auth request-link rate limits after sane cap", async () => {
    const db = new FakeD1();
    const env = makeEnv({ DB: db, env: { AUTH_DEV_LINKS: "1", AUTH_DEV_SECRET } });
    let resp;
    for (let i = 0; i < 5; i += 1) {
      resp = await worker.fetch(new Request("https://partyparty.party/api/auth/request-link", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.24" },
        body: JSON.stringify({ email: `rate-${i}@example.com` }),
      }), env);
      assert.equal(resp.status, 200);
    }
    resp = await worker.fetch(new Request("https://partyparty.party/api/auth/request-link", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.24" },
      body: JSON.stringify({ email: "rate-final@example.com" }),
    }), env);
    assert.equal(resp.status, 429);
  }],
  ["auth request-link lets allowlisted admin bypass rate limit", async () => {
    const createdMs = Date.now();
    const ipHash = await sha256Hex("ip:203.0.113.24");
    const authMagicTokens = Array.from({ length: 5 }, (_, i) => ({
      id: `rate-token-${i}`,
      token_hash: `rate-token-hash-${i}`,
      email_norm: `rate-${i}@example.com`,
      redirect_path: "/",
      created_ms: createdMs,
      expires_ms: createdMs + 60_000,
      used_ms: null,
      request_ip_hash: ipHash,
      user_agent_hash: "",
    }));
    const db = new FakeD1({ authMagicTokens });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/auth/request-link", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.24",
        "x-auth-dev-secret": AUTH_DEV_SECRET,
      },
      body: JSON.stringify({ email: "Ramine@Ramine.NET", redirect: "/account" }),
    }), makeEnv({ DB: db, env: { AUTH_DEV_LINKS: "1", AUTH_DEV_DIRECT: "1", AUTH_DEV_SECRET, AUTH_DEV_EMAILS: "ramine@ramine.net" } }));
    const json = await resp.json();
    assert.equal(resp.status, 200);
    assert.equal(json.ok, true);
    assert.match(json.devLink, /^https:\/\/partyparty\.party\/auth\/verify\?token=/);
    // First sign-in mints a dj_profile and lands on the /welcome soft-gate.
    assert.equal(json.redirect, "/welcome?redirect=%2Faccount");
    assert.match(resp.headers.get("set-cookie") || "", /pp_session=[a-f0-9]{64}/);
  }],
  ["auth request-link does not reveal account existence", async () => {
    const db = new FakeD1({
      authUsers: [{
        id: "known-user",
        email: "known@example.com",
        email_norm: "known@example.com",
        display_name: "Known",
        created_ms: 1,
        updated_ms: 1,
        email_verified_ms: 1,
        last_login_ms: 1,
        disabled_ms: null,
      }],
    });
    const known = await worker.fetch(new Request("https://partyparty.party/api/auth/request-link", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.26", "x-auth-dev-secret": AUTH_DEV_SECRET },
      body: JSON.stringify({ email: "known@example.com" }),
    }), makeEnv({ DB: db, env: { AUTH_DEV_LINKS: "1", AUTH_DEV_SECRET } }));
    const unknown = await worker.fetch(new Request("https://partyparty.party/api/auth/request-link", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.27", "x-auth-dev-secret": AUTH_DEV_SECRET },
      body: JSON.stringify({ email: "unknown@example.com" }),
    }), makeEnv({ DB: db, env: { AUTH_DEV_LINKS: "1", AUTH_DEV_SECRET } }));
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.deepEqual(Object.keys(await known.json()).sort(), ["devLink", "ok"]);
    assert.deepEqual(Object.keys(await unknown.json()).sort(), ["devLink", "ok"]);
  }],
  ["account redirects anonymous users to login", async () => {
    const resp = await worker.fetch(new Request("https://partyparty.party/account"), makeEnv({ DB: new FakeD1() }));
    assert.equal(resp.status, 302);
    assert.equal(resp.headers.get("location"), "/login?redirect=/account");
  }],
  ["account renders signed-in user shell", async () => {
    const db = new FakeD1();
    const cookie = await signInCookie(db, "acct@example.com", { ip: "203.0.113.28" });
    const user = [...db.authUsers.values()][0];
    db.profiles.push({
      id: "profile-account",
      user_id: user.id,
      handle: "acct.dj",
      display_name: "Account DJ",
      published: 1,
    });
    db.deviceInstalls.set("install-account", { install_id: "install-account", user_id: user.id, profile_id: "profile-account" });
    db.events.set("owned-account", {
      slug: "owned-account",
      owner_user_id: user.id,
      title: "Owned Account Night",
      status: "upcoming",
      scheduled_at_ms: 1893542400000,
    });

    const resp = await worker.fetch(new Request("https://partyparty.party/account", {
      headers: { cookie },
    }), makeEnv({ DB: db }));
    const html = await resp.text();
    assert.equal(resp.status, 200);
    assert.match(html, /acct@example\.com/);
    assert.match(html, /Sign out/);
    assert.match(html, /acct\.dj/);
    assert.match(html, /href="\/profile\/edit"/);
    assert.match(html, /href="\/events\/new">＋ Create event/);
    assert.match(html, /Owned Account Night/);
    assert.match(html, /Link your Mac/);
    assert.match(html, /Sign in to link this Mac|choose Sign in to link this Mac/);
    assert.match(html, /Older app version only/);
    assert.match(html, /install-link-create/);
  }],
  ["install-link create gates auth and profile, then returns a one-time code", async () => {
    const anon = await worker.fetch(new Request("https://partyparty.party/api/install-link/create", {
      method: "POST",
    }), makeEnv({ DB: new FakeD1() }));
    assert.equal(anon.status, 401);

    const db = new FakeD1();
    const cookie = await signInCookie(db, "link-create@example.com", { ip: "203.0.113.29" });
    const noProfile = await worker.fetch(new Request("https://partyparty.party/api/install-link/create", {
      method: "POST",
      headers: { cookie },
    }), makeEnv({ DB: db }));
    assert.equal(noProfile.status, 400);

    const user = [...db.authUsers.values()][0];
    db.profiles.push({
      id: "profile-link-create",
      user_id: user.id,
      handle: "link.create",
      display_name: "Link Create",
      published: 1,
    });
    const created = await worker.fetch(new Request("https://partyparty.party/api/install-link/create", {
      method: "POST",
      headers: { cookie },
    }), makeEnv({ DB: db }));
    const json = await created.json();
    const token = [...db.installLinkTokens.values()][0];
    assert.equal(created.status, 200);
    assert.equal(json.ok, true);
    assert.match(json.code, /^[a-f0-9]{32}$/);
    assert.equal(typeof json.expiresMs, "number");
    assert.equal(db.installLinkTokens.size, 1);
    assert.equal(token.user_id, user.id);
    assert.equal(token.profile_id, "profile-link-create");
    assert.notEqual(token.code_hash, json.code);
    assert.equal(token.install_id, null);
    assert.equal(token.used_ms, null);
  }],
  ["broker link-start returns a browser sign-in URL for a valid install", async () => {
    const db = new FakeD1();
    const bad = await worker.fetch(new Request("https://partyparty.party/api/broker/link-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "wrong" }),
    }), makeEnv({ DB: db }));
    assert.equal(bad.status, 403);

    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/link-start", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.30" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a" }),
    }), makeEnv({ DB: db }));
    const json = await resp.json();
    const url = new URL(json.url);
    const rawToken = url.searchParams.get("token") || "";
    const token = [...db.installBrowserTokens.values()][0];
    assert.equal(resp.status, 200);
    assert.equal(json.ok, true);
    assert.equal(url.pathname, "/link-mac");
    assert.match(rawToken, /^[a-f0-9]{64}$/);
    assert.equal(db.installBrowserTokens.size, 1);
    assert.equal(token.install_id, "abc123abc123");
    assert.equal(token.install_slug, "disco12");
    assert.notEqual(token.token_hash, rawToken);
    assert.equal(token.used_ms, null);
  }],
  ["broker account-status reports unlinked and linked install state", async () => {
    const db = new FakeD1();
    const unlinked = await worker.fetch(new Request("https://partyparty.party/api/broker/account-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a" }),
    }), makeEnv({ DB: db }));
    const unlinkedJson = await unlinked.json();
    assert.equal(unlinked.status, 200);
    assert.equal(unlinkedJson.ok, true);
    assert.equal(unlinkedJson.providersAvailable, false);
    assert.equal(unlinkedJson.linked, false);
    assert.equal(unlinkedJson.install.slug, "disco12");
    assert.equal(unlinkedJson.license.ok, false);

    const providersOn = await worker.fetch(new Request("https://partyparty.party/api/broker/account-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a" }),
    }), makeEnv({ DB: db, env: GOOGLE_TEST_ENV }));
    assert.equal((await providersOn.json()).providersAvailable, true);

    db.authUsers.set("user-account-status", {
      id: "user-account-status",
      email: "linked@example.com",
      email_norm: "linked@example.com",
      display_name: "Linked User",
      created_ms: 1,
      updated_ms: 1,
      email_verified_ms: 1,
      last_login_ms: 1,
      disabled_ms: null,
    });
    db.profiles.push({
      id: "profile-account-status",
      user_id: "user-account-status",
      handle: "linked.dj",
      display_name: "Linked DJ",
      published: 1,
    });
    db.deviceInstalls.set("abc123abc123", {
      install_id: "abc123abc123",
      install_slug: "disco12",
      user_id: "user-account-status",
      profile_id: "profile-account-status",
      created_ms: 1,
      linked_ms: 1,
      last_seen_ms: 1,
      revoked_ms: null,
    });
    db.events.set("linked-event", {
      slug: "linked-event",
      install_id: "abc123abc123",
      owner_user_id: "user-account-status",
      title: "Linked Event",
      status: "live",
      scheduled_at_ms: 1893542400000,
    });
    db.liveInstalls.set("abc123abc123", {
      install_id: "abc123abc123", handle: "linked.dj", host: "disco12.party.party.example.test",
      event_slug: "linked-event", expires_ms: Date.now() + 60_000,
    });

    const linked = await worker.fetch(new Request("https://partyparty.party/api/broker/account-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a" }),
    }), makeEnv({ DB: db }));
    const linkedJson = await linked.json();
    assert.equal(linked.status, 200);
    assert.equal(linkedJson.providersAvailable, false);
    assert.equal(linkedJson.linked, true);
    assert.equal(linkedJson.user.email, "linked@example.com");
    assert.equal(linkedJson.profile.handle, "linked.dj");
    assert.equal(linkedJson.license.ok, true);
    assert.equal(linkedJson.events[0].slug, "linked-event");

    const unlinkResp = await worker.fetch(new Request("https://partyparty.party/api/broker/account-unlink", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a" }),
    }), makeEnv({ DB: db }));
    const unlinkJson = await unlinkResp.json();
    assert.equal(unlinkResp.status, 200);
    assert.equal(unlinkJson.ok, true);
    assert.equal(unlinkJson.revoked, 1);
    assert.equal(typeof db.deviceInstalls.get("abc123abc123").revoked_ms, "number");
    assert.equal(db.liveInstalls.has("abc123abc123"), false);
    assert.equal(db.events.get("linked-event").status, "replay");

    const after = await worker.fetch(new Request("https://partyparty.party/api/broker/account-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a" }),
    }), makeEnv({ DB: db }));
    const afterJson = await after.json();
    assert.equal(after.status, 200);
    assert.equal(afterJson.linked, false);
  }],
  ["broker registration throttles repeated unauthenticated R2 writes", async () => {
    const oldCache = globalThis.caches.default;
    const entries = new Map();
    globalThis.caches.default = {
      match: async (request) => entries.get(request.url)?.clone() || null,
      put: async (request, response) => { entries.set(request.url, response.clone()); },
    };
    try {
      const env = makeEnv();
      const register = () => worker.fetch(new Request("https://partyparty.party/api/broker/register", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.77" },
        body: "{}",
      }), env);
      const first = await register();
      const second = await register();
      assert.equal(first.status, 200);
      assert.equal(second.status, 429);
      assert.equal((await second.json()).error, "slow down");
      assert.equal([...env.DL.objects.keys()].filter((key) => /^broker\/[a-f0-9]{12}\.json$/.test(key)).length, 3);
    } finally {
      globalThis.caches.default = oldCache;
    }
  }],
  ["link-mac redirects through sign-in then links install to the account", async () => {
    const rawToken = "4444444444444444444444444444444444444444444444444444444444444444";
    const db = new FakeD1();
    await seedInstallBrowserToken(db, { id: "browser-token-ok", token: rawToken });

    const anon = await worker.fetch(new Request(`https://partyparty.party/link-mac?token=${rawToken}`), makeEnv({ DB: db }));
    assert.equal(anon.status, 302);
    assert.equal(anon.headers.get("location"), `/login?redirect=${encodeURIComponent(`/link-mac?token=${rawToken}`)}`);
    assert.equal(db.installBrowserTokens.get("browser-token-ok").used_ms, null);

    const cookie = await signInCookie(db, "browser-link@example.com", { ip: "203.0.113.31" });
    const user = [...db.authUsers.values()].find((row) => row.email_norm === "browser-link@example.com");
    // Authenticated GET only CONFIRMS now — no bind, token still unused.
    const confirm = await worker.fetch(new Request(`https://partyparty.party/link-mac?token=${rawToken}`, {
      headers: { cookie },
    }), makeEnv({ DB: db }));
    const confirmHtml = await confirm.text();
    assert.equal(confirm.status, 200);
    assert.match(confirmHtml, /Link this Mac/);
    assert.match(confirmHtml, /method="POST"/i);
    assert.equal(db.installBrowserTokens.get("browser-token-ok").used_ms, null);
    assert.equal(db.deviceInstalls.has("abc123abc123"), false);

    // The same-site POST performs the bind.
    const linked = await worker.fetch(new Request(`https://partyparty.party/link-mac`, {
      method: "POST",
      headers: { cookie, origin: "https://partyparty.party", "content-type": "application/x-www-form-urlencoded" },
      body: `token=${rawToken}`,
    }), makeEnv({ DB: db }));
    const html = await linked.text();
    const install = db.deviceInstalls.get("abc123abc123");
    const profile = db.profiles.find((row) => row.user_id === user.id);
    assert.equal(linked.status, 200);
    assert.match(html, /Mac linked/);
    assert.ok(profile?.id);
    assert.equal(profile.handle, "browser.link");
    assert.equal(install.user_id, user.id);
    assert.equal(install.profile_id, profile.id);
    assert.equal(install.revoked_ms, null);
    assert.equal(typeof db.installBrowserTokens.get("browser-token-ok").used_ms, "number");
  }],
  ["link-mac blocks CSRF: authed GET does not bind, cross-site POST rejected", async () => {
    const rawToken = "5555555555555555555555555555555555555555555555555555555555555555";
    const db = new FakeD1();
    await seedInstallBrowserToken(db, { id: "browser-token-csrf", token: rawToken });
    const cookie = await signInCookie(db, "csrf-victim@example.com", { ip: "203.0.113.32" });

    const get = await worker.fetch(new Request(`https://partyparty.party/link-mac?token=${rawToken}`, {
      headers: { cookie },
    }), makeEnv({ DB: db }));
    assert.equal(get.status, 200);
    assert.equal(db.installBrowserTokens.get("browser-token-csrf").used_ms, null);
    assert.equal(db.deviceInstalls.has("abc123abc123"), false);

    const evil = await worker.fetch(new Request(`https://partyparty.party/link-mac`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: `token=${rawToken}`,
    }), makeEnv({ DB: db }));
    const evilHtml = await evil.text();
    assert.match(evilHtml, /Link blocked/);
    assert.equal(db.installBrowserTokens.get("browser-token-csrf").used_ms, null);
    assert.equal(db.deviceInstalls.has("abc123abc123"), false);
  }],
  ["broker link-install rejects bad secret", async () => {
    const rawCode = "badc0dedbadc0dedbadc0dedbadc0ded";
    const db = new FakeD1({
      profiles: [{
        id: "profile-bad-secret",
        user_id: "user-bad-secret",
        handle: "bad.secret",
        published: 1,
      }],
      installLinkTokens: [{
        id: "token-bad-secret",
        code_hash: await sha256Hex(rawCode),
        user_id: "user-bad-secret",
        profile_id: "profile-bad-secret",
        install_id: null,
        created_ms: Date.now(),
        expires_ms: Date.now() + 60_000,
        used_ms: null,
      }],
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/link-install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "wrong", code: rawCode }),
    }), makeEnv({ DB: db }));
    assert.equal(resp.status, 403);
    assert.equal(db.installLinkTokens.get("token-bad-secret").used_ms, null);
    assert.equal(db.deviceInstalls.has("abc123abc123"), false);
  }],
  ["broker link-install rejects active cross-account takeover but allows same-user relink", async () => {
    const otherCode = "11111111111111111111111111111111";
    const sameCode = "22222222222222222222222222222222";
    const db = new FakeD1({
      profiles: [{
        id: "profile-old",
        user_id: "user-old",
        handle: "old.link",
        published: 1,
      }, {
        id: "profile-new",
        user_id: "user-new",
        handle: "new.link",
        published: 1,
      }, {
        id: "profile-old-next",
        user_id: "user-old",
        handle: "old.next",
        published: 1,
      }],
      deviceInstalls: [{
        install_id: "abc123abc123",
        install_slug: "disco12",
        user_id: "user-old",
        profile_id: "profile-old",
        created_ms: Date.now() - 10_000,
        linked_ms: Date.now() - 10_000,
        last_seen_ms: Date.now() - 10_000,
        revoked_ms: null,
      }],
    });
    await seedInstallLinkToken(db, { id: "token-other-user", code: otherCode, userId: "user-new", profileId: "profile-new" });
    await seedInstallLinkToken(db, { id: "token-same-user", code: sameCode, userId: "user-old", profileId: "profile-old-next" });

    const takeover = await worker.fetch(new Request("https://partyparty.party/api/broker/link-install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", code: otherCode }),
    }), makeEnv({ DB: db }));
    assert.equal(takeover.status, 409);
    assert.equal(db.installLinkTokens.get("token-other-user").used_ms, null);
    assert.equal(db.deviceInstalls.get("abc123abc123").user_id, "user-old");
    assert.equal(db.deviceInstalls.get("abc123abc123").profile_id, "profile-old");

    const same = await worker.fetch(new Request("https://partyparty.party/api/broker/link-install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", code: sameCode }),
    }), makeEnv({ DB: db }));
    assert.equal(same.status, 200);
    assert.equal(db.installLinkTokens.get("token-same-user").install_id, "abc123abc123");
    assert.equal(db.deviceInstalls.get("abc123abc123").user_id, "user-old");
    assert.equal(db.deviceInstalls.get("abc123abc123").profile_id, "profile-old-next");
    assert.equal(db.deviceInstalls.get("abc123abc123").revoked_ms, null);
  }],
  ["install-link unlink revokes owner link and permits later relink to a new account", async () => {
    const db = new FakeD1();
    const cookie = await signInCookie(db, "unlink-owner@example.com", { ip: "203.0.113.31" });
    const owner = [...db.authUsers.values()][0];
    db.profiles.push({
      id: "profile-unlink-owner",
      user_id: owner.id,
      handle: "unlink.owner",
      display_name: "Unlink Owner",
      published: 1,
    });
    db.deviceInstalls.set("abc123abc123", {
      install_id: "abc123abc123",
      install_slug: "disco12",
      user_id: owner.id,
      profile_id: "profile-unlink-owner",
      label: "",
      created_ms: Date.now() - 10_000,
      linked_ms: Date.now() - 10_000,
      last_seen_ms: Date.now() - 10_000,
      revoked_ms: null,
    });
    db.events.set("unlink-live", {
      slug: "unlink-live", install_id: "abc123abc123", owner_user_id: owner.id,
      dj_profile_id: "profile-unlink-owner", title: "Unlink Live", status: "live",
    });
    db.liveInstalls.set("abc123abc123", {
      install_id: "abc123abc123", handle: "unlink.owner", host: "disco12.party.party.example.test",
      event_slug: "unlink-live", expires_ms: Date.now() + 60_000,
    });

    const unlink = await worker.fetch(new Request("https://partyparty.party/api/install-link/unlink", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ install_id: "abc123abc123" }),
    }), makeEnv({ DB: db }));
    const unlinkJson = await unlink.json();
    assert.equal(unlink.status, 200);
    assert.deepEqual(unlinkJson, { ok: true, revoked: 1 });
    assert.equal(typeof db.deviceInstalls.get("abc123abc123").revoked_ms, "number");
    assert.equal(db.liveInstalls.has("abc123abc123"), false);
    assert.equal(db.events.get("unlink-live").status, "replay");

    const relinkCode = "33333333333333333333333333333333";
    db.profiles.push({
      id: "profile-relink-new",
      user_id: "user-relink-new",
      handle: "relink.new",
      published: 1,
    });
    await seedInstallLinkToken(db, { id: "token-relink-new", code: relinkCode, userId: "user-relink-new", profileId: "profile-relink-new" });
    const relink = await worker.fetch(new Request("https://partyparty.party/api/broker/link-install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", code: relinkCode }),
    }), makeEnv({ DB: db }));
    assert.equal(relink.status, 200);
    assert.equal(db.deviceInstalls.get("abc123abc123").user_id, "user-relink-new");
    assert.equal(db.deviceInstalls.get("abc123abc123").profile_id, "profile-relink-new");
    assert.equal(db.deviceInstalls.get("abc123abc123").revoked_ms, null);
  }],
  ["revoked device install cannot publish or unlock profile events-window", async () => {
    const now = Date.now();
    const db = new FakeD1({
      deviceInstalls: [{
        install_id: "abc123abc123",
        install_slug: "disco12",
        user_id: "user-revoked",
        profile_id: "profile-revoked",
        created_ms: now - 10_000,
        linked_ms: now - 10_000,
        last_seen_ms: now - 10_000,
        revoked_ms: now - 1_000,
      }],
      events: [{
        slug: "profile-only-window",
        install_id: "def456def456",
        title: "Profile Only Window",
        status: "upcoming",
        dj_profile_id: "profile-revoked",
        scheduled_at_ms: now + 60_000,
        updated_ms: now,
      }, {
        slug: "revoked-existing",
        install_id: "abc123abc123",
        title: "Revoked Existing",
        status: "upcoming",
        updated_ms: now,
      }],
    });

    // A revoked install is no longer linked → cloud publish is refused outright
    // (going live online requires a live account link).
    const publishMeta = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-meta", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "revoked-publish", title: "Revoked Publish" }),
    }), makeEnv({ DB: db }));
    assert.equal(publishMeta.status, 403);
    assert.equal(db.events.has("revoked-publish"), false);

    const eventUpsert = await worker.fetch(new Request("https://partyparty.party/api/broker/event-upsert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "revoked-upsert", title: "Revoked Upsert" }),
    }), makeEnv({ DB: db }));
    assert.equal(eventUpsert.status, 403);
    assert.equal(db.events.has("revoked-upsert"), false);

    // Retaining the broker secret must not let a revoked Mac mutate an event it
    // already owns through a route downstream of event creation.
    const eventStatus = await worker.fetch(new Request("https://partyparty.party/api/broker/event-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "revoked-existing", status: "live" }),
    }), makeEnv({ DB: db }));
    assert.equal(eventStatus.status, 403);
    assert.equal(db.events.get("revoked-existing").status, "upcoming");

    const mirrorEnv = makeEnv({ DB: db });
    const liveSegment = await worker.fetch(new Request("https://partyparty.party/api/broker/live-segment", {
      method: "PUT",
      headers: {
        "x-pp-id": "abc123abc123", "x-pp-secret": "secret-a", "x-pp-slug": "revoked-existing",
        "x-pp-file": "live0.ts", "content-length": "6",
      },
      body: "tsdata",
    }), mirrorEnv);
    assert.equal(liveSegment.status, 403);
    assert.equal(await mirrorEnv.DL.get("event/revoked-existing/live/live0.ts"), null);

    const windowResp = await worker.fetch(new Request("https://partyparty.party/api/broker/events-window", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", since_ms: now - 86_400_000, until_ms: now + 86_400_000 }),
    }), makeEnv({ DB: db }));
    const windowJson = await windowResp.json();
    assert.equal(windowResp.status, 200);
    assert.equal(windowJson.events.some((event) => event.slug === "profile-only-window"), false);
  }],
  ["cloud publish requires a linked account: unlinked install is refused, linked one passes", async () => {
    // Unlinked (registered in R2, but no device_installs link) → publish refused.
    const unlinked = new FakeD1();
    const metaU = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-meta", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "needs-link", title: "Nope" }),
    }), makeEnv({ DB: unlinked }));
    assert.equal(metaU.status, 403);
    assert.equal(JSON.parse(await metaU.text()).reason, "not_linked");
    assert.equal(unlinked.events.has("needs-link"), false);
    const upsertU = await worker.fetch(new Request("https://partyparty.party/api/broker/event-upsert", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "needs-link2", title: "Nope" }),
    }), makeEnv({ DB: unlinked }));
    assert.equal(upsertU.status, 403);
    assert.equal(unlinked.events.has("needs-link2"), false);

    // Linked → publish succeeds.
    const linked = new FakeD1({
      deviceInstalls: [{ install_id: "abc123abc123", user_id: "user-lp", profile_id: "profile-lp" }],
    });
    const metaL = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-meta", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "linked-pub", title: "Yes" }),
    }), makeEnv({ DB: linked }));
    assert.equal(metaL.status, 200);
    assert.equal(linked.events.get("linked-pub").dj_profile_id, "profile-lp");

    // Escape hatch: BROKER_ALLOW_UNLINKED_PUBLISH=1 lets an unlinked install publish.
    const hatch = new FakeD1();
    const metaH = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-meta", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "hatch-pub", title: "Hatch" }),
    }), makeEnv({ DB: hatch, env: { BROKER_ALLOW_UNLINKED_PUBLISH: "1" } }));
    assert.equal(metaH.status, 200);
  }],
  ["broker link-install throttles repeated bad code guesses per install", async () => {
    const env = makeEnv({ DB: new FakeD1() });
    for (let i = 0; i < 10; i += 1) {
      const guess = String(i).padStart(32, "0");
      const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/link-install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", code: guess }),
      }), env);
      assert.equal(resp.status, 400);
    }
    const throttled = await worker.fetch(new Request("https://partyparty.party/api/broker/link-install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", code: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    }), env);
    assert.equal(throttled.status, 429);
  }],
  ["broker link-install binds install, rejects reuse and expired codes, then stamps broker writes", async () => {
    const db = new FakeD1();
    const cookie = await signInCookie(db, "link-ok@example.com", { ip: "203.0.113.30" });
    const user = [...db.authUsers.values()][0];
    db.profiles.push({
      id: "profile-link-ok",
      user_id: user.id,
      handle: "link.ok",
      display_name: "Link OK",
      published: 1,
    });
    const create = await worker.fetch(new Request("https://partyparty.party/api/install-link/create", {
      method: "POST",
      headers: { cookie },
    }), makeEnv({ DB: db }));
    const code = (await create.json()).code;

    const link = await worker.fetch(new Request("https://partyparty.party/api/broker/link-install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", code }),
    }), makeEnv({ DB: db }));
    const linkJson = await link.json();
    const install = db.deviceInstalls.get("abc123abc123");
    const token = [...db.installLinkTokens.values()][0];
    assert.equal(link.status, 200);
    assert.deepEqual(linkJson, { ok: true, handle: "link.ok" });
    assert.equal(token.install_id, "abc123abc123");
    assert.equal(typeof token.used_ms, "number");
    assert.equal(install.install_slug, "disco12");
    assert.equal(install.user_id, user.id);
    assert.equal(install.profile_id, "profile-link-ok");
    assert.equal(typeof install.linked_ms, "number");

    const reused = await worker.fetch(new Request("https://partyparty.party/api/broker/link-install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", code }),
    }), makeEnv({ DB: db }));
    assert.equal(reused.status, 400);

    const expiredCode = "feedcafefeedcafefeedcafefeedcafe";
    db.installLinkTokens.set("expired-install-link", {
      id: "expired-install-link",
      code_hash: await sha256Hex(expiredCode),
      user_id: user.id,
      profile_id: "profile-link-ok",
      install_id: null,
      created_ms: Date.now() - 120_000,
      expires_ms: Date.now() - 1,
      used_ms: null,
    });
    const expired = await worker.fetch(new Request("https://partyparty.party/api/broker/link-install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", code: expiredCode }),
    }), makeEnv({ DB: db }));
    assert.equal(expired.status, 400);
    assert.equal(db.installLinkTokens.get("expired-install-link").used_ms, null);

    const publishMeta = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-meta", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "abc123abc123",
        secret: "secret-a",
        slug: "linked-publish",
        title: "Linked Publish",
      }),
    }), makeEnv({ DB: db }));
    const publishRow = db.events.get("linked-publish");
    assert.equal(publishMeta.status, 200);
    assert.equal(publishRow.owner_user_id, user.id);
    assert.equal(publishRow.dj_profile_id, "profile-link-ok");

    const eventUpsert = await worker.fetch(new Request("https://partyparty.party/api/broker/event-upsert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "abc123abc123",
        secret: "secret-a",
        slug: "linked-upsert",
        title: "Linked Upsert",
      }),
    }), makeEnv({ DB: db }));
    const upsertRow = db.events.get("linked-upsert");
    assert.equal(eventUpsert.status, 200);
    assert.equal(upsertRow.owner_user_id, user.id);
    assert.equal(upsertRow.dj_profile_id, "profile-link-ok");
  }],
  ["broker DNS writes require a linked account install", async () => {
    await withCloudflareDNSMock(async (calls) => {
      const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", ip: "192.168.2.1" }),
      }), makeEnv({ DB: new FakeD1() }));
      const json = await resp.json();
      assert.equal(resp.status, 403);
      assert.deepEqual(json, { error: "link this Mac to your account before requesting certificates" });
      assert.equal(calls.length, 0);
    });
  }],
  ["broker DNS writes use the linked install slug domain", async () => {
    const db = new FakeD1({
      deviceInstalls: [{
        install_id: "abc123abc123",
        install_slug: "disco12",
        user_id: "user-dns",
        profile_id: "profile-dns",
        revoked_ms: null,
      }],
    });
    await withCloudflareDNSMock(async (calls) => {
      const aResp = await worker.fetch(new Request("https://partyparty.party/api/broker/a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", ip: "192.168.2.1" }),
      }), makeEnv({ DB: db }));
      const aJson = await aResp.json();
      assert.equal(aResp.status, 200);
      assert.equal(aJson.host, "disco12.party.party.example.test");
      const aPost = calls.find((c) => c.method === "POST" && c.body?.type === "A");
      assert.equal(aPost.body.name, "disco12.party.party.example.test");
      assert.equal(aPost.body.content, "192.168.2.1");
      assert.equal(aPost.body.proxied, false);

      const txtResp = await worker.fetch(new Request("https://partyparty.party/api/broker/txt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", value: "challenge-token" }),
      }), makeEnv({ DB: db }));
      const txtJson = await txtResp.json();
      assert.equal(txtResp.status, 200);
      assert.equal(txtJson.name, "_acme-challenge.disco12.party.party.example.test");
      const txtPost = calls.find((c) => c.method === "POST" && c.body?.type === "TXT");
      assert.equal(txtPost.body.name, "_acme-challenge.disco12.party.party.example.test");
      assert.equal(txtPost.body.content, "challenge-token");
    });
  }],
  ["broker /a renames a linked install to the handle-derived slug (seth-live) — but never while live", async () => {
    const mkDb = (over = {}) => new FakeD1({
      deviceInstalls: [{ install_id: "abc123abc123", user_id: "user-hs", profile_id: "profile-hs", revoked_ms: null }],
      profiles: [{ id: "profile-hs", user_id: "user-hs", handle: "seth", display_name: "Seth", published: 1, handle_confirmed_ms: 5, ...over.profile }],
      ...over.db,
    });
    const postA = (env) => worker.fetch(new Request("https://partyparty.party/api/broker/a", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", ip: "192.168.2.1" }),
    }), env);

    // Confirmed handle + idle -> rename disco12 -> seth-live; A record for the new name.
    await withCloudflareDNSMock(async (calls) => {
      const env = makeEnv({ DB: mkDb() });
      const json = await (await postA(env)).json();
      assert.equal(json.host, "seth-live.party.party.example.test");
      const aPost = calls.find((c) => c.method === "POST" && c.body?.type === "A");
      assert.equal(aPost.body.name, "seth-live.party.party.example.test");
      // Reverse index claimed + rec updated: a second call is a stable no-op.
      const again = await (await postA(env)).json();
      assert.equal(again.host, "seth-live.party.party.example.test");
      assert.equal(await (await env.DL.get("broker/slug/seth-live")).text(), "abc123abc123");
    });

    // Unconfirmed (auto-minted) handle -> no rename; hostname must not churn.
    await withCloudflareDNSMock(async () => {
      const env = makeEnv({ DB: mkDb({ profile: { handle_confirmed_ms: null } }) });
      assert.equal((await (await postA(env)).json()).host, "disco12.party.party.example.test");
    });

    // Currently LIVE -> keep the name the Mac can actually serve a cert for.
    await withCloudflareDNSMock(async () => {
      const env = makeEnv({ DB: mkDb({ db: { liveInstalls: [{
        install_id: "abc123abc123", handle: "seth", profile_id: "profile-hs", public_ip_hash: "h",
        host: "disco12.party.party.example.test", lan_ip: "192.168.2.1", event_slug: "", dj_name: "Seth",
        event_title: "", listeners: 0, now_playing: "", live_started_ms: 1, last_seen_ms: 1,
        expires_ms: Date.now() + 60000,
      }] } }) });
      assert.equal((await (await postA(env)).json()).host, "disco12.party.party.example.test");
    });

    // Base taken by ANOTHER install (the DJ's second Mac) -> seth-live2.
    await withCloudflareDNSMock(async () => {
      const env = makeEnv({
        DB: mkDb(),
        r2Objects: { "broker/slug/seth-live": new FakeR2Object("someoneelse47", {}) },
      });
      assert.equal((await (await postA(env)).json()).host, "seth-live2.party.party.example.test");
    });

    // Dotted/underscored handles map to DNS-safe labels (dj.max -> dj-max-live).
    await withCloudflareDNSMock(async () => {
      const env = makeEnv({ DB: mkDb({ profile: { handle: "dj.max_1" } }) });
      assert.equal((await (await postA(env)).json()).host, "dj-max-1-live.party.party.example.test");
    });
  }],

  ["broker DNS writes upgrade legacy installs to a slug instead of IP-encoded hostnames", async () => {
    const db = new FakeD1({
      deviceInstalls: [{
        install_id: "abc123abc123",
        install_slug: "",
        user_id: "user-legacy-dns",
        profile_id: "profile-legacy-dns",
        revoked_ms: null,
      }],
    });
    const env = makeEnv({
      DB: db,
      r2Objects: {
        "broker/abc123abc123.json": new FakeR2Object(JSON.stringify({ secret: "secret-a", created: 1 }), { contentType: "application/json" }),
      },
    });
    await withCloudflareDNSMock(async (calls) => {
      const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", ip: "192.168.2.1" }),
      }), env);
      const json = await resp.json();
      assert.equal(resp.status, 200);
      assert.match(json.host, /^[a-z]+[0-9]{2}\.party\.party\.example\.test$/);
      assert.equal(json.host.includes("192-168-2-1"), false);
      const aPost = calls.find((c) => c.method === "POST" && c.body?.type === "A");
      assert.equal(aPost.body.name, json.host);
      const updated = await env.DL.get("broker/abc123abc123.json").then((o) => o.json());
      assert.equal(`${updated.slug}.party.party.example.test`, json.host);
    });
  }],
  ["dns-admin rejects record-id path traversal before calling Cloudflare", async () => {
    await withCloudflareDNSMock(async (calls) => {
      const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/dns-admin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ admin: "admin-test", op: "delete", recordId: "../../../../user/tokens/verify" }),
      }), makeEnv({ env: { ADMIN_KEY: "admin-test" } }));
      assert.equal(resp.status, 400);
      assert.equal((await resp.json()).error, "bad recordId");
      assert.equal(calls.length, 0);
    });
  }],
  ["web event create API requires authentication", async () => {
    const resp = await worker.fetch(new Request("https://partyparty.party/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Anon Event" }),
    }), makeEnv({ DB: new FakeD1() }));
    assert.equal(resp.status, 401);
  }],
  ["web event create API requires a DJ profile", async () => {
    const db = new FakeD1();
    const cookie = await signInCookie(db, "no-profile-event@example.com", { ip: "203.0.113.36" });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/events", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "No Profile Event" }),
    }), makeEnv({ DB: db }));
    const json = await resp.json();
    assert.equal(resp.status, 400);
    assert.deepEqual(json, { error: "create a DJ profile first", redirect: "/profile/edit" });

    const page = await worker.fetch(new Request("https://partyparty.party/events/new", {
      headers: { cookie },
    }), makeEnv({ DB: db }));
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Create your DJ profile first/);
    assert.match(html, /href="\/profile\/edit"/);
  }],
  ["web event create API inserts a signed-in DJ-owned event", async () => {
    const db = new FakeD1();
    const cookie = await signInCookie(db, "web-create@example.com", { ip: "203.0.113.37" });
    const user = [...db.authUsers.values()].find((row) => row.email === "web-create@example.com");
    db.profiles.push({
      id: "profile-web-create",
      user_id: user.id,
      handle: "web.create",
      display_name: "Web Create",
      published: 1,
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/events", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        slug: "web-party",
        title: "Web Party",
        location_name: "Club Web",
        scheduled_at_ms: 1893542400000,
      }),
    }), makeEnv({ DB: db }));
    const json = await resp.json();
    const row = db.events.get("web-party");
    assert.equal(resp.status, 200);
    assert.deepEqual(json, { ok: true, slug: "web-party", url: "https://partyparty.party/e/web-party" });
    assert.equal(row.install_id, "");
    assert.equal(row.owner_user_id, user.id);
    assert.equal(row.dj_profile_id, "profile-web-create");
    assert.equal(row.source, "web");
    assert.equal(row.status, "upcoming");
    assert.equal(row.visibility, "public");
    assert.equal(row.rsvp_enabled, 1);
    assert.equal(row.title, "Web Party");
    assert.equal(row.location_name, "Club Web");
    assert.equal(db.profileActivityBumps[0].profileId, "profile-web-create");
  }],
  ["web event create API rejects duplicate explicit slug", async () => {
    const db = new FakeD1({
      events: [{ slug: "taken-web", install_id: "abc123abc123", owner_user_id: "other", title: "Taken" }],
    });
    const cookie = await signInCookie(db, "duplicate-web@example.com", { ip: "203.0.113.38" });
    const user = [...db.authUsers.values()].find((row) => row.email === "duplicate-web@example.com");
    db.profiles.push({
      id: "profile-duplicate-web",
      user_id: user.id,
      handle: "duplicate.web",
      display_name: "Duplicate Web",
      published: 1,
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/events", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ slug: "taken-web", title: "New Title" }),
    }), makeEnv({ DB: db }));
    const json = await resp.json();
    assert.equal(resp.status, 409);
    assert.deepEqual(json, { error: "slug taken" });
    assert.equal(db.events.get("taken-web").title, "Taken");
  }],
  ["web event update API allows owner and rejects non-owner", async () => {
    const db = new FakeD1();
    const ownerCookie = await signInCookie(db, "web-owner@example.com", { ip: "203.0.113.39" });
    const owner = [...db.authUsers.values()].find((row) => row.email === "web-owner@example.com");
    db.profiles.push({
      id: "profile-web-owner",
      user_id: owner.id,
      handle: "web.owner",
      display_name: "Web Owner",
      published: 1,
    });
    db.events.set("owned-web", {
      slug: "owned-web",
      install_id: "",
      owner_user_id: owner.id,
      dj_profile_id: "profile-web-owner",
      title: "Old Web",
      status: "upcoming",
      source: "web",
      visibility: "public",
      rsvp_enabled: 1,
    });
    const update = await worker.fetch(new Request("https://partyparty.party/api/events/owned-web", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ title: "Owner Updated", location_name: "New Room", rsvp_enabled: 0 }),
    }), makeEnv({ DB: db }));
    const updateJson = await update.json();
    const row = db.events.get("owned-web");
    assert.equal(update.status, 200);
    assert.deepEqual(updateJson, { ok: true });
    assert.equal(row.title, "Owner Updated");
    assert.equal(row.location_name, "New Room");
    assert.equal(row.where_txt, "New Room");
    assert.equal(row.rsvp_enabled, 0);
    assert.equal(row.install_id, "");
    assert.equal(row.status, "upcoming");

    const otherCookie = await signInCookie(db, "web-other@example.com", { ip: "203.0.113.40" });
    const other = [...db.authUsers.values()].find((item) => item.email === "web-other@example.com");
    db.profiles.push({
      id: "profile-web-other",
      user_id: other.id,
      handle: "web.other",
      display_name: "Web Other",
      published: 1,
    });
    const denied = await worker.fetch(new Request("https://partyparty.party/api/events/owned-web", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: otherCookie },
      body: JSON.stringify({ title: "Stolen" }),
    }), makeEnv({ DB: db }));
    assert.equal(denied.status, 403);
    assert.equal(db.events.get("owned-web").title, "Owner Updated");
  }],
  ["web event update API renames slug and old event link redirects", async () => {
    const db = new FakeD1();
    const ownerCookie = await signInCookie(db, "web-rename@example.com", { ip: "203.0.113.41" });
    const owner = [...db.authUsers.values()].find((row) => row.email === "web-rename@example.com");
    db.profiles.push({
      id: "profile-web-rename",
      user_id: owner.id,
      handle: "web.rename",
      display_name: "Web Rename",
      published: 1,
    });
    db.events.set("old-web", {
      slug: "old-web",
      install_id: "",
      owner_user_id: owner.id,
      dj_profile_id: "profile-web-rename",
      title: "Old Web",
      status: "upcoming",
      source: "web",
      visibility: "public",
      rsvp_enabled: 1,
    });
    const update = await worker.fetch(new Request("https://partyparty.party/api/events/old-web", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ slug: "new-web", title: "Renamed Web" }),
    }), makeEnv({ DB: db }));
    const updateJson = await update.json();
    assert.equal(update.status, 200);
    assert.deepEqual(updateJson, { ok: true });
    assert.equal(db.events.has("old-web"), false);
    assert.equal(db.events.get("new-web").title, "Renamed Web");
    assert.equal(db.eventAliases.get("old-web").slug, "new-web");

    const oldPage = await worker.fetch(new Request("https://partyparty.party/e/old-web"), makeEnv({ DB: db }));
    assert.equal(oldPage.status, 301);
    assert.equal(oldPage.headers.get("location"), "/e/new-web");

    const unknown = await worker.fetch(new Request("https://partyparty.party/e/unknown-web"), makeEnv({ DB: db }));
    assert.equal(unknown.status, 404);
  }],
  ["web event update API refuses to rename an event with guest activity", async () => {
    const db = new FakeD1();
    const ownerCookie = await signInCookie(db, "web-active@example.com", { ip: "203.0.113.42" });
    const owner = [...db.authUsers.values()].find((row) => row.email === "web-active@example.com");
    db.profiles.push({ id: "profile-web-active", user_id: owner.id, handle: "web.active", display_name: "Web Active", published: 1 });
    db.events.set("active-web", {
      slug: "active-web", install_id: "", owner_user_id: owner.id, dj_profile_id: "profile-web-active",
      title: "Active Web", status: "upcoming", source: "web", visibility: "public", rsvp_enabled: 1,
    });
    db.importedPosts.set("active-post", { id: "active-post", slug: "active-web", approved: 1, text: "Already here" });
    const update = await worker.fetch(new Request("https://partyparty.party/api/events/active-web", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ slug: "active-web-new" }),
    }), makeEnv({ DB: db }));
    assert.equal(update.status, 409);
    assert.equal((await update.json()).error, "event with activity cannot be renamed");
    assert.equal(db.events.has("active-web"), true);
    assert.equal(db.events.has("active-web-new"), false);
  }],
  ["profile API creates signed-in user's fresh profile and public route renders it", async () => {
    const db = new FakeD1();
    const cookie = await signInCookie(db, "fresh@example.com", { ip: "203.0.113.30" });
    const user = [...db.authUsers.values()][0];
    const resp = await worker.fetch(new Request("https://partyparty.party/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ handle: " Fresh DJ ", display_name: "Fresh Name" }),
    }), makeEnv({ DB: db }));
    const json = await resp.json();
    assert.equal(resp.status, 200);
    assert.deepEqual(json, { ok: true, handle: "fresh.dj", url: "https://partyparty.party/@fresh.dj" });
    assert.equal(db.profiles.length, 1);
    assert.equal(db.profiles[0].user_id, user.id);
    assert.equal(db.profiles[0].handle, "fresh.dj");

    const page = await worker.fetch(new Request("https://partyparty.party/@fresh.dj"), makeEnv({ DB: db }));
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Fresh Name/);
    assert.match(html, /@fresh\.dj/);
    // A non-owner (anonymous) visitor must NOT see owner-only actions.
    assert.doesNotMatch(html, /Create event/);
    assert.equal(page.headers.get("cache-control"), "public, max-age=60");

    // The owner (signed-in) sees Create event + Edit profile, uncached.
    const ownerPage = await worker.fetch(new Request("https://partyparty.party/@fresh.dj", { headers: { cookie } }), makeEnv({ DB: db }));
    const ownerHtml = await ownerPage.text();
    assert.equal(ownerPage.status, 200);
    assert.match(ownerHtml, /href="\/events\/new">＋ Create event/);
    assert.match(ownerHtml, /href="\/profile\/edit">Edit profile/);
    assert.equal(ownerPage.headers.get("cache-control"), "private, no-store");
  }],
  ["follow toggles, drives button state, and the home 'DJs you follow' section", async () => {
    const db = new FakeD1({
      profiles: [{ id: "profile-star", user_id: "user-star", handle: "star.dj", display_name: "Star DJ", published: 1 }],
    });
    const cookie = await signInCookie(db, "fan@example.com", { ip: "203.0.113.40" });

    // Signed-out profile → "Sign in to follow", no follow button.
    const anonHtml = await (await worker.fetch(new Request("https://partyparty.party/@star.dj"), makeEnv({ DB: db }))).text();
    assert.match(anonHtml, /Sign in to follow/);
    assert.doesNotMatch(anonHtml, /id="followbtn"/);

    // Signed-in non-owner → Follow button (not yet following), uncached.
    const before = await worker.fetch(new Request("https://partyparty.party/@star.dj", { headers: { cookie } }), makeEnv({ DB: db }));
    assert.match(await before.text(), /id="followbtn"[^>]*data-following="0"/);
    assert.equal(before.headers.get("cache-control"), "private, no-store");

    // Follow (POST) is idempotent.
    const follow = await worker.fetch(new Request("https://partyparty.party/api/follow", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ handle: "star.dj" }),
    }), makeEnv({ DB: db }));
    assert.equal(follow.status, 200);
    assert.deepEqual(await follow.json(), { ok: true, following: true });
    await worker.fetch(new Request("https://partyparty.party/api/follow", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ handle: "star.dj" }),
    }), makeEnv({ DB: db }));
    assert.equal(db.follows.length, 1);

    // Profile now shows "Following".
    assert.match(await (await worker.fetch(new Request("https://partyparty.party/@star.dj", { headers: { cookie } }), makeEnv({ DB: db }))).text(), /id="followbtn"[^>]*data-following="1"/);

    // Signed-in home shows the personalized section, uncached; anon home doesn't.
    // (The events aggregator lives at /live since decision C; / is the marketing page.)
    const home = await worker.fetch(new Request("https://partyparty.party/live", { headers: { cookie } }), makeEnv({ DB: db }));
    assert.match(await home.text(), /DJs you follow/);
    assert.equal(home.headers.get("cache-control"), "private, no-store");
    const anonHome = await worker.fetch(new Request("https://partyparty.party/live"), makeEnv({ DB: db }));
    assert.doesNotMatch(await anonHome.text(), /DJs you follow/);
    assert.equal(anonHome.headers.get("cache-control"), "public, max-age=60");

    // Unfollow (DELETE).
    const unfollow = await worker.fetch(new Request("https://partyparty.party/api/follow", {
      method: "DELETE", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ handle: "star.dj" }),
    }), makeEnv({ DB: db }));
    assert.deepEqual(await unfollow.json(), { ok: true, following: false });
    assert.equal(db.follows.length, 0);
  }],
  ["follow rejects anonymous callers and self-follow", async () => {
    const db = new FakeD1();
    const anon = await worker.fetch(new Request("https://partyparty.party/api/follow", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "someone" }),
    }), makeEnv({ DB: db }));
    assert.equal(anon.status, 401);

    const cookie = await signInCookie(db, "self@example.com", { ip: "203.0.113.41" });
    const user = [...db.authUsers.values()].find((u) => u.email_norm === "self@example.com");
    db.profiles.push({ id: "profile-self", user_id: user.id, handle: "self.dj", display_name: "Self DJ", published: 1 });
    const self = await worker.fetch(new Request("https://partyparty.party/api/follow", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ handle: "self.dj" }),
    }), makeEnv({ DB: db }));
    assert.equal(self.status, 400);
    assert.equal(db.follows.length, 0);
  }],
  ["event edit page: owner pre-fill, non-owner blocked, event-page Edit affordance", async () => {
    const db = new FakeD1();
    const cookie = await signInCookie(db, "host@example.com", { ip: "203.0.113.50" });
    const user = [...db.authUsers.values()].find((u) => u.email_norm === "host@example.com");
    db.events.set("rooftop", {
      slug: "rooftop", owner_user_id: user.id, title: "Rooftop Sessions", status: "upcoming",
      visibility: "public", rsvp_enabled: 1, tagline: "Sunset edits", scheduled_at_ms: 1893542400000,
    });

    // Anonymous → redirect to login.
    const anon = await worker.fetch(new Request("https://partyparty.party/e/rooftop/edit"), makeEnv({ DB: db }));
    assert.equal(anon.status, 302);
    assert.match(anon.headers.get("location"), /\/login\?redirect=/);

    // Owner → pre-filled edit form that submits to the update API, uncached.
    const owner = await worker.fetch(new Request("https://partyparty.party/e/rooftop/edit", { headers: { cookie } }), makeEnv({ DB: db }));
    const ownerHtml = await owner.text();
    assert.equal(owner.status, 200);
    assert.match(ownerHtml, /Edit event/);
    assert.match(ownerHtml, /Rooftop Sessions/);
    assert.match(ownerHtml, /\/api\/events\/rooftop/);
    assert.equal(owner.headers.get("cache-control"), "no-store");

    // A different signed-in user → 403.
    const otherCookie = await signInCookie(db, "stranger@example.com", { ip: "203.0.113.51" });
    const other = await worker.fetch(new Request("https://partyparty.party/e/rooftop/edit", { headers: { cookie: otherCookie } }), makeEnv({ DB: db }));
    assert.equal(other.status, 403);
    assert.match(await other.text(), /Not your event/);

    // Event page: owner sees an Edit link (uncached); anonymous does not.
    const ownerView = await worker.fetch(new Request("https://partyparty.party/e/rooftop", { headers: { cookie } }), makeEnv({ DB: db }));
    assert.match(await ownerView.text(), /href="\/e\/rooftop\/edit"/);
    assert.equal(ownerView.headers.get("cache-control"), "private, no-store");
    const anonView = await worker.fetch(new Request("https://partyparty.party/e/rooftop"), makeEnv({ DB: db }));
    assert.doesNotMatch(await anonView.text(), /href="\/e\/rooftop\/edit"/);
  }],
  ["profile API rejects a different user claiming an existing normalized handle", async () => {
    const db = new FakeD1();
    const cookieA = await signInCookie(db, "claim-a@example.com", { ip: "203.0.113.31" });
    const first = await worker.fetch(new Request("https://partyparty.party/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieA },
      body: JSON.stringify({ handle: "Taken Handle" }),
    }), makeEnv({ DB: db }));
    assert.equal(first.status, 200);

    const cookieB = await signInCookie(db, "claim-b@example.com", { ip: "203.0.113.32" });
    const second = await worker.fetch(new Request("https://partyparty.party/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieB },
      body: JSON.stringify({ handle: "taken.handle" }),
    }), makeEnv({ DB: db }));
    assert.equal(second.status, 409);
    assert.equal(db.profiles.length, 1);
  }],
  ["profile API rejects invalid handles", async () => {
    const db = new FakeD1();
    const cookie = await signInCookie(db, "bad-handle@example.com", { ip: "203.0.113.33" });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ handle: "!!!" }),
    }), makeEnv({ DB: db }));
    assert.equal(resp.status, 400);
    assert.equal(db.profiles.length, 0);
  }],
  ["profile API enforces reserved handles, aliases, and rename cooldown", async () => {
    const db = new FakeD1();
    const cookie = await signInCookie(db, "profile-rename@example.com", { ip: "203.0.113.36" });
    const create = await worker.fetch(new Request("https://partyparty.party/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ handle: "first.profile" }),
    }), makeEnv({ DB: db }));
    assert.equal(create.status, 200);

    const reserved = await worker.fetch(new Request("https://partyparty.party/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ handle: "api" }),
    }), makeEnv({ DB: db }));
    assert.equal(reserved.status, 409);
    assert.equal(db.profiles[0].handle, "first.profile");

    const rename = await worker.fetch(new Request("https://partyparty.party/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ handle: "second.profile" }),
    }), makeEnv({ DB: db }));
    assert.equal(rename.status, 200);
    assert.equal(db.profiles[0].handle, "second.profile");
    assert.equal(db.handleAliases.get("first.profile")?.profile_id, db.profiles[0].id);

    const tooSoon = await worker.fetch(new Request("https://partyparty.party/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ handle: "third.profile" }),
    }), makeEnv({ DB: db }));
    assert.equal(tooSoon.status, 429);
    assert.equal(db.profiles[0].handle, "second.profile");
  }],
  ["profile API requires authentication", async () => {
    const resp = await worker.fetch(new Request("https://partyparty.party/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "anon.dj" }),
    }), makeEnv({ DB: new FakeD1() }));
    assert.equal(resp.status, 401);
  }],
  ["profile API persists owner display name and bio edits", async () => {
    const db = new FakeD1();
    const cookie = await signInCookie(db, "edit-owner@example.com", { ip: "203.0.113.34" });
    const create = await worker.fetch(new Request("https://partyparty.party/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ handle: "edit.owner" }),
    }), makeEnv({ DB: db }));
    assert.equal(create.status, 200);

    const edit = await worker.fetch(new Request("https://partyparty.party/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ display_name: "Owner Edited", bio: "Updated private owner copy.", location: "Oakland" }),
    }), makeEnv({ DB: db }));
    assert.equal(edit.status, 200);
    const row = db.profiles.find((profile) => profile.handle === "edit.owner");
    assert.equal(row.display_name, "Owner Edited");
    assert.equal(row.bio, "Updated private owner copy.");
    assert.equal(row.location, "Oakland");
  }],
  ["profile socials reject javascript URLs and accept https URLs", async () => {
    const db = new FakeD1();
    const cookie = await signInCookie(db, "socials@example.com", { ip: "203.0.113.35" });
    const create = await worker.fetch(new Request("https://partyparty.party/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ handle: "social.dj" }),
    }), makeEnv({ DB: db }));
    assert.equal(create.status, 200);

    const bad = await worker.fetch(new Request("https://partyparty.party/api/profile/socials", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ website_url: "javascript:alert(1)" }),
    }), makeEnv({ DB: db }));
    assert.equal(bad.status, 400);
    assert.equal(db.profiles[0].website_url, "");

    const good = await worker.fetch(new Request("https://partyparty.party/api/profile/socials", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ website_url: "https://example.test/dj", instagram_url: "" }),
    }), makeEnv({ DB: db }));
    const json = await good.json();
    assert.equal(good.status, 200);
    assert.equal(json.website_url, "https://example.test/dj");
    assert.equal(db.profiles[0].website_url, "https://example.test/dj");
  }],
  ["profile edit redirects anonymous users to login", async () => {
    const resp = await worker.fetch(new Request("https://partyparty.party/profile/edit"), makeEnv({ DB: new FakeD1() }));
    assert.equal(resp.status, 302);
    assert.equal(resp.headers.get("location"), "/login?redirect=/profile/edit");
  }],
  ["login renders fallback when no consumer auth providers are configured", async () => {
    const resp = await worker.fetch(new Request("https://partyparty.party/login"), makeEnv({ DB: new FakeD1() }));
    const html = await resp.text();
    assert.equal(resp.status, 200);
    assert.doesNotMatch(html, /type="email"/);
    assert.match(html, /No self-serve sign-in methods are configured/);
    assert.match(html, /Older app version only/);
    assert.match(html, /href="\/account"/);
    assert.match(html, /href="\/login\?admin=1&amp;redirect=%2Faccount"/);
    // Admin passcode is demoted — not shown on the default consumer login.
    assert.doesNotMatch(html, /Admin passcode/);

    // ...but it's available behind /login?admin=1 for support/dev.
    const adminResp = await worker.fetch(new Request("https://partyparty.party/login?admin=1"), makeEnv({ DB: new FakeD1() }));
    assert.match(await adminResp.text(), /Admin passcode/);
  }],
  ["login renders email form when MXroute email is configured", async () => {
    const resp = await worker.fetch(new Request("https://partyparty.party/login"), makeEnv({
      DB: new FakeD1(),
      env: {
        AUTH_EMAIL_SERVER: "smtps://signin%40mail.example.test:p%40ssword@mail.mxrouting.test:465",
      },
    }));
    const html = await resp.text();
    assert.equal(resp.status, 200);
    assert.match(html, /type="email"/);
    assert.match(html, /New to partyparty\? Your account is created automatically/);
    assert.match(html, /redirect="\/account"/);
    assert.match(html, /Email sign-in is temporarily unavailable/);
  }],
  ["login redirects signed-in users to account", async () => {
    const db = new FakeD1();
    const cookie = await signInCookie(db, "login-redirect@example.com", { ip: "203.0.113.29" });
    const resp = await worker.fetch(new Request("https://partyparty.party/login", {
      headers: { cookie },
    }), makeEnv({ DB: db }));
    assert.equal(resp.status, 302);
    assert.equal(resp.headers.get("location"), "/account");
    const next = await worker.fetch(new Request("https://partyparty.party/login?redirect=/link-mac%3Ftoken%3Daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
      headers: { cookie },
    }), makeEnv({ DB: db }));
    assert.equal(next.status, 302);
    assert.equal(next.headers.get("location"), "/link-mac?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  }],
  ["/ serves the static marketing page (decision C)", async () => {
    // The root is the marketing landing for everyone; it delegates to the
    // ASSETS binding (the static site/index.html), not the aggregator.
    const resp = await fetchPath("/", {}, { assetBody: "STATIC_LANDING_MARKER" });
    assert.equal(resp.status, 200);
    assert.equal(await resp.text(), "STATIC_LANDING_MARKER");
  }],
  ["/api/version returns the download freshness payload", async () => {
    const codeMajor = (await readFile(new URL("../../CODE_MAJOR", import.meta.url), "utf8")).replace(/\D/g, "");
    const payloadVersion = (await readFile(new URL("../../web/PAYLOAD_VERSION", import.meta.url), "utf8")).replace(/\D/g, "");
    const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
    const expectedDate = workerSource.match(/const APP_VERSION_DATE = "([^"]+)";/)?.[1];
    const resp = await fetchPath("/api/version");
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("content-type") || "", /application\/json/);
    assert.equal(resp.headers.get("cache-control"), "public, max-age=300");
    assert.ok(expectedDate);
    assert.deepEqual(await resp.json(), { version: `${codeMajor}.${payloadVersion}`, date: expectedDate });
  }],
  ["/api/version does not let an older native marker hide a payload release", async () => {
    const codeMajor = (await readFile(new URL("../../CODE_MAJOR", import.meta.url), "utf8")).replace(/\D/g, "");
    const payloadVersion = (await readFile(new URL("../../web/PAYLOAD_VERSION", import.meta.url), "utf8")).replace(/\D/g, "");
    const workerSource = await readFile(new URL("../worker.js", import.meta.url), "utf8");
    const expectedDate = workerSource.match(/const APP_VERSION_DATE = "([^"]+)";/)?.[1];
    const resp = await fetchPath("/api/version", {}, {
      r2Objects: { "content/app-version": new FakeR2Object(`${codeMajor}.${Math.max(0, Number(payloadVersion) - 1)}`) },
    });
    assert.equal(resp.status, 200);
    assert.ok(expectedDate);
    assert.deepEqual(await resp.json(), { version: `${codeMajor}.${payloadVersion}`, date: expectedDate });
  }],
  ["/live renders the aggregator's useful empty state", async () => {
    const resp = await fetchPath("/live");
    const html = await resp.text();
    assert.equal(resp.status, 200);
    assert.match(html, /speakers would get you shut down/);
    assert.match(html, /coming soon/);
    assert.match(html, /Get the app/);
    assert.match(html, /Sign in/);
    assert.match(html, /\/partyparty\.pkg/);
    assert.match(html, /href="\/login"/);
    assert.match(html, /href="\/faq"/);
    assert.notEqual(html.trim(), "");
  }],
  ["static landing exposes account access", async () => {
    const html = await readFile(new URL("../../site/index.html", import.meta.url), "utf8");
    // Invariants, not marketing copy (the landing was redesigned 2026-07):
    // account access is reachable, the no-guest-account promise is stated, and
    // the page personalizes/vesions itself from the live APIs.
    assert.match(html, /id="nav-auth" href="\/login">Sign in/);
    assert.match(html, /[Nn]o accounts?\b/);
    assert.match(html, /fetch\('\/api\/me'/);
    assert.match(html, /fetch\('\/api\/version'/);
  }],
  ["/live renders public events and featured DJs", async () => {
    const resp = await fetchPath("/live", {}, {
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
  ["faq renders how it works page", async () => {
    const resp = await fetchPath("/faq");
    const html = await resp.text();
    assert.equal(resp.status, 200);
    assert.match(html, /How partyparty works/);
    assert.match(html, /Setups &amp; networks/);
    assert.match(html, /Fraunces:opsz,wght/);
    assert.match(html, /Questions we didn&#39;t answer\?/);
    assert.match(html, /href="\/"/);
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
    assert.match(html, /class="eventtop"/);
    assert.match(html, /<b>DJ<\/b>Test DJ/);
    assert.match(html, /<b>Date<\/b>Tonight/);
    assert.match(html, /<b>Place<\/b>Test Venue/);
    assert.match(html, /src="\/event\/known-set\/cover\.jpg"/);
    assert.match(html, /Replay player/);
    assert.match(html, /<audio id="setaudio"/);
  }],
  ["event RSVP POST mints anonymous cookie and counts coming", async () => {
    const db = new FakeD1({ rsvpEnabled: 1 });
    const resp = await worker.fetch(new Request(`https://partyparty.party/api/e/${KNOWN_SLUG}/rsvp`, {
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
    const first = await worker.fetch(new Request(`https://partyparty.party/api/e/${KNOWN_SLUG}/rsvp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: "coming" }),
    }), makeEnv({ DB: db }));
    const cookie = (first.headers.get("set-cookie") || "").split(";")[0];
    const second = await worker.fetch(new Request(`https://partyparty.party/api/e/${KNOWN_SLUG}/rsvp`, {
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
    ["event RSVP cookie-less browsers on one IP keep distinct identities", async () => {
      const db = new FakeD1({ rsvpEnabled: 1 });
      const first = await worker.fetch(new Request(`https://partyparty.party/api/e/${KNOWN_SLUG}/rsvp`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
        body: JSON.stringify({ response: "coming" }),
      }), makeEnv({ DB: db }));
      const second = await worker.fetch(new Request(`https://partyparty.party/api/e/${KNOWN_SLUG}/rsvp`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
        body: JSON.stringify({ response: "not" }),
      }), makeEnv({ DB: db }));
      const json = await second.json();
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.deepEqual(json, { ok: true, response: "not", counts: { coming: 1, not: 1 } });
      assert.equal(db.rsvps.size, 2);
      assert.notEqual(
        (first.headers.get("set-cookie") || "").split(";")[0],
        (second.headers.get("set-cookie") || "").split(";")[0]
      );
    }],
  ["event RSVP GET returns counts and mine", async () => {
    const db = new FakeD1({ rsvpEnabled: 1 });
    const first = await worker.fetch(new Request(`https://partyparty.party/api/e/${KNOWN_SLUG}/rsvp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: "coming" }),
    }), makeEnv({ DB: db }));
    const cookie = (first.headers.get("set-cookie") || "").split(";")[0];
    const resp = await worker.fetch(new Request(`https://partyparty.party/api/e/${KNOWN_SLUG}/rsvp`, {
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
        wallComments: [{
          id: "comment-img",
          post_id: "post-img",
          author: "Mia",
          emoji: "\u2764\ufe0f",
          text: "Still thinking about this.",
          approved: 1,
          deleted_ms: null,
          ts_ms: 1893456100000,
        }],
      },
    });
    const html = await resp.text();
    assert.equal(resp.status, 200);
    assert.match(html, /<audio id="setaudio"/);
    assert.match(html, /<div class="wave" id="wave"/);
    assert.match(html, /<div class="media-grid"/);
    assert.match(html, /<div class="timeline"/);
    assert.match(html, /The lights hit right at midnight\./);
    assert.match(html, /Bassline stayed locked\./);
    assert.match(html, /Still thinking about this\./);
    assert.ok(html.indexOf("Bassline stayed locked.") < html.indexOf("The lights hit right at midnight."));
    assert.match(html, /<img loading="lazy" decoding="async" src="\/event\/known-set\/media\/media-img"/);
  }],
  ["event media gallery renders approved video tiles", async () => {
    const resp = await fetchPath(`/e/${KNOWN_SLUG}`, {}, {
      db: {
        wallPosts: [{
          id: "post-video",
          slug: KNOWN_SLUG,
          author: "Ava",
          text: "Clip from the opener.",
          approved: 1,
          deleted_ms: null,
          activity_ms: 1893456000000,
          created_ms: 1893456000000,
        }],
        wallMedia: [{
          id: "media-video",
          slug: KNOWN_SLUG,
          post_id: "post-video",
          media_key: `event/${KNOWN_SLUG}/media-video`,
          media_type: "video",
          mime_type: "video/mp4",
          name: "opener.mp4",
          sort_order: 0,
        }],
      },
    });
    const html = await resp.text();
    assert.equal(resp.status, 200);
    assert.match(html, /<div class="media-grid"/);
    assert.match(html, /<video controls preload="metadata" playsinline src="\/event\/known-set\/media\/media-video"/);
  }],
  ["event wall ignores invalid timestamps instead of crashing", async () => {
    const resp = await fetchPath(`/e/${KNOWN_SLUG}`, {}, {
      db: {
        wallPosts: [{
          id: "post-huge-ts",
          slug: KNOWN_SLUG,
          author: "Ava",
          text: "Still renders",
          approved: 1,
          deleted_ms: null,
          activity_ms: 9007199254740991,
          created_ms: 9007199254740991,
        }],
      },
    });
    const html = await resp.text();
    assert.equal(resp.status, 200);
    assert.match(html, /Still renders/);
    assert.doesNotMatch(html, /datetime=/);
  }],
  ["event wall handles ready set with no posts", async () => {
    const resp = await fetchPath(`/e/${KNOWN_SLUG}`);
    const html = await resp.text();
    assert.equal(resp.status, 200);
    assert.match(html, /<audio id="setaudio"/);
    assert.match(html, /<div class="wave" id="wave"/);
    assert.match(html, /No photos or clips yet\. Approved guest media will collect here after the party\./);
    assert.match(html, /No comments yet\. Guest notes will appear here once the DJ approves them\./);
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
    ["profile route omits unsafe social URL schemes", async () => {
      const resp = await fetchPath("/@unsafe", {}, {
        db: {
          profiles: [{
            id: "profile-unsafe",
            handle: "unsafe",
            display_name: "DJ Unsafe",
            bio: "Links under test.",
            published: 1,
            website_url: "javascript:alert(1)",
            instagram_url: "data:text/html,hi",
            soundcloud_url: "https://soundcloud.example.test/dj",
            spotify_url: "http://spotify.example.test/dj",
          }],
        },
      });
      const html = await resp.text();
      assert.equal(resp.status, 200);
      assert.doesNotMatch(html, /javascript:alert/);
      assert.doesNotMatch(html, /data:text\/html/);
      assert.match(html, /href="https:\/\/soundcloud\.example\.test\/dj"/);
      assert.match(html, /href="http:\/\/spotify\.example\.test\/dj"/);
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
      assert.equal(resp.headers.get("x-content-type-options"), "nosniff");
      assert.equal(resp.headers.get("cache-control"), "public, max-age=300");
      assert.equal(await resp.text(), "fake-png");
    }],
    ["approved post media coerces unsafe stored content-type", async () => {
      const resp = await fetchPath(`/event/${KNOWN_SLUG}/media/media-html`, {}, {
        db: {
          wallPosts: [{
            id: "post-img",
            slug: KNOWN_SLUG,
            approved: 1,
            deleted_ms: null,
          }],
          wallMedia: [{
            id: "media-html",
            slug: KNOWN_SLUG,
            post_id: "post-img",
            media_key: `event/${KNOWN_SLUG}/post-media/media-html`,
            media_type: "image",
            mime_type: "text/html",
          }],
        },
        r2Objects: {
          [`event/${KNOWN_SLUG}/post-media/media-html`]: new FakeR2Object("<script>alert(1)</script>", { contentType: "text/html" }),
        },
      });
      assert.equal(resp.status, 200);
      assert.equal(resp.headers.get("content-type"), "image/jpeg");
      assert.equal(resp.headers.get("x-content-type-options"), "nosniff");
      assert.equal(await resp.text(), "<script>alert(1)</script>");
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
      assert.equal(resp.headers.get("x-content-type-options"), "nosniff");
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
  ["broker publish-cover delete clears object and event cover", async () => {
    const env = makeEnv({ DB: new FakeD1({ deviceInstalls: [LINKED_INSTALL] }) });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-cover", {
      method: "DELETE",
      headers: {
        "x-pp-id": "abc123abc123",
        "x-pp-secret": "secret-a",
        "x-pp-slug": KNOWN_SLUG,
      },
    }), env);
    assert.equal(resp.status, 200);
    assert.equal(await env.DL.get(`event/${KNOWN_SLUG}/cover.jpg`), null);
    assert.equal(env.DB.events.get(KNOWN_SLUG).cover_key, null);
  }],
  ["broker event-upsert rejects bad secret", async () => {
    const resp = await fetchPath("/api/broker/event-upsert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "wrong", slug: "ahead-bad-secret" }),
    });
    assert.equal(resp.status, 403);
  }],
  ["broker events-window rejects bad secret", async () => {
    const resp = await fetchPath("/api/broker/events-window", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "wrong" }),
    });
    assert.equal(resp.status, 403);
  }],
  ["broker events-window returns owned events with replay and RSVP fields", async () => {
    const now = Date.now();
    const db = new FakeD1({
      events: [{
        slug: "window-upcoming",
        install_id: "abc123abc123",
        title: "Window Upcoming",
        host: "DJ Window",
        status: "upcoming",
        visibility: "public",
        scheduled_at_ms: now + 60_000,
        end_at_ms: now + 3_600_000,
        timezone: "America/Los_Angeles",
        location_name: "Rooftop",
        updated_ms: now - 1_000,
        last_activity_ms: now - 1_000,
      }, {
        slug: "window-replay",
        install_id: "abc123abc123",
        title: "Window Replay",
        host: "DJ Window",
        status: "replay",
        visibility: "unlisted",
        scheduled_at_ms: null,
        published_ms: now - 60_000,
        updated_ms: now - 60_000,
        last_activity_ms: now - 30_000,
      }],
      eventSets: [{ slug: "window-replay", state: "ready" }],
      rsvps: [
        { slug: "window-upcoming", user_id: "u1", response: "coming" },
        { slug: "window-upcoming", user_id: "u2", response: "coming" },
        { slug: "window-upcoming", user_id: "u3", response: "not" },
      ],
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/events-window", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", since_ms: now - 86_400_000, until_ms: now + 86_400_000 }),
    }), makeEnv({ DB: db }));
    const json = await resp.json();
    assert.equal(resp.status, 200);
    assert.equal(json.ok, true);
    assert.equal(typeof json.serverMs, "number");
    assert.deepEqual(json.events.map((event) => event.slug), ["window-upcoming", "window-replay"]);
    assert.equal(json.events[0].url, "https://partyparty.party/e/window-upcoming");
    assert.equal(json.events[0].status, "upcoming");
    assert.equal(json.events[0].visibility, "public");
    assert.equal(json.events[0].scheduled_at_ms, now + 60_000);
    assert.equal(json.events[0].end_at_ms, now + 3_600_000);
    assert.equal(json.events[0].timezone, "America/Los_Angeles");
    assert.equal(json.events[0].location_name, "Rooftop");
    assert.equal(json.events[0].hasReplay, false);
    assert.deepEqual(json.events[0].rsvp, { coming: 2, not: 1 });
    assert.equal(json.events[1].url, "https://partyparty.party/e/window-replay");
    assert.equal(json.events[1].status, "replay");
    assert.equal(json.events[1].hasReplay, true);
    assert.deepEqual(json.events[1].rsvp, { coming: 0, not: 0 });
  }],
  ["broker events-window returns empty list for install with no events", async () => {
    const resp = await fetchPath("/api/broker/events-window", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a" }),
    });
    const json = await resp.json();
    assert.equal(resp.status, 200);
    assert.equal(json.ok, true);
    assert.deepEqual(json.events, []);
    assert.equal(typeof json.serverMs, "number");
  }],
  ["broker events-window excludes events owned by another install", async () => {
    const now = Date.now();
    const db = new FakeD1({
      events: [{
        slug: "window-other",
        install_id: "def456def456",
        title: "Other",
        status: "upcoming",
        scheduled_at_ms: now + 60_000,
        updated_ms: now,
      }],
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/events-window", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", since_ms: now - 86_400_000, until_ms: now + 86_400_000 }),
    }), makeEnv({ DB: db }));
    const json = await resp.json();
    assert.equal(resp.status, 200);
    assert.deepEqual(json.events, []);
  }],
  ["broker event-upsert creates fresh upcoming event", async () => {
    const db = new FakeD1({
      deviceInstalls: [{ install_id: "abc123abc123", user_id: "user-1", profile_id: "profile-1" }],
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/event-upsert", {
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
    assert.deepEqual(json, { ok: true, slug: "ahead-new", url: "https://partyparty.party/e/ahead-new", status: "upcoming" });
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
    ["broker event-upsert creates minimal fresh event with non-null text defaults", async () => {
      const db = new FakeD1({
        deviceInstalls: [{ install_id: "abc123abc123", user_id: "user-1", profile_id: "profile-1" }],
      });
      const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/event-upsert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "abc123abc123",
          secret: "secret-a",
          slug: "ahead-minimal",
        }),
      }), makeEnv({ DB: db }));
      const row = db.events.get("ahead-minimal");
      assert.equal(resp.status, 200);
      assert.equal(row.title, "");
      assert.equal(row.host, "");
      assert.equal(row.starts, "");
      assert.equal(row.where_txt, "");
      assert.equal(row.tagline, "");
      assert.equal(row.about, "");
      assert.equal(row.timezone, "");
      assert.equal(row.location_name, "");
      assert.equal(row.location_address, "");
      assert.equal(row.scheduled_at_ms, null);
      assert.equal(row.end_at_ms, null);
    }],
  ["broker event-upsert returns 409 for slug owned by another install", async () => {
    const db = new FakeD1({
      deviceInstalls: [{ install_id: "abc123abc123", user_id: "user-1", profile_id: "profile-1" }],
      events: [{ slug: "taken-ahead", install_id: "def456def456", title: "Taken", status: "upcoming" }],
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/event-upsert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "taken-ahead", title: "Nope" }),
    }), makeEnv({ DB: db }));
    assert.equal(resp.status, 409);
    assert.equal(db.events.get("taken-ahead").title, "Taken");
  }],
  ["linked Mac claims its account's unassigned web event", async () => {
    const db = new FakeD1({
      deviceInstalls: [{ install_id: "abc123abc123", user_id: "user-web-owner", profile_id: "profile-web-owner", revoked_ms: null }],
      events: [
        { slug: "web-upsert", install_id: "", owner_user_id: "user-web-owner", dj_profile_id: "profile-web-owner", title: "Web Upsert", status: "upcoming", source: "web" },
        { slug: "web-publish", install_id: "", owner_user_id: "user-web-owner", dj_profile_id: "profile-web-owner", title: "Web Publish", status: "upcoming", source: "web" },
      ],
    });
    const upsert = await worker.fetch(new Request("https://partyparty.party/api/broker/event-upsert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "web-upsert", title: "Synced from Mac" }),
    }), makeEnv({ DB: db }));
    assert.equal(upsert.status, 200);
    assert.equal(db.events.get("web-upsert").install_id, "abc123abc123");
    assert.equal(db.events.get("web-upsert").title, "Synced from Mac");

    const publish = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-meta", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "web-publish", title: "Published from Mac" }),
    }), makeEnv({ DB: db }));
    assert.equal(publish.status, 200);
    assert.equal(db.events.get("web-publish").install_id, "abc123abc123");
    assert.equal(db.events.get("web-publish").status, "replay");
  }],
  ["broker event-upsert updates owned title without clobbering replay status", async () => {
    const db = new FakeD1({
      deviceInstalls: [{ install_id: "abc123abc123", user_id: "user-1", profile_id: "profile-1" }],
      events: [{ slug: "owned-replay", install_id: "abc123abc123", title: "Old Title", status: "replay" }],
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/event-upsert", {
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
  ["broker event-upsert records alias when old_slug is renamed", async () => {
    const db = new FakeD1({
      deviceInstalls: [{ install_id: "abc123abc123", user_id: "user-1", profile_id: "profile-1" }],
      events: [{ slug: "ahead-old", install_id: "abc123abc123", title: "Ahead Old", status: "upcoming" }],
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/event-upsert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "abc123abc123",
        secret: "secret-a",
        old_slug: "ahead-old",
        slug: "ahead-new",
        title: "Ahead New",
      }),
    }), makeEnv({ DB: db }));
    const json = await resp.json();
    assert.equal(resp.status, 200);
    assert.equal(json.slug, "ahead-new");
    assert.equal(db.events.has("ahead-old"), false);
    assert.equal(db.events.get("ahead-new").title, "Ahead New");
    assert.equal(db.eventAliases.get("ahead-old").slug, "ahead-new");
  }],
  ["broker event-upsert refuses to rename an event with published content", async () => {
    const db = new FakeD1({
      deviceInstalls: [LINKED_INSTALL],
      events: [{ slug: "published-old", install_id: "abc123abc123", title: "Published", status: "replay" }],
      eventSets: [{ id: "published-set", slug: "published-old", state: "ready", audio_key: "event/published-old/published-set.m4a" }],
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/event-upsert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", old_slug: "published-old", slug: "published-new", title: "Published" }),
    }), makeEnv({ DB: db }));
    assert.equal(resp.status, 409);
    assert.equal((await resp.json()).error, "event with activity cannot be renamed");
    assert.equal(db.events.has("published-old"), true);
    assert.equal(db.events.has("published-new"), false);
  }],
  ["broker event rename is REJECTED when the slug is reserved by another's keepsake", async () => {
    // Owner A renamed party -> rave (alias party->rave; rave is live). Owner B
    // tries to reclaim the freed slug "party" — the reservation model blocks it
    // (409 slug reserved) so A's keepsake link never breaks. (v17 alias finding.)
    const db = new FakeD1({
      deviceInstalls: [
        { install_id: "abc123abc123", user_id: "user-a", profile_id: "profile-a" },
        { install_id: "def456def456", user_id: "user-b", profile_id: "profile-b" },
      ],
      events: [
        { slug: "rave", install_id: "abc123abc123", title: "A Rave", status: "upcoming" },
        { slug: "b-old", install_id: "def456def456", title: "B Event", status: "upcoming" },
      ],
      eventAliases: [{ old_slug: "party", slug: "rave", created_ms: 1 }],
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/event-upsert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "def456def456", secret: "secret-b", old_slug: "b-old", slug: "party", title: "B Event" }),
    }), makeEnv({ DB: db }));
    assert.equal(resp.status, 409);
    assert.equal((await resp.json()).error, "slug reserved");
    // A's keepsake is untouched — B never got the slug.
    assert.equal(db.eventAliases.get("party").slug, "rave");
    assert.equal(db.events.has("party"), false);
  }],
  ["broker event-upsert lets the SAME owner reclaim their own aliased slug", async () => {
    // Install A renamed party -> rave (alias party->rave points at A's event).
    // A renames rave -> party (undo). Allowed: the alias points to A's own event.
    const db = new FakeD1({
      deviceInstalls: [{ install_id: "abc123abc123", user_id: "user-a", profile_id: "profile-a" }],
      events: [{ slug: "rave", install_id: "abc123abc123", title: "A Rave", status: "upcoming" }],
      eventAliases: [{ old_slug: "party", slug: "rave", created_ms: 1 }],
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/event-upsert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", old_slug: "rave", slug: "party", title: "A Rave" }),
    }), makeEnv({ DB: db }));
    assert.equal(resp.status, 200);
    assert.equal(db.events.has("party"), true);          // reclaimed
    assert.equal(db.events.has("rave"), false);          // moved off rave
    assert.equal(db.eventAliases.get("rave").slug, "party"); // new keepsake rave->party
  }],
  ["web event create API rejects a slug reserved by a keepsake alias", async () => {
    const db = new FakeD1({
      events: [{ slug: "rave", owner_user_id: "other", title: "Rave" }],
      eventAliases: [{ old_slug: "party", slug: "rave", created_ms: 1 }],
    });
    const cookie = await signInCookie(db, "reserve-web@example.com", { ip: "203.0.113.39" });
    const user = [...db.authUsers.values()].find((row) => row.email === "reserve-web@example.com");
    db.profiles.push({ id: "profile-reserve-web", user_id: user.id, handle: "reserve.web", display_name: "Reserve Web", published: 1 });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/events", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "New", slug: "party" }),
    }), makeEnv({ DB: db }));
    assert.equal(resp.status, 409);
    assert.equal((await resp.json()).error, "slug reserved");
  }],
  ["web event auto-slug does not shadow a keepsake alias", async () => {
    const db = new FakeD1({
      events: [{ slug: "current-party", owner_user_id: "other", title: "Current Party" }],
      eventAliases: [{ old_slug: "party-night", slug: "current-party", created_ms: 1 }],
    });
    const cookie = await signInCookie(db, "auto-reserve@example.com", { ip: "203.0.113.40" });
    const user = [...db.authUsers.values()].find((row) => row.email === "auto-reserve@example.com");
    db.profiles.push({ id: "profile-auto-reserve", user_id: user.id, handle: "auto.reserve", display_name: "Auto Reserve", published: 1 });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/events", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "Party Night" }),
    }), makeEnv({ DB: db }));
    const json = await resp.json();
    assert.equal(resp.status, 200);
    assert.notEqual(json.slug, "party-night");
    assert.equal(db.eventAliases.get("party-night")?.slug, "current-party");
  }],
  ["broker publish-meta stamps replay activity and bumps DJ profile", async () => {
    const db = new FakeD1({
      deviceInstalls: [{ install_id: "abc123abc123", user_id: "user-publish", profile_id: "profile-publish" }],
      events: [{
        slug: "owned-publish",
        install_id: "abc123abc123",
        title: "Old Publish",
        status: "live",
        dj_profile_id: "profile-publish",
        last_activity_ms: 1,
      }],
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-meta", {
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
      deviceInstalls: [LINKED_INSTALL],
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
    const first = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-posts", {
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

    const second = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }), makeEnv({ DB: db }));
    assert.equal(second.status, 200);
      assert.equal(db.importedPosts.size, 2);
      assert.deepEqual([...db.importedPosts.keys()], ids);
    }],
    ["broker publish-posts rejects aggregate post cap before writing", async () => {
      const db = new FakeD1({
        deviceInstalls: [LINKED_INSTALL],
        events: [{ slug: "owned-posts-cap", install_id: "abc123abc123", title: "Owned Posts", status: "replay" }],
      });
      const posts = Array.from({ length: 201 }, (_, i) => ({
        localId: `post-${i}`,
        ts: 1,
        author: "Guest",
        text: "Nope",
        comments: [],
      }));
      const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "abc123abc123",
          secret: "secret-a",
          slug: "owned-posts-cap",
          posts,
        }),
      }), makeEnv({ DB: db }));
      assert.equal(resp.status, 413);
      assert.equal(db.importedPosts.size, 0);
    }],
  ["broker publish-posts rejects slug owned by another install", async () => {
    const db = new FakeD1({
      deviceInstalls: [LINKED_INSTALL],
      events: [{ slug: "other-posts", install_id: "def456def456", title: "Other", status: "replay" }],
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-posts", {
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
      deviceInstalls: [LINKED_INSTALL],
      events: [{ slug: "deleted-posts", install_id: "abc123abc123", title: "Deleted Posts", status: "replay" }],
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-posts", {
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
      deviceInstalls: [LINKED_INSTALL],
      events: [{ slug: "other-media", install_id: "def456def456", title: "Other", status: "replay" }],
      wallPosts: [{ id: "post-one", slug: "other-media", approved: 1, deleted_ms: null }],
    });
    const env = makeEnv({ DB: db });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-post-media", {
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
      deviceInstalls: [LINKED_INSTALL],
      events: [{ slug: "owned-media", install_id: "abc123abc123", title: "Owned", status: "replay" }],
    });
    const env = makeEnv({ DB: db });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-post-media", {
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
    ["broker publish-post-media rejects unsafe mime for media type", async () => {
      const db = new FakeD1({
        deviceInstalls: [LINKED_INSTALL],
        events: [{ slug: "owned-media", install_id: "abc123abc123", title: "Owned", status: "replay" }],
        wallPosts: [{ id: "post-one", slug: "owned-media", approved: 1, deleted_ms: null }],
      });
      const env = makeEnv({ DB: db });
      const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-post-media", {
        method: "PUT",
        headers: {
          "x-pp-id": "abc123abc123",
          "x-pp-secret": "secret-a",
          "x-pp-slug": "owned-media",
          "x-pp-post": "post-one",
          "x-pp-media": "media-one",
          "x-pp-media-type": "image",
          "x-pp-mime": "text/html",
          "content-length": contentLength("<script>alert(1)</script>"),
        },
        body: "<script>alert(1)</script>",
      }), env);
      assert.equal(resp.status, 400);
      assert.equal(env.DL.objects.has("event/owned-media/posts/post-one/media-one"), false);
      assert.equal(db.importedPostMedia.size, 0);
    }],
    ["broker publish-post-media writes R2 key and upserts post_media", async () => {
    const db = new FakeD1({
      deviceInstalls: [LINKED_INSTALL],
      events: [{ slug: "owned-media", install_id: "abc123abc123", title: "Owned", status: "replay" }],
      wallPosts: [{ id: "post-one", slug: "owned-media", approved: 1, deleted_ms: null }],
    });
    const env = makeEnv({ DB: db });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-post-media", {
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
      deviceInstalls: [LINKED_INSTALL],
      events: [{ slug: "owned-media", install_id: "abc123abc123", title: "Owned", status: "replay" }],
      wallPosts: [{ id: "post-one", slug: "owned-media", approved: 1, deleted_ms: null }],
    });
    const env = makeEnv({ DB: db });
    const upload = (body, name, sort) => worker.fetch(new Request("https://partyparty.party/api/broker/publish-post-media", {
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
  ["broker publish-post-media multipart rejects missing auth", async () => {
    const resp = await fetchPath("/api/broker/publish-post-media-multipart-init", {
      method: "POST",
      headers: {
        "x-pp-slug": "owned-media",
        "x-pp-post": "post-one",
        "x-pp-media": "media-one",
        "x-pp-media-type": "video",
        "x-pp-size": "10",
      },
    });
    assert.equal(resp.status, 403);
  }],
  ["broker publish-post-media multipart requires ordered complete parts", async () => {
    const db = new FakeD1({
      deviceInstalls: [LINKED_INSTALL],
      events: [{ slug: "owned-media", install_id: "abc123abc123", title: "Owned", status: "replay" }],
      wallPosts: [{ id: "post-one", slug: "owned-media", approved: 1, deleted_ms: null }],
    });
    const env = makeEnv({ DB: db });
    const headers = {
      "x-pp-id": "abc123abc123",
      "x-pp-secret": "secret-a",
      "x-pp-slug": "owned-media",
      "x-pp-post": "post-one",
      "x-pp-media": "media-video",
      "x-pp-media-type": "video",
      "x-pp-mime": "video/mp4",
      "x-pp-name": "clip.mp4",
      "x-pp-sort": "4",
      "x-pp-size": "10",
    };
    const init = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-post-media-multipart-init", {
      method: "POST",
      headers,
    }), env);
    assert.equal(init.status, 200);
    const { uploadId } = await init.json();
    const p1 = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-post-media-multipart-part", {
      method: "PUT",
      headers: { ...headers, "x-pp-upload-id": uploadId, "x-pp-part-number": "1", "content-length": "5" },
      body: "hello",
    }), env);
    const p2 = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-post-media-multipart-part", {
      method: "PUT",
      headers: { ...headers, "x-pp-upload-id": uploadId, "x-pp-part-number": "2", "content-length": "5" },
      body: "world",
    }), env);
    const j1 = await p1.json();
    const j2 = await p2.json();
    const bad = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-post-media-multipart-complete", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ uploadId, parts: [j2, j1], size: 10 }),
    }), env);
    assert.equal(bad.status, 400);
    assert.equal(env.DL.objects.has("event/owned-media/posts/post-one/media-video"), false);
    assert.equal(db.importedPostMedia.size, 0);
  }],
  ["broker publish-post-media multipart completes two parts and is idempotent", async () => {
    const db = new FakeD1({
      deviceInstalls: [LINKED_INSTALL],
      events: [{ slug: "owned-media", install_id: "abc123abc123", title: "Owned", status: "replay" }],
      wallPosts: [{ id: "post-one", slug: "owned-media", approved: 1, deleted_ms: null }],
    });
    const env = makeEnv({ DB: db });
    const headers = {
      "x-pp-id": "abc123abc123",
      "x-pp-secret": "secret-a",
      "x-pp-slug": "owned-media",
      "x-pp-post": "post-one",
      "x-pp-media": "media-video",
      "x-pp-media-type": "video",
      "x-pp-mime": "video/mp4",
      "x-pp-name": "clip.mp4",
      "x-pp-sort": "4",
      "x-pp-size": "10",
    };
    const init = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-post-media-multipart-init", {
      method: "POST",
      headers,
    }), env);
    assert.equal(init.status, 200);
    const { uploadId, mediaId } = await init.json();
    assert.equal(mediaId, "media-video");
    const uploadPart = async (partNumber, body) => {
      const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-post-media-multipart-part", {
        method: "PUT",
        headers: { ...headers, "x-pp-upload-id": uploadId, "x-pp-part-number": String(partNumber), "content-length": contentLength(body) },
        body,
      }), env);
      assert.equal(resp.status, 200);
      return await resp.json();
    };
    const firstP1 = await uploadPart(1, "hello");
    const retryP1 = await uploadPart(1, "hello");
    const p2 = await uploadPart(2, "world");
    assert.equal(retryP1.etag, firstP1.etag);
    const complete = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-post-media-multipart-complete", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ uploadId, parts: [retryP1, p2], size: 10 }),
    }), env);
    const json = await complete.json();
    const key = "event/owned-media/posts/post-one/media-video";
    const row = db.importedPostMedia.get("media-video");
    assert.equal(complete.status, 200);
    assert.deepEqual(json, { ok: true, key, mediaId: "media-video" });
    assert.equal(await env.DL.objects.get(key).text(), "helloworld");
    assert.equal(env.DL.objects.get(key).httpMetadata.contentType, "video/mp4");
    assert.equal(row.media_key, key);
    assert.equal(row.media_type, "video");
    assert.equal(row.mime_type, "video/mp4");
    assert.equal(row.name, "clip.mp4");
    assert.equal(row.size_bytes, 10);
    assert.equal(row.sort_order, 4);

    const again = await worker.fetch(new Request("https://partyparty.party/api/broker/publish-post-media-multipart-complete", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ uploadId, parts: [retryP1, p2], size: 10 }),
    }), env);
    const againJson = await again.json();
    assert.equal(again.status, 200);
    assert.equal(againJson.complete, true);
    assert.equal(db.importedPostMedia.size, 1);
  }],
    ["broker event-status rejects non-owner install", async () => {
      const db = new FakeD1({
        deviceInstalls: [LINKED_INSTALL],
        events: [{ slug: "owned-by-b", install_id: "def456def456", title: "Owned B", status: "upcoming" }],
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/event-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "owned-by-b", status: "live" }),
    }), makeEnv({ DB: db }));
    assert.equal(resp.status, 403);
      assert.equal(db.events.get("owned-by-b").status, "upcoming");
      assert.equal(db.events.get("owned-by-b").live_started_ms, undefined);
    }],
  ["broker event-status rejects over-cap JSON body", async () => {
    const db = new FakeD1({
      events: [{ slug: "owned-large-status", install_id: "abc123abc123", title: "Owned", status: "upcoming" }],
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/event-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "abc123abc123",
        secret: "secret-a",
        slug: "owned-large-status",
        status: "live",
        pad: "x".repeat(17000),
      }),
    }), makeEnv({ DB: db }));
    assert.equal(resp.status, 413);
    assert.equal(db.events.get("owned-large-status").status, "upcoming");
  }],
    ["broker event-status owner sets live and stamps start", async () => {
    const db = new FakeD1({
      deviceInstalls: [LINKED_INSTALL],
      events: [{ slug: "owned-live", install_id: "abc123abc123", title: "Owned Live", status: "upcoming", dj_profile_id: "profile-live" }],
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/event-status", {
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
      deviceInstalls: [LINKED_INSTALL],
      events: [{ slug: "owned-invalid-status", install_id: "abc123abc123", title: "Owned", status: "upcoming" }],
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/event-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "owned-invalid-status", status: "paused" }),
    }), makeEnv({ DB: db }));
    assert.equal(resp.status, 400);
    assert.equal(db.events.get("owned-invalid-status").status, "upcoming");
  }],
  ["broker diagnostics require install auth and stay scoped", async () => {
    let resp = await fetchPath("/api/broker/log-list", {
      method: "POST",
      body: JSON.stringify({ id: "abc123abc123", secret: "wrong" }),
    });
    assert.equal(resp.status, 403);

    resp = await fetchPath("/api/broker/log-list", {
      method: "POST",
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a" }),
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { logs: [] });

    resp = await fetchPath("/api/broker/log-get", {
      method: "POST",
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", key: "logs/def456def456/session-1.log.gz" }),
    });
    assert.equal(resp.status, 400);

    resp = await fetchPath("/api/broker/telemetry-dump", {
      method: "POST",
      body: JSON.stringify({ id: "abc123abc123", secret: "wrong", admin: "admin-secret", n: 3 }),
    }, { env: { ADMIN_KEY: "admin-secret" } });
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { entries: [] });
  }],
  ["google sign-in start redirects to Google and sets a state cookie", async () => {
    const db = new FakeD1({});
    const resp = await worker.fetch(new Request("https://partyparty.party/auth/google?redirect=/account", {}),
      makeEnv({ DB: db, env: GOOGLE_TEST_ENV }));
    assert.equal(resp.status, 302);
    const loc = resp.headers.get("location") || "";
    assert.ok(loc.startsWith("https://accounts.google.com/o/oauth2/v2/auth"), "redirects to Google");
    const locUrl = new URL(loc);
    assert.equal(locUrl.searchParams.get("client_id"), GOOGLE_TEST_ENV.AUTH_GOOGLE_ID);
    assert.equal(locUrl.searchParams.get("redirect_uri"), "https://partyparty.party/auth/google/callback");
    assert.equal(locUrl.searchParams.get("response_type"), "code");
    const state = locUrl.searchParams.get("state");
    assert.ok(state && state.length >= 16, "carries a state nonce");
    const sc = resp.headers.get("set-cookie") || "";
    assert.ok(sc.startsWith("pp_oauth="), "sets the oauth state cookie");
    assert.ok(sc.includes(state), "state cookie carries the same nonce");
  }],
  ["google sign-in is unavailable when unconfigured", async () => {
    const resp = await worker.fetch(new Request("https://partyparty.party/auth/google", {}), makeEnv({ DB: new FakeD1({}) }));
    assert.equal(resp.status, 302);
    assert.equal(resp.headers.get("location"), "/login");
  }],
  ["google callback creates a session for a verified email", async () => {
    const db = new FakeD1({});
    const resp = await withGoogleTokenMock(fakeIdToken(googleClaims()), () => googleCallbackReq(db, { redirect: "/account" }));
    assert.equal(resp.status, 302);
    // First sign-in mints a dj_profile and lands on the /welcome soft-gate.
    assert.equal(resp.headers.get("location"), "/welcome?redirect=%2Faccount");
    const sessionCookie = (resp.headers.get("set-cookie") || "").split(";")[0];
    assert.ok(sessionCookie.length > 0, "sets a session cookie");
    // The session must actually authenticate.
    const me = await worker.fetch(new Request("https://partyparty.party/api/me", { headers: { cookie: sessionCookie } }),
      makeEnv({ DB: db }));
    const meJson = await me.json();
    assert.equal(meJson.user && meJson.user.email, "dj@example.com");
  }],
  ["google callback rejects a forged state (CSRF)", async () => {
    const db = new FakeD1({});
    const resp = await withGoogleTokenMock(fakeIdToken(googleClaims()),
      () => googleCallbackReq(db, { state: "aaaaaaaa", cookieState: "bbbbbbbb" }));
    assertOAuthFailure(resp, db, "state");
  }],
  ["google callback rejects a missing code before token exchange", async () => {
    const db = new FakeD1({});
    const state = "s".repeat(32);
    let tokenFetches = 0;
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === "https://oauth2.googleapis.com/token") tokenFetches++;
      return oldFetch(input, init);
    };
    try {
      const resp = await worker.fetch(new Request(`https://partyparty.party/auth/google/callback?state=${state}`, {
        headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=g|${state}|/account` },
      }), makeEnv({ DB: db, env: GOOGLE_TEST_ENV }));
      assertOAuthFailure(resp, db, "state");
      assert.equal(tokenFetches, 0);
    } finally {
      globalThis.fetch = oldFetch;
    }
  }],
  ["google callback rejects a non-2xx token endpoint response", async () => {
    const db = new FakeD1({});
    const resp = await withGoogleTokenMock(fakeIdToken(googleClaims()),
      () => googleCallbackReq(db, {}), { status: 400 });
    assertOAuthFailure(resp, db, "verify");
  }],
  ["google callback rejects a malformed id_token", async () => {
    const db = new FakeD1({});
    const resp = await withGoogleTokenMock("not-a-jwt", () => googleCallbackReq(db, {}));
    assertOAuthFailure(resp, db, "verify");
  }],
  ["google callback rejects an id_token missing email", async () => {
    const db = new FakeD1({});
    const claims = googleClaims();
    delete claims.email;
    const resp = await withGoogleTokenMock(fakeIdToken(claims), () => googleCallbackReq(db, {}));
    assertOAuthFailure(resp, db, "verify");
  }],
  ["google callback rejects an expired id_token", async () => {
    const db = new FakeD1({});
    const resp = await withGoogleTokenMock(fakeIdToken(googleClaims({ exp: Math.floor(Date.now() / 1000) - 60 })),
      () => googleCallbackReq(db, {}));
    assertOAuthFailure(resp, db, "verify");
  }],
  ["google callback rejects an unverified email", async () => {
    const db = new FakeD1({});
    const resp = await withGoogleTokenMock(fakeIdToken(googleClaims({ email_verified: false })),
      () => googleCallbackReq(db, {}));
    assertOAuthFailure(resp, db, "verify");
  }],
  ["google callback rejects a wrong audience", async () => {
    const db = new FakeD1({});
    const resp = await withGoogleTokenMock(fakeIdToken(googleClaims({ aud: "someone-else.apps.googleusercontent.com" })),
      () => googleCallbackReq(db, {}));
    assertOAuthFailure(resp, db, "verify");
  }],
  ["login page shows Continue with Google only when configured", async () => {
    const on = await worker.fetch(new Request("https://partyparty.party/login", {}), makeEnv({ DB: new FakeD1({}), env: GOOGLE_TEST_ENV }));
    const onBody = await on.text();
    assert.ok(onBody.includes("Continue with Google"), "button present when configured");
    assert.ok(onBody.includes("/auth/google?redirect="), "button links to /auth/google");
    const off = await worker.fetch(new Request("https://partyparty.party/login", {}), makeEnv({ DB: new FakeD1({}) }));
    assert.ok(!(await off.text()).includes("Continue with Google"), "button hidden when unconfigured");
  }],
  ["apple sign-in start redirects to Apple with form_post and a None-SameSite cookie", async () => {
    const env = await makeAppleEnv();
    const resp = await worker.fetch(new Request("https://partyparty.party/auth/apple?redirect=/account", {}), makeEnv({ DB: new FakeD1({}), env }));
    assert.equal(resp.status, 302);
    const loc = resp.headers.get("location") || "";
    assert.ok(loc.startsWith("https://appleid.apple.com/auth/authorize"), "redirects to Apple");
    const locUrl = new URL(loc);
    assert.equal(locUrl.searchParams.get("client_id"), env.AUTH_APPLE_ID);
    assert.equal(locUrl.searchParams.get("response_mode"), "form_post");
    assert.equal(locUrl.searchParams.get("scope"), "name email");
    const sc = resp.headers.get("set-cookie") || "";
    assert.ok(sc.startsWith("pp_oauth="), "sets the oauth state cookie");
    assert.ok(/SameSite=None/i.test(sc), "state cookie is SameSite=None so it survives the cross-site form_post");
  }],
  ["apple sign-in is unavailable when unconfigured", async () => {
    const resp = await worker.fetch(new Request("https://partyparty.party/auth/apple", {}), makeEnv({ DB: new FakeD1({}) }));
    assert.equal(resp.status, 302);
    assert.equal(resp.headers.get("location"), "/login");
  }],
  ["apple callback mints the ES256 client secret and creates a session", async () => {
    const env = await makeAppleEnv();
    const db = new FakeD1({});
    const resp = await withAppleTokenMock(fakeIdToken(appleClaims(env)), () => appleCallbackReq(db, env, {}));
    assert.equal(resp.status, 302);
    // First sign-in mints a dj_profile and lands on the /welcome soft-gate.
    assert.equal(resp.headers.get("location"), "/welcome?redirect=%2Faccount");
    const sessionCookie = (resp.headers.get("set-cookie") || "").split(";")[0];
    assert.ok(sessionCookie.length > 0, "sets a session cookie");
    const me = await worker.fetch(new Request("https://partyparty.party/api/me", { headers: { cookie: sessionCookie } }), makeEnv({ DB: db }));
    const meJson = await me.json();
    assert.equal(meJson.user && meJson.user.email, "dj@icloud.com");
  }],
  ["apple callback rejects a forged state (CSRF)", async () => {
    const env = await makeAppleEnv();
    const db = new FakeD1({});
    const resp = await withAppleTokenMock(fakeIdToken(appleClaims(env)),
      () => appleCallbackReq(db, env, { state: "aaaaaaaa", cookieState: "bbbbbbbb" }));
    assertOAuthFailure(resp, db, "state");
  }],
  ["apple callback rejects a missing state before token exchange", async () => {
    const env = await makeAppleEnv();
    const db = new FakeD1({});
    const state = "a".repeat(32);
    let tokenFetches = 0;
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === "https://appleid.apple.com/auth/token") tokenFetches++;
      return oldFetch(input, init);
    };
    try {
      const resp = await worker.fetch(new Request("https://partyparty.party/auth/apple/callback", {
        method: "POST",
        headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=a|${state}|/account`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: "auth-code" }).toString(),
      }), makeEnv({ DB: db, env }));
      assertOAuthFailure(resp, db, "state");
      assert.equal(tokenFetches, 0);
    } finally {
      globalThis.fetch = oldFetch;
    }
  }],
  ["apple callback rejects a missing code", async () => {
    const env = await makeAppleEnv();
    const db = new FakeD1({});
    const resp = await withAppleTokenMock(fakeIdToken(appleClaims(env)),
      () => appleCallbackReq(db, env, { code: null }));
    assertOAuthFailure(resp, db, "state");
  }],
  ["apple callback rejects a non-2xx token endpoint response", async () => {
    const env = await makeAppleEnv();
    const db = new FakeD1({});
    const resp = await withAppleTokenMock(fakeIdToken(appleClaims(env)),
      () => appleCallbackReq(db, env, {}), { status: 500 });
    assertOAuthFailure(resp, db, "verify");
  }],
  ["apple callback rejects a malformed id_token", async () => {
    const env = await makeAppleEnv();
    const db = new FakeD1({});
    const resp = await withAppleTokenMock("not-a-jwt", () => appleCallbackReq(db, env, {}));
    assertOAuthFailure(resp, db, "verify");
  }],
  ["apple callback rejects an id_token missing email", async () => {
    const env = await makeAppleEnv();
    const db = new FakeD1({});
    const claims = appleClaims(env);
    delete claims.email;
    const resp = await withAppleTokenMock(fakeIdToken(claims), () => appleCallbackReq(db, env, {}));
    assertOAuthFailure(resp, db, "verify");
  }],
  ["apple callback rejects an expired id_token", async () => {
    const env = await makeAppleEnv();
    const db = new FakeD1({});
    const resp = await withAppleTokenMock(fakeIdToken(appleClaims(env, { exp: Math.floor(Date.now() / 1000) - 60 })),
      () => appleCallbackReq(db, env, {}));
    assertOAuthFailure(resp, db, "verify");
  }],
  ["apple callback rejects a wrong audience", async () => {
    const env = await makeAppleEnv();
    const db = new FakeD1({});
    const resp = await withAppleTokenMock(fakeIdToken(appleClaims(env, { aud: "com.someone.else" })),
      () => appleCallbackReq(db, env, {}));
    assertOAuthFailure(resp, db, "verify");
  }],
  ["apple callback rejects a GET (form_post is POST only)", async () => {
    const env = await makeAppleEnv();
    const db = new FakeD1({});
    const resp = await worker.fetch(new Request("https://partyparty.party/auth/apple/callback", {}), makeEnv({ DB: db, env }));
    assertOAuthFailure(resp, db, "method");
  }],
  ["login page shows Continue with Apple only when configured", async () => {
    const env = await makeAppleEnv();
    const on = await worker.fetch(new Request("https://partyparty.party/login", {}), makeEnv({ DB: new FakeD1({}), env }));
    assert.ok((await on.text()).includes("Continue with Apple"), "button present when configured");
    const off = await worker.fetch(new Request("https://partyparty.party/login", {}), makeEnv({ DB: new FakeD1({}) }));
    assert.ok(!(await off.text()).includes("Continue with Apple"), "button hidden when unconfigured");
  }],

  // ---- Phase 1: username identity backbone ----
  ["sign-in mints a dj_profile and lands on the /welcome soft-gate while unconfirmed", async () => {
    const db = new FakeD1();
    const r = await rawSignIn(db, "welcome-new@example.com", { ip: "203.0.113.60" });
    assert.equal(r.status, 302);
    assert.match(r.location, /^\/welcome\?redirect=/);
    const user = userByEmail(db, "welcome-new@example.com");
    const profile = db.profiles.find((p) => p.user_id === user.id);
    assert.ok(profile, "profile minted at sign-in");
    assert.ok(profile.handle_confirmed_ms == null, "minted handle is unconfirmed (NULL)");
    assert.equal(profile.handle, "welcome.new");

    const page = await worker.fetch(new Request("https://partyparty.party/welcome", { headers: { cookie: r.cookie } }), makeEnv({ DB: db }));
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Your username/);
    assert.match(html, /welcome\.new\.partyparty\.party/);
    assert.match(html, /\/api\/handle\/confirm/);
  }],
  ["/welcome redirects anonymous visitors to /login carrying the destination", async () => {
    const resp = await worker.fetch(new Request("https://partyparty.party/welcome?redirect=/account"), makeEnv({ DB: new FakeD1() }));
    assert.equal(resp.status, 302);
    assert.match(resp.headers.get("location") || "", /^\/login\?redirect=/);
  }],
  ["/api/handle/confirm keeps the handle, stamps confirmed, and stops the /welcome gate", async () => {
    const db = new FakeD1();
    const first = await rawSignIn(db, "confirm-keep@example.com", { ip: "203.0.113.61", redirect: "/account" });
    assert.equal(first.location, "/welcome?redirect=%2Faccount");
    const user = userByEmail(db, "confirm-keep@example.com");
    const profile = db.profiles.find((p) => p.user_id === user.id);
    const handle = profile.handle;

    const confirm = await worker.fetch(new Request("https://partyparty.party/api/handle/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: first.cookie },
      body: JSON.stringify({ handle, redirect: "/account" }),
    }), makeEnv({ DB: db }));
    const cj = await confirm.json();
    assert.equal(confirm.status, 200);
    assert.deepEqual(cj, { ok: true, handle, redirect: "/account" });
    assert.ok(profile.handle_confirmed_ms != null, "handle now confirmed");

    // A subsequent sign-in no longer routes through /welcome.
    const second = await rawSignIn(db, "confirm-keep@example.com", { ip: "203.0.113.61", redirect: "/account" });
    assert.equal(second.status, 302);
    assert.equal(second.location, "/account");
  }],
  ["/api/handle/confirm with a new handle renames and retires the minted default", async () => {
    const db = new FakeD1();
    const first = await rawSignIn(db, "confirm-change@example.com", { ip: "203.0.113.63" });
    const user = userByEmail(db, "confirm-change@example.com");
    const minted = db.profiles.find((p) => p.user_id === user.id).handle;
    assert.equal(minted, "confirm.change");

    const confirm = await worker.fetch(new Request("https://partyparty.party/api/handle/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: first.cookie },
      body: JSON.stringify({ handle: "djfresh" }),
    }), makeEnv({ DB: db }));
    const cj = await confirm.json();
    assert.equal(confirm.status, 200);
    assert.equal(cj.handle, "djfresh");
    const prof = db.profiles.find((p) => p.user_id === user.id);
    assert.equal(prof.handle, "djfresh");
    assert.ok(prof.handle_confirmed_ms != null, "confirmed on rename");
    assert.ok(db.handleAliases.get(minted), "minted default retired into aliases");

    const redirect = await worker.fetch(new Request(`https://partyparty.party/@${minted}`), makeEnv({ DB: db }));
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get("location"), "/@djfresh");
  }],
  ["/api/settings renames the username, retires the old handle, 301s /@old -> /@new, and cools down", async () => {
    const db = new FakeD1();
    const cookie = await signInCookie(db, "rename-me@example.com", { ip: "203.0.113.62" });
    const user = userByEmail(db, "rename-me@example.com");
    const now = Date.now();
    db.profiles.push({
      id: "p-rename", user_id: user.id, handle: "oldname", display_name: "Old Name",
      published: 1, handle_confirmed_ms: now - 5000, handle_changed_ms: null,
    });

    const rename = await worker.fetch(new Request("https://partyparty.party/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ handle: "newname", display_name: "New Name" }),
    }), makeEnv({ DB: db }));
    const rj = await rename.json();
    assert.equal(rename.status, 200);
    assert.equal(rj.ok, true);
    assert.equal(rj.handle, "newname");
    assert.equal(rj.display_name, "New Name");

    const prof = db.profiles.find((p) => p.id === "p-rename");
    assert.equal(prof.handle, "newname");
    assert.equal(prof.display_name, "New Name");
    assert.ok(prof.handle_changed_ms != null, "change stamped");
    const alias = db.handleAliases.get("oldname");
    assert.ok(alias, "old handle retired into aliases");
    assert.equal(alias.profile_id, "p-rename");

    const redirect = await worker.fetch(new Request("https://partyparty.party/@oldname"), makeEnv({ DB: db }));
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get("location"), "/@newname");

    const newProfile = await worker.fetch(new Request("https://partyparty.party/@newname"), makeEnv({ DB: db }));
    assert.equal(newProfile.status, 200);

    // A second change inside 30 days is rejected.
    const again = await worker.fetch(new Request("https://partyparty.party/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ handle: "thirdname" }),
    }), makeEnv({ DB: db }));
    const aj = await again.json();
    assert.equal(again.status, 429);
    assert.match(aj.error, /30 days/);
    assert.equal(db.profiles.find((p) => p.id === "p-rename").handle, "newname");
    assert.equal(db.handleAliases.has("thirdname"), false);
  }],
  ["/api/handle/confirm rejects reserved and taken usernames", async () => {
    const db = new FakeD1();
    const first = await rawSignIn(db, "picky@example.com", { ip: "203.0.113.64" });
    const user = userByEmail(db, "picky@example.com");
    db.profiles.push({ id: "p-other", user_id: "other-user", handle: "takenname", display_name: "Other", published: 1 });

    const reserved = await worker.fetch(new Request("https://partyparty.party/api/handle/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: first.cookie },
      body: JSON.stringify({ handle: "admin" }),
    }), makeEnv({ DB: db }));
    assert.equal(reserved.status, 409);
    assert.match((await reserved.json()).error, /reserved/);

    const taken = await worker.fetch(new Request("https://partyparty.party/api/handle/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: first.cookie },
      body: JSON.stringify({ handle: "takenname" }),
    }), makeEnv({ DB: db }));
    assert.equal(taken.status, 409);
    assert.match((await taken.json()).error, /taken/);

    const prof = db.profiles.find((p) => p.user_id === user.id);
    assert.equal(prof.handle, "picky");
    assert.ok(prof.handle_confirmed_ms == null, "still unconfirmed after failed attempts");
  }],
  ["/api/settings updates the display name without touching the handle", async () => {
    const db = new FakeD1();
    const cookie = await signInCookie(db, "dispname@example.com", { ip: "203.0.113.67" });
    const user = userByEmail(db, "dispname@example.com");
    db.profiles.push({ id: "p-disp", user_id: user.id, handle: "disp.dj", display_name: "Old", published: 1, handle_confirmed_ms: Date.now() });

    const resp = await worker.fetch(new Request("https://partyparty.party/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ display_name: "Brand New" }),
    }), makeEnv({ DB: db }));
    const j = await resp.json();
    assert.equal(resp.status, 200);
    assert.equal(j.handle, "disp.dj");
    assert.equal(j.display_name, "Brand New");
    const prof = db.profiles.find((p) => p.id === "p-disp");
    assert.equal(prof.display_name, "Brand New");
    assert.equal(prof.handle, "disp.dj");
    assert.equal(db.handleAliases.size, 0);
  }],
  ["/settings renders the identity editor and gates anonymous visitors", async () => {
    const anon = await worker.fetch(new Request("https://partyparty.party/settings"), makeEnv({ DB: new FakeD1() }));
    assert.equal(anon.status, 302);
    assert.equal(anon.headers.get("location"), "/login?redirect=/settings");

    const db = new FakeD1();
    const cookie = await signInCookie(db, "settings-view@example.com", { ip: "203.0.113.65" });
    const user = userByEmail(db, "settings-view@example.com");
    db.profiles.push({ id: "p-set", user_id: user.id, handle: "settings.dj", display_name: "Set DJ", published: 1, handle_confirmed_ms: Date.now() });
    const page = await worker.fetch(new Request("https://partyparty.party/settings", { headers: { cookie } }), makeEnv({ DB: db }));
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Settings/);
    assert.match(html, /settings\.dj/);
    assert.match(html, /Edit public profile/);
    assert.match(html, /\/api\/settings/);
  }],
  ["/account nudges unconfirmed usernames and links to settings", async () => {
    const db = new FakeD1();
    const cookie = await signInCookie(db, "nudge@example.com", { ip: "203.0.113.66" });
    const user = userByEmail(db, "nudge@example.com");
    db.profiles.push({ id: "p-nudge", user_id: user.id, handle: "nudge.dj", display_name: "Nudge", published: 1, handle_confirmed_ms: null });
    const page = await worker.fetch(new Request("https://partyparty.party/account", { headers: { cookie } }), makeEnv({ DB: db }));
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Confirm your username/);
    assert.match(html, /href="\/welcome"/);
    assert.match(html, /href="\/settings"/);
  }],

  // ---- Phase 2/3: live presence, discovery, cloud mirror, wildcard router ----

  ["/api/broker/live registers presence, resolves the handle server-side, and writes the grey slug-host A record", async () => {
    const db = new FakeD1({
      deviceInstalls: [{ install_id: "abc123abc123", user_id: "user-live", profile_id: "profile-live", revoked_ms: null }],
      profiles: [{ id: "profile-live", user_id: "user-live", handle: "wave", display_name: "DJ Wave", published: 1 }],
      events: [{ slug: "rooftop-night", install_id: "abc123abc123", dj_profile_id: "profile-live", status: "live", live_started_ms: 5000 }],
    });
    await withCloudflareDNSMock(async (calls) => {
      const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/live", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
        body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", lan_ip: "192.168.1.50", title: "Rooftop", now_playing: "Opening Track" }),
      }), makeEnv({ DB: db }));
      const json = await resp.json();
      assert.equal(resp.status, 200);
      assert.equal(json.host, "disco12.party.party.example.test");
      assert.equal(json.claimed, true);

      const row = db.liveInstalls.get("abc123abc123");
      assert.equal(row.handle, "wave");
      assert.equal(row.dj_name, "DJ Wave");
      assert.equal(row.event_title, "Rooftop");
      assert.equal(row.now_playing, "Opening Track");
      assert.equal(row.host, "disco12.party.party.example.test");
      assert.equal(row.lan_ip, "192.168.1.50");
      assert.equal(row.event_slug, "rooftop-night");
      // Public IP hash comes from cf-connecting-ip ONLY — never a Mac-supplied value.
      assert.equal(row.public_ip_hash, await sha256Hex("ip:203.0.113.9"));
      assert.ok(row.expires_ms > Date.now());

      // Grey A record written for the LOCAL slug host -> lan_ip (never the handle).
      const aPost = calls.find((c) => c.method === "POST" && c.body?.type === "A");
      assert.equal(aPost.body.name, "disco12.party.party.example.test");
      assert.equal(aPost.body.content, "192.168.1.50");
      assert.equal(aPost.body.proxied, false);
    });
  }],

  ["/api/broker/live refuses an install that is not linked to an account", async () => {
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/live", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", lan_ip: "192.168.1.50" }),
    }), makeEnv({ DB: new FakeD1() }));
    assert.equal(resp.status, 403);
    assert.equal((await resp.json()).reason, "not_linked");
  }],

  ["/api/broker/live claimant: most-recent go-live wins; primary_install_id overrides", async () => {
    const past = Date.now() - 100000;
    const future = Date.now() + 600000;
    const makeDb = (primaryInstall) => new FakeD1({
      deviceInstalls: [
        { install_id: "abc123abc123", user_id: "user-w", profile_id: "profile-w", revoked_ms: null },
        { install_id: "def456def456", user_id: "user-w", profile_id: "profile-w", revoked_ms: null },
      ],
      profiles: [{ id: "profile-w", user_id: "user-w", handle: "wave", display_name: "Wave", published: 1, primary_install_id: primaryInstall }],
      liveInstalls: [{
        install_id: "def456def456", handle: "wave", profile_id: "profile-w",
        public_ip_hash: "other", host: "groove34.party.example.test", lan_ip: "10.0.0.9",
        event_slug: "", dj_name: "Wave", event_title: "", listeners: 0, now_playing: "",
        live_started_ms: past, last_seen_ms: past, expires_ms: future,
      }],
    });
    // No primary pin: abc123 goes live NOW (more recent) -> it is the claimant.
    await withCloudflareDNSMock(async () => {
      const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/live", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.1" },
        body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", lan_ip: "192.168.1.7" }),
      }), makeEnv({ DB: makeDb(null) }));
      assert.equal((await resp.json()).claimed, true);
    });
    // primary_install_id pins the OTHER Mac: abc123 goes live but is NOT the claimant.
    await withCloudflareDNSMock(async () => {
      const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/live", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.1" },
        body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", lan_ip: "192.168.1.7" }),
      }), makeEnv({ DB: makeDb("def456def456") }));
      assert.equal((await resp.json()).claimed, false);
    });
  }],

  ["/api/broker/offline drops the presence row and deletes the grey slug-host A record", async () => {
    const db = new FakeD1({
      liveInstalls: [{
        install_id: "abc123abc123", handle: "wave", profile_id: "profile-w",
        public_ip_hash: "h", host: "disco12.party.party.example.test", lan_ip: "192.168.1.5",
        event_slug: "", dj_name: "Wave", event_title: "", listeners: 0, now_playing: "",
        live_started_ms: 1000, last_seen_ms: 1000, expires_ms: Date.now() + 60000,
      }],
    });
    await withCloudflareDNSRecords(
      [{ id: "rec-a", type: "A", name: "disco12.party.party.example.test", content: "192.168.1.5" }],
      async (calls) => {
        const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/offline", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "abc123abc123", secret: "secret-a" }),
        }), makeEnv({ DB: db }));
        assert.equal(resp.status, 200);
        assert.equal(db.liveInstalls.has("abc123abc123"), false);
        const del = calls.find((c) => c.method === "DELETE");
        assert.ok(del, "deletes the A record on clean offline");
        assert.match(del.url, /\/dns_records\/rec-a$/);
      }
    );
  }],

  ["/api/discover returns all live parties to probe (IP-matched first), excluding expired rows", async () => {
    const callerHash = await sha256Hex("ip:203.0.113.20");
    const future = Date.now() + 60000;
    const db = new FakeD1({
      liveInstalls: [
        {
          install_id: "abc123abc123", handle: "wave", profile_id: "profile-w", public_ip_hash: callerHash,
          host: "disco12.party.party.example.test", lan_ip: "192.168.1.5", event_slug: "s1", dj_name: "DJ Wave",
          event_title: "Rooftop", listeners: 3, now_playing: "Track A", live_started_ms: 2000, last_seen_ms: 2000, expires_ms: future,
        },
        {
          install_id: "def456def456", handle: "beat", profile_id: "profile-b", public_ip_hash: "someone-else",
          host: "groove34.party.example.test", lan_ip: "10.0.0.2", event_slug: "s2", dj_name: "DJ Beat",
          event_title: "Basement", listeners: 0, now_playing: "", live_started_ms: 3000, last_seen_ms: 3000, expires_ms: future,
        },
        {
          install_id: "aaa111aaa111", handle: "stale", profile_id: "profile-s", public_ip_hash: callerHash,
          host: "vinyl99.party.example.test", lan_ip: "192.168.1.9", event_slug: "s3", dj_name: "DJ Stale",
          event_title: "Old", listeners: 0, now_playing: "", live_started_ms: 1000, last_seen_ms: 1000, expires_ms: Date.now() - 5000,
        },
      ],
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/discover", {
      headers: { "cf-connecting-ip": "203.0.113.20" },
    }), makeEnv({ DB: db }));
    const json = await resp.json();
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get("cache-control"), "no-store");
    // Both live parties returned (the client probes to find which is on this LAN);
    // the expired row is excluded. IP-matched party sorts first.
    assert.equal(json.parties.length, 2);
    assert.deepEqual(json.parties[0], {
      host: "disco12.party.party.example.test",
      handle: "wave",
      // No guest_port on this seed row -> the join URL falls back to :8443.
      joinUrl: "https://disco12.party.party.example.test:8443/",
      ipHint: true, // cloud IP agrees; still probed client-side
      djName: "DJ Wave",
      eventTitle: "Rooftop",
      nowPlaying: "Track A",
    });
    assert.deepEqual(json.parties[1], {
      host: "groove34.party.example.test",
      handle: "beat",
      joinUrl: "https://groove34.party.example.test:8443/",
      ipHint: false, // different cloud IP, but still offered for probing
      djName: "DJ Beat",
      eventTitle: "Basement",
      nowPlaying: "",
    });
    assert.ok(!json.parties.some((p) => p.host.startsWith("vinyl99")), "expired row excluded");
  }],

  ["event join: web guests get the LAN-style identity ask (name/emoji/optional email)", async () => {
    const db = new FakeD1({
      events: [{ slug: "rooftop-night", install_id: "abc123abc123", title: "Rooftop", host: "DJ Wave", status: "live", created_ms: 1, updated_ms: 1 }],
    });
    const env = makeEnv({ DB: db });
    // First join (anon, no cookie): stores identity + email, mints the shared rsvp cookie.
    const first = await worker.fetch(new Request("https://partyparty.party/api/e/rooftop-night/join", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({ name: "Nassim", emoji: "🎧", email: "Nassim@Example.com" }),
    }), env);
    assert.equal(first.status, 200);
    const cookie = (first.headers.get("set-cookie") || "").split(";")[0];
    assert.match(cookie, /^pp_rsvp=/);
    const rows = [...db.eventGuests.values()];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "Nassim");
    assert.equal(rows[0].emoji, "🎧");
    assert.equal(rows[0].email, "nassim@example.com"); // lowercased
    // Re-join with the SAME cookie and no email: name updates, email is KEPT.
    const second = await worker.fetch(new Request("https://partyparty.party/api/e/rooftop-night/join", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", cookie },
      body: JSON.stringify({ name: "Nassim K", emoji: "🔥", email: "" }),
    }), env);
    assert.equal(second.status, 200);
    const after = [...db.eventGuests.values()];
    assert.equal(after.length, 1, "same guest upserts one row");
    assert.equal(after[0].name, "Nassim K");
    assert.equal(after[0].email, "nassim@example.com");
    // A different browser behind the same NAT gets a different guest identity;
    // it must not overwrite Nassim's name or private email.
    const neighbor = await worker.fetch(new Request("https://partyparty.party/api/e/rooftop-night/join", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({ name: "Maya", emoji: "🪩", email: "maya@example.com" }),
    }), env);
    assert.equal(neighbor.status, 200);
    assert.notEqual((neighbor.headers.get("set-cookie") || "").split(";")[0], cookie);
    const neighbors = [...db.eventGuests.values()];
    assert.equal(neighbors.length, 2);
    assert.deepEqual(neighbors.map((row) => row.email).sort(), ["maya@example.com", "nassim@example.com"]);
    // Garbage email -> 400; unknown event -> 404.
    const bad = await worker.fetch(new Request("https://partyparty.party/api/e/rooftop-night/join", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "not-an-email" }),
    }), env);
    assert.equal(bad.status, 400);
    const gone = await worker.fetch(new Request("https://partyparty.party/api/e/nope-nope/join", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }),
    }), env);
    assert.equal(gone.status, 404);

    const replay = new FakeD1({
      events: [{ slug: "old-night", install_id: "abc123abc123", title: "Old", status: "replay" }],
    });
    const closed = await worker.fetch(new Request("https://partyparty.party/api/e/old-night/join", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }), makeEnv({ DB: replay }));
    assert.equal(closed.status, 403);
    assert.equal(replay.eventGuests.size, 0);
  }],

  ["shared feed: presence heartbeat counts web listeners; web posts land on the wall and ride the check-in", async () => {
    const db = new FakeD1({
      events: [{ slug: "rooftop-night", install_id: "abc123abc123", title: "Rooftop", host: "DJ Wave", status: "live", created_ms: 1, updated_ms: 1 }],
      deviceInstalls: [{ install_id: "abc123abc123", user_id: "user-w", profile_id: "profile-w", revoked_ms: null }],
      profiles: [{ id: "profile-w", user_id: "user-w", handle: "wave", display_name: "DJ Wave", published: 1, handle_confirmed_ms: 5 }],
    });
    const env = makeEnv({ DB: db });
    // A bare heartbeat cannot mint identities and inflate the count.
    const hb = await worker.fetch(new Request("https://partyparty.party/api/e/rooftop-night/presence", {
      method: "POST", headers: { "cf-connecting-ip": "203.0.113.30" },
    }), env);
    assert.equal(hb.status, 200);
    assert.equal((await hb.json()).webListeners, 0);
    assert.equal(db.eventGuests.size, 0);
    // Join mints a browser identity; only that existing identity can heartbeat.
    const joined = await worker.fetch(new Request("https://partyparty.party/api/e/rooftop-night/join", {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.30" },
      body: JSON.stringify({ name: "Web Wanda", emoji: "✨" }),
    }), env);
    const cookie = (joined.headers.get("set-cookie") || "").split(";")[0];
    assert.equal([...db.eventGuests.values()].length, 1);
    const counted = await worker.fetch(new Request("https://partyparty.party/api/e/rooftop-night/presence", {
      method: "POST", headers: { "cf-connecting-ip": "203.0.113.30", cookie },
    }), env);
    assert.equal((await counted.json()).webListeners, 1);
    // Web guest posts to the shared wall.
    const post = await worker.fetch(new Request("https://partyparty.party/api/e/rooftop-night/post", {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.30", cookie },
      body: JSON.stringify({ name: "Impostor", emoji: "😈", text: "hi from the internet" }),
    }), env);
    assert.equal(post.status, 200);
    // It renders on the event page wall...
    const page = await worker.fetch(new Request("https://partyparty.party/e/rooftop-night"), env);
    const html = await page.text();
    assert.match(html, /hi from the internet/);
    assert.match(html, /Web Wanda/);
    assert.doesNotMatch(html, /Impostor/);
    // ...and rides back to the ROOM on the Mac's live check-in response.
    await withCloudflareDNSMock(async () => {
      db.liveInstalls.set("abc123abc123", {
        install_id: "abc123abc123", handle: "wave", profile_id: "profile-w", public_ip_hash: "h",
        host: "wave-live.party.example.test", lan_ip: "192.168.1.4", guest_port: 8443,
        event_slug: "rooftop-night", dj_name: "DJ Wave", event_title: "Rooftop", listeners: 2,
        now_playing: "", live_started_ms: 1, last_seen_ms: 1, expires_ms: Date.now() + 60000,
      });
      const beat = await worker.fetch(new Request("https://partyparty.party/api/broker/live", {
        method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.7" },
        body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", lan_ip: "192.168.1.4", guest_port: 8443 }),
      }), env);
      const j = await beat.json();
      assert.equal(j.ok, true);
      assert.equal(j.webListeners, 1);
      assert.equal(j.webPosts.length, 1);
      assert.equal(j.webPosts[0].author, "Web Wanda");
      assert.equal(j.webPosts[0].text, "hi from the internet");
    });
    // Empty text -> 400. Composer + refresh glue ship on the live page.
    const empty = await worker.fetch(new Request("https://partyparty.party/api/e/rooftop-night/post", {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.99" },
      body: JSON.stringify({ text: "   " }),
    }), env);
    assert.equal(empty.status, 400);
    assert.match(html, /pp-comp-text/);
    assert.match(html, /\/presence/);

    // Replay keepsakes are CLOSED: no new posts, no count inflation (review).
    const replayDb = new FakeD1({
      events: [{ slug: "old-night", install_id: "abc123abc123", title: "Old", host: "DJ", status: "replay", created_ms: 1, updated_ms: 1 }],
    });
    const replayEnv = makeEnv({ DB: replayDb });
    const deadPost = await worker.fetch(new Request("https://partyparty.party/api/e/old-night/post", {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.50" },
      body: JSON.stringify({ text: "necro comment" }),
    }), replayEnv);
    assert.equal(deadPost.status, 403);
    const deadPresence = await worker.fetch(new Request("https://partyparty.party/api/e/old-night/presence", {
      method: "POST", headers: { "cf-connecting-ip": "203.0.113.50" },
    }), replayEnv);
    assert.equal((await deadPresence.json()).webListeners, 0);
    assert.equal([...replayDb.eventGuests.values()].length, 0);

    // Bidi/control injection is stripped from guest-authored text (review).
    const bidi = await worker.fetch(new Request("https://partyparty.party/api/e/rooftop-night/post", {
      method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.51" },
      body: JSON.stringify({ name: "evil‮name", text: "hi‮ there " }),
    }), env);
    assert.equal(bidi.status, 200);
    const bidiPost = env.DB.wallPosts.find((p) => p.author.startsWith("evil"));
    assert.equal(bidiPost.author, "evilname");
    assert.equal(bidiPost.text, "hi there");
  }],

  ["shared feed: signed-in posters keep ownership and hit the per-user rate cap", async () => {
    const db = new FakeD1({
      events: [{ slug: "signed-live", install_id: "abc123abc123", title: "Signed", status: "live" }],
    });
    const cookie = await signInCookie(db, "poster@example.com", { ip: "203.0.113.61" });
    const user = [...db.authUsers.values()].find((row) => row.email_norm === "poster@example.com");
    for (let i = 0; i < 6; i += 1) {
      const resp = await worker.fetch(new Request("https://partyparty.party/api/e/signed-live/post", {
        method: "POST",
        headers: { "content-type": "application/json", cookie, "cf-connecting-ip": `203.0.113.${70 + i}` },
        body: JSON.stringify({ name: "Signed Guest", text: `post ${i}` }),
      }), makeEnv({ DB: db }));
      assert.equal(resp.status, 200);
    }
    const limited = await worker.fetch(new Request("https://partyparty.party/api/e/signed-live/post", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "cf-connecting-ip": "203.0.113.90" },
      body: JSON.stringify({ name: "Signed Guest", text: "post 6" }),
    }), makeEnv({ DB: db }));
    assert.equal(limited.status, 429);
    assert.equal(db.wallPosts.length, 6);
    assert.ok(db.wallPosts.every((row) => row.author_user_id === user.id));
  }],

  ["live mirror ingest + serve: segment audio/mp2t (cacheable), playlist mpegurl (no-store), inline eviction", async () => {
    const db = new FakeD1({ deviceInstalls: [LINKED_INSTALL] });
    const env = makeEnv({ DB: db }); // reuse ONE env so R2 state persists across calls
    // A stale segment the new window will no longer reference.
    await env.DL.put("event/known-set/live/seg-0.ts", "old", { httpMetadata: { contentType: "audio/mp2t" } });

    const segResp = await worker.fetch(new Request("https://partyparty.party/api/broker/live-segment", {
      method: "PUT",
      headers: {
        "x-pp-id": "abc123abc123", "x-pp-secret": "secret-a", "x-pp-slug": KNOWN_SLUG, "x-pp-file": "seg-1.ts",
        "content-length": String(new TextEncoder().encode("tsdata").byteLength),
      },
      body: "tsdata",
    }), env);
    assert.equal(segResp.status, 200);
    assert.equal((await segResp.json()).key, "event/known-set/live/seg-1.ts");

    const playlist = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:3\n#EXTINF:3.0,\nseg-1.ts\n";
    const plResp = await worker.fetch(new Request("https://partyparty.party/api/broker/live-playlist", {
      method: "PUT",
      headers: { "x-pp-id": "abc123abc123", "x-pp-secret": "secret-a", "x-pp-slug": KNOWN_SLUG, "x-pp-file": "live.m3u8" },
      body: playlist,
    }), env);
    assert.equal(plResp.status, 200);
    // Eviction: seg-0 (out of window) removed; seg-1 (referenced) kept.
    assert.equal(await env.DL.get("event/known-set/live/seg-0.ts"), null);
    assert.ok(await env.DL.get("event/known-set/live/seg-1.ts"));

    // Serve the segment: audio/mp2t + CDN-cacheable.
    const segGet = await worker.fetch(new Request("https://partyparty.party/event/known-set/live/seg-1.ts"), env);
    assert.equal(segGet.status, 200);
    assert.equal(segGet.headers.get("content-type"), "audio/mp2t");
    assert.match(segGet.headers.get("cache-control"), /max-age=30/);

    // Serve the playlist: mpegurl + no-store (always the live edge).
    const plGet = await worker.fetch(new Request("https://partyparty.party/event/known-set/live/live.m3u8"), env);
    assert.equal(plGet.status, 200);
    assert.equal(plGet.headers.get("content-type"), "application/vnd.apple.mpegurl");
    assert.equal(plGet.headers.get("cache-control"), "no-store");
    assert.match(await plGet.text(), /seg-1\.ts/);
  }],

  ["live mirror ingest rejects a slug the install does not own", async () => {
    // Slug owned by ANOTHER install -> hard 403 (the real ownership protection).
    const db = new FakeD1({
      deviceInstalls: [LINKED_INSTALL],
      events: [{ slug: "not-mine", install_id: "def456def456", status: "live" }],
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/api/broker/live-segment", {
      method: "PUT",
      headers: { "x-pp-id": "abc123abc123", "x-pp-secret": "secret-a", "x-pp-slug": "not-mine", "x-pp-file": "seg-1.ts" },
      body: "tsdata",
    }), makeEnv({ DB: db }));
    assert.equal(resp.status, 403);
    assert.equal((await resp.json()).error, "not your event");

    // UNLINKED install + no event row -> also 403 (mirror can't mint for it).
    const anon = await worker.fetch(new Request("https://partyparty.party/api/broker/live-segment", {
      method: "PUT",
      headers: { "x-pp-id": "abc123abc123", "x-pp-secret": "secret-a", "x-pp-slug": "fresh-party", "x-pp-file": "seg-1.ts" },
      body: "tsdata",
    }), makeEnv({ DB: new FakeD1() }));
    assert.equal(anon.status, 403);
  }],

  ["live mirror mints the live event for a fresh party (the field 403 bug)", async () => {
    // Nothing creates the events row at go-live (publish runs at set END), so the
    // mirror must mint it itself — otherwise every segment of a fresh party 403s
    // (observed live: 2.8k failed uploads across one set, no remote stream).
    const db = new FakeD1({
      deviceInstalls: [{ install_id: "abc123abc123", user_id: "user-m", profile_id: "profile-m", revoked_ms: null }],
      liveInstalls: [{
        install_id: "abc123abc123", handle: "seth", profile_id: "profile-m", public_ip_hash: "h",
        host: "seth-live.party.party.example.test", lan_ip: "10.0.0.5", event_slug: "", dj_name: "Seth",
        event_title: "Rooftop", listeners: 0, now_playing: "", live_started_ms: 1, last_seen_ms: 1,
        expires_ms: Date.now() + 60000,
      }],
    });
    const env = makeEnv({ DB: db });
    const seg = await worker.fetch(new Request("https://partyparty.party/api/broker/live-segment", {
      method: "PUT",
      headers: {
        "x-pp-id": "abc123abc123", "x-pp-secret": "secret-a", "x-pp-slug": "fresh-party", "x-pp-file": "live0.ts",
        "content-length": String(new TextEncoder().encode("tsdata").byteLength),
      },
      body: "tsdata",
    }), env);
    assert.equal(seg.status, 200);
    const minted = db.events.get("fresh-party");
    assert.ok(minted, "event row minted by the mirror");
    assert.equal(minted.install_id, "abc123abc123");
    assert.equal(minted.status, "live");
    assert.equal(minted.title, "Rooftop");
    assert.equal(db.liveInstalls.get("abc123abc123").event_slug, "fresh-party");
    // Clean offline demotes the phantom 'live' event to replay.
    const off = await worker.fetch(new Request("https://partyparty.party/api/broker/offline", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a" }),
    }), env);
    assert.equal(off.status, 200);
    assert.equal(db.events.get("fresh-party").status, "replay");
  }],

  ["wildcard router: the live join page sends off-LAN guests to the EVENT page", async () => {
    const db = new FakeD1({
      liveInstalls: [{
        install_id: "abc123abc123", handle: "wave", profile_id: "profile-w",
        public_ip_hash: await sha256Hex("ip:198.51.100.7"), host: "disco12.party.party.example.test", lan_ip: "192.168.1.5",
        event_slug: "rooftop-night", dj_name: "DJ Wave", event_title: "Rooftop", listeners: 4, now_playing: "Track Z",
        live_started_ms: 2000, last_seen_ms: 2000, expires_ms: Date.now() + 60000,
      }],
    });
    const resp = await worker.fetch(new Request("https://wave.party.example.test/", {
      headers: { "cf-connecting-ip": "203.0.113.200" },
    }), makeEnv({ DB: db }));
    const html = await resp.text();
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get("content-type"), "text/html; charset=utf-8");
    // The probe-fail path redirects to the event page (the off-Wi-Fi listen surface).
    assert.match(html, /\/e\/rooftop-night/);
    assert.match(html, /DJ Wave/);
    assert.match(html, /Track Z/);
  }],

  ["handle domain: non-root paths fall through — the mirror playlist streams, not the join page", async () => {
    // The bug this locks out: the router used to swallow EVERY path on
    // <handle>.party..., so the <audio> element asked for the playlist and got
    // HTML back — "tap to listen" silently did nothing.
    const db = new FakeD1({
      liveInstalls: [{
        install_id: "abc123abc123", handle: "wave", profile_id: "profile-w",
        public_ip_hash: "h", host: "disco12.party.party.example.test", lan_ip: "192.168.1.5",
        event_slug: "known-set", dj_name: "DJ Wave", event_title: "", listeners: 0, now_playing: "",
        live_started_ms: 2000, last_seen_ms: 2000, expires_ms: Date.now() + 60000,
      }],
    });
    const env = makeEnv({
      DB: db,
      r2Objects: { "event/known-set/live/live.m3u8": new FakeR2Object("#EXTM3U\nlive0.ts\n", { contentType: "application/vnd.apple.mpegurl" }) },
    });
    const resp = await worker.fetch(new Request("https://wave.party.example.test/event/known-set/live/live.m3u8", {
      headers: { "cf-connecting-ip": "203.0.113.200" },
    }), env);
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get("content-type"), "application/vnd.apple.mpegurl");
    assert.match(await resp.text(), /#EXTM3U/);
  }],

  ["event page: a live event with a cloud mirror renders the delayed player + LAN link", async () => {
    const db = new FakeD1({
      events: [{
        slug: "rooftop-night", install_id: "abc123abc123", title: "Rooftop", host: "DJ Wave",
        status: "live", owner_user_id: "user-w", created_ms: 1, updated_ms: 1,
      }],
      liveInstalls: [{
        install_id: "abc123abc123", handle: "wave", profile_id: "profile-w",
        public_ip_hash: "h", host: "disco12.party.party.example.test", lan_ip: "192.168.1.5", guest_port: 8443,
        event_slug: "rooftop-night", dj_name: "DJ Wave", event_title: "Rooftop", listeners: 7, now_playing: "Track Z",
        live_started_ms: 2000, last_seen_ms: 2000, expires_ms: Date.now() + 60000,
      }],
    });
    const env = makeEnv({
      DB: db,
      r2Objects: { "event/rooftop-night/live/live.m3u8": new FakeR2Object("#EXTM3U\nlive0.ts\n", { contentType: "application/vnd.apple.mpegurl" }) },
    });
    const resp = await worker.fetch(new Request("https://partyparty.party/e/rooftop-night"), env);
    const html = await resp.text();
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get("cache-control"), "private, no-store"); // live pages must not cache
    assert.match(html, /\/event\/rooftop-night\/live\/live\.m3u8/); // the delayed stream
    assert.match(html, /Tap to listen/);
    assert.match(html, /a few seconds behind/);
    assert.match(html, /https:\/\/disco12\.party\.party\.example\.test:8443\//); // "at the party" LAN link
    assert.match(html, /Track Z/);
    // The LAN-style identity ask ships with the live player.
    assert.match(html, /pp-join-name/);
    assert.match(html, /Email \(optional\)/);
    assert.match(html, /\/api\/e\/rooftop-night\/join/);
    assert.match(html, /Just listen/); // playback is never gated

    // Same live event WITHOUT a mirror playlist in R2 -> no dead player element
    // (the live-page script may still reference the id; only the <audio> matters).
    const noMirror = await worker.fetch(new Request("https://partyparty.party/e/rooftop-night"), makeEnv({ DB: db }));
    const nmHtml = await noMirror.text();
    assert.doesNotMatch(nmHtml, /<audio id="pp-live-audio"/);
    // The shared wall (composer + refresh) still ships while live.
    assert.match(nmHtml, /pp-comp-text/);
    assert.match(nmHtml, /pp-wall/);
  }],

  ["wildcard router: live handle serves the LAN-probe join page carrying the Mac's :port URL", async () => {
    const db = new FakeD1({
      liveInstalls: [{
        install_id: "abc123abc123", handle: "wave", profile_id: "profile-w",
        public_ip_hash: await sha256Hex("ip:198.51.100.7"), host: "disco12.party.party.example.test", lan_ip: "192.168.1.5",
        guest_port: 8443,
        event_slug: "rooftop-night", dj_name: "DJ Wave", event_title: "Rooftop", listeners: 4, now_playing: "",
        live_started_ms: 2000, last_seen_ms: 2000, expires_ms: Date.now() + 60000,
      }],
    });
    // No server-side IP 302 (unreliable behind Private Relay/CGNAT): the page ships
    // the LAN URL + a client probe that redirects there when the Mac is reachable.
    const resp = await worker.fetch(new Request("https://wave.party.example.test/", {
      headers: { "cf-connecting-ip": "198.51.100.7" },
    }), makeEnv({ DB: db }));
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get("content-type"), "text/html; charset=utf-8");
    const html = await resp.text();
    // The Mac serves guests on its high HTTPS port, not 443 — the probe/redirect carries it.
    assert.match(html, /https:\/\/disco12\.party\.party\.example\.test:8443\//);
    assert.match(html, /no-cors/);            // the reachability probe
    assert.match(html, /location\.replace/);  // redirect to the LAN listener when reachable
    assert.match(html, /DJ Wave/);
  }],

  ["wildcard router: ?pp-state JSON lets the join page discover the minted event page (startup-window fix)", async () => {
    // A guest who scans during the ~30-60s after Go Live renders the join page
    // BEFORE the first mirror upload mints the live event — the page polls
    // ?pp-state and jumps when eventPath appears (or reloads when live ends).
    const mk = (event_slug) => new FakeD1({
      liveInstalls: [{
        install_id: "abc123abc123", handle: "wave", profile_id: "profile-w",
        public_ip_hash: "x", host: "disco12.party.party.example.test", lan_ip: "192.168.1.5",
        guest_port: 8443, event_slug, dj_name: "DJ Wave", event_title: "Rooftop",
        listeners: 0, now_playing: "",
        live_started_ms: 2000, last_seen_ms: 2000, expires_ms: Date.now() + 60000,
      }],
    });
    // live, event not minted yet
    let resp = await worker.fetch(new Request("https://wave.party.example.test/?pp-state"), makeEnv({ DB: mk("") }));
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { live: true, eventPath: "" });
    // live, event minted
    resp = await worker.fetch(new Request("https://wave.party.example.test/?pp-state"), makeEnv({ DB: mk("rooftop-night") }));
    assert.deepEqual(await resp.json(), { live: true, eventPath: "/e/rooftop-night" });
    // idle
    resp = await worker.fetch(new Request("https://wave.party.example.test/?pp-state"), makeEnv({ DB: new FakeD1({}) }));
    assert.deepEqual(await resp.json(), { live: false, eventPath: "" });
    // and the join page itself carries the poller + the raw-IP tap fallback
    // (rebind-protected venue routers hide the slug host from guests — the
    // page retargets the "At the party?" link at the DNS-free LAN IP)
    resp = await worker.fetch(new Request("https://wave.party.example.test/"), makeEnv({ DB: mk("") }));
    const joinHtml = await resp.text();
    assert.match(joinHtml, /pp-state/);
    assert.match(joinHtml, /http:\/\/192\.168\.1\.5:8000\//);
  }],

  ["wildcard router: IDLE page when no party is live, and reserved labels are not handles", async () => {
    const db = new FakeD1({
      profiles: [{ id: "profile-w", user_id: "user-w", handle: "wave", display_name: "DJ Wave", published: 1 }],
      events: [{ slug: "past-set", install_id: "abc123abc123", dj_profile_id: "profile-w", status: "replay", title: "Last Rooftop", last_activity_ms: 5000 }],
    });
    const idle = await worker.fetch(new Request("https://wave.party.example.test/", {
      headers: { "cf-connecting-ip": "203.0.113.5" },
    }), makeEnv({ DB: db }));
    const html = await idle.text();
    assert.equal(idle.status, 200);
    assert.match(html, /No party live right now/);
    assert.match(html, /\/@wave/);
    assert.match(html, /\/e\/past-set/);

    // A reserved label ("www") is NOT a handle -> falls through to the landing asset.
    const reserved = await worker.fetch(new Request("https://www.party.example.test/", {
      headers: { "cf-connecting-ip": "203.0.113.5" },
    }), makeEnv({ DB: db, assetBody: "landing-page" }));
    const body = await reserved.text();
    assert.equal(reserved.status, 200);
    assert.equal(body, "landing-page");
    assert.doesNotMatch(body, /No party live/);
  }],

  ["scheduled cron GC expires dead rows and deletes orphaned grey A records", async () => {
    const db = new FakeD1({
      liveInstalls: [
        {
          install_id: "abc123abc123", handle: "wave", profile_id: "p", public_ip_hash: "h",
          host: "disco12.party.party.example.test", lan_ip: "192.168.1.5", event_slug: "", dj_name: "", event_title: "",
          listeners: 0, now_playing: "", live_started_ms: 1, last_seen_ms: 1, expires_ms: Date.now() - 5000,
        },
        {
          install_id: "def456def456", handle: "beat", profile_id: "p2", public_ip_hash: "h2",
          host: "groove34.party.example.test", lan_ip: "10.0.0.2", event_slug: "", dj_name: "", event_title: "",
          listeners: 0, now_playing: "", live_started_ms: 1, last_seen_ms: 1, expires_ms: Date.now() + 60000,
        },
      ],
    });
    await withCloudflareDNSRecords(
      [{ id: "rec-dead", type: "A", name: "disco12.party.party.example.test", content: "192.168.1.5" }],
      async (calls) => {
        await worker.scheduled({}, makeEnv({ DB: db }), { waitUntil() {} });
        // Expired row swept; the still-live row is untouched.
        assert.equal(db.liveInstalls.has("abc123abc123"), false);
        assert.equal(db.liveInstalls.has("def456def456"), true);
        // The dead Mac's orphaned slug-host A record is deleted.
        const del = calls.find((c) => c.method === "DELETE");
        assert.ok(del, "deletes the orphaned A record");
        assert.match(del.url, /rec-dead$/);
      }
    );
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
