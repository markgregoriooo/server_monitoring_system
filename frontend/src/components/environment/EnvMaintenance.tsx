import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/api";
import type { EnvMaintenanceStatus } from "../../api/api";
import { socket } from "../../socket/socket";

/**
 * Environment node maintenance — the shared pieces used by the Environment page (button,
 * modal, banner with Extend/Resume) and the Dashboard (banner only).
 *
 * While a window is open the room alerts (sensor offline, temperature, humidity, smoke)
 * are not raised and auto-cooling is paused, so the banner is deliberately loud and on
 * every page that shows the room: nobody should mistake a quiet room for a safe one.
 * Backend: services/envMaintenanceService.js.
 */

const ORANGE = "#FF780A";
// Primary action label: the raised .gf-btn like the rest of the app (Backups' "Back up
// now"), with an orange label so it reads as part of the maintenance warning.
const PRIMARY = { color: ORANGE } as const;

// Must match envMaintenanceRules.DURATION_MINUTES (the backend rejects anything else).
const DURATIONS: { minutes: number; label: string }[] = [
  { minutes: 30, label: "30 min" },
  { minutes: 60, label: "1 hour" },
  { minutes: 120, label: "2 hours" },
  { minutes: 240, label: "4 hours" },
];
const NOTE_MAX = 200;

const INACTIVE: EnvMaintenanceStatus = { active: false };

/** Current window, kept live: first GET, then the `envMaintenance` broadcast. */
export function useEnvMaintenance() {
  const [status, setStatus] = useState<EnvMaintenanceStatus>(INACTIVE);

  const refresh = useCallback(async () => {
    const r = await api.getEnvMaintenance();
    if (r.success && r.data) setStatus(r.data);
  }, []);

  useEffect(() => {
    void refresh();
    const onUpdate = (s: EnvMaintenanceStatus) => setStatus(s ?? INACTIVE);
    // A broadcast missed while the socket was down is caught up on reconnect.
    const onConnect = () => void refresh();
    socket.on("envMaintenance", onUpdate);
    socket.on("connect", onConnect);
    return () => {
      socket.off("envMaintenance", onUpdate);
      socket.off("connect", onConnect);
    };
  }, [refresh]);

  // Drop the banner at the scheduled end even if the "ended" broadcast never arrives.
  useEffect(() => {
    if (!status.active || !status.endsAt) return;
    const wait = Date.parse(status.endsAt) - Date.now();
    if (!(wait > 0)) {
      setStatus(INACTIVE);
      return;
    }
    const t = setTimeout(() => setStatus(INACTIVE), wait + 500);
    return () => clearTimeout(t);
  }, [status]);

  return { status, setStatus, refresh };
}

const fmtClock = (iso?: string) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";

function minutesLeft(iso?: string) {
  if (!iso) return 0;
  return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 60000));
}

const fmtLeft = (m: number) =>
  m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`;

/** Toolbar button on the Environment page (admin). Icon-only on a phone, like Recalibrate. */
export function EnvMaintenanceButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={active ? "Extend or end the maintenance window" : "Put the environment node in maintenance (admin)"}
      aria-label={active ? "Maintenance window options" : "Start maintenance"}
      className="gf-btn text-[13px] px-2 sm:px-2.5 py-1 inline-flex items-center gap-1.5"
      style={{ color: active ? ORANGE : "var(--gf-text-muted)" }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="shrink-0">
        <path
          d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4 2.6-2.6z"
          stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
        />
      </svg>
      <span className="hidden sm:inline">{active ? "In maintenance" : "Maintenance"}</span>
    </button>
  );
}

/**
 * The banner. `onExtend`/`onResume` are passed only for an admin; without them it is
 * read-only (IT staff, and the Dashboard).
 */
export function EnvMaintenanceBanner({
  status,
  onExtend,
  onResume,
  busy = false,
  className = "",
}: {
  status: EnvMaintenanceStatus;
  onExtend?: (() => void) | undefined;
  onResume?: (() => void) | undefined;
  busy?: boolean;
  className?: string;
}) {
  // Re-render every 30s so "in N min" counts down.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!status.active) return;
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, [status.active]);

  if (!status.active) return null;
  const left = minutesLeft(status.endsAt);

  return (
    <div
      className={`flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-3 ${className}`}
      style={{ background: "rgba(255,120,10,0.10)", border: "1px solid rgba(255,120,10,0.35)", borderRadius: 2 }}
      role="status"
    >
      <div className="flex items-start gap-3 flex-1 min-w-0">
        <span style={{ color: ORANGE, fontSize: 14, lineHeight: "18px" }}>■</span>
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-[14px] font-bold" style={{ color: ORANGE }}>
            Environment node in maintenance until {fmtClock(status.endsAt)}
            <span className="font-normal" style={{ color: "var(--gf-text-muted)" }}> · {fmtLeft(left)} left</span>
          </span>
          <span className="text-[13px] break-words" style={{ color: "var(--gf-text-muted)" }}>
            Room alerts (sensor offline, temperature, humidity, smoke) and auto-cooling are paused.
            {status.note ? ` Work: ${status.note}.` : ""}
            {status.startedBy ? ` Started by ${status.startedBy}.` : ""}
          </span>
        </div>
      </div>
      {(onExtend || onResume) && (
        <div className="flex items-center gap-2 shrink-0 pl-6 sm:pl-0">
          {onExtend && (
            <button onClick={onExtend} disabled={busy} className="gf-btn text-[12px] px-2.5 py-1" style={{ color: "var(--gf-text-muted)" }}>
              Extend
            </button>
          )}
          {onResume && (
            <button
              onClick={onResume}
              disabled={busy}
              className="gf-btn text-[12px] px-2.5 py-1 font-semibold"
              style={PRIMARY}
            >
              {busy ? "Resuming…" : "Resume monitoring"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Start a window, or extend the open one (`extending`). */
export function EnvMaintenanceModal({
  extending,
  initialNote,
  onClose,
  onDone,
}: {
  extending: boolean;
  initialNote?: string | null | undefined;
  onClose: () => void;
  onDone: (s: EnvMaintenanceStatus) => void;
}) {
  const [minutes, setMinutes] = useState(60);
  const [note, setNote] = useState(initialNote ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await api.startEnvMaintenance(minutes, note.trim());
    setBusy(false);
    if (!r.success || !r.data) {
      setError(r.error ?? "Could not start maintenance.");
      return;
    }
    onDone(r.data);
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      style={{ background: "rgba(8,9,12,0.7)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md max-h-[92vh] overflow-y-auto"
        style={{
          background: "var(--gf-panel)",
          border: "1px solid var(--gf-panel-border)",
          borderRadius: 2,
          fontFamily: "'JetBrains Mono', monospace",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 flex items-center justify-between" style={{ borderBottom: "1px solid var(--gf-divider)" }}>
          <h3 className="text-[14px] font-semibold" style={{ color: "var(--gf-text-primary)" }}>
            {extending ? "Extend maintenance" : "Environment node maintenance"}
          </h3>
          <button onClick={onClose} aria-label="Close" style={{ color: "var(--gf-text-dim)" }}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <form onSubmit={submit} className="p-5 flex flex-col gap-4">
          <div
            className="px-3 py-2.5"
            style={{ background: "rgba(255,120,10,0.08)", border: "1px solid rgba(255,120,10,0.2)", borderRadius: 2 }}
          >
            <p className="text-[12px] leading-relaxed" style={{ color: ORANGE }}>
              {extending
                ? "The window will end this long from now instead."
                : "While in maintenance the server room has NO smoke, heat or sensor-offline alerts, and auto-cooling is paused. Live readings still show. It ends on its own at the time you choose."}
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] tracking-widest uppercase" style={{ color: "var(--gf-text-dim)" }}>
              {extending ? "End in" : "Duration"}
            </span>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {DURATIONS.map((d) => {
                const on = d.minutes === minutes;
                return (
                  <button
                    key={d.minutes}
                    type="button"
                    onClick={() => setMinutes(d.minutes)}
                    className={`gf-btn text-[13px] py-1.5 ${on ? "font-semibold" : ""}`}
                    style={
                      on
                        ? { color: ORANGE, borderColor: ORANGE, boxShadow: "var(--gf-btn-shadow-active)", backgroundImage: "none" }
                        : { color: "var(--gf-text-muted)" }
                    }
                    aria-pressed={on}
                  >
                    {d.label}
                  </button>
                );
              })}
            </div>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-[11px] tracking-widest uppercase" style={{ color: "var(--gf-text-dim)" }}>
              What is being done <span style={{ textTransform: "none" }}>(optional)</span>
            </span>
            <input
              name="maintenanceNote"
              value={note}
              maxLength={NOTE_MAX}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. replacing MQ-2 #2"
              className="px-2 py-1.5 text-[14px] rounded-[2px] outline-none"
              style={{ background: "var(--gf-bg)", border: "1px solid var(--gf-panel-border)", color: "var(--gf-text-primary)" }}
            />
          </label>

          {error && <p className="text-[12px]" style={{ color: "#F2495C" }}>{error}</p>}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="gf-btn text-[13px] px-3 py-1.5" style={{ color: "var(--gf-text-muted)" }}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="gf-btn text-[13px] px-3 py-1.5 font-semibold"
              style={PRIMARY}
            >
              {busy ? "Saving…" : extending ? "Extend" : "Start maintenance"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
