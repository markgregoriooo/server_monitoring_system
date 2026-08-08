// ─── Typed errors: "the user did something we reject" vs "our stack failed" ────
//
// Without this distinction a route's catch-all turns every failure into the same
// answer. That's how a DATABASE OUTAGE got reported to users as "sign-in failed":
// people then hunt through their account settings for a problem that is ours, and
// the real cause (MySQL down) stays invisible.
//
// The rule every catch here follows: an error is only client-safe if it says so.
// Anything unmarked is logged server-side and answered with a generic message, so
// raw driver output ("connect ECONNREFUSED 127.0.0.1:3306", SQL text, stack
// frames) can never reach a browser.

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
