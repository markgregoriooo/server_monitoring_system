import { useEffect, useRef, useState } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import { useNotifications } from "../context/NotificationContext";
import { relativeTime } from "../components/notifications/notificationUtils";

// Shared incident list (alerts table) with lifecycle: active → acknowledged → resolved.
// Distinct from the per-user bell feed (NotificationContext). Admin + IT staff.

interface Alert {
  id: number;
  deviceId: number | null;
  deviceName: string | null;
  type: string;
  title: string;
  message: string;
  severity: string;
  status: string; // active | acknowledged | resolved
  acknowledgedByName: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

type Filter = "all" | "active" | "acknowledged" | "resolved";
const FILTERS: Filter[] = ["all", "active", "acknowledged", "resolved"];

const SEV_COLOR: Record<string, string> = { critical: "#E02F44", warning: "#FF780A", info: "#5794F2" };
const STATUS_COLOR: Record<string, string> = {
  active: "#F2495C",
  acknowledged: "#5794F2",
  resolved: "#73BF69",
};
const GREEN = "#73BF69";

const gf = {
  panel: "var(--gf-panel)",
  border: "var(--gf-panel-border)",
  header: "var(--gf-header)",
  textPrimary: "var(--gf-text-primary)",
  textMuted: "var(--gf-text-muted)",
  textDim: "var(--gf-text-dim)",
  hover: "var(--gf-hover)",
  accent: "var(--gf-accent)",
  accentDim: "var(--gf-accent-dim)",
} as const;

const sourceLabel = (a: Alert) =>
  a.deviceName ?? (a.deviceId == null ? "Server room" : `Device ${a.deviceId}`);

export default function Alerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [filter, setFilter] = useState<Filter>("active");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [ackCount, setAckCount] = useState(0); // acknowledged-but-not-resolved → tab badge
  const { refresh: refreshNotifications } = useNotifications();
  const filterRef = useRef<Filter>(filter);
  filterRef.current = filter;

  const load = async (f: Filter = filterRef.current) => {
    const res = await api.getAlerts(f === "all" ? undefined : f);
    if (res.success && res.data) setAlerts(res.data.alerts ?? []);
    setLoading(false);
  };

  // Count of currently-acknowledged alerts — tracked separately from `alerts` so the
  // tab badge is correct even while viewing another filter.
  const loadAckCount = async () => {
    const res = await api.getAlerts("acknowledged");
    if (res.success && res.data) setAckCount((res.data.alerts ?? []).length);
  };

  useEffect(() => {
    setLoading(true);
    load(filter);
  }, [filter]);

  // Live: lifecycle changes (alertUpdated) + newly-raised alerts (notification) → reload
  // the current view + the acknowledged count so other users' actions and auto-resolves
  // show up immediately.
  useEffect(() => {
    loadAckCount();
    const refresh = () => {
      load();
      loadAckCount();
    };
    socket.on("alertUpdated", refresh);
    socket.on("notification", refresh);
    return () => {
      socket.off("alertUpdated", refresh);
      socket.off("notification", refresh);
    };
  }, []);

  const act = async (id: number, action: "acknowledge" | "resolve") => {
    setBusyId(id);
    const res = action === "acknowledge" ? await api.acknowledgeAlert(id) : await api.resolveAlert(id);
    setBusyId(null);
    if (res.success) {
      load();
      loadAckCount();
      refreshNotifications(); // your own bell row was auto-marked read server-side
    }
  };

  return (
    <div className="p-4 lg:p-6" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      {/* Header + filter tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-[15px] font-bold" style={{ color: gf.textPrimary }}>
            Alerts
          </h1>
          <p className="text-[13px] mt-1" style={{ color: gf.textMuted }}>
            Incident list. Acknowledge when you're handling it; resolve when it's over
            (alerts also auto-resolve when the metric recovers).
          </p>
        </div>
        <div className="flex gap-1">
          {/* inline-flex + gap so the tab can carry the acknowledged count badge; the
              12px sizing and the `capitalize` moved onto the inner span both come from
              main's readability pass.
              These are TOGGLES, so the two states get opposite depth — unselected sits
              raised on .gf-btn's face, selected is pushed IN with the inset shadow.
              Same treatment as the History page's filters, so the two pages' filter
              rows behave identically. */}
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className="gf-btn inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1"
              style={{
                color: filter === f ? gf.textPrimary : gf.textMuted,
                ...(filter === f
                  ? { background: gf.accentDim, borderColor: gf.accent, boxShadow: "var(--gf-btn-shadow-active)" }
                  : {}),
              }}
            >
              <span className="capitalize">{f}</span>
              {f === "acknowledged" && ackCount > 0 && (
                <span
                  className="inline-flex items-center justify-center text-[9px] font-semibold rounded-full px-1 min-w-[15px] h-[15px] leading-none"
                  style={{ background: gf.accent, color: "#fff" }}
                >
                  {ackCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-[2px] overflow-hidden" style={{ border: `1px solid ${gf.border}` }}>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: gf.header, color: gf.textDim }}>
                {["Severity", "Alert", "Source", "When", "Status", ""].map((h) => (
                  <th
                    key={h}
                    className="text-left font-medium px-3 py-2 whitespace-nowrap tracking-wider uppercase text-[11px]"
                    style={{ borderBottom: `1px solid ${gf.border}` }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center" style={{ color: gf.textDim }}>
                    Loading…
                  </td>
                </tr>
              ) : alerts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center" style={{ color: gf.textDim }}>
                    No {filter === "all" ? "" : filter} alerts.
                  </td>
                </tr>
              ) : (
                alerts.map((a, i) => (
                  <tr
                    key={a.id}
                    style={{
                      background: i % 2 ? gf.hover : "transparent",
                      color: gf.textPrimary,
                      opacity: a.status === "resolved" ? 0.6 : 1,
                    }}
                  >
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className="px-1.5 py-0.5 rounded-[2px] text-[11px] tracking-wider uppercase font-medium"
                        style={{
                          color: SEV_COLOR[a.severity] ?? gf.textMuted,
                          background: `${SEV_COLOR[a.severity] ?? "#888"}1f`,
                        }}
                      >
                        {a.severity}
                      </span>
                    </td>
                    <td className="px-3 py-2 max-w-[320px]">
                      <div className="font-medium truncate">{a.title}</div>
                      <div className="truncate text-[12px]" style={{ color: gf.textMuted }}>
                        {a.message}
                      </div>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: gf.textMuted }}>
                      {sourceLabel(a)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap" style={{ color: gf.textDim }}>
                      {relativeTime(a.createdAt)}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span
                        className="px-1.5 py-0.5 rounded-[2px] text-[11px] tracking-wider uppercase font-medium"
                        style={{
                          color: STATUS_COLOR[a.status] ?? gf.textMuted,
                          background: `${STATUS_COLOR[a.status] ?? "#888"}1f`,
                        }}
                      >
                        {a.status}
                      </span>
                      {a.acknowledgedByName && a.status !== "active" && (
                        <div className="text-[11px] mt-0.5" style={{ color: gf.textDim }}>
                          by {a.acknowledgedByName}
                          {a.status === "resolved" && a.resolvedAt
                            ? ` · ${relativeTime(a.resolvedAt)}`
                            : a.acknowledgedAt
                              ? ` · ${relativeTime(a.acknowledgedAt)}`
                              : ""}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-right">
                      <span className="inline-flex gap-1.5">
                        {a.status === "active" && (
                          <button
                            onClick={() => act(a.id, "acknowledge")}
                            disabled={busyId === a.id}
                            className="px-2 py-1 rounded-md text-[12px] transition-colors disabled:opacity-50"
                            style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}
                          >
                            Acknowledge
                          </button>
                        )}
                        {a.status !== "resolved" && (
                          <button
                            onClick={() => act(a.id, "resolve")}
                            disabled={busyId === a.id}
                            className="gf-raise px-2 py-1 rounded-md text-[12px] transition-colors disabled:opacity-50"
                            style={{ color: "#fff", background: GREEN }}
                          >
                            Resolve
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
