import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// ─── Weekly backup encryption (AES-256-GCM, streaming) ────────────────────────
// The weekly archive holds the WHOLE database — users, audit trail, the agent and
// MikroTik secrets' ciphertexts — so it is encrypted before it touches the USB drive.
// The nightly host dump (mysql-*.sql.gz) never was; only the offsite copy was, by rclone.
//
// File layout:
//   "CSPCBAK1" (8) | keyId (6) | iv (12) | ciphertext … | GCM tag (16)
//
// keyId is the first 6 bytes of SHA-256(key). It is not secret and proves nothing
// cryptographically; it exists so a restore with the wrong key says "wrong key"
// instead of the generic GCM failure, which reads exactly like a corrupted file.
//
// The tag sits at the END because the cipher only knows it after the last byte, and
// the archive is streamed (a week of samples can be hundreds of MB). Decryption reads
// the tag first (the file is on disk, so its last 16 bytes are addressable), then
// streams the middle — still constant memory.
//
// Key: BACKUP_ENC_KEY, falling back to SECRET_ENC_KEY, then MIKROTIK_ENC_KEY, so an
// existing deployment gets encrypted backups with no new config. ⚠️ Whatever key was
// in force when a backup was made is needed to open it: rotating that key
// (`npm run rekey`) does NOT re-encrypt old archives. Keep the old key with the
// offline copy of backend/.env until the last archive made under it has aged out.

export const MAGIC = Buffer.from("CSPCBAK1", "ascii");
const KEY_ID_LEN = 6;
const IV_LEN = 12;
const TAG_LEN = 16;
export const HEADER_LEN = MAGIC.length + KEY_ID_LEN + IV_LEN;

const KEY_ENV = ["BACKUP_ENC_KEY", "SECRET_ENC_KEY", "MIKROTIK_ENC_KEY"];

/** Parse a 64-hex key, or null. */
export function parseKey(hex) {
  const v = String(hex ?? "").trim();
  return /^[0-9a-fA-F]{64}$/.test(v) ? Buffer.from(v, "hex") : null;
}

/** The backup key from the environment, and which variable it came from. */
export function resolveKey(env = process.env) {
  for (const name of KEY_ENV) {
    const key = parseKey(env[name]);
    if (key) return { key, source: name };
  }
  return { key: null, source: null };
}

/** First 6 bytes of SHA-256(key) — tells keys apart, reveals nothing about them. */
export function keyIdOf(key) {
  return crypto.createHash("sha256").update(key).digest().subarray(0, KEY_ID_LEN);
}

/** A transform that turns plaintext into the file layout above. */
export function createEncryptStream(key) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let headerSent = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (!headerSent) {
        this.push(Buffer.concat([MAGIC, keyIdOf(key), iv]));
        headerSent = true;
      }
      cb(null, cipher.update(chunk));
    },
    flush(cb) {
      if (!headerSent) this.push(Buffer.concat([MAGIC, keyIdOf(key), iv])); // empty input
      this.push(cipher.final());
      this.push(cipher.getAuthTag());
      cb();
    },
  });
}

/** An Error with a `code` the callers and the restore script can branch on. */
function backupError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Decrypt `srcPath` into `dest` (a writable stream). Rejects with code:
 *   NOT_A_BACKUP  — not this format (or truncated below the header + tag)
 *   WRONG_KEY     — made with a different key
 *   TAMPERED      — the bytes were changed or cut short after encryption
 */
export async function decryptFileTo(srcPath, dest, key) {
  const { size } = await fsp.stat(srcPath);
  if (size < HEADER_LEN + TAG_LEN) throw backupError("NOT_A_BACKUP", "File is too short to be a backup archive.");

  const fh = await fsp.open(srcPath, "r");
  let header;
  let tag;
  try {
    header = Buffer.alloc(HEADER_LEN);
    await fh.read(header, 0, HEADER_LEN, 0);
    tag = Buffer.alloc(TAG_LEN);
    await fh.read(tag, 0, TAG_LEN, size - TAG_LEN);
  } finally {
    await fh.close();
  }

  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw backupError("NOT_A_BACKUP", "Not a CSPC-ICTU backup archive (unknown header).");
  }
  const fileKeyId = header.subarray(MAGIC.length, MAGIC.length + KEY_ID_LEN);
  if (!fileKeyId.equals(keyIdOf(key))) {
    throw backupError(
      "WRONG_KEY",
      `This backup was encrypted with a different key (key id ${fileKeyId.toString("hex")}, ` +
        `current key id ${keyIdOf(key).toString("hex")}). Use the key that was in backend/.env when it was made.`,
    );
  }
  const iv = header.subarray(MAGIC.length + KEY_ID_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const body = size - HEADER_LEN - TAG_LEN;
  const src = body > 0
    ? fs.createReadStream(srcPath, { start: HEADER_LEN, end: HEADER_LEN + body - 1 })
    : Readable.from([]); // an archive of empty input: nothing between header and tag
  try {
    await pipeline(src, decipher, dest);
  } catch (err) {
    if (/unable to authenticate|auth/i.test(err?.message ?? "")) {
      throw backupError("TAMPERED", "The archive failed its integrity check — it was modified or is damaged.");
    }
    throw err;
  }
}

/** Decrypt to nowhere: proves the archive opens with `key` and was not modified. */
export async function verifyDecrypts(srcPath, key) {
  const sink = new Transform({ transform: (_c, _e, cb) => cb() });
  sink.resume();
  await decryptFileTo(srcPath, sink, key);
}

/** Streaming SHA-256 of a file, hex. */
export function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(absPath);
    s.on("error", reject);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

export default {
  MAGIC,
  HEADER_LEN,
  parseKey,
  resolveKey,
  keyIdOf,
  createEncryptStream,
  decryptFileTo,
  verifyDecrypts,
  sha256File,
};
