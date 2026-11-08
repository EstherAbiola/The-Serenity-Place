// Staff rota, clock-in/out, targets and payroll.
const express = require("express");
const crypto = require("crypto");
const db = require("./db");
const { requireRole } = require("./auth");
const { todayLagos } = require("./booking");
const { h, isDate, addDays, dateRange, lagosStart, csv, sendCsv, getSetting, setSetting, toInt, text, BookingError } = require("./util");
const email = require("./email");

const ANY = requireRole("owner", "manager", "staff");
const MANAGERS = requireRole("owner", "manager");
const OWNER = requireRole("owner");
const router = express.Router();

/* ---------------- settings with placeholder defaults ---------------- */

const DEFAULT_SHIFTS = [
  { name: "Morning", start: "07:00", end: "15:00" },
  { name: "Evening", start: "15:00", end: "23:00" },
  { name: "Night", start: "23:00", end: "07:00" },
];
async function shiftTemplates() {
  try {
    const v = JSON.parse(await getSetting("shift_templates", "null"));
    if (Array.isArray(v) && v.length) return v;
  } catch { /* fall through */ }
  return DEFAULT_SHIFTS;
}
async function teamSettings() {
  return {
    shift_templates: await shiftTemplates(),
    shift_times_are_placeholders: !(await getSetting("shift_templates")),
    late_grace_minutes: Number(await getSetting("late_grace_minutes", "15")),
    site_code_required: Boolean(await getSetting("clockin_site_code", "")),
    pay_day: Number(await getSetting("pay_day", "28")),
  };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const monthOk = (m) => typeof m === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const thisMonth = () => todayLagos().slice(0, 7);
const monthLabel = (m) => new Date(m + "-15T12:00:00Z").toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const nextMonth = (m) => { const [y, mo] = m.split("-").map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`; };

// Shift start and end as Date objects (end rolls to the next day for overnight shifts).
function shiftWindow(s) {
  const date = db.toISODate(s.shift_date);
  const start = new Date(`${date}T${s.start_time}:00+01:00`);
  let end = new Date(`${date}T${s.end_time}:00+01:00`);
  if (end <= start) end = new Date(end.getTime() + 864e5);
  return { start, end };
}

async function activeTeam() {
  const { rows } = await db.query("SELECT id, name, email, role FROM users WHERE active = TRUE ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, name");
  return rows;
}

/* ---------------- my day: shifts, clock status, target ---------------- */

async function collectedBy(userId, fromIso, toIsoExclusive) {
  const { rows } = await db.query(
    "SELECT COALESCE(SUM(amount),0)::int AS total, COUNT(*)::int AS n FROM payments WHERE recorded_by = $1 AND status = 'success' AND created_at >= $2 AND created_at < $3",
    [userId, fromIso, toIsoExclusive]
  );
  return { total: Number(rows[0].total), count: Number(rows[0].n) };
}

router.get("/me", ANY, h(async (req, res) => {
  const today = todayLagos();
  const { rows: shifts } = await db.query(
    "SELECT * FROM shifts WHERE user_id = $1 AND shift_date >= $2 AND shift_date <= $3 ORDER BY shift_date, start_time",
    [req.user.id, addDays(today, -1), addDays(today, 14)]
  );
  const { rows: open } = await db.query("SELECT * FROM attendance WHERE user_id = $1 AND clock_out IS NULL ORDER BY clock_in DESC", [req.user.id]);
  const month = thisMonth();
  const { rows: t } = await db.query("SELECT amount FROM staff_targets WHERE user_id = $1 AND month = $2", [req.user.id, month]);
  const collected = await collectedBy(req.user.id, lagosStart(month + "-01"), lagosStart(nextMonth(month) + "-01"));
  res.json({
    today,
    settings: await teamSettings(),
    shifts: shifts.filter((s) => shiftWindow(s).end > new Date()).map((s) => ({ id: s.id, date: db.toISODate(s.shift_date), name: s.name, start: s.start_time, end: s.end_time })),
    clocked_in: open[0] ? { since: open[0].clock_in, shift_id: open[0].shift_id } : null,
    target: { month, month_label: monthLabel(month), amount: t[0] ? Number(t[0].amount) : null, collected: collected.total, payments: collected.count },
    birthday: await (async () => {
      const { rows: u } = await db.query("SELECT birthday FROM users WHERE id = $1", [req.user.id]);
      const bd = u[0] && u[0].birthday;
      if (!bd) return { birthday: null, is_today: false, wishes: [] };
      const isToday = nextBirthday(bd, today) === today;
      const { rows: w } = isToday
        ? await db.query("SELECT w.message, u.name AS from_name FROM birthday_wishes w JOIN users u ON u.id = w.from_user_id WHERE w.user_id = $1 AND w.year = $2 ORDER BY w.created_at", [req.user.id, Number(today.slice(0, 4))])
        : { rows: [] };
      return { birthday: bd, is_today: isToday, wishes: w };
    })(),
  });
}));

router.post("/clock-in", ANY, h(async (req, res) => {
  const required = await getSetting("clockin_site_code", "");
  if (required) {
    const given = String(req.body?.site_code || "").trim().toUpperCase();
    if (given !== String(required).toUpperCase()) throw new BookingError("That site code is not right. It is shown at the front desk.", 403);
  }
  const { rows: open } = await db.query("SELECT id FROM attendance WHERE user_id = $1 AND clock_out IS NULL", [req.user.id]);
  if (open.length) throw new BookingError("You're already clocked in.", 409);
  // Match the shift that is on now (or starts within 2 hours).
  const today = todayLagos();
  const { rows: shifts } = await db.query("SELECT * FROM shifts WHERE user_id = $1 AND shift_date >= $2 AND shift_date <= $3", [req.user.id, addDays(today, -1), today]);
  const now = new Date();
  const match = shifts.find((s) => { const w = shiftWindow(s); return now >= new Date(w.start.getTime() - 2 * 3600e3) && now < w.end; });
  await db.query("INSERT INTO attendance (user_id, shift_id, clock_in, ip) VALUES ($1,$2,$3,$4)", [req.user.id, match ? match.id : null, now.toISOString(), String(req.ip || "").slice(0, 60)]);
  res.status(201).json({ ok: true, shift: match ? { name: match.name, start: match.start_time, end: match.end_time } : null });
}));

// Clock out and get a summary of what was done during the shift.
router.post("/clock-out", ANY, h(async (req, res) => {
  const { rows } = await db.query("SELECT * FROM attendance WHERE user_id = $1 AND clock_out IS NULL ORDER BY clock_in DESC", [req.user.id]);
  const a = rows[0];
  if (!a) throw new BookingError("You're not clocked in.", 409);
  const now = new Date();
  await db.query("UPDATE attendance SET clock_out = $2, note = $3 WHERE id = $1", [a.id, now.toISOString(), text(req.body?.note, 300) || null]);
  const since = new Date(a.clock_in).toISOString();
  const { rows: pays } = await db.query(
    `SELECT p.amount, p.method, b.ref, b.guest_name FROM payments p JOIN bookings b ON b.id = p.booking_id
      WHERE p.recorded_by = $1 AND p.status = 'success' AND p.created_at >= $2 AND p.created_at <= $3 ORDER BY p.created_at`,
    [req.user.id, since, now.toISOString()]
  );
  const { rows: events } = await db.query(
    "SELECT action FROM booking_events WHERE user_id = $1 AND created_at >= $2 AND created_at <= $3",
    [req.user.id, since, now.toISOString()]
  );
  const count = (act) => events.filter((e) => e.action === act).length;
  const byMethod = {};
  for (const p of pays) byMethod[p.method] = (byMethod[p.method] || 0) + Number(p.amount);
  res.json({
    clock_in: a.clock_in, clock_out: now, hours: Math.round(((now - new Date(a.clock_in)) / 3600e3) * 10) / 10,
    collected: pays.reduce((s, p) => s + Number(p.amount), 0), by_method: byMethod,
    payments: pays.map((p) => ({ ref: p.ref, guest: p.guest_name, amount: Number(p.amount), method: p.method })),
    bookings_created: count("created"), check_ins: count("checked_in"), check_outs: count("checked_out"), no_shows: count("no_show"),
  });
}));

/* ---------------- rota (managers) ---------------- */

router.get("/rota", MANAGERS, h(async (req, res) => {
  const start = isDate(req.query.start) ? req.query.start : todayLagos();
  const days = [];
  for (let i = 0; i < 7; i++) days.push(addDays(start, i));
  const { rows } = await db.query("SELECT * FROM shifts WHERE shift_date >= $1 AND shift_date <= $2 ORDER BY start_time", [start, days[6]]);
  res.json({
    start, days, team: await activeTeam(), settings: await teamSettings(),
    shifts: rows.map((s) => ({ id: s.id, user_id: s.user_id, date: db.toISODate(s.shift_date), name: s.name, start: s.start_time, end: s.end_time })),
  });
}));

router.post("/shifts", MANAGERS, h(async (req, res) => {
  const b = req.body || {};
  const userId = parseInt(b.user_id, 10);
  if (!isDate(b.date)) throw new BookingError("Choose a date.");
  const templates = await shiftTemplates();
  const t = templates.find((x) => x.name === b.name);
  if (!t) throw new BookingError("Choose a shift.");
  const u = await db.query("SELECT id FROM users WHERE id = $1 AND active = TRUE", [userId]);
  if (!u.rows.length) throw new BookingError("Team member not found.");
  const dup = await db.query("SELECT id FROM shifts WHERE user_id = $1 AND shift_date = $2 AND name = $3", [userId, b.date, t.name]);
  if (dup.rows.length) throw new BookingError("That shift is already on the rota.", 409);
  await db.query("INSERT INTO shifts (user_id, shift_date, name, start_time, end_time, created_by) VALUES ($1,$2,$3,$4,$5,$6)", [userId, b.date, t.name, t.start, t.end, req.user.id]);
  res.status(201).json({ ok: true });
}));

router.post("/shifts/:id/delete", MANAGERS, h(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const used = await db.query("SELECT id FROM attendance WHERE shift_id = $1", [id]);
  if (used.rows.length) throw new BookingError("Someone already clocked in for this shift, so it can't be removed.", 409);
  await db.query("DELETE FROM shifts WHERE id = $1", [id]);
  res.json({ ok: true });
}));

// Copy a week's rota to the following week (skips shifts that already exist).
router.post("/rota/copy", MANAGERS, h(async (req, res) => {
  const from = req.body?.from;
  if (!isDate(from)) throw new BookingError("Choose the week to copy.");
  const { rows } = await db.query("SELECT * FROM shifts WHERE shift_date >= $1 AND shift_date <= $2", [from, addDays(from, 6)]);
  let added = 0;
  for (const s of rows) {
    const date = addDays(db.toISODate(s.shift_date), 7);
    const dup = await db.query("SELECT id FROM shifts WHERE user_id = $1 AND shift_date = $2 AND name = $3", [s.user_id, date, s.name]);
    if (dup.rows.length) continue;
    await db.query("INSERT INTO shifts (user_id, shift_date, name, start_time, end_time, created_by) VALUES ($1,$2,$3,$4,$5,$6)", [s.user_id, date, s.name, s.start_time, s.end_time, req.user.id]);
    added++;
  }
  res.json({ added });
}));

/* ---------------- attendance report (managers) ---------------- */

async function attendanceReport(from, to) {
  const grace = Number(await getSetting("late_grace_minutes", "15"));
  const { rows: shifts } = await db.query(
    "SELECT s.*, u.name AS user_name FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.shift_date >= $1 AND s.shift_date <= $2 ORDER BY s.shift_date, s.start_time",
    [from, to]
  );
  const { rows: att } = await db.query(
    "SELECT a.*, u.name AS user_name FROM attendance a JOIN users u ON u.id = a.user_id WHERE a.clock_in >= $1 AND a.clock_in < $2 ORDER BY a.clock_in",
    [lagosStart(addDays(from, -1)), lagosStart(addDays(to, 2))]
  );
  const now = new Date();
  const used = new Set();
  const rowsOut = shifts.map((s) => {
    const w = shiftWindow(s);
    const a = att.find((x) => x.shift_id === s.id) ||
      att.find((x) => !used.has(x.id) && x.user_id === s.user_id && !x.shift_id && new Date(x.clock_in) >= new Date(w.start.getTime() - 2 * 3600e3) && new Date(x.clock_in) < w.end);
    if (a) used.add(a.id);
    let status, late = 0;
    if (a) {
      late = Math.max(0, Math.round((new Date(a.clock_in) - w.start) / 60000));
      status = late > grace ? "late" : "on_time";
    } else status = now < w.start ? "upcoming" : now < w.end ? "not_in_yet" : "missed";
    const hours = a && a.clock_out ? Math.round(((new Date(a.clock_out) - new Date(a.clock_in)) / 3600e3) * 10) / 10 : null;
    return { user_id: s.user_id, user: s.user_name, date: db.toISODate(s.shift_date), shift: s.name, start: s.start_time, end: s.end_time,
      clock_in: a ? a.clock_in : null, clock_out: a ? a.clock_out : null, late_minutes: late, hours, status };
  });
  for (const a of att) {
    if (used.has(a.id)) continue;
    const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date(a.clock_in));
    if (d < from || d > to) continue;
    rowsOut.push({ user_id: a.user_id, user: a.user_name, date: d, shift: "Not on rota", start: null, end: null, clock_in: a.clock_in, clock_out: a.clock_out,
      late_minutes: 0, hours: a.clock_out ? Math.round(((new Date(a.clock_out) - new Date(a.clock_in)) / 3600e3) * 10) / 10 : null, status: "unscheduled" });
  }
  rowsOut.sort((x, y) => (x.date + (x.start || "99")).localeCompare(y.date + (y.start || "99")));
  const people = {};
  for (const r of rowsOut) {
    const p = (people[r.user_id] = people[r.user_id] || { user_id: r.user_id, user: r.user, shifts: 0, attended: 0, late: 0, missed: 0, unscheduled: 0, hours: 0 });
    if (r.status === "unscheduled") p.unscheduled++;
    else if (!["upcoming", "not_in_yet"].includes(r.status)) p.shifts++; // only shifts that have already happened
    if (["on_time", "late"].includes(r.status)) p.attended++;
    if (r.status === "late") p.late++;
    if (r.status === "missed") p.missed++;
    p.hours = Math.round((p.hours + (r.hours || 0)) * 10) / 10;
  }
  return { from, to, grace_minutes: grace, rows: rowsOut, people: Object.values(people) };
}

router.get("/attendance", MANAGERS, h(async (req, res) => {
  const { from, to } = dateRange(req.query, { maxDays: 62 });
  res.json(await attendanceReport(from, to));
}));

router.get("/attendance.csv", MANAGERS, h(async (req, res) => {
  const { from, to } = dateRange(req.query, { maxDays: 62 });
  const r = await attendanceReport(from, to);
  const t = (v) => (v ? new Date(v).toLocaleTimeString("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit" }) : "");
  sendCsv(res, `attendance_${from}_to_${to}.csv`, csv(r.rows, [
    { label: "Date", get: "date" }, { label: "Staff", get: "user" }, { label: "Shift", get: "shift" }, { label: "Starts", get: "start" },
    { label: "Clocked in", get: (x) => t(x.clock_in) }, { label: "Clocked out", get: (x) => t(x.clock_out) },
    { label: "Minutes late", get: "late_minutes" }, { label: "Hours", get: "hours" }, { label: "Status", get: "status" },
  ]));
}));

/* ---------------- targets ---------------- */

router.get("/targets", MANAGERS, h(async (req, res) => {
  const month = monthOk(req.query.month) ? req.query.month : thisMonth();
  const team = await activeTeam();
  const { rows: t } = await db.query("SELECT * FROM staff_targets WHERE month = $1", [month]);
  const out = [];
  for (const u of team) {
    const c = await collectedBy(u.id, lagosStart(month + "-01"), lagosStart(nextMonth(month) + "-01"));
    const target = t.find((x) => x.user_id === u.id);
    out.push({ user_id: u.id, name: u.name, role: u.role, target: target ? Number(target.amount) : null, collected: c.total, payments: c.count });
  }
  res.json({ month, month_label: monthLabel(month), people: out });
}));

router.post("/targets", OWNER, h(async (req, res) => {
  const month = monthOk(req.body?.month) ? req.body.month : null;
  if (!month) throw new BookingError("Choose a month.");
  const userId = parseInt(req.body?.user_id, 10);
  const amount = toInt(req.body?.amount, { min: 0, max: 1000000000, name: "Target" });
  await db.query("DELETE FROM staff_targets WHERE user_id = $1 AND month = $2", [userId, month]);
  if (amount > 0) await db.query("INSERT INTO staff_targets (user_id, month, amount) VALUES ($1,$2,$3)", [userId, month, amount]);
  res.json({ ok: true });
}));

/* ---------------- pay details (owner) ---------------- */

router.get("/pay-details", OWNER, h(async (req, res) => {
  const team = await activeTeam();
  const { rows } = await db.query("SELECT * FROM staff_pay");
  res.json({ pay_day: Number(await getSetting("pay_day", "28")), people: team.map((u) => {
    const p = rows.find((x) => x.user_id === u.id) || {};
    return { ...u, monthly_salary: Number(p.monthly_salary || 0), bank_name: p.bank_name || "", account_number: p.account_number || "", account_name: p.account_name || "" };
  }) });
}));

router.post("/pay-details/:userId", OWNER, h(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const b = req.body || {};
  const salary = toInt(b.monthly_salary ?? 0, { max: 100000000, name: "Salary" });
  const acct = text(b.account_number, 20);
  if (acct && !/^\d{10}$/.test(acct)) throw new BookingError("Account number must be 10 digits (NUBAN).");
  await db.query("DELETE FROM staff_pay WHERE user_id = $1", [userId]);
  await db.query("INSERT INTO staff_pay (user_id, monthly_salary, bank_name, account_number, account_name) VALUES ($1,$2,$3,$4,$5)",
    [userId, salary, text(b.bank_name, 60) || null, acct || null, text(b.account_name, 100) || null]);
  res.json({ ok: true });
}));

/* ---------------- payroll ---------------- */

async function payrollRows(month) {
  const { rows } = await db.query(
    `SELECT p.id, p.month, p.user_id, p.base, p.deductions, p.bonus, p.note, p.status, p.paid_at, p.method, p.reference, (p.receipt IS NOT NULL) AS has_receipt,
            u.name, u.email, u.role, pb.name AS paid_by_name, sp.bank_name, sp.account_number, sp.account_name
       FROM payroll p JOIN users u ON u.id = p.user_id LEFT JOIN users pb ON pb.id = p.paid_by LEFT JOIN staff_pay sp ON sp.user_id = p.user_id
      WHERE p.month = $1 ORDER BY u.name`,
    [month]
  );
  return rows.map((r) => ({ ...r, base: Number(r.base), deductions: Number(r.deductions), bonus: Number(r.bonus), net: Number(r.base) - Number(r.deductions) + Number(r.bonus) }));
}

router.get("/payroll", MANAGERS, h(async (req, res) => {
  const month = monthOk(req.query.month) ? req.query.month : thisMonth();
  const items = await payrollRows(month);
  // Missed shifts this month, to help decide deductions.
  const last = addDays(nextMonth(month) + "-01", -1);
  const report = await attendanceReport(month + "-01", last < todayLagos() ? last : todayLagos() < month + "-01" ? month + "-01" : todayLagos());
  const missed = Object.fromEntries(report.people.map((p) => [p.user_id, { missed: p.missed, late: p.late }]));
  res.json({
    month, month_label: monthLabel(month), pay_day: Number(await getSetting("pay_day", "28")),
    items: items.map((i) => ({ ...i, attendance: missed[i.user_id] || { missed: 0, late: 0 } })),
    total_due: items.filter((i) => i.status === "due").reduce((s, i) => s + i.net, 0),
    total_paid: items.filter((i) => i.status === "paid").reduce((s, i) => s + i.net, 0),
  });
}));

// Create this month's payroll lines from each person's agreed salary.
router.post("/payroll/prepare", MANAGERS, h(async (req, res) => {
  const month = monthOk(req.body?.month) ? req.body.month : thisMonth();
  const { rows } = await db.query("SELECT sp.user_id, sp.monthly_salary FROM staff_pay sp JOIN users u ON u.id = sp.user_id WHERE u.active = TRUE AND sp.monthly_salary > 0");
  let added = 0;
  for (const r of rows) {
    const exists = await db.query("SELECT id FROM payroll WHERE month = $1 AND user_id = $2", [month, r.user_id]);
    if (exists.rows.length) continue;
    await db.query("INSERT INTO payroll (month, user_id, base) VALUES ($1,$2,$3)", [month, r.user_id, Number(r.monthly_salary)]);
    added++;
  }
  if (!rows.length) throw new BookingError("No salaries are set yet. The owner adds them under Payroll → Salaries & bank details.");
  res.json({ added });
}));

router.post("/payroll/:id/adjust", OWNER, h(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query("SELECT * FROM payroll WHERE id = $1", [id]);
  const p = rows[0];
  if (!p) throw new BookingError("Payroll line not found.", 404);
  if (p.status !== "due") throw new BookingError("This salary is already paid.", 409);
  const deductions = toInt(req.body?.deductions ?? 0, { max: Number(p.base), name: "Deductions" });
  const bonus = toInt(req.body?.bonus ?? 0, { max: 100000000, name: "Bonus" });
  await db.query("UPDATE payroll SET deductions=$2, bonus=$3, note=$4 WHERE id=$1", [id, deductions, bonus, text(req.body?.note, 300) || null]);
  res.json({ ok: true });
}));

router.post("/payroll/:id/pay", MANAGERS, h(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query("SELECT * FROM payroll WHERE id = $1", [id]);
  const p = rows[0];
  if (!p) throw new BookingError("Payroll line not found.", 404);
  if (p.status === "paid") throw new BookingError("This salary is already marked as paid.", 409);
  const method = ["transfer", "cash"].includes(req.body?.method) ? req.body.method : null;
  if (!method) throw new BookingError("Choose how it was paid.");
  const reference = text(req.body?.reference, 80) || null;
  let receipt = null;
  if (req.body?.receipt) {
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(req.body.receipt) || req.body.receipt.length > 1500000) throw new BookingError("The receipt must be a photo under about 1 MB.");
    receipt = req.body.receipt;
  }
  if (method === "transfer" && !reference && !receipt) throw new BookingError("For a transfer, add the transaction reference or a photo of the receipt.");
  await db.query("UPDATE payroll SET status='paid', paid_at=$2, method=$3, reference=$4, receipt=$5, paid_by=$6 WHERE id=$1", [id, new Date().toISOString(), method, reference, receipt, req.user.id]);
  const item = (await payrollRows(p.month)).find((x) => x.id === id);
  email.payslip({ ...item, month_label: monthLabel(p.month), method: method === "transfer" ? "Bank transfer" : "Cash" });
  res.json({ ok: true });
}));

router.get("/payroll/:id/receipt", MANAGERS, h(async (req, res) => {
  const { rows } = await db.query("SELECT receipt FROM payroll WHERE id = $1", [parseInt(req.params.id, 10)]);
  const r = rows[0] && rows[0].receipt;
  if (!r) return res.status(404).json({ error: "No receipt." });
  const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(r);
  res.setHeader("Content-Type", m[1]);
  res.send(Buffer.from(m[2], "base64"));
}));

router.get("/payroll.csv", MANAGERS, h(async (req, res) => {
  const month = monthOk(req.query.month) ? req.query.month : thisMonth();
  const items = await payrollRows(month);
  sendCsv(res, `payroll_${month}.csv`, csv(items, [
    { label: "Staff", get: "name" }, { label: "Role", get: "role" }, { label: "Basic (NGN)", get: "base" }, { label: "Deductions (NGN)", get: "deductions" },
    { label: "Bonus (NGN)", get: "bonus" }, { label: "Net (NGN)", get: "net" }, { label: "Bank", get: "bank_name" }, { label: "Account number", get: "account_number" },
    { label: "Account name", get: "account_name" }, { label: "Status", get: "status" }, { label: "Paid on", get: (r) => (r.paid_at ? new Date(r.paid_at).toLocaleDateString("en-GB", { timeZone: "Africa/Lagos" }) : "") },
    { label: "Method", get: "method" }, { label: "Reference", get: "reference" }, { label: "Note", get: "note" },
  ]));
}));

// Staff see their own payslips.
router.get("/my-payslips", ANY, h(async (req, res) => {
  const { rows } = await db.query("SELECT month, base, deductions, bonus, note, status, paid_at, method, reference FROM payroll WHERE user_id = $1 ORDER BY month DESC", [req.user.id]);
  const extras = await extrasList("x.user_id = $1 AND x.status IN ('approved','paid')", [req.user.id]);
  res.json({
    payslips: rows.map((r) => ({ ...r, month_label: monthLabel(r.month), base: Number(r.base), deductions: Number(r.deductions), bonus: Number(r.bonus), net: Number(r.base) - Number(r.deductions) + Number(r.bonus) })),
    extras: extras.map((x) => ({ kind_label: x.kind_label, period: x.period, amount: x.amount, reason: x.reason, status: x.status, paid_at: x.paid_at })),
  });
}));

/* ---------------- birthdays ---------------- */

const MD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
function validBirthday(v) {
  if (v === "" || v == null) return null;
  if (!MD.test(v)) throw new BookingError("Choose a day and month for the birthday.");
  const [m, d] = v.split("-").map(Number);
  if (d > [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]) throw new BookingError("That date doesn't exist.");
  return v;
}
// Next occurrence of a MM-DD birthday on or after today (29 Feb falls on 28 Feb in other years).
function nextBirthday(md, today) {
  const y = Number(today.slice(0, 4));
  const isLeap = (yr) => (yr % 4 === 0 && yr % 100 !== 0) || yr % 400 === 0;
  const on = (yr) => (md === "02-29" && !isLeap(yr) ? `${yr}-02-28` : `${yr}-${md}`);
  return on(y) >= today ? on(y) : on(y + 1);
}

router.get("/birthdays", ANY, h(async (req, res) => {
  const today = todayLagos(), year = Number(today.slice(0, 4));
  const { rows } = await db.query("SELECT id, name, role, birthday FROM users WHERE active = TRUE ORDER BY name");
  const people = rows.map((u) => {
    if (!u.birthday) return { user_id: u.id, name: u.name, role: u.role, birthday: null };
    const next = nextBirthday(u.birthday, today);
    return { user_id: u.id, name: u.name, role: u.role, birthday: u.birthday, next, days: Math.round((Date.parse(next) - Date.parse(today)) / 864e5) };
  });
  const todays = people.filter((p) => p.days === 0);
  const { rows: wishes } = await db.query(
    `SELECT w.user_id, w.from_user_id, w.message, w.created_at, u.name AS from_name
       FROM birthday_wishes w JOIN users u ON u.id = w.from_user_id WHERE w.year = $1 ORDER BY w.created_at`,
    [year]
  );
  res.json({
    today,
    mine: people.find((p) => p.user_id === req.user.id) || null,
    today_birthdays: todays.map((p) => ({ ...p, wishes: wishes.filter((w) => w.user_id === p.user_id), i_wished: wishes.some((w) => w.user_id === p.user_id && w.from_user_id === req.user.id) })),
    upcoming: people.filter((p) => p.birthday && p.days > 0 && p.days <= 30).sort((a, b) => a.days - b.days),
    people: req.user.role === "staff" ? undefined : people,
  });
}));

// Set your own birthday.
router.post("/birthday", ANY, h(async (req, res) => {
  await db.query("UPDATE users SET birthday = $2 WHERE id = $1", [req.user.id, validBirthday(req.body?.birthday)]);
  res.json({ ok: true });
}));

// Owner or manager sets a team member's birthday.
router.post("/birthday/:userId", MANAGERS, h(async (req, res) => {
  const r = await db.query("UPDATE users SET birthday = $2 WHERE id = $1 RETURNING id", [parseInt(req.params.userId, 10), validBirthday(req.body?.birthday)]);
  if (!r.rows.length) throw new BookingError("Team member not found.", 404);
  res.json({ ok: true });
}));

// Send (or update) birthday wishes to a teammate on their birthday.
router.post("/birthdays/:userId/wish", ANY, h(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (userId === req.user.id) throw new BookingError("You can't send wishes to yourself, but happy birthday!");
  const message = text(req.body?.message, 300);
  if (!message) throw new BookingError("Write a short message.");
  const today = todayLagos(), year = Number(today.slice(0, 4));
  const { rows } = await db.query("SELECT birthday FROM users WHERE id = $1 AND active = TRUE", [userId]);
  if (!rows[0] || !rows[0].birthday || nextBirthday(rows[0].birthday, today) !== today) throw new BookingError("It's not their birthday today.");
  await db.query("DELETE FROM birthday_wishes WHERE user_id = $1 AND from_user_id = $2 AND year = $3", [userId, req.user.id, year]);
  await db.query("INSERT INTO birthday_wishes (user_id, from_user_id, year, message) VALUES ($1,$2,$3,$4)", [userId, req.user.id, year, message]);
  res.status(201).json({ ok: true });
}));

/* ---------------- bonuses and off-cycle payments ---------------- */

const EXTRA_KINDS = { bonus: "Bonus", quarterly: "Quarterly payment", target: "Target reward", other: "Other payment" };

async function extrasList(where = "TRUE", params = []) {
  const { rows } = await db.query(
    `SELECT x.id, x.user_id, x.kind, x.period, x.amount, x.reason, x.status, x.paid_at, x.method, x.reference, x.review_note, x.created_at,
            (x.receipt IS NOT NULL) AS has_receipt, u.name, u.email, u.role, c.name AS created_by_name, a.name AS approved_by_name, pb.name AS paid_by_name,
            sp.bank_name, sp.account_number, sp.account_name
       FROM extra_payments x JOIN users u ON u.id = x.user_id LEFT JOIN users c ON c.id = x.created_by LEFT JOIN users a ON a.id = x.approved_by
       LEFT JOIN users pb ON pb.id = x.paid_by LEFT JOIN staff_pay sp ON sp.user_id = x.user_id
      WHERE ${where} ORDER BY x.created_at DESC`,
    params
  );
  return rows.map((r) => ({ ...r, amount: Number(r.amount), kind_label: EXTRA_KINDS[r.kind] || r.kind, has_receipt: Boolean(r.has_receipt) }));
}

router.get("/extras", MANAGERS, h(async (req, res) => {
  const status = ["pending", "approved", "paid", "rejected"].includes(req.query.status) ? req.query.status : null;
  const items = await extrasList(status ? "x.status = $1" : "TRUE", status ? [status] : []);
  res.json({ kinds: EXTRA_KINDS, items,
    totals: { pending: items.filter((i) => i.status === "pending").reduce((s, i) => s + i.amount, 0),
              to_pay: items.filter((i) => i.status === "approved").reduce((s, i) => s + i.amount, 0) } });
}));

router.post("/extras", MANAGERS, h(async (req, res) => {
  const b = req.body || {};
  const userId = parseInt(b.user_id, 10);
  const u = await db.query("SELECT id FROM users WHERE id = $1 AND active = TRUE", [userId]);
  if (!u.rows.length) throw new BookingError("Choose who it's for.");
  if (!EXTRA_KINDS[b.kind]) throw new BookingError("Choose the type of payment.");
  const amount = toInt(b.amount, { min: 1, max: 100000000, name: "Amount" });
  const reason = text(b.reason, 300);
  if (!reason) throw new BookingError("Say what it's for, e.g. 'Hit November collection target'.");
  const status = req.user.role === "owner" ? "approved" : "pending";
  await db.query(
    "INSERT INTO extra_payments (user_id, kind, period, amount, reason, status, created_by, approved_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [userId, b.kind, text(b.period, 40) || null, amount, reason, status, req.user.id, status === "approved" ? req.user.id : null]
  );
  res.status(201).json({ status });
}));

async function reviewExtra(req, res, status) {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query("SELECT status FROM extra_payments WHERE id = $1", [id]);
  if (!rows[0]) throw new BookingError("Payment not found.", 404);
  if (rows[0].status !== "pending") throw new BookingError("This payment has already been reviewed.", 409);
  await db.query("UPDATE extra_payments SET status=$2, approved_by=$3, review_note=$4 WHERE id=$1", [id, status, req.user.id, text(req.body?.note, 300) || null]);
  res.json({ ok: true });
}
router.post("/extras/:id/approve", OWNER, h((req, res) => reviewExtra(req, res, "approved")));
router.post("/extras/:id/reject", OWNER, h((req, res) => reviewExtra(req, res, "rejected")));

router.post("/extras/:id/pay", MANAGERS, h(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query("SELECT status FROM extra_payments WHERE id = $1", [id]);
  if (!rows[0]) throw new BookingError("Payment not found.", 404);
  if (rows[0].status === "pending") throw new BookingError("The owner needs to approve this payment first.", 409);
  if (rows[0].status !== "approved") throw new BookingError("This payment is already paid or was rejected.", 409);
  const method = ["transfer", "cash"].includes(req.body?.method) ? req.body.method : null;
  if (!method) throw new BookingError("Choose how it was paid.");
  const reference = text(req.body?.reference, 80) || null;
  let receipt = null;
  if (req.body?.receipt) {
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(req.body.receipt) || req.body.receipt.length > 1500000) throw new BookingError("The receipt must be a photo under about 1 MB.");
    receipt = req.body.receipt;
  }
  if (method === "transfer" && !reference && !receipt) throw new BookingError("For a transfer, add the transaction reference or a photo of the receipt.");
  await db.query("UPDATE extra_payments SET status='paid', paid_at=$2, method=$3, reference=$4, receipt=$5, paid_by=$6 WHERE id=$1",
    [id, new Date().toISOString(), method, reference, receipt, req.user.id]);
  const item = (await extrasList("x.id = $1", [id]))[0];
  email.extraPayment({ ...item, method_label: method === "transfer" ? "Bank transfer" : "Cash" });
  res.json({ ok: true });
}));

router.get("/extras/:id/receipt", MANAGERS, h(async (req, res) => {
  const { rows } = await db.query("SELECT receipt FROM extra_payments WHERE id = $1", [parseInt(req.params.id, 10)]);
  const r = rows[0] && rows[0].receipt;
  if (!r) return res.status(404).json({ error: "No receipt." });
  const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(r);
  res.setHeader("Content-Type", m[1]);
  res.send(Buffer.from(m[2], "base64"));
}));

router.get("/extras.csv", MANAGERS, h(async (req, res) => {
  const items = await extrasList();
  sendCsv(res, "bonuses_and_off_cycle_payments.csv", csv(items, [
    { label: "Created", get: (r) => new Date(r.created_at).toLocaleDateString("en-GB", { timeZone: "Africa/Lagos" }) },
    { label: "Staff", get: "name" }, { label: "Type", get: "kind_label" }, { label: "Period", get: "period" }, { label: "Amount (NGN)", get: "amount" },
    { label: "Reason", get: "reason" }, { label: "Status", get: "status" }, { label: "Requested by", get: "created_by_name" }, { label: "Approved by", get: "approved_by_name" },
    { label: "Paid on", get: (r) => (r.paid_at ? new Date(r.paid_at).toLocaleDateString("en-GB", { timeZone: "Africa/Lagos" }) : "") },
    { label: "Method", get: "method" }, { label: "Reference", get: "reference" },
  ]));
}));

/* ---------------- team settings (owner) ---------------- */

router.get("/settings", MANAGERS, h(async (req, res) => {
  res.json({ ...(await teamSettings()), clockin_site_code: req.user.role === "owner" ? await getSetting("clockin_site_code", "") : undefined });
}));

router.post("/settings", OWNER, h(async (req, res) => {
  const b = req.body || {};
  if (Array.isArray(b.shift_templates)) {
    const list = b.shift_templates.map((t) => ({ name: text(t.name, 30), start: String(t.start || ""), end: String(t.end || "") })).filter((t) => t.name);
    if (!list.length) throw new BookingError("Keep at least one shift.");
    for (const t of list) if (!TIME.test(t.start) || !TIME.test(t.end)) throw new BookingError(`Use 24-hour times like 07:00 for the ${t.name} shift.`);
    if (new Set(list.map((t) => t.name.toLowerCase())).size !== list.length) throw new BookingError("Each shift needs a different name.");
    await setSetting("shift_templates", JSON.stringify(list));
  }
  if (b.late_grace_minutes != null) await setSetting("late_grace_minutes", toInt(b.late_grace_minutes, { max: 240, name: "Grace period" }));
  if (b.pay_day != null) await setSetting("pay_day", toInt(b.pay_day, { min: 1, max: 31, name: "Pay day" }));
  if (b.clockin_site_code != null) {
    const code = text(String(b.clockin_site_code), 12).toUpperCase();
    if (code && !/^[A-Z0-9]{4,12}$/.test(code)) throw new BookingError("The site code should be 4–12 letters or numbers.");
    await setSetting("clockin_site_code", code);
  }
  if (b.new_site_code) await setSetting("clockin_site_code", crypto.randomBytes(3).toString("hex").toUpperCase());
  res.json({ ...(await teamSettings()), clockin_site_code: await getSetting("clockin_site_code", "") });
}));

module.exports = router;
module.exports.monthLabel = monthLabel;
module.exports.nextMonth = nextMonth;
