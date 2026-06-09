import { useState, useEffect, useRef } from "react";
import { api } from "../api/api";
import { roleConfig } from "../data/users";
import { useAuth } from "../context/AuthContext";
import { API_URL } from "../config";

// ─── Types ────────────────────────────────────────────────────────────────────

interface User {
  id: number;
  name: string;
  username: string;
  email: string;
  role: string;
  status: string;
  profile_image?: string;
  avatar?: string;
  last_login?: string;
  created_at?: string;
}

interface UserForm {
  name: string;
  username: string;
  email: string;
  role: string;
  password: string;
  status: string;
}

interface EditForm {
  name: string;
  username: string;
  email: string;
  role: string;
  status: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function initials(name: string) {
  return name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
}

function avatarColor(role: string) {
  switch (role) {
    case "admin":    return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
    case "it_staff": return "bg-blue-500/20 text-blue-400 border-blue-500/30";
    default:         return "bg-slate-500/20 text-slate-400 border-slate-500/30";
  }
}

function roleCfg(role: string) {
  return roleConfig[role as keyof typeof roleConfig] ?? {
    label: role, color: "text-slate-400",
    bg: "bg-slate-500/10", border: "border-slate-500/30", pages: [],
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function RoleBadge({ role }: { role: string }) {
  const cfg = roleCfg(role);
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold border ${cfg.bg} ${cfg.border} ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

function StatusBadge({ status }: { status?: string }) {
  const active = !status || status === "active";
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${
      active
        ? "bg-green-500/10 border-green-500/25 text-green-400"
        : "bg-slate-500/10 border-slate-500/25 text-slate-400"
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${active ? "bg-green-400" : "bg-slate-500"}`} />
      {active ? "Active" : "Inactive"}
    </span>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-xl bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] p-4">
      <div className="text-[9px] font-mono text-slate-400 uppercase tracking-widest mb-1">{label}</div>
      <div className={`text-2xl font-bold font-mono leading-none ${color}`}>{value}</div>
    </div>
  );
}

// ─── Shared input/label classes ───────────────────────────────────────────────

const inputCls =
  "w-full px-3 py-2.5 rounded-lg bg-slate-100 dark:bg-white/[0.05] border border-slate-200 dark:border-white/[0.10] text-slate-900 dark:text-white text-sm font-mono outline-none focus:border-blue-500/60 transition placeholder-slate-400 dark:placeholder-slate-600";

const labelCls =
  "block text-[10px] font-mono font-semibold text-slate-400 uppercase tracking-widest mb-1.5";

// ─── SelectField — theme-aware dropdown ──────────────────────────────────────
//
// Native <select> dropdowns ignore Tailwind's dark: utilities for the popup
// background. Setting `colorScheme` tells the browser to match the OS/page
// theme so option backgrounds flip correctly in dark mode.

function SelectField({
  value,
  onChange,
  options,
  className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  className?: string;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // appearance-none removes the default OS chevron so we can add our own
        className={`${inputCls} appearance-none cursor-pointer pr-8 ${className}`}
        // colorScheme is the key fix: it signals to the browser which theme
        // to use when rendering the native dropdown popup and its options.
        style={{ colorScheme: "light dark" }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {/* Custom chevron replaces the removed OS one */}
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-xs select-none">
        ▾
      </span>
    </div>
  );
}

// ─── Modal (wider) ────────────────────────────────────────────────────────────

function Modal({
  title, open, onClose, children,
}: {
  title: string; open: boolean; onClose: () => void; children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    setTimeout(() => document.addEventListener("mousedown", handler), 10);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div
        ref={ref}
        className="w-full max-w-2xl rounded-2xl bg-white dark:bg-[#0f1117] border border-slate-200 dark:border-white/[0.10] shadow-2xl flex flex-col max-h-[92vh] overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-7 py-5 border-b border-slate-200 dark:border-white/[0.08] bg-slate-50 dark:bg-white/[0.03] flex-shrink-0">
          <span className="text-base font-semibold text-slate-900 dark:text-white">{title}</span>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-200 dark:hover:bg-white/10 transition cursor-pointer"
          >✕</button>
        </div>
        <div className="overflow-y-auto flex-1 px-7 py-6">{children}</div>
      </div>
    </div>
  );
}

// Confirm dialog
function ConfirmDialog({
  open, message, confirmLabel, confirmStyle, onConfirm, onCancel,
}: {
  open: boolean; message: string; confirmLabel: string;
  confirmStyle: string; onConfirm: () => void; onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-[#0f1117] border border-slate-200 dark:border-white/[0.10] shadow-2xl p-6 flex flex-col gap-4">
        <div className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">{message}</div>
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="px-4 py-2 rounded-lg text-xs font-semibold border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/5 transition cursor-pointer">
            Cancel
          </button>
          <button onClick={onConfirm} className={`px-4 py-2 rounded-lg text-xs font-semibold text-white border-none cursor-pointer transition ${confirmStyle}`}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function UserManagement() {
  const { user: currentUser } = useAuth();

  const [users,      setUsers]      = useState<User[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [search,     setSearch]     = useState("");
  const [filterRole, setFilterRole] = useState("all");

  // Add modal
  const [showAdd,    setShowAdd]    = useState(false);
  const [addForm,    setAddForm]    = useState<UserForm>({ name: "", username: "", email: "", role: "it_staff", password: "", status: "active" });
  const [addError,   setAddError]   = useState("");
  const [addLoading, setAddLoading] = useState(false);

  // Edit modal
  const [editUser,    setEditUser]    = useState<User | null>(null);
  const [editForm,    setEditForm]    = useState<EditForm>({ name: "", username: "", email: "", role: "", status: "active" });
  const [editError,   setEditError]   = useState("");
  const [editLoading, setEditLoading] = useState(false);

  // Reset password modal
  const [resetUser,    setResetUser]    = useState<User | null>(null);
  const [newPassword,  setNewPassword]  = useState("");
  const [confirmPw,    setConfirmPw]    = useState("");
  const [showPw,       setShowPw]       = useState(false);
  const [resetError,   setResetError]   = useState("");
  const [resetLoading, setResetLoading] = useState(false);

  // Delete confirm
  const [deleteTarget,  setDeleteTarget]  = useState<User | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Toast
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);
  const showToast = (msg: string, type: "success" | "error" = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    api.getUsers().then((result) => {
      if (result.success && result.data) setUsers(result.data.users ?? []);
      setLoading(false);
    });
  }, []);

  // ── Computed ──
  const filtered = users.filter((u) => {
    const q = search.toLowerCase();
    const matchSearch = !q || u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q) || (u.email ?? "").toLowerCase().includes(q);
    const matchRole = filterRole === "all" || u.role === filterRole;
    return matchSearch && matchRole;
  });

  const totalActive   = users.filter((u) => !u.status || u.status === "active").length;
  const totalInactive = users.filter((u) => u.status === "inactive").length;
  const roleGroups    = ["admin", "it_staff"].reduce((acc, r) => {
    acc[r] = users.filter((u) => u.role === r).length;
    return acc;
  }, {} as Record<string, number>);

  // ── Add user ──
  const handleAdd = async () => {
    if (!addForm.name.trim() || !addForm.username.trim() || !addForm.email.trim() || !addForm.password.trim()) {
      setAddError("Name, username, email, and password are required."); return;
    }
    if (addForm.password.length < 6) { setAddError("Password must be at least 6 characters."); return; }
    setAddLoading(true);
    const result = await api.createUser(addForm);
    if (result.success && result.data) {
      setUsers((prev) => [result.data.user, ...prev]);
      setAddForm({ name: "", username: "", email: "", role: "it_staff", password: "", status: "active" });
      setAddError("");
      setShowAdd(false);
      showToast("User created successfully.");
    } else {
      setAddError(result.error ?? "Failed to create user.");
    }
    setAddLoading(false);
  };

  // ── Open edit ──
  const openEdit = (u: User) => {
    setEditUser(u);
    setEditForm({ name: u.name, username: u.username, email: u.email ?? "", role: u.role, status: u.status ?? "active" });
    setEditError("");
  };

  // ── Save edit ──
  const handleEdit = async () => {
    if (!editUser) return;
    if (!editForm.name.trim() || !editForm.username.trim()) { setEditError("Name and username are required."); return; }
    setEditLoading(true);
    const result = await api.updateUser(editUser.id, editForm);
    if (result.success && result.data) {
      setUsers((prev) => prev.map((u) => (u.id === editUser.id ? result.data.user : u)));
      setEditUser(null);
      showToast("User updated successfully.");
    } else {
      setEditError(result.error ?? "Failed to update user.");
    }
    setEditLoading(false);
  };

  // ── Toggle status ──
  const handleToggleStatus = async (u: User) => {
    const newStatus: string = u.status === "inactive" ? "active" : "inactive";
    try {
      const result = await api.updateUserStatus(u.id, newStatus);
      if (result.success) {
        setUsers((p) => p.map((x) => (x.id === u.id ? { ...x, status: newStatus } : x)));
        showToast(`User ${newStatus === "active" ? "enabled" : "disabled"}.`);
      } else {
        showToast(result.error ?? "Failed to update user status.", "error");
      }
    } catch {
      showToast("Failed to update user status.", "error");
    }
  };

  // ── Reset password ──
  const openReset = (u: User) => {
    setResetUser(u);
    setNewPassword("");
    setConfirmPw("");
    setShowPw(false);
    setResetError("");
  };

  const handleReset = async () => {
    if (!resetUser) return;
    if (newPassword.length < 6) { setResetError("Password must be at least 6 characters."); return; }
    if (newPassword !== confirmPw) { setResetError("Passwords do not match."); return; }
    setResetLoading(true);
    const result = await api.resetPassword(resetUser.id, newPassword);
    if (result.success) {
      setResetUser(null);
      setNewPassword("");
      setConfirmPw("");
      showToast("Password reset successfully.");
    } else {
      setResetError(result.error ?? "Failed to reset password.");
    }
    setResetLoading(false);
  };

  // ── Delete ──
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await api.deleteUser(deleteTarget.id);
      setUsers((p) => p.filter((u) => u.id !== deleteTarget.id));
      showToast("User deleted.");
    } catch {
      showToast("Failed to delete user.", "error");
    }
    setDeleteTarget(null);
    setDeleteLoading(false);
  };

  const isProtected = (u: User) => u.id === 1 || String(u.id) === String(currentUser?.id);
  const isAdmin     = (u: User) => u.role === "admin";

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4 bg-white dark:bg-transparent relative">

      {/* ── Toast ── */}
      {toast && (
        <div className={`fixed top-5 right-5 z-[70] flex items-center gap-2 px-4 py-3 rounded-xl border text-xs font-mono shadow-xl transition-all ${
          toast.type === "success"
            ? "bg-green-100 dark:bg-green-500/10 border-green-300 dark:border-green-500/25 text-green-700 dark:text-green-400"
            : "bg-red-100 dark:bg-red-500/10 border-red-300 dark:border-red-500/25 text-red-700 dark:text-red-400"
        }`}>
          <span>{toast.type === "success" ? "✓" : "✕"}</span>
          {toast.msg}
        </div>
      )}

      {/* ── Header ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-mono text-slate-400 tracking-widest uppercase">
            {users.length} user{users.length !== 1 ? "s" : ""} · CSPC Server Monitoring System
          </div>
        </div>
        <button
          onClick={() => { setShowAdd(true); setAddError(""); }}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs border-none cursor-pointer transition-colors"
        >
          <span className="text-base leading-none">+</span> Add User
        </button>
      </div>

      {/* ── Stat cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatCard label="Total Users" value={users.length}             color="text-slate-900 dark:text-white" />
        <StatCard label="Active"      value={totalActive}              color="text-green-600 dark:text-green-400" />
        <StatCard label="Inactive"    value={totalInactive}            color="text-slate-500 dark:text-slate-400" />
        <StatCard label="Admins"      value={roleGroups["admin"] ?? 0} color="text-yellow-600 dark:text-yellow-400" />
      </div>

      {/* ── Role legend ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {(["admin", "it_staff"] as const).map((role) => {
          const cfg = roleCfg(role);
          return (
            <div key={role} className={`rounded-xl border ${cfg.border} p-3 bg-slate-50 dark:bg-white/[0.02]`}>
              <div className={`text-xs font-bold mb-1 ${cfg.color}`}>{cfg.label}</div>
              <div className="text-[10px] text-slate-400 leading-relaxed font-mono">
                {cfg.pages.map((p) => p.replace("-", " ")).join(" · ")}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Search + filter bar ── */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[180px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs pointer-events-none">⌕</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, username, email…"
            className="w-full pl-7 pr-3 py-1.5 text-xs font-mono rounded-lg border border-slate-200 dark:border-white/[0.08] bg-slate-50 dark:bg-white/[0.03] text-slate-900 dark:text-white placeholder-slate-400 focus:outline-none focus:border-blue-400 transition-colors"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-white text-xs cursor-pointer">✕</button>
          )}
        </div>

        <div className="h-5 w-px bg-slate-200 dark:bg-white/10" />

        {[
          { key: "all",      label: "All" },
          { key: "admin",    label: "Admin" },
          { key: "it_staff", label: "IT Staff" },
        ].map((f) => (
          <button
            key={f.key}
            onClick={() => setFilterRole(f.key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border cursor-pointer transition-all whitespace-nowrap ${
              filterRole === f.key
                ? "bg-blue-100 dark:bg-blue-500/20 border-blue-300 dark:border-blue-500/40 text-blue-600 dark:text-blue-400"
                : "bg-slate-100 dark:bg-white/[0.04] border-slate-200 dark:border-white/[0.07] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
            }`}
          >{f.label}</button>
        ))}
      </div>

      {/* ── Users table ── */}
      <div className="rounded-xl bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.08] overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 dark:border-white/[0.07] bg-slate-50 dark:bg-white/[0.02]">
          <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">
            {filtered.length} of {users.length} users
          </span>
        </div>

        {loading ? (
          <div className="text-center py-14 text-slate-400 text-sm font-mono">Loading...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-14 text-slate-400 dark:text-slate-600 font-mono text-xs">No users match the current filter.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {["User", "Username", "Email", "Role", "Status", "Last Login", "Actions"].map((h) => (
                    <th key={h} className="text-left px-4 py-2.5 text-[10px] font-mono text-slate-400 uppercase tracking-widest border-b border-slate-200 dark:border-white/[0.07] whitespace-nowrap bg-slate-50 dark:bg-white/[0.02]">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-200 dark:divide-white/[0.04]">
                {filtered.map((u) => (
                  <tr key={u.id} className="group hover:bg-slate-200/50 dark:hover:bg-white/[0.03] transition-colors">

                    {/* Avatar + Name */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-lg border overflow-hidden flex-shrink-0 ${avatarColor(u.role)}`}>
                          {u.profile_image ? (
                            <img src={`${API_URL}${u.profile_image}`} alt={u.name} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-xs font-bold font-mono">
                              {u.avatar || initials(u.name)}
                            </div>
                          )}
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-slate-900 dark:text-white leading-tight">
                            {u.name}
                            {isProtected(u) && (
                              <span className="ml-1.5 text-[9px] font-mono text-slate-400 bg-slate-200 dark:bg-white/[0.06] px-1.5 py-0.5 rounded">
                                {u.id === 1 ? "system" : "you"}
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] font-mono text-slate-400">#{String(u.id).padStart(3, "0")}</div>
                        </div>
                      </div>
                    </td>

                    <td className="px-4 py-3 font-mono text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">@{u.username}</td>
                    <td className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">
                      {u.email || <span className="text-slate-300 dark:text-slate-600">—</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap"><RoleBadge role={u.role} /></td>
                    <td className="px-4 py-3 whitespace-nowrap"><StatusBadge status={u.status} /></td>
                    <td className="px-4 py-3 font-mono text-[10px] text-slate-400 whitespace-nowrap">
                      {u.last_login
                        ? new Date(u.last_login).toLocaleDateString("en-PH", { month: "short", day: "2-digit", year: "numeric" })
                        : <span className="text-slate-300 dark:text-slate-600">Never</span>
                      }
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">

                        {/* Edit — hidden for admin accounts (they use ProfileModal) */}
                        {!isAdmin(u) && (
                          <button
                            onClick={() => openEdit(u)}
                            title="Edit user"
                            className="px-2.5 py-1 rounded-md text-[10px] font-semibold font-mono border border-slate-300 dark:border-white/[0.10] bg-white dark:bg-white/[0.04] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.08] hover:text-slate-900 dark:hover:text-white transition cursor-pointer whitespace-nowrap"
                          >
                            ✎ Edit
                          </button>
                        )}

                        {/* Reset password — shown for all */}
                        <button
                          onClick={() => openReset(u)}
                          title="Reset password"
                          className="px-2.5 py-1 rounded-md text-[10px] font-semibold font-mono border border-slate-300 dark:border-white/[0.10] bg-white dark:bg-white/[0.04] text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.08] hover:text-slate-900 dark:hover:text-white transition cursor-pointer whitespace-nowrap"
                        >
                          ⟳ Reset PW
                        </button>

                        {/* Enable / Disable — not for protected */}
                        {!isProtected(u) && (
                          <button
                            onClick={() => handleToggleStatus(u)}
                            title={u.status === "inactive" ? "Enable account" : "Disable account"}
                            className={`px-2.5 py-1 rounded-md text-[10px] font-semibold font-mono border transition cursor-pointer whitespace-nowrap ${
                              u.status === "inactive"
                                ? "border-green-300 dark:border-green-500/25 bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-500/20"
                                : "border-amber-300 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-500/20"
                            }`}
                          >
                            {u.status === "inactive" ? "⊕ Enable" : "⊘ Disable"}
                          </button>
                        )}

                        {/* Delete — not for protected */}
                        {!isProtected(u) && (
                          <button
                            onClick={() => setDeleteTarget(u)}
                            title="Delete user"
                            className="px-2.5 py-1 rounded-md text-[10px] font-semibold font-mono border border-red-300 dark:border-red-500/25 bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-500/20 transition cursor-pointer whitespace-nowrap"
                          >
                            ✕ Delete
                          </button>
                        )}

                        {isProtected(u) && isAdmin(u) && (
                          <span className="text-[10px] font-mono text-slate-300 dark:text-slate-600 px-1">Protected</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ══════════════════ MODALS ══════════════════ */}

      {/* ── Add User Modal ── */}
      <Modal title="Add New User" open={showAdd} onClose={() => setShowAdd(false)}>
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Full Name *</label>
              <input
                value={addForm.name}
                onChange={(e) => setAddForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="e.g. Juan dela Cruz"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Username *</label>
              <input
                value={addForm.username}
                onChange={(e) => setAddForm((p) => ({ ...p, username: e.target.value }))}
                placeholder="e.g. jdelacruz"
                className={inputCls}
              />
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Email *</label>
              <input
                value={addForm.email}
                onChange={(e) => setAddForm((p) => ({ ...p, email: e.target.value }))}
                placeholder="e.g. jdelacruz@cspc.edu.ph"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Role *</label>
              <SelectField
                value={addForm.role}
                onChange={(v) => setAddForm((p) => ({ ...p, role: v }))}
                options={[{ value: "it_staff", label: "IT Staff" }]}
              />
            </div>
            <div>
              <label className={labelCls}>Status</label>
              <SelectField
                value={addForm.status}
                onChange={(v) => setAddForm((p) => ({ ...p, status: v }))}
                options={[
                  { value: "active",   label: "Active" },
                  { value: "inactive", label: "Inactive" },
                ]}
              />
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Password *</label>
              <input
                type="password"
                value={addForm.password}
                onChange={(e) => setAddForm((p) => ({ ...p, password: e.target.value }))}
                placeholder="Min. 6 characters"
                className={inputCls}
              />
            </div>
          </div>

          {addError && (
            <div className="px-4 py-2.5 rounded-lg bg-red-100 dark:bg-red-500/10 border border-red-300 dark:border-red-500/25 text-red-600 dark:text-red-400 text-sm font-mono">
              {addError}
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button
              onClick={() => setShowAdd(false)}
              className="flex-1 px-4 py-3 rounded-lg text-sm font-semibold border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/5 transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={addLoading}
              className="flex-1 px-4 py-3 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white border-none cursor-pointer transition disabled:opacity-60"
            >
              {addLoading ? "Creating…" : "Create User"}
            </button>
          </div>
        </div>
      </Modal>

      {/* ── Edit User Modal ── */}
      <Modal title={`Edit User — ${editUser?.name ?? ""}`} open={!!editUser} onClose={() => setEditUser(null)}>
        <div className="flex flex-col gap-5">

          {/* Read-only info strip */}
          <div className="rounded-xl bg-slate-100 dark:bg-white/[0.04] border border-slate-200 dark:border-white/[0.07] px-4 py-3.5 flex gap-6 flex-wrap">
            {[
              ["ID",         `#${String(editUser?.id ?? "").padStart(3, "0")}`],
              ["Created",    editUser?.created_at  ? new Date(editUser.created_at).toLocaleDateString("en-PH")  : "—"],
              ["Last Login", editUser?.last_login   ? new Date(editUser.last_login).toLocaleDateString("en-PH")  : "Never"],
            ].map(([k, v]) => (
              <div key={k} className="flex flex-col gap-0.5">
                <span className="text-[9px] font-mono text-slate-400 uppercase tracking-widest">{k}</span>
                <span className="text-sm font-mono text-slate-600 dark:text-slate-300 font-semibold">{v}</span>
              </div>
            ))}
            <div className="ml-auto self-center text-[10px] font-mono text-slate-300 dark:text-slate-600 italic">Read-only</div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Full Name *</label>
              <input
                value={editForm.name}
                onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))}
                className={inputCls}
                placeholder="Full name"
              />
            </div>
            <div>
              <label className={labelCls}>Username *</label>
              <input
                value={editForm.username}
                onChange={(e) => setEditForm((p) => ({ ...p, username: e.target.value }))}
                className={inputCls}
                placeholder="Username"
              />
            </div>
            <div className="col-span-2">
              <label className={labelCls}>Email</label>
              <input
                value={editForm.email}
                onChange={(e) => setEditForm((p) => ({ ...p, email: e.target.value }))}
                className={inputCls}
                placeholder="Email address"
              />
            </div>
            <div>
              <label className={labelCls}>Role</label>
              {/* Role locked to IT Staff — admins use their own ProfileModal */}
              <SelectField
                value={editForm.role}
                onChange={(v) => setEditForm((p) => ({ ...p, role: v }))}
                options={[{ value: "it_staff", label: "IT Staff" }]}
              />
            </div>
            <div>
              <label className={labelCls}>Account Status</label>
              <SelectField
                value={editForm.status}
                onChange={(v) => setEditForm((p) => ({ ...p, status: v }))}
                options={[
                  { value: "active",   label: "Active" },
                  { value: "inactive", label: "Inactive" },
                ]}
              />
            </div>
          </div>

          {editError && (
            <div className="px-4 py-2.5 rounded-lg bg-red-100 dark:bg-red-500/10 border border-red-300 dark:border-red-500/25 text-red-600 dark:text-red-400 text-sm font-mono">
              {editError}
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button
              onClick={() => setEditUser(null)}
              className="flex-1 px-4 py-3 rounded-lg text-sm font-semibold border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/5 transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleEdit}
              disabled={editLoading}
              className="flex-1 px-4 py-3 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white border-none cursor-pointer transition disabled:opacity-60"
            >
              {editLoading ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </div>
      </Modal>

      {/* ── Reset Password Modal ── */}
      <Modal title={`Reset Password — ${resetUser?.name ?? ""}`} open={!!resetUser} onClose={() => setResetUser(null)}>
        <div className="flex flex-col gap-5">

          <div className="px-4 py-3 rounded-xl bg-amber-100 dark:bg-amber-500/10 border border-amber-300 dark:border-amber-500/25 text-amber-700 dark:text-amber-400 text-sm font-mono leading-relaxed">
            This will immediately change the password for <strong>{resetUser?.username}</strong>. The user will need to log in again.
          </div>

          <div>
            <label className={labelCls}>New Password *</label>
            <div className="relative">
              <input
                type={showPw ? "text" : "password"}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Min. 6 characters"
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

          <div>
            <label className={labelCls}>Confirm Password *</label>
            <input
              type={showPw ? "text" : "password"}
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              placeholder="Re-enter password"
              className={inputCls}
            />
            {confirmPw && (
              <div className={`text-[11px] font-mono mt-2 ${newPassword === confirmPw ? "text-green-500" : "text-red-400"}`}>
                {newPassword === confirmPw ? "✓ Passwords match" : "✕ Passwords do not match"}
              </div>
            )}
          </div>

          {/* Strength bars */}
          {newPassword && (
            <div className="flex gap-1.5 items-center">
              {[6, 8, 12].map((threshold, i) => (
                <div key={i} className={`h-1.5 flex-1 rounded-full transition-colors ${
                  newPassword.length >= threshold
                    ? i === 0 ? "bg-red-400" : i === 1 ? "bg-amber-400" : "bg-green-400"
                    : "bg-slate-200 dark:bg-white/10"
                }`} />
              ))}
              <span className="text-[11px] font-mono text-slate-400 ml-1 w-16">
                {newPassword.length < 6 ? "Too short" : newPassword.length < 8 ? "Weak" : newPassword.length < 12 ? "Fair" : "Strong"}
              </span>
            </div>
          )}

          {resetError && (
            <div className="px-4 py-2.5 rounded-lg bg-red-100 dark:bg-red-500/10 border border-red-300 dark:border-red-500/25 text-red-600 dark:text-red-400 text-sm font-mono">
              {resetError}
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button
              onClick={() => setResetUser(null)}
              className="flex-1 px-4 py-3 rounded-lg text-sm font-semibold border border-slate-200 dark:border-white/10 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/5 transition cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleReset}
              disabled={resetLoading}
              className="flex-1 px-4 py-3 rounded-lg text-sm font-semibold bg-amber-500 hover:bg-amber-400 text-white border-none cursor-pointer transition disabled:opacity-60"
            >
              {resetLoading ? "Resetting…" : "Reset Password"}
            </button>
          </div>
        </div>
      </Modal>

      {/* ── Delete Confirm ── */}
      <ConfirmDialog
        open={!!deleteTarget}
        message={`Are you sure you want to delete "${deleteTarget?.name}" (@${deleteTarget?.username})? This action cannot be undone.`}
        confirmLabel={deleteLoading ? "Deleting…" : "Delete User"}
        confirmStyle="bg-red-600 hover:bg-red-500"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

    </div>
  );
}