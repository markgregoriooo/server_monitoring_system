import { Fragment, useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import { useAuth } from "../context/AuthContext";
import NetworkDetail from "./NetworkDetail";
import type { NetDevice } from "./NetworkDetail";
import { GF as gf, STATUS } from "../theme/gf";
import { formatUptime } from "../utils/format";
import { GhostButton, StatPanel, Field, Meta } from "../components/ui/primitives";
const { green: GREEN, orange: ORANGE, red: RED, blue: BLUE } = STATUS;

// ─── Router list page ─────────────────────────────────────────────────────────
//
// USER-FACING WORDING: everything here says "router", never "router/switch".
// A managed switch is still fully supported and registers through this same form —
// SNMP reads IF-MIB from both and the poller cannot tell them apart — but naming
// both device classes in the UI raised more questions than it answered at CSPC,
// where there is no switch to register. The capability is documented in
// router-ups-monitoring.md; the label is kept plain.
// First page = the fleet list (one compact card per router, with "View"); clicking
// through swaps in NetworkDetail for the full drill-down. Mirrors
// MikrotikMonitoring ↔ MikrotikDetail and ServerMetrics ↔ ServerDetail, so moving
// between the MikroTik and SNMP pages doesn't mean relearning the layout.
// Types live in NetworkDetail.tsx — this module imports them, never the reverse.

// ─── Grafana tokens (match ServerMetrics.tsx) ─────────────────────────────────



const inputStyle: React.CSSProperties = {
  background: gf.bg,
  border: `1px solid ${gf.border}`,
  color: gf.textPrimary,
  fontFamily: "'JetBrains Mono', monospace",
};

// Blank form for "Add router". Community defaults to the ubiquitous read-only "public".
interface NetForm {
  name: string;
  ip: string;
  community: string;
  snmpPort: string;
  location: string;
}
const EMPTY_NET_FORM: NetForm = {
  name: "",
  ip: "",
  community: "", // blank = ICMP-only monitoring (see the note in save())
  snmpPort: "161",
  location: "CSPC-ICTU Server Room",
};

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

function mapNet(r: any): NetDevice {
  return {
    id: String(r.id),
    name: r.name ?? "—",
    ip: r.ip ?? "—",
    location: r.location ?? "—",
    status: r.status ?? "Offline",
    reachable: r.reachable ?? null,
    descr: r.descr ?? null,
    sysName: r.sysName ?? null,
    uptimeSeconds: r.uptimeSeconds ?? null,
    interfaces: (r.interfaces ?? []).map((i: any) => ({
      name: i.name ?? "—",
      locationLabel: i.locationLabel ?? "",
      linkUp: Boolean(i.linkUp),
      utilizationPct: i.utilizationPct ?? null,
      speedMbps: i.speedMbps ?? null,
      rxErrors: i.rxErrors ?? null,
      txErrors: i.txErrors ?? null,
      rxBytes: i.rxBytes ?? null,
      txBytes: i.txBytes ?? null,
    })),
    monitored: r.monitored ?? true,
    mode: r.mode ?? "snmp",
    latencyMs: r.latencyMs ?? null,
    packetLossPct: r.packetLossPct ?? null,
  };
}
function mergeNetLive(prev: NetDevice | undefined, p: any): NetDevice {
  const base = prev ?? mapNet({ ...p, monitored: true });
  return {
    ...base,
    status: p.status ?? base.status,
    reachable: p.reachable ?? base.reachable,
    descr: p.descr ?? base.descr,
    sysName: p.sysName ?? base.sysName,
    uptimeSeconds: p.uptimeSeconds ?? base.uptimeSeconds,
    // ?? would keep a stale reading when the newest poll measured null — which for
    // latency is exactly the total-loss case, i.e. the one worth showing.
    latencyMs: "latencyMs" in p ? p.latencyMs : base.latencyMs,
    packetLossPct: "packetLossPct" in p ? p.packetLossPct : base.packetLossPct,
    mode: p.mode ?? base.mode,
    interfaces: p.interfaces ? mapNet(p).interfaces : base.interfaces,
  };
}

// ─── Panel ────────────────────────────────────────────────────────────────────

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

// ─── Ghost button (matches ServerMetrics "View") ──────────────────────────────

// ─── Port chip (compact per-port state for the LIST card) ─────────────────────
// The list only needs an at-a-glance "which ports are up"; the full per-port table
// (speed / Tx / Rx / errors / util) lives in the detail view. Matches MikroTik's
// list — and replaces the old full-width utilization bars, whose empty tracks read
// as loading skeletons on the idle ports that are the normal case here.

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

// One labelled fact in a drawer's summary strip. The strip used to be bare values
// separated by gaps — "dev-router-01", "RB951G-2HnD", "4h 16m" — which only reads if
// you already know the schema. The key is what makes a value information.
// ─── Drawer row (expands under a table row) ───────────────────────────────────
// Mirrors ServerMetrics' ServerDrawerRow: the table shows what you SCAN, the drawer
// holds what you'd otherwise have to open the detail page for. Animated by max-height
// rather than conditional rendering, so it slides instead of snapping.
function NetDrawerRow({ d, isOpen, colSpan }: { d: NetDevice; isOpen: boolean; colSpan: number }) {
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
              {d.sysName && <Meta label="System name" value={d.sysName} mono />}
              {d.descr && <Meta label="Description" value={d.descr} />}
              <Meta label="Uptime" value={formatUptime(d.uptimeSeconds)} />
            </div>
            {d.mode === "ping" ? (
              /* A ping device is not a broken SNMP device, and must not look like
                 one. It reports exactly three things and will never report ports, so
                 name the mode and show what it does have instead of an empty list. */
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] tracking-widest uppercase" style={{ color: gf.textDim }}>
                  ICMP ping · no SNMP community
                </span>
                <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5">
                  <Meta
                    label="Latency"
                    value={d.latencyMs == null ? "—" : `${d.latencyMs} ms`}
                  />
                  <Meta
                    label="Packet loss"
                    value={d.packetLossPct == null ? "—" : `${d.packetLossPct}%`}
                  />
                </div>
                <span className="text-[12px]" style={{ color: gf.textDim }}>
                  Reachability, latency and loss only — enable SNMP on this device for
                  per-port traffic and link status.
                </span>
              </div>
            ) : d.interfaces.length === 0 ? (
              <div className="text-[13px]" style={{ color: gf.textDim }}>
                {d.status === "Online" ? "No interfaces reported." : "Offline — awaiting next poll."}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] tracking-widest uppercase" style={{ color: gf.textDim }}>
                  Ports · {up}/{d.interfaces.length} up
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {d.interfaces.map((i) => (
                    <PortChip key={`${d.id}:${i.name}`} label={i.locationLabel || i.name} up={i.linkUp} util={i.utilizationPct} />
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

// Compact ports figure for the table cell — the count is the scannable bit, the chips
// live in the drawer.
function PortsCell({ d }: { d: NetDevice }) {
  // A ping device has no ports and never will. An em-dash here would read as
  // "SNMP is broken / not polled yet", which is the opposite of the truth — so say
  // what it IS instead, and put the one number it does have where the eye lands.
  if (d.mode === "ping") {
    const loss = d.packetLossPct;
    const lossColor =
      loss == null ? gf.textDim : loss >= 50 ? RED : loss > 0 ? ORANGE : GREEN;
    return (
      <span className="inline-flex items-baseline gap-1.5">
        <span className="text-[11px] tracking-wider uppercase" style={{ color: gf.textDim }}>ping</span>
        <span className="text-[13px] tabular-nums" style={{ color: lossColor }}>
          {loss == null ? "—" : loss > 0 ? `${loss}% loss` : `${d.latencyMs ?? "—"} ms`}
        </span>
      </span>
    );
  }
  const up = d.interfaces.filter((i) => i.linkUp).length;
  const total = d.interfaces.length;
  const color = total === 0 ? gf.textDim : up === total ? GREEN : up === 0 ? RED : ORANGE;
  return (
    <span className="text-[13px] tabular-nums" style={{ color }}>
      {total === 0 ? "—" : `${up}/${total}`}
    </span>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function NetworkMonitoring() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [devices, setDevices] = useState<NetDevice[]>([]);
  // Drill-down target held by ID (not a snapshot) so the open detail page keeps
  // getting the list-level live updates. Same pattern as MikrotikMonitoring.
  const [detailId, setDetailId] = useState<string | null>(null);

  // Add-router modal + inline remove-confirm + toast (admin only).
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<NetForm>(EMPTY_NET_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // Which row's drawer is open (one at a time), same as ServerMetrics.
  const [openId, setOpenId] = useState<string | null>(null);
  const toggleDrawer = (id: string) => setOpenId((prev) => (prev === id ? null : id));
  const [toast, setToast] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();

  // Deep-link from a notification: /network?device=<id> opens that router's detail
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
  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  };

  const openAdd = () => {
    setForm(EMPTY_NET_FORM);
    setFormError("");
    setFormOpen(true);
  };

  const save = async () => {
    if (!form.name.trim()) return setFormError("Device name is required.");
    if (!form.ip.trim()) return setFormError("IP address is required.");
    // A blank community is a CHOICE, not an omission: it registers the device for
    // ICMP monitoring. Refusing it is what kept the one router this system most
    // needs to watch — the ISP-owned CPE, which will never hand out a community —
    // out of the dashboard entirely.
    setSaving(true);
    setFormError("");
    const res = await api.addNetworkDevice({
      name: form.name.trim(),
      ip: form.ip.trim(),
      community: form.community.trim(),
      snmpPort: form.snmpPort.trim() || undefined,
      location: form.location.trim() || undefined,
    });
    setSaving(false);
    if (res.success && res.data?.device) {
      const added = mapNet(res.data.device);
      setDevices((prev) => (prev.some((d) => d.id === added.id) ? prev : [...prev, added]));
      setFormOpen(false);
      showToast("Router added — polling starts within a minute.");
    } else {
      setFormError(res.error || "Could not add router.");
    }
  };

  const remove = async (id: string) => {
    setConfirmId(null);
    const res = await api.deleteNetworkDevice(Number(id));
    if (res.success) {
      setDevices((prev) => prev.filter((d) => d.id !== id));
      setDetailId((prev) => (prev === id ? null : prev));
      showToast("Router removed.");
    } else {
      showToast(res.error || "Could not remove router.");
    }
  };

  // Escape closes the add modal.
  useEffect(() => {
    if (!formOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFormOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [formOpen]);

  const load = () =>
    api.getNetworkDevices().then((r) => {
      if (r.success && r.data) setDevices((r.data.devices ?? []).map(mapNet));
    });

  useEffect(() => {
    load();
    const onMetrics = (data: { device: any }) => {
      if (!data?.device || data.device.type === "mikrotik") return; // MikroTik has its own page
      const id = String(data.device.id);
      setDevices((prev) => {
        const idx = prev.findIndex((d) => d.id === id);
        if (idx === -1) return [...prev, mergeNetLive(undefined, data.device)];
        const next = [...prev];
        next[idx] = mergeNetLive(next[idx], data.device);
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
    const onRemoved = (data: { id: number | string }) => {
      const id = String(data?.id);
      setDevices((prev) => prev.filter((d) => d.id !== id));
      setDetailId((prev) => (prev === id ? null : prev));
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
  const ifacesUp = allIfaces.filter((i) => i.linkUp).length;
  const upUtil = allIfaces.filter((i) => i.linkUp && i.utilizationPct != null).map((i) => i.utilizationPct as number);
  const peakUtil = upUtil.length ? Math.round(Math.max(...upUtil)) : 0;
  const onlineColor = total === 0 ? gf.textMuted : online === total ? GREEN : online === 0 ? RED : ORANGE;

  // Drill-down: render the per-router detail in place (Back returns to the list),
  // mirroring MikrotikMonitoring ↔ MikrotikDetail. Look the device up by id each
  // render so the open page keeps receiving the list's live socket updates.
  const detail = detailId ? devices.find((x) => x.id === detailId) ?? null : null;
  if (detail) {
    return <NetworkDetail device={detail} isAdmin={isAdmin} onBack={() => setDetailId(null)} />;
  }

  return (
    <div className="flex flex-col gap-2.5" style={{ background: gf.bg, minHeight: "100%", padding: 12 }}>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 px-0.5">
        <div className="flex items-baseline gap-2 min-w-0">
          <h1 className="text-[15px] font-semibold truncate" style={{ color: gf.textPrimary }}>Network Monitoring</h1>
          <span className="text-[13px] hidden sm:inline" style={{ color: gf.textDim }}>{total} devices · {online} online</span>
        </div>
        <div className="flex items-center gap-2.5 shrink-0">
          {isAdmin && (
            <button
              onClick={openAdd}
              className="gf-btn inline-flex items-center gap-1.5 text-[13px] font-medium"
              style={{ height: 28, padding: "0 10px", color: "var(--gf-text-primary)" }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              Add router
            </button>
          )}
          <span className="flex items-center gap-1.5 text-[12px] tracking-widest uppercase" style={{ color: gf.textMuted }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: GREEN, boxShadow: `0 0 6px ${GREEN}` }} /> Live
          </span>
        </div>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <StatPanel label="Routers" value={`${online}/${total}`} color={onlineColor} sub="online" />
        <StatPanel label="Ports Up" value={`${ifacesUp}/${allIfaces.length}`} color={allIfaces.length > 0 && ifacesUp === allIfaces.length ? GREEN : ifacesUp === 0 ? RED : ORANGE} sub="links up" />
        {/* Busiest link, not the mean: one saturated uplink IS the incident, and
            averaging it against idle ports hides exactly what needs attention. */}
        <StatPanel label="Peak Util" value={String(peakUtil)} unit="%" color={loadColor(peakUtil)} sub={upUtil.length > 1 ? `busiest of ${upUtil.length}` : "of link speed"} />
        <StatPanel label="Devices Down" value={String(total - online)} color={total - online === 0 ? GREEN : RED} sub="unreachable" />
      </div>

      {total === 0 ? (
        <Panel title="Devices">
          <div className="flex flex-col items-center justify-center text-center py-12 px-4">
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" style={{ color: gf.textDim }}>
              <rect x="2" y="3" width="20" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <rect x="2" y="15" width="20" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M12 9v6M7 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <p className="text-[15px] mt-3" style={{ color: gf.textMuted }}>No routers monitored yet</p>
            <p className="text-[13px] mt-1 max-w-md" style={{ color: gf.textDim }}>
              {isAdmin
                ? "Click “Add router” to register a managed router (with SNMP enabled) — it starts polling within a minute."
                : "A managed router (with SNMP enabled) must be registered by an admin to see live interface metrics here."}
            </p>
            {isAdmin && (
              <button onClick={openAdd} className="gf-btn mt-4 text-[13px] font-semibold px-3 py-1.5" style={{ color: "var(--gf-text-primary)" }}>
                + Add router
              </button>
            )}
          </div>
        </Panel>
      ) : (
        /* Wide list + expandable drawer, matching the Server Metrics front page: one
           full-width table you can scan down, with each row clicking open to reveal the
           ports. The old two-up card grid showed every port for every router at once,
           which meant scrolling past detail you hadn't asked for to find the one router
           you cared about. */
        <Panel
          title="Routers"
          noPad
          right={<span className="text-[12px]" style={{ color: gf.textDim }}>{online}/{total} online</span>}
        >
          {/* Mobile: one card per router (a table can't shrink to a phone) */}
          <div className="md:hidden flex flex-col gap-2 p-2.5">
            {devices.map((d) => (
              <div key={d.id} className="rounded-[2px] p-2.5" style={{ background: gf.bg, border: `1px solid ${gf.border}` }}>
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: statusColor(d.status), boxShadow: `0 0 5px ${statusColor(d.status)}` }} />
                  <span className="text-[14px] font-medium truncate flex-1" style={{ color: gf.textPrimary }}>{d.name}</span>
                  <PortsCell d={d} />
                </div>
                <div className="text-[12px] font-mono mt-0.5 truncate" style={{ color: gf.textDim }}>{d.ip} · ↑ {formatUptime(d.uptimeSeconds)}</div>
                <div className="flex gap-2 mt-2">
                  <GhostButton onClick={() => setDetailId(d.id)}>View</GhostButton>
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
                  {["Router", "IP Address", "Location", "Status", "Ports", "Uptime", ""].map((h) => (
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
                        {d.sysName && d.sysName !== d.name && (
                          <div className="text-[12px] font-mono font-normal" style={{ color: gf.textDim }}>{d.sysName}</div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-[13px] font-mono whitespace-nowrap" style={{ color: gf.textMuted }}>{d.ip}</td>
                      <td className="px-3 py-2.5 text-[13px] whitespace-nowrap" style={{ color: gf.textMuted }}>{d.location}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor(d.status), boxShadow: `0 0 5px ${statusColor(d.status)}` }} />
                          <span className="text-[13px]" style={{ color: gf.textMuted }}>{d.status}</span>
                        </span>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap"><PortsCell d={d} /></td>
                      <td className="px-3 py-2.5 text-[13px] whitespace-nowrap" style={{ color: gf.textMuted }}>{formatUptime(d.uptimeSeconds)}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        <div className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                          {confirmId === d.id ? (
                            <>
                              <span className="text-[12px]" style={{ color: RED }}>Remove?</span>
                              <button onClick={() => remove(d.id)} className="gf-btn px-2 py-1 text-[12px] font-medium" style={{ color: RED }}>Yes</button>
                              <button onClick={() => setConfirmId(null)} className="gf-btn px-2 py-1 text-[12px]" style={{ color: gf.textMuted }}>No</button>
                            </>
                          ) : (
                            <>
                              <GhostButton onClick={() => setDetailId(d.id)}>View</GhostButton>
                              {isAdmin && <GhostButton danger onClick={() => setConfirmId(d.id)}>Remove</GhostButton>}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                    <NetDrawerRow d={d} isOpen={openId === d.id} colSpan={7} />
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* Add-router modal (admin) */}
      {formOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }} onClick={() => setFormOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-[2px] overflow-hidden" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
            <div className="flex items-center justify-between px-4" style={{ height: 44, borderBottom: `1px solid ${gf.divider}`, background: gf.panel }}>
              <span className="text-[14px] font-semibold tracking-wide" style={{ color: gf.textPrimary }}>Add router</span>
              <button onClick={() => setFormOpen(false)} className="grid place-items-center w-7 h-7 rounded-md" style={{ color: gf.textMuted }} title="Close (Esc)">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-4 flex flex-col gap-3">
              <Field label="Name">
                <input name="name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} autoFocus placeholder="PLDT DMZ router" className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="IP address">
                  <input name="ip" value={form.ip} onChange={(e) => setForm((f) => ({ ...f, ip: e.target.value }))} placeholder="192.168.1.1" className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                </Field>
                <Field label="SNMP port">
                  <input name="snmpPort" value={form.snmpPort} onChange={(e) => setForm((f) => ({ ...f, snmpPort: e.target.value }))} placeholder="161" className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                </Field>
              </div>
              <Field label="SNMP community (read-only, v2c) — leave blank for ping-only">
                <input name="community" value={form.community} onChange={(e) => setForm((f) => ({ ...f, community: e.target.value }))} placeholder="blank = monitor by ping only" className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
              </Field>
              <Field label="Location">
                <input name="location" value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
              </Field>
              {/* The note changes with the mode, because the two register very
                  different devices and the difference is invisible once saved. */}
              <p className="text-[12px] leading-relaxed" style={{ color: gf.textDim }}>
                {form.community.trim() ? (
                  <>
                    <span style={{ color: gf.textMuted }}>SNMP mode.</span> Reads per-port
                    traffic, link status and uptime over v2c with a read-only community.
                    Confirm UDP {form.snmpPort || "161"} is reachable from the backend host.
                  </>
                ) : (
                  <>
                    <span style={{ color: ORANGE }}>Ping-only mode.</span> With no community
                    this device is monitored by ICMP: up/down, latency and packet loss, and
                    nothing else — no per-port traffic or link status. Use this for gear you
                    cannot enable SNMP on, such as an ISP-owned router.
                  </>
                )}{" "}
                Polling begins on the next cycle (≤60s) — no restart needed.
              </p>
              {formError && <div className="text-[12px]" style={{ color: RED }}>{formError}</div>}
              <div className="flex gap-2 mt-1">
                <button onClick={save} disabled={saving} className="gf-raise text-[13px] font-semibold px-4 py-2 rounded-md transition-colors active:scale-95 disabled:opacity-50" style={{ color: "#fff", background: BLUE }}>
                  {saving ? "Adding…" : "Add router"}
                </button>
                <button onClick={() => setFormOpen(false)} className="text-[13px] font-medium px-4 py-2 rounded-md transition-colors active:scale-95" style={{ color: gf.textMuted, border: `1px solid ${gf.border}`, background: "transparent" }}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed top-5 right-5 z-[100] flex items-center gap-2 px-4 py-3 rounded-[2px] border text-xs shadow-xl" style={{ color: GREEN, background: `${GREEN}14`, borderColor: `${GREEN}40`, fontFamily: "'JetBrains Mono', monospace" }}>
          <span>✓</span> {toast}
        </div>
      )}
    </div>
  );
}
