import { useEffect, useRef } from "react";
import { animate } from "animejs";
import { useInView, prefersReducedMotion, EASE } from "./motion";

/**
 * A number that counts up once when it scrolls into view. Writes textContent through
 * a ref instead of React state, to avoid re-rendering at 60fps. The final value is
 * already in the markup, so without JavaScript the correct number shows.
 */
export default function Counter({
  to,
  decimals = 0,
  prefix = "",
  suffix = "",
  duration = 1100,
  className = "",
  style,
}: {
  to: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const { ref, inView } = useInView<HTMLSpanElement>({ threshold: 0.6 });
  const outRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!inView) return;
    const node = outRef.current;
    if (!node) return;

    const final = prefix + to.toFixed(decimals) + suffix;

    if (prefersReducedMotion()) {
      node.textContent = final;
      return;
    }

    const box = { v: 0 };
    const anim = animate(box, {
      v: to,
      duration,
      ease: EASE.settle,
      onUpdate: () => {
        node.textContent = prefix + box.v.toFixed(decimals) + suffix;
      },
      onComplete: () => {
        node.textContent = final;
      },
    });
    // Braced, not `() => anim.pause()`: pause() returns the animation for
    // chaining, and React's EffectCallback destructor must return nothing.
    return () => {
      anim.pause();
    };
  }, [inView, to, decimals, prefix, suffix, duration]);

  return (
    <span
      ref={(el) => {
        ref.current = el;
        outRef.current = el;
      }}
      className={`tabular-nums ${className}`}
      {...(style ? { style } : {})}
    >
      {prefix}
      {to.toFixed(decimals)}
      {suffix}
    </span>
  );
}
