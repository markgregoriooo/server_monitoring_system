// `npm run backup:decrypt -- <archive.tar.gz.enc> [output.tar.gz] [--key <64 hex>]`
//
// Turns a weekly/manual system backup back into a plain .tar.gz, which `tar -xzf`
// (Linux, macOS, and Windows 10+ built-in tar) opens into:
//   manifest.json   what is inside + SHA-256 of every file
//   database.sql    full MySQL dump — load with `mariadb <db> < database.sql`
//   data/*.ndjson   that week's samples
//
// The key: --key if given, else BACKUP_ENC_KEY → SECRET_ENC_KEY → MIKROTIK_ENC_KEY
// from backend/.env, the same order the backend used. An archive made BEFORE a key
// rotation needs the OLD key, passed with --key.
//
// Restoring is deliberately a command, not a button on the Backups page: one click —
// or one stolen admin session — must not be able to replace the live database.
// The full procedure is in backup-storage.md ("Restoring a weekly backup").

import "../config/env.js";
import fs from "node:fs";
import path from "node:path";
import backupCrypto from "../services/backupCrypto.js";

const args = process.argv.slice(2);
const keyFlag = args.indexOf("--key");
const keyHex = keyFlag >= 0 ? args.splice(keyFlag, 2)[1] : null;
const [src, outArg] = args;

if (!src) {
  console.log("Usage: npm run backup:decrypt -- <archive.tar.gz.enc> [output.tar.gz] [--key <64 hex>]");
  process.exit(2);
}
if (!fs.existsSync(src)) {
  console.error(`No such file: ${src}`);
  process.exit(2);
}

const key = keyHex ? backupCrypto.parseKey(keyHex) : backupCrypto.resolveKey().key;
if (!key) {
  console.error(
    keyHex
      ? "--key must be 64 hex characters."
      : "No key found. Set BACKUP_ENC_KEY (or SECRET_ENC_KEY / MIKROTIK_ENC_KEY) in backend/.env, or pass --key.",
  );
  process.exit(2);
}

const out = outArg ?? src.replace(/\.enc$/, "").replace(/(\.tar\.gz)?$/, ".tar.gz");
if (path.resolve(out) === path.resolve(src)) {
  console.error("The output would overwrite the archive. Give an output file name.");
  process.exit(2);
}
const tmp = `${out}.part`;

try {
  await backupCrypto.decryptFileTo(src, fs.createWriteStream(tmp), key);
  fs.renameSync(tmp, out);
  console.log(`Decrypted and verified → ${out}`);
  console.log(`Next:  tar -xzf "${out}"   then see manifest.json and backup-storage.md`);
} catch (err) {
  fs.rmSync(tmp, { force: true });
  const hint = {
    WRONG_KEY: "Pass the key that was in backend/.env when this backup was made: --key <64 hex>.",
    TAMPERED: "Do not restore from this file. Use another week's archive or the offsite copy.",
    NOT_A_BACKUP: "This is not a weekly/manual system backup (.tar.gz.enc).",
  }[err.code];
  console.error(`FAILED: ${err.message}`);
  if (hint) console.error(hint);
  process.exit(1);
}
