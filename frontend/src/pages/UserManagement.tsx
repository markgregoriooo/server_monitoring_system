import { useState, useEffect, useRef } from "react";
import { api } from "../api/api";
import { roleConfig } from "../data/users";
import { useAuth } from "../context/AuthContext";
import { socket } from "../socket/socket";
import { avatarUrl } from "../utils/format";
// Aliased: this file already owns a `STATUS` map (user account states, line ~53),
// which is a different idea entirely from the design system's status palette.
import { STATUS as PALETTE } from "../theme/gf";
const { green: GREEN, orange: ORANGE, red: RED, blue: BLUE } = PALETTE;

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

// Status/role pill (tinted background + dot). `neutral` keeps it grey and lets the dot
// carry the colour, so the column stays calm.
function Pill({
  color, dot, neutral, children,
}: { color: string; dot?: boolean; neutral?: boolean; children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[2px] text-[12px] font-semibold whitespace-nowrap"
      style={
        neutral
          ? {
              color: "var(--gf-text-primary)",
              background: "var(--gf-hover)",
              border: "1px solid var(--gf-panel-border)",
            }
          : { color, background: `${color}1A`, border: `1px solid ${color}40` }
      }
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
  // An active account that has never signed in shows as "Invited" rather than "Active".
  // Disabled accounts still show "Inactive".
  if ((status === "active" || !status) && !lastLogin) {
    return <Pill color={BLUE} dot neutral>Invited</Pill>;
  }
  const s = STATUS[status || "active"] ?? STATUS_INACTIVE;
  return <Pill color={s.color} dot neutral>{s.label}</Pill>;
}

// `sub` is what is not in the headline number: invited accounts under Active, pending
// registrations under Total.
function StatPanel({ label, value, color, sub }: { label: string; value: number; color: string; sub?: string }) {
  return (
    <div className="p-3 rounded-[2px] bg-[var(--gf-panel)] border border-[var(--gf-panel-border)]">
      <div className="text-[11px] uppercase tracking-widest mb-1.5 text-[var(--gf-text-muted)]">{label}</div>
      <div className="text-2xl font-bold leading-none" style={{ color }}>{value}</div>
      {sub && <div className="text-[11px] mt-1 leading-tight text-[var(--gf-text-dim)]">{sub}</div>}
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
          <span className="text-[13px] font-medium tracking-widest uppercase text-[var(--gf-text-muted)]">{title}</span>
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
  "block text-[12px] font-semibold uppercase tracking-widest mb-1.5 text-[var(--gf-text-muted)]";

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
      <select name="value"
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
          <span className="text-[15px] font-semibold tracking-wide text-[var(--gf-text-primary)]">{title}</span>
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
        <div className="text-[15px] text-[var(--gf-text-primary)] leading-relaxed">{message}</div>
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="gf-btn px-4 py-2 rounded-[2px] text-xs font-semibold border border-[var(--gf-panel-border)] text-[var(--gf-text-muted)] hover:bg-[var(--gf-hover)] transition cursor-pointer">
            Cancel
          </button>
          <button onClick={onConfirm} className="gf-raise px-4 py-2 rounded-[2px] text-xs font-semibold text-white border-none cursor-pointer transition hover:opacity-90" style={{ background: confirmColor }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Small button for the actions cell. All row actions share one neutral raised surface
// (.gf-btn); `danger` only colours the label, so Delete still reads as destructive.
function ActionBtn({
  onClick, title, danger, children,
}: {
  onClick: () => void; title: string; danger?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="gf-btn px-2.5 py-1 text-[12px] font-semibold cursor-pointer whitespace-nowrap"
      style={{ color: danger ? "var(--gf-danger)" : "var(--gf-text-primary)" }}
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
      const label = role === "admin" ? "Admin" : "IT Staff";
      /* The approval email is the only way the person learns their account works. If it was
         not sent, say so clearly (error style, even though the approval succeeded) so the
         admin can tell them another way. */
      if (r.data?.emailed === false) {
        showToast(`${p.name} approved as ${label}, but the email could not be sent — tell them directly.`, "error");
      } else {
        showToast(`${p.name} approved as ${label}. Notification email sent.`);
      }
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
      if (r.data?.emailed === false) {
        showToast(`${p.name}'s request was rejected, but the email could not be sent.`, "error");
      } else {
        showToast(`${p.name}'s request was rejected. They have been notified.`);
      }
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

  // "Active" is counted two ways: the headline counts people who have signed in, and
  // approved accounts that never signed in are listed as invited underneath, matching
  // the table's "Invited" badge.
  const isActiveRow   = (u: User) => !u.status || u.status === "active";
  const signedIn      = users.filter((u) => isActiveRow(u) && u.last_login).length;
  const invited       = users.filter((u) => isActiveRow(u) && !u.last_login).length;
  const totalInactive = users.filter((u) => u.status === "inactive").length;
  // Counts describing the list leave out `pending` rows, because the list does (they are
  // in the approval panel), so Active + Inactive adds up to Total.
  const listed        = users.filter((u) => u.status !== "pending").length;
  const pendingCount  = users.length - listed;
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
  // Only username, role and status are sent. Name and email come from Google and are
  // re-synced at sign-in.
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
    // Based on "can sign in", not the literal "inactive", so a rejected user gets "Enable"
    // (which undoes the rejection) instead of "Disable".
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

  // Same rule as the server: never offer actions that would remove the last active admin,
  // or act on your own account. The backend (userService.js) enforces it; this only hides
  // the buttons.
  const activeAdminCount = users.filter(
    (u) => u.role === "admin" && (u.status ?? "active") === "active",
  ).length;
  const isSelf            = (u: User) => String(u.id) === String(currentUser?.id);
  const isLastActiveAdmin = (u: User) =>
    u.role === "admin" && (u.status ?? "active") === "active" && activeAdminCount <= 1;
  const isProtected = (u: User) => isSelf(u) || isLastActiveAdmin(u);
  const isAdmin     = (u: User) => u.role === "admin";
  // Can this account sign in? A null status counts as active, as in the stat cards and
  // StatusBadge. Inactive and rejected are both off.
  const isEnabled   = (u: User) => !u.status || u.status === "active";

  // Row actions, used by both the phone card and the table row. A plain function, not a
  // component defined here, so React does not rebuild the buttons on every render.
  const userActions = (u: User) => (
    <>
      {!isSelf(u) && (
        <ActionBtn onClick={() => openEdit(u)} title="Edit user">✎ Edit</ActionBtn>
      )}
      {!isProtected(u) && (
        <ActionBtn
          onClick={() => handleToggleStatus(u)}
          title={isEnabled(u) ? "Disable account" : "Enable account"}
        >
          {isEnabled(u) ? "⊘ Disable" : "⊕ Enable"}
        </ActionBtn>
      )}
      {!isProtected(u) && (
        <ActionBtn onClick={() => setDeleteTarget(u)} title="Delete user" danger>✕ Delete</ActionBtn>
      )}
      {isProtected(u) && isAdmin(u) && (
        <span className="text-[12px] text-[var(--gf-text-dim)] px-1">Protected</span>
      )}
    </>
  );

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
        <span className="text-[13px] hidden sm:inline text-[var(--gf-text-dim)]">
          {listed} user{listed !== 1 ? "s" : ""}
        </span>
      </div>

      {/* ── Stat cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        {/* Conditional spread instead of `sub={x || undefined}`: with exactOptionalPropertyTypes,
           passing undefined to an optional prop is an error. */}
        <StatPanel label="Total Users" value={listed} color="var(--gf-text-primary)"
          {...(pendingCount > 0 ? { sub: `+${pendingCount} pending` } : {})} />
        <StatPanel label="Active"      value={signedIn} color={GREEN}
          {...(invited > 0 ? { sub: `+${invited} invited` } : {})} />
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
              <div className="text-[12px] leading-relaxed text-[var(--gf-text-dim)]">
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
            <span className="text-[12px] ml-1" style={{ color: `${ORANGE}B0` }}>awaiting your approval</span>
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
                    <div className="text-[12px] truncate text-[var(--gf-text-muted)]">{p.email}</div>
                  </div>
                </div>
                {/* flex-wrap: the role picker (128px) plus Approve and Reject overrun a
                    360px phone, and without it the Reject button leaves the screen. */}
                <div className="flex items-center gap-2 flex-wrap flex-shrink-0">
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
                    className="gf-raise px-3 py-1.5 rounded-[2px] text-[13px] font-semibold text-white border-none cursor-pointer transition hover:opacity-90 disabled:opacity-60 whitespace-nowrap"
                    style={{ background: GREEN }}
                  >
                    {pendingBusy === p.id ? "…" : "✓ Approve"}
                  </button>
                  <button
                    onClick={() => handleReject(p)}
                    disabled={pendingBusy === p.id}
                    className="gf-btn px-3 py-1.5 rounded-[2px] text-[13px] font-semibold border border-[var(--gf-panel-border)] text-[var(--gf-text-muted)] hover:bg-[var(--gf-hover)] cursor-pointer transition disabled:opacity-60 whitespace-nowrap"
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
          <input name="search"
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
        right={<span className="text-[12px] text-[var(--gf-text-dim)]">{filtered.length} of {listed}</span>}
      >
        {loading ? (
          <div className="text-center py-14 text-[var(--gf-text-muted)] text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-14 text-[var(--gf-text-dim)] text-xs">No users match the current filter.</div>
        ) : (
          <>
          {/* Two layouts from one list: cards below `md` (a seven-column table pushes Role, Status
             and Actions off a phone screen), the table from `md` up. Same as UpsMonitoring.tsx. */}
          <div className="md:hidden flex flex-col">
            {filtered.map((u, i) => (
              <div
                key={u.id}
                className="flex flex-col gap-2.5 px-3 py-3"
                style={{ borderTop: i > 0 ? "1px solid var(--gf-divider)" : "none" }}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-[2px] overflow-hidden flex-shrink-0 flex items-center justify-center text-xs font-bold" style={{ background: `${roleColor(u.role)}1A`, color: roleColor(u.role), border: `1px solid ${roleColor(u.role)}40` }}>
                    {u.profile_image ? (
                      <img src={avatarUrl(u.profile_image) ?? ""} alt={u.name} referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                    ) : (
                      u.avatar || initials(u.name)
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold leading-tight text-[var(--gf-text-primary)] truncate">
                      {u.name}
                      {isProtected(u) && (
                        <span className="ml-1.5 text-[11px] text-[var(--gf-text-muted)] bg-[var(--gf-hover)] px-1.5 py-0.5 rounded-[2px]">
                          {isLastActiveAdmin(u) ? "last admin" : "you"}
                        </span>
                      )}
                    </div>
                    <div className="text-[12px] truncate text-[var(--gf-text-muted)]">@{u.username}</div>
                  </div>
                  <span className="flex-shrink-0"><RoleBadge role={u.role} /></span>
                </div>

                {/* break-all instead of truncate: the email is how the account is identified. */}
                <div className="text-[12px] break-all text-[var(--gf-text-muted)]">
                  {u.email || <span className="text-[var(--gf-text-dim)]">—</span>}
                </div>

                <div className="flex items-center gap-2 flex-wrap text-[12px]">
                  <StatusBadge status={u.status} lastLogin={u.last_login} />
                  <span className="text-[var(--gf-text-dim)]">
                    {u.last_login
                      ? `last login ${new Date(u.last_login).toLocaleDateString("en-PH", { month: "short", day: "2-digit", year: "numeric" })}`
                      : "never signed in"}
                  </span>
                  <span className="text-[var(--gf-text-dim)] ml-auto">#{String(u.id).padStart(3, "0")}</span>
                </div>

                <div className="flex items-center gap-1.5 flex-wrap">{userActions(u)}</div>
              </div>
            ))}
          </div>

          <div className="hidden md:block overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {["User", "Username", "Email", "Role", "Status", "Last Login", "Actions"].map((h) => (
                    <th key={h} className="text-left px-4 py-2.5 text-[11px] uppercase tracking-widest font-medium border-b border-[var(--gf-divider)] whitespace-nowrap text-[var(--gf-text-dim)]">
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
                              <span className="ml-1.5 text-[11px] text-[var(--gf-text-muted)] bg-[var(--gf-hover)] px-1.5 py-0.5 rounded-[2px]">
                                {isLastActiveAdmin(u) ? "last admin" : "you"}
                              </span>
                            )}
                          </div>
                          <div className="text-[12px] text-[var(--gf-text-dim)]">#{String(u.id).padStart(3, "0")}</div>
                        </div>
                      </div>
                    </td>

                    <td className="px-4 py-3 text-xs text-[var(--gf-text-muted)] whitespace-nowrap">@{u.username}</td>
                    <td className="px-4 py-3 text-xs text-[var(--gf-text-muted)] whitespace-nowrap">
                      {u.email || <span className="text-[var(--gf-text-dim)]">—</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap"><RoleBadge role={u.role} /></td>
                    <td className="px-4 py-3 whitespace-nowrap"><StatusBadge status={u.status} lastLogin={u.last_login} /></td>
                    <td className="px-4 py-3 text-[12px] text-[var(--gf-text-muted)] whitespace-nowrap">
                      {u.last_login
                        ? new Date(u.last_login).toLocaleDateString("en-PH", { month: "short", day: "2-digit", year: "numeric" })
                        : <span className="text-[var(--gf-text-dim)]">Never</span>
                      }
                    </td>

                    {/* Actions */}
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">{userActions(u)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
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
                <span className="text-[11px] uppercase tracking-widest text-[var(--gf-text-dim)]">{k}</span>
                <span className="text-sm font-semibold text-[var(--gf-text-primary)]">{v}</span>
              </div>
            ))}
            <div className="ml-auto self-center text-[12px] italic text-[var(--gf-text-dim)]">Read-only</div>
          </div>

          {/* Name + email are owned by Google and re-synced on the user's next sign-in,
              so they're shown read-only — editing them here would silently revert. */}
          <div className="rounded-[2px] bg-[var(--gf-bg)] border border-[var(--gf-panel-border)] px-4 py-3 flex flex-col gap-2">
            <div className="flex gap-8 flex-wrap">
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-[11px] uppercase tracking-widest text-[var(--gf-text-dim)]">Full Name</span>
                <span className="text-sm font-semibold text-[var(--gf-text-primary)] truncate">{editUser?.name ?? "—"}</span>
              </div>
              <div className="flex flex-col gap-0.5 min-w-0">
                <span className="text-[11px] uppercase tracking-widest text-[var(--gf-text-dim)]">Email</span>
                <span className="text-sm font-semibold text-[var(--gf-text-primary)] truncate">{editUser?.email ?? "—"}</span>
              </div>
            </div>
            <span className="text-[12px] text-[var(--gf-text-dim)] leading-relaxed">
              From this user's CSPC Google account — refreshed on each sign-in, so not editable here.
            </span>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className={labelCls}>Username *</label>
              <input name="username" value={editForm.username} onChange={(e) => setEditForm((p) => ({ ...p, username: e.target.value }))} className={inputCls} placeholder="Username" />
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
                  // A rejected account has no matching option, so the select would show blank. Keep the
                  // option while it applies, so the status is visible and can be switched to Active.
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
            <button onClick={() => setEditUser(null)} className="gf-btn flex-1 px-4 py-2.5 rounded-[2px] text-sm font-semibold border border-[var(--gf-panel-border)] text-[var(--gf-text-muted)] hover:bg-[var(--gf-hover)] transition cursor-pointer">Cancel</button>
            <button onClick={handleEdit} disabled={editLoading} className="gf-raise flex-1 px-4 py-2.5 rounded-[2px] text-sm font-semibold text-white border-none cursor-pointer transition hover:opacity-90 disabled:opacity-60" style={{ background: "var(--gf-accent)" }}>
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
