// ─── Account-status email content — PURE, import-free ────────────────────────
//
// What an approval / rejection email SAYS. emailService.js does the sending; this
// decides the words. Same split as reportTemplate (content) vs reportRenderer (I/O),
// and for the same reason: `tests/accountEmail.test.js` runs these with no SMTP, no
// .env and no nodemailer, so the wording can be pinned by a test.
//
// ⚠️ THESE ARE TRANSACTIONAL, NOT NOTIFICATIONS. They are deliberately NOT gated by
// `notification_prefs.email_enabled` and NOT gated by Privacy Notice acceptance, and
// both exemptions are load-bearing:
//
//   * `email_enabled` governs ALERT email — an ongoing stream of operational data the
//     person never asked for, which is opt-in for good reason (see
//     NOTIFY_EMAIL_MIN_SEVERITY in CLAUDE.md, and
//     migrations/2026-09-18_notification_prefs_default_off.sql). This is the opposite
//     case: a single reply to an action the person themselves started by registering.
//     Routing it through that flag would let a default meant to protect someone from
//     alerts suppress the one message telling them their account works.
//
//   * Policy acceptance is IMPOSSIBLE to have here. A pending user has never held a
//     session, so PolicyGate has never rendered for them and `users.policy_version` is
//     unset. Gating on acceptance makes the mail unsendable: they cannot accept until
//     they can sign in, and they cannot know to sign in without the mail.
//
// Two things are deliberately absent from both templates:
//
//   * THE ADMIN'S NAME. Accountability lives in `system_logs` (action='approve_user' /
//     'reject_user', with the actor). Putting it in the email would make one staff
//     member the personal support contact for everyone they ever approved.
//   * THE REASON FOR A REJECTION. A rejection can be a security decision, and an email
//     that explains itself confirms to whoever registered exactly what was noticed.
//     One neutral sentence and a route back to a human is the whole message.

/** DB role → the label the dashboard shows. Kept identical to frontend
 *  `data/users.ts` roleConfig: an email that calls it "Administrator" while every
 *  screen says "Admin" reads as a different system. */
export const ROLE_LABEL = Object.freeze({
  admin: "Admin",
  it_staff: "IT Staff",
});

/** Where ICTU is reached when something is wrong. One constant, used by both. */
export const SUPPORT_CONTACT = "the CSPC ICT Unit";

/**
 * HTML-escape. Every interpolated value below is user-controlled — `name` comes from
 * a Google profile and `email` from the address that registered — so neither reaches
 * the markup raw.
 */
export function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/**
 * Trim a trailing slash so `${url}/login` never doubles it. A doubled slash usually
 * still resolves, but it looks broken in a link somebody is being asked to trust.
 */
export function normalizeUrl(url) {
  const u = String(url ?? "").trim();
  if (!u) return "";
  return u.replace(/\/+$/, "");
}

/** Shared chrome. Light theme, matching the report email: this is a message to a
 *  person, not an alarm, and the dark alert styling reads as a fault in an inbox. */
function shell(bodyHtml) {
  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f5f6f8;padding:24px">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:4px;overflow:hidden">
      <div style="background:#2563eb;padding:14px 18px">
        <div style="color:#ffffff;font-size:15px;font-weight:700">CSPC-ICTU Monitoring</div>
      </div>
      <div style="padding:18px">${bodyHtml}</div>
      <div style="padding:12px 18px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af">
        CSPC-ICTU Server Infrastructure Monitoring System. Please do not reply to this message.
      </div>
    </div>
  </div>`;
}

// ─── Approved ────────────────────────────────────────────────────────────────

export function approvedSubject() {
  return "Your CSPC-ICTU Monitoring account has been approved";
}

/**
 * @param {{name?: string, email?: string, role?: string}} user
 * @param {string} [appUrl] dashboard URL; the link is omitted entirely when unknown,
 *   rather than printed as a broken or guessed address.
 */
export function approvedHtml(user, appUrl) {
  const url = normalizeUrl(appUrl);
  const role = ROLE_LABEL[user?.role] ?? user?.role ?? "";
  const greeting = user?.name ? `Hi ${esc(user.name)},` : "Hello,";
  return shell(`
        <div style="font-size:16px;font-weight:700;color:#1a1d23;margin-bottom:10px">Account approved</div>
        <p style="font-size:13.5px;line-height:1.55;color:#374151;margin:0 0 12px">${greeting}</p>
        <p style="font-size:13.5px;line-height:1.55;color:#374151;margin:0 0 12px">
          Your registration for the CSPC-ICTU Server Infrastructure Monitoring System has been
          approved. You can now sign in${role ? ` with <b>${esc(role)}</b> access` : ""}.
        </p>
        <table style="width:100%;font-size:13px;color:#374151;border-collapse:collapse;margin:0 0 14px">
          ${user?.email ? `<tr><td style="padding:3px 0;color:#6b7280;width:90px">Account</td><td style="padding:3px 0">${esc(user.email)}</td></tr>` : ""}
          ${role ? `<tr><td style="padding:3px 0;color:#6b7280">Access</td><td style="padding:3px 0">${esc(role)}</td></tr>` : ""}
        </table>
        ${
          url
            ? `<p style="margin:0 0 14px">
          <a href="${esc(url)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-size:13.5px;font-weight:600;padding:9px 16px;border-radius:4px">Open the dashboard</a>
        </p>
        <p style="font-size:12px;color:#6b7280;margin:0 0 12px">${esc(url)}</p>`
            : ""
        }
        <p style="font-size:12.5px;line-height:1.5;color:#6b7280;margin:0">
          Sign in with the <b>CSPC Mail</b> button using this same address. On your first sign-in
          you will be asked to read and accept the Privacy Notice and Terms before the dashboard
          opens.
        </p>`);
}

/**
 * ⚠️ Built as BLOCKS joined by a blank line, not as a flat list of lines.
 *
 * The first version was a flat array with `""` entries for the blank lines and `""` for
 * omitted ones, filtered by `line !== ""` — which cannot tell the two apart, so it
 * stripped every paragraph break and rendered the whole message as one unreadable wall.
 * Nothing caught it, because asserting that a string CONTAINS the right words says
 * nothing about whether it is readable. A block list makes omission (`null`, dropped)
 * and separation (the join) different mechanisms, so they cannot collide again.
 */
export function approvedText(user, appUrl) {
  const url = normalizeUrl(appUrl);
  const role = ROLE_LABEL[user?.role] ?? user?.role ?? "";

  const facts = [
    user?.email ? `Account: ${user.email}` : null,
    role ? `Access:  ${role}` : null,
  ].filter(Boolean);

  return [
    "Account approved",
    user?.name ? `Hi ${user.name},` : "Hello,",
    "Your registration for the CSPC-ICTU Server Infrastructure Monitoring System has been\n" +
      `approved. You can now sign in${role ? ` with ${role} access` : ""}.`,
    facts.length ? facts.join("\n") : null,
    url ? `Open the dashboard: ${url}` : null,
    "Sign in with the CSPC Mail button using this same address. On your first sign-in you\n" +
      "will be asked to read and accept the Privacy Notice and Terms before the dashboard opens.",
    "CSPC-ICTU Server Infrastructure Monitoring System. Please do not reply to this message.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ─── Rejected ────────────────────────────────────────────────────────────────

export function rejectedSubject() {
  return "Your CSPC-ICTU Monitoring account request";
}

/**
 * Neutral by design — no reason, no actor. The only actionable content is a route back
 * to a human, because the legitimate case this exists for is somebody who was rejected
 * by mistake and otherwise has no way to find out or say so.
 */
export function rejectedHtml(user) {
  const greeting = user?.name ? `Hi ${esc(user.name)},` : "Hello,";
  return shell(`
        <div style="font-size:16px;font-weight:700;color:#1a1d23;margin-bottom:10px">Account request not approved</div>
        <p style="font-size:13.5px;line-height:1.55;color:#374151;margin:0 0 12px">${greeting}</p>
        <p style="font-size:13.5px;line-height:1.55;color:#374151;margin:0 0 12px">
          Your request for access to the CSPC-ICTU Server Infrastructure Monitoring System was
          not approved, so no account has been activated${user?.email ? ` for ${esc(user.email)}` : ""}.
        </p>
        <p style="font-size:13.5px;line-height:1.55;color:#374151;margin:0">
          If you believe this is a mistake, please contact ${esc(SUPPORT_CONTACT)} directly.
        </p>`);
}

/** Blocks joined by a blank line, for the same reason as approvedText above. */
export function rejectedText(user) {
  return [
    "Account request not approved",
    user?.name ? `Hi ${user.name},` : "Hello,",
    "Your request for access to the CSPC-ICTU Server Infrastructure Monitoring System was\n" +
      `not approved, so no account has been activated${user?.email ? ` for ${user.email}` : ""}.`,
    `If you believe this is a mistake, please contact ${SUPPORT_CONTACT} directly.`,
    "CSPC-ICTU Server Infrastructure Monitoring System. Please do not reply to this message.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export default {
  ROLE_LABEL,
  SUPPORT_CONTACT,
  esc,
  normalizeUrl,
  approvedSubject,
  approvedHtml,
  approvedText,
  rejectedSubject,
  rejectedHtml,
  rejectedText,
};
