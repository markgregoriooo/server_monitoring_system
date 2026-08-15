import crypto from "node:crypto";

// ─── AES-256-GCM for secrets that must be READ BACK, not just verified ──────────
//
// The general form of what mikrotikCrypto.js has always done for the RouterOS API
// password. Two things now need reversible storage, so the algorithm lives here once
// and each caller binds it to its own key.
//
// WHEN TO USE THIS vs A HASH:
//   hash (installKeyUtils.hashKey)  — you only ever need to ANSWER "is this the same
//                                     value?". One-way. Always preferable.
//   this                            — a human has to see the original again later.
//
// An install key needs both: the hash is what the enrollment path matches on (indexed,
// one lookup), while the ciphertext is what lets an admin re-open the install command
// tomorrow. Storing it encrypted rather than plaintext means a database dump — including
// the nightly mysqldump that ops/db-backup drops onto the backup drive, and anything
// rclone syncs offsite from there — does not hand over usable credentials on its own.
// The key lives in backend/.env, which is not in the database and not in the backup.
//
// Stored format (base64):  [ iv(12) | authTag(16) | ciphertext ]
// GCM is authenticated, so tampering with a stored value fails decryption rather than
// silently returning corrupted bytes.

const ALGO = "aes-256-gcm";
const KEY_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Bind the cipher to one or more env var names, tried in order.
 *
 * The list exists so a caller can move to a better-named variable without breaking data
 * already encrypted under the old one — but note that switching WHICH key is present
 * makes existing ciphertext undecryptable, so a caller that already has stored data
 * (mikrotikCrypto) pins exactly one name rather than accepting a fallback.
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

// The general-purpose suite. Prefers a purpose-neutral SECRET_ENC_KEY, and falls back to
// MIKROTIK_ENC_KEY so an existing deployment — which already has that one set, because
// MikroTik monitoring requires it — gains this with no new configuration.
const suite = createCipherSuite(["SECRET_ENC_KEY", "MIKROTIK_ENC_KEY"]);

export const { isConfigured, encrypt, decrypt } = suite;
export default suite;
