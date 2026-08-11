import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router";
import { useGoogleLogin } from "@react-oauth/google";
import { useAuth } from "../../context/AuthContext.js";
import { useTheme } from "../../context/ThemeContext";
import { BRAND } from "../../branding";

// Topbar height. The fold subtracts it so the hero still fills exactly one screen,
// and the content sections use it as scroll-margin so the sticky bar never covers
// the heading it just scrolled to.
const NAV_H = 52;

// Grafana status colors (match the rest of the dashboard).
const GREEN = "#73BF69";
const ORANGE = "#FF780A";
const RED = "#F2495C";
const ACCENT = "#5794F2";

// Blue TEXT uses the --gf-accent-text token (see index.css), which darkens in light
// mode because #5794F2 only measures 2.76:1 there. The literal below is the same
// light-mode value, needed only where the colour is string-concatenated into a
// tint/border rather than set as a CSS colour — a var() cannot be sliced like that.
// Keep it in step with --gf-accent-text in index.css.
const ACCENT_TEXT_LIGHT = "#1F62E0";

// Multi-color Google "G" mark for the custom sign-in button.
function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" className="shrink-0">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

// Square logo mark — hero wordmark, mobile brand block and page footer.
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

// Decorative two-series area chart along the bottom of the hero column — the
// Grafana/Zabbix "there are graphs behind this product" cue. Purely ornamental:
// the numbers are a fixed shape, not data, so nothing here can go stale or lie.
const SERIES_A = [210, 196, 204, 178, 186, 160, 172, 150, 158, 132, 146, 120, 136,
  112, 126, 104, 118, 96, 110, 88, 102, 80, 94, 72, 86];
const SERIES_B = [262, 255, 268, 250, 264, 246, 258, 242, 256, 238, 252, 236, 248,
  232, 246, 230, 244, 228, 240, 226, 238, 224, 236, 222, 234];
const points = (ys: number[]) => ys.map((y, i) => `${i * 50},${y}`).join(" ");

function HeroChart() {
  return (
    <svg
      viewBox="0 0 1200 300"
      preserveAspectRatio="none"
      aria-hidden="true"
      className="absolute inset-x-0 bottom-0 w-full h-[45%] pointer-events-none"
    >
      <polygon points={`${points(SERIES_A)} 1200,300 0,300`} fill={ACCENT} opacity="0.07" />
      <polyline points={points(SERIES_A)} fill="none" stroke={ACCENT} strokeWidth="2" opacity="0.35" />
      <polyline points={points(SERIES_B)} fill="none" stroke={GREEN} strokeWidth="2" opacity="0.22" />
    </svg>
  );
}

// What the system watches — one line per ingest path, matching the three real
// collectors (Go agents, SNMP/MikroTik pollers, the ESP32).
const CAPABILITIES: string[] = [
  "Server CPU, memory & disk from on-host agents",
  "Routers, MikroTik & UPS polled over SNMP",
  "Room temperature, humidity & gas with predictive alerting",
];

// ── Below-the-fold content ──────────────────────────────────────────────────
const ICONS: Record<string, React.ReactNode> = {
  server: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="1" />
      <rect x="3" y="14" width="18" height="6" rx="1" />
      <path d="M7 7h.01M7 17h.01" />
    </>
  ),
  network: (
    <>
      <circle cx="12" cy="5" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
      <path d="M12 7v4M12 11l-5.4 5.4M12 11l5.4 5.4" />
    </>
  ),
  power: (
    <>
      <rect x="2" y="7" width="17" height="10" rx="2" />
      <path d="M22 10v4" />
      <path d="m11 9-2 3h3l-2 3" />
    </>
  ),
  climate: (
    <>
      <path d="M12 3a2 2 0 0 1 2 2v8.5a4 4 0 1 1-4 0V5a2 2 0 0 1 2-2Z" />
      <path d="M12 9v5" />
    </>
  ),
};

const COVERAGE: { icon: string; color: string; title: string; body: string; meta: string }[] = [
  {
    icon: "server",
    color: GREEN,
    title: "Servers",
    body: "CPU, memory, per-volume disk and uptime from a lightweight agent installed on each host.",
    meta: "Go agent · HTTP push · ~10s",
  },
  {
    icon: "network",
    color: ACCENT,
    title: "Network",
    body: "Per-interface throughput, utilisation and link state across the campus routers and the MikroTik.",
    meta: "SNMP IF-MIB + RouterOS API · pull",
  },
  {
    icon: "power",
    color: ORANGE,
    title: "Power",
    body: "Battery charge, runtime remaining, output load and on-battery events for the room's UPS units.",
    meta: "SNMP UPS-MIB · pull",
  },
  {
    icon: "climate",
    color: RED,
    title: "Server room",
    body: "Temperature, humidity and combustible gas, with the air conditioners driven automatically over IR.",
    meta: "ESP32 · Socket.IO push · ~3s",
  },
];

const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: "01",
    title: "Sign in",
    body: "Use your CSPC Google account. There is no separate password for this system to manage or leak.",
  },
  {
    n: "02",
    title: "Get approved",
    body: "A first sign-in creates a pending request. An ICTU administrator reviews it and assigns your role.",
  },
  {
    n: "03",
    title: "Start monitoring",
    body: "Live dashboards, alerts and generated reports open immediately, scoped to the role you were given.",
  },
];

function SectionHead({ label, title, sub }: { label: string; title: string; sub: string }) {
  return (
    <div className="mb-8 max-w-2xl">
      <p className="text-[11px] tracking-[0.22em] uppercase mb-3" style={{ color: "var(--gf-accent-text)" }}>
        {label}
      </p>
      <h2 className="text-[20px] sm:text-[23px] font-semibold leading-snug" style={{ color: "var(--gf-text-primary)" }}>
        {title}
      </h2>
      <p className="text-[13px] leading-relaxed mt-2.5" style={{ color: "var(--gf-text-muted)" }}>
        {sub}
      </p>
    </div>
  );
}

// One node in the data-flow strip.
function Chip({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="gf-panel px-4 py-3 flex-1 lg:min-w-[148px]">
      <div className="text-[12px] font-semibold" style={{ color: "var(--gf-text-primary)" }}>
        {title}
      </div>
      <div className="text-[10px] mt-1 leading-relaxed" style={{ color: "var(--gf-text-dim)" }}>
        {sub}
      </div>
    </div>
  );
}

// Direction changes with the layout: the strip is a row on lg, a stack below it.
function Arrow() {
  return (
    <div className="flex items-center justify-center shrink-0 text-[15px]" style={{ color: "var(--gf-text-dim)" }} aria-hidden="true">
      <span className="hidden lg:block">→</span>
      <span className="lg:hidden">↓</span>
    </div>
  );
}

// One banner style for the three message kinds (session notice / pending / error).
function Banner({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div
      className="text-[13px] leading-relaxed px-3 py-2.5 mb-4"
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
  // Only the info Banner needs this as a literal — it slices the colour to build a
  // tint and a border. Everything else uses the var(--gf-accent-text) token.
  const accentText = theme === "dark" ? ACCENT : ACCENT_TEXT_LIGHT;
  const [error, setError] = useState<string>("");
  const [info, setInfo] = useState<string>(""); // pending / informational
  const [loading, setLoading] = useState<boolean>(false);

  // Shown once when the user was auto-logged-out by an expired/invalid session.
  // Read the flag here (pure — no side effect), then clear it in the effect below.
  const [notice, setNotice] = useState<string>(() =>
    sessionStorage.getItem("cspc_session_expired")
      ? "Your session expired. Please sign in again."
      : "",
  );

  useEffect(() => {
    sessionStorage.removeItem("cspc_session_expired");

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

  return (
    <div className="min-h-screen bg-[var(--gf-bg)]" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      {/* ══ Topbar — sticky, so Sign in stays reachable while reading the page ══ */}
      <header
        className="sticky top-0 z-50 flex items-center justify-between px-4 sm:px-6"
        style={{
          height: NAV_H,
          background: "var(--gf-header)",
          borderBottom: "1px solid var(--gf-divider)",
        }}
      >
        {/* Brand */}
        <div className="flex items-center gap-2.5 min-w-0">
          <LogoMark size={28} />
          <div className="leading-tight min-w-0">
            <div className="text-[13px] font-semibold tracking-wide truncate" style={{ color: "var(--gf-text-primary)" }}>
              {BRAND.name}
            </div>
            <div className="text-[9px] tracking-[0.22em] truncate" style={{ color: "var(--gf-text-dim)" }}>
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
          >
            <ThemeIcon theme={theme} />
          </button>

          {/* Google's white button needs its border to exist at all against a light
              topbar, so it carries one in both themes rather than a theme-conditional. */}
          <button
            type="button"
            onClick={handleClick}
            disabled={loading}
            className="gf-raise flex items-center gap-2 px-3.5 text-[12px] font-semibold"
            style={{
              height: 32,
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
                <GoogleG />
                CSPC Mail
              </>
            )}
          </button>
        </div>
      </header>

      {/* ══ The fold: full-width hero. Sign-in lives in the topbar button. ══ */}
      <section className="relative flex flex-col overflow-hidden" style={{ minHeight: `calc(100vh - ${NAV_H}px)` }}>
        {/* Grafana-style grid, masked to a soft ellipse so it fades at the edges.
            Tokens rather than fixed colors: the hero is the whole fold now, so it
            has to follow the theme toggle sitting right above it. */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage:
              "linear-gradient(var(--gf-divider) 1px, transparent 1px), linear-gradient(90deg, var(--gf-divider) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
            maskImage: "radial-gradient(ellipse at 35% 40%, black 0%, transparent 78%)",
            WebkitMaskImage: "radial-gradient(ellipse at 35% 40%, black 0%, transparent 78%)",
          }}
        />
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ backgroundImage: "radial-gradient(ellipse at 18% 0%, rgba(87,148,242,0.13) 0%, transparent 62%)" }}
        />
        <HeroChart />

        {/* The sign-in messages have no form to live in any more, so they sit at the
            top of the fold — directly under the button that produces them. */}
        {(notice || info || error) && (
          <div className="relative z-10 px-6 pt-6 flex justify-center" aria-live="polite">
            <div className="w-full max-w-lg">
              {notice && <Banner color={ORANGE}>{notice}</Banner>}
              {info && <Banner color={accentText}>{info}</Banner>}
              {error && <Banner color={RED}>{error}</Banner>}
            </div>
          </div>
        )}

        <div className="relative z-10 flex-1 flex items-center px-6 sm:px-10 lg:px-16 py-14">
          <div className="max-w-6xl mx-auto w-full">
            <div className="max-w-2xl">
              <p className="text-[11px] tracking-[0.22em] uppercase mb-4" style={{ color: "var(--gf-accent-text)" }}>
                {BRAND.tagline}
              </p>
              <h1
                className="text-[24px] sm:text-[28px] xl:text-[32px] font-semibold leading-[1.25]"
                style={{ color: "var(--gf-text-primary)" }}
              >
                {BRAND.fullName}
              </h1>

              <ul className="mt-8 space-y-2.5">
                {CAPABILITIES.map((c) => (
                  <li key={c} className="text-[13px] leading-relaxed" style={{ color: "var(--gf-text-muted)" }}>
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ══ What it monitors ══ */}
      <section
        id="overview"
        className="px-6 py-16 sm:py-20"
        style={{ borderTop: "1px solid var(--gf-divider)", scrollMarginTop: NAV_H }}
      >
        <div className="max-w-6xl mx-auto">
          <SectionHead
            label="Coverage"
            title="Four things the ICTU server room cannot afford to lose"
            sub="Every panel on the dashboard is fed by live data — no sample sets, no seeded rows. Each stream below is collected on its own schedule and written to time-series storage as it arrives."
          />

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {COVERAGE.map((c) => (
              <div key={c.title} className="gf-panel p-5 flex flex-col">
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={c.color}
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  {ICONS[c.icon]}
                </svg>
                <h3 className="text-[14px] font-semibold mt-4" style={{ color: "var(--gf-text-primary)" }}>
                  {c.title}
                </h3>
                <p className="text-[12px] leading-relaxed mt-2 flex-1" style={{ color: "var(--gf-text-muted)" }}>
                  {c.body}
                </p>
                <p className="text-[10px] mt-4 pt-3" style={{ color: "var(--gf-text-dim)", borderTop: "1px solid var(--gf-divider)" }}>
                  {c.meta}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══ How the data flows ══ */}
      <section className="px-6 py-16 sm:py-20" style={{ borderTop: "1px solid var(--gf-divider)" }}>
        <div className="max-w-6xl mx-auto">
          <SectionHead
            label="Architecture"
            title="Three ingest paths, one backend, two stores"
            sub="Sensors and agents push; routers and UPS units are polled. Everything converges on a single Node.js service that writes measurements to InfluxDB, state to MySQL, and a mirrored copy to on-site storage that survives a database wipe."
          />

          <div className="flex flex-col lg:flex-row lg:items-center gap-3">
            <div className="flex flex-col gap-2 lg:w-[26%]">
              <Chip title="ESP32" sub="DHT11 + MQ-2 + IR — push over Socket.IO" />
              <Chip title="Go agents" sub="one per server — push over HTTP" />
              <Chip title="Pollers" sub="SNMP + RouterOS API — pull" />
            </div>
            <Arrow />
            <Chip title="Node.js + Express" sub="validate · alert · broadcast" />
            <Arrow />
            <div className="flex flex-col gap-2 lg:w-[22%]">
              <Chip title="InfluxDB" sub="time-series measurements" />
              <Chip title="MySQL" sub="users · devices · alerts" />
            </div>
            <Arrow />
            <Chip title="React dashboard" sub="live over Socket.IO" />
          </div>
        </div>
      </section>

      {/* ══ Getting access ══ */}
      <section className="px-6 py-16 sm:py-20" style={{ borderTop: "1px solid var(--gf-divider)" }}>
        <div className="max-w-6xl mx-auto">
          <SectionHead
            label="Access"
            title="Approved CSPC accounts only"
            sub="There is no public sign-up and no password to steal. Sign-in is delegated to Google Workspace and restricted to @cspc.edu.ph and @my.cspc.edu.ph — and even then, every account still has to be let in by hand."
          />

          <div className="grid gap-4 sm:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.n} className="gf-panel p-5">
                <div className="text-[11px] font-semibold tracking-[0.18em]" style={{ color: "var(--gf-accent-text)" }}>
                  {s.n}
                </div>
                <h3 className="text-[14px] font-semibold mt-3" style={{ color: "var(--gf-text-primary)" }}>
                  {s.title}
                </h3>
                <p className="text-[12px] leading-relaxed mt-2" style={{ color: "var(--gf-text-muted)" }}>
                  {s.body}
                </p>
              </div>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 mt-4">
            <div className="gf-panel p-5">
              <h3 className="text-[13px] font-semibold" style={{ color: "var(--gf-text-primary)" }}>
                Admin
              </h3>
              <p className="text-[12px] leading-relaxed mt-2.5" style={{ color: "var(--gf-text-muted)" }}>
                Everything IT Staff can do, plus the two pages that change how the system itself behaves —
                User Management (approve or reject sign-in requests) and Alert Rules (the thresholds every
                alert is measured against).
              </p>
            </div>
            <div className="gf-panel p-5">
              <h3 className="text-[13px] font-semibold" style={{ color: "var(--gf-text-primary)" }}>
                IT Staff
              </h3>
              <p className="text-[12px] leading-relaxed mt-2.5" style={{ color: "var(--gf-text-muted)" }}>
                Every monitoring page — servers, network, UPS, environment and air conditioning — plus
                acknowledging and resolving alerts, predictive analytics, history and generated reports.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ══ Footer: Grafana's version/link row, Zabbix's copyright line ══ */}
      <footer className="px-6 py-8" style={{ borderTop: "1px solid var(--gf-divider)" }}>
        <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <LogoMark size={22} />
            <span className="text-[11px]" style={{ color: "var(--gf-text-muted)" }}>
              © {new Date().getFullYear()} {BRAND.name}. All rights reserved.
            </span>
          </div>
          <div className="flex items-center flex-wrap justify-center gap-2 text-[11px]" style={{ color: "var(--gf-text-dim)" }}>
            {/* Readable BEFORE signing in — that is the whole point of a notice */}
            <Link to="/privacy" className="hover:underline" style={{ color: "var(--gf-text-muted)" }}>
              Privacy &amp; Terms
            </Link>
            <span aria-hidden="true">·</span>
            {BRAND.supportEmail && (
              <>
                <a href={`mailto:${BRAND.supportEmail}`} className="hover:underline" style={{ color: "var(--gf-text-muted)" }}>
                  Support
                </a>
                <span aria-hidden="true">·</span>
              </>
            )}
            <span>ICTU</span>
            <span aria-hidden="true">·</span>
            <span>{BRAND.version}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
