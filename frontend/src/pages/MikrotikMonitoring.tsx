import { useState, useEffect, useRef } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import { useAuth } from "../context/AuthContext";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MkIface {
  name: string;
  locationLabel: string; // the building this port serves
  linkUp: boolean;
  utilizationPct: number | null;
  rxBytes: string | null;
  txBytes: string | null;
}
interface MkDevice {
  id: string;
  name: string;
  ip: string;
  location: string;
  status: string;
  reachable: boolean | null;
  uptimeSeconds: number | null;
  cpuPercent: number | null;
  memPercent: number | null;
  connectedClients: number | null;
  routerosVersion: string | null;
  boardModel: string | null;
  apiPort: number | null;
  useTls: boolean;
  apiUsername: string | null;
  interfaces: MkIface[];
  monitored: boolean;
}
interface HistPoint {
  time: string;
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
}

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
const TRACK = "rgba(127,127,127,0.18)";
const BAR_GRADIENT = "linear-gradient(90deg,#73BF69 0%,#73BF69 55%,#FF780A 78%,#F2495C 95%)";

const RANGES = ["-1h", "-6h", "-24h"] as const;
type Range = (typeof RANGES)[number];
const rangeLabel: Record<Range, string> = { "-1h": "1h", "-6h": "6h", "-24h": "24h" };

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
function formatBps(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const bits = n * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gb/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(2)} Mb/s`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(1)} kb/s`;
  return `${Math.round(bits)} b/s`;
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
    routerosVersion: r.routerosVersion ?? null,
    boardModel: r.boardModel ?? null,
    apiPort: r.apiPort ?? null,
    useTls: Boolean(r.useTls),
    apiUsername: r.apiUsername ?? null,
    interfaces: (r.interfaces ?? []).map((i: any) => ({
      name: i.name ?? "—",
      locationLabel: i.locationLabel ?? "",
      linkUp: Boolean(i.linkUp),
      utilizationPct: i.utilizationPct ?? null,
      rxBytes: i.rxBytes ?? null,
      txBytes: i.txBytes ?? null,
    })),
    monitored: r.monitored ?? true,
  };
}
function mergeMkLive(prev: MkDevice | undefined, p: any): MkDevice {
  const base = prev ?? mapMk({ ...p, monitored: true });
  return {
    ...base,
    status: p.status ?? base.status,
    reachable: p.reachable ?? base.reachable,
    uptimeSeconds: p.uptimeSeconds ?? base.uptimeSeconds,
    cpuPercent: p.cpuPercent ?? base.cpuPercent,
    memPercent: p.memPercent ?? base.memPercent,
    connectedClients: p.connectedClients ?? base.connectedClients,
    interfaces: p.interfaces ? mapMk(p).interfaces : base.interfaces,
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
    <div className="flex flex-col rounded-lg overflow-hidden" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
      {title !== undefined && (
        <div className="flex items-center justify-between px-3 shrink-0" style={{ height: 32, borderBottom: `1px solid ${gf.divider}` }}>
          <span className="text-[11px] font-medium tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>{title}</span>
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
        <span className="text-[10px] tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>{label}</span>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      </div>
      <div className="px-3 pt-1.5">
        <span className="text-[26px] font-bold leading-none" style={{ color }}>{value}</span>
        {unit && <span className="text-[13px] ml-1" style={{ color: color + "AA" }}>{unit}</span>}
        {sub && <div className="text-[9px] mt-1 tracking-widest uppercase" style={{ color: gf.textDim }}>{sub}</div>}
      </div>
    </div>
  );
}

// ─── Throughput history chart (rx/tx dual line) ───────────────────────────────

function ThroughputChart({ history }: { history: HistPoint[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const W = (c.width = c.clientWidth * 2);
    const H = (c.height = 160 * 2);
    ctx.clearRect(0, 0, W, H);
    const rx = history.map((p) => p.rxBytesPerSec ?? 0);
    const tx = history.map((p) => p.txBytesPerSec ?? 0);
    if (rx.length < 2) {
      ctx.fillStyle = "#6B7280";
      ctx.font = "24px 'JetBrains Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText("No data in range", W / 2, H / 2);
      return;
    }
    const max = Math.max(1, ...rx, ...tx);
    const pad = 12 * 2;
    const x = (i: number, len: number) => pad + (i / (len - 1)) * (W - pad * 2);
    const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
    const line = (data: number[], color: string) => {
      ctx.beginPath();
      data.forEach((v, i) => (i ? ctx.lineTo(x(i, data.length), y(v)) : ctx.moveTo(x(i, data.length), y(v))));
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.lineJoin = "round";
      ctx.stroke();
    };
    line(rx, BLUE);
    line(tx, GREEN);
  }, [history]);
  return <canvas ref={ref} style={{ width: "100%", height: 160, display: "block" }} />;
}

// ─── Building (interface) row ─────────────────────────────────────────────────

function BuildingRow({ i }: { i: MkIface }) {
  const util = Math.round(i.utilizationPct ?? 0);
  const primary = i.locationLabel || i.name; // building label leads; port name is secondary
  const secondary = i.locationLabel ? i.name : "";
  return (
    <div className="flex items-center gap-3 px-3 py-2" style={{ borderBottom: `1px solid ${gf.divider}` }}>
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: i.linkUp ? GREEN : RED, boxShadow: `0 0 5px ${i.linkUp ? GREEN : RED}` }} />
      <div className="w-36 min-w-0">
        <div className="text-[12px] truncate" style={{ color: gf.textPrimary }}>{primary}</div>
        {secondary && <div className="text-[9px] truncate" style={{ color: gf.textDim }}>{secondary}</div>}
      </div>
      <div className="flex-1 h-3 rounded-[2px] overflow-hidden" style={{ background: TRACK }}>
        <div className="h-full rounded-[2px] transition-all duration-500" style={{ width: `${i.linkUp ? util : 0}%`, background: BAR_GRADIENT, backgroundSize: `${util > 0 ? (100 / util) * 100 : 100}% 100%` }} />
      </div>
      <span className="text-[11px] font-bold w-12 text-right shrink-0" style={{ color: i.linkUp ? loadColor(util) : gf.textDim }}>
        {i.linkUp ? `${util}%` : "down"}
      </span>
    </div>
  );
}

// ─── Admin: add a new MikroTik ────────────────────────────────────────────────

function AddModal({ onClose, onAdded }: { onClose: () => void; onAdded: (msg: string) => void }) {
  const [name, setName] = useState("Campus MikroTik");
  const [ip, setIp] = useState("");
  const [location, setLocation] = useState("Server Room");
  const [apiPort, setApiPort] = useState<number>(8728);
  const [useTls, setUseTls] = useState(false);
  const [apiUsername, setApiUsername] = useState("");
  const [apiPassword, setApiPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    if (!name.trim() || !ip.trim()) {
      setErr("Name and IP are required.");
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

  const labelCls = "text-[10px] tracking-widest uppercase mb-1 block";
  const inputCls = "w-full px-2 py-1.5 text-[12px] rounded-[2px] outline-none";
  const inputStyle = { background: gf.bg, border: `1px solid ${gf.border}`, color: gf.textPrimary } as const;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div className="w-full max-w-md rounded-lg overflow-hidden" style={{ background: gf.panel, border: `1px solid ${gf.border}` }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4" style={{ height: 40, borderBottom: `1px solid ${gf.divider}` }}>
          <span className="text-[12px] font-semibold" style={{ color: gf.textPrimary }}>Add MikroTik</span>
          <button onClick={onClose} className="text-[18px] leading-none" style={{ color: gf.textMuted }}>×</button>
        </div>
        <div className="p-4 flex flex-col gap-3">
          <div>
            <label className={labelCls} style={{ color: gf.textMuted }}>Name</label>
            <input className={inputCls} style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} style={{ color: gf.textMuted }}>IP address</label>
              <input className={inputCls} style={inputStyle} value={ip} onChange={(e) => setIp(e.target.value)} placeholder="192.168.88.1" />
            </div>
            <div>
              <label className={labelCls} style={{ color: gf.textMuted }}>Location</label>
              <input className={inputCls} style={inputStyle} value={location} onChange={(e) => setLocation(e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} style={{ color: gf.textMuted }}>API Port</label>
              <input type="number" className={inputCls} style={inputStyle} value={apiPort} onChange={(e) => setApiPort(Number(e.target.value))} />
            </div>
            <label className="flex items-center gap-2 text-[12px] cursor-pointer self-end pb-1.5" style={{ color: gf.textPrimary }}>
              <input type="checkbox" checked={useTls} onChange={(e) => setUseTls(e.target.checked)} />
              Use TLS (8729)
            </label>
          </div>
          <div>
            <label className={labelCls} style={{ color: gf.textMuted }}>Username (read-only RouterOS user)</label>
            <input className={inputCls} style={inputStyle} value={apiUsername} onChange={(e) => setApiUsername(e.target.value)} placeholder="monitor-ro" autoComplete="off" />
          </div>
          <div>
            <label className={labelCls} style={{ color: gf.textMuted }}>Password</label>
            <input type="password" className={inputCls} style={inputStyle} value={apiPassword} onChange={(e) => setApiPassword(e.target.value)} placeholder="RouterOS API password" autoComplete="new-password" />
            <p className="text-[9px] mt-1" style={{ color: gf.textDim }}>Stored encrypted (AES-256-GCM).</p>
          </div>
          {err && (
            <div className="text-[11px] px-2 py-1.5 rounded-[2px]" style={{ color: RED, background: RED + "14", border: `1px solid ${RED}40` }}>{err}</div>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <button onClick={onClose} className="text-[11px] px-3 py-1.5 rounded-[2px]" style={{ color: gf.textMuted }}>Cancel</button>
            <button onClick={submit} disabled={busy || !name.trim() || !ip.trim()} className="text-[11px] px-3 py-1.5 rounded-[2px] font-semibold" style={{ background: BLUE, color: "#fff", opacity: busy || !name.trim() || !ip.trim() ? 0.6 : 1 }}>
              {busy ? "Adding…" : "Add MikroTik"}
            </button>
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

  const test = async () => {
    setBusy("test");
    setResult(null);
    const r = await api.testMikrotik(Number(device.id));
    setBusy("");
    const data: any = r.data ?? {};
    if (r.success && data.ok) {
      setResult({ ok: true, msg: `OK — RouterOS ${data.version ?? "?"}${data.boardName ? ` · ${data.boardName}` : ""}` });
    } else {
      setResult({ ok: false, msg: data.error || r.error || "Connection failed" });
    }
  };

  const labelCls = "text-[10px] tracking-widest uppercase mb-1 block";
  const inputCls = "w-full px-2 py-1.5 text-[12px] rounded-[2px] outline-none";
  const inputStyle = { background: gf.bg, border: `1px solid ${gf.border}`, color: gf.textPrimary } as const;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div className="w-full max-w-md rounded-lg overflow-hidden" style={{ background: gf.panel, border: `1px solid ${gf.border}` }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4" style={{ height: 40, borderBottom: `1px solid ${gf.divider}` }}>
          <span className="text-[12px] font-semibold truncate" style={{ color: gf.textPrimary }}>RouterOS connection · {device.name}</span>
          <button onClick={onClose} className="text-[18px] leading-none" style={{ color: gf.textMuted }}>×</button>
        </div>
        <div className="p-4 flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} style={{ color: gf.textMuted }}>API Port</label>
              <input type="number" className={inputCls} style={inputStyle} value={apiPort} onChange={(e) => setApiPort(Number(e.target.value))} />
            </div>
            <label className="flex items-center gap-2 text-[12px] cursor-pointer self-end pb-1.5" style={{ color: gf.textPrimary }}>
              <input type="checkbox" checked={useTls} onChange={(e) => setUseTls(e.target.checked)} />
              Use TLS (8729)
            </label>
          </div>
          <div>
            <label className={labelCls} style={{ color: gf.textMuted }}>Username (read-only RouterOS user)</label>
            <input className={inputCls} style={inputStyle} value={apiUsername} onChange={(e) => setApiUsername(e.target.value)} placeholder="monitor-ro" autoComplete="off" />
          </div>
          <div>
            <label className={labelCls} style={{ color: gf.textMuted }}>Password</label>
            <input type="password" className={inputCls} style={inputStyle} value={apiPassword} onChange={(e) => setApiPassword(e.target.value)} placeholder="leave blank to keep current" autoComplete="new-password" />
            <p className="text-[9px] mt-1" style={{ color: gf.textDim }}>Stored encrypted (AES-256-GCM); never shown again.</p>
          </div>

          {result && (
            <div className="text-[11px] px-2 py-1.5 rounded-[2px]" style={{ color: result.ok ? GREEN : RED, background: (result.ok ? GREEN : RED) + "14", border: `1px solid ${(result.ok ? GREEN : RED)}40` }}>
              {result.msg}
            </div>
          )}

          <div className="flex items-center justify-between gap-2 pt-1">
            <button onClick={test} disabled={busy !== ""} className="text-[11px] px-3 py-1.5 rounded-[2px]" style={{ color: gf.textMuted, border: `1px solid ${gf.border}`, opacity: busy ? 0.6 : 1 }}>
              {busy === "test" ? "Testing…" : "Test connection"}
            </button>
            <div className="flex items-center gap-2">
              <button onClick={onClose} className="text-[11px] px-3 py-1.5 rounded-[2px]" style={{ color: gf.textMuted }}>Cancel</button>
              <button onClick={save} disabled={busy !== "" || !apiUsername.trim()} className="text-[11px] px-3 py-1.5 rounded-[2px] font-semibold" style={{ background: BLUE, color: "#fff", opacity: busy || !apiUsername.trim() ? 0.6 : 1 }}>
                {busy === "save" ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
          <p className="text-[9px]" style={{ color: gf.textDim }}>Test uses the saved credentials — Save first, then Test.</p>
        </div>
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function MikrotikMonitoring() {
  const [devices, setDevices] = useState<MkDevice[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("-1h");
  const [history, setHistory] = useState<HistPoint[]>([]);
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [configFor, setConfigFor] = useState<MkDevice | null>(null);
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState("");

  const load = () =>
    api.getMikrotikDevices().then((r) => {
      if (r.success && r.data) {
        const list: MkDevice[] = (r.data.devices ?? []).map(mapMk);
        setDevices(list);
        setSelectedId((cur) => cur ?? (list[0]?.id ?? null));
      }
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
      setSelectedId((cur) => cur ?? id);
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
    socket.on("networkMetrics", onMetrics);
    socket.on("networkStatus", onStatus);
    return () => {
      socket.off("networkMetrics", onMetrics);
      socket.off("networkStatus", onStatus);
    };
  }, []);

  // Throughput history for the selected device whenever it / the range changes.
  useEffect(() => {
    if (!selectedId) {
      setHistory([]);
      return;
    }
    api.getMikrotikHistory(Number(selectedId), range).then((r) => {
      if (r.success && r.data) setHistory(r.data.history ?? []);
    });
  }, [selectedId, range]);

  const total = devices.length;
  const online = devices.filter((d) => d.status === "Online").length;
  const allIfaces = devices.flatMap((d) => d.interfaces);
  const portsUp = allIfaces.filter((i) => i.linkUp).length;
  const cpuVals = devices.filter((d) => d.cpuPercent != null).map((d) => d.cpuPercent as number);
  const memVals = devices.filter((d) => d.memPercent != null).map((d) => d.memPercent as number);
  const avgCpu = cpuVals.length ? Math.round(cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length) : 0;
  const avgMem = memVals.length ? Math.round(memVals.reduce((a, b) => a + b, 0) / memVals.length) : 0;
  const selected = devices.find((d) => d.id === selectedId) ?? null;
  const latest = history.length ? history[history.length - 1] : undefined;

  return (
    <div className="flex flex-col gap-2.5" style={{ background: gf.bg, minHeight: "100%", padding: 12 }}>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 px-0.5">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-[15px] font-semibold truncate" style={{ color: gf.textPrimary }}>MikroTik Network</h1>
          <span className="text-[11px] hidden sm:inline" style={{ color: gf.textDim }}>per-building traffic · {portsUp}/{allIfaces.length} ports up</span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {isAdmin && (
            <button onClick={() => setAdding(true)} className="text-[11px] px-2.5 py-1 rounded-[2px] font-medium" style={{ background: BLUE, color: "#fff" }}>
              + Add MikroTik
            </button>
          )}
          <span className="flex items-center gap-1.5 text-[10px] tracking-widest uppercase" style={{ color: gf.textMuted }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: online > 0 ? GREEN : RED, boxShadow: `0 0 6px ${online > 0 ? GREEN : RED}` }} /> Live
          </span>
        </div>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <StatPanel label="Building Ports" value={String(allIfaces.length)} color={BLUE} sub={`${total} router${total === 1 ? "" : "s"}`} />
        <StatPanel label="Ports Up" value={`${portsUp}/${allIfaces.length}`} color={portsUp === allIfaces.length && allIfaces.length > 0 ? GREEN : portsUp === 0 ? RED : ORANGE} sub="links online" />
        <StatPanel label="CPU" value={String(avgCpu)} unit="%" color={loadColor(avgCpu)} sub="router load" />
        <StatPanel label="Memory" value={String(avgMem)} unit="%" color={loadColor(avgMem)} sub="router RAM" />
      </div>

      {total === 0 ? (
        <Panel title="MikroTik">
          <div className="flex flex-col items-center justify-center text-center py-12 px-4">
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" style={{ color: gf.textDim }}>
              <rect x="2" y="4" width="20" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <rect x="2" y="14" width="20" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M6 7h.01M6 17h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <p className="text-[13px] mt-3" style={{ color: gf.textMuted }}>No MikroTik registered yet</p>
            <p className="text-[11px] mt-1 max-w-md" style={{ color: gf.textDim }}>
              Run <span style={{ color: gf.textMuted }}>migrations/2026-06-20_mikrotik_device.sql</span>, then add your router below
              and set its read-only RouterOS login.
            </p>
            {isAdmin && (
              <button onClick={() => setAdding(true)} className="mt-4 text-[12px] px-3 py-1.5 rounded-[2px] font-medium" style={{ background: BLUE, color: "#fff" }}>
                + Add MikroTik
              </button>
            )}
          </div>
        </Panel>
      ) : (
        <>
          {/* Selected device throughput history */}
          {selected && (
            <Panel
              title={`Throughput · ${selected.name}`}
              right={
                <div className="flex items-center gap-2">
                  <span className="text-[10px]" style={{ color: BLUE }}>↓ {formatBps(latest?.rxBytesPerSec ?? null)}</span>
                  <span className="text-[10px]" style={{ color: GREEN }}>↑ {formatBps(latest?.txBytesPerSec ?? null)}</span>
                  <div className="flex rounded-md overflow-hidden" style={{ border: `1px solid ${gf.border}` }}>
                    {RANGES.map((rg) => (
                      <button
                        key={rg}
                        onClick={() => setRange(rg)}
                        className="text-[10px] px-2 py-0.5 transition-colors"
                        style={{ background: range === rg ? gf.hover : "transparent", color: range === rg ? gf.textPrimary : gf.textMuted }}
                      >
                        {rangeLabel[rg]}
                      </button>
                    ))}
                  </div>
                </div>
              }
            >
              <ThroughputChart history={history} />
            </Panel>
          )}

          {/* Per-device: info + buildings (ports) */}
          {devices.map((d) => (
            <Panel
              key={d.id}
              title={d.name}
              noPad
              right={
                <div className="flex items-center gap-2">
                  {isAdmin && (
                    <button onClick={() => setConfigFor(d)} className="text-[10px] px-2 py-0.5 rounded-[2px]" style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}>
                      Configure
                    </button>
                  )}
                  <button onClick={() => setSelectedId(d.id)} className="flex items-center gap-2">
                    <span className="text-[10px] font-mono" style={{ color: gf.textDim }}>{d.ip}</span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor(d.status), boxShadow: `0 0 5px ${statusColor(d.status)}` }} />
                      <span className="text-[11px]" style={{ color: gf.textMuted }}>{d.status}</span>
                    </span>
                  </button>
                </div>
              }
            >
              {/* device summary line */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-[10px]" style={{ color: gf.textDim, borderBottom: `1px solid ${gf.divider}` }}>
                <span>{d.location}</span>
                <span>CPU <span style={{ color: loadColor(Math.round(d.cpuPercent ?? 0)) }}>{d.cpuPercent != null ? `${Math.round(d.cpuPercent)}%` : "—"}</span></span>
                <span>MEM <span style={{ color: loadColor(Math.round(d.memPercent ?? 0)) }}>{d.memPercent != null ? `${Math.round(d.memPercent)}%` : "—"}</span></span>
                <span>{d.connectedClients != null ? `${d.connectedClients} clients` : "— clients"}</span>
                {d.routerosVersion && <span>RouterOS {d.routerosVersion}</span>}
                {d.boardModel && <span>{d.boardModel}</span>}
                <span className="ml-auto">↑ {formatUptime(d.uptimeSeconds)}</span>
              </div>
              {!d.monitored ? (
                <div className="px-3 py-4 text-[11px]" style={{ color: ORANGE }}>API not configured — set the read-only RouterOS login (admin).</div>
              ) : d.interfaces.length === 0 ? (
                <div className="px-3 py-4 text-[11px]" style={{ color: gf.textDim }}>
                  {d.status === "Online" ? "No ports reported." : "Offline — awaiting next poll."}
                </div>
              ) : (
                d.interfaces.map((i) => <BuildingRow key={`${d.id}:${i.name}`} i={i} />)
              )}
            </Panel>
          ))}
        </>
      )}

      {adding && (
        <AddModal
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
