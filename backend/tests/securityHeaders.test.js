import test from "node:test";
import assert from "node:assert/strict";
import { securityHeaders } from "../middleware/securityHeaders.js";

/** Minimal Express req/res doubles — enough for a header-only middleware. */
function run(mw, { secure = false } = {}) {
  const headers = new Map();
  const req = { secure, method: "GET", originalUrl: "/api/servers" };
  const res = {
    setHeader: (k, v) => headers.set(k, v),
    removeHeader: (k) => headers.delete(k),
  };
  let called = false;
  headers.set("X-Powered-By", "Express"); // what Express would have set
  mw(req, res, () => (called = true));
  return { headers, called };
}

test("sets the baseline headers and calls next()", () => {
  const { headers, called } = run(securityHeaders());
  assert.equal(called, true);
  assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("X-Frame-Options"), "DENY");
  assert.equal(headers.get("Referrer-Policy"), "no-referrer");
  assert.match(headers.get("Permissions-Policy"), /camera=\(\)/);
});

test("strips X-Powered-By — no free stack disclosure", () => {
  const { headers } = run(securityHeaders());
  assert.equal(headers.has("X-Powered-By"), false);
});

test("the API CSP forbids everything, including being framed", () => {
  const { headers } = run(securityHeaders());
  const csp = headers.get("Content-Security-Policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'none'/);
});

test("HSTS is sent ONLY over TLS", () => {
  // Over plain HTTP this header would pin http://<lan-ip>:3001 to HTTPS in every
  // staff browser and lock them out of a host with no certificate.
  assert.equal(run(securityHeaders()).headers.has("Strict-Transport-Security"), false);
  const secure = run(securityHeaders(), { secure: true }).headers.get("Strict-Transport-Security");
  assert.match(secure, /^max-age=\d+$/);
});

test("HSTS never claims preload or subdomains we don't own", () => {
  const v = run(securityHeaders(), { secure: true }).headers.get("Strict-Transport-Security");
  assert.doesNotMatch(v, /preload/);
  assert.doesNotMatch(v, /includeSubDomains/);
});
