import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createEncryptStream,
  decryptFileTo,
  verifyDecrypts,
  resolveKey,
  parseKey,
  HEADER_LEN,
} from "../services/backupCrypto.js";

const KEY = crypto.randomBytes(32);
const OTHER = crypto.randomBytes(32);

async function tmpFile(name) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cspc-bak-"));
  return path.join(dir, name);
}

async function encryptTo(file, data, key = KEY) {
  // Several chunks, so the header/tag framing is exercised across chunk boundaries.
  const chunks = [];
  for (let i = 0; i < data.length; i += 7000) chunks.push(data.subarray(i, i + 7000));
  await pipeline(Readable.from(chunks), createEncryptStream(key), fs.createWriteStream(file));
}

function collector() {
  const parts = [];
  const w = new Writable({
    write(c, _e, cb) {
      parts.push(c);
      cb();
    },
  });
  w.result = () => Buffer.concat(parts);
  return w;
}

test("round trip: what goes in comes out, across many chunks", async () => {
  const data = crypto.randomBytes(100_000);
  const file = await tmpFile("a.enc");
  await encryptTo(file, data);
  const out = collector();
  await decryptFileTo(file, out, KEY);
  assert.ok(out.result().equals(data));
});

test("the file on disk is not the plaintext", async () => {
  const data = Buffer.from("INSERT INTO users VALUES ('admin@cspc.edu.ph');".repeat(50));
  const file = await tmpFile("b.enc");
  await encryptTo(file, data);
  const raw = await fsp.readFile(file);
  assert.equal(raw.includes(Buffer.from("admin@cspc.edu.ph")), false);
});

test("a single flipped byte is detected as tampering", async () => {
  const file = await tmpFile("c.enc");
  await encryptTo(file, crypto.randomBytes(20_000));
  const raw = await fsp.readFile(file);
  raw[HEADER_LEN + 500] ^= 0x01;
  await fsp.writeFile(file, raw);
  await assert.rejects(verifyDecrypts(file, KEY), { code: "TAMPERED" });
});

test("a truncated archive is detected", async () => {
  const file = await tmpFile("d.enc");
  await encryptTo(file, crypto.randomBytes(20_000));
  const raw = await fsp.readFile(file);
  await fsp.writeFile(file, raw.subarray(0, raw.length - 3000));
  await assert.rejects(verifyDecrypts(file, KEY), { code: "TAMPERED" });
});

test("the wrong key says WRONG KEY, not 'corrupted'", async () => {
  const file = await tmpFile("e.enc");
  await encryptTo(file, crypto.randomBytes(1000));
  await assert.rejects(verifyDecrypts(file, OTHER), { code: "WRONG_KEY" });
});

test("a file that is not a backup is refused", async () => {
  const file = await tmpFile("f.sql.gz");
  await fsp.writeFile(file, crypto.randomBytes(500));
  await assert.rejects(verifyDecrypts(file, KEY), { code: "NOT_A_BACKUP" });
});

test("empty input still produces a valid archive", async () => {
  const file = await tmpFile("g.enc");
  await encryptTo(file, Buffer.alloc(0));
  const out = collector();
  await decryptFileTo(file, out, KEY);
  assert.equal(out.result().length, 0);
});

test("key resolution prefers BACKUP_ENC_KEY, then the existing keys", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  assert.equal(resolveKey({ BACKUP_ENC_KEY: a, SECRET_ENC_KEY: b }).source, "BACKUP_ENC_KEY");
  assert.equal(resolveKey({ SECRET_ENC_KEY: b }).source, "SECRET_ENC_KEY");
  assert.equal(resolveKey({ MIKROTIK_ENC_KEY: b }).source, "MIKROTIK_ENC_KEY");
  assert.equal(resolveKey({ BACKUP_ENC_KEY: "short", MIKROTIK_ENC_KEY: b }).source, "MIKROTIK_ENC_KEY");
  assert.equal(resolveKey({}).key, null);
  assert.equal(parseKey("zz".repeat(32)), null);
});
