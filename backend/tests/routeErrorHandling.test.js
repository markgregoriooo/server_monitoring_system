import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─── Every async route handler must pass its errors on ────────────────
// Express 4 does not catch a rejected promise from a handler: the request just hangs.
// Two accepted patterns:
//   utils/asyncHandler.js   the wrapper, `asyncHandler(async (req, res) => …)`
//   an explicit try/catch   `catch (err) { next(err) }`
// This reads the route files as text and fails if a handler uses neither.
// See audits/design-patterns-report-2026-08-25.md (P-06).

const ROUTES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "routes");

/** Index of the ")" closing the "(" at `from`. */
function matchParen(s, from) {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function asyncHandlersIn(file) {
  const src = fs.readFileSync(path.join(ROUTES_DIR, file), "utf8");
  const re = /router\.(get|post|put|patch|delete)\s*\(/g;
  const out = [];
  let m;
  while ((m = re.exec(src))) {
    const close = matchParen(src, m.index + m[0].length - 1);
    if (close < 0) continue;
    const call = src.slice(m.index, close + 1);
    if (!/async\s*\(/.test(call)) continue;
    out.push({
      line: src.slice(0, m.index).split(/\r?\n/).length,
      wrapped: /asyncHandler\s*\(/.test(call),
      guarded: /\btry\s*\{/.test(call),
      label: call.slice(0, call.indexOf(",")).replace(/\s+/g, " "),
    });
  }
  return out;
}

const FILES = fs.readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".js"));

test("the routes directory is where we think it is", () => {
  assert.ok(FILES.length > 0, "no route files found — did the directory move?");
});

test("every async route handler is asyncHandler-wrapped or try/catch-guarded", () => {
  const offenders = [];
  for (const f of FILES) {
    for (const h of asyncHandlersIn(f)) {
      if (!h.wrapped && !h.guarded) offenders.push(`routes/${f}:${h.line}  ${h.label})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "Async handlers with no error path — a rejection here hangs the request:\n  " +
      offenders.join("\n  ") +
      "\nWrap with asyncHandler(...) from utils/asyncHandler.js, or add try/catch + next(err).",
  );
});

test("the scan actually finds handlers (guards against a silently-passing regex)", () => {
  const total = FILES.reduce((n, f) => n + asyncHandlersIn(f).length, 0);
  // A vacuous pass is the failure mode this whole test would otherwise have: if the
  // regex stops matching, "zero offenders" is true and meaningless.
  assert.ok(total > 50, `expected many async handlers, found ${total} — the scan is broken`);
});
