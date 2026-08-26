// ─── HTTP security response headers — PURE, import-free ───────────────────────
//
// There were NONE before this: no `X-Content-Type-Options`, no `X-Frame-Options`,
// no `Referrer-Policy`, no CSP, no HSTS — and Express's default
// `X-Powered-By: Express` announcing the stack on every response.
//
// WHY THIS IS HAND-WRITTEN RATHER THAN `helmet`.
// Two reasons, and the second is the load-bearing one:
//   1. It is ~10 headers. A dependency that has to be installed, audited and kept
//      current on an air-gapped campus server is a poor trade for ten `setHeader`
//      calls whose values we want to choose deliberately anyway.
//   2. **Express here serves JSON and nothing else.** The dashboard's HTML, JS and
//      CSS are served by nginx from `frontend/dist` (deployment-guide.md §5) — they
//      never pass through this process. So the CSP that matters for the *page* has
//      to live in the nginx config, and helmet's page-shaped CSP defaults would be
//      applied to the wrong artifact entirely. What belongs HERE is the much
//      stricter API-response CSP below, which helmet does not ship.
//
// ⚠️ Mount this BEFORE the routes and BEFORE the rate limiter, so a 429 and a 404
// carry the headers too — a response is not exempt from being framed or sniffed
// just because it failed.

// `default-src 'none'` is the correct CSP for a pure-JSON API: every response from
// this process is `application/json` or a `Content-Disposition: attachment` report
// file, so there is nothing legitimate for a browser to load or execute from one.
// If a reflected value ever lands in a response body and a browser is navigated
// straight to that URL, this is what stops it running. `frame-ancestors 'none'` is
// the modern half of X-Frame-Options and covers browsers that ignore the old header.
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// 180 days. Deliberately WITHOUT `preload` and WITHOUT `includeSubDomains`:
// preload is effectively irreversible and is not ours to commit cspc.edu.ph to, and
// includeSubDomains would speak for hostnames ICTU owns and we do not. Set
// HSTS_MAX_AGE_SEC=0 to switch the header off entirely.
const HSTS_MAX_AGE = Number(process.env.HSTS_MAX_AGE_SEC ?? 15_552_000);

/**
 * @param {{ secure?: boolean }} [opts] test seam — force the HTTPS branch.
 */
export function securityHeaders(_opts = {}) {
  return function securityHeadersMiddleware(req, res, next) {
    // Never advertise the framework. Free reconnaissance otherwise: it names the
    // stack to anyone deciding which CVE list to work through.
    res.removeHeader("X-Powered-By");

    // Stop a browser second-guessing our Content-Type. The report download path
    // streams user-titled files; nosniff is what keeps one being interpreted as
    // something executable.
    res.setHeader("X-Content-Type-Options", "nosniff");

    // Clickjacking. The dashboard drives real hardware — the aircon toggle and the
    // IR commands are one click each — so a framed UI is not a theoretical concern.
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", API_CSP);

    // Don't leak the dashboard URL (which carries device ids in its paths) to any
    // third party the browser is sent to.
    res.setHeader("Referrer-Policy", "no-referrer");

    // ─── Never store an API response ────────────────────────────────────────
    //
    // There were NO cache directives at all, which does not mean "not cached" — it
    // means "cached heuristically", by whatever rule the browser or an intermediary
    // decides to apply.
    //
    // Two things travel on these responses that must not be written to a disk cache
    // or held by a shared proxy:
    //   • `X-Renewed-Token` — the sliding-session renewal puts a LIVE BEARER TOKEN in
    //     a response header, on every request made past the current token's half-life.
    //   • the bodies themselves — `/auth/me`, the user list, `system_logs` rows
    //     carrying ip_address and user_agent. That is the most personal data in the
    //     schema, on a campus where browsers are shared between staff.
    //
    // RFC 9111 §3.5 already forbids a SHARED cache from storing a response to a request
    // carrying `Authorization`, so the exposure was bounded — but it rests on every
    // intermediary honouring that rule, and it does not constrain the local browser
    // cache at all. Stating `no-store` is one header and removes the question.
    // `Pragma` is the HTTP/1.0 spelling, still emitted by some corporate proxies.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");

    // This API has no use for a camera, a microphone or a location.
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");

    // HSTS only over a real TLS connection. `req.secure` reads X-Forwarded-Proto,
    // which nginx sets and `trust proxy` makes trustworthy. Sending it over plain
    // HTTP is not just useless — a LAN deployment reached at http://<ip>:3000 would
    // pin that host to HTTPS in every staff browser and lock them out of a server
    // that has no certificate.
    if (HSTS_MAX_AGE > 0 && (req.secure || _opts.secure === true)) {
      res.setHeader("Strict-Transport-Security", `max-age=${HSTS_MAX_AGE}`);
    }

    next();
  };
}

export default securityHeaders;
