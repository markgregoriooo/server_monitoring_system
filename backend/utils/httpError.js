// ─── HTTP errors ─────────────────────────────────────────────────────────────
// Errors that carry an HTTP status. The central handler in src/server.js sends
// `error` to the client only for 4xx, so a user error thrown without a status
// used to show up as "Server error". See audits/error-handling-report-2026-08-25.md (E-04, E-08).

/**
 * An Error with an HTTP status. `expose` marks the message as safe to show the
 * client; it defaults to true for 4xx and false for 5xx.
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
 * 503: a dependency this request needs is unavailable. Exposed by default, since
 * the message is written for the operator (e.g. "Email is not configured").
 */
export const unavailable = (message = "Service temporarily unavailable.", options) =>
  new HttpError(503, message, { expose: true, ...options });

/** True when `err` carries a deliberate 4xx status — i.e. its message is for the user. */
export const isClientError = (err) =>
  Number.isInteger(err?.status) && err.status >= 400 && err.status < 500;


/**
 * A readable description of any thrown value, never empty. mysql2 connection
 * errors have an empty message (only `code`), so this falls back through
 * message → code → error type → String(). Also handles thrown non-Errors.
 * See audits/error-flow-report-2026-08-25.md (F-01).
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


// ─── Formerly utils/httpErrors.js ────────────────────────────────────────────
// Merged here from the nearly identically named httpErrors.js.
//   isClientError: does it carry a 4xx status?
//   isClientSafe:  was it explicitly marked safe to show?
// The second is stricter: a 4xx from a library is not automatically safe to show.
// See audits/resilience-report-2026-08-25.md (S-06).

// A request we are turning down (bad code, unverified email, wrong domain). The
// user can act on it, so the message is safe to show.
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

// True when an error was raised with a client-safe message.
export function isClientSafe(err) {
  return Boolean(err && err.expose === true && typeof err.status === "number");
}

// Network failures, used to tell "Google is unreachable" (our problem) from
// "Google rejected this code" (the user's problem).
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
