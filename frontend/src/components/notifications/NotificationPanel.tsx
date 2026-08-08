import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useNotifications } from "../../context/NotificationContext";
import type { AppNotification } from "../../context/NotificationContext";
import { SEVERITY_COLOR, routeFor, relativeTime } from "./notificationUtils";
import { desktopPermission, requestDesktopPermission } from "../../utils/browserNotify";
import { isSoundEnabled, setSoundEnabled } from "../../utils/notificationSound";

// Friendly role label for the acknowledge/resolve attribution line.
const roleLabel = (r?: string | null) =>
  r === "admin" ? "Admin" : r === "it_staff" ? "IT Staff" : r ?? "";

export default function NotificationPanel({ onClose }: { onClose: () => void }) {
  const { items, unreadCount, markRead, markAllRead, dismiss, clearAll } = useNotifications();
  const navigate = useNavigate();

  // Bell filter: show all, or only unread.
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const visibleItems = filter === "unread" ? items.filter((n) => !n.isRead) : items;

  // Desktop (OS) popups are opt-in: offer to enable while permission is still "default".
  const [perm, setPerm] = useState(desktopPermission());
  // Notification chime — on by default, mutable from this panel.
  const [soundOn, setSoundOn] = useState(isSoundEnabled());
  const toggleSound = () => {
    const next = !soundOn;
    setSoundEnabled(next);
    setSoundOn(next);
  };

  const onItemClick = (n: AppNotification) => {
    if (!n.isRead) markRead([n.id]);
    navigate(routeFor(n));
    onClose();
  };

  return (
    <div
      className="fixed top-12 right-2 w-[calc(100vw-1rem)] max-w-sm sm:absolute sm:top-auto sm:right-0 sm:mt-2 sm:w-96 sm:max-w-none max-h-[78vh] flex flex-col z-50 overflow-hidden"
      style={{
        background: "var(--gf-panel)",
        border: "1px solid var(--gf-panel-border)",
        borderRadius: 8,
        boxShadow: "var(--gf-shadow)",
        fontFamily: "'JetBrains Mono', monospace",
      }}
      role="dialog"
      aria-label="Notifications"
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3.5 py-2.5 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--gf-divider)" }}
      >
        <span className="text-[14px] font-semibold tracking-wide" style={{ color: "var(--gf-text-primary)" }}>
          NOTIFICATIONS{unreadCount > 0 ? ` (${unreadCount})` : ""}
        </span>
        <div className="flex items-center gap-2.5">
          {unreadCount > 0 && (
            <button
              onClick={() => markAllRead()}
              className="text-[13px] transition-colors"
              style={{ color: "var(--gf-accent)" }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.8")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
            >
              Mark all read
            </button>
          )}
          {items.length > 0 && (
            <button
              onClick={() => clearAll()}
              className="text-[13px] transition-colors"
              style={{ color: "var(--gf-text-muted)" }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--gf-text-primary)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--gf-text-muted)")}
            >
              Clear all
            </button>
          )}
          <button
            onClick={toggleSound}
            aria-label={soundOn ? "Mute notification sound" : "Unmute notification sound"}
            title={soundOn ? "Sound on" : "Sound off"}
            className="transition-colors flex items-center"
            style={{ color: soundOn ? "var(--gf-text-muted)" : "var(--gf-text-dim)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--gf-text-primary)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = soundOn ? "var(--gf-text-muted)" : "var(--gf-text-dim)")}
          >
            {soundOn ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M8 3L4.5 6H2v4h2.5L8 13V3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                <path d="M10.5 5.5a3 3 0 010 5M12.5 4a5.5 5.5 0 010 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M8 3L4.5 6H2v4h2.5L8 13V3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                <path d="M11 6l3 3M14 6l-3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* All / Unread filter */}
      <div
        className="flex items-center gap-1 px-3 py-2 flex-shrink-0"
        style={{ borderBottom: "1px solid var(--gf-divider)" }}
      >
        {([
          { key: "all", label: `All${items.length ? ` (${items.length})` : ""}` },
          { key: "unread", label: `Unread${unreadCount ? ` (${unreadCount})` : ""}` },
        ] as const).map((t) => {
          const active = filter === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setFilter(t.key)}
              className="text-[13px] px-2.5 py-1 transition-colors"
              style={{
                borderRadius: 2,
                background: active ? "var(--gf-accent)" : "transparent",
                color: active ? "#fff" : "var(--gf-text-muted)",
              }}
              onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--gf-hover)"; }}
              onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Desktop-popup opt-in (only while the browser hasn't decided yet) */}
      {perm === "default" && (
        <button
          onClick={async () => setPerm(await requestDesktopPermission())}
          className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] w-full transition-colors flex-shrink-0"
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
      <div className="overflow-y-auto pb-2">
        {visibleItems.length === 0 ? (
          <div className="px-3 py-10 text-center text-[14px]" style={{ color: "var(--gf-text-muted)" }}>
            {filter === "unread" ? "No unread notifications" : "No notifications"}
          </div>
        ) : (
          visibleItems.map((n) => (
            // relative wrapper so the dismiss control is a sibling (not a nested
            // button) of the clickable row — valid HTML + group-hover reveal.
            <div
              key={n.id}
              className="relative group"
              style={{ borderBottom: "1px solid var(--gf-divider)" }}
            >
              <button
                onClick={() => onItemClick(n)}
                className="w-full text-left pl-3.5 pr-8 py-3 flex gap-2.5 transition-colors"
                style={{ background: n.isRead ? "transparent" : "var(--gf-accent-dim)" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--gf-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = n.isRead ? "transparent" : "var(--gf-accent-dim)")}
              >
                {/* severity dot */}
                <span
                  className="mt-1 flex-shrink-0 rounded-full"
                  style={{ width: 8, height: 8, background: SEVERITY_COLOR[n.severity] ?? "var(--gf-text-muted)" }}
                />
                <span className="flex-1 min-w-0">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-[14px] font-semibold truncate" style={{ color: "var(--gf-text-primary)" }}>
                      {n.title}
                    </span>
                    <span className="text-[12px] flex-shrink-0" style={{ color: "var(--gf-text-dim)" }}>
                      {relativeTime(n.sentAt || n.createdAt)}
                    </span>
                  </span>
                  <span className="block text-[13px] mt-0.5 truncate" style={{ color: "var(--gf-text-muted)" }}>
                    {n.message}
                  </span>
                  {n.deviceName && (
                    <span className="block text-[12px] mt-0.5 truncate" style={{ color: "var(--gf-text-dim)" }}>
                      {n.deviceName}
                    </span>
                  )}
                  {n.status && n.status !== "active" && (
                    <span
                      className="flex items-center gap-1 text-[12px] mt-1 font-medium"
                      style={{ color: n.status === "resolved" ? "#73BF69" : "var(--gf-accent)" }}
                    >
                      {n.status === "resolved" ? (
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                          <path d="M3 8.5l3.5 3.5L13 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : (
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", display: "inline-block" }} />
                      )}
                      {n.status === "resolved" ? "Resolved" : "Acknowledged"}
                      {n.acknowledgedByName ? ` by ${n.acknowledgedByName}` : ""}
                      {n.acknowledgedByName && n.acknowledgedByRole ? ` · ${roleLabel(n.acknowledgedByRole)}` : ""}
                    </span>
                  )}
                </span>
              </button>
              {/* dismiss (X) — reveals on row hover */}
              <button
                onClick={() => dismiss([n.id])}
                aria-label="Dismiss notification"
                title="Dismiss"
                className="absolute top-2 right-1.5 p-1 rounded opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                style={{ color: "var(--gf-text-dim)" }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--gf-text-primary)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--gf-text-dim)")}
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
