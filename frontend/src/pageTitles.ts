import { BRAND } from "./branding";

// ─── One list of page names, for the breadcrumb AND the browser tab ─────────────
//
// Header.tsx owned this map privately, which is why two pages had quietly fallen out
// of step with the router: `/mikrotik` and `/analytics` were added to App.tsx and never
// added here, so the breadcrumb on both read "Dashboard". A second copy in a title hook
// would have inherited the same drift, so there is one copy and both read it.
//
// Keys are exact pathnames because every route in App.tsx is flat — the detail views
// (ServerDetail, MikrotikDetail, …) are rendered inside their list page rather than at a
// route of their own, so there is no `/server-metrics/:id` to pattern-match.
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
 * The system's full name, as it reads in the browser tab.
 *
 * ⚠️ TWIN of the <title> in frontend/index.html, which is what the tab shows for the
 * instant before React mounts. Change one and change the other, or the tab renames itself
 * on load. That file cannot import this one (Vite only substitutes %VITE_*% env vars into
 * the HTML), so the duplication is structural — hence the warning rather than a fix.
 */
export const SYSTEM_TITLE = `${BRAND.name} Server Infrastructure Monitoring`;

/**
 * What the browser tab should read: "Dashboard · CSPC-ICTU Server Infrastructure Monitoring".
 *
 * Page first, system second. A tab strip truncates from the RIGHT, so the half that
 * tells you which tab this is has to come first — lead with the system name and a row
 * of open tabs all read "CSPC-ICTU Server Infra…" and are indistinguishable, which is
 * the exact problem showing the page name was meant to solve.
 *
 * An unmapped path falls back to the system name alone rather than to "Dashboard",
 * since naming the wrong page is worse than naming none.
 */
export function documentTitleFor(pathname: string): string {
  const page = pageNameFor(pathname);
  return page ? `${page} · ${SYSTEM_TITLE}` : SYSTEM_TITLE;
}
