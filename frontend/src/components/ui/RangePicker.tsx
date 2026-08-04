import { useState, useEffect, useRef } from "react";

// ─── Time-range picker (presets + custom absolute window) ─────────────────────
// Shared by the router and UPS detail pages so both offer the same choices — a
// battery discharge and the traffic during the same outage have to be comparable
// over the same period. Drops into a Panel's `right` slot, same footprint as the
// plain button row it replaces.
//
// Presets mirror the server whitelist in services/snmpUtils.js (PRESET_WINDOW).
// Keep the two in step: an unknown preset silently falls back to -1h server-side,
// which would look like the button simply didn't work.

export const PRESETS = ["-1h", "-6h", "-24h", "-7d", "-30d"] as const;
export type Preset = (typeof PRESETS)[number];
export const presetLabel: Record<Preset, string> = {
  "-1h": "1h",
  "-6h": "6h",
  "-24h": "24h",
  "-7d": "7d",
  "-30d": "30d",
};

export type RangeValue =
  | { kind: "preset"; preset: Preset }
  | { kind: "custom"; start: string; stop: string }; // ISO-8601 (UTC)

export const DEFAULT_RANGE: RangeValue = { kind: "preset", preset: "-1h" };

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
const BLUE = "#5794F2";
const RED = "#F2495C";

// `datetime-local` speaks LOCAL wall-clock with no zone ("2026-08-04T14:30"), while
// the API speaks UTC ISO. These two convert between them via the Date constructor,
// which interprets a zone-less string as local time — which is exactly what the user
// meant when they typed it.
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localInputToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
function fmtShort(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString("en-PH", {
    timeZone: "Asia/Manila", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

export default function RangePicker({
  value,
  onChange,
  error,
}: {
  value: RangeValue;
  onChange: (v: RangeValue) => void;
  error?: string | undefined; // server-side rejection, surfaced next to the inputs
}) {
  const [open, setOpen] = useState(false);
  const [startInput, setStartInput] = useState("");
  const [stopInput, setStopInput] = useState("");
  const [localError, setLocalError] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  const isCustom = value.kind === "custom";

  // Seed the inputs from whatever is currently charted, so opening the editor starts
  // from the visible window rather than blank fields.
  const openEditor = () => {
    const now = new Date();
    if (value.kind === "custom") {
      setStartInput(isoToLocalInput(value.start));
      setStopInput(isoToLocalInput(value.stop));
    } else {
      const hours = value.preset === "-1h" ? 1 : value.preset === "-6h" ? 6 : value.preset === "-24h" ? 24 : value.preset === "-7d" ? 168 : 720;
      setStartInput(isoToLocalInput(new Date(now.getTime() - hours * 3600_000).toISOString()));
      setStopInput(isoToLocalInput(now.toISOString()));
    }
    setLocalError("");
    setOpen(true);
  };

  // Click-outside and Escape both close the editor — it's a popover, not a modal, so
  // it must never trap the page.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const apply = () => {
    const start = localInputToIso(startInput);
    const stop = localInputToIso(stopInput);
    if (!start || !stop) return setLocalError("Enter both a start and an end.");
    // Mirror the server's rules so the common mistakes are caught without a round
    // trip; the server still enforces them (this is convenience, not the gate).
    const spanSec = (Date.parse(stop) - Date.parse(start)) / 1000;
    if (spanSec <= 0) return setLocalError("Start must be before end.");
    if (spanSec < 60) return setLocalError("Range must span at least 1 minute.");
    if (spanSec > 366 * 86400) return setLocalError("Range cannot span more than a year.");
    setLocalError("");
    setOpen(false);
    onChange({ kind: "custom", start, stop });
  };

  const shown = error || localError;

  return (
    <div className="relative flex items-center gap-2" ref={wrapRef}>
      {/* Active custom window, so the chart is never unlabelled about its period */}
      {isCustom && (
        <span className="text-[10px] tabular-nums hidden md:inline" style={{ color: gf.textMuted }}>
          {fmtShort(value.start)} → {fmtShort(value.stop)}
        </span>
      )}

      <div className="flex rounded-md overflow-hidden" style={{ border: `1px solid ${gf.border}` }}>
        {PRESETS.map((p) => {
          const active = !isCustom && value.preset === p;
          return (
            <button
              key={p}
              onClick={() => onChange({ kind: "preset", preset: p })}
              className="text-[10px] px-2 py-0.5 transition-colors"
              style={{ background: active ? gf.hover : "transparent", color: active ? gf.textPrimary : gf.textMuted }}
            >
              {presetLabel[p]}
            </button>
          );
        })}
        <button
          onClick={openEditor}
          title="Custom time range"
          className="text-[10px] px-2 py-0.5 transition-colors inline-flex items-center gap-1"
          style={{
            background: isCustom ? gf.hover : "transparent",
            color: isCustom ? BLUE : gf.textMuted,
            borderLeft: `1px solid ${gf.border}`,
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M3 10h18M8 3v4M16 3v4" />
          </svg>
          Custom
        </button>
      </div>

      {open && (
        <div
          className="absolute right-0 top-full mt-1.5 z-50 rounded-[2px] p-3 flex flex-col gap-2.5 shadow-xl"
          style={{ background: gf.panel, border: `1px solid ${gf.border}`, minWidth: 250 }}
        >
          <span className="text-[9px] tracking-widest uppercase" style={{ color: gf.textDim }}>
            Custom range · local time
          </span>
          <label className="flex flex-col gap-1">
            <span className="text-[9px] tracking-wider uppercase" style={{ color: gf.textDim }}>From</span>
            <input
              type="datetime-local"
              value={startInput}
              onChange={(e) => setStartInput(e.target.value)}
              className="text-[11px] px-2 py-1 rounded-[2px] outline-none"
              style={{ background: gf.bg, border: `1px solid ${gf.border}`, color: gf.textPrimary, colorScheme: "dark light" }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[9px] tracking-wider uppercase" style={{ color: gf.textDim }}>To</span>
            <input
              type="datetime-local"
              value={stopInput}
              onChange={(e) => setStopInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && apply()}
              className="text-[11px] px-2 py-1 rounded-[2px] outline-none"
              style={{ background: gf.bg, border: `1px solid ${gf.border}`, color: gf.textPrimary, colorScheme: "dark light" }}
            />
          </label>

          {/* Quick relative jumps — the common case is "the last N", not two dates */}
          <div className="flex flex-wrap gap-1">
            {([["6h", 6], ["12h", 12], ["2d", 48], ["90d", 2160]] as [string, number][]).map(([lbl, hrs]) => (
              <button
                key={lbl}
                onClick={() => {
                  const now = new Date();
                  setStartInput(isoToLocalInput(new Date(now.getTime() - hrs * 3600_000).toISOString()));
                  setStopInput(isoToLocalInput(now.toISOString()));
                  setLocalError("");
                }}
                className="text-[9px] px-1.5 py-0.5 rounded-[2px]"
                style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}
              >
                last {lbl}
              </button>
            ))}
          </div>

          {shown && <div className="text-[10px]" style={{ color: RED }}>{shown}</div>}

          <div className="flex gap-2">
            <button
              onClick={apply}
              className="text-[10px] px-2.5 py-1 rounded-[2px] font-semibold"
              style={{ background: BLUE, color: "#fff" }}
            >
              Apply
            </button>
            <button
              onClick={() => setOpen(false)}
              className="text-[10px] px-2.5 py-1 rounded-[2px]"
              style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
