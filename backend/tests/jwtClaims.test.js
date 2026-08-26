import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
  JWT_ISSUER,
  JWT_AUDIENCE,
  JWT_VERIFY_OPTS,
  JWT_SIGN_OPTS,
} from "../middleware/auth.js";

// ─── The JWT stamping/checking contract ───────────────────────────────────────
//
// There are five places that sign or verify this app's session token — the auth
// middleware, the sliding renewal inside it, issueSession, the Socket.IO handshake and
// the rate limiter's user key. They all read the two frozen option objects exported by
// middleware/auth.js. If any of them ever grows its own copy, the failure is a mass
// logout: tokens minted by one site stop verifying at another.

const SECRET = "test-secret-not-used-anywhere-real-0123456789abcdef";

test("verify enforces algorithm, issuer AND audience", () => {
  assert.deepEqual(JWT_VERIFY_OPTS.algorithms, ["HS256"]);
  assert.equal(JWT_VERIFY_OPTS.issuer, JWT_ISSUER);
  assert.equal(JWT_VERIFY_OPTS.audience, JWT_AUDIENCE);
});

test("the options are frozen — a caller cannot weaken them for everyone", () => {
  assert.throws(() => {
    "use strict";
    JWT_VERIFY_OPTS.algorithms = ["none"];
  });
});

test("a token signed with our options verifies with our options", () => {
  const token = jwt.sign({ id: 1, tv: 0 }, SECRET, { ...JWT_SIGN_OPTS, expiresIn: "1h" });
  const decoded = jwt.verify(token, SECRET, JWT_VERIFY_OPTS);
  assert.equal(decoded.id, 1);
  assert.equal(decoded.iss, JWT_ISSUER);
  assert.equal(decoded.aud, JWT_AUDIENCE);
});

test("a token from ANOTHER issuer is rejected even with the right secret", () => {
  // The point of `iss`: a secret copied into a sibling service or a script cannot
  // mint sessions for this app.
  const foreign = jwt.sign({ id: 1 }, SECRET, {
    algorithm: "HS256",
    issuer: "some-other-service",
    audience: JWT_AUDIENCE,
    expiresIn: "1h",
  });
  assert.throws(() => jwt.verify(foreign, SECRET, JWT_VERIFY_OPTS), /jwt issuer invalid/);
});

test("a token for ANOTHER audience is rejected even with the right secret", () => {
  const foreign = jwt.sign({ id: 1 }, SECRET, {
    algorithm: "HS256",
    issuer: JWT_ISSUER,
    audience: "some-other-app",
    expiresIn: "1h",
  });
  assert.throws(() => jwt.verify(foreign, SECRET, JWT_VERIFY_OPTS), /jwt audience invalid/);
});

test("an unsigned `alg: none` token is rejected", () => {
  // The classic JWT attack. `algorithms: ["HS256"]` is what refuses it.
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ id: 1, role: "admin" })).toString("base64url");
  assert.throws(() => jwt.verify(`${header}.${body}.`, SECRET, JWT_VERIFY_OPTS));
});

test("re-signing a decoded token must strip iss/aud, or every renewal 500s", () => {
  // jwt.sign THROWS when an option duplicates a claim already in the payload. The
  // renewal path spreads the decoded token, so it has to drop iss/aud along with the
  // time claims — this pins that, because the symptom would be a 500 on the first
  // request past a token's half-life rather than anything at deploy time.
  const decoded = jwt.verify(
    jwt.sign({ id: 1, ist: 123 }, SECRET, { ...JWT_SIGN_OPTS, expiresIn: "1h" }),
    SECRET,
    JWT_VERIFY_OPTS,
  );

  // Strip ONLY the time claims — exactly what the renewal code did before the fix.
  // (Keeping `exp` too would throw on `exp` first and hide the claim this pins.)
  const { iat: _i, exp: _e, nbf: _n, ...stillHasIssAud } = decoded;
  assert.throws(
    () => jwt.sign(stillHasIssAud, SECRET, { ...JWT_SIGN_OPTS, expiresIn: "1h" }),
    /Bad "options\.audience" option\. The payload already has an "aud" property/,
    "expected jwt.sign to reject a payload that still carries aud",
  );

  const { iat, exp, nbf, iss, aud, ...claims } = decoded;
  const renewed = jwt.sign(claims, SECRET, { ...JWT_SIGN_OPTS, expiresIn: "1h" });
  const after = jwt.verify(renewed, SECRET, JWT_VERIFY_OPTS);
  assert.equal(after.ist, 123, "the session-start claim must survive renewal, or the cap resets");
});
