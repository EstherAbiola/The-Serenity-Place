// Paystack: start a payment, verify it, and check webhook signatures.
// Switched on by setting PAYSTACK_SECRET_KEY (sk_test_... while testing, sk_live_... for real money).
const crypto = require("crypto");

const API_BASE = process.env.PAYSTACK_API_BASE || "https://api.paystack.co";
const SECRET = process.env.PAYSTACK_SECRET_KEY || "";

function enabled() {
  return Boolean(SECRET);
}

function isTestKey() {
  return SECRET.startsWith("sk_test_");
}

async function call(method, path, body) {
  const res = await fetch(API_BASE + path, {
    method,
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok || data.status === false) {
    const msg = data.message || `Paystack error (${res.status})`;
    const err = new Error(msg);
    err.paystack = true;
    throw err;
  }
  return data.data;
}

// Create a Paystack checkout for a booking. Amount is in naira; Paystack takes kobo.
async function initialize({ email, amountNaira, bookingRef, callbackUrl }) {
  const reference = `${bookingRef}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  const data = await call("POST", "/transaction/initialize", {
    email,
    amount: Math.round(amountNaira * 100),
    currency: "NGN",
    reference,
    callback_url: callbackUrl,
    channels: ["card", "bank", "ussd", "bank_transfer"],
    metadata: { booking_ref: bookingRef },
  });
  return { authorization_url: data.authorization_url, reference };
}

async function verify(reference) {
  return call("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
}

// Webhooks are signed with HMAC-SHA512 of the raw body using the secret key.
function validSignature(rawBody, signature) {
  if (!SECRET || !signature || !rawBody) return false;
  const expected = crypto.createHmac("sha512", SECRET).update(rawBody).digest("hex");
  return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// Booking ref from a Paystack transaction (metadata first, then the reference prefix).
function bookingRefOf(tx) {
  const meta = typeof tx.metadata === "string" ? (() => { try { return JSON.parse(tx.metadata); } catch { return {}; } })() : tx.metadata || {};
  if (meta.booking_ref) return String(meta.booking_ref);
  const m = /^(SP-[A-Z0-9]{6})-/.exec(tx.reference || "");
  return m ? m[1] : null;
}

module.exports = { enabled, isTestKey, initialize, verify, validSignature, bookingRefOf };
