import { createCipherSuite } from "./secretCrypto.js";

// ─── AES-256-GCM for the RouterOS API password ────────────────────────────────
// The API password is stored encrypted in mikrotik_devices.api_password (base64),
// never returned to the UI and only decrypted in memory by the poller.
//
// Key: MIKROTIK_ENC_KEY in backend/.env, 64 hex chars (32 bytes). Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//
// Stored format (base64):  [ iv(12) | authTag(16) | ciphertext ]
//
// Uses secretCrypto.js but only with MIKROTIK_ENC_KEY: allowing the SECRET_ENC_KEY
// fallback here would make already-stored passwords undecryptable.

const suite = createCipherSuite(["MIKROTIK_ENC_KEY"]);

export const { isConfigured, encrypt, decrypt } = suite;
export default suite;
