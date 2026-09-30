import { useCallback } from "react";
import { useScrolled, prefersReducedMotion } from "./motion";

/**
 * "Back to top" button for the landing page. The page is long; the fixed topbar also
 * has Sign in, so this is a small, quiet convenience. It appears once the visitor has
 * scrolled past the fold, not only at the bottom, since people rarely stop reading at
 * the very end.
 */
export default function BackToTop() {
  // 700px is comfortably past the hero on every viewport this page targets, so the
  // button is never competing with the sign-in button it would scroll you back to.
  const show = useScrolled(700);

  const toTop = useCallback(() => {
    // Smooth scroll so the jump is visible; skipped under reduced motion, since a long
    // smooth scroll can cause motion sickness.
    window.scrollTo({
      top: 0,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, []);

  return (
    <button
      type="button"
      onClick={toTop}
      // aria-hidden, tabIndex -1 and pointer-events-none while hidden, so the invisible
      // button cannot be tabbed to or clicked.
      aria-hidden={!show}
      tabIndex={show ? 0 : -1}
      aria-label="Back to top"
      title="Back to top"
      className="fixed z-[60] flex items-center justify-center"
      style={{
        right: 16,
        // Clear of the iOS home indicator / Android gesture bar, which sit over the
        // bottom of the viewport and would otherwise swallow the tap.
        bottom: "calc(16px + env(safe-area-inset-bottom, 0px))",
        width: 40,
        height: 40,
        borderRadius: 2,
        border: "1px solid var(--gf-panel-border)",
        background: "var(--gf-glass)",
        backdropFilter: "blur(14px) saturate(150%)",
        WebkitBackdropFilter: "blur(14px) saturate(150%)",
        color: "var(--gf-text-muted)",
        boxShadow: "0 2px 12px rgba(0,0,0,0.22)",
        opacity: show ? 1 : 0,
        transform: show ? "translateY(0)" : "translateY(8px)",
        pointerEvents: show ? "auto" : "none",
        transition: "opacity .2s ease, transform .2s ease, color .12s ease, border-color .12s ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "var(--gf-text-primary)";
        e.currentTarget.style.borderColor = "var(--gf-accent)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "var(--gf-text-muted)";
        e.currentTarget.style.borderColor = "var(--gf-panel-border)";
      }}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 19V5" />
        <path d="M5 12l7-7 7 7" />
      </svg>
    </button>
  );
}
