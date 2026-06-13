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
import { api } from "../api/api.js";
import { socket } from "../socket/socket.js";
import { useAuth } from "./AuthContext.js";
import { fireDesktopNotification } from "../utils/browserNotify.js";
import { playNotificationSound } from "../utils/notificationSound.js";

export type Severity = "info" | "warning" | "critical";

// Mirrors the backend toClient() shape (camelCase). `id` is the per-user
// alert_notifications row — the thing we mark read.
export interface AppNotification {
  id: number;
  alertId: number;
  deviceId: number;
  deviceName: string | null;
  type: string;
  title: string;
  message: string;
  severity: Severity;
  isRead: boolean;
  createdAt: string;
  sentAt: string;
}

type IncomingListener = (n: AppNotification) => void;

interface NotificationContextType {
  items: AppNotification[];
  unreadCount: number;
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
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

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

  // Load on login / refresh-from-storage; clear on logout.
  useEffect(() => {
    if (!user) {
      setItems([]);
      setUnreadCount(0);
      return;
    }
    refresh();
  }, [user, refresh]);

  // Live feed: prepend on push, and re-sync on (re)connect so a tab that was
  // asleep/offline doesn't miss events fired while its socket was down.
  useEffect(() => {
    if (!user) return;
    const onNotification = (n: AppNotification) => {
      setItems((prev) => [n, ...prev].slice(0, MAX_ITEMS));
      setUnreadCount((c) => c + 1);
      playNotificationSound(); // chime (if not muted)
      fireDesktopNotification({ title: n.title, message: n.message, alertId: n.alertId }); // OS popup (if granted + tab hidden)
      listenersRef.current.forEach((fn) => fn(n)); // in-app toasts, etc.
    };
    const onReconnect = () => { refresh(); };
    socket.on("notification", onNotification);
    socket.on("connect", onReconnect);
    return () => {
      socket.off("notification", onNotification);
      socket.off("connect", onReconnect);
    };
  }, [user, refresh]);

  const markRead = useCallback(async (ids: number[]) => {
    if (!ids.length) return;
    const idSet = new Set(ids);
    setItems((prev) => prev.map((n) => (idSet.has(n.id) ? { ...n, isRead: true } : n))); // optimistic
    const res = await api.markNotificationsRead(ids);
    if (res.success && res.data) setUnreadCount(res.data.unreadCount ?? 0);
    else refresh(); // reconcile on failure
  }, [refresh]);

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
    () => ({ items, unreadCount, refresh, markRead, markAllRead, dismiss, clearAll, subscribe }),
    [items, unreadCount, refresh, markRead, markAllRead, dismiss, clearAll, subscribe],
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotifications must be used within NotificationProvider");
  return ctx;
}
