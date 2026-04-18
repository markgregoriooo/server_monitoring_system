import { useAuth } from "../../context/AuthContext";
import { roleConfig } from "../../data/users";

type HeaderProps = {
  title: string;
  alertCount?: number;
  onMenuToggle?: () => void;
};

type RoleKey = keyof typeof roleConfig;

export default function Header({ title, alertCount = 2, onMenuToggle }: HeaderProps) {
  const auth = useAuth();

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
    <header
      className="h-14 bg-[#070e1cbf] backdrop-blur border-b border-white/[0.07]
      flex items-center justify-between px-4 lg:px-6 flex-shrink-0 sticky top-0 z-10"
    >
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuToggle}
          className="lg:hidden p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 6h16M4 12h16M4 18h16"
            />
          </svg>
        </button>

        <div>
          <div className="text-white font-bold text-sm lg:text-base leading-tight line-clamp-1">
            {title}
          </div>
          <div className="hidden sm:block text-[8px] text-[#f5c400]/60 font-mono tracking-widest mt-0.5">
            CSPC-ICTU
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 lg:gap-5">
        <div className="hidden md:block text-[10px] text-slate-500 font-mono">{now}</div>

        <div className="relative cursor-pointer">
          <span className="text-lg text-slate-400">🔔</span>
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
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-600 to-blue-900
              flex items-center justify-center text-xs font-bold text-white border-2 border-blue-500/35"
            >
              {user.avatar}
            </div>

            <div className="hidden sm:block">
              <div className="text-white text-xs font-semibold leading-tight">
                {user.name}
              </div>

              {roleCfg && (
                <div className={`text-[9px] font-semibold ${roleCfg.color}`}>
                  {roleCfg.label}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
