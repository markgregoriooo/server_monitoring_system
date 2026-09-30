import type { ReactNode } from "react";
import { useInView, prefersReducedMotion } from "./motion";

/**
 * Scroll-in animation for ordinary content (headings, text, cards). CSS transitions
 * on transform/opacity, which stay smooth even with many on a page; anime.js is only
 * used for the data visuals. `delay` staggers a group (e.g. `delay={i * 70}`); keep it small.
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
