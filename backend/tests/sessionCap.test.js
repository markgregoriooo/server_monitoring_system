import test from "node:test";
import assert from "node:assert/strict";
import {
  sessionHardExpirySec,
  sessionPastHardLimit,
  SESSION_MAX_HOURS,
} from "../middleware/auth.js";

// ─── The absolute session ceiling ─────────────────────────────────────────────
//
// The sliding renewal in middleware/auth.js has no upper bound of its own — `ist` plus
// SESSION_MAX_HOURS is the only thing that ends a session that keeps being used. That
// ceiling was enforced in exactly one place (maybeRenewToken) and by exactly one
// mechanism (declining to mint a new token), which meant it had NO effect on a
// Socket.IO connection: a socket authenticates once at the handshake and never needs
// another token, so it kept streaming past the cap indefinitely.
//
// These pin the shared predicate that now backs the handshake and the revocation sweep.
// Pure — auth.js imports the mysql POOL, but creating a pool opens no connection.

const HOUR = 3600;
const NOW = 1_800_000_000; // fixed clock, so nothing here depends on wall time
const CAP = SESSION_MAX_HOURS * HOUR;
const TOKEN_TTL = HOUR; // must track RENEW_TTL / issueSession's expiresIn

test("the hard expiry is the cap PLUS one token lifetime", () => {
  // Not the cap itself. Past the cap the middleware stops RENEWING rather than
  // 401-ing, so the last token minted just under the wire stays valid for one more
  // TTL — the documented "worst case a session lives this + 1h". Enforcing the bare
  // cap here would disconnect sockets belonging to sessions HTTP is still serving.
  const ist = NOW - CAP;
  assert.equal(sessionHardExpirySec({ ist }), ist + CAP + TOKEN_TTL);
});

test("a fresh session is not past the limit", () => {
  assert.equal(sessionPastHardLimit({ ist: NOW }, NOW), false);
});

test("a session exactly at the cap is still allowed", () => {
  // It has up to one more token lifetime of legitimate life left.
  assert.equal(sessionPastHardLimit({ ist: NOW - CAP }, NOW), false);
});

test("a session one second past cap + TTL is refused", () => {
  assert.equal(sessionPastHardLimit({ ist: NOW - CAP - TOKEN_TTL - 1 }, NOW), true);
});

test("the boundary itself is refused (>=, not >)", () => {
  // At exactly cap + TTL the last possible token has expired, so nothing valid remains.
  assert.equal(sessionPastHardLimit({ ist: NOW - CAP - TOKEN_TTL }, NOW), true);
});

test("`iat` is the fallback when a token predates `ist`", () => {
  // A token minted before `ist` existed has no session anchor. Treating it as ageless
  // is the exact hole `ist` was introduced to close, so it is measured from `iat`
  // instead — its session is bounded from its current token rather than not at all.
  assert.equal(sessionPastHardLimit({ iat: NOW - CAP - TOKEN_TTL - 1 }, NOW), true);
  assert.equal(sessionPastHardLimit({ iat: NOW }, NOW), false);
});

test("`ist` wins over `iat` when both are present", () => {
  // Every renewal stamps a fresh `iat` while carrying `ist` through unchanged. Reading
  // `iat` in preference would make a renewed token look brand new and restore the
  // unbounded sliding window this exists to stop.
  const claims = { ist: NOW - CAP - TOKEN_TTL - 1, iat: NOW };
  assert.equal(sessionPastHardLimit(claims, NOW), true);
});

test("claims with no time anchor at all are not refused", () => {
  // `sessionHardExpirySec` returns null and the caller decides. Failing OPEN is correct
  // here and only here: a token with neither claim cannot be produced by this app
  // (jwt.sign always stamps `iat`), so reaching this means something upstream changed,
  // and the liveness predicate — account status and token_version — is the check that
  // actually guards the data. Refusing on a missing claim would turn a signing-side
  // change into a fleet-wide disconnect.
  assert.equal(sessionHardExpirySec({}), null);
  assert.equal(sessionPastHardLimit({}, NOW), false);
  assert.equal(sessionPastHardLimit(null, NOW), false);
  assert.equal(sessionPastHardLimit(undefined, NOW), false);
});

test("a non-numeric anchor is treated as absent, not coerced", () => {
  // A string "1800000000" would compare as NaN and silently never expire.
  assert.equal(sessionHardExpirySec({ ist: "1800000000" }), null);
  assert.equal(sessionPastHardLimit({ ist: "1800000000" }, NOW), false);
});

test("SESSION_MAX_HOURS is a positive number", () => {
  // It divides into every bound above; a zero or NaN would make every session either
  // instantly dead or immortal, and both fail quietly.
  assert.ok(Number.isFinite(SESSION_MAX_HOURS) && SESSION_MAX_HOURS > 0);
});
