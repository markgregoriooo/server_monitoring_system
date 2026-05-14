import { useState } from "react";
import { useTheme } from "../../context/ThemeContext";
import { useAuth } from "../../context/AuthContext";
import { roleConfig } from "../../data/users";
import ProfileModal from "./ProfileModal";

type HeaderProps = {
  title: string;
  alertCount?: number;
  onMenuToggle?: () => void;
};

type RoleKey = keyof typeof roleConfig;

export default function Header({
  title,
  alertCount = 2,
  onMenuToggle,
}: HeaderProps) {
  const auth = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [profileOpen, setProfileOpen] = useState(false);

  const user = auth?.user ?? null;
  const logout = auth?.logout;

  const roleCfg = user ? roleConfig[user.role as RoleKey] : null;

  const now = new Date().toLocaleString("en-PH", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <>
      <header
        className="h-14 bg-white/80 dark:bg-[#070e1cbf] backdrop-blur border-b border-slate-200 dark:border-white/[0.07]
    flex items-center justify-between px-4 lg:px-6 flex-shrink-0 sticky top-0 z-10"
      >
        {/* LEFT SIDE */}
        <div className="flex items-center gap-3">
          <button
            onClick={onMenuToggle}
            className="lg:hidden p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-white/10 transition"
          >
            <svg
              className="w-5 h-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          </button>

          <div>
            <div className="text-slate-900 dark:text-white font-bold text-sm lg:text-base leading-tight line-clamp-1">
              {title}
            </div>

            <div className="hidden sm:block text-[8px] text-yellow-600 dark:text-[#f5c400]/60 font-mono tracking-widest mt-0.5">
              CSPC-ICTU
            </div>
          </div>
        </div>

        {/* RIGHT SIDE */}
        <div className="flex items-center gap-3 lg:gap-5">
          {/* ── THEME TOGGLE BUTTON ── */}
          <button
            onClick={toggleTheme}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            className="p-1.5 rounded-lg transition hover:bg-slate-200 dark:hover:bg-white/10"
          >
            {theme === "dark" ? (
              // Sun icon for switching to light
              <svg
                className="w-4 h-4 text-yellow-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707M17.657 17.657l-.707-.707M6.343 6.343l-.707-.707M12 7a5 5 0 100 10A5 5 0 0012 7z"
                />
              </svg>
            ) : (
              // Moon icon for switching to dark
              <svg
                className="w-4 h-4 text-slate-700 dark:text-slate-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                />
              </svg>
            )}
          </button>
          {/* ── END TOGGLE ── */}

          <div className="hidden md:block text-[10px] text-slate-500 dark:text-slate-400 font-mono">
            {now}
          </div>

          <div className="relative cursor-pointer">
            <span className="text-lg text-slate-500 dark:text-slate-400">
              🔔
            </span>

            {alertCount > 0 && (
              <span
                className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white rounded-full
            text-[8px] font-bold flex items-center justify-center"
              >
                {alertCount}
              </span>
            )}
          </div>

          {user && (
            <button
              onClick={() => setProfileOpen(true)}
              title="Edit profile"
              className="flex items-center gap-2 cursor-pointer group rounded-lg px-1.5 py-1 hover:bg-slate-100 dark:hover:bg-white/[0.06] transition"
            >
              <div className="w-8 h-8 rounded-full border-2 border-blue-500/35 group-hover:ring-2 group-hover:ring-blue-400/50 transition overflow-hidden">
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
              <div className="hidden sm:block text-left">
                <div className="text-slate-900 dark:text-white text-xs font-semibold leading-tight">
                  {user.name}
                </div>
                {roleCfg && (
                  <div className={`text-[9px] font-semibold ${roleCfg.color}`}>
                    {roleCfg.label}
                  </div>
                )}
              </div>
            </button>
          )}
        </div>
      </header>

      {/* ProfileModal outside <header> so it overlays the full page */}
      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
    </>
  );
}
