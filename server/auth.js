// Login for owner, manager and staff, using a signed session cookie.
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");

const COOKIE = "sp_session";
const MAX_AGE_HOURS = 12;

let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("[auth] SESSION_SECRET not set: using a random one. Everyone is logged out whenever the app restarts.");
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

// Signed booking-reference tokens for receipt links (valid for 7 days).
function signRef(ref) {
  const exp = Date.now() + 7 * 24 * 3600e3;
  return `${exp}.${sign(`ref:${ref}:${exp}`)}`;
}
function checkRef(ref, token) {
  const [exp, sig] = String(token).split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = sign(`ref:${ref}:${exp}`);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

module.exports = { login, logout, loadUser, requireRole, signRef, checkRef };
