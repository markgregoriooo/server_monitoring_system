import test from "node:test";
import assert from "node:assert/strict";
import {
  HttpError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  unavailable,
  isClientError,
  ServiceUnavailable,
} from "../utils/httpError.js";

// See audits/error-handling-report-2026-08-25.md — E-04, E-08.

test("each factory carries the status the central handler reads", () => {
  assert.equal(badRequest("x").status, 400);
  assert.equal(unauthorized().status, 401);
  assert.equal(forbidden().status, 403);
  assert.equal(notFound().status, 404);
  assert.equal(conflict("x").status, 409);
  assert.equal(unavailable().status, 503);
});

test("they are real Errors, so instanceof and stack still work", () => {
  const e = badRequest("bad input");
  assert.ok(e instanceof Error);
  assert.ok(e instanceof HttpError);
  assert.equal(e.message, "bad input");
  assert.ok(typeof e.stack === "string" && e.stack.length > 0);
});

test("exposure follows INTENT, not just the status range", () => {
  // src/server.js shows a message when `expose` is true OR the status is 4xx.
  //
  // 4xx is always written for a user:
  assert.equal(badRequest("duplicate email").expose, true);
  assert.equal(conflict("username taken").expose, true);

  // An ACCIDENTAL 5xx must stay generic — a driver message is not for a browser:
  assert.equal(new HttpError(500, "ER_NO_SUCH_TABLE: cspc.reports").expose, false);

  // A DELIBERATE 5xx exposes: its text is the entire point ("Email is not configured
  // on this server"). unavailable() and ServiceUnavailable must agree here — they are
  // the same status and callers treat them interchangeably (L-01).
  assert.equal(unavailable().expose, true);
  assert.equal(new ServiceUnavailable().expose, true);
  assert.equal(unavailable("x").status, new ServiceUnavailable("x").status);
});

test("a deliberate 5xx can still be forced generic", () => {
  assert.equal(unavailable("internal detail", { expose: false }).expose, false);
});

test("expose can be overridden deliberately", () => {
  assert.equal(new HttpError(503, "Report store unreachable.", { expose: true }).expose, true);
});

test("isClientError distinguishes intentional 4xx from everything else", () => {
  assert.equal(isClientError(badRequest("x")), true);
  assert.equal(isClientError(notFound()), true);
  assert.equal(isClientError(unavailable()), false);
  assert.equal(isClientError(new Error("plain")), false, "a statusless Error is not a client error");
  assert.equal(isClientError(null), false);
  assert.equal(isClientError(undefined), false);
});

test("cause is preserved for wrapping a lower-level failure", () => {
  const root = new Error("ECONNREFUSED");
  const e = unavailable("Database unreachable.", { cause: root });
  assert.equal(e.cause, root);
});

test("an optional machine-readable code survives", () => {
  assert.equal(badRequest("x", { code: "DUPLICATE_EMAIL" }).code, "DUPLICATE_EMAIL");
});
