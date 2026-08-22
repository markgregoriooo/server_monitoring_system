import axios from "axios";
import type {
  AxiosInstance,
  InternalAxiosRequestConfig,
} from "axios";
import { API_URL } from "../config";

const baseURL = `${API_URL}/api`;

// Which session a request was sent under. Read back in the error interceptor to
// tell a genuine expiry from the reply to a session that has already been replaced.
declare module "axios" {
  export interface InternalAxiosRequestConfig {
    __cspcToken?: string | null;
    /** Set once when a replaced-session failure is retried, so it can never loop. */
    __cspcRetried?: boolean;
  }
}

function getToken(): string | null {
  try {
    return JSON.parse(sessionStorage.getItem("cspc_token") || "null");
  } catch {
    return null;
  }
}

// Read a JWT's time claims without a library. Null if missing/unparseable.
//
// JWTs are base64URL, which `atob` does not accept: base64url writes `-` and `_`
// where base64 writes `+` and `/`, and drops the `=` padding. Feed one straight to
// `atob` and it THROWS — but only for tokens whose payload happens to encode those
// characters, so it fails for some sessions and not others. That is exactly the kind
// of intermittency that let a dead token live in a tab for a day and a half.
function decodeJwtTimes(token: string | null): { iat?: number; exp?: number } | null {
  if (!token) return null;
  try {
    const raw = (token.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const p = JSON.parse(atob(padded));
    return {
      iat: typeof p?.iat === "number" ? p.iat : undefined,
      exp: typeof p?.exp === "number" ? p.exp : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Milliseconds until the stored token dies, measured on ONE clock.
 *
 * `exp * 1000 - Date.now()` mixes two: `exp` is stamped by the BACKEND, `Date.now()`
 * is this machine. Machines whose time drifts would read a freshly minted token as
 * long dead. `exp - iat` is the token's LIFETIME — both claims from the same server
 * clock, so the difference is skew-free — added to when WE received it (our clock).
 *
 * Exported so AuthContext measures expiry the same way; two copies of this rule
 * drifting apart is how a session ends up trusted in one place and not the other.
 */
export function msUntilTokenExpiry(): number | null {
  const times = decodeJwtTimes(getToken());
  if (!times?.exp) return null;

  const receivedAt = Number(sessionStorage.getItem("cspc_token_at"));
  if (times.iat && Number.isFinite(receivedAt) && receivedAt > 0) {
    return receivedAt + (times.exp - times.iat) * 1000 - Date.now();
  }
  return times.exp * 1000 - Date.now(); // no arrival stamp (older session)
}

const apiClient: AxiosInstance = axios.create({
  baseURL,
});

// ─── In-flight GET coalescing ───────────────────────────────────────────────────
//
// Several independent consumers legitimately want the same list at the same moment,
// and each was issuing its own HTTP request:
//
//   • Dashboard AND LiveSummaryContext (the PiP widget) both seed from /servers,
//     /ups, /network, /mikrotik and /aircon on mount — five duplicated requests.
//   • React StrictMode double-invokes every effect IN DEV, so each of those fires
//     twice, in the same commit.
//
// One Dashboard load was therefore ~50-70 requests, most of them the same handful of
// URLs. That is what exhausted the server's rate limiter and blanked the page.
//
// This shares the PROMISE of a request that is still in flight. Deliberately NOT a
// response cache: the entry is dropped the moment the request settles, so a caller can
// never be handed a stale body — the only thing suppressed is a duplicate that is
// literally concurrent with one already on the wire. Both cases above are exactly that.
// A later refetch (the socket `connect` resync) still goes out, because by then nothing
// is in flight and the data genuinely may have moved.
const inFlight = new Map<string, Promise<unknown>>();

// Endpoints that must reach the server on EVERY call, even concurrently. Revealing an
// install key is audited per view, so coalescing two of them would lose an audit row —
// the record of who saw the key is the point of the endpoint.
const NEVER_COALESCE = [/\/install-keys\/\d+\/reveal$/];

function coalesceKey(config: InternalAxiosRequestConfig): string | null {
  const method = (config.method ?? "get").toLowerCase();
  if (method !== "get") return null; // only reads; a POST is never a duplicate
  const url = config.url ?? "";
  if (NEVER_COALESCE.some((re) => re.test(url))) return null;
  // Params matter: /servers/1/history?range=-1h is not /servers/1/history?range=-7d.
  return `${url}?${JSON.stringify(config.params ?? {})}`;
}

// `get` is wrapped rather than handled in an interceptor: an interceptor can only shape
// the request that is about to go out, it cannot hand back a promise already running.
const rawGet = apiClient.get.bind(apiClient);
apiClient.get = ((url: string, config?: Parameters<typeof rawGet>[1]) => {
  const key = coalesceKey({ ...(config ?? {}), url, method: "get" } as InternalAxiosRequestConfig);
  if (!key) return rawGet(url, config);

  // Callers share ONE AxiosResponse object. Nothing mutates a response body today —
  // api.ts reads `res.data` and passes it on — but code that did would be writing into
  // every other caller's copy, so keep responses treated as read-only.
  const existing = inFlight.get(key);
  if (existing) return existing;

  const p = rawGet(url, config);
  inFlight.set(key, p);
  // Drop on settle, success or failure. The identity check matters: a slow request that
  // finishes after a newer one for the same URL started must not evict the newer entry.
  const drop = () => {
    if (inFlight.get(key) === p) inFlight.delete(key);
  };
  p.then(drop, drop);
  return p;
}) as typeof apiClient.get;

// Attach token automatically
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = getToken();

    // Never send a token we can already see is dead.
    //
    // This is the last line of defence, and the only one that protects a tab which
    // is ALREADY RUNNING. Every other expiry check happens when a session is created
    // or restored — none of which a tab that has been open for a day and a half ever
    // executes again. Such a tab kept firing its heartbeat and its socket re-seeds
    // with a token that died hours earlier, producing a wall of 403s that looked, on
    // the screen, exactly like being kicked out right after signing in.
    //
    // This runs per request, so it catches that tab on its very next call regardless
    // of when it loaded. The session teardown then happens once, in order, instead of
    // once per rejected request.
    const msLeft = token ? msUntilTokenExpiry() : null;
    if (token && msLeft !== null && msLeft <= 0) {
      notifySessionExpired({
        url: config.url,
        serverError: `stored token expired ${Math.round(-msLeft / 1000)}s ago — not sent`,
      });
      config.__cspcToken = null; // no Authorization header: the request goes out bare
      return config;
    }

    if (token) {
      config.headers.set("Authorization", `Bearer ${token}`);
    }
    // Stamp the request with the session it belongs to, even when that is null —
    // the error interceptor compares this against the token in storage at the time
    // the FAILURE lands, which may be a different session entirely.
    config.__cspcToken = token;

    return config;
  }
);

// ── Auto-logout on auth failure ───────────────────────────────────────────────
// When the backend rejects our session, tell the app to log out. We emit a window
// event (rather than import AuthContext) so this low-level module stays free of
// React and we avoid a circular import; AuthContext listens for it.
//
// Fire on: 401 (no / invalid / expired session, or a session invalidated
// elsewhere — logout, disable, role or password change all return 401 here) and
// on the specific 403 "Invalid or expired token." We deliberately do NOT fire on
// 403 "Insufficient permissions." (a valid user hitting a forbidden action), nor
// on the /auth/google or /auth/logout requests themselves (a failed sign-in or a
// pending/rejected account returns 401/403, and a logout shouldn't look like an expiry).
let sessionExpiredNotified = false;

export function resetSessionExpiredGuard() {
  sessionExpiredNotified = false;
}

export interface SessionEndInfo {
  status?: number | undefined;
  url?: string | undefined;
  serverError?: string | undefined;
}

function notifySessionExpired(info: SessionEndInfo) {
  if (sessionExpiredNotified) return; // collapse a burst of parallel failures into one
  sessionExpiredNotified = true;
  // Carry WHICH request killed the session. A session that ends without saying why
  // is the hardest kind of bug to chase — it looks identical whether the token was
  // rejected, never sent, or timed out on the client.
  console.warn("[session] ended by an API auth failure:", info);
  window.dispatchEvent(new CustomEvent("cspc:session-expired", { detail: info }));
}

apiClient.interceptors.response.use(
  (response) => {
    // Sliding session: if the backend renewed our token (auth middleware sets this
    // header once the current token is past its half-life), swap it into storage
    // transparently and notify AuthContext to re-arm its expiry timer — so an active
    // user is never hard-logged-out at the original 1h mark.
    const renewed = response.headers?.["x-renewed-token"];
    if (renewed && typeof renewed === "string") {
      try {
        sessionStorage.setItem("cspc_token", JSON.stringify(renewed));
        // Arrival time on OUR clock. AuthContext measures the token's remaining life
        // as (exp - iat) from here, which keeps the whole calculation on one clock
        // instead of comparing a server-stamped exp against this machine's time.
        sessionStorage.setItem("cspc_token_at", String(Date.now()));
        window.dispatchEvent(new Event("cspc:token-renewed"));
      } catch {
        /* storage unavailable — ignore */
      }
    }
    return response;
  },
  (error) => {
    const status: number | undefined = error?.response?.status;
    const serverError: string | undefined = error?.response?.data?.error;
    const url: string = error?.config?.url ?? "";
    const isAuthEndpoint = url.includes("/auth/google") || url.includes("/auth/logout");

    const isAuthFailure =
      (status === 401 ||
        (status === 403 && serverError === "Invalid or expired token.")) &&
      !isAuthEndpoint;

    // A response can outlive the session that produced it, and an auth failure
    // belonging to a DEAD session must never log out the LIVE one.
    //
    // The race this fixes: a request leaves under token T1 (say the 10-minute /me
    // heartbeat). Before it comes back, the session ends — the token expires, or
    // the user signs out, which bumps token_version and invalidates T1 server-side.
    // They sign in again seconds later and the app is now running on T2. Only then
    // does the old request fail with 401 — and the interceptor, seeing nothing but
    // "401, not an auth endpoint", tore down the brand-new session. Symptom: signed
    // out moments after signing in, "Your session expired", plus a socket killed
    // mid-upgrade ("WebSocket is closed before the connection is established") and a
    // 403 from the reconnect that follows with no token.
    //
    // Comparing the token the request was SENT with against the one in storage NOW
    // tells the two apart. A mismatch means a newer session replaced this one, so
    // the failure is about a session nobody is using any more — drop it.
    //
    // This cannot mask a real revocation: if the current token is also invalid, the
    // next request made with it fails too, and that one matches and does log out.
    const sentUnder = error?.config?.__cspcToken ?? null;
    const belongsToCurrentSession = sentUnder === getToken();

    if (isAuthFailure && !belongsToCurrentSession) {
      // Not logging out is only HALF the answer. The request was still wanted — it
      // simply left under a session that rotated out from under it — and dropping it
      // leaves whatever asked for it permanently empty.
      //
      // That is exactly what happened on the Dashboard: the focus charts fetch their
      // history once, in an effect keyed on [device, range]. If that one fetch lands
      // during a session rotation it is discarded, nothing re-triggers the effect, and
      // the Network / MikroTik / UPS charts stay blank until the user changes the range
      // by hand. Three empty charts and a console full of 403s, on a live session.
      //
      // So retry once, with the token now in storage. This is safe for ANY method: the
      // auth middleware rejects before the route handler runs, so the request provably
      // had no effect the first time. The flag makes it at most one extra attempt, and
      // if the new token is also rejected that failure DOES match the current session
      // and logs out through the branch below.
      const cfg = error?.config;
      if (cfg && !cfg.__cspcRetried && getToken()) {
        cfg.__cspcRetried = true;
        console.warn(
          "[session] auth failure from a replaced session — retrying under the current one:",
          { status, url, serverError },
        );
        return apiClient.request(cfg);
      }
      console.warn(
        "[session] ignored an auth failure from a replaced session:",
        { status, url, serverError },
      );
    }

    if (isAuthFailure && belongsToCurrentSession) {
      notifySessionExpired({ status, url, serverError });
    }
    return Promise.reject(error);
  },
);

export default apiClient;
