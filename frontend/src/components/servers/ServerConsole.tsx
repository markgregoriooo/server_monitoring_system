import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../../api/api";
import type { ConsoleAction, ConsoleActionResult, ConsoleAddress, ConsoleInfo, OsFamily } from "../../api/api";
import { socket } from "../../socket/socket";
import { fmtDateTime } from "../../utils/format";

// Server Console: control a monitored server from the dashboard instead of opening
// PowerShell and typing `ssh`. Two halves, one login form:
//
//   Quick Actions  fixed buttons (disk, processes, restart a service, reboot …). The
//                  browser sends an action id, never command text — see backend
//                  services/consoleCommands.js. Read-only ones for IT staff too.
//   Terminal       a real interactive shell (xterm.js ⇄ Socket.IO ⇄ SSH). Admin only.
//
// The password lives in this component's state and nowhere else: not sessionStorage,
// not localStorage, not the backend. Leaving the page drops it. Only the USERNAME is
// remembered per server, as a convenience.
//
// Styled like ServerDetail (slate base + dark: overrides), which is the page it sits in.

interface Props {
  serverId: number;
  serverName: string;
  isAdmin: boolean;
}

const PANEL = "bg-white dark:bg-[#111217] border border-slate-200 dark:border-white/[0.07] rounded-lg";
const LABEL = "text-[13px] font-medium text-slate-500 dark:text-slate-400";
const INPUT =
  "w-full h-9 px-3 text-[13px] font-mono rounded-md border bg-white dark:bg-[#0b0e14] " +
  "border-slate-300 dark:border-white/[0.12] text-slate-900 dark:text-slate-100 " +
  "placeholder:text-slate-400 dark:placeholder:text-slate-600 " +
  "focus:outline-none focus:border-[#5794F2] focus:ring-2 focus:ring-[#5794F2]/25 transition-shadow";
// Info tile inside the login card (address, host key).
const TILE =
  "rounded-md border border-slate-200 dark:border-white/[0.07] bg-slate-50 dark:bg-white/[0.025] " +
  "p-3 flex flex-col gap-1.5 min-w-0";
const TILE_LABEL = "text-[10.5px] font-semibold uppercase tracking-[0.08em] text-slate-400 dark:text-slate-500";
// Buttons use the app's own raised-button classes (index.css): .gf-btn is the neutral
// raised face with sheen + press-inset, .gf-btn-primary the accent CTA. Same depth and
// feel as every other button in the dashboard.
const BTN_PRIMARY = "gf-btn-primary px-3 py-1.5 text-[13px] font-semibold";
const BTN_GHOST = "gf-btn px-3 py-1.5 text-[13px] font-semibold text-slate-700 dark:text-[var(--gf-text-primary)]";
const BTN_SMALL = "gf-btn !rounded-md h-7 px-2.5 text-[12px] font-semibold text-slate-700 dark:text-[var(--gf-text-primary)]";

const userKey = (id: number) => `cspc_console_user:${id}`;
const readUser = (id: number) => {
  try {
    return localStorage.getItem(userKey(id)) ?? "";
  } catch {
    return "";
  }
};
const saveUser = (id: number, u: string) => {
  try {
    localStorage.setItem(userKey(id), u);
  } catch {
    /* private window — the field just starts empty next time */
  }
};

export default function ServerConsole({ serverId, serverName, isAdmin }: Props) {
  const [info, setInfo] = useState<ConsoleInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<"actions" | "terminal">("actions");

  const [username, setUsername] = useState(() => readUser(serverId));
  const [password, setPassword] = useState("");
  const [port, setPort] = useState("22");
  const [osChoice, setOsChoice] = useState<OsFamily>("linux");
  const [showPw, setShowPw] = useState(false);

  const load = useCallback(() => {
    api.getServerConsole(serverId).then((r) => {
      if (r.success && r.data) {
        setInfo(r.data);
        // Start the port field on the server's saved SSH port (22 unless an admin set one).
        setPort(String(r.data.address?.port ?? 22));
        setLoadError("");
      } else setLoadError(r.error ?? "Could not load the console.");
    });
  }, [serverId]);
  useEffect(load, [load]);

  if (loadError) return <div className={`${PANEL} p-4 text-sm text-red-500`}>{loadError}</div>;
  if (!info) return <div className={`${PANEL} p-4 text-sm text-slate-400`}>Loading console…</div>;

  const family: OsFamily = info.family ?? osChoice;
  const portNum = Number(port) || 22;
  const credsReady = username.trim() !== "" && password !== "";
  const creds = { username: username.trim(), password, port: portNum, os: info.family ? undefined : osChoice };

  return (
    <div className="flex flex-col gap-3">
      {/* ── Login ─────────────────────────────────────────────────────────── */}
      <div className={`${PANEL} p-4 flex flex-col gap-4`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="grid place-items-center w-8 h-8 rounded-md bg-[#5794F2]/[0.12] text-[#5794F2] flex-shrink-0">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 5h16v14H4zM7 9l3 3-3 3M12 15h5" />
              </svg>
            </span>
            <div className="min-w-0">
              <div className="text-[14px] font-semibold text-slate-900 dark:text-white">SSH login</div>
              <div className="text-[12px] text-slate-500 truncate">Sign in to {serverName} to run actions or open a terminal</div>
            </div>
          </div>
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full border border-slate-300 dark:border-white/[0.12] text-slate-600 dark:text-slate-300 flex-shrink-0">
            {family === "windows" ? "Windows" : "Linux"}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <AddressTile address={info.address} isAdmin={isAdmin} serverId={serverId} onChanged={load} />
          <HostKeyTile info={info} isAdmin={isAdmin} serverId={serverId} onChanged={load} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_96px] gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-slate-600 dark:text-slate-400">Username</span>
            <input
              className={INPUT}
              value={username}
              autoComplete="off"
              spellCheck={false}
              placeholder={family === "windows" ? "Administrator" : "ictu"}
              onChange={(e) => setUsername(e.target.value)}
              onBlur={() => username.trim() && saveUser(serverId, username.trim())}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-slate-600 dark:text-slate-400">Password</span>
            <div className="relative">
              <input
                className={`${INPUT} pr-14`}
                type={showPw ? "text" : "password"}
                value={password}
                autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowPw((v) => !v)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 px-2 py-0.5 rounded text-[11px] font-semibold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.06]"
              >
                {showPw ? "Hide" : "Show"}
              </button>
            </div>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-slate-600 dark:text-slate-400">Port</span>
            <input className={INPUT} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
          </label>
        </div>

        {!info.family && (
          <div className="flex items-center gap-3 text-[12px] text-slate-500">
            The agent has not reported this server's OS. It is:
            {(["linux", "windows"] as OsFamily[]).map((f) => (
              <label key={f} className="flex items-center gap-1 cursor-pointer">
                <input type="radio" checked={osChoice === f} onChange={() => setOsChoice(f)} />
                {f === "linux" ? "Linux" : "Windows"}
              </label>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 text-[12px] text-slate-500 dark:text-slate-400">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
            <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01" />
          </svg>
          The password is used only on this page and is never saved.
          {credsReady && <span className="ml-auto text-[#73BF69] font-semibold">Ready</span>}
        </div>
      </div>

      {/* ── Tabs ──────────────────────────────────────────────────────────── */}
      <div className="flex gap-1 border-b border-slate-200 dark:border-white/[0.07]">
        <TabButton active={tab === "actions"} onClick={() => setTab("actions")}>Quick actions</TabButton>
        {info.terminalAllowed && (
          <TabButton active={tab === "terminal"} onClick={() => setTab("terminal")}>Terminal</TabButton>
        )}
      </div>

      {/* Both stay mounted so switching tabs does not drop an open terminal. */}
      <div className={tab === "actions" ? "" : "hidden"}>
        <QuickActions
          serverId={serverId}
          family={family}
          actions={info.actions}
          creds={creds}
          credsReady={credsReady}
          onHostKey={load}
        />
      </div>
      {info.terminalAllowed && (
        <div className={tab === "terminal" ? "" : "hidden"}>
          <WebTerminal
            serverId={serverId}
            serverName={serverName}
            family={family}
            creds={creds}
            credsReady={credsReady}
            visible={tab === "terminal"}
            onHostKey={load}
          />
        </div>
      )}

      {family === "windows" && <WindowsHelp />}
    </div>
  );
}

// ─── Pieces ───────────────────────────────────────────────────────────────────

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2 text-[13px] -mb-px border-b-2 transition-colors ${
        active
          ? "border-[#5794F2] text-slate-900 dark:text-white"
          : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
      }`}
    >
      {children}
    </button>
  );
}

// Where the console will connect, and whether that is the agent's IP or an admin's
// override. Admins can change it here: a VirtualBox NAT VM reports 10.0.2.15, which
// nothing outside the VM can reach, and a server may take SSH on a management network.
function AddressTile({
  address,
  isAdmin,
  serverId,
  onChanged,
}: {
  address: ConsoleAddress;
  isAdmin: boolean;
  serverId: number;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const open = () => {
    setHost(address.overridden ? address.host : "");
    setPort(address.port === 22 ? "" : String(address.port));
    setErr("");
    setEditing(true);
  };
  const save = async (h: string, p: string) => {
    setBusy(true);
    setErr("");
    const r = await api.setConsoleAddress(serverId, h.trim(), p ? Number(p) : null);
    setBusy(false);
    if (!r.success) return setErr(r.error ?? "Could not save.");
    setEditing(false);
    onChanged();
  };

  if (editing) {
    return (
      <div className={TILE}>
        <span className={TILE_LABEL}>Address</span>
        <div className="flex gap-2">
          <input
            className={`${INPUT} !h-8 flex-1 min-w-0`}
            value={host}
            spellCheck={false}
            placeholder={address.agentIp || "192.168.56.101"}
            onChange={(e) => setHost(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && save(host, port)}
            autoFocus
          />
          <input
            className={`${INPUT} !h-8 !w-16`}
            inputMode="numeric"
            value={port}
            placeholder="22"
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
          />
        </div>
        <div className="text-[11px] text-slate-500">Leave blank to use the agent's IP ({address.agentIp}).</div>
        {err && <div className="text-[12px] text-red-500">{err}</div>}
        <div className="flex gap-2 justify-end">
          {address.overridden && (
            <button className={BTN_SMALL} disabled={busy} onClick={() => save("", "")}>Use agent IP</button>
          )}
          <button className={BTN_SMALL} disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
          <button className="gf-btn-primary !rounded-md h-7 px-3 text-[12px] font-semibold" disabled={busy} onClick={() => save(host, port)}>
            Save
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className={TILE}>
      <div className="flex items-center justify-between gap-2">
        <span className={TILE_LABEL}>Address</span>
        <span
          className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-px rounded ${
            address.overridden
              ? "bg-[#5794F2]/15 text-[#5794F2]"
              : "bg-slate-200 dark:bg-white/[0.08] text-slate-500 dark:text-slate-400"
          }`}
        >
          {address.overridden ? "Set by admin" : "From agent"}
        </span>
      </div>
      <div className="font-mono text-[14px] font-semibold text-slate-900 dark:text-slate-100 truncate">
        {address.host}:{address.port}
      </div>
      <div className="flex items-center justify-between gap-2 mt-auto">
        <span className="text-[11px] text-slate-500 truncate">
          {address.overridden ? `Agent reports ${address.agentIp}` : "Reported by the monitoring agent"}
        </span>
        {isAdmin && (
          <button className={BTN_SMALL} onClick={open}>Change</button>
        )}
      </div>
    </div>
  );
}

// The server's SSH identity key, pinned on the first successful login. Shown shortened;
// the full value is in the tooltip so it can be compared with `ssh-keygen -lf` by hand.
function HostKeyTile({
  info,
  isAdmin,
  serverId,
  onChanged,
}: {
  info: ConsoleInfo;
  isAdmin: boolean;
  serverId: number;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const k = info.hostKey;
  const forget = async () => {
    if (
      !window.confirm(
        "Clear the saved SSH host key for this server?\n\nOnly do this if you know the server's key changed " +
          "(for example, the OS was reinstalled). The next login will trust whatever key the server presents.",
      )
    )
      return;
    setBusy(true);
    await api.forgetConsoleHostKey(serverId);
    setBusy(false);
    onChanged();
  };
  const short = (fp: string) => (fp.length > 30 ? `${fp.slice(0, 18)}…${fp.slice(-8)}` : fp);

  return (
    <div className={TILE}>
      <div className="flex items-center justify-between gap-2">
        <span className={TILE_LABEL}>Host key</span>
        <span
          className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-px rounded ${
            k ? "bg-[#73BF69]/15 text-[#73BF69]" : "bg-slate-200 dark:bg-white/[0.08] text-slate-500 dark:text-slate-400"
          }`}
        >
          {k ? "Saved" : "Not yet seen"}
        </span>
      </div>
      {k ? (
        <>
          <div className="font-mono text-[14px] font-semibold text-slate-900 dark:text-slate-100 truncate" title={k.fingerprint}>
            {short(k.fingerprint)}
          </div>
          <div className="flex items-center justify-between gap-2 mt-auto">
            <span className="text-[11px] text-slate-500 truncate">
              {k.keyType ?? "key"}
              {k.firstSeen ? ` · saved ${fmtDateTime(k.firstSeen)}` : ""}
            </span>
            {isAdmin && (
              <button className={`${BTN_SMALL} gf-btn-danger`} onClick={forget} disabled={busy}>Forget</button>
            )}
          </div>
        </>
      ) : (
        <div className="text-[12px] text-slate-500 mt-auto">
          Saved on the first successful login. Later logins must present the same key.
        </div>
      )}
    </div>
  );
}

interface Creds {
  username: string;
  password: string;
  port: number;
  os?: OsFamily | undefined;
}

function QuickActions({
  serverId,
  family,
  actions,
  creds,
  credsReady,
  onHostKey,
}: {
  serverId: number;
  family: OsFamily;
  actions: ConsoleAction[];
  creds: Creds;
  credsReady: boolean;
  onHostKey: () => void;
}) {
  const [service, setService] = useState("");
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<(ConsoleActionResult & { label: string }) | null>(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<ConsoleAction | null>(null);
  // The output lands BELOW the buttons, usually off-screen — so bring it into view as
  // soon as something starts running, and again when the result or error arrives.
  const outRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (running || result || error) outRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [running, result, error]);
  const runningLabel = actions.find((a) => a.id === running)?.label;

  const run = async (a: ConsoleAction) => {
    setConfirming(null);
    setRunning(a.id);
    setError("");
    const r = await api.runConsoleAction(serverId, {
      action: a.id,
      ...creds,
      ...(a.param ? { param: service.trim() } : {}),
    });
    setRunning(null);
    if (!r.success || !r.data) {
      setResult(null);
      setError(r.error ?? "The action failed.");
      return;
    }
    const label = a.param ? `${a.label} — ${service.trim()}` : a.label;
    setResult({ ...r.data, label });
    if (r.data.hostKey?.firstTrust) onHostKey();
  };

  const click = (a: ConsoleAction) => {
    if (a.param && !service.trim()) {
      setError("Type a service name first.");
      return;
    }
    if (a.confirm) setConfirming(a);
    else run(a);
  };

  const groups: { key: "info" | "control"; title: string }[] = [
    { key: "info", title: "Information" },
    { key: "control", title: "Control" },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className={`${PANEL} p-4 flex flex-col gap-4`}>
        <label className="flex flex-col gap-1 max-w-sm">
          <span className="text-[12px] text-slate-500">
            Service name <span className="text-slate-400">(for the service buttons)</span>
          </span>
          <input
            className={INPUT}
            value={service}
            spellCheck={false}
            placeholder={family === "windows" ? "Spooler" : "nginx"}
            onChange={(e) => setService(e.target.value)}
          />
        </label>

        {groups.map((g) => {
          const list = actions.filter((a) => a.group === g.key);
          if (list.length === 0) return null;
          return (
            <div key={g.key}>
              <div className={`${LABEL} mb-2`}>
                {g.title}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 auto-rows-fr gap-3">
                {list.map((a) => (
                  <ActionButton
                    key={a.id}
                    action={a}
                    running={running === a.id}
                    disabled={!credsReady || !a.allowed || running !== null}
                    title={!a.allowed ? "Admin only" : !credsReady ? "Enter the username and password first" : a.description}
                    onClick={() => click(a)}
                  />
                ))}
              </div>
            </div>
          );
        })}
        {!credsReady && <div className="text-[12px] text-slate-400">Enter the SSH username and password above to enable the buttons.</div>}
      </div>

      <div ref={outRef} className="flex flex-col gap-3 scroll-mt-4">
        {running && (
          <div className={`${PANEL} px-4 py-3 flex items-center gap-2 text-[13px] text-slate-600 dark:text-slate-300`}>
            <Spinner /> Running "{runningLabel}" on the server… the result will appear here.
          </div>
        )}
        {error && <div className={`${PANEL} p-3 text-[13px] text-red-500 border-red-300 dark:border-red-900/50`}>{error}</div>}
        {!running && result && <OutputPanel result={result} onClear={() => setResult(null)} />}
        {!running && !result && !error && (
          <div className="text-[12px] text-slate-400 px-1">Results appear here.</div>
        )}
      </div>

      {confirming && (
        <ConfirmDialog
          title={confirming.param ? `${confirming.label}: ${service.trim()}` : confirming.label}
          message={confirming.confirm ?? ""}
          onCancel={() => setConfirming(null)}
          onConfirm={() => run(confirming)}
        />
      )}
    </div>
  );
}

// ─── Quick Action button ──────────────────────────────────────────────────────
// The dashboard's standard raised button (.gf-btn). Every button is the same height
// (h-full in an equal-row grid) so the grid reads as one even block.

// Icon colour says what kind of action it is: blue reads, orange changes the server,
// red reboots it.
const ACCENT = { info: "#5794F2", control: "#FF780A", danger: "#E02F44" } as const;

function accentFor(a: ConsoleAction) {
  if (a.id === "reboot") return ACCENT.danger;
  return a.group === "control" ? ACCENT.control : ACCENT.info;
}

// 24x24 stroke icons, one per action; a generic terminal glyph for anything new.
const ICONS: Record<string, string> = {
  overview: "M3 4h18v12H3zM8 20h8M12 16v4",
  top_processes: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  disk: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  network: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3",
  failed_services: "M12 3 2 20h20L12 3zM12 10v4M12 17h.01",
  running_services: "M5 4l14 8-14 8V4z",
  recent_logs: "M6 3h9l4 4v14H6zM9 9h6M9 13h6M9 17h4",
  agent_status: "M3 12h4l3-7 4 14 3-7h4",
  service_status: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1",
  restart_service: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  restart_agent: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7M9 12h2l1-2 2 4 1-2h1",
  reboot: "M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0",
};
const FALLBACK_ICON = "M4 5h16v14H4zM7 9l3 3-3 3M12 15h5";

function ActionButton({
  action,
  running,
  disabled,
  title,
  onClick,
}: {
  action: ConsoleAction;
  running: boolean;
  disabled: boolean;
  title: string;
  onClick: () => void;
}) {
  const c = accentFor(action);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      // .gf-btn: the dashboard's standard raised button (face, sheen, shadow, press-inset).
      // Reboot also takes .gf-btn-danger, which reddens the edge and label on hover.
      className={`gf-btn ${action.id === "reboot" ? "gf-btn-danger" : ""} text-left flex items-start gap-3 px-3.5 py-3 w-full h-full !rounded-lg`}
      style={running ? { borderColor: "var(--gf-accent)" } : undefined}
    >
      <span className="flex-shrink-0 mt-0.5" style={{ color: c }}>
        {running ? (
          <Spinner />
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d={ICONS[action.id] ?? FALLBACK_ICON} />
          </svg>
        )}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-2 text-[13px] font-semibold text-slate-800 dark:text-[var(--gf-text-primary)]">
          {action.label}
          {!action.allowed && (
            <span className="text-[9px] uppercase tracking-wider px-1 py-px rounded-sm bg-slate-200 dark:bg-white/10 text-slate-500">
              admin
            </span>
          )}
        </span>
        <span className="block text-[11.5px] leading-snug text-slate-500 dark:text-slate-400 mt-0.5">{action.description}</span>
      </span>
    </button>
  );
}

function OutputPanel({ result, onClear }: { result: ConsoleActionResult & { label: string }; onClear: () => void }) {
  const [copied, setCopied] = useState(false);
  const color = result.timedOut ? "#FF780A" : result.ok ? "#73BF69" : "#F2495C";
  const status = result.timedOut ? "timed out" : `exit ${result.exitCode ?? "?"}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked on plain http — the text is selectable anyway */
    }
  };
  return (
    <div className={`${PANEL} overflow-hidden`}>
      <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-200 dark:border-white/[0.07]">
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
        <span className="text-[13px] text-slate-700 dark:text-slate-200">{result.label}</span>
        <span className="text-[12px] font-mono" style={{ color }}>{status}</span>
        <span className="text-[12px] text-slate-400 font-mono">{(result.durationMs / 1000).toFixed(1)}s</span>
        <div className="flex-1" />
        <button onClick={copy} className="text-[12px] text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">{copied ? "copied" : "copy"}</button>
        <button onClick={onClear} className="text-[12px] text-slate-400 hover:text-slate-700 dark:hover:text-slate-200">clear</button>
      </div>
      {result.hostKey?.firstTrust && (
        <div className="px-4 py-2 text-[12px] text-[#5794F2] bg-[#5794F2]/10">
          First login to this server — its SSH key {result.hostKey.fingerprint} was saved. Future logins must match it.
        </div>
      )}
      <pre className="m-0 p-4 max-h-[480px] overflow-auto text-[12px] leading-[1.45] font-mono bg-[#0b0e14] text-[#73BF69] whitespace-pre">
        {result.output.trim() || "(no output)"}
        {result.truncated && "\n\n… output cut off at 256 KB"}
      </pre>
    </div>
  );
}

function ConfirmDialog({
  title,
  message,
  onCancel,
  onConfirm,
}: {
  title: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div className={`${PANEL} p-5 max-w-md w-full`} onClick={(e) => e.stopPropagation()}>
        <div className="text-[15px] font-semibold text-slate-900 dark:text-white mb-2">{title}</div>
        <div className="text-[13px] text-slate-600 dark:text-slate-300 mb-5">{message}</div>
        <div className="flex justify-end gap-2">
          <button className={BTN_GHOST} onClick={onCancel}>Cancel</button>
          <button
            className="gf-raise px-3 py-1.5 text-[13px] font-semibold rounded-[2px] border border-black/20 text-white"
            style={{ background: "#E02F44" }}
            onClick={onConfirm}
            autoFocus
          >
            Yes, run it
          </button>
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />;
}

// ─── Web Terminal ─────────────────────────────────────────────────────────────

type TermState = "idle" | "connecting" | "open" | "closed";

function WebTerminal({
  serverId,
  serverName,
  family,
  creds,
  credsReady,
  visible,
  onHostKey,
}: {
  serverId: number;
  serverName: string;
  family: OsFamily;
  creds: Creds;
  credsReady: boolean;
  visible: boolean;
  onHostKey: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sessionRef = useRef<string | null>(null);
  const [state, setState] = useState<TermState>("idle");
  const [message, setMessage] = useState("");

  // One xterm instance for the life of the component.
  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: { background: "#0b0e14", foreground: "#D9D9D9", cursor: "#5794F2", selectionBackground: "rgba(87,148,242,0.35)" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current!);
    term.writeln("\x1b[90mEnter the SSH login above, then press Connect.\x1b[0m");
    termRef.current = term;
    fitRef.current = fit;

    const sub = term.onData((data) => {
      if (sessionRef.current) socket.emit("console:input", { sessionId: sessionRef.current, data });
    });

    const onOutput = (m: { sessionId: string; data: string }) => {
      if (m.sessionId === sessionRef.current) term.write(m.data);
    };
    const onClosed = (m: { sessionId: string; reason: string }) => {
      if (m.sessionId !== sessionRef.current) return;
      sessionRef.current = null;
      setState("closed");
      setMessage(`Session ended — ${m.reason}.`);
      term.writeln(`\r\n\x1b[90m── session ended: ${m.reason} ──\x1b[0m`);
    };
    socket.on("console:output", onOutput);
    socket.on("console:closed", onClosed);

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return; // hidden (display:none) — nothing to measure
      }
      if (sessionRef.current) {
        socket.emit("console:resize", { sessionId: sessionRef.current, cols: term.cols, rows: term.rows });
      }
    });
    ro.observe(hostRef.current!);

    return () => {
      ro.disconnect();
      sub.dispose();
      socket.off("console:output", onOutput);
      socket.off("console:closed", onClosed);
      if (sessionRef.current) socket.emit("console:close", { sessionId: sessionRef.current });
      sessionRef.current = null;
      term.dispose();
    };
  }, []);

  // Refit when the tab becomes visible (it was measured at 0x0 while hidden).
  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        /* not laid out yet */
      }
      termRef.current?.focus();
    });
  }, [visible]);

  const connect = () => {
    const term = termRef.current!;
    try {
      fitRef.current?.fit();
    } catch {
      /* use the defaults */
    }
    setState("connecting");
    setMessage("");
    term.reset();
    term.writeln(`\x1b[90mConnecting to ${serverName} as ${creds.username}…\x1b[0m`);
    socket.timeout(30000).emit(
      "console:open",
      { serverId, ...creds, cols: term.cols, rows: term.rows },
      (err: Error | null, res: { ok: boolean; error?: string; sessionId?: string; fingerprint?: string; firstTrust?: boolean; idleMinutes?: number }) => {
        if (err || !res?.ok) {
          const why = err ? "No reply from the backend." : res?.error ?? "Could not connect.";
          setState("idle");
          setMessage(why);
          term.writeln(`\x1b[31m${why}\x1b[0m`);
          return;
        }
        sessionRef.current = res.sessionId!;
        setState("open");
        if (res.firstTrust) {
          term.writeln(`\x1b[34mFirst login to this server — SSH key ${res.fingerprint} saved.\x1b[0m`);
          onHostKey();
        }
        setMessage(`Connected. Closes after ${res.idleMinutes} min without typing.`);
        term.focus();
      },
    );
  };

  const disconnect = () => {
    if (sessionRef.current) socket.emit("console:close", { sessionId: sessionRef.current });
  };

  return (
    <div className={`${PANEL} overflow-hidden`}>
      <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-200 dark:border-white/[0.07] flex-wrap">
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: state === "open" ? "#73BF69" : state === "connecting" ? "#FF780A" : "#6B7280" }}
        />
        <span className="text-[13px] text-slate-700 dark:text-slate-200">
          {family === "windows" ? "PowerShell" : "Shell"} — {serverName}
        </span>
        <span className="text-[12px] text-slate-400 truncate">{message}</span>
        <div className="flex-1" />
        {state === "open" ? (
          <button className={BTN_GHOST} onClick={disconnect}>Disconnect</button>
        ) : (
          <button className={BTN_PRIMARY} onClick={connect} disabled={!credsReady || state === "connecting"}>
            {state === "connecting" ? "Connecting…" : state === "closed" ? "Reconnect" : "Connect"}
          </button>
        )}
      </div>
      <div className="bg-[#0b0e14] p-2">
        <div ref={hostRef} className="h-[460px] w-full" />
      </div>
      <div className="px-4 py-2 text-[11px] text-slate-400 border-t border-slate-200 dark:border-white/[0.07]">
        Admin only. Opening and closing a terminal is recorded in History; what you type is not.
      </div>
    </div>
  );
}

function WindowsHelp() {
  return (
    <details className={`${PANEL} px-4 py-3 text-[12px] text-slate-500`}>
      <summary className="cursor-pointer text-[13px] text-slate-600 dark:text-slate-300">
        Windows server not connecting? Turn on OpenSSH Server (one time)
      </summary>
      <div className="mt-2">
        Windows Server 2019 and newer include it. Run this once in an <b>Administrator</b> PowerShell on the server:
      </div>
      <pre className="mt-2 p-3 bg-[#0b0e14] text-slate-200 font-mono rounded-sm overflow-auto">
{`Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service sshd -StartupType Automatic`}
      </pre>
      <div className="mt-2">
        The installer opens port 22 in Windows Firewall. Log in with a local or domain account that is an administrator
        on that server. Windows Server 2016 and older need OpenSSH installed by hand.
      </div>
    </details>
  );
}
