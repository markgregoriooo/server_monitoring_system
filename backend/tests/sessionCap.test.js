import test from "node:test";
import assert from "node:assert/strict";
import {
  sessionHardExpirySec,
  sessionPastHardLimit,
  SESSION_MAX_HOURS,
} from "../middleware/auth.js";

// ─── Absolute session cap ─────────────────────────────────────────────
// `ist` + SESSION_MAX_HOURS is the only limit on a session that keeps being used.
// It was only applied when renewing, which never affects a Socket.IO connection.
// These test the shared check now used by the handshake and the revocation sweep.
// auth.js imports the mysql pool, but creating a pool opens no connection.

const HOUR = 3600;
const NOW = 1_800_000_000; // fixed clock, so nothing here depends on wall time
const CAP = SESSION_MAX_HOURS * HOUR;
const TOKEN_TTL = HOUR; // must track RENEW_TTL / issueSession's expiresIn

test("the hard expiry is the cap PLUS one token lifetime", () => {
  // Cap + one token lifetime, not the bare cap: the last token issued before the cap
  // stays valid for one more hour, and HTTP still serves it.
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
  // A token from before `ist` existed is measured from `iat`, not treated as ageless.
  assert.equal(sessionPastHardLimit({ iat: NOW - CAP - TOKEN_TTL - 1 }, NOW), true);
  assert.equal(sessionPastHardLimit({ iat: NOW }, NOW), false);
});

test("`ist` wins over `iat` when both are present", () => {
  // Renewal gives a new `iat` but keeps `ist`; reading `iat` first would make a renewed
  // token look new.
  const claims = { ist: NOW - CAP - TOKEN_TTL - 1, iat: NOW };
  assert.equal(sessionPastHardLimit(claims, NOW), true);
});

test("claims with no time anchor at all are not refused", () => {
  // With neither claim, `sessionHardExpirySec` returns null. This app always sets `iat`,
  // so it cannot normally happen; the status/token_version check still applies.
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
