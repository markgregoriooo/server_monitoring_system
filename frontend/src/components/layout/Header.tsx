import { useState, useEffect } from "react";
import { useLocation } from "react-router";
import { useAuth } from "../../context/AuthContext";
import { BRAND } from "../../branding";
import { avatarUrl } from "../../utils/format";

type HeaderProps = {
  title: string;
  alertCount?: number;
  onMenuToggle?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
};

// Breadcrumb map: pathname → [section, page]
const breadcrumbs: Record<string, [string, string]> = {
  "/":                [BRAND.name, "Dashboard"],
  "/server-metrics":  [BRAND.name, "Server Metrics"],
  "/environment":     [BRAND.name, "Environment Monitoring"],
  "/air-conditioner": [BRAND.name, "Air Conditioner"],
  "/history":         [BRAND.name, "History Logs"],
  "/reports":         [BRAND.name, "Reports"],
  "/settings":        [BRAND.name, "Settings"],
  "/user-management": [BRAND.name, "User Management"],
};

function LivePing() {
  return (
    <span className="flex items-center gap-1.5">
      <span className="relative flex h-1.5 w-1.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60"
          style={{ background: "#73BF69" }} />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5"
          style={{ background: "#73BF69" }} />
      </span>
      <span className="text-[9px] tracking-widest"
        style={{ color: "#73BF69", fontFamily: "monospace" }}>
        LIVE
      </span>
    </span>
  );
}

export default function Header({ alertCount = 0, onMenuToggle, collapsed, onToggleCollapse }: HeaderProps) {
  const { user }    = useAuth();
  const location    = useLocation();
  const [section, page] = breadcrumbs[location.pathname] ?? [BRAND.name, "Dashboard"];

  // Live clock, pinned to Philippine time regardless of the viewer's machine zone.
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const now = clock.toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });

  return (
    <header className="h-10 flex items-center justify-between px-4 flex-shrink-0"
      style={{
        background:   "var(--gf-header)",
        borderBottom: "1px solid var(--gf-panel-border)",
        fontFamily:   "'JetBrains Mono', monospace",
      }}>

      {/* LEFT — mobile menu + breadcrumb */}
      <div className="flex items-center gap-3">
        <button onClick={onMenuToggle}
          className="lg:hidden p-1 rounded transition-colors"
          style={{ color: "var(--gf-text-muted)" }}
          onMouseEnter={e => (e.currentTarget.style.color = "var(--gf-text-primary)")}
          onMouseLeave={e => (e.currentTarget.style.color = "var(--gf-text-muted)")}>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16"/>
          </svg>
        </button>

        {/* Desktop: show the sidebar again when it's collapsed */}
        {collapsed && (
          <button onClick={onToggleCollapse}
            aria-label="Show sidebar"
            title="Show sidebar (Ctrl/⌘ B)"
            className="hidden lg:flex items-center justify-center p-1 rounded transition-colors"
            style={{ color: "var(--gf-text-muted)" }}
            onMouseEnter={e => (e.currentTarget.style.color = "var(--gf-text-primary)")}
            onMouseLeave={e => (e.currentTarget.style.color = "var(--gf-text-muted)")}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        )}

        {/* Grafana-style breadcrumb */}
        <div className="flex items-center gap-1.5 text-[11px]">
          <span style={{ color: "var(--gf-text-muted)" }}>{section}</span>
          <span style={{ color: "var(--gf-text-dim)" }}>/</span>
          <span className="font-semibold" style={{ color: "var(--gf-text-primary)" }}>{page}</span>
        </div>

        <LivePing />
      </div>

      {/* RIGHT — time + notifications + avatar */}
      <div className="flex items-center gap-4">
        <span className="hidden sm:block text-[10px]"
          style={{ color: "var(--gf-text-dim)" }}>
          {now}
        </span>

        {/* Notification bell */}
        <button className="relative transition-colors"
          style={{ color: "var(--gf-text-muted)" }}
          onMouseEnter={e => (e.currentTarget.style.color = "var(--gf-text-primary)")}
          onMouseLeave={e => (e.currentTarget.style.color = "var(--gf-text-muted)")}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M8 2a5 5 0 00-5 5v3l-1 1.5h12L13 10V7a5 5 0 00-5-5z"
              stroke="currentColor" strokeWidth="1.3"/>
            <path d="M6.5 13.5a1.5 1.5 0 003 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
          {alertCount > 0 && (
            <span className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full text-white flex items-center justify-center"
              style={{ background: "#F2495C", fontSize: 7, fontWeight: 700 }}>
              {alertCount}
            </span>
          )}
        </button>

        {/* User avatar — clicking handled in Sidebar ProfileModal */}
        {user && (
          <div className="w-6 h-6 rounded overflow-hidden flex-shrink-0"
            style={{ border: "1px solid var(--gf-panel-border)" }}>
            {user.profile_image ? (
              <img src={avatarUrl(user.profile_image) ?? ""} alt={user.name}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-[9px] font-bold text-white"
                style={{ background: "var(--gf-accent)" }}>
                {user.avatar}
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
