import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/api";
import { API_URL } from "../../config";

// ─── Agent install keys (admin) ─────────────────────────────────────────────────
//
// The credential the installer presents at enrollment. It used to be a single
// AGENT_INSTALL_KEY in backend/.env — unrotatable without shell access, with no
// expiry, no revocation and no record of who issued it. Now an admin mints one per
// rollout here, copies the ready-made install command, and revokes it when done.
//
// ⚠️ Revoking a key blocks NEW enrollments only. Servers already enrolled with it keep
// reporting on their own agent token; to stop one of those, remove the server.

const gf = {
  panel: "var(--gf-panel)",
  border: "var(--gf-panel-border)",
  divider: "var(--gf-divider)",
  textPrimary: "var(--gf-text-primary)",
  textMuted: "var(--gf-text-muted)",
  textDim: "var(--gf-text-dim)",
  hover: "var(--gf-hover)",
  accent: "var(--gf-accent)",
} as const;

const GREEN = "#73BF69";
const ORANGE = "#FF780A";
const RED = "#F2495C";

export interface InstallKey {
  id: number;
  label: string;
  keyPrefix: string;
  status: "active" | "revoked" | "expired";
  createdByName: string | null;
  revokedByName: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
  /** Whether the install command can be re-opened (false for pre-existing keys). */
  canReveal: boolean;
}

/** A server this key enrolled that is still reporting. */
interface EnrolledServer {
  id: number;
  name: string;
  ip: string | null;
  status: string | null;
}

/** The revoke dialog's state: which key, and what it would take down. */
interface RevokeTarget {
  key: InstallKey;
  servers: EnrolledServer[];
  loading: boolean;
}

/**
 * Copy to the clipboard, with a fallback that actually works here.
 *
 * `navigator.clipboard` requires a SECURE CONTEXT — HTTPS, or localhost. The dashboard
 * is served over plain HTTP on the LAN (http://192.168.100.9:5173), where the whole API
 * is `undefined`. Relying on it alone would leave the copy button doing nothing at all,
 * silently, in exactly the environment this ships into. `execCommand` is deprecated but
 * is still the only thing that works on an insecure origin, so it stays until the
 * dashboard is behind the HTTPS hostname Google sign-in already needs.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    // Off-screen rather than hidden: a display:none element cannot be selected.
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length); // iOS ignores select() on its own
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");

  const onClick = async () => {
    const ok = await copyText(text);
    setState(ok ? "ok" : "fail");
    setTimeout(() => setState("idle"), 2000);
  };

  const color = state === "ok" ? GREEN : state === "fail" ? RED : gf.textMuted;
  return (
    <button
      type="button"
      onClick={onClick}
      className="gf-btn shrink-0 text-[12px] px-2.5 py-1 rounded-[2px] transition-colors"
      style={{ color, border: `1px solid ${state === "idle" ? gf.border : color}` }}
      // A failed copy needs to say what to do instead, not just go red.
      title={state === "fail" ? "Copy failed — select the text and press Ctrl+C" : "Copy to clipboard"}
    >
      {state === "ok" ? "✓ Copied" : state === "fail" ? "Copy failed" : label}
    </button>
  );
}

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";

const STATUS_COLOR: Record<InstallKey["status"], string> = {
  active: GREEN,
  expired: ORANGE,
  revoked: RED,
};

// The dashboard's own host is the best guess at the URL agents should post to, since an
// admin is usually browsing at the same address the servers can reach.
//
// EXCEPT when that address is loopback. The command is meant to be run on a DIFFERENT
// machine, where "localhost" means that machine itself — so a literal http://localhost:3000
// is not merely a poor guess, it is guaranteed wrong, and wrong in a way that fails later
// (the agent starts, can't reach a backend, and looks like a network problem). Substituting
// a placeholder makes the command refuse to run until it has been filled in, which is the
// behaviour you want from a value nobody can guess on the user's behalf.
const isLocalUrl = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(API_URL);

const COMMAND_URL = (() => {
  if (!isLocalUrl) return API_URL;
  try {
    const u = new URL(API_URL);
    // Rebuilt from parts rather than string-replaced: it keeps the port and survives
    // an IPv6 literal like http://[::1]:3000, where a naive host regex does not.
    return `${u.protocol}//<domain>${u.port ? `:${u.port}` : ""}`;
  } catch {
    return API_URL;
  }
})();

const psCommand = (key: string) => `.\\install.ps1 -ApiUrl "${COMMAND_URL}" -InstallKey "${key}"`;
const shCommand = (key: string) => `sudo bash install.sh "${COMMAND_URL}" "${key}"`;

function CommandLine({ os, command }: { os: string; command: string }) {
  return (
    <div>
      <div className="text-[11px] tracking-widest uppercase mb-1" style={{ color: gf.textDim }}>
        {os}
      </div>
      <div
        className="flex items-center gap-2 px-2.5 py-2 rounded-[2px]"
        style={{ background: "rgba(0,0,0,0.25)", border: `1px solid ${gf.border}` }}
      >
        <code
          className="flex-1 min-w-0 text-[12px] overflow-x-auto whitespace-pre"
          style={{ color: gf.textPrimary }}
        >
          {command}
        </code>
        <CopyButton text={command} />
      </div>
    </div>
  );
}

export default function InstallKeysPanel() {
  const [keys, setKeys] = useState<InstallKey[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("");
  const [error, setError] = useState("");
  // Plaintext keys we currently hold, by key id — either just minted, or fetched back
  // from GET /reveal. Kept in component state only; the page never writes a key to
  // localStorage or sessionStorage, so the browser is not a second place it can leak from.
  // Re-opening after a reload costs one audited request instead.
  const [sessionKeys, setSessionKeys] = useState<Record<number, string>>({});
  // Which key's command box is currently open.
  const [revealId, setRevealId] = useState<number | null>(null);
  const [revoking, setRevoking] = useState<RevokeTarget | null>(null);

  const revealedKey = revealId == null ? null : sessionKeys[revealId] ?? null;

  // Show the install command for a key. Uses the copy we already hold when we have one
  // (just created, or opened earlier), otherwise asks the server.
  const showCommand = async (k: InstallKey) => {
    setError("");
    if (sessionKeys[k.id]) {
      setRevealId(k.id);
      return;
    }
    const res = await api.revealInstallKey(k.id);
    if (!res.success || !res.data?.key) {
      setError(res.error ?? "Could not load that key.");
      return;
    }
    const key = res.data.key;
    setSessionKeys((m) => ({ ...m, [k.id]: key }));
    setRevealId(k.id);
  };

  const load = useCallback(async () => {
    const res = await api.getInstallKeys();
    if (res.success && res.data) setKeys(res.data.keys ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    setError("");
    if (!label.trim()) {
      setError("Give the key a label so you can tell it apart later.");
      return;
    }
    setCreating(true);
    const days = expiresInDays.trim() === "" ? null : Number(expiresInDays);
    const res = await api.createInstallKey(label.trim(), days);
    setCreating(false);
    if (!res.success || !res.data?.key) {
      setError(res.error ?? "Could not create the key.");
      return;
    }
    const id = Number(res.data.record?.id);
    const key = res.data.key;
    if (Number.isInteger(id)) {
      setSessionKeys((m) => ({ ...m, [id]: key }));
      setRevealId(id);
    }
    setLabel("");
    setExpiresInDays("");
    setOpen(false);
    load();
  };

  // Revoking is a two-step: open the dialog, which fetches the servers this key
  // enrolled, so the admin picks between "stop new installs" and "stop those servers
  // too" while looking at the actual list of what would go dark.
  const openRevoke = async (k: InstallKey) => {
    setError("");
    setRevoking({ key: k, servers: [], loading: true });
    const res = await api.getInstallKeyServers(k.id);
    setRevoking({
      key: k,
      servers: res.success && res.data ? res.data.servers ?? [] : [],
      loading: false,
    });
  };

  // Only offered on a revoked key (the backend enforces it too). The warning names what
  // is actually lost — the row's history — and what is not: the servers keep running.
  const handleDelete = async (k: InstallKey) => {
    const warning =
      `Delete "${k.label}" from the list?\n\n` +
      (k.useCount > 0
        ? `The ${k.useCount} server(s) it enrolled keep running, but stop being linked to any key.\n`
        : "") +
      `The record of this key — who created it and what it enrolled — is lost.`;
    if (!window.confirm(warning)) return;
    const res = await api.deleteInstallKey(k.id);
    if (res.success) load();
    else setError(res.error ?? "Could not delete the key.");
  };

  const confirmRevoke = async (revokeAgents: boolean) => {
    if (!revoking) return;
    const k = revoking.key;
    setRevoking(null);
    const res = await api.revokeInstallKey(k.id, revokeAgents);
    if (res.success) load();
    else setError(res.error ?? "Could not revoke the key.");
  };

  const activeCount = keys.filter((k) => k.status === "active").length;

  return (
    <div
      className="flex flex-col rounded-lg overflow-hidden"
      style={{ background: gf.panel, border: `1px solid ${gf.border}` }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between gap-2 px-3 shrink-0"
        style={{ height: 32, borderBottom: `1px solid ${gf.divider}` }}
      >
        <span
          className="text-[13px] font-medium tracking-widest uppercase truncate"
          style={{ color: gf.textMuted }}
        >
          Agent install keys{activeCount > 0 ? ` · ${activeCount} active` : ""}
        </span>
        <button
          type="button"
          onClick={() => {
            setOpen((o) => !o);
            setError("");
          }}
          className="gf-btn shrink-0 text-[12px] px-2.5 py-1 rounded-[2px]"
          style={{ color: gf.textPrimary, border: `1px solid ${gf.border}` }}
        >
          {open ? "Cancel" : "+ New key"}
        </button>
      </div>

      <div className="flex flex-col gap-3" style={{ padding: 12 }}>
        <p className="text-[12px] leading-relaxed" style={{ color: gf.textDim }}>
          A key lets the installer enrol a new server. It is used once, at install time —
          revoking one blocks new enrolments and never affects servers already reporting.
        </p>

        {/* Create form */}
        {open && (
          <div
            className="flex flex-col gap-2.5 px-3 py-3 rounded-[2px]"
            style={{ background: gf.hover, border: `1px solid ${gf.border}` }}
          >
            <div className="flex flex-col sm:flex-row gap-2.5">
              <label className="flex-1 flex flex-col gap-1">
                <span className="text-[11px] tracking-widest uppercase" style={{ color: gf.textDim }}>
                  Label
                </span>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Main server room — Aug 2026"
                  maxLength={100}
                  autoFocus
                  className="px-2.5 py-1.5 text-[13px] rounded-[2px] outline-none"
                  style={{
                    background: gf.panel,
                    border: `1px solid ${gf.border}`,
                    color: gf.textPrimary,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                />
              </label>
              <label className="flex flex-col gap-1 sm:w-44">
                <span className="text-[11px] tracking-widest uppercase" style={{ color: gf.textDim }}>
                  Expires in (days)
                </span>
                <input
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="blank = never"
                  inputMode="numeric"
                  className="px-2.5 py-1.5 text-[13px] rounded-[2px] outline-none"
                  style={{
                    background: gf.panel,
                    border: `1px solid ${gf.border}`,
                    color: gf.textPrimary,
                    fontFamily: "'JetBrains Mono', monospace",
                  }}
                />
              </label>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCreate}
                disabled={creating}
                className="gf-raise text-[13px] font-medium px-3 py-1.5 rounded-md text-white active:scale-95 transition disabled:opacity-60"
                style={{ background: gf.accent }}
              >
                {creating ? "Creating…" : "Create key"}
              </button>
              <span className="text-[11px]" style={{ color: gf.textDim }}>
                The key is shown once, right after it is created.
              </span>
            </div>
          </div>
        )}

        {error && (
          <div className="text-[12px]" style={{ color: RED }}>
            {error}
          </div>
        )}

        {/* The key + its install command. Openable again from the row for as long as
            this page stays loaded — see sessionKeys. */}
        {revealedKey && (
          <div
            className="flex flex-col gap-3 px-3 py-3 rounded-[2px]"
            style={{ background: "rgba(115,191,105,0.06)", border: `1px solid rgba(115,191,105,0.35)` }}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[13px] font-semibold" style={{ color: GREEN }}>
                  Copy this key now
                </div>
                <div className="text-[12px] mt-0.5" style={{ color: gf.textMuted }}>
                  Stored encrypted — re-open it any time with <strong>Show command</strong>
                  in the list below. Each view is recorded in the audit log.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setRevealId(null)}
                className="shrink-0 text-[16px] leading-none px-1"
                style={{ color: gf.textDim }}
                title="Hide"
              >
                ×
              </button>
            </div>

            <div
              className="flex items-center gap-2 px-2.5 py-2 rounded-[2px]"
              style={{ background: "rgba(0,0,0,0.25)", border: `1px solid ${gf.border}` }}
            >
              <code
                className="flex-1 min-w-0 text-[12px] overflow-x-auto whitespace-pre"
                style={{ color: GREEN }}
              >
                {revealedKey}
              </code>
              <CopyButton text={revealedKey} label="Copy key" />
            </div>

            <div className="flex flex-col gap-2">
              <div className="text-[12px]" style={{ color: gf.textMuted }}>
                Run this on the server you want to monitor, from the installer folder:
              </div>
              <CommandLine os="Windows · PowerShell (as Administrator)" command={psCommand(revealedKey)} />
              <CommandLine os="Linux · bash" command={shCommand(revealedKey)} />
            </div>

            {/* The URL comes from the address this dashboard is open at, which is wrong the
                moment that address is loopback — the agent runs on another machine, where
                localhost is itself. COMMAND_URL has already put a placeholder in its place;
                this says what to fill in. */}
            {isLocalUrl && (
              <div className="text-[12px]" style={{ color: ORANGE }}>
                ⚠ Replace <code>&lt;domain&gt;</code> with the backend's LAN address or
                hostname (e.g. <code>192.168.100.9</code>). You opened this dashboard on
                localhost, which means nothing on another machine.
              </div>
            )}

            <div className="text-[12px]" style={{ color: gf.textDim }}>
              The installer waits for approval — the server then appears under Pending
              approvals below. Already-installed machines need <code>-ReEnroll</code> to
              move onto this key.
            </div>
          </div>
        )}

        {/* Existing keys */}
        {keys.length === 0 ? (
          <div className="text-[12px] py-2" style={{ color: gf.textDim }}>
            No install keys yet. Create one to enrol a server.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr style={{ borderBottom: `1px solid ${gf.divider}` }}>
                  {["Label", "Key", "Status", "Enrolled", "Created", "Expires", ""].map((h) => (
                    <th
                      key={h}
                      className="text-left px-2 py-1.5 text-[11px] tracking-widest uppercase font-medium whitespace-nowrap"
                      style={{ color: gf.textDim }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} style={{ borderBottom: `1px solid ${gf.divider}` }}>
                    <td className="px-2 py-2 text-[13px]" style={{ color: gf.textPrimary }}>
                      {k.label}
                      {k.createdByName && (
                        <span className="block text-[11px]" style={{ color: gf.textDim }}>
                          by {k.createdByName}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-[12px] whitespace-nowrap" style={{ color: gf.textMuted }}>
                      {k.keyPrefix}…
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <span
                        className="text-[11px] tracking-widest uppercase px-1.5 py-0.5 rounded-[2px]"
                        style={{
                          color: STATUS_COLOR[k.status],
                          background: `${STATUS_COLOR[k.status]}14`,
                          border: `1px solid ${STATUS_COLOR[k.status]}40`,
                        }}
                      >
                        {k.status}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-[13px] whitespace-nowrap" style={{ color: gf.textMuted }}>
                      {k.useCount}
                      {k.lastUsedAt && (
                        <span className="block text-[11px]" style={{ color: gf.textDim }}>
                          last {fmtDate(k.lastUsedAt)}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-[12px] whitespace-nowrap" style={{ color: gf.textMuted }}>
                      {fmtDate(k.createdAt)}
                    </td>
                    <td className="px-2 py-2 text-[12px] whitespace-nowrap" style={{ color: gf.textMuted }}>
                      {k.expiresAt ? fmtDate(k.expiresAt) : "never"}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <div className="flex items-center justify-end gap-2">
                        {/* A button rather than a click on the whole row: Revoke and
                            Delete live in this same row, and a row-wide target next to a
                            destructive button invites misclicks. Hidden for keys created
                            before they were recoverable — an offer that would only fail. */}
                        {k.canReveal && revealId !== k.id && (
                          <button
                            type="button"
                            onClick={() => showCommand(k)}
                            className="text-[12px] px-2 py-1 rounded-[2px] transition-colors"
                            style={{ color: GREEN, border: `1px solid ${GREEN}40` }}
                            title="Show the key and install command again"
                          >
                            Show command
                          </button>
                        )}
                        {k.status === "revoked" ? (
                          <>
                            {k.revokedByName && (
                              <span className="text-[11px]" style={{ color: gf.textDim }}>
                                by {k.revokedByName}
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => handleDelete(k)}
                              className="text-[12px] px-2 py-1 rounded-[2px] transition-colors"
                              style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}
                              title="Remove this key from the list"
                            >
                              Delete
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openRevoke(k)}
                            className="text-[12px] px-2 py-1 rounded-[2px] transition-colors"
                            style={{ color: RED, border: `1px solid ${RED}40` }}
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Revoke dialog. Two outcomes, both spelled out, with the affected servers named
          — the difference between them is a whole branch's monitoring, so this must not
          be a yes/no on an ambiguous question. */}
      {revoking && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.6)" }}
          onClick={() => setRevoking(null)}
        >
          <div
            className="w-full max-w-lg rounded-lg overflow-hidden"
            style={{ background: gf.panel, border: `1px solid ${gf.border}`, fontFamily: "'JetBrains Mono', monospace" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="px-4 flex items-center"
              style={{ height: 40, borderBottom: `1px solid ${gf.divider}` }}
            >
              <span className="text-[13px] font-medium tracking-widest uppercase" style={{ color: gf.textMuted }}>
                Revoke “{revoking.key.label}”
              </span>
            </div>

            <div className="p-4 flex flex-col gap-3">
              {revoking.loading ? (
                <div className="text-[13px]" style={{ color: gf.textMuted }}>
                  Checking which servers use this key…
                </div>
              ) : revoking.servers.length === 0 ? (
                <div className="text-[13px]" style={{ color: gf.textMuted }}>
                  No servers are currently reporting under this key. Revoking it only blocks
                  new installs.
                </div>
              ) : (
                <>
                  <div className="text-[13px]" style={{ color: gf.textPrimary }}>
                    {revoking.servers.length} server{revoking.servers.length === 1 ? "" : "s"} enrolled
                    with this key {revoking.servers.length === 1 ? "is" : "are"} currently reporting:
                  </div>
                  <div
                    className="flex flex-col gap-1 px-3 py-2 rounded-[2px] max-h-40 overflow-y-auto"
                    style={{ background: gf.hover, border: `1px solid ${gf.border}` }}
                  >
                    {revoking.servers.map((s) => (
                      <div key={s.id} className="flex items-baseline justify-between gap-2 text-[13px]">
                        <span style={{ color: gf.textPrimary }}>{s.name}</span>
                        <span className="text-[11px]" style={{ color: gf.textDim }}>{s.ip ?? "—"}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className="text-[12px] leading-relaxed" style={{ color: gf.textDim }}>
                Stopping a server is reversible — its history and logs are kept, and running
                the installer again with a live key brings it back as the same server,
                pending your approval.
              </div>

              <div className="flex flex-col gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => confirmRevoke(true)}
                  disabled={revoking.loading}
                  className="gf-raise w-full text-[13px] font-medium px-3 py-2 rounded-md text-white active:scale-95 transition disabled:opacity-60"
                  style={{ background: RED }}
                >
                  Revoke key and stop {revoking.servers.length || "these"} server
                  {revoking.servers.length === 1 ? "" : "s"}
                </button>
                <button
                  type="button"
                  onClick={() => confirmRevoke(false)}
                  disabled={revoking.loading}
                  className="w-full text-[13px] px-3 py-2 rounded-md transition disabled:opacity-60"
                  style={{ background: gf.hover, color: gf.textPrimary, border: `1px solid ${gf.border}` }}
                >
                  Revoke key only — leave running servers alone
                </button>
                <button
                  type="button"
                  onClick={() => setRevoking(null)}
                  className="w-full text-[12px] px-3 py-1.5"
                  style={{ color: gf.textDim }}
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
