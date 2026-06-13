import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useNotifications } from "../../context/NotificationContext";
import type { AppNotification } from "../../context/NotificationContext";
import { SEVERITY_COLOR, routeFor } from "./notificationUtils";

const TOAST_MS = 6000;   // auto-dismiss after 6s
const MAX_VISIBLE = 4;   // cap the stack so a burst doesn't fill the screen

// Renders transient corner toasts for live notifications. Subscribes to the
// context's live stream (not the socket directly), so there's a single source of
// truth for incoming events.
export default function ToastHost() {
  const { subscribe, markRead } = useNotifications();
  const navigate = useNavigate();
  const [toasts, setToasts] = useState<AppNotification[]>([]);
  const timersRef = useRef<number[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const unsub = subscribe((n) => {
      setToasts((prev) => [...prev.slice(-(MAX_VISIBLE - 1)), n]);
      const tid = window.setTimeout(() => dismiss(n.id), TOAST_MS);
      timersRef.current.push(tid);
    });
    return () => {
      unsub();
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    };
  }, [subscribe, dismiss]);

  const onClick = (n: AppNotification) => {
    if (!n.isRead) markRead([n.id]);
    navigate(routeFor(n));
    dismiss(n.id);
  };

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 w-72"
      style={{ fontFamily: "'JetBrains Mono', monospace" }}
      aria-live="polite"
    >
      {toasts.map((n) => (
        <div
          key={n.id}
          className="flex items-start gap-2 px-3 py-2.5 cursor-pointer animate-[fadeIn_0.15s_ease-out]"
          style={{
            background: "var(--gf-panel)",
            border: "1px solid var(--gf-panel-border)",
            borderLeft: `3px solid ${SEVERITY_COLOR[n.severity] ?? "var(--gf-text-muted)"}`,
            borderRadius: 6,
            boxShadow: "var(--gf-shadow)",
          }}
          onClick={() => onClick(n)}
          role="alert"
        >
          <span className="flex-1 min-w-0">
            <span className="block text-[11px] font-semibold truncate" style={{ color: "var(--gf-text-primary)" }}>
              {n.title}
            </span>
            <span className="block text-[10px] mt-0.5" style={{ color: "var(--gf-text-muted)" }}>
              {n.message}
            </span>
            {n.deviceName && (
              <span className="block text-[9px] mt-0.5 truncate" style={{ color: "var(--gf-text-dim)" }}>
                {n.deviceName}
              </span>
            )}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); dismiss(n.id); }}
            aria-label="Dismiss"
            className="flex-shrink-0 transition-colors leading-none"
            style={{ color: "var(--gf-text-dim)" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "var(--gf-text-primary)")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "var(--gf-text-dim)")}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
