import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import tpl, {
  ROLE_LABEL,
  esc,
  normalizeUrl,
  approvedSubject,
  approvedHtml,
  approvedText,
  rejectedSubject,
  rejectedHtml,
  rejectedText,
} from "../services/accountEmailTemplate.js";

// The template module is PURE, so this whole file runs with no SMTP, no .env and no
// nodemailer — the same reason reportTemplate/analyticsMath are split from their I/O.

const APPROVED = { name: "Juan Dela Cruz", email: "juan@cspc.edu.ph", role: "it_staff" };
const URL = "https://monitoring.cspc-ictu.stream";

// ─── Role labels must match the dashboard ────────────────────────────────────
// Reads the frontend source (like contract.test.js reads metrics.go), so the email
// uses the same role names as the screens.

test("ROLE_LABEL matches the frontend roleConfig labels", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "../../frontend/src/data/users.ts"), "utf8");

  const found = {};
  const re = /(\w+):\s*\{\s*label:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) found[m[1]] = m[2];

  assert.ok(Object.keys(found).length >= 2, `parsed too few roles from users.ts: ${JSON.stringify(found)}`);
  for (const [role, label] of Object.entries(found)) {
    assert.equal(
      ROLE_LABEL[role],
      label,
      `ROLE_LABEL.${role} is "${ROLE_LABEL[role]}" but the dashboard shows "${label}"`,
    );
  }
});

// ─── Escaping ────────────────────────────────────────────────────────────────
// `name` and `email` come from the user's Google account, so both must be escaped.

test("esc neutralises HTML", () => {
  assert.equal(esc(`<script>"x"&'y'</script>`), "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
});

test("a name containing markup cannot inject into the approval HTML", () => {
  const html = approvedHtml({ ...APPROVED, name: `<img src=x onerror=alert(1)>` }, URL);
  assert.ok(!html.includes("<img"), "raw tag reached the HTML body");
  assert.ok(html.includes("&lt;img"), "the name should appear escaped");
});

test("a name containing markup cannot inject into the rejection HTML", () => {
  const html = rejectedHtml({ name: `</div><script>x</script>`, email: "a@cspc.edu.ph" });
  assert.ok(!html.includes("<script>"), "raw tag reached the HTML body");
});

// ─── URLs ────────────────────────────────────────────────────────────────────

test("normalizeUrl strips trailing slashes and tolerates junk", () => {
  assert.equal(normalizeUrl("https://x.test/"), "https://x.test");
  assert.equal(normalizeUrl("https://x.test///"), "https://x.test");
  assert.equal(normalizeUrl("https://x.test"), "https://x.test");
  assert.equal(normalizeUrl("  "), "");
  assert.equal(normalizeUrl(null), "");
});

test("no URL means no link at all, not a broken one", () => {
  const html = approvedHtml(APPROVED, "");
  assert.ok(!html.includes("<a href"), "an anchor was rendered with no address to point at");
  assert.ok(!html.includes("href=\"\""), "an empty href was rendered");

  const text = approvedText(APPROVED, "");
  assert.ok(!text.includes("Open the dashboard:"), "text version advertised a missing link");
});

test("the approval carries the dashboard address when it is known", () => {
  assert.ok(approvedHtml(APPROVED, URL).includes(URL));
  assert.ok(approvedText(APPROVED, URL).includes(URL));
});

// ─── Approval content ────────────────────────────────────────────────────────

test("the approval states the role, in the dashboard's own words", () => {
  const text = approvedText(APPROVED, URL);
  assert.ok(text.includes("IT Staff"), "the assigned role should be named");
  assert.ok(!text.includes("it_staff"), "the raw DB value should never be shown to a person");

  const html = approvedHtml({ ...APPROVED, role: "admin" }, URL);
  assert.ok(html.includes("Admin"));
});

test("an unrecognised role degrades instead of printing 'undefined'", () => {
  const text = approvedText({ ...APPROVED, role: "auditor" }, URL);
  assert.ok(!text.includes("undefined"));
  assert.ok(text.includes("auditor"));
});

test("a user with no name still gets a sensible greeting", () => {
  const text = approvedText({ email: "x@cspc.edu.ph", role: "admin" }, URL);
  assert.ok(text.includes("Hello,"), "expected the nameless fallback greeting");
  assert.ok(!text.includes("undefined"));
});

test("the approval tells the user the Privacy Notice is coming", () => {
  // The policy gate blocks the dashboard on first sign-in. Somebody who is not
  // expecting it reads that as the approval not having worked.
  assert.ok(/privacy notice/i.test(approvedText(APPROVED, URL)));
  assert.ok(/privacy notice/i.test(approvedHtml(APPROVED, URL)));
});

// ─── Rejection content ───────────────────────────────────────────────────────

test("the rejection names no actor and gives no reason", () => {
  const user = { name: "Juan Dela Cruz", email: "juan@cspc.edu.ph", role: "it_staff" };
  for (const out of [rejectedText(user), rejectedHtml(user)]) {
    // A rejection can be a security decision; explaining it confirms what was noticed.
    assert.ok(!/because|reason|denied by|rejected by/i.test(out), "the rejection explained itself");
    // No role was granted, so naming one would be both wrong and informative.
    assert.ok(!out.includes("IT Staff"), "the rejection should not state a role");
  }
});

test("the rejection routes the user to a human", () => {
  assert.ok(/contact/i.test(rejectedText({ name: "A" })));
  assert.ok(/ICT Unit/i.test(rejectedText({ name: "A" })));
});

test("neither template ever emits the literal 'undefined' or 'null'", () => {
  const empty = {};
  const outputs = [
    approvedHtml(empty, ""),
    approvedText(empty, ""),
    rejectedHtml(empty),
    rejectedText(empty),
    approvedHtml(undefined, undefined),
    rejectedText(undefined),
  ];
  for (const out of outputs) {
    assert.ok(!/undefined|null/.test(out), `leaked a placeholder: ${out.slice(0, 120)}`);
  }
});

// ─── Readability of the plain-text part ──────────────────────────────────────
// Added after the first version lost every blank line and read as one block of text.
// These check the layout, not just the words.

test("the plain-text emails are broken into paragraphs", () => {
  for (const out of [approvedText(APPROVED, URL), rejectedText(APPROVED)]) {
    assert.ok(out.includes("\n\n"), "no blank line anywhere — the message is one wall of text");
    // The greeting must not be welded to the heading above it.
    assert.ok(/\n\n(Hi |Hello,)/.test(out), "the greeting has no blank line before it");
  }
});

test("no run of three or more newlines, with or without the optional blocks", () => {
  const cases = [
    approvedText(APPROVED, URL),
    approvedText({ role: "admin" }, URL), // no name, no email
    approvedText({ name: "A", email: "a@cspc.edu.ph" }, ""), // no role, no link
    approvedText({}, ""), // nothing optional at all
    rejectedText(APPROVED),
    rejectedText({}),
  ];
  for (const out of cases) {
    assert.ok(!/\n{3,}/.test(out), `gap left by an omitted block:\n${JSON.stringify(out)}`);
    assert.ok(!/^\n/.test(out) && !/\n$/.test(out), "leading or trailing blank line");
  }
});

test("no line runs long enough to wrap badly in a mail client", () => {
  for (const out of [approvedText(APPROVED, URL), rejectedText(APPROVED)]) {
    for (const line of out.split("\n")) {
      assert.ok(line.length <= 100, `line is ${line.length} chars: ${line}`);
    }
  }
});

// ─── Subjects ────────────────────────────────────────────────────────────────

test("subjects are distinct, non-empty and free of severity tags", () => {
  const a = approvedSubject();
  const r = rejectedSubject();
  assert.ok(a.length > 0 && r.length > 0);
  assert.notEqual(a, r);
  // `[CRITICAL]`-style prefixes belong to alert mail — these are not alerts, and a
  // person's first message from the system should not look like an alarm.
  assert.ok(!/^\[/.test(a));
  assert.ok(!/^\[/.test(r));
});

test("the default export exposes the same functions as the named ones", () => {
  assert.equal(tpl.approvedSubject, approvedSubject);
  assert.equal(tpl.rejectedHtml, rejectedHtml);
  assert.equal(tpl.ROLE_LABEL, ROLE_LABEL);
});
