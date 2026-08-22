import { useEffect, useRef } from "react";
import { createTimeline } from "animejs";
import { useInView, prefersReducedMotion, useIsNarrow } from "./motion";
import Reveal from "./Reveal";
import { SplitHeading, SectionRail } from "./ScrollFx";
import BrowserFrame from "./BrowserFrame";
import ScaledStage from "./ScaledStage";

/**
 * "See it work" — the alert loop, end to end.
 *
 * Everything above this point on the page is the system describing itself. This
 * is the one section that shows the chain actually closing: a reading rises past
 * a threshold, the node's own siren goes off, the dashboard raises an alert, and
 * an email leaves for whoever is on duty. Four different pieces of the system,
 * one physical cause.
 *
 * Animated rather than filmed. A recording of a real smoke test would be
 * stronger evidence, but it is also a smoke test — not something to stage in a
 * room full of equipment that may be under fire detection — and the sequence
 * itself is what the reader needs to understand. This says what fires, in what
 * order, and how quickly, without claiming to be footage.
 */

const GREEN = "#73BF69";
const ORANGE = "#FF780A";
const RED = "#E02F44";
const ACCENT = "#5794F2";

const W = 520;
const H = 150;

// ppm to y. The MQ-2 range that matters: clean air up to a room full of smoke.
const MAX_PPM = 400;
const yFor = (ppm: number) => H - 14 - (ppm / MAX_PPM) * (H - 30);

const WARN_PPM = 150;
const CRIT_PPM = 300;

// Clean, then a fast rise. Gas does not ramp politely — it arrives.
const GAS = [
  38, 41, 39, 44, 42, 46, 43, 48, 52, 61, 78, 104, 138, 176, 214, 248, 276, 298,
  316, 328, 334, 338, 341, 343,
];

const GAS_PATH = GAS.map((v, i) => {
  const x = (i / (GAS.length - 1)) * W;
  return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${yFor(v).toFixed(1)}`;
}).join(" ");

/** The three claims the chips CANNOT make on their own. Everything else the old
    caption column said was already written across the animation itself. */
const FACTS: { k: string; v: string }[] = [
  {
    k: "Every 3 seconds",
    v: "Both MQ-2 sensors are read continuously. Nothing waits for a poll to come round.",
  },
  {
    k: "The device decides first",
    v: "LED and buzzer fire on the ESP32 itself, against thresholds pushed from the dashboard. No network needed.",
  },
  {
    k: "It reaches you anyway",
    v: "Bell, toast and email go out together — nobody has to be watching the dashboard.",
  },
];

/** The four things that fire, in the order they fire. */
const CHAIN: { id: string; label: string; sub: string; tone: string }[] = [
  { id: "led", label: "LED", sub: "turns red", tone: RED },
  { id: "buzzer", label: "BUZZER", sub: "sounds", tone: RED },
  { id: "toast", label: "DASHBOARD", sub: "alert raised", tone: ORANGE },
  { id: "email", label: "EMAIL", sub: "sent on duty", tone: ACCENT },
];

function AlertChainLoop() {
  const { ref, inView } = useInView<HTMLDivElement>({ threshold: 0.3 });
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!inView) return;
    const root = rootRef.current;
    if (!root) return;

    const line = root.querySelector<SVGPathElement>("[data-gas]");
    const readout = root.querySelector<HTMLElement>("[data-readout]");
    const status = root.querySelector<HTMLElement>("[data-status]");
    const chips = root.querySelectorAll<HTMLElement>("[data-chip]");
    if (!line || !readout || !status) return;

    const len = line.getTotalLength();
    const lastPpm = GAS[GAS.length - 1] ?? 0;

    // Reduced motion: the finished frame — line drawn, everything fired. The
    // sequence is the message, but a static end state still carries it.
    if (prefersReducedMotion()) {
      line.style.strokeDasharray = "none";
      line.style.strokeDashoffset = "0";
      readout.textContent = `${lastPpm} ppm`;
      readout.style.color = RED;
      status.textContent = "CRITICAL";
      status.style.color = RED;
      chips.forEach((c) => {
        c.style.opacity = "1";
      });
      return;
    }

    line.style.strokeDasharray = String(len);
    line.style.strokeDashoffset = String(len);
    chips.forEach((c) => {
      c.style.opacity = "0.28";
    });

    const progress = { v: 0 };
    const tl = createTimeline({ loop: true, defaults: { ease: "linear" } });

    tl
      .set(readout, { opacity: 1 })
      // The reading climbs and the line draws on the same clock, so the number
      // beside the chart is always the number the line is at.
      .add(
        progress,
        {
          v: GAS.length - 1,
          duration: 3400,
          ease: "inQuad",
          onUpdate: () => {
            const ppm = GAS[Math.round(progress.v)] ?? 0;
            readout.textContent = `${ppm} ppm`;
            const tone = ppm >= CRIT_PPM ? RED : ppm >= WARN_PPM ? ORANGE : GREEN;
            readout.style.color = tone;
            status.textContent =
              ppm >= CRIT_PPM ? "CRITICAL" : ppm >= WARN_PPM ? "WARNING" : "NORMAL";
            status.style.color = tone;
          },
        },
        0,
      )
      .add(line, { strokeDashoffset: 0, duration: 3400, ease: "inQuad" }, 0);

    // Each link in the chain lights as the reading reaches the point that would
    // actually trigger it — the LED and buzzer at the device's threshold, the
    // dashboard and the email just after, because they cross the network.
    const chipAt = [2350, 2500, 2900, 3300];
    chips.forEach((chip, i) => {
      tl.add(chip, { opacity: [0.28, 1], scale: [0.96, 1], duration: 300, ease: "outExpo" }, chipAt[i] ?? 0);
    });

    // Hold on the fired state, then reset for the loop.
    tl.add({ hold: 0 }, { hold: 1, duration: 1800 }, 3700);
    tl.add(chips, { opacity: 0.28, duration: 400 }, 5500);
    tl.add(readout, { opacity: 0, duration: 300 }, 5500);

    return () => {
      tl.revert();
    };
  }, [inView]);

  return (
    <div ref={ref} style={{ background: "var(--gf-panel)" }}>
      <div ref={rootRef}>
        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div style={{ fontSize: 9, letterSpacing: "0.16em", color: "var(--gf-text-dim)" }}>
                MQ-2 · COMBUSTIBLE GAS
              </div>
              <span
                data-readout=""
                className="block font-semibold tabular-nums mt-1"
                style={{ fontSize: 22, color: GREEN, lineHeight: 1.1 }}
              >
                38 ppm
              </span>
            </div>
            <span
              data-status=""
              className="px-2 py-1"
              style={{
                fontSize: 9,
                letterSpacing: "0.14em",
                color: GREEN,
                border: "1px solid currentColor",
                borderRadius: 2,
              }}
            >
              NORMAL
            </span>
          </div>

          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="w-full"
            style={{ height: 108, display: "block", overflow: "visible" }}
            aria-hidden="true"
          >
            <line x1="0" x2={W} y1={yFor(WARN_PPM)} y2={yFor(WARN_PPM)} stroke={ORANGE} strokeWidth="1" strokeDasharray="4 4" opacity="0.7" />
            <line x1="0" x2={W} y1={yFor(CRIT_PPM)} y2={yFor(CRIT_PPM)} stroke={RED} strokeWidth="1" strokeDasharray="4 4" opacity="0.7" />
            <text x="2" y={yFor(WARN_PPM) - 4} fontSize="8" fill={ORANGE}>
              warning · {WARN_PPM}
            </text>
            <text x="2" y={yFor(CRIT_PPM) - 4} fontSize="8" fill={RED}>
              critical · {CRIT_PPM}
            </text>
            <path
              data-gas=""
              d={GAS_PATH}
              fill="none"
              stroke={RED}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>

        {/* the chain */}
        <div
          className="grid grid-cols-4"
          style={{ borderTop: "1px solid var(--gf-divider)" }}
        >
          {CHAIN.map((c, i) => (
            <div
              key={c.id}
              data-chip=""
              className="px-2 py-3 text-center"
              style={{
                borderRight: i < CHAIN.length - 1 ? "1px solid var(--gf-divider)" : "none",
                opacity: 0.28,
              }}
            >
              <div
                className="rounded-full mx-auto mb-2"
                style={{ width: 6, height: 6, background: c.tone }}
              />
              <div style={{ fontSize: 8.5, letterSpacing: "0.12em", color: c.tone, fontWeight: 600 }}>
                {c.label}
              </div>
              <div style={{ fontSize: 8, color: "var(--gf-text-dim)", marginTop: 2 }}>{c.sub}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function DemoReel() {
  const narrow = useIsNarrow();

  return (
    <section
      className="relative px-4 sm:px-6 py-16 sm:py-20"
      style={{ borderTop: "1px solid var(--gf-divider)" }}
      id="demo"
    >
      <SectionRail tone={RED} />
      <div className="max-w-7xl mx-auto">
        <div className="mb-8 max-w-2xl">
          <Reveal>
            <p className="text-[12px] tracking-[0.22em] uppercase mb-3" style={{ color: "var(--gf-accent-text)" }}>
              See it work
            </p>
          </Reveal>
          <SplitHeading
            text="Smoke reaches the sensor. Four things happen."
            className="text-[24px] sm:text-[28px] font-semibold leading-snug"
            style={{ color: "var(--gf-text-primary)" }}
          />
          <Reveal delay={120}>
            <p className="text-[14px] leading-relaxed mt-2.5" style={{ color: "var(--gf-text-muted)" }}>
              A dashboard is only worth having if someone finds out when nobody is looking at it.
              This is the whole chain, from a reading crossing a threshold to a phone buzzing —
              a few seconds end to end.
            </p>
          </Reveal>
        </div>

        {/* Stage left, facts right. This is the two-column arrangement again,
            but it works now for a reason the four narrated cards did not: three
            one-line facts stack to roughly the height of the stage, so the two
            columns actually balance instead of leaving a tall ragged text
            column beside a short chart. `items-center` keeps them level if the
            copy ever runs shorter than the mock. */}
        <div className="grid lg:grid-cols-[1.5fr_1fr] gap-6 lg:gap-10 items-center">
          <Reveal y={20}>
            <BrowserFrame>
              <ScaledStage width={narrow ? 360 : 470}>
                <AlertChainLoop />
              </ScaledStage>
            </BrowserFrame>
            <p className="text-[11px] mt-3" style={{ color: "var(--gf-text-dim)" }}>
              Illustrative — the sequence and its order are real, the reading is not a live feed.
            </p>
          </Reveal>

          <div className="flex flex-col gap-5">
            {FACTS.map((f, i) => (
              <Reveal key={f.k} delay={i * 80}>
                <div style={{ borderTop: `2px solid ${RED}`, paddingTop: 12 }}>
                  <h3 className="text-[13.5px] font-semibold" style={{ color: "var(--gf-text-primary)" }}>
                    {f.k}
                  </h3>
                  <p className="text-[12.5px] leading-relaxed mt-1.5" style={{ color: "var(--gf-text-muted)" }}>
                    {f.v}
                  </p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
