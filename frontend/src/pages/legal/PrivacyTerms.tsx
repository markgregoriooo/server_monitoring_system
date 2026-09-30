import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTheme } from "../../context/ThemeContext";
import { api } from "../../api/api";
import { BRAND } from "../../branding";
import PolicyDocument from "./PolicyDocument";

/**
 * Public /privacy page, reachable without signing in. Registered before the auth
 * redirect in App.tsx.
 */
export default function PrivacyTerms() {
  const { theme, toggleTheme } = useTheme();
  const [version, setVersion] = useState<string>("");

  // The version comes from the backend, so it matches what acceptances record. If the API
  // is unreachable the document still shows, without the version stamp.
  useEffect(() => {
    let alive = true;
    void api.policyVersion().then((r) => {
      if (alive && r.success && r.data?.version) setVersion(r.data.version);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="min-h-screen bg-[var(--gf-bg)]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      <header
        className="sticky top-0 z-50 flex items-center justify-between px-4 sm:px-6"
        style={{ height: 52, background: "var(--gf-header)", borderBottom: "1px solid var(--gf-divider)" }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          {BRAND.logoSrc ? (
            <img src={BRAND.logoSrc} alt="" className="w-7 h-7 object-contain shrink-0" />
          ) : (
            <div
              className="w-7 h-7 flex items-center justify-center font-bold text-[11px] shrink-0"
              style={{ background: "var(--gf-accent)", color: "#fff", borderRadius: 2 }}
            >
              {BRAND.logoText}
            </div>
          )}
          <div className="leading-tight min-w-0">
            <div className="text-[13px] font-semibold tracking-wide truncate" style={{ color: "var(--gf-text-primary)" }}>
              {BRAND.name}
            </div>
            <div className="text-[9px] tracking-[0.22em] truncate" style={{ color: "var(--gf-text-dim)" }}>
              {BRAND.subtitle}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={toggleTheme}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            className="gf-icon-btn flex"
          >
            {theme === "dark" ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <circle cx="7" cy="7" r="3" stroke="currentColor" strokeWidth="1.4" />
                <path
                  d="M7 1v1.5M7 11.5V13M1 7h1.5M11.5 7H13M3.2 3.2l1 1M9.8 9.8l1 1M10.8 3.2l-1 1M4.2 9.8l-1 1"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path d="M12 8.6A5.4 5.4 0 0 1 5.4 2a5.5 5.5 0 1 0 6.6 6.6Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              </svg>
            )}
          </button>
          <Link
            to="/login"
            className="gf-btn flex items-center px-3.5 text-[12px] font-semibold"
            style={{ height: 32, color: "var(--gf-text-primary)" }}
          >
            Back to sign in
          </Link>
        </div>
      </header>

      <main className="px-6 py-12 sm:py-16">
        <div className="max-w-3xl mx-auto">
          <p className="text-[11px] tracking-[0.22em] uppercase mb-3" style={{ color: "var(--gf-accent-text)" }}>
            Data Privacy Act of 2012 (RA 10173)
          </p>
          <h1 className="text-[22px] sm:text-[26px] font-semibold leading-snug" style={{ color: "var(--gf-text-primary)" }}>
            Privacy Notice &amp; Terms of Use
          </h1>
          <p className="text-[12px] mt-3" style={{ color: "var(--gf-text-dim)" }}>
            {version ? `Version ${version}` : "Version —"} · {BRAND.name}
          </p>

          <div className="my-8" style={{ borderTop: "1px solid var(--gf-divider)" }} />

          <PolicyDocument />
        </div>
      </main>

      <footer className="px-6 py-8" style={{ borderTop: "1px solid var(--gf-divider)" }}>
        <div className="max-w-3xl mx-auto text-center text-[11px]" style={{ color: "var(--gf-text-dim)" }}>
          © {new Date().getFullYear()} {BRAND.name}. All rights reserved.
        </div>
      </footer>
    </div>
  );
}
