// Front-desk API for staff, managers and the owner.
const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("./db");
const booking = require("./booking");
const { requireRole } = require("./auth");
const email = require("./email");

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ANY = requireRole("owner", "manager", "staff");
const MANAGERS = requireRole("owner", "manager");
const OWNER = requireRole("owner");

const ACTIVE = ["pending", "confirmed", "checked_in", "needs_attention"];
const PAY_METHODS = ["cash", "pos", "transfer"];

function rowToBooking(r) {
  return {
    ref: r.ref, status: r.status, channel: r.channel, room_type: r.room_type_name || r.room_type_id,
    checkin: db.toISODate(r.checkin), checkout: db.toISODate(r.checkout), nights: r.nights, beds: r.beds_count,
    amount: Number(r.amount), paid: Number(r.paid || 0),
    guest_name: r.guest_name, guest_phone: r.guest_phone, guest_email: r.guest_email, guest_gender: r.guest_gender,
  };
}

// Bookings with their room type name and total paid.
async function listBookings(where, params) {
  const { rows } = await db.query(
    `SELECT b.*, t.name AS room_type_name FROM bookings b JOIN room_types t ON t.id = b.room_type_id WHERE ${where} ORDER BY b.checkin, b.guest_name`,
    params
  );
  if (!rows.length) return [];
  const { rows: pays } = await db.query("SELECT booking_id, amount FROM payments WHERE status = 'success'");
  const paid = new Map();
  for (const p of pays) paid.set(p.booking_id, (paid.get(p.booking_id) || 0) + Number(p.amount));
  return rows.map((r) => rowToBooking({ ...r, paid: paid.get(r.id) || 0 }));
}

async function findBooking(ref) {
  const { rows } = await db.query("SELECT * FROM bookings WHERE ref = $1", [String(ref).toUpperCase()]);
  if (!rows[0]) throw new booking.BookingError("Booking not found.", 404, "not_found");
  return rows[0];
}

async function logEvent(bookingId, action, userId, note = null) {
  await db.query("INSERT INTO booking_events (booking_id, action, note, user_id) VALUES ($1,$2,$3,$4)", [bookingId, action, note, userId]);
}

async function setStatus(b, status, userId, note, { releaseFrom } = {}) {
  await db.query("UPDATE bookings SET status = $1, expires_at = NULL WHERE id = $2", [status, b.id]);
  if (releaseFrom) await db.query("DELETE FROM booking_nights WHERE booking_id = $1 AND night >= $2", [b.id, releaseFrom]);
  await logEvent(b.id, status, userId, note);
}

const router = express.Router();

// Today at a glance: arrivals, departures, guests in house, free beds tonight, my own sales.
router.get("/overview", ANY, h(async (req, res) => {
  await booking.releaseExpired();
  const today = booking.todayLagos();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "") ? req.query.date : today;
  const arrivals = await listBookings("b.checkin = $1 AND b.status IN ('pending','confirmed','checked_in','needs_attention','no_show')", [date]);
  const departures = await listBookings("b.checkout = $1 AND b.status IN ('confirmed','checked_in','checked_out')", [date]);
  const inHouse = await listBookings("b.status = 'checked_in'", []);

  const types = await booking.getRoomTypes();
  const tomorrow = new Date(date + "T00:00:00Z"); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const next = tomorrow.toISOString().slice(0, 10);
  const freeTonight = [];
  for (const t of types.filter((x) => !x.coming_soon)) {
    const all = await booking.freeBeds(db, t.id, date, next, { channel: "walk_in" });
    freeTonight.push({
      room_type_id: t.id, name: t.name,
      female: all.filter((b) => b.gender !== "male").length,
      male: all.filter((b) => b.gender !== "female").length,
      walk_in_reserve: all.filter((b) => !b.online).length,
    });
  }

  const { rows: mine } = await db.query(
    "SELECT COALESCE(SUM(amount),0)::int AS total, COUNT(*)::int AS n FROM payments WHERE recorded_by = $1 AND created_at >= $2",
    [req.user.id, today + "T00:00:00+01:00"]
  );
  res.json({ date, today, arrivals, departures, in_house: inHouse, free_tonight: freeTonight,
    my_day: { payments: Number(mine[0].n), collected: Number(mine[0].total) } });
}));

// Arrivals for the next N days (default 7), starting tomorrow.
router.get("/upcoming", ANY, h(async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 31);
  const today = booking.todayLagos();
  const start = new Date(today + "T00:00:00Z"); start.setUTCDate(start.getUTCDate() + 1);
  const end = new Date(start); end.setUTCDate(end.getUTCDate() + days);
  const list = await listBookings(
    "b.checkin >= $1 AND b.checkin < $2 AND b.status IN ('pending','confirmed','needs_attention')",
    [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)]
  );
  res.json({ from: start.toISOString().slice(0, 10), days, arrivals: list });
}));

// Bed-by-night board for the next N nights.
router.get("/board", ANY, h(async (req, res) => {
  await booking.releaseExpired();
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 14);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start || "") ? req.query.start : booking.todayLagos();
  const nights = [];
  for (let i = 0; i < days; i++) { const d = new Date(start + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + i); nights.push(d.toISOString().slice(0, 10)); }
  const end = (() => { const d = new Date(start + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); })();

  const { rows: beds } = await db.query(
    `SELECT b.id, b.label, b.online, r.id AS room_id, r.name AS room, r.gender, r.room_type_id
       FROM beds b JOIN rooms r ON r.id = b.room_id WHERE b.active = TRUE AND r.active = TRUE ORDER BY r.name, b.id`
  );
  const { rows: occ } = await db.query(
    `SELECT bn.bed_id, bn.night, bk.ref, bk.guest_name, bk.status
       FROM booking_nights bn JOIN bookings bk ON bk.id = bn.booking_id
      WHERE bn.night >= $1 AND bn.night < $2`,
    [start, end]
  );
  const byBed = new Map();
  for (const o of occ) {
    const k = Number(o.bed_id);
    if (!byBed.has(k)) byBed.set(k, {});
    byBed.get(k)[db.toISODate(o.night)] = { ref: o.ref, guest: o.guest_name, status: o.status };
  }
  const rooms = [];
  for (const b of beds) {
    let room = rooms.find((r) => r.id === b.room_id);
    if (!room) { room = { id: b.room_id, name: b.room, gender: b.gender, room_type_id: b.room_type_id, beds: [] }; rooms.push(room); }
    room.beds.push({ id: b.id, label: b.label, walk_in_reserve: !b.online, nights: nights.map((n) => (byBed.get(Number(b.id)) || {})[n] || null) });
  }
  res.json({ start, nights, rooms });
}));

// Search by reference, phone or name.
router.get("/bookings", ANY, h(async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json({ results: [] });
  const like = "%" + q.toLowerCase() + "%";
  const results = await listBookings(
    "(LOWER(b.ref) LIKE $1 OR LOWER(b.guest_name) LIKE $1 OR REPLACE(b.guest_phone,' ','') LIKE $2)",
    [like, "%" + q.replace(/\s/g, "") + "%"]
  );
  res.json({ results: results.slice(-50).reverse() });
}));

router.get("/bookings/:ref", ANY, h(async (req, res) => {
  const b = await booking.getBooking(String(req.params.ref).toUpperCase());
  if (!b) return res.status(404).json({ error: "Booking not found." });
  const raw = await findBooking(b.ref);
  const { rows: events } = await db.query(
    `SELECT e.action, e.note, e.created_at, u.name AS by FROM booking_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.booking_id = $1 ORDER BY e.created_at`,
    [raw.id]
  );
  res.json({ ...b, events });
}));

// Walk-in or phone booking. Can use walk-in reserve beds. Payment can be recorded at the same time.
router.post("/bookings", ANY, h(async (req, res) => {
  const result = await booking.createBooking(req.body || {}, { channel: "walk_in", userId: req.user.id });
  const raw = await findBooking(result.ref);
  await logEvent(raw.id, "created", req.user.id, "Walk-in / front desk booking");
  const pay = req.body && req.body.payment;
  if (pay && pay.method) {
    if (!PAY_METHODS.includes(pay.method)) throw new booking.BookingError("Payment method must be cash, POS or transfer.");
    await booking.confirmPayment(result.ref, { method: pay.method, reference: pay.reference ? String(pay.reference).slice(0, 80) : null, userId: req.user.id });
    await logEvent(raw.id, "payment", req.user.id, `${pay.method}${pay.reference ? " · " + pay.reference : ""}`);
  }
  const full = await booking.getBooking(result.ref);
  email.bookingConfirmation(full);
  res.status(201).json(full);
}));

// Record a front-desk payment (full amount) for an unpaid booking.
router.post("/bookings/:ref/payment", ANY, h(async (req, res) => {
  const b = await findBooking(req.params.ref);
  const method = String(req.body?.method || "");
  if (!PAY_METHODS.includes(method)) throw new booking.BookingError("Payment method must be cash, POS or transfer.");
  if (b.status !== "pending" && b.status !== "expired") throw new booking.BookingError("This booking is already paid or closed.", 409);
  const reference = req.body?.reference ? String(req.body.reference).slice(0, 80) : null;
  await booking.confirmPayment(b.ref, { method, reference, userId: req.user.id });
  await logEvent(b.id, "payment", req.user.id, `${method}${reference ? " · " + reference : ""}`);
  const full = await booking.getBooking(b.ref);
  email.paymentReceipt(full, { amount: full.amount, method, reference });
  res.json(full);
}));

router.post("/bookings/:ref/checkin", ANY, h(async (req, res) => {
  const b = await findBooking(req.params.ref);
  if (b.status !== "confirmed") throw new booking.BookingError(b.status === "pending" ? "Record payment before checking in." : "Only confirmed bookings can be checked in.", 409);
  const idType = String(req.body?.id_type || "").slice(0, 40);
  if (!idType) throw new booking.BookingError("Select the type of ID the guest showed.");
  await setStatus(b, "checked_in", req.user.id, `ID seen: ${idType}`);
  res.json(await booking.getBooking(b.ref));
}));

router.post("/bookings/:ref/checkout", ANY, h(async (req, res) => {
  const b = await findBooking(req.params.ref);
  if (b.status !== "checked_in") throw new booking.BookingError("Only guests who are checked in can be checked out.", 409);
  // An early departure frees the remaining nights.
  const tomorrow = new Date(booking.todayLagos() + "T00:00:00Z"); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  await setStatus(b, "checked_out", req.user.id, null, { releaseFrom: booking.todayLagos() < db.toISODate(b.checkout) ? tomorrow.toISOString().slice(0, 10) : null });
  res.json(await booking.getBooking(b.ref));
}));

router.post("/bookings/:ref/no-show", ANY, h(async (req, res) => {
  const b = await findBooking(req.params.ref);
  if (!["pending", "confirmed"].includes(b.status)) throw new booking.BookingError("Only expected arrivals can be marked as no-show.", 409);
  if (db.toISODate(b.checkin) > booking.todayLagos()) throw new booking.BookingError("You can only mark a no-show on or after the arrival date.", 409);
  await setStatus(b, "no_show", req.user.id, String(req.body?.note || "").slice(0, 300) || null, { releaseFrom: booking.todayLagos() });
  res.json(await booking.getBooking(b.ref));
}));

router.post("/bookings/:ref/cancel", MANAGERS, h(async (req, res) => {
  const b = await findBooking(req.params.ref);
  if (!["pending", "confirmed", "needs_attention"].includes(b.status)) throw new booking.BookingError("This booking can't be cancelled.", 409);
  await setStatus(b, "cancelled", req.user.id, String(req.body?.reason || "").slice(0, 300) || null, { releaseFrom: "1900-01-01" });
  res.json(await booking.getBooking(b.ref));
}));

// Team accounts (owner only, until the owner dashboard is built).
router.get("/team", OWNER, h(async (req, res) => {
  const { rows } = await db.query("SELECT id, name, email, role, active, created_at FROM users ORDER BY role, name");
  res.json({ users: rows });
}));

router.post("/team", OWNER, h(async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 100);
  const email = String(req.body?.email || "").trim().toLowerCase().slice(0, 160);
  const role = String(req.body?.role || "staff");
  const password = String(req.body?.password || "");
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new booking.BookingError("Enter a name and a valid email.");
  if (!["staff", "manager"].includes(role)) throw new booking.BookingError("Role must be staff or manager.");
  if (password.length < 8) throw new booking.BookingError("Temporary password must be at least 8 characters.");
  const exists = await db.query("SELECT id FROM users WHERE email = $1", [email]);
  if (exists.rows.length) throw new booking.BookingError("Someone already uses that email.", 409);
  await db.query("INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,$4)", [name, email, await bcrypt.hash(password, 10), role]);
  res.status(201).json({ ok: true });
}));

router.post("/team/:id/password", OWNER, h(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const password = String(req.body?.password || "");
  if (password.length < 8) throw new booking.BookingError("Temporary password must be at least 8 characters.");
  const r = await db.query("UPDATE users SET password_hash = $2 WHERE id = $1 AND role <> 'owner' RETURNING id", [id, await bcrypt.hash(password, 10)]);
  if (!r.rows.length) throw new booking.BookingError("Team member not found.", 404);
  res.json({ ok: true });
}));

router.post("/team/:id/active", OWNER, h(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) throw new booking.BookingError("You can't deactivate your own account.");
  await db.query("UPDATE users SET active = $1 WHERE id = $2 AND role <> 'owner'", [!!req.body?.active, id]);
  res.json({ ok: true });
}));

module.exports = router;
