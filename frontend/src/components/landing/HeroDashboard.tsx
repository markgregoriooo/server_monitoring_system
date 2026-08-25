import { useEffect, useRef } from "react";
import { animate, utils } from "animejs";
import { useInView, prefersReducedMotion, EASE, DUR } from "./motion";
import { STATUS } from "../../theme/gf";
const { green: GREEN, orange: ORANGE, critical: RED } = STATUS;

/**
 * The hero set-piece: a miniature of the real dashboard, drawn in code.
 *
 * Not a screenshot, for four reasons that all matter on THIS page:
 *   - it animates, and a still image of a chart says nothing a paragraph doesn't;
 *   - it follows the theme toggle sitting directly above it;
 *   - it stays sharp at any size and costs a few KB on a page served before login;
 *   - it contains no real hostnames, IPs or staff, and this page is public.
 *
 * The chart SCROLLS. It plots itself once on arrival, then every couple of
 * seconds a new sample arrives at the right edge and the whole series slides
 * left by exactly one step — the same thing a live Grafana panel does. A chart
 * that draws once and then freezes is a picture of a chart; this is a picture of
 * monitoring.
 *
 * The colours are the product's own: CPU and memory are ServerFocus's exact
 * series hexes, and the status tints are the Status Colors table. Someone who
 * signs in should recognise what they were just looking at.
 *
 * The numbers are SHAPE, not data. They are a bounded random walk seeded from a
 * hand-drawn opening, wired to nothing, so nothing here can go stale or claim
 * something untrue about a live system.
 */

// ServerFocus's series identities: the same hue means the same metric here as there.
const CPU = "#378ADD";
const MEM = "#7F77DD";

const W = 560;
const H = 180;

/**
 * One more point than fits. The extra sample lives just off the right edge; the
 * series slides left by one step to bring it in, then the arrays shift and the
 * transform resets. That is what makes the motion continuous rather than a jump.
 */
const VISIBLE = 44;
const P = VISIBLE + 2;
const STEP_X = W / VISIBLE;
const TICK_MS = 2000;

const xAt = (i: number) => i * STEP_X;
const yAt = (v: number) => H - 8 - (v / 100) * (H - 22);

// Deliberately lumpy openings: real CPU has noise, a spike and a recovery, and a
// clean sine wave is the clearest single tell that a chart is decorative.
const CPU_SEED = [
  38, 41, 36, 44, 39, 47, 43, 52, 46, 44, 58, 71, 66, 54, 49, 45, 42, 48, 44, 51,
  47, 43, 40, 46, 42, 39, 45, 63, 78, 84, 72, 61, 54, 49, 52, 46, 43, 48, 44, 41,
  45, 42, 47, 44, 46, 43,
];
const MEM_SEED = [
  62, 63, 62, 64, 65, 64, 66, 65, 67, 66, 68, 69, 68, 70, 69, 68, 70, 71, 70, 72,
  71, 70, 72, 73, 72, 74, 73, 75, 76, 78, 77, 76, 75, 74, 76, 75, 74, 76, 75, 77,
  76, 75, 77, 76, 75, 76,
];

const linePath = (vals: number[]) =>
  vals.map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");

const areaPath = (vals: number[]) => `${linePath(vals)} L${xAt(P - 1)},${H} L0,${H} Z`;

/** Bounded random walk. Occasionally takes a bigger step, so the line has events. */
const nextValue = (prev: number, min: number, max: number, step: number) => {
  const jump = Math.random() < 0.08 ? 3 : 1;
  return utils.clamp(prev + (Math.random() * 2 - 1) * step * jump, min, max);
};

interface Tile {
  key: "cpu" | "mem" | "room" | "ups";
  label: string;
  to: number;
  suffix: string;
  color: string;
  /** plus/minus range for the idle drift, in display units */
  drift: number;
  decimals?: number;
  /** Hard ceiling for the drift. Without it a 98% battery wanders to 101%. */
  max?: number;
}

const TILES: Tile[] = [
  { key: "cpu", label: "CPU", to: 44, suffix: "%", color: CPU, drift: 3 },
  { key: "mem", label: "MEMORY", to: 76, suffix: "%", color: MEM, drift: 1 },
  { key: "room", label: "ROOM", to: 26.5, suffix: "°C", color: GREEN, drift: 0.3, decimals: 1 },
  { key: "ups", label: "UPS", to: 98, suffix: "%", color: GREEN, drift: 1, max: 100 },
];

const ROWS: { name: string; tone: string; label: string }[] = [
  { name: "web-01", tone: GREEN, label: "ONLINE" },
  { name: "db-01", tone: GREEN, label: "ONLINE" },
  { name: "core-router", tone: GREEN, label: "ONLINE" },
  { name: "ups-main", tone: ORANGE, label: "ON BATT" },
];

/**
 * `compact` drops the DEVICES column and the forecast alert, leaving the four
 * tiles and the chart.
 *
 * On a phone the mock is scaled to ~360px of design width, which puts the device
 * rows at roughly 6px of rendered text and the forecast sub-line under 5px —
 * present, unreadable, and adding height to a first screen that already carries a
 * long institution name, a headline, a paragraph and two calls to action. Cutting
 * them keeps the two parts that still read at that size and still say "this is a
 * monitoring dashboard", which is the mock's entire job here.
 */
export default function HeroDashboard({ compact = false }: { compact?: boolean }) {
  const { ref, inView } = useInView<HTMLDivElement>({ threshold: 0.2 });
  const cpuRef = useRef<SVGPathElement | null>(null);
  const memRef = useRef<SVGPathElement | null>(null);
  const areaRef = useRef<SVGPathElement | null>(null);
  const groupRef = useRef<SVGGElement | null>(null);
  const headRef = useRef<SVGCircleElement | null>(null);
  const tileRefs = useRef<Partial<Record<Tile["key"], HTMLSpanElement | null>>>({});

  useEffect(() => {
    if (!inView) return;

    const still = prefersReducedMotion();
    const fmt = (t: Tile, v: number) => v.toFixed(t.decimals ?? 0) + t.suffix;
    const tileFor = (k: Tile["key"]) => TILES.find((t) => t.key === k);

    const cpu = cpuRef.current;
    const mem = memRef.current;
    const area = areaRef.current;
    const group = groupRef.current;
    const head = headRef.current;

    // Reduced motion: paint the finished state and stop. No draw, no scroll, no
    // drift — but the whole visual is there, which is the point.
    if (still) {
      for (const p of [cpu, mem]) {
        if (p) {
          p.style.strokeDasharray = "none";
          p.style.strokeDashoffset = "0";
          p.style.opacity = "1";
        }
      }
      if (area) area.style.opacity = "1";
      if (head) head.style.opacity = "1";
      TILES.forEach((t) => {
        const n = tileRefs.current[t.key];
        if (n) n.textContent = fmt(t, t.to);
      });
      return;
    }

    const cleanups: Array<() => void> = [];
    let cancelled = false;

    // ── 1. The lines plot themselves, left to right ───────────────────────
    // strokeDashoffset over the measured path length, rather than anime's
    // drawable helper: getTotalLength is exact, and this cannot be thrown off
    // by how the path happens to be constructed.
    [
      { node: cpu, delay: 120 },
      { node: mem, delay: 260 },
    ].forEach(({ node, delay }) => {
      if (!node) return;
      const len = node.getTotalLength();
      node.style.strokeDasharray = String(len);
      node.style.strokeDashoffset = String(len);
      node.style.opacity = "1";
      animate(node, {
        strokeDashoffset: 0,
        duration: DUR.plot,
        delay,
        ease: EASE.glide,
        // The dash pattern has to go before the series starts scrolling —
        // otherwise the next `d` update is measured against the OLD path length
        // and the line renders half drawn.
        onComplete: () => {
          node.style.strokeDasharray = "none";
          node.style.strokeDashoffset = "0";
        },
      });
    });

    if (area) {
      animate(area, {
        opacity: [0, 1],
        duration: DUR.base,
        delay: DUR.plot * 0.55,
        ease: EASE.glide,
      });
    }
    if (head) {
      animate(head, { opacity: [0, 1], duration: DUR.quick, delay: DUR.plot, ease: EASE.settle });
    }

    // ── 2. Tiles count up ─────────────────────────────────────────────────
    // Animating a plain object and writing textContent, rather than driving
    // React state: four tiles at 60fps would be ~240 re-renders a second for
    // digits nothing else depends on.
    TILES.forEach((t, i) => {
      const node = tileRefs.current[t.key];
      if (!node) return;
      const box = { v: 0 };
      animate(box, {
        v: t.to,
        duration: 1000,
        delay: 160 + i * 90,
        ease: EASE.settle,
        onUpdate: () => {
          node.textContent = fmt(t, box.v);
        },
      });
    });

    // ── 3. Then it runs, like a live panel ────────────────────────────────
    // Each tick slides the whole series left by exactly one step while a new
    // sample arrives at the right edge. Self-scheduling from onComplete rather
    // than setInterval: an interval would keep firing if a frame budget slipped
    // and stack overlapping transforms on the same element.
    const cpuVals = [...CPU_SEED];
    const memVals = [...MEM_SEED];

    const tick = () => {
      if (cancelled || !group) return;
      const scroll = animate(group, {
        translateX: [0, -STEP_X],
        duration: TICK_MS,
        ease: EASE.linear,
        onComplete: () => {
          if (cancelled) return;

          cpuVals.push(nextValue(cpuVals[cpuVals.length - 1] ?? 44, 22, 92, 6));
          memVals.push(nextValue(memVals[memVals.length - 1] ?? 76, 66, 86, 1.6));
          cpuVals.shift();
          memVals.shift();

          cpu?.setAttribute("d", linePath(cpuVals));
          mem?.setAttribute("d", linePath(memVals));
          area?.setAttribute("d", areaPath(cpuVals));

          // Snap back so the next slide starts from zero again. The data moved
          // by one step, so the picture is identical and the reset is invisible.
          utils.set(group, { translateX: 0 });

          // The tiles read the newest sample, so the numbers above the chart are
          // the numbers the chart just drew rather than a separate fiction.
          const newestCpu = cpuVals[cpuVals.length - 2];
          const newestMem = memVals[memVals.length - 2];
          const cpuTile = tileFor("cpu");
          const memTile = tileFor("mem");
          if (cpuTile && newestCpu != null && tileRefs.current.cpu) {
            tileRefs.current.cpu.textContent = fmt(cpuTile, newestCpu);
          }
          if (memTile && newestMem != null && tileRefs.current.mem) {
            tileRefs.current.mem.textContent = fmt(memTile, newestMem);
          }
          if (head && newestCpu != null) head.setAttribute("cy", String(yAt(newestCpu)));

          tick();
        },
      });
      cleanups.push(() => scroll.pause());
    };

    const startScroll = window.setTimeout(tick, DUR.plot + 400);
    cleanups.push(() => window.clearTimeout(startScroll));

    // ── 4. The two tiles the chart does not feed ──────────────────────────
    // Small drift only: a hero that visibly rewrites itself pulls the eye off
    // the copy beside it, and this has to survive being on screen for minutes.
    const drift = window.setInterval(() => {
      (["room", "ups"] as const).forEach((key) => {
        const t = tileFor(key);
        const node = tileRefs.current[key];
        if (!t || !node) return;
        const current = parseFloat(node.textContent ?? "") || t.to;
        const next = utils.clamp(
          current + (Math.random() * 2 - 1) * t.drift,
          Math.max(0, t.to - t.drift * 3),
          Math.min(t.max ?? Infinity, t.to + t.drift * 3),
        );
        const box = { v: current };
        animate(box, {
          v: next,
          duration: 900,
          ease: EASE.glide,
          onUpdate: () => {
            node.textContent = fmt(t, box.v);
          },
        });
      });
    }, 3000);
    cleanups.push(() => window.clearInterval(drift));

    // The leading dot breathes: one small "this is live" cue, cheap enough to
    // leave running.
    if (head) {
      const pulse = animate(head, {
        r: [3, 5],
        opacity: [1, 0.45],
        duration: 1500,
        delay: DUR.plot + 200,
        loop: true,
        alternate: true,
        ease: "inOutQuad",
      });
      cleanups.push(() => pulse.pause());
    }

    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
    };
  }, [inView]);

  const headY = yAt(CPU_SEED[VISIBLE] ?? 44);

  return (
    <div ref={ref} style={{ background: "var(--gf-panel)" }}>
      {/* stat tiles */}
      <div className="grid grid-cols-4" style={{ borderBottom: "1px solid var(--gf-divider)" }}>
        {TILES.map((t, i) => (
          <div
            key={t.key}
            className="px-3 py-2.5"
            style={{
              borderRight: i < TILES.length - 1 ? "1px solid var(--gf-divider)" : "none",
            }}
          >
            <div
              className="truncate"
              style={{ fontSize: 8.5, letterSpacing: "0.18em", color: "var(--gf-text-dim)" }}
            >
              {t.label}
            </div>
            <span
              ref={(el) => {
                tileRefs.current[t.key] = el;
              }}
              className="block mt-1 font-semibold tabular-nums"
              style={{ fontSize: 17, color: t.color, lineHeight: 1.1 }}
            >
              {/* First-paint value. The animation overwrites it, but if JS never
                  runs the tile still reads correctly. */}
              {t.to.toFixed(t.decimals ?? 0)}
              {t.suffix}
            </span>
          </div>
        ))}
      </div>

      <div className="grid" style={{ gridTemplateColumns: compact ? "1fr" : "1.55fr 1fr" }}>
        {/* chart */}
        <div
          className="p-3"
          style={{ borderRight: compact ? "none" : "1px solid var(--gf-divider)" }}
        >
          <div className="flex items-center justify-between mb-2">
            <span style={{ fontSize: 9, letterSpacing: "0.14em", color: "var(--gf-text-dim)" }}>
              LAST 6 HOURS
            </span>
            <span className="flex items-center gap-2.5" style={{ fontSize: 8.5 }}>
              <span className="flex items-center gap-1" style={{ color: "var(--gf-text-muted)" }}>
                <i className="block" style={{ width: 7, height: 2, background: CPU }} /> CPU
              </span>
              <span className="flex items-center gap-1" style={{ color: "var(--gf-text-muted)" }}>
                <i className="block" style={{ width: 7, height: 2, background: MEM }} /> MEM
              </span>
            </span>
          </div>

          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="w-full"
            // `hidden`, not `visible`: the incoming sample sits just past the
            // right edge and must be clipped until the slide brings it in.
            style={{ height: 118, display: "block", overflow: "hidden" }}
            aria-hidden="true"
          >
            {/* gridlines at 25/50/75 percent, the axis Grafana would draw. Outside
                the scrolling group, so they stay put while the data moves. */}
            {[0.25, 0.5, 0.75].map((f) => (
              <line
                key={f}
                x1="0"
                x2={W}
                y1={H - 8 - f * (H - 22)}
                y2={H - 8 - f * (H - 22)}
                stroke="var(--gf-divider)"
                strokeWidth="1"
              />
            ))}

            <g ref={groupRef}>
              <path ref={areaRef} d={areaPath(CPU_SEED)} fill={CPU} style={{ opacity: 0 }} />
              <path
                ref={memRef}
                d={linePath(MEM_SEED)}
                fill="none"
                stroke={MEM}
                strokeWidth="1.8"
                strokeLinejoin="round"
                strokeLinecap="round"
                style={{ opacity: 0 }}
              />
              <path
                ref={cpuRef}
                d={linePath(CPU_SEED)}
                fill="none"
                stroke={CPU}
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                style={{ opacity: 0 }}
              />
            </g>

            {/* Pinned at "now" on the right edge, outside the group — the series
                flows underneath it, which is what a live cursor does. */}
            <circle ref={headRef} cx={W} cy={headY} r="3" fill={CPU} style={{ opacity: 0 }} />
          </svg>
        </div>

        {/* device rows + one alert — dropped in compact mode, see the note above */}
        {!compact && (
        <div className="p-3">
          <div style={{ fontSize: 9, letterSpacing: "0.14em", color: "var(--gf-text-dim)" }}>
            DEVICES
          </div>
          <div className="flex flex-col gap-1.5 mt-2">
            {ROWS.map((r) => (
              <div key={r.name} className="flex items-center gap-2">
                <span
                  className="rounded-full shrink-0"
                  style={{ width: 5, height: 5, background: r.tone }}
                />
                <span
                  className="flex-1 min-w-0 truncate"
                  style={{ fontSize: 10, color: "var(--gf-text-primary)" }}
                >
                  {r.name}
                </span>
                <span
                  className="shrink-0"
                  style={{ fontSize: 7.5, letterSpacing: "0.1em", color: r.tone }}
                >
                  {r.label}
                </span>
              </div>
            ))}
          </div>

          <div className="mt-3 pt-2.5" style={{ borderTop: "1px solid var(--gf-divider)" }}>
            <div
              className="flex items-start gap-2 px-2 py-1.5"
              style={{ background: `${RED}14`, border: `1px solid ${RED}40`, borderRadius: 2 }}
            >
              <span
                className="rounded-full shrink-0"
                style={{ width: 5, height: 5, background: RED, marginTop: 3 }}
              />
              <span style={{ fontSize: 9, lineHeight: 1.45, color: "var(--gf-text-primary)" }}>
                Disk projected full in <strong>6 days</strong>
                <span className="block" style={{ color: "var(--gf-text-dim)", fontSize: 8 }}>
                  db-01 · /var · forecast
                </span>
              </span>
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
