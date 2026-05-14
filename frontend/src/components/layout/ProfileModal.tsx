import { useState, useEffect, useRef } from "react";
import { useAuth } from "../../context/AuthContext";
import { api } from "../../api/api";

interface ProfileForm {
  name: string;
  username: string;
  email: string;
}

interface PasswordForm {
  current: string;
  next: string;
  confirm: string;
}

interface ProfileModalProps {
  open: boolean;
  onClose: () => void;
}

function initials(name: string) {
  return name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
}

function passwordStrength(pw: string): { label: string; bars: string[] } {
  const bars = [
    pw.length >= 6  ? "bg-red-400"   : "bg-slate-200 dark:bg-white/10",
    pw.length >= 8  ? "bg-amber-400" : "bg-slate-200 dark:bg-white/10",
    pw.length >= 12 ? "bg-green-400" : "bg-slate-200 dark:bg-white/10",
  ];
  const label =
    pw.length === 0  ? ""          :
    pw.length < 6    ? "Too short" :
    pw.length < 8    ? "Weak"      :
    pw.length < 12   ? "Fair"      : "Strong";
  return { label, bars };
}

const inputCls =
  "w-full px-3 py-2.5 rounded-lg bg-slate-100 dark:bg-white/[0.05] border border-slate-200 dark:border-white/[0.10] text-slate-900 dark:text-white text-sm font-mono outline-none focus:border-blue-500/60 transition placeholder-slate-400 dark:placeholder-slate-600";
const labelCls =
  "block text-[10px] font-mono font-semibold text-slate-400 uppercase tracking-widest mb-1.5";

export default function ProfileModal({ open, onClose }: ProfileModalProps) {
  const { user, updateUser } = useAuth();

  const [form, setForm] = useState<ProfileForm>({ name: "", username: "", email: "" });
  const [pwForm, setPwForm]     = useState<PasswordForm>({ current: "", next: "", confirm: "" });
  const [showPw, setShowPw]     = useState(false);
  const [pwError, setPwError]   = useState("");
  const [pwSuccess, setPwSuccess] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarFile, setAvatarFile]       = useState<File | null>(null);
  const fileRef    = useRef<HTMLInputElement>(null);
  const [tab, setTab]           = useState<"profile" | "password">("profile");
  const [saving, setSaving]     = useState(false);
  const [profileError, setProfileError] = useState("");
  const [toast, setToast]       = useState("");
  const backdropRef = useRef<HTMLDivElement>(null);

  const imageSrc =
    avatarPreview ||
    (user?.profile_image ? `http://localhost:3000${user.profile_image}` : null);

  const strength = passwordStrength(pwForm.next);

  useEffect(() => {
    if (!open || !user) return;
    setForm({
      name:     String(user.name     ?? ""),
      username: String(user.username ?? ""),
      email:    String(user.email    ?? ""),
    });
    setAvatarPreview(null);
    setAvatarFile(null);
    setPwForm({ current: "", next: "", confirm: "" });
    setPwError("");
    setPwSuccess(false);
    setProfileError("");
    setTab("profile");
  }, [open, user]);

  if (!open || !user) return null;

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  };

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
    showToast("Profile updated successfully.");
  };

  const handleSavePassword = async () => {
    setPwError(""); setPwSuccess(false);
    if (!pwForm.current.trim())   { setPwError("Current password is required."); return; }
    if (pwForm.next.length < 6)   { setPwError("New password must be at least 6 characters."); return; }
    if (pwForm.next !== pwForm.confirm) { setPwError("Passwords do not match."); return; }
    setSaving(true);
    const result = await api.changePassword(pwForm.current, pwForm.next);
    if (!result.success) { setPwError(result.error ?? "Failed to change password."); setSaving(false); return; }
    setSaving(false);
    setPwSuccess(true);
    setPwForm({ current: "", next: "", confirm: "" });
    showToast("Password changed successfully.");
  };

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onMouseDown={(e) => { if (e.target === backdropRef.current) onClose(); }}
    >
      {/* ── Modal shell — wider and taller ── */}
      <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-[#0f1117] border border-slate-200 dark:border-white/[0.10] shadow-2xl flex flex-col max-h-[92vh] overflow-hidden">

        {/* ── Header ── */}
        <div className="flex items-center justify-between px-7 py-5 border-b border-slate-200 dark:border-white/[0.08] bg-slate-50 dark:bg-white/[0.03] flex-shrink-0">
          <div>
            <div className="text-base font-semibold text-slate-900 dark:text-white">My Profile</div>
            <div className="text-[11px] font-mono text-slate-400 mt-0.5 tracking-widest uppercase">
              {String(user.role ?? "")}
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-white/10 transition cursor-pointer"
          >✕</button>
        </div>

        {/* ── Toast ── */}
        {toast && (
          <div className="mx-7 mt-5 px-4 py-2.5 rounded-lg bg-green-100 dark:bg-green-500/10 border border-green-300 dark:border-green-500/25 text-green-700 dark:text-green-400 text-sm font-mono flex items-center gap-2">
            <span>✓</span> {toast}
          </div>
        )}

        {/* ── Tabs ── */}
        <div className="flex gap-2 px-7 mt-5 flex-shrink-0">
          {(["profile", "password"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-5 py-2 rounded-lg text-xs font-semibold border cursor-pointer transition-all capitalize ${
                tab === t
                  ? "bg-blue-100 dark:bg-blue-500/20 border-blue-300 dark:border-blue-500/40 text-blue-600 dark:text-blue-400"
                  : "bg-slate-100 dark:bg-white/[0.04] border-slate-200 dark:border-white/[0.07] text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
              }`}
            >
              {t === "profile" ? "Profile Info" : "Change Password"}
            </button>
          ))}
        </div>

        {/* ── Scrollable body ── */}
        <div className="overflow-y-auto flex-1 px-7 py-6">

          {/* ════ PROFILE TAB ════ */}
          {tab === "profile" && (
            <div className="flex flex-col gap-6">

              {/* Avatar row */}
              <div className="flex items-center gap-6">
                <div className="relative flex-shrink-0">
                  {imageSrc ? (
                    <img
                      src={imageSrc}
                      alt="avatar"
                      className="w-24 h-24 rounded-full object-cover border-2 border-blue-500/30"
                    />
                  ) : (
                    <div className="w-24 h-24 rounded-full bg-gradient-to-br from-blue-600 to-blue-900 flex items-center justify-center text-2xl font-bold text-white border-2 border-blue-500/30 select-none">
                      {initials(form.name || String(user.name ?? "?"))}
                    </div>
                  )}
                  {avatarPreview && (
                    <button
                      onClick={() => { setAvatarPreview(null); setAvatarFile(null); if (fileRef.current) fileRef.current.value = ""; }}
                      className="absolute -top-1 -right-1 w-6 h-6 rounded-full bg-red-500 text-white text-[11px] flex items-center justify-center cursor-pointer border-2 border-white dark:border-[#0f1117]"
                    >✕</button>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  <input ref={fileRef} type="file" accept="image/*" onChange={handleAvatarChange} className="hidden" />
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="px-4 py-2 rounded-lg text-xs font-semibold border border-slate-300 dark:border-white/[0.10] bg-white dark:bg-white/[0.04] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.08] transition cursor-pointer"
                  >
                    Upload photo
                  </button>
                  <span className="text-[11px] font-mono text-slate-400">JPG, PNG — max 2 MB</span>
                </div>
              </div>

              {/* Fields — 2-col grid */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Full Name *</label>
                  <input
                    value={form.name}
                    onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                    placeholder="e.g. Juan dela Cruz"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Username *</label>
                  <input
                    value={form.username}
                    onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))}
                    placeholder="e.g. jdelacruz"
                    className={inputCls}
                  />
                </div>
                <div className="col-span-2">
                  <label className={labelCls}>Email</label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                    placeholder="e.g. juan@cspc.edu.ph"
                    className={inputCls}
                  />
                </div>
              </div>

              {profileError && (
                <div className="px-4 py-2.5 rounded-lg bg-red-100 dark:bg-red-500/10 border border-red-300 dark:border-red-500/25 text-red-600 dark:text-red-400 text-sm font-mono">
                  {profileError}
                </div>
              )}

              <div className="flex gap-3 pt-1">
                <button
                  onClick={onClose}
                  className="flex-1 px-4 py-3 rounded-lg text-sm font-semibold border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/5 transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveProfile}
                  disabled={saving}
                  className="flex-1 px-4 py-3 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white border-none cursor-pointer transition disabled:opacity-60"
                >
                  {saving ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </div>
          )}

          {/* ════ PASSWORD TAB ════ */}
          {tab === "password" && (
            <div className="flex flex-col gap-5">

              <div className="px-4 py-3 rounded-lg bg-amber-100 dark:bg-amber-500/10 border border-amber-300 dark:border-amber-500/25 text-amber-700 dark:text-amber-400 text-sm font-mono leading-relaxed">
                You will remain logged in after changing your password.
              </div>

              {/* Current */}
              <div>
                <label className={labelCls}>Current Password *</label>
                <div className="relative">
                  <input
                    type={showPw ? "text" : "password"}
                    value={pwForm.current}
                    onChange={(e) => setPwForm((p) => ({ ...p, current: e.target.value }))}
                    placeholder="Your current password"
                    className={inputCls + " pr-16"}
                  />
                  <button
                    onClick={() => setShowPw((p) => !p)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-mono text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
                  >
                    {showPw ? "Hide" : "Show"}
                  </button>
                </div>
              </div>

              {/* New */}
              <div>
                <label className={labelCls}>New Password *</label>
                <input
                  type={showPw ? "text" : "password"}
                  value={pwForm.next}
                  onChange={(e) => setPwForm((p) => ({ ...p, next: e.target.value }))}
                  placeholder="Min. 6 characters"
                  className={inputCls}
                />
                {pwForm.next && (
                  <div className="flex gap-1.5 items-center mt-2">
                    {strength.bars.map((cls, i) => (
                      <div key={i} className={`h-1.5 flex-1 rounded-full transition-colors ${cls}`} />
                    ))}
                    <span className="text-[11px] font-mono text-slate-400 ml-1 w-16">{strength.label}</span>
                  </div>
                )}
              </div>

              {/* Confirm */}
              <div>
                <label className={labelCls}>Confirm New Password *</label>
                <input
                  type={showPw ? "text" : "password"}
                  value={pwForm.confirm}
                  onChange={(e) => setPwForm((p) => ({ ...p, confirm: e.target.value }))}
                  placeholder="Re-enter new password"
                  className={inputCls}
                />
                {pwForm.confirm && (
                  <div className={`text-[11px] font-mono mt-2 ${pwForm.next === pwForm.confirm ? "text-green-500" : "text-red-400"}`}>
                    {pwForm.next === pwForm.confirm ? "✓ Passwords match" : "✕ Passwords do not match"}
                  </div>
                )}
              </div>

              {pwError && (
                <div className="px-4 py-2.5 rounded-lg bg-red-100 dark:bg-red-500/10 border border-red-300 dark:border-red-500/25 text-red-600 dark:text-red-400 text-sm font-mono">
                  {pwError}
                </div>
              )}

              {pwSuccess && (
                <div className="px-4 py-2.5 rounded-lg bg-green-100 dark:bg-green-500/10 border border-green-300 dark:border-green-500/25 text-green-600 dark:text-green-400 text-sm font-mono">
                  ✓ Password changed successfully.
                </div>
              )}

              <div className="flex gap-3 pt-1">
                <button
                  onClick={onClose}
                  className="flex-1 px-4 py-3 rounded-lg text-sm font-semibold border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/5 transition cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSavePassword}
                  disabled={saving}
                  className="flex-1 px-4 py-3 rounded-lg text-sm font-semibold bg-amber-500 hover:bg-amber-400 text-white border-none cursor-pointer transition disabled:opacity-60"
                >
                  {saving ? "Saving…" : "Change Password"}
                </button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}