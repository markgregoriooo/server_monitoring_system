import type { AppNotification, Severity } from "../../types/notification";

// Grafana status palette (see CLAUDE.md → Status Colors). Shared by the bell
// panel and the toast host.
export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "#E02F44",
  warning: "#FF780A",
  info: "#5794F2",
};

// How a device is named in the bell, toast, critical modal and OS popup, so all four
// match. A server's display name and hostname are both shown; the backend only sends
// the hostname when it differs, so this never shows "web-01 (web-01)".
export function deviceLabel(n: Pick<AppNotification, "deviceName" | "deviceHostname">): string | null {
  if (!n.deviceName) return null;
  return n.deviceHostname ? `${n.deviceName} (${n.deviceHostname})` : n.deviceName;
}

// Which list page owns each kind of devices row. Every one of these pages reads
// ?device=<id> and opens that device's detail, so the deep-link shape is uniform.
const PAGE_FOR_DEVICE_TYPE: Record<string, string> = {
  server: "/server-metrics",
  router: "/network",
  mikrotik: "/mikrotik",
  ups: "/ups",
};

// Where clicking a notification goes. Decided by the device type, not the alert type:
// MikroTik and SNMP routers share `router_*` alerts, and routers, UPS and MikroTiks
// all raise `device_offline`. The alert type is the fallback when there is no device
// (ESP32 room alerts, older alerts).
export function routeFor(n: AppNotification): string {
  const page = n.deviceType ? PAGE_FOR_DEVICE_TYPE[n.deviceType] : undefined;
  if (page) return n.deviceId ? `${page}?device=${n.deviceId}` : page;

  switch (n.type) {
    case "cpu":
    case "mem":
    case "disk":
    case "offline":
      return n.deviceId ? `/server-metrics?device=${n.deviceId}` : "/server-metrics";
    case "environment": // legacy combined env alerts (pre-configurable-thresholds)
    case "temperature":
    case "gas":
    case "humidity":
    // Room-level, like the metrics above: the ESP32 has no device row, so there is no
    // server detail page to deep-link to — send it to the Environment page.
    case "esp32_offline":
      return "/environment";
  }

  // Fallback when device_type is missing: guess the page from the type prefix
  // (`link_util:ether3` has a port suffix, hence startsWith). A MikroTik lands on
  // /network here.
  if (n.type.startsWith("ups_")) return "/ups";
  if (n.type.startsWith("router_") || n.type.startsWith("link_")) return "/network";
  return "/";
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
