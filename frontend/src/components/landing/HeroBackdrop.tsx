import { useEffect, useRef } from "react";
import { animate } from "animejs";
import { prefersReducedMotion, EASE } from "./motion";

/**
 * The fold's ambient background. Two layers, both decorative, both `aria-hidden`:
 *
 *   1. a dot matrix, faded in from the right
 *   2. two telemetry series drifting sideways  (the original layer)
 *
 * Two other layers were tried here and removed: a node-and-edge constellation, which
 * against the dot matrix read as a second competing set of dots rather than as a
 * topology, and expanding "ping" rings, which pulled the eye to a corner where nothing
 * was happening. Both are worth NOT re-adding — the fold is a backdrop for a headline
 * and a sign-in button, and every layer past texture costs the copy some attention.
 *
 * Purely ambient — every value here is a fixed shape wired to nothing, so none of it
 * can go stale or claim something untrue. Its whole job is to say "there are graphs
 * behind this product" underneath the headline, the way Grafana's and Zabbix's own
 * marketing pages do.
 *
 * ── EVERYTHING IS WEIGHTED TO THE RIGHT ────────────────────────────────────────
 * The hero copy is a single LEFT-aligned column, so the right of the fold is the empty
 * half — the space the dashboard mock used to occupy. Layers 1 and 2 are masked or
 * placed to live there and fade out before they reach the text (layer 3 spans the full
 * width, but it hugs the bottom edge, well under the copy). That is the whole reason the
 * masked 44px grid that used to sit here was removed: it ran lines straight through
 * the headline. Texture beside the copy reads as depth; texture behind it reads as
 * noise, and the copy is the one thing the hero cannot afford to make harder to read.
 *
 * ── ANIMATION IS COMPOSITED, OR IT DOES NOT ANIMATE ────────────────────────────
 * The one moving layer translates a group — `transform` and `opacity` are the two
 * properties the compositor can handle without re-rasterising, which matters for
 * something that runs forever on a page that can sit open on a wall display.
 *
 * All motion is skipped under `prefers-reduced-motion` — this is a large-area, slow,
 * peripheral movement, which is precisely the kind that triggers vestibular symptoms.
 * The static frame is composed to look deliberate on its own, not like a broken loop.
 */

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
    <>
      {/* ── 1. dot matrix ─────────────────────────────────────────────────────
          Dots, not the grid lines this replaced: a dot never forms a continuous
          rule that can cut through a line of type, so it survives being masked
          close to the copy. Doubly masked — a horizontal ramp keeps it clear of
          the text, a vertical one stops it colliding with the fixed topbar. */}
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
        {/* ⚠️ Colours go through `style`, NOT the `stroke`/`fill` ATTRIBUTES.
            An SVG presentation attribute does not parse `var()` — `stroke="var(--x)"`
            is silently dropped and the path renders black. The CSS property does, so
            the theme token only reaches the shape via style. */}
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
