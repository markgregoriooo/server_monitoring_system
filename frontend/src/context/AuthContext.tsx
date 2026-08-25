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

  // Privacy Notice & Terms. `policy_version` is what this user last accepted
  // (null = never); `policy_current` is what the SERVER says is in force. The
  // acceptance gate shows when they differ, so bumping the version server-side
  // re-prompts everyone without a frontend release.
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

      // Only restore a session whose token is STILL ALIVE.
      //
      // sessionStorage lives as long as the tab does, so a dashboard left open
      // overnight still has its user object here the next morning — with a token
      // that died an hour into the night. Restoring on the strength of the user
      // object alone booted straight into the dashboard, fired a dozen authenticated
      // requests that every one came back 403, filled the console with failures, and
      // landed on the login page anyway. To the person at the keyboard that looks
      // like being kicked out immediately after signing in.
      //
      // The token states its own expiry, so this costs nothing and needs no network.
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

  // Keep the socket connection in sync with auth state. This also runs on mount,
  // so a session restored from sessionStorage after a page refresh reconnects the
  // socket (and resumes live sensor data) without needing to log out and back in.
  //
  // `idleLogout` is part of the condition because `user` deliberately stays set while
  // the notice is up (so the page behind it doesn't vanish) — without this the effect
  // would helpfully reconnect the socket we just closed.
  useEffect(() => {
    if (user && !idleLogout) {
      if (!socket.connected) socket.connect();
    } else if (socket.connected) {
      socket.disconnect();
    }
  }, [user, idleLogout]);

  // Clear the session locally, no server round-trip. Used by manual logout (after
  // notifying the server) and by both auto-logout paths below, where the token is
  // already invalid so calling the server is pointless. Setting user to null makes
  // AppShell redirect to /login automatically.
  const clearLocalSession = useCallback(() => {
    socket.disconnect();
    setUser(null);
    sessionStorage.removeItem("cspc_user");
    sessionStorage.removeItem("cspc_token");
    sessionStorage.removeItem("cspc_token_at");
  }, []);

  // Idle timeout. Unlike every other teardown this one does NOT drop straight to the
  // login page: being bounced to a sign-in screen with no explanation, after stepping
  // away for a coffee, reads as a crash. The user gets a notice they have to
  // acknowledge instead.
  //
  // The session is destroyed HERE, not when OK is clicked. Token gone, socket
  // closed, storage cleared — all of it, immediately, at the 15-minute mark. The
  // modal is only an explanation, and it must never be the thing keeping a session
  // alive, or an idle timeout could be defeated by simply never clicking OK. `user`
  // stays in React state purely so the page behind the notice doesn't blank out; it
  // is a rendering detail, and it authorises nothing, because the credentials it
  // would have travelled with are already gone.
  const beginIdleLogout = useCallback(() => {
    console.warn("[session] ended — idle: tab hidden for 15 minutes");
    socket.disconnect();
    sessionStorage.removeItem("cspc_user");
    sessionStorage.removeItem("cspc_token");
    sessionStorage.removeItem("cspc_token_at");
    setIdleLogout(true);
  }, []);

  // OK on the notice: finish the job. No `cspc_session_expired` flag — the modal has
  // already said why, and the login page would repeat it in a banner.
  const confirmIdleLogout = useCallback(() => {
    setIdleLogout(false);
    setUser(null); // AppShell redirects to /login
  }, []);

  // Every path that ends a session goes through here, so the console always names
  // the one that fired. Four different mechanisms can log a user out — a rejected
  // request, the token's own expiry, the idle-away timer, and server-side socket
  // revocation — and they all produce the identical "Your session expired" screen.
  // Without the label they are indistinguishable from the outside, which is exactly
  // what makes a spurious logout hard to chase.
  const endSession = useCallback(
    (reason: string, detail?: unknown) => {
      console.warn(`[session] ended — ${reason}`, detail ?? "");
      sessionStorage.setItem("cspc_session_expired", "1");
      clearLocalSession();
    },
    [clearLocalSession],
  );

  // Reactive auto-logout: the axios response interceptor emits this when the backend
  // rejects one of our requests. Act only if we still hold a token, so a stray event
  // after logout is a no-op. The login page shows a notice via the flag.
  //
  // A single rejected request is NOT proof the session is dead, and treating it as
  // proof is what made this destructive. Any one response can be rejected for reasons
  // that have nothing to do with the session still being valid — it was sent under a
  // token that has since been replaced by the sliding renewal, it raced a reconnect,
  // it was retried by the browser, or it simply arrived late. The old code destroyed
  // the session on the first such reply, which is why a burst of parallel requests
  // (pip/LiveSummaryContext re-seeds four endpoints the instant the socket connects,
  // i.e. immediately after login) could throw the user straight back to the sign-in
  // page while their credentials were perfectly good.
  //
  // So: ask the server. ONE authoritative call with the CURRENT token decides. If
  // /auth/me answers, the session is alive and the rejection belonged to something
  // stale — keep the user signed in and re-arm the guard. Only a rejection of THIS
  // check ends the session. A network or 5xx failure is not an auth answer at all and
  // must never log anyone out.
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

  // Server-side revocation of a LIVE socket (services/socketSessions.js): the
  // account was disabled, removed, or its tokens revoked while this connection was
  // open. HTTP would have caught it at the next request, but a dashboard sitting on
  // socket-fed pages makes no requests for minutes — so without this the user keeps
  // watching live data they are no longer entitled to. Same treatment as an expiry:
  // the reason isn't shown, since the login page already explains a disabled account
  // if they try to sign back in.
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

  // A REJECTED handshake had no listener at all.
  //
  // src/server.js's io.use() rejects with next(new Error("Unauthorized")) or
  // next(new Error("Session is no longer valid")) — both arrive here as connect_error.
  // With nobody listening, Socket.IO retried forever in silence: HTTP kept working, so
  // the dashboard looked fine while every live panel quietly stopped updating. On a
  // monitoring wall that is indistinguishable from "nothing is happening".
  //
  // An auth rejection gets the same treatment as sessionRevoked. Anything else (backend
  // down, network drop) is left alone deliberately — Socket.IO's own reconnection
  // handles it, and signing someone out because the LAN blipped would be worse.
  // See audits/error-handling-report-2026-08-25.md — E-06.
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
    const msLeft = msUntilTokenExpiry();
    if (msLeft === null) return;

    // Already dead when we armed. The restore path above now rejects an expired
    // token before a session is ever built from it, so reaching this means the token
    // died between restore and here — an unlikely but real window.
    if (msLeft <= 0) {
      endSession("token already expired when armed", { expiredMsAgo: -msLeft });
      return;
    }
    const t = setTimeout(() => endSession("token lifetime reached"), msLeft);
    return () => clearTimeout(t);
  }, [user, endSession, renewTick]);

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
