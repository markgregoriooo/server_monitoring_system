import test from "node:test";
import assert from "node:assert/strict";
import { logSafe } from "../utils/logSafe.js";

// ─── Log injection (CWE-117) ──────────────────────────────────────────────────
//
// The values these guard are fully attacker-controlled and reachable without
// authentication: the `User-Agent` on any rejected request (middleware/auth.js) and the
// `hostname` in an enrollment body (routes/agents.js).
//
// String.fromCharCode is used throughout rather than escape sequences, so this file
// cannot itself end up containing the invisible control characters it is testing.
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const TAB = String.fromCharCode(9);
const ESC = String.fromCharCode(27);
const NUL = String.fromCharCode(0);

test("a newline cannot start a second log line", () => {
  const forged = `Mozilla/5.0${LF}[AUTH] rejected POST /api/admin — user=1 role=admin`;
  const out = logSafe(forged);
  assert.ok(!out.includes(LF), "output must be a single line");
  assert.ok(out.includes("\\n"), "the newline should be visible as an escape, not deleted");
});

test("carriage return is escaped too — CR alone rewrites a line on most terminals", () => {
  const out = logSafe(`abc${CR}def`);
  assert.ok(!out.includes(CR));
  assert.equal(out, "abc\\rdef");
});

test("ANSI escapes are neutralised — they can clear the screen or overwrite lines", () => {
  const out = logSafe(`x${ESC}[2Jy`);
  assert.ok(!out.includes(ESC));
  assert.equal(out, "x\\x1b[2Jy");
});

test("NUL and other C0 controls become hex escapes", () => {
  assert.equal(logSafe(`a${NUL}b`), "a\\x00b");
  assert.equal(logSafe(`a${TAB}b`), "a\\tb");
});

test("ordinary text is completely untouched", () => {
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
  assert.equal(logSafe(ua), ua);
  assert.equal(logSafe("server-01.cspc.edu.ph"), "server-01.cspc.edu.ph");
});

test("length is capped INSIDE the loop, so escapes cannot blow past the cap", () => {
  // Each control char expands to 4 chars. A naive "escape then slice" would build a
  // 2000-character string first; the cap has to hold on the way out.
  const nasty = NUL.repeat(500);
  const out = logSafe(nasty, 120);
  assert.ok(out.length <= 121, `expected <=121 chars, got ${out.length}`);
});

test("null / undefined / non-strings are safe", () => {
  assert.equal(logSafe(null), "");
  assert.equal(logSafe(undefined), "");
  assert.equal(logSafe(42), "42");
  assert.equal(logSafe({ a: 1 }), "[object Object]");
});

test("a custom max is honoured and marks truncation", () => {
  const out = logSafe("A".repeat(100), 10);
  assert.ok(out.length <= 11);
  assert.ok(out.endsWith("…"), "truncation should be visible");
});
