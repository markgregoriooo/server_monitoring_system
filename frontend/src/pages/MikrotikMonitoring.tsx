import { Fragment, useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import { useAuth } from "../context/AuthContext";
import MikrotikDetail from "./MikrotikDetail";
import type { MkDevice } from "./MikrotikDetail";

// ─── MikroTik list page ───────────────────────────────────────────────────────
// First page = the fleet list (one compact row per router, with "View"); clicking
// through swaps in MikrotikDetail for the full drill-down. Mirrors
// ServerMetrics ↔ ServerDetail and NetworkMonitoring ↔ NetworkDetail.
// Types + the per-device charts/ports live in MikrotikDetail.tsx.

// ─── Grafana tokens (match NetworkMonitoring.tsx) ─────────────────────────────

const gf = {
  bg: "var(--gf-bg)",
  panel: "var(--gf-panel)",
  border: "var(--gf-panel-border)",
  divider: "var(--gf-divider)",
  textPrimary: "var(--gf-text-primary)",
  textMuted: "var(--gf-text-muted)",
  textDim: "var(--gf-text-dim)",
  hover: "var(--gf-hover)",
} as const;

const GREEN = "#73BF69";
const ORANGE = "#FF780A";
const RED = "#F2495C";
const BLUE = "#5794F2";

function loadColor(v: number) {
  if (v >= 85) return RED;
  if (v >= 65) return ORANGE;
  return GREEN;
}
function statusColor(s: string) {
  if (s === "Online") return GREEN;
  if (s === "Warning") return ORANGE;
  return RED;
}
function formatUptime(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.floor(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

function mapMk(r: any): MkDevice {
  return {
    id: String(r.id),
    name: r.name ?? "—",
    ip: r.ip ?? "—",
    location: r.location ?? "—",
    status: r.status ?? "Offline",
    reachable: r.reachable ?? null,
    uptimeSeconds: r.uptimeSeconds ?? null,
    cpuPercent: r.cpuPercent ?? null,
    memPercent: r.memPercent ?? null,
    connectedClients: r.connectedClients ?? null,
    latencyMs: r.latencyMs ?? null,
    packetLossPct: r.packetLossPct ?? null,
    routerosVersion: r.routerosVersion ?? null,
    boardModel: r.boardModel ?? null,
    apiPort: r.apiPort ?? null,
    useTls: Boolean(r.useTls),
    apiUsername: r.apiUsername ?? null,
    interfaces: (r.interfaces ?? []).map((i: any) => ({
      name: i.name ?? "—",
      locationLabel: i.locationLabel ?? "",
      linkUp: Boolean(i.linkUp),
      // Absent on an older backend — default to enabled so a port is never drawn as
      // "disabled" just because the field is missing.
      adminUp: i.adminUp !== false,
      utilizationPct: i.utilizationPct ?? null,
      rxBytes: i.rxBytes ?? null,
      txBytes: i.txBytes ?? null,
    })),
    monitored: r.monitored ?? true,
  };
}
// Merge one live `networkMetrics` payload onto the row we already hold. Every field is
// optional: a poll carries metrics, while an add/config-save carries identity + settings
// only. Anything absent keeps its current value.
function mergeMkLive(prev: MkDevice | undefined, p: any): MkDevice {
  const base = prev ?? mapMk({ ...p, monitored: p.monitored ?? false });
  return {
    ...base,
    name: p.name ?? base.name,
    ip: p.ip ?? base.ip,
    location: p.location ?? base.location,
    status: p.status ?? base.status,
    reachable: p.reachable ?? base.reachable,
    uptimeSeconds: p.uptimeSeconds ?? base.uptimeSeconds,
    cpuPercent: p.cpuPercent ?? base.cpuPercent,
    memPercent: p.memPercent ?? base.memPercent,
    connectedClients: p.connectedClients ?? base.connectedClients,
    // `in` rather than `??`: a poll that measured NO latency (total loss) reports null,
    // and `??` would keep showing the previous healthy figure at the worst moment.
    latencyMs: "latencyMs" in p ? p.latencyMs : base.latencyMs,
    packetLossPct: "packetLossPct" in p ? p.packetLossPct : base.packetLossPct,
    routerosVersion: p.routerosVersion ?? base.routerosVersion,
    boardModel: p.boardModel ?? base.boardModel,
    apiPort: p.apiPort ?? base.apiPort,
    useTls: p.useTls != null ? Boolean(p.useTls) : base.useTls,
    apiUsername: p.apiUsername ?? base.apiUsername,
    monitored: p.monitored != null ? Boolean(p.monitored) : base.monitored,
    // Only a real poll carries ports. An add/config-save sends an empty array, which
    // must NOT wipe the ports we're already showing — offline clearing is handled by
    // the separate `networkStatus` event.
    interfaces: Array.isArray(p.interfaces) && p.interfaces.length ? mapMk(p).interfaces : base.interfaces,
  };
}

// ─── Panel / StatPanel ────────────────────────────────────────────────────────

function Panel({
  title, right, children, noPad,
}: {
  title?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  noPad?: boolean;
}) {
  return (
    <div
      className="flex flex-col rounded-lg overflow-hidden"
      style={{ background: gf.panel, border: `1px solid ${gf.border}` }}
    >
      {title !== undefined && (
        <div className="flex items-center justify-between px-3 shrink-0" style={{ height: 32, borderBottom: `1px solid ${gf.divider}` }}>
          <span className="text-[13px] font-medium tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>{title}</span>
          {right && <div className="flex items-center gap-2">{right}</div>}
        </div>
      )}
      <div className="flex-1 min-h-0" style={{ padding: noPad ? 0 : 12 }}>{children}</div>
    </div>
  );
}

function StatPanel({ label, value, unit, color, sub }: { label: string; value: string; unit?: string; color: string; sub?: string }) {
  return (
    <div className="relative overflow-hidden rounded-lg flex flex-col" style={{ background: gf.panel, border: `1px solid ${gf.border}`, minHeight: 88 }}>
      <div className="flex items-center justify-between px-3 pt-2.5">
        <span className="text-[12px] tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>{label}</span>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      </div>
      <div className="px-3 pt-1.5">
        <span className="text-[26px] font-bold leading-none" style={{ color }}>{value}</span>
        {unit && <span className="text-[15px] ml-1" style={{ color: color + "AA" }}>{unit}</span>}
        {sub && <div className="text-[11px] mt-1 tracking-widest uppercase" style={{ color: gf.textDim }}>{sub}</div>}
      </div>
    </div>
  );
}

// ─── Ghost button (matches ServerMetrics / NetworkMonitoring "View") ──────────

function GhostButton({ children, onClick, danger }: { children: React.ReactNode; onClick: (e: React.MouseEvent) => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className="gf-btn text-[13px] font-medium px-2.5 py-1"
      style={{ color: danger ? RED : gf.textMuted }}
    >
      {children}
    </button>
  );
}

// One labelled fact in a drawer's summary strip. The strip used to be bare values —
// "RB951G-2HnD", "monitor-ro", "8729 · TLS" — which only reads if you already know
// which field is which. The key is what makes a value information.
function Meta({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 min-w-0">
      <span className="text-[10px] tracking-widest uppercase shrink-0" style={{ color: gf.textDim }}>{label}</span>
      <span className={`text-[12px] truncate ${mono ? "font-mono" : ""}`} style={{ color: gf.textMuted }}>{value}</span>
    </span>
  );
}

// ─── Drawer row (expands under a table row) ───────────────────────────────────
// Same pattern as ServerMetrics' ServerDrawerRow: the row carries what you scan, the
// drawer the ports and identity you'd otherwise open the detail page for.
function MkDrawerRow({ d, isOpen, colSpan }: { d: MkDevice; isOpen: boolean; colSpan: number }) {
  const up = d.interfaces.filter((i) => i.linkUp).length;
  return (
    <tr>
      <td colSpan={colSpan} className="p-0">
        <div
          className="overflow-hidden transition-all duration-300 ease-in-out"
          style={{ maxHeight: isOpen ? 260 : 0, borderBottom: isOpen ? `1px solid ${gf.divider}` : "none" }}
        >
          <div className="p-3" style={{ background: gf.bg }}>
            <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 mb-2.5">
              <Meta label="IP" value={d.ip} mono />
              <Meta label="Location" value={d.location} />
              {d.routerosVersion && <Meta label="RouterOS" value={d.routerosVersion} />}
              {d.boardModel && <Meta label="Board" value={d.boardModel} />}
              <Meta label="API port" value={`${d.apiPort ?? "—"}${d.useTls ? " · TLS" : ""}`} />
              {d.apiUsername && <Meta label="API user" value={d.apiUsername} mono />}
              <Meta label="Uptime" value={formatUptime(d.uptimeSeconds)} />
            </div>
            {!d.monitored ? (
              <div className="text-[13px]" style={{ color: ORANGE }}>
                API not configured — set the read-only RouterOS login (admin).
              </div>
            ) : d.interfaces.length === 0 ? (
              <div className="text-[13px]" style={{ color: gf.textDim }}>
                {d.status === "Online" ? "No ports reported." : "Offline — awaiting next poll."}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] tracking-widest uppercase" style={{ color: gf.textDim }}>
                  Ports · {up}/{d.interfaces.length} up
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {d.interfaces.map((i) => (
                    <PortChip key={i.name} label={i.locationLabel || i.name} up={i.linkUp} util={i.utilizationPct} />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </td>
    </tr>
  );
}

// Compact ports figure for the table cell — chips live in the drawer.
function PortsCell({ d }: { d: MkDevice }) {
  const up = d.interfaces.filter((i) => i.linkUp).length;
  const total = d.interfaces.length;
  const color = total === 0 ? gf.textDim : up === total ? GREEN : up === 0 ? RED : ORANGE;
  return (
    <span className="text-[13px] tabular-nums" style={{ color }}>
      {total === 0 ? "—" : `${up}/${total}`}
    </span>
  );
}

// ─── Port chip (compact per-port state for the LIST row) ──────────────────────
// The full utilization bars live in the detail view — the list only needs an
// at-a-glance "which ports are up".

function PortChip({ label, up, util }: { label: string; up: boolean; util?: number | null }) {
  const showUtil = up && util != null && Number.isFinite(util);
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[2px] text-[12px]"
      style={{ background: gf.hover, border: `1px solid ${gf.divider}`, color: up ? gf.textMuted : gf.textDim }}
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: up ? GREEN : RED }} />
      <span className="truncate" style={{ maxWidth: 120 }}>{label}</span>
      {showUtil && (
        <span className="tabular-nums" style={{ color: loadColor(Math.round(util as number)) }}>
          {Math.round(util as number)}%
        </span>
      )}
      {!up && <span style={{ color: gf.textDim }}>down</span>}
    </span>
  );
}

// ─── Password input with a show/hide toggle ───────────────────────────────────
// RouterOS passwords are typed by hand and are never displayed again once saved, so
// being able to verify what you typed before committing avoids a save-then-fail loop.

function PasswordField({
  value, onChange, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input name="value"
        type={show ? "text" : "password"}
        className="w-full pl-2 pr-8 py-1.5 text-[14px] rounded-[2px] outline-none"
        style={{ background: gf.bg, border: `1px solid ${gf.border}`, color: gf.textPrimary }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="new-password"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        title={show ? "Hide password" : "Show password"}
        aria-label={show ? "Hide password" : "Show password"}
        className="absolute right-1 top-1/2 -translate-y-1/2 grid place-items-center w-6 h-6 rounded-[2px] transition-colors"
        style={{ color: gf.textMuted, background: "transparent" }}
        onMouseEnter={(e) => (e.currentTarget.style.color = gf.textPrimary)}
        onMouseLeave={(e) => (e.currentTarget.style.color = gf.textMuted)}
      >
        {show ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C5 20 1 12 1 12a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
            <path d="M1 1l22 22" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}

// ─── Admin: add a new MikroTik ────────────────────────────────────────────────

function AddModal({ onClose, onAdded, usedNames }: { onClose: () => void; onAdded: (msg: string) => void; usedNames: string[] }) {
  const [name, setName] = useState("Campus MikroTik");
  const [ip, setIp] = useState("");
  const [location, setLocation] = useState("Server Room");
  const [apiPort, setApiPort] = useState<number>(8728);
  const [useTls, setUseTls] = useState(false);
  const [apiUsername, setApiUsername] = useState("");
  const [apiPassword, setApiPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Verify the login before creating anything — nothing is persisted by this call.
  const test = async () => {
    if (!ip.trim() || !apiUsername.trim()) {
      setTestResult({ ok: false, msg: "IP address and username are required to test." });
      return;
    }
    setTesting(true);
    setTestResult(null);
    const r = await api.testMikrotik(null, {
      ip: ip.trim(),
      apiPort: Number(apiPort),
      useTls,
      apiUsername: apiUsername.trim(),
      apiPassword,
    });
    setTesting(false);
    const data: any = r.data ?? {};
    if (r.success && data.ok) {
      setTestResult({ ok: true, msg: `OK — RouterOS ${data.version ?? "?"}${data.boardName ? ` · ${data.boardName}` : ""}` });
    } else {
      setTestResult({ ok: false, msg: data.error || r.error || "Connection failed" });
    }
  };

  const submit = async () => {
    if (!name.trim() || !ip.trim()) {
      setErr("Name and IP are required.");
      return;
    }
    // Instant feedback; the server enforces the same rule authoritatively (409).
    if (usedNames.some((u) => u.toLowerCase() === name.trim().toLowerCase())) {
      setErr(`A MikroTik named "${name.trim()}" already exists.`);
      return;
    }
    setBusy(true);
    setErr("");
    const body: {
      name: string; ip: string; location: string;
      apiPort: number; useTls: boolean; apiUsername: string; apiPassword?: string;
    } = {
      name: name.trim(),
      ip: ip.trim(),
      location: location.trim(),
      apiPort: Number(apiPort),
      useTls,
      apiUsername: apiUsername.trim(),
    };
    if (apiPassword) body.apiPassword = apiPassword;
    const r = await api.addMikrotik(body);
    setBusy(false);
    if (r.success) onAdded("MikroTik added");
    else setErr(r.error || "Add failed — did you run the migration?");
  };

  const labelCls = "text-[12px] tracking-widest uppercase mb-1 block";
  const inputCls = "w-full px-2 py-1.5 text-[14px] rounded-[2px] outline-none";
  const inputStyle = { background: gf.bg, border: `1px solid ${gf.border}`, color: gf.textPrimary } as const;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div className="w-full max-w-md rounded-lg overflow-hidden" style={{ background: gf.panel, border: `1px solid ${gf.border}` }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4" style={{ height: 40, borderBottom: `1px solid ${gf.divider}` }}>
          <span className="text-[14px] font-semibold" style={{ color: gf.textPrimary }}>Add MikroTik</span>
          <button onClick={onClose} className="text-[18px] leading-none" style={{ color: gf.textMuted }}>×</button>
        </div>
        <div className="p-4 flex flex-col gap-3">
          <div>
            <label className={labelCls} style={{ color: gf.textMuted }}>Name</label>
            <input name="name" className={inputCls} style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} style={{ color: gf.textMuted }}>IP address</label>
              <input name="ip" className={inputCls} style={inputStyle} value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.88.1" />
            </div>
            <div>
              <label className={labelCls} style={{ color: gf.textMuted }}>Location</label>
              <input name="location" className={inputCls} style={inputStyle} value={location} onChange={(e) => setLocation(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} style={{ color: gf.textMuted }}>API Port</label>
              <input name="apiPort" type="number" className={inputCls} style={inputStyle} value={apiPort} onChange={(e) => setApiPort(Number(e.target.value))} />
            </div>
            <label className="flex items-center gap-2 text-[14px] cursor-pointer self-end pb-1.5" style={{ color: gf.textPrimary }}>
              <input name="useTls"
                type="checkbox"
                checked={useTls}
                onChange={(e) => {
                  const on = e.target.checked;
                  setUseTls(on);
                  // Move the port with the toggle. The label promises 8729, but the port
                  // is a separate field — leaving it at 8728 means speaking TLS to a
                  // plain port, which just hangs until the socket times out. Only the
                  // two default ports are auto-switched; a custom port is left alone.
                  setApiPort((p) => (on ? (p === 8728 ? 8729 : p) : p === 8729 ? 8728 : p));
                }}
              />
              Use TLS (8729)
            </label>
          </div>
          <div>
            <label className={labelCls} style={{ color: gf.textMuted }}>Username (read-only RouterOS user)</label>
            <input name="apiUsername" className={inputCls} style={inputStyle} value={apiUsername} onChange={(e) => setApiUsername(e.target.value)} placeholder="monitor-ro" autoComplete="off" />
          </div>
          <div>
            <label className={labelCls} style={{ color: gf.textMuted }}>Password</label>
            <PasswordField value={apiPassword} onChange={setApiPassword} placeholder="RouterOS API password" />
            <p className="text-[11px] mt-1" style={{ color: gf.textDim }}>Stored encrypted (AES-256-GCM).</p>
          </div>
          {err && (
            <div className="text-[13px] px-2 py-1.5 rounded-[2px]" style={{ color: RED, background: RED + "14", border: `1px solid ${RED}40` }}>{err}</div>
          )}
          {testResult && (
            <div className="text-[13px] px-2 py-1.5 rounded-[2px]" style={{ color: testResult.ok ? GREEN : RED, background: (testResult.ok ? GREEN : RED) + "14", border: `1px solid ${(testResult.ok ? GREEN : RED)}40` }}>
              {testResult.msg}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            <button onClick={test} disabled={testing || busy} className="text-[13px] px-3 py-1.5 rounded-[2px]" style={{ color: gf.textMuted, border: `1px solid ${gf.border}`, opacity: testing || busy ? 0.6 : 1 }}>
              {testing ? "Testing…" : "Test connection"}
            </button>
            <div className="flex items-center gap-2">
            <button onClick={onClose} className="text-[13px] px-3 py-1.5 rounded-[2px]" style={{ color: gf.textMuted }}>Cancel</button>
            <button onClick={submit} disabled={busy || !name.trim() || !ip.trim()} className="gf-raise text-[13px] px-3 py-1.5 rounded-[2px] font-semibold" style={{ background: BLUE, color: "#fff", opacity: busy || !name.trim() || !ip.trim() ? 0.6 : 1 }}>
              {busy ? "Adding…" : "Add MikroTik"}
            </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Admin: RouterOS connection modal ─────────────────────────────────────────

function ConnectionModal({
  device, onClose, onSaved,
}: {
  device: MkDevice;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [apiPort, setApiPort] = useState<number>(device.apiPort ?? 8728);
  const [useTls, setUseTls] = useState<boolean>(device.useTls);
  const [apiUsername, setApiUsername] = useState<string>(device.apiUsername ?? "");
  const [apiPassword, setApiPassword] = useState<string>("");
  const [busy, setBusy] = useState<"" | "save" | "test">("");
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const save = async () => {
    setBusy("save");
    setResult(null);
    const body: { apiPort: number; useTls: boolean; apiUsername: string; apiPassword?: string } = {
      apiPort: Number(apiPort),
      useTls,
      apiUsername: apiUsername.trim(),
    };
    if (apiPassword) body.apiPassword = apiPassword;
    const r = await api.saveMikrotikConnection(Number(device.id), body);
    setBusy("");
    if (r.success) onSaved("Connection saved");
    else setResult({ ok: false, msg: r.error || "Save failed" });
  };

  // Tests what's currently typed, not what's stored — so a wrong password never has to
  // be saved just to discover it's wrong. A blank password field falls back to the
  // stored one server-side.
  const test = async () => {
    setBusy("test");
    setResult(null);
    const r = await api.testMikrotik(Number(device.id), {
      apiPort: Number(apiPort),
      useTls,
      apiUsername: apiUsername.trim(),
      ...(apiPassword ? { apiPassword } : {}),
    });
    setBusy("");
    const data: any = r.data ?? {};
    if (r.success && data.ok) {
      setResult({ ok: true, msg: `OK — RouterOS ${data.version ?? "?"}${data.boardName ? ` · ${data.boardName}` : ""}` });
    } else {
      setResult({ ok: false, msg: data.error || r.error || "Connection failed" });
    }
  };

  const labelCls = "text-[12px] tracking-widest uppercase mb-1 block";
  const inputCls = "w-full px-2 py-1.5 text-[14px] rounded-[2px] outline-none";
  const inputStyle = { background: gf.bg, border: `1px solid ${gf.border}`, color: gf.textPrimary } as const;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div className="w-full max-w-md rounded-lg overflow-hidden" style={{ background: gf.panel, border: `1px solid ${gf.border}` }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4" style={{ height: 40, borderBottom: `1px solid ${gf.divider}` }}>
          <span className="text-[14px] font-semibold truncate" style={{ color: gf.textPrimary }}>RouterOS connection · {device.name}</span>
          <button onClick={onClose} className="text-[18px] leading-none" style={{ color: gf.textMuted }}>×</button>
        </div>
        <div className="p-4 flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} style={{ color: gf.textMuted }}>API Port</label>
              <input name="apiPort" type="number" className={inputCls} style={inputStyle} value={apiPort} onChange={(e) => setApiPort(Number(e.target.value))} />
            </div>
            <label className="flex items-center gap-2 text-[14px] cursor-pointer self-end pb-1.5" style={{ color: gf.textPrimary }}>
              <input name="useTls"
                type="checkbox"
                checked={useTls}
                onChange={(e) => {
                  const on = e.target.checked;
                  setUseTls(on);
                  // Move the port with the toggle. The label promises 8729, but the port
                  // is a separate field — leaving it at 8728 means speaking TLS to a
                  // plain port, which just hangs until the socket times out. Only the
                  // two default ports are auto-switched; a custom port is left alone.
                  setApiPort((p) => (on ? (p === 8728 ? 8729 : p) : p === 8729 ? 8728 : p));
                }}
              />
              Use TLS (8729)
            </label>
          </div>
          <div>
            <label className={labelCls} style={{ color: gf.textMuted }}>Username (read-only RouterOS user)</label>
            <input name="apiUsername" className={inputCls} style={inputStyle} value={apiUsername} onChange={(e) => setApiUsername(e.target.value)} placeholder="monitor-ro" autoComplete="off" />
          </div>
          <div>
            <label className={labelCls} style={{ color: gf.textMuted }}>Password</label>
            <PasswordField value={apiPassword} onChange={setApiPassword} placeholder="leave blank to keep current" />
            <p className="text-[11px] mt-1" style={{ color: gf.textDim }}>Stored encrypted (AES-256-GCM); never shown again.</p>
          </div>

          {result && (
            <div className="text-[13px] px-2 py-1.5 rounded-[2px]" style={{ color: result.ok ? GREEN : RED, background: (result.ok ? GREEN : RED) + "14", border: `1px solid ${(result.ok ? GREEN : RED)}40` }}>
              {result.msg}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <button onClick={test} disabled={busy !== ""} className="text-[13px] px-3 py-1.5 rounded-[2px]" style={{ color: gf.textMuted, border: `1px solid ${gf.border}`, opacity: busy ? 0.6 : 1 }}>
              {busy === "test" ? "Testing…" : "Test connection"}
            </button>
            <div className="flex items-center gap-2">
              <button onClick={onClose} className="text-[13px] px-3 py-1.5 rounded-[2px]" style={{ color: gf.textMuted }}>Cancel</button>
              <button onClick={save} disabled={busy !== "" || !apiUsername.trim()} className="gf-raise text-[13px] px-3 py-1.5 rounded-[2px] font-semibold" style={{ background: BLUE, color: "#fff", opacity: busy || !apiUsername.trim() ? 0.6 : 1 }}>
                {busy === "save" ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
          <p className="text-[11px]" style={{ color: gf.textDim }}>Test uses what's typed above — no need to save first. Leave the password blank to test the stored one.</p>
        </div>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function MikrotikMonitoring() {
  const [devices, setDevices] = useState<MkDevice[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [configFor, setConfigFor] = useState<MkDevice | null>(null);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  // Which row's drawer is open (one at a time), same as ServerMetrics.
  const [openId, setOpenId] = useState<string | null>(null);
  const toggleDrawer = (id: string) => setOpenId((prev) => (prev === id ? null : id));
  const [searchParams, setSearchParams] = useSearchParams();

  // Deep-link from a notification: /mikrotik?device=<id> opens that router's detail
  // once the list has loaded, then drops the param (so Back returns to the list and a
  // refresh doesn't re-trigger). Same contract as ServerMetrics — see routeFor.
  useEffect(() => {
    const deviceParam = searchParams.get("device");
    if (!deviceParam) return;
    if (!devices.some((d) => d.id === String(deviceParam))) return;
    setDetailId(String(deviceParam));
    searchParams.delete("device");
    setSearchParams(searchParams, { replace: true });
  }, [devices, searchParams, setSearchParams]);

  // Decommission. Cascades server-side to mikrotik_devices / network_interfaces /
  // device_logs / alerts, so it's gated behind the inline Yes/No confirm.
  const remove = async (id: string) => {
    setRemoving(id);
    const r = await api.deleteMikrotik(Number(id));
    setRemoving(null);
    setConfirmId(null);
    if (!r.success) {
      alert(r.error ?? "Failed to remove MikroTik.");
      return;
    }
    setDevices((prev) => prev.filter((x) => x.id !== id));
    setDetailId((cur) => (cur === id ? null : cur));
    setToast("MikroTik removed");
    setTimeout(() => setToast(""), 3000);
  };

  const load = () =>
    api.getMikrotikDevices().then((r) => {
      if (r.success && r.data) setDevices((r.data.devices ?? []).map(mapMk));
    });

  useEffect(() => {
    load();
    const onMetrics = (data: { device: any }) => {
      if (!data?.device || data.device.type !== "mikrotik") return; // shared event — only ours
      const id = String(data.device.id);
      setDevices((prev) => {
        const idx = prev.findIndex((d) => d.id === id);
        if (idx === -1) return [...prev, mergeMkLive(undefined, data.device)];
        const next = [...prev];
        next[idx] = mergeMkLive(next[idx], data.device);
        return next;
      });
    };
    const onStatus = (data: { id: number | string; status: string }) => {
      const id = String(data?.id);
      setDevices((prev) =>
        prev.map((d) =>
          d.id !== id
            ? d
            : data.status === "Offline"
              ? { ...d, status: "Offline", reachable: false, interfaces: [] }
              : { ...d, status: data.status },
        ),
      );
    };
    // Another admin removed it — drop it here too, and bail out of its detail view.
    const onRemoved = (data: { id: number | string }) => {
      const id = String(data?.id);
      setDevices((prev) => prev.filter((d) => d.id !== id));
      setDetailId((cur) => (cur === id ? null : cur));
    };
    socket.on("networkMetrics", onMetrics);
    socket.on("networkStatus", onStatus);
    socket.on("networkRemoved", onRemoved);
    return () => {
      socket.off("networkMetrics", onMetrics);
      socket.off("networkStatus", onStatus);
      socket.off("networkRemoved", onRemoved);
    };
  }, []);

  const total = devices.length;
  const online = devices.filter((d) => d.status === "Online").length;
  const allIfaces = devices.flatMap((d) => d.interfaces);
  const portsUp = allIfaces.filter((i) => i.linkUp).length;
  // WORST across the fleet, not the average. A status tile exists to make you look —
  // and an average is the one aggregation guaranteed to stop that: one router at 98%
  // with three idle ones averages to ~29% and shows green while a device is on fire.
  // Devices that haven't reported (offline) contribute nothing rather than counting as 0.
  const cpuVals = devices.filter((d) => d.cpuPercent != null).map((d) => d.cpuPercent as number);
  const memVals = devices.filter((d) => d.memPercent != null).map((d) => d.memPercent as number);
  const worstCpu = cpuVals.length ? Math.round(Math.max(...cpuVals)) : 0;
  const worstMem = memVals.length ? Math.round(Math.max(...memVals)) : 0;
  const reporting = Math.max(cpuVals.length, memVals.length);
  const aggSub = reporting > 1 ? `worst of ${reporting}` : "router load";

  // Drill-down: render the per-router detail in place (Back returns to the list),
  // mirroring ServerMetrics ↔ ServerDetail. Look the device up by id each render so
  // the open page keeps receiving live socket updates from the list's state.
  const detail = detailId ? devices.find((d) => d.id === detailId) ?? null : null;
  if (detail) {
    return (
      <>
        <MikrotikDetail
          device={detail}
          isAdmin={isAdmin}
          onBack={() => setDetailId(null)}
          onConfigure={isAdmin ? () => setConfigFor(detail) : undefined}
        />
        {configFor && (
          <ConnectionModal
            device={configFor}
            onClose={() => setConfigFor(null)}
            onSaved={(msg) => {
              setConfigFor(null);
              setToast(msg);
              load();
              setTimeout(() => setToast(""), 3000);
            }}
          />
        )}
        {toast && (
          <div className="fixed top-5 right-5 z-[80] flex items-center gap-2 px-4 py-3 rounded-[2px] border text-xs shadow-xl"
            style={{ color: GREEN, background: GREEN + "14", borderColor: GREEN + "40" }}>
            <span>✓</span> {toast}
          </div>
        )}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-2.5" style={{ background: gf.bg, minHeight: "100%", padding: 12 }}>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 px-0.5">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-[15px] font-semibold truncate" style={{ color: gf.textPrimary }}>MikroTik Network</h1>
          <span className="text-[13px] hidden sm:inline" style={{ color: gf.textDim }}>
            per-port traffic · {portsUp}/{allIfaces.length} ports up
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {isAdmin && (
            <button
              onClick={() => setAdding(true)}
              className="gf-btn inline-flex items-center gap-1.5 text-[13px] font-medium"
              style={{ height: 28, padding: "0 10px", color: "var(--gf-text-primary)" }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              Add MikroTik
            </button>
          )}
          <span className="flex items-center gap-1.5 text-[12px] tracking-widest uppercase" style={{ color: gf.textMuted }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: online > 0 ? GREEN : RED, boxShadow: `0 0 6px ${online > 0 ? GREEN : RED}` }} /> Live
          </span>
        </div>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <StatPanel label="Routers" value={`${online}/${total}`} color={total > 0 && online === total ? GREEN : online === 0 ? RED : ORANGE} sub="online" />
        <StatPanel label="Ports Up" value={`${portsUp}/${allIfaces.length}`} color={allIfaces.length > 0 && portsUp === allIfaces.length ? GREEN : portsUp === 0 ? RED : ORANGE} sub="links up" />
        <StatPanel label="CPU" value={String(worstCpu)} unit="%" color={loadColor(worstCpu)} sub={aggSub} />
        <StatPanel label="Memory" value={String(worstMem)} unit="%" color={loadColor(worstMem)} sub={reporting > 1 ? `worst of ${reporting}` : "router RAM"} />
      </div>

      {total === 0 ? (
        <Panel title="MikroTik">
          <div className="flex flex-col items-center justify-center text-center py-12 px-4">
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" style={{ color: gf.textDim }}>
              <rect x="2" y="4" width="20" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <rect x="2" y="14" width="20" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M6 7h.01M6 17h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <p className="text-[15px] mt-3" style={{ color: gf.textMuted }}>No MikroTik registered yet</p>
            <p className="text-[13px] mt-1 max-w-md" style={{ color: gf.textDim }}>
              Add your router below and set its read-only RouterOS login.
            </p>
            {isAdmin && (
              <button onClick={() => setAdding(true)} className="gf-btn mt-4 text-[14px] px-3 py-1.5 font-medium" style={{ color: "var(--gf-text-primary)" }}>
                + Add MikroTik
              </button>
            )}
          </div>
        </Panel>
      ) : (
        /* Wide list + expandable drawer, matching the Server Metrics front page. */
        <Panel
          title="MikroTik routers"
          noPad
          right={<span className="text-[12px]" style={{ color: gf.textDim }}>{online}/{total} online</span>}
        >
          {/* Mobile: one card per router */}
          <div className="md:hidden flex flex-col gap-2 p-2.5">
            {devices.map((d) => (
              <div key={d.id} className="rounded-[2px] p-2.5" style={{ background: gf.bg, border: `1px solid ${gf.border}` }}>
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: statusColor(d.status), boxShadow: `0 0 5px ${statusColor(d.status)}` }} />
                  <span className="text-[14px] font-medium truncate flex-1" style={{ color: gf.textPrimary }}>{d.name}</span>
                  <PortsCell d={d} />
                </div>
                <div className="text-[12px] font-mono mt-0.5 truncate" style={{ color: gf.textDim }}>{d.ip} · ↑ {formatUptime(d.uptimeSeconds)}</div>
                <div className="flex gap-2 mt-2 flex-wrap">
                  <GhostButton onClick={() => setDetailId(d.id)}>View</GhostButton>
                  {isAdmin && <GhostButton onClick={() => setConfigFor(d)}>Configure</GhostButton>}
                  {isAdmin && <GhostButton danger onClick={() => setConfirmId(d.id)}>Remove</GhostButton>}
                </div>
              </div>
            ))}
          </div>

          {/* Desktop: table + drawer */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr style={{ borderBottom: `1px solid ${gf.divider}` }}>
                  {["Router", "IP Address", "Status", "CPU", "Memory", "Ports", "Leases", "Uptime", ""].map((h) => (
                    <th key={h} className="text-left px-3 py-2 text-[11px] tracking-widest uppercase font-medium whitespace-nowrap" style={{ color: gf.textDim }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {devices.map((d, i) => (
                  <Fragment key={d.id}>
                    <tr
                      onClick={() => toggleDrawer(d.id)}
                      className="cursor-pointer transition-colors"
                      style={{ borderBottom: `1px solid ${gf.divider}`, background: openId === d.id ? gf.hover : i % 2 ? gf.hover : "transparent" }}
                    >
                      <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: gf.textPrimary }}>
                        <div className="text-[14px] font-medium">
                          {d.name}
                          <span className="ml-1.5 text-[12px] inline-block transition-transform" style={{ color: gf.textDim, transform: openId === d.id ? "rotate(180deg)" : "none" }}>▾</span>
                        </div>
                        {d.boardModel && <div className="text-[12px] font-normal" style={{ color: gf.textDim }}>{d.boardModel}</div>}
                      </td>
                      <td className="px-3 py-2.5 text-[13px] font-mono whitespace-nowrap" style={{ color: gf.textMuted }}>{d.ip}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor(d.status), boxShadow: `0 0 5px ${statusColor(d.status)}` }} />
                          <span className="text-[13px]" style={{ color: gf.textMuted }}>{d.status}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className="text-[13px] tabular-nums" style={{ color: d.cpuPercent != null ? loadColor(Math.round(d.cpuPercent)) : gf.textDim }}>
                          {d.cpuPercent != null ? `${Math.round(d.cpuPercent)}%` : "—"}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className="text-[13px] tabular-nums" style={{ color: d.memPercent != null ? loadColor(Math.round(d.memPercent)) : gf.textDim }}>
                          {d.memPercent != null ? `${Math.round(d.memPercent)}%` : "—"}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap"><PortsCell d={d} /></td>
                      <td className="px-3 py-2.5 text-[13px] tabular-nums whitespace-nowrap" style={{ color: gf.textMuted }}>
                        {d.connectedClients != null ? d.connectedClients : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-[13px] whitespace-nowrap" style={{ color: gf.textMuted }}>{formatUptime(d.uptimeSeconds)}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <div className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                          {confirmId === d.id ? (
                            <>
                              <span className="text-[12px]" style={{ color: RED }}>Remove?</span>
                              <button onClick={() => void remove(d.id)} disabled={removing === d.id} className="gf-btn px-2 py-1 text-[12px] font-medium" style={{ color: RED }}>
                                {removing === d.id ? "Removing…" : "Yes"}
                              </button>
                              <button onClick={() => setConfirmId(null)} className="gf-btn px-2 py-1 text-[12px]" style={{ color: gf.textMuted }}>No</button>
                            </>
                          ) : (
                            <>
                              <GhostButton onClick={() => setDetailId(d.id)}>View</GhostButton>
                              {isAdmin && <GhostButton onClick={() => setConfigFor(d)}>Configure</GhostButton>}
                              {isAdmin && <GhostButton danger onClick={() => setConfirmId(d.id)}>Remove</GhostButton>}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                    <MkDrawerRow d={d} isOpen={openId === d.id} colSpan={9} />
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {adding && (
        <AddModal
          usedNames={devices.map((d) => d.name)}
          onClose={() => setAdding(false)}
          onAdded={(msg) => {
            setAdding(false);
            setToast(msg);
            load();
            setTimeout(() => setToast(""), 3000);
          }}
        />
      )}

      {configFor && (
        <ConnectionModal
          device={configFor}
          onClose={() => setConfigFor(null)}
          onSaved={(msg) => {
            setConfigFor(null);
            setToast(msg);
            load();
            setTimeout(() => setToast(""), 3000);
          }}
        />
      )}

      {toast && (
        <div
          className="fixed top-5 right-5 z-[80] flex items-center gap-2 px-4 py-3 rounded-[2px] border text-xs shadow-xl"
          style={{ color: GREEN, background: GREEN + "14", borderColor: GREEN + "40" }}
        >
          <span>✓</span> {toast}
        </div>
      )}
    </div>
  );
}
