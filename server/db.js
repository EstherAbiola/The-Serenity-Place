// Database connection, schema setup and placeholder seed data.
//
// - With DATABASE_URL set (e.g. a Supabase or Neon Postgres URL), data is stored there permanently.
// - Without it, the app runs on a temporary in-memory database so previews still work.
//   That data is lost whenever the app restarts or redeploys.

const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

let pool;
let persistent = false;

function toISODate(v) {
  if (v == null) return v;
  if (v instanceof Date) {
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, "0"), d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

async function connect() {
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    const isNeon = /\.neon\.tech$/i.test(u.hostname) || process.env.DB_DRIVER === "neon";
    if (isNeon) {
      // GoDaddy Node.js Hosting only allows outbound traffic on ports 80/443, so the normal
      // Postgres port (5432) is blocked. Neon's serverless driver talks to the same database
      // over a secure WebSocket on port 443, with the same Pool/transaction API as `pg`.
      const { Pool, neonConfig, types } = require("@neondatabase/serverless");
      neonConfig.webSocketConstructor = require("ws");
      types.setTypeParser(1082, (v) => v); // keep DATE columns as 'YYYY-MM-DD' strings
      u.searchParams.delete("channel_binding");
      pool = new Pool({ connectionString: u.toString(), max: 5 });
      console.log("[db] Connecting to Neon over WebSocket (port 443).");
    } else {
      const pg = require("pg");
      pg.types.setTypeParser(1082, (v) => v); // keep DATE columns as 'YYYY-MM-DD' strings
      // Strip libpq-only options (sslmode, channel_binding) and set SSL explicitly.
      u.searchParams.delete("sslmode");
      u.searchParams.delete("channel_binding");
      const local = /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
      const ssl = local ? false : { rejectUnauthorized: process.env.DB_SSL_NO_VERIFY !== "1" };
      pool = new pg.Pool({ connectionString: u.toString(), ssl, max: 5 });
    }
    pool.on("error", (err) => console.error("[db] idle client error:", err.message));
    persistent = true;
  } else {
    const { newDb } = require("pg-mem");
    const mem = newDb();
    const { Pool } = mem.adapters.createPg();
    pool = new Pool();
    console.warn("[db] DATABASE_URL not set: using a TEMPORARY in-memory database. Data will be lost on restart.");
  }
  await migrate();
  await seed();
  return pool;
}

async function query(text, params) {
  return pool.query(text, params);
}

// Run fn(client) inside a transaction.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  const statements = sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/--.*$/gm, "").trim())
    .filter(Boolean);
  for (const s of statements) await pool.query(s);
}

// Placeholder inventory and prices. Only inserted into an EMPTY database.
const SEED = {
  roomTypes: [
    { id: "dorm8", name: "Shared Dorm · 8 Bed", unit: "bed", base_price: 10000, capacity_label: "1 guest per bed", tag: "Best value", sort_order: 1,
      description: "A clean, secure bunk in a shared room. Ideal for solo travellers, youth groups and programme attendees on a budget." },
    { id: "dorm4", name: "Shared Dorm · 4 Bed", unit: "bed", base_price: 15000, capacity_label: "1 guest per bed", tag: "Popular", sort_order: 2,
      description: "A quieter shared room with fewer bunks. Good for small groups or friends travelling together." },
    { id: "private", name: "Private Standard Room", unit: "room", base_price: 30000, capacity_label: "Up to 2 guests", tag: "Coming soon", coming_soon: true, sort_order: 3,
      description: "Private rooms with en-suite bathrooms are planned for a later phase." },
    { id: "exec", name: "Executive Room", unit: "room", base_price: 0, capacity_label: "Up to 2 guests", tag: "Coming soon", coming_soon: true, sort_order: 4,
      description: "Premium rooms with upgraded finishes are in our next phase." },
  ],
  // name, type, gender, beds, how many beds held back for walk-ins
  rooms: [
    ["Dorm A", "dorm8", "female", 8, 2],
    ["Dorm B", "dorm8", "male", 8, 2],
    ["Dorm C", "dorm8", "female", 8, 2],
    ["Dorm D", "dorm8", "male", 8, 2],
    ["Dorm E", "dorm4", "female", 4, 1],
    ["Dorm F", "dorm4", "male", 4, 1],
  ],
  peaks: [
    { name: "Holy Ghost Congress (placeholder dates)", start: "2026-12-07", end: "2026-12-13", rates: { dorm8: 15000, dorm4: 22000 } },
  ],
};

async function seed() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM room_types");
  if (Number(rows[0].n) === 0) {
    for (const t of SEED.roomTypes) {
      await pool.query(
        `INSERT INTO room_types (id, name, description, unit, base_price, capacity_label, tag, coming_soon, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [t.id, t.name, t.description, t.unit, t.base_price, t.capacity_label, t.tag, !!t.coming_soon, t.sort_order]
      );
    }
    for (const [name, type, gender, count, reserve] of SEED.rooms) {
      const r = await pool.query("INSERT INTO rooms (name, room_type_id, gender) VALUES ($1,$2,$3) RETURNING id", [name, type, gender]);
      const roomId = r.rows[0].id;
      const letter = name.slice(-1);
      for (let i = 1; i <= count; i++) {
        const online = i <= count - reserve;
        await pool.query("INSERT INTO beds (room_id, label, online) VALUES ($1,$2,$3)", [roomId, `${letter}${i}`, online]);
      }
    }
    for (const p of SEED.peaks) {
      const r = await pool.query("INSERT INTO peak_periods (name, start_date, end_date) VALUES ($1,$2,$3) RETURNING id", [p.name, p.start, p.end]);
      for (const [type, price] of Object.entries(p.rates)) {
        await pool.query("INSERT INTO peak_rates (peak_period_id, room_type_id, price) VALUES ($1,$2,$3)", [r.rows[0].id, type, price]);
      }
    }
    console.log("[db] Seeded placeholder rooms, beds and prices.");
  }

  // First owner account, from environment variables (never hard-coded).
  const { OWNER_EMAIL, OWNER_PASSWORD, OWNER_NAME } = process.env;
  if (OWNER_EMAIL && OWNER_PASSWORD) {
    const exists = await pool.query("SELECT id FROM users WHERE email = $1", [OWNER_EMAIL.toLowerCase()]);
    if (exists.rows.length === 0) {
      const hash = await bcrypt.hash(OWNER_PASSWORD, 10);
      await pool.query("INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,'owner')", [OWNER_NAME || "Owner", OWNER_EMAIL.toLowerCase(), hash]);
      console.log(`[db] Created owner account for ${OWNER_EMAIL}.`);
    }
  }
}

module.exports = { connect, query, tx, toISODate, isPersistent: () => persistent };
