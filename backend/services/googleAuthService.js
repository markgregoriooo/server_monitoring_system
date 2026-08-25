import "../config/env.js";
import { OAuth2Client } from "google-auth-library";
import userService from "./userService.js";
import authService from "./authService.js";
import { AuthRejection, ServiceUnavailable, isTransportError } from "../utils/httpError.js";
import { parseAllowedDomains, isAllowedDomain } from "./googleDomain.js";
import { describeError } from "../utils/httpError.js";

// ─── Google "Sign in with Google" (OAuth 2.0 / OpenID Connect) ────────────────
// The frontend (custom "CSPC Mail" button) runs the OAuth 2.0 AUTHORIZATION CODE
// flow (popup) and sends us a one-time AUTH CODE. We exchange that code with
// Google for tokens — server-to-server, authenticated with the client secret —
// and verify the returned ID token's signature locally (verifyIdToken, no extra
// network call). verifyIdToken also enforces the audience, so a token minted for
// another client can't be replayed here. Then we enforce the CSPC email domains
// and either log the user in (existing + active) or create a pending registration
// for an admin to approve. Only login path; no password.
//
// Why auth-code (not implicit): the implicit flow is deprecated (OAuth 2.1 /
// RFC 9700). Auth-code keeps the token out of the browser, and the ID token it
// returns already carries email + name + picture — so no separate tokeninfo /
// userinfo round trips. The custom button is still required only for the
// "CSPC Mail" label (Google's official button is fixed-text).

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

// Allowed CSPC domains. The matching logic lives in ./googleDomain.js — pure and
// import-free so backend/tests/ can cover it (see tests/googleDomain.test.js).
const ALLOWED_DOMAINS = parseAllowedDomains(process.env.GOOGLE_ALLOWED_DOMAINS);

// "postmessage" is the special redirect_uri Google uses for the popup auth-code
// flow (@react-oauth/google's default ux_mode: 'popup'). It must match the value
// the library used to obtain the code, and needs NO entry in the Cloud Console's
// "Authorized redirect URIs" — only the JavaScript origins matter.
// 'client' object is server's identity as an app to Google
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

// Exchange the Google auth code, verify the ID token, enforce CSPC domain, and
// resolve the user to one of: ok (session issued) | pending_created | pending |
// rejected | disabled.
//
// Throws AuthRejection (4xx, message shown to the user) ONLY for things the user
// can act on: a missing/invalid code, wrong audience, unverified email, non-CSPC
// domain. Everything else — Google unreachable, missing credentials, a database
// failure from the calls below — throws ServiceUnavailable or propagates unmarked,
// so the route answers 503 instead of blaming the user's account. See utils/httpError.js.
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
    // 1. Swap the one-time code for tokens (authenticated with the client secret).
    // 2. Verify the ID token's signature locally and confirm it was issued for
    //    THIS client (audience) — verifyIdToken throws on any mismatch.
    const { tokens } = await client.getToken(code);
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token, //OIDC identity JWT
      audience: CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (err) {
    // Both outcomes throw, but they mean opposite things: if we never reached
    // Google (DNS, no route, timeout) that is OUR outage — telling the user their
    // sign-in couldn't be verified would be a lie that hides a network problem.
    if (isTransportError(err)) {
      console.error("[AUTH] cannot reach Google to verify sign-in:", describeError(err));
      throw new ServiceUnavailable(
        "Could not reach Google to verify your sign-in. Check the server's internet connection.",
      );
    }
    // Log the REAL cause. Everything that lands here — wrong client secret, a secret
    // belonging to a different client, an already-used or expired code, audience
    // mismatch, clock skew — collapses into one opaque user-facing message, so
    // without this line a misconfigured deployment is undiagnosable server-side.
    console.error("[GOOGLE_AUTH] code exchange / ID-token verification failed:", err);
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
      "Only CSPC accounts (@cspc.edu.ph or @my.cspc.edu.ph) can sign in.",
      403,
    );
  }

  const sub = payload.sub ?? null;
  const profile = {
    name: (payload.name ?? "").trim() || email.split("@")[0],
    picture: payload.picture ?? null,
  };

  // Match on google_sub FIRST — it is the stable Google account id. Email is a
  // mutable alias: when ICTU renames a CSPC address, an email-only lookup misses
  // the existing row, creates a duplicate 'pending' registration, orphans the
  // original user_id (and its logs/alerts), then collides on the UNIQUE
  // google_sub index. Falling back to email is what lets accounts predating
  // Google login — the bootstrapped admin above all — sign in the first time.
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

  // Google owns the name/photo — re-sync every login so they don't freeze at
  // registration. The email only moves when we matched by sub AND Google's
  // address changed, i.e. a real rename of this same account.
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
