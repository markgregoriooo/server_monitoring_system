import type { ReactNode } from "react";
import { useInView, prefersReducedMotion } from "./motion";

/**
 * Scroll-entrance for ordinary content — headings, copy, cards.
 *
 * CSS transitions rather than anime.js: there is nothing to choreograph here, and
 * a transform/opacity pair is composited on the GPU, so a page with forty of them
 * still scrolls at 60fps. anime.js is saved for the data visuals, where the
 * motion carries meaning.
 *
 * `delay` staggers a group (map over children with `delay={i * 70}`). Keep the
 * step small — a stagger you can count is a stagger that is too slow.
 */
export default function Reveal({
  children,
  delay = 0,
  y = 14,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  /** ms, staggered within a group */
  delay?: number;
  /** px travelled on entry; 0 = fade only */
  y?: number;
  className?: string;
  as?: "div" | "section" | "li" | "span";
}) {
  const { ref, inView } = useInView<HTMLDivElement>();
  const still = prefersReducedMotion();

  // Reduced motion still gets the content — it just arrives already in place.
  const shown = inView || still;

  return (
    <Tag
      ref={ref as never}
      className={className}
      style={{
        opacity: shown ? 1 : 0,
        transform: shown ? "none" : `translateY(${y}px)`,
        transition: still
          ? "none"
          : `opacity 620ms cubic-bezier(0.16,1,0.3,1) ${delay}ms, transform 620ms cubic-bezier(0.16,1,0.3,1) ${delay}ms`,
        willChange: shown ? "auto" : "opacity, transform",
      }}
    >
      {children}
    </Tag>
  );
}
