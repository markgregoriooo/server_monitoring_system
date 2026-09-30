import secretCrypto from "./secretCrypto.js";

// ─── SNMP community strings, encrypted at rest ─────────────────────────────────
// A v2c community is the credential for reading a device, and the nightly database
// dump is copied offsite (ops/db-backup, ops/offsite-backup), so the column is
// encrypted like mikrotik_devices.api_password. Encryption, not a hash, because the
// poller has to send the value to the device.
//
// ── Stored format ──────────────────────────────────────────────────────────────
//   "gcm1:" + base64([ iv(12) | authTag(16) | ciphertext ])
//
// The prefix tells ciphertext from plaintext exactly (base64 decoding alone would
// "succeed" on a plain string like `dev-router`). Unprefixed values are always read
// as plaintext, e.g. the dev-snmpsim seed or a row fixed by hand.

export const PREFIX = "gcm1:";

let noKeyReported = false;
let decryptFailureReported = false;

/** True when an encryption key (SECRET_ENC_KEY, else MIKROTIK_ENC_KEY) is configured. */
export const isConfigured = () => secretCrypto.isConfigured();

/**
 * Encrypt a community for storage. Returns null for blank (an ICMP-only router).
 * Stores plaintext with a warning when no key is configured, so registering a
 * router does not fail on an unrelated setting.
 */
export function writeCommunity(plaintext) {
  const s = plaintext == null ? "" : String(plaintext).trim();
  if (!s) return null;
  if (!secretCrypto.isConfigured()) {
    if (!noKeyReported) {
      noKeyReported = true;
      console.warn(
        "[SNMP] No SECRET_ENC_KEY or MIKROTIK_ENC_KEY configured — SNMP community strings " +
          "are being stored in PLAINTEXT. They are then included in the nightly mysqldump " +
          "and in whatever that folder is synced to. Set SECRET_ENC_KEY in backend/.env " +
          '(node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))") ' +
          "and re-save the affected devices.",
      );
    }
    return s;
  }
  return PREFIX + secretCrypto.encrypt(s);
}

/**
 * Read a stored community back (encrypted or plaintext); "" for null/blank. A
 * decryption failure returns "" instead of throwing, so only that one device fails
 * connFor() and the rest keep being polled.
 */
export function readCommunity(stored) {
  if (stored == null) return "";
  const s = String(stored);
  if (!s.startsWith(PREFIX)) return s.trim();
  try {
    return secretCrypto.decrypt(s.slice(PREFIX.length));
  } catch (err) {
    if (!decryptFailureReported) {
      decryptFailureReported = true;
      console.error(
        `[SNMP] Cannot decrypt a stored SNMP community: ${err.message}\n` +
          "[SNMP] This almost always means SECRET_ENC_KEY / MIKROTIK_ENC_KEY in backend/.env is\n" +
          "[SNMP] not the key the value was encrypted under. Those devices cannot be polled\n" +
          "[SNMP] until the key is restored, or the community is re-entered in the dashboard.",
      );
    }
    return "";
  }
}

/** Whether a stored value is already in the encrypted form. Used by the rekey script. */
export const isEncrypted = (stored) => typeof stored === "string" && stored.startsWith(PREFIX);

export default { isConfigured, writeCommunity, readCommunity, isEncrypted, PREFIX };
