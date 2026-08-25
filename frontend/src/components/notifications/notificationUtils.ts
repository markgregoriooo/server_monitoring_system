import type { AppNotification, Severity } from "../../types/notification";

// Grafana status palette (see CLAUDE.md → Status Colors). Shared by the bell
// panel and the toast host.
export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "#E02F44",
  warning: "#FF780A",
  info: "#5794F2",
};

// Which list page owns each kind of devices row. Every one of these pages reads
// ?device=<id> and opens that device's detail, so the deep-link shape is uniform.
const PAGE_FOR_DEVICE_TYPE: Record<string, string> = {
  server: "/server-metrics",
  router: "/network",
  mikrotik: "/mikrotik",
  ups: "/ups",
};

// Where clicking a notification takes you.
//
// DEVICE TYPE decides it, not the alert type. `deviceAlerts.checkRouter` is shared by
// the SNMP and MikroTik pollers, so a MikroTik CPU alert and an SNMP router's are both
// `router_cpu`; and routers, UPS and MikroTiks all raise the same `device_offline`.
// Routing on `n.type` alone would therefore send half of these to the wrong page —
// hence `deviceType`, added to the notification payload for exactly this.
//
// The alert type is still the fallback, for triggers with no devices row to key off:
// the ESP32's room-level environment alerts, and anything raised before deviceType
// was carried.
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

  // Last resort when device_type is missing: infer the page from the type prefix.
  // `link_util:ether3` and friends carry a per-interface suffix, hence startsWith.
  // A MikroTik can't be told from an SNMP router here — it lands on /network, which
  // is a degradation rather than a dead end.
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
