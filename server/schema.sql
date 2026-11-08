-- Serenity Place Residences: core booking schema (PostgreSQL).
-- Safe to run on every start: every statement is idempotent.

CREATE TABLE IF NOT EXISTS room_types (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT,
  unit           TEXT NOT NULL DEFAULT 'bed',      -- 'bed' (dorms) or 'room'
  base_price     INTEGER NOT NULL DEFAULT 0,       -- naira per unit per night
  capacity_label TEXT,
  tag            TEXT,
  coming_soon    BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rooms (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  room_type_id TEXT NOT NULL REFERENCES room_types(id),
  gender       TEXT NOT NULL DEFAULT 'mixed',      -- 'female', 'male' or 'mixed'
  active       BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS beds (
  id      SERIAL PRIMARY KEY,
  room_id INTEGER NOT NULL REFERENCES rooms(id),
  label   TEXT NOT NULL,
  online  BOOLEAN NOT NULL DEFAULT TRUE,           -- FALSE = walk-in reserve, never sold online
  active  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS peak_periods (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  start_date DATE NOT NULL,                        -- first peak night
  end_date   DATE NOT NULL                         -- last peak night (inclusive)
);

CREATE TABLE IF NOT EXISTS peak_rates (
  peak_period_id INTEGER NOT NULL REFERENCES peak_periods(id),
  room_type_id   TEXT NOT NULL REFERENCES room_types(id),
  price          INTEGER NOT NULL,
  PRIMARY KEY (peak_period_id, room_type_id)
);

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff',     -- 'owner', 'manager' or 'staff'
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bookings (
  id           SERIAL PRIMARY KEY,
  ref          TEXT NOT NULL UNIQUE,
  room_type_id TEXT NOT NULL REFERENCES room_types(id),
  checkin      DATE NOT NULL,
  checkout     DATE NOT NULL,
  nights       INTEGER NOT NULL,
  beds_count   INTEGER NOT NULL,
  amount       INTEGER NOT NULL,                   -- naira
  guest_name   TEXT NOT NULL,
  guest_phone  TEXT NOT NULL,
  guest_email  TEXT,
  guest_gender TEXT,
  purpose      TEXT,
  notes        TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',    -- pending, confirmed, checked_in, checked_out, cancelled, no_show, expired
  channel      TEXT NOT NULL DEFAULT 'online',     -- 'online' or 'walk_in'
  created_by   INTEGER REFERENCES users(id),
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per bed per night. The primary key makes double-booking impossible.
CREATE TABLE IF NOT EXISTS booking_nights (
  bed_id     INTEGER NOT NULL REFERENCES beds(id),
  night      DATE NOT NULL,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  PRIMARY KEY (bed_id, night)
);

CREATE TABLE IF NOT EXISTS payments (
  id          SERIAL PRIMARY KEY,
  booking_id  INTEGER NOT NULL REFERENCES bookings(id),
  amount      INTEGER NOT NULL,
  method      TEXT NOT NULL,                       -- paystack, cash, pos, transfer, preview
  reference   TEXT,
  status      TEXT NOT NULL DEFAULT 'success',     -- success, pending, failed
  recorded_by INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
