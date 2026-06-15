import { useEffect, useState } from "react";
import { api } from "../../api/api";

type Severity = "info" | "warning" | "critical";

// Per-user email notification preferences (persisted in notification_prefs).
// Only the email controls are surfaced — they're the ones enforced server-side
// (the in-app bell/toast/sound are controlled live from the bell panel).
export default function NotificationPreferences() {
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [minSeverity, setMinSeverity] = useState<Severity>("critical");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    api.getNotificationPrefs().then((res) => {
      if (!alive) return;
      if (res.success && res.data?.prefs) {
        setEmailEnabled(Boolean(res.data.prefs.emailEnabled));
        setMinSeverity((res.data.prefs.minEmailSeverity as Severity) ?? "critical");
      }
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  const save = async () => {
    setSaving(true);
    const res = await api.saveNotificationPrefs({ emailEnabled, minEmailSeverity: minSeverity });
    setSaving(false);
    if (res.success) {
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
      <div className="text-[11px] mb-4" style={sub}>
        Email alerts for this account. Bell, toast and sound are controlled from the bell menu.
      </div>

      {loading ? (
        <div className="text-[12px] py-4" style={sub}>Loading…</div>
      ) : (
        <div className="flex flex-col gap-4">
          {/* Email toggle */}
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-[12px]" style={label}>Email me alerts</span>
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
            <span className="text-[12px]" style={label}>Email me when severity is at least</span>
            <select
              value={minSeverity}
              disabled={!emailEnabled}
              onChange={(e) => setMinSeverity(e.target.value as Severity)}
              className="text-[12px] px-2 py-1 outline-none"
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

          <button
            onClick={save}
            disabled={saving}
            className="self-start text-[12px] px-3 py-1.5 transition-colors"
            style={{
              background: saved ? "#73BF69" : "var(--gf-accent)",
              color: "#fff", borderRadius: 2, opacity: saving ? 0.7 : 1,
            }}
          >
            {saved ? "✓ Saved" : saving ? "Saving…" : "Save preferences"}
          </button>
        </div>
      )}
    </div>
  );
}
