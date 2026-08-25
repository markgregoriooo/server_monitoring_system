// ─── HTTP-aware errors — PURE, import-free ────────────────────────────────────
//
// The codebase already had a consistent CONVENTION — attach `.status` to an Error and
// the central handler in src/server.js uses it — but no shared implementation. At least
// eight modules rolled their own three-line factory (`badRequest` in reportService,
// `err` in installKeyService, `irCfgErr` in airconService, `ruleError` in
// alertRuleValidation, plus inline `e.status = 400` in historyRange, snmpUtils,
// userService, widgetPrefsService).
//
// More importantly, **32 `throw new Error(...)` calls carried no status at all**, so the
// central handler defaulted them to 500. That is not cosmetic: `src/server.js` only puts
// `error` on the response body for 4xx, and the frontend's `handleError` reads exactly
// that field — so a 500 fell through to the generic "Server error. Please try again
// later." A user typing a duplicate email was told the server had broken.
//
// See audits/error-handling-report-2026-08-25.md — E-04, E-08.

/**
 * An Error that knows its HTTP status.
 *
 * `expose` marks a message as safe to send to the client. Every 4xx built here is
 * intentional text written for a user, so it defaults to true for 4xx and false for 5xx —
 * matching what the central handler does with it.
 */
export class HttpError extends Error {
  constructor(status, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "HttpError";
    this.status = status;
    this.expose = options.expose ?? (status >= 400 && status < 500);
    if (options.code) this.code = options.code;
    Error.captureStackTrace?.(this, HttpError);
  }
}

/** 400 — the request itself is malformed or fails validation. */
export const badRequest = (message, options) => new HttpError(400, message, options);

/** 401 — no credential, or one that is not valid. The client should authenticate. */
export const unauthorized = (message = "Unauthorized.", options) =>
  new HttpError(401, message, options);

/** 403 — authenticated, but not allowed to do this. Re-authenticating will not help. */
export const forbidden = (message = "Insufficient permissions.", options) =>
  new HttpError(403, message, options);

/** 404 — the addressed thing does not exist. */
export const notFound = (message = "Not found.", options) => new HttpError(404, message, options);

/**
 * 409 — the request is well-formed but conflicts with current state.
 * Duplicate email, username already taken, approving a user who is not pending.
 */
export const conflict = (message, options) => new HttpError(409, message, options);

/**
 * 503 — a dependency this request needs is unavailable right now.
 *
 * Exposed by default. A 5xx is normally kept generic, but this one is RAISED
 * DELIBERATELY with text written for the operator ("Email is not configured on this
 * server"), which is useless if the central handler replaces it. That also makes it
 * substitutable with the `ServiceUnavailable` class below, which has always set
 * `expose: true` — two 503s that behaved differently was the LSP violation in L-01.
 */
export const unavailable = (message = "Service temporarily unavailable.", options) =>
  new HttpError(503, message, { expose: true, ...options });

/** True when `err` carries a deliberate 4xx status — i.e. its message is for the user. */
export const isClientError = (err) =>
  Number.isInteger(err?.status) && err.status >= 400 && err.status < 500;


/**
 * A human-readable description of ANY thrown value, guaranteed non-empty.
 *
 * `err.message` is not reliable. mysql2's connection errors carry an **empty**
 * message — verified: a MySQL outage throws `Error` with `code: "ECONNREFUSED"` and
 * `message: ""`. There were 46 log lines in this codebase of the form
 * `console.error("[x] failed:", err.message)`, so during a database outage — precisely
 * when someone is reading the log — they printed:
 *
 *     [audit] failed to record action:
 *     [BACKUP] flush error:
 *
 * Falls back through `message` → `code` → the error's type → String(). Also handles a
 * thrown non-Error (a string, an object), which `.message` renders as `undefined`.
 *
 * See audits/error-flow-report-2026-08-25.md — F-01.
 */
export function describeError(err) {
  if (err == null) return "unknown error";
  const msg = typeof err.message === "string" ? err.message.trim() : "";
  const code = err.code ? String(err.code) : "";
  if (msg && code) return `${msg} (${code})`;
  if (msg) return msg;
  if (code) return `${code} (no message)`;
  if (err instanceof Error) return `${err.name} (no message)`;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}


// ─── Merged from utils/httpErrors.js (plural) ─────────────────────────────────
//
// There were TWO error modules whose names differed by one character —
// `httpError.js` (this file, 29 dependents) and `httpErrors.js` (2 dependents, the
// Google sign-in path). They overlapped: `ServiceUnavailable` vs `unavailable()`,
// `isClientSafe` vs `isClientError`. A name collision that subtle is worse than either
// module being missing, because an import can be wrong and still compile.
//
// Consolidated here. The distinctions below are real and deliberately kept:
//   isClientError — "does this carry a 4xx status?"          (status range)
//   isClientSafe  — "was this deliberately marked exposable?" (explicit opt-in)
// The second is stricter: a 4xx from a library is not automatically safe to show.
// See audits/resilience-report-2026-08-25.md — S-06.

// A request we are deliberately turning down — bad code, unverified email, wrong
// domain. The user can act on this, so the message is safe to show them.
export class AuthRejection extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = "AuthRejection";
    this.status = status;
    this.expose = true;
  }
}

// A dependency we need is unavailable or misconfigured (database down, Google
// unreachable, missing credentials). Nothing the user did, and retrying may work.
export class ServiceUnavailable extends Error {
  constructor(message = "Service temporarily unavailable. Please try again shortly.") {
    super(message);
    this.name = "ServiceUnavailable";
    this.status = 503;
    this.expose = true;
  }
}

// True when an error was deliberately raised WITH a client-safe message.
export function isClientSafe(err) {
  return Boolean(err && err.expose === true && typeof err.status === "number");
}

// Node/undici transport failures. Used to tell "Google is unreachable" (our
// problem) from "Google rejected this code" (the user's problem) — both surface
// as a thrown error from the auth library, but they mean opposite things.
const NETWORK_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN",
  "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ERR_NETWORK",
  "ERR_SOCKET_CONNECTION_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT",
]);

export function isTransportError(err) {
  if (!err) return false;
  // An HTTP reply arrived (e.g. 400 invalid_grant) → the peer answered, so this is
  // a real rejection, not a transport failure.
  if (err.response) return false;
  if (NETWORK_CODES.has(err.code)) return true;
  if (err.cause && NETWORK_CODES.has(err.cause.code)) return true; // undici wraps
  return err.name === "FetchError";
}

export default {
  HttpError,
  AuthRejection,
  ServiceUnavailable,
  isClientSafe,
  isTransportError,
  describeError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  unavailable,
  isClientError,
};
