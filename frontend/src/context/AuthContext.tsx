import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
} from "react";
import type { ReactNode } from "react";
import { api } from "../api/api.js";
import { resetSessionExpiredGuard } from "../api/client.js";
import { socket } from "../socket/socket.js";

// Read the JWT's `exp` (epoch seconds) without a library. Null if missing/unparseable.
function decodeJwtExp(token: string | null): number | null {
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split(".")[1] ?? ""));
    return typeof payload?.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

function readToken(): string | null {
  try {
    return JSON.parse(sessionStorage.getItem("cspc_token") || "null");
  } catch {
    return null;
  }
}

interface User {
  id: number;
  name: string;
  username: string;
  email: string;
  role: string;

  avatar?: string | undefined;
  profile_image?: string | undefined;
  status?: string | undefined;
  created_at?: string | undefined;
  last_login?: string | undefined;

  permissions: string[];
}

interface AuthContextType {
  user: User | null;
  // Google sign-in is the only login path. Resolves with success on an active
  // account; otherwise carries a `status` ("pending" | "rejected" | "disabled").
  loginWithGoogle: (
    code: string,
  ) => Promise<{
    success: boolean;
    status?: string | undefined;
    error?: string | undefined;
  }>;
  logout: () => Promise<void>;
  updateUser: (data: Partial<User>) => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    try {
      const saved = sessionStorage.getItem("cspc_user");
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  // Keep the socket connection in sync with auth state. This also runs on mount,
  // so a session restored from sessionStorage after a page refresh reconnects the
  // socket (and resumes live sensor data) without needing to log out and back in.
  useEffect(() => {
    if (user) {
      if (!socket.connected) socket.connect();
    } else if (socket.connected) {
      socket.disconnect();
    }
  }, [user]);

  // Clear the session locally, no server round-trip. Used by manual logout (after
  // notifying the server) and by both auto-logout paths below, where the token is
  // already invalid so calling the server is pointless. Setting user to null makes
  // AppShell redirect to /login automatically.
  const clearLocalSession = useCallback(() => {
    socket.disconnect();
    setUser(null);
    sessionStorage.removeItem("cspc_user");
    sessionStorage.removeItem("cspc_token");
  }, []);

  // Reactive auto-logout: the axios response interceptor emits this when the
  // backend rejects our token (expired, or a session invalidated elsewhere). Act
  // only if we still hold a token, so a stray event after logout is a no-op. The
  // login page shows a notice via the cspc_session_expired flag.
  useEffect(() => {
    const onExpired = () => {
      if (!sessionStorage.getItem("cspc_user")) return; // not logged in — ignore stray events
      sessionStorage.setItem("cspc_session_expired", "1");
      clearLocalSession();
    };
    window.addEventListener("cspc:session-expired", onExpired);
    return () => window.removeEventListener("cspc:session-expired", onExpired);
  }, [clearLocalSession]);

  // Sliding session: the API silently renews our token (X-Renewed-Token header →
  // client.ts saves it + fires this event) while the user stays active. Bumping this
  // tick re-runs the proactive-expiry effect below so it re-arms to the NEW token's
  // later exp, instead of firing at the original login+1h mark and logging out an
  // active user.
  const [renewTick, setRenewTick] = useState(0);
  useEffect(() => {
    const onRenewed = () => setRenewTick((n) => n + 1);
    window.addEventListener("cspc:token-renewed", onRenewed);
    return () => window.removeEventListener("cspc:token-renewed", onRenewed);
  }, []);

  // Proactive auto-logout exactly when the JWT expires, so an idle tab doesn't sit
  // on a dead token until the next request. Re-runs on login / restore-from-storage /
  // token renewal, reading exp from the current token.
  useEffect(() => {
    if (!user) return;
    const exp = decodeJwtExp(readToken());
    if (!exp) return;
    const expire = () => {
      sessionStorage.setItem("cspc_session_expired", "1");
      clearLocalSession();
    };
    const msLeft = exp * 1000 - Date.now();
    if (msLeft <= 0) {
      expire();
      return;
    }
    const t = setTimeout(expire, msLeft);
    return () => clearTimeout(t);
  }, [user, clearLocalSession, renewTick]);

  // Activity-based session lifetime — two rules, both keyed on whether the user is
  // actually WATCHING the dashboard:
  //   • watching      → keep the session alive. A heartbeat ping triggers the backend's
  //                     sliding renewal, so even socket-fed pages that make no HTTP
  //                     calls once loaded — Dashboard, Environment, Server Metrics,
  //                     Network, MikroTik, UPS — don't expire while on screen.
  //   • not watching  → the user switched to another tab / minimized / hid the page,
  //                     so log out after a 15-min idle timeout (PCI-DSS standard)
  //                     instead of lingering for the full token life.
  // "Watching" = the tab is visible OR a Picture-in-Picture window is open, so popping
  // out a live tile and working elsewhere keeps you signed in. The PiP check reads the
  // browser API directly, so it already works for the pip-widget when that branch merges.
  useEffect(() => {
    if (!user) return;

    const HEARTBEAT_MS = 10 * 60 * 1000;    // keep-alive cadence — under the 30-min half-life
    const AWAY_LOGOUT_MS = 15 * 60 * 1000;  // idle timeout after leaving the tab (PCI-DSS standard)

    const pipOpen = () => {
      try {
        const w = window as unknown as { documentPictureInPicture?: { window: unknown } };
        return !!w.documentPictureInPicture?.window || !!document.pictureInPictureElement;
      } catch {
        return false;
      }
    };
    const watching = () => document.visibilityState === "visible" || pipOpen();

    let awayTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelAway = () => {
      if (awayTimer) {
        clearTimeout(awayTimer);
        awayTimer = null;
      }
    };

    const ping = () => {
      if (watching()) void api.me();
    };

    const onVisibilityChange = () => {
      if (watching()) {
        cancelAway();
        ping(); // refresh the session the moment the user comes back
      } else if (!awayTimer) {
        awayTimer = setTimeout(() => {
          sessionStorage.setItem("cspc_session_expired", "1");
          clearLocalSession();
        }, AWAY_LOGOUT_MS);
      }
    };

    ping(); // immediate keep-alive on mount/restore
    const beat = setInterval(ping, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      clearInterval(beat);
      cancelAway();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [user, clearLocalSession]);

  const loginWithGoogle = useCallback(async (code: string) => {
    const result = await api.loginWithGoogle(code);

    // Active accounts come back with a token. Anything else (pending / rejected /
    // disabled, or an error) has no token — surface its status to the Login page.
    if (!result.success || !result.data?.token) {
      return {
        success: false,
        status: result.data?.status,
        error: result.error ?? result.data?.message ?? "Sign-in failed.",
      };
    }

    const { token, user } = result.data;

    // normalize user to match AuthContext User type
    const safeUser: User = {
      id: Number(user.id),
      name: String(user.name ?? ""),
      username: String(user.username ?? ""),
      email: String(user.email ?? ""),
      role: String(user.role ?? ""),
      status: user.status ?? undefined,
      avatar: user.avatar ?? undefined,
      profile_image: user.profile_image ?? undefined,
      permissions: Array.isArray(user.permissions)
        ? user.permissions.map(String)
        : [],
      created_at: user.created_at ?? undefined,
      last_login: user.last_login ?? undefined,
    };

    sessionStorage.setItem("cspc_token", JSON.stringify(token));
    sessionStorage.setItem("cspc_user", JSON.stringify(safeUser));
    sessionStorage.removeItem("cspc_session_expired"); // fresh login — drop any expiry notice
    resetSessionExpiredGuard();                         // re-arm the interceptor's one-shot guard

    setUser(safeUser);
    socket.connect();

    return { success: true };
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    clearLocalSession();
  }, [clearLocalSession]);

  const updateUser = useCallback((data: Partial<User>) => {
    setUser((prev) => {
      if (!prev) return prev;

      // Only spread defined values — prevents undefined fields
      // from overwriting good existing state
      const patch = Object.fromEntries(
        Object.entries(data).filter(([, v]) => v !== undefined),
      ) as Partial<User>;

      const updated: User = {
        ...prev,
        ...patch,
      };

      sessionStorage.setItem("cspc_user", JSON.stringify(updated));
      return updated;
    });
  }, []);

  const value = useMemo(
    () => ({ user, loginWithGoogle, logout, updateUser }),
    [user, loginWithGoogle, logout, updateUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
