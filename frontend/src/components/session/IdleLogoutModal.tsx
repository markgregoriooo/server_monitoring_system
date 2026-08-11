import { useEffect, useRef } from "react";

const ACCENT = "#5794F2";

/**
 * Shown when the idle timeout has ended the session, in place of dumping the user on
 * a sign-in screen with no explanation — after stepping away for a few minutes, that
 * reads as a crash rather than a policy.
 *
 * The session is ALREADY gone by the time this renders (see beginIdleLogout in
 * AuthContext): token cleared, socket closed. Nothing here keeps it alive, and the
 * only action available finishes the sign-out.
 *
 * The backdrop is opaque and blurred on purpose. An idle timeout exists to protect an
 * unattended screen, so leaving a readable dashboard behind a transparent overlay
 * would defeat the very thing that triggered it.
 */
export default function IdleLogoutModal({ onConfirm }: { onConfirm: () => void }) {
  const okRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    okRef.current?.focus();
    // Enter or Escape both mean "yes, I've read it" — there is no other choice here,
    // so neither key should leave the user stuck on a dialog they can't dismiss.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onConfirm]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: "rgba(9,11,15,0.82)", backdropFilter: "blur(6px)" }}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="idle-title"
      aria-describedby="idle-body"
    >
      <div
        className="w-full max-w-sm"
        style={{
          background: "var(--gf-panel)",
          border: "1px solid var(--gf-panel-border)",
          borderRadius: 2,
          boxShadow: "var(--gf-shadow)",
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        <div className="p-6">
          <div className="flex items-start gap-3.5">
            {/* Info mark — this is a notice, not an error: nothing went wrong. */}
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke={ACCENT}
              strokeWidth="1.6"
              strokeLinecap="round"
              className="shrink-0 mt-0.5"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 11v5" />
              <path d="M12 7.5v.01" />
            </svg>

            <div className="min-w-0">
              <h2
                id="idle-title"
                className="text-[15px] font-semibold leading-snug"
                style={{ color: "var(--gf-text-primary)" }}
              >
                Signed out due to inactivity
              </h2>
              <p
                id="idle-body"
                className="text-[13px] leading-relaxed mt-2"
                style={{ color: "var(--gf-text-muted)" }}
              >
                You were logged out because this tab was left unattended for 15 minutes.
                Sign in again to continue.
              </p>
            </div>
          </div>

          <button
            ref={okRef}
            type="button"
            onClick={onConfirm}
            className="gf-btn-primary w-full mt-6 text-[13px] font-semibold"
            style={{ height: 36 }}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
