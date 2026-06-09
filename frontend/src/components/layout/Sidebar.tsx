import { useState } from "react";
import { NavLink } from "react-router";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";
import { roleConfig } from "../../data/users";
import { BRAND } from "../../branding";
import { API_URL } from "../../config";
import ProfileModal from "./ProfileModal";

type RoleKey = keyof typeof roleConfig;

interface NavItem { id: string; label: string; path: string; icon: React.ReactNode; }
interface SidebarProps {
  mobileOpen: boolean;
  onClose: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

// ─── Nav icons (inline SVG, 14×14) ───────────────────────────────────────────

const Icons: Record<string, React.ReactNode> = {
  dashboard: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.4"/>
      <rect x="9" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.4"/>
      <rect x="1" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.4"/>
      <rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.4"/>
    </svg>
  ),
  "server-metrics": (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="2" width="14" height="4" rx="1" stroke="currentColor" strokeWidth="1.4"/>
      <rect x="1" y="10" width="14" height="4" rx="1" stroke="currentColor" strokeWidth="1.4"/>
      <circle cx="12" cy="4" r="1" fill="currentColor"/>
      <circle cx="12" cy="12" r="1" fill="currentColor"/>
    </svg>
  ),
  environment: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 2v7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      <circle cx="8" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M5 5H3M11 5h2M5 8H3M11 8h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  ),
  "air-conditioner": (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="4" width="14" height="5" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M4 9v3M8 9v3M12 9v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      <circle cx="12" cy="6.5" r="1" fill="currentColor"/>
    </svg>
  ),
  history: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M8 5v3l2 2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  ),
  reports: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="3" y="1" width="10" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M6 5h4M6 8h4M6 11h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  ),
  settings: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.1 3.1l1.4 1.4M11.5 11.5l1.4 1.4M12.9 3.1l-1.4 1.4M4.5 11.5l-1.4 1.4"
        stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  ),
  "user-management": (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <circle cx="6" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M1 14c0-2.8 2.2-5 5-5s5 2.2 5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      <path d="M11 7c1.1 0 2 .9 2 2M13 13c0-1.1-.9-2-2-2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  ),
};

const allNavItems: NavItem[] = [
  { id: "dashboard",        label: "Dashboard",        path: "/",                icon: Icons["dashboard"] },
  { id: "server-metrics",   label: "Server Metrics",   path: "/server-metrics",  icon: Icons["server-metrics"] },
  { id: "environment",      label: "Environment",      path: "/environment",     icon: Icons["environment"] },
  { id: "air-conditioner",  label: "Air Conditioner",  path: "/air-conditioner", icon: Icons["air-conditioner"] },
  { id: "history",          label: "History",          path: "/history",         icon: Icons["history"] },
  { id: "reports",          label: "Reports",          path: "/reports",         icon: Icons["reports"] },
  { id: "settings",         label: "Settings",         path: "/settings",        icon: Icons["settings"] },
  { id: "user-management",  label: "User Management",  path: "/user-management", icon: Icons["user-management"] },
];

export default function Sidebar({ mobileOpen, onClose, collapsed, onToggleCollapse }: SidebarProps) {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [profileOpen, setProfileOpen] = useState(false);

  const allowed   = user ? roleConfig[user.role as RoleKey]?.pages || [] : [];
  const navItems  = allNavItems.filter(item => allowed.includes(item.id));
  const roleCfg   = user ? roleConfig[user.role as RoleKey] : null;

  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 bg-black/70 z-20 lg:hidden" onClick={onClose} />
      )}

      <aside
        className={`
          fixed lg:static inset-y-0 left-0 z-30
          w-52 ${collapsed ? "lg:w-0" : "lg:w-52"}
          flex flex-col h-full flex-shrink-0 overflow-hidden
          transition-[transform,width] duration-300 ease-in-out
          ${mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
        `}
        style={{
          background:  "var(--gf-sidebar)",
          borderRight: collapsed ? "none" : "1px solid var(--gf-panel-border)",
          fontFamily:  "'JetBrains Mono', monospace",
        }}
      >
        {/* ── Brand ── */}
        <div className="flex items-center gap-3 px-4 py-3.5"
          style={{ borderBottom: "1px solid var(--gf-panel-border)" }}>
          {BRAND.logoSrc ? (
            <img src={BRAND.logoSrc} alt={BRAND.name}
              className="w-7 h-7 rounded object-contain flex-shrink-0" />
          ) : (
            <div className="w-7 h-7 rounded flex items-center justify-center flex-shrink-0 text-[9px] font-black tracking-tight"
              style={{ background: "#F59E0B", color: "#111217" }}>
              {BRAND.logoText}
            </div>
          )}
          <div className="min-w-0" title={BRAND.fullName}>
            <div className="text-[11px] font-bold tracking-wide"
              style={{ color: "var(--gf-text-primary)" }}>
              {BRAND.name}
            </div>
            <div className="text-[8px] tracking-widest"
              style={{ color: "var(--gf-text-dim)" }}>
              {BRAND.subtitle}
            </div>
          </div>

          {/* Collapse sidebar (desktop only — mobile uses the header menu) */}
          <button
            onClick={onToggleCollapse}
            aria-label="Hide sidebar"
            title="Hide sidebar (Ctrl/⌘ B)"
            className="hidden lg:flex ml-auto flex-shrink-0 items-center justify-center w-6 h-6 rounded transition-colors"
            style={{ color: "var(--gf-text-muted)" }}
            onMouseEnter={e => { e.currentTarget.style.color = "var(--gf-text-primary)"; e.currentTarget.style.background = "var(--gf-hover)"; }}
            onMouseLeave={e => { e.currentTarget.style.color = "var(--gf-text-muted)"; e.currentTarget.style.background = "transparent"; }}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* ── Navigation ── */}
        <nav className="flex-1 py-1.5 overflow-y-auto">
          <div className="px-3 pt-2 pb-1">
            <span className="text-[8px] tracking-widest uppercase"
              style={{ color: "var(--gf-text-dim)" }}>
              Navigation
            </span>
          </div>

          {navItems.map(item => (
            <NavLink
              key={item.id}
              to={item.path}
              end={item.path === "/"}
              onClick={onClose}
              className="flex items-center gap-2.5 px-3 py-2 text-[11px] transition-colors"
              style={({ isActive }) => ({
                borderLeft:  isActive ? "2px solid var(--gf-accent)"  : "2px solid transparent",
                background:  isActive ? "var(--gf-accent-dim)"        : "transparent",
                color:       isActive ? "var(--gf-text-primary)"      : "var(--gf-text-muted)",
              })}
              onMouseEnter={e => {
                const el = e.currentTarget;
                if (!el.style.background.includes("var(--gf-accent")) {
                  el.style.background = "var(--gf-hover)";
                  el.style.color      = "var(--gf-text-primary)";
                }
              }}
              onMouseLeave={e => {
                const el = e.currentTarget;
                if (!el.style.background.includes("var(--gf-accent")) {
                  el.style.background = "transparent";
                  el.style.color      = "var(--gf-text-muted)";
                }
              }}
            >
              <span style={{ opacity: 0.75 }}>{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* ── Bottom: theme + user ── */}
        <div style={{ borderTop: "1px solid var(--gf-panel-border)" }}>
          {/* Theme toggle */}
          <div className="flex items-center justify-between px-4 py-2.5"
            style={{ borderBottom: "1px solid var(--gf-panel-border)" }}>
            <span className="text-[9px] tracking-widest uppercase"
              style={{ color: "var(--gf-text-dim)" }}>
              Theme
            </span>
            <button onClick={toggleTheme}
              className="flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] transition-colors"
              style={{ color: "var(--gf-text-muted)", background: "var(--gf-hover)" }}
              onMouseEnter={e => (e.currentTarget.style.color = "var(--gf-text-primary)")}
              onMouseLeave={e => (e.currentTarget.style.color = "var(--gf-text-muted)")}>
              {theme === "dark" ? (
                <>
                  <svg width="10" height="10" viewBox="0 0 14 14" fill="none">
                    <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4"/>
                    <path d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M3.2 3.2l1 1M9.8 9.8l1 1M10.8 3.2l-1 1M4.2 9.8l-1 1"
                      stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                  </svg>
                  Light
                </>
              ) : (
                <>
                  <svg width="10" height="10" viewBox="0 0 14 14" fill="none">
                    <path d="M12.25 7.46A5.25 5.25 0 1 1 6.54 1.75 4.08 4.08 0 0 0 12.25 7.46z"
                      stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  Dark
                </>
              )}
            </button>
          </div>

          {/* User */}
          {user && (
            <div className="px-3 py-3 flex flex-col gap-2">
              <button onClick={() => setProfileOpen(true)}
                className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-left transition-colors"
                style={{ background: "var(--gf-hover)" }}
                onMouseEnter={e => (e.currentTarget.style.background = "var(--gf-hover-strong)")}
                onMouseLeave={e => (e.currentTarget.style.background = "var(--gf-hover)")}>
                <div className="w-6 h-6 rounded flex-shrink-0 overflow-hidden">
                  {user.profile_image ? (
                    <img src={`${API_URL}${user.profile_image}`} alt={user.name}
                      className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[9px] font-bold text-white"
                      style={{ background: "var(--gf-accent)" }}>
                      {user.avatar}
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-semibold truncate"
                    style={{ color: "var(--gf-text-primary)" }}>
                    {user.name}
                  </div>
                  {roleCfg && (
                    <div className="text-[8px] tracking-widest truncate"
                      style={{ color: "var(--gf-accent)" }}>
                      {roleCfg.label}
                    </div>
                  )}
                </div>
              </button>

              <button onClick={logout}
                className="w-full py-1.5 rounded text-[10px] tracking-wider transition-colors"
                style={{ color: "var(--gf-text-muted)", border: "1px solid var(--gf-panel-border)" }}
                onMouseEnter={e => {
                  e.currentTarget.style.color      = "var(--gf-text-primary)";
                  e.currentTarget.style.background = "var(--gf-hover)";
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.color      = "var(--gf-text-muted)";
                  e.currentTarget.style.background = "transparent";
                }}>
                Sign Out
              </button>
            </div>
          )}
        </div>
      </aside>

      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
    </>
  );
}
