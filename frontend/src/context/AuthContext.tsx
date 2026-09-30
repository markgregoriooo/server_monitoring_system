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
import { resetSessionExpiredGuard, msUntilTokenExpiry } from "../api/client.js";
import { socket } from "../socket/socket.js";

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

  // Privacy Notice & Terms. `policy_version` is what this user last accepted (null =
  // never); `policy_current` is the version in force on the server. The gate shows
  // when they differ.
  policy_version?: string | null | undefined;
  policy_accepted_at?: string | null | undefined;
  policy_current?: string | undefined;

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
  /** True once the idle timeout has ended the session but the user hasn't acknowledged it. */
  idleLogout: boolean;
  /** Dismiss the idle notice and complete the sign-out (drops to the login page). */
  confirmIdleLogout: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    try {
      const saved = sessionStorage.getItem("cspc_user");
      if (!saved) return null;

      // Only restore a session whose token is still valid. A tab left open overnight still
      // has the user object in sessionStorage but an expired token; restoring it would
      // fire requests that all fail and then land on the login page. The token's own
      // expiry is checked, with no network call.
      const token = readToken();
      const msLeft = token ? msUntilTokenExpiry() : null;
      if (!token || (msLeft !== null && msLeft <= 0)) {
        console.warn(
          `[session] not restoring — stored token ${token ? `expired ${Math.round(-(msLeft ?? 0) / 1000)}s ago` : "missing"}`,
        );
        sessionStorage.removeItem("cspc_user");
        sessionStorage.removeItem("cspc_token");
        sessionStorage.removeItem("cspc_token_at");
        sessionStorage.setItem("cspc_session_expired", "1");
        return null;
      }

      return JSON.parse(saved);
    } catch {
      return null;
    }
  });

  // The idle timeout has fired and the user has not acknowledged it yet. The session
  // is already dead at this point — this only holds the notice on screen.
  const [idleLogout, setIdleLogout] = useState(false);

  // Keep the socket in step with the auth state. Also runs on mount, so a session
  // restored after a refresh reconnects the socket. `idleLogout` is in the condition
  // because `user` stays set while the idle notice is shown; otherwise this would
  // reconnect the socket that was just closed.
  useEffect(() => {
    if (user && !idleLogout) {
      if (!socket.connected) socket.connect();
    } else if (socket.connected) {
      socket.disconnect();
    }
  }, [user, idleLogout]);

  // Clear the session locally, with no server call. Used by manual logout (after telling
  // the server) and by the auto-logout paths, where the token is already invalid.
  // Setting user to null makes AppShell redirect to /login.
  const clearLocalSession = useCallback(() => {
    socket.disconnect();
    setUser(null);
    sessionStorage.removeItem("cspc_user");
    sessionStorage.removeItem("cspc_token");
    sessionStorage.removeItem("cspc_token_at");
  }, []);

  // Idle timeout. Instead of dropping straight to the login page, the user gets a notice
  // explaining what happened. The session is destroyed right here at the 15-minute mark
  // (token, socket, storage); the notice only explains it, so not clicking OK cannot
  // keep a session alive. `user` stays in state only so the page behind the notice
  // does not go blank.
  const beginIdleLogout = useCallback(() => {
    console.warn("[session] ended — idle: tab hidden for 15 minutes");

    // Revoke on the server first, then clear locally. Otherwise the token would still work
    // for up to an hour after the screen locked. Not awaited, so a slow backend never
    // delays securing the screen. `api.logout()` reads the token from storage, so it is
    // called before the keys are removed.
    void api.logout().catch(() => {
      /* best effort — the local session is torn down regardless */
    });

    socket.disconnect();
    sessionStorage.removeItem("cspc_user");
    sessionStorage.removeItem("cspc_token");
    sessionStorage.removeItem("cspc_token_at");

    // Tell the sign-in page why, so its banner matches. Set here rather than on the OK
    // button, because a reload or restored tab reaches /login without OK being clicked.
    // The value tells the two cases apart: "expired" (the token ran out) and "idle"
    // (nobody was watching).
    sessionStorage.setItem("cspc_session_expired", "idle");

    setIdleLogout(true);
  }, []);

  // OK on the notice: finish the sign-out. The `cspc_session_expired` flag was already
  // set in beginIdleLogout.
  const confirmIdleLogout = useCallback(() => {
    setIdleLogout(false);
    setUser(null); // AppShell redirects to /login
  }, []);

  // Every logout goes through here, so the console names which one fired: a rejected
  // request, token expiry, the idle timer or socket revocation. They all show the same
  // "session expired" screen.
  const endSession = useCallback(
    (reason: string, detail?: unknown) => {
      console.warn(`[session] ended — ${reason}`, detail ?? "");
      sessionStorage.setItem("cspc_session_expired", "1");
      clearLocalSession();
    },
    [clearLocalSession],
  );

  // Reactive auto-logout: the axios interceptor fires this when the backend rejects a
  // request. Only acts while we still hold a token.
  //
  // One rejected request does not prove the session is dead: it may have been sent with
  // a token that was just renewed, raced a reconnect or arrived late (e.g. the burst of
  // requests LiveSummaryContext sends right after login). So ask the server once with
  // the current token: if /auth/me answers, stay signed in. Only a rejection of this
  // check ends the session; a network or 5xx error never logs anyone out.
  useEffect(() => {
    const onExpired = async (e: Event) => {
      if (!sessionStorage.getItem("cspc_user")) return; // not logged in — ignore stray events
      const detail = (e as CustomEvent).detail;

      const check = await api.me();
      if (check.success) {
        console.warn(
          "[session] auth failure did not survive re-check — session is alive, ignoring:",
          detail,
        );
        resetSessionExpiredGuard(); // let a LATER genuine failure through
        return;
      }
      if (check.status === 401 || check.status === 403) {
        endSession("server confirmed the session is dead", { trigger: detail, check: check.status });
        return;
      }
      // Unreachable backend, 5xx, CORS — an infrastructure problem, not an expiry.
      console.warn("[session] could not verify session (kept):", check.status, detail);
      resetSessionExpiredGuard();
    };
    window.addEventListener("cspc:session-expired", onExpired as EventListener);
    return () => window.removeEventListener("cspc:session-expired", onExpired as EventListener);
  }, [endSession]);

  // The server revoked this live socket (services/socketSessions.js): the account was
  // disabled or removed, or its tokens revoked. Socket-fed pages may make no HTTP
  // requests for minutes, so this is how they find out. Handled like an expiry.
  useEffect(() => {
    const onRevoked = (payload: unknown) => {
      if (!sessionStorage.getItem("cspc_user")) return;
      endSession("server revoked this socket", payload);
    };
    socket.on("sessionRevoked", onRevoked);
    return () => {
      socket.off("sessionRevoked", onRevoked);
    };
  }, [endSession]);

  // A rejected handshake (io.use() in src/server.js: "Unauthorized" or "Session is no
  // longer valid") arrives as connect_error. Without a listener, Socket.IO kept retrying
  // silently while live panels stopped updating. Auth rejections are handled like
  // sessionRevoked; other errors (backend down, network) are left to Socket.IO's own
  // reconnect. See audits/error-handling-report-2026-08-25.md (E-06).
  useEffect(() => {
    const AUTH_REJECTIONS = ["Unauthorized", "Session is no longer valid"];
    const onConnectError = (err: Error) => {
      const msg = err?.message ?? String(err);
      if (AUTH_REJECTIONS.includes(msg)) {
        if (!sessionStorage.getItem("cspc_user")) return;
        endSession("socket handshake rejected", msg);
        return;
      }
      // Transport-level: log once per failure so a silently dead feed is at least
      // diagnosable from the console, but do not touch the session.
      console.warn("[socket] connect_error —", msg);
    };
    socket.on("connect_error", onConnectError);
    return () => {
      socket.off("connect_error", onConnectError);
    };
  }, [endSession]);

  // Sliding session: when the API renews our token (client.ts saves it and fires this
  // event), bump the tick so the expiry timer below re-arms to the new token's expiry.
  const [renewTick, setRenewTick] = useState(0);
  useEffect(() => {
    const onRenewed = () => setRenewTick((n) => n + 1);
    window.addEventListener("cspc:token-renewed", onRenewed);
    return () => window.removeEventListener("cspc:token-renewed", onRenewed);
  }, []);

  // Log out exactly when the JWT expires, so an idle tab does not keep a dead token.
  // Re-runs on login, restore and token renewal.
  useEffect(() => {
    // `idleLogout` is in the condition and deps (like the heartbeat effect): the session is
    // already gone while the notice shows, and a timer left over from before could
    // otherwise fire and replace the "idle" reason with "expired".
    if (!user || idleLogout) return;
    const msLeft = msUntilTokenExpiry();
    if (msLeft === null) return;

    // Already expired when armed. The restore path rejects expired tokens, so this only
    // covers a token that expired in between.
    if (msLeft <= 0) {
      endSession("token already expired when armed", { expiredMsAgo: -msLeft });
      return;
    }
    const t = setTimeout(() => endSession("token lifetime reached"), msLeft);
    return () => clearTimeout(t);
  }, [user, idleLogout, endSession, renewTick]);

  // Session lifetime based on whether the user is watching the dashboard:
  //   • watching     → keep the session alive. A heartbeat request triggers the
  //                    backend's renewal, so socket-only pages (Dashboard,
  //                    Environment, Server Metrics, Network, MikroTik, UPS) do not
  //                    expire while on screen.
  //   • not watching → another tab, minimized or hidden: log out after 15 minutes
  //                    idle (PCI-DSS).
  // "Watching" = the tab is visible or a Picture-in-Picture window is open.
  useEffect(() => {
    if (!user || idleLogout) return; // notice on screen — the session is already gone

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
        awayTimer = setTimeout(beginIdleLogout, AWAY_LOGOUT_MS);
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
  }, [user, idleLogout, beginIdleLogout]);

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
      policy_version: user.policy_version ?? null,
      policy_accepted_at: user.policy_accepted_at ?? null,
      policy_current: user.policy_current ?? undefined,
    };

    sessionStorage.setItem("cspc_token", JSON.stringify(token));
    // When WE received it, on OUR clock — see msUntilTokenExpiry.
    sessionStorage.setItem("cspc_token_at", String(Date.now()));
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
    () => ({ user, loginWithGoogle, logout, updateUser, idleLogout, confirmIdleLogout }),
    [user, loginWithGoogle, logout, updateUser, idleLogout, confirmIdleLogout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within AuthProvider");
  return context;
}
