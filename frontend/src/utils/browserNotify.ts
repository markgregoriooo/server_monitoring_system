// Thin wrapper around the Web Notifications API (OS-level popups). Kept free of
// app types so it never couples back to NotificationContext.

// `onActivate` runs when the popup is clicked. A callback, so this module needs no
// router knowledge (see notificationUtils.routeFor).
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

// Show an OS popup only when the tab is not focused (a focused user sees the in-app
// toast). Does nothing without permission.
export function fireDesktopNotification(n: DesktopPayload): void {
  if (!desktopGranted()) return;
  if (typeof document !== "undefined" && document.visibilityState === "visible") return;
  try {
    const opts: NotificationOptions = { body: n.message };
    if (n.alertId != null) opts.tag = `alert-${n.alertId}`; // collapse dupes across tabs
    const popup = new Notification(n.title, opts);

    // Clicking does what the toast does: brings the dashboard forward and opens the alert's page.
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
