// Stripe, arranged so the money is the DJ's and never ours.
//
// Connect STANDARD, not Express: the connected account is the merchant, holds
// its own balance, and owns its own disputes and refunds. We are the page. That
// is the whole posture - no platform balance, no payouts to schedule, no
// merchant-of-record exposure, and nothing to hold when a DJ stops using us.
//
// We take an application fee on tickets, and nothing at all on tips.

const API = "https://api.stripe.com/v1";

function form(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    body.set(key, String(value));
  }
  return body;
}

async function call(env, path, params, { account, fetchImpl } = {}) {
  const key = String(env.STRIPE_SECRET_KEY || "");
  if (!key) throw new Error("stripe is not configured");
  const headers = {
    authorization: `Bearer ${key}`,
    "content-type": "application/x-www-form-urlencoded",
  };
  // Acting AS the connected account, rather than on its behalf from ours, is
  // what keeps the charge, the balance and the dispute with the DJ.
  if (account) headers["stripe-account"] = account;
  const response = await (fetchImpl || fetch)(`${API}${path}`, {
    method: "POST",
    headers,
    body: form(params).toString(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`stripe: ${(payload.error && payload.error.message) || response.status}`);
  }
  return payload;
}

export function stripeConfigured(env) {
  return !!env.STRIPE_SECRET_KEY;
}

// The onboarding link a DJ follows once, when they want to be paid. Stripe
// collects the identity details; we never see them.
export async function accountLink(env, { account, refreshUrl, returnUrl, fetchImpl }) {
  let id = account;
  if (!id) {
    const created = await call(env, "/accounts", { type: "standard" }, { fetchImpl });
    id = created.id;
  }
  const link = await call(env, "/account_links", {
    account: id,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: "account_onboarding",
  }, { fetchImpl });
  return { account: id, url: link.url };
}

// One checkout, created on the DJ's own account. The buyer pays the face value
// plus our fee plus processing, shown as a single number - the DJ receives
// exactly what they priced.
export async function checkout(env, {
  account, amountCents, feeCents, currency, name, successUrl, cancelUrl, metadata, fetchImpl,
}) {
  const params = {
    mode: "payment",
    success_url: successUrl,
    cancel_url: cancelUrl,
    "line_items[0][quantity]": 1,
    "line_items[0][price_data][currency]": currency || "usd",
    "line_items[0][price_data][unit_amount]": Math.round(amountCents),
    "line_items[0][price_data][product_data][name]": name,
  };
  if (feeCents > 0) params["payment_intent_data[application_fee_amount]"] = Math.round(feeCents);
  for (const [key, value] of Object.entries(metadata || {})) params[`metadata[${key}]`] = value;
  const session = await call(env, "/checkout/sessions", params, { account, fetchImpl });
  return { id: session.id, url: session.url };
}

// What the buyer pays for a ticket priced at `faceCents`. Our cut and the
// processing fee are added on top and shown as one number, the way Posh and
// DICE do it, so the DJ receives the number they typed.
//
// The processing fee has to be grossed up, not simply added: Stripe takes its
// percentage of the FINAL total, so adding it first leaves you short.
export function totalForBuyer(faceCents, takeRate, { percent = 0.029, fixed = 30 } = {}) {
  const ours = Math.round(faceCents * takeRate);
  const total = Math.ceil((faceCents + ours + fixed) / (1 - percent));
  return { total, ours, processing: total - faceCents - ours };
}

// Stripe signs every webhook, and an unverified one is just a POST from
// anybody claiming a ticket was paid for.
export async function verifyWebhook(secret, signatureHeader, payload, nowMs, toleranceMs = 5 * 60 * 1000) {
  const parts = {};
  for (const piece of String(signatureHeader || "").split(",")) {
    const [key, value] = piece.split("=");
    if (key === "v1") (parts.v1 = parts.v1 || []).push(value);
    else if (key) parts[key] = value;
  }
  if (!parts.t || !parts.v1 || !secret) return false;
  const timestamp = Number(parts.t) * 1000;
  if (!Number.isFinite(timestamp)) return false;
  // A replayed webhook from last week is not news.
  if (Math.abs(nowMs - timestamp) > toleranceMs) return false;

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${parts.t}.${payload}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  // Constant time, so a wrong answer never leaks how wrong it was.
  return parts.v1.some((candidate) => {
    if (!candidate || candidate.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ candidate.charCodeAt(i);
    return diff === 0;
  });
}
