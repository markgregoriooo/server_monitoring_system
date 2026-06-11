import "../config/env.js";
import { OAuth2Client } from "google-auth-library";
import userService from "./userService.js";
import authService from "./authService.js";

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

// Allowed CSPC domains. Exact match on the part after "@" (NOT endsWith, so a
// look-alike like "notcspc.edu.ph" can't slip through).
const ALLOWED_DOMAINS = (process.env.GOOGLE_ALLOWED_DOMAINS ?? "cspc.edu.ph,my.cspc.edu.ph")
  .split(",")
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

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

function domainOf(email) {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

// Exchange the Google auth code, verify the ID token, enforce CSPC domain, and
// resolve the user to one of: ok (session issued) | pending_created | pending |
// rejected | disabled. Throws (→ 401) on a missing/invalid code, wrong audience,
// unverified email, or non-CSPC domain.
async function authenticate(code, { ip = null, userAgent = null } = {}) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Google sign-in is not configured on the server.");
  }
  if (!code) throw new Error("Missing Google sign-in code.");

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
  } catch {
    throw new Error("Could not verify your Google sign-in. Please try again.");
  }

  // The ID token carries email_verified as a real boolean (unlike the legacy
  // tokeninfo string), plus name + picture — so there is no separate profile fetch.
  const email = (payload.email ?? "").trim().toLowerCase();
  if (!email || payload.email_verified !== true) {
    throw new Error("Your Google email is not verified.");
  }
  if (!ALLOWED_DOMAINS.includes(domainOf(email))) {
    throw new Error("Only CSPC accounts (@cspc.edu.ph or @my.cspc.edu.ph) can sign in.");
  }

  const sub = payload.sub ?? null;
  const existing = await userService.findByEmail(email);

  // First time we've seen this CSPC account → create a pending registration.
  if (!existing) {
    const user = await userService.registerGoogleUser({
      email,
      googleSub: sub,
      name: (payload.name ?? "").trim() || email.split("@")[0],
      picture: payload.picture ?? null,
    });
    return { outcome: "pending_created", user };
  }

  // Backfill google_sub on accounts that pre-date Google login (e.g. the
  // bootstrapped admin) the first time they sign in with Google.
  if (!existing.google_sub && sub) {
    await userService.linkGoogleSub(existing.user_id, sub);
  }

  switch (existing.status) {
    case "active": {
      const session = await authService.issueSession(existing, { ip, userAgent });
      return { outcome: "ok", ...session };
    }
    case "pending":
      return { outcome: "pending", user: existing };
    case "rejected":
      return { outcome: "rejected", user: existing };
    default: // 'inactive'
      return { outcome: "disabled", user: existing };
  }
}

export default { authenticate };
