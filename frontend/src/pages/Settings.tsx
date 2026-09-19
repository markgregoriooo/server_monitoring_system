import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { roleConfig, type Role } from "../data/users";
import { initials, avatarUrl } from "../utils/format";
import ProfileModal from "../components/layout/ProfileModal";
import NotificationPreferences from "../components/notifications/NotificationPreferences";
import WidgetBuilder from "../pip/WidgetBuilder";
import { useIsNarrow } from "../hooks/useIsNarrow";

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
  // Phone check for the pop-out widget builder below. `md` — the same boundary the
  // tables on Alerts / History / User Management switch layout at.
  const narrow = useIsNarrow(768);

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

        {/* flex-wrap + basis-full: on a phone the 112px button eats the space the email
            needs, truncating the one line here that cannot be guessed from the rest.
            Below `sm` it drops to its own full-width row instead. */}
        <div className="flex items-center gap-4 flex-wrap">
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
            className="gf-btn text-[14px] px-3 py-1.5 flex-shrink-0 basis-full sm:basis-auto"
            style={{ color: "var(--gf-text-primary)" }}
          >
            Edit profile
          </button>
        </div>
      </div>

      {/* ── Notification preferences (per-user, persisted in notification_prefs) ── */}
      <NotificationPreferences />

      {/* ── Customize Widget (per-user, persisted in widget_prefs) ──
          Desktop only. The widget it builds is a Document Picture-in-Picture window,
          which no mobile browser implements — so on a phone this is a drag-and-drop
          builder for a window that can never be opened on that device, and dragging
          tiles past a scrolling page is the worst way to find that out.

          NOT RENDERED rather than hidden with `md:hidden`: WidgetBuilder mounts
          useWidgetLayout (a GET /api/widget-prefs) and subscribes to LiveSummary, so
          a CSS-hidden copy would still spend a request out of the per-user rate
          budget on every Settings visit from a phone.

          ⚠️ The gate is the VIEWPORT, deliberately not `pipSupported`. The builder is
          meant to stay visible on a desktop browser without the API (Firefox, Safari)
          — the layout saves to the account and is used later from Chrome or Edge,
          which is what the "Pop-out itself needs Chrome or Edge" note inside it is
          for. Capability decides what the button does; width decides what fits. */}
      {!narrow && <WidgetBuilder />}

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
