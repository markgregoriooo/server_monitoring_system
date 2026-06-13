import type { AppNotification, Severity } from "../../context/NotificationContext";

// Grafana status palette (see CLAUDE.md → Status Colors). Shared by the bell
// panel and the toast host.
export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "#E02F44",
  warning: "#FF780A",
  info: "#5794F2",
};

// Where clicking a notification takes you. All current triggers are server-side;
// extend this as UPS / router / environment triggers land.
export function routeFor(n: AppNotification): string {
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

export function relativeTime(iso: string): string {
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
