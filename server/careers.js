// Careers: public job openings and applications; owner/manager applications inbox.
const express = require("express");
const db = require("./db");
const { requireRole } = require("./auth");
const { h, text, BookingError } = require("./util");
const email = require("./email");

const MANAGERS = requireRole("owner", "manager");
const OWNER = requireRole("owner");
const router = express.Router();

const STATUSES = ["new", "shortlisted", "rejected", "hired"];
const CV_TYPES = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
};
const MAX_CV_CHARS = 2_900_000; // about 2 MB file

// Very small per-IP limiter for the public form.
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  list.push(now);
  hits.set(ip, list);
  return list.length > 5;
}

/* ---------------- public ---------------- */

router.get("/jobs", h(async (req, res) => {
  const { rows } = await db.query("SELECT id, title, description, requirements FROM jobs WHERE open = TRUE ORDER BY sort_order, id");
  res.json({ jobs: rows });
}));

router.post("/apply", h(async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: "Too many applications from this device. Please try again later." });
  const b = req.body || {};
  if (b.website) return res.status(201).json({ ok: true }); // honeypot field filled by bots
  const jobId = parseInt(b.job_id, 10);
  const { rows } = await db.query("SELECT id, title FROM jobs WHERE id = $1 AND open = TRUE", [jobId]);
  const job = rows[0];
  if (!job) throw new BookingError("Please choose a role that is open.");
  const a = {
    name: text(b.name, 120), phone: text(b.phone, 30), email: text(b.email, 160).toLowerCase(),
    location: text(b.location, 120), experience: text(b.experience, 2000), role: job.title,
  };
  if (!a.name) throw new BookingError("Please enter your full name.");
  if (!/^[+0-9 ()-]{7,20}$/.test(a.phone)) throw new BookingError("Please enter a valid phone number.");
  if (a.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)) throw new BookingError("Please enter a valid email address, or leave it empty.");
  let cv = null, cvName = null;
  if (b.cv) {
    const m = /^data:([a-z/.+-]+);base64,[A-Za-z0-9+/=]+$/.exec(String(b.cv));
    if (!m || !CV_TYPES[m[1]]) throw new BookingError("Your CV must be a PDF, Word document or photo.");
    if (b.cv.length > MAX_CV_CHARS) throw new BookingError("Your CV file is too large (2 MB maximum).");
    cv = b.cv;
    cvName = (text(b.cv_name, 120) || `cv.${CV_TYPES[m[1]]}`).replace(/[^\w.\- ]/g, "_");
  }
  await db.query(
    "INSERT INTO applications (job_id, role, name, phone, email, location, experience, cv, cv_name) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [job.id, a.role, a.name, a.phone, a.email || null, a.location || null, a.experience || null, cv, cvName]
  );
  email.applicationReceived(a);
  res.status(201).json({ ok: true });
}));

/* ---------------- inbox (owner + manager) ---------------- */

router.get("/applications", MANAGERS, h(async (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  const { rows } = await db.query(
    `SELECT id, job_id, role, name, phone, email, location, experience, cv_name, (cv IS NOT NULL) AS has_cv, status, note, created_at
       FROM applications ${status ? "WHERE status = $1" : ""} ORDER BY created_at DESC`,
    status ? [status] : []
  );
  const { rows: counts } = await db.query("SELECT status, COUNT(*)::int AS n FROM applications GROUP BY status");
  res.json({ applications: rows, counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) });
}));

router.post("/applications/:id/status", MANAGERS, h(async (req, res) => {
  const status = req.body?.status;
  if (!STATUSES.includes(status)) throw new BookingError("Unknown status.");
  const r = await db.query("UPDATE applications SET status = $2, note = $3 WHERE id = $1 RETURNING id", [parseInt(req.params.id, 10), status, text(req.body?.note, 500) || null]);
  if (!r.rows.length) throw new BookingError("Application not found.", 404);
  res.json({ ok: true });
}));

router.get("/applications/:id/cv", MANAGERS, h(async (req, res) => {
  const { rows } = await db.query("SELECT cv, cv_name FROM applications WHERE id = $1", [parseInt(req.params.id, 10)]);
  const r = rows[0];
  if (!r || !r.cv) return res.status(404).json({ error: "No CV attached." });
  const m = /^data:([a-z/.+-]+);base64,(.+)$/.exec(r.cv);
  res.setHeader("Content-Type", m[1]);
  res.setHeader("Content-Disposition", `attachment; filename="${r.cv_name || "cv"}"`);
  res.send(Buffer.from(m[2], "base64"));
}));

/* ---------------- job openings (owner) ---------------- */

router.get("/admin/jobs", MANAGERS, h(async (req, res) => {
  const { rows } = await db.query("SELECT * FROM jobs ORDER BY sort_order, id");
  res.json({ jobs: rows });
}));

async function saveJob(id, b) {
  const title = text(b.title, 80);
  if (!title) throw new BookingError("Give the role a title.");
  const desc = text(b.description, 1000) || null, reqs = text(b.requirements, 1000) || null, open = b.open !== false;
  if (id) {
    const r = await db.query("UPDATE jobs SET title=$2, description=$3, requirements=$4, open=$5 WHERE id=$1 RETURNING id", [id, title, desc, reqs, open]);
    if (!r.rows.length) throw new BookingError("Role not found.", 404);
  } else {
    await db.query("INSERT INTO jobs (title, description, requirements, open, sort_order) VALUES ($1,$2,$3,$4,99)", [title, desc, reqs, open]);
  }
}
router.post("/admin/jobs", OWNER, h(async (req, res) => { await saveJob(null, req.body || {}); res.status(201).json({ ok: true }); }));
router.post("/admin/jobs/:id", OWNER, h(async (req, res) => { await saveJob(parseInt(req.params.id, 10), req.body || {}); res.json({ ok: true }); }));

module.exports = router;
