import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashKey } from "../services/installKeyUtils.js";

// ─── Node ↔ SQL hashing contract ──────────────────────────────────────────
// The backend stores and looks up agent tokens by Node's hashKey(), in a column the
// schema defines. If the two ever disagree (width, uniqueness), no lookup matches and
// every agent gets 403. Same idea as contract.test.js checking the Go collector.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = path.join(__dirname, "..", "..", "v13_cspc-ictu-monitoring-system.sql");

/** The schema minus its `--` comment lines, so prose can't satisfy a check. */
const statements = fs
  .readFileSync(SCHEMA, "utf8")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

/** Just the agent_tokens CREATE TABLE, so a column elsewhere can't satisfy a check. */
const agentTokens = statements.match(/CREATE TABLE `agent_tokens` \(([\s\S]*?)\) ENGINE=/)?.[1] ?? "";

test("the schema defines agent_tokens", () => {
  assert.ok(agentTokens, "CREATE TABLE `agent_tokens` not found in v13");
});

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

test("the hash column is char(64) — the exact width hashKey emits", () => {
  assert.match(
    agentTokens,
    /`approved_token_hash`\s+char\(64\)/i,
    "a narrower column would silently TRUNCATE the hash and break every lookup",
  );
});

test("the hash column is uniquely indexed — it is the credential lookup path", () => {
  assert.match(statements, /UNIQUE\s+(?:INDEX|KEY)\s+`?uq_agent_tokens_approved_hash`?\s*\(`approved_token_hash`\)/i);
});

test("a recoverable cipher column exists — a hash alone cannot re-deliver a token", () => {
  // Re-delivering the token (lost agent.conf, adopt) needs the original value. Without
  // this column the agent just loops on "approved but token missing; retrying".
  assert.match(agentTokens, /`approved_token_cipher`\s+varchar\(255\)/i);
});

test("there is no plaintext token column — the whole point of hashing", () => {
  assert.doesNotMatch(agentTokens, /`approved_token`\s/, "a readable token column is back");
});
