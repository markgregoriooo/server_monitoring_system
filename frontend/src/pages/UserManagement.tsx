import { useState, useEffect, useRef } from "react";
import { api } from "../api/api";
import { roleConfig } from "../data/users";
import { useAuth } from "../context/AuthContext";
import { socket } from "../socket/socket";
import { avatarUrl } from "../utils/format";

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

interface EditForm {
  name: string;
  username: string;
  email: string;
  role: string;
  status: string;
}

// A Google self-registration awaiting admin approval.
interface PendingUser {
  id: number;
  name: string;
  username: string;
  email: string;
  avatar?: string;
  profile_image?: string;
  created_at?: string;
}

// ─── Grafana status colors ────────────────────────────────────────────────────

const GREEN = "#73BF69";
const ORANGE = "#FF780A";
const RED = "#F2495C";
const BLUE = "#5794F2";
const GOLD = "#F5C400";
const GREY = "#6B7280";

const ROLE_COLOR: Record<string, string> = { admin: GOLD, it_staff: BLUE };
const roleColor = (r: string) => ROLE_COLOR[r] ?? GREY;

const STATUS_INACTIVE = { label: "Inactive", color: GREY };
const STATUS: Record<string, { label: string; color: string }> = {
  active:   { label: "Active",   color: GREEN },
  inactive: STATUS_INACTIVE,
  pending:  { label: "Pending",  color: ORANGE },
  rejected: { label: "Rejected", color: RED },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function initials(name: string) {
  return name.split(" ").map((w) => w[0]).join("").toUpperCase().slice(0, 2);
}

function roleCfg(role: string) {
  return roleConfig[role as keyof typeof roleConfig] ?? {
    label: role, color: "", bg: "", border: "", pages: [],
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

// Grafana status/role pill (tinted background + dot).
function Pill({ color, dot, children }: { color: string; dot?: boolean; children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[2px] text-[10px] font-semibold whitespace-nowrap"
      style={{ color, background: `${color}1A`, border: `1px solid ${color}40` }}
    >
      {dot && <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />}
      {children}
    </span>
  );
}

function RoleBadge({ role }: { role: string }) {
  return <Pill color={roleColor(role)}>{roleCfg(role).label}</Pill>;
}

function StatusBadge({ status, lastLogin }: { status?: string; lastLogin?: string | null | undefined }) {
  // An approved (active) account that has never signed in shows as "Invited"
  // rather than green "Active" — it's enabled, but the user hasn't logged in yet.
  // (Disabled accounts still read "Inactive" regardless, so the two stay distinct.)
  if ((status === "active" || !status) && !lastLogin) {
    return <Pill color={BLUE} dot>Invited</Pill>;
  }
  const s = STATUS[status || "active"] ?? STATUS_INACTIVE;
  return <Pill color={s.color} dot>{s.label}</Pill>;
}

function StatPanel({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="p-3 rounded-[2px] bg-[var(--gf-panel)] border border-[var(--gf-panel-border)]">
      <div className="text-[9px] uppercase tracking-widest mb-1.5 text-[var(--gf-text-muted)]">{label}</div>
      <div className="text-2xl font-bold leading-none" style={{ color }}>{value}</div>
    </div>
  );
}

// Grafana panel chrome (optional 32px header strip).
function Panel({
  title, right, children, noPad,
}: {
  title?: string; right?: React.ReactNode; children: React.ReactNode; noPad?: boolean;
}) {
  return (
    <div className="rounded-[2px] overflow-hidden bg-[var(--gf-panel)] border border-[var(--gf-panel-border)]">
      {title !== undefined && (
        <div className="flex items-center justify-between px-3 border-b border-[var(--gf-divider)]" style={{ height: 32 }}>
          <span className="text-[11px] font-medium tracking-widest uppercase text-[var(--gf-text-muted)]">{title}</span>
          {right}
        </div>
      )}
      <div style={{ padding: noPad ? 0 : 12 }}>{children}</div>
    </div>
  );
}

// ─── Shared input/label classes (Grafana tokens) ──────────────────────────────

const inputCls =
  "w-full px-3 py-2.5 rounded-[2px] text-sm font-mono outline-none transition " +
  "bg-[var(--gf-bg)] border border-[var(--gf-panel-border)] text-[var(--gf-text-primary)] " +
  "placeholder-[var(--gf-text-dim)] focus:border-[var(--gf-accent)]";

const labelCls =
  "block text-[10px] font-semibold uppercase tracking-widest mb-1.5 text-[var(--gf-text-muted)]";

// ─── SelectField ──────────────────────────────────────────────────────────────

function SelectField({
  value, onChange, options, className = "",
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
        className={`${inputCls} appearance-none cursor-pointer pr-8 ${className}`}
        style={{ colorScheme: "dark" }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--gf-text-muted)] text-xs select-none">
        ▾
      </span>
    </div>
  );
}

// ─── Modal ────────────────────────────────────────────────────────────────────

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div
        ref={ref}
        className="w-full max-w-2xl rounded-[2px] bg-[var(--gf-panel)] border border-[var(--gf-panel-border)] shadow-2xl flex flex-col max-h-[92vh] overflow-hidden"
        style={{ fontFamily: "'JetBrains Mono', monospace" }}
      >
        <div className="flex items-center justify-between px-5 sm:px-6 border-b border-[var(--gf-divider)] flex-shrink-0" style={{ height: 44 }}>
          <span className="text-[13px] font-semibold tracking-wide text-[var(--gf-text-primary)]">{title}</span>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded-[2px] text-[var(--gf-text-muted)] hover:text-[var(--gf-text-primary)] hover:bg-[var(--gf-hover)] transition cursor-pointer"
          >✕</button>
        </div>
        <div className="overflow-y-auto flex-1 px-5 sm:px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

// Confirm dialog
function ConfirmDialog({
  open, message, confirmLabel, confirmColor, onConfirm, onCancel,
}: {
  open: boolean; message: string; confirmLabel: string;
  confirmColor: string; onConfirm: () => void; onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div
        className="w-full max-w-sm rounded-[2px] bg-[var(--gf-panel)] border border-[var(--gf-panel-border)] shadow-2xl p-5 flex flex-col gap-4"
        style={{ fontFamily: "'JetBrains Mono', monospace" }}
      >
        <div className="text-[13px] text-[var(--gf-text-primary)] leading-relaxed">{message}</div>
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="px-4 py-2 rounded-[2px] text-xs font-semibold border border-[var(--gf-panel-border)] text-[var(--gf-text-muted)] hover:bg-[var(--gf-hover)] transition cursor-pointer">
            Cancel
          </button>
          <button onClick={onConfirm} className="px-4 py-2 rounded-[2px] text-xs font-semibold text-white border-none cursor-pointer transition hover:opacity-90" style={{ background: confirmColor }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Small action button used in the table actions cell.
function ActionBtn({
  onClick, title, color, children,
}: {
  onClick: () => void; title: string; color?: string; children: React.ReactNode;
}) {
  const c = color ?? "var(--gf-text-muted)";
  return (
    <button
      onClick={onClick}
      title={title}
      className="px-2.5 py-1 rounded-[2px] text-[10px] font-semibold transition cursor-pointer whitespace-nowrap hover:opacity-80"
      style={{ color: c, border: `1px solid ${color ? `${color}40` : "var(--gf-panel-border)"}`, background: color ? `${color}14` : "transparent" }}
    >
      {children}
    </button>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function UserManagement() {
  const { user: currentUser } = useAuth();

  const [users,      setUsers]      = useState<User[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [search,     setSearch]     = useState("");
  const [filterRole, setFilterRole] = useState("all");

  // Pending registrations (Google self-register → admin approve/reject)
  const [pending,      setPending]      = useState<PendingUser[]>([]);
  const [pendingRoles, setPendingRoles] = useState<Record<number, string>>({});
  const [pendingBusy,  setPendingBusy]  = useState<number | null>(null);

  // Edit modal
  const [editUser,    setEditUser]    = useState<User | null>(null);
  const [editForm,    setEditForm]    = useState<EditForm>({ name: "", username: "", email: "", role: "", status: "active" });
  const [editError,   setEditError]   = useState("");
  const [editLoading, setEditLoading] = useState(false);

  // Delete confirm
  const [deleteTarget,  setDeleteTarget]  = useState<User | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Toast
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);
  const showToast = (msg: string, type: "success" | "error" = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const reloadUsers = () =>
    api.getUsers().then((result) => {
      if (result.success && result.data) setUsers(result.data.users ?? []);
    });

  useEffect(() => {
    reloadUsers().then(() => setLoading(false));
  }, []);

  // ── Pending registrations: initial load + live updates ──
  const loadPending = () =>
    api.getPendingUsers().then((r) => {
      if (r.success && r.data) setPending(r.data.pending ?? []);
    });

  useEffect(() => {
    loadPending();
    const onPending = () => loadPending();              // new request / reject
    const onApproved = () => { loadPending(); reloadUsers(); };
    socket.on("userPending", onPending);
    socket.on("userApproved", onApproved);
    return () => {
      socket.off("userPending", onPending);
      socket.off("userApproved", onApproved);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const roleFor = (id: number) => pendingRoles[id] ?? "it_staff";

  const handleApprove = async (p: PendingUser) => {
    setPendingBusy(p.id);
    const role = roleFor(p.id);
    const r = await api.approveUser(p.id, role);
    if (r.success) {
      setPending((prev) => prev.filter((x) => x.id !== p.id));
      reloadUsers();
      showToast(`${p.name} approved as ${role === "admin" ? "Admin" : "IT Staff"}.`);
    } else {
      showToast(r.error ?? "Failed to approve user.", "error");
    }
    setPendingBusy(null);
  };

  const handleReject = async (p: PendingUser) => {
    setPendingBusy(p.id);
    const r = await api.rejectUser(p.id);
    if (r.success) {
      setPending((prev) => prev.filter((x) => x.id !== p.id));
      showToast(`${p.name}'s request was rejected.`);
    } else {
      showToast(r.error ?? "Failed to reject user.", "error");
    }
    setPendingBusy(null);
  };

  // ── Computed ──
  const filtered = users.filter((u) => {
    const q = search.toLowerCase();
    const matchSearch = !q || u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q) || (u.email ?? "").toLowerCase().includes(q);
    const matchRole = filterRole === "all" || u.role === filterRole;
    // Pending registrations live in their own approval panel, not the user table.
    return matchSearch && matchRole && u.status !== "pending";
  });

  const totalActive   = users.filter((u) => !u.status || u.status === "active").length;
  const totalInactive = users.filter((u) => u.status === "inactive").length;
  const roleGroups    = ["admin", "it_staff"].reduce((acc, r) => {
    acc[r] = users.filter((u) => u.role === r).length;
    return acc;
  }, {} as Record<string, number>);

  // ── Open edit ──
  const openEdit = (u: User) => {
    setEditUser(u);
    setEditForm({ name: u.name, username: u.username, email: u.email ?? "", role: u.role, status: u.status ?? "active" });
    setEditError("");
  };

  // ── Save edit ──
  // Only username / role / status are sent. name + email come from the user's Google
  // account and are re-synced on their next sign-in, so editing them here would revert.
  const handleEdit = async () => {
    if (!editUser) return;
    if (!editForm.username.trim()) { setEditError("Username is required."); return; }
    setEditLoading(true);
    const result = await api.updateUser(editUser.id, {
      username: editForm.username,
      role: editForm.role,
      status: editForm.status,
    });
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
    // Invert on "can sign in", not on the literal "inactive". The old check sent a
    // REJECTED user to 'inactive' (offering "Disable" on an account that was
    // already blocked); now it enables them, which is the un-reject path.
    const newStatus: string = isEnabled(u) ? "inactive" : "active";
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

  // ── Delete ──
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    const result = await api.deleteUser(deleteTarget.id);
    if (result.success) {
      setUsers((p) => p.filter((u) => u.id !== deleteTarget.id));
      showToast("User deleted.");
      setDeleteTarget(null);
    } else {
      showToast(result.error ?? "Failed to delete user.", "error");
    }
    setDeleteLoading(false);
  };

  // Mirrors the server-side guard: never offer actions that would remove the last
  // active admin, and never let you act on your own account. (The backend in
  // userService.js is the authoritative boundary; this just hides dead buttons.)
  const activeAdminCount = users.filter(
    (u) => u.role === "admin" && (u.status ?? "active") === "active",
  ).length;
  const isSelf            = (u: User) => String(u.id) === String(currentUser?.id);
  const isLastActiveAdmin = (u: User) =>
    u.role === "admin" && (u.status ?? "active") === "active" && activeAdminCount <= 1;
  const isProtected = (u: User) => isSelf(u) || isLastActiveAdmin(u);
  const isAdmin     = (u: User) => u.role === "admin";
  // "Can this account currently sign in?" — a null status counts as active, matching
  // the stat cards and StatusBadge. Everything else (inactive AND rejected) is off,
  // so the Enable/Disable control points the right way for a rejected registration.
  const isEnabled   = (u: User) => !u.status || u.status === "active";

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div
      className="p-3 sm:p-4 lg:p-5 flex flex-col gap-3 relative"
      style={{ background: "var(--gf-bg)", minHeight: "100%", fontFamily: "'JetBrains Mono', monospace" }}
    >
      {/* ── Toast ── */}
      {toast && (
        <div
          className="fixed top-5 right-5 z-[70] flex items-center gap-2 px-4 py-3 rounded-[2px] border text-xs shadow-xl"
          style={{
            color: toast.type === "success" ? GREEN : RED,
            background: `${toast.type === "success" ? GREEN : RED}14`,
            borderColor: `${toast.type === "success" ? GREEN : RED}40`,
          }}
        >
          <span>{toast.type === "success" ? "✓" : "✕"}</span>
          {toast.msg}
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className="flex items-baseline gap-2 min-w-0 px-0.5">
        <h1 className="text-[15px] font-semibold truncate text-[var(--gf-text-primary)]">User Management</h1>
        <span className="text-[11px] hidden sm:inline text-[var(--gf-text-dim)]">
          {users.length} user{users.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* ── Stat cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <StatPanel label="Total Users" value={users.length}             color="var(--gf-text-primary)" />
        <StatPanel label="Active"      value={totalActive}              color={GREEN} />
        <StatPanel label="Inactive"    value={totalInactive}            color={GREY} />
        <StatPanel label="Admins"      value={roleGroups["admin"] ?? 0} color={GOLD} />
      </div>

      {/* ── Role legend ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        {(["admin", "it_staff"] as const).map((role) => {
          const cfg = roleCfg(role);
          const c = roleColor(role);
          return (
            <div key={role} className="rounded-[2px] p-3 bg-[var(--gf-panel)] border border-[var(--gf-panel-border)]">
              <div className="text-xs font-bold mb-1 flex items-center gap-1.5" style={{ color: c }}>
                <span className="w-1.5 h-1.5 rounded-full" style={{ background: c }} />
                {cfg.label}
              </div>
              <div className="text-[10px] leading-relaxed text-[var(--gf-text-dim)]">
                {cfg.pages.map((p) => p.replace("-", " ")).join(" · ")}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Pending registrations (Google self-register → approve / reject) ── */}
      {pending.length > 0 && (
        <div className="rounded-[2px] overflow-hidden" style={{ background: `${ORANGE}0F`, border: `1px solid ${ORANGE}3B` }}>
          <div className="flex items-center gap-2 px-3 py-2.5" style={{ borderBottom: `1px solid ${ORANGE}29` }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: ORANGE }} />
            <span className="text-xs font-semibold" style={{ color: ORANGE }}>
              Pending registrations · {pending.length}
            </span>
            <span className="text-[10px] ml-1" style={{ color: `${ORANGE}B0` }}>awaiting your approval</span>
          </div>
          <div className="flex flex-col">
            {pending.map((p) => (
              <div key={p.id} className="flex flex-col sm:flex-row sm:items-center gap-3 px-3 py-3" style={{ borderTop: `1px solid ${ORANGE}1F` }}>
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div className="w-8 h-8 rounded-[2px] flex items-center justify-center text-xs font-bold flex-shrink-0 overflow-hidden" style={{ background: `${ORANGE}1A`, color: ORANGE, border: `1px solid ${ORANGE}40` }}>
                    {p.profile_image
                      ? <img src={avatarUrl(p.profile_image) ?? ""} alt={p.name} referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                      : (p.avatar || initials(p.name))}
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-semibold truncate text-[var(--gf-text-primary)]">{p.name}</div>
                    <div className="text-[10px] truncate text-[var(--gf-text-muted)]">{p.email}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <SelectField
                    value={roleFor(p.id)}
                    onChange={(v) => setPendingRoles((m) => ({ ...m, [p.id]: v }))}
                    options={[
                      { value: "it_staff", label: "IT Staff" },
                      { value: "admin",    label: "Admin" },
                    ]}
                    className="!py-1.5 !w-32"
                  />
                  <button
                    onClick={() => handleApprove(p)}
                    disabled={pendingBusy === p.id}
                    className="px-3 py-1.5 rounded-[2px] text-[11px] font-semibold text-white border-none cursor-pointer transition hover:opacity-90 disabled:opacity-60 whitespace-nowrap"
                    style={{ background: GREEN }}
                  >
                    {pendingBusy === p.id ? "…" : "✓ Approve"}
                  </button>
                  <button
                    onClick={() => handleReject(p)}
                    disabled={pendingBusy === p.id}
                    className="px-3 py-1.5 rounded-[2px] text-[11px] font-semibold border border-[var(--gf-panel-border)] text-[var(--gf-text-muted)] hover:bg-[var(--gf-hover)] cursor-pointer transition disabled:opacity-60 whitespace-nowrap"
                  >
                    ✕ Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Search + filter bar ── */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[180px]">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--gf-text-muted)] text-xs pointer-events-none">⌕</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, username, email…"
            className="w-full pl-7 pr-3 py-1.5 text-xs rounded-[2px] bg-[var(--gf-panel)] border border-[var(--gf-panel-border)] text-[var(--gf-text-primary)] placeholder-[var(--gf-text-dim)] outline-none focus:border-[var(--gf-accent)] transition"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--gf-text-muted)] hover:text-[var(--gf-text-primary)] text-xs cursor-pointer">✕</button>
          )}
        </div>

        <div className="h-5 w-px bg-[var(--gf-divider)]" />

        {[
          { key: "all",      label: "All" },
          { key: "admin",    label: "Admin" },
          { key: "it_staff", label: "IT Staff" },
        ].map((f) => {
          const active = filterRole === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setFilterRole(f.key)}
              className="px-3 py-1.5 rounded-[2px] text-xs font-semibold border cursor-pointer transition whitespace-nowrap"
              style={
                active
                  ? { color: "var(--gf-accent)", background: "var(--gf-accent-dim)", borderColor: "var(--gf-accent)" }
                  : { color: "var(--gf-text-muted)", background: "var(--gf-panel)", borderColor: "var(--gf-panel-border)" }
              }
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {/* ── Users table ── */}
      <Panel
        title="Accounts"
        noPad
        right={<span className="text-[10px] text-[var(--gf-text-dim)]">{filtered.length} of {users.length}</span>}
      >
        {loading ? (
          <div className="text-center py-14 text-[var(--gf-text-muted)] text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-14 text-[var(--gf-text-dim)] text-xs">No users match the current filter.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {["User", "Username", "Email", "Role", "Status", "Last Login", "Actions"].map((h) => (
                    <th key={h} className="text-left px-4 py-2.5 text-[9px] uppercase tracking-widest font-medium border-b border-[var(--gf-divider)] whitespace-nowrap text-[var(--gf-text-dim)]">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {filtered.map((u) => (
                  <tr key={u.id} className="border-b border-[var(--gf-divider)] hover:bg-[var(--gf-hover)] transition-colors">

                    {/* Avatar + Name */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-[2px] overflow-hidden flex-shrink-0 flex items-center justify-center text-xs font-bold" style={{ background: `${roleColor(u.role)}1A`, color: roleColor(u.role), border: `1px solid ${roleColor(u.role)}40` }}>
                          {u.profile_image ? (
                            <img src={avatarUrl(u.profile_image) ?? ""} alt={u.name} referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                          ) : (
                            u.avatar || initials(u.name)
                          )}
                        </div>
                        <div>
                          <div className="text-xs font-semibold leading-tight text-[var(--gf-text-primary)]">
                            {u.name}
                            {isProtected(u) && (
                              <span className="ml-1.5 text-[9px] text-[var(--gf-text-muted)] bg-[var(--gf-hover)] px-1.5 py-0.5 rounded-[2px]">
                                {isLastActiveAdmin(u) ? "last admin" : "you"}
                              </span>
                            )}
                          </div>
                          <div className="text-[10px] text-[var(--gf-text-dim)]">#{String(u.id).padStart(3, "0")}</div>
                        </div>
                      </div>
                    </td>

                    <td className="px-4 py-3 text-xs text-[var(--gf-text-muted)] whitespace-nowrap">@{u.username}</td>
                    <td className="px-4 py-3 text-xs text-[var(--gf-text-muted)] whitespace-nowrap">
                      {u.email || <span className="text-[var(--gf-text-dim)]">—</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap"><RoleBadge role={u.role} /></td>
                    <td className="px-4 py-3 whitespace-nowrap"><StatusBadge status={u.status} lastLogin={u.last_login} /></td>
                    <td className="px-4 py-3 text-[10px] text-[var(--gf-text-muted)] whitespace-nowrap">
                      {u.last_login
                        ? new Date(u.last_login).toLocaleDateString("en-PH", { month: "short", day: "2-digit", year: "numeric" })
                        : <span className="text-[var(--gf-text-dim)]">Never</span>
                      }
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        {!isSelf(u) && (
                          <ActionBtn onClick={() => openEdit(u)} title="Edit user">✎ Edit</ActionBtn>
                        )}
                        {!isProtected(u) && (
                          <ActionBtn
                            onClick={() => handleToggleStatus(u)}
                            title={isEnabled(u) ? "Disable account" : "Enable account"}
                            color={isEnabled(u) ? ORANGE : GREEN}
                          >
                            {isEnabled(u) ? "⊘ Disable" : "⊕ Enable"}
                          </ActionBtn>
                        )}
                        {!isProtected(u) && (
                          <ActionBtn onClick={() => setDeleteTarget(u)} title="Delete user" color={RED}>✕ Delete</ActionBtn>
                        )}
                        {isProtected(u) && isAdmin(u) && (
                          <span className="text-[10px] text-[var(--gf-text-dim)] px-1">Protected</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* ══════════════════ MODALS ══════════════════ */}

      {/* ── Edit User Modal ── */}
      <Modal title={`Edit User — ${editUser?.name ?? ""}`} open={!!editUser} onClose={() => setEditUser(null)}>
        <div className="flex flex-col gap-5">

          {/* Read-only info strip */}
          <div className="rounded-[2px] bg-[var(--gf-bg)] border border-[var(--gf-panel-border)] px-4 py-3.5 flex gap-6 flex-wrap">
            {[
              ["ID",         `#${String(editUser?.id ?? "").padStart(3, "0")}`],
              ["Created",    editUser?.created_at  ? new Date(editUser.created_at).toLocaleDateString("en-PH")  : "—"],
              ["Last Login", editUser?.last_login   ? new Date(editUser.last_login).toLocaleDateString("en-PH")  : "Never"],
            ].map(([k, v]) => (
              <div key={k} className="flex flex-col gap-0.5">
                <span className="text-[9px] uppercase tracking-widest text-[var(--gf-text-dim)]">{k}</span>
                <span className="text-sm font-semibold text-[var(--gf-text-primary)]">{v}</span>
              </div>
            ))}
            <div className="ml-auto self-center text-[10px] italic text-[var(--gf-text-dim)]">Read-only</div>
          </div>

          {/* Name + email are owned by Google and re-synced on the user's next sign-in,
              so they're shown read-only — editing them here would silently revert. */}
          <div className="rounded-[2px] bg-[var(--gf-bg)] border border-[var(--gf-panel-border)] px-4 py-3 flex flex-col gap-2">
            <div className="flex gap-8 flex-wrap">
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-[9px] uppercase tracking-widest text-[var(--gf-text-dim)]">Full Name</span>
                <span className="text-sm font-semibold text-[var(--gf-text-primary)] truncate">{editUser?.name ?? "—"}</span>
              </div>
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-[9px] uppercase tracking-widest text-[var(--gf-text-dim)]">Email</span>
                <span className="text-sm font-semibold text-[var(--gf-text-primary)] truncate">{editUser?.email ?? "—"}</span>
              </div>
            </div>
            <span className="text-[10px] text-[var(--gf-text-dim)] leading-relaxed">
              From this user's CSPC Google account — refreshed on each sign-in, so not editable here.
            </span>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className={labelCls}>Username *</label>
              <input value={editForm.username} onChange={(e) => setEditForm((p) => ({ ...p, username: e.target.value }))} className={inputCls} placeholder="Username" />
            </div>
            <div>
              <label className={labelCls}>Role</label>
              <SelectField value={editForm.role} onChange={(v) => setEditForm((p) => ({ ...p, role: v }))} options={[{ value: "it_staff", label: "IT Staff" }, { value: "admin", label: "Admin" }]} />
            </div>
            <div>
              <label className={labelCls}>Account Status</label>
              <SelectField
                value={editForm.status}
                onChange={(v) => setEditForm((p) => ({ ...p, status: v }))}
                options={[
                  { value: "active",   label: "Active" },
                  { value: "inactive", label: "Inactive" },
                  // A rejected registration has no matching option, so the select
                  // renders BLANK and hides the account's real state. Keep the entry
                  // (only while it applies) so the status is visible and an admin can
                  // switch to Active — undoing an accidental reject without having to
                  // delete the row and lose the audit trail.
                  ...(editForm.status === "rejected"
                    ? [{ value: "rejected", label: "Rejected" }]
                    : []),
                ]}
              />
            </div>
          </div>

          {editError && (
            <div className="px-4 py-2.5 rounded-[2px] text-sm" style={{ color: RED, background: `${RED}14`, border: `1px solid ${RED}40` }}>{editError}</div>
          )}

          <div className="flex gap-3 pt-1">
            <button onClick={() => setEditUser(null)} className="flex-1 px-4 py-2.5 rounded-[2px] text-sm font-semibold border border-[var(--gf-panel-border)] text-[var(--gf-text-muted)] hover:bg-[var(--gf-hover)] transition cursor-pointer">Cancel</button>
            <button onClick={handleEdit} disabled={editLoading} className="flex-1 px-4 py-2.5 rounded-[2px] text-sm font-semibold text-white border-none cursor-pointer transition hover:opacity-90 disabled:opacity-60" style={{ background: "var(--gf-accent)" }}>
              {editLoading ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </div>
      </Modal>

      {/* ── Delete Confirm ── */}
      <ConfirmDialog
        open={!!deleteTarget}
        message={`Are you sure you want to delete "${deleteTarget?.name}" (@${deleteTarget?.username})? This action cannot be undone.`}
        confirmLabel={deleteLoading ? "Deleting…" : "Delete User"}
        confirmColor={RED}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

    </div>
  );
}
