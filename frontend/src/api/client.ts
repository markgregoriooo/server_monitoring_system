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

// Read a JWT's time claims without a library. Null if missing or unreadable.
// JWTs are base64url (`-`, `_`, no padding), which `atob` rejects, so convert first;
// otherwise it only fails for some tokens.
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
 * Milliseconds until the stored token expires, measured on one clock.
 *
 * `exp - iat` is the token's lifetime (both from the server clock), added to when we
 * received it (our clock). Comparing `exp` with Date.now() would mix the two clocks
 * and break on a machine whose time is off. Exported so AuthContext uses the same rule.
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

// ─── Sharing identical in-flight GETs ───────────────────────────────────────────────────
// The Dashboard and the PiP widget both load /servers, /ups, /network, /mikrotik and
// /aircon on mount, and StrictMode doubles that in dev, which used to hit the rate
// limiter. Concurrent identical GETs now share one promise. Not a cache: the entry
// is removed as soon as the request settles, so nobody gets stale data.
const inFlight = new Map<string, Promise<unknown>>();

// Always sent, even when concurrent: revealing an install key is audited per view.
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

  // Callers share one response object, so treat responses as read-only.
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

    // Never send a token we know has expired. This is the only check that covers a tab
    // that has been open for a long time; the others run when a session starts or is
    // restored. Ends the session once, cleanly, instead of a burst of rejected requests.
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
    // Record which session the request belongs to (even null), so the error handler can
    // tell whether a failure is about the current session.
    config.__cspcToken = token;

    return config;
  }
);

// ── Auto-logout on auth failure ───────────────────────────────────────────────
// When the backend rejects our session, fire a window event for AuthContext (so this
// module does not import React or AuthContext). Only on 401, and not for /auth/google
// or /auth/logout themselves. A 403 (signed in but not allowed) never logs out.
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
  // Include which request ended the session, to make an unexpected logout traceable.
  console.warn("[session] ended by an API auth failure:", info);
  window.dispatchEvent(new CustomEvent("cspc:session-expired", { detail: info }));
}

apiClient.interceptors.response.use(
  (response) => {
    // Sliding session: if the backend sent a renewed token (past half its life), store it
    // and tell AuthContext to reset its expiry timer.
    const renewed = response.headers?.["x-renewed-token"];
    if (renewed && typeof renewed === "string") {
      try {
        sessionStorage.setItem("cspc_token", JSON.stringify(renewed));
        // When we received it, on our clock (see msUntilTokenExpiry).
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

    // 401 only: every authentication failure from the backend is a 401 (no token, bad
    // token, expired, revoked). A 403 means signed in but not allowed, and must not end
    // the session.
    const isAuthFailure = status === 401 && !isAuthEndpoint;

    // A failure from an old session must not log out the current one. Example: a
    // request goes out with token T1, the user signs out and back in (now T2), and then
    // the old request fails with 401. Compare the token the request was sent with against
    // the one stored now; if they differ, ignore the failure. A real revocation still logs
    // out, because the next request with the current token fails too.
    const sentUnder = error?.config?.__cspcToken ?? null;
    const belongsToCurrentSession = sentUnder === getToken();

    if (isAuthFailure && !belongsToCurrentSession) {
      // Don't just drop it; retry once with the current token. Otherwise something that
      // fetches once (like the Dashboard's focus charts) stays empty. Safe for any method:
      // the auth check rejects before the route runs, so the first attempt had no effect. At
      // most one retry; if the new token is rejected too, the branch below logs out.
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
