import "../config/env.js";
import { OAuth2Client } from "google-auth-library";
import userService from "./userService.js";
import authService from "./authService.js";
import { AuthRejection, ServiceUnavailable, isTransportError } from "../utils/httpError.js";
import { parseAllowedDomains, isAllowedDomain } from "./googleDomain.js";
import { describeError } from "../utils/httpError.js";

// ─── Google sign-in (OAuth 2.0 / OpenID Connect) ────────────────
// The "CSPC Mail" button runs the authorization-code flow in a popup and sends us
// a one-time code. We exchange it with Google using the client secret, verify the
// returned ID token locally (verifyIdToken also checks the audience), check the
// CSPC domain, then sign the user in or create a pending registration. This is the
// only login; there are no passwords.
//
// Auth-code rather than the deprecated implicit flow: the token never reaches the
// browser, and the ID token already has the email, name and picture.

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// Allowed CSPC domains. The matching logic lives in ./googleDomain.js — pure and
// import-free so backend/tests/ can cover it (see tests/googleDomain.test.js).
const ALLOWED_DOMAINS = parseAllowedDomains(process.env.GOOGLE_ALLOWED_DOMAINS);

// "postmessage" is the redirect_uri Google uses for the popup auth-code flow. It
// must match what the library used, and needs no entry under "Authorized redirect
// URIs"; only the JavaScript origins matter.
const client = new OAuth2Client({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  redirectUri: "postmessage",
});

// Best-effort audit of a refused sign-in. Never throws: a failed audit write must
// not turn a clean denial into a 500.
async function recordDenial(reason, { email = null, userId = null, ip = null, userAgent = null }) {
  try {
    await authService.recordSignInDenied({ email, reason, userId, ip, userAgent });
  } catch (err) {
    console.error("[GOOGLE_AUTH] could not record denied sign-in:", err);
  }
}

// Exchange the code, verify the ID token, check the CSPC domain, and resolve the
// user to one of: ok (session issued) | pending_created | pending | rejected |
// disabled.
//
// Throws AuthRejection (4xx, shown to the user) only for things the user can fix:
// missing/invalid code, wrong audience, unverified email, non-CSPC domain.
// Everything else (Google unreachable, missing credentials, a database error) is a
// 503, not the user's fault. See utils/httpError.js.
async function authenticate(code, { ip = null, userAgent = null } = {}) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    // A deployment mistake, not a sign-in problem. 401 here used to send admins
    // looking at Google Cloud consoles instead of at their own .env.
    throw new ServiceUnavailable(
      "Google sign-in is not configured on the server (missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).",
    );
  }
  if (!code) throw new AuthRejection("Missing Google sign-in code.", 400);

  let payload;
  try {
    // 1. Exchange the code for tokens (with the client secret).
    // 2. Verify the ID token locally and check it was issued for this client
    //    (audience); verifyIdToken throws on any mismatch.
    const { tokens } = await client.getToken(code);
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token, //OIDC identity JWT
      audience: CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    // Not reaching Google at all (DNS, no route, timeout) is our outage, not a failed
    // sign-in.
    if (isTransportError(err)) {
      console.error("[AUTH] cannot reach Google to verify sign-in:", describeError(err));
      throw new ServiceUnavailable(
        "Could not reach Google to verify your sign-in. Check the server's internet connection.",
      );
    }
    // Log the real cause (wrong or mismatched client secret, reused or expired code,
    // audience mismatch, clock skew); the user only sees a generic message. Uses
    // describeError, not the raw error, which would log the one-time auth code.
    // `err.code`/`err.status` show the cause (e.g. invalid_grant, 400).
    console.error(
      `[GOOGLE_AUTH] code exchange / ID-token verification failed: ${describeError(err)}` +
        (err?.status ? ` (http ${err.status})` : ""),
    );
    await recordDenial("token_verification_failed", { ip, userAgent });
    throw new AuthRejection("Could not verify your Google sign-in. Please try again.");
  }

  // The ID token carries email_verified as a real boolean (unlike the legacy
  // tokeninfo string), plus name + picture — so there is no separate profile fetch.
  const email = (payload.email ?? "").trim().toLowerCase();
  if (!email || payload.email_verified !== true) {
    await recordDenial("email_not_verified", { email: email || null, ip, userAgent });
    throw new AuthRejection("Your Google email is not verified.");
  }
  if (!isAllowedDomain(email, ALLOWED_DOMAINS)) {
    await recordDenial("domain_not_allowed", { email, ip, userAgent });
    // 403, not 401: we know who they are, they're just not allowed in.
    throw new AuthRejection(
      // Short so it fits the login banner on a phone; the allowed domains are already
      // shown on the sign-in page.
      "Only CSPC accounts can sign in.",
      403,
    );
  }

  const sub = payload.sub ?? null;
  const profile = {
    name: (payload.name ?? "").trim() || email.split("@")[0],
    picture: payload.picture ?? null,
  };

  // Match by google_sub first (the permanent Google account id), then by email. Email
  // alone would create a duplicate pending account if ICTU renames an address. The
  // email fallback lets accounts created without a google_sub (such as the seeded
  // first admin) sign in the first time.
  let existing = await userService.findByGoogleSub(sub);
  const matchedBySub = existing !== null;
  if (!existing) existing = await userService.findByEmail(email);

  // First time we've seen this CSPC account → create a pending registration.
  if (!existing) {
    const user = await userService.registerGoogleUser({
      email,
      googleSub: sub,
      ...profile,
    });
    return { outcome: "pending_created", user };
  }

  // Backfill google_sub on accounts that pre-date Google login (e.g. the
  // bootstrapped admin) the first time they sign in with Google.
  if (!existing.google_sub && sub) {
    await userService.linkGoogleSub(existing.user_id, sub);
  }

  // Google owns the name and photo, so re-sync them on every sign-in. The email only
  // changes when we matched by sub and Google's address changed (a real rename).
  const renamed = matchedBySub && existing.email !== email;
  const synced = await userService.syncGoogleProfile(existing.user_id, {
    ...profile,
    email: renamed ? email : null,
  });
  // Mirror onto the in-memory row so the JWT minted below carries the fresh
  // values instead of the ones we read a few lines ago.
  existing.name = profile.name;
  if (profile.picture) existing.profile_image = profile.picture;
  if (synced.email) existing.email = synced.email;

  switch (existing.status) {
    case "active": {
      const session = await authService.issueSession(existing, { ip, userAgent });
      return { outcome: "ok", ...session };
    }
    case "pending":
      await recordDenial("account_pending", { email, userId: existing.user_id, ip, userAgent });
      return { outcome: "pending", user: existing };
    case "rejected":
      await recordDenial("account_rejected", { email, userId: existing.user_id, ip, userAgent });
      return { outcome: "rejected", user: existing };
    default: // 'inactive'
      await recordDenial("account_disabled", { email, userId: existing.user_id, ip, userAgent });
      return { outcome: "disabled", user: existing };
  }
}

export default { authenticate };
