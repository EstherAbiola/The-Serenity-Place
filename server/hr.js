// HR documents: employment letters, contracts and other staff records, with renewal tracking.
// Only the owner can upload, renew or archive. Each person can view their own documents.
const express = require("express");
const db = require("./db");
const { requireRole } = require("./auth");
const { todayLagos } = require("./booking");
const { h, isDate, addDays, text, BookingError } = require("./util");

const ANY = requireRole("owner", "manager", "staff");
const OWNER = requireRole("owner");
const router = express.Router();

const TYPES = {
  employment_letter: "Employment letter",
  contract: "Contract",
  guarantor: "Guarantor form",
  id: "ID document",
  other: "Other document",
};
const FILE_TYPES = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
};
const MAX_FILE_CHARS = 2_900_000; // about 2 MB

function shape(r, today) {
  const expires = r.expires_on ? db.toISODate(r.expires_on) : null;
  const days = expires ? Math.round((Date.parse(expires) - Date.parse(today)) / 864e5) : null;
  return {
    id: r.id, user_id: r.user_id, user: r.user_name, doc_type: r.doc_type, type_label: TYPES[r.doc_type] || r.doc_type,
    title: r.title, file_name: r.file_name, starts_on: r.starts_on ? db.toISODate(r.starts_on) : null, expires_on: expires,
    days_left: days, expiry: !expires || r.status !== "active" ? null : days < 0 ? "expired" : days <= 60 ? "soon" : "ok",
    notes: r.notes, status: r.status, replaces_id: r.replaces_id, uploaded_by: r.uploaded_by_name, created_at: r.created_at,
  };
}

async function listDocs(where, params) {
  const today = todayLagos();
  const { rows } = await db.query(
    `SELECT d.id, d.user_id, d.doc_type, d.title, d.file_name, d.starts_on, d.expires_on, d.notes, d.status, d.replaces_id, d.created_at,
            u.name AS user_name, b.name AS uploaded_by_name
       FROM staff_documents d JOIN users u ON u.id = d.user_id LEFT JOIN users b ON b.id = d.uploaded_by
      WHERE ${where} ORDER BY d.status, d.created_at DESC`,
    params
  );
  return rows.map((r) => shape(r, today));
}

router.get("/types", ANY, h(async (req, res) => res.json({ types: TYPES })));

// Owner: all documents, or one person's. Everyone else: their own.
router.get("/documents", ANY, h(async (req, res) => {
  if (req.user.role !== "owner") return res.json({ documents: await listDocs("d.user_id = $1 AND d.status <> 'archived'", [req.user.id]) });
  const uid = parseInt(req.query.user_id, 10);
  res.json({ documents: uid ? await listDocs("d.user_id = $1", [uid]) : await listDocs("TRUE", []) });
}));

// Owner: active documents that have expired or expire within N days (default 60).
router.get("/expiring", OWNER, h(async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 60, 1), 365);
  const docs = await listDocs("d.status = 'active' AND d.expires_on IS NOT NULL AND d.expires_on <= $1", [addDays(todayLagos(), days)]);
  res.json({ days, documents: docs.sort((a, b) => a.days_left - b.days_left) });
}));

// Owner uploads a document (or a renewal that replaces an older one).
router.post("/documents", OWNER, h(async (req, res) => {
  const b = req.body || {};
  const userId = parseInt(b.user_id, 10);
  const u = await db.query("SELECT id FROM users WHERE id = $1", [userId]);
  if (!u.rows.length) throw new BookingError("Choose a team member.");
  if (!TYPES[b.doc_type]) throw new BookingError("Choose the type of document.");
  const title = text(b.title, 120) || TYPES[b.doc_type];
  const m = /^data:([a-z/.+-]+);base64,[A-Za-z0-9+/=]+$/.exec(String(b.file || ""));
  if (!m || !FILE_TYPES[m[1]]) throw new BookingError("Attach the document as a PDF, Word file or photo.");
  if (b.file.length > MAX_FILE_CHARS) throw new BookingError("The file is too large (2 MB maximum). Try a PDF or a smaller scan.");
  const fileName = (text(b.file_name, 120) || `${b.doc_type}.${FILE_TYPES[m[1]]}`).replace(/[^\w.\- ]/g, "_");
  const starts = b.starts_on ? (isDate(b.starts_on) ? b.starts_on : null) : null;
  const expires = b.expires_on ? (isDate(b.expires_on) ? b.expires_on : null) : null;
  if ((b.starts_on && !starts) || (b.expires_on && !expires)) throw new BookingError("Check the dates.");
  if (starts && expires && expires <= starts) throw new BookingError("The end date must be after the start date.");
  let replaces = null;
  if (b.replaces_id) {
    const r = await db.query("SELECT id, user_id, status FROM staff_documents WHERE id = $1", [parseInt(b.replaces_id, 10)]);
    if (!r.rows[0] || r.rows[0].user_id !== userId) throw new BookingError("The document being renewed was not found for this person.");
    replaces = r.rows[0].id;
  }
  await db.tx(async (c) => {
    await c.query(
      `INSERT INTO staff_documents (user_id, doc_type, title, file, file_name, starts_on, expires_on, notes, replaces_id, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [userId, b.doc_type, title, b.file, fileName, starts, expires, text(b.notes, 500) || null, replaces, req.user.id]
    );
    if (replaces) await c.query("UPDATE staff_documents SET status = 'renewed' WHERE id = $1", [replaces]);
  });
  res.status(201).json({ ok: true });
}));

router.post("/documents/:id", OWNER, h(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rows } = await db.query("SELECT * FROM staff_documents WHERE id = $1", [id]);
  const d = rows[0];
  if (!d) throw new BookingError("Document not found.", 404);
  const b = req.body || {};
  const starts = b.starts_on === "" ? null : b.starts_on != null ? (isDate(b.starts_on) ? b.starts_on : "x") : d.starts_on;
  const expires = b.expires_on === "" ? null : b.expires_on != null ? (isDate(b.expires_on) ? b.expires_on : "x") : d.expires_on;
  if (starts === "x" || expires === "x") throw new BookingError("Check the dates.");
  await db.query("UPDATE staff_documents SET title=$2, starts_on=$3, expires_on=$4, notes=$5 WHERE id=$1",
    [id, text(b.title, 120) || d.title, starts, expires, b.notes != null ? text(b.notes, 500) || null : d.notes]);
  res.json({ ok: true });
}));

// Documents are never deleted, only archived, so the company keeps a full record.
router.post("/documents/:id/archive", OWNER, h(async (req, res) => {
  const r = await db.query("UPDATE staff_documents SET status = 'archived' WHERE id = $1 RETURNING id", [parseInt(req.params.id, 10)]);
  if (!r.rows.length) throw new BookingError("Document not found.", 404);
  res.json({ ok: true });
}));
router.post("/documents/:id/restore", OWNER, h(async (req, res) => {
  const r = await db.query("UPDATE staff_documents SET status = 'active' WHERE id = $1 AND status = 'archived' RETURNING id", [parseInt(req.params.id, 10)]);
  if (!r.rows.length) throw new BookingError("Only archived documents can be restored.", 409);
  res.json({ ok: true });
}));

router.get("/documents/:id/file", ANY, h(async (req, res) => {
  const { rows } = await db.query("SELECT user_id, file, file_name FROM staff_documents WHERE id = $1", [parseInt(req.params.id, 10)]);
  const d = rows[0];
  if (!d || (req.user.role !== "owner" && d.user_id !== req.user.id)) return res.status(404).json({ error: "Document not found." });
  const m = /^data:([a-z/.+-]+);base64,(.+)$/.exec(d.file);
  res.setHeader("Content-Type", m[1]);
  res.setHeader("Content-Disposition", `${/pdf|image/.test(m[1]) ? "inline" : "attachment"}; filename="${d.file_name}"`);
  res.setHeader("Cache-Control", "private, no-store");
  res.send(Buffer.from(m[2], "base64"));
}));

module.exports = router;
