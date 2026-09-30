import { useEffect, useRef } from "react";
import { animate, svg, stagger } from "animejs";
import { useInView, prefersReducedMotion, EASE } from "./motion";
import { STATUS } from "../../theme/gf";
const { green: GREEN } = STATUS;

/**
 * The architecture as a diagram with data moving through it: three ingest paths into
 * one backend, then live data over Socket.IO to the browser and history through the
 * databases. The dashboard gets live values from the socket, not by polling the
 * database, so those are drawn as two separate lanes. SVG on large screens only;
 * below `lg` the caller shows a stacked list.
 */

const ACCENT = "#5794F2";

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

// The three source boxes share one width (152). The Pollers label "SNMP · RouterOS ·
// ICMP" needs ~139px at 10.5px monospace. Connectors start at x=166.
const BOXES: Box[] = [
  { x: 6, y: 18, w: 160, h: 52, title: "ESP32", sub: "DHT22 · MQ-2 · IR", tone: GREEN },
  { x: 6, y: 92, w: 160, h: 52, title: "Go agents", sub: "one per server", tone: GREEN },
  // ICMP is not a separate ingest path (it runs in the poller), but it is named because
  // it monitors equipment we have no credentials for.
  { x: 6, y: 166, w: 160, h: 52, title: "Pollers", sub: "SNMP · RouterOS · ICMP", tone: GREEN },
  // 196 wide to fit "validate · alert · broadcast" (~176px). Its right edge is at 476,
  // where l4/l5 start.
  { x: 280, y: 79, w: 196, h: 90, title: "Node.js", sub: "validate · alert · broadcast", tone: ACCENT },
  { x: 560, y: 44, w: 130, h: 54, title: "InfluxDB", sub: "time-series" },
  { x: 560, y: 150, w: 130, h: 54, title: "MySQL", sub: "state · alerts" },
  { x: 800, y: 79, w: 134, h: 90, title: "Dashboard", sub: "React · live", tone: ACCENT },
];

/**
 * Connectors, in flow order. `d` is a cubic so the convergence reads as three
 * streams merging rather than three lines meeting a wall.
 */
const LINKS: { id: string; d: string; tone: string; dur: number }[] = [
  { id: "l1", d: "M166,44 C214,44 228,105 280,105", tone: GREEN, dur: 2200 },
  { id: "l2", d: "M166,118 C214,118 228,124 280,124", tone: GREEN, dur: 2000 },
  { id: "l3", d: "M166,192 C214,192 228,143 280,143", tone: GREEN, dur: 2400 },
  { id: "l4", d: "M476,100 C516,100 528,71 560,71", tone: ACCENT, dur: 1900 },
  { id: "l5", d: "M476,148 C516,148 528,177 560,177", tone: ACCENT, dur: 2100 },
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

    // 3. Then packets ride each connector, forever. createMotionPath makes each dot follow
    // the actual curve, and each link has its own duration so the dots do not move in step.
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
        aria-label="Three ingest paths feed one Node.js backend: sensors and agents push, while routers and UPS units are polled over SNMP, the RouterOS API and ICMP. The backend writes to InfluxDB and MySQL and broadcasts live readings straight to the React dashboard."
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
