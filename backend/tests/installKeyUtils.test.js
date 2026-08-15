import test from "node:test";
import assert from "node:assert/strict";
import {
  KEY_PREFIX,
  KEY_BYTES,
  DISPLAY_PREFIX_LEN,
  generateKey,
  hashKey,
  prefixOf,
  looksLikeKey,
  keyRejection,
  isUsable,
  keyStatus,
} from "../services/installKeyUtils.js";

const HOUR = 3_600_000;
const NOW = new Date("2026-08-15T12:00:00Z");

// A row as the enrollment lookup reads it back: usable, no expiry, never revoked.
const LIVE_KEY = { install_key_id: 1, revoked_at: null, expires_at: null };

test("a generated key is prefixed and full width", () => {
  const key = generateKey();
  assert.ok(key.startsWith(KEY_PREFIX));
  assert.equal(key.length, KEY_PREFIX.length + KEY_BYTES * 2);
  assert.equal(looksLikeKey(key), true);
});

test("keys are unique across a batch", () => {
  // Not a randomness test — a guard against ever swapping in a counter or a timestamp.
  const seen = new Set(Array.from({ length: 500 }, generateKey));
  assert.equal(seen.size, 500);
});

test("the hash is stable, and different keys hash differently", () => {
  const a = generateKey();
  const b = generateKey();
  assert.equal(hashKey(a), hashKey(a));
  assert.notEqual(hashKey(a), hashKey(b));
  assert.match(hashKey(a), /^[0-9a-f]{64}$/); // char(64) in the schema
});

test("the stored prefix is short enough to leak nothing useful", () => {
  const key = generateKey();
  assert.equal(prefixOf(key), key.slice(0, DISPLAY_PREFIX_LEN));
  // The displayed fragment must stay a small fraction of the secret.
  assert.ok(DISPLAY_PREFIX_LEN < key.length / 3);
});

test("malformed input is rejected before it can reach a query", () => {
  for (const bad of [
    null,
    undefined,
    42,
    "",
    "not-a-key",
    KEY_PREFIX, // prefix alone
    KEY_PREFIX + "zz".repeat(KEY_BYTES), // right length, not hex
    KEY_PREFIX + "ab".repeat(KEY_BYTES - 1), // hex, too short
    generateKey().toUpperCase(), // hex is lower-case as generated
    " " + generateKey(), // stray whitespace
  ]) {
    assert.equal(looksLikeKey(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test("a live key is usable", () => {
  assert.equal(keyRejection(LIVE_KEY, NOW), null);
  assert.equal(isUsable(LIVE_KEY, NOW), true);
  assert.equal(keyStatus(LIVE_KEY, NOW), "active");
});

test("a key with no matching row reads as unknown, not as a crash", () => {
  // The enrollment path passes whatever the SELECT returned, which is undefined on a miss.
  assert.equal(keyRejection(undefined, NOW), "unknown");
  assert.equal(isUsable(undefined, NOW), false);
});

test("a revoked key is refused", () => {
  const revoked = { ...LIVE_KEY, revoked_at: new Date(NOW.getTime() - HOUR) };
  assert.equal(keyRejection(revoked, NOW), "revoked");
  assert.equal(keyStatus(revoked, NOW), "revoked");
});

test("revoked beats expired — a withdrawn key is withdrawn regardless of its dates", () => {
  const both = {
    ...LIVE_KEY,
    revoked_at: new Date(NOW.getTime() - HOUR),
    expires_at: new Date(NOW.getTime() - 2 * HOUR),
  };
  assert.equal(keyRejection(both, NOW), "revoked");
});

test("an expired key is refused; a future expiry is not", () => {
  const expired = { ...LIVE_KEY, expires_at: new Date(NOW.getTime() - 1) };
  const valid = { ...LIVE_KEY, expires_at: new Date(NOW.getTime() + HOUR) };
  assert.equal(keyRejection(expired, NOW), "expired");
  assert.equal(keyRejection(valid, NOW), null);
});

test("expiry is inclusive at the boundary — a key is dead ON its expiry instant", () => {
  const atBoundary = { ...LIVE_KEY, expires_at: new Date(NOW.getTime()) };
  assert.equal(keyRejection(atBoundary, NOW), "expired");
});

test("MySQL hands timestamps back as strings on some drivers — both parse", () => {
  const asString = { ...LIVE_KEY, expires_at: "2026-08-15T11:00:00.000Z" };
  assert.equal(keyRejection(asString, NOW), "expired");
});
