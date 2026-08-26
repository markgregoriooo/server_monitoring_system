import { useCallback } from "react";
import { useScrolled, prefersReducedMotion } from "./motion";

/**
 * "Back to top" control for the landing page.
 *
 * The page is long — hero, figures, walkthrough, coverage, demo reel, data flow,
 * analytics, photos, FAQ, footer — and the only way back to the sign-in button at the
 * top was a scroll all the way up. The topbar is fixed and does carry a Sign in button,
 * so this is a convenience rather than the only route back; that is why it is quiet
 * rather than a large accent-coloured FAB.
 *
 * ── Why it appears on SCROLL DEPTH, not at the bottom ──────────────────────────
 * "Show it when they reach the bottom" sounds like the narrower, tidier rule, and it
 * is the wrong one: the moment someone wants to go back up is the moment they stop
 * reading, which is rarely the last pixel of the page. Anyone who has scrolled past
 * the fold is far enough in for the control to be worth having, and it costs one
 * button in a corner.
 */
export default function BackToTop() {
  // 700px is comfortably past the hero on every viewport this page targets, so the
  // button is never competing with the sign-in button it would scroll you back to.
  const show = useScrolled(700);

  const toTop = useCallback(() => {
    // `smooth` on a page this long is a slow ride, but it is the behaviour that makes
    // the jump legible — an instant teleport to the top reads as a page change. The
    // reduced-motion branch is not politeness: a full-page smooth scroll is exactly the
    // kind of large-area movement that triggers vestibular symptoms.
    window.scrollTo({
      top: 0,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, []);

  return (
    <button
      type="button"
      onClick={toTop}
      // aria-hidden + tabIndex -1 while hidden, so the button does not sit in the tab
      // order as an invisible stop. `pointer-events-none` covers the mouse for the
      // same reason — opacity alone would leave a clickable ghost in the corner.
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
