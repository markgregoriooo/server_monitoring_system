/**
 * Shared motion helpers for the landing page.
 *
 *   - CSS transitions (`Reveal`) for most of the page: headings, text, cards.
 *   - anime.js for the data visuals, where the animation shows what the product does
 *     (a line plotting itself, packets moving, a forecast extending).
 *
 * Everything respects prefers-reduced-motion and falls back to the finished state,
 * never a blank one.
 */
import { useEffect, useRef, useState } from "react";

/** Reduced motion is a user setting, not a device class — read it live. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Fires once when the element first enters the viewport. Returns `true` right away
 * when IntersectionObserver is missing or reduced motion is on, so the content shows.
 */
export function useInView<T extends HTMLElement = HTMLDivElement>(
  { threshold = 0.25, rootMargin = "0px 0px -10% 0px", once = true } = {},
) {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState<boolean>(
    () => typeof IntersectionObserver === "undefined",
  );

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            if (once) io.disconnect();
          } else if (!once) {
            setInView(false);
          }
        }
      },
      { threshold, rootMargin },
    );

    io.observe(el);
    return () => io.disconnect();
  }, [threshold, rootMargin, once]);

  return { ref, inView };
}

/**
 * Shared easing and durations. `outExpo` slows down sharply at the end, which suits
 * numbers settling.
 */
export const EASE = {
  settle: "outExpo",
  glide: "outCubic",
  linear: "linear",
} as const;

export const DUR = {
  quick: 340,
  base: 620,
  plot: 1150,
  travel: 2600,
} as const;

/**
 * True on phone-width viewports. Re-exported from `hooks/useIsNarrow` for the landing
 * components that already import it here. Used to pick the mocks' design width: a
 * mock designed for 560px shrunk to 343px has unreadable 5px labels, while a 360px
 * design renders about 1:1. Default 640 matches Tailwind's `sm`.
 */
export { useIsNarrow } from "../../hooks/useIsNarrow";

/**
 * True once the page has scrolled past `threshold`; switches the topbar from
 * transparent to frosted. Throttled with requestAnimationFrame and registered
 * `passive`.
 */
export function useScrolled(threshold = 24): boolean {
  const [scrolled, setScrolled] = useState(
    () => typeof window !== "undefined" && window.scrollY > threshold,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setScrolled(window.scrollY > threshold);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [threshold]);

  return scrolled;
}
