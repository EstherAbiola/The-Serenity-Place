// Operating expenses: the manager (or owner) logs costs; the owner approves those above a limit.
const express = require("express");
const db = require("./db");
const { requireRole } = require("./auth");
const { h, isDate, dateRange, csv, sendCsv, getSetting, toInt, text, BookingError } = require("./util");
const { todayLagos } = require("./booking");

const MANAGERS = requireRole("owner", "manager");
const OWNER = requireRole("owner");
const router = express.Router();

const CATEGORIES = ["Maintenance & repairs", "Power & diesel", "Water", "Cleaning supplies", "Laundry & linen", "Security", "Internet & phone", "Salaries & wages", "Transport", "Other"];
const METHODS = ["cash", "transfer", "pos"];
const MAX_RECEIPT_CHARS = 1_500_000; // about 1.1 MB image

function shape(r) {
  return {
    id: r.id, spent_on: db.toISODate(r.spent_on), category: r.category, room_id: r.room_id, room: r.room_name || null,
    description: r.description, amount: Number(r.amount), paid_to: r.paid_to, method: r.method,
    has_receipt: Boolean(r.has_receipt), status: r.status, review_note: r.review_note,
    created_by: r.created_by_name, reviewed_by: r.reviewed_by_name, created_at: r.created_at,
  };
}

async function list(from, to, status) {
  const params = [from, to];
  let where = "e.spent_on >= $1 AND e.spent_on <= $2";
  if (status) { params.push(status); where += " AND e.status = $3"; }
  const { rows } = await db.query(
    `SELECT e.id, e.spent_on, e.category, e.room_id, e.description, e.amount, e.paid_to, e.method, e.status, e.review_note, e.created_at,
            (e.receipt IS NOT NULL) AS has_receipt, r.name AS room_name, u.name AS created_by_name, v.name AS reviewed_by_name
       FROM expenses e LEFT JOIN rooms r ON r.id = e.room_id LEFT JOIN users u ON u.id = e.created_by LEFT JOIN users v ON v.id = e.reviewed_by
      WHERE ${where} ORDER BY e.spent_on DESC, e.id DESC`,
    params
  );
  return rows.map(shape);
}

router.get("/meta", MANAGERS, h(async (req, res) => {
  const { rows: rooms } = await db.query("SELECT id, name FROM rooms ORDER BY name");
  res.json({ categories: CATEGORIES, methods: METHODS, rooms, approval_limit: Number(await getSetting("expense_approval_limit", "50000")), today: todayLagos() });
}));

router.get("/", MANAGERS, h(async (req, res) => {
  const { from, to } = dateRange(req.query);
  const status = ["approved", "pending", "rejected"].includes(req.query.status) ? req.query.status : null;
  const items = await list(from, to, status);
  const total = items.filter((e) => e.status === "approved").reduce((s, e) => s + e.amount, 0);
  const byCategory = {};
  for (const e of items) if (e.status === "approved") byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
  const byRoom = {};
  for (const e of items) if (e.status === "approved" && e.room) byRoom[e.room] = (byRoom[e.room] || 0) + e.amount;
  res.json({ from, to, expenses: items, approved_total: total, by_category: byCategory, by_room: byRoom,
    pending: items.filter((e) => e.status === "pending").length });
}));

router.post("/", MANAGERS, h(async (req, res) => {
  const b = req.body || {};
  const spentOn = isDate(b.spent_on) ? b.spent_on : todayLagos();
  if (spentOn > todayLagos()) throw new BookingError("The expense date can't be in the future.");
  const category = CATEGORIES.includes(b.category) ? b.category : null;
  if (!category) throw new BookingError("Choose a category.");
  const description = text(b.description, 300);
  if (!description) throw new BookingError("Describe what the money was spent on, e.g. 'Electrician fixed ceiling fan'.");
  const amount = toInt(b.amount, { min: 1, max: 100000000, name: "Amount" });
  const method = METHODS.includes(b.method) ? b.method : null;
  let roomId = null;
  if (b.room_id) {
    const r = await db.query("SELECT id FROM rooms WHERE id = $1", [parseInt(b.room_id, 10)]);
    if (!r.rows.length) throw new BookingError("Room not found.");
    roomId = r.rows[0].id;
  }
  let receipt = null;
  if (b.receipt) {
    if (typeof b.receipt !== "string" || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.receipt)) throw new BookingError("The receipt must be a photo (JPEG, PNG or WebP).");
    if (b.receipt.length > MAX_RECEIPT_CHARS) throw new BookingError("The receipt photo is too large. Please take a smaller photo.");
    receipt = b.receipt;
  }
  const limit = Number(await getSetting("expense_approval_limit", "50000"));
  const status = req.user.role === "owner" || amount <= limit ? "approved" : "pending";
  await db.query(
    `INSERT INTO expenses (spent_on, category, room_id, description, amount, paid_to, method, receipt, status, created_by, reviewed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [spentOn, category, roomId, description, amount, text(b.paid_to, 120) || null, method, receipt, status, req.user.id, status === "approved" && req.user.role === "owner" ? req.user.id : null]
  );
  res.status(201).json({ status, needs_approval: status === "pending", limit });
}));

router.get("/:id/receipt", MANAGERS, h(async (req, res) => {
  const { rows } = await db.query("SELECT receipt FROM expenses WHERE id = $1", [parseInt(req.params.id, 10)]);
  const r = rows[0] && rows[0].receipt;
  if (!r) return res.status(404).json({ error: "No receipt for this expense." });
  const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(r);
  res.setHeader("Content-Type", m[1]);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(Buffer.from(m[2], "base64"));
}));

async function review(req, res, status) {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query("SELECT status FROM expenses WHERE id = $1", [id]);
  if (!rows[0]) throw new BookingError("Expense not found.", 404);
  if (rows[0].status !== "pending") throw new BookingError("This expense has already been reviewed.", 409);
  await db.query("UPDATE expenses SET status=$2, reviewed_by=$3, review_note=$4 WHERE id=$1", [id, status, req.user.id, text(req.body?.note, 300) || null]);
  res.json({ ok: true });
}
router.post("/:id/approve", OWNER, h((req, res) => review(req, res, "approved")));
router.post("/:id/reject", OWNER, h((req, res) => review(req, res, "rejected")));

router.get("/export.csv", MANAGERS, h(async (req, res) => {
  const { from, to } = dateRange(req.query);
  const items = await list(from, to);
  sendCsv(res, `expenses_${from}_to_${to}.csv`, csv(items, [
    { label: "Date", get: "spent_on" }, { label: "Category", get: "category" }, { label: "Room", get: "room" },
    { label: "Description", get: "description" }, { label: "Amount (NGN)", get: "amount" }, { label: "Paid to", get: "paid_to" },
    { label: "Method", get: "method" }, { label: "Status", get: "status" }, { label: "Logged by", get: "created_by" },
    { label: "Reviewed by", get: "reviewed_by" }, { label: "Receipt", get: (e) => (e.has_receipt ? "Yes" : "No") },
  ]));
}));

module.exports = router;
