import { useState, useEffect, useMemo } from "react";
import { NavLink, useLocation } from "react-router";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";
import { useNotifications } from "../../context/NotificationContext";
import { roleConfig } from "../../data/users";
import { BRAND } from "../../branding";
import { avatarUrl } from "../../utils/format";
import ProfileModal from "./ProfileModal";

type RoleKey = keyof typeof roleConfig;

interface NavItem { id: string; label: string; path: string; icon: React.ReactNode; }
interface NavGroup { id: string; label: string; items: NavItem[]; }
interface BadgeSpec { count: number; color: string; title: string; }
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
  network: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="2" width="14" height="4" rx="1" stroke="currentColor" strokeWidth="1.4"/>
      <rect x="1" y="10" width="14" height="4" rx="1" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M8 6v4" stroke="currentColor" strokeWidth="1.4"/>
      <circle cx="3.5" cy="4" r="0.8" fill="currentColor"/>
      <circle cx="3.5" cy="12" r="0.8" fill="currentColor"/>
    </svg>
  ),
  mikrotik: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="8.5" width="13" height="5.5" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M4 11.2h.01M11.5 11.2h.01" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M5.2 5.6a4 4 0 0 1 5.6 0M6.8 7.1a1.7 1.7 0 0 1 2.4 0" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  ),
  ups: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <rect x="1.5" y="3" width="13" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4"/>
      <path d="M9 5.5L6.5 8.5H8.5L7 10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
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
  "alert-rules": (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 1.5a3.5 3.5 0 0 0-3.5 3.5c0 3-1.5 4-1.5 4h10s-1.5-1-1.5-4A3.5 3.5 0 0 0 8 1.5z"
        stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
      <path d="M6.5 13a1.5 1.5 0 0 0 3 0" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
    </svg>
  ),
  alerts: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M8 2.5l6 11H2l6-11z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
      <path d="M8 7v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      <circle cx="8" cy="11.6" r="0.5" fill="currentColor" stroke="currentColor" strokeWidth="0.6"/>
    </svg>
  ),
  analytics: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
      <path d="M1.5 14.5V2M14.5 14.5H2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
      <path d="M4 11l3-3 2.5 2L14 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M11 5h3v3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ),
};

// ─── Nav structure ────────────────────────────────────────────────────────────
// Thirteen flat entries was too long a list to scan. Dashboard and Settings stay
// pinned (top / bottom); everything else lives in a collapsible group.
//
// Groups collapse by DEFAULT — the whole point is a short sidebar — but the group
// owning the current route auto-expands, and open/closed state persists, so the
// sections you actually use stay open across sessions.

const NAV_DASHBOARD: NavItem =
  { id: "dashboard", label: "Dashboard", path: "/", icon: Icons["dashboard"] };

const NAV_SETTINGS: NavItem =
  { id: "settings", label: "Settings", path: "/settings", icon: Icons["settings"] };

const NAV_GROUPS: NavGroup[] = [
  {
    id: "infrastructure",
    label: "Infrastructure",
    items: [
      { id: "server-metrics", label: "Server Metrics", path: "/server-metrics", icon: Icons["server-metrics"] },
      { id: "network",        label: "Network",        path: "/network",        icon: Icons["network"] },
      { id: "mikrotik",       label: "MikroTik",       path: "/mikrotik",       icon: Icons["mikrotik"] },
      { id: "ups",            label: "UPS",            path: "/ups",            icon: Icons["ups"] },
    ],
  },
  {
    id: "server-room",
    label: "Server Room",
    items: [
      { id: "environment",     label: "Environment",     path: "/environment",     icon: Icons["environment"] },
      { id: "air-conditioner", label: "Air Conditioner", path: "/air-conditioner", icon: Icons["air-conditioner"] },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    items: [
      { id: "alerts",    label: "Alerts",    path: "/alerts",    icon: Icons["alerts"] },
      { id: "analytics", label: "Analytics", path: "/analytics", icon: Icons["analytics"] },
      { id: "history",   label: "History",   path: "/history",   icon: Icons["history"] },
      { id: "reports",   label: "Reports",   path: "/reports",   icon: Icons["reports"] },
    ],
  },
  {
    // Admin-only pages. it_staff has neither, so the whole group disappears for them
    // rather than rendering an empty header.
    id: "administration",
    label: "Administration",
    items: [
      { id: "user-management", label: "User Management", path: "/user-management", icon: Icons["user-management"] },
      { id: "alert-rules",     label: "Alert Rules",     path: "/alert-rules",     icon: Icons["alert-rules"] },
    ],
  },
];

const NAV_GROUPS_KEY = "cspc_nav_groups";

function readOpenGroups(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(NAV_GROUPS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export default function Sidebar({ mobileOpen, onClose, collapsed, onToggleCollapse }: SidebarProps) {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { openAlertCount, pendingAgentCount, pendingUserCount } = useNotifications();
  const [profileOpen, setProfileOpen] = useState(false);
  // Success toast shown AFTER the profile modal closes (same style as UserManagement).
  const [profileToast, setProfileToast] = useState("");
  const showProfileToast = (msg: string) => {
    setProfileToast(msg);
    setTimeout(() => setProfileToast(""), 3000);
  };

  const location = useLocation();
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(readOpenGroups);

  const allowed = user ? roleConfig[user.role as RoleKey]?.pages || [] : [];
  const roleCfg = user ? roleConfig[user.role as RoleKey] : null;

  // Role-filter every group, then drop any that ended up empty.
  const groups = useMemo(
    () =>
      NAV_GROUPS
        .map(g => ({ ...g, items: g.items.filter(i => allowed.includes(i.id)) }))
        .filter(g => g.items.length > 0),
    [allowed.join(",")],
  );

  const isActivePath = (p: string) =>
    p === "/" ? location.pathname === "/" : location.pathname.startsWith(p);

  // The group owning the current route — used to auto-expand it.
  const activeGroupId = useMemo(
    () => groups.find(g => g.items.some(i => isActivePath(i.path)))?.id ?? null,
    [groups, location.pathname],
  );

  // Open the active group, but never auto-CLOSE the others: collapsing a section the
  // user just opened because they navigated elsewhere is the annoying part of
  // accordion sidebars. Sections they use simply accumulate as open.
  useEffect(() => {
    if (!activeGroupId) return;
    setOpenGroups(prev => (prev[activeGroupId] ? prev : { ...prev, [activeGroupId]: true }));
  }, [activeGroupId]);

  useEffect(() => {
    try {
      localStorage.setItem(NAV_GROUPS_KEY, JSON.stringify(openGroups));
    } catch {
      /* private mode / quota — the sidebar still works, it just won't remember */
    }
  }, [openGroups]);

  const toggleGroup = (id: string) =>
    setOpenGroups(prev => ({ ...prev, [id]: !prev[id] }));

  // Per-item badge. Kept in one place so the group header can reuse it.
  const badgeFor = (id: string): BadgeSpec | null => {
    if (id === "alerts" && openAlertCount > 0)
      return { count: openAlertCount, color: "#F2495C", title: `${openAlertCount} alert(s) need attention` };
    if (id === "server-metrics" && pendingAgentCount > 0)
      return { count: pendingAgentCount, color: "var(--gf-accent)", title: `${pendingAgentCount} server(s) awaiting approval` };
    if (id === "user-management" && pendingUserCount > 0)
      return { count: pendingUserCount, color: "var(--gf-accent)", title: `${pendingUserCount} new registration(s)` };
    return null;
  };

  // Roll a group's child badges up onto its header. Without this, collapsing a group
  // would HIDE an open-alert count — the one thing the sidebar must never hide.
  // Red wins over accent so a real alert is never disguised as a pending approval.
  const groupBadge = (items: NavItem[]): BadgeSpec | null => {
    const badges = items.map(i => badgeFor(i.id)).filter((b): b is BadgeSpec => b !== null);
    if (badges.length === 0) return null;
    return {
      count: badges.reduce((sum, b) => sum + b.count, 0),
      color: badges.some(b => b.color === "#F2495C") ? "#F2495C" : "var(--gf-accent)",
      title: badges.map(b => b.title).join(" · "),
    };
  };

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
          ${collapsed ? "" : "gf-rail"}
          transition-[transform,width] duration-300 ease-in-out
          ${mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
        `}
        style={{
          background:  "var(--gf-sidebar)",
          // .gf-rail supplies the seam edge + drop shadow, so the rail reads as its
          // own plane. Dropped while collapsed — a 0-width rail casting a shadow is
          // just a dark stripe down the page.
          ...(collapsed ? { borderRight: "none" } : {}),
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
            <div className="w-7 h-7 rounded flex items-center justify-center flex-shrink-0 text-[11px] font-black tracking-tight"
              style={{ background: "#F59E0B", color: "#111217" }}>
              {BRAND.logoText}
            </div>
          )}
          <div className="min-w-0" title={BRAND.fullName}>
            <div className="text-[13px] font-bold tracking-wide"
              style={{ color: "var(--gf-text-primary)" }}>
              {BRAND.name}
            </div>
            <div className="text-[10px] tracking-widest"
              style={{ color: "var(--gf-text-dim)" }}>
              {BRAND.subtitle}
            </div>
          </div>

          {/* Collapse sidebar (desktop only — mobile uses the header menu) */}
          <button
            onClick={onToggleCollapse}
            aria-label="Hide sidebar"
            title="Hide sidebar (Ctrl/⌘ B)"
            className="gf-icon-btn hidden lg:flex ml-auto flex-shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M10 4L6 8l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* ── Navigation ── */}
        <nav className="flex-1 py-1.5 overflow-y-auto">
          <div className="px-3 pt-2 pb-1">
            <span className="text-[10px] tracking-widest uppercase"
              style={{ color: "var(--gf-text-dim)" }}>
              Navigation
            </span>
          </div>

          {allowed.includes(NAV_DASHBOARD.id) && (
            <NavRow item={NAV_DASHBOARD} badge={badgeFor(NAV_DASHBOARD.id)} onClose={onClose} />
          )}

          {groups.map(group => {
            const isOpen = !!openGroups[group.id];
            const rolled = groupBadge(group.items);
            return (
              <div key={group.id}>
                {/* Hover is CSS now (.gf-nav-group), replacing the mouse handlers that
                    had to re-derive `isOpen` on every mouse-out to restore the colour. */}
                <button
                  type="button"
                  onClick={() => toggleGroup(group.id)}
                  aria-expanded={isOpen}
                  className="gf-nav-group w-full flex items-center gap-2 px-2 py-2 text-[13px]"
                  style={{
                    marginLeft: 6,
                    marginRight: 6,
                    width: "calc(100% - 12px)",
                    color: isOpen ? "var(--gf-text-primary)" : "var(--gf-text-muted)",
                    fontWeight: isOpen ? 600 : 500,
                  }}
                >
                  <svg
                    width="10" height="10" viewBox="0 0 16 16" fill="none"
                    style={{
                      flexShrink: 0,
                      opacity: 0.75,
                      transform: isOpen ? "rotate(90deg)" : "none",
                      transition: "transform 150ms ease",
                    }}
                  >
                    <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6"
                      strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <span className="tracking-wide">{group.label}</span>

                  {/* Only when collapsed — an open group shows the counts on the rows themselves */}
                  {!isOpen && rolled && (
                    <NavBadge count={rolled.count} color={rolled.color} title={rolled.title} />
                  )}
                  {/* Closed group holding the current page: a dot marks where you are */}
                  {!isOpen && !rolled && activeGroupId === group.id && (
                    <span
                      className="ml-auto w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ background: "var(--gf-accent)" }}
                      title="Contains the current page"
                    />
                  )}
                </button>

                {isOpen &&
                  group.items.map(item => (
                    <NavRow key={item.id} item={item} badge={badgeFor(item.id)} onClose={onClose} indented />
                  ))}
              </div>
            );
          })}

          {allowed.includes(NAV_SETTINGS.id) && (
            <NavRow item={NAV_SETTINGS} badge={badgeFor(NAV_SETTINGS.id)} onClose={onClose} />
          )}
        </nav>

        {/* ── Bottom: theme + user ── */}
        <div style={{ borderTop: "1px solid var(--gf-panel-border)" }}>
          {/* Theme toggle */}
          <div className="flex items-center justify-between px-4 py-2.5"
            style={{ borderBottom: "1px solid var(--gf-panel-border)" }}>
            <span className="text-[11px] tracking-widest uppercase"
              style={{ color: "var(--gf-text-dim)" }}>
              Theme
            </span>
            {/* Raised like every other pressable control. It was a flat tint with JS
                hover — the one button in the rail that gave no sign it could be pressed,
                sitting directly under nav rows that now lift. Hover/press come from
                .gf-btn, so it also gains the pressed state inline styles cannot express.
                The label already names the theme you'll GET, not the one you're in. */}
            <button onClick={toggleTheme}
              title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              className="gf-btn flex items-center gap-1.5 px-2.5 py-1 text-[12px]"
              style={{ color: "var(--gf-text-primary)", borderRadius: 3, fontWeight: 600 }}>
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
              {/* Raised like every other pressable surface — a flat tinted rectangle
                  gave no hint the profile row could be clicked at all. */}
              <button onClick={() => setProfileOpen(true)}
                className="gf-btn flex items-center gap-2 w-full px-2 py-1.5 text-left"
                style={{ borderRadius: 3 }}>
                <div className="w-6 h-6 rounded flex-shrink-0 overflow-hidden">
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
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-semibold truncate"
                    style={{ color: "var(--gf-text-primary)" }}>
                    {user.name}
                  </div>
                  {roleCfg && (
                    <div className="text-[10px] tracking-widest truncate"
                      style={{ color: "var(--gf-accent)" }}>
                      {roleCfg.label}
                    </div>
                  )}
                </div>
              </button>

              {/* RECESSED, not raised — signing out is the way out, not the thing you
                  came here to do. Same rule as Cancel elsewhere, and it keeps the theme
                  button above it as the only lifted control in this block.
                  Hover stays in JS here because the inline colour would otherwise beat a
                  CSS :hover rule on specificity. */}
              <button onClick={logout}
                className="w-full py-1.5 rounded-[3px] text-[12px] tracking-wider transition-all active:scale-[0.98]"
                style={{
                  color: "var(--gf-text-muted)",
                  background: "var(--gf-bg)",
                  border: "1px solid var(--gf-panel-border)",
                  boxShadow: "var(--gf-btn-shadow-active)",
                }}
                onMouseEnter={e => {
                  e.currentTarget.style.color = "var(--gf-text-primary)";
                  e.currentTarget.style.borderColor = "var(--gf-btn-border-hover)";
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.color = "var(--gf-text-muted)";
                  e.currentTarget.style.borderColor = "var(--gf-panel-border)";
                }}>
                Sign Out
              </button>
            </div>
          )}
        </div>
      </aside>

      <ProfileModal
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        onSaved={showProfileToast}
      />

      {/* Success toast — fixed top-right, persists after the modal closes. */}
      {profileToast && (
        <div
          className="fixed top-5 right-5 z-[80] flex items-center gap-2 px-4 py-3 rounded-[2px] border text-xs shadow-xl"
          style={{
            color: "#73BF69",
            background: "#73BF6914",
            borderColor: "#73BF6940",
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          <span>✓</span> {profileToast}
        </div>
      )}
    </>
  );
}

// A single nav link. Shared by the pinned items (Dashboard / Settings) and by the
// rows inside a group, so active/hover styling can't drift between them.
function NavRow({
  item, badge, onClose, indented,
}: {
  item: NavItem;
  badge: BadgeSpec | null;
  onClose: () => void;
  indented?: boolean;
}) {
  return (
    // Hover and active depth live in CSS (.gf-nav / .gf-nav-active in index.css).
    // The previous version drove hover from onMouseEnter/onMouseLeave and decided
    // "am I the active row?" by string-matching the inline background — which broke
    // the moment the active style stopped being a plain colour, and could never
    // express :active at all.
    <NavLink
      to={item.path}
      end={item.path === "/"}
      onClick={onClose}
      className={({ isActive }) =>
        `gf-nav flex items-center gap-2.5 py-2 text-[13px] ${isActive ? "gf-nav-active" : ""}`
      }
      style={({ isActive }) => ({
        marginLeft: indented ? 18 : 6,
        marginRight: 6,
        paddingLeft: indented ? 10 : 8,
        paddingRight: 8,
        // Accent edge kept as a SECOND cue alongside the raised surface — colour
        // alone fails on a bright screen and for anyone who can't rely on the blue.
        boxShadow: isActive ? "inset 2px 0 0 var(--gf-accent), var(--gf-btn-shadow)" : undefined,
        color: isActive ? undefined : "var(--gf-text-muted)",
      })}
    >
      <span style={{ opacity: 0.85, flexShrink: 0 }}>{item.icon}</span>
      <span className="truncate">{item.label}</span>
      {badge && <NavBadge count={badge.count} color={badge.color} title={badge.title} />}
    </NavLink>
  );
}

// Small count pill shown on a nav item (alerts = red, pending approvals = accent).
// Self-hides when count is 0.
function NavBadge({ count, color, title }: { count: number; color: string; title: string }) {
  if (count <= 0) return null;
  return (
    <span
      className="ml-auto min-w-[13px] h-[13px] px-[3px] flex items-center justify-center rounded-full text-[10px] font-semibold leading-none"
      style={{ background: color, color: "#fff" }}
      title={title}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
