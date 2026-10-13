import { useState } from "react";
import { api } from "../../api/api";
import type { MkDevice } from "../../pages/MikrotikDetail";
import { GF as gf, STATUS } from "../../theme/gf";
import { formatUptime } from "../../utils/format";
import { Meta } from "../ui/primitives";
const { green: GREEN, orange: ORANGE, red: RED, blue: BLUE } = STATUS;

// ─── MikroTik pieces of the Network page ──────────────────────────────────────
// MikroTiks used to have their own page and sidebar entry. ICTU's network admin asked
// for one Network page ("they are all network"), so NetworkMonitoring now lists them
// beside the SNMP / ping routers and uses these for the MikroTik rows: mapping, live
// merge, status, drawer, and the Add / RouterOS-connection modals. Monitoring itself is
// unchanged — still the RouterOS API poller, still /api/mikrotik.


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
// ─── Mapping ──────────────────────────────────────────────────────────────────

export function mapMk(r: any): MkDevice {
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
// Merge one live `networkMetrics` payload into the current row. All fields are optional:
// a poll carries metrics, an add or config save carries identity and settings. Missing
// fields keep their value.
export function mergeMkLive(prev: MkDevice | undefined, p: any): MkDevice {
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
    // Only a real poll carries ports; an add/config save sends an empty array, which must
    // not clear them. Offline is handled by the `networkStatus` event.
    interfaces: Array.isArray(p.interfaces) && p.interfaces.length ? mapMk(p).interfaces : base.interfaces,
  };
}

// ─── Status, including "API not configured" ──────────────────────────
// A MikroTik with no RouterOS login has never been polled, so `status` is "Offline",
// but it is not down: an admin needs to add the login. So the row shows "API not
// configured" where the status is.
export function MkStatus({ d }: { d: MkDevice }) {
  if (!d.monitored) {
    return (
      <span
        className="inline-flex items-center gap-1.5"
        title="No read-only RouterOS login is set for this router, so it has never been polled. Use Configure to set one."
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: ORANGE, boxShadow: `0 0 5px ${ORANGE}` }} />
        <span className="text-[13px] whitespace-nowrap" style={{ color: ORANGE }}>API not configured</span>
      </span>
    );
  }
  const c = statusColor(d.status);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: c, boxShadow: `0 0 5px ${c}` }} />
      <span className="text-[13px]" style={{ color: gf.textMuted }}>{d.status}</span>
    </span>
  );
}

// ─── Drawer row (expands under a table row) ───────────────────────────────────
// Same pattern as ServerMetrics' ServerDrawerRow: the row has the summary, the drawer
// the ports and identity.
export function MkDrawerRow({ d, isOpen, colSpan }: { d: MkDevice; isOpen: boolean; colSpan: number }) {
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
              {/* Was a table column on the MikroTik page; the merged table has no room for a
                  column only MikroTiks fill, so it lives here. */}
              {d.connectedClients != null && <Meta label="DHCP leases" value={String(d.connectedClients)} />}
            </div>
            {!d.monitored ? (
              /* The row already carries the flag (see MkStatus). This is the expanded
                 half: what to actually do about it. */
              <div className="text-[13px]" style={{ color: ORANGE }}>
                No RouterOS login is set, so this router has never been polled. An admin can
                set a read-only API user with <span style={{ color: gf.textPrimary }}>Configure</span>.
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
export function MkPortsCell({ d }: { d: MkDevice }) {
  const up = d.interfaces.filter((i) => i.linkUp).length;
  const total = d.interfaces.length;
  const color = total === 0 ? gf.textDim : up === total ? GREEN : up === 0 ? RED : ORANGE;
  return (
    <span className="text-[13px] tabular-nums" style={{ color }}>
      {total === 0 ? "—" : `${up}/${total}`}
    </span>
  );
}

// ─── Port chip (per-port state in the list row) ──────────────────────
// The list only shows which ports are up; bars are in the detail view.

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

// ─── Password input with show/hide ───────────────────────────────────
// RouterOS passwords are never shown after saving, so let the admin check what they
// typed first.

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

export function AddMikrotikModal({ onClose, onAdded, usedNames }: { onClose: () => void; onAdded: (msg: string) => void; usedNames: string[] }) {
  // Empty fields with placeholders, not pre-filled values that have to be deleted each
  // time. Location may be empty: createDevice uses "Server Room" by default.
  const [name, setName] = useState("");
  const [ip, setIp] = useState("");
  const [location, setLocation] = useState("");
  const [apiPort, setApiPort] = useState<number>(8728);
  const [useTls, setUseTls] = useState(false);
  const [apiUsername, setApiUsername] = useState("");
  const [apiPassword, setApiPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // Changing a field the test depends on clears the test result, so a pass never refers
  // to values that were not tested. Same as the Add router / Add UPS forms (see
  // components/devices/DeviceProbe.tsx).
  const edit = <T,>(setter: (v: T) => void) => (v: T) => {
    setTestResult(null);
    setter(v);
  };

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
    // Does not say it works yet: the backend logs in and polls once, and the result arrives
    // on `deviceFirstPoll` a moment later and replaces this line.
    if (r.success) onAdded("MikroTik registered — testing the API login…");
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
            <input name="name" className={inputCls} style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Campus MikroTik" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} style={{ color: gf.textMuted }}>IP address</label>
              <input name="ip" className={inputCls} style={inputStyle} value={ip} onChange={(e) => edit(setIp)(e.target.value)} placeholder="192.168.88.1" />
            </div>
            <div>
              <label className={labelCls} style={{ color: gf.textMuted }}>Location</label>
              <input name="location" className={inputCls} style={inputStyle} value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Server Room" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} style={{ color: gf.textMuted }}>API Port</label>
              <input name="apiPort" type="number" className={inputCls} style={inputStyle} value={apiPort} onChange={(e) => edit(setApiPort)(Number(e.target.value))} />
            </div>
            <label className="flex items-center gap-2 text-[14px] cursor-pointer self-end pb-1.5" style={{ color: gf.textPrimary }}>
              <input name="useTls"
                type="checkbox"
                checked={useTls}
                onChange={(e) => {
                  const on = e.target.checked;
                  setTestResult(null);
                  setUseTls(on);
                  // Switch the port with the TLS toggle (8728 ↔ 8729); TLS on the plain port just hangs
                  // until timeout. Only the two default ports are switched; a custom port is left alone.
                  setApiPort((p) => (on ? (p === 8728 ? 8729 : p) : p === 8729 ? 8728 : p));
                }}
              />
              Use TLS (8729)
            </label>
          </div>
          <div>
            <label className={labelCls} style={{ color: gf.textMuted }}>Username (read-only RouterOS user)</label>
            <input name="apiUsername" className={inputCls} style={inputStyle} value={apiUsername} onChange={(e) => edit(setApiUsername)(e.target.value)} placeholder="monitor-ro" autoComplete="off" />
          </div>
          <div>
            <label className={labelCls} style={{ color: gf.textMuted }}>Password</label>
            <PasswordField value={apiPassword} onChange={edit(setApiPassword)} placeholder="RouterOS API password" />
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
          {/* A failed or skipped test never blocks saving (the API service may not be enabled
             yet); it states the consequence instead. Same on all three Add forms. */}
          {!testResult?.ok && (
            <p className="text-[11px]" style={{ color: gf.textDim }}>
              Not verified yet. Adding without a successful test is allowed — the card will
              show as Offline until the API login works.
            </p>
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

export function ConnectionModal({
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

  // Tests what is typed, not what is saved. A blank password uses the saved one.
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
                  // Switch the port with the TLS toggle (8728 ↔ 8729); TLS on the plain port just hangs
                  // until timeout. Only the two default ports are switched; a custom port is left alone.
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
