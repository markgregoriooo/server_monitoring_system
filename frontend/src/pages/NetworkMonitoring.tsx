import { Fragment, useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import { useAuth } from "../context/AuthContext";
import NetworkDetail from "./NetworkDetail";
import type { NetDevice } from "./NetworkDetail";
import MikrotikDetail from "./MikrotikDetail";
import type { MkDevice } from "./MikrotikDetail";
import { GF as gf, STATUS } from "../theme/gf";
import { formatUptime } from "../utils/format";
import { GhostButton, StatPanel, Field, Meta } from "../components/ui/primitives";
import { useProbe, ProbeResultPanel, probePassed } from "../components/devices/DeviceProbe";
import {
  mapMk, mergeMkLive, MkStatus, MkDrawerRow, MkPortsCell, AddMikrotikModal, ConnectionModal,
} from "../components/network/MikrotikParts";
import type { DeviceFirstPoll } from "../api/api";
const { green: GREEN, orange: ORANGE, red: RED, blue: BLUE } = STATUS;

// ─── Network page ─────────────────────────────────────────────────────────────
// Every network device in one list, however it is monitored: SNMP routers/switches,
// ping-only devices, and MikroTiks over the RouterOS API. MikroTiks had their own page
// and sidebar entry until ICTU's network admin asked for one Network page. Monitoring is
// unchanged — only the listing is shared; the MikroTik row pieces are in
// components/network/MikrotikParts.tsx. "View" opens NetworkDetail or MikrotikDetail in
// place. Types are in those two files.

// ─── Grafana tokens (match ServerMetrics.tsx) ─────────────────────────────────



const inputStyle: React.CSSProperties = {
  background: gf.bg,
  border: `1px solid ${gf.border}`,
  color: gf.textPrimary,
  fontFamily: "'JetBrains Mono', monospace",
};

// Blank "Add router" form. The community starts empty: blank means ICMP-only
// monitoring, so pre-filling "public" would opt every router into SNMP. (The UPS form
// starts at "public", since a UPS has no ping-only mode.)
interface NetForm {
  name: string;
  ip: string;
  community: string;
  snmpPort: string;
  location: string;
}

// Empty field with a placeholder rather than a value to delete. parseCommon uses
// "CSPC-ICTU Server Room" when it is left empty.
const EMPTY_NET_FORM: NetForm = {
  name: "",
  ip: "",
  community: "", // blank = ICMP-only monitoring (see the note in save())
  snmpPort: "161",
  location: "",
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
      rxBps: i.rxBps ?? null,
      txBps: i.txBps ?? null,
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

// ─── Port chip (per-port state in the list) ─────────────────────
// The list only shows which ports are up; the full table (speed / Tx / Rx / errors /
// util) is in the detail view. Same as the MikroTik list.

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

// One labelled value in a drawer's summary strip, so each value says what it is.
// ─── Drawer row (expands under a table row) ───────────────────────────────────
// Like ServerMetrics' ServerDrawerRow: the table has the summary, the drawer the rest.
// Animated with max-height so it slides open.
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
              /* A ping device reports three things and never has ports, so show its mode and what it
                 has instead of an empty list. */
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
  // A ping device has no ports; say what it is and show the number it does have, rather
  // than a dash that looks like a failure.
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

// ─── Merged list ──────────────────────────────────────────────────────────────
// One row per device, whichever way it is monitored. The two kinds keep their own state
// (different shapes, different endpoints) and are only merged for display. Device ids
// come from the one `devices` table, so an id never names two rows.

type Row = { kind: "router"; d: NetDevice } | { kind: "mikrotik"; d: MkDevice };

// How a row is monitored — the one thing the separate pages used to say by being separate.
function TypeBadge({ row }: { row: Row }) {
  const label = row.kind === "mikrotik" ? "MikroTik API" : row.d.mode === "ping" ? "Ping" : "SNMP";
  return (
    <span
      className="inline-block px-1 py-px rounded-[2px] text-[10px] tracking-wide uppercase whitespace-nowrap"
      style={{ background: gf.hover, border: `1px solid ${gf.divider}`, color: gf.textMuted }}
    >
      {label}
    </span>
  );
}

function RouterStatus({ d }: { d: NetDevice }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor(d.status), boxShadow: `0 0 5px ${statusColor(d.status)}` }} />
      <span className="text-[13px]" style={{ color: gf.textMuted }}>{d.status}</span>
    </span>
  );
}

// CPU / memory only exist for a MikroTik (the RouterOS API reports them; IF-MIB does not).
function LoadCell({ v }: { v: number | null | undefined }) {
  return (
    <span className="text-[13px] tabular-nums" style={{ color: v != null ? loadColor(Math.round(v)) : gf.textDim }}>
      {v != null ? `${Math.round(v)}%` : "—"}
    </span>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function NetworkMonitoring() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [devices, setDevices] = useState<NetDevice[]>([]);
  const [mkDevices, setMkDevices] = useState<MkDevice[]>([]);
  // Drill-down target held by ID (not a snapshot) so the open detail page keeps getting
  // the list-level live updates.
  const [detailId, setDetailId] = useState<string | null>(null);

  // "Add device" asks what kind first, then opens that kind's own form.
  const [chooserOpen, setChooserOpen] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [mkAdding, setMkAdding] = useState(false);
  const [configFor, setConfigFor] = useState<MkDevice | null>(null);
  const [form, setForm] = useState<NetForm>(EMPTY_NET_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  // Which row's drawer is open (one at a time), same as ServerMetrics.
  const [openId, setOpenId] = useState<string | null>(null);
  const toggleDrawer = (id: string) => setOpenId((prev) => (prev === id ? null : id));
  // Toasts have a tone, so a registration whose first poll failed is not shown as success.
  const [toast, setToast] = useState<{ msg: string; tone: "ok" | "warn" } | null>(null);
  const probe = useProbe();
  const [searchParams, setSearchParams] = useSearchParams();

  // Deep link from a notification: /network?device=<id> opens that device once the lists
  // load, then removes the parameter (so Back returns to the list). Old /mikrotik?device=
  // links are redirected here with the parameter kept (App.tsx).
  useEffect(() => {
    const deviceParam = searchParams.get("device");
    if (!deviceParam) return;
    const id = String(deviceParam);
    if (!devices.some((d) => d.id === id) && !mkDevices.some((d) => d.id === id)) return;
    setDetailId(id);
    searchParams.delete("device");
    setSearchParams(searchParams, { replace: true });
  }, [devices, mkDevices, searchParams, setSearchParams]);
  // A warning stays up longer than a confirmation: it asks the reader to go and do
  // something, and 3 seconds is not enough to read a reason and an address.
  const showToast = (msg: string, tone: "ok" | "warn" = "ok") => {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), tone === "warn" ? 9000 : 3000);
  };

  const openRouterForm = () => {
    setChooserOpen(false);
    setForm(EMPTY_NET_FORM);
    setFormError("");
    probe.reset();
    setFormOpen(true);
  };
  const openMikrotikForm = () => {
    setChooserOpen(false);
    setMkAdding(true);
  };

  // Any edit to a field the probe depends on invalidates the probe. A green tick
  // vouching for an address that has since been retyped is worse than no tick.
  const editConn = (patch: Partial<NetForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    probe.reset();
  };

  const test = async () => {
    if (!form.ip.trim()) return setFormError("Enter an IP address to test.");
    setFormError("");
    await probe.run(() =>
      api.testNetworkDevice({
        ip: form.ip.trim(),
        community: form.community.trim(),
        snmpPort: form.snmpPort.trim() || undefined,
      }),
    );
  };

  const save = async () => {
    if (!form.name.trim()) return setFormError("Device name is required.");
    if (!form.ip.trim()) return setFormError("IP address is required.");
    // A blank community is allowed: it registers the device for ICMP monitoring (e.g. ISP
    // equipment with no community).
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
      probe.reset();
      // Does not say the device works yet: the backend polls it once and the result arrives on
      // `deviceFirstPoll` a moment later and replaces this line.
      showToast("Router registered — testing it now…");
    } else {
      setFormError(res.error || "Could not add router.");
    }
  };

  // Decommission. Each kind has its own endpoint; both cascade server-side.
  const remove = async (row: Row) => {
    const id = row.d.id;
    setRemoving(id);
    const res = row.kind === "mikrotik"
      ? await api.deleteMikrotik(Number(id))
      : await api.deleteNetworkDevice(Number(id));
    setRemoving(null);
    setConfirmId(null);
    if (res.success) {
      setDevices((prev) => prev.filter((d) => d.id !== id));
      setMkDevices((prev) => prev.filter((d) => d.id !== id));
      setDetailId((prev) => (prev === id ? null : prev));
      showToast(`${row.d.name} removed.`);
    } else {
      showToast(res.error || `Could not remove ${row.d.name}.`, "warn");
    }
  };

  // Escape closes whichever add dialog is open.
  useEffect(() => {
    if (!formOpen && !chooserOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setFormOpen(false);
      setChooserOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [formOpen, chooserOpen]);

  const loadRouters = () =>
    api.getNetworkDevices().then((r) => {
      if (r.success && r.data) setDevices((r.data.devices ?? []).map(mapNet));
    });
  const loadMikrotiks = () =>
    api.getMikrotikDevices().then((r) => {
      if (r.success && r.data) setMkDevices((r.data.devices ?? []).map(mapMk));
    });

  useEffect(() => {
    loadRouters();
    loadMikrotiks();
    // One event for both kinds; `type` says which list it belongs to.
    const onMetrics = (data: { device: any }) => {
      if (!data?.device) return;
      const id = String(data.device.id);
      if (data.device.type === "mikrotik") {
        setMkDevices((prev) => {
          const idx = prev.findIndex((d) => d.id === id);
          if (idx === -1) return [...prev, mergeMkLive(undefined, data.device)];
          const next = [...prev];
          next[idx] = mergeMkLive(next[idx], data.device);
          return next;
        });
        return;
      }
      setDevices((prev) => {
        const idx = prev.findIndex((d) => d.id === id);
        if (idx === -1) return [...prev, mergeNetLive(undefined, data.device)];
        const next = [...prev];
        next[idx] = mergeNetLive(next[idx], data.device);
        return next;
      });
    };
    // Status and removal carry only an id; it matches at most one row across both lists.
    const onStatus = (data: { id: number | string; status: string }) => {
      const id = String(data?.id);
      const apply = <T extends { id: string; status: string }>(d: T): T =>
        d.id !== id
          ? d
          : data.status === "Offline"
            ? { ...d, status: "Offline", reachable: false, interfaces: [] }
            : { ...d, status: data.status };
      setDevices((prev) => prev.map(apply));
      setMkDevices((prev) => prev.map(apply));
    };
    const onRemoved = (data: { id: number | string }) => {
      const id = String(data?.id);
      setDevices((prev) => prev.filter((d) => d.id !== id));
      setMkDevices((prev) => prev.filter((d) => d.id !== id));
      setDetailId((prev) => (prev === id ? null : prev));
    };
    // How the new device's first poll went, sent only to the admin who added it, so a wrong
    // community or RouterOS login shows up on screen instead of only in the server log.
    const onFirstPoll = (d: DeviceFirstPoll) => {
      if (d?.kind === "router") {
        if (d.ok) {
          showToast(
            d.mode === "ping"
              ? `${d.name} is answering ping — monitored for up/down, latency and loss.`
              : `${d.name} answered SNMP — now polling.`,
          );
        } else {
          showToast(
            `${d.name} did not answer its first poll${d.reason ? ` — ${d.reason}` : ""}. ` +
              `Check the IP, the community and that UDP 161 is open to the backend. ` +
              `It stays registered and keeps retrying.`,
            "warn",
          );
        }
      } else if (d?.kind === "mikrotik") {
        if (d.ok) {
          showToast(`${d.name} logged in over the RouterOS API — now polling.`);
        } else {
          showToast(
            `${d.name} could not be polled${d.reason ? ` — ${d.reason}` : ""}. ` +
              `Check the username, the password, the API port and that the api service is ` +
              `enabled on the router. It stays registered and keeps retrying.`,
            "warn",
          );
        }
      }
      // UPS has its own page.
    };

    socket.on("networkMetrics", onMetrics);
    socket.on("networkStatus", onStatus);
    socket.on("networkRemoved", onRemoved);
    socket.on("deviceFirstPoll", onFirstPoll);
    return () => {
      socket.off("networkMetrics", onMetrics);
      socket.off("networkStatus", onStatus);
      socket.off("networkRemoved", onRemoved);
      socket.off("deviceFirstPoll", onFirstPoll);
    };
  }, []);

  const rows: Row[] = [
    ...devices.map((d): Row => ({ kind: "router", d })),
    ...mkDevices.map((d): Row => ({ kind: "mikrotik", d })),
  ].sort((a, b) => a.d.name.localeCompare(b.d.name));

  const total = rows.length;
  const online = rows.filter((r) => r.d.status === "Online").length;
  // A MikroTik with no RouterOS login has never been polled: it is waiting on an admin,
  // not down, so it is not counted as a device down (its row says so instead).
  const down = rows.filter((r) => r.d.status !== "Online" && !(r.kind === "mikrotik" && !r.d.monitored)).length;
  const allIfaces: { linkUp: boolean; utilizationPct: number | null }[] = rows.flatMap((r) => r.d.interfaces);
  const ifacesUp = allIfaces.filter((i) => i.linkUp).length;
  const upUtil = allIfaces.filter((i) => i.linkUp && i.utilizationPct != null).map((i) => i.utilizationPct as number);
  const peakUtil = upUtil.length ? Math.round(Math.max(...upUtil)) : 0;
  const onlineColor = total === 0 ? gf.textMuted : online === total ? GREEN : online === 0 ? RED : ORANGE;

  const toastEl = toast && (
    /* Two tones — see showToast. The warning one wraps, because it carries a reason and a
       next step, not just a confirmation. */
    <div
      className="fixed top-5 right-5 z-[100] flex items-start gap-2 px-4 py-3 rounded-[2px] border text-xs shadow-xl max-w-sm"
      style={{
        color: toast.tone === "warn" ? ORANGE : GREEN,
        background: toast.tone === "warn" ? `${ORANGE}14` : `${GREEN}14`,
        borderColor: toast.tone === "warn" ? `${ORANGE}40` : `${GREEN}40`,
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      <span className="shrink-0">{toast.tone === "warn" ? "!" : "✓"}</span>
      <span className="leading-relaxed">{toast.msg}</span>
    </div>
  );

  const connectionModal = configFor && (
    <ConnectionModal
      device={configFor}
      onClose={() => setConfigFor(null)}
      onSaved={(msg) => {
        setConfigFor(null);
        showToast(msg);
        loadMikrotiks();
      }}
    />
  );

  // Detail view in place (Back returns to the list). Looked up by id each render so it
  // keeps getting live updates from the list's state.
  if (detailId) {
    const mk = mkDevices.find((x) => x.id === detailId);
    if (mk) {
      return (
        <>
          <MikrotikDetail
            device={mk}
            isAdmin={isAdmin}
            onBack={() => setDetailId(null)}
            onConfigure={isAdmin ? () => setConfigFor(mk) : undefined}
          />
          {connectionModal}
          {toastEl}
        </>
      );
    }
    const net = devices.find((x) => x.id === detailId);
    if (net) return <NetworkDetail device={net} isAdmin={isAdmin} onBack={() => setDetailId(null)} />;
  }

  // Row actions, shared by the mobile cards and the table.
  const actions = (row: Row) =>
    confirmId === row.d.id ? (
      <>
        <span className="text-[12px]" style={{ color: RED }}>Remove?</span>
        <button onClick={() => void remove(row)} disabled={removing === row.d.id} className="gf-btn px-2 py-1 text-[12px] font-medium" style={{ color: RED }}>
          {removing === row.d.id ? "Removing…" : "Yes"}
        </button>
        <button onClick={() => setConfirmId(null)} className="gf-btn px-2 py-1 text-[12px]" style={{ color: gf.textMuted }}>No</button>
      </>
    ) : (
      <>
        <GhostButton onClick={() => setDetailId(row.d.id)}>View</GhostButton>
        {isAdmin && row.kind === "mikrotik" && <GhostButton onClick={() => setConfigFor(row.d)}>Configure</GhostButton>}
        {isAdmin && <GhostButton danger onClick={() => setConfirmId(row.d.id)}>Remove</GhostButton>}
      </>
    );

  const COLUMNS = ["Device", "Type", "IP Address", "Location", "Status", "CPU", "Memory", "Ports", "Uptime", ""];

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
              onClick={() => setChooserOpen(true)}
              className="gf-btn inline-flex items-center gap-1.5 text-[13px] font-medium"
              style={{ height: 28, padding: "0 10px", color: "var(--gf-text-primary)" }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              Add device
            </button>
          )}
          <span className="flex items-center gap-1.5 text-[12px] tracking-widest uppercase" style={{ color: gf.textMuted }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: GREEN, boxShadow: `0 0 6px ${GREEN}` }} /> Live
          </span>
        </div>
      </div>

      {/* Stat row — across every device, however it is monitored */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <StatPanel label="Devices" value={`${online}/${total}`} color={onlineColor} sub="online" />
        <StatPanel label="Ports Up" value={`${ifacesUp}/${allIfaces.length}`} color={allIfaces.length > 0 && ifacesUp === allIfaces.length ? GREEN : ifacesUp === 0 ? RED : ORANGE} sub="links up" />
        {/* Busiest link, not the mean: one saturated uplink IS the incident, and
            averaging it against idle ports hides exactly what needs attention. */}
        <StatPanel label="Peak Util" value={String(peakUtil)} unit="%" color={loadColor(peakUtil)} sub={upUtil.length > 1 ? `busiest of ${upUtil.length}` : "of link speed"} />
        <StatPanel label="Devices Down" value={String(down)} color={down === 0 ? GREEN : RED} sub="unreachable" />
      </div>

      {total === 0 ? (
        <Panel title="Devices">
          <div className="flex flex-col items-center justify-center text-center py-12 px-4">
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" style={{ color: gf.textDim }}>
              <rect x="2" y="3" width="20" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <rect x="2" y="15" width="20" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M12 9v6M7 12h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <p className="text-[15px] mt-3" style={{ color: gf.textMuted }}>No network devices monitored yet</p>
            <p className="text-[13px] mt-1 max-w-md" style={{ color: gf.textDim }}>
              {isAdmin
                ? "Click “Add device” to register a router or switch (SNMP, or ping only) or a MikroTik (RouterOS API)."
                : "A router, switch or MikroTik must be registered by an admin to see live metrics here."}
            </p>
            {isAdmin && (
              <button onClick={() => setChooserOpen(true)} className="gf-btn mt-4 text-[13px] font-semibold px-3 py-1.5" style={{ color: "var(--gf-text-primary)" }}>
                + Add device
              </button>
            )}
          </div>
        </Panel>
      ) : (
        /* A full-width list with expandable rows, like the Server Metrics page. */
        <Panel
          title="Devices"
          noPad
          right={<span className="text-[12px]" style={{ color: gf.textDim }}>{online}/{total} online</span>}
        >
          {/* Mobile: one card per device (a table can't shrink to a phone) */}
          <div className="md:hidden flex flex-col gap-2 p-2.5">
            {rows.map((row) => {
              const d = row.d;
              const pending = row.kind === "mikrotik" && !row.d.monitored;
              const dot = pending ? ORANGE : statusColor(d.status);
              return (
                <div key={d.id} className="rounded-[2px] p-2.5" style={{ background: gf.bg, border: `1px solid ${gf.border}` }}>
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot, boxShadow: `0 0 5px ${dot}` }} />
                    <span className="text-[14px] font-medium truncate flex-1" style={{ color: gf.textPrimary }}>{d.name}</span>
                    {row.kind === "mikrotik" ? <MkPortsCell d={row.d} /> : <PortsCell d={row.d} />}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <TypeBadge row={row} />
                    <span className="text-[12px] font-mono truncate" style={{ color: gf.textDim }}>{d.ip} · ↑ {formatUptime(d.uptimeSeconds)}</span>
                  </div>
                  {pending && (
                    <div className="text-[12px] mt-1" style={{ color: ORANGE }}>
                      API not configured — set the read-only RouterOS login.
                    </div>
                  )}
                  <div className="flex gap-2 mt-2 flex-wrap items-center">{actions(row)}</div>
                </div>
              );
            })}
          </div>

          {/* Desktop: table + drawer */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr style={{ borderBottom: `1px solid ${gf.divider}` }}>
                  {COLUMNS.map((h) => (
                    <th key={h} className="text-left px-3 py-2 text-[11px] tracking-widest uppercase font-medium whitespace-nowrap" style={{ color: gf.textDim }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const d = row.d;
                  const sub = row.kind === "mikrotik" ? row.d.boardModel : row.d.sysName !== d.name ? row.d.sysName : null;
                  return (
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
                          {sub && <div className="text-[12px] font-normal" style={{ color: gf.textDim }}>{sub}</div>}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap"><TypeBadge row={row} /></td>
                        <td className="px-3 py-2.5 text-[13px] font-mono whitespace-nowrap" style={{ color: gf.textMuted }}>{d.ip}</td>
                        <td className="px-3 py-2.5 text-[13px] whitespace-nowrap" style={{ color: gf.textMuted }}>{d.location}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          {row.kind === "mikrotik" ? <MkStatus d={row.d} /> : <RouterStatus d={row.d} />}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap"><LoadCell v={row.kind === "mikrotik" ? row.d.cpuPercent : null} /></td>
                        <td className="px-3 py-2.5 whitespace-nowrap"><LoadCell v={row.kind === "mikrotik" ? row.d.memPercent : null} /></td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          {row.kind === "mikrotik" ? <MkPortsCell d={row.d} /> : <PortsCell d={row.d} />}
                        </td>
                        <td className="px-3 py-2.5 text-[13px] whitespace-nowrap" style={{ color: gf.textMuted }}>{formatUptime(d.uptimeSeconds)}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <div className="flex items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                            {actions(row)}
                          </div>
                        </td>
                      </tr>
                      {row.kind === "mikrotik"
                        ? <MkDrawerRow d={row.d} isOpen={openId === d.id} colSpan={COLUMNS.length} />
                        : <NetDrawerRow d={row.d} isOpen={openId === d.id} colSpan={COLUMNS.length} />}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* Add device: pick the kind, then that kind's own form (admin) */}
      {chooserOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }} onClick={() => setChooserOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-[2px] overflow-hidden" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
            <div className="flex items-center justify-between px-4" style={{ height: 44, borderBottom: `1px solid ${gf.divider}` }}>
              <span className="text-[14px] font-semibold tracking-wide" style={{ color: gf.textPrimary }}>Add device</span>
              <button onClick={() => setChooserOpen(false)} className="grid place-items-center w-7 h-7 rounded-md" style={{ color: gf.textMuted }} title="Close (Esc)">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-4 flex flex-col gap-2.5">
              {[
                { title: "Router or switch", sub: "SNMP v2c (ports and traffic), or ping only — any brand.", onClick: openRouterForm },
                { title: "MikroTik", sub: "RouterOS API — ports, traffic, CPU, memory and DHCP leases.", onClick: openMikrotikForm },
              ].map((o) => (
                <button
                  key={o.title}
                  onClick={o.onClick}
                  className="text-left px-3 py-2.5 rounded-[2px] transition-colors"
                  style={{ background: gf.bg, border: `1px solid ${gf.border}` }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = BLUE)}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = gf.border)}
                >
                  <div className="text-[14px] font-medium" style={{ color: gf.textPrimary }}>{o.title}</div>
                  <div className="text-[12px] mt-0.5" style={{ color: gf.textDim }}>{o.sub}</div>
                </button>
              ))}
              <p className="text-[11px] mt-1" style={{ color: gf.textDim }}>
                A MikroTik with SNMP enabled can also be added as a router or switch — pick one, not both, or it is polled twice.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Add-router modal (admin) */}
      {formOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }} onClick={() => setFormOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-md rounded-[2px] overflow-hidden" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
            <div className="flex items-center justify-between px-4" style={{ height: 44, borderBottom: `1px solid ${gf.divider}`, background: gf.panel }}>
              <span className="text-[14px] font-semibold tracking-wide" style={{ color: gf.textPrimary }}>Add router or switch</span>
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
                  <input name="ip" value={form.ip} onChange={(e) => editConn({ ip: e.target.value })} placeholder="192.168.1.1" className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                </Field>
                <Field label="SNMP port">
                  <input name="snmpPort" value={form.snmpPort} onChange={(e) => editConn({ snmpPort: e.target.value })} placeholder="161" className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                </Field>
              </div>
              <Field label="SNMP community (read-only, v2c) — leave blank for ping-only">
                <input name="community" value={form.community} onChange={(e) => editConn({ community: e.target.value })} placeholder="blank = monitor by ping only" className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
              </Field>
              <Field label="Location">
                <input name="location" value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} placeholder="CSPC-ICTU Server Room" className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
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
                Polled once the moment you add it, then every cycle (≤60s) — no restart needed.
              </p>

              {/* Test before saving, so a wrong address or community is caught next to the field. */}
              <ProbeResultPanel state={probe.state} />

              {formError && <div className="text-[12px]" style={{ color: RED }}>{formError}</div>}
              <div className="flex flex-wrap gap-2 mt-1">
                <button onClick={save} disabled={saving || probe.state.phase === "testing"} className="gf-raise text-[13px] font-semibold px-4 py-2 rounded-md transition-colors active:scale-95 disabled:opacity-50" style={{ color: "#fff", background: BLUE }}>
                  {saving ? "Adding…" : "Add router"}
                </button>
                <button onClick={test} disabled={probe.state.phase === "testing" || saving} className="text-[13px] font-medium px-4 py-2 rounded-md transition-colors active:scale-95 disabled:opacity-50" style={{ color: gf.textMuted, border: `1px solid ${gf.border}`, background: "transparent" }}>
                  {probe.state.phase === "testing" ? "Testing…" : "Test connection"}
                </button>
                <button onClick={() => setFormOpen(false)} className="text-[13px] font-medium px-4 py-2 rounded-md transition-colors active:scale-95" style={{ color: gf.textMuted, border: `1px solid ${gf.border}`, background: "transparent" }}>
                  Cancel
                </button>
              </div>
              {/* A failed test never blocks saving (the device may not be reachable yet); it states
                 the consequence instead. */}
              {probe.state.phase === "done" && !probePassed(probe.state) && (
                <p className="text-[11px]" style={{ color: ORANGE }}>
                  You can still add it — it will show as Offline until whatever is named above is fixed.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {mkAdding && (
        <AddMikrotikModal
          usedNames={mkDevices.map((d) => d.name)}
          onClose={() => setMkAdding(false)}
          onAdded={(msg) => {
            setMkAdding(false);
            showToast(msg);
            loadMikrotiks();
          }}
        />
      )}

      {connectionModal}
      {toastEl}
    </div>
  );
}
