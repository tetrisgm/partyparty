// partyparty.party: account activation, certificate-backed LAN hostnames,
// diagnostics, direct-download updates, and the static product site.
// Guest audio and room posts never transit this Worker.
var ZIP_RE = /^\/[A-Za-z0-9._-]+\.(zip|pkg|dmg)$/;
var CONTENT_RE = /^\/content\/(manifest\.json|payload-\d+\.tar\.gz)$/;
var SITE_ORIGIN = "https://partyparty.party";
var DEFAULT_OG_IMAGE = "/img/og-default.jpg";
const APP_VERSION = "119.87";
const APP_VERSION_DATE = "2026-07-26";
var SESSION_COOKIE = "pp_session";
var MAX_IMPORT_FUTURE_MS = 24 * 60 * 60 * 1e3;
var READ_JSON_TOO_LARGE = /* @__PURE__ */ new WeakSet();
var MAGIC_LINK_TTL_MS = 15 * 60 * 1e3;
var MAGIC_LINK_RATE_WINDOW_MS = 15 * 60 * 1e3;
var MAGIC_LINK_IP_CAP = 5;
var MAGIC_LINK_EMAIL_CAP = 3;
var SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
var AUTH_CLEANUP_GRACE_MS = 24 * 60 * 60 * 1e3;
var INSTALL_LINK_TTL_MS = 10 * 60 * 1e3;
var INSTALL_LINK_USER_CAP = 5;
var INSTALL_LINK_CLEANUP_GRACE_MS = 60 * 60 * 1e3;
var INSTALL_LINK_ATTEMPT_WINDOW_MS = 10 * 60 * 1e3;
var INSTALL_LINK_ATTEMPT_CAP = 10;
var INSTALL_BROWSER_LINK_TTL_MS = 10 * 60 * 1e3;
var INSTALL_BROWSER_LINK_INSTALL_CAP = 5;
var esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
var clip = (s, n) => String(s == null ? "" : s).slice(0, n);
var randHex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
var absUrl = (s) => {
  try {
    return new URL(s || "/", SITE_ORIGIN).href;
  } catch (_) {
    return SITE_ORIGIN + "/";
  }
};
function normalizeEmail(s) {
  const email = String(s == null ? "" : s).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320 ? email : "";
}
function safeRedirectPath(s) {
  const path = String(s || "/").trim() || "/";
  if (!path.startsWith("/") || path.startsWith("//")) return "/";
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return "/";
  try {
    const u = new URL(path, SITE_ORIGIN);
    return u.origin === SITE_ORIGIN ? `${u.pathname}${u.search}${u.hash}` : "/";
  } catch (_) {
    return "/";
  }
}
function parseCookies(request) {
  const out = {};
  const header = request?.headers?.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (!name) continue;
    const raw = part.slice(i + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch (_) {
      out[name] = raw;
    }
  }
  return out;
}
function cookieHeader(name, value, opts = {}) {
  const cookieName = String(name || "").replace(/[\r\n;=]/g, "");
  if (!cookieName) return "";
  const o = opts || {};
  const parts = [`${cookieName}=${encodeURIComponent(String(value == null ? "" : value))}`];
  const maxAge = Number(o.maxAge);
  if (Number.isFinite(maxAge)) parts.push(`Max-Age=${Math.trunc(maxAge)}`);
  parts.push(`Path=${String(o.path || "/").replace(/[\r\n;]/g, "") || "/"}`);
  if (o.httpOnly !== false) parts.push("HttpOnly");
  if (o.secure !== false) parts.push("Secure");
  parts.push(`SameSite=${String(o.sameSite || "Lax").replace(/[\r\n;]/g, "") || "Lax"}`);
  return parts.join("; ");
}
function normalizeHandle(s) {
  const raw = String(s == null ? "" : s).trim().toLowerCase();
  let out = "", lastSep = false;
  for (const ch of raw) {
    if (ch >= "a" && ch <= "z" || ch >= "0" && ch <= "9" || ch === "_" || ch === ".") {
      out += ch;
      lastSep = false;
    } else if (out && !lastSep) {
      out += ".";
      lastSep = true;
    }
  }
  out = out.replace(/^[._]+|[._]+$/g, "");
  if (out.length > 30) out = out.slice(0, 30).replace(/[._]+$/g, "");
  return /^[a-z0-9_.]{1,30}$/.test(out) ? out : "";
}
var RESERVED_HANDLES = /* @__PURE__ */ new Set([
  "account",
  "login",
  "logout",
  "welcome",
  "settings",
  "signup",
  "signin",
  "api",
  "e",
  "live",
  "discover",
  "broker",
  "www",
  "admin",
  "root",
  "mail",
  "m",
  "about",
  "help",
  "support",
  "terms",
  "privacy",
  "profile",
  "profiles",
  "edit",
  "new",
  "event",
  "events",
  "me",
  "home",
  "app",
  "assets",
  "static",
  "favicon",
  "robots",
  "sitemap",
  "auth",
  "partyparty",
  "party"
]);
function handleReserved(h) {
  const n = normalizeHandle(h);
  return !n || RESERVED_HANDLES.has(n);
}
async function handleAvailable(env, h) {
  const n = normalizeHandle(h);
  if (!n || RESERVED_HANDLES.has(n)) return false;
  if (!env?.DB) return false;
  const inProfiles = await env.DB.prepare("SELECT 1 FROM dj_profiles WHERE handle=? LIMIT 1").bind(n).first();
  if (inProfiles) return false;
  try {
    const inAliases = await env.DB.prepare("SELECT 1 FROM handle_aliases WHERE handle=? LIMIT 1").bind(n).first();
    if (inAliases) return false;
  } catch (_) {
  }
  return true;
}
async function readJson(request, maxBytes = 16384) {
  const cap = Math.max(0, Number(maxBytes) || 0);
  const len = Number(request?.headers?.get("content-length") || "0");
  READ_JSON_TOO_LARGE.delete(request);
  if (len && len > cap) {
    READ_JSON_TOO_LARGE.add(request);
    return null;
  }
  try {
    let text = "";
    if (request?.body?.getReader) {
      const reader = request.body.getReader();
      const decoder = new TextDecoder();
      let total = 0;
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) {
          await reader.cancel().catch(() => {
          });
          READ_JSON_TOO_LARGE.add(request);
          return null;
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } else {
      text = await request.text();
      if (new TextEncoder().encode(text).byteLength > cap) {
        READ_JSON_TOO_LARGE.add(request);
        return null;
      }
    }
    return text ? JSON.parse(text) : null;
  } catch (_) {
    return null;
  }
}
async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(String(str == null ? "" : str));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function getSessionUser(env, request) {
  if (!env?.DB) return null;
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE] || "";
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  return await env.DB.prepare(
    `SELECT u.*
     FROM auth_sessions s
     JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=? AND s.expires_ms>? AND s.revoked_ms IS NULL AND u.disabled_ms IS NULL
     LIMIT 1`
  ).bind(tokenHash, nowMs()).first();
}
function nowMs() {
  return Date.now();
}
function compareProductVersions(a, b) {
  const pa = /^(\d+)\.(\d+)$/.exec(String(a || "").trim());
  const pb = /^(\d+)\.(\d+)$/.exec(String(b || "").trim());
  if (!pa || !pb) return Number.NEGATIVE_INFINITY;
  const major = Number(pa[1]) - Number(pb[1]);
  return major || Number(pa[2]) - Number(pb[2]);
}
var CSS = `
:root{--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--ink2:#6e6e73;--ink3:#86868b;--line:#e6e6e9;--accent:#ff2d6f;--pill:999px;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);line-height:1.45}a{color:inherit;text-decoration:none}
nav{max-width:760px;margin:0 auto;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{font-size:18px;font-weight:700}.navlinks,.ecta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:var(--pill);padding:11px 18px;background:var(--accent);color:#fff;font:inherit;font-size:14px;font-weight:650;cursor:pointer}.btn.lt{background:var(--card);border-color:var(--line);color:var(--ink)}.btn.sm{padding:8px 13px}
.page{max-width:760px;margin:0 auto;padding:8px 20px 60px}.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:24px;margin-top:16px}.card h1,.card h2{margin:0 0 6px}.sub,.hint,.emptyline,.sectionhead p,.accounthead p{color:var(--ink2)}
.authcard{max-width:520px;margin:48px auto 0}.authform{display:grid;gap:12px;margin-top:16px}.authform input{width:100%;border:1px solid var(--line);border-radius:8px;padding:12px 14px;font:inherit}.authform input:focus{outline:0;border-color:var(--accent)}
.accounthead,.sectionhead{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}.minirow{border-top:1px solid var(--line);padding-top:12px;margin-top:12px}.minirow:first-child{border-top:0;margin-top:0;padding-top:0}.minirow b,.minirow span{display:block}.minirow span{color:var(--ink2);font-size:13px;margin:3px 0 8px}
footer{max-width:760px;margin:0 auto;padding:24px 20px 48px;color:var(--ink3);font-size:13px;display:flex;justify-content:space-between;gap:12px}
@media(max-width:560px){.accounthead,.sectionhead{display:grid}.navlinks .btn:first-child{display:none}}
`;
var SVGDEFS = "";
var NAV = `<nav><a class="brand" href="/">partyparty</a><div class="navlinks"><a class="btn lt sm" href="/partyparty.pkg">Get the app</a><a class="btn lt sm" id="nav-auth" href="/login">Sign in</a></div></nav>`;
var NAV_AUTH_JS = `<script>
(function(){var a=document.getElementById('nav-auth');if(!a||!window.fetch)return;fetch('/api/me',{credentials:'same-origin',cache:'no-store'}).then(function(r){return r.ok?r.json():null}).then(function(j){if(j&&j.user){a.textContent='Account';a.href='/account'}else{a.textContent='Sign in';a.href='/login'}}).catch(function(){})})();
<\/script>`;
var TOAST_JS = "";
function shell({ title, desc, ogImage, url, body }) {
  const pageUrl = absUrl(url || "/");
  const imageUrl = absUrl(ogImage || DEFAULT_OG_IMAGE);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:url" content="${esc(pageUrl)}"><meta property="og:site_name" content="partyparty"><meta property="og:image" content="${esc(imageUrl)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${esc(imageUrl)}">
<meta name="theme-color" content="#f5f5f7"><meta name="color-scheme" content="light">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>\u{1F57A}</text></svg>">
<link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin>
<style>${CSS}</style></head><body>${SVGDEFS}${NAV}${body}${NAV_AUTH_JS}${TOAST_JS}</body></html>`;
}
function fmtWhen(ms) {
  const n = Number(ms) || 0;
  if (!n) return "Date TBA";
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date(n));
  } catch (_) {
    return "Date TBA";
  }
}
function redirectResp(location) {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}
function defaultDisplayName(user) {
  return clip(String(user?.email || "").split("@")[0] || user?.display_name || "DJ", 80);
}
function defaultHandle(user) {
  return normalizeHandle(String(user?.email || "").split("@")[0] || user?.display_name || "dj") || "dj";
}
function handleCandidate(base, suffix) {
  const tail = suffix ? `.${suffix}` : "";
  const stem = String(base || "dj").slice(0, 30 - tail.length).replace(/[._]+$/g, "") || "dj";
  return normalizeHandle(stem + tail) || `dj.${suffix || "1"}`;
}
async function ensureUserDjProfile(env, user, now = nowMs()) {
  let profile = await env.DB.prepare("SELECT * FROM dj_profiles WHERE user_id=? LIMIT 1").bind(user.id).first();
  if (profile?.id) return profile;
  const base = defaultHandle(user);
  const displayName = defaultDisplayName(user);
  for (let i = 0; i < 10; i += 1) {
    const handle = handleCandidate(base, i ? i + 1 : 0);
    if (handleReserved(handle)) continue;
    try {
      await env.DB.prepare(
        `INSERT INTO dj_profiles (id, user_id, handle, display_name, bio, location, published, created_ms, updated_ms, last_activity_ms)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      ).bind(randHex(16), user.id, handle, displayName, "", "", now, now, now).run();
      profile = await env.DB.prepare("SELECT * FROM dj_profiles WHERE user_id=? LIMIT 1").bind(user.id).first();
      if (profile?.id) return profile;
    } catch (e) {
      if (!/unique|constraint|dj_profiles\.handle/i.test(String(e?.message || e || ""))) throw e;
    }
  }
  throw new Error("could not create DJ profile");
}
var HANDLE_CHANGE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1e3;
async function signInLanding(env, user, redirectPath) {
  return safeRedirectPath(redirectPath || "/account") || "/account";
}
async function loginResponse(request, env) {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
  }
  const redirectPath = safeRedirectPath(new URL(request.url).searchParams.get("redirect") || "/account");
  const user = await getSessionUser(env, request);
  if (user) return redirectResp(redirectPath || "/account");
  const showAdmin = new URL(request.url).searchParams.get("admin") != null;
  const adminField = showAdmin ? `<details open><summary>Admin passcode</summary><input type="password" name="devSecret" autocomplete="off" placeholder="Admin passcode" aria-label="Admin passcode"></details>` : "";
  const oauthRedirect = encodeURIComponent(redirectPath || "/account");
  const oauthBtnStyle = "display:block;width:100%;box-sizing:border-box;text-align:center;margin:0 0 8px";
  const hasGoogle = hasGoogleProvider(env);
  const hasApple = hasAppleProvider(env);
  const emailConfigured = authEmailConfigured(env);
  const providersAvailable = hasGoogle || hasApple || emailConfigured;
  if (!providersAvailable && !showAdmin) {
    const adminUrl = `/login?admin=1&redirect=${encodeURIComponent(redirectPath || "/account")}`;
    const body2 = `<div class="page">
    <div class="card authcard">
      <h1 style="font-size:30px;letter-spacing:-.03em;margin:0 0 6px">Sign in</h1>
      <p class="sub">No self-serve sign-in methods are configured for this partyparty server.</p>
      <div class="minirow" style="margin-top:14px">
        <b>Older app version only</b>
        <span>If you are already signed in, open Account and use Link your Mac \u2192 Older app version only to generate a one-time code.</span>
        <a class="btn lt sm" href="/account">Open account linking</a>
      </div>
      <p class="hint" style="margin:14px 0 0">Recovery: ask the site owner to enable Google, Apple, or MXroute SMTP sign-in, or use the admin passcode recovery link.</p>
      <div class="ecta"><a class="btn lt sm" href="${esc(adminUrl)}">Admin recovery</a></div>
    </div>
  </div>
  <footer><span>\u{1F57A} partyparty</span><span>Account access</span></footer>`;
    return new Response(shell({
      title: "Sign in \xB7 partyparty",
      desc: "Sign in to your partyparty account.",
      ogImage: DEFAULT_OG_IMAGE,
      url: "/login",
      body: body2
    }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  const providerBtns = [
    hasGoogle ? `<a class="btn lt" style="${oauthBtnStyle}" href="/auth/google?redirect=${oauthRedirect}">Continue with Google</a>` : "",
    hasApple ? `<a class="btn lt" style="${oauthBtnStyle}" href="/auth/apple?redirect=${oauthRedirect}"> Continue with Apple</a>` : ""
  ].filter(Boolean).join("");
  const showEmailForm = emailConfigured || showAdmin;
  const providerBlock = providerBtns && showEmailForm ? `<div style="margin:0 0 12px">${providerBtns}</div>
       <div style="display:flex;align-items:center;gap:10px;color:var(--ink3);font-size:12px;margin:0 0 14px"><span style="flex:1;height:1px;background:var(--line)"></span>or use email<span style="flex:1;height:1px;background:var(--line)"></span></div>` : providerBtns ? `<div style="margin:0 0 12px">${providerBtns}</div>` : "";
  const emailSub = showEmailForm && providerBtns ? "We will send a sign-in link to your email." : showEmailForm ? "Enter your email and we will send a sign-in link." : "Choose a sign-in provider to continue.";
  const emailForm = showEmailForm ? `<form class="authform" id="login-form">
        <input type="email" name="email" autocomplete="email" required placeholder="you@example.com" aria-label="Email">
        ${adminField}
        <button class="btn" type="submit">Send sign-in link</button>
      </form>
      <p class="hint" id="login-msg" role="status" style="margin:14px 0 0"></p>
      <div id="login-dev" style="margin-top:14px"></div>` : "";
  const body = `<div class="page">
    <div class="card authcard">
      <h1 style="font-size:30px;letter-spacing:-.03em;margin:0 0 6px">Sign in</h1>
      <p class="sub">${emailSub}</p>
      <p class="hint" style="margin:0 0 14px">New to partyparty? Your account is created automatically the first time you sign in \u2014 nothing to fill out.</p>
      ${providerBlock}
      ${emailForm}
    </div>
  </div>
  <script>
(function(){var f=document.getElementById('login-form'),m=document.getElementById('login-msg'),d=document.getElementById('login-dev'),redirect=${JSON.stringify(redirectPath)};if(!f)return;f.addEventListener('submit',function(ev){ev.preventDefault();m.textContent='';d.innerHTML='';var email=f.elements.email.value,secret=f.elements.devSecret?f.elements.devSecret.value:'',h={'content-type':'application/json'};if(secret)h['x-auth-dev-secret']=secret;fetch('/api/auth/request-link',{method:'POST',credentials:'same-origin',headers:h,body:JSON.stringify({email:email,redirect:redirect})}).then(function(r){return r.json().then(function(j){return {ok:r.ok,json:j}})}).then(function(out){if(!out.ok){m.textContent='Could not send a sign-in link. Check the email and try again.';return}if(out.json&&out.json.redirect){m.textContent='Signing in...';location.href=out.json.redirect;return}if(out.json&&out.json.devLink){m.textContent='Admin sign-in link ready.';var a=document.createElement('a');a.className='btn lt';a.href=out.json.devLink;a.textContent='Continue';d.appendChild(a);return}if(out.json&&out.json.queued===false){m.textContent='Email sign-in is temporarily unavailable. Use the admin passcode or try again later.';return}m.textContent='Check your email for your sign-in link.'}).catch(function(){m.textContent='Could not send a sign-in link. Try again.'})})})();
  <\/script>
  <footer><span>\u{1F57A} partyparty</span><span>Account access</span></footer>`;
  return new Response(shell({
    title: "Sign in \xB7 partyparty",
    desc: "Sign in to your partyparty account.",
    ogImage: DEFAULT_OG_IMAGE,
    url: "/login",
    body
  }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
async function accountResponse(request, env) {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
  }
  const user = await getSessionUser(env, request);
  if (!user) return redirectResp("/login?redirect=/account");
  const installs = (await env.DB.prepare(
    `SELECT install_id, install_slug, label, linked_ms, last_seen_ms
     FROM device_installs WHERE user_id=? AND revoked_ms IS NULL
     ORDER BY COALESCE(last_seen_ms, linked_ms, 0) DESC LIMIT 20`
  ).bind(user.id).all())?.results || [];
  const deviceRows = installs.length ? installs.map((d) => {
    const name = d.label && String(d.label).trim() ? d.label : d.install_slug ? "Mac \xB7 " + d.install_slug : "This Mac";
    const seen = d.last_seen_ms ? "Last seen " + fmtWhen(d.last_seen_ms) : d.linked_ms ? "Linked " + fmtWhen(d.linked_ms) : "";
    return `<div class="minirow"><b>${esc(name)}</b><span>${esc(seen)}</span><button class="btn lt sm" data-unlink-install="${esc(d.install_id)}" type="button">Unlink</button></div>`;
  }).join("") : `<p class="emptyline">No Macs linked yet. Open partyparty on your Mac and sign in to link it.</p>`;
  const body = `<div class="page">
    <div class="card">
      <div class="accounthead">
        <div><h1 style="font-size:30px;margin:0 0 6px">Account</h1><p>${esc(user.email || "")}</p></div>
        <div class="ecta" style="margin:0"><button class="btn lt sm" id="sign-out" type="button">Sign out</button></div>
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="sectionhead" style="margin:0 0 12px"><div><h2>Linked Macs</h2><p>Only Macs you approve can provision a secure room address.</p></div></div>
      ${deviceRows}<p class="hint" id="device-unlink-out" role="status"></p>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="sectionhead"><div><h2>Privacy</h2><p>Review what partyparty stores or permanently delete this account.</p></div></div>
      <div class="ecta"><a class="btn lt sm" href="/privacy">Privacy policy</a><a class="btn lt sm" href="/support">Support</a></div>
      <details style="margin-top:18px">
        <summary style="cursor:pointer;color:#b42318;font-weight:650">Delete account</summary>
        <p class="hint">This permanently deletes your account, DJ profile, linked-Mac records, and associated cloud account data. Party audio, posts, and uploads already stored on your Mac stay on that Mac.</p>
        <div class="authform" style="margin-top:10px">
          <label for="delete-confirm">Type <b>DELETE</b> to confirm</label>
          <input id="delete-confirm" autocomplete="off" spellcheck="false">
          <button class="btn" id="delete-account" type="button" style="background:#b42318">Permanently delete account</button>
        </div>
        <p class="hint" id="delete-account-out" role="status"></p>
      </details>
    </div>
  </div>
  <script>
(function(){var b=document.getElementById('sign-out');if(b)b.addEventListener('click',function(){fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'}).finally(function(){location.href='/'})});var out=document.getElementById('device-unlink-out');document.querySelectorAll('[data-unlink-install]').forEach(function(btn){btn.addEventListener('click',function(){var id=btn.getAttribute('data-unlink-install');btn.disabled=true;if(out)out.textContent='Unlinking...';fetch('/api/install-link/unlink',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({install_id:id})}).then(function(r){return r.json().then(function(j){return {ok:r.ok,json:j}})}).then(function(o){if(!o.ok)throw new Error(o.json&&o.json.error||'Could not unlink.');if(out)out.textContent='Unlinked.';setTimeout(function(){location.reload()},400)}).catch(function(e){if(out)out.textContent=e.message;btn.disabled=false})})})});var del=document.getElementById('delete-account'),confirmInput=document.getElementById('delete-confirm'),delOut=document.getElementById('delete-account-out');if(del)del.addEventListener('click',function(){if(confirmInput.value!=='DELETE'){delOut.textContent='Type DELETE exactly to confirm.';return}del.disabled=true;delOut.textContent='Deleting your account...';fetch('/api/account/delete',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({confirm:'DELETE'})}).then(function(r){return r.json().then(function(j){return {ok:r.ok,json:j}})}).then(function(o){if(!o.ok)throw new Error(o.json&&o.json.error||'Could not delete account.');delOut.textContent='Account deleted.';setTimeout(function(){location.href='/'},500)}).catch(function(e){delOut.textContent=e.message;del.disabled=false})})})();
  <\/script>
  <footer><span>partyparty</span><span><a href="/privacy">Privacy</a> · <a href="/support">Support</a></span></footer>`;
  return new Response(shell({
    title: "Account \xB7 partyparty",
    desc: "Manage Macs linked to your partyparty account.",
    ogImage: DEFAULT_OG_IMAGE,
    url: "/account",
    body
  }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
function legalResponse(pathname) {
  const privacy = pathname === "/privacy";
  const body = privacy ? `<div class="page">
    <div class="card">
      <h1>Privacy policy</h1>
      <p class="sub">Effective July 26, 2026</p>
      <h2>What partyparty does</h2>
      <p>The Mac app serves live audio and the active party room directly to guests on the same Wi-Fi. Party audio, guest names, posts, comments, reactions, photos, and videos stay on the DJ's Mac. They are not uploaded to partyparty's cloud service.</p>
      <h2>Account data</h2>
      <p>When a DJ signs in, partyparty stores the account email address, account and DJ profile identifiers, and a random install identifier for each linked Mac. These records are used only to authenticate the DJ and provision a certificate-backed local room address.</p>
      <h2>Diagnostics</h2>
      <p>The Mac App Store edition keeps diagnostics on the Mac and does not upload session logs or status telemetry. Cloudflare may process ordinary request metadata needed to operate and secure the website, authentication, and certificate broker.</p>
      <h2>Sharing and tracking</h2>
      <p>partyparty does not sell personal data, track people across apps or websites, or use account data for advertising.</p>
      <h2>Retention and deletion</h2>
      <p>Account data is kept while the account is active. A signed-in DJ can permanently delete the account and its associated cloud data from <a href="/account"><u>Account</u></a>. Content stored locally in an event folder remains under the Mac owner's control.</p>
      <h2>Contact</h2>
      <p>Questions or privacy requests: <a href="mailto:support@partyparty.party"><u>support@partyparty.party</u></a>.</p>
    </div>
  </div>` : `<div class="page">
    <div class="card">
      <h1>Support</h1>
      <p class="sub">Help with partyparty for Mac.</p>
      <h2>Contact</h2>
      <p>Email <a href="mailto:support@partyparty.party"><u>support@partyparty.party</u></a> with the app version, macOS version, and a short description of what happened.</p>
      <h2>Before a party</h2>
      <p>Connect the Mac and guests to the venue Wi-Fi, open partyparty, select the audio source, and use the displayed HTTPS QR code. Guests need no account and can keep listening while their iPhone is locked.</p>
      <h2>Account and privacy</h2>
      <p>Manage linked Macs or delete an account from <a href="/account"><u>Account</u></a>. Read the <a href="/privacy"><u>privacy policy</u></a>.</p>
    </div>
  </div>`;
  return new Response(shell({
    title: `${privacy ? "Privacy" : "Support"} \xB7 partyparty`,
    desc: privacy ? "How partyparty handles account and party data." : "Support for partyparty on Mac.",
    ogImage: DEFAULT_OG_IMAGE,
    url: pathname,
    body: body + `<footer><span>partyparty</span><span><a href="/privacy">Privacy</a> \xB7 <a href="/support">Support</a></span></footer>`
  }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}
function renderNotFound() {
  return shell({
    title: "Not found · partyparty",
    desc: "The requested page does not exist.",
    body: '<div class="page"><div class="card"><h1>Not found</h1><p class="sub">Return to partyparty or download the Mac app.</p><div class="ecta"><a class="btn" href="/">Home</a><a class="btn lt" href="/partyparty.pkg">Get the app</a></div></div></div>'
  });
}
var jsonResp = (status, obj, headers = void 0) => {
  const h = new Headers(headers || {});
  h.set("content-type", "application/json");
  return new Response(JSON.stringify(obj), { status, headers: h });
};
var BROKER_SLUG_WORDS = [
  "disco",
  "groove",
  "bass",
  "vinyl",
  "tempo",
  "fader",
  "reverb",
  "echo",
  "strobe",
  "neon",
  "boombox",
  "sub",
  "beat",
  "drop",
  "loop",
  "mix",
  "vibe",
  "funk",
  "wave",
  "pulse",
  "rhythm",
  "deck",
  "fade",
  "amp",
  "chorus",
  "riff",
  "snare",
  "hihat",
  "kick",
  "midi"
];
async function newBrokerSlug(env, id) {
  for (let tries = 0; tries < 10; tries++) {
    const cand = BROKER_SLUG_WORDS[Math.floor(Math.random() * BROKER_SLUG_WORDS.length)] + String(Math.floor(Math.random() * 90) + 10);
    if (!await env.DL.get(`broker/slug/${cand}`)) return cand;
  }
  return "party" + id.slice(0, 6);
}
async function ensureBrokerSlug(env, id, rec) {
  if (rec.slug) return rec.slug;
  const slug = await newBrokerSlug(env, id);
  rec.slug = slug;
  await env.DL.put(`broker/slug/${slug}`, id);
  await env.DL.put(`broker/${id}.json`, JSON.stringify(rec));
  return slug;
}
async function requireLinkedInstallForDNS(env, id) {
  if (env.BROKER_ALLOW_UNLINKED_DNS === "1") return null;
  if (!env.DB) return jsonResp(503, { error: "account link required" });
  const linked = await env.DB.prepare(
    "SELECT user_id, profile_id FROM device_installs WHERE install_id=? AND revoked_ms IS NULL LIMIT 1"
  ).bind(id).first();
  if (!linked?.user_id || !linked?.profile_id) {
    return jsonResp(403, { error: "link this Mac to your account before requesting certificates" });
  }
  return null;
}
function expiredLinkResponse(status = 400) {
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PartyParty sign-in link expired</title>
<style>
body{margin:0;font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#111;color:#fff;display:grid;min-height:100vh;place-items:center}
main{max-width:420px;padding:32px;text-align:center}
a{color:#9ad7ff}
</style>
</head>
<body><main><h1>That sign-in link expired.</h1><p>Request a new link to continue to PartyParty.</p><p><a href="/">Back to PartyParty</a></p></main></body>
</html>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
function verifyConfirmResponse(rawToken) {
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to partyparty</title>
<style>
body{margin:0;font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#111;color:#fff;display:grid;min-height:100vh;place-items:center}
main{max-width:420px;padding:32px;text-align:center}
button{border:0;border-radius:8px;background:#fff;color:#111;font:600 16px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:14px 22px;cursor:pointer}
</style>
</head>
<body><main><h1>Sign in to partyparty</h1><form method="POST" action="/auth/verify"><input type="hidden" name="token" value="${esc(rawToken)}"><button type="submit">Continue</button></form></main></body>
</html>`, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
function safeDecodeComponent(s) {
  try {
    return decodeURIComponent(s || "");
  } catch (_) {
    return s || "";
  }
}
function mxrouteSmtpConfigPresent(env) {
  if (String(env.AUTH_EMAIL_SERVER || "").trim()) return true;
  return !!(env.MXROUTE_SMTP_HOST && env.MXROUTE_SMTP_USER && env.MXROUTE_SMTP_PASS);
}
function authEmailConfigured(env) {
  if (!env) return false;
  return !!mxrouteSmtpConfig(env) || !!(env.EMAIL && typeof env.EMAIL.send === "function");
}
function authProvidersAvailable(env) {
  return hasGoogleProvider(env) || hasAppleProvider(env) || authEmailConfigured(env);
}
function mxrouteSmtpConfig(env) {
  const rawUrl = String(env.AUTH_EMAIL_SERVER || "").trim();
  if (rawUrl) {
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== "smtps:" && u.protocol !== "smtp:") return null;
      const hostname2 = u.hostname;
      const port2 = Number(u.port || (u.protocol === "smtps:" ? 465 : 587));
      const username2 = safeDecodeComponent(u.username);
      const password2 = safeDecodeComponent(u.password);
      if (!hostname2 || !Number.isInteger(port2) || port2 <= 0 || !username2 || !password2) return null;
      return {
        hostname: hostname2,
        port: port2,
        username: username2,
        password: password2,
        secureTransport: u.protocol === "smtps:" ? "on" : "starttls"
      };
    } catch (_) {
      return null;
    }
  }
  const hostname = String(env.MXROUTE_SMTP_HOST || "").trim();
  const username = String(env.MXROUTE_SMTP_USER || "").trim();
  const password = String(env.MXROUTE_SMTP_PASS || "");
  const port = Number(String(env.MXROUTE_SMTP_PORT || "465").trim() || "465");
  if (!hostname || !username || !password || !Number.isInteger(port) || port <= 0) return null;
  return {
    hostname,
    port,
    username,
    password,
    secureTransport: port === 465 ? "on" : "starttls"
  };
}
function smtpSafeHeloHost(env) {
  const raw = String(env.AUTH_EMAIL_HELO || env.BROKER_BASE || "partyparty.party").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9.-]{0,252}[a-z0-9]$/.test(raw) ? raw : "partyparty.party";
}
function smtpBase64(s) {
  let bin = "";
  for (const b of new TextEncoder().encode(String(s || ""))) bin += String.fromCharCode(b);
  return btoa(bin);
}
function smtpHeaderValue(s) {
  return String(s || "").replace(/[\r\n]+/g, " ").trim();
}
function smtpAddressHeader(addr) {
  const email = normalizeEmail(addr?.email) || "noreply@partyparty.party";
  const name = smtpHeaderValue(addr?.name || "");
  if (!name) return `<${email}>`;
  const quoted = name.replace(/["\\]/g, "\\$&");
  return `"${quoted}" <${email}>`;
}
function smtpNormalizeData(s) {
  return String(s || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").map((line) => line.startsWith(".") ? `.${line}` : line).join("\r\n");
}
function smtpMessageId(fromEmail) {
  const domain = String(fromEmail || "").split("@")[1] || "partyparty.party";
  return `<${randHex(16)}@${domain}>`;
}
function authEmailMimeMessage(env, toEmail, link) {
  const from = authEmailFrom(env);
  const body = authEmailBody(link);
  const boundary = `pp-${randHex(16)}`;
  const headers = [
    `From: ${smtpAddressHeader(from)}`,
    `To: <${normalizeEmail(toEmail)}>`,
    `Subject: ${smtpHeaderValue(body.subject)}`,
    "MIME-Version: 1.0",
    `Date: ${(/* @__PURE__ */ new Date()).toUTCString()}`,
    `Message-ID: ${smtpMessageId(from.email)}`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ];
  return `${headers.join("\r\n")}\r
\r
--${boundary}\r
Content-Type: text/plain; charset=utf-8\r
Content-Transfer-Encoding: 7bit\r
\r
${body.text}\r
\r
--${boundary}\r
Content-Type: text/html; charset=utf-8\r
Content-Transfer-Encoding: 7bit\r
\r
${body.html}\r
\r
--${boundary}--`;
}
var SmtpReplyReader = class {
  constructor(reader) {
    this.reader = reader;
    this.decoder = new TextDecoder();
    this.buffer = "";
  }
  async read() {
    const lines = [];
    for (; ; ) {
      const idx = this.buffer.indexOf("\n");
      if (idx < 0) {
        const { value, done } = await this.reader.read();
        if (done) throw new Error("smtp connection closed before reply");
        this.buffer += this.decoder.decode(value, { stream: true });
        continue;
      }
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      const code = Number(line.slice(0, 3));
      if (!Number.isInteger(code)) throw new Error(`smtp malformed reply: ${line}`);
      lines.push(line);
      if (line[3] !== "-") return { code, lines };
    }
  }
};
async function smtpWrite(writer, data) {
  await writer.write(new TextEncoder().encode(data));
}
async function smtpExpect(replies, expected, step) {
  const reply = await replies.read();
  const codes = Array.isArray(expected) ? expected : [expected];
  if (!codes.includes(reply.code)) {
    throw new Error(`smtp ${step} failed with ${reply.code}`);
  }
  return reply;
}
async function smtpAuthLogin(connectFn, config, message) {
  let socket = null;
  let reader = null;
  let writer = null;
  let ok = false;
  const openStreams = () => {
    reader = socket.readable.getReader();
    writer = socket.writable.getWriter();
    return new SmtpReplyReader(reader);
  };
  try {
    socket = connectFn(
      { hostname: config.hostname, port: config.port },
      { secureTransport: config.secureTransport }
    );
    if (socket.opened) await socket.opened;
    let replies = openStreams();
    await smtpExpect(replies, 220, "greeting");
    await smtpWrite(writer, `EHLO ${config.heloHost}\r
`);
    await smtpExpect(replies, 250, "ehlo");
    if (config.secureTransport === "starttls") {
      await smtpWrite(writer, "STARTTLS\r\n");
      await smtpExpect(replies, 220, "starttls");
      try {
        reader.releaseLock();
      } catch (_) {
      }
      try {
        writer.releaseLock();
      } catch (_) {
      }
      socket = socket.startTls();
      if (socket.opened) await socket.opened;
      replies = openStreams();
      await smtpWrite(writer, `EHLO ${config.heloHost}\r
`);
      await smtpExpect(replies, 250, "ehlo after starttls");
    }
    await smtpWrite(writer, "AUTH LOGIN\r\n");
    await smtpExpect(replies, 334, "auth username challenge");
    await smtpWrite(writer, `${smtpBase64(config.username)}\r
`);
    await smtpExpect(replies, 334, "auth password challenge");
    await smtpWrite(writer, `${smtpBase64(config.password)}\r
`);
    await smtpExpect(replies, 235, "auth");
    await smtpWrite(writer, `MAIL FROM:<${config.fromEmail}>\r
`);
    await smtpExpect(replies, 250, "mail from");
    await smtpWrite(writer, `RCPT TO:<${config.toEmail}>\r
`);
    await smtpExpect(replies, [250, 251], "rcpt to");
    await smtpWrite(writer, "DATA\r\n");
    await smtpExpect(replies, 354, "data");
    await smtpWrite(writer, `${smtpNormalizeData(message)}\r
.\r
`);
    await smtpExpect(replies, 250, "message");
    await smtpWrite(writer, "QUIT\r\n");
    await smtpExpect(replies, 221, "quit");
    ok = true;
    return true;
  } catch (_) {
    return false;
  } finally {
    try {
      reader?.releaseLock?.();
    } catch (_) {
    }
    try {
      writer?.releaseLock?.();
    } catch (_) {
    }
    if (!ok) {
      try {
        await socket?.close?.();
      } catch (_) {
      }
    }
  }
}
async function mxrouteConnectFn(env) {
  if (typeof env.__TEST_SMTP_CONNECT === "function") return env.__TEST_SMTP_CONNECT;
  const mod = await import("cloudflare:sockets");
  return mod.connect;
}
async function sendViaMXroute(env, toEmail, link) {
  const config = mxrouteSmtpConfig(env);
  const toNorm = normalizeEmail(toEmail);
  if (!config || !toNorm) return false;
  const from = authEmailFrom(env);
  const connectFn = await mxrouteConnectFn(env);
  return await smtpAuthLogin(connectFn, {
    ...config,
    heloHost: smtpSafeHeloHost(env),
    fromEmail: from.email,
    toEmail: toNorm
  }, authEmailMimeMessage(env, toNorm, link));
}
function authEmailFrom(env) {
  const raw = String(env.AUTH_EMAIL_FROM || env.MXROUTE_SMTP_FROM || "noreply@partyparty.party").trim();
  const match = /^(?:"?([^"<>]*)"?\s*)?<([^<>]+)>$/.exec(raw);
  const email = normalizeEmail(match ? match[2] : raw) || "noreply@partyparty.party";
  const name = clip((match ? match[1] : env.AUTH_EMAIL_FROM_NAME) || "partyparty", 80).trim() || "partyparty";
  return { email, name };
}
function authEmailBody(link) {
  const safeLink = esc(link);
  const text = `Sign in to partyparty:

${link}

This link expires in 15 minutes. If you did not request it, you can ignore this email.`;
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f7;color:#1d1d1f;font:16px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <main style="max-width:520px;margin:0 auto;padding:32px 20px">
    <h1 style="font-size:28px;line-height:1.1;margin:0 0 12px">Sign in to partyparty</h1>
    <p style="margin:0 0 20px;color:#424245">Use this link to finish signing in and link your Mac.</p>
    <p style="margin:0 0 24px"><a href="${safeLink}" style="display:inline-block;background:#ff2d6f;color:#fff;text-decoration:none;border-radius:999px;padding:12px 18px;font-weight:700">Continue to partyparty</a></p>
    <p style="margin:0;color:#6e6e73;font-size:14px">This link expires in 15 minutes. If you did not request it, you can ignore this email.</p>
  </main></body></html>`;
  return { subject: "Sign in to partyparty", text, html };
}
async function sendAuthEmail(env, toEmail, link, devMode = false) {
  if (devMode) return true;
  if (mxrouteSmtpConfigPresent(env) && await sendViaMXroute(env, toEmail, link)) {
    return true;
  }
  if (env.EMAIL && typeof env.EMAIL.send === "function") {
    const body = authEmailBody(link);
    await env.EMAIL.send({
      to: toEmail,
      from: authEmailFrom(env),
      subject: body.subject,
      text: body.text,
      html: body.html
    });
    return true;
  }
  return false;
}
function authDevEmailAllowlist(env) {
  return String(env.AUTH_DEV_EMAILS || "").split(",").map((s) => normalizeEmail(s)).filter(Boolean);
}
function authDevMode(request, env, emailNorm = "") {
  if (env.AUTH_DEV_LINKS !== "1" || !env.AUTH_DEV_SECRET) return false;
  if (request.headers.get("x-auth-dev-secret") !== env.AUTH_DEV_SECRET) return false;
  const allowed = authDevEmailAllowlist(env);
  if (!allowed.length) return true;
  return allowed.includes(normalizeEmail(emailNorm));
}
function authDevDirectMode(request, env, emailNorm = "") {
  return env.AUTH_DEV_DIRECT === "1" && authDevMode(request, env, emailNorm);
}
function authLazyCleanup(env, now) {
  if (!env?.DB || Math.random() >= 0.05) return;
  const cutoff = now - AUTH_CLEANUP_GRACE_MS;
  Promise.all([
    env.DB.prepare("DELETE FROM auth_magic_tokens WHERE expires_ms < ? LIMIT 200").bind(cutoff).run(),
    env.DB.prepare("DELETE FROM auth_sessions WHERE expires_ms < ? LIMIT 200").bind(cutoff).run()
  ]).catch(() => {
  });
}
async function readVerifyToken(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const body = await readJson(request, 2048);
    return String(body?.token || "");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 2048) return "";
  return String(new URLSearchParams(text).get("token") || "");
}
async function createAuthSession(env, request, emailNorm, now = nowMs()) {
  if (!emailNorm) return null;
  const displayName = clip(emailNorm.split("@")[0] || "Guest", 80);
  await env.DB.prepare(
    `INSERT INTO users (id, email, email_norm, display_name, created_ms, updated_ms, email_verified_ms, last_login_ms, disabled_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(email_norm) DO NOTHING`
  ).bind(randHex(16), emailNorm, emailNorm, displayName, now, now, now, now).run();
  let user = await env.DB.prepare("SELECT * FROM users WHERE email_norm=? LIMIT 1").bind(emailNorm).first();
  if (!user?.id) return null;
  await env.DB.prepare(
    "UPDATE users SET last_login_ms=?, email_verified_ms=COALESCE(email_verified_ms, ?), updated_ms=? WHERE id=?"
  ).bind(now, now, now, user.id).run();
  user = { ...user, last_login_ms: now, email_verified_ms: user.email_verified_ms || now, updated_ms: now };
  const sessionToken = randHex(32);
  const ipHash = await sha256Hex(`ip:${request.headers.get("cf-connecting-ip") || ""}`);
  const uaHash = await sha256Hex(request.headers.get("user-agent") || "");
  await env.DB.prepare(
    `INSERT INTO auth_sessions
       (id, token_hash, user_id, created_ms, expires_ms, last_seen_ms, revoked_ms, request_ip_hash, user_agent_hash)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`
  ).bind(randHex(16), await sha256Hex(sessionToken), user.id, now, now + SESSION_TTL_MS, now, ipHash, uaHash).run();
  return {
    user,
    cookie: cookieHeader(SESSION_COOKIE, sessionToken, {
      maxAge: SESSION_TTL_MS / 1e3,
      httpOnly: true,
      secure: true,
      sameSite: "Lax"
    })
  };
}
async function authRequestLink(request, env) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }
  if (!env.DB) return jsonResp(503, { error: "auth db not configured" });
  const body = await readJson(request, 2048);
  if (!body) return READ_JSON_TOO_LARGE.has(request) ? jsonResp(413, { error: "too large" }) : jsonResp(400, { error: "bad json" });
  const emailNorm = normalizeEmail(body.email);
  if (!emailNorm) return jsonResp(400, { error: "bad email" });
  const now = nowMs();
  const since = now - MAGIC_LINK_RATE_WINDOW_MS;
  const ipHash = await sha256Hex(`ip:${request.headers.get("cf-connecting-ip") || ""}`);
  const uaHash = await sha256Hex(request.headers.get("user-agent") || "");
  const devMode = authDevMode(request, env, emailNorm);
  const devDirect = authDevDirectMode(request, env, emailNorm);
  authLazyCleanup(env, now);
  if (!devMode) {
    const [ipCountRow, emailCountRow] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS n FROM auth_magic_tokens WHERE request_ip_hash=? AND created_ms>=?").bind(ipHash, since).first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM auth_magic_tokens WHERE email_norm=? AND created_ms>=?").bind(emailNorm, since).first()
    ]);
    if ((Number(ipCountRow?.n) || 0) >= MAGIC_LINK_IP_CAP || (Number(emailCountRow?.n) || 0) >= MAGIC_LINK_EMAIL_CAP) {
      return jsonResp(429, { error: "rate limited" });
    }
  }
  const rawToken = randHex(32);
  const tokenHash = await sha256Hex(rawToken);
  const redirectPath = safeRedirectPath(body.redirect);
  await env.DB.prepare(
    `INSERT INTO auth_magic_tokens
       (id, token_hash, email_norm, user_id, purpose, redirect_path, created_ms, expires_ms, used_ms, request_ip_hash, user_agent_hash)
     VALUES (?, ?, ?, NULL, 'login', ?, ?, ?, NULL, ?, ?)`
  ).bind(randHex(16), tokenHash, emailNorm, redirectPath, now, now + MAGIC_LINK_TTL_MS, ipHash, uaHash).run();
  const link = `${SITE_ORIGIN}/auth/verify?token=${encodeURIComponent(rawToken)}`;
  let queued = true;
  try {
    queued = await sendAuthEmail(env, emailNorm, link, devMode) !== false;
  } catch (e) {
    console.warn("auth email send failed", {
      code: e?.code || "",
      message: e?.message || String(e || "")
    });
    queued = false;
  }
  const out = { ok: true };
  const headers = new Headers();
  if (devMode) {
    out.devLink = link;
    if (devDirect) {
      const session = await createAuthSession(env, request, emailNorm, now);
      if (session?.cookie) {
        headers.append("set-cookie", session.cookie);
        out.redirect = await signInLanding(env, session.user, redirectPath);
      }
    }
  } else if (!queued) {
    out.queued = false;
  }
  return jsonResp(200, out, headers);
}
async function authVerify(request, env) {
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, POST" } });
  }
  if (!env.DB) return expiredLinkResponse(400);
  const rawToken = request.method === "GET" ? String(new URL(request.url).searchParams.get("token") || "") : await readVerifyToken(request);
  if (!/^[a-f0-9]{64}$/i.test(rawToken)) return expiredLinkResponse(400);
  const now = nowMs();
  const tokenHash = await sha256Hex(rawToken);
  const row = await env.DB.prepare("SELECT * FROM auth_magic_tokens WHERE token_hash=? LIMIT 1").bind(tokenHash).first();
  if (!row || row.used_ms != null || Number(row.expires_ms) < now) return expiredLinkResponse(400);
  if (request.method === "GET") return verifyConfirmResponse(rawToken);
  const mark = await env.DB.prepare("UPDATE auth_magic_tokens SET used_ms=? WHERE id=? AND used_ms IS NULL").bind(now, row.id).run();
  if ((Number(mark?.meta?.changes) || 0) < 1) return expiredLinkResponse(400);
  const emailNorm = normalizeEmail(row.email_norm);
  if (!emailNorm) return expiredLinkResponse(400);
  const session = await createAuthSession(env, request, emailNorm, now);
  if (!session?.cookie) return expiredLinkResponse(400);
  const dest = await signInLanding(env, session.user, safeRedirectPath(row.redirect_path));
  const headers = new Headers({ location: dest });
  headers.append("set-cookie", session.cookie);
  headers.set("cache-control", "no-store");
  return new Response(null, { status: 302, headers });
}
var OAUTH_STATE_COOKIE = "pp_oauth";
var GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
var GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
function hasGoogleProvider(env) {
  return !!(env && env.AUTH_GOOGLE_ID && env.AUTH_GOOGLE_SECRET);
}
function hasAppleProvider(env) {
  return !!(env && env.AUTH_APPLE_ID && env.AUTH_APPLE_TEAM_ID && env.AUTH_APPLE_KEY_ID && env.AUTH_APPLE_PRIVATE_KEY);
}
function decodeJwtPayload(jwt) {
  try {
    const part = String(jwt || "").split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - b64.length % 4) : "";
    return JSON.parse(atob(b64 + pad));
  } catch (_) {
    return null;
  }
}
function oauthStateCookie(prov, nonce, redirect, sameSite = "Lax") {
  return cookieHeader(
    OAUTH_STATE_COOKIE,
    `${prov}|${nonce}|${encodeURIComponent(redirect)}`,
    { maxAge: 600, httpOnly: true, secure: true, sameSite }
  );
}
function clearOauthStateCookie() {
  return cookieHeader(OAUTH_STATE_COOKIE, "", { maxAge: 0, httpOnly: true, secure: true, sameSite: "Lax" });
}
function oauthError(reason) {
  const h = new Headers({ location: `/login?error=${encodeURIComponent(reason || "oauth")}`, "cache-control": "no-store" });
  h.append("set-cookie", clearOauthStateCookie());
  return new Response(null, { status: 302, headers: h });
}
function readOauthState(request, prov, returnedState) {
  const saved = parseCookies(request)[OAUTH_STATE_COOKIE] || "";
  const [p, nonce, enc] = saved.split("|");
  if (!p || p !== prov || !nonce || !returnedState || nonce !== returnedState) return null;
  let redirect = "/account";
  try {
    redirect = safeRedirectPath(decodeURIComponent(enc || "")) || "/account";
  } catch (_) {
  }
  return { redirect };
}
async function googleAuthStart(request, env) {
  if (!hasGoogleProvider(env)) return redirectResp("/login");
  const redirect = safeRedirectPath(new URL(request.url).searchParams.get("redirect") || "/account") || "/account";
  const nonce = randHex(16);
  const params = new URLSearchParams({
    client_id: env.AUTH_GOOGLE_ID,
    redirect_uri: `${SITE_ORIGIN}/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    state: nonce,
    prompt: "select_account"
  });
  const headers = new Headers({ location: `${GOOGLE_AUTH_URL}?${params.toString()}`, "cache-control": "no-store" });
  headers.append("set-cookie", oauthStateCookie("g", nonce, redirect));
  return new Response(null, { status: 302, headers });
}
async function googleAuthCallback(request, env) {
  if (!hasGoogleProvider(env) || !env.DB) return oauthError("unavailable");
  const url = new URL(request.url);
  const code = url.searchParams.get("code") || "";
  const st = readOauthState(request, "g", url.searchParams.get("state") || "");
  if (!code || !st) return oauthError("state");
  let tok = null;
  try {
    const resp = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.AUTH_GOOGLE_ID,
        client_secret: env.AUTH_GOOGLE_SECRET,
        redirect_uri: `${SITE_ORIGIN}/auth/google/callback`,
        grant_type: "authorization_code"
      }).toString()
    });
    if (resp.ok) tok = await resp.json();
  } catch (_) {
  }
  const claims = decodeJwtPayload(tok && tok.id_token);
  const good = claims && claims.aud === env.AUTH_GOOGLE_ID && (claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com") && Number(claims.exp) * 1e3 > nowMs() && claims.email && claims.email_verified === true;
  const emailNorm = good ? normalizeEmail(claims.email) : "";
  if (!emailNorm) return oauthError("verify");
  const session = await createAuthSession(env, request, emailNorm);
  if (!session || !session.cookie) return oauthError("session");
  const dest = await signInLanding(env, session.user, st.redirect);
  const headers = new Headers({ location: dest, "cache-control": "no-store" });
  headers.append("set-cookie", session.cookie);
  headers.append("set-cookie", clearOauthStateCookie());
  return new Response(null, { status: 302, headers });
}
var APPLE_AUTH_URL = "https://appleid.apple.com/auth/authorize";
var APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
var APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
var APPLE_ISS = "https://appleid.apple.com";
function b64urlBytes(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(str) {
  return b64urlBytes(new TextEncoder().encode(str));
}
async function importApplePrivateKey(pem) {
  const b64 = String(pem || "").replace(/\\n/g, "\n").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der.buffer, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}
async function appleClientSecret(env, now = nowMs()) {
  const iat = Math.floor(now / 1e3);
  const header = { alg: "ES256", kid: env.AUTH_APPLE_KEY_ID, typ: "JWT" };
  const payload = { iss: env.AUTH_APPLE_TEAM_ID, iat, exp: iat + 300, aud: APPLE_ISS, sub: env.AUTH_APPLE_ID };
  const signingInput = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(payload))}`;
  const key = await importApplePrivateKey(env.AUTH_APPLE_PRIVATE_KEY);
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput)
  ));
  return `${signingInput}.${b64urlBytes(sig)}`;
}
async function appleAuthStart(request, env) {
  if (!hasAppleProvider(env)) return redirectResp("/login");
  const redirect = safeRedirectPath(new URL(request.url).searchParams.get("redirect") || "/account") || "/account";
  const nonce = randHex(16);
  const params = new URLSearchParams({
    client_id: env.AUTH_APPLE_ID,
    redirect_uri: `${SITE_ORIGIN}/auth/apple/callback`,
    response_type: "code",
    scope: "name email",
    response_mode: "form_post",
    state: nonce
  });
  const headers = new Headers({ location: `${APPLE_AUTH_URL}?${params.toString()}`, "cache-control": "no-store" });
  headers.append("set-cookie", oauthStateCookie("a", nonce, redirect, "None"));
  return new Response(null, { status: 302, headers });
}
async function appleAuthCallback(request, env) {
  if (!hasAppleProvider(env) || !env.DB) return oauthError("unavailable");
  if (request.method !== "POST") return oauthError("method");
  const form = await request.formData().catch(() => null);
  if (!form) return oauthError("form");
  const code = String(form.get("code") || "");
  const st = readOauthState(request, "a", String(form.get("state") || ""));
  if (!code || !st) return oauthError("state");
  let secret;
  try {
    secret = await appleClientSecret(env);
  } catch (_) {
    return oauthError("secret");
  }
  let tok = null;
  try {
    const resp = await fetch(APPLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.AUTH_APPLE_ID,
        client_secret: secret,
        redirect_uri: `${SITE_ORIGIN}/auth/apple/callback`,
        grant_type: "authorization_code"
      }).toString()
    });
    if (resp.ok) tok = await resp.json();
  } catch (_) {
  }
  const claims = decodeJwtPayload(tok && tok.id_token);
  const emailVerified = !!claims && (claims.email_verified === true || claims.email_verified === "true");
  const good = claims && claims.aud === env.AUTH_APPLE_ID && claims.iss === APPLE_ISS && Number(claims.exp) * 1e3 > nowMs() && claims.email && emailVerified;
  const emailNorm = good ? normalizeEmail(claims.email) : "";
  if (!emailNorm) return oauthError("verify");
  const session = await createAuthSession(env, request, emailNorm);
  if (!session || !session.cookie) return oauthError("session");
  const revokeToken = String(tok.refresh_token || tok.access_token || "");
  if (revokeToken) {
    const now = nowMs();
    const tokenKind = tok.refresh_token ? "refresh_token" : "access_token";
    await env.DB.prepare(
      `INSERT INTO auth_provider_tokens
         (provider, user_id, provider_sub, revoke_token, token_kind, created_ms, updated_ms)
       VALUES ('apple', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider, user_id) DO UPDATE SET
         provider_sub=excluded.provider_sub,
         revoke_token=excluded.revoke_token,
         token_kind=excluded.token_kind,
         updated_ms=excluded.updated_ms`
    ).bind(session.user.id, String(claims.sub || ""), revokeToken, tokenKind, now, now).run();
  }
  const dest = await signInLanding(env, session.user, st.redirect);
  const headers = new Headers({ location: dest, "cache-control": "no-store" });
  headers.append("set-cookie", session.cookie);
  headers.append("set-cookie", clearOauthStateCookie());
  return new Response(null, { status: 302, headers });
}
async function authLogout(request, env) {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
  }
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE] || "";
  if (env.DB && token) {
    await env.DB.prepare("UPDATE auth_sessions SET revoked_ms=? WHERE token_hash=? AND revoked_ms IS NULL").bind(nowMs(), await sha256Hex(token)).run();
  }
  const headers = new Headers({ "content-type": "application/json" });
  headers.append("set-cookie", cookieHeader(SESSION_COOKIE, "", { maxAge: 0, httpOnly: true, secure: true, sameSite: "Lax" }));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
async function authMe(request, env) {
  const user = await getSessionUser(env, request);
  if (!user) return jsonResp(200, { user: null });
  return jsonResp(200, {
    user: {
      id: user.id,
      email: user.email,
      display_name: user.display_name
    }
  });
}
async function revokeAppleCredential(env, userId) {
  const credential = await env.DB.prepare(
    "SELECT revoke_token, token_kind FROM auth_provider_tokens WHERE provider='apple' AND user_id=? LIMIT 1"
  ).bind(userId).first();
  if (!credential?.revoke_token) return;
  const secret = await appleClientSecret(env);
  const response = await fetch(APPLE_REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.AUTH_APPLE_ID,
      client_secret: secret,
      token: credential.revoke_token,
      token_type_hint: credential.token_kind === "access_token" ? "access_token" : "refresh_token"
    }).toString()
  });
  if (!response.ok) throw new Error(`apple revoke failed: ${response.status}`);
}
async function deleteR2Prefix(env, prefix) {
  if (!env?.DL) return;
  let cursor = void 0;
  for (let page = 0; page < 20; page += 1) {
    const listed = await env.DL.list({ prefix, limit: 1e3, cursor });
    for (const object of listed.objects || []) await env.DL.delete(object.key);
    if (!listed.truncated || !listed.cursor) return;
    cursor = listed.cursor;
  }
}
async function deleteMachineDNS(env, slug) {
  if (!slug || !(env.CF_DNS_TOKEN && env.CF_ZONE_ID && env.BROKER_BASE)) return;
  const host = machineHost(env, slug);
  const records = await cfDNS(env, "GET", `?type=A&name=${encodeURIComponent(host)}`) || [];
  for (const record of records) await cfDNS(env, "DELETE", "/" + record.id);
}
async function authDeleteAccount(request, env) {
  if (request.method !== "POST") return jsonResp(405, { error: "POST required" });
  if (!env.DB) return jsonResp(503, { error: "account db not configured" });
  const user = await getSessionUser(env, request);
  if (!user) return jsonResp(401, { error: "sign in required" });
  const body = await readJson(request, 1024);
  if (!body) return READ_JSON_TOO_LARGE.has(request) ? jsonResp(413, { error: "too large" }) : jsonResp(400, { error: "bad json" });
  if (String(body.confirm || "") !== "DELETE") return jsonResp(400, { error: "type DELETE to confirm" });
  if (hasAppleProvider(env)) {
    try {
      await revokeAppleCredential(env, user.id);
    } catch (error) {
      console.warn("apple credential revoke failed during account deletion", {
        message: String(error?.message || error)
      });
    }
  }
  const installs = await env.DB.prepare(
    "SELECT install_id, install_slug FROM device_installs WHERE user_id=?"
  ).bind(user.id).all();
  const rows = installs?.results || [];
  for (const row of rows) {
    await env.DB.prepare("DELETE FROM live_installs WHERE install_id=?").bind(row.install_id).run();
  }
  const statements = [
    ["DELETE FROM event_guests WHERE user_id=?", user.id],
    ["DELETE FROM event_guest_claims WHERE user_id=?", user.id],
    ["DELETE FROM event_rsvps WHERE user_id=?", user.id],
    ["DELETE FROM post_comments WHERE author_user_id=?", user.id],
    ["DELETE FROM posts WHERE author_user_id=?", user.id],
    ["DELETE FROM follows WHERE follower_user_id=? OR dj_profile_id IN (SELECT id FROM dj_profiles WHERE user_id=?)", user.id, user.id],
    ["DELETE FROM event_aliases WHERE slug IN (SELECT slug FROM events WHERE owner_user_id=?)", user.id],
    ["DELETE FROM publish_events WHERE user_id=?", user.id],
    ["DELETE FROM events WHERE owner_user_id=?", user.id],
    ["DELETE FROM device_installs WHERE user_id=?", user.id],
    ["DELETE FROM auth_magic_tokens WHERE user_id=? OR email_norm=?", user.id, user.email_norm],
    ["DELETE FROM users WHERE id=?", user.id]
  ];
  for (const [sql, ...bindings] of statements) await env.DB.prepare(sql).bind(...bindings).run();
  for (const row of rows) {
    const id = String(row.install_id || "");
    const slug = String(row.install_slug || "");
    const cleanup = [
      env.DL?.delete(`broker/${id}.json`).catch(() => {
      }),
      env.DL?.delete(installLinkAttemptKey(id)).catch(() => {
      }),
      deleteR2Prefix(env, `logs/${id}/`).catch(() => {
      }),
      deleteR2Prefix(env, `telemetry/${id}/`).catch(() => {
      }),
      deleteMachineDNS(env, slug).catch(() => {
      })
    ];
    if (slug) cleanup.push(env.DL?.delete(`broker/slug/${slug}`).catch(() => {
    }));
    await Promise.all(cleanup);
  }
  const headers = new Headers({ "content-type": "application/json" });
  headers.append("set-cookie", cookieHeader(SESSION_COOKIE, "", { maxAge: 0, httpOnly: true, secure: true, sameSite: "Lax" }));
  return new Response(JSON.stringify({ ok: true, deleted: true }), { status: 200, headers });
}
async function installLinkCreate(request, env) {
  if (request.method !== "POST") return jsonResp(405, { error: "POST required" });
  if (!env.DB) return jsonResp(503, { error: "link db not configured" });
  const user = await getSessionUser(env, request);
  if (!user) return jsonResp(401, { error: "sign in required" });
  const profile = await env.DB.prepare("SELECT * FROM dj_profiles WHERE user_id=? LIMIT 1").bind(user.id).first();
  if (!profile?.id) return jsonResp(400, { error: "create a DJ profile first", redirect: "/profile/edit" });
  const now = nowMs();
  cleanupInstallLinkTokens(env, now);
  const live = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM install_link_tokens WHERE user_id=? AND used_ms IS NULL AND expires_ms>?"
  ).bind(user.id, now).first();
  if ((Number(live?.n) || 0) >= INSTALL_LINK_USER_CAP) return jsonResp(429, { error: "rate limited" });
  let code = "";
  let expiresMs = 0;
  for (let i = 0; i < 3; i += 1) {
    code = randHex(16);
    expiresMs = now + INSTALL_LINK_TTL_MS;
    try {
      await env.DB.prepare(
        `INSERT INTO install_link_tokens
           (id, code_hash, user_id, profile_id, install_id, created_ms, expires_ms, used_ms)
         VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)`
      ).bind(randHex(16), await sha256Hex(code), user.id, profile.id, now, expiresMs).run();
      return jsonResp(200, { ok: true, code, expiresMs });
    } catch (e) {
      if (!/unique|constraint|install_link_tokens/i.test(String(e && e.message || e))) throw e;
    }
  }
  return jsonResp(500, { error: "could not create code" });
}
async function installLinkUnlink(request, env) {
  if (request.method !== "POST") return jsonResp(405, { error: "POST required" });
  if (!env.DB) return jsonResp(503, { error: "link db not configured" });
  const user = await getSessionUser(env, request);
  if (!user) return jsonResp(401, { error: "sign in required" });
  const wantsJson = String(request.headers.get("content-type") || "").includes("application/json");
  const body = wantsJson ? await readJson(request, 1024) : {};
  if (wantsJson && !body) return READ_JSON_TOO_LARGE.has(request) ? jsonResp(413, { error: "too large" }) : jsonResp(400, { error: "bad json" });
  const installId = String(body.install_id || body.id || "");
  const now = nowMs();
  let result;
  let revokedIds = [];
  if (installId) {
    if (!/^[a-f0-9]{12}$/.test(installId)) return jsonResp(400, { error: "bad install_id" });
    result = await env.DB.prepare(
      "UPDATE device_installs SET revoked_ms=? WHERE user_id=? AND install_id=? AND revoked_ms IS NULL"
    ).bind(now, user.id, installId).run();
    if ((Number(result?.meta?.changes) || 0) > 0) revokedIds = [installId];
  } else {
    const active = await env.DB.prepare(
      "SELECT install_id FROM device_installs WHERE user_id=? AND revoked_ms IS NULL"
    ).bind(user.id).all();
    revokedIds = (active?.results || []).map((row) => String(row.install_id || "")).filter((id) => /^[a-f0-9]{12}$/.test(id));
    result = await env.DB.prepare(
      "UPDATE device_installs SET revoked_ms=? WHERE user_id=? AND revoked_ms IS NULL"
    ).bind(now, user.id).run();
  }
  return jsonResp(200, { ok: true, revoked: Number(result?.meta?.changes) || 0 });
}
async function installBrowserLinkStart(env, id, rec, request) {
  if (!env.DB) return jsonResp(503, { error: "link db not configured" });
  const now = nowMs();
  cleanupInstallLinkTokens(env, now);
  const live = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM install_browser_tokens WHERE install_id=? AND used_ms IS NULL AND expires_ms>?"
  ).bind(id, now).first();
  if ((Number(live?.n) || 0) >= INSTALL_BROWSER_LINK_INSTALL_CAP) return jsonResp(429, { error: "rate limited" });
  for (let i = 0; i < 3; i += 1) {
    const token = randHex(32);
    try {
      await env.DB.prepare(
        `INSERT INTO install_browser_tokens
           (id, token_hash, install_id, install_slug, created_ms, expires_ms, used_ms, request_ip_hash)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
      ).bind(
        randHex(16),
        await sha256Hex(token),
        id,
        clip(rec?.slug || "", 64),
        now,
        now + INSTALL_BROWSER_LINK_TTL_MS,
        await sha256Hex(`ip:${request.headers.get("cf-connecting-ip") || ""}`)
      ).run();
      return jsonResp(200, {
        ok: true,
        url: `${SITE_ORIGIN}/link-mac?token=${encodeURIComponent(token)}`,
        expiresMs: now + INSTALL_BROWSER_LINK_TTL_MS
      });
    } catch (e) {
      if (!/unique|constraint|install_browser_tokens/i.test(String(e && e.message || e))) throw e;
    }
  }
  return jsonResp(500, { error: "could not create sign-in link" });
}
function linkMacPage(title, message, extra = "") {
  const body = `<div class="page">
    <div class="card authcard">
      <h1 style="font-size:30px;letter-spacing:-.03em;margin:0 0 8px">${esc(title)}</h1>
      <p class="sub">${esc(message)}</p>
      ${extra}
    </div>
  </div>
  <footer><span>\u{1F57A} partyparty</span><span>Mac link</span></footer>`;
  return new Response(shell({
    title: `${title} \xB7 partyparty`,
    desc: "Link your Mac to your partyparty account.",
    ogImage: DEFAULT_OG_IMAGE,
    url: "/link-mac",
    body
  }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
function linkMacConfirmPage(user, rawToken) {
  const who = esc(user.email || "your account");
  const extra = `<form method="POST" action="/link-mac" style="margin-top:16px">
      <input type="hidden" name="token" value="${esc(rawToken)}">
      <div class="ecta">
        <button class="btn" type="submit">Link this Mac to ${who}</button>
        <a class="btn lt sm" href="/account">Not now</a>
      </div>
    </form>`;
  return linkMacPage(
    "Link this Mac?",
    `Linking lets this Mac provision its secure same-Wi-Fi room address under ${user.email || "your account"}. Only continue if you just started sign-in from partyparty on this Mac.`,
    extra
  );
}
async function linkMacResponse(request, env) {
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, POST" } });
  }
  if (!env.DB) return linkMacPage("Link unavailable", "Account linking is not configured yet.");
  const isPost = request.method === "POST";
  let rawToken;
  if (isPost) {
    const origin = request.headers.get("origin") || "";
    if (origin && origin !== SITE_ORIGIN && origin !== "null") {
      return linkMacPage("Link blocked", "That request didn\u2019t come from partyparty. Start sign-in again from the app on your Mac.");
    }
    const form = await request.formData().catch(() => null);
    rawToken = String(form && form.get("token") || "").trim().toLowerCase();
  } else {
    rawToken = String(new URL(request.url).searchParams.get("token") || "").trim().toLowerCase();
  }
  if (!/^[a-f0-9]{64}$/.test(rawToken)) {
    return linkMacPage("Link expired", "Open partyparty on your Mac and start sign-in again.");
  }
  const tokenHash = await sha256Hex(rawToken);
  const row = await env.DB.prepare("SELECT * FROM install_browser_tokens WHERE token_hash=? LIMIT 1").bind(tokenHash).first();
  const now = nowMs();
  if (!row || row.used_ms != null || Number(row.expires_ms) <= now) {
    return linkMacPage("Link expired", "Open partyparty on your Mac and start sign-in again.");
  }
  const user = await getSessionUser(env, request);
  if (!user) {
    return redirectResp(`/login?redirect=${encodeURIComponent(`/link-mac?token=${rawToken}`)}`);
  }
  const profile = await ensureUserDjProfile(env, user, now);
  const existing = await env.DB.prepare(
    "SELECT user_id, profile_id, revoked_ms FROM device_installs WHERE install_id=? LIMIT 1"
  ).bind(row.install_id).first();
  if (existing && existing.revoked_ms == null && existing.user_id && existing.user_id !== user.id) {
    return linkMacPage(
      "Mac already linked",
      "This Mac is linked to a different account. Unlink it from that account first.",
      `<div class="ecta"><a class="btn lt sm" href="/account">Account</a></div>`
    );
  }
  if (!isPost) {
    return linkMacConfirmPage(user, rawToken);
  }
  const mark = await env.DB.prepare(
    "UPDATE install_browser_tokens SET used_ms=? WHERE id=? AND used_ms IS NULL"
  ).bind(now, row.id).run();
  if ((Number(mark?.meta?.changes) || 0) < 1) {
    return linkMacPage("Link expired", "Open partyparty on your Mac and start sign-in again.");
  }
  await env.DB.prepare(
    `INSERT INTO device_installs
       (install_id, install_slug, user_id, profile_id, label, created_ms, linked_ms, last_seen_ms, revoked_ms)
     VALUES (?, ?, ?, ?, '', ?, ?, ?, NULL)
     ON CONFLICT(install_id) DO UPDATE SET
       install_slug=excluded.install_slug,
       user_id=excluded.user_id,
       profile_id=excluded.profile_id,
       linked_ms=excluded.linked_ms,
       last_seen_ms=excluded.last_seen_ms,
       revoked_ms=NULL`
  ).bind(row.install_id, row.install_slug || "", user.id, profile.id, now, now, now).run();
  return linkMacPage(
    "Mac linked",
    `This Mac is now linked to ${user.email || "your account"}.`,
    // The hidden marker lets partyparty's in-app sign-in window detect that the
    // bind landed (a native-injected script watches for [data-pp-linked] and
    // signals the app to drop its activation gate). Harmless in a plain browser.
    `<span data-pp-linked="1" hidden></span><div class="ecta"><a class="btn sm" href="/account">View account</a><a class="btn lt sm" href="/">Go to website</a></div>`
  );
}
function cleanupInstallLinkTokens(env, now) {
  try {
    const jobs = [env.DB.prepare(
      "DELETE FROM install_link_tokens WHERE (used_ms IS NOT NULL OR expires_ms < ?) AND created_ms < ? LIMIT 200"
    ).bind(now, now - INSTALL_LINK_CLEANUP_GRACE_MS).run()];
    jobs.push(env.DB.prepare(
      "DELETE FROM install_browser_tokens WHERE (used_ms IS NOT NULL OR expires_ms < ?) AND created_ms < ? LIMIT 200"
    ).bind(now, now - INSTALL_LINK_CLEANUP_GRACE_MS).run());
    Promise.all(jobs).catch(() => {
    });
  } catch (_) {
  }
}
function installLinkAttemptKey(id) {
  return `broker/link-install-attempts/${id}.json`;
}
async function installLinkAttemptState(env, id, now) {
  try {
    const row = await env.DL.get(installLinkAttemptKey(id)).then((o) => o ? o.json() : null);
    if (!row || Number(row.start_ms) + INSTALL_LINK_ATTEMPT_WINDOW_MS <= now) return { start_ms: now, n: 0 };
    return { start_ms: Number(row.start_ms) || now, n: Number(row.n) || 0 };
  } catch (_) {
    return { start_ms: now, n: 0 };
  }
}
async function installLinkAttemptsExceeded(env, id, now) {
  const state = await installLinkAttemptState(env, id, now);
  return state.n >= INSTALL_LINK_ATTEMPT_CAP;
}
async function recordInstallLinkFailure(env, id, now) {
  try {
    const state = await installLinkAttemptState(env, id, now);
    await env.DL.put(installLinkAttemptKey(id), JSON.stringify({ start_ms: state.start_ms, n: state.n + 1 }), {
      httpMetadata: { contentType: "application/json" }
    });
  } catch (_) {
  }
}
async function clearInstallLinkFailures(env, id) {
  try {
    await env.DL.delete(installLinkAttemptKey(id));
  } catch (_) {
  }
}
async function contentState(env) {
  const cache = caches.default;
  const key = new Request("https://pp-internal-cache/content-state");
  try {
    const hit = await cache.match(key);
    if (hit) return await hit.json();
  } catch (e) {
  }
  const state = await readContentState(env);
  try {
    await cache.put(key, new Response(JSON.stringify(state), {
      headers: { "content-type": "application/json", "cache-control": "max-age=3" }
    }));
  } catch (e) {
  }
  return state;
}
async function readContentState(env) {
  let payloadVersion = 0, minRuntime = 1, appVersion = "";
  try {
    const m = await env.DL.get("content/manifest.json");
    if (m) {
      const j = await m.json();
      payloadVersion = j.payloadVersion || 0;
      minRuntime = j.minRuntime || 1;
    }
  } catch (e) {
  }
  try {
    const a = await env.DL.get("content/app-version");
    if (a) appVersion = (await a.text()).trim();
  } catch (e) {
  }
  return { payloadVersion, minRuntime, appVersion };
}
function machineHost(env, label) {
  return `${label}.party.${env.BROKER_BASE}`;
}
async function cfDNS(env, method, suffix, body, zoneId) {
  const zone = zoneId || env.CF_ZONE_ID;
  const url = `https://api.cloudflare.com/client/v4/zones/${zone}/dns_records${suffix}`;
  const resp = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${env.CF_DNS_TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : void 0
  });
  const j = await resp.json().catch(() => ({}));
  if (!j.success) throw new Error("cloudflare: " + (j.errors && j.errors[0] ? j.errors[0].message : resp.status));
  return j.result;
}
async function authInstall(env, id, secret) {
  if (!/^[a-f0-9]{12}$/.test(String(id || ""))) return null;
  const rec = await env.DL.get(`broker/${id}.json`).then((o) => o ? o.json() : null);
  if (!rec || rec.secret !== secret) return null;
  return rec;
}
function isValidIPv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || ""));
  if (!m) return false;
  return m.slice(1, 5).every((o) => {
    const n = Number(o);
    return n >= 0 && n <= 255 && String(n) === o;
  });
}
async function upsertMachineA(env, rec, expectedIPv4) {
  const host = machineHost(env, rec.slug);
  if (!isValidIPv4(expectedIPv4)) return { ok: false, host, reason: "invalid_lan_ip" };
  let existing;
  try {
    existing = await cfDNS(env, "GET", `?type=A&name=${encodeURIComponent(host)}`) || [];
  } catch (e) {
    return { ok: false, host, reason: "cloudflare_read_failed" };
  }
  let keep = existing.find((r) => r.content === expectedIPv4 && r.proxied === false) || existing[0] || null;
  try {
    if (!keep) {
      keep = await cfDNS(env, "POST", "", { type: "A", name: host, content: expectedIPv4, ttl: 60, proxied: false });
    } else if (keep.content !== expectedIPv4 || keep.ttl !== 60 || keep.proxied !== false) {
      keep = await cfDNS(env, "PUT", "/" + keep.id, { type: "A", name: host, content: expectedIPv4, ttl: 60, proxied: false });
    }
  } catch (e) {
    return { ok: false, host, reason: "cloudflare_write_failed" };
  }
  try {
    for (const r of existing) if (r.id !== keep.id) await cfDNS(env, "DELETE", "/" + r.id);
  } catch (e) {
    return { ok: false, host, reason: "duplicate_cleanup_failed" };
  }
  let after;
  try {
    after = await cfDNS(env, "GET", `?type=A&name=${encodeURIComponent(host)}`) || [];
  } catch (e) {
    return { ok: false, host, reason: "cloudflare_verify_failed" };
  }
  if (after.length !== 1 || after[0].content !== expectedIPv4 || after[0].proxied !== false) {
    return { ok: false, host, reason: "record_mismatch" };
  }
  return { ok: true, host, ip: expectedIPv4, recordId: after[0].id, proxied: false, verified: true };
}
var NAMESPACE_ANCHOR_CONTENT = "partyparty-machine-namespace-v1";
async function ensureNamespaceAnchor(env) {
  if (!(env.CF_DNS_TOKEN && env.CF_ZONE_ID && env.BROKER_BASE)) {
    return { ok: false, reason: "not_configured" };
  }
  const anchorName = `party.${env.BROKER_BASE}`;
  const guardName = `*.party.${env.BROKER_BASE}`;
  const hasAnchor = (recs) => (recs || []).some((r) => String(r.content || "").replace(/^"|"$/g, "") === NAMESPACE_ANCHOR_CONTENT);
  let txt;
  try {
    txt = await cfDNS(env, "GET", `?type=TXT&name=${encodeURIComponent(anchorName)}`);
  } catch (e) {
    return { ok: false, reason: "anchor_read_failed" };
  }
  if (!hasAnchor(txt)) {
    try {
      await cfDNS(env, "POST", "", { type: "TXT", name: anchorName, content: NAMESPACE_ANCHOR_CONTENT, ttl: 300 });
    } catch (e) {
      return { ok: false, reason: "anchor_create_failed" };
    }
  }
  let confirm;
  try {
    confirm = await cfDNS(env, "GET", `?type=TXT&name=${encodeURIComponent(anchorName)}`);
  } catch (e) {
    return { ok: false, reason: "anchor_verify_failed" };
  }
  if (!hasAnchor(confirm)) return { ok: false, reason: "anchor_unverified" };
  let guards;
  try {
    guards = await cfDNS(env, "GET", `?type=A&name=${encodeURIComponent(guardName)}`);
  } catch (e) {
    return { ok: true, anchor: true, guardCleanup: "read_failed" };
  }
  let deleted = 0;
  for (const r of guards || []) {
    try {
      await cfDNS(env, "DELETE", "/" + r.id);
      deleted++;
    } catch (e) {
    }
  }
  return { ok: true, anchor: true, deletedGuards: deleted };
}
async function discoverRateLimited(ipHash, bucket = "discover", maxAge = 2) {
  try {
    const cache = caches.default;
    if (!cache) return false;
    const key = new Request(`https://ratelimit.partyparty.internal/${bucket}/${ipHash}`);
    if (await cache.match(key)) return true;
    await cache.put(key, new Response("1", { headers: { "cache-control": `max-age=${maxAge}` } }));
    return false;
  } catch (e) {
    return false;
  }
}
async function brokerAccountStatus(env, id, rec) {
  if (!env.DB) return jsonResp(503, { error: "account db not configured" });
  const providersAvailable = authProvidersAvailable(env);
  const linked = await env.DB.prepare(
    `SELECT
       di.user_id,
       u.email,
       u.display_name AS user_display_name
     FROM device_installs di
     LEFT JOIN users u ON u.id=di.user_id
     WHERE di.install_id=? AND di.revoked_ms IS NULL
     LIMIT 1`
  ).bind(id).first();
  if (!linked?.user_id) {
    return jsonResp(200, {
      ok: true,
      providersAvailable,
      linked: false,
      install: { id, slug: rec.slug || "", host: machineHost(env, rec.slug || id) },
      license: { ok: false, reason: "sign in required" }
    });
  }
  return jsonResp(200, {
    ok: true,
    providersAvailable,
    linked: true,
    user: {
      id: linked.user_id,
      email: linked.email || "",
      displayName: linked.user_display_name || ""
    },
    install: { id, slug: rec.slug || "", host: machineHost(env, rec.slug || id) },
    license: { ok: true, source: "account" }
  });
}
async function brokerAccountUnlink(env, id) {
  if (!env.DB) return jsonResp(503, { error: "account db not configured" });
  const now = nowMs();
  const result = await env.DB.prepare(
    "UPDATE device_installs SET revoked_ms=?, last_seen_ms=? WHERE install_id=? AND revoked_ms IS NULL"
  ).bind(now, now, id).run();
  return jsonResp(200, { ok: true, revoked: Number(result?.meta?.changes) || 0 });
}
function brokerJsonCap(pathname) {
  if (pathname === "/api/broker/log") return 81e5;
  if (pathname === "/api/broker/telemetry") return 128e3;
  if (pathname === "/api/broker/link-install") return 2048;
  if (pathname === "/api/broker/link-start") return 2048;
  if (pathname === "/api/broker/account-status") return 2048;
  if (pathname === "/api/broker/account-unlink") return 2048;
  return 16384;
}
async function broker(request, env, pathname) {
  if (pathname === "/api/broker/ping") return jsonResp(200, { ok: true, t: Date.now() });
  if (request.method !== "POST") return jsonResp(405, { error: "POST required" });
  if (!env.CF_DNS_TOKEN || !env.CF_ZONE_ID || !env.BROKER_BASE) return jsonResp(503, { error: "broker not configured" });
  const jsonCap = brokerJsonCap(pathname);
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength && contentLength > jsonCap) return jsonResp(413, { error: "too large" });
  const body = await readJson(request, jsonCap);
  if (!body) return READ_JSON_TOO_LARGE.has(request) ? jsonResp(413, { error: "too large" }) : jsonResp(400, { error: "bad json" });
  if (pathname === "/api/broker/register") {
    const ipHash = await sha256Hex(`ip:${request.headers.get("cf-connecting-ip") || ""}`);
    if (await discoverRateLimited(ipHash, "register", 10)) {
      return jsonResp(429, { error: "slow down" }, { "retry-after": "10" });
    }
    const id2 = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const secret = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const slug = await newBrokerSlug(env, id2);
    await env.DL.put(`broker/slug/${slug}`, id2);
    await env.DL.put(`broker/${id2}.json`, JSON.stringify({ secret, slug, created: Date.now() }));
    return jsonResp(200, { id: id2, secret, base: env.BROKER_BASE, slug });
  }
  if (pathname === "/api/broker/wildcard-cert") {
    const id2 = String(body.id || "");
    if (!await authInstall(env, id2, body.secret || "")) {
      return jsonResp(403, { error: "bad install auth" });
    }
    const linkErr = await requireLinkedInstallForDNS(env, id2);
    if (linkErr) return linkErr;
    const obj = await env.DL.get("wildcard/current.json");
    if (!obj) return jsonResp(404, { error: "wildcard cert not provisioned" });
    return new Response(await obj.text(), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
  }
  const isAdmin = env.ADMIN_KEY && body.admin === env.ADMIN_KEY;
  if (pathname === "/api/broker/installs") {
    if (!isAdmin) return jsonResp(403, { error: "admin only" });
    const list = await env.DL.list({ prefix: "broker/", limit: 1e3 });
    const installs = [];
    for (const o of list.objects) {
      if (!o.key.endsWith(".json")) continue;
      try {
        const r2 = await env.DL.get(o.key).then((x) => x ? x.json() : null);
        if (r2) installs.push({ id: o.key.slice(7, -5), slug: r2.slug || "", created: r2.created || 0 });
      } catch (e) {
      }
    }
    return jsonResp(200, { installs });
  }
  if (pathname === "/api/broker/dns-admin") {
    if (!isAdmin) return jsonResp(403, { error: "admin only" });
    const op = String(body.op || "list");
    const zone = body.zone != null && /^[0-9a-f]{32}$/i.test(String(body.zone)) ? String(body.zone) : void 0;
    if (body.zone != null && !zone) return jsonResp(400, { error: "bad zone" });
    try {
      if (op === "list") {
        const search = body.search ? `&search=${encodeURIComponent(String(body.search).slice(0, 120))}` : "";
        const recs = await cfDNS(env, "GET", `?per_page=100${search}`, void 0, zone);
        return jsonResp(200, { ok: true, records: (recs || []).map((r) => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied })) });
      }
      if (op === "create") {
        const rec2 = { type: String(body.type || "A"), name: String(body.name || ""), content: String(body.content || ""), ttl: 1, proxied: body.proxied !== false };
        if (!rec2.name || !rec2.content) return jsonResp(400, { error: "name and content required" });
        if (body.priority != null) rec2.priority = Number(body.priority) || 0;
        const made = await cfDNS(env, "POST", "", rec2, zone);
        return jsonResp(200, { ok: true, id: made?.id || "" });
      }
      if (op === "delete") {
        const rid = String(body.recordId || "");
        if (!/^[0-9a-f]{32}$/i.test(rid)) return jsonResp(400, { error: "bad recordId" });
        await cfDNS(env, "DELETE", "/" + encodeURIComponent(rid), void 0, zone);
        return jsonResp(200, { ok: true });
      }
      return jsonResp(400, { error: "bad op" });
    } catch (e) {
      return jsonResp(502, { error: String(e && e.message || e) });
    }
  }
  const id = String(body.id || "");
  if (!/^[a-f0-9]{12}$/.test(id)) return jsonResp(400, { error: "bad id" });
  if (pathname === "/api/broker/link-start") {
    const rec2 = await authInstall(env, id, body.secret || "");
    if (!rec2) return jsonResp(403, { error: "bad credentials" });
    return await installBrowserLinkStart(env, id, rec2, request);
  }
  if (pathname === "/api/broker/account-status") {
    const rec2 = await authInstall(env, id, body.secret || "");
    if (!rec2) return jsonResp(403, { error: "bad credentials" });
    return await brokerAccountStatus(env, id, rec2);
  }
  if (pathname === "/api/broker/account-unlink") {
    const rec2 = await authInstall(env, id, body.secret || "");
    if (!rec2) return jsonResp(403, { error: "bad credentials" });
    return await brokerAccountUnlink(env, id);
  }
  if (pathname === "/api/broker/link-install") {
    if (!env.DB) return jsonResp(503, { error: "link db not configured" });
    const rec2 = await authInstall(env, id, body.secret || "");
    if (!rec2) return jsonResp(403, { error: "bad credentials" });
    const now = nowMs();
    if (await installLinkAttemptsExceeded(env, id, now)) return jsonResp(429, { error: "rate limited" });
    const code = String(body.code || "").trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(code)) {
      await recordInstallLinkFailure(env, id, now);
      return jsonResp(400, { error: "bad code" });
    }
    const token = await env.DB.prepare("SELECT * FROM install_link_tokens WHERE code_hash=? LIMIT 1").bind(await sha256Hex(code)).first();
    if (!token || token.used_ms != null || Number(token.expires_ms) <= now) {
      await recordInstallLinkFailure(env, id, now);
      return jsonResp(400, { error: "invalid code" });
    }
    const profile = await env.DB.prepare("SELECT * FROM dj_profiles WHERE id=? LIMIT 1").bind(token.profile_id).first();
    if (!profile?.id) {
      await recordInstallLinkFailure(env, id, now);
      return jsonResp(400, { error: "invalid code" });
    }
    const existing = await env.DB.prepare(
      "SELECT user_id, profile_id, revoked_ms FROM device_installs WHERE install_id=? LIMIT 1"
    ).bind(id).first();
    if (existing && existing.revoked_ms == null && existing.user_id && existing.user_id !== token.user_id) {
      return jsonResp(409, { error: "install already linked to another account; unlink it first" });
    }
    const mark = await env.DB.prepare(
      "UPDATE install_link_tokens SET used_ms=?, install_id=? WHERE id=? AND used_ms IS NULL"
    ).bind(now, id, token.id).run();
    if ((Number(mark?.meta?.changes) || 0) < 1) {
      await recordInstallLinkFailure(env, id, now);
      return jsonResp(400, { error: "invalid code" });
    }
    const uname = normalizeHandle(profile.handle || "");
    if (uname && !handleReserved(uname) && rec2.slug !== uname) {
      const owner = await env.DL.get(`broker/slug/${uname}`).then((o) => o ? o.text() : "");
      if (!owner || owner === id) {
        const oldSlug = rec2.slug;
        rec2.slug = uname;
        await env.DL.put(`broker/slug/${uname}`, id);
        await env.DL.put(`broker/${id}.json`, JSON.stringify(rec2));
        if (oldSlug && oldSlug !== uname) await env.DL.delete(`broker/slug/${oldSlug}`).catch(() => {
        });
      }
    }
    await env.DB.prepare(
      `INSERT INTO device_installs
         (install_id, install_slug, user_id, profile_id, label, created_ms, linked_ms, last_seen_ms, revoked_ms)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, NULL)
       ON CONFLICT(install_id) DO UPDATE SET
         install_slug=excluded.install_slug,
         user_id=excluded.user_id,
         profile_id=excluded.profile_id,
         linked_ms=excluded.linked_ms,
         last_seen_ms=excluded.last_seen_ms,
         revoked_ms=NULL`
    ).bind(id, rec2.slug || "", token.user_id, token.profile_id, now, now, now).run();
    await clearInstallLinkFailures(env, id);
    return jsonResp(200, { ok: true, handle: normalizeHandle(profile.handle) });
  }
  const rec = await env.DL.get(`broker/${id}.json`).then((o) => o ? o.json() : null);
  const READ_ONLY = ["/api/broker/telemetry-dump", "/api/broker/log-list", "/api/broker/log-get"];
  if (isAdmin && READ_ONLY.includes(pathname)) {
  } else if (!rec || rec.secret !== body.secret) {
    return jsonResp(403, { error: "bad credentials" });
  }
  let label = rec.slug || id;
  if (pathname === "/api/broker/txt") {
    const linkedErr = await requireLinkedInstallForDNS(env, id);
    if (linkedErr) return linkedErr;
    label = await ensureBrokerSlug(env, id, rec);
    const value = String(body.value || "");
    if (!value || value.length > 255) return jsonResp(400, { error: "bad value" });
    const name = `_acme-challenge.${machineHost(env, label)}`;
    const old = await cfDNS(env, "GET", `?type=TXT&name=${name}`);
    for (const r of old || []) await cfDNS(env, "DELETE", "/" + r.id);
    await cfDNS(env, "POST", "", { type: "TXT", name, content: value, ttl: 60 });
    return jsonResp(200, { ok: true, name });
  }
  if (pathname === "/api/broker/a") {
    const linkedErr = await requireLinkedInstallForDNS(env, id);
    if (linkedErr) return linkedErr;
    await ensureBrokerSlug(env, id, rec);
    const receipt = await upsertMachineA(env, rec, String(body.ip || ""));
    if (!receipt.ok) {
      return jsonResp(
        receipt.reason === "invalid_lan_ip" ? 400 : 502,
        { ok: false, host: receipt.host, reason: receipt.reason }
      );
    }
    return jsonResp(200, receipt);
  }
  if (pathname === "/api/broker/telemetry") {
    if (!body.snap) return jsonResp(400, { error: "no snap" });
    await env.DL.put(`telemetry/${id}/${Date.now()}.json`, JSON.stringify(body.snap));
    return jsonResp(200, { ok: true });
  }
  if (pathname === "/api/broker/log") {
    const session = String(body.session || "").replace(/[^a-zA-Z0-9._-]/g, "");
    if (!body.log || !session) return jsonResp(400, { error: "no log/session" });
    let bytes;
    try {
      bytes = Uint8Array.from(atob(body.log), (c) => c.charCodeAt(0));
    } catch (e) {
      return jsonResp(400, { error: "bad base64" });
    }
    if (bytes.length > 6e6) return jsonResp(413, { error: "log too large" });
    await env.DL.put(`logs/${id}/${session}.log.gz`, bytes);
    return jsonResp(200, { ok: true });
  }
  if (pathname === "/api/broker/log-list") {
    const list = await env.DL.list({ prefix: `logs/${id}/`, limit: 1e3 });
    return jsonResp(200, { logs: list.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded })) });
  }
  if (pathname === "/api/broker/log-get") {
    const key = String(body.key || "");
    if (!key.startsWith(`logs/${id}/`)) return jsonResp(400, { error: "bad key" });
    const o = await env.DL.get(key);
    if (!o) return jsonResp(404, { error: "not found" });
    const buf = new Uint8Array(await o.arrayBuffer());
    let b64 = "";
    for (let i = 0; i < buf.length; i += 32768) b64 += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
    return jsonResp(200, { key, gz: btoa(b64) });
  }
  if (pathname === "/api/broker/telemetry-dump") {
    const n = Math.min(Number(body.n) || 10, 50);
    const list = await env.DL.list({ prefix: `telemetry/${id}/`, limit: 1e3 });
    const keys = list.objects.map((o) => o.key).sort().slice(-n);
    const entries = [];
    for (const k of keys) {
      const o = await env.DL.get(k);
      if (o) entries.push({ key: k, snap: await o.json() });
    }
    return jsonResp(200, { entries });
  }
  return jsonResp(404, { error: "unknown broker endpoint" });
}
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname === "/.well-known/apple-developer-domain-association.txt") {
      if (env.APPLE_DOMAIN_ASSOC) {
        return new Response(env.APPLE_DOMAIN_ASSOC, {
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
        });
      }
      return new Response("Not configured", { status: 404 });
    }
    if (pathname === "/api/auth/request-link") {
      try {
        return await authRequestLink(request, env);
      } catch (_) {
        return jsonResp(500, { error: "auth unavailable" });
      }
    }
    if (pathname === "/auth/verify") {
      try {
        return await authVerify(request, env);
      } catch (_) {
        return expiredLinkResponse(400);
      }
    }
    if (pathname === "/auth/google") {
      try {
        return await googleAuthStart(request, env);
      } catch (_) {
        return redirectResp("/login");
      }
    }
    if (pathname === "/auth/google/callback") {
      try {
        return await googleAuthCallback(request, env);
      } catch (_) {
        return oauthError("oauth");
      }
    }
    if (pathname === "/auth/apple") {
      try {
        return await appleAuthStart(request, env);
      } catch (_) {
        return redirectResp("/login");
      }
    }
    if (pathname === "/auth/apple/callback") {
      try {
        return await appleAuthCallback(request, env);
      } catch (_) {
        return oauthError("oauth");
      }
    }
    if (pathname === "/api/auth/logout") {
      try {
        return await authLogout(request, env);
      } catch (_) {
        return jsonResp(200, { ok: true });
      }
    }
    if (pathname === "/api/me") {
      try {
        return await authMe(request, env);
      } catch (_) {
        return jsonResp(200, { user: null });
      }
    }
    if (pathname === "/api/account/delete") {
      try {
        return await authDeleteAccount(request, env);
      } catch (_) {
        return jsonResp(500, { error: "account deletion unavailable" });
      }
    }
    if (pathname === "/api/version") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const headers = { "cache-control": "public, max-age=300" };
      if (request.method === "HEAD") {
        return new Response(null, { headers: { ...headers, "content-type": "application/json" } });
      }
      let version = APP_VERSION, date = APP_VERSION_DATE;
      try {
        const a = await env.DL.get("content/app-version");
        if (a) {
          const v = (await a.text()).trim();
          if (v && compareProductVersions(v, version) >= 0) {
            version = v;
            if (a.uploaded) date = new Date(a.uploaded).toISOString().slice(0, 10);
          }
        }
      } catch (e) {
      }
      return jsonResp(200, { version, date }, headers);
    }
    if (pathname === "/api/install-link/create") {
      try {
        return await installLinkCreate(request, env);
      } catch (e) {
        return jsonResp(500, { error: String(e && e.message || e) });
      }
    }
    if (pathname === "/api/install-link/unlink") {
      try {
        return await installLinkUnlink(request, env);
      } catch (e) {
        return jsonResp(500, { error: String(e && e.message || e) });
      }
    }
    if (pathname === "/link-mac") {
      try {
        return await linkMacResponse(request, env);
      } catch (_) {
        return linkMacPage("Link unavailable", "Open partyparty on your Mac and start sign-in again.");
      }
    }
    if (pathname === "/login") {
      try {
        return await loginResponse(request, env);
      } catch (_) {
        return new Response(renderNotFound(), {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
        });
      }
    }
    if (pathname === "/account") {
      try {
        return await accountResponse(request, env);
      } catch (_) {
        return new Response(renderNotFound(), {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
        });
      }
    }
    if (pathname === "/privacy" || pathname === "/support") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const response = legalResponse(pathname);
      return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
    }
    if (pathname.startsWith("/api/broker/")) {
      try {
        return await broker(request, env, pathname);
      } catch (e) {
        return jsonResp(500, { error: String(e && e.message || e) });
      }
    }
    const isFeed = pathname === "/appcast.xml";
    const isZip = ZIP_RE.test(pathname);
    if (isFeed || isZip) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const key = pathname.slice(1);
      const obj = await env.DL.get(key);
      if (!obj) return new Response("Not found \u2014 run `make release`.", { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      if (isFeed) {
        headers.set("content-type", "application/xml");
        headers.set("cache-control", "public, max-age=60");
      } else {
        headers.set(
          "content-type",
          key.endsWith(".dmg") ? "application/x-apple-diskimage" : key.endsWith(".pkg") ? "application/octet-stream" : "application/zip"
        );
        const dlName = key === "partyparty.pkg" ? "PartyParty Installer.pkg" : key;
        headers.set("content-disposition", `attachment; filename="${dlName}"`);
        const isLatestAlias = key === "partyparty.zip" || key === "partyparty.pkg" || key === "partyparty.dmg";
        headers.set("cache-control", isLatestAlias ? "public, max-age=300" : "public, max-age=86400, immutable");
      }
      return new Response(request.method === "HEAD" ? null : obj.body, { headers });
    }
    if (CONTENT_RE.test(pathname)) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const key = pathname.slice(1);
      const obj = await env.DL.get(key);
      if (!obj) return new Response("Not found \u2014 run scripts/publish-payload.sh.", { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set("etag", obj.httpEtag);
      const isManifest = key === "content/manifest.json";
      headers.set("content-type", isManifest ? "application/json" : "application/gzip");
      headers.set("cache-control", isManifest ? "public, max-age=60" : "public, max-age=86400, immutable");
      return new Response(request.method === "HEAD" ? null : obj.body, { headers });
    }
    if (pathname === "/content/state.json" || pathname === "/content/subscribe") {
      const first = await contentState(env);
      if (pathname === "/content/state.json") {
        return new Response(JSON.stringify(first), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      const q = new URL(request.url).searchParams;
      const cv = parseInt(q.get("cv") || "0", 10) || 0;
      const av = q.get("av") || "";
      const moved = (s2) => (s2.payloadVersion || 0) > cv || !!s2.appVersion && s2.appVersion !== av;
      let s = first;
      const deadline = Date.now() + 2e4;
      while (!moved(s) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2e3));
        s = await contentState(env);
      }
      return new Response(JSON.stringify({ ...s, changed: moved(s) }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    if (pathname === "/") {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      const u = new URL(request.url);
      u.pathname = "/";
      return env.ASSETS.fetch(new Request(u, request));
    }
    return env.ASSETS.fetch(request);
  },
  // Keep the machine namespace anchored so absent hostnames return NXDOMAIN
  // instead of falling through to a product wildcard.
  async scheduled(event, env, ctx) {
    try {
      await ensureNamespaceAnchor(env);
    } catch (_) {
    }
  }
};
export {
  APP_VERSION,
  RESERVED_HANDLES,
  cookieHeader,
  worker_default as default,
  getSessionUser,
  handleAvailable,
  handleReserved,
  normalizeHandle,
  nowMs,
  parseCookies,
  readJson,
  sendViaMXroute,
  sha256Hex
};
