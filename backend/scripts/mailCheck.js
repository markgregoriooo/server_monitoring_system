import "../config/env.js";
import emailService from "../services/emailService.js";

// SMTP check ─ `npm run mail:check [recipient@example.com]`.
//
// Without an argument it only connects and signs in (nothing is sent). With a
// recipient it also sends one test alert, which checks sign-in, the From address and
// delivery. Run it after changing SMTP_* / MAIL_FROM; real alert email fails silently.

const recipient = process.argv[2];

const result = await emailService.verify();
if (!result.ok) {
  console.error(`\n✗ Verify FAILED: ${result.error}\n`);
  console.error("Common causes (Gmail / Google Workspace):");
  console.error("  • SMTP_PASS is the account password — it must be a 16-char App Password");
  console.error("  • 2-Step Verification is off on the account (App Passwords need it)");
  console.error("  • A Workspace admin has disabled App Passwords for the tenant");
  console.error("  • SMTP_USER is not the FULL address (needs monitoring@cspc.edu.ph, not 'monitoring')\n");
  emailService.close();
  process.exit(1);
}

console.log(`\n✓ Verify OK — from ${result.from}`);

if (!recipient) {
  console.log("\nNo recipient given — connection verified, nothing sent.");
  console.log("To send a real test:  npm run mail:check -- you@example.com\n");
  emailService.close();
  process.exit(0);
}

const override = (process.env.NOTIFY_EMAIL_TO || "").trim();
if (override && override !== recipient) {
  console.log(`\n NOTIFY_EMAIL_TO is set — this will be delivered to ${override}, NOT ${recipient}.`);
}

console.log(`\nSending test alert to ${recipient} …`);
const sent = await emailService.sendAlertEmail(recipient, {
  title: "Test alert — SMTP check",
  message: "If you are reading this, the alert email channel is working end to end.",
  severity: "critical",
  deviceName: "mail:check",
  createdAt: new Date(),
});

console.log(sent ? "✓ Sent — check the inbox (and spam).\n" : "✗ Send failed — see the error above.\n");
emailService.close();
process.exit(sent ? 0 : 1);
