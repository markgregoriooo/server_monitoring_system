import { useEffect, useRef } from "react";
import { animate, svg, stagger } from "animejs";
import { useInView, prefersReducedMotion, EASE } from "./motion";

/**
 * The architecture, as a diagram data actually moves through.
 *
 * The previous version of this section was a row of boxes with "→" between them,
 * which is a picture of a sentence. Here each connector is a real path and a
 * packet rides it, so the direction, the convergence (three ingest paths into one
 * backend) and the split (live socket to the browser vs. history through the
 * stores) are all visible rather than described.
 *
 * The top arc is the honest bit most diagrams of this shape get wrong: the
 * dashboard does NOT poll the database for live values. The backend broadcasts
 * over Socket.IO the moment a sample lands, and the stores are read for HISTORY.
 * Two different lanes, drawn as two different lanes.
 *
 * SVG on large screens only. Scaled down to a phone the labels would be 4px, so
 * below `lg` the caller renders a stacked list instead.
 */

const ACCENT = "#5794F2";
const GREEN = "#73BF69";

const VB_W = 940;
const VB_H = 250;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub: string;
  tone?: string;
}

const BOXES: Box[] = [
  { x: 6, y: 18, w: 130, h: 52, title: "ESP32", sub: "DHT11 · MQ-2 · IR", tone: GREEN },
  { x: 6, y: 92, w: 130, h: 52, title: "Go agents", sub: "one per server", tone: GREEN },
  { x: 6, y: 166, w: 130, h: 52, title: "Pollers", sub: "SNMP · RouterOS", tone: GREEN },
  { x: 280, y: 79, w: 150, h: 90, title: "Node.js", sub: "validate · alert · broadcast", tone: ACCENT },
  { x: 560, y: 44, w: 130, h: 54, title: "InfluxDB", sub: "time-series" },
  { x: 560, y: 150, w: 130, h: 54, title: "MySQL", sub: "state · alerts" },
  { x: 800, y: 79, w: 134, h: 90, title: "Dashboard", sub: "React · live", tone: ACCENT },
];

/**
 * Connectors, in flow order. `d` is a cubic so the convergence reads as three
 * streams merging rather than three lines meeting a wall.
 */
const LINKS: { id: string; d: string; tone: string; dur: number }[] = [
  { id: "l1", d: "M136,44 C200,44 220,105 280,105", tone: GREEN, dur: 2200 },
  { id: "l2", d: "M136,118 C200,118 220,124 280,124", tone: GREEN, dur: 2000 },
  { id: "l3", d: "M136,192 C200,192 220,143 280,143", tone: GREEN, dur: 2400 },
  { id: "l4", d: "M430,100 C490,100 505,71 560,71", tone: ACCENT, dur: 1900 },
  { id: "l5", d: "M430,148 C490,148 505,177 560,177", tone: ACCENT, dur: 2100 },
  { id: "l6", d: "M690,71 C740,71 755,105 800,105", tone: "var(--gf-text-dim)", dur: 2300 },
  { id: "l7", d: "M690,177 C740,177 755,143 800,143", tone: "var(--gf-text-dim)", dur: 2500 },
  // the live lane — over the top, bypassing the stores entirely
  { id: "l8", d: "M355,79 C420,8 800,8 867,79", tone: ACCENT, dur: 2600 },
];

export default function FlowDiagram() {
  const { ref, inView } = useInView<HTMLDivElement>({ threshold: 0.3 });
  const rootRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    if (!inView || !rootRef.current) return;
    const root = rootRef.current;
    const still = prefersReducedMotion();

    const paths = root.querySelectorAll<SVGPathElement>("[data-link]");
    const cleanups: Array<() => void> = [];

    // Reduced motion: draw every connector, hide the packets. The topology is
    // the information; the travel is the flourish.
    if (still) {
      paths.forEach((p) => {
        p.style.strokeDasharray = "none";
        p.style.strokeDashoffset = "0";
      });
      root.querySelectorAll<SVGCircleElement>("[data-dot]").forEach((d) => {
        d.style.opacity = "0";
      });
      return;
    }

    // 1. The connectors draw themselves, in flow order.
    paths.forEach((p, i) => {
      const len = p.getTotalLength();
      p.style.strokeDasharray = String(len);
      p.style.strokeDashoffset = String(len);
      const a = animate(p, {
        strokeDashoffset: 0,
        duration: 620,
        delay: 180 + i * 90,
        ease: EASE.glide,
      });
      cleanups.push(() => a.pause());
    });

    // 2. Boxes settle in.
    const boxes = root.querySelectorAll<SVGGElement>("[data-box]");
    const boxAnim = animate(boxes, {
      opacity: [0, 1],
      scale: [0.94, 1],
      duration: 520,
      delay: stagger(70),
      ease: EASE.settle,
    });
    cleanups.push(() => boxAnim.pause());

    // 3. Then packets ride each connector, forever.
    //
    // createMotionPath resolves the path into x/y/rotate tracks, so a dot follows
    // the real curve rather than a straight line between its endpoints. Each link
    // gets its own duration so the packets never march in lockstep, which is what
    // makes it read as traffic instead of as a carousel.
    LINKS.forEach((link, i) => {
      const dot = root.querySelector<SVGCircleElement>(`[data-dot="${link.id}"]`);
      const pathEl = root.querySelector<SVGPathElement>(`[data-link="${link.id}"]`);
      if (!dot || !pathEl) return;

      const motion = svg.createMotionPath(pathEl);
      const a = animate(dot, {
        translateX: motion.translateX,
        translateY: motion.translateY,
        opacity: [
          { to: 1, duration: 140 },
          { to: 1, duration: link.dur - 340 },
          { to: 0, duration: 200 },
        ],
        duration: link.dur,
        delay: 900 + i * 160,
        loop: true,
        ease: EASE.linear,
      });
      cleanups.push(() => a.pause());
    });

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
        aria-label="Three ingest paths feed one Node.js backend, which writes to InfluxDB and MySQL and broadcasts live readings straight to the React dashboard."
      >
        {/* connectors first, so boxes sit on top of their endpoints */}
        {LINKS.map((l) => (
          <path
            key={l.id}
            data-link={l.id}
            d={l.d}
            fill="none"
            stroke={l.tone}
            strokeWidth="1.4"
            strokeLinecap="round"
            opacity="0.5"
          />
        ))}

        {LINKS.map((l) => (
          <circle key={l.id} data-dot={l.id} cx="0" cy="0" r="3.2" fill={l.tone} opacity="0" />
        ))}

        {/* label on the live lane — without it the arc is just a decorative swoosh */}
        <text x="611" y="26" fontSize="11" textAnchor="middle" fill="var(--gf-text-dim)" letterSpacing="0.06em">
          live · Socket.IO
        </text>

        {BOXES.map((b) => (
          <g key={b.title} data-box="" style={{ transformOrigin: `${b.x + b.w / 2}px ${b.y + b.h / 2}px` }}>
            <rect
              x={b.x}
              y={b.y}
              width={b.w}
              height={b.h}
              rx="2"
              fill="var(--gf-panel)"
              stroke={b.tone ?? "var(--gf-panel-border)"}
              strokeWidth="1"
            />
            {/* accent edge, the same cue the sidebar's active row uses */}
            {b.tone && <rect x={b.x} y={b.y} width="2" height={b.h} fill={b.tone} />}
            <text
              x={b.x + b.w / 2}
              y={b.y + b.h / 2 - 3}
              fontSize="14.5"
              textAnchor="middle"
              fill="var(--gf-text-primary)"
              fontWeight="600"
            >
              {b.title}
            </text>
            <text
              x={b.x + b.w / 2}
              y={b.y + b.h / 2 + 13}
              fontSize="10.5"
              textAnchor="middle"
              fill="var(--gf-text-dim)"
            >
              {b.sub}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
