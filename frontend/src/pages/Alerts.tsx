import { useEffect, useRef, useState } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import { useNotifications } from "../context/NotificationContext";
import { relativeTime } from "../components/notifications/notificationUtils";
import { GF as gf, STATUS } from "../theme/gf";
const { green: GREEN } = STATUS;

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


const sourceLabel = (a: Alert) =>
  a.deviceName ?? (a.deviceId == null ? "Server room" : `Device ${a.deviceId}`);

// Who acted, and when. Rendered twice — under the status pill in the table and on the
// phone card — so it lives here rather than being written out twice: the fallback chain
// (resolved time, else acknowledged time, else no time at all) is exactly the kind of
// detail that drifts between two copies.
const actorLine = (a: Alert): string | null => {
  if (!a.acknowledgedByName || a.status === "active") return null;
  const when =
    a.status === "resolved" && a.resolvedAt
      ? relativeTime(a.resolvedAt)
      : a.acknowledgedAt
        ? relativeTime(a.acknowledgedAt)
        : null;
  return `by ${a.acknowledgedByName}${when ? ` · ${when}` : ""}`;
};

function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      className="px-1.5 py-0.5 rounded-[2px] text-[11px] tracking-wider uppercase font-medium"
      style={{ color, background: `${color}1f` }}
    >
      {children}
    </span>
  );
}

// Acknowledge / Resolve, shared by the table row and the phone card so an alert can
// never offer different actions depending on the width of the screen. `full` stretches
// the buttons across a card — on a phone a 70px tap target at the end of a row is the
// one thing you came to press and the hardest thing to hit.
function AlertActions({
  a,
  busy,
  onAct,
  full,
}: {
  a: Alert;
  busy: boolean;
  onAct: (id: number, action: "acknowledge" | "resolve") => void;
  full?: boolean;
}) {
  if (a.status === "resolved") return null;
  const btn = `px-2 py-1 rounded-md text-[12px] transition-colors disabled:opacity-50${full ? " flex-1" : ""}`;
  return (
    <span className={full ? "flex gap-1.5 w-full" : "inline-flex gap-1.5"}>
      {a.status === "active" && (
        <button
          onClick={() => onAct(a.id, "acknowledge")}
          disabled={busy}
          className={btn}
          style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}
        >
          Acknowledge
        </button>
      )}
      <button
        onClick={() => onAct(a.id, "resolve")}
        disabled={busy}
        className={`gf-raise ${btn}`}
        style={{ color: "#fff", background: GREEN }}
      >
        Resolve
      </button>
    </span>
  );
}

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
        {/* flex-wrap: four toggles plus the acknowledged badge overrun a 360px phone,
            and an un-wrapped row pushes "resolved" off the edge rather than shrinking. */}
        <div className="flex flex-wrap gap-1">
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

      {/* Incident list — TWO layouts over one data source.
          A six-column table on a 390px phone is a sideways scroll, and the columns that
          end up off the right edge are the message and the buttons: the two things the
          page exists for. Below `md` the same alerts render as cards; from `md` up it is
          the table, unchanged. Same split UpsMonitoring.tsx already uses for its list. */}
      <div className="rounded-[2px] overflow-hidden" style={{ border: `1px solid ${gf.border}` }}>
        {/* Phone */}
        <div className="md:hidden">
          {loading ? (
            <div className="px-3 py-6 text-center text-[13px]" style={{ color: gf.textDim }}>
              Loading…
            </div>
          ) : alerts.length === 0 ? (
            <div className="px-3 py-6 text-center text-[13px]" style={{ color: gf.textDim }}>
              No {filter === "all" ? "" : filter} alerts.
            </div>
          ) : (
            alerts.map((a, i) => (
              <div
                key={a.id}
                className="flex flex-col gap-2 px-3 py-3"
                style={{
                  borderTop: i > 0 ? `1px solid ${gf.border}` : "none",
                  color: gf.textPrimary,
                  opacity: a.status === "resolved" ? 0.6 : 1,
                }}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <Pill color={SEV_COLOR[a.severity] ?? gf.textMuted}>{a.severity}</Pill>
                  <Pill color={STATUS_COLOR[a.status] ?? gf.textMuted}>{a.status}</Pill>
                  <span className="ml-auto text-[11px]" style={{ color: gf.textDim }}>
                    {relativeTime(a.createdAt)}
                  </span>
                </div>

                {/* break-words, not the table's `truncate`: on a phone this text is the
                    whole reason the row is on screen, and there is no hover tooltip to
                    recover a cut-off message from. */}
                <div>
                  <div className="text-[13px] font-medium break-words">{a.title}</div>
                  <div className="text-[12px] break-words" style={{ color: gf.textMuted }}>
                    {a.message}
                  </div>
                </div>

                <div className="text-[11px] break-words" style={{ color: gf.textDim }}>
                  {sourceLabel(a)}
                  {actorLine(a) ? ` · ${actorLine(a)}` : ""}
                </div>

                <AlertActions a={a} busy={busyId === a.id} onAct={act} full />
              </div>
            ))
          )}
        </div>

        {/* Tablet and up */}
        <div className="hidden md:block overflow-x-auto">
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
                      <Pill color={SEV_COLOR[a.severity] ?? gf.textMuted}>{a.severity}</Pill>
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
                      <Pill color={STATUS_COLOR[a.status] ?? gf.textMuted}>{a.status}</Pill>
                      {actorLine(a) && (
                        <div className="text-[11px] mt-0.5" style={{ color: gf.textDim }}>
                          {actorLine(a)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-right">
                      <AlertActions a={a} busy={busyId === a.id} onAct={act} />
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
