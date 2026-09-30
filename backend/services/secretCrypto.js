import crypto from "node:crypto";

// ─── AES-256-GCM for secrets that must be read back ──────────
// Used when a person needs to see the original value again. When you only need to
// check "is this the same value?", use a hash instead (installKeyUtils.hashKey).
//
// Install keys use both: the hash for the enrollment lookup, the ciphertext so an
// admin can reopen the install command. Encrypted values mean a database dump (the
// nightly backup included) does not contain usable credentials; the key is only in
// backend/.env.
//
// Stored format (base64):  [ iv(12) | authTag(16) | ciphertext ]
// GCM is authenticated, so a tampered value fails to decrypt.

const ALGO = "aes-256-gcm";
const KEY_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Bind the cipher to one or more env var names, tried in order. Changing which key is
 * present makes existing ciphertext unreadable, so a caller that already has stored
 * data (mikrotikCrypto) pins a single name.
 */
export function createCipherSuite(envNames) {
  const names = Array.isArray(envNames) ? envNames : [envNames];

  const keyHex = () => {
    for (const n of names) {
      const v = (process.env[n] ?? "").trim();
      if (KEY_RE.test(v)) return v;
    }
    return null;
  };

  function getKey() {
    const hex = keyHex();
    if (!hex) {
      throw new Error(
        `${names[0]} must be 64 hex chars (32 bytes). Generate: ` +
          `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
      );
    }
    return Buffer.from(hex, "hex");
  }

  return {
    /** True when a usable key is configured — lets callers degrade instead of throwing. */
    isConfigured: () => keyHex() !== null,

    encrypt(plaintext) {
      const key = getKey();
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(ALGO, key, iv);
      const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
    },

    decrypt(b64) {
      const key = getKey();
      const raw = Buffer.from(String(b64), "base64");
      if (raw.length < 28) throw new Error("ciphertext too short");
      const decipher = crypto.createDecipheriv(ALGO, key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    },
  };
}

// General-purpose suite: SECRET_ENC_KEY, falling back to MIKROTIK_ENC_KEY so existing
// deployments need no new setting.
const suite = createCipherSuite(["SECRET_ENC_KEY", "MIKROTIK_ENC_KEY"]);

export const { isConfigured, encrypt, decrypt } = suite;
export default suite;
