import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// The module reads its key from the environment at call time (createCipherSuite closes
// over the NAMES, not the values), so the key has to be in place before the import —
// and can be changed afterwards to simulate a rotation. No DB, no .env, in keeping with
// the rest of backend/tests.
const KEY_A = crypto.randomBytes(32).toString("hex");
const KEY_B = crypto.randomBytes(32).toString("hex");
process.env.SECRET_ENC_KEY = KEY_A;

const { writeCommunity, readCommunity, isEncrypted, PREFIX } = await import(
  "../services/communityCrypto.js"
);

test("a community round-trips through encryption", () => {
  const stored = writeCommunity("cspc-ictu-ro");
  assert.notEqual(stored, "cspc-ictu-ro", "the plaintext must not survive into the column");
  assert.ok(isEncrypted(stored));
  assert.equal(readCommunity(stored), "cspc-ictu-ro");
});

test("the same input encrypts differently every time (random IV)", () => {
  // Two identical communities must not produce identical ciphertext — otherwise the
  // column leaks which devices share a credential, and equal-ciphertext becomes a
  // tempting shortcut for the duplicate-endpoint check, which would then be a matcher
  // that works right up until the row is re-saved.
  assert.notEqual(writeCommunity("public"), writeCommunity("public"));
});

test("a blank community is null, not an empty credential", () => {
  // null is what device_network stores for an ICMP-only router. "" would be a community
  // string that happens to be empty, and loadDevices' pingOnly test would still work by
  // accident while connFor's guard read it as a configured-but-blank credential.
  assert.equal(writeCommunity(""), null);
  assert.equal(writeCommunity("   "), null);
  assert.equal(writeCommunity(null), null);
  assert.equal(writeCommunity(undefined), null);
});

test("surrounding whitespace is trimmed before encryption", () => {
  // A trailing space pasted into the add-device form is not part of the community, and
  // SNMP would reject it. Trimming at the boundary means the stored value is the one the
  // device will actually accept.
  assert.equal(readCommunity(writeCommunity("  public  ")), "public");
});

test("a legacy plaintext value is read back as-is", () => {
  // The migration is in-place and the dev simulator's seed SQL inserts plaintext
  // directly, so an unprefixed value must never be run through decrypt(). This is
  // permanent tolerance, not a migration window.
  assert.equal(readCommunity("dev-router"), "dev-router");
  assert.equal(readCommunity("public"), "public");
  assert.equal(isEncrypted("dev-router"), false);
});

test("base64-looking plaintext is still read as plaintext", () => {
  // The reason the format carries a marker at all. Node's base64 decoder is lenient
  // enough to turn almost anything into bytes, so "does it decode?" is not a usable test
  // for "is it ciphertext" — a wrong guess would silently destroy a working community.
  const looksLikeB64 = "cHVibGljCg";
  assert.equal(readCommunity(looksLikeB64), looksLikeB64);
});

test("null and undefined read back as the empty string", () => {
  assert.equal(readCommunity(null), "");
  assert.equal(readCommunity(undefined), "");
});

test("a value encrypted under another key fails closed, not open", () => {
  // The poller must lose ONE device to a key mismatch, not mistake ciphertext for a
  // community string and present it to the router. "" then fails connFor's guard, which
  // is the correct blast radius.
  const underA = writeCommunity("secret-community");
  process.env.SECRET_ENC_KEY = KEY_B;
  try {
    const out = readCommunity(underA);
    assert.equal(out, "");
    assert.notEqual(out, "secret-community");
  } finally {
    process.env.SECRET_ENC_KEY = KEY_A;
  }
});

test("tampering with stored ciphertext is rejected (GCM is authenticated)", () => {
  // The point of GCM over CBC here: a modified row fails to open rather than decrypting
  // to different bytes. A community silently mutated in the database would be an
  // authentication failure at the device that nothing in the log could explain.
  const stored = writeCommunity("cspc-ictu-ro");
  const body = stored.slice(PREFIX.length);
  const raw = Buffer.from(body, "base64");
  raw[raw.length - 1] ^= 0xff; // flip a bit in the ciphertext
  assert.equal(readCommunity(PREFIX + raw.toString("base64")), "");
});

test("with no key configured, values are stored readable and still round-trip", () => {
  // The documented degradation: a deployment with neither key set keeps working rather
  // than refusing to register a device over an unrelated missing variable. The warning
  // on every such write is what stops it being quiet — see communityCrypto.js.
  const savedSecret = process.env.SECRET_ENC_KEY;
  const savedMikrotik = process.env.MIKROTIK_ENC_KEY;
  delete process.env.SECRET_ENC_KEY;
  delete process.env.MIKROTIK_ENC_KEY;
  try {
    const stored = writeCommunity("public");
    assert.equal(stored, "public");
    assert.equal(isEncrypted(stored), false);
    assert.equal(readCommunity(stored), "public");
  } finally {
    process.env.SECRET_ENC_KEY = savedSecret;
    if (savedMikrotik !== undefined) process.env.MIKROTIK_ENC_KEY = savedMikrotik;
  }
});

test("ciphertext fits the VARCHAR(255) column for a realistic community", () => {
  // The migration widened nothing because it did not have to; this is the assertion that
  // makes that a checked fact rather than an estimate. 64 characters is already far
  // beyond any community string in practice.
  const stored = writeCommunity("x".repeat(64));
  assert.ok(stored.length <= 255, `stored length ${stored.length} exceeds VARCHAR(255)`);
});
