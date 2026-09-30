import { useEffect, useRef } from "react";
import { animate } from "animejs";
import { prefersReducedMotion, EASE } from "./motion";

/**
 * Background of the first screen, decorative and `aria-hidden`:
 *
 *   1. a dot matrix, fading in from the right
 *   2. two telemetry lines drifting sideways
 *
 * Both sit on the right, away from the left-aligned headline, so nothing crosses
 * the text. The values are fixed shapes connected to nothing. Only transform and
 * opacity animate (cheap on a page that may stay open on a wall display), and all
 * motion stops under `prefers-reduced-motion`.
 */

const W = 1200;
const H = 300;

/**
 * Both series repeat: the last value equals the first so the doubled copy joins
 * seamlessly. Change one end and change the other.
 */
const SERIES_A = [
  55, 48, 52, 44, 58, 41, 47, 62, 50, 44, 57, 71, 60, 49, 54, 43, 51, 66, 78, 63,
  52, 46, 55, 42, 49, 60, 53, 45, 58, 47, 51, 44, 55,
];
const SERIES_B = [
  30, 33, 31, 35, 38, 36, 40, 43, 41, 39, 44, 47, 45, 42, 46, 49, 47, 44, 41, 38,
  40, 37, 34, 36, 33, 31, 34, 32, 29, 31, 28, 29, 30,
];

/** Draw the series twice, so one copy's width can scroll away under the other. */
function doubledPath(values: number[]): string {
  const period = values.length - 1;
  const stepX = W / period;
  const pts: string[] = [];
  for (let i = 0; i <= period * 2; i++) {
    const v = values[i % period] ?? 0;
    const x = i * stepX;
    const y = H - (v / 100) * H;
    pts.push(`${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(" ");
}

const PATH_A = doubledPath(SERIES_A);
const PATH_B = doubledPath(SERIES_B);
const AREA_A = `${PATH_A} L${W * 2},${H} L0,${H} Z`;

export default function HeroBackdrop() {
  const backRef = useRef<SVGGElement | null>(null);
  const frontRef = useRef<SVGGElement | null>(null);

  useEffect(() => {
    if (prefersReducedMotion()) return;

    // Different speeds so the two series separate into planes instead of sliding
    // as one sheet. Both are very slow: this is texture, not an event.
    const anims = [
      { node: backRef.current, ms: 64000 },
      { node: frontRef.current, ms: 41000 },
    ]
      .filter((x): x is { node: SVGGElement; ms: number } => x.node !== null)
      .map(({ node, ms }) =>
        animate(node, {
          translateX: [0, -W],
          duration: ms,
          ease: EASE.linear,
          loop: true,
        }),
      );

    return () => anims.forEach((a) => a.pause());
  }, []);

  return (
    <>
      {/* ── 1. dot matrix ─────────────────────────────────────────────────────
         Dots rather than grid lines, so nothing forms a line through the text. Masked
         horizontally (away from the text) and vertically (away from the topbar). */}
      <div
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: "radial-gradient(var(--gf-text-dim) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
          opacity: 0.22,
          maskImage:
            "linear-gradient(90deg, transparent 38%, black 82%), linear-gradient(180deg, transparent 6%, black 34%, black 74%, transparent 96%)",
          WebkitMaskImage:
            "linear-gradient(90deg, transparent 38%, black 82%), linear-gradient(180deg, transparent 6%, black 34%, black 74%, transparent 96%)",
          maskComposite: "intersect",
          WebkitMaskComposite: "source-in",
        }}
      />

      {/* ── 2. the telemetry series ───────────────────────────────────────── */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 w-full pointer-events-none"
        style={{ height: "62%" }}
      >
        {/* Colours are set through `style`, not the `stroke`/`fill` attributes: SVG attributes
           do not understand `var()` and the path would render black. */}
        {/* back plane — slower, fainter */}
        <g ref={backRef}>
          <path d={PATH_B} fill="none" strokeWidth="2" style={{ stroke: "var(--gf-hero-line-b)" }} />
        </g>

        {/* front plane — the one with the fill under it */}
        <g ref={frontRef}>
          <path d={AREA_A} style={{ fill: "var(--gf-hero-area-a)" }} />
          <path d={PATH_A} fill="none" strokeWidth="2" style={{ stroke: "var(--gf-hero-line-a)" }} />
        </g>
      </svg>
    </>
  );
}
