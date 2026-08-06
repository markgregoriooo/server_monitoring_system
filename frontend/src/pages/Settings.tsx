import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { roleConfig, type Role } from "../data/users";
import { initials, avatarUrl } from "../utils/format";
import ProfileModal from "../components/layout/ProfileModal";
import NotificationPreferences from "../components/notifications/NotificationPreferences";

// Personal settings — everything on this page is PER-USER and scoped to the signed-in
// account: profile (users row), notification prefs (notification_prefs, keyed by user_id,
// API scoped to req.user.id), and theme (this browser's localStorage). No global/system
// config lives here — alert thresholds are on the admin-only Alert Rules page; the old
// mock "backend connection / thresholds / save" cards were removed.

const panelStyle: React.CSSProperties = {
  background: "var(--gf-panel)",
  border: "1px solid var(--gf-panel-border)",
  borderRadius: 2,
  fontFamily: "'JetBrains Mono', monospace",
};
const titleColor = { color: "var(--gf-text-primary)" };
const subColor = { color: "var(--gf-text-muted)" };

export default function Settings() {
  const { user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [profileOpen, setProfileOpen] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  const showSaved = (msg: string) => {
    setSavedMsg(msg);
    setTimeout(() => setSavedMsg(""), 3000);
  };

  const roleLabel = user ? roleConfig[user.role as Role]?.label ?? String(user.role) : "";
  const imageSrc = avatarUrl(user?.profile_image);

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4">

      <div className="text-[13px] tracking-widest uppercase" style={subColor}>
        Personal settings — these apply to your account only.
      </div>

      {/* ── Profile (your users row) — edit via the shared ProfileModal ── */}
      <div className="p-5" style={panelStyle}>
        <div className="text-sm font-bold mb-1" style={titleColor}>Profile</div>
        <div className="text-[13px] mb-4" style={subColor}>Your account identity.</div>

        <div className="flex items-center gap-4">
          {imageSrc ? (
            <img
              src={imageSrc}
              alt="avatar"
              referrerPolicy="no-referrer"
              className="w-14 h-14 rounded-full object-cover flex-shrink-0"
              style={{ border: "2px solid var(--gf-accent)" }}
            />
          ) : (
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center text-lg font-bold text-white select-none flex-shrink-0"
              style={{ background: "var(--gf-accent)" }}
            >
              {initials(String(user?.name ?? "?"))}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold truncate" style={titleColor}>{String(user?.name ?? "")}</div>
            <div className="text-[14px] truncate" style={subColor}>{String(user?.email ?? "")}</div>
            <div className="text-[12px] mt-0.5 tracking-widest uppercase" style={{ color: "var(--gf-accent)" }}>{roleLabel}</div>
          </div>
          <button
            type="button"
            onClick={() => setProfileOpen(true)}
            className="gf-raise text-[14px] px-3 py-1.5 transition-colors flex-shrink-0 hover:opacity-90"
            style={{ background: "var(--gf-accent)", color: "#fff", borderRadius: 2 }}
          >
            Edit profile
          </button>
        </div>
      </div>

      {/* ── Notification preferences (per-user, persisted in notification_prefs) ── */}
      <NotificationPreferences />

      {/* ── Appearance (per-user, persisted in localStorage: cspc_theme) ── */}
      <div className="p-5" style={panelStyle}>
        <div className="text-sm font-bold mb-1" style={titleColor}>Appearance</div>
        <div className="text-[13px] mb-4" style={subColor}>Theme for this browser.</div>
        <div className="flex items-center justify-between">
          <span className="text-[14px]" style={titleColor}>Theme</span>
          <div
            className="flex"
            style={{ border: "1px solid var(--gf-panel-border)", borderRadius: 2, overflow: "hidden" }}
          >
            {(["dark", "light"] as const).map((t) => {
              const active = theme === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => { if (!active) toggleTheme(); }}
                  className="text-[14px] px-3 py-1 capitalize transition-colors"
                  style={{
                    background: active ? "var(--gf-accent)" : "transparent",
                    color: active ? "#fff" : "var(--gf-text-muted)",
                  }}
                >
                  {t}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} onSaved={showSaved} />

      {/* Saved toast — fixed top-right, persists briefly after the modal closes. */}
      {savedMsg && (
        <div
          className="fixed top-5 right-5 z-[80] flex items-center gap-2 px-4 py-3 rounded-[2px] border text-xs shadow-xl"
          style={{
            color: "#73BF69",
            background: "#73BF6914",
            borderColor: "#73BF6940",
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          <span>✓</span> {savedMsg}
        </div>
      )}

    </div>
  );
}
