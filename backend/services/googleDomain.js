// Helpers for the sign-in domain check, used by googleAuthService.js. No imports,
// so it can be tested without a database. Keep isAllowedDomain an exact match:
// `email.endsWith(domain)` would also let in "attacker@notcspc.edu.ph".

const DEFAULT_ALLOWED_DOMAINS = "cspc.edu.ph,my.cspc.edu.ph";

// The domain of an email, lowercased. Returns "" for bad input, which never matches,
// so malformed input is refused. Uses lastIndexOf because only the last "@" counts.
function domainOf(email) {
  if (typeof email !== "string") return "";
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).trim().toLowerCase();
}

// Parse GOOGLE_ALLOWED_DOMAINS into a list. Missing or blank falls back to the CSPC
// default, so an empty `GOOGLE_ALLOWED_DOMAINS=` line cannot lock everyone out.
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
