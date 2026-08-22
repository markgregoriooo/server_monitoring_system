/**
 * Shared motion primitives for the landing page.
 *
 * Two layers, on purpose:
 *
 *   - CSS transitions (`Reveal`) carry the bulk of the page — headings, copy,
 *     cards. They cost nothing, cannot fail, and their failure mode is "already
 *     visible", which is the state we want anyway.
 *   - anime.js is reserved for the DATA visuals, where the choreography IS the
 *     message: a line that plots itself left to right, dots that travel the
 *     direction data actually travels, a forecast that extends past the last
 *     reading. Fading a chart in says nothing about the product; drawing it says
 *     what the product does.
 *
 * Everything is gated on prefers-reduced-motion and degrades to the FINAL state,
 * never a blank one. Someone who asked for less motion still gets the whole page.
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
 * Fires once when the element first enters the viewport.
 *
 * `once` is the default because these are entrance animations: re-running them
 * every time a section scrolls back into view turns a page into a slot machine.
 *
 * The observer is skipped entirely when IntersectionObserver is missing (or on a
 * reduced-motion machine), returning `true` immediately — a browser that cannot
 * observe should get the finished page, not an invisible one.
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
 * Easing + duration vocabulary, so twelve components don't each invent their own
 * feel. `outExpo` decelerates hard, which is what makes a value look like it
 * SETTLED rather than stopped — the right curve for anything numeric.
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
 * True on phone-width viewports.
 *
 * Used to pick the DESIGN WIDTH of the mini-UI mocks, not to hide things. A mock
 * laid out for 560px and scaled into a 343px column lands at 0.61, which turns
 * its 9px labels into 5px — legible as a shape, useless as text. Handing the
 * same mock a 360px design box instead means it renders at roughly 1:1 on a
 * phone and stays readable.
 *
 * Matches Tailwind's `sm` breakpoint so the mocks change over at the same width
 * as the layout around them, rather than at some second, invisible boundary.
 */
export function useIsNarrow(breakpoint = 640): boolean {
  const query = `(max-width: ${breakpoint - 0.02}px)`;
  const [narrow, setNarrow] = useState<boolean>(
    () => typeof window !== "undefined" && window.matchMedia?.(query).matches === true,
  );

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    setNarrow(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return narrow;
}

/**
 * True once the page has scrolled past `threshold`.
 *
 * Drives the topbar's two states: floating over the hero at rest, frosted and
 * bordered once content is passing underneath it. rAF-throttled and registered
 * `passive`, because a scroll listener that forces layout on every event is the
 * classic way to make a page feel heavy on a phone.
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
