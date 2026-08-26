import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router";
import { useGoogleLogin } from "@react-oauth/google";
import { useAuth } from "../../context/AuthContext.js";
import { useTheme } from "../../context/ThemeContext";
import { BRAND } from "../../branding";
import Reveal from "../../components/landing/Reveal";
import Counter from "../../components/landing/Counter";
import HeroBackdrop from "../../components/landing/HeroBackdrop";
import Footer from "../../components/landing/Footer";
import FlowDiagram from "../../components/landing/FlowDiagram";
import ForecastVisual from "../../components/landing/ForecastVisual";
import PhotoGallery from "../../components/landing/PhotoGallery";
import DemoReel from "../../components/landing/DemoReel";
import LoginTutorial from "../../components/landing/LoginTutorial";
import Faq from "../../components/landing/Faq";
import BackToTop from "../../components/landing/BackToTop";
import { ScrollProgress, SplitHeading, SectionRail } from "../../components/landing/ScrollFx";
import { useScrolled } from "../../components/landing/motion";
import { COVERAGE_VISUALS, type CoverageVisualKey } from "../../components/landing/CoverageVisuals";
import { STATUS } from "../../theme/gf";
const { green: GREEN, orange: ORANGE, red: RED } = STATUS;

// Topbar height. The fold subtracts it so the hero still fills exactly one screen,
// and the content sections use it as scroll-margin so the sticky bar never covers
// the heading it just scrolled to.
const NAV_H = 60;

// Grafana status colors (match the rest of the dashboard).
const ACCENT = "#5794F2";

// Blue TEXT uses the --gf-accent-text token (see index.css), which darkens in light
// mode because #5794F2 only measures 2.76:1 there. The literal below is the same
// light-mode value, needed only where the colour is string-concatenated into a
// tint/border rather than set as a CSS colour — a var() cannot be sliced like that.
// Keep it in step with --gf-accent-text in index.css.
const ACCENT_TEXT_LIGHT = "#1F62E0";

// Multi-color Google "G" mark for the custom sign-in button.
function GoogleG({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="shrink-0">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

// Square logo mark — topbar, mobile brand block and page footer.
function LogoMark({ size }: { size: number }) {
  return BRAND.logoSrc ? (
    <img src={BRAND.logoSrc} alt="" style={{ width: size, height: size }} className="object-contain shrink-0" />
  ) : (
    <div
      className="flex items-center justify-center font-bold shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.38, background: ACCENT, color: "#fff", borderRadius: 2 }}
    >
      {BRAND.logoText}
    </div>
  );
}

// The strip under the fold. Four figures that are each TRUE and each say something
// a sentence would take a paragraph to say — "0 passwords stored" is the whole
// authentication design in two words.
const FIGURES: { value: number; suffix?: string; label: string; note: string }[] = [
  { value: 4, label: "ingest paths", note: "agents · SNMP · RouterOS · ICMP · sensor" },
  { value: 3, suffix: "s", label: "room sampling", note: "every reading evaluated" },
  { value: 2, label: "data stores", note: "InfluxDB + MySQL" },
  { value: 0, label: "passwords stored", note: "Google Workspace only" },
];

const COVERAGE: {
  visual: CoverageVisualKey;
  color: string;
  title: string;
  body: string;
  meta: string;
}[] = [
  {
    visual: "servers",
    color: GREEN,
    title: "Servers",
    body: "CPU, memory, per-volume disk and uptime from a lightweight agent installed on each host. Disk alerting follows the worst volume, not the root.",
    meta: "Go agent · HTTP push · ~10s",
  },
  {
    visual: "network",
    color: ACCENT,
    title: "Network",
    body: "Per-interface throughput, utilisation and link state across the campus routers and the MikroTik — with ports that were never patched kept deliberately silent. Latency and packet loss are measured by ping alongside every poll, so a link that is up but quietly dropping traffic still shows.",
    meta: "SNMP IF-MIB + RouterOS API + ICMP · pull",
  },
  {
    visual: "power",
    color: ORANGE,
    title: "Power",
    body: "Battery charge, runtime remaining, output load and on-battery events for the room's UPS units, with battery ageing tracked over months.",
    meta: "SNMP UPS-MIB · pull",
  },
  {
    visual: "climate",
    color: RED,
    title: "Server room",
    body: "Temperature, humidity and combustible gas from a custom sensor node — and the air conditioners driven automatically over infrared as the room warms.",
    meta: "ESP32 · Socket.IO push · ~3s",
  },
];

const ANALYTICS_POINTS: { title: string; body: string }[] = [
  {
    title: "Forecasts with a confidence gate",
    body: "Linear regression over weeks of history, validated on a chronological hold-out. When the fit is too weak to trust, it reports Stable rather than inventing a date.",
  },
  {
    title: "Anomaly detection per hour of day",
    body: "A server room at 3 AM and the same room at 2 PM are not the same baseline. Deviation is measured against the hour, not against a flat average.",
  },
  {
    title: "Thresholds it can recommend",
    body: "Observed p95 and p99 compared against the rules currently in force, so an admin can retune an alert from evidence instead of from a guess.",
  },
];

// Section heading. The title assembles word by word on approach (SplitHeading),
// which is what keeps a long page feeling like it is responding to the scroll
// rather than just sliding past — the label and the sub-line still use the plain
// fade, because three staggered animations stacked on one heading is a lot of
// motion for one corner of the screen.
function SectionHead({ label, title, sub }: { label: string; title: string; sub: string }) {
  return (
    <div className="mb-8 max-w-2xl">
      <Reveal>
        <p className="text-[12px] tracking-[0.22em] uppercase mb-3" style={{ color: "var(--gf-accent-text)" }}>
          {label}
        </p>
      </Reveal>
      <SplitHeading
        text={title}
        className="text-[24px] sm:text-[28px] font-semibold leading-snug"
        style={{ color: "var(--gf-text-primary)" }}
      />
      <Reveal delay={120}>
        <p className="text-[14px] leading-relaxed mt-2.5" style={{ color: "var(--gf-text-muted)" }}>
          {sub}
        </p>
      </Reveal>
    </div>
  );
}

// One node in the mobile data-flow strip. Below `lg` the SVG diagram would scale
// its labels down to a few pixels, so small screens get this stacked list instead.
function Chip({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="gf-panel px-4 py-3">
      <div className="text-[13px] font-semibold" style={{ color: "var(--gf-text-primary)" }}>
        {title}
      </div>
      <div className="text-[11px] mt-1 leading-relaxed" style={{ color: "var(--gf-text-dim)" }}>
        {sub}
      </div>
    </div>
  );
}

function DownArrow() {
  return (
    <div className="flex justify-center text-[16.5px]" style={{ color: "var(--gf-text-dim)" }} aria-hidden="true">
      ↓
    </div>
  );
}

// One banner style for the three message kinds (session notice / pending / error).
function Banner({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div
      className="text-[14px] leading-relaxed px-3 py-2.5 mb-4"
      style={{ color, background: `${color}14`, border: `1px solid ${color}40`, borderRadius: 2 }}
    >
      {children}
    </div>
  );
}

// Sun / moon for the theme toggle — the glyph names the theme you'll GET, not the
// one you're in (same convention as the sidebar's toggle).
function ThemeIcon({ theme }: { theme: string }) {
  return theme === "dark" ? (
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
      <path
        d="M12 8.6A5.4 5.4 0 0 1 5.4 2a5.5 5.5 0 1 0 6.6 6.6Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function Login() {
  const { loginWithGoogle } = useAuth();
  const { theme, toggleTheme } = useTheme();
  // Drives the topbar's two states: transparent and floating over the hero at
  // rest, frosted once content starts passing beneath it.
  const scrolled = useScrolled(24);
  // NOTE: `narrow`/`useIsNarrow` and `mockWidth` lived here to size the hero's
  // dashboard mock. The mock is gone and nothing else on this page measured the
  // viewport in JS — the remaining responsive work is all CSS breakpoints — so both
  // were removed rather than left as dead state re-rendering on every resize.
  // Only the info Banner needs this as a literal — it slices the colour to build a
  // tint and a border. Everything else uses the var(--gf-accent-text) token.
  const accentText = theme === "dark" ? ACCENT : ACCENT_TEXT_LIGHT;
  const [error, setError] = useState<string>("");
  const [info, setInfo] = useState<string>(""); // pending / informational
  const [loading, setLoading] = useState<boolean>(false);

  // Shown once when the user was auto-logged-out. Read the flag here (pure — no side
  // effect), then clear it in the effect below.
  //
  // The flag's VALUE says which of the two endings happened, because they are different
  // events to the person reading it: "expired" is the credential running out on its own,
  // "idle" is the system having signed them out on purpose. Telling someone their session
  // expired when they know full well they only stepped away reads as a fault rather than
  // as the policy it is. Any other truthy value falls back to the generic wording, so an
  // older flag left in storage by a previous build still says something sensible.
  const [notice, setNotice] = useState<string>(() => {
    const why = sessionStorage.getItem("cspc_session_expired");
    if (!why) return "";
    return why === "idle"
      ? "You were signed out after a period of inactivity. Please sign in again."
      : "Your session expired. Please sign in again.";
  });

  useEffect(() => {
    // ⚠️ `cspc_session_expired` is deliberately NOT cleared here.
    //
    // It used to be, and that made the notice above disappear on any remount: the message
    // is derived in a useState INITIALISER, so a second mount re-reads a flag this effect
    // has already deleted and comes back with "". The user is then dropped on a bare
    // sign-in form seconds after being told the session ended — which reads as the page
    // having refreshed and lost its place, and is exactly what it was reported as.
    //
    // Nothing needs it cleared here anyway: AuthContext's loginWithGoogle drops it on a
    // successful sign-in (`fresh login — drop any expiry notice`), which is the moment the
    // message stops being true. Until then it SHOULD keep showing — someone who lands back
    // on this page without signing in has not stopped being signed out.
    //
    // The credential wipe below is a different concern and stays: it runs for its own
    // reason, not to tidy up the notice.

    // Reaching the sign-in page means, by definition, that there is no usable
    // session — so any credentials still sitting in storage are dead by definition
    // too. Leaving them there is how a dead token gets a second life: the tab is
    // restored later (Chrome brings sessionStorage back with a restored tab), the
    // app sees a user object, boots into the dashboard on a token that expired
    // hours ago, and bounces right back here. Wiping on arrival makes that loop
    // self-healing rather than something the user has to clear by hand.
    sessionStorage.removeItem("cspc_token");
    sessionStorage.removeItem("cspc_token_at");
    sessionStorage.removeItem("cspc_user");
  }, []);

  const navigate = useNavigate();

  // Exchange the Google auth code for an app session (the backend does the exchange).
  const exchangeToken = async (code?: string) => {
    if (!code) {
      setError("Google did not return a sign-in code. Please try again.");
      setLoading(false);
      return;
    }
    const result = await loginWithGoogle(code);

    if (result.success) {
      navigate("/");
    } else if (result.status === "pending") {
      setInfo(result.error || "Your registration is awaiting administrator approval.");
    } else if (result.status === "rejected") {
      setError("Your access request was declined. Please contact an administrator.");
    } else if (result.status === "disabled") {
      setError("Your account has been disabled. Please contact an administrator.");
    } else {
      setError(result.error || "Sign-in failed. Please try again.");
    }
    setLoading(false);
  };

  // Custom button → authorization-code flow → one-time code (lets us label it "CSPC
  // Mail"; Google's official button only allows its own preset text). The backend
  // swaps the code with Google and verifies the ID token.
  const startLogin = useGoogleLogin({
    flow: "auth-code", // returns a one-time auth code (not a token) — exchanged server-side
    scope: "openid email profile", // permission to read (openid, email, profile = name + photo)
    // NOTE: `prompt: "select_account"` does NOT belong here. It is a field of
    // TokenClientConfig (the implicit flow); the auth-code flow builds a
    // CodeClientConfig, which has no `prompt` — so TypeScript rejects it and
    // Google's initCodeClient would ignore it anyway. Google's equivalent lever for
    // this flow is `select_account: true`, which @react-oauth/google does not yet
    // declare in its types. Verify it in a browser before adding it.
    onSuccess: (resp) => exchangeToken(resp.code),
    onError: () => {
      setLoading(false);
      setError("Google sign-in was cancelled or failed.");
    },
    // Fired when the popup is closed or blocked BEFORE Google returns anything — this is
    // NOT an OAuth error, so `onError` never runs. Without resetting here the button stays
    // stuck on "Signing in…". A plain close (user cancelled) just re-enables the button;
    // a blocked popup gets a hint.
    onNonOAuthError: (err) => {
      setLoading(false);
      if (err.type === "popup_failed_to_open") {
        setError("Couldn't open the Google popup. Please allow popups for this site and try again.");
      }
    },
  });

  const handleClick = () => {
    setError("");
    setInfo("");
    setNotice("");
    setLoading(true);
    startLogin();
  };

  // Google's white button needs its border to exist at all against a light topbar,
  // so it carries one in both themes rather than a theme-conditional.
  const googleButton = (size: "sm" | "lg") => (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      className={`gf-raise flex items-center justify-center gap-2 font-semibold ${
        size === "lg" ? "px-6 text-[15.5px]" : "px-3.5 text-[13px]"
      }`}
      style={{
        height: size === "lg" ? 44 : 32,
        background: "#fff",
        color: "#1f1f1f",
        border: "1px solid rgba(0,0,0,0.16)",
        borderRadius: 2,
      }}
    >
      {loading ? (
        <>
          <span
            aria-hidden="true"
            className="inline-block w-3.5 h-3.5 rounded-full border-2 animate-spin"
            style={{ borderColor: "#1f1f1f", borderTopColor: "transparent" }}
          />
          Signing in…
        </>
      ) : (
        <>
          <GoogleG size={size === "lg" ? 20 : 18} />
          {size === "lg" ? "Sign in with CSPC Mail" : "CSPC Mail"}
        </>
      )}
    </button>
  );

  return (
    <div className="min-h-screen bg-[var(--gf-bg)]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      <ScrollProgress />
      <BackToTop />

      {/* ══ Topbar — sticky, so Sign in stays reachable while reading the page ══ */}
      <header
        className="fixed top-0 inset-x-0 z-50 flex items-center justify-between px-4 sm:px-6"
        style={{
          height: NAV_H,
          // At rest the bar is invisible and the hero runs underneath it. Once
          // anything is scrolling past, it frosts so the content behind cannot
          // collide with the brand and the sign-in button.
          background: scrolled ? "var(--gf-glass)" : "transparent",
          backdropFilter: scrolled ? "blur(14px) saturate(150%)" : "none",
          WebkitBackdropFilter: scrolled ? "blur(14px) saturate(150%)" : "none",
          borderBottom: `1px solid ${scrolled ? "var(--gf-glass-border)" : "transparent"}`,
          boxShadow: scrolled ? "0 1px 12px rgba(0,0,0,0.18)" : "none",
          transition:
            "background-color .28s ease, backdrop-filter .28s ease, border-color .28s ease, box-shadow .28s ease",
        }}
      >
        {/* Brand */}
        <div className="flex items-center gap-3 min-w-0">
          <LogoMark size={36} />
          {/* The wordmark stays at every width — it is what identifies the page. The
              bar cannot carry both this and the Sign in button on a phone, and the
              button is the half that gives way (see its own note below). */}
          <div className="leading-tight min-w-0">
            <div className="text-[17px] font-semibold tracking-wide truncate" style={{ color: "var(--gf-text-primary)" }}>
              {BRAND.name}
            </div>
            <div className="text-[11px] tracking-[0.22em] truncate" style={{ color: "var(--gf-text-dim)" }}>
              {BRAND.subtitle}
            </div>
          </div>
        </div>

        {/* Theme toggle + sign in */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={toggleTheme}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            className="gf-icon-btn flex"
            // Overridden to 32px so it matches the Sign in button beside it —
            // `gf-icon-btn` is 28px, which is right in the dashboard chrome where every
            // neighbour is another icon button, and 4px short here where the neighbour
            // is a 32px-tall text button. Local override rather than editing the class:
            // the sidebar and header use it at 28 and should stay there.
            style={{ width: 32, height: 32 }}
          >
            <ThemeIcon theme={theme} />
          </button>
          {/* Desktop only. On a phone the bar has room for the wordmark or this, not
              both, and this is the one with somewhere else to go: the hero carries a
              full-size Sign in button, and the back-to-top control returns you to it
              from anywhere on the page. Losing the wordmark instead would leave a bare
              logo square identifying nothing. */}
          <span className="hidden sm:block">{googleButton("sm")}</span>
        </div>
      </header>

      {/* ══ The fold ══ */}
      {/* The bar is fixed and overlays this section, so the hero fills the screen
          and pads its own content clear of it — that is what lets the backdrop
          run edge to edge behind a transparent nav.

          The floor applies on phones too. Dropping it there was an overcorrection:
          the earlier "empty space underneath" was the content sitting at the TOP
          with no flex context, which `flex-1 items-center` below fixes on its own.
          With the centring in place the leftover height splits above and below,
          which reads as composition rather than as a gap. */}
      <section
        className="hero-fold relative flex flex-col overflow-hidden"
        style={{ paddingTop: NAV_H }}
      >
        {/* NOTE: a masked 44px Grafana-style grid used to sit here, under the glow.
            Removed — it was drawn to give a mostly-empty fold some texture, and the
            fold is no longer mostly empty. Behind type it competed with the copy
            rather than supporting it. The accent glow and HeroBackdrop's sparklines
            below still carry the depth it was there for. */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ backgroundImage: "radial-gradient(ellipse at 18% 0%, rgba(87,148,242,0.13) 0%, transparent 62%)" }}
        />
        <HeroBackdrop />

        {/* The sign-in messages have no form to live in any more, so they sit at the
            top of the fold — directly under the button that produces them. */}
        {(notice || info || error) && (
          <div className="relative z-10 px-4 sm:px-6 pt-6 flex justify-center" aria-live="polite">
            <div className="w-full max-w-lg">
              {notice && <Banner color={ORANGE}>{notice}</Banner>}
              {info && <Banner color={accentText}>{info}</Banner>}
              {error && <Banner color={RED}>{error}</Banner>}
            </div>
          </div>
        )}

        <div className="relative z-10 flex-1 flex items-center px-4 sm:px-10 lg:px-16 py-14 sm:py-16 lg:py-20">
          {/* Single column since the illustrative dashboard mock was removed, on the same
              `max-w-7xl` as the figures strip and every section below — so the hero lines
              up with the rest of the page instead of sitting in a narrower well of its own.
              Text stays LEFT-aligned: the institution name wraps, and centred ragged lines
              that long are markedly harder to read.
              ⚠️ The heading is allowed the full width, but the BODY copy below is capped
              (`max-w-3xl`). At this container width an uncapped paragraph runs to ~150
              characters a line, which is roughly twice the point where the eye starts
              losing its place on the return sweep. */}
          <div className="max-w-7xl mx-auto w-full">
            <div>
              <Reveal>
                {/* The eyebrow now carries what the SYSTEM is, because the institution
                    name has been promoted into the headline below it. */}
                <p className="text-[11px] tracking-[0.1em] sm:text-[12.5px] sm:tracking-[0.2em] uppercase mb-4 sm:mb-5 leading-relaxed" style={{ color: "var(--gf-accent-text)" }}>
                  {BRAND.tagline}
                </p>
              </Reveal>

              <Reveal delay={80}>
                {/* The institution owns this page, so it is the h1 — the first thing a
                    reader needs is WHOSE system this is, not what it claims to do.
                    ⚠️ The full name is ~82 characters. At this size it runs to three
                    lines on a laptop and would be six on a phone, above the fold, so
                    narrow screens keep the short form. Both are rendered and one hidden
                    by CSS rather than switched in JS: this is above the fold, and a swap
                    that waits for a media-query hook shows the wrong one first. */}
                <h1
                  className="text-[27px] sm:text-[34px] lg:text-[38px] xl:text-[42px] font-semibold leading-[1.15]"
                  style={{ color: "var(--gf-text-primary)" }}
                >
                  <span className="sm:hidden">{BRAND.name} · {BRAND.subtitle}</span>
                  <span className="hidden sm:inline">{BRAND.fullName}</span>
                </h1>
              </Reveal>

              <Reveal delay={120}>
                {/* Demoted from h1 to a supporting line — it is the promise, not the
                    identity. Kept in the accent colour so it still reads as a statement
                    rather than as body copy. */}
                <p
                  className="text-[16px] sm:text-[19px] font-medium leading-snug mt-4 sm:mt-5"
                  style={{ color: "var(--gf-accent-text)" }}
                >
                  Nothing in the server room goes unwatched.
                </p>
              </Reveal>

              <Reveal delay={150}>
                {/* Same idea for the body. The full sentence carries three ideas
                    (what is collected, how it is stored, what it becomes); on a phone
                    the third is the one worth keeping, since it is the reason the
                    system exists. The rest is said again further down the page. */}
                <p className="text-[14px] sm:text-[16.5px] leading-relaxed mt-5 sm:mt-6 max-w-3xl" style={{ color: "var(--gf-text-muted)" }}>
                  <span className="sm:hidden">
                    Servers, network, power and the room itself — turned into alerts that reach
                    someone before a failure does.
                  </span>
                  <span className="hidden sm:inline">
                    Servers, network links, power and the room itself — collected continuously, stored as
                    time-series, and turned into alerts that reach someone before a failure does.
                  </span>
                </p>
              </Reveal>

              <Reveal delay={190}>
                {/* The one thing the sentence above does NOT say, and the only claim on
                    this page that is about the future rather than the present. Kept to a
                    single line: it earns its place by being a real capability
                    (analyticsService — disk, UPS battery and link saturation are each
                    regressed over weeks of history), not by adding length.
                    The phone gets a shortened version rather than nothing. Hiding it
                    outright left the mobile fold visibly empty — the one screen where the
                    copy is shortest — so the fix is fewer words, not fewer ideas. */}
                <p
                  className="text-[14px] sm:text-[16.5px] leading-relaxed mt-4 max-w-3xl"
                  style={{ color: "var(--gf-text-muted)" }}
                >
                  <span className="sm:hidden">
                    It also looks ahead — projecting when a disk fills or a UPS battery stops
                    holding its charge, so the work gets scheduled instead of rushed.
                  </span>
                  <span className="hidden sm:inline">
                    It also looks ahead: weeks of history are regressed to project when a disk
                    fills, a UPS battery stops holding its charge or a link runs out of headroom —
                    so the work gets scheduled instead of rushed.
                  </span>
                </p>
              </Reveal>

              <Reveal delay={215}>
                {/* A compact restatement of scope in the reader's own vocabulary. The
                    prose above says it in sentence form; this is the version someone
                    scanning rather than reading will actually take in, and it costs four
                    words. Each maps to a real ingest path — Go agents, SNMP/RouterOS,
                    UPS-MIB and the ESP32 — which is what the figures strip below counts. */}
                {/* Deliberately NOT flex-wrap: broken across lines this stops reading as
                    one list and turns into four stray labels. It is kept on a single row
                    at every width by shrinking the type and the tracking on phones —
                    "SERVERS · NETWORK · POWER · ROOM" is ~31 characters, which at 12px
                    with 0.14em tracking overruns a 360px screen but fits comfortably at
                    10px/0.1em. */}
                <div
                  className="flex flex-nowrap items-center gap-x-2 sm:gap-x-3 mt-6 text-[10px] sm:text-[12px] tracking-[0.1em] sm:tracking-[0.14em] uppercase"
                  style={{ color: "var(--gf-text-dim)" }}
                >
                  {["Servers", "Network", "Power", "Room"].map((w, i) => (
                    <span key={w} className="flex items-center gap-x-2 sm:gap-x-3 whitespace-nowrap">
                      {i > 0 && <span aria-hidden="true">·</span>}
                      {w}
                    </span>
                  ))}
                </div>
              </Reveal>

              <Reveal delay={240}>
                <div className="mt-7 sm:mt-8 flex flex-wrap items-center gap-3">
                  {googleButton("lg")}
                  <Link
                    to="/privacy"
                    className="text-[13px] hover:underline"
                    style={{ color: "var(--gf-text-muted)" }}
                  >
                    Read the privacy notice
                  </Link>
                </div>
              </Reveal>
            </div>
          </div>
        </div>
      </section>

      {/* ══ Figures strip ══ */}
      <section className="px-4 sm:px-6 py-10" style={{ borderTop: "1px solid var(--gf-divider)", background: "var(--gf-panel)" }}>
        <div className="max-w-7xl mx-auto grid grid-cols-2 lg:grid-cols-4 gap-6">
          {FIGURES.map((f, i) => (
            <Reveal key={f.label} delay={i * 70}>
              <div>
                <Counter
                  to={f.value}
                  {...(f.suffix ? { suffix: f.suffix } : {})}
                  className="block text-[30px] sm:text-[36px] font-semibold leading-none"
                  style={{ color: "var(--gf-text-primary)" }}
                />
                <div className="text-[12.5px] mt-2" style={{ color: "var(--gf-text-muted)" }}>
                  {f.label}
                </div>
                <div className="text-[11px] mt-1" style={{ color: "var(--gf-text-dim)" }}>
                  {f.note}
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ══ The walkthrough ══
          First thing below the fold. It is the strongest asset on the page and
          it used to sit at section 8 of 10, where most readers never reached it.
          Everything after this now reads as detail on something already seen
          rather than as claims to be taken on faith. */}
      <LoginTutorial />

      {/* ══ What it monitors ══ */}
      <section
        id="overview"
        className="relative px-4 sm:px-6 py-16 sm:py-20"
        style={{ borderTop: "1px solid var(--gf-divider)", scrollMarginTop: NAV_H }}
      >
        <SectionRail />
        <div className="max-w-7xl mx-auto">
          <SectionHead
            label="Coverage"
            title="Four things the ICTU server room cannot afford to lose"
            sub="Every panel on the dashboard is fed by live data — no sample sets, no seeded rows. Each stream below is collected on its own schedule and written to time-series storage as it arrives."
          />

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {COVERAGE.map((c, i) => {
              const Visual = COVERAGE_VISUALS[c.visual];
              return (
                <Reveal key={c.title} delay={i * 80}>
                  <div className="gf-panel p-5 flex flex-col h-full">
                    <div className="mb-4">
                      <Visual />
                    </div>
                    <h3 className="text-[15.5px] font-semibold" style={{ color: "var(--gf-text-primary)" }}>
                      {c.title}
                    </h3>
                    <p className="text-[13px] leading-relaxed mt-2 flex-1" style={{ color: "var(--gf-text-muted)" }}>
                      {c.body}
                    </p>
                    <p
                      className="text-[11px] mt-4 pt-3"
                      style={{ color: "var(--gf-text-dim)", borderTop: "1px solid var(--gf-divider)" }}
                    >
                      {c.meta}
                    </p>
                  </div>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      {/* ══ See it work ══ */}
      <DemoReel />

      {/* ══ How the data flows ══ */}
      <section className="px-4 sm:px-6 py-16 sm:py-20" style={{ borderTop: "1px solid var(--gf-divider)" }}>
        <div className="max-w-7xl mx-auto">
          <SectionHead
            label="Architecture"
            title="Three ingest paths, one backend, two stores"
            sub="Sensors and agents push; routers and UPS units are polled — over SNMP, the RouterOS API, and ICMP for the gear we hold no credentials for. Everything converges on a single Node.js service that writes measurements to InfluxDB, state to MySQL, and a mirrored copy to on-site storage that survives a database wipe."
          />

          {/* Diagram from `md` up, stacked list below it.
              The switch is about whether the LABELS survive the scale, not about
              "desktop vs mobile": the SVG is a 940-wide viewBox at `w-full`, and its
              smallest label is 10.5px. In a 768px tablet column (~720px inside the
              section padding) that scales to ~8px — small, but sharp on a tablet
              display. On a 360px phone the same label lands at ~3.6px, which is why
              the fallback exists at all. This used to be gated at `lg`, which handed
              every iPad in portrait the phone layout on a screen with ample room. */}
          <Reveal delay={100}>
            <div className="hidden md:block">
              <FlowDiagram />
            </div>
          </Reveal>

          <div className="md:hidden flex flex-col gap-2">
            <Chip title="ESP32" sub="DHT11 + MQ-2 + IR — push over Socket.IO" />
            <Chip title="Go agents" sub="one per server — push over HTTP" />
            <Chip title="Pollers" sub="SNMP + RouterOS API + ICMP — pull" />
            <DownArrow />
            <Chip title="Node.js + Express" sub="validate · alert · broadcast" />
            <DownArrow />
            <Chip title="InfluxDB" sub="time-series measurements" />
            <Chip title="MySQL" sub="users · devices · alerts" />
            <DownArrow />
            <Chip title="React dashboard" sub="live over Socket.IO" />
          </div>
        </div>
      </section>

      {/* ══ Predictive analytics ══ */}
      <section className="relative px-4 sm:px-6 py-16 sm:py-20" style={{ borderTop: "1px solid var(--gf-divider)" }}>
        <SectionRail />
        <div className="max-w-7xl mx-auto">
          <SectionHead
            label="Analytics"
            title="It does not wait for the threshold to be crossed"
            sub="Dashboards tell you what is happening now, and an alert tells you once it is already a problem. Regression over weeks of stored history turns a slow trend into a date — while there is still time to act on it."
          />

          <div className="grid lg:grid-cols-[1.15fr_1fr] gap-8 lg:gap-12 items-center">
            <Reveal delay={100} y={20}>
              <div className="gf-panel p-5">
                <div className="flex items-center justify-between mb-4">
                  <span className="text-[12px] font-semibold" style={{ color: "var(--gf-text-primary)" }}>
                    db-01 · /var
                  </span>
                  <span
                    className="px-1.5 py-0.5 text-[10px]"
                    style={{
                      color: "var(--gf-accent-text)",
                      border: "1px solid var(--gf-accent)",
                      borderRadius: 2,
                    }}
                  >
                    R² 0.94
                  </span>
                </div>
                <ForecastVisual />

                {/* The ETA repeated as real text. The marker inside the SVG is
                    the nicer presentation, but an SVG label scales with its
                    viewBox and lands around 5px on a phone — the one number a
                    reader must come away with cannot live only in there. */}
                <div
                  className="mt-4 pt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1"
                  style={{ borderTop: "1px solid var(--gf-divider)" }}
                >
                  <span className="text-[14px] font-semibold" style={{ color: ORANGE }}>
                    Projected full in ~6 days
                  </span>
                  <span className="text-[12px]" style={{ color: "var(--gf-text-dim)" }}>
                    fastest-filling volume · 30 days measured
                  </span>
                </div>
              </div>
            </Reveal>

            <div className="flex flex-col gap-5">
              {ANALYTICS_POINTS.map((p, i) => (
                <Reveal key={p.title} delay={160 + i * 80}>
                  <div>
                    <h3 className="text-[15px] font-semibold" style={{ color: "var(--gf-text-primary)" }}>
                      {p.title}
                    </h3>
                    <p className="text-[13px] leading-relaxed mt-2" style={{ color: "var(--gf-text-muted)" }}>
                      {p.body}
                    </p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ══ The hardware, photographed ══ */}
      <PhotoGallery />

      {/* ══ FAQ — also where the Admin / IT Staff role breakdown now lives ══ */}
      <Faq />

      {/* ══ Footer ══ */}
      <Footer logo={<LogoMark size={22} />} onSignIn={handleClick} />
    </div>
  );
}
