import React from "react";
import { GF as gf, STATUS } from "../../theme/gf";

/**
 * Small building blocks shared by the monitoring pages (GhostButton, Stat, StatPanel,
 * Field, Meta, PortChip, Th), which used to be copied across pages.
 * See audits/code-duplication-report-2026-08-25.md (R-09).
 *
 * `Panel` is not here: its copies differ in real ways (`subtitle`, `action`,
 * `bodyStyle`, `noPad`, optional `title`), so they stay local for now.
 */

const { red: RED } = STATUS;

/**
 * A borderless text button. `danger` turns it red. `fitLabels` sizes the button to the
 * longest of those labels, so a button that swaps its text (Maintain / Resume) keeps one
 * width and the buttons beside it stay lined up from row to row.
 */
export function GhostButton({
  children,
  onClick,
  danger,
  fitLabels,
}: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
  fitLabels?: string[];
}) {
  // JetBrains Mono is monospace, so a label is exactly its length in `ch`.
  // + 20px padding (px-2.5) + 2px border.
  const longest = fitLabels ? Math.max(...fitLabels.map((l) => l.length)) : 0;
  return (
    <button
      onClick={onClick}
      className="gf-btn text-[13px] font-medium px-2.5 py-1 text-center"
      style={{
        color: danger ? RED : gf.textMuted,
        ...(longest ? { minWidth: `calc(${longest}ch + 22px)` } : {}),
      }}
    >
      {children}
    </button>
  );
}

/**
 * A single headline figure with a status dot. `minHeight` defaults to 84 (the
 * monitoring pages pass 88).
 */
export function Stat({
  label,
  value,
  unit,
  color,
  sub,
  minHeight = 84,
  valueSize = 24,
}: {
  label: string;
  value: string;
  unit?: string | undefined;
  color: string;
  sub?: string | undefined;
  minHeight?: number;
  valueSize?: number;
}) {
  return (
    <div
      className="relative overflow-hidden rounded-lg flex flex-col"
      style={{ background: gf.panel, border: `1px solid ${gf.border}`, minHeight }}
    >
      <div className="flex items-center justify-between px-3 pt-2.5">
        <span className="text-[12px] tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>
          {label}
        </span>
        <span
          className="w-1.5 h-1.5 rounded-full shrink-0"
          style={{ background: color, boxShadow: `0 0 6px ${color}` }}
        />
      </div>
      <div className="px-3 pt-1.5">
        <span className="font-bold leading-none" style={{ color, fontSize: valueSize }}>
          {value}
        </span>
        {unit && (
          <span className="text-[15px] ml-1" style={{ color: color + "AA" }}>
            {unit}
          </span>
        )}
        {sub && (
          <div className="text-[11px] mt-1 tracking-widest uppercase" style={{ color: gf.textDim }}>
            {sub}
          </div>
        )}
      </div>
    </div>
  );
}

/** `Stat` at the monitoring pages' proportions — 88px tall, 26px figure. */
export function StatPanel(props: Omit<React.ComponentProps<typeof Stat>, "minHeight" | "valueSize">) {
  return <Stat {...props} minHeight={88} valueSize={26} />;
}

/** A labelled block in a form or drawer. */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] tracking-wider uppercase" style={{ color: gf.textDim }}>
        {label}
      </span>
      {children}
    </div>
  );
}

/** One labelled fact in a summary strip. */
export function Meta({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <span className="inline-flex items-baseline gap-1.5 min-w-0">
      <span className="text-[10px] tracking-widest uppercase shrink-0" style={{ color: gf.textDim }}>
        {label}
      </span>
      <span className={`text-[12px] truncate ${mono ? "font-mono" : ""}`} style={{ color: gf.textMuted }}>
        {value}
      </span>
    </span>
  );
}

/** A table header cell in the WinBox-style interface tables. */
export function Th({
  children,
  right,
  w,
}: {
  children: React.ReactNode;
  right?: boolean;
  w?: number;
}) {
  return (
    <th
      className={`text-[11px] tracking-widest uppercase font-medium px-2 py-1.5 ${right ? "text-right" : "text-left"}`}
      style={{ color: gf.textMuted, width: w, whiteSpace: "nowrap" }}
    >
      {children}
    </th>
  );
}
