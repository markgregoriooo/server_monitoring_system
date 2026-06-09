import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../../context/AuthContext.js";
import { BRAND } from "../../branding";

interface LoginResult {
  success: boolean;
  error?: string;
}

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [showPass, setShowPass] = useState<boolean>(false);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);

  // Shown once when the user was auto-logged-out by an expired/invalid session.
  // Read the flag here (pure — no side effect), then clear it in the effect below.
  // Removing it inside this initializer would break under React StrictMode, which
  // double-invokes initializers in dev and would wipe the flag before it shows.
  const [notice, setNotice] = useState<string>(() =>
    sessionStorage.getItem("cspc_session_expired")
      ? "Your session expired. Please sign in again."
      : "",
  );

  useEffect(() => {
    sessionStorage.removeItem("cspc_session_expired");
  }, []);

  const navigate = useNavigate();

  const handleSubmit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError("");
    setNotice("");

    if (!email || !password) {
      setError("Please enter both email and password.");
      return;
    }

    setLoading(true);

    await new Promise((r) => setTimeout(r, 700));

    const result: LoginResult = await login(email, password);

    if (!result.success) {
      setError(result.error || "Login failed");
    } else {
      navigate("/");
    }

    setLoading(false);
  };

  return (
    <div
      className="min-h-screen bg-[#080f1e] flex flex-col items-center justify-center p-4"
      style={{
        backgroundImage:
          "radial-gradient(ellipse at 20% 20%, rgba(13,59,142,0.25) 0%, transparent 55%), radial-gradient(ellipse at 80% 80%, rgba(245,196,0,0.06) 0%, transparent 50%)",
      }}
    >
      <div
        className="fixed inset-0 pointer-events-none opacity-[0.03]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }}
      />

      <div className="w-full max-w-md relative z-10">
        <div className="flex flex-col items-center mb-8">
          {BRAND.logoSrc ? (
            <img
              src={BRAND.logoSrc}
              alt={BRAND.name}
              className="w-20 h-20 rounded-full object-contain mb-5 shadow-[0_0_40px_rgba(245,196,0,0.25)]"
            />
          ) : (
            <div
              className="w-20 h-20 rounded-full bg-gradient-to-br from-[#f5c400] to-[#d4a800]
              flex items-center justify-center font-black text-base text-[#080f1e]
              shadow-[0_0_40px_rgba(245,196,0,0.4)] mb-5 border-2 border-[#f5c400]/30"
            >
              {BRAND.logoText}
            </div>
          )}

          <h1 className="font-bold text-white tracking-tight text-center leading-snug flex flex-col items-center">
            <span className="text-lg sm:text-xl">Camarines Sur Polytechnic Colleges</span>
            <span className="text-sm sm:text-base text-white/90">Information and Communications</span>
            <span className="text-xs sm:text-sm text-white/80">Technology Unit</span>
          </h1>

          <p className="text-[10px] text-[#f5c400]/60 font-mono tracking-[0.2em] mt-3 text-center">
            {BRAND.tagline}
          </p>
        </div>

        <div
          className="rounded-2xl border border-white/[0.09] p-6 sm:p-8"
          style={{ background: "rgba(255,255,255,0.035)", backdropFilter: "blur(12px)" }}
        >
          <h2 className="text-xl font-bold text-white mb-1">Sign In</h2>
          <p className="text-xs text-slate-400 mb-6">
            Enter your credentials to access the dashboard.
          </p>

          {notice && (
            <div className="flex items-center gap-2.5 px-4 py-3 mb-4 rounded-xl bg-amber-500/10 border border-amber-500/25 text-amber-300 text-sm">
              {notice}
            </div>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label className="block text-xs text-slate-400 font-semibold mb-1.5">
                Email
              </label>

              <input
                type="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError("");
                }}
                placeholder="Enter your email"
                autoComplete="email"
                className="w-full px-4 py-3 rounded-xl text-white text-sm font-mono placeholder-slate-600 outline-none transition
                  bg-white/[0.05] border border-white/10 focus:border-blue-500/60 focus:bg-white/[0.08]"
              />
            </div>

            <div>
              <label className="block text-xs text-slate-400 font-semibold mb-1.5">
                Password
              </label>

              <div className="relative">
                <input
                  type={showPass ? "text" : "password"}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError("");
                  }}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                  className="w-full px-4 py-3 pr-12 rounded-xl text-white text-sm font-mono placeholder-slate-600 outline-none transition
                    bg-white/[0.05] border border-white/10 focus:border-blue-500/60 focus:bg-white/[0.08]"
                />

                <button
                  type="button"
                  onClick={() => setShowPass((p) => !p)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition p-1"
                >
                  {showPass ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 mt-1 rounded-xl text-white font-bold text-sm border-none cursor-pointer transition-all
                bg-gradient-to-r from-blue-700 to-blue-500
                shadow-[0_4px_20px_rgba(26,86,196,0.35)]
                hover:opacity-90 active:scale-[0.98]
                disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {loading ? "Signing in..." : "Sign In →"}
            </button>
          </form>
        </div>

        <p className="text-center text-[10px] text-slate-600 mt-5 font-mono">
          Camarines Sur Polytechnic Colleges · ICTU · v1.0.0
        </p>
      </div>
    </div>
  );
}
