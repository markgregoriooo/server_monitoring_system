-- Stop storing SNMP community strings in readable form.
--
-- A v2c community is the credential for reading a router or UPS, and the nightly
-- database dump is copied offsite (ops/db-backup, ops/offsite-backup). Encrypted, like
-- mikrotik_devices.api_password; not hashed, because the poller has to send the value to
-- the device (services/secretCrypto.js).
--
-- ── No data change in this file ────────────────────────────────────
-- The key is in backend/.env, which MySQL does not have, so Node does the conversion:
--
--     cd backend && npm run rekey -- --encrypt-plaintext
--
-- Safe to run repeatedly. Until then nothing breaks: services/communityCrypto.js reads a
-- value without the `gcm1:` prefix as plaintext (the dev simulator seed inserts plaintext).
--
-- ── Column width ───────────────────────────────────────────────────────────────
-- Stored as "gcm1:" + base64([iv(12) | tag(16) | ciphertext]), about 130 characters for
-- a 64-character community. VARCHAR(255) fits; this statement just makes the width
-- explicit and changes nothing on an unchanged schema.

ALTER TABLE `device_network`
  MODIFY COLUMN `snmp_community` VARCHAR(255) DEFAULT NULL
  COMMENT 'AES-256-GCM, "gcm1:"-prefixed (services/communityCrypto.js). An unprefixed value is legacy/hand-written plaintext and is still read as-is. NULL/blank = ICMP-only monitoring.';
