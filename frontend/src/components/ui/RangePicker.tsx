import { useState, useEffect, useRef } from "react";

// ─── Time-range picker (presets + custom absolute window) ─────────────────────
// Presets mirror the server whitelist in services/historyRange.js (PRESET_WINDOW).
// Keep the two in step: an unknown preset silently falls back to -1h server-side,
// which would look like the button simply didn't work.
//
// TWO VISUAL VARIANTS on purpose. This codebase runs two design systems side by
// side (see CLAUDE.md "Page Style Status"): most pages use the Grafana `--gf-*`
// tokens, while ServerDetail is `slate-*` + `dark:` overrides. Rather than force one
// look into the wrong page, the picker renders either. `slate` is the default
// because ServerDetail is the first consumer; pass variant="gf" on a Grafana page.

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

// Seconds covered by a value — drives the "does the axis need DATES?" decision.
export function rangeSpanSec(v: RangeValue): number {
  if (v.kind === "custom") return (Date.parse(v.stop) - Date.parse(v.start)) / 1000;
  return { "-1h": 3600, "-6h": 21600, "-24h": 86400, "-7d": 604800, "-30d": 2592000 }[v.preset];
}

// `datetime-local` speaks LOCAL wall-clock with no zone ("2026-08-04T14:30"), while
// the API speaks UTC ISO. These convert via the Date constructor, which reads a
// zone-less string as local time — exactly what the user meant when they typed it.
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
  variant = "slate",
}: {
  value: RangeValue;
  onChange: (v: RangeValue) => void;
  error?: string | undefined; // server-side rejection, surfaced next to the inputs
  variant?: "slate" | "gf";
}) {
  const [open, setOpen] = useState(false);
  const [startInput, setStartInput] = useState("");
  const [stopInput, setStopInput] = useState("");
  const [localError, setLocalError] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  const isCustom = value.kind === "custom";
  const gf = variant === "gf";

  // Per-variant class sets. Kept as whole literal strings (not built by
  // concatenation) so Tailwind's scanner can see every class it must emit.
  // `shrink-0` so the preset group is never squeezed to nothing when it shares a
  // wrapped header row with other controls.
  const groupCls = gf
    ? "flex rounded-md overflow-hidden shrink-0 border border-[var(--gf-panel-border)]"
    : "flex gap-1 shrink-0 bg-slate-100 dark:bg-white/[0.05] rounded-md p-0.5";
  const btnCls = (active: boolean) =>
    gf
      ? `text-[12px] px-2 py-0.5 transition-colors ${active ? "bg-[var(--gf-hover)] text-[var(--gf-text-primary)]" : "text-[var(--gf-text-muted)]"}`
      : `px-2.5 py-1 rounded text-[13px] font-medium transition-colors ${
          active
            ? "bg-white dark:bg-white/[0.12] text-slate-900 dark:text-white shadow-sm"
            : "text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white"
        }`;
  // POSITIONING MATTERS HERE. At >=sm this is an absolutely positioned dropdown. On a
  // phone `absolute` is unusable: the picker sits in a panel header whose root may set
  // `overflow-hidden` (rounded corners), so a dropdown taller than the panel is clipped
  // and the inputs become unreachable. `fixed` escapes every overflow and stacking
  // ancestor, so on mobile it becomes a bottom sheet pinned to the viewport — fully
  // visible wherever the panel sits and however far the page is scrolled.
  const popPos =
    "fixed inset-x-3 bottom-3 z-[70] sm:absolute sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-full sm:mt-1.5 sm:w-auto sm:min-w-[250px]";
  const popCls = gf
    ? `${popPos} rounded-[2px] p-3 flex flex-col gap-2.5 shadow-xl bg-[var(--gf-panel)] border border-[var(--gf-panel-border)]`
    : `${popPos} rounded-md p-3 flex flex-col gap-2.5 shadow-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-white/10`;
  const labelCls = gf
    ? "text-[11px] tracking-wider uppercase text-[var(--gf-text-muted)]"
    : "text-[11px] tracking-wider uppercase text-slate-500 dark:text-slate-400";
  const inputCls = gf
    ? "text-[13px] px-2 py-1 rounded-[2px] outline-none bg-[var(--gf-bg)] border border-[var(--gf-panel-border)] text-[var(--gf-text-primary)]"
    : "text-[13px] px-2 py-1 rounded outline-none bg-slate-50 dark:bg-white/[0.06] border border-slate-200 dark:border-white/10 text-slate-900 dark:text-white";
  const chipCls = gf
    ? "text-[11px] px-1.5 py-0.5 rounded-[2px] text-[var(--gf-text-muted)] border border-[var(--gf-panel-border)]"
    : "text-[11px] px-1.5 py-0.5 rounded text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-white/10";
  const activeWindowCls = gf
    ? "text-[12px] tabular-nums hidden md:inline text-[var(--gf-text-muted)]"
    : "text-[13px] tabular-nums hidden md:inline text-slate-500 dark:text-slate-400";

  // Seed the inputs from whatever is currently charted, so opening the editor starts
  // from the visible window rather than blank fields.
  const openEditor = () => {
    const now = new Date();
    if (value.kind === "custom") {
      setStartInput(isoToLocalInput(value.start));
      setStopInput(isoToLocalInput(value.stop));
    } else {
      setStartInput(isoToLocalInput(new Date(now.getTime() - rangeSpanSec(value) * 1000).toISOString()));
      setStopInput(isoToLocalInput(now.toISOString()));
    }
    setLocalError("");
    setOpen(true);
  };

  // Click-outside and Escape both close it — it's a popover, not a modal, so it must
  // never trap the page.
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
    // Mirror the server's rules so common mistakes are caught without a round trip;
    // the server still enforces them (this is convenience, not the gate).
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
        <span className={activeWindowCls}>
          {fmtShort(value.start)} → {fmtShort(value.stop)}
        </span>
      )}

      <div className={groupCls}>
        {PRESETS.map((p) => (
          <button key={p} onClick={() => onChange({ kind: "preset", preset: p })} className={btnCls(!isCustom && value.kind === "preset" && value.preset === p)}>
            {presetLabel[p]}
          </button>
        ))}
        <button
          onClick={openEditor}
          title="Custom time range"
          className={`${btnCls(isCustom)} inline-flex items-center gap-1`}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M3 10h18M8 3v4M16 3v4" />
          </svg>
          Custom
        </button>
      </div>

      {open && (
        <>
        {/* Mobile only: dimmed backdrop so the bottom sheet reads as a modal layer and
            a tap anywhere outside closes it. */}
        <div className="fixed inset-0 z-[60] sm:hidden" style={{ background: "rgba(0,0,0,0.45)" }} onClick={() => setOpen(false)} />
        <div className={popCls}>
          <span className={labelCls}>Custom range · local time</span>
          <label className="flex flex-col gap-1">
            <span className={labelCls}>From</span>
            <input
              type="datetime-local"
              value={startInput}
              onChange={(e) => setStartInput(e.target.value)}
              className={inputCls}
              style={{ colorScheme: "dark light" }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={labelCls}>To</span>
            <input
              type="datetime-local"
              value={stopInput}
              onChange={(e) => setStopInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && apply()}
              className={inputCls}
              style={{ colorScheme: "dark light" }}
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
                className={chipCls}
              >
                last {lbl}
              </button>
            ))}
          </div>

          {shown && <div className="text-[12px] text-red-500 dark:text-red-400">{shown}</div>}

          {/* Bigger tap targets on touch; compact again at >=sm. */}
          <div className="flex gap-2">
            <button onClick={apply} className="flex-1 sm:flex-none text-[13px] sm:text-[12px] px-2.5 py-2 sm:py-1 rounded font-semibold text-white bg-[#5794F2]">
              Apply
            </button>
            <button
              onClick={() => setOpen(false)}
              className={gf
                ? "flex-1 sm:flex-none text-[13px] sm:text-[12px] px-2.5 py-2 sm:py-1 rounded-[2px] text-[var(--gf-text-muted)] border border-[var(--gf-panel-border)]"
                : "flex-1 sm:flex-none text-[13px] sm:text-[12px] px-2.5 py-2 sm:py-1 rounded text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-white/10"}
            >
              Cancel
            </button>
          </div>
        </div>
        </>
      )}
    </div>
  );
}
