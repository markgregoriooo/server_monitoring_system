import { createCipherSuite } from "./secretCrypto.js";

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
//
// The algorithm now lives in secretCrypto.js, which install keys share. This module
// stays because it pins MIKROTIK_ENC_KEY and ONLY that name: the general suite accepts
// a SECRET_ENC_KEY fallback, and if someone set that here, every password already
// encrypted under MIKROTIK_ENC_KEY would stop decrypting and the poller would silently
// fail to log in. Passwords already in the database keep working exactly as before.

const suite = createCipherSuite(["MIKROTIK_ENC_KEY"]);

export const { isConfigured, encrypt, decrypt } = suite;
export default suite;
