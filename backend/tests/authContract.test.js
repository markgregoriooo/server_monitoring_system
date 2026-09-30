import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─── Authentication-failure contract between backend and frontend ─────────
// Every authentication failure is 401 (sign in again); 403 means signed in but not
// allowed. The frontend used to match the exact 403 message text, so rewording it
// would have broken expiry logouts. These tests keep the two apart.
// See audits/error-handling-report-2026-08-25.md (E-07).

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const AUTH_MW = path.join(ROOT, "backend", "middleware", "auth.js");
const CLIENT = path.join(ROOT, "frontend", "src", "api", "client.ts");

const read = (p) => fs.readFileSync(p, "utf8");

test("every authentication failure in the middleware is a 401, never a 403", () => {
  const lines = read(AUTH_MW).split(/\r?\n/);

  // Lines that SEND a status for an authentication problem (as opposed to an
  // authorization one — "Insufficient permissions" is legitimately 403).
  const authFailures = lines.filter(
    (l) =>
      /res\.status\(\d{3}\)/.test(l) &&
      /(No token provided|Invalid or expired token|Session is no longer valid|Unauthorized)/.test(l),
  );

  assert.ok(authFailures.length >= 3, `expected several auth-failure responses, found ${authFailures.length}`);

  for (const line of authFailures) {
    assert.ok(
      line.includes("401"),
      "An authentication failure is answered with something other than 401:\n  " +
        line.trim() +
        "\n401 means 'the credential is missing or invalid — re-authenticate'. 403 means " +
        "'authenticated, but not permitted', which api/client.ts must NOT treat as a " +
        "dead session.",
    );
  }
});

test("403 is still used for authorization, so the two are not merged", () => {
  const src = read(AUTH_MW);
  assert.ok(
    /res\.status\(403\)[\s\S]{0,120}Insufficient permissions/.test(src),
    "requireRole no longer answers 403 'Insufficient permissions.' — a permissions " +
      "failure must stay 403, or the client will sign the user out when they merely " +
      "lack a role.",
  );
});

test("the client no longer string-matches a 403 to detect expiry", () => {
  const src = read(CLIENT);
  assert.ok(
    !/status === 403 && serverError === "Invalid or expired token\."/.test(src),
    "api/client.ts still carries the 403 + message-text special case. The backend now " +
      "returns 401 for an expired token, so that branch is dead code — and keeping it " +
      "re-creates the cross-package coupling on a literal string.",
  );
});

test("the client still ends the session on 401", () => {
  const src = read(CLIENT);
  assert.ok(
    /const isAuthFailure = status === 401 && !isAuthEndpoint;/.test(src),
    "api/client.ts's isAuthFailure no longer reads `status === 401 && !isAuthEndpoint`. " +
      "If that check was reshaped, confirm an expired token still triggers a logout — " +
      "otherwise the user sits on a dashboard where every request fails.",
  );
});
