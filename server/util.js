// Small helpers shared by the owner, expenses and staff routes.
const db = require("./db");
const { BookingError, todayLagos } = require("./booking");

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z"));

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ?from=YYYY-MM-DD&to=YYYY-MM-DD (inclusive). Defaults to the current month so far.
function dateRange(q, { maxDays = 400 } = {}) {
  const today = todayLagos();
  const from = isDate(q.from) ? q.from : today.slice(0, 8) + "01";
  const to = isDate(q.to) ? q.to : today;
  if (to < from) throw new BookingError("The end date must be on or after the start date.");
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
  if (days > maxDays) throw new BookingError(`Please choose a period of ${maxDays} days or less.`);
  return { from, to, days };
}

// Start of a Lagos day as a timestamp, for comparing with created_at.
const lagosStart = (iso) => `${iso}T00:00:00+01:00`;

function csv(rows, columns) {
  const cell = (v) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => cell(c.label)).join(","), ...rows.map((r) => columns.map((c) => cell(typeof c.get === "function" ? c.get(r) : r[c.get])).join(","))].join("\r\n");
}

function sendCsv(res, filename, text) {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send("﻿" + text); // BOM so Excel reads ₦ and accents correctly
}

async function getSetting(key, fallback = null) {
  const { rows } = await db.query("SELECT value FROM settings WHERE key = $1", [key]);
  return rows[0] ? rows[0].value : fallback;
}

async function setSetting(key, value) {
  const { rows } = await db.query("SELECT key FROM settings WHERE key = $1", [key]);
  if (rows.length) await db.query("UPDATE settings SET value = $2 WHERE key = $1", [key, String(value)]);
  else await db.query("INSERT INTO settings (key, value) VALUES ($1, $2)", [key, String(value)]);
}

function toInt(v, { min = 0, max = 1e9, name = "Amount" } = {}) {
  const n = Number(String(v ?? "").replace(/[,\s₦]/g, ""));
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) throw new BookingError(`${name} must be a whole number between ${min.toLocaleString()} and ${max.toLocaleString()}.`);
  return n;
}

const text = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

module.exports = { h, isDate, addDays, dateRange, lagosStart, csv, sendCsv, getSetting, setSetting, toInt, text, BookingError };
