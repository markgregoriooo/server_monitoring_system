import "../config/env.js";
import nodemailer from "nodemailer";
import { describeError } from "../utils/httpError.js";
import accountTpl from "./accountEmailTemplate.js";

// Alert and report email over SMTP (nodemailer).
//
// Sending through a real Workspace mailbox means Google's existing SPF/DKIM records
// already cover the domain, so no DNS change is needed and mail reaches any
// recipient. A third-party sending API would need its own DNS records on cspc.edu.ph.
//
// Blank SMTP_USER/SMTP_PASS turns email off; the bell and toasts still work.
//
//   SMTP_HOST        e.g. smtp.gmail.com. Blank = smtp.gmail.com.
//   SMTP_PORT        587 (STARTTLS) or 465 (implicit TLS). Blank = 587.
//   SMTP_USER        full mailbox address. Dev: your own Gmail. Prod: ictusupport@cspc.edu.ph
//   SMTP_PASS        App Password, not the account password (needs 2-Step Verification).
//   MAIL_FROM        "Name <addr@domain>"; blank = SMTP_USER. Gmail rewrites the address
//                    to the signed-in mailbox unless it is a verified alias.
//   NOTIFY_EMAIL_TO  optional: send all mail to this one address (testing).

const SMTP_HOST = (process.env.SMTP_HOST || "").trim() || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = (process.env.SMTP_USER || "").trim();
// Google shows App Passwords as four groups with spaces; strip all whitespace so a
// pasted password still works.
const SMTP_PASS = (process.env.SMTP_PASS || "").replace(/\s+/g, "");
const TO_OVERRIDE = (process.env.NOTIFY_EMAIL_TO || "").trim();

const ENABLED = Boolean(SMTP_USER && SMTP_PASS);

// ─── Dashboard address for email links ──────────────────────────────────
// Only account emails need it (an approved user has never opened the dashboard).
// APP_PUBLIC_URL first, else the first WEB_ORIGIN entry. WEB_ORIGIN is a CORS list
// and may be `*`, so `*` and anything not http(s) are refused and the link is left out.
function resolveAppUrl() {
  const explicit = (process.env.APP_PUBLIC_URL || "").trim();
  if (explicit) return explicit;
  const first = (process.env.WEB_ORIGIN || "").split(",")[0].trim();
  if (!first || first === "*" || !/^https?:\/\//i.test(first)) return "";
  return first;
}
const APP_URL = resolveAppUrl();

// Gmail rewrites From to the authenticated mailbox unless it's a verified alias, so
// SMTP_USER is what actually appears on the message when MAIL_FROM isn't set.
const FROM = (process.env.MAIL_FROM || "").trim() || `CSPC ICTU Monitoring <${SMTP_USER}>`;

if (!ENABLED) {
  console.warn("[email] SMTP_USER/SMTP_PASS not set — email notifications disabled (bell + toast still work).");
} else {
  console.log(
    `[email] SMTP ${SMTP_HOST}:${SMTP_PORT} as ${SMTP_USER} — from ${FROM}` +
      (TO_OVERRIDE ? ` — ALL mail forced to ${TO_OVERRIDE}` : ""),
  );
}

// Pooled and created on first use. raiseAlert sends to all users at once, and a pool
// reuses a few connections instead of opening one per recipient (which trips Gmail's
// connection limit).
let _transporter = null;
function transporter() {
  if (!_transporter) {
    _transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465, // 465 = implicit TLS; 587 = plain connect upgraded by STARTTLS
      requireTLS: SMTP_PORT !== 465, // refuse to send in the clear if STARTTLS is unavailable
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      pool: true,
      maxConnections: 3,
      maxMessages: 50,
    });
  }
  return _transporter;
}

const SEV_LABEL = { critical: "CRITICAL", warning: "WARNING", info: "INFO" };
const SEV_COLOR = { critical: "#E02F44", warning: "#FF780A", info: "#5794F2" };

function isEnabled() {
  return ENABLED;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function phTime(v) {
  return v ? new Date(v).toLocaleString("en-PH", { timeZone: "Asia/Manila", hour12: false }) : "";
}

// Single send path so From, the recipient override and errors are the same for
// every email. Returns true/false and never throws.
async function send({ to, subject, html, text, attachments }) {
  if (!ENABLED) return false;
  const recipient = TO_OVERRIDE || to;
  if (!recipient) return false;
  try {
    await transporter().sendMail({ from: FROM, to: recipient, subject, html, text, attachments });
    return true;
  } catch (err) {
    console.error("[email] send failed:", describeError(err));
    return false;
  }
}

// ─── Alerts ──────────────────────────────────────────────────────────────────

// Minimal inline-styled HTML (email clients ignore <style>/external CSS).
function renderHtml(a) {
  const color = SEV_COLOR[a.severity] ?? "#5794F2";
  const label = SEV_LABEL[a.severity] ?? "ALERT";
  const when = phTime(a.createdAt);
  return `<div style="font-family:Arial,Helvetica,sans-serif;background:#111217;padding:24px;color:#D9D9D9">
    <div style="max-width:520px;margin:0 auto;background:#181B1F;border:1px solid rgba(255,255,255,0.07);border-left:4px solid ${color};border-radius:2px">
      <div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.07)">
        <span style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:1px;color:#fff;background:${color};padding:2px 8px;border-radius:2px">${label}</span>
        <h2 style="margin:10px 0 0;font-size:16px;color:#D9D9D9">${esc(a.title)}</h2>
      </div>
      <div style="padding:16px 20px">
        <p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:#D9D9D9">${esc(a.message)}</p>
        ${a.deviceName ? `<p style="margin:0 0 6px;font-size:12px;color:#6B7280">Device: <b style="color:#D9D9D9">${esc(a.deviceName)}</b></p>` : ""}
        ${when ? `<p style="margin:0;font-size:12px;color:#6B7280">Time: ${esc(when)} (PH)</p>` : ""}
      </div>
      <div style="padding:12px 20px;border-top:1px solid rgba(255,255,255,0.07);font-size:11px;color:#4B5563">
        CSPC-ICTU Server Room Monitoring — automated alert. Do not reply.
      </div>
    </div>
  </div>`;
}

// Plain-text alternative. Sent alongside the HTML: spam filters score HTML-only mail
// worse, and it's what a text client / notification preview shows.
function renderText(a) {
  const when = phTime(a.createdAt);
  return [
    `[${SEV_LABEL[a.severity] ?? "ALERT"}] ${a.title}`,
    "",
    a.message,
    a.deviceName ? `\nDevice: ${a.deviceName}` : "",
    when ? `Time: ${when} (PH)` : "",
    "",
    "CSPC-ICTU Server Room Monitoring — automated alert. Do not reply.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function sendAlertEmail(to, alert) {
  return send({
    to,
    subject: `[${SEV_LABEL[alert.severity] ?? "ALERT"}] ${alert.title}${alert.deviceName ? ` — ${alert.deviceName}` : ""}`,
    html: renderHtml(alert),
    text: renderText(alert),
  });
}

// ─── Reports ─────────────────────────────────────────────────────────────────

function renderReportHtml(r) {
  const period =
    r.periodStart && r.periodEnd
      ? `${String(r.periodStart).slice(0, 10)} → ${String(r.periodEnd).slice(0, 10)}`
      : "—";
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f5f6f8;padding:24px">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:4px;overflow:hidden">
      <div style="background:#2563eb;padding:14px 18px">
        <div style="color:#ffffff;font-size:15px;font-weight:700">CSPC-ICTU Monitoring</div>
      </div>
      <div style="padding:18px">
        <div style="font-size:16px;font-weight:700;color:#1a1d23;margin-bottom:10px">${esc(r.title)}</div>
        <table style="width:100%;font-size:13px;color:#374151;border-collapse:collapse">
          <tr><td style="padding:3px 0;color:#6b7280">Type</td><td style="padding:3px 0">${esc(r.typeLabel)}</td></tr>
          <tr><td style="padding:3px 0;color:#6b7280">Period</td><td style="padding:3px 0">${esc(period)}</td></tr>
          ${r.deviceName ? `<tr><td style="padding:3px 0;color:#6b7280">Device</td><td style="padding:3px 0">${esc(r.deviceName)}</td></tr>` : ""}
          <tr><td style="padding:3px 0;color:#6b7280">Generated by</td><td style="padding:3px 0">${esc(r.generatedByName ?? "—")}</td></tr>
        </table>
        <p style="font-size:12.5px;color:#6b7280;margin:14px 0 0">
          The full report is attached as a PDF.
        </p>
      </div>
    </div>
  </div>`;
}

function renderReportText(r) {
  const period =
    r.periodStart && r.periodEnd
      ? `${String(r.periodStart).slice(0, 10)} to ${String(r.periodEnd).slice(0, 10)}`
      : "—";
  return [
    r.title,
    "",
    `Type:         ${r.typeLabel}`,
    `Period:       ${period}`,
    r.deviceName ? `Device:       ${r.deviceName}` : "",
    `Generated by: ${r.generatedByName ?? "—"}`,
    "",
    "The full report is attached as a PDF.",
    "",
    "CSPC-ICTU Server Room Monitoring.",
  ]
    .filter(Boolean)
    .join("\n");
}

// Send one generated report as a PDF attachment. Returns true/false, never throws,
// does nothing when SMTP is not configured. PDF only; the CSV is for downloading.
async function sendReportEmail(to, report, pdfBuffer) {
  return send({
    to,
    subject: `[REPORT] ${report.title}`,
    html: renderReportHtml(report),
    text: renderReportText(report),
    attachments: [{ filename: report.filename, content: pdfBuffer }],
  });
}

// ─── Account status ──────────────────────────────────────────────────────────
// One-off replies, not alert notifications, so they skip email_enabled and the
// Privacy Notice gate (see accountEmailTemplate.js). Return true/false and never
// throw, so an approval cannot fail because of email. NOTIFY_EMAIL_TO applies here
// too; leave it blank in production.

/** Tell an approved user their account is live, and where. */
async function sendAccountApprovedEmail(user) {
  return send({
    to: user?.email,
    subject: accountTpl.approvedSubject(),
    html: accountTpl.approvedHtml(user, APP_URL),
    text: accountTpl.approvedText(user, APP_URL),
  });
}

/** Tell a rejected user their request was not approved. No reason, no actor. */
async function sendAccountRejectedEmail(user) {
  return send({
    to: user?.email,
    subject: accountTpl.rejectedSubject(),
    html: accountTpl.rejectedHtml(user),
    text: accountTpl.rejectedText(user),
  });
}

// Connect + authenticate without sending. Used by `npm run mail:check` so a bad App
// Password surfaces on demand instead of on the first real alert. Never throws.
async function verify() {
  if (!ENABLED) return { ok: false, error: "SMTP_USER/SMTP_PASS not set" };
  try {
    await transporter().verify();
    return { ok: true, from: FROM };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Release pooled SMTP sockets so a graceful shutdown isn't held open by them.
function close() {
  if (_transporter) {
    _transporter.close();
    _transporter = null;
  }
}

export default {
  isEnabled,
  sendAlertEmail,
  sendReportEmail,
  sendAccountApprovedEmail,
  sendAccountRejectedEmail,
  verify,
  close,
};
