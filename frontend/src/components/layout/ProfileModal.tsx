import { useState, useEffect, useRef } from "react";
import { useAuth } from "../../context/AuthContext";
import { api } from "../../api/api";
import { initials, avatarUrl } from "../../utils/format";

// Login is Google-only, and googleAuthService re-syncs name + photo (and the email,
// on a Google-side rename) from the ID token on EVERY sign-in. Editing those here
// would therefore last exactly until the next login, so they are shown read-only.
// `username` is ours alone — Google never touches it — so it stays editable.
interface ProfileForm {
  username: string;
}

interface ProfileModalProps {
  open: boolean;
  onClose: () => void;
  // Called with a success message after a save; the parent shows the toast so it
  // stays visible once the modal closes.
  onSaved?: (msg: string) => void;
}

const RED = "#F2495C";

const inputCls =
  "w-full px-3 py-2.5 rounded-[2px] text-sm font-mono outline-none transition " +
  "bg-[var(--gf-bg)] border border-[var(--gf-panel-border)] text-[var(--gf-text-primary)] " +
  "placeholder-[var(--gf-text-dim)] focus:border-[var(--gf-accent)]";

const labelCls =
  "block text-[12px] font-semibold uppercase tracking-widest mb-1.5 text-[var(--gf-text-muted)]";

export default function ProfileModal({ open, onClose, onSaved }: ProfileModalProps) {
  const { user, updateUser } = useAuth();

  const [form, setForm] = useState<ProfileForm>({ username: "" });
  const [saving, setSaving]     = useState(false);
  const [profileError, setProfileError] = useState("");
  const backdropRef = useRef<HTMLDivElement>(null);

  const imageSrc = avatarUrl(user?.profile_image);

  useEffect(() => {
    if (!open || !user) return;
    setForm({ username: String(user.username ?? "") });
    setProfileError("");
  }, [open, user]);

  if (!open || !user) return null;

  const handleSaveProfile = async () => {
    if (!form.username.trim()) {
      setProfileError("Username is required."); return;
    }
    setSaving(true);
    setProfileError("");

    const result = await api.updateMe(form.username.trim());
    if (!result.success || !result.data) {
      setProfileError(result.error ?? "Failed to save profile.");
      setSaving(false);
      return;
    }

    updateUser({ username: String(result.data.username) });

    setSaving(false);
    // Hand the success message to the parent, then close — the toast lives outside
    // this modal so it's still visible after we exit.
    onSaved?.("Username updated successfully.");
    onClose();
  };

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === backdropRef.current) onClose(); }}
      style={{ fontFamily: "'JetBrains Mono', monospace" }}
    >
      {/* ── Modal shell ── */}
      <div className="w-full max-w-2xl rounded-[2px] bg-[var(--gf-panel)] border border-[var(--gf-panel-border)] shadow-2xl flex flex-col max-h-[92vh] overflow-hidden">

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-6 border-b border-[var(--gf-divider)] flex-shrink-0" style={{ height: 48 }}>
          <div>
            <div className="text-[15px] font-semibold text-[var(--gf-text-primary)]">My Profile</div>
            <div className="text-[12px] text-[var(--gf-text-dim)] mt-0.5 tracking-widest uppercase">
              {String(user.role ?? "")}
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-[2px] text-[var(--gf-text-muted)] hover:text-[var(--gf-text-primary)] hover:bg-[var(--gf-hover)] transition cursor-pointer"
          >✕</button>
        </div>

        {/* ── Body ── */}
        <div className="overflow-y-auto flex-1 px-6 py-6">
          <div className="flex flex-col gap-6">

            {/* Avatar + identity — all of it comes from Google, none of it editable */}
            <div className="flex items-center gap-6">
              <div className="flex-shrink-0">
                {imageSrc ? (
                  <img
                    src={imageSrc}
                    alt="avatar"
                    referrerPolicy="no-referrer"
                    className="w-24 h-24 rounded-full object-cover"
                    style={{ border: "2px solid var(--gf-accent)" }}
                  />
                ) : (
                  <div
                    className="w-24 h-24 rounded-full flex items-center justify-center text-2xl font-bold text-white select-none"
                    style={{ background: "var(--gf-accent)", border: "2px solid var(--gf-accent)" }}
                  >
                    {initials(String(user.name ?? "?"))}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-3 min-w-0">
                <div>
                  <span className={labelCls}>Full Name</span>
                  <div className="text-sm font-semibold text-[var(--gf-text-primary)] truncate">
                    {String(user.name ?? "—")}
                  </div>
                </div>
                <div>
                  <span className={labelCls}>Email</span>
                  <div className="text-sm font-semibold text-[var(--gf-text-primary)] truncate">
                    {String(user.email ?? "—")}
                  </div>
                </div>
              </div>
            </div>

            {/* Why those three are fixed */}
            <div
              className="px-4 py-2.5 rounded-[2px] text-[13px] leading-relaxed"
              style={{
                color: "var(--gf-text-muted)",
                background: "var(--gf-bg)",
                border: "1px solid var(--gf-panel-border)",
              }}
            >
              Your name, email and photo come from your CSPC Google account and refresh on every
              sign-in — so they can't be edited here. Change them in your Google account and they
              will update the next time you log in.
            </div>

            {/* The one field that is ours */}
            <div>
              <label className={labelCls}>Username *</label>
              <input name="username"
                value={form.username}
                onChange={(e) => setForm({ username: e.target.value })}
                placeholder="e.g. jdelacruz"
                className={inputCls}
              />
              <span className="block text-[13px] mt-1.5 text-[var(--gf-text-dim)]">
                Display name inside this dashboard. Must be unique.
              </span>
            </div>

            {profileError && (
              <div className="px-4 py-2.5 rounded-[2px] text-sm" style={{ color: RED, background: `${RED}14`, border: `1px solid ${RED}40` }}>{profileError}</div>
            )}

            <div className="flex gap-3 pt-1">
              <button onClick={onClose} className="gf-btn flex-1 px-4 py-2.5 rounded-[2px] text-sm font-semibold border border-[var(--gf-panel-border)] text-[var(--gf-text-muted)] hover:bg-[var(--gf-hover)] transition cursor-pointer">Cancel</button>
              <button onClick={handleSaveProfile} disabled={saving} className="gf-raise flex-1 px-4 py-2.5 rounded-[2px] text-sm font-semibold text-white border-none cursor-pointer transition hover:opacity-90 disabled:opacity-60" style={{ background: "var(--gf-accent)" }}>
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
