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
  method      TEXT NOT NULL,                       -- cash, pos, transfer
  reference   TEXT,
  status      TEXT NOT NULL DEFAULT 'success',     -- success, pending, failed
  recorded_by INTEGER REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A payment reference can only be recorded once (protects against double-processing).
CREATE UNIQUE INDEX IF NOT EXISTS payments_reference_key ON payments (reference);

-- Audit trail: who did what to a booking, and when (check-in, check-out, no-show, cancel, payment).
CREATE TABLE IF NOT EXISTS booking_events (
  id         SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  action     TEXT NOT NULL,
  note       TEXT,
  user_id    INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Business settings the owner can change (key/value).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Operating expenses logged by the manager or owner.
CREATE TABLE IF NOT EXISTS expenses (
  id           SERIAL PRIMARY KEY,
  spent_on     DATE NOT NULL,
  category     TEXT NOT NULL,
  room_id      INTEGER REFERENCES rooms(id),
  description  TEXT NOT NULL,
  amount       INTEGER NOT NULL,                   -- naira
  paid_to      TEXT,
  method       TEXT,                               -- cash, transfer, pos
  receipt      TEXT,                               -- photo as a data URL (optional)
  status       TEXT NOT NULL DEFAULT 'approved',   -- approved, pending, rejected
  created_by   INTEGER REFERENCES users(id),
  reviewed_by  INTEGER REFERENCES users(id),
  review_note  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Staff rota: one row per person per shift.
CREATE TABLE IF NOT EXISTS shifts (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  shift_date DATE NOT NULL,
  name       TEXT NOT NULL,
  start_time TEXT NOT NULL,                        -- 'HH:MM' Lagos time
  end_time   TEXT NOT NULL,                        -- may be earlier than start (overnight)
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Clock-in / clock-out records.
CREATE TABLE IF NOT EXISTS attendance (
  id        SERIAL PRIMARY KEY,
  user_id   INTEGER NOT NULL REFERENCES users(id),
  shift_id  INTEGER REFERENCES shifts(id),
  clock_in  TIMESTAMPTZ NOT NULL,
  clock_out TIMESTAMPTZ,
  ip        TEXT,
  note      TEXT
);

-- Monthly sales target per staff member (naira collected).
CREATE TABLE IF NOT EXISTS staff_targets (
  user_id INTEGER NOT NULL REFERENCES users(id),
  month   TEXT NOT NULL,                           -- 'YYYY-MM'
  amount  INTEGER NOT NULL,
  PRIMARY KEY (user_id, month)
);

-- Agreed pay and bank details per staff member.
CREATE TABLE IF NOT EXISTS staff_pay (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id),
  monthly_salary INTEGER NOT NULL DEFAULT 0,
  bank_name      TEXT,
  account_number TEXT,
  account_name   TEXT
);

-- Payroll: one row per person per month.
CREATE TABLE IF NOT EXISTS payroll (
  id         SERIAL PRIMARY KEY,
  month      TEXT NOT NULL,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  base       INTEGER NOT NULL,
  deductions INTEGER NOT NULL DEFAULT 0,
  bonus      INTEGER NOT NULL DEFAULT 0,
  note       TEXT,
  status     TEXT NOT NULL DEFAULT 'due',          -- due, paid
  paid_at    TIMESTAMPTZ,
  method     TEXT,
  reference  TEXT,
  receipt    TEXT,
  paid_by    INTEGER REFERENCES users(id),
  UNIQUE (month, user_id)
);

-- Careers: open roles and applications.
CREATE TABLE IF NOT EXISTS jobs (
  id           SERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  requirements TEXT,
  open         BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS applications (
  id         SERIAL PRIMARY KEY,
  job_id     INTEGER REFERENCES jobs(id),
  role       TEXT NOT NULL,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL,
  email      TEXT,
  location   TEXT,
  experience TEXT,
  cv         TEXT,                                 -- file as a data URL (optional)
  cv_name    TEXT,
  status     TEXT NOT NULL DEFAULT 'new',          -- new, shortlisted, rejected, hired
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Every email the app tries to send, for troubleshooting.
CREATE TABLE IF NOT EXISTS email_log (
  id         SERIAL PRIMARY KEY,
  kind       TEXT NOT NULL,
  to_addr    TEXT NOT NULL,
  subject    TEXT NOT NULL,
  status     TEXT NOT NULL,                        -- sent, failed, skipped
  error      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
