import React from "react";
import { GF as gf, STATUS } from "../../theme/gf";

/**
 * The small building blocks the monitoring pages share.
 *
 * Each of these was copy-pasted across three or four pages, character-identical after
 * whitespace normalisation — `GhostButton` four times, `Stat`, `StatPanel`, `Field` and
 * `Meta` three times each, `PortChip` and `Th` twice. That is ~140 redundant lines, but
 * the reason to consolidate is not the line count: a button that renders differently on
 * the UPS page than on the router page is the kind of drift nobody notices until a
 * reviewer sees both screens side by side.
 *
 * See audits/code-duplication-report-2026-08-25.md — R-09.
 *
 * `Panel` is deliberately NOT here. It has eleven definitions across nine pages, but
 * only two pairs are identical — the rest differ in real ways (`subtitle`, `action`,
 * `bodyStyle`, `noPad`, optional vs required `title`). One `Panel` with eight optional
 * props would be worse than three honest ones, so those stay local until someone decides
 * what the shared contract actually is.
 */

const { red: RED } = STATUS;

/** A borderless text button. `danger` turns it red. */
export function GhostButton({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="gf-btn text-[13px] font-medium px-2.5 py-1"
      style={{ color: danger ? RED : gf.textMuted }}
    >
      {children}
    </button>
  );
}

/**
 * A single headline figure with a status dot.
 *
 * `minHeight` is the only thing that ever differed between the copies: the detail pages
 * used 84 and the monitoring pages 88. Defaulted to 84 with a prop, so both callers keep
 * the spacing they had rather than one silently shifting.
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
