import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useNotifications } from "../../context/NotificationContext";
import type { AppNotification } from "../../context/NotificationContext";
import { SEVERITY_COLOR, routeFor, relativeTime } from "./notificationUtils";
import { desktopPermission, requestDesktopPermission } from "../../utils/browserNotify";

export default function NotificationPanel({ onClose }: { onClose: () => void }) {
  const { items, unreadCount, markRead, markAllRead } = useNotifications();
  const navigate = useNavigate();

  // Desktop (OS) popups are opt-in: offer to enable while permission is still "default".
  const [perm, setPerm] = useState(desktopPermission());

  const onItemClick = (n: AppNotification) => {
    if (!n.isRead) markRead([n.id]);
    navigate(routeFor(n));
    onClose();
  };

  return (
    <div
      className="absolute right-0 mt-2 w-80 max-h-[70vh] flex flex-col z-50 shadow-xl"
      style={{
        background: "var(--gf-panel)",
        border: "1px solid var(--gf-panel-border)",
        borderRadius: 2,
        fontFamily: "'JetBrains Mono', monospace",
      }}
      role="dialog"
      aria-label="Notifications"
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--gf-divider)" }}
      >
        <span className="text-[11px] font-semibold tracking-wide" style={{ color: "var(--gf-text-primary)" }}>
          NOTIFICATIONS{unreadCount > 0 ? ` (${unreadCount})` : ""}
        </span>
        {unreadCount > 0 && (
          <button
            onClick={() => markAllRead()}
            className="text-[10px] transition-colors"
            style={{ color: "var(--gf-accent)" }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.8")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
          >
            Mark all read
          </button>
        )}
      </div>

      {/* Desktop-popup opt-in (only while the browser hasn't decided yet) */}
      {perm === "default" && (
        <button
          onClick={async () => setPerm(await requestDesktopPermission())}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[10px] w-full transition-colors flex-shrink-0"
          style={{ color: "var(--gf-accent)", borderBottom: "1px solid var(--gf-divider)" }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--gf-hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <path d="M8 2a5 5 0 00-5 5v3l-1 1.5h12L13 10V7a5 5 0 00-5-5z" stroke="currentColor" strokeWidth="1.3" />
          </svg>
          Enable desktop alerts
        </button>
      )}

      {/* List */}
      <div className="overflow-y-auto">
        {items.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11px]" style={{ color: "var(--gf-text-muted)" }}>
            No notifications
          </div>
        ) : (
          items.map((n) => (
            <button
              key={n.id}
              onClick={() => onItemClick(n)}
              className="w-full text-left px-3 py-2.5 flex gap-2.5 transition-colors"
              style={{
                borderBottom: "1px solid var(--gf-divider)",
                background: n.isRead ? "transparent" : "var(--gf-accent-dim)",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "var(--gf-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = n.isRead ? "transparent" : "var(--gf-accent-dim)")}
            >
              {/* severity dot */}
              <span
                className="mt-1 flex-shrink-0 rounded-full"
                style={{ width: 7, height: 7, background: SEVERITY_COLOR[n.severity] ?? "var(--gf-text-muted)" }}
              />
              <span className="flex-1 min-w-0">
                <span className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-semibold truncate" style={{ color: "var(--gf-text-primary)" }}>
                    {n.title}
                  </span>
                  <span className="text-[9px] flex-shrink-0" style={{ color: "var(--gf-text-dim)" }}>
                    {relativeTime(n.sentAt || n.createdAt)}
                  </span>
                </span>
                <span className="block text-[10px] mt-0.5 truncate" style={{ color: "var(--gf-text-muted)" }}>
                  {n.message}
                </span>
                {n.deviceName && (
                  <span className="block text-[9px] mt-0.5 truncate" style={{ color: "var(--gf-text-dim)" }}>
                    {n.deviceName}
                  </span>
                )}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
