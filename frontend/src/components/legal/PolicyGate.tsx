import { useRef, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { api } from "../../api/api";
import { BRAND } from "../../branding";
import PolicyDocument from "../../pages/legal/PolicyDocument";

/**
 * Blocking acceptance gate, shown by AppShell instead of the dashboard when the user
 * has not accepted the current version.
 *
 * Shown after sign-in rather than as a checkbox on the login page: only after sign-in
 * do we know who is accepting, so the acceptance can be recorded with the user,
 * version, time and IP. It cannot be dismissed; the only ways out are accepting or
 * signing out.
 */
export default function PolicyGate() {
  const { user, logout, updateUser } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Enable the button only after the document has been scrolled to the end. Not a
  // security measure, just a basic "read it first" step.
  const [read, setRead] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || read) return;
    // 24px of slack: exact equality misses on fractional-pixel zoom levels.
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 24) setRead(true);
  };

  const accept = async () => {
    setBusy(true);
    setError("");
    const res = await api.acceptPolicy();
    if (res.success && res.data?.policy_version) {
      // Update the cached user so AppShell shows the dashboard, using the version the
      // server recorded.
      updateUser({
        policy_version: res.data.policy_version,
        policy_current: res.data.policy_current,
      });
      return; // unmounting — no need to clear `busy`
    }
    setError(res.error || "Could not record your acceptance. Please try again.");
    setBusy(false);
  };

  return (
    <div
      className="min-h-screen flex flex-col bg-[var(--gf-bg)]"
      style={{ fontFamily: "'JetBrains Mono', monospace" }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="policy-gate-title"
    >
      <div className="flex-1 flex items-center justify-center px-4 py-8">
        <div
          className="w-full max-w-3xl flex flex-col"
          style={{
            background: "var(--gf-panel)",
            border: "1px solid var(--gf-panel-border)",
            borderRadius: 2,
            maxHeight: "calc(100vh - 4rem)",
          }}
        >
          {/* Header */}
          <div className="px-5 sm:px-7 pt-6 pb-5 shrink-0" style={{ borderBottom: "1px solid var(--gf-divider)" }}>
            <p className="text-[11px] tracking-[0.22em] uppercase mb-2.5" style={{ color: "var(--gf-accent-text)" }}>
              Before you continue
            </p>
            <h1 id="policy-gate-title" className="text-[18px] sm:text-[20px] font-semibold" style={{ color: "var(--gf-text-primary)" }}>
              Privacy Notice &amp; Terms of Use
            </h1>
            <p className="text-[12px] leading-relaxed mt-2.5" style={{ color: "var(--gf-text-muted)" }}>
              {BRAND.name} records what you do in this dashboard and keeps a limited amount of
              information about your account. Please read this before using the system.
              {user?.policy_version ? " It has been updated since you last accepted it." : ""}
            </p>
          </div>

          {/* The document — the same component the public /privacy page renders */}
          <div ref={scrollRef} onScroll={onScroll} className="overflow-y-auto px-5 sm:px-7 py-6 flex-1">
            <PolicyDocument />
          </div>

          {/* Actions */}
          <div className="px-5 sm:px-7 py-4 shrink-0" style={{ borderTop: "1px solid var(--gf-divider)" }}>
            {error && (
              <div
                role="alert"
                className="text-[12px] leading-relaxed px-3 py-2.5 mb-3"
                style={{
                  color: "#F2495C",
                  background: "#F2495C14",
                  border: "1px solid #F2495C40",
                  borderRadius: 2,
                }}
              >
                {error}
              </div>
            )}

            <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3">
              <button
                type="button"
                onClick={() => void logout()}
                className="text-[12px] hover:underline text-left"
                style={{ color: "var(--gf-text-dim)" }}
              >
                Decline and sign out
              </button>

              <div className="flex items-center gap-3">
                <span className="text-[11px] hidden sm:block" style={{ color: "var(--gf-text-dim)" }}>
                  {read ? "" : "Scroll to the end to continue"}
                </span>
                <button
                  type="button"
                  onClick={() => void accept()}
                  disabled={busy || !read}
                  className="gf-btn-primary px-5 text-[13px] font-semibold w-full sm:w-auto"
                  style={{ height: 36 }}
                >
                  {busy ? "Recording…" : "I have read and agree"}
                </button>
              </div>
            </div>

            <p className="text-[10px] leading-relaxed mt-3" style={{ color: "var(--gf-text-dim)" }}>
              Your acceptance is recorded with the document version, the date and time, and the
              address you accepted from.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
