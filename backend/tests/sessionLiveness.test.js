import test from "node:test";
import assert from "node:assert/strict";
import { sessionIsLive, sessionRevocationReason } from "../middleware/auth.js";

// ─── The authorization rule ───────────────────────────────────────────────────
//
// "Is this token still a live session?" is enforced in THREE places — the HTTP
// middleware, the Socket.IO handshake, and the revocation sweep that re-checks
// already-connected sockets. It was three hand-written copies until the error-handling
// audit (R-03) collapsed them into one predicate; that predicate then had no test.
//
// This is the rule that decides whether a disabled account keeps streaming live data, so
// it gets one. Pure — `middleware/auth.js` imports the mysql POOL but creating a pool
// opens no connection, so this runs with no database.
//
// See audits/testing-report-2026-08-25.md — T-03.

const live = { status: "active", token_version: 5 };

test("a live session passes", () => {
  assert.equal(sessionRevocationReason(live, 5), null);
  assert.equal(sessionIsLive(live, 5), true);
});

test("a deleted account is rejected as account_removed", () => {
  for (const gone of [null, undefined]) {
    assert.equal(sessionRevocationReason(gone, 5), "account_removed");
    assert.equal(sessionIsLive(gone, 5), false);
  }
});

test("every non-active status is rejected as account_inactive", () => {
  // users.status has four values; only 'active' may hold a session. A new status must
  // fail CLOSED — if someone adds one and forgets this rule, this test says so.
  for (const status of ["pending", "rejected", "inactive", "suspended", ""]) {
    const row = { status, token_version: 5 };
    assert.equal(sessionRevocationReason(row, 5), "account_inactive", `status=${status}`);
    assert.equal(sessionIsLive(row, 5), false, `status=${status}`);
  }
});

test("a stale token_version is rejected as session_revoked", () => {
  // logout, disable, role change and password change all bump token_version.
  assert.equal(sessionRevocationReason(live, 4), "session_revoked", "older claim");
  assert.equal(sessionRevocationReason(live, 6), "session_revoked", "newer claim");
  assert.equal(sessionIsLive(live, 4), false);
});

test("the token_version comparison is STRICT — no type coercion", () => {
  // A `tv` claim arriving as a string must not satisfy a numeric column. Loose equality
  // here would let "5" == 5 pass, which is exactly the kind of silent widening that
  // makes a revocation check stop revoking.
  assert.equal(sessionIsLive(live, "5"), false, '"5" must not match 5');
  assert.equal(sessionIsLive({ status: "active", token_version: "5" }, 5), false);
});

test("a missing tv claim is rejected", () => {
  assert.equal(sessionIsLive(live, undefined), false);
  assert.equal(sessionIsLive(live, null), false);
});

test("the three rejection reasons are checked in priority order", () => {
  // A removed account must report account_removed even though its tv is also unknown —
  // socketSessions.js reports the reason to the client, so the order is observable.
  assert.equal(sessionRevocationReason(null, 999), "account_removed");
  // Inactive is reported before a version mismatch, because the account state is the
  // more fundamental fact.
  assert.equal(sessionRevocationReason({ status: "inactive", token_version: 1 }, 999), "account_inactive");
});

test("sessionIsLive agrees with sessionRevocationReason on every case", () => {
  const rows = [null, undefined, live, { status: "pending", token_version: 5 }, { status: "active", token_version: 1 }];
  for (const row of rows) {
    for (const tv of [1, 5, "5", undefined]) {
      assert.equal(
        sessionIsLive(row, tv),
        sessionRevocationReason(row, tv) === null,
        `${JSON.stringify(row)} tv=${JSON.stringify(tv)}`,
      );
    }
  }
});
