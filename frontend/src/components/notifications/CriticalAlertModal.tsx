import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useNotifications } from "../../context/NotificationContext";
import type { AppNotification } from "../../types/notification";
import { routeFor, deviceLabel } from "./notificationUtils";
import { api } from "../../api/api";
import { startAlarm, stopAlarm, isAudioBlocked } from "../../utils/criticalAlarm";

/**
 * The CRITICAL alert takeover — a blocking, centred, loud interruption for the one severity
 * that means somebody has to move now.
 *
 * Why this exists alongside the bell, the toast and the email: every one of those is passive.
 * A toast auto-dismisses after six seconds, the bell is a number in a corner, and email is
 * read when it is read. For smoke in a server room that is not good enough — the client asked
 * for something in the shape of an NDRRMC emergency broadcast, and the defining property of
 * one is that you cannot carry on until you have dealt with it.
 *
 * Scope is deliberately `critical` ONLY. Extending it to warnings would train everybody to
 * click it away without reading, which is precisely how a real alarm gets missed.
 *
 * ── Lifecycle ────────────────────────────────────────────────────────────────────────────
 * Raised by two paths, because either alone leaves a hole:
 *   • LIVE   — the `notification` socket event, via the context's subscribe()
 *   • ON LOAD — a scan of the existing feed for critical alerts still `active`
 * The second is what covers a wall display that refreshed mid-incident, and the staff member
 * who opens the dashboard *because* they got the email. An alarm only the already-open tab
 * ever sees is a weak alarm.
 *
 * Closing is ACKNOWLEDGE, which writes `alerts.acknowledged_by` and is visible to everyone on
 * the Alerts page. Silence is separate and does not close: killing the noise and taking
 * ownership of an incident are different acts, and fusing them would mean the only way to
 * stop a siren is to claim something you have not looked at yet.
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

  // Everything this component has already queued or closed, so neither the live event nor the
  // on-load scan can raise the same incident twice. Keyed by alertId (the shared incident),
  // NOT the per-user notification id.
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

  // ── Path 2: whatever was already open when this mounted ────────────────────────────────
  // Runs on every `items` change rather than once: the feed is fetched asynchronously, so at
  // first mount it is usually still empty. enqueue()'s own dedupe makes the repeat harmless.
  useEffect(() => {
    for (const n of items) {
      if (n.severity === "critical" && (n.status ?? "active") === "active") enqueue(n);
    }
  }, [items, enqueue]);

  // ── Someone else acknowledged or resolved it ───────────────────────────────────────────
  // `items` is kept live by the context's `alertUpdated` listener, so a colleague acting from
  // the Alerts page — or an auto-resolve when the metric recovers — takes the modal down here
  // too. Without this, a recovered incident would keep a siren running in an empty office.
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

  /* Navigating alone was useless: this is a blocking overlay, so the page it opened was
     behind the very dialog that opened it. Collapsing to the bar is what makes the button mean
     anything — and the alternative, removing it, would have left Acknowledge as the only way
     to reach the data, i.e. you must take ownership of an incident before you are allowed to
     look at what it is. Nothing is dismissed here: the alarm keeps sounding, the queue keeps
     its place, and the bar cannot be closed except by acknowledging. */
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
     A persistent bar rather than a dismissal. It pins to the TOP because the 40px Header is
     a breadcrumb, not navigation — the Sidebar owns that — so covering it costs nothing,
     while a bottom bar would sit under the toast stack. There is no close button on purpose:
     the only exits are Acknowledge and somebody else resolving it. */
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
        // Deliberately opaque enough to blank the dashboard behind it. A translucent scrim
        // would leave the charts readable and invite people to keep working around the alarm.
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
            // Said out loud rather than swallowed: a screen that looks like it is sounding an
            // alarm, on a machine whose browser has blocked audio, is worse than one that
            // admits it is silent.
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

          {/* Acknowledge goes full-width and FIRST-in-reach on a phone. With `ml-auto`
              alone it wrapped onto its own row anyway, but right-aligned and detached from
              the two it belongs beside. */}
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
