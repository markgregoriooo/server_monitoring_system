import secretCrypto from "./secretCrypto.js";

// ─── SNMP community strings, encrypted at rest ─────────────────────────────────
//
// `device_network.snmp_community` held its value verbatim. An SNMPv2c community IS the
// credential — there is no user, no challenge and no transport security; whoever holds
// the string can read the device's full MIB over UDP.
//
// WHY THAT MATTERS HERE SPECIFICALLY, and it is not "if someone reads the database":
// `ops/db-backup/dump-mysql.sh` writes a full mysqldump of this schema into BACKUP_DIR,
// and `ops/offsite-backup/sync-offsite.sh` rclone-copies that folder to Backblaze. So
// the community string for every router and UPS on the campus network was leaving the
// building nightly, in a file on third-party storage. That is the exact argument
// migrations/2026-08-25_agent_token_hash.sql makes for agent tokens and
// 2026-08-15b_install_key_reveal.sql makes for install keys. This column was simply the
// one nobody came back to — meanwhile `mikrotik_devices.api_password`, one table over,
// has been AES-256-GCM since it was introduced.
//
// A HASH would be wrong here, for the reason secretCrypto.js sets out: the poller has to
// PRESENT this value to the device on every cycle, so it must be recoverable. Reversible
// storage is the requirement, not a shortcut.
//
// ── Stored format ──────────────────────────────────────────────────────────────
//   "gcm1:" + base64([ iv(12) | authTag(16) | ciphertext ])
//
// The prefix is what makes an IN-PLACE migration of a live column safe. Without a
// marker, telling ciphertext from a legacy plaintext community means guessing, and
// Node's base64 decoder is lenient enough to "successfully" decode `dev-router` into
// bytes — so a wrong guess turns a working community into an unusable one silently.
// With it, `readCommunity` can be exact: prefixed → decrypt, otherwise → return as
// written. That tolerance is deliberate and permanent, not a migration window: the
// dev simulator's seed SQL (dev-snmpsim/seed-dev-devices.sql) inserts plaintext
// directly, and a hand-fixed row during an incident should not break the poller.

export const PREFIX = "gcm1:";

let noKeyReported = false;
let decryptFailureReported = false;

/** True when an encryption key (SECRET_ENC_KEY, else MIKROTIK_ENC_KEY) is configured. */
export const isConfigured = () => secretCrypto.isConfigured();

/**
 * Encrypt a community string for storage. Returns null for a blank input, which is the
 * ICMP-only router case and means "no SNMP credential", not "empty credential".
 *
 * ⚠️ Degrades to storing plaintext when no key is configured, rather than throwing.
 * agentService.approve() takes the opposite line for agent tokens and is right to: it
 * MINTS a credential, so refusing costs nothing. This value is supplied by an admin to
 * describe a device that already exists, and refusing would mean "you cannot register
 * your router because an unrelated variable is unset" — which ends with the feature
 * being worked around rather than the variable being set. The warning fires on every
 * such write so the condition cannot stay quiet.
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
 * Read a stored community string back. Accepts both the encrypted form and a legacy or
 * hand-written plaintext value; returns "" for null/blank.
 *
 * A decryption failure returns "" rather than throwing: the poller's job is to keep
 * polling the devices it CAN reach, and one device encrypted under a key that has since
 * changed must not take down the cycle for all of them. The empty string then fails the
 * connFor() guard for that device alone, which is the correct blast radius.
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
