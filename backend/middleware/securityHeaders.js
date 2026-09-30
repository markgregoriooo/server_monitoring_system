// ─── HTTP security headers ─────────────────────────────────────────────────────
// Written by hand instead of using helmet: this process only serves JSON (nginx
// serves the dashboard), so helmet's page CSP would not apply. The page CSP lives in
// the nginx config. Mount this before the routes and the rate limiter so 404 and
// 429 responses get the headers too.

// Strict CSP for a JSON API: nothing in these responses should ever load or run.
// frame-ancestors 'none' is the modern X-Frame-Options.
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// 180 days, without preload or includeSubDomains (those are not ours to set for
// cspc.edu.ph). HSTS_MAX_AGE_SEC=0 turns it off.
const HSTS_MAX_AGE = Number(process.env.HSTS_MAX_AGE_SEC ?? 15_552_000);

/**
 * @param {{ secure?: boolean }} [opts] test seam — force the HTTPS branch.
 */
export function securityHeaders(_opts = {}) {
  return function securityHeadersMiddleware(req, res, next) {
    // Never advertise the framework. Free reconnaissance otherwise: it names the
    // stack to anyone deciding which CVE list to work through.
    res.removeHeader("X-Powered-By");

    // Stop the browser guessing the content type of downloaded report files.
    res.setHeader("X-Content-Type-Options", "nosniff");

    // Clickjacking. The dashboard drives real hardware — the aircon toggle and the
    // IR commands are one click each — so a framed UI is not a theoretical concern.
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", API_CSP);

    // Don't leak the dashboard URL (which carries device ids in its paths) to any
    // third party the browser is sent to.
    res.setHeader("Referrer-Policy", "no-referrer");

    // ─── Never cache API responses ───────────────────────────────────────────
    // Responses carry renewed tokens (X-Renewed-Token) and personal data such as
    // system_logs rows, and browsers are shared between staff. Pragma is for old
    // HTTP/1.0 proxies.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");

    // This API has no use for a camera, a microphone or a location.
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");

    // HSTS only over real TLS (req.secure reads X-Forwarded-Proto). Over plain HTTP it
    // would pin http://<ip>:3000 to HTTPS in staff browsers and lock them out.
    if (HSTS_MAX_AGE > 0 && (req.secure || _opts.secure === true)) {
      res.setHeader("Strict-Transport-Security", `max-age=${HSTS_MAX_AGE}`);
    }

    next();
  };
}

export default securityHeaders;
