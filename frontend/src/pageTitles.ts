import { BRAND } from "./branding";

// ─── Page names for the breadcrumb and the browser tab ─────────────
// One list so the two always agree. Keys are exact paths, since every route in
// App.tsx is flat (detail views render inside their list page).
export const PAGE_NAMES: Record<string, string> = {
  "/":                "Dashboard",
  "/server-metrics":  "Server Metrics",
  "/network":         "Network Monitoring",
  "/mikrotik":        "MikroTik",
  "/ups":             "UPS Monitoring",
  "/environment":     "Environment Monitoring",
  "/air-conditioner": "Air Conditioner",
  "/analytics":       "Analytics",
  "/history":         "History Logs",
  "/reports":         "Reports",
  "/settings":        "Settings",
  "/user-management": "User Management",
  "/alerts":          "Alerts",
  "/alert-rules":     "Alert Rules",
  "/login":           "Sign in",
  "/privacy":         "Privacy Notice & Terms",
};

/** The page's own name, or null for a path with no entry (a redirect, a 404). */
export function pageNameFor(pathname: string): string | null {
  return PAGE_NAMES[pathname] ?? null;
}

/**
 * The system's full name in the browser tab. Must match the <title> in
 * frontend/index.html (shown before React mounts); index.html cannot import this file.
 */
export const SYSTEM_TITLE = `${BRAND.name} Server Infrastructure Monitoring`;

/**
 * The tab title: "Dashboard · CSPC-ICTU Server Infrastructure Monitoring". Page name
 * first, since tabs cut off from the right. An unknown path shows only the system name.
 */
export function documentTitleFor(pathname: string): string {
  const page = pageNameFor(pathname);
  return page ? `${page} · ${SYSTEM_TITLE}` : SYSTEM_TITLE;
}
