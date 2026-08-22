import { useEffect, useRef } from "react";
import { animate } from "animejs";
import { useInView, prefersReducedMotion, EASE, DUR } from "./motion";

/**
 * The forecast: history, then a projection past the last reading to the ceiling
 * it is heading for.
 *
 * This is the one visual on the page that shows something a dashboard alone
 * cannot do, so it gets the clearest telling: the solid line is measured, the
 * dashed line is predicted, the widening wedge is the confidence going soft the
 * further out it reaches, and the marker is the date the regression lands on.
 *
 * The wedge matters. A single confident dashed line to a precise day is the
 * classic way a forecast chart lies; the system itself refuses to publish an ETA
 * at all when the fit is too weak (R² below 0.4 reports "Stable" instead), and
 * the picture should carry the same caution the code does.
 */

const ORANGE = "#FF780A";
const RED = "#E02F44";
const ACCENT = "#5794F2";

const VB_W = 520;
const VB_H = 200;

const PLOT_BOTTOM = 180;
const PLOT_TOP = 20;
const HISTORY_END_X = 300;
const CROSS_X = 455;

/** Disk percentage to y. */
const yFor = (pct: number) => PLOT_BOTTOM - (pct / 100) * (PLOT_BOTTOM - PLOT_TOP);

// 24 samples climbing 52 → 78 percent. Noisy on the way up, because a real volume
// fills in steps — logs rotate, a backup lands, something gets cleaned up.
const HISTORY = [
  52, 53, 52.5, 54, 55, 54.5, 56, 57.5, 57, 59, 60, 61.5, 61, 63, 64.5, 65, 67, 68,
  67.5, 70, 71.5, 73, 76, 78,
];

const HISTORY_PATH = HISTORY.map((v, i) => {
  const x = (i / (HISTORY.length - 1)) * HISTORY_END_X;
  return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${yFor(v).toFixed(1)}`;
}).join(" ");

const PROJECTION_PATH = `M${HISTORY_END_X},${yFor(78).toFixed(1)} L${CROSS_X},${yFor(100).toFixed(1)}`;

// Confidence wedge: tight at the last real reading, wide at the far end.
const WEDGE_PATH = [
  `M${HISTORY_END_X},${yFor(78).toFixed(1)}`,
  `L${VB_W - 40},${yFor(112).toFixed(1)}`,
  `L${VB_W - 40},${yFor(88).toFixed(1)}`,
  "Z",
].join(" ");

export default function ForecastVisual() {
  const { ref, inView } = useInView<HTMLDivElement>({ threshold: 0.3 });
  const rootRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!inView || !rootRef.current) return;
    const root = rootRef.current;
    const still = prefersReducedMotion();

    const history = root.querySelector<SVGPathElement>("[data-history]");
    const projection = root.querySelector<SVGPathElement>("[data-projection]");
    const wedge = root.querySelector<SVGPathElement>("[data-wedge]");
    const marker = root.querySelector<SVGGElement>("[data-marker]");

    const showFinal = () => {
      [history, projection].forEach((p) => {
        if (!p) return;
        p.style.strokeDasharray = p === projection ? "5 4" : "none";
        p.style.strokeDashoffset = "0";
        p.style.opacity = "1";
      });
      if (wedge) wedge.style.opacity = "1";
      if (marker) marker.style.opacity = "1";
    };

    if (still) {
      showFinal();
      return;
    }

    const cleanups: Array<() => void> = [];

    // 1. Measured history plots itself.
    if (history) {
      const len = history.getTotalLength();
      history.style.strokeDasharray = String(len);
      history.style.strokeDashoffset = String(len);
      history.style.opacity = "1";
      const a = animate(history, {
        strokeDashoffset: 0,
        duration: DUR.plot,
        delay: 140,
        ease: EASE.glide,
      });
      cleanups.push(() => a.pause());
    }

    // 2. Uncertainty appears before the prediction it qualifies — the caveat
    //    should not arrive after the claim.
    if (wedge) {
      const a = animate(wedge, {
        opacity: [0, 1],
        duration: DUR.base,
        delay: DUR.plot,
        ease: EASE.glide,
      });
      cleanups.push(() => a.pause());
    }

    // 3. The projection extends past the last real reading.
    //
    // Animating strokeDashoffset on a line that is ITSELF dashed would fight
    // itself, so the dash pattern is applied only once the draw has finished.
    if (projection) {
      const len = projection.getTotalLength();
      projection.style.strokeDasharray = String(len);
      projection.style.strokeDashoffset = String(len);
      projection.style.opacity = "1";
      const a = animate(projection, {
        strokeDashoffset: 0,
        duration: 700,
        delay: DUR.plot + 180,
        ease: EASE.glide,
        onComplete: () => {
          projection.style.strokeDasharray = "5 4";
          projection.style.strokeDashoffset = "0";
        },
      });
      cleanups.push(() => a.pause());
    }

    // 4. The date it lands on.
    if (marker) {
      const a = animate(marker, {
        opacity: [0, 1],
        translateY: [8, 0],
        duration: DUR.quick,
        delay: DUR.plot + 820,
        ease: EASE.settle,
      });
      cleanups.push(() => a.pause());
    }

    return () => cleanups.forEach((fn) => fn());
  }, [inView]);

  return (
    <div ref={ref}>
      <svg
        ref={rootRef}
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="w-full"
        style={{ display: "block", overflow: "visible" }}
        role="img"
        aria-label="A disk usage line measured over thirty days, with a dashed regression projecting it to full in about six days, inside a widening confidence band."
      >
        {/* the critical rule this volume is measured against */}
        <line
          x1="0"
          x2={VB_W - 40}
          y1={yFor(90)}
          y2={yFor(90)}
          stroke={RED}
          strokeWidth="1"
          strokeDasharray="3 3"
          opacity="0.55"
        />
        <text x="0" y={yFor(90) - 5} fontSize="10.5" fill={RED} opacity="0.9">
          critical rule · 90%
        </text>

        {/* where measurement stops and prediction starts */}
        <line
          x1={HISTORY_END_X}
          x2={HISTORY_END_X}
          y1={PLOT_TOP - 6}
          y2={PLOT_BOTTOM}
          stroke="var(--gf-divider)"
          strokeWidth="1"
        />
        <text x={HISTORY_END_X - 6} y={PLOT_BOTTOM + 13} fontSize="10.5" textAnchor="end" fill="var(--gf-text-dim)">
          now
        </text>
        <text x="0" y={PLOT_BOTTOM + 13} fontSize="10.5" fill="var(--gf-text-dim)">
          30 days measured
        </text>

        <path data-wedge="" d={WEDGE_PATH} fill={ORANGE} opacity="0" style={{ opacity: 0 }} />

        <path
          data-history=""
          d={HISTORY_PATH}
          fill="none"
          stroke={ACCENT}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ opacity: 0 }}
        />

        <path
          data-projection=""
          d={PROJECTION_PATH}
          fill="none"
          stroke={ORANGE}
          strokeWidth="2"
          strokeLinecap="round"
          style={{ opacity: 0 }}
        />

        {/* the ETA */}
        <g data-marker="" style={{ opacity: 0 }}>
          <circle cx={CROSS_X} cy={yFor(100)} r="4" fill={ORANGE} />
          <circle cx={CROSS_X} cy={yFor(100)} r="8" fill={ORANGE} opacity="0.22" />
          <text
            x={CROSS_X + 12}
            y={yFor(100) + 1}
            fontSize="13"
            fill="var(--gf-text-primary)"
            fontWeight="600"
          >
            full
          </text>
          <text x={CROSS_X + 12} y={yFor(100) + 13} fontSize="11" fill={ORANGE}>
            ~6 days
          </text>
        </g>
      </svg>
    </div>
  );
}
