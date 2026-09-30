import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// The key is read from the environment when used, so it is set before the import and
// can be changed later to simulate a rotation. No DB or .env.
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
  // The same community must not give the same ciphertext twice, or the column would
  // show which devices share a credential.
  assert.notEqual(writeCommunity("public"), writeCommunity("public"));
});

test("a blank community is null, not an empty credential", () => {
  // null is what an ICMP-only router stores, as opposed to an empty community string.
  assert.equal(writeCommunity(""), null);
  assert.equal(writeCommunity("   "), null);
  assert.equal(writeCommunity(null), null);
  assert.equal(writeCommunity(undefined), null);
});

test("surrounding whitespace is trimmed before encryption", () => {
  // A trailing space from the form is not part of the community and SNMP would reject it.
  assert.equal(readCommunity(writeCommunity("  public  ")), "public");
});

test("a legacy plaintext value is read back as-is", () => {
  // Unprefixed values (the in-place migration, the dev simulator seed) are plaintext and
  // must never be decrypted.
  assert.equal(readCommunity("dev-router"), "dev-router");
  assert.equal(readCommunity("public"), "public");
  assert.equal(isEncrypted("dev-router"), false);
});

test("base64-looking plaintext is still read as plaintext", () => {
  // Why the format has a marker: base64 decoding accepts almost anything, so "does it
  // decode?" cannot tell ciphertext from plaintext.
  const looksLikeB64 = "cHVibGljCg";
  assert.equal(readCommunity(looksLikeB64), looksLikeB64);
});

test("null and undefined read back as the empty string", () => {
  assert.equal(readCommunity(null), "");
  assert.equal(readCommunity(undefined), "");
});

test("a value encrypted under another key fails closed, not open", () => {
  // A key mismatch loses one device ("" fails connFor), never sends ciphertext to the router.
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
  // GCM: a modified row fails to decrypt instead of giving different bytes.
  const stored = writeCommunity("cspc-ictu-ro");
  const body = stored.slice(PREFIX.length);
  const raw = Buffer.from(body, "base64");
  raw[raw.length - 1] ^= 0xff; // flip a bit in the ciphertext
  assert.equal(readCommunity(PREFIX + raw.toString("base64")), "");
});

test("with no key configured, values are stored readable and still round-trip", () => {
  // With no key set, registering still works (stored as plaintext with a warning).
  // See communityCrypto.js.
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
  // Checks the encrypted value still fits the column. 64 characters is already far
  // longer than any real community.
  const stored = writeCommunity("x".repeat(64));
  assert.ok(stored.length <= 255, `stored length ${stored.length} exceeds VARCHAR(255)`);
});
