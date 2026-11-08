// Operating expenses: the manager (or owner) logs costs; the owner approves those above a limit.
const express = require("express");
const db = require("./db");
const { requireRole } = require("./auth");
const { h, isDate, dateRange, csv, sendCsv, getSetting, toInt, text, BookingError } = require("./util");
const { todayLagos } = require("./booking");

const MANAGERS = requireRole("owner", "manager");
const OWNER = requireRole("owner");
const router = express.Router();

const CATEGORIES = ["Maintenance & repairs", "Power & diesel", "Water", "Cleaning supplies", "Laundry & linen", "Security", "Internet & phone", "Transport", "Other"]; // salaries go through Payroll
const METHODS = ["cash", "transfer", "pos"];
const MAX_RECEIPT_CHARS = 1_500_000; // about 1.1 MB image
const MAX_DOC_CHARS = 2_000_000;     // about 1.5 MB photo or PDF
// Categories where the manager must upload proof that the work was done and sign it off.
const WORK_CATEGORIES = ["Maintenance & repairs"];
const repeatWindow = async () => Number(await getSetting("repeat_window_days", "30"));

function shape(r) {
  return {
    item: r.item || null, has_work_doc: Boolean(r.has_work_doc), work_doc_name: r.work_doc_name || null,
    completion_confirmed: Boolean(r.completion_confirmed), confirmed_by: r.confirmed_by || null, completion_note: r.completion_note || null,
    repeat_of: r.repeat_of || null, repeat_reason: r.repeat_reason || null,
    id: r.id, spent_on: db.toISODate(r.spent_on), category: r.category, room_id: r.room_id, room: r.room_name || null,
    description: r.description, amount: Number(r.amount), paid_to: r.paid_to, method: r.method,
    has_receipt: Boolean(r.has_receipt), status: r.status, review_note: r.review_note,
    created_by: r.created_by_name, reviewed_by: r.reviewed_by_name, created_at: r.created_at,
  };
}

async function list(from, to, status, roomId) {
  const params = [from, to];
  let where = "e.spent_on >= $1 AND e.spent_on <= $2";
  if (status) { params.push(status); where += ` AND e.status = $${params.length}`; }
  if (roomId) { params.push(roomId); where += ` AND e.room_id = $${params.length}`; }
  const { rows } = await db.query(
    `SELECT e.id, e.spent_on, e.category, e.room_id, e.description, e.amount, e.paid_to, e.method, e.status, e.review_note, e.created_at,
            e.item, e.work_doc_name, e.completion_confirmed, e.confirmed_by, e.completion_note, e.repeat_of, e.repeat_reason,
            (e.receipt IS NOT NULL) AS has_receipt, (e.work_doc IS NOT NULL) AS has_work_doc, r.name AS room_name, u.name AS created_by_name, v.name AS reviewed_by_name
       FROM expenses e LEFT JOIN rooms r ON r.id = e.room_id LEFT JOIN users u ON u.id = e.created_by LEFT JOIN users v ON v.id = e.reviewed_by
      WHERE ${where} ORDER BY e.spent_on DESC, e.id DESC`,
    params
  );
  const out = rows.map(shape);
  const prevIds = [...new Set(out.filter((e) => e.repeat_of).map((e) => e.repeat_of))];
  for (const pid of prevIds) {
    const prev = await earlier(pid);
    for (const e of out) if (e.repeat_of === pid) e.previous = prev;
  }
  return out;
}

async function earlier(id) {
  const { rows } = await db.query(
    `SELECT e.id, e.spent_on, e.item, e.description, e.amount, e.paid_to, e.status, e.completion_confirmed, e.confirmed_by,
            (e.receipt IS NOT NULL) AS has_receipt, (e.work_doc IS NOT NULL) AS has_work_doc, u.name AS created_by_name
       FROM expenses e LEFT JOIN users u ON u.id = e.created_by WHERE e.id = $1`,
    [id]
  );
  const r = rows[0];
  return r ? { id: r.id, spent_on: db.toISODate(r.spent_on), item: r.item, description: r.description, amount: Number(r.amount), paid_to: r.paid_to,
    status: r.status, completion_confirmed: Boolean(r.completion_confirmed), confirmed_by: r.confirmed_by, has_receipt: Boolean(r.has_receipt),
    has_work_doc: Boolean(r.has_work_doc), created_by: r.created_by_name } : null;
}

// Earlier expenses for the same room and item within the repeat window (most recent first).
async function findRepeats(roomId, item, category, spentOn) {
  if (!roomId || !item) return [];
  const days = await repeatWindow();
  const from = require("./util").addDays(spentOn, -days);
  const { rows } = await db.query(
    `SELECT id FROM expenses WHERE room_id = $1 AND category = $2 AND LOWER(item) = LOWER($3)
        AND spent_on >= $4 AND spent_on <= $5 AND status <> 'rejected' ORDER BY spent_on DESC, id DESC`,
    [roomId, category, item.trim(), from, spentOn]
  );
  const out = [];
  for (const r of rows) out.push(await earlier(r.id));
  return out;
}

router.get("/meta", MANAGERS, h(async (req, res) => {
  const { rows: rooms } = await db.query("SELECT id, name FROM rooms ORDER BY name");
  const { rows: items } = await db.query("SELECT DISTINCT item FROM expenses WHERE item IS NOT NULL ORDER BY item");
  res.json({ categories: CATEGORIES, work_categories: WORK_CATEGORIES, methods: METHODS, rooms, items: items.map((i) => i.item),
    approval_limit: Number(await getSetting("expense_approval_limit", "50000")), repeat_window_days: await repeatWindow(), today: todayLagos() });
}));

// Live check while the form is being filled: has this item in this room been fixed recently?
router.get("/check-repeat", MANAGERS, h(async (req, res) => {
  const spentOn = isDate(req.query.spent_on) ? req.query.spent_on : todayLagos();
  const matches = await findRepeats(parseInt(req.query.room_id, 10) || null, text(req.query.item, 80), text(req.query.category, 60), spentOn);
  res.json({ window_days: await repeatWindow(), matches });
}));

// Every expense logged against a room: its maintenance history.
router.get("/room-history/:roomId", MANAGERS, h(async (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  const { rows } = await db.query("SELECT name FROM rooms WHERE id = $1", [roomId]);
  if (!rows[0]) throw new BookingError("Room not found.", 404);
  const items = await list("1900-01-01", "2999-12-31", null, roomId);
  res.json({ room: rows[0].name, expenses: items, total: items.filter((e) => e.status === "approved").reduce((s, e) => s + e.amount, 0) });
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
  const isManager = req.user.role !== "owner";
  const needsWork = WORK_CATEGORIES.includes(category);
  const item = text(b.item, 80) || null;
  if (needsWork && !item) throw new BookingError("Say what was fixed, e.g. 'Ceiling fan' or 'Water pump'.");

  let receipt = null;
  if (b.receipt) {
    if (typeof b.receipt !== "string" || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.receipt)) throw new BookingError("The receipt must be a photo (JPEG, PNG or WebP).");
    if (b.receipt.length > MAX_RECEIPT_CHARS) throw new BookingError("The receipt photo is too large. Please take a smaller photo.");
    receipt = b.receipt;
  }
  if (isManager && !receipt) throw new BookingError("Upload a photo of the receipt.");

  let workDoc = null, workDocName = null;
  if (b.work_doc) {
    if (typeof b.work_doc !== "string" || !/^data:(image\/(jpeg|png|webp)|application\/pdf);base64,[A-Za-z0-9+/=]+$/.test(b.work_doc)) throw new BookingError("The work-done document must be a photo or a PDF.");
    if (b.work_doc.length > MAX_DOC_CHARS) throw new BookingError("The work-done document is too large (about 1.5 MB maximum).");
    workDoc = b.work_doc;
    workDocName = (text(b.work_doc_name, 120) || "work-done").replace(/[^\w.\- ]/g, "_");
  }
  const confirmed = b.completion_confirmed === true;
  const confirmedBy = text(b.confirmed_by, 100) || null;
  if (needsWork && isManager) {
    if (!workDoc) throw new BookingError("Upload the signed work-done (completion) document.");
    if (!confirmed || !confirmedBy) throw new BookingError("Confirm the work is complete and working, and enter the name of the person signing off.");
  }

  // Repeat repair: same room and item fixed within the window.
  const repeats = await findRepeats(roomId, item, category, spentOn);
  const repeatOf = repeats.length ? repeats[0].id : null;
  const repeatReason = text(b.repeat_reason, 500) || null;
  if (repeatOf && !repeatReason) {
    return res.status(409).json({ error: `${item} in this room was already paid for on ${repeats[0].spent_on}. Explain what went wrong before logging it again.`, code: "repeat", matches: repeats });
  }

  const limit = Number(await getSetting("expense_approval_limit", "50000"));
  // Repeats always go to the owner for review, whatever the amount.
  const status = req.user.role === "owner" ? "approved" : repeatOf || amount > limit ? "pending" : "approved";
  await db.query(
    `INSERT INTO expenses (spent_on, category, room_id, description, amount, paid_to, method, receipt, status, created_by, reviewed_by,
                           item, work_doc, work_doc_name, completion_confirmed, confirmed_by, completion_note, repeat_of, repeat_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [spentOn, category, roomId, description, amount, text(b.paid_to, 120) || null, method, receipt, status, req.user.id, status === "approved" && req.user.role === "owner" ? req.user.id : null,
     item, workDoc, workDocName, confirmed, confirmedBy, text(b.completion_note, 300) || null, repeatOf, repeatReason]
  );
  res.status(201).json({ status, needs_approval: status === "pending", limit, repeat: Boolean(repeatOf) });
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

router.get("/:id/work-doc", MANAGERS, h(async (req, res) => {
  const { rows } = await db.query("SELECT work_doc, work_doc_name FROM expenses WHERE id = $1", [parseInt(req.params.id, 10)]);
  const r = rows[0];
  if (!r || !r.work_doc) return res.status(404).json({ error: "No work-done document for this expense." });
  const m = /^data:([a-z/.+-]+);base64,(.+)$/.exec(r.work_doc);
  res.setHeader("Content-Type", m[1]);
  res.setHeader("Content-Disposition", `inline; filename="${r.work_doc_name || "work-done"}"`);
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
    { label: "Item", get: "item" }, { label: "Work-done document", get: (e) => (e.has_work_doc ? "Yes" : "No") },
    { label: "Signed off by", get: (e) => (e.completion_confirmed ? e.confirmed_by : "") },
    { label: "Repeat of earlier fix", get: (e) => (e.previous ? `${e.previous.spent_on}: ${e.previous.description}` : "") },
    { label: "Why fixed again", get: "repeat_reason" },
  ]));
}));

module.exports = router;
