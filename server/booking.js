// Availability, pricing and booking creation.
const crypto = require("crypto");
const db = require("./db");

const HOLD_MINUTES = 30; // an unpaid online booking holds its beds this long
const MAX_NIGHTS = 30;
const MAX_BEDS = 8;
const GENDERS = ["female", "male"];

class BookingError extends Error {
  constructor(message, status = 400, code = "invalid") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function todayLagos() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
}

function isISODate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));
}

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function nightsBetween(checkin, checkout) {
  const out = [];
  for (let d = checkin; d < checkout; d = addDays(d, 1)) out.push(d);
  return out;
}

function validateStay(checkin, checkout, { allowPast = false } = {}) {
  if (!isISODate(checkin) || !isISODate(checkout)) throw new BookingError("Please choose valid check-in and check-out dates.");
  if (!allowPast && checkin < todayLagos()) throw new BookingError("Check-in date cannot be in the past.");
  const nights = nightsBetween(checkin, checkout);
  if (nights.length < 1) throw new BookingError("Check-out must be at least one night after check-in.");
  if (nights.length > MAX_NIGHTS) throw new BookingError(`Online bookings are limited to ${MAX_NIGHTS} nights. Please contact us for longer stays.`);
  return nights;
}

function newRef() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(6);
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return "SP-" + s;
}

// Release beds held by unpaid bookings whose hold has run out.
async function releaseExpired(client = db) {
  const { rows } = await client.query(
    "UPDATE bookings SET status = 'expired' WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < NOW() RETURNING id"
  );
  for (const r of rows) await client.query("DELETE FROM booking_nights WHERE booking_id = $1", [r.id]);
  return rows.length;
}

async function getRoomTypes(client = db) {
  const { rows } = await client.query("SELECT * FROM room_types ORDER BY sort_order, id");
  return rows;
}

async function getPeakPeriods(client = db) {
  const { rows: periods } = await client.query("SELECT * FROM peak_periods ORDER BY start_date");
  const { rows: rates } = await client.query("SELECT * FROM peak_rates");
  return periods.map((p) => ({
    id: p.id,
    name: p.name,
    start_date: db.toISODate(p.start_date),
    end_date: db.toISODate(p.end_date),
    rates: Object.fromEntries(rates.filter((r) => r.peak_period_id === p.id).map((r) => [r.room_type_id, Number(r.price)])),
  }));
}

// Price for each night, using the peak rate where a night falls inside a peak period.
function priceNights(roomType, nights, peaks) {
  return nights.map((night) => {
    const peak = peaks.find((p) => night >= p.start_date && night <= p.end_date && p.rates[roomType.id] != null);
    return { night, price: peak ? peak.rates[roomType.id] : Number(roomType.base_price), peak: peak ? peak.name : null };
  });
}

// Beds of a room type that are free on every night of the stay.
async function freeBeds(client, roomTypeId, checkin, checkout, { gender, channel = "online" } = {}) {
  const params = [roomTypeId];
  let where = "r.room_type_id = $1 AND r.active = TRUE AND b.active = TRUE";
  if (channel === "online") where += " AND b.online = TRUE"; // walk-in reserve is never sold online
  if (gender) {
    params.push(gender);
    where += " AND (r.gender = $2 OR r.gender = 'mixed')";
  }
  const { rows: candidates } = await client.query(
    `SELECT b.id, b.label, b.online, r.id AS room_id, r.name AS room_name, r.gender
       FROM beds b JOIN rooms r ON r.id = b.room_id
      WHERE ${where}
      ORDER BY r.id, b.id`,
    params
  );
  const { rows: taken } = await client.query(
    "SELECT DISTINCT bed_id FROM booking_nights WHERE night >= $1 AND night < $2",
    [checkin, checkout]
  );
  const busy = new Set(taken.map((t) => Number(t.bed_id)));
  return candidates.filter((b) => !busy.has(Number(b.id)));
}

// Choose beds, keeping a group in one room where possible.
function allocate(beds, count) {
  const byRoom = new Map();
  for (const b of beds) {
    if (!byRoom.has(b.room_id)) byRoom.set(b.room_id, []);
    byRoom.get(b.room_id).push(b);
  }
  const rooms = [...byRoom.values()];
  // Smallest room that still fits the whole group (leaves big blocks free for big groups).
  const fits = rooms.filter((r) => r.length >= count).sort((a, b) => a.length - b.length);
  if (fits.length) return fits[0].slice(0, count);
  // Otherwise fill from the emptiest rooms first.
  const picked = [];
  for (const r of rooms.sort((a, b) => b.length - a.length)) {
    for (const bed of r) {
      if (picked.length === count) break;
      picked.push(bed);
    }
  }
  return picked.length === count ? picked : null;
}

async function availability({ checkin, checkout, gender }) {
  const nights = validateStay(checkin, checkout);
  if (gender && !GENDERS.includes(gender)) throw new BookingError("Unknown gender.");
  await releaseExpired();
  const types = await getRoomTypes();
  const peaks = await getPeakPeriods();
  const out = [];
  for (const t of types) {
    if (t.coming_soon) {
      out.push({ room_type_id: t.id, coming_soon: true, available: 0 });
      continue;
    }
    const free = await freeBeds(db, t.id, checkin, checkout, { gender });
    const priced = priceNights(t, nights, peaks);
    out.push({
      room_type_id: t.id,
      available: free.length,
      nights: priced.length,
      price_per_unit: priced.reduce((s, n) => s + n.price, 0), // one bed for the whole stay
      nightly: priced,
    });
  }
  return { checkin, checkout, nights: nights.length, room_types: out };
}

function cleanText(v, max = 200) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

async function createBooking(input, { channel = "online", userId = null } = {}) {
  const roomTypeId = cleanText(input.room_type_id, 40);
  const checkin = input.checkin, checkout = input.checkout;
  const beds = parseInt(input.beds, 10);
  const g = input.guest || {};
  const guest = {
    name: cleanText(g.name, 120),
    phone: cleanText(g.phone, 30),
    email: cleanText(g.email, 160).toLowerCase(),
    gender: cleanText(g.gender, 10).toLowerCase(),
    purpose: cleanText(g.purpose, 200),
    notes: cleanText(g.notes, 1000),
  };

  const nights = validateStay(checkin, checkout, { allowPast: false });
  if (!Number.isInteger(beds) || beds < 1 || beds > MAX_BEDS) throw new BookingError(`Please book between 1 and ${MAX_BEDS} beds. For larger groups, contact us.`);
  if (!guest.name) throw new BookingError("Please enter the guest's full name.");
  if (!/^[+0-9 ()-]{7,20}$/.test(guest.phone)) throw new BookingError("Please enter a valid phone number.");
  if (channel === "online" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guest.email)) throw new BookingError("Please enter a valid email address.");
  if (guest.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guest.email)) throw new BookingError("Please enter a valid email address.");
  if (!GENDERS.includes(guest.gender)) throw new BookingError("Please select female or male so we can allocate the right dorm.");

  return db.tx(async (client) => {
    await releaseExpired(client);
    const { rows: tRows } = await client.query("SELECT * FROM room_types WHERE id = $1", [roomTypeId]);
    const type = tRows[0];
    if (!type) throw new BookingError("Please choose a room type.");
    if (type.coming_soon) throw new BookingError("That room type is not open for booking yet.");

    const free = await freeBeds(client, type.id, checkin, checkout, { gender: guest.gender, channel });
    const picked = allocate(free, beds);
    if (!picked) {
      throw new BookingError(
        free.length
          ? `Only ${free.length} bed${free.length === 1 ? "" : "s"} left for those dates. Please reduce the number of beds or contact us.`
          : "Sorry, this dorm is fully booked for those dates.",
        409,
        "unavailable"
      );
    }

    const peaks = await getPeakPeriods(client);
    const priced = priceNights(type, nights, peaks);
    const amount = priced.reduce((s, n) => s + n.price, 0) * beds;
    const ref = newRef();
    const status = "pending";
    const expires = channel === "online" ? new Date(Date.now() + HOLD_MINUTES * 60000).toISOString() : null;

    const { rows: bRows } = await client.query(
      `INSERT INTO bookings (ref, room_type_id, checkin, checkout, nights, beds_count, amount,
                             guest_name, guest_phone, guest_email, guest_gender, purpose, notes,
                             status, channel, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
      [ref, type.id, checkin, checkout, nights.length, beds, amount,
       guest.name, guest.phone, guest.email || null, guest.gender, guest.purpose || null, guest.notes || null,
       status, channel, userId, expires]
    );
    const bookingId = bRows[0].id;
    try {
      for (const bed of picked) {
        for (const night of nights) {
          await client.query("INSERT INTO booking_nights (bed_id, night, booking_id) VALUES ($1,$2,$3)", [bed.id, night, bookingId]);
        }
      }
    } catch (e) {
      if (e.code === "23505" || /duplicate|unique/i.test(e.message)) {
        throw new BookingError("Those beds were just taken by another guest. Please try again.", 409, "unavailable");
      }
      throw e;
    }

    return {
      ref, status, amount, nights: nights.length, beds: beds,
      room_type: { id: type.id, name: type.name },
      checkin, checkout, expires_at: expires,
      allocation: picked.map((b) => ({ room: b.room_name, bed: b.label })),
      nightly: priced,
    };
  });
}

// Record a successful payment and confirm the booking. Safe to call twice with the same reference.
// If the 30-minute hold ran out before the money arrived, try to give the guest beds again;
// if none are left, the booking is flagged "needs_attention" so staff can refund or rehouse them.
async function confirmPayment(ref, { method, reference = null, amount = null, userId = null }) {
  return db.tx(async (client) => {
    const { rows } = await client.query("SELECT * FROM bookings WHERE ref = $1", [ref]);
    const b = rows[0];
    if (!b) throw new BookingError("Booking not found.", 404, "not_found");

    if (reference) {
      const dup = await client.query("SELECT id FROM payments WHERE reference = $1", [reference]);
      if (dup.rows.length) return getBooking(ref, client); // already recorded
    }
    if (method === "preview" && b.status !== "pending") {
      throw new BookingError(b.status === "expired" ? "This booking's hold expired before payment. Please book again." : "This booking is already paid.", 409, b.status);
    }

    let status = b.status;
    if (status === "pending") {
      status = "confirmed";
    } else if (status === "expired") {
      const nights = nightsBetween(db.toISODate(b.checkin), db.toISODate(b.checkout));
      const free = await freeBeds(client, b.room_type_id, db.toISODate(b.checkin), db.toISODate(b.checkout), { gender: b.guest_gender, channel: b.channel });
      const picked = allocate(free, b.beds_count);
      if (picked) {
        for (const bed of picked) for (const night of nights) {
          await client.query("INSERT INTO booking_nights (bed_id, night, booking_id) VALUES ($1,$2,$3)", [bed.id, night, b.id]);
        }
        status = "confirmed";
      } else {
        status = "needs_attention";
      }
    } else if (status === "cancelled") {
      status = "needs_attention";
    }

    await client.query(
      "INSERT INTO payments (booking_id, amount, method, reference, status, recorded_by) VALUES ($1,$2,$3,$4,'success',$5)",
      [b.id, amount == null ? b.amount : amount, method, reference, userId]
    );
    await client.query("UPDATE bookings SET status = $1, expires_at = NULL WHERE id = $2", [status, b.id]);
    if (status === "needs_attention") console.warn(`[booking] ${ref} was paid but has no beds; staff must follow up.`);
    return getBooking(ref, client);
  });
}

// Give a pending online booking a fresh hold while the guest is on the payment page.
async function extendHold(ref) {
  await db.query(
    "UPDATE bookings SET expires_at = $1 WHERE ref = $2 AND status = 'pending'",
    [new Date(Date.now() + HOLD_MINUTES * 60000).toISOString(), ref]
  );
}

async function getBooking(ref, client = db) {
  const { rows } = await client.query(
    `SELECT b.*, t.name AS room_type_name FROM bookings b JOIN room_types t ON t.id = b.room_type_id WHERE b.ref = $1`,
    [ref]
  );
  const b = rows[0];
  if (!b) return null;
  const { rows: beds } = await client.query(
    `SELECT DISTINCT r.name AS room, bd.label AS bed
       FROM booking_nights bn JOIN beds bd ON bd.id = bn.bed_id JOIN rooms r ON r.id = bd.room_id
      WHERE bn.booking_id = $1 ORDER BY r.name, bd.label`,
    [b.id]
  );
  const { rows: pays } = await client.query(
    "SELECT amount, method, reference, status, created_at FROM payments WHERE booking_id = $1 ORDER BY created_at",
    [b.id]
  );
  return {
    ref: b.ref, status: b.status, channel: b.channel,
    room_type: { id: b.room_type_id, name: b.room_type_name },
    checkin: db.toISODate(b.checkin), checkout: db.toISODate(b.checkout),
    nights: b.nights, beds: b.beds_count, amount: Number(b.amount),
    guest: { name: b.guest_name, phone: b.guest_phone, email: b.guest_email, gender: b.guest_gender, purpose: b.purpose, notes: b.notes },
    allocation: beds, payments: pays.map((p) => ({ ...p, amount: Number(p.amount) })),
    expires_at: b.expires_at, created_at: b.created_at,
  };
}

module.exports = {
  BookingError, availability, createBooking, confirmPayment, extendHold, getBooking, freeBeds, allocate, nightsBetween, validateStay, getRoomTypes, getPeakPeriods,
  releaseExpired, todayLagos, HOLD_MINUTES,
};
