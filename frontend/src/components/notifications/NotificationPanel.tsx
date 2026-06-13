import { useNavigate } from "react-router-dom";
import { useNotifications } from "../../context/NotificationContext";
import type { AppNotification, Severity } from "../../context/NotificationContext";

// Grafana status palette (see CLAUDE.md → Status Colors).
const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "#E02F44",
  warning: "#FF780A",
  info: "#5794F2",
};

// Where clicking a notification takes you. All current triggers are server-side;
// extend this as UPS / router / environment triggers land.
function routeFor(n: AppNotification): string {
  switch (n.type) {
    case "cpu":
    case "mem":
    case "disk":
    case "offline":
      return "/server-metrics";
    default:
      return "/";
  }
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export default function NotificationPanel({ onClose }: { onClose: () => void }) {
  const { items, unreadCount, markRead, markAllRead } = useNotifications();
  const navigate = useNavigate();

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
