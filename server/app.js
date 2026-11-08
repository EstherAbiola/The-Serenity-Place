// HTTP routes: the public website, the booking API and the start of the staff/owner API.
const path = require("path");
const express = require("express");
const db = require("./db");
const booking = require("./booking");
const auth = require("./auth");
const email = require("./email");
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
  // Small JSON bodies everywhere, except expenses which may carry a receipt photo.
  const smallJson = express.json({ limit: "50kb" });
  const receiptJson = express.json({ limit: "2mb" });
  const cvJson = express.json({ limit: "4mb" });
  app.use((req, res, next) => {
    if (req.path.startsWith("/api/careers/apply")) return cvJson(req, res, next);
    if (req.path.startsWith("/api/expenses") || req.path.startsWith("/api/team/payroll")) return receiptJson(req, res, next);
    return smallJson(req, res, next);
  });
  app.use(h(auth.loadUser));

  // Until the database is connected, API calls get a clear "try again shortly" answer.
  app.use("/api", (req, res, next) => {
    if (db.isReady() || req.path === "/health") return next();
    res.status(503).json({ error: "Online booking is temporarily unavailable. Please try again in a few minutes or contact us.", code: "db_unavailable" });
  });

  const api = express.Router();

  api.get("/health", (req, res) => res.status(db.isReady() ? 200 : 503).json({ ok: db.isReady(), db_connected: db.isReady(), persistent_db: db.isPersistent(), payment_mode: "pay_on_arrival" }));

  // Public: room types, prices and peak periods for the website.
  api.get("/config", h(async (req, res) => {
    const types = await booking.getRoomTypes();
    const peaks = await booking.getPeakPeriods();
    res.json({
      payment_mode: "pay_on_arrival",
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
    email.bookingConfirmation(await booking.getBooking(result.ref));
    res.status(201).json(result);
  }));

  // Look up a booking: the guest must know both the reference and their email.
  api.get("/bookings/:ref", rateLimit({ windowMs: 60e3, max: 20 }), h(async (req, res) => {
    const b = await booking.getBooking(String(req.params.ref).toUpperCase());
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!b || !b.guest.email || b.guest.email !== email) return res.status(404).json({ error: "Booking not found." });
    res.json(b);
  }));

  // Staff and owner login.
  api.post("/auth/login", rateLimit({ windowMs: 15 * 60e3, max: 10 }), h(auth.login));
  api.post("/auth/logout", auth.logout);
  api.post("/auth/password", auth.requireRole(), h(auth.changePassword));
  api.get("/auth/setup", h(auth.setupStatus));
  api.post("/auth/setup", rateLimit({ windowMs: 15 * 60e3, max: 10 }), h(auth.setupOwner));
  api.get("/auth/me", (req, res) => (req.user ? res.json({ user: req.user }) : res.status(401).json({ error: "Not logged in." })));

  // Front desk, managers and owner.
  api.use("/staff", require("./staff"));
  api.use("/owner", require("./owner"));
  api.use("/expenses", require("./expenses"));
  api.use("/team", require("./team"));
  api.use("/careers", require("./careers"));

  api.use((req, res) => res.status(404).json({ error: "Not found." }));
  app.use("/api", api);

  // "/staff/" and "/careers/" (with a trailing slash) go to the same page as "/staff" and "/careers".
  app.use((req, res, next) => {
    if (req.method === "GET" && req.path.length > 1 && req.path.endsWith("/") && !req.path.startsWith("/api/")) {
      const q = req.originalUrl.slice(req.path.length);
      return res.redirect(301, req.path.replace(/\/+$/, "") + q);
    }
    next();
  });

  // Website files.
  const pub = path.join(__dirname, "..", "public");
  // Pages are always re-checked so updates show straight away; images can be cached for a day.
  const noCache = (res) => res.setHeader("Cache-Control", "no-cache");
  app.use(express.static(pub, {
    extensions: ["html"],
    setHeaders: (res, file) => (file.endsWith(".html") ? noCache(res) : res.setHeader("Cache-Control", "public, max-age=86400")),
  }));
  app.get("*", (req, res) => { noCache(res); res.sendFile(path.join(pub, "index.html")); });

  // Errors.
  app.use((err, req, res, next) => {
    if (err instanceof booking.BookingError) return res.status(err.status).json({ error: err.message, code: err.code });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid request." });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "That upload is too large. Please use a smaller photo." });
    console.error(err);
    res.status(500).json({ error: "Something went wrong on our side. Please try again." });
  });

  return app;
}

module.exports = { createApp };
