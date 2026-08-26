import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashKey } from "../services/installKeyUtils.js";

// ─── The Node ↔ SQL hashing contract ──────────────────────────────────────────
//
// The agent-token migration backfills its lookup column with MySQL's SHA2(x, 256) while
// the backend looks that column up with Node's hashKey(). Two implementations of one
// value, in two languages, that must agree byte for byte forever — and if they ever stop
// agreeing, nothing throws: the lookup simply never matches, every agent 403s, and a
// monitoring system reports that every server died at once.
//
// Same guard, and the same reasoning, as contract.test.js parsing the Go collector: when
// a contract is hand-duplicated across a language boundary, a test has to hold it.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(__dirname, "..", "..", "migrations", "2026-08-25_agent_token_hash.sql");
const sql = fs.readFileSync(MIGRATION, "utf8");

/** The migration file minus its `--` comment lines, so prose can't satisfy a check. */
const statements = sql
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

test("hashKey returns exactly what MySQL's SHA2(x, 256) returns: 64 lowercase hex chars", () => {
  const h = hashKey("AGT-" + "ab".repeat(24));
  assert.match(h, /^[0-9a-f]{64}$/, `got ${h}`);
});

test("hashKey is pinned to a known vector — a library swap cannot quietly change it", () => {
  // Verify independently:  SELECT SHA2('AGT-test', 256);   →  the same string
  //                        printf 'AGT-test' | sha256sum   →  the same string
  assert.equal(
    hashKey("AGT-test"),
    "7aa0b6b43fe34e8028671835aa8b87d560ae529519a4b37ca10967846cc90445",
  );
});

test("the migration backfills with SHA2(..., 256) — not 512, not MD5, not PASSWORD()", () => {
  assert.match(
    statements,
    /SHA2\(\s*`?approved_token`?\s*,\s*256\s*\)/i,
    "the backfill must use SHA2(approved_token, 256) to match Node's sha256 hex",
  );
});

test("the hash column is char(64) — the exact width hashKey emits", () => {
  assert.match(
    statements,
    /`approved_token_hash`\s+char\(64\)/i,
    "a narrower column would silently TRUNCATE the hash and break every lookup",
  );
});

test("the hash column is uniquely indexed — it is the credential lookup path", () => {
  assert.match(statements, /UNIQUE\s+INDEX\s+`?uq_agent_tokens_approved_hash`?/i);
});

test("a recoverable cipher column exists — a hash alone cannot re-deliver a token", () => {
  // The lost-agent.conf recovery path (and the ADOPT workflow that shares it) needs the
  // ORIGINAL token again. If this column is ever removed, that path breaks silently:
  // the agent loops on `approved but token missing; retrying` rather than failing.
  assert.match(statements, /`approved_token_cipher`\s+varchar\(255\)/i);
});

test("the plaintext column is dropped — the whole point of the change", () => {
  assert.match(statements, /DROP\s+COLUMN\s+`?approved_token`?\s*;/i);
});

test("the hash is backfilled BEFORE the plaintext is dropped", () => {
  // Order is the entire safety argument for already-approved agents: hash first and they
  // keep authenticating untouched, because each one already holds its token in agent.conf.
  // Drop first and every one of them 403s at the next POST, which on a monitoring system
  // reads as the whole fleet dying at once.
  const backfill = statements.search(/SET\s+`?approved_token_hash`?\s*=\s*SHA2/i);
  const drop = statements.search(/DROP\s+COLUMN\s+`?approved_token`?/i);
  assert.ok(backfill > -1 && drop > -1, "both statements must be present");
  assert.ok(backfill < drop, "the SHA2 backfill must come before the DROP COLUMN");
});
