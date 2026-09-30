import { useState, useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { useAuth } from "../../context/AuthContext";
import { useNotifications } from "../../context/NotificationContext";
import { useTheme } from "../../context/ThemeContext";
import NotificationPanel from "../notifications/NotificationPanel";
import { usePip } from "../../pip/PipContext";
import { BRAND } from "../../branding";
import { pageNameFor } from "../../pageTitles";
import { avatarUrl } from "../../utils/format";

type HeaderProps = {
  title: string;
  onMenuToggle?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** Raise the My Profile modal. The modal itself is owned by the Sidebar, so this asks
   *  AppShell to signal it rather than rendering a second copy of the form. */
  onOpenProfile?: () => void;
};

// The page part of the breadcrumb comes from src/pageTitles.ts, shared with the
// browser tab title.

function LivePing() {
  return (
    // shrink-0: a two-element badge that is already only ~40px wide has nothing to give,
    // and squashing it turns the dot into an ellipse.
    <span className="flex items-center gap-1.5 shrink-0">
      <span className="relative flex h-1.5 w-1.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-60"
          style={{ background: "#73BF69" }} />
        <span className="relative inline-flex rounded-full h-1.5 w-1.5"
          style={{ background: "#73BF69" }} />
      </span>
      <span className="text-[11px] tracking-widest"
        style={{ color: "#73BF69", fontFamily: "monospace" }}>
        LIVE
      </span>
    </span>
  );
}

export default function Header({ onMenuToggle, collapsed, onToggleCollapse, onOpenProfile }: HeaderProps) {
  const { user }    = useAuth();
  const { unreadCount, openAlertCount, pendingAgentCount, pendingUserCount } = useNotifications();
  const { supported: pipSupported, isOpen: pipOpen, open: openPip, close: closePip } = usePip();
  const { theme, toggleTheme } = useTheme();
  const location    = useLocation();
  const section = BRAND.name;
  const page = pageNameFor(location.pathname) ?? "Dashboard";

  // Notification bell dropdown — close on outside-click or Escape.
  const [bellOpen, setBellOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!bellOpen) return;
    const onDown = (e: MouseEvent) => {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setBellOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setBellOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [bellOpen]);

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

  // Shown on the "open sidebar" buttons so a hidden sidebar still shows what its badges
  // would: open alerts plus pending approvals (servers and registrations, admin only).
  // Red when any alert is open, otherwise accent. it_staff only see alerts.
  const navAttention = openAlertCount + pendingAgentCount + pendingUserCount;
  const navBadge = navAttention > 0 ? (
    <span className="absolute -top-1 -right-1 min-w-[14px] h-3.5 px-0.5 rounded-full text-white flex items-center justify-center"
      style={{ background: openAlertCount > 0 ? "#F2495C" : "var(--gf-accent)", fontSize: 7, fontWeight: 700 }}
      title={`${navAttention} item(s) need attention`}>
      {navAttention > 99 ? "99+" : navAttention}
    </span>
  ) : null;

  return (
    /* `gap-4` keeps space between the two groups; justify-between alone leaves none once
       the bar is full. */
    <header className="h-10 flex items-center justify-between gap-4 px-4 flex-shrink-0"
      style={{
        background:   "var(--gf-header)",
        borderBottom: "1px solid var(--gf-panel-border)",
        fontFamily:   "'JetBrains Mono', monospace",
      }}>

      {/* LEFT — mobile menu + breadcrumb */}
      <div className="flex items-center gap-3 min-w-0">
        <button onClick={onMenuToggle}
          aria-label="Open menu"
          className="gf-icon-btn flex lg:hidden relative">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16"/>
          </svg>
          {navBadge}
        </button>

        {/* Desktop: show the sidebar again when it's collapsed */}
        {collapsed && (
          <button onClick={onToggleCollapse}
            aria-label="Show sidebar"
            title="Show sidebar (Ctrl/⌘ B)"
            className="gf-icon-btn hidden lg:flex relative">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            {navBadge}
          </button>
        )}

        {/* Grafana-style breadcrumb. `min-w-0` + truncate makes it the part that shrinks when
           space is tight, since the page name also appears in the sidebar and page heading. */}
        <div className="flex items-center gap-1.5 text-[13px] min-w-0">
          <span className="truncate" style={{ color: "var(--gf-text-muted)" }}>{section}</span>
          <span className="hidden sm:inline" style={{ color: "var(--gf-text-dim)" }}>/</span>
          <span className="font-semibold truncate hidden sm:inline" style={{ color: "var(--gf-text-primary)" }}>{page}</span>
        </div>

        <LivePing />
      </div>

      {/* RIGHT — time + notifications + avatar */}
      <div className="flex items-center gap-4">
        <span className="hidden sm:block text-[12px]"
          style={{ color: "var(--gf-text-dim)" }}>
          {now}
        </span>

        {/* Theme toggle, in the topbar with the other controls (moved from the sidebar on
           2026-08-28, where it was hidden when the rail was collapsed). Icon-only, same
           `gf-icon-btn` as its neighbours. The title names the theme you will switch to. */}
        <button
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
          className="gf-icon-btn inline-flex">
          {theme === "dark" ? (
            <svg width="15" height="15" viewBox="0 0 14 14" fill="none">
              <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" />
              <path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M3.2 3.2l1 1M9.8 9.8l1 1M10.8 3.2l-1 1M4.2 9.8l-1 1"
                stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 14 14" fill="none">
              <path d="M12.25 7.46A5.25 5.25 0 1 1 6.54 1.75 4.08 4.08 0 0 0 12.25 7.46z"
                stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>

        {/* Pop-out live widget (Picture-in-Picture), Chromium only. Same .gf-icon-btn as the
           bell; `is-open` marks it active like the bell's open panel. */}
        {pipSupported && (
          <button
            onClick={() => (pipOpen ? closePip() : openPip())}
            aria-label={pipOpen ? "Close live widget" : "Pop out live widget"}
            aria-pressed={pipOpen}
            title={pipOpen ? "Close live widget" : "Pop out live widget"}
            className={`gf-icon-btn inline-flex relative${pipOpen ? " is-open" : ""}`}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
              <rect x="8" y="8" width="5.5" height="4" rx="1" fill="currentColor" />
            </svg>
          </button>
        )}

        {/* Notification bell + dropdown */}
        <div className="relative" ref={bellRef}>
          <button
            onClick={() => setBellOpen(o => !o)}
            aria-label="Notifications"
            aria-expanded={bellOpen}
            className={`gf-icon-btn inline-flex relative${bellOpen ? " is-open" : ""}`}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path d="M8 2a5 5 0 00-5 5v3l-1 1.5h12L13 10V7a5 5 0 00-5-5z"
                stroke="currentColor" strokeWidth="1.3"/>
              <path d="M6.5 13.5a1.5 1.5 0 003 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[14px] h-3.5 px-0.5 rounded-full text-white flex items-center justify-center"
                style={{ background: "#F2495C", fontSize: 7, fontWeight: 700 }}>
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </button>
          {bellOpen && <NotificationPanel onClose={() => setBellOpen(false)} />}
        </div>

        {/* User avatar: opens the same My Profile modal as the sidebar's profile row (on a
           phone the sidebar is behind the menu button). */}
        {user && (
          <button
            onClick={onOpenProfile}
            aria-label="My profile"
            title={`${user.name} — My profile`}
            className="w-6 h-6 rounded overflow-hidden flex-shrink-0 transition-opacity hover:opacity-80 active:scale-95"
            style={{ border: "1px solid var(--gf-panel-border)" }}>
            {user.profile_image ? (
              <img src={avatarUrl(user.profile_image) ?? ""} alt={user.name}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-[11px] font-bold text-white"
                style={{ background: "var(--gf-accent)" }}>
                {user.avatar}
              </div>
            )}
          </button>
        )}
      </div>
    </header>
  );
}
