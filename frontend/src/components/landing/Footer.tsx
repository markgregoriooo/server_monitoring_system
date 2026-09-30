import { Link } from "react-router";
import { BRAND } from "../../branding";
import CopyableEmail from "./CopyableEmail";

/**
 * The footer: where someone who cannot get in looks for a person to contact. The
 * Support address is a CopyableEmail (a plain mailto does nothing without a mail
 * app). Every contact field is optional (see branding.ts) and left out when blank.
 */

function ColHead({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="text-[11px] tracking-[0.2em] uppercase mb-3"
      style={{ color: "var(--gf-text-dim)" }}
    >
      {children}
    </div>
  );
}

export default function Footer({
  logo,
  onSignIn,
}: {
  /** The brand mark, passed in so the footer and topbar cannot drift apart. */
  logo: React.ReactNode;
  onSignIn: () => void;
}) {
  const year = new Date().getFullYear();

  return (
    <footer style={{ borderTop: "1px solid var(--gf-divider)", background: "var(--gf-panel)" }}>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[1.6fr_1fr_1fr]">
          {/* brand + what this actually is */}
          <div>
            <div className="flex items-center gap-2.5 mb-3.5">
              {logo}
              <div className="leading-tight">
                <div className="text-[14px] font-semibold tracking-wide" style={{ color: "var(--gf-text-primary)" }}>
                  {BRAND.name}
                </div>
                <div className="text-[10px] tracking-[0.22em]" style={{ color: "var(--gf-text-dim)" }}>
                  {BRAND.subtitle}
                </div>
              </div>
            </div>
            <p className="text-[13px] leading-relaxed max-w-sm" style={{ color: "var(--gf-text-muted)" }}>
              Continuous monitoring for the {BRAND.name} server room — servers, network links, power
              and the room itself, with alerts that reach someone before a failure does.
            </p>
            <p className="text-[12px] leading-relaxed mt-3" style={{ color: "var(--gf-text-dim)" }}>
              {BRAND.fullName}
            </p>
          </div>

          {/* contact */}
          <div>
            <ColHead>Contact</ColHead>
            <div className="flex flex-col gap-2 text-[13px]" style={{ color: "var(--gf-text-muted)" }}>
              {BRAND.supportUnit && <div style={{ color: "var(--gf-text-primary)" }}>{BRAND.supportUnit}</div>}

              {BRAND.supportEmail && (
                <CopyableEmail
                  address={BRAND.supportEmail}
                  style={{ color: "var(--gf-accent-text)" }}
                />
              )}

              {BRAND.supportPhone && (
                <a href={`tel:${BRAND.supportPhone.replace(/\s+/g, "")}`} className="hover:underline">
                  {BRAND.supportPhone}
                </a>
              )}

              {BRAND.supportHours && (
                <div className="text-[12px]" style={{ color: "var(--gf-text-dim)" }}>
                  {BRAND.supportHours}
                </div>
              )}

              {(BRAND.addressLine || BRAND.campus) && (
                <address className="not-italic text-[12px] leading-relaxed mt-1" style={{ color: "var(--gf-text-dim)" }}>
                  {BRAND.addressLine && (
                    <>
                      {BRAND.addressLine}
                      <br />
                    </>
                  )}
                  {BRAND.campus}
                </address>
              )}
            </div>
          </div>

          {/* the system itself */}
          <div>
            <ColHead>This system</ColHead>
            <div className="flex flex-col gap-2 text-[13px]" style={{ color: "var(--gf-text-muted)" }}>
              <button
                type="button"
                onClick={onSignIn}
                className="text-left hover:underline"
                style={{ color: "var(--gf-text-muted)" }}
              >
                Sign in
              </button>
              <Link to="/privacy" className="hover:underline" style={{ color: "var(--gf-text-muted)" }}>
                Privacy Notice &amp; Terms
              </Link>
              <span className="text-[12px]" style={{ color: "var(--gf-text-dim)" }}>
                Access is restricted to approved CSPC accounts.
              </span>
              <span className="text-[12px] mt-1" style={{ color: "var(--gf-text-dim)" }}>
                Version {BRAND.version}
              </span>
            </div>
          </div>
        </div>

        {/* bottom bar */}
        <div
          className="mt-10 pt-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          style={{ borderTop: "1px solid var(--gf-divider)" }}
        >
          <span className="text-[12px]" style={{ color: "var(--gf-text-dim)" }}>
            © {year} {BRAND.name}. All rights reserved.
          </span>
          {/* Naming the law is not decoration: it tells a Filipino reader which
              rights the notice they are being offered actually implements. */}
          <span className="text-[12px]" style={{ color: "var(--gf-text-dim)" }}>
            Personal data handled under the Data Privacy Act of 2012 (RA 10173).
          </span>
        </div>
      </div>
    </footer>
  );
}
