import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_ALLOWED_DOMAINS,
  domainOf,
  parseAllowedDomains,
  isAllowedDomain,
} from "../services/googleDomain.js";

// ─── Sign-in domain check ─────────────────────────────────────────────────────
// This is the check between any Google account and a session here. Cases cover the
// endsWith() look-alike, subdomains, the blank env var and addresses with several @.
// See audits/testing-report-2026-08-25.md (T-03).

test("domainOf returns the lowercased part after the LAST @", () => {
  assert.equal(domainOf("mark@cspc.edu.ph"), "cspc.edu.ph");
  assert.equal(domainOf("Mark@CSPC.EDU.PH"), "cspc.edu.ph");
  // A local part may legally contain a quoted "@" — only the final one separates.
  assert.equal(domainOf('"weird@local"@cspc.edu.ph'), "cspc.edu.ph");
});

test("domainOf fails CLOSED on unusable input", () => {
  // "" can never match an allow-list entry, so malformed input is rejected, not admitted.
  for (const bad of ["", "no-at-sign", null, undefined, 42, {}, []]) {
    assert.equal(domainOf(bad), "", `${JSON.stringify(bad)} should yield ""`);
  }
});

test("an exact allowed domain passes", () => {
  const allowed = parseAllowedDomains(DEFAULT_ALLOWED_DOMAINS);
  assert.equal(isAllowedDomain("staff@cspc.edu.ph", allowed), true);
  assert.equal(isAllowedDomain("student@my.cspc.edu.ph", allowed), true);
});

test("a LOOK-ALIKE domain is rejected — the endsWith() trap", () => {
  // The source warns about exactly this: `email.endsWith("cspc.edu.ph")` looks
  // equivalent and would admit every address below.
  const allowed = parseAllowedDomains(DEFAULT_ALLOWED_DOMAINS);
  for (const email of [
    "attacker@notcspc.edu.ph",
    "attacker@xcspc.edu.ph",
    "attacker@evil-cspc.edu.ph",
  ]) {
    assert.equal(isAllowedDomain(email, allowed), false, `${email} must be rejected`);
  }
});

test("a SUBDOMAIN of an allowed domain is rejected", () => {
  const allowed = parseAllowedDomains(DEFAULT_ALLOWED_DOMAINS);
  for (const email of [
    "attacker@cspc.edu.ph.attacker.com",
    "attacker@mail.cspc.edu.ph",
    "attacker@sub.my.cspc.edu.ph",
  ]) {
    assert.equal(isAllowedDomain(email, allowed), false, `${email} must be rejected`);
  }
});

test("an unrelated domain is rejected", () => {
  const allowed = parseAllowedDomains(DEFAULT_ALLOWED_DOMAINS);
  assert.equal(isAllowedDomain("someone@gmail.com", allowed), false);
  assert.equal(isAllowedDomain("someone@example.org", allowed), false);
});

test("a BLANK env value falls back to the CSPC defaults, never an empty list", () => {
  // Regression: a bare `GOOGLE_ALLOWED_DOMAINS=` line produced an EMPTY list, which
  // matches nothing — silently locking every account out of the system.
  for (const blank of [undefined, null, "", "   "]) {
    const allowed = parseAllowedDomains(blank);
    assert.deepEqual(allowed, ["cspc.edu.ph", "my.cspc.edu.ph"], `${JSON.stringify(blank)}`);
    assert.equal(isAllowedDomain("staff@cspc.edu.ph", allowed), true, "staff must still get in");
  }
});

test("parseAllowedDomains trims, lowercases and drops empty entries", () => {
  assert.deepEqual(parseAllowedDomains(" CSPC.edu.ph , ,my.cspc.edu.ph ,, "), [
    "cspc.edu.ph",
    "my.cspc.edu.ph",
  ]);
});

test("a custom allow-list replaces the defaults entirely", () => {
  const allowed = parseAllowedDomains("partner.example.edu");
  assert.equal(isAllowedDomain("x@partner.example.edu", allowed), true);
  assert.equal(isAllowedDomain("x@cspc.edu.ph", allowed), false, "defaults must NOT be implicit");
});

test("an empty allow-list admits nobody", () => {
  // parseAllowedDomains cannot produce this, but isAllowedDomain is exported separately
  // and must fail closed if a caller ever passes one.
  assert.equal(isAllowedDomain("staff@cspc.edu.ph", []), false);
});
