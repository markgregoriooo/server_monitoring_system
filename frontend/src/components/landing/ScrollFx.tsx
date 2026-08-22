import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { animate, onScroll, stagger } from "animejs";
import { prefersReducedMotion, EASE } from "./motion";

/**
 * Scroll-LINKED effects, as opposed to the scroll-TRIGGERED entrances in
 * Reveal.tsx.
 *
 * The difference is what made the first pass feel flat. A triggered animation
 * fires once and finishes on its own schedule, so past the first 600ms the page
 * is static again no matter what the reader does — scrolling and not scrolling
 * look identical. A linked animation is driven BY the scroll position, so the
 * page keeps responding for as long as the wheel is moving. One of those feels
 * alive; the other is a slideshow with a fade.
 *
 * anime's `onScroll({ sync: true })` does the linking. `sync` also accepts a
 * number for interpolation, deliberately not used here: scroll events already
 * arrive often enough to look smooth, and adding lag between the wheel and the
 * page is the thing that makes scroll-jacked sites feel broken.
 *
 * All of it is off under prefers-reduced-motion — scroll-linked motion is the
 * most likely thing on the page to make someone ill, so it degrades to nothing
 * moving at all rather than to something moving less.
 */

/* ── Scroll progress ─────────────────────────────────────────────────────────
   A 2px accent bar along the top of the viewport. Small, but it is the one cue
   that tells a reader the page is long and how far in they are — without it a
   long single-column page gives no sense of depth at all. */
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
   Moves its child against the scroll, so foreground and background separate
   instead of sliding as one flat sheet. Keep `distance` small: past about 40px
   it stops reading as depth and starts reading as a bug. */
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
   A heading that assembles word by word.

   The words are split in React rather than by anime's TextSplitter: the splitter
   rewrites the element's innerHTML, which is exactly the DOM React believes it
   owns, and the two disagree the moment anything re-renders. Rendering the spans
   ourselves keeps one owner.

   The whole phrase stays in the accessibility tree as a single label, because a
   screen reader announcing eleven separate one-word fragments is worse than no
   animation at all. */
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
   A hairline that draws itself down the left edge of a section as the section
   passes through the viewport. Cheap, but it is continuous feedback: something
   on screen is always responding to the wheel. */
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
      className="absolute left-0 top-0 bottom-0 hidden lg:block"
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
