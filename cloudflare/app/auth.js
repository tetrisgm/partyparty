// Sign in with Apple and with Google, for DJs and for the members who want an
// account. Members are never required to have one - everything they can do
// works from a token in an email - so this exists to make a DJ's identity
// portable between the Mac and the web, and to let a regular guest keep one
// name across several groups.
//
// Both providers are OpenID Connect, so the shape is the same: bounce to them,
// take back a code, trade the code for an id_token, and verify that token
// against the provider's published keys. The differences are small and both
// are handled here rather than smeared through the router.

const JWKS_TTL_MS = 60 * 60 * 1000;
const jwksCache = new Map();

function b64urlToBytes(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToB64url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeSegment(segment) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(segment)));
}

// Apple wants its client secret as a short-lived ES256 JWT signed with the .p8
// they issue once. Google just wants the string. The asymmetry is Apple's, not
// ours, and it lives here so the caller never has to know.
export async function appleClientSecret(env, now) {
  const pem = String(env.APPLE_SIWA_KEY || "").trim();
  if (!pem || !env.APPLE_KEY_ID || !env.APPLE_TEAM_ID || !env.APPLE_CLIENT_ID) return "";
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8", b64urlToBytes(body.replace(/\+/g, "-").replace(/\//g, "_")),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
  const header = bytesToB64url(new TextEncoder().encode(JSON.stringify({
    alg: "ES256", kid: env.APPLE_KEY_ID,
  })));
  const claims = bytesToB64url(new TextEncoder().encode(JSON.stringify({
    iss: env.APPLE_TEAM_ID,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 600,
    aud: "https://appleid.apple.com",
    sub: env.APPLE_CLIENT_ID,
  })));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${claims}`)
  );
  return `${header}.${claims}.${bytesToB64url(signature)}`;
}

async function fetchKeys(provider, url, now, fetchImpl) {
  const response = await (fetchImpl || fetch)(url);
  if (!response.ok) throw new Error(`${provider}: keys unavailable`);
  const body = await response.json();
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(provider, { keys, until: now + JWKS_TTL_MS });
  return keys;
}

// Cached, but never so hard that a key rotation locks everyone out. Providers
// rotate signing keys whenever they like, and a cache that only expires on a
// timer would reject every valid sign-in until it did - an hour of "that did
// not complete" with nothing wrong on our side. An unknown key id is the signal
// to look again.
async function keyFor(kid, provider, url, now, fetchImpl) {
  const cached = jwksCache.get(provider);
  if (cached && cached.until > now) {
    const hit = cached.keys.find((k) => k.kid === kid);
    if (hit) return hit;
  }
  const keys = await fetchKeys(provider, url, now, fetchImpl);
  return keys.find((k) => k.kid === kid) || null;
}

// Verify the signature, the issuer, the audience and the clock. An id_token
// that is merely well-formed proves nothing: without the signature check
// anybody could mint one claiming any email address they liked.
export async function verifyIdToken(token, { issuers, audience, jwksUrl, provider, now, fetchImpl }) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("id_token malformed");
  const header = decodeSegment(parts[0]);
  const claims = decodeSegment(parts[1]);
  if (header.alg !== "RS256") throw new Error("unexpected id_token algorithm");

  const jwk = await keyFor(header.kid, provider, jwksUrl, now, fetchImpl);
  if (!jwk) throw new Error("id_token signed by an unknown key");
  const key = await crypto.subtle.importKey(
    "jwk", { ...jwk, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!ok) throw new Error("id_token signature does not verify");

  if (!issuers.includes(String(claims.iss || ""))) throw new Error("id_token from the wrong issuer");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) throw new Error("id_token for a different app");
  const seconds = Math.floor(now / 1000);
  if (Number(claims.exp || 0) <= seconds) throw new Error("id_token expired");
  if (Number(claims.iat || 0) > seconds + 300) throw new Error("id_token issued in the future");
  return claims;
}

export const PROVIDERS = {
  apple: {
    authorize: "https://appleid.apple.com/auth/authorize",
    tokenUrl: "https://appleid.apple.com/auth/token",
    jwksUrl: "https://appleid.apple.com/auth/keys",
    issuers: ["https://appleid.apple.com"],
    scope: "name email",
    // Apple posts the result back as a form, which means the browser arrives
    // cross-site: the state cookie has to be SameSite=None or it is not sent
    // and every sign-in fails with "state mismatch".
    formPost: true,
  },
  google: {
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    scope: "openid email profile",
    formPost: false,
  },
};

export function clientIdFor(env, provider) {
  return String(provider === "apple" ? (env.APPLE_CLIENT_ID || "") : (env.GOOGLE_CLIENT_ID || ""));
}

export function configured(env, provider) {
  if (provider === "apple") {
    return !!(env.APPLE_CLIENT_ID && env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_SIWA_KEY);
  }
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

// The state value is signed rather than stored: it has to survive a redirect
// through a provider, and a row in the database for every abandoned sign-in
// attempt is a table that only ever grows.
export async function signState(env, payload) {
  const body = bytesToB64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(String(env.STATE_SECRET || "dev-state-secret")),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${bytesToB64url(mac)}`;
}

export async function readState(env, value, now) {
  const [body, mac] = String(value || "").split(".");
  if (!body || !mac) return null;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(String(env.STATE_SECRET || "dev-state-secret")),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const ok = await crypto.subtle.verify("HMAC", key, b64urlToBytes(mac), new TextEncoder().encode(body));
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
    if (Number(payload.exp || 0) < now) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

export function authorizeURL(env, provider, { redirectUri, state, nonce }) {
  const spec = PROVIDERS[provider];
  const url = new URL(spec.authorize);
  url.searchParams.set("client_id", clientIdFor(env, provider));
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", spec.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  if (spec.formPost) url.searchParams.set("response_mode", "form_post");
  return url.toString();
}

export async function exchangeCode(env, provider, { code, redirectUri, now, fetchImpl }) {
  const spec = PROVIDERS[provider];
  const secret = provider === "apple"
    ? await appleClientSecret(env, now)
    : String(env.GOOGLE_CLIENT_SECRET || "");
  const body = new URLSearchParams({
    client_id: clientIdFor(env, provider),
    client_secret: secret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  const response = await (fetchImpl || fetch)(spec.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) throw new Error(`${provider}: code exchange refused`);
  const payload = await response.json();
  if (!payload.id_token) throw new Error(`${provider}: no id_token returned`);
  return verifyIdToken(payload.id_token, {
    issuers: spec.issuers,
    audience: clientIdFor(env, provider),
    jwksUrl: spec.jwksUrl,
    provider,
    now,
    fetchImpl,
  });
}

// Apple sends the name once, on the very first authorization, in a separate
// form field - never in the id_token and never again. Miss it and the DJ is
// nameless forever, which is why it is read here rather than assumed.
export function appleNameFrom(form) {
  try {
    const raw = form && form.get("user");
    if (!raw) return "";
    const parsed = JSON.parse(String(raw));
    const name = parsed && parsed.name;
    return [name && name.firstName, name && name.lastName].filter(Boolean).join(" ").slice(0, 60);
  } catch (e) {
    return "";
  }
}
