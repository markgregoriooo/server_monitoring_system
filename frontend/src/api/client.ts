import axios from "axios";
import type {
  AxiosInstance,
  InternalAxiosRequestConfig,
} from "axios";
import { API_URL } from "../config";

const baseURL = `${API_URL}/api`;

function getToken(): string | null {
  try {
    return JSON.parse(sessionStorage.getItem("cspc_token") || "null");
  } catch {
    return null;
  }
}

const apiClient: AxiosInstance = axios.create({
  baseURL,
});

// Attach token automatically
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = getToken();

    if (token) {
      config.headers.set("Authorization", `Bearer ${token}`);
    }

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

function notifySessionExpired() {
  if (sessionExpiredNotified) return; // collapse a burst of parallel failures into one
  sessionExpiredNotified = true;
  window.dispatchEvent(new Event("cspc:session-expired"));
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

    if (isAuthFailure) notifySessionExpired();
    return Promise.reject(error);
  },
);

export default apiClient;
