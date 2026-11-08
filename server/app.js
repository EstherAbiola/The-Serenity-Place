// HTTP routes: the public website, the booking API and the start of the staff/owner API.
const path = require("path");
const express = require("express");
const db = require("./db");
const booking = require("./booking");
const auth = require("./auth");
const paystack = require("./paystack");

const PAYMENT_MODE = paystack.enabled() ? "paystack" : "preview";

// Confirm a booking from a verified Paystack transaction, after checking the amount and currency.
async function applyPaystackSuccess(tx) {
  if (!tx || tx.status !== "success") return { ok: false, reason: "not_successful" };
  const ref = paystack.bookingRefOf(tx);
  const b = ref && (await booking.getBooking(ref));
  if (!b) return { ok: false, reason: "unknown_booking" };
  if (tx.currency !== "NGN" || Number(tx.amount) !== b.amount * 100) {
    console.error(`[paystack] Amount mismatch for ${ref}: paid ${tx.amount} ${tx.currency}, expected ${b.amount * 100} NGN`);
    return { ok: false, reason: "amount_mismatch", ref };
  }
  const updated = await booking.confirmPayment(ref, { method: "paystack", reference: tx.reference, amount: Number(tx.amount) / 100 });
  return { ok: true, ref, booking: updated };
}

// Wrap async handlers so errors reach the error handler.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Very small in-memory rate limiter (per IP, per route group).
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(key, list);
    if (list.length > max) return res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
    next();
  };
}

function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    next();
  });
  // Paystack webhook needs the raw body to check its signature, so it comes before the JSON parser.
  app.post("/api/paystack/webhook", express.raw({ type: "*/*", limit: "200kb" }), h(async (req, res) => {
    if (!db.isReady()) return res.status(503).end(); // Paystack will retry
    if (!paystack.validSignature(req.body, req.get("x-paystack-signature"))) return res.status(401).end();
    let event = {};
    try { event = JSON.parse(req.body.toString("utf8")); } catch { return res.status(400).end(); }
    if (event.event === "charge.success") {
      const result = await applyPaystackSuccess(event.data);
      if (!result.ok) console.warn("[paystack] webhook not applied:", result.reason, event.data && event.data.reference);
    }
    res.status(200).end();
  }));

  // Guest returns here from the Paystack payment page.
  app.get("/pay/callback", h(async (req, res) => {
    const reference = String(req.query.reference || req.query.trxref || "");
    if (!paystack.enabled() || !reference) return res.redirect("/#book");
    if (!db.isReady()) return res.redirect("/?payfail=1#book");
    let result = { ok: false };
    try {
      result = await applyPaystackSuccess(await paystack.verify(reference));
    } catch (e) {
      console.error("[paystack] verify failed:", e.message);
    }
    if (result.ok) return res.redirect(`/?paid=${encodeURIComponent(result.ref)}&t=${auth.signRef(result.ref)}#book`);
    res.redirect("/?payfail=1#book");
  }));

  app.use(express.json({ limit: "50kb" }));
  app.use(h(auth.loadUser));

  // Until the database is connected, API calls get a clear "try again shortly" answer.
  app.use("/api", (req, res, next) => {
    if (db.isReady() || req.path === "/health") return next();
    res.status(503).json({ error: "Online booking is temporarily unavailable. Please try again in a few minutes or contact us.", code: "db_unavailable" });
  });

  const api = express.Router();

  api.get("/health", (req, res) => res.status(db.isReady() ? 200 : 503).json({ ok: db.isReady(), db_connected: db.isReady(), persistent_db: db.isPersistent(), payment_mode: PAYMENT_MODE }));

  // Public: room types, prices and peak periods for the website.
  api.get("/config", h(async (req, res) => {
    const types = await booking.getRoomTypes();
    const peaks = await booking.getPeakPeriods();
    res.json({
      payment_mode: PAYMENT_MODE,
      payment_test: paystack.enabled() && paystack.isTestKey(),
      hold_minutes: booking.HOLD_MINUTES,
      today: booking.todayLagos(),
      room_types: types.map((t) => ({
        id: t.id, name: t.name, description: t.description, unit: t.unit, base_price: Number(t.base_price),
        capacity_label: t.capacity_label, tag: t.tag, coming_soon: t.coming_soon,
      })),
      peak_periods: peaks,
    });
  }));

  api.get("/availability", rateLimit({ windowMs: 60e3, max: 60 }), h(async (req, res) => {
    const { checkin, checkout, gender } = req.query;
    res.json(await booking.availability({ checkin, checkout, gender: gender || undefined }));
  }));

  api.post("/bookings", rateLimit({ windowMs: 10 * 60e3, max: 10 }), h(async (req, res) => {
    const result = await booking.createBooking(req.body || {}, { channel: "online" });
    res.status(201).json(result);
  }));

  // Look up a booking: the guest must know both the reference and their email.
  api.get("/bookings/:ref", rateLimit({ windowMs: 60e3, max: 20 }), h(async (req, res) => {
    const b = await booking.getBooking(String(req.params.ref).toUpperCase());
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!b || !b.guest.email || b.guest.email !== email) return res.status(404).json({ error: "Booking not found." });
    res.json(b);
  }));

  // Start payment: returns the Paystack page to send the guest to.
  api.post("/bookings/:ref/pay", rateLimit({ windowMs: 10 * 60e3, max: 10 }), h(async (req, res) => {
    if (!paystack.enabled()) return res.status(404).json({ error: "Online payment is not switched on yet." });
    const ref = String(req.params.ref).toUpperCase();
    const b = await booking.getBooking(ref);
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!b || b.guest.email !== email) return res.status(404).json({ error: "Booking not found." });
    if (b.status !== "pending") return res.status(409).json({ error: b.status === "expired" ? "This booking's hold expired. Please book again." : "This booking is already paid." });
    await booking.extendHold(ref);
    const callbackUrl = `${process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`}/pay/callback`;
    try {
      const out = await paystack.initialize({ email, amountNaira: b.amount, bookingRef: ref, callbackUrl });
      res.json({ authorization_url: out.authorization_url });
    } catch (e) {
      console.error("[paystack] initialize failed:", e.message);
      res.status(502).json({ error: "We couldn't open the payment page. Please try again in a moment." });
    }
  }));

  // Receipt after returning from Paystack (signed link, no email needed).
  api.get("/bookings/:ref/receipt", h(async (req, res) => {
    const ref = String(req.params.ref).toUpperCase();
    if (!auth.checkRef(ref, String(req.query.t || ""))) return res.status(404).json({ error: "Booking not found." });
    const b = await booking.getBooking(ref);
    if (!b) return res.status(404).json({ error: "Booking not found." });
    res.json(b);
  }));

  // Preview mode only (no Paystack key): mark a booking as paid without taking money.
  api.post("/bookings/:ref/preview-pay", rateLimit({ windowMs: 10 * 60e3, max: 10 }), h(async (req, res) => {
    if (paystack.enabled()) return res.status(404).json({ error: "Not found." });
    const ref = String(req.params.ref).toUpperCase();
    const b = await booking.getBooking(ref);
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!b || b.guest.email !== email) return res.status(404).json({ error: "Booking not found." });
    res.json(await booking.confirmPayment(ref, { method: "preview", reference: "PREVIEW-" + ref }));
  }));

  // Staff and owner login.
  api.post("/auth/login", rateLimit({ windowMs: 15 * 60e3, max: 10 }), h(auth.login));
  api.post("/auth/logout", auth.logout);
  api.get("/auth/me", (req, res) => (req.user ? res.json({ user: req.user }) : res.status(401).json({ error: "Not logged in." })));

  // Front desk, managers and owner.
  api.use("/staff", require("./staff"));

  api.use((req, res) => res.status(404).json({ error: "Not found." }));
  app.use("/api", api);

  // Website files.
  const pub = path.join(__dirname, "..", "public");
  app.use(express.static(pub, { extensions: ["html"], maxAge: "1h" }));
  app.get("*", (req, res) => res.sendFile(path.join(pub, "index.html")));

  // Errors.
  app.use((err, req, res, next) => {
    if (err instanceof booking.BookingError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid request." });
    console.error(err);
    res.status(500).json({ error: "Something went wrong on our side. Please try again." });
  });

  return app;
}

module.exports = { createApp };
