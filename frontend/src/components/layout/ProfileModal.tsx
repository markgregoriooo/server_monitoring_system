import { useState, useEffect, useRef } from "react";
import { useAuth } from "../../context/AuthContext";
import { api } from "../../api/api";
import { initials, avatarUrl } from "../../utils/format";

interface ProfileForm {
  name: string;
  username: string;
  email: string;
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
  "block text-[10px] font-semibold uppercase tracking-widest mb-1.5 text-[var(--gf-text-muted)]";

export default function ProfileModal({ open, onClose, onSaved }: ProfileModalProps) {
  const { user, updateUser } = useAuth();

  const [form, setForm] = useState<ProfileForm>({ name: "", username: "", email: "" });
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarFile, setAvatarFile]       = useState<File | null>(null);
  const fileRef    = useRef<HTMLInputElement>(null);
  const [saving, setSaving]     = useState(false);
  const [profileError, setProfileError] = useState("");
  const backdropRef = useRef<HTMLDivElement>(null);

  const imageSrc = avatarPreview || avatarUrl(user?.profile_image);

  useEffect(() => {
    if (!open || !user) return;
    setForm({
      name:     String(user.name     ?? ""),
      username: String(user.username ?? ""),
      email:    String(user.email    ?? ""),
    });
    setAvatarPreview(null);
    setAvatarFile(null);
    setProfileError("");
  }, [open, user]);

  if (!open || !user) return null;

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setProfileError("Image must be under 2 MB."); return; }
    setAvatarFile(file);

    const reader = new FileReader();
    reader.onload = () => setAvatarPreview(reader.result as string);
    reader.readAsDataURL(file);
    setProfileError("");
  };

  const handleSaveProfile = async () => {
    if (!form.name.trim() || !form.username.trim()) {
      setProfileError("Name and username are required."); return;
    }
    setSaving(true);
    setProfileError("");

    const formData = new FormData();
    formData.append("name",     form.name.trim());
    formData.append("username", form.username.trim());
    formData.append("email",    form.email.trim());
    if (avatarFile) formData.append("profile_image", avatarFile);

    const result = await api.updateMe(formData);
    if (!result.success || !result.data) {
      setProfileError(result.error ?? "Failed to save profile.");
      setSaving(false);
      return;
    }

    const raw = result.data;
    updateUser({
      name:          String(raw.name),
      username:      String(raw.username),
      email:         String(raw.email),
      profile_image: raw.profile_image,
      avatar:        raw.avatar,
    });

    setAvatarFile(null);
    setSaving(false);
    // Hand the success message to the parent, then close — the toast lives outside
    // this modal so it's still visible after we exit.
    onSaved?.("Profile updated successfully.");
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
            <div className="text-[13px] font-semibold text-[var(--gf-text-primary)]">My Profile</div>
            <div className="text-[10px] text-[var(--gf-text-dim)] mt-0.5 tracking-widest uppercase">
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

            {/* Avatar row */}
            <div className="flex items-center gap-6">
              <div className="relative flex-shrink-0">
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
                    {initials(form.name || String(user.name ?? "?"))}
                  </div>
                )}
                {avatarPreview && (
                  <button
                    onClick={() => { setAvatarPreview(null); setAvatarFile(null); if (fileRef.current) fileRef.current.value = ""; }}
                    className="absolute -top-1 -right-1 w-6 h-6 rounded-full text-white text-[11px] flex items-center justify-center cursor-pointer"
                    style={{ background: RED, border: "2px solid var(--gf-panel)" }}
                  >✕</button>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <input ref={fileRef} type="file" accept="image/*" onChange={handleAvatarChange} className="hidden" />
                <button
                  onClick={() => fileRef.current?.click()}
                  className="px-4 py-2 rounded-[2px] text-xs font-semibold border border-[var(--gf-panel-border)] text-[var(--gf-text-muted)] hover:bg-[var(--gf-hover)] hover:text-[var(--gf-text-primary)] transition cursor-pointer"
                >
                  Upload photo
                </button>
                <span className="text-[11px] text-[var(--gf-text-dim)]">JPG, PNG — max 2 MB</span>
              </div>
            </div>

            {/* Fields */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Full Name *</label>
                <input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} placeholder="e.g. Juan dela Cruz" className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>Username *</label>
                <input value={form.username} onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))} placeholder="e.g. jdelacruz" className={inputCls} />
              </div>
              <div className="col-span-2">
                <label className={labelCls}>Email</label>
                <input type="email" value={form.email} onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))} placeholder="e.g. juan@cspc.edu.ph" className={inputCls} />
              </div>
            </div>

            {profileError && (
              <div className="px-4 py-2.5 rounded-[2px] text-sm" style={{ color: RED, background: `${RED}14`, border: `1px solid ${RED}40` }}>{profileError}</div>
            )}

            <div className="flex gap-3 pt-1">
              <button onClick={onClose} className="flex-1 px-4 py-2.5 rounded-[2px] text-sm font-semibold border border-[var(--gf-panel-border)] text-[var(--gf-text-muted)] hover:bg-[var(--gf-hover)] transition cursor-pointer">Cancel</button>
              <button onClick={handleSaveProfile} disabled={saving} className="flex-1 px-4 py-2.5 rounded-[2px] text-sm font-semibold text-white border-none cursor-pointer transition hover:opacity-90 disabled:opacity-60" style={{ background: "var(--gf-accent)" }}>
                {saving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
