import crypto from "crypto";

// ─── AES-256-GCM for the RouterOS API password ────────────────────────────────
//
// The MikroTik api_password is LOGIN material, so it's stored encrypted at rest in
// mikrotik_devices.api_password (VARCHAR(255)) — ciphertext base64-encoded, never
// plaintext, never returned to the UI. Decrypted only in-memory by the poller.
//
// Key: MIKROTIK_ENC_KEY in backend/.env — 64 hex chars (32 bytes). Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// Stored format (base64):  [ iv(12) | authTag(16) | ciphertext ]

const ALGO = "aes-256-gcm";
const KEY_RE = /^[0-9a-fA-F]{64}$/;

function getKey() {
  const hex = (process.env.MIKROTIK_ENC_KEY || "").trim();
  if (!KEY_RE.test(hex)) {
    throw new Error(
      "MIKROTIK_ENC_KEY must be 64 hex chars (32 bytes). Generate: " +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return Buffer.from(hex, "hex");
}

export function isConfigured() {
  return KEY_RE.test((process.env.MIKROTIK_ENC_KEY || "").trim());
}

export function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decrypt(b64) {
  const key = getKey();
  const raw = Buffer.from(String(b64), "base64");
  if (raw.length < 28) throw new Error("ciphertext too short");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

export default { isConfigured, encrypt, decrypt };
