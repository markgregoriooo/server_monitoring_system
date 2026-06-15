// Thin wrapper around the Web Notifications API (OS-level popups). Kept free of
// app types so it never couples back to NotificationContext.

type DesktopPayload = { title: string; message: string; alertId?: number };

export function desktopSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function desktopPermission(): NotificationPermission | "unsupported" {
  return desktopSupported() ? Notification.permission : "unsupported";
}

export function desktopGranted(): boolean {
  return desktopSupported() && Notification.permission === "granted";
}

export async function requestDesktopPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!desktopSupported()) return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

// Fire an OS popup — but only when the tab is NOT focused. A focused user already
// sees the in-app toast, so the desktop popup is reserved for the background case
// (its whole point). No-op if permission isn't granted.
export function fireDesktopNotification(n: DesktopPayload): void {
  if (!desktopGranted()) return;
  if (typeof document !== "undefined" && document.visibilityState === "visible") return;
  try {
    const opts: NotificationOptions = { body: n.message };
    if (n.alertId != null) opts.tag = `alert-${n.alertId}`; // collapse dupes across tabs
    new Notification(n.title, opts);
  } catch {
    /* some browsers throw if constructed without a service worker — ignore */
  }
}
