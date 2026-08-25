import { useEffect, useRef } from "react";
import { animate, stagger } from "animejs";
import { useInView, prefersReducedMotion, EASE, DUR } from "./motion";
import { STATUS } from "../../theme/gf";
const { green: GREEN, orange: ORANGE, critical: RED } = STATUS;

/**
 * One small animated visual per coverage card.
 *
 * Each is a different FORM, not the same shape in a different colour: bars that
 * fill, packets that travel a wire, a cell that charges, a curve inside a band.
 * Four cards carrying four recoloured copies of one icon is exactly the texture
 * that reads as generated, and it is the thing the consultant reacted to.
 *
 * Each visual also says what its data actually looks like — utilisation is a
 * bar, throughput is movement along a link, charge is a reservoir, room
 * temperature is a line with a safe band around it. The picture teaches the
 * metric.
 */

const ACCENT = "#5794F2";

const VB_W = 240;
const VB_H = 62;

/** Shared frame: fixed viewBox, decorative, and it reports when it is on screen. */
function Stage({
  children,
  onReveal,
}: {
  children: React.ReactNode;
  onReveal: (root: SVGSVGElement, still: boolean) => (() => void) | void;
}) {
  const { ref, inView } = useInView<HTMLDivElement>({ threshold: 0.35 });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const cbRef = useRef(onReveal);
  cbRef.current = onReveal;

  useEffect(() => {
    if (!inView || !svgRef.current) return;
    return cbRef.current(svgRef.current, prefersReducedMotion()) ?? undefined;
  }, [inView]);

  return (
    <div ref={ref}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="w-full"
        style={{ height: VB_H, display: "block", overflow: "visible" }}
        aria-hidden="true"
      >
        {children}
      </svg>
    </div>
  );
}

/* ── Servers: utilisation bars fill to their reading ────────────────────────
   Three bars, because the agent reports three things and the disk one is the
   worst-volume figure the alerting actually uses. */
const BARS = [
  { label: "cpu", to: 0.44, color: "#378ADD" },
  { label: "mem", to: 0.76, color: "#7F77DD" },
  { label: "disk", to: 0.91, color: ORANGE },
];

export function ServersVisual() {
  return (
    <Stage
      onReveal={(root, still) => {
        const fills = root.querySelectorAll<SVGRectElement>("[data-fill]");
        if (still) {
          fills.forEach((el) => {
            el.setAttribute("width", el.dataset["target"] ?? "0");
          });
          return;
        }
        // Each bar animates to its OWN target, so this is a loop rather than one
        // call with a function-value: every bar has a different end width, and
        // anime's per-target function form doesn't type-resolve for `width`.
        const anims = Array.from(fills).map((el, i) => {
          const target = Number(el.dataset["target"] ?? 0);
          el.setAttribute("width", "0");
          return animate(el, {
            width: target,
            duration: DUR.plot,
            delay: 110 * i,
            ease: EASE.settle,
          });
        });
        return () => anims.forEach((a) => a.pause());
      }}
    >
      {BARS.map((b, i) => {
        const y = 8 + i * 18;
        const track = 176;
        return (
          <g key={b.label}>
            <text x="0" y={y + 8} fontSize="10" fill="var(--gf-text-dim)" letterSpacing="0.1em">
              {b.label.toUpperCase()}
            </text>
            <rect x="34" y={y} width={track} height="9" rx="1" fill="var(--gf-seg-empty)" />
            <rect
              data-fill=""
              data-target={String(track * b.to)}
              x="34"
              y={y}
              width={track * b.to}
              height="9"
              rx="1"
              fill={b.color}
            />
            <text
              x={VB_W}
              y={y + 8}
              fontSize="10"
              textAnchor="end"
              fill="var(--gf-text-muted)"
              className="tabular-nums"
            >
              {Math.round(b.to * 100)}%
            </text>
          </g>
        );
      })}
    </Stage>
  );
}

/* ── Network: packets travel the link, in the direction data moves ──────────
   The motion is the metric here. A static line would be a picture of a cable;
   dots moving along it is throughput. */
export function NetworkVisual() {
  return (
    <Stage
      onReveal={(root, still) => {
        const dots = root.querySelectorAll<SVGCircleElement>("[data-packet]");
        if (still) {
          dots.forEach((d) => d.setAttribute("opacity", "0"));
          return;
        }
        const anim = animate(dots, {
          cx: [40, 200],
          opacity: [
            { to: 1, duration: 180 },
            { to: 1, duration: 1400 },
            { to: 0, duration: 200 },
          ],
          duration: DUR.travel,
          delay: stagger(420),
          loop: true,
          ease: EASE.linear,
        });
        return () => anim.pause();
      }}
    >
      {/* endpoints */}
      <rect x="14" y="20" width="26" height="22" rx="2" fill="var(--gf-seg-empty)" stroke={ACCENT} strokeWidth="1" />
      <rect x="200" y="20" width="26" height="22" rx="2" fill="var(--gf-seg-empty)" stroke={ACCENT} strokeWidth="1" />
      <text x="14" y="54" fontSize="9" fill="var(--gf-text-dim)" letterSpacing="0.08em">
        ether1
      </text>
      <text x={VB_W - 14} y="54" fontSize="9" textAnchor="end" fill="var(--gf-text-dim)" letterSpacing="0.08em">
        sfp1
      </text>

      {/* link */}
      <line x1="40" y1="31" x2="200" y2="31" stroke="var(--gf-divider)" strokeWidth="2" />
      {[0, 1, 2, 3].map((i) => (
        <circle key={i} data-packet="" cx="40" cy="31" r="2.5" fill={GREEN} opacity="0" />
      ))}

      <text x="120" y="16" fontSize="10" textAnchor="middle" fill="var(--gf-text-muted)">
        842 Mbps
      </text>
    </Stage>
  );
}

/* ── Power: the cell charges to its reading ─────────────────────────────────
   A reservoir, because that is what a battery is: the number that matters is how
   much is left, not how fast it is moving. */
export function PowerVisual() {
  return (
    <Stage
      onReveal={(root, still) => {
        const fill = root.querySelector<SVGRectElement>("[data-charge]");
        const bolt = root.querySelector<SVGPathElement>("[data-bolt]");
        if (!fill) return;
        const target = Number(fill.dataset["target"] ?? 0);
        if (still) {
          fill.setAttribute("width", String(target));
          return;
        }
        fill.setAttribute("width", "0");
        const anim = animate(fill, {
          width: target,
          duration: DUR.plot,
          delay: 120,
          ease: EASE.settle,
        });
        const cleanups = [() => anim.pause()];
        if (bolt) {
          const pulse = animate(bolt, {
            opacity: [0.35, 1],
            duration: 1200,
            loop: true,
            alternate: true,
            ease: "inOutQuad",
          });
          cleanups.push(() => pulse.pause());
        }
        return () => cleanups.forEach((fn) => fn());
      }}
    >
      {/* cell body + terminal */}
      <rect x="10" y="16" width="150" height="30" rx="2" fill="var(--gf-seg-empty)" stroke="var(--gf-panel-border)" strokeWidth="1" />
      <rect x="161" y="25" width="5" height="12" rx="1" fill="var(--gf-panel-border)" />
      <rect data-charge="" data-target="144" x="13" y="19" width="144" height="24" rx="1" fill={GREEN} />
      <path data-bolt="" d="M84 22 l-9 12 h7 l-3 10 l10 -13 h-7 z" fill="var(--gf-bg)" opacity="0.9" />
      <text x="176" y="27" fontSize="11" fill={GREEN} className="tabular-nums" fontWeight="600">
        98%
      </text>
      <text x="176" y="41" fontSize="9.5" fill="var(--gf-text-dim)">
        42 min left
      </text>
    </Stage>
  );
}

/* ── Server room: the curve, inside the band it must stay in ────────────────
   The band is the point. A temperature line alone is a squiggle; a line drawn
   against its warning and critical thresholds is a room being kept safe. */
const TEMP_PTS = [24.4, 24.6, 24.5, 24.9, 25.2, 25.0, 25.4, 25.9, 26.3, 26.1, 26.6, 27.0, 26.8, 26.5, 26.4];

export function ClimateVisual() {
  const path = TEMP_PTS.map((v, i) => {
    const x = (i / (TEMP_PTS.length - 1)) * (VB_W - 34);
    // 22-30 °C mapped across the box: the range the room actually lives in.
    const y = VB_H - 10 - ((v - 22) / 8) * (VB_H - 20);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");

  const yFor = (c: number) => VB_H - 10 - ((c - 22) / 8) * (VB_H - 20);

  return (
    <Stage
      onReveal={(root, still) => {
        const line = root.querySelector<SVGPathElement>("[data-temp]");
        if (!line) return;
        if (still) {
          line.style.strokeDasharray = "none";
          line.style.strokeDashoffset = "0";
          line.style.opacity = "1";
          return;
        }
        const len = line.getTotalLength();
        line.style.strokeDasharray = String(len);
        line.style.strokeDashoffset = String(len);
        line.style.opacity = "1";
        const anim = animate(line, {
          strokeDashoffset: 0,
          duration: DUR.plot,
          delay: 140,
          ease: EASE.glide,
        });
        return () => anim.pause();
      }}
    >
      {/* the safe band, then the two thresholds that bound it */}
      <rect x="0" y={yFor(28)} width={VB_W - 34} height={yFor(22) - yFor(28)} fill={GREEN} opacity="0.07" />
      <line x1="0" x2={VB_W - 34} y1={yFor(28)} y2={yFor(28)} stroke={ORANGE} strokeWidth="1" strokeDasharray="3 3" opacity="0.8" />
      <line x1="0" x2={VB_W - 34} y1={yFor(30)} y2={yFor(30)} stroke={RED} strokeWidth="1" strokeDasharray="3 3" opacity="0.8" />
      <text x={VB_W - 30} y={yFor(28) + 3} fontSize="9" fill={ORANGE}>
        28°
      </text>
      <text x={VB_W - 30} y={yFor(30) + 3} fontSize="9" fill={RED}>
        30°
      </text>

      <path
        data-temp=""
        d={path}
        fill="none"
        stroke={GREEN}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ opacity: 0 }}
      />
    </Stage>
  );
}

export const COVERAGE_VISUALS = {
  servers: ServersVisual,
  network: NetworkVisual,
  power: PowerVisual,
  climate: ClimateVisual,
} as const;

export type CoverageVisualKey = keyof typeof COVERAGE_VISUALS;
