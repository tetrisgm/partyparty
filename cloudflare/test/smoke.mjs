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
    if (sql.includes("FROM follows WHERE follower_user_id=? AND dj_profile_id=?")) {
      const [userId, profileId] = this.args;
      return this.db.follows.some((f) => f.follower_user_id === userId && f.dj_profile_id === profileId) ? { 1: 1 } : null;
    }
    return null;
  }

  async all() {
    const sql = this.sql.replace(/\s+/g, " ");
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
        existing.handle = handle;
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

async function fetchPath(path, init = {}, envOpts = {}) {
  return worker.fetch(new Request(`https://party.ramine.net${path}`, init), makeEnv(envOpts));
}

const AUTH_DEV_SECRET = "smoke-dev-secret";

function smtpSuccessReplies() {
  return [
    "220 mxroute ESMTP ready\r\n",
    "250-mxroute greets party.ramine.net\r\n250 AUTH LOGIN PLAIN\r\n",
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
    "250 mxroute greets party.ramine.net\r\n",
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
  const resp = await worker.fetch(new Request("https://party.ramine.net/api/auth/request-link", {
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
  assert.match(json.devLink, /^https:\/\/party\.ramine\.net\/auth\/verify\?token=[a-f0-9]{64}$/);
  return json.devLink;
}

async function postVerify(db, token, opts = {}) {
  return await worker.fetch(new Request("https://party.ramine.net/auth/verify", {
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
  return (verify.headers.get("set-cookie") || "").split(";")[0];
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
    `https://party.ramine.net/auth/google/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
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
  return worker.fetch(new Request("https://party.ramine.net/auth/apple/callback", {
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
  ["sendViaMXroute walks SMTP AUTH LOGIN over implicit TLS", async () => {
    const smtp = fakeSmtpConnect();
    const ok = await sendViaMXroute({
      AUTH_EMAIL_SERVER: "smtps://signin%40mail.example.test:p%40ssword@mail.mxrouting.test:465",
      AUTH_EMAIL_FROM: "partyparty <signin@mail.example.test>",
      BROKER_BASE: "party.ramine.net",
      __TEST_SMTP_CONNECT: smtp.connect,
    }, "User@Example.COM", "https://party.ramine.net/auth/verify?token=abc123");

    assert.equal(ok, true);
    assert.deepEqual(smtp.calls, [{
      address: { hostname: "mail.mxrouting.test", port: 465 },
      options: { secureTransport: "on" },
    }]);
    assert.deepEqual(smtp.writes.slice(0, 7), [
      "EHLO party.ramine.net\r\n",
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
      BROKER_BASE: "party.ramine.net",
      __TEST_SMTP_CONNECT: smtp.connect,
    }, "starttls@example.com", "https://party.ramine.net/auth/verify?token=starttls");

    assert.equal(ok, true);
    assert.deepEqual(smtp.calls, [{
      address: { hostname: "mail.mxrouting.test", port: 587 },
      options: { secureTransport: "starttls" },
    }]);
    assert.equal(smtp.upgraded, true);
    assert.deepEqual(smtp.writes.slice(0, 4), [
      "EHLO party.ramine.net\r\n",
      "STARTTLS\r\n",
      "EHLO party.ramine.net\r\n",
      "AUTH LOGIN\r\n",
    ]);
    assert.equal(smtp.writes[7], "RCPT TO:<starttls@example.com>\r\n");
  }],
  ["auth request-link gates devLink behind dev secret", async () => {
    const db = new FakeD1();
    const noHeader = await worker.fetch(new Request("https://party.ramine.net/api/auth/request-link", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.20" },
      body: JSON.stringify({ email: " Person@Example.COM ", redirect: "/dashboard" }),
    }), makeEnv({ DB: db, env: { AUTH_DEV_LINKS: "1", AUTH_DEV_SECRET } }));
    const noHeaderJson = await noHeader.json();
    assert.equal(noHeader.status, 200);
    assert.equal(noHeaderJson.ok, true);
    assert.equal("devLink" in noHeaderJson, false);
    assert.equal(noHeaderJson.queued, false);

    const withHeader = await worker.fetch(new Request("https://party.ramine.net/api/auth/request-link", {
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
    assert.match(withHeaderJson.devLink, /^https:\/\/party\.ramine\.net\/auth\/verify\?token=[a-f0-9]{64}$/);
    assert.equal("queued" in withHeaderJson, false);

    const failClosed = await worker.fetch(new Request("https://party.ramine.net/api/auth/request-link", {
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
    const denied = await worker.fetch(new Request("https://party.ramine.net/api/auth/request-link", {
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

    const allowed = await worker.fetch(new Request("https://party.ramine.net/api/auth/request-link", {
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
    assert.match(allowedJson.devLink, /^https:\/\/party\.ramine\.net\/auth\/verify\?token=[a-f0-9]{64}$/);
    assert.equal(allowedJson.redirect, "/account");
    assert.match(allowed.headers.get("set-cookie") || "", /pp_session=[a-f0-9]{64}/);
    assert.equal("queued" in allowedJson, false);
  }],
  ["auth request-link sends through AUTH_EMAIL_SERVER before EMAIL binding", async () => {
    const db = new FakeD1();
    const smtp = fakeSmtpConnect();
    const fallback = [];
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/auth/request-link", {
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
    assert.match(smtp.writes[7], /https:\/\/party\.ramine\.net\/auth\/verify\?token=[a-f0-9]{64}/);
  }],
  ["auth request-link sends through EMAIL binding when configured", async () => {
    const db = new FakeD1();
    const sent = [];
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/auth/request-link", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.28",
      },
      body: JSON.stringify({ email: "mail@example.com", redirect: "/account" }),
    }), makeEnv({
      DB: db,
      env: {
        AUTH_EMAIL_FROM: "partyparty <signin@ramine.net>",
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
    assert.deepEqual(sent[0].from, { email: "signin@ramine.net", name: "partyparty" });
    assert.match(sent[0].subject, /Sign in/);
    assert.match(sent[0].text, /https:\/\/party\.ramine\.net\/auth\/verify\?token=[a-f0-9]{64}/);
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

    const anon = await worker.fetch(new Request("https://party.ramine.net/api/me"), makeEnv({ DB: db }));
    assert.deepEqual(await anon.json(), { user: null });

    const verify = await postVerify(db, token, { ip: "203.0.113.21" });
    const cookie = verify.headers.get("set-cookie") || "";
    assert.equal(verify.status, 302);
    assert.equal(verify.headers.get("location"), "/after-login?ok=1");
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
    const resp = await worker.fetch(new Request(`https://party.ramine.net/auth/verify?token=${rawToken}`), makeEnv({ DB: db }));
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

    const anon = await worker.fetch(new Request("https://party.ramine.net/api/me"), makeEnv({ DB: db }));
    assert.deepEqual(await anon.json(), { user: null });

    const me = await worker.fetch(new Request("https://party.ramine.net/api/me", {
      headers: { cookie },
    }), makeEnv({ DB: db }));
    const meJson = await me.json();
    assert.equal(me.status, 200);
    assert.deepEqual(Object.keys(meJson.user).sort(), ["display_name", "email", "id"]);
    assert.equal(meJson.user.email, "me@example.com");

    const logout = await worker.fetch(new Request("https://party.ramine.net/api/auth/logout", {
      method: "POST",
      headers: { cookie },
    }), makeEnv({ DB: db }));
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") || "", /pp_session=; Max-Age=0/);

    const after = await worker.fetch(new Request("https://party.ramine.net/api/me", {
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
      resp = await worker.fetch(new Request("https://party.ramine.net/api/auth/request-link", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.24" },
        body: JSON.stringify({ email: `rate-${i}@example.com` }),
      }), env);
      assert.equal(resp.status, 200);
    }
    resp = await worker.fetch(new Request("https://party.ramine.net/api/auth/request-link", {
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
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/auth/request-link", {
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
    assert.match(json.devLink, /^https:\/\/party\.ramine\.net\/auth\/verify\?token=/);
    assert.equal(json.redirect, "/account");
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
    const known = await worker.fetch(new Request("https://party.ramine.net/api/auth/request-link", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.26", "x-auth-dev-secret": AUTH_DEV_SECRET },
      body: JSON.stringify({ email: "known@example.com" }),
    }), makeEnv({ DB: db, env: { AUTH_DEV_LINKS: "1", AUTH_DEV_SECRET } }));
    const unknown = await worker.fetch(new Request("https://party.ramine.net/api/auth/request-link", {
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
    const resp = await worker.fetch(new Request("https://party.ramine.net/account"), makeEnv({ DB: new FakeD1() }));
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

    const resp = await worker.fetch(new Request("https://party.ramine.net/account", {
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
    const anon = await worker.fetch(new Request("https://party.ramine.net/api/install-link/create", {
      method: "POST",
    }), makeEnv({ DB: new FakeD1() }));
    assert.equal(anon.status, 401);

    const db = new FakeD1();
    const cookie = await signInCookie(db, "link-create@example.com", { ip: "203.0.113.29" });
    const noProfile = await worker.fetch(new Request("https://party.ramine.net/api/install-link/create", {
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
    const created = await worker.fetch(new Request("https://party.ramine.net/api/install-link/create", {
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
    const bad = await worker.fetch(new Request("https://party.ramine.net/api/broker/link-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "wrong" }),
    }), makeEnv({ DB: db }));
    assert.equal(bad.status, 403);

    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/link-start", {
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
    const unlinked = await worker.fetch(new Request("https://party.ramine.net/api/broker/account-status", {
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

    const providersOn = await worker.fetch(new Request("https://party.ramine.net/api/broker/account-status", {
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
      owner_user_id: "user-account-status",
      title: "Linked Event",
      status: "upcoming",
      scheduled_at_ms: 1893542400000,
    });

    const linked = await worker.fetch(new Request("https://party.ramine.net/api/broker/account-status", {
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

    const unlinkResp = await worker.fetch(new Request("https://party.ramine.net/api/broker/account-unlink", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a" }),
    }), makeEnv({ DB: db }));
    const unlinkJson = await unlinkResp.json();
    assert.equal(unlinkResp.status, 200);
    assert.equal(unlinkJson.ok, true);
    assert.equal(unlinkJson.revoked, 1);
    assert.equal(typeof db.deviceInstalls.get("abc123abc123").revoked_ms, "number");

    const after = await worker.fetch(new Request("https://party.ramine.net/api/broker/account-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a" }),
    }), makeEnv({ DB: db }));
    const afterJson = await after.json();
    assert.equal(after.status, 200);
    assert.equal(afterJson.linked, false);
  }],
  ["link-mac redirects through sign-in then links install to the account", async () => {
    const rawToken = "4444444444444444444444444444444444444444444444444444444444444444";
    const db = new FakeD1();
    await seedInstallBrowserToken(db, { id: "browser-token-ok", token: rawToken });

    const anon = await worker.fetch(new Request(`https://party.ramine.net/link-mac?token=${rawToken}`), makeEnv({ DB: db }));
    assert.equal(anon.status, 302);
    assert.equal(anon.headers.get("location"), `/login?redirect=${encodeURIComponent(`/link-mac?token=${rawToken}`)}`);
    assert.equal(db.installBrowserTokens.get("browser-token-ok").used_ms, null);

    const cookie = await signInCookie(db, "browser-link@example.com", { ip: "203.0.113.31" });
    const user = [...db.authUsers.values()].find((row) => row.email_norm === "browser-link@example.com");
    // Authenticated GET only CONFIRMS now — no bind, token still unused.
    const confirm = await worker.fetch(new Request(`https://party.ramine.net/link-mac?token=${rawToken}`, {
      headers: { cookie },
    }), makeEnv({ DB: db }));
    const confirmHtml = await confirm.text();
    assert.equal(confirm.status, 200);
    assert.match(confirmHtml, /Link this Mac/);
    assert.match(confirmHtml, /method="POST"/i);
    assert.equal(db.installBrowserTokens.get("browser-token-ok").used_ms, null);
    assert.equal(db.deviceInstalls.has("abc123abc123"), false);

    // The same-site POST performs the bind.
    const linked = await worker.fetch(new Request(`https://party.ramine.net/link-mac`, {
      method: "POST",
      headers: { cookie, origin: "https://party.ramine.net", "content-type": "application/x-www-form-urlencoded" },
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

    const get = await worker.fetch(new Request(`https://party.ramine.net/link-mac?token=${rawToken}`, {
      headers: { cookie },
    }), makeEnv({ DB: db }));
    assert.equal(get.status, 200);
    assert.equal(db.installBrowserTokens.get("browser-token-csrf").used_ms, null);
    assert.equal(db.deviceInstalls.has("abc123abc123"), false);

    const evil = await worker.fetch(new Request(`https://party.ramine.net/link-mac`, {
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
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/link-install", {
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

    const takeover = await worker.fetch(new Request("https://party.ramine.net/api/broker/link-install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", code: otherCode }),
    }), makeEnv({ DB: db }));
    assert.equal(takeover.status, 409);
    assert.equal(db.installLinkTokens.get("token-other-user").used_ms, null);
    assert.equal(db.deviceInstalls.get("abc123abc123").user_id, "user-old");
    assert.equal(db.deviceInstalls.get("abc123abc123").profile_id, "profile-old");

    const same = await worker.fetch(new Request("https://party.ramine.net/api/broker/link-install", {
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

    const unlink = await worker.fetch(new Request("https://party.ramine.net/api/install-link/unlink", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ install_id: "abc123abc123" }),
    }), makeEnv({ DB: db }));
    const unlinkJson = await unlink.json();
    assert.equal(unlink.status, 200);
    assert.deepEqual(unlinkJson, { ok: true, revoked: 1 });
    assert.equal(typeof db.deviceInstalls.get("abc123abc123").revoked_ms, "number");

    const relinkCode = "33333333333333333333333333333333";
    db.profiles.push({
      id: "profile-relink-new",
      user_id: "user-relink-new",
      handle: "relink.new",
      published: 1,
    });
    await seedInstallLinkToken(db, { id: "token-relink-new", code: relinkCode, userId: "user-relink-new", profileId: "profile-relink-new" });
    const relink = await worker.fetch(new Request("https://party.ramine.net/api/broker/link-install", {
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
      }],
    });

    // A revoked install is no longer linked → cloud publish is refused outright
    // (going live online requires a live account link).
    const publishMeta = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-meta", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "revoked-publish", title: "Revoked Publish" }),
    }), makeEnv({ DB: db }));
    assert.equal(publishMeta.status, 403);
    assert.equal(db.events.has("revoked-publish"), false);

    const eventUpsert = await worker.fetch(new Request("https://party.ramine.net/api/broker/event-upsert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "revoked-upsert", title: "Revoked Upsert" }),
    }), makeEnv({ DB: db }));
    assert.equal(eventUpsert.status, 403);
    assert.equal(db.events.has("revoked-upsert"), false);

    const windowResp = await worker.fetch(new Request("https://party.ramine.net/api/broker/events-window", {
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
    const metaU = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-meta", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "needs-link", title: "Nope" }),
    }), makeEnv({ DB: unlinked }));
    assert.equal(metaU.status, 403);
    assert.equal(JSON.parse(await metaU.text()).reason, "not_linked");
    assert.equal(unlinked.events.has("needs-link"), false);
    const upsertU = await worker.fetch(new Request("https://party.ramine.net/api/broker/event-upsert", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "needs-link2", title: "Nope" }),
    }), makeEnv({ DB: unlinked }));
    assert.equal(upsertU.status, 403);
    assert.equal(unlinked.events.has("needs-link2"), false);

    // Linked → publish succeeds.
    const linked = new FakeD1({
      deviceInstalls: [{ install_id: "abc123abc123", user_id: "user-lp", profile_id: "profile-lp" }],
    });
    const metaL = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-meta", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "linked-pub", title: "Yes" }),
    }), makeEnv({ DB: linked }));
    assert.equal(metaL.status, 200);
    assert.equal(linked.events.get("linked-pub").dj_profile_id, "profile-lp");

    // Escape hatch: BROKER_ALLOW_UNLINKED_PUBLISH=1 lets an unlinked install publish.
    const hatch = new FakeD1();
    const metaH = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-meta", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", slug: "hatch-pub", title: "Hatch" }),
    }), makeEnv({ DB: hatch, env: { BROKER_ALLOW_UNLINKED_PUBLISH: "1" } }));
    assert.equal(metaH.status, 200);
  }],
  ["broker link-install throttles repeated bad code guesses per install", async () => {
    const env = makeEnv({ DB: new FakeD1() });
    for (let i = 0; i < 10; i += 1) {
      const guess = String(i).padStart(32, "0");
      const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/link-install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", code: guess }),
      }), env);
      assert.equal(resp.status, 400);
    }
    const throttled = await worker.fetch(new Request("https://party.ramine.net/api/broker/link-install", {
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
    const create = await worker.fetch(new Request("https://party.ramine.net/api/install-link/create", {
      method: "POST",
      headers: { cookie },
    }), makeEnv({ DB: db }));
    const code = (await create.json()).code;

    const link = await worker.fetch(new Request("https://party.ramine.net/api/broker/link-install", {
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

    const reused = await worker.fetch(new Request("https://party.ramine.net/api/broker/link-install", {
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
    const expired = await worker.fetch(new Request("https://party.ramine.net/api/broker/link-install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", code: expiredCode }),
    }), makeEnv({ DB: db }));
    assert.equal(expired.status, 400);
    assert.equal(db.installLinkTokens.get("expired-install-link").used_ms, null);

    const publishMeta = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-meta", {
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

    const eventUpsert = await worker.fetch(new Request("https://party.ramine.net/api/broker/event-upsert", {
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
      const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/a", {
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
      const aResp = await worker.fetch(new Request("https://party.ramine.net/api/broker/a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", ip: "192.168.2.1" }),
      }), makeEnv({ DB: db }));
      const aJson = await aResp.json();
      assert.equal(aResp.status, 200);
      assert.equal(aJson.host, "disco12.party.example.test");
      const aPost = calls.find((c) => c.method === "POST" && c.body?.type === "A");
      assert.equal(aPost.body.name, "disco12.party.example.test");
      assert.equal(aPost.body.content, "192.168.2.1");
      assert.equal(aPost.body.proxied, false);

      const txtResp = await worker.fetch(new Request("https://party.ramine.net/api/broker/txt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", value: "challenge-token" }),
      }), makeEnv({ DB: db }));
      const txtJson = await txtResp.json();
      assert.equal(txtResp.status, 200);
      assert.equal(txtJson.name, "_acme-challenge.disco12.party.example.test");
      const txtPost = calls.find((c) => c.method === "POST" && c.body?.type === "TXT");
      assert.equal(txtPost.body.name, "_acme-challenge.disco12.party.example.test");
      assert.equal(txtPost.body.content, "challenge-token");
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
      const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", ip: "192.168.2.1" }),
      }), env);
      const json = await resp.json();
      assert.equal(resp.status, 200);
      assert.match(json.host, /^[a-z]+[0-9]{2}\.party\.example\.test$/);
      assert.equal(json.host.includes("192-168-2-1"), false);
      const aPost = calls.find((c) => c.method === "POST" && c.body?.type === "A");
      assert.equal(aPost.body.name, json.host);
      const updated = await env.DL.get("broker/abc123abc123.json").then((o) => o.json());
      assert.equal(`${updated.slug}.party.example.test`, json.host);
    });
  }],
  ["web event create API requires authentication", async () => {
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Anon Event" }),
    }), makeEnv({ DB: new FakeD1() }));
    assert.equal(resp.status, 401);
  }],
  ["web event create API requires a DJ profile", async () => {
    const db = new FakeD1();
    const cookie = await signInCookie(db, "no-profile-event@example.com", { ip: "203.0.113.36" });
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/events", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "No Profile Event" }),
    }), makeEnv({ DB: db }));
    const json = await resp.json();
    assert.equal(resp.status, 400);
    assert.deepEqual(json, { error: "create a DJ profile first", redirect: "/profile/edit" });

    const page = await worker.fetch(new Request("https://party.ramine.net/events/new", {
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
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/events", {
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
    assert.deepEqual(json, { ok: true, slug: "web-party", url: "https://party.ramine.net/e/web-party" });
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
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/events", {
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
    const update = await worker.fetch(new Request("https://party.ramine.net/api/events/owned-web", {
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
    const denied = await worker.fetch(new Request("https://party.ramine.net/api/events/owned-web", {
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
    const update = await worker.fetch(new Request("https://party.ramine.net/api/events/old-web", {
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

    const oldPage = await worker.fetch(new Request("https://party.ramine.net/e/old-web"), makeEnv({ DB: db }));
    assert.equal(oldPage.status, 301);
    assert.equal(oldPage.headers.get("location"), "/e/new-web");

    const unknown = await worker.fetch(new Request("https://party.ramine.net/e/unknown-web"), makeEnv({ DB: db }));
    assert.equal(unknown.status, 404);
  }],
  ["profile API creates signed-in user's fresh profile and public route renders it", async () => {
    const db = new FakeD1();
    const cookie = await signInCookie(db, "fresh@example.com", { ip: "203.0.113.30" });
    const user = [...db.authUsers.values()][0];
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ handle: " Fresh DJ ", display_name: "Fresh Name" }),
    }), makeEnv({ DB: db }));
    const json = await resp.json();
    assert.equal(resp.status, 200);
    assert.deepEqual(json, { ok: true, handle: "fresh.dj", url: "https://party.ramine.net/@fresh.dj" });
    assert.equal(db.profiles.length, 1);
    assert.equal(db.profiles[0].user_id, user.id);
    assert.equal(db.profiles[0].handle, "fresh.dj");

    const page = await worker.fetch(new Request("https://party.ramine.net/@fresh.dj"), makeEnv({ DB: db }));
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /Fresh Name/);
    assert.match(html, /@fresh\.dj/);
    // A non-owner (anonymous) visitor must NOT see owner-only actions.
    assert.doesNotMatch(html, /Create event/);
    assert.equal(page.headers.get("cache-control"), "public, max-age=60");

    // The owner (signed-in) sees Create event + Edit profile, uncached.
    const ownerPage = await worker.fetch(new Request("https://party.ramine.net/@fresh.dj", { headers: { cookie } }), makeEnv({ DB: db }));
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
    const anonHtml = await (await worker.fetch(new Request("https://party.ramine.net/@star.dj"), makeEnv({ DB: db }))).text();
    assert.match(anonHtml, /Sign in to follow/);
    assert.doesNotMatch(anonHtml, /id="followbtn"/);

    // Signed-in non-owner → Follow button (not yet following), uncached.
    const before = await worker.fetch(new Request("https://party.ramine.net/@star.dj", { headers: { cookie } }), makeEnv({ DB: db }));
    assert.match(await before.text(), /id="followbtn"[^>]*data-following="0"/);
    assert.equal(before.headers.get("cache-control"), "private, no-store");

    // Follow (POST) is idempotent.
    const follow = await worker.fetch(new Request("https://party.ramine.net/api/follow", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ handle: "star.dj" }),
    }), makeEnv({ DB: db }));
    assert.equal(follow.status, 200);
    assert.deepEqual(await follow.json(), { ok: true, following: true });
    await worker.fetch(new Request("https://party.ramine.net/api/follow", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ handle: "star.dj" }),
    }), makeEnv({ DB: db }));
    assert.equal(db.follows.length, 1);

    // Profile now shows "Following".
    assert.match(await (await worker.fetch(new Request("https://party.ramine.net/@star.dj", { headers: { cookie } }), makeEnv({ DB: db }))).text(), /id="followbtn"[^>]*data-following="1"/);

    // Signed-in home shows the personalized section, uncached; anon home doesn't.
    // (The events aggregator lives at /live since decision C; / is the marketing page.)
    const home = await worker.fetch(new Request("https://party.ramine.net/live", { headers: { cookie } }), makeEnv({ DB: db }));
    assert.match(await home.text(), /DJs you follow/);
    assert.equal(home.headers.get("cache-control"), "private, no-store");
    const anonHome = await worker.fetch(new Request("https://party.ramine.net/live"), makeEnv({ DB: db }));
    assert.doesNotMatch(await anonHome.text(), /DJs you follow/);
    assert.equal(anonHome.headers.get("cache-control"), "public, max-age=60");

    // Unfollow (DELETE).
    const unfollow = await worker.fetch(new Request("https://party.ramine.net/api/follow", {
      method: "DELETE", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ handle: "star.dj" }),
    }), makeEnv({ DB: db }));
    assert.deepEqual(await unfollow.json(), { ok: true, following: false });
    assert.equal(db.follows.length, 0);
  }],
  ["follow rejects anonymous callers and self-follow", async () => {
    const db = new FakeD1();
    const anon = await worker.fetch(new Request("https://party.ramine.net/api/follow", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "someone" }),
    }), makeEnv({ DB: db }));
    assert.equal(anon.status, 401);

    const cookie = await signInCookie(db, "self@example.com", { ip: "203.0.113.41" });
    const user = [...db.authUsers.values()].find((u) => u.email_norm === "self@example.com");
    db.profiles.push({ id: "profile-self", user_id: user.id, handle: "self.dj", display_name: "Self DJ", published: 1 });
    const self = await worker.fetch(new Request("https://party.ramine.net/api/follow", {
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
    const anon = await worker.fetch(new Request("https://party.ramine.net/e/rooftop/edit"), makeEnv({ DB: db }));
    assert.equal(anon.status, 302);
    assert.match(anon.headers.get("location"), /\/login\?redirect=/);

    // Owner → pre-filled edit form that submits to the update API, uncached.
    const owner = await worker.fetch(new Request("https://party.ramine.net/e/rooftop/edit", { headers: { cookie } }), makeEnv({ DB: db }));
    const ownerHtml = await owner.text();
    assert.equal(owner.status, 200);
    assert.match(ownerHtml, /Edit event/);
    assert.match(ownerHtml, /Rooftop Sessions/);
    assert.match(ownerHtml, /\/api\/events\/rooftop/);
    assert.equal(owner.headers.get("cache-control"), "no-store");

    // A different signed-in user → 403.
    const otherCookie = await signInCookie(db, "stranger@example.com", { ip: "203.0.113.51" });
    const other = await worker.fetch(new Request("https://party.ramine.net/e/rooftop/edit", { headers: { cookie: otherCookie } }), makeEnv({ DB: db }));
    assert.equal(other.status, 403);
    assert.match(await other.text(), /Not your event/);

    // Event page: owner sees an Edit link (uncached); anonymous does not.
    const ownerView = await worker.fetch(new Request("https://party.ramine.net/e/rooftop", { headers: { cookie } }), makeEnv({ DB: db }));
    assert.match(await ownerView.text(), /href="\/e\/rooftop\/edit"/);
    assert.equal(ownerView.headers.get("cache-control"), "private, no-store");
    const anonView = await worker.fetch(new Request("https://party.ramine.net/e/rooftop"), makeEnv({ DB: db }));
    assert.doesNotMatch(await anonView.text(), /href="\/e\/rooftop\/edit"/);
  }],
  ["profile API rejects a different user claiming an existing normalized handle", async () => {
    const db = new FakeD1();
    const cookieA = await signInCookie(db, "claim-a@example.com", { ip: "203.0.113.31" });
    const first = await worker.fetch(new Request("https://party.ramine.net/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieA },
      body: JSON.stringify({ handle: "Taken Handle" }),
    }), makeEnv({ DB: db }));
    assert.equal(first.status, 200);

    const cookieB = await signInCookie(db, "claim-b@example.com", { ip: "203.0.113.32" });
    const second = await worker.fetch(new Request("https://party.ramine.net/api/profile", {
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
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ handle: "!!!" }),
    }), makeEnv({ DB: db }));
    assert.equal(resp.status, 400);
    assert.equal(db.profiles.length, 0);
  }],
  ["profile API requires authentication", async () => {
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle: "anon.dj" }),
    }), makeEnv({ DB: new FakeD1() }));
    assert.equal(resp.status, 401);
  }],
  ["profile API persists owner display name and bio edits", async () => {
    const db = new FakeD1();
    const cookie = await signInCookie(db, "edit-owner@example.com", { ip: "203.0.113.34" });
    const create = await worker.fetch(new Request("https://party.ramine.net/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ handle: "edit.owner" }),
    }), makeEnv({ DB: db }));
    assert.equal(create.status, 200);

    const edit = await worker.fetch(new Request("https://party.ramine.net/api/profile", {
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
    const create = await worker.fetch(new Request("https://party.ramine.net/api/profile", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ handle: "social.dj" }),
    }), makeEnv({ DB: db }));
    assert.equal(create.status, 200);

    const bad = await worker.fetch(new Request("https://party.ramine.net/api/profile/socials", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ website_url: "javascript:alert(1)" }),
    }), makeEnv({ DB: db }));
    assert.equal(bad.status, 400);
    assert.equal(db.profiles[0].website_url, "");

    const good = await worker.fetch(new Request("https://party.ramine.net/api/profile/socials", {
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
    const resp = await worker.fetch(new Request("https://party.ramine.net/profile/edit"), makeEnv({ DB: new FakeD1() }));
    assert.equal(resp.status, 302);
    assert.equal(resp.headers.get("location"), "/login?redirect=/profile/edit");
  }],
  ["login renders fallback when no consumer auth providers are configured", async () => {
    const resp = await worker.fetch(new Request("https://party.ramine.net/login"), makeEnv({ DB: new FakeD1() }));
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
    const adminResp = await worker.fetch(new Request("https://party.ramine.net/login?admin=1"), makeEnv({ DB: new FakeD1() }));
    assert.match(await adminResp.text(), /Admin passcode/);
  }],
  ["login renders email form when MXroute email is configured", async () => {
    const resp = await worker.fetch(new Request("https://party.ramine.net/login"), makeEnv({
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
    const resp = await worker.fetch(new Request("https://party.ramine.net/login", {
      headers: { cookie },
    }), makeEnv({ DB: db }));
    assert.equal(resp.status, 302);
    assert.equal(resp.headers.get("location"), "/account");
    const next = await worker.fetch(new Request("https://party.ramine.net/login?redirect=/link-mac%3Ftoken%3Daaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
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
    const resp = await fetchPath("/api/version");
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get("content-type") || "", /application\/json/);
    assert.equal(resp.headers.get("cache-control"), "public, max-age=300");
    assert.deepEqual(await resp.json(), { version: `${codeMajor}.${payloadVersion}`, date: "2026-07-09" });
  }],
  ["/api/version does not let an older native marker hide a payload release", async () => {
    const codeMajor = (await readFile(new URL("../../CODE_MAJOR", import.meta.url), "utf8")).replace(/\D/g, "");
    const payloadVersion = (await readFile(new URL("../../web/PAYLOAD_VERSION", import.meta.url), "utf8")).replace(/\D/g, "");
    const resp = await fetchPath("/api/version", {}, {
      r2Objects: { "content/app-version": new FakeR2Object(`${codeMajor}.${Math.max(0, Number(payloadVersion) - 1)}`) },
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { version: `${codeMajor}.${payloadVersion}`, date: "2026-07-09" });
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
    assert.match(html, /id="nav-auth" href="\/login">Sign in/);
    assert.match(html, /Sign in once to link your Mac/);
    assert.match(html, /No guest account needed/);
    assert.match(html, /fetch\('\/api\/me'/);
    assert.match(html, /fetch\('\/api\/version'/);
    assert.match(html, /No fake crowd numbers/);
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
    ["event RSVP cookie-less POSTs from same IP collapse to one row", async () => {
      const db = new FakeD1({ rsvpEnabled: 1 });
      const first = await worker.fetch(new Request(`https://party.ramine.net/api/e/${KNOWN_SLUG}/rsvp`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
        body: JSON.stringify({ response: "coming" }),
      }), makeEnv({ DB: db }));
      const second = await worker.fetch(new Request(`https://party.ramine.net/api/e/${KNOWN_SLUG}/rsvp`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
        body: JSON.stringify({ response: "not" }),
      }), makeEnv({ DB: db }));
      const json = await second.json();
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
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
    const env = makeEnv();
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-cover", {
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
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/events-window", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "abc123abc123", secret: "secret-a", since_ms: now - 86_400_000, until_ms: now + 86_400_000 }),
    }), makeEnv({ DB: db }));
    const json = await resp.json();
    assert.equal(resp.status, 200);
    assert.equal(json.ok, true);
    assert.equal(typeof json.serverMs, "number");
    assert.deepEqual(json.events.map((event) => event.slug), ["window-upcoming", "window-replay"]);
    assert.equal(json.events[0].url, "https://party.ramine.net/e/window-upcoming");
    assert.equal(json.events[0].status, "upcoming");
    assert.equal(json.events[0].visibility, "public");
    assert.equal(json.events[0].scheduled_at_ms, now + 60_000);
    assert.equal(json.events[0].end_at_ms, now + 3_600_000);
    assert.equal(json.events[0].timezone, "America/Los_Angeles");
    assert.equal(json.events[0].location_name, "Rooftop");
    assert.equal(json.events[0].hasReplay, false);
    assert.deepEqual(json.events[0].rsvp, { coming: 2, not: 1 });
    assert.equal(json.events[1].url, "https://party.ramine.net/e/window-replay");
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
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/events-window", {
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
    ["broker event-upsert creates minimal fresh event with non-null text defaults", async () => {
      const db = new FakeD1({
        deviceInstalls: [{ install_id: "abc123abc123", user_id: "user-1", profile_id: "profile-1" }],
      });
      const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/event-upsert", {
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
      deviceInstalls: [{ install_id: "abc123abc123", user_id: "user-1", profile_id: "profile-1" }],
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
  ["broker event-upsert records alias when old_slug is renamed", async () => {
    const db = new FakeD1({
      deviceInstalls: [{ install_id: "abc123abc123", user_id: "user-1", profile_id: "profile-1" }],
      events: [{ slug: "ahead-old", install_id: "abc123abc123", title: "Ahead Old", status: "upcoming" }],
    });
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/event-upsert", {
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
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/event-upsert", {
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
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/event-upsert", {
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
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/events", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ title: "New", slug: "party" }),
    }), makeEnv({ DB: db }));
    assert.equal(resp.status, 409);
    assert.equal((await resp.json()).error, "slug reserved");
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
    ["broker publish-posts rejects aggregate post cap before writing", async () => {
      const db = new FakeD1({
        events: [{ slug: "owned-posts-cap", install_id: "abc123abc123", title: "Owned Posts", status: "replay" }],
      });
      const posts = Array.from({ length: 201 }, (_, i) => ({
        localId: `post-${i}`,
        ts: 1,
        author: "Guest",
        text: "Nope",
        comments: [],
      }));
      const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-posts", {
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
    ["broker publish-post-media rejects unsafe mime for media type", async () => {
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
    const init = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-post-media-multipart-init", {
      method: "POST",
      headers,
    }), env);
    assert.equal(init.status, 200);
    const { uploadId } = await init.json();
    const p1 = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-post-media-multipart-part", {
      method: "PUT",
      headers: { ...headers, "x-pp-upload-id": uploadId, "x-pp-part-number": "1", "content-length": "5" },
      body: "hello",
    }), env);
    const p2 = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-post-media-multipart-part", {
      method: "PUT",
      headers: { ...headers, "x-pp-upload-id": uploadId, "x-pp-part-number": "2", "content-length": "5" },
      body: "world",
    }), env);
    const j1 = await p1.json();
    const j2 = await p2.json();
    const bad = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-post-media-multipart-complete", {
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
    const init = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-post-media-multipart-init", {
      method: "POST",
      headers,
    }), env);
    assert.equal(init.status, 200);
    const { uploadId, mediaId } = await init.json();
    assert.equal(mediaId, "media-video");
    const uploadPart = async (partNumber, body) => {
      const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-post-media-multipart-part", {
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
    const complete = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-post-media-multipart-complete", {
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

    const again = await worker.fetch(new Request("https://party.ramine.net/api/broker/publish-post-media-multipart-complete", {
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
  ["broker event-status rejects over-cap JSON body", async () => {
    const db = new FakeD1({
      events: [{ slug: "owned-large-status", install_id: "abc123abc123", title: "Owned", status: "upcoming" }],
    });
    const resp = await worker.fetch(new Request("https://party.ramine.net/api/broker/event-status", {
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
  ["google sign-in start redirects to Google and sets a state cookie", async () => {
    const db = new FakeD1({});
    const resp = await worker.fetch(new Request("https://party.ramine.net/auth/google?redirect=/account", {}),
      makeEnv({ DB: db, env: GOOGLE_TEST_ENV }));
    assert.equal(resp.status, 302);
    const loc = resp.headers.get("location") || "";
    assert.ok(loc.startsWith("https://accounts.google.com/o/oauth2/v2/auth"), "redirects to Google");
    const locUrl = new URL(loc);
    assert.equal(locUrl.searchParams.get("client_id"), GOOGLE_TEST_ENV.AUTH_GOOGLE_ID);
    assert.equal(locUrl.searchParams.get("redirect_uri"), "https://party.ramine.net/auth/google/callback");
    assert.equal(locUrl.searchParams.get("response_type"), "code");
    const state = locUrl.searchParams.get("state");
    assert.ok(state && state.length >= 16, "carries a state nonce");
    const sc = resp.headers.get("set-cookie") || "";
    assert.ok(sc.startsWith("pp_oauth="), "sets the oauth state cookie");
    assert.ok(sc.includes(state), "state cookie carries the same nonce");
  }],
  ["google sign-in is unavailable when unconfigured", async () => {
    const resp = await worker.fetch(new Request("https://party.ramine.net/auth/google", {}), makeEnv({ DB: new FakeD1({}) }));
    assert.equal(resp.status, 302);
    assert.equal(resp.headers.get("location"), "/login");
  }],
  ["google callback creates a session for a verified email", async () => {
    const db = new FakeD1({});
    const resp = await withGoogleTokenMock(fakeIdToken(googleClaims()), () => googleCallbackReq(db, { redirect: "/account" }));
    assert.equal(resp.status, 302);
    assert.equal(resp.headers.get("location"), "/account");
    const sessionCookie = (resp.headers.get("set-cookie") || "").split(";")[0];
    assert.ok(sessionCookie.length > 0, "sets a session cookie");
    // The session must actually authenticate.
    const me = await worker.fetch(new Request("https://party.ramine.net/api/me", { headers: { cookie: sessionCookie } }),
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
    const on = await worker.fetch(new Request("https://party.ramine.net/login", {}), makeEnv({ DB: new FakeD1({}), env: GOOGLE_TEST_ENV }));
    const onBody = await on.text();
    assert.ok(onBody.includes("Continue with Google"), "button present when configured");
    assert.ok(onBody.includes("/auth/google?redirect="), "button links to /auth/google");
    const off = await worker.fetch(new Request("https://party.ramine.net/login", {}), makeEnv({ DB: new FakeD1({}) }));
    assert.ok(!(await off.text()).includes("Continue with Google"), "button hidden when unconfigured");
  }],
  ["apple sign-in start redirects to Apple with form_post and a None-SameSite cookie", async () => {
    const env = await makeAppleEnv();
    const resp = await worker.fetch(new Request("https://party.ramine.net/auth/apple?redirect=/account", {}), makeEnv({ DB: new FakeD1({}), env }));
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
    const resp = await worker.fetch(new Request("https://party.ramine.net/auth/apple", {}), makeEnv({ DB: new FakeD1({}) }));
    assert.equal(resp.status, 302);
    assert.equal(resp.headers.get("location"), "/login");
  }],
  ["apple callback mints the ES256 client secret and creates a session", async () => {
    const env = await makeAppleEnv();
    const db = new FakeD1({});
    const resp = await withAppleTokenMock(fakeIdToken(appleClaims(env)), () => appleCallbackReq(db, env, {}));
    assert.equal(resp.status, 302);
    assert.equal(resp.headers.get("location"), "/account");
    const sessionCookie = (resp.headers.get("set-cookie") || "").split(";")[0];
    assert.ok(sessionCookie.length > 0, "sets a session cookie");
    const me = await worker.fetch(new Request("https://party.ramine.net/api/me", { headers: { cookie: sessionCookie } }), makeEnv({ DB: db }));
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
    const resp = await worker.fetch(new Request("https://party.ramine.net/auth/apple/callback", {}), makeEnv({ DB: db, env }));
    assertOAuthFailure(resp, db, "method");
  }],
  ["login page shows Continue with Apple only when configured", async () => {
    const env = await makeAppleEnv();
    const on = await worker.fetch(new Request("https://party.ramine.net/login", {}), makeEnv({ DB: new FakeD1({}), env }));
    assert.ok((await on.text()).includes("Continue with Apple"), "button present when configured");
    const off = await worker.fetch(new Request("https://party.ramine.net/login", {}), makeEnv({ DB: new FakeD1({}) }));
    assert.ok(!(await off.text()).includes("Continue with Apple"), "button hidden when unconfigured");
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
