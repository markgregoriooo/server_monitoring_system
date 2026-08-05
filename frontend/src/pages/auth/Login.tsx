import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { useGoogleLogin } from "@react-oauth/google";
import { useAuth } from "../../context/AuthContext.js";
import { BRAND } from "../../branding";

// Grafana status colors (match the rest of the dashboard).
const ORANGE = "#FF780A";
const RED = "#F2495C";
const ACCENT = "#5794F2";

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

// One banner style for the three message kinds (session notice / pending / error).
function Banner({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div
      className="text-[12px] leading-relaxed px-3 py-2.5 mb-4"
      style={{ color, background: `${color}14`, border: `1px solid ${color}40`, borderRadius: 2 }}
    >
      {children}
    </div>
  );
}

export default function Login() {
  const { loginWithGoogle } = useAuth();
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
    // Always show the account chooser. Without this Google silently reuses the
    // last signed-in account, which on a shared ICTU/lab machine means the second
    // person is handed the first person's identity with no way to switch.
    prompt: "select_account",
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
    <div
      className="min-h-screen flex flex-col items-center justify-center p-4 relative"
      style={{ background: "var(--gf-bg)", fontFamily: "'JetBrains Mono', monospace" }}
    >
      {/* Faint Grafana-style grid + a subtle accent glow for depth */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            "linear-gradient(var(--gf-divider) 1px, transparent 1px), linear-gradient(90deg, var(--gf-divider) 1px, transparent 1px)",
          backgroundSize: "44px 44px",
          opacity: 0.5,
          maskImage: "radial-gradient(ellipse at center, black 0%, transparent 75%)",
          WebkitMaskImage: "radial-gradient(ellipse at center, black 0%, transparent 75%)",
        }}
      />
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ backgroundImage: "radial-gradient(ellipse at 50% 0%, rgba(87,148,242,0.10) 0%, transparent 55%)" }}
      />

      <div className="w-full max-w-sm relative z-10">
        {/* Brand */}
        <div className="flex flex-col items-center mb-5 sm:mb-6">
          {BRAND.logoSrc ? (
            <img src={BRAND.logoSrc} alt={BRAND.name} className="w-14 h-14 sm:w-16 sm:h-16 object-contain mb-3 sm:mb-4" />
          ) : (
            <div
              className="w-12 h-12 sm:w-14 sm:h-14 flex items-center justify-center font-bold text-base sm:text-lg mb-3 sm:mb-4"
              style={{ background: "var(--gf-accent)", color: "#fff", borderRadius: 2 }}
            >
              {BRAND.logoText}
            </div>
          )}

          <h1
            className="text-[13px] sm:text-[15px] font-semibold text-center leading-snug px-2"
            style={{ color: "var(--gf-text-primary)" }}
          >
            {BRAND.fullName}
          </h1>
          <p
            className="text-[9px] sm:text-[10px] tracking-[0.18em] mt-2 text-center uppercase px-2"
            style={{ color: "var(--gf-text-dim)" }}
          >
            {BRAND.tagline}
          </p>
        </div>

        {/* Panel */}
        <div style={{ background: "var(--gf-panel)", border: "1px solid var(--gf-panel-border)", borderRadius: 2 }}>
          {/* Panel header strip (Grafana panel chrome) */}
          <div className="px-4 flex items-center" style={{ height: 36, borderBottom: "1px solid var(--gf-divider)" }}>
            <span className="text-[11px] font-medium tracking-widest uppercase" style={{ color: "var(--gf-text-muted)" }}>
              Sign In
            </span>
          </div>

          <div className="p-5 sm:p-6">
            <p className="text-[12px] mb-5" style={{ color: "var(--gf-text-muted)" }}>
              Sign in with your CSPC GSUITE account to access the dashboard.
            </p>

            {notice && <Banner color={ORANGE}>{notice}</Banner>}
            {info && <Banner color={ACCENT}>{info}</Banner>}
            {error && <Banner color={RED}>{error}</Banner>}

            {/* Custom "CSPC Mail" sign-in button */}
            <button
              type="button"
              onClick={handleClick}
              disabled={loading}
              className="w-full flex items-center justify-center gap-2.5 text-[13px] font-semibold transition-opacity hover:opacity-90 active:scale-[0.99] disabled:opacity-60 disabled:cursor-not-allowed"
              style={{ height: 42, background: "#fff", color: "#1f1f1f", borderRadius: 2 }}
            >
              {loading ? (
                <>
                  <span
                    className="inline-block w-4 h-4 rounded-full border-2 animate-spin"
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

            <p className="text-[10px] text-center leading-relaxed mt-3" style={{ color: "var(--gf-text-dim)" }}>
              CSPC accounts only — <span style={{ color: "var(--gf-text-muted)" }}>@cspc.edu.ph</span> /{" "}
              <span style={{ color: "var(--gf-text-muted)" }}>@my.cspc.edu.ph</span>
            </p>
          </div>
        </div>

        <p className="text-center text-[10px] mt-4" style={{ color: "var(--gf-text-dim)" }}>
          {BRAND.name} · ICTU · v1.0.0
        </p>
      </div>
    </div>
  );
}
