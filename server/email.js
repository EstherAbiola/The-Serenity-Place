// Transactional email through GoDaddy Node.js Hosting's built-in email gateway.
// The gateway runs inside the hosting container, so no SMTP settings or API keys are needed.
// Locally (no gateway) sends are logged as "skipped". Emails never block or break a request.

const db = require("./db");

/* ---- GoDaddy's sendEmail() helper (JavaScript variant of the platform's reference helper) ---- */
const EMAIL_GATEWAY_URL = "http://127.0.0.1:2525/api/email/send";
const REQUEST_TIMEOUT_MS = 30_000;

async function sendEmail(input) {
  const payload = buildPayload(input);
  let response;
  let body;
  try {
    response = await fetch(EMAIL_GATEWAY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    body = await parseBody(response);
  } catch (err) {
    throw new Error(`email gateway unreachable: ${describeError(err)}`);
  }
  if (!response.ok || !body.success) {
    const detail = body.error ?? `HTTP ${response.status}`;
    const idSuffix = body.messageId ? ` (messageId=${body.messageId})` : "";
    throw new Error(`email send failed: ${detail}${idSuffix}`);
  }
  if (!body.messageId) throw new Error("email send succeeded but gateway returned no messageId");
  return { messageId: body.messageId };
}

function buildPayload(input) {
  const payload = { to: toArray(input.to), subject: input.subject };
  const cc = toArray(input.cc);
  if (cc.length > 0) payload.cc = cc;
  const bcc = toArray(input.bcc);
  if (bcc.length > 0) payload.bcc = bcc;
  if (input.text) payload.text = input.text;
  if (input.html) payload.html = input.html;
  if (input.replyTo) payload.replyTo = input.replyTo;
  if (input.from) payload.from = input.from;
  if (input.attachments && input.attachments.length > 0) payload.attachments = input.attachments.map(encodeAttachment);
  return payload;
}
function toArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
function encodeAttachment(att) {
  const out = { filename: att.filename, content: Buffer.from(att.content).toString("base64") };
  if (att.contentType) out.contentType = att.contentType;
  return out;
}
async function parseBody(response) {
  try {
    return await response.json();
  } catch (err) {
    if (isAbortLike(err)) throw err;
    return { success: false, error: `non-JSON response (HTTP ${response.status})` };
  }
}
function isAbortLike(err) {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}
function describeError(err) {
  if (err instanceof Error) {
    if (isAbortLike(err)) return `timed out after ${REQUEST_TIMEOUT_MS}ms`;
    return err.message;
  }
  return String(err);
}
/* ---- end of platform helper ---- */

const BRAND = "Serenity Place Residences";
const money = (n) => "₦" + Number(n || 0).toLocaleString("en-NG");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const isEmail = (s) => typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// Business contact details shown in emails (placeholders until provided).
const CONTACT = {
  phone: process.env.CONTACT_PHONE || "+234 [000 000 0000]",
  address: process.env.CONTACT_ADDRESS || "[Full address to be added]",
};

function layout(title, bodyHtml) {
  return `<!DOCTYPE html><html><body style="margin:0;background:#faf7f0;font-family:Arial,Helvetica,sans-serif;color:#26301b">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="background:#344323;color:#f3efe2;border-radius:14px 14px 0 0;padding:18px 22px">
      <div style="font-size:18px;letter-spacing:2px;font-weight:bold">SERENITY PLACE</div>
      <div style="font-size:11px;letter-spacing:4px;color:#e9784d">RESIDENCES</div>
    </div>
    <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:22px;border:1px solid #e2dccd;border-top:0">
      <h2 style="margin:0 0 12px;font-size:20px;color:#344323">${esc(title)}</h2>
      ${bodyHtml}
      <p style="margin-top:22px;font-size:13px;color:#6b7262">${esc(BRAND)} · ${esc(CONTACT.address)} · ${esc(CONTACT.phone)}<br><i>Pristine Living. Peaceful Stays. · Ìtura àti Àlàáfíà.</i></p>
    </div>
  </div></body></html>`;
}
const row = (k, v) => `<tr><td style="padding:6px 0;color:#6b7262;font-size:14px">${esc(k)}</td><td style="padding:6px 0;font-size:14px;text-align:right"><b>${v}</b></td></tr>`;
const table = (rows) => `<table style="width:100%;border-collapse:collapse;border-top:1px solid #e2dccd">${rows.join("")}</table>`;

async function log(kind, to, subject, status, error) {
  try {
    await db.query("INSERT INTO email_log (kind, to_addr, subject, status, error) VALUES ($1,$2,$3,$4,$5)", [kind, to, subject, status, error ? String(error).slice(0, 500) : null]);
  } catch { /* logging must never break anything */ }
}

// Send without ever throwing; outcome goes to email_log and the server log.
function sendSafe(kind, { to, subject, html, text }) {
  if (!isEmail(to)) return;
  (async () => {
    try {
      await sendEmail({ to, subject, html, text });
      await log(kind, to, subject, "sent");
    } catch (e) {
      const unreachable = /unreachable/.test(e.message);
      if (!unreachable) console.error(`[email] ${kind} to ${to} failed: ${e.message}`);
      await log(kind, to, subject, unreachable ? "skipped" : "failed", e.message);
    }
  })();
}

// Optional: where to send staff notifications (new bookings, applications). Leave unset to skip.
const notifyAddress = () => (isEmail(process.env.NOTIFY_EMAIL) ? process.env.NOTIFY_EMAIL : null);

/* ---------------- messages ---------------- */

function bookingConfirmation(b) {
  if (!b || !b.guest || !isEmail(b.guest.email)) return;
  const paid = (b.payments || []).reduce((s, p) => s + Number(p.amount), 0);
  const beds = (b.allocation || []).map((a) => `${a.room} ${a.bed}`).join(", ");
  const subject = `Your reservation ${b.ref} at Serenity Place`;
  const html = layout(`Your reservation is confirmed, ${b.guest.name.split(" ")[0]}`, `
    <p style="font-size:15px">Thank you for choosing Serenity Place. Please keep this email and bring a valid photo ID when you arrive.</p>
    <p style="font-size:22px;letter-spacing:3px;background:#f2ecdf;display:inline-block;padding:8px 16px;border-radius:8px;color:#344323"><b>${esc(b.ref)}</b></p>
    ${table([
      row("Room", esc(b.room_type.name)),
      row("Beds", `${b.beds}${beds ? " (" + esc(beds) + ")" : ""}`),
      row("Check-in", `${fmtDate(b.checkin)}, from 2:00 PM`),
      row("Check-out", `${fmtDate(b.checkout)}, by 12:00 noon`),
      row("Nights", b.nights),
      row("Total", money(b.amount)),
      row(paid >= b.amount ? "Paid" : "To pay on arrival", paid >= b.amount ? money(paid) : money(b.amount - paid) + " (cash, POS or transfer)"),
    ])}`);
  const text = `Reservation ${b.ref}\n${b.room_type.name}, ${b.beds} bed(s)\nCheck-in ${b.checkin} from 2pm, check-out ${b.checkout} by noon\nTotal ${money(b.amount)}${paid >= b.amount ? " (paid)" : " to pay on arrival"}\nBring a valid photo ID.`;
  sendSafe("booking_confirmation", { to: b.guest.email, subject, html, text });
  const staff = notifyAddress();
  if (staff) sendSafe("booking_alert", { to: staff, subject: `New reservation ${b.ref}: ${b.guest.name}`, html: layout("New reservation", table([row("Guest", esc(b.guest.name)), row("Phone", esc(b.guest.phone)), row("Stay", `${fmtDate(b.checkin)} → ${fmtDate(b.checkout)}`), row("Beds", `${b.beds} · ${esc(b.room_type.name)}`), row("Amount", money(b.amount))])) });
}

function paymentReceipt(b, payment) {
  if (!b || !b.guest || !isEmail(b.guest.email)) return;
  const METHOD = { cash: "Cash", pos: "POS", transfer: "Bank transfer" };
  const subject = `Payment receipt for ${b.ref}`;
  const html = layout("Payment received, thank you", `
    ${table([
      row("Booking", esc(b.ref)),
      row("Guest", esc(b.guest.name)),
      row("Stay", `${fmtDate(b.checkin)} → ${fmtDate(b.checkout)}`),
      row("Room", `${esc(b.room_type.name)} · ${b.beds} bed${b.beds > 1 ? "s" : ""}`),
      row("Amount paid", money(payment.amount)),
      row("Method", esc(METHOD[payment.method] || payment.method)),
      payment.reference ? row("Reference", esc(payment.reference)) : "",
      row("Date", new Date().toLocaleString("en-GB", { timeZone: "Africa/Lagos" })),
    ])}`);
  sendSafe("payment_receipt", { to: b.guest.email, subject, html, text: `Payment of ${money(payment.amount)} received for ${b.ref}.` });
}

function applicationReceived(a) {
  if (isEmail(a.email)) {
    sendSafe("application_received", {
      to: a.email,
      subject: `We received your application: ${a.role}`,
      html: layout(`Thank you, ${a.name.split(" ")[0]}`, `<p style="font-size:15px">We've received your application for <b>${esc(a.role)}</b> at Serenity Place Residences. If you're shortlisted, we'll contact you on ${esc(a.phone)}.</p>`),
      text: `We've received your application for ${a.role}. If you're shortlisted, we'll contact you on ${a.phone}.`,
    });
  }
  const staff = notifyAddress();
  if (staff) sendSafe("application_alert", { to: staff, subject: `New job application: ${a.role} — ${a.name}`, html: layout("New job application", table([row("Role", esc(a.role)), row("Name", esc(a.name)), row("Phone", esc(a.phone)), row("Location", esc(a.location || "—"))])) });
}

function payslip(p) {
  if (!isEmail(p.email)) return;
  const net = p.base - p.deductions + p.bonus;
  sendSafe("payslip", {
    to: p.email,
    subject: `Payslip for ${p.month_label}`,
    html: layout(`Payslip · ${p.month_label}`, `
      <p style="font-size:15px">Hello ${esc(p.name.split(" ")[0])}, your salary for ${esc(p.month_label)} has been paid.</p>
      ${table([
        row("Basic salary", money(p.base)),
        row("Deductions", p.deductions ? "−" + money(p.deductions) : money(0)),
        row("Bonus", money(p.bonus)),
        row("Net paid", money(net)),
        row("Method", esc(p.method || "")),
        p.reference ? row("Reference", esc(p.reference)) : "",
        p.note ? row("Note", esc(p.note)) : "",
      ])}`),
    text: `Payslip ${p.month_label}: basic ${money(p.base)}, deductions ${money(p.deductions)}, bonus ${money(p.bonus)}, net ${money(net)}.`,
  });
}

module.exports = { sendEmail, sendSafe, bookingConfirmation, paymentReceipt, applicationReceived, payslip };
