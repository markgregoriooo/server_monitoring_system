import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { animate, onScroll, stagger } from "animejs";
import { prefersReducedMotion, EASE } from "./motion";

/**
 * Scroll-linked effects (driven by the scroll position), as opposed to the one-time
 * entrances in Reveal.tsx. anime's `onScroll({ sync: true })` links them; no extra
 * smoothing, which would add lag behind the wheel. Everything is off under
 * prefers-reduced-motion.
 */

/* ── Scroll progress ─────────────────────────────────────────────────────────
   A 2px accent bar along the top showing how far down the page you are. */
export function ScrollProgress() {
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar || prefersReducedMotion()) return;

    const anim = animate(bar, {
      scaleX: [0, 1],
      ease: EASE.linear,
      autoplay: onScroll({
        target: document.documentElement,
        enter: "top top",
        leave: "bottom bottom",
        sync: true,
      }),
    });

    return () => {
      anim.revert();
    };
  }, []);

  return (
    <div
      aria-hidden="true"
      className="fixed top-0 left-0 right-0 z-[60] pointer-events-none"
      style={{ height: 2 }}
    >
      <div
        ref={barRef}
        style={{
          height: "100%",
          background: "var(--gf-accent)",
          transformOrigin: "0 50%",
          transform: "scaleX(0)",
        }}
      />
    </div>
  );
}

/* ── Parallax ────────────────────────────────────────────────────────────────
   Moves its child against the scroll for a sense of depth. Keep `distance` small
   (under ~40px) or it looks like a bug. */
export function Parallax({
  children,
  distance = 26,
  className = "",
}: {
  children: ReactNode;
  /** total px travelled across the whole pass; negative reverses direction */
  distance?: number;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const inner = innerRef.current;
    if (!host || !inner || prefersReducedMotion()) return;

    const anim = animate(inner, {
      y: [distance / 2, -distance / 2],
      ease: EASE.linear,
      autoplay: onScroll({
        target: host,
        enter: "bottom top",
        leave: "top bottom",
        sync: true,
      }),
    });

    return () => {
      anim.revert();
    };
  }, [distance]);

  return (
    <div ref={hostRef} className={className}>
      <div ref={innerRef} style={{ willChange: "transform" }}>
        {children}
      </div>
    </div>
  );
}

/* ── Split heading ───────────────────────────────────────────────────────────
   A heading that appears word by word. The words are split in React (anime's
   TextSplitter rewrites innerHTML, which React owns). The whole phrase stays one label
   for screen readers. */
export function SplitHeading({
  text,
  className = "",
  style,
  as: Tag = "h2",
  delay = 0,
}: {
  text: string;
  className?: string;
  style?: React.CSSProperties;
  as?: "h1" | "h2" | "h3";
  delay?: number;
}) {
  const hostRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const words = host.querySelectorAll<HTMLElement>("[data-word]");
    if (words.length === 0) return;

    if (prefersReducedMotion()) {
      words.forEach((w) => {
        w.style.opacity = "1";
        w.style.transform = "none";
      });
      return;
    }

    const anim = animate(words, {
      opacity: [0, 1],
      y: [16, 0],
      // Not filter:blur — it forces a repaint of the whole heading on every
      // frame and costs more than the effect is worth on an integrated GPU.
      duration: 760,
      delay: stagger(34, { start: delay }),
      ease: EASE.settle,
      autoplay: onScroll({
        target: host,
        enter: "bottom-=60 top",
        // Fires once. A heading that re-assembles every time it scrolls back
        // past is a page that will not sit still and be read.
        repeat: false,
      }),
    });

    return () => {
      anim.revert();
    };
  }, [text, delay]);

  return (
    <Tag ref={hostRef} className={className} {...(style ? { style } : {})} aria-label={text}>
      {text.split(" ").map((word, i) => (
        <span
          key={`${word}-${i}`}
          data-word=""
          aria-hidden="true"
          style={{ display: "inline-block", opacity: 0, willChange: "transform, opacity" }}
        >
          {word}
          {/* A trailing space inside the span, so the words keep their gaps when
              each one is inline-block. */}
          {i < text.split(" ").length - 1 ? " " : ""}
        </span>
      ))}
    </Tag>
  );
}

/* ── Section rail ────────────────────────────────────────────────────────────
   A thin line that draws down the left edge of a section as it scrolls past. */
export function SectionRail({ tone = "var(--gf-accent)" }: { tone?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const lineRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const line = lineRef.current;
    if (!host || !line || prefersReducedMotion()) return;

    const anim = animate(line, {
      scaleY: [0, 1],
      ease: EASE.linear,
      autoplay: onScroll({
        target: host,
        enter: "bottom-=100 top",
        leave: "top+=100 bottom",
        sync: true,
      }),
    });

    return () => {
      anim.revert();
    };
  }, []);

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className="absolute left-0 top-0 bottom-0 hidden md:block"
      style={{ width: 1, background: "var(--gf-divider)" }}
    >
      <div
        ref={lineRef}
        style={{
          width: "100%",
          height: "100%",
          background: tone,
          transformOrigin: "50% 0",
          transform: "scaleY(0)",
        }}
      />
    </div>
  );
}
