// HTTP routes: the public website, the booking API and the start of the staff/owner API.
const path = require("path");
const express = require("express");
const db = require("./db");
const booking = require("./booking");
const auth = require("./auth");

const PAYMENT_MODE = process.env.PAYMENT_MODE === "live" ? "live" : "preview";

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
  app.use(express.json({ limit: "50kb" }));
  app.use(h(auth.loadUser));

  const api = express.Router();

  api.get("/health", (req, res) => res.json({ ok: true, persistent_db: db.isPersistent(), payment_mode: PAYMENT_MODE }));

  // Public: room types, prices and peak periods for the website.
  api.get("/config", h(async (req, res) => {
    const types = await booking.getRoomTypes();
    const peaks = await booking.getPeakPeriods();
    res.json({
      payment_mode: PAYMENT_MODE,
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

  // Preview mode only: mark a booking as paid without taking money. Replaced by Paystack in step 3.
  api.post("/bookings/:ref/preview-pay", rateLimit({ windowMs: 10 * 60e3, max: 10 }), h(async (req, res) => {
    if (PAYMENT_MODE === "live") return res.status(404).json({ error: "Not found." });
    const ref = String(req.params.ref).toUpperCase();
    const b = await booking.getBooking(ref);
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!b || b.guest.email !== email) return res.status(404).json({ error: "Booking not found." });
    res.json(await booking.recordPayment(ref, { method: "preview", reference: "PREVIEW-" + ref }));
  }));

  // Staff and owner login.
  api.post("/auth/login", rateLimit({ windowMs: 15 * 60e3, max: 10 }), h(auth.login));
  api.post("/auth/logout", auth.logout);
  api.get("/auth/me", (req, res) => (req.user ? res.json({ user: req.user }) : res.status(401).json({ error: "Not logged in." })));

  // Staff/owner: bookings arriving on a date (defaults to today). Dashboards build on this in later steps.
  api.get("/admin/arrivals", auth.requireRole("owner", "manager", "staff"), h(async (req, res) => {
    const date = req.query.date || booking.todayLagos();
    const { rows } = await db.query(
      `SELECT b.ref, b.guest_name, b.guest_phone, b.beds_count, b.nights, b.amount, b.status, b.channel, t.name AS room_type
         FROM bookings b JOIN room_types t ON t.id = b.room_type_id
        WHERE b.checkin = $1 AND b.status IN ('confirmed','checked_in','pending')
        ORDER BY b.guest_name`,
      [date]
    );
    res.json({ date, arrivals: rows });
  }));

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
