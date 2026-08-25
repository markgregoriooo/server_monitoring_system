import { useEffect, useMemo, useState } from "react";
import { api } from "../api/api";
import { GF as gf, STATUS } from "../theme/gf";
const { green: GREEN, orange: ORANGE, red: RED } = STATUS;

// Admin-only page for the configurable alert thresholds (alert_rules). A rule with
// deviceId = null is a GLOBAL default (every server / the room); a deviceId is a
// per-server override. Resolver + evaluation live in backend/services/alertRulesService.js.

interface Rule {
  id: number;
  deviceId: number | null;
  deviceName: string | null;
  interfaceName: string | null; // null = every port on the device
  metricName: string;
  thresholdValue: number;
  comparison: string;
  severity: string;
  isActive: boolean;
  updatedByName?: string | null; // who last created/edited (accountability)
  updatedAt?: string | null;
}

// Every device class that can carry a per-device threshold override. The room-level
// environment metrics have no device at all, so they aren't a kind.
type DeviceKind = "server" | "network" | "ups";

interface ServerOpt {
  id: number;
  name: string;
  kind: DeviceKind;
  // Physical ports, for network devices only — populates the per-port scope dropdown.
  interfaces?: string[];
}

// Metrics measured per PORT rather than per device. Only these offer an interface scope.
const PER_PORT_METRICS = new Set(["link_util", "link_errors"]);

interface FormState {
  deviceId: string; // "" = global default, else the device id
  interfaceName: string; // "" = whole device; else one port on that device
  metricName: string;
  thresholdValue: string;
  comparison: string;
  severity: string;
  isActive: boolean;
}

interface MetricMeta {
  value: string;
  label: string;
  unit: string;
  color: string;
  env?: boolean; // room-level (ESP32) metric — global only, never per-device
  // Which class of device this metric applies to. Drives the scope dropdown: picking a
  // router only offers router metrics, picking a UPS only offers UPS metrics. Metrics
  // used to be server-only here, which forced every router/UPS threshold to be global.
  scope?: DeviceKind;
  lowerIsWorse?: boolean; // smaller value = worse (battery charge / runtime) → default the condition to '<='
}

const METRICS: MetricMeta[] = [
  { value: "cpu", label: "CPU usage", unit: "%", color: "#5794F2", scope: "server" },
  { value: "mem", label: "Memory usage", unit: "%", color: "#B877D9", scope: "server" },
  { value: "disk", label: "Disk usage", unit: "%", color: "#FFA94D", scope: "server" },
  { value: "temperature", label: "Temperature", unit: "°C", color: "#FF6B6B", env: true },
  { value: "gas", label: "Gas / smoke", unit: "ppm", color: "#9AA0A6", env: true },
  { value: "humidity", label: "Humidity", unit: "%", color: "#3CC8E8", env: true },
  // Router / UPS metrics (SNMP + MikroTik pollers → services/deviceAlerts.js). Global
  // defaults ship seeded in the base schema (v13_cspc-ictu-monitoring-system.sql); per-device
  // overrides are now selectable here too.
  { value: "router_cpu", label: "Router CPU", unit: "%", color: "#5794F2", scope: "network" },
  { value: "router_mem", label: "Router memory", unit: "%", color: "#B877D9", scope: "network" },
  { value: "router_clients", label: "Connected clients", unit: "", color: "#73BF69", scope: "network" },
  { value: "link_util", label: "Link utilization", unit: "%", color: "#FF9830", scope: "network" },
  // Errors ADDED since the previous poll (rx+tx), not the lifetime counter — so the
  // sensible threshold depends on the poll cadence. See
  // the seeded `link_errors` rule in the base schema.
  { value: "link_errors", label: "Link errors", unit: "/poll", color: "#F2495C", scope: "network" },
  // ICMP link quality — the two things SNMP cannot report (a walk either answers or
  // times out, so a link dropping a third of its packets reads as healthy). Also the
  // only numeric metrics a PING-ONLY router has. Seeded in the base schema:
  // router_loss ACTIVE, router_latency INACTIVE — latency's right value is a property
  // of the link (a rack switch answers in <1 ms, an ISP CPE in 20-40 ms, both healthy),
  // so it is put in front of an admin to set per device rather than guessed globally.
  { value: "router_latency", label: "Latency", unit: "ms", color: "#3CC8E8", scope: "network" },
  { value: "router_loss", label: "Packet loss", unit: "%", color: "#F2495C", scope: "network" },
  { value: "ups_charge", label: "UPS battery", unit: "%", color: "#73BF69", scope: "ups", lowerIsWorse: true },
  { value: "ups_runtime", label: "UPS runtime", unit: "min", color: "#5794F2", scope: "ups", lowerIsWorse: true },
  { value: "ups_load", label: "UPS load", unit: "%", color: "#FF780A", scope: "ups" },
];

const KIND_LABEL: Record<DeviceKind, string> = {
  server: "Servers",
  network: "Routers / MikroTik",
  ups: "UPS",
};
// First metric offered when the scope switches to a device of this kind.
const KIND_DEFAULT_METRIC: Record<DeviceKind, string> = {
  server: "cpu",
  network: "router_cpu",
  ups: "ups_charge",
};
const COMPARISONS = [">=", ">", "<=", "<"];
const SEVERITIES = ["info", "warning", "critical"];
const SEV_COLOR: Record<string, string> = { critical: "#E02F44", warning: "#FF780A", info: "#5794F2" };
const SEV_RANK: Record<string, number> = { critical: 3, warning: 2, info: 1 };
const PURPLE = "#B877D9";


const EMPTY_FORM: FormState = {
  deviceId: "",
  interfaceName: "",
  metricName: "cpu",
  thresholdValue: "",
  comparison: ">=",
  severity: "warning",
  isActive: true,
};

const metricMeta = (name: string): MetricMeta =>
  METRICS.find((m) => m.value === name) ?? { value: name, label: name, unit: "", color: gf.textMuted };

// Compact "Jun 14, 2:30 PM" (Manila) for the last-edited stamp.
const fmtWhen = (iso?: string | null): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-PH", {
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Manila",
  });
};

const inputStyle: React.CSSProperties = {
  background: gf.bg,
  border: `1px solid ${gf.border}`,
  color: gf.textPrimary,
  fontFamily: "'JetBrains Mono', monospace",
};

// ─── Metric icons (tinted by metric color via currentColor) ───────────────────
function MetricIcon({ name, size = 15 }: { name: string; size?: number }) {
  const p = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "cpu":
      return (
        <svg {...p}>
          <rect x="6" y="6" width="12" height="12" rx="1.5" />
          <rect x="9.5" y="9.5" width="5" height="5" rx="0.5" />
          <path d="M9 3v2M12 3v2M15 3v2M9 19v2M12 19v2M15 19v2M3 9h2M3 12h2M3 15h2M19 9h2M19 12h2M19 15h2" />
        </svg>
      );
    case "mem":
      return (
        <svg {...p}>
          <rect x="2.5" y="9" width="19" height="7" rx="1" />
          <path d="M6 16v2M10 16v2M14 16v2M18 16v2M6 9V7.5M18 9V7.5" />
        </svg>
      );
    case "disk":
      return (
        <svg {...p}>
          <ellipse cx="12" cy="6" rx="7" ry="3" />
          <path d="M5 6v6c0 1.66 3.13 3 7 3s7-1.34 7-3V6" />
          <path d="M5 12v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" />
        </svg>
      );
    case "temperature":
      return (
        <svg {...p}>
          <path d="M14 14.76V5a2 2 0 0 0-4 0v9.76a4 4 0 1 0 4 0z" />
        </svg>
      );
    case "gas":
      return (
        <svg {...p}>
          <path d="M3 8h11a3 3 0 1 0-3-3" />
          <path d="M3 12h15a3 3 0 1 1-3 3" />
          <path d="M3 16h8.5a2.5 2.5 0 1 1-2.5 2.5" />
        </svg>
      );
    case "humidity":
      return (
        <svg {...p}>
          <path d="M12 2.7s6 6.3 6 10.3a6 6 0 0 1-12 0c0-4 6-10.3 6-10.3z" />
        </svg>
      );
    case "router_cpu":
    case "router_mem":
    case "router_clients":
    case "link_util":
    case "link_errors":
    case "router_latency":
    case "router_loss":
      return (
        <svg {...p}>
          <rect x="3" y="13" width="18" height="7" rx="1.5" />
          <path d="M7 16.5h.01M10.5 16.5h.01" />
          <path d="M12 10V6M9 8a4 4 0 0 1 6 0" />
        </svg>
      );
    case "ups_charge":
    case "ups_runtime":
    case "ups_load":
      return (
        <svg {...p}>
          <rect x="2" y="8" width="18" height="9" rx="1.5" />
          <path d="M22 11v3" />
          <path d="M10 9.5l-2 3.5h3l-2 3" />
        </svg>
      );
    default:
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
  }
}

export default function AlertRules() {
  const [rules, setRules] = useState<Rule[]>([]);
  const [servers, setServers] = useState<ServerOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [confirmId, setConfirmId] = useState<number | null>(null);

  // filters
  const [search, setSearch] = useState("");
  const [metricFilter, setMetricFilter] = useState("all");
  const [sevFilter, setSevFilter] = useState("all");
  const [scopeFilter, setScopeFilter] = useState("all"); // all | global | override
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(""), 3000);
  };

  const load = async () => {
    // Every device class that can hold an override, so the scope dropdown isn't limited
    // to servers. Each list is independent — one failing shouldn't blank the others.
    const [rulesRes, serversRes, netRes, upsRes, mkRes] = await Promise.all([
      api.getAlertRules(),
      api.getServers(),
      api.getNetworkDevices(),
      api.getUpsDevices(),
      api.getMikrotikDevices(),
    ]);
    if (rulesRes.success && rulesRes.data) setRules(rulesRes.data.rules ?? []);
    else setError(rulesRes.error || "Failed to load alert rules.");

    const opts: ServerOpt[] = [];
    const push = (rows: any[] | undefined, kind: DeviceKind) => {
      for (const r of rows ?? []) {
        const entry: ServerOpt = { id: Number(r.id), name: r.name, kind };
        // Network devices carry their ports so a rule can target one of them.
        const ports = (r.interfaces ?? []).map((i: any) => i?.name).filter(Boolean);
        if (kind === "network" && ports.length) entry.interfaces = ports;
        opts.push(entry);
      }
    };
    if (serversRes.success) push(serversRes.data?.servers, "server");
    // Routers and MikroTiks share the router_* / link_* metric vocabulary.
    if (netRes.success) push(netRes.data?.devices, "network");
    if (mkRes.success) push(mkRes.data?.devices, "network");
    if (upsRes.success) push(upsRes.data?.devices, "ups");
    setServers(opts);

    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  // Escape closes the modal
  useEffect(() => {
    if (!formOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFormOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [formOpen]);

  const openAdd = (deviceId = "") => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, deviceId });
    setError("");
    setConfirmId(null);
    setFormOpen(true);
  };

  const openEdit = (r: Rule) => {
    setEditingId(r.id);
    setForm({
      deviceId: r.deviceId == null ? "" : String(r.deviceId),
      interfaceName: r.interfaceName ?? "",
      metricName: r.metricName,
      thresholdValue: String(r.thresholdValue),
      comparison: r.comparison,
      severity: r.severity,
      isActive: r.isActive,
    });
    setError("");
    setConfirmId(null);
    setFormOpen(true);
  };

  const save = async () => {
    const threshold = Number(form.thresholdValue);
    if (form.thresholdValue.trim() === "" || !Number.isFinite(threshold)) {
      setError("Threshold must be a number.");
      return;
    }
    setSaving(true);
    setError("");
    const payload = {
      deviceId: form.deviceId === "" ? null : Number(form.deviceId),
      metricName: form.metricName,
      thresholdValue: threshold,
      comparison: form.comparison,
      severity: form.severity,
      isActive: form.isActive,
      // "" → null so the rule applies to the whole device. Always sent, so clearing a
      // port on an existing rule actually clears it rather than being ignored.
      interfaceName: form.interfaceName || null,
    };
    const res = editingId
      ? await api.updateAlertRule(editingId, payload)
      : await api.createAlertRule(payload);
    setSaving(false);
    if (res.success) {
      setFormOpen(false);
      showToast(editingId ? "Rule updated." : "Rule created.");
      load();
    } else {
      setError(res.error || "Save failed.");
    }
  };

  const toggleActive = async (r: Rule) => {
    const res = await api.updateAlertRule(r.id, { isActive: !r.isActive });
    if (res.success) {
      setRules((prev) => prev.map((x) => (x.id === r.id ? { ...x, isActive: !x.isActive } : x)));
    } else {
      showToast(res.error || "Could not update rule.");
    }
  };

  const remove = async (id: number) => {
    setConfirmId(null);
    const res = await api.deleteAlertRule(id);
    if (res.success) {
      setRules((prev) => prev.filter((x) => x.id !== id));
      showToast("Rule deleted.");
    } else {
      showToast(res.error || "Delete failed.");
    }
  };

  // ─── Coverage guard ─────────────────────────────────────────────────────────
  // Alerting is rules-only: with no global rule for a metric, every server WITHOUT
  // its own override goes silent for it. Warn before an edit/delete removes the last
  // global rule that's still covering a metric.
  const activeGlobalCount = (metric: string, excludeId?: number) =>
    rules.filter(
      (r) => r.deviceId == null && r.isActive && r.metricName === metric && r.id !== excludeId,
    ).length;

  const editingRule = editingId != null ? rules.find((r) => r.id === editingId) ?? null : null;

  // Live warning for the open edit form: does saving drop the last global coverage?
  const coverageLossMessage = (): string | null => {
    if (!editingRule || editingRule.deviceId != null) return null; // only a global rule can lose global coverage
    const metric = editingRule.metricName;
    if (activeGlobalCount(metric) === 0) return null; // nothing was covered anyway
    const stillCovers = form.deviceId === "" && form.isActive && form.metricName === metric;
    const after = activeGlobalCount(metric, editingRule.id) + (stillCovers ? 1 : 0);
    if (after > 0) return null; // another global rule still covers this metric
    const label = metricMeta(metric).label;
    const how =
      form.deviceId !== ""
        ? "reassigning it to a single server"
        : form.metricName !== metric
          ? "changing its metric"
          : !form.isActive
            ? "pausing it"
            : "this change";
    return `This is the last global ${label} rule. By ${how}, every OTHER server will have no ${label} alerts (alerting is rules-only — nothing else covers them).`;
  };

  // Short warning for the inline delete confirm.
  const deleteLossMessage = (rule: Rule): string | null => {
    if (rule.deviceId != null) return null;
    if (activeGlobalCount(rule.metricName) === 0) return null;
    if (activeGlobalCount(rule.metricName, rule.id) > 0) return null;
    return `Last global ${metricMeta(rule.metricName).label} rule — all other servers lose ${metricMeta(rule.metricName).label} alerts`;
  };

  // ─── derived: stats ─────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const total = rules.length;
    const active = rules.filter((r) => r.isActive).length;
    const global = rules.filter((r) => r.deviceId == null).length;
    return { total, active, paused: total - active, global, overrides: total - global };
  }, [rules]);

  // ─── derived: filter → group by scope ───────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rules.filter((r) => {
      if (metricFilter !== "all" && r.metricName !== metricFilter) return false;
      if (sevFilter !== "all" && r.severity !== sevFilter) return false;
      if (scopeFilter === "global" && r.deviceId != null) return false;
      if (scopeFilter === "override" && r.deviceId == null) return false;
      if (q) {
        const meta = metricMeta(r.metricName);
        const scopeName = r.deviceId == null ? "global" : r.deviceName ?? `device ${r.deviceId}`;
        const hay =
          `${meta.label} ${r.metricName} ${r.severity} ${scopeName} ${r.interfaceName ?? ""} ${r.comparison}${r.thresholdValue}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rules, search, metricFilter, sevFilter, scopeFilter]);

  const groups = useMemo(() => {
    const map = new Map<string, { key: string; deviceId: number | null; name: string; rules: Rule[] }>();
    for (const r of filtered) {
      const key = r.deviceId == null ? "global" : `dev-${r.deviceId}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          deviceId: r.deviceId,
          name: r.deviceId == null ? "Global defaults" : r.deviceName ?? `Device ${r.deviceId}`,
          rules: [],
        });
      }
      map.get(key)!.rules.push(r);
    }
    const order = (m: string) => {
      const i = METRICS.findIndex((x) => x.value === m);
      return i === -1 ? 99 : i;
    };
    for (const g of map.values()) {
      g.rules.sort(
        (a, b) =>
          order(a.metricName) - order(b.metricName) ||
          (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0) ||
          a.thresholdValue - b.thresholdValue,
      );
    }
    return [...map.values()].sort(
      (a, b) => Number(a.deviceId != null) - Number(b.deviceId != null) || a.name.localeCompare(b.name),
    );
  }, [filtered]);

  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const filtersActive = search.trim() !== "" || metricFilter !== "all" || sevFilter !== "all" || scopeFilter !== "all";
  const clearFilters = () => {
    setSearch("");
    setMetricFilter("all");
    setSevFilter("all");
    setScopeFilter("all");
  };

  const selectCls = "text-[13px] px-2 py-1.5 rounded-[2px] outline-none cursor-pointer";
  const liveWarn = formOpen ? coverageLossMessage() : null;
  // A per-device scope only exposes metrics that apply to THAT kind of device — a router
  // can't have a disk rule, a UPS can't have a link-utilization rule. Temperature / gas /
  // humidity are room-level (the ESP32 isn't a `devices` row) so they stay global-only.
  const selectedDevice = form.deviceId === ""
    ? null
    : servers.find((s) => String(s.id) === form.deviceId) ?? null;
  const metricOptions = selectedDevice
    ? METRICS.filter((m) => !m.env && m.scope === selectedDevice.kind)
    : METRICS;

  return (
    <div className="p-4 lg:p-6" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-[16px] font-bold" style={{ color: gf.textPrimary }}>
            Alert Rules
          </h1>
          <p className="text-[13px] mt-1 max-w-2xl" style={{ color: gf.textMuted }}>
            Configurable thresholds. A <b style={{ color: gf.accent }}>Global</b> rule applies to
            every server and the room; a <b style={{ color: PURPLE }}>per-server</b> rule overrides
            the global for that one server.
          </p>
        </div>
        {/* .gf-btn owns the raised face, hover and press-inset, so the manual
            mouse handlers and the hand-rolled active:translate-y-px are gone. */}
        <button
          onClick={() => openAdd()}
          className="gf-btn inline-flex items-center gap-2 text-[14px] font-medium whitespace-nowrap"
          style={{ height: 32, padding: "0 12px", color: "var(--gf-text-primary)" }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          Add rule
        </button>
      </div>

      {/* Stat panels */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard label="Total rules" value={stats.total} color={gf.accent} sub={`${stats.paused} paused`} />
        <StatCard label="Active" value={stats.active} color={GREEN} sub="firing" />
        <StatCard label="Global defaults" value={stats.global} color={gf.accent} sub="all servers / room" />
        <StatCard label="Server overrides" value={stats.overrides} color={PURPLE} sub="per-server" />
      </div>

      {/* Rules-only reminder */}
      <div
        className="flex items-start gap-2 text-[12px] px-3 py-2 mb-4 rounded-[2px]"
        style={{ color: gf.textMuted, background: gf.accentDim, border: `1px solid ${gf.border}` }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={gf.accent} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-px">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8h.01M11 12h1v4h1" />
        </svg>
        <span>
          Alerting is <b>rules-only</b> — a metric with no active rule raises nothing. The seeded
          global defaults preserve the previous 80/90 (servers) and firmware (environment) behavior.
        </span>
      </div>

      {/* Toolbar: search + filters */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[180px]">
          <svg
            width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={gf.textDim} strokeWidth="2" strokeLinecap="round"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input name="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search rules, metric or server…"
            className="w-full text-[13px] pl-8 pr-2 py-1.5 rounded-[2px] outline-none"
            style={inputStyle}
          />
        </div>
        <select name="metricFilter" value={metricFilter} onChange={(e) => setMetricFilter(e.target.value)} className={selectCls} style={inputStyle}>
          <option value="all">All metrics</option>
          {METRICS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <select name="sevFilter" value={sevFilter} onChange={(e) => setSevFilter(e.target.value)} className={selectCls} style={inputStyle}>
          <option value="all">All severities</option>
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
        <select name="scopeFilter" value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value)} className={selectCls} style={inputStyle}>
          <option value="all">All scopes</option>
          <option value="global">Global only</option>
          <option value="override">Overrides only</option>
        </select>
        {filtersActive && (
          <button
            onClick={clearFilters}
            className="text-[12px] px-2.5 py-1.5 rounded-[2px] transition-colors"
            style={{ color: gf.textMuted, border: `1px solid ${gf.border}`, background: "transparent" }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Grouped rules */}
      {loading ? (
        <div className="rounded-lg px-3 py-10 text-center text-[14px]" style={{ background: gf.panel, border: `1px solid ${gf.border}`, color: gf.textDim }}>
          Loading…
        </div>
      ) : groups.length === 0 ? (
        <EmptyState filtered={filtersActive} onAdd={() => openAdd()} onClear={clearFilters} />
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map((g) => {
            const isGlobal = g.deviceId == null;
            const open = !collapsed.has(g.key);
            return (
              <div key={g.key} className="rounded-lg overflow-hidden" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
                {/* group header */}
                <button
                  onClick={() => toggleCollapse(g.key)}
                  className="w-full flex items-center gap-2.5 px-3 transition-colors"
                  style={{ height: 40, background: gf.header, borderBottom: open ? `1px solid ${gf.divider}` : "none" }}
                >
                  <svg
                    width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={gf.textMuted} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
                    style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}
                  >
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                  <span style={{ color: isGlobal ? gf.accent : PURPLE }}>
                    {isGlobal ? <GlobeIcon /> : <ServerIcon />}
                  </span>
                  <span className="text-[14px] font-semibold truncate" style={{ color: gf.textPrimary }}>
                    {g.name}
                  </span>
                  <span
                    className="px-1.5 py-0.5 rounded-full text-[11px] font-medium"
                    style={{ color: gf.textMuted, background: gf.hoverStrong }}
                  >
                    {g.rules.length}
                  </span>
                  <span
                    className="px-1.5 py-0.5 rounded-[2px] text-[10px] tracking-wider uppercase font-medium"
                    style={
                      isGlobal
                        ? { color: gf.accent, background: gf.accentDim }
                        : { color: PURPLE, background: `${PURPLE}1f` }
                    }
                  >
                    {isGlobal ? "Applies to all" : "Override"}
                  </span>
                </button>

                {/* rule rows */}
                {open &&
                  g.rules.map((r, idx) => {
                    const meta = metricMeta(r.metricName);
                    const sev = SEV_COLOR[r.severity] ?? gf.textMuted;
                    return (
                      <div
                        key={r.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 transition-colors"
                        style={{
                          borderTop: idx === 0 ? "none" : `1px solid ${gf.divider}`,
                          opacity: r.isActive ? 1 : 0.5,
                        }}
                      >
                        {/* metric + condition */}
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <span
                            className="grid place-items-center rounded-md shrink-0"
                            style={{ width: 32, height: 32, background: `${meta.color}1f`, color: meta.color }}
                          >
                            <MetricIcon name={r.metricName} />
                          </span>
                          <div className="min-w-0">
                            <div className="flex items-baseline gap-1.5 min-w-0">
                              <span className="text-[14px] font-medium truncate" style={{ color: gf.textPrimary }}>
                                {meta.label}
                              </span>
                              {/* Port-scoped rules look identical to device-wide ones
                                  without this — same metric, same device, different reach. */}
                              {r.interfaceName && (
                                <span
                                  className="text-[11px] px-1.5 py-0.5 rounded-[2px] shrink-0"
                                  style={{ color: gf.textMuted, background: gf.hover, border: `1px solid ${gf.divider}` }}
                                >
                                  {r.interfaceName}
                                </span>
                              )}
                            </div>
                            <div className="text-[12px] truncate" style={{ color: gf.textMuted }}>
                              when value{" "}
                              <span className="font-semibold" style={{ color: gf.textPrimary }}>
                                {r.comparison} {r.thresholdValue}
                                {meta.unit}
                              </span>
                            </div>
                            <div className="text-[11px] truncate mt-0.5" style={{ color: gf.textDim }}>
                              {r.updatedByName ? (
                                <>
                                  edited by{" "}
                                  <span style={{ color: gf.textMuted }}>{r.updatedByName}</span>
                                  {fmtWhen(r.updatedAt) && ` · ${fmtWhen(r.updatedAt)}`}
                                </>
                              ) : (
                                "system default"
                              )}
                            </div>
                          </div>
                        </div>

                        {/* severity */}
                        <span
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[2px] text-[11px] tracking-wider uppercase font-semibold shrink-0"
                          style={{ color: sev, background: `${sev}1f` }}
                        >
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: sev }} />
                          {r.severity}
                        </span>

                        {/* active toggle */}
                        <button
                          onClick={() => toggleActive(r)}
                          className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[2px] text-[11px] tracking-wider uppercase font-medium transition-colors shrink-0"
                          style={{
                            color: r.isActive ? GREEN : gf.textDim,
                            background: r.isActive ? `${GREEN}1f` : gf.hover,
                          }}
                          title={r.isActive ? "Click to pause" : "Click to activate"}
                        >
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: r.isActive ? GREEN : gf.textDim }} />
                          {r.isActive ? "Active" : "Paused"}
                        </button>

                        {/* actions */}
                        <div className="shrink-0">
                          {confirmId === r.id ? (
                            <span className="inline-flex items-center gap-1.5 flex-wrap justify-end">
                              {deleteLossMessage(r) ? (
                                <span className="inline-flex items-center gap-1 text-[12px] max-w-[260px]" style={{ color: ORANGE }}>
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={ORANGE} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                                    <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0z" />
                                    <path d="M12 9v4M12 17h.01" />
                                  </svg>
                                  {deleteLossMessage(r)}
                                </span>
                              ) : (
                                <span className="text-[12px]" style={{ color: gf.textMuted }}>
                                  Delete?
                                </span>
                              )}
                              <button
                                onClick={() => remove(r.id)}
                                className="gf-raise px-3 py-1.5 rounded-[3px] text-[12px] font-bold transition-all active:scale-95"
                                style={{
                                  color: "#fff",
                                  background: RED,
                                  border: `1px solid ${RED}`,
                                  boxShadow: "0 2px 6px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.25)",
                                }}
                              >
                                {deleteLossMessage(r) ? "Delete anyway" : "Yes"}
                              </button>
                              <button
                                onClick={() => setConfirmId(null)}
                                className="px-3 py-1.5 rounded-[3px] text-[12px] transition-all active:scale-95"
                                style={{
                                  color: gf.textMuted,
                                  background: gf.bg,
                                  border: `1px solid ${gf.border}`,
                                  boxShadow: "var(--gf-btn-shadow-active)",
                                }}
                              >
                                {deleteLossMessage(r) ? "Cancel" : "No"}
                              </button>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              <button
                                onClick={() => openEdit(r)}
                                className="gf-btn grid place-items-center w-8 h-8"
                                style={{ color: gf.textPrimary, borderRadius: 3 }}
                                title="Edit rule"
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M12 20h9" />
                                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
                                </svg>
                              </button>
                              <button
                                onClick={() => setConfirmId(r.id)}
                                className="gf-btn gf-btn-danger grid place-items-center w-8 h-8"
                                style={{ color: gf.textMuted, borderRadius: 3 }}
                                title="Delete rule"
                              >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
                                </svg>
                              </button>
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </div>
      )}

      {/* Add / edit modal */}
      {formOpen && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={() => setFormOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-[2px] overflow-hidden"
            style={{ background: gf.panel, border: `1px solid ${gf.border}`, boxShadow: "var(--gf-shadow)" }}
          >
            {/* modal header */}
            <div className="flex items-center justify-between px-4" style={{ height: 44, borderBottom: `1px solid ${gf.divider}`, background: gf.header }}>
              <span className="text-[14px] font-semibold tracking-wide" style={{ color: gf.textPrimary }}>
                {editingId ? "Edit rule" : "New alert rule"}
              </span>
              <button onClick={() => setFormOpen(false)} className="grid place-items-center w-7 h-7 rounded-md transition-colors" style={{ color: gf.textMuted }} title="Close (Esc)">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Scope">
                  <select name="deviceId"
                    value={form.deviceId}
                    onChange={(e) => {
                      const deviceId = e.target.value;
                      setForm((f) => {
                        // Switching scope: if the current metric doesn't apply to the newly
                        // selected device's kind (or is room-level), fall back to that
                        // kind's default metric.
                        const dev = deviceId === "" ? null : servers.find((s) => String(s.id) === deviceId);
                        // Global scope, or a different device: a port from the old
                        // device is meaningless, so drop it.
                        if (!dev) return { ...f, deviceId, interfaceName: "" };
                        const m = metricMeta(f.metricName);
                        const metricName =
                          m.env || m.scope !== dev.kind ? KIND_DEFAULT_METRIC[dev.kind] : f.metricName;
                        return { ...f, deviceId, metricName, interfaceName: "" };
                      });
                    }}
                    className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none"
                    style={inputStyle}
                  >
                    <option value="">Global (all devices / room)</option>
                    {/* Grouped so it's obvious which class each device belongs to —
                        the metric list below adapts to whichever you pick. */}
                    {(["server", "network", "ups"] as DeviceKind[]).map((kind) => {
                      const group = servers.filter((s) => s.kind === kind);
                      if (!group.length) return null;
                      return (
                        <optgroup key={kind} label={KIND_LABEL[kind]}>
                          {group.map((s) => (
                            <option key={`${kind}:${s.id}`} value={s.id}>
                              {s.name}
                            </option>
                          ))}
                        </optgroup>
                      );
                    })}
                  </select>
                </Field>

                <Field label="Metric">
                  <select name="metricName" value={form.metricName} onChange={(e) => setForm((f) => {
                    const metricName = e.target.value;
                    // Point the condition the sensible way for the chosen metric: lower-is-worse
                    // metrics (battery / runtime) want '<='; keep the user's operator if it
                    // already matches the metric's direction.
                    const isLt = f.comparison.startsWith("<");
                    const lw = metricMeta(metricName).lowerIsWorse;
                    const comparison = lw ? (isLt ? f.comparison : "<=") : (isLt ? ">=" : f.comparison);
                    // Only per-port metrics can carry a port scope — drop it otherwise.
                    const interfaceName = PER_PORT_METRICS.has(metricName) ? f.interfaceName : "";
                    return { ...f, metricName, comparison, interfaceName };
                  })} className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle}>
                    {metricOptions.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label} ({m.unit})
                      </option>
                    ))}
                  </select>
                </Field>

                {/* Per-port scope. link_util / link_errors are measured per interface, so
                    an ISP uplink that normally sits at 70% and an access port that should
                    never exceed 5% can each carry their own threshold. Only shown when a
                    network device is scoped and it reported its ports. */}
                {selectedDevice?.kind === "network"
                  && PER_PORT_METRICS.has(form.metricName)
                  && (selectedDevice.interfaces?.length ?? 0) > 0 && (
                  <Field label="Port">
                    <select name="interfaceName"
                      value={form.interfaceName}
                      onChange={(e) => setForm((f) => ({ ...f, interfaceName: e.target.value }))}
                      className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none"
                      style={inputStyle}
                    >
                      <option value="">All ports on this device</option>
                      {selectedDevice.interfaces!.map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  </Field>
                )}

                <Field label="Condition">
                  <select name="comparison" value={form.comparison} onChange={(e) => setForm((f) => ({ ...f, comparison: e.target.value }))} className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle}>
                    {COMPARISONS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label={`Threshold (${metricMeta(form.metricName).unit})`}>
                  <input name="thresholdValue"
                    type="number"
                    value={form.thresholdValue}
                    onChange={(e) => setForm((f) => ({ ...f, thresholdValue: e.target.value }))}
                    placeholder="e.g. 90"
                    autoFocus
                    className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none"
                    style={inputStyle}
                  />
                </Field>

                <Field label="Severity">
                  <div className="flex gap-1.5">
                    {SEVERITIES.map((s) => {
                      const c = SEV_COLOR[s];
                      const on = form.severity === s;
                      return (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setForm((f) => ({ ...f, severity: s }))}
                          className="flex-1 text-[12px] tracking-wider uppercase font-semibold px-2 py-1.5 rounded-[2px] transition-colors"
                          style={{
                            color: on ? c : gf.textMuted,
                            background: on ? `${c}26` : gf.bg,
                            border: `1px solid ${on ? c : gf.border}`,
                          }}
                        >
                          {s}
                        </button>
                      );
                    })}
                  </div>
                </Field>

                <Field label="Status">
                  <label className="flex items-center gap-2 text-[13px] px-2 py-1.5 rounded-[2px] cursor-pointer" style={{ ...inputStyle, color: gf.textMuted }}>
                    <input name="isActive" type="checkbox" checked={form.isActive} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))} />
                    {form.isActive ? "Active (rule will fire)" : "Paused (rule disabled)"}
                  </label>
                </Field>
              </div>

              {/* live preview */}
              <div className="mt-4 p-3 rounded-[2px]" style={{ background: gf.bg, border: `1px solid ${gf.border}` }}>
                <div className="text-[10px] tracking-widest uppercase mb-1.5" style={{ color: gf.textDim }}>
                  Preview
                </div>
                <RulePreview form={form} servers={servers} />
              </div>

              {/* coverage guard — last global rule for a metric */}
              {liveWarn && (
                <div className="flex items-start gap-2 text-[12px] mt-3 px-3 py-2 rounded-[2px]" style={{ color: ORANGE, background: `${ORANGE}14`, border: `1px solid ${ORANGE}40` }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={ORANGE} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-px">
                    <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.42 0z" />
                    <path d="M12 9v4M12 17h.01" />
                  </svg>
                  <span>
                    {liveWarn} Add a separate per-server rule instead to keep the global for everyone
                    else.
                  </span>
                </div>
              )}

              {error && (
                <div className="text-[12px] mt-3" style={{ color: RED }}>
                  {error}
                </div>
              )}

              <div className="flex gap-2 mt-4">
                <button onClick={save} disabled={saving} className="text-[13px] font-semibold px-4 py-2 rounded-md transition-colors active:scale-95 disabled:opacity-50" style={{ color: "#fff", background: liveWarn ? ORANGE : gf.accent }}>
                  {saving ? "Saving…" : liveWarn ? "Save anyway" : editingId ? "Save changes" : "Create rule"}
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
        <div
          className="fixed top-5 right-5 z-[100] flex items-center gap-2 px-4 py-3 rounded-[2px] border text-xs shadow-xl"
          style={{ color: GREEN, background: `${GREEN}14`, borderColor: `${GREEN}40`, fontFamily: "'JetBrains Mono', monospace" }}
        >
          <span>✓</span> {toast}
        </div>
      )}
    </div>
  );
}

// ─── small components ─────────────────────────────────────────────────────────

function StatCard({ label, value, color, sub }: { label: string; value: number; color: string; sub?: string }) {
  return (
    <div className="relative overflow-hidden rounded-lg flex flex-col" style={{ background: gf.panel, border: `1px solid ${gf.border}`, minHeight: 84 }}>
      <div className="flex items-center justify-between px-3 pt-2.5">
        <span className="text-[12px] tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>
          {label}
        </span>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      </div>
      <div className="px-3 pt-1.5 pb-3">
        <span className="text-[28px] font-bold leading-none" style={{ color }}>
          {value}
        </span>
        {sub && (
          <div className="text-[11px] mt-1.5 tracking-widest uppercase" style={{ color: gf.textDim }}>
            {sub}
          </div>
        )}
      </div>
    </div>
  );
}

function RulePreview({ form, servers }: { form: FormState; servers: ServerOpt[] }) {
  const meta = metricMeta(form.metricName);
  const sev = SEV_COLOR[form.severity] ?? gf.textMuted;
  const deviceName = form.deviceId === "" ? "all devices / the room" : servers.find((s) => String(s.id) === form.deviceId)?.name ?? "the selected device";
  // Name the port when one is chosen, so the sentence reads as the rule actually behaves.
  const scope = form.interfaceName ? `${deviceName} · ${form.interfaceName}` : deviceName;
  const threshold = form.thresholdValue.trim() === "" ? "…" : form.thresholdValue;
  return (
    <div className="flex items-center gap-2.5 flex-wrap text-[13px]" style={{ color: gf.textPrimary }}>
      <span className="grid place-items-center rounded-md shrink-0" style={{ width: 28, height: 28, background: `${meta.color}1f`, color: meta.color }}>
        <MetricIcon name={form.metricName} size={14} />
      </span>
      <span>
        Raise a{" "}
        <span className="font-semibold tracking-wider uppercase text-[12px] px-1.5 py-0.5 rounded-[2px]" style={{ color: sev, background: `${sev}1f` }}>
          {form.severity}
        </span>{" "}
        alert when <b>{meta.label}</b>{" "}
        <span className="font-semibold">
          {form.comparison} {threshold}
          {meta.unit}
        </span>{" "}
        on <b>{scope}</b>.
      </span>
    </div>
  );
}

function EmptyState({ filtered, onAdd, onClear }: { filtered: boolean; onAdd: () => void; onClear: () => void }) {
  return (
    <div className="rounded-lg px-4 py-12 flex flex-col items-center text-center" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
      <span className="grid place-items-center rounded-full mb-3" style={{ width: 44, height: 44, background: gf.accentDim, color: gf.accent }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        </svg>
      </span>
      {filtered ? (
        <>
          <div className="text-[15px] font-semibold mb-1" style={{ color: gf.textPrimary }}>
            No rules match your filters
          </div>
          <div className="text-[13px] mb-4" style={{ color: gf.textMuted }}>
            Try a different search or clear the filters.
          </div>
          <button onClick={onClear} className="text-[13px] font-medium px-3 py-1.5 rounded-md" style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}>
            Clear filters
          </button>
        </>
      ) : (
        <>
          <div className="text-[15px] font-semibold mb-1" style={{ color: gf.textPrimary }}>
            No alert rules yet
          </div>
          <div className="text-[13px] mb-4 max-w-sm" style={{ color: gf.textMuted }}>
            With rules-only alerting, nothing will fire until you add a rule. Apply the seed migration
            or create one now.
          </div>
          <button onClick={onAdd} className="gf-btn text-[13px] font-semibold px-3 py-1.5" style={{ color: gf.textPrimary }}>
            + Add your first rule
          </button>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] tracking-wider uppercase" style={{ color: gf.textDim }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function GlobeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" />
    </svg>
  );
}

function ServerIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="7" rx="1" />
      <rect x="3" y="13" width="18" height="7" rx="1" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </svg>
  );
}
