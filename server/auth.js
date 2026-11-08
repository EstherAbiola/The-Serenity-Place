// Login for owner, manager and staff, using a signed session cookie.
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");

const COOKIE = "sp_session";
const MAX_AGE_HOURS = 12;

let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString("hex");
  console.log("[auth] Using a temporary login key; staff will need to log in again after each restart.");
}

function sign(data) {
  return crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
}

function makeToken(userId) {
  const body = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + MAX_AGE_HOURS * 3600e3 })).toString("base64url");
  return `${body}.${sign(body)}`;
}

function readToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = sign(body);
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString());
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, value, maxAgeSec) {
  const secure = process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "1";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`
  );
}

async function login(req, res) {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const { rows } = await db.query("SELECT * FROM users WHERE email = $1 AND active = TRUE", [email]);
  const user = rows[0];
  const ok = user && (await bcrypt.compare(password, user.password_hash));
  if (!ok) return res.status(401).json({ error: "Incorrect email or password." });
  setCookie(res, makeToken(user.id), MAX_AGE_HOURS * 3600);
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}

function logout(req, res) {
  setCookie(res, "", 0);
  res.json({ ok: true });
}

// Middleware: attach req.user if logged in.
async function loadUser(req, res, next) {
  const data = readToken(parseCookies(req.headers.cookie)[COOKIE]);
  if (data) {
    const { rows } = await db.query("SELECT id, name, email, role FROM users WHERE id = $1 AND active = TRUE", [data.uid]);
    req.user = rows[0] || null;
  }
  next();
}

// Middleware factory: only allow the given roles.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Please log in." });
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: "You don't have access to this." });
    next();
  };
}

// Anyone logged in can change their own password.
async function changePassword(req, res) {
  const current = String(req.body?.current_password || "");
  const next = String(req.body?.new_password || "");
  if (next.length < 8) return res.status(400).json({ error: "Choose a new password of at least 8 characters." });
  const { rows } = await db.query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
  if (!rows[0] || !(await bcrypt.compare(current, rows[0].password_hash))) return res.status(403).json({ error: "Your current password is not correct." });
  await db.query("UPDATE users SET password_hash = $2 WHERE id = $1", [req.user.id, await bcrypt.hash(next, 10)]);
  res.json({ ok: true });
}

// ---- First-run owner setup (no secrets needed) ----
// If no owner account exists, a one-time setup code is printed to the server logs
// (GoDaddy → Runtime Logs). Only someone who can see the logs can create the owner login.
let setupCode = null;

async function prepareOwnerSetup() {
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM users WHERE role = 'owner'");
  if (Number(rows[0].n) > 0) { setupCode = null; return; }
  const raw = crypto.randomBytes(4).toString("hex").toUpperCase();
  setupCode = raw.slice(0, 4) + "-" + raw.slice(4);
  console.error(`[setup] No owner account yet. Open /staff and use this one-time setup code: ${setupCode}`);
}

async function setupStatus(req, res) {
  res.json({ needs_setup: Boolean(setupCode) });
}

async function setupOwner(req, res) {
  if (!setupCode) return res.status(409).json({ error: "The owner account is already set up. Please log in." });
  const code = String(req.body?.code || "").trim().toUpperCase();
  const ok = code.length === setupCode.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(setupCode));
  if (!ok) return res.status(403).json({ error: "That setup code is not correct. Copy it from GoDaddy → Runtime Logs." });
  const name = String(req.body?.name || "").trim().slice(0, 100);
  const email = String(req.body?.email || "").trim().toLowerCase().slice(0, 160);
  const password = String(req.body?.password || "");
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter your name and a valid email." });
  if (password.length < 8) return res.status(400).json({ error: "Choose a password of at least 8 characters." });
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await db.query("INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,'owner') RETURNING id, name, email, role", [name, email, hash]);
  setupCode = null;
  console.error(`[setup] Owner account created for ${email}.`);
  setCookie(res, makeToken(rows[0].id), MAX_AGE_HOURS * 3600);
  res.status(201).json({ user: rows[0] });
}

module.exports = { login, logout, loadUser, requireRole, prepareOwnerSetup, setupStatus, setupOwner, changePassword };
