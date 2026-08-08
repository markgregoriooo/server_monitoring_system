// Thin wrapper around the Web Notifications API (OS-level popups). Kept free of
// app types so it never couples back to NotificationContext.

// `onActivate` runs when the user CLICKS the popup. Passed in as a callback rather
// than a route string so this module stays free of app types and router knowledge —
// the caller decides where a notification leads (see notificationUtils.routeFor).
type DesktopPayload = {
  title: string;
  message: string;
  alertId?: number;
  onActivate?: () => void;
};

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
    const popup = new Notification(n.title, opts);

    // A click must do what the in-app toast does: bring the dashboard forward and open
    // the alert's page. Without this the popup is a dead end — and since it only fires
    // when the tab is BACKGROUNDED, "dismiss" is never what the user wanted.
    popup.onclick = (event) => {
      event.preventDefault(); // some browsers otherwise also open a blank tab
      // Focus can be refused (browser policy, or the window is already gone). Navigate
      // either way, so the dashboard is on the right page whenever it is next looked at.
      try { window.focus(); } catch { /* ignore — navigation below still runs */ }
      popup.close(); // Windows otherwise leaves it sitting in the Action Center
      n.onActivate?.();
    };
  } catch {
    /* some browsers throw if constructed without a service worker — ignore */
  }
}
