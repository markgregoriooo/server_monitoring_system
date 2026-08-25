// PURE helpers for the Google sign-in domain gate. Used by googleAuthService.js.
//
// This is the single check standing between an arbitrary Google account and a
// session on this system, so it lives in one small file you can read end to end
// rather than buried in the OAuth flow.
//
// Deliberately DEPENDENCY-FREE (no env, no mysql, no google-auth-library): it can
// be imported and exercised without starting a database.
//
// If you ever change isAllowedDomain, keep it an EXACT match. Rewriting it as
// `email.endsWith(domain)` looks equivalent and is not — it would admit
// "attacker@notcspc.edu.ph", and nothing would appear to break.

const DEFAULT_ALLOWED_DOMAINS = "cspc.edu.ph,my.cspc.edu.ph";

// The domain part of an email, lowercased. Returns "" for anything unusable
// (non-string, no "@"), and "" can never match an allow-list entry — so
// malformed input fails CLOSED rather than slipping through.
// lastIndexOf, not indexOf: only the final "@" separates local-part from domain.
function domainOf(email) {
  if (typeof email !== "string") return "";
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).trim().toLowerCase();
}

// Parse GOOGLE_ALLOWED_DOMAINS into a list. A missing OR BLANK value falls back
// to the CSPC default — matching how server.js treats WEB_ORIGIN. (A bare
// `GOOGLE_ALLOWED_DOMAINS=` line in .env used to produce an EMPTY list, which
// silently locked out every account, since `??` only replaces undefined.)
function parseAllowedDomains(raw) {
  const value = String(raw ?? "").trim() || DEFAULT_ALLOWED_DOMAINS;
  return value
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

// EXACT match on the part after "@" — never endsWith, so a look-alike domain
// ("notcspc.edu.ph") or a subdomain ("cspc.edu.ph.attacker.com") cannot pass.
function isAllowedDomain(email, allowed) {
  const domain = domainOf(email);
  return domain !== "" && allowed.includes(domain);
}

export { DEFAULT_ALLOWED_DOMAINS, domainOf, parseAllowedDomains, isAllowedDomain };
