import { useState, useEffect } from "react";
import { api } from "../api/api";
import { roleConfig } from "../data/users";

interface RoleConfig {
  label: string;
  bg: string;
  border: string;
  color: string;
  pages: string[];
}

interface User {
  id: number;
  name: string;
  username: string;
  email: string;
  role: string;
}

interface UserForm {
  name: string;
  username: string;
  email: string;
  role: string;
  password: string;
}

interface RoleBadgeProps {
  role: string;
}

function RoleBadge({ role }: RoleBadgeProps) {

    const cfg: RoleConfig = roleConfig[role as keyof typeof roleConfig] || {};
    
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border ${cfg.bg} ${cfg.border} ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

export default function UserManagement() {
  const [users, setUsers]           = useState<User[]>([]);
  const [loading, setLoading]       = useState<boolean>(true);
  const [showAdd, setShowAdd]       = useState<boolean>(false);
  const [form, setForm]             = useState<UserForm>({ name: "", username: "", email: "", role: "viewer", password: "" });
  const [formError, setFormError]   = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);

  useEffect(() => {
    api
      .getUsers()
      .then((d: { users: User[] }) => { setUsers(d.users); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const handleAdd = async () => {
    if (!form.name || !form.username || !form.password) {
      setFormError("Name, username, and password are required.");
      return;
    }

    setSubmitting(true);

    try {
      const d: { user: User } = await api.createUser(form);
      setUsers(p => [...p, d.user]);
      setForm({ name: "", username: "", email: "", role: "viewer", password: "" });
      setFormError("");
      setShowAdd(false);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : "Failed to create user.");
    }

    setSubmitting(false);
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm("Delete this user?")) return;

    try {
      await api.deleteUser(id);
      setUsers(p => p.filter(u => u.id !== id));
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to delete user.");
    }
  };

  const inputClass = "w-full px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10 text-white text-sm font-mono outline-none focus:border-blue-500/50 transition placeholder-slate-600";
  const labelClass = "block text-xs text-slate-400 font-semibold mb-1";

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-base font-bold text-white">User Management</div>
          <div className="text-xs text-slate-400 mt-0.5">Manage system users and role permissions</div>
        </div>
        <button
          onClick={() => { setShowAdd(p => !p); setFormError(""); }}
          className="px-4 py-2 rounded-lg bg-gradient-to-r from-blue-700 to-blue-500 text-white font-semibold text-sm border-none cursor-pointer hover:opacity-90 transition"
        >
          {showAdd ? "✕ Cancel" : "+ Add User"}
        </button>
      </div>

      {/* Role Legend */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {(Object.entries(roleConfig) as [string, RoleConfig][]).map(([key, cfg]) => (
          <div key={key} className={`rounded-xl border ${cfg.border} p-3 bg-white/[0.02]`}>
            <div className={`text-sm font-bold mb-1.5 ${cfg.color}`}>{cfg.label}</div>
            <div className="text-[10px] text-slate-500 leading-relaxed">
              Can access: {cfg.pages.map(p => p.replace("-", " ")).join(", ")}
            </div>
          </div>
        ))}
      </div>

      {/* Add User Form */}
      {showAdd && (
        <div className="rounded-xl bg-white/[0.03] border border-blue-500/20 p-5">
          <div className="text-sm font-bold text-white mb-4">Add New User</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
            <div>
              <label className={labelClass}>Full Name *</label>
              <input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Juan dela Cruz" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Username *</label>
              <input value={form.username} onChange={e => setForm(p => ({ ...p, username: e.target.value }))} placeholder="e.g. jdelacruz" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Email</label>
              <input value={form.email} onChange={e => setForm(p => ({ ...p, email: e.target.value }))} placeholder="e.g. user@cspc.edu.ph" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Password *</label>
              <input type="password" value={form.password} onChange={e => setForm(p => ({ ...p, password: e.target.value }))} placeholder="Set a password" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Role *</label>
              <select value={form.role} onChange={e => setForm(p => ({ ...p, role: e.target.value }))} className={inputClass + " cursor-pointer"}>
                <option value="super_admin">Super Admin</option>
                <option value="it_staff">IT Staff</option>
                <option value="viewer">Viewer</option>
              </select>
            </div>
          </div>
          {formError && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/25 text-red-400 text-xs">
              {formError}
            </div>
          )}
          <button
            onClick={handleAdd}
            disabled={submitting}
            className="px-5 py-2.5 rounded-lg bg-gradient-to-r from-green-700 to-green-500 text-white font-semibold text-sm border-none cursor-pointer hover:opacity-90 transition disabled:opacity-60"
          >
            {submitting ? "Creating..." : "✓ Create User"}
          </button>
        </div>
      )}

      {/* Users Table */}
      <div className="rounded-xl bg-white/[0.03] border border-white/[0.08] p-4">
        <div className="text-sm font-bold text-white mb-3">All Users ({users.length})</div>
        {loading ? (
          <div className="text-center py-8 text-slate-500 text-sm">Loading users...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr>
                  {["#", "Name", "Username", "Email", "Role", "Action"].map(h => (
                    <th key={h} className="text-left px-3 py-2 text-[10px] text-slate-500 font-semibold tracking-widest border-b border-white/[0.07] whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u, i) => (
                  <tr key={u.id} className={i % 2 === 0 ? "bg-white/[0.015]" : ""}>
                    <td className="px-3 py-3 font-mono text-slate-500 text-xs">
                      {String(u.id).padStart(2, "0")}
                    </td>
                    <td className="px-3 py-3 text-white font-semibold text-xs whitespace-nowrap">
                      {u.name}
                    </td>
                    <td className="px-3 py-3 font-mono text-slate-400 text-xs">
                      {u.username}
                    </td>
                    <td className="px-3 py-3 text-slate-400 text-xs">
                      {u.email || "—"}
                    </td>
                    <td className="px-3 py-3">
                      <RoleBadge role={u.role} />
                    </td>
                    <td className="px-3 py-3">
                      {u.id === 1
                        ? <span className="text-xs text-slate-600 font-mono">Protected</span>
                        : <button
                            onClick={() => handleDelete(u.id)}
                            className="px-2.5 py-1 rounded-md border border-red-500/25 bg-red-500/10 text-red-400 text-xs cursor-pointer hover:bg-red-500/20 transition"
                          >
                            Delete
                          </button>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}