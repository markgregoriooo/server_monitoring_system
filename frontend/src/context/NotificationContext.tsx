import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
} from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/api.js";
import { routeFor, deviceLabel } from "../components/notifications/notificationUtils.js";
import { socket } from "../socket/socket.js";
import { useAuth } from "./AuthContext.js";
import { fireDesktopNotification } from "../utils/browserNotify.js";
import { playNotificationSound } from "../utils/notificationSound.js";
import type { AppNotification, Severity } from "../types/notification";

// Shapes moved to ../types/notification: this file imports routeFor from
// notificationUtils, which needs these types — owning them here made a cycle.
// Re-exported so the existing `from "../context/NotificationContext"` imports resolve.
export type { Severity, AppNotification } from "../types/notification";

type IncomingListener = (n: AppNotification) => void;

interface NotificationContextType {
  items: AppNotification[];
  unreadCount: number;
  // Count of alerts still needing attention (active OR acknowledged). Shared lifecycle
  // count — distinct from per-user unreadCount. Drives the sidebar "Alerts" badge.
  openAlertCount: number;
  // Admin-only live counts for the sidebar nav badges (0 for non-admins).
  pendingAgentCount: number; // servers (agents) awaiting approval → Server Metrics badge
  pendingUserCount: number; // new user registrations awaiting approval → User Management badge
  refresh: () => Promise<void>;
  markRead: (ids: number[]) => Promise<void>;
  markAllRead: () => Promise<void>;
  dismiss: (ids: number[]) => Promise<void>;
  clearAll: () => Promise<void>;
  // Subscribe to NEW (live) notifications only — for ephemeral consumers like the
  // toast host. Returns an unsubscribe fn. Avoids a second socket listener.
  subscribe: (fn: IncomingListener) => () => void;
}

const NotificationContext = createContext<NotificationContextType | null>(null);

const MAX_ITEMS = 100; // cap the in-memory feed; older history is still in the DB

export function NotificationProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  // Safe: the provider is mounted inside <BrowserRouter> (main.tsx → App). Used only
  // to make the OS popup's click land on the right page, the way the toast/bell do.
  const navigate = useNavigate();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [openAlertCount, setOpenAlertCount] = useState(0);
  const [pendingAgentCount, setPendingAgentCount] = useState(0);
  const [pendingUserCount, setPendingUserCount] = useState(0);

  // Live-event subscribers (toast host, etc.). A ref so subscribe/unsubscribe
  // never re-creates the socket handler.
  const listenersRef = useRef<Set<IncomingListener>>(new Set());
  const subscribe = useCallback((fn: IncomingListener) => {
    listenersRef.current.add(fn);
    return () => { listenersRef.current.delete(fn); };
  }, []);

  const refresh = useCallback(async () => {
    const res = await api.getNotifications();
    if (res.success && res.data) {
      setItems(res.data.notifications ?? []);
      setUnreadCount(res.data.unreadCount ?? 0);
    }
  }, []);

  // Open (unresolved) alert count for the sidebar badge — the shared lifecycle view.
  const refreshAlertCount = useCallback(async () => {
    const res = await api.getOpenAlertCount();
    if (res.success && res.data) setOpenAlertCount(res.data.open ?? 0);
  }, []);

  // Pending-approval counts for the nav badges. Admin-only endpoints — skip (and keep
  // 0) for it_staff so we never fire a 403. Both pages also refetch their own lists.
  const refreshPending = useCallback(async () => {
    if (user?.role !== "admin") return;
    const [agentsRes, usersRes] = await Promise.all([api.getPendingAgents(), api.getPendingUsers()]);
    if (agentsRes.success && agentsRes.data) setPendingAgentCount((agentsRes.data.pending ?? []).length);
    if (usersRes.success && usersRes.data) setPendingUserCount((usersRes.data.pending ?? []).length);
  }, [user]);

  // Load on login / refresh-from-storage; clear on logout.
  useEffect(() => {
    if (!user) {
      setItems([]);
      setUnreadCount(0);
      setOpenAlertCount(0);
      setPendingAgentCount(0);
      setPendingUserCount(0);
      return;
    }
    refresh();
    refreshAlertCount();
    refreshPending();
  }, [user, refresh, refreshAlertCount, refreshPending]);

  // Declared ABOVE the live-feed effect on purpose: that effect's dependency array
  // names it, and a dep array is built during render — a `const` declared further down
  // would still be in its temporal dead zone and throw on the very first render.
  const markRead = useCallback(async (ids: number[]) => {
    if (!ids.length) return;
    const idSet = new Set(ids);
    setItems((prev) => prev.map((n) => (idSet.has(n.id) ? { ...n, isRead: true } : n))); // optimistic
    const res = await api.markNotificationsRead(ids);
    if (res.success && res.data) setUnreadCount(res.data.unreadCount ?? 0);
    else refresh(); // reconcile on failure
  }, [refresh]);

  // Live feed: prepend on push, and re-sync on (re)connect so a tab that was
  // asleep/offline doesn't miss events fired while its socket was down.
  useEffect(() => {
    if (!user) return;
    const onNotification = (n: AppNotification) => {
      setItems((prev) => [n, ...prev].slice(0, MAX_ITEMS));
      setUnreadCount((c) => c + 1);
      refreshAlertCount(); // a new alert is unresolved → bump the sidebar badge
      playNotificationSound(); // chime (if not muted)
      // OS popup (if granted + tab hidden). Clicking it focuses the dashboard, marks
      // the item read and opens the device's page — the same gesture as the toast.
      // The device goes in the BODY here, unlike the toast and the bell which have a
      // line of their own for it. An OS popup only gets a title and a body, so a
      // notification that named the device nowhere was the one surface you could read
      // without learning WHICH machine it was about — and it is the surface you see
      // when the dashboard is not even open.
      fireDesktopNotification({
        title: n.title,
        message: deviceLabel(n) ? `${n.message} — ${deviceLabel(n)}` : n.message,
        alertId: n.alertId,
        onActivate: () => {
          if (!n.isRead) markRead([n.id]);
          navigate(routeFor(n));
        },
      });
      listenersRef.current.forEach((fn) => fn(n)); // in-app toasts, etc.
    };
    // Any lifecycle change (acknowledge/resolve/auto-resolve) can change the open count
    // AND should reflect on the matching bell items (status + who handled it), live.
    const onAlertUpdated = (a: {
      id: number;
      status?: AppNotification["status"];
      acknowledgedByName?: string | null;
      acknowledgedByRole?: string | null;
      acknowledgedAt?: string | null;
      resolvedAt?: string | null;
    }) => {
      if (a && typeof a.id === "number") {
        setItems((prev) =>
          prev.map((n) =>
            n.alertId === a.id
              ? {
                  ...n,
                  status: a.status ?? n.status ?? "active",
                  acknowledgedByName: a.acknowledgedByName ?? n.acknowledgedByName ?? null,
                  acknowledgedByRole: a.acknowledgedByRole ?? n.acknowledgedByRole ?? null,
                  acknowledgedAt: a.acknowledgedAt ?? n.acknowledgedAt ?? null,
                  resolvedAt: a.resolvedAt ?? n.resolvedAt ?? null,
                }
              : n,
          ),
        );
      }
      refreshAlertCount();
    };
    const onReconnect = () => { refresh(); refreshAlertCount(); refreshPending(); };
    // Pending-approval queues change → update the nav badges (admin only; no-op otherwise).
    // agentApproved/agentPending fire on agent register/approve/reject;
    // userApproved/userPending on user self-register/approve/reject.
    const onPendingChanged = () => refreshPending();
    socket.on("notification", onNotification);
    socket.on("alertUpdated", onAlertUpdated);
    socket.on("connect", onReconnect);
    socket.on("agentPending", onPendingChanged);
    socket.on("agentApproved", onPendingChanged);
    socket.on("userPending", onPendingChanged);
    socket.on("userApproved", onPendingChanged);
    return () => {
      socket.off("notification", onNotification);
      socket.off("alertUpdated", onAlertUpdated);
      socket.off("connect", onReconnect);
      socket.off("agentPending", onPendingChanged);
      socket.off("agentApproved", onPendingChanged);
      socket.off("userPending", onPendingChanged);
      socket.off("userApproved", onPendingChanged);
    };
  }, [user, refresh, refreshAlertCount, refreshPending, markRead, navigate]);

  const markAllRead = useCallback(async () => {
    setItems((prev) => prev.map((n) => ({ ...n, isRead: true }))); // optimistic
    setUnreadCount(0);
    const res = await api.markAllNotificationsRead();
    if (!res.success) refresh();
  }, [refresh]);

  const dismiss = useCallback(async (ids: number[]) => {
    if (!ids.length) return;
    const idSet = new Set(ids);
    setItems((prev) => prev.filter((n) => !idSet.has(n.id))); // optimistic remove
    const res = await api.dismissNotifications(ids);
    if (res.success && res.data) setUnreadCount(res.data.unreadCount ?? 0);
    else refresh();
  }, [refresh]);

  const clearAll = useCallback(async () => {
    setItems([]); // optimistic
    setUnreadCount(0);
    const res = await api.clearAllNotifications();
    if (!res.success) refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ items, unreadCount, openAlertCount, pendingAgentCount, pendingUserCount, refresh, markRead, markAllRead, dismiss, clearAll, subscribe }),
    [items, unreadCount, openAlertCount, pendingAgentCount, pendingUserCount, refresh, markRead, markAllRead, dismiss, clearAll, subscribe],
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotifications must be used within NotificationProvider");
  return ctx;
}
