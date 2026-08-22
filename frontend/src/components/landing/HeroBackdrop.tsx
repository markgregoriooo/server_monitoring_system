import { useEffect, useRef } from "react";
import { animate } from "animejs";
import { prefersReducedMotion, EASE } from "./motion";

/**
 * Two telemetry series drifting across the back of the fold.
 *
 * Purely ambient — the numbers are a fixed shape wired to nothing, so this can
 * never go stale or claim something untrue. Its whole job is to say "there are
 * graphs behind this product" underneath the headline, the way Grafana's and
 * Zabbix's own marketing pages do.
 *
 * SEAMLESS LOOP, and that is the only interesting part. The series is drawn
 * TWICE end to end, and the group translates left by exactly one copy's width
 * before snapping back. Because the array's last value equals its first, the
 * join between the two copies is continuous, and the reset lands on a picture
 * identical to the frame before it — so there is no visible jump and no need to
 * shift any data. One transform, running forever, composited on the GPU.
 *
 * ⚠️ Opacity is deliberately tiny. This sits BEHIND the headline and the CTA,
 * and the fold already carries a grid pattern and an accent glow; a third
 * background layer that competes for attention makes the copy harder to read,
 * which is the one thing the hero cannot afford. If it is hard to see, it is
 * working.
 */

const ACCENT = "#5794F2";
const GREEN = "#73BF69";

const W = 1200;
const H = 300;

/**
 * Both series are PERIODIC: the last value repeats the first, which is what lets
 * the doubled copy join without a step. Change a value at either end and you
 * must change the other, or a notch appears once per lap.
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
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      className="absolute inset-x-0 bottom-0 w-full pointer-events-none"
      style={{ height: "62%" }}
    >
      {/* back plane — slower, fainter */}
      <g ref={backRef}>
        <path d={PATH_B} fill="none" stroke={GREEN} strokeWidth="2" opacity="0.16" />
      </g>

      {/* front plane — the one with the fill under it */}
      <g ref={frontRef}>
        <path d={AREA_A} fill={ACCENT} opacity="0.05" />
        <path d={PATH_A} fill="none" stroke={ACCENT} strokeWidth="2" opacity="0.22" />
      </g>
    </svg>
  );
}
