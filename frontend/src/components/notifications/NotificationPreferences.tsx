import { useEffect, useState } from "react";
import { api } from "../../api/api";

type Severity = "info" | "warning" | "critical";

// Per-user email notification preferences (notification_prefs). Only the email
// settings are here; bell, toast and sound are controlled from the bell panel.
export default function NotificationPreferences() {
  // Both defaults are false, matching the server's PREF_DEFAULTS (email is opt-in).
  // A toggle showing "on" before the fetch finishes would tell a new user they are
  // subscribed when they are not.
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [minSeverity, setMinSeverity] = useState<Severity>("critical");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // What the server has now; the button compares the controls with this to show
  // whether there is anything to save.
  const [baseline, setBaseline] = useState<{ emailEnabled: boolean; minSeverity: Severity } | null>(null);

  const dirty =
    baseline !== null &&
    (baseline.emailEnabled !== emailEnabled || baseline.minSeverity !== minSeverity);

  useEffect(() => {
    let alive = true;
    api.getNotificationPrefs().then((res) => {
      if (!alive) return;
      // Seed the baseline from the SAME values we put in state — including when the
      // fetch fails and we fall back to defaults, so the button is never stuck.
      const prefs = res.success ? res.data?.prefs : null;
      const next = {
        emailEnabled: prefs ? Boolean(prefs.emailEnabled) : false,
        minSeverity: (prefs?.minEmailSeverity as Severity) ?? "critical",
      };
      setEmailEnabled(next.emailEnabled);
      setMinSeverity(next.minSeverity);
      setBaseline(next);
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  const save = async () => {
    setSaving(true);
    const res = await api.saveNotificationPrefs({ emailEnabled, minEmailSeverity: minSeverity });
    setSaving(false);
    if (res.success) {
      setBaseline({ emailEnabled, minSeverity }); // now in sync → no longer dirty
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  const label = { color: "var(--gf-text-primary)" };
  const sub = { color: "var(--gf-text-muted)" };

  return (
    <div
      className="p-5"
      style={{
        background: "var(--gf-panel)",
        border: "1px solid var(--gf-panel-border)",
        borderRadius: 2,
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      <div className="text-sm font-bold mb-1" style={label}>Notification Preferences</div>
      <div className="text-[13px] mb-4" style={sub}>
        Email alerts for this account. Bell, toast and sound are controlled from the bell menu.
      </div>

      {loading ? (
        <div className="text-[14px] py-4" style={sub}>Loading…</div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Email toggle */}
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-[14px]" style={label}>Email me alerts</span>
            <button
              type="button"
              role="switch"
              aria-checked={emailEnabled}
              onClick={() => setEmailEnabled((v) => !v)}
              className="relative transition-colors"
              style={{
                width: 36, height: 20, borderRadius: 99,
                background: emailEnabled ? "var(--gf-accent)" : "var(--gf-hover-strong)",
              }}
            >
              <span
                className="absolute top-0.5 transition-all"
                style={{
                  width: 16, height: 16, borderRadius: 99, background: "#fff",
                  left: emailEnabled ? 18 : 2,
                }}
              />
            </button>
          </label>

          {/* Min severity */}
          <div className="flex items-center justify-between gap-3" style={{ opacity: emailEnabled ? 1 : 0.5 }}>
            <span className="text-[14px]" style={label}>Email me when severity is at least</span>
            <select name="minSeverity"
              value={minSeverity}
              disabled={!emailEnabled}
              onChange={(e) => setMinSeverity(e.target.value as Severity)}
              className="text-[14px] px-2 py-1 outline-none"
              style={{
                background: "var(--gf-bg)",
                border: "1px solid var(--gf-panel-border)",
                borderRadius: 2,
                color: "var(--gf-text-primary)",
              }}
            >
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
          </div>

          {/* The button shows the state: green just after saving, blue when there are changes,
             muted and disabled when nothing has changed. */}
          <button
            onClick={save}
            disabled={saving || !dirty}
            title={dirty ? "Save your notification preferences" : "No unsaved changes"}
            className="self-start text-[14px] px-3 py-1.5 transition-colors"
            style={{
              background: saved ? "#73BF69" : dirty ? "var(--gf-accent)" : "var(--gf-hover-strong)",
              color: saved || dirty ? "#fff" : "var(--gf-text-muted)",
              borderRadius: 2,
              cursor: saving || !dirty ? "default" : "pointer",
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saved ? "✓ Saved" : saving ? "Saving…" : dirty ? "Save preferences" : "No changes"}
          </button>
        </div>
      )}
    </div>
  );
}
