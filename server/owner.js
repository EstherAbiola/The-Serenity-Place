// Owner dashboard and settings.
const express = require("express");
const db = require("./db");
const { requireRole } = require("./auth");
const { h, isDate, addDays, dateRange, lagosStart, csv, sendCsv, getSetting, setSetting, toInt, text, BookingError } = require("./util");

const OWNER = requireRole("owner");
const router = express.Router();

const GENDERS = ["female", "male", "mixed"];

/* ------------------------------------------------------------------ dashboard */

async function paymentsInRange(from, to) {
  const { rows } = await db.query(
    `SELECT p.amount, p.method, p.reference, p.created_at, b.ref, b.guest_name, b.channel, u.name AS recorded_by
       FROM payments p JOIN bookings b ON b.id = p.booking_id LEFT JOIN users u ON u.id = p.recorded_by
      WHERE p.status = 'success' AND p.created_at >= $1 AND p.created_at < $2
      ORDER BY p.created_at`,
    [lagosStart(from), lagosStart(addDays(to, 1))]
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount) }));
}

async function bedCapacity() {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM beds b JOIN rooms r ON r.id = b.room_id JOIN room_types t ON t.id = r.room_type_id
      WHERE b.active = TRUE AND r.active = TRUE AND t.coming_soon = FALSE`
  );
  return Number(rows[0].n);
}

router.get("/summary", OWNER, h(async (req, res) => {
  const { from, to, days } = dateRange(req.query);

  const payments = await paymentsInRange(from, to);
  const byMethod = {}, byChannel = {}, byDay = {};
  for (const p of payments) {
    byMethod[p.method] = (byMethod[p.method] || 0) + p.amount;
    byChannel[p.channel] = (byChannel[p.channel] || 0) + p.amount;
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date(p.created_at));
    byDay[day] = (byDay[day] || 0) + p.amount;
  }

  const { rows: bk } = await db.query(
    "SELECT status, channel, beds_count, nights FROM bookings WHERE created_at >= $1 AND created_at < $2",
    [lagosStart(from), lagosStart(addDays(to, 1))]
  );
  const byStatus = {};
  for (const b of bk) byStatus[b.status] = (byStatus[b.status] || 0) + 1;

  const capacity = await bedCapacity();
  const { rows: sold } = await db.query(
    "SELECT night, COUNT(*)::int AS n FROM booking_nights WHERE night >= $1 AND night <= $2 GROUP BY night",
    [from, to]
  );
  const soldBy = Object.fromEntries(sold.map((r) => [db.toISODate(r.night), Number(r.n)]));
  const nights = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(from, i);
    nights.push({ date: d, sold: soldBy[d] || 0, capacity, money_in: byDay[d] || 0 });
  }
  const soldTotal = nights.reduce((s, n) => s + n.sold, 0);

  const { rows: ex } = await db.query(
    "SELECT category, amount, status FROM expenses WHERE spent_on >= $1 AND spent_on <= $2",
    [from, to]
  );
  const expensesByCat = {};
  let expensesTotal = 0, pendingExpenses = 0;
  for (const e of ex) {
    if (e.status === "approved") { expensesTotal += Number(e.amount); expensesByCat[e.category] = (expensesByCat[e.category] || 0) + Number(e.amount); }
    if (e.status === "pending") pendingExpenses++;
  }

  const moneyIn = payments.reduce((s, p) => s + p.amount, 0);
  res.json({
    from, to, days,
    money_in: moneyIn, payments_count: payments.length, by_method: byMethod, by_channel: byChannel,
    bookings_created: bk.length, by_status: byStatus,
    beds: capacity, bed_nights_sold: soldTotal, bed_nights_available: capacity * days,
    occupancy: capacity ? soldTotal / (capacity * days) : 0,
    nights,
    expenses: expensesTotal, expenses_by_category: expensesByCat, pending_expenses: pendingExpenses,
    net: moneyIn - expensesTotal,
  });
}));

// Bookings whose stay starts in the period.
async function bookingsInRange(from, to, status) {
  const params = [from, to];
  let where = "b.checkin >= $1 AND b.checkin <= $2";
  if (status) { params.push(status); where += " AND b.status = $3"; }
  const { rows } = await db.query(
    `SELECT b.*, t.name AS room_type_name, u.name AS created_by_name
       FROM bookings b JOIN room_types t ON t.id = b.room_type_id LEFT JOIN users u ON u.id = b.created_by
      WHERE ${where} ORDER BY b.checkin, b.guest_name`,
    params
  );
  const { rows: pays } = await db.query("SELECT booking_id, amount FROM payments WHERE status = 'success'");
  const paid = new Map();
  for (const p of pays) paid.set(p.booking_id, (paid.get(p.booking_id) || 0) + Number(p.amount));
  return rows.map((r) => ({
    ref: r.ref, status: r.status, channel: r.channel, room_type: r.room_type_name,
    checkin: db.toISODate(r.checkin), checkout: db.toISODate(r.checkout), nights: r.nights, beds: r.beds_count,
    amount: Number(r.amount), paid: paid.get(r.id) || 0,
    guest_name: r.guest_name, guest_phone: r.guest_phone, guest_email: r.guest_email, guest_gender: r.guest_gender,
    purpose: r.purpose, created_by: r.created_by_name, created_at: r.created_at,
  }));
}

router.get("/bookings", OWNER, h(async (req, res) => {
  const { from, to } = dateRange(req.query);
  const status = text(req.query.status, 20) || null;
  res.json({ from, to, bookings: await bookingsInRange(from, to, status) });
}));

router.get("/export/bookings.csv", OWNER, h(async (req, res) => {
  const { from, to } = dateRange(req.query);
  const list = await bookingsInRange(from, to);
  sendCsv(res, `bookings_${from}_to_${to}.csv`, csv(list, [
    { label: "Reference", get: "ref" }, { label: "Status", get: "status" }, { label: "Booked via", get: (r) => (r.channel === "walk_in" ? "Front desk" : "Online") },
    { label: "Guest", get: "guest_name" }, { label: "Phone", get: "guest_phone" }, { label: "Email", get: "guest_email" }, { label: "Dorm", get: "guest_gender" },
    { label: "Room type", get: "room_type" }, { label: "Beds", get: "beds" }, { label: "Check-in", get: "checkin" }, { label: "Check-out", get: "checkout" },
    { label: "Nights", get: "nights" }, { label: "Amount (NGN)", get: "amount" }, { label: "Paid (NGN)", get: "paid" }, { label: "Purpose", get: "purpose" },
    { label: "Created by", get: (r) => r.created_by || "Website" },
  ]));
}));

router.get("/export/payments.csv", OWNER, h(async (req, res) => {
  const { from, to } = dateRange(req.query);
  const list = await paymentsInRange(from, to);
  sendCsv(res, `payments_${from}_to_${to}.csv`, csv(list, [
    { label: "Date", get: (r) => new Date(r.created_at).toLocaleString("en-GB", { timeZone: "Africa/Lagos" }) },
    { label: "Booking", get: "ref" }, { label: "Guest", get: "guest_name" }, { label: "Amount (NGN)", get: "amount" },
    { label: "Method", get: "method" }, { label: "Reference", get: "reference" }, { label: "Recorded by", get: "recorded_by" },
  ]));
}));

/* ------------------------------------------------------------------ settings */

async function loadSettings() {
  const { rows: types } = await db.query("SELECT * FROM room_types ORDER BY sort_order, id");
  const { rows: rooms } = await db.query("SELECT * FROM rooms ORDER BY name");
  const { rows: beds } = await db.query("SELECT * FROM beds ORDER BY id");
  const { rows: periods } = await db.query("SELECT * FROM peak_periods ORDER BY start_date");
  const { rows: rates } = await db.query("SELECT * FROM peak_rates");
  return {
    room_types: types.map((t) => ({ ...t, base_price: Number(t.base_price) })),
    rooms: rooms.map((r) => ({ ...r, beds: beds.filter((b) => b.room_id === r.id) })),
    peak_periods: periods.map((p) => ({
      id: p.id, name: p.name, start_date: db.toISODate(p.start_date), end_date: db.toISODate(p.end_date),
      rates: Object.fromEntries(rates.filter((x) => x.peak_period_id === p.id).map((x) => [x.room_type_id, Number(x.price)])),
    })),
    expense_approval_limit: Number(await getSetting("expense_approval_limit", "50000")),
  };
}

router.get("/settings", OWNER, h(async (req, res) => res.json(await loadSettings())));

router.post("/settings/general", OWNER, h(async (req, res) => {
  if (req.body?.expense_approval_limit != null) {
    await setSetting("expense_approval_limit", toInt(req.body.expense_approval_limit, { max: 100000000, name: "Approval limit" }));
  }
  res.json(await loadSettings());
}));

// Room type: price, name, description, open/coming soon.
router.post("/room-types/:id", OWNER, h(async (req, res) => {
  const { rows } = await db.query("SELECT * FROM room_types WHERE id = $1", [req.params.id]);
  const t = rows[0];
  if (!t) throw new BookingError("Room type not found.", 404);
  const b = req.body || {};
  const price = b.base_price != null ? toInt(b.base_price, { max: 10000000, name: "Price" }) : Number(t.base_price);
  const name = text(b.name, 80) || t.name;
  const description = b.description != null ? text(b.description, 500) : t.description;
  const capacity = b.capacity_label != null ? text(b.capacity_label, 80) : t.capacity_label;
  const tag = b.tag != null ? text(b.tag, 30) : t.tag;
  const comingSoon = b.coming_soon != null ? !!b.coming_soon : t.coming_soon;
  if (!comingSoon && price <= 0) throw new BookingError("Set a price above ₦0 before opening this room type for booking.");
  await db.query(
    "UPDATE room_types SET base_price=$2, name=$3, description=$4, capacity_label=$5, tag=$6, coming_soon=$7 WHERE id=$1",
    [t.id, price, name, description, capacity, tag, comingSoon]
  );
  res.json(await loadSettings());
}));

// Peak periods.
async function savePeak(id, body) {
  const name = text(body.name, 100);
  const start = body.start_date, end = body.end_date;
  if (!name) throw new BookingError("Give the peak period a name, e.g. Holy Ghost Congress.");
  if (!isDate(start) || !isDate(end) || end < start) throw new BookingError("Choose a valid first and last night (last night on or after the first).");
  const rates = body.rates && typeof body.rates === "object" ? body.rates : {};
  return db.tx(async (c) => {
    let pid = id;
    if (pid) {
      const r = await c.query("UPDATE peak_periods SET name=$2, start_date=$3, end_date=$4 WHERE id=$1 RETURNING id", [pid, name, start, end]);
      if (!r.rows.length) throw new BookingError("Peak period not found.", 404);
      await c.query("DELETE FROM peak_rates WHERE peak_period_id = $1", [pid]);
    } else {
      const r = await c.query("INSERT INTO peak_periods (name, start_date, end_date) VALUES ($1,$2,$3) RETURNING id", [name, start, end]);
      pid = r.rows[0].id;
    }
    for (const [type, price] of Object.entries(rates)) {
      if (price === "" || price == null) continue;
      const exists = await c.query("SELECT id FROM room_types WHERE id = $1", [type]);
      if (!exists.rows.length) continue;
      await c.query("INSERT INTO peak_rates (peak_period_id, room_type_id, price) VALUES ($1,$2,$3)", [pid, type, toInt(price, { min: 1, max: 10000000, name: "Peak price" })]);
    }
  });
}
router.post("/peaks", OWNER, h(async (req, res) => { await savePeak(null, req.body || {}); res.status(201).json(await loadSettings()); }));
router.post("/peaks/:id", OWNER, h(async (req, res) => { await savePeak(parseInt(req.params.id, 10), req.body || {}); res.json(await loadSettings()); }));
router.post("/peaks/:id/delete", OWNER, h(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  await db.query("DELETE FROM peak_rates WHERE peak_period_id = $1", [id]);
  await db.query("DELETE FROM peak_periods WHERE id = $1", [id]);
  res.json(await loadSettings());
}));

// Rooms and beds.
async function futureNights(where, params) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM booking_nights bn JOIN beds b ON b.id = bn.bed_id WHERE bn.night >= $1 AND ${where}`,
    [require("./booking").todayLagos(), ...params]
  );
  return Number(rows[0].n);
}

router.post("/rooms", OWNER, h(async (req, res) => {
  const b = req.body || {};
  const name = text(b.name, 60);
  const gender = GENDERS.includes(b.gender) ? b.gender : null;
  const count = toInt(b.beds, { min: 1, max: 40, name: "Number of beds" });
  const reserve = toInt(b.reserve ?? 0, { min: 0, max: count, name: "Walk-in reserve" });
  if (!name || !gender) throw new BookingError("Enter a room name and choose female, male or mixed.");
  const t = await db.query("SELECT id FROM room_types WHERE id = $1", [b.room_type_id]);
  if (!t.rows.length) throw new BookingError("Choose a room type.");
  const dup = await db.query("SELECT id FROM rooms WHERE LOWER(name) = LOWER($1)", [name]);
  if (dup.rows.length) throw new BookingError("A room with that name already exists.", 409);
  const prefix = text(b.bed_prefix, 6) || name.replace(/^dorm\s*/i, "").slice(0, 3).toUpperCase() || "B";
  await db.tx(async (c) => {
    const r = await c.query("INSERT INTO rooms (name, room_type_id, gender) VALUES ($1,$2,$3) RETURNING id", [name, b.room_type_id, gender]);
    for (let i = 1; i <= count; i++) {
      await c.query("INSERT INTO beds (room_id, label, online) VALUES ($1,$2,$3)", [r.rows[0].id, `${prefix}${i}`, i <= count - reserve]);
    }
  });
  res.status(201).json(await loadSettings());
}));

router.post("/rooms/:id", OWNER, h(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query("SELECT * FROM rooms WHERE id = $1", [id]);
  const room = rows[0];
  if (!room) throw new BookingError("Room not found.", 404);
  const b = req.body || {};
  const name = text(b.name, 60) || room.name;
  const gender = b.gender != null ? b.gender : room.gender;
  const active = b.active != null ? !!b.active : room.active;
  const type = b.room_type_id || room.room_type_id;
  if (!GENDERS.includes(gender)) throw new BookingError("Choose female, male or mixed.");
  const changesGuests = gender !== room.gender || !active || type !== room.room_type_id;
  if (changesGuests && (await futureNights("b.room_id = $2", [id]))) {
    throw new BookingError("This room has upcoming bookings. Move or cancel them before changing its dorm type, room type or closing it.", 409);
  }
  await db.query("UPDATE rooms SET name=$2, gender=$3, active=$4, room_type_id=$5 WHERE id=$1", [id, name, gender, active, type]);
  res.json(await loadSettings());
}));

// Set how many beds in a room are held back for walk-ins (the last N beds).
router.post("/rooms/:id/reserve", OWNER, h(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows: beds } = await db.query("SELECT id FROM beds WHERE room_id = $1 AND active = TRUE ORDER BY id", [id]);
  if (!beds.length) throw new BookingError("Room not found or has no beds.", 404);
  const n = toInt(req.body?.reserve, { min: 0, max: beds.length, name: "Walk-in reserve" });
  for (let i = 0; i < beds.length; i++) {
    await db.query("UPDATE beds SET online = $2 WHERE id = $1", [beds[i].id, i < beds.length - n]);
  }
  res.json(await loadSettings());
}));

router.post("/rooms/:id/beds", OWNER, h(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query("SELECT * FROM rooms WHERE id = $1", [id]);
  if (!rows[0]) throw new BookingError("Room not found.", 404);
  const label = text(req.body?.label, 10);
  if (!label) throw new BookingError("Give the bed a label, e.g. A9.");
  await db.query("INSERT INTO beds (room_id, label, online) VALUES ($1,$2,$3)", [id, label, req.body?.online !== false]);
  res.status(201).json(await loadSettings());
}));

router.post("/beds/:id", OWNER, h(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query("SELECT * FROM beds WHERE id = $1", [id]);
  const bed = rows[0];
  if (!bed) throw new BookingError("Bed not found.", 404);
  const b = req.body || {};
  const online = b.online != null ? !!b.online : bed.online;
  const active = b.active != null ? !!b.active : bed.active;
  const label = text(b.label, 10) || bed.label;
  if (!active && bed.active && (await futureNights("b.id = $2", [id]))) {
    throw new BookingError("This bed has upcoming bookings, so it can't be taken out of use yet.", 409);
  }
  await db.query("UPDATE beds SET online=$2, active=$3, label=$4 WHERE id=$1", [id, online, active, label]);
  res.json(await loadSettings());
}));

module.exports = router;
