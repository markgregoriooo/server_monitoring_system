import { useState } from "react";
import { NavLink } from "react-router";
import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";
import { roleConfig } from "../../data/users";
import ProfileModal from "./ProfileModal";

type RoleKey = keyof typeof roleConfig;

interface NavItem {
  id: string;
  label: string;
  path: string;
}

interface RoleBadgeProps {
  role: string;
}

interface SidebarProps {
  mobileOpen: boolean;
  onClose: () => void;
}

const allNavItems: NavItem[] = [
  { id: "dashboard", label: "Dashboard", path: "/dashboard" },
  { id: "server-metrics", label: "Server Metrics", path: "/server-metrics" },
  { id: "environment", label: "Environment", path: "/environment" },
  { id: "air-conditioner", label: "Air Conditioner", path: "/air-conditioner" },
  { id: "history", label: "History", path: "/history" },
  { id: "reports", label: "Reports", path: "/reports" },
  { id: "settings", label: "Settings", path: "/settings" },
  { id: "user-management", label: "User Management", path: "/user-management" },
];

function RoleBadge({ role }: RoleBadgeProps) {
  const cfg = roleConfig[role as RoleKey] || {};
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-bold border
        ${cfg.bg} ${cfg.border} ${cfg.color}`}
    >
      {cfg.label}
    </span>
  );
}

export default function Sidebar({ mobileOpen, onClose }: SidebarProps) {
  const { user, logout } = useAuth();
  const { theme } = useTheme();
  const [profileOpen, setProfileOpen] = useState(false);

  const isDark = theme === "dark";

  const allowed = user ? roleConfig[user.role as RoleKey]?.pages || [] : [];
  const navItems = allNavItems.filter((item) => allowed.includes(item.id));

  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-20 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={`
          fixed lg:static inset-y-0 left-0 z-30
          w-56 flex flex-col h-full
          border-r transition-all duration-300 ease-in-out
          ${mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
          ${
            isDark
              ? "bg-gradient-to-b from-[#060c18] to-[#091221] border-white/[0.06]"
              : "bg-gradient-to-b from-white to-[#f0f4f8] border-slate-200"
          }
        `}
      >
        {/* ── Logo / Brand ── */}
        <div
          className={`flex items-center gap-3 px-4 py-4 border-b
            ${isDark ? "border-white/[0.06]" : "border-slate-200"}`}
        >
          <div
            className="w-10 h-10 rounded-full bg-gradient-to-br from-[#f5c400] to-[#d4a800]
              flex items-center justify-center text-[#080f1e] font-black text-[10px]
              tracking-wide flex-shrink-0 shadow-[0_0_14px_rgba(245,196,0,0.35)]"
          >
            CSPC
          </div>
          <div>
            <div
              className={`font-bold text-sm leading-tight
              ${isDark ? "text-white" : "text-slate-800"}`}
            >
              CSPC-ICTU
            </div>
            <div
              className={`text-[#f5c400]/70 font-mono text-[8px] tracking-widest mt-0.5  ${isDark ? "text-white" : "text-slate-800"}`}
            >
              SERVER MONITOR
            </div>
          </div>
        </div>

        {/* ── Navigation ── */}
        <nav className="flex-1 py-2 overflow-y-auto">
          {navItems.map((item) => (
            <NavLink
              key={item.id}
              to={item.path}
              onClick={onClose}
              className={({ isActive }) => `
                w-full flex items-center gap-3 px-4 py-2.5 text-sm font-medium
                border-l-[3px] transition-all duration-150 text-left
                ${
                  isActive
                    ? isDark
                      ? "border-blue-400 bg-gradient-to-r from-blue-600/25 to-transparent text-white"
                      : "border-blue-500 bg-blue-100 text-blue-700"
                    : isDark
                      ? "border-transparent text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]"
                      : "border-transparent text-slate-500 hover:text-slate-800 hover:bg-slate-100"
                }
              `}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* ── User section ── */}
        {user && (
          <div
            className={`px-4 py-3 border-t
              ${isDark ? "border-white/[0.06]" : "border-slate-200"}`}
          >
            {/* Clickable avatar row — opens ProfileModal */}
            <button
              onClick={() => setProfileOpen(true)}
              title="Edit profile"
              className="flex items-center gap-2.5 mb-2 w-full rounded-lg px-1 py-1 hover:bg-black/5 dark:hover:bg-white/[0.05] transition cursor-pointer group"
            >
              <div className="w-8 h-8 rounded-full flex-shrink-0 border border-blue-500/30 group-hover:ring-2 group-hover:ring-blue-400/50 transition overflow-hidden">
                {user.profile_image ? (
                  <img
                    src={`http://localhost:3000${user.profile_image}`}
                    alt={user.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-blue-600 to-blue-900 flex items-center justify-center text-xs font-bold text-white">
                    {user.avatar}
                  </div>
                )}
              </div>
              <div className="min-w-0 text-left flex-1">
                <div
                  className={`text-xs font-semibold leading-tight truncate
                  ${isDark ? "text-white" : "text-slate-800"}`}
                >
                  {user.name}
                </div>
                <RoleBadge role={user.role as RoleKey} />
              </div>
              {/* Edit hint */}
              <span className="text-[9px] font-mono text-slate-400 opacity-0 group-hover:opacity-100 transition flex-shrink-0">
                edit
              </span>
            </button>

            <button
              onClick={logout}
              className={`w-full py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition
                ${
                  isDark
                    ? "border border-white/10 bg-white/[0.04] text-slate-400 hover:text-white hover:bg-white/[0.08]"
                    : "border border-slate-200 bg-slate-100 text-slate-500 hover:text-slate-800 hover:bg-slate-200"
                }`}
            >
              Sign Out
            </button>
          </div>
        )}
      </aside>

      {/* ProfileModal rendered outside <aside> so it overlays the full page */}
      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
    </>
  );
}
