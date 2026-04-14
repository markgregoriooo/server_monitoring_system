import { NavLink } from "react-router";
import { useAuth } from "../../context/AuthContext";
import { roleConfig } from "../../data/users";

const allNavItems = [
  { id: "dashboard",       label: "Dashboard",       icon: "⊞", path: "/dashboard" },
  { id: "server-metrics",  label: "Server Metrics",  icon: "▤", path: "/server-metrics" },
  { id: "environment",     label: "Environment",     icon: "◎", path: "/environment" },
  { id: "air-control",     label: "Air Control",     icon: "❄", path: "/air-control" },
  { id: "history",         label: "History",         icon: "◷", path: "/history" },
  { id: "reports",         label: "Reports",         icon: "◻", path: "/reports" },
  { id: "settings",        label: "Settings",        icon: "⚙", path: "/settings" },
  { id: "user-management", label: "User Management", icon: "👥", path: "/user-management" },
];

function RoleBadge({ role }) {
  const cfg = roleConfig[role] || {};
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[9px] font-bold border ${cfg.bg} ${cfg.border} ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

export default function Sidebar({ mobileOpen, onClose }) {
  const { user, logout } = useAuth();
  const allowed = user ? (roleConfig[user.role]?.pages || []) : [];
  const navItems = allNavItems.filter(item => allowed.includes(item.id));

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 bg-black/60 z-20 lg:hidden" onClick={onClose} />
      )}

      <aside className={`
        fixed lg:static inset-y-0 left-0 z-30
        w-56 flex flex-col h-full
        bg-gradient-to-b from-[#060c18] to-[#091221]
        border-r border-white/[0.06]
        transition-transform duration-300 ease-in-out
        ${mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
      `}>

        <div className="flex items-center gap-3 px-4 py-4 border-b border-white/[0.06]">
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#f5c400] to-[#d4a800]
            flex items-center justify-center text-[#080f1e] font-black text-[10px] tracking-wide flex-shrink-0
            shadow-[0_0_14px_rgba(245,196,0,0.35)]">
            CSPC
          </div>
          <div>
            <div className="text-white font-bold text-sm leading-tight">CSPC-ICTU</div>
            <div className="text-[#f5c400]/60 font-mono text-[8px] tracking-widest mt-0.5">SERVER MONITOR</div>
          </div>
        </div>

        <nav className="flex-1 py-2 overflow-y-auto">
          {navItems.map(item => (
            <NavLink
              key={item.id}
              to={item.path}
              onClick={onClose}
              className={({ isActive }) => `
                w-full flex items-center gap-3 px-4 py-2.5 text-sm font-medium
                border-l-[3px] transition-all duration-150 text-left
                ${isActive
                  ? "border-blue-400 bg-gradient-to-r from-blue-600/25 to-transparent text-white"
                  : "border-transparent text-slate-400 hover:text-slate-200 hover:bg-white/[0.03]"
                }`
              }
            >
              <span className="text-base w-5 text-center flex-shrink-0">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        {user && (
          <div className="px-4 py-3 border-t border-white/[0.06]">
            <div className="flex items-center gap-2.5 mb-2">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-600 to-blue-900
                flex items-center justify-center text-xs font-bold text-white flex-shrink-0 border border-blue-500/30">
                {user.avatar}
              </div>
              <div className="min-w-0">
                <div className="text-white text-xs font-semibold leading-tight truncate">{user.name}</div>
                <RoleBadge role={user.role} />
              </div>
            </div>
            <button onClick={logout}
              className="w-full py-1.5 rounded-lg border border-white/10 bg-white/[0.04]
                text-slate-400 text-xs font-semibold cursor-pointer hover:text-white hover:bg-white/[0.08] transition">
              Sign Out
            </button>
          </div>
        )}
      </aside>
    </>
  );
}
