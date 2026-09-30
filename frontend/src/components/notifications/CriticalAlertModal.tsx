import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useNotifications } from "../../context/NotificationContext";
import type { AppNotification } from "../../types/notification";
import { routeFor, deviceLabel } from "./notificationUtils";
import { api } from "../../api/api";
import { startAlarm, stopAlarm, isAudioBlocked } from "../../utils/criticalAlarm";

/**
 * The critical alert takeover: a blocking, centred, loud interruption for alerts that
 * need someone to act now. The bell, toast and email can all be missed; this works
 * like an emergency broadcast. Critical only, so people do not learn to click it away.
 *
 * ── Lifecycle ────────────────────────────────────────────────────────────────────────────
 * Raised two ways:
 *   • live    : the `notification` socket event, via the context's subscribe()
 *   • on load : a scan of the feed for critical alerts still `active`
 * The second covers a wall display that refreshed during an incident, or someone who
 * opens the dashboard because of the email.
 *
 * Closing means Acknowledge, which sets `alerts.acknowledged_by` for everyone to see.
 * Silence only stops the sound; muting the alarm and taking ownership are separate.
 */

const CRITICAL_RECHECK_MS = 30_000; // re-arm the scheduled sweep well before it expires

export default function CriticalAlertModal() {
  const { items, subscribe, markRead } = useNotifications();
  const navigate = useNavigate();

  // The queue of criticals still needing acknowledgement, oldest first.
  const [queue, setQueue] = useState<AppNotification[]>([]);
  const [silenced, setSilenced] = useState(false);
  // Collapsed to the bar rather than dismissed. The incident is still open, still queued and
  // still sounding — the operator is just being allowed to LOOK at it.
  const [minimized, setMinimized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);

  // Alerts already queued or closed, so neither path raises the same one twice. Keyed
  // by alertId (the shared alert), not the per-user notification id.
  const handledRef = useRef<Set<number>>(new Set());

  const current = queue[0] ?? null;

  const enqueue = useCallback((n: AppNotification) => {
    if (n.severity !== "critical") return;
    if (n.status && n.status !== "active") return; // already acknowledged or resolved
    if (handledRef.current.has(n.alertId)) return;
    handledRef.current.add(n.alertId);
    setQueue((prev) => [...prev, n]);
    setSilenced(false); // a NEW critical un-silences: the last one being muted says nothing
                        // about this one
    setMinimized(false); // ...and re-takes the screen, for the same reason
  }, []);

  // ── Path 1: live events ────────────────────────────────────────────────────────────────
  useEffect(() => subscribe(enqueue), [subscribe, enqueue]);

  // ── Path 2: alerts already open when this mounted ────────────────────────────────
  // Runs on every `items` change, since the feed loads asynchronously; enqueue() skips
  // duplicates.
  useEffect(() => {
    for (const n of items) {
      if (n.severity === "critical" && (n.status ?? "active") === "active") enqueue(n);
    }
  }, [items, enqueue]);

  // ── Someone else acknowledged or resolved it ───────────────────────────────────────────
  // `items` is updated by the context's `alertUpdated` listener, so an acknowledge from
  // another user or an auto-resolve also closes the modal here and stops the siren.
  useEffect(() => {
    setQueue((prev) =>
      prev.filter((q) => {
        const live = items.find((n) => n.alertId === q.alertId);
        return !live || (live.status ?? "active") === "active";
      })
    );
  }, [items]);

  // ── The siren ──────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!current || silenced) {
      stopAlarm();
      return;
    }
    startAlarm();
    setBlocked(isAudioBlocked());

    // The sweep is scheduled on the audio clock for a few minutes at a time; re-arm it so a
    // genuinely long unattended incident does not quietly fall silent.
    const id = window.setInterval(() => {
      stopAlarm();
      startAlarm();
      setBlocked(isAudioBlocked());
    }, CRITICAL_RECHECK_MS);

    return () => {
      window.clearInterval(id);
      stopAlarm();
    };
  }, [current, silenced]);

  // Belt and braces: never leave a siren running if this unmounts (sign-out, route teardown).
  useEffect(() => () => stopAlarm(), []);

  const acknowledge = useCallback(async () => {
    if (!current || busy) return;
    setBusy(true);
    setError(null);
    const res = await api.acknowledgeAlert(current.alertId);
    setBusy(false);
    if (!res.success) {
      // Keep the modal and the alarm up. A failed acknowledge that closed the dialog anyway
      // would leave the incident unowned while everyone believes it was handled.
      setError(res.error || "Could not acknowledge — check the connection and try again.");
      return;
    }
    if (!current.isRead) markRead([current.id]);
    setQueue((prev) => prev.slice(1));
    setSilenced(false);
  }, [current, busy, markRead]);

  /* The modal blocks the page, so "view" collapses it to the bar instead of opening the
     page behind it. Nothing is dismissed: the alarm keeps sounding and the bar stays
     until someone acknowledges. */
  const viewDetails = useCallback(() => {
    if (!current) return;
    navigate(routeFor(current));
    setMinimized(true);
  }, [current, navigate]);

  const when = useMemo(() => {
    if (!current) return "";
    const d = new Date(current.createdAt);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
  }, [current]);

  if (!current) return null;

  /* ── Collapsed ───────────────────────────────────────────────────────────────────────────
     A bar pinned to the top (the header there is only a breadcrumb; a bottom bar would
     cover the toasts). No close button: it goes away on acknowledge or when someone
     else resolves the alert. */
  if (minimized) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="fixed top-0 left-0 right-0 z-[100] flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5"
        style={{
          background: "#E02F44",
          color: "#fff",
          fontFamily: "'JetBrains Mono', monospace",
          boxShadow: "0 2px 18px rgba(224,47,68,0.45)",
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="flex-shrink-0">
          <path
            d="M12 3L1.5 21h21L12 3z M12 10v5 M12 17.5v.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {/* The red bar and the warning glyph already say CRITICAL; on a phone the word
            is ~90px of the row that the alert's own TITLE needs more. */}
        <span className="text-[12px] font-bold tracking-[0.16em] flex-shrink-0 hidden sm:inline">CRITICAL</span>
        {/* min-w-0 or `truncate` cannot shrink it — a flex item will not go below its
            content width without it, and the row overflows instead of the text ellipsing. */}
        <span className="text-[13px] font-semibold truncate min-w-0">{current.title}</span>
        {deviceLabel(current) && (
          <span className="text-[12px] opacity-80 truncate hidden sm:inline">
            · {deviceLabel(current)}
          </span>
        )}
        {queue.length > 1 && (
          <span className="text-[11px] font-semibold opacity-90 flex-shrink-0">
            +{queue.length - 1} more
          </span>
        )}

        <span className="ml-auto flex items-center gap-2 flex-shrink-0">
          {/* Desktop only: three buttons plus the title do not fit 360px, and Silence is
              the one reachable another way — Expand opens the dialog, which has it. */}
          {!silenced && (
            <button
              onClick={() => setSilenced(true)}
              className="hidden sm:block px-2.5 py-1.5 text-[12px] font-semibold"
              style={{ background: "rgba(0,0,0,0.22)", color: "#fff", borderRadius: 3 }}
            >
              Silence
            </button>
          )}
          <button
            onClick={() => setMinimized(false)}
            className="px-2.5 py-1.5 text-[12px] font-semibold"
            style={{ background: "rgba(0,0,0,0.22)", color: "#fff", borderRadius: 3 }}
          >
            Expand
          </button>
          <button
            onClick={acknowledge}
            disabled={busy}
            className="px-3 py-1.5 text-[12px] font-bold disabled:opacity-60"
            style={{ background: "#fff", color: "#E02F44", borderRadius: 3 }}
          >
            {busy ? "…" : <><span className="sm:hidden">Ack</span><span className="hidden sm:inline">Acknowledge</span></>}
          </button>
        </span>
      </div>
    );
  }

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="critical-alert-title"
      aria-describedby="critical-alert-message"
      className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
      style={{
        // Opaque enough to hide the dashboard, so people do not keep working around the alarm.
        background: "rgba(8, 9, 12, 0.92)",
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      {/* The pulsing frame carries the urgency for anyone who cannot hear the siren — a muted
          machine, a deaf user, a noisy server room. motion-reduce turns it off. */}
      <style>{`
        @keyframes cspcCriticalPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(224,47,68,0.55), 0 0 40px rgba(224,47,68,0.25); }
          50%      { box-shadow: 0 0 0 18px rgba(224,47,68,0), 0 0 70px rgba(224,47,68,0.45); }
        }
      `}</style>

      <div
        className="w-full max-w-lg max-h-[92vh] overflow-y-auto animate-[cspcCriticalPulse_1.4s_ease-out_infinite] motion-reduce:animate-none"
        style={{
          background: "var(--gf-panel)",
          border: "2px solid #E02F44",
          borderRadius: 4,
        }}
      >
        <div
          className="flex items-center gap-2 sm:gap-3 px-4 sm:px-5 py-3"
          style={{ background: "#E02F44", color: "#fff" }}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 3L1.5 21h21L12 3z M12 10v5 M12 17.5v.5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="text-[13px] sm:text-[15px] font-bold tracking-[0.12em] sm:tracking-[0.18em] whitespace-nowrap">CRITICAL ALERT</span>
          {queue.length > 1 && (
            <span className="ml-auto text-[12px] font-semibold opacity-90">
              1 of {queue.length}
            </span>
          )}
        </div>

        <div className="px-4 sm:px-5 py-4 sm:py-5">
          <h2
            id="critical-alert-title"
            className="text-[17px] sm:text-[20px] font-bold leading-snug break-words"
            style={{ color: "var(--gf-text-primary)" }}
          >
            {current.title}
          </h2>
          <p
            id="critical-alert-message"
            className="mt-2 text-[14px] leading-relaxed"
            style={{ color: "var(--gf-text-primary)" }}
          >
            {current.message}
          </p>

          <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
            {deviceLabel(current) && (
              <>
                <dt style={{ color: "var(--gf-text-dim)" }}>Device</dt>
                <dd style={{ color: "var(--gf-text-muted)" }}>{deviceLabel(current)}</dd>
              </>
            )}
            <dt style={{ color: "var(--gf-text-dim)" }}>Raised</dt>
            <dd style={{ color: "var(--gf-text-muted)" }}>{when}</dd>
          </dl>

          {blocked && (
            // Tell the user when the browser has blocked sound, instead of looking like an alarm
            // that is sounding.
            <button
              onClick={() => {
                startAlarm();
                setBlocked(isAudioBlocked());
              }}
              className="mt-4 w-full px-3 py-2 text-[12px] font-semibold"
              style={{ background: "#FF780A", color: "#111217", borderRadius: 3 }}
            >
              ⚠ Sound is blocked by this browser — tap to enable
            </button>
          )}

          {error && (
            <p className="mt-3 text-[12px]" style={{ color: "#E02F44" }}>
              {error}
            </p>
          )}

          {/* On a phone, Acknowledge goes full width and first. */}
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              onClick={() => setSilenced(true)}
              disabled={silenced}
              className="px-4 py-2.5 text-[13px] font-semibold disabled:opacity-40"
              style={{
                background: "transparent",
                color: "var(--gf-text-primary)",
                border: "1px solid var(--gf-panel-border)",
                borderRadius: 3,
              }}
            >
              {silenced ? "Silenced" : "Silence"}
            </button>
            <button
              onClick={viewDetails}
              className="px-4 py-2.5 text-[13px] font-semibold"
              style={{
                background: "transparent",
                color: "var(--gf-accent)",
                border: "1px solid var(--gf-panel-border)",
                borderRadius: 3,
              }}
            >
              View details
            </button>
            <button
              onClick={acknowledge}
              disabled={busy}
              className="w-full sm:w-auto sm:ml-auto px-5 py-2.5 text-[13px] font-bold disabled:opacity-60"
              style={{ background: "#E02F44", color: "#fff", borderRadius: 3 }}
            >
              {busy ? "Acknowledging…" : "Acknowledge"}
            </button>
          </div>

          <p className="mt-3 text-[11px]" style={{ color: "var(--gf-text-dim)" }}>
            Acknowledging records your name against this incident for everyone on the Alerts
            page. Silence only stops the sound.
          </p>
        </div>
      </div>
    </div>
  );
}
