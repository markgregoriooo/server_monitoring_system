import { useAuth } from "../../context/AuthContext";
import { roleConfig } from "../../data/users";
import { BRAND } from "../../branding";

// ─── Access denied ────────────────────────────────────────────────────────────
//
// Rendered by ProtectedRoute (App.tsx) INSTEAD of a page the signed-in role is
// not allowed to open. Not a 404 and not a login wall: the person is signed in
// and the page exists — it is simply not theirs. In practice that is IT Staff
// reaching User Management or Alert Rules, the only two admin-only pages.
//
// It was the last screen still on the pre-Grafana palette: `slate-*` text, a
// blue gradient button and `rounded-xl`, all three of which CLAUDE.md rules out
// for new code. Being the one page nobody plans to visit is exactly why it never
// got updated — and exactly why it is worth updating, since it is only ever seen
// at a moment of confusion.
//
// What it now answers, which "Access Denied" alone did not:
//   • WHOSE permissions these are — the role is named, so a shared machine or a
//     forgotten account reads as the cause instead of a bug.
//   • WHAT to do — go back, or ask a named contact. The old copy said "contact
//     your administrator" without saying who that is.
export default function Unauthorized({ onBack }: { onBack?: () => void }) {
  const { user } = useAuth();
  const role = user?.role ? roleConfig[user.role as keyof typeof roleConfig] : undefined;

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      {/* Locked panel, not an emoji. The 🔒 rendered as a colour glyph in the
          middle of a monospace, single-hue UI — the loudest thing on a screen
          whose message is "nothing to do here". */}
      <div
        className="mb-5 flex items-center justify-center"
        style={{
          width: 44,
          height: 44,
          borderRadius: 2,
          background: "var(--gf-panel)",
          border: "1px solid var(--gf-panel-border)",
        }}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--gf-text-muted)"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="4" y="10.5" width="16" height="10" rx="1.5" />
          <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
        </svg>
      </div>

      <h2 className="text-[15px] font-semibold" style={{ color: "var(--gf-text-primary)" }}>
        You don't have access to this page
      </h2>

      <p
        className="mt-2 max-w-sm text-[13px] leading-relaxed"
        style={{ color: "var(--gf-text-muted)" }}
      >
        {role ? (
          <>
            Your account is signed in as{" "}
            <span style={{ color: "var(--gf-text-primary)" }}>{role.label}</span>, and this
            page is restricted to administrators.
          </>
        ) : (
          <>This page is restricted, and your account does not have access to it.</>
        )}
      </p>

      <p className="mt-1.5 max-w-sm text-[12px]" style={{ color: "var(--gf-text-dim)" }}>
        Nothing is wrong — you have simply opened a page outside your role. An administrator
        can change that from User Management.
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <button
          onClick={onBack}
          className="gf-btn inline-flex items-center gap-1.5 text-[13px] font-medium"
          style={{ height: 30, padding: "0 12px", color: "var(--gf-text-primary)" }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          Back to dashboard
        </button>

        {/* Only rendered when there is a real address to offer — a mailto: that
            goes nowhere is worse than no link, and BRAND.supportEmail is
            deliberately allowed to be blank. */}
        {BRAND.supportEmail && (
          <a
            href={`mailto:${BRAND.supportEmail}?subject=${encodeURIComponent(
              "Access request — " + BRAND.name,
            )}`}
            className="gf-btn-quiet inline-flex items-center text-[13px]"
            style={{ height: 30, padding: "0 12px", color: "var(--gf-text-muted)" }}
          >
            Request access
          </a>
        )}
      </div>
    </div>
  );
}
