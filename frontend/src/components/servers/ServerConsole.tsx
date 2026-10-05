import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api } from "../../api/api";
import type { ConsoleAction, ConsoleActionResult, ConsoleInfo, OsFamily } from "../../api/api";
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
  ip: string;
  isAdmin: boolean;
}

const PANEL = "bg-white dark:bg-[#111217] border border-slate-200 dark:border-white/[0.07] rounded-lg";
const LABEL = "text-[13px] font-medium text-slate-500 dark:text-slate-400";
const INPUT =
  "w-full px-2.5 py-1.5 text-[13px] font-mono rounded-sm border bg-white dark:bg-[#0b0e14] " +
  "border-slate-300 dark:border-white/[0.12] text-slate-900 dark:text-slate-100 " +
  "focus:outline-none focus:border-[#5794F2]";
const BTN =
  "px-3 py-1.5 text-[13px] rounded-sm border transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
const BTN_PRIMARY = `${BTN} bg-[#5794F2] border-[#5794F2] text-white hover:bg-[#4a83de]`;
const BTN_GHOST =
  `${BTN} border-slate-300 dark:border-white/[0.12] text-slate-700 dark:text-slate-200 ` +
  "hover:bg-slate-100 dark:hover:bg-white/[0.05]";

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

export default function ServerConsole({ serverId, serverName, ip, isAdmin }: Props) {
  const [info, setInfo] = useState<ConsoleInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<"actions" | "terminal">("actions");

  const [username, setUsername] = useState(() => readUser(serverId));
  const [password, setPassword] = useState("");
  const [port, setPort] = useState("22");
  const [osChoice, setOsChoice] = useState<OsFamily>("linux");

  const load = useCallback(() => {
    api.getServerConsole(serverId).then((r) => {
      if (r.success && r.data) {
        setInfo(r.data);
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
      <div className={`${PANEL} p-4`}>
        <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
          <div>
            <div className={LABEL}>SSH login</div>
            <div className="text-[12px] text-slate-400 mt-0.5">
              {family === "windows" ? "Windows" : "Linux"} · {ip} — the password is used only for this page and is never saved.
            </div>
          </div>
          <HostKeyBadge info={info} isAdmin={isAdmin} serverId={serverId} onChanged={load} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_90px] gap-2.5">
          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-slate-500">Username</span>
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
          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-slate-500">Password</span>
            <input
              className={INPUT}
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[12px] text-slate-500">Port</span>
            <input className={INPUT} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
          </label>
        </div>

        {!info.family && (
          <div className="mt-2.5 flex items-center gap-3 text-[12px] text-slate-500">
            The agent has not reported this server's OS. It is:
            {(["linux", "windows"] as OsFamily[]).map((f) => (
              <label key={f} className="flex items-center gap-1 cursor-pointer">
                <input type="radio" checked={osChoice === f} onChange={() => setOsChoice(f)} />
                {f === "linux" ? "Linux" : "Windows"}
              </label>
            ))}
          </div>
        )}
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

function HostKeyBadge({
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
  if (!k) {
    return (
      <span className="text-[12px] text-slate-400 font-mono" title="The server's SSH key is saved on the first successful login.">
        host key: not yet seen
      </span>
    );
  }
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
  return (
    <div className="text-right">
      <div className="text-[12px] font-mono text-slate-500 dark:text-slate-400 break-all" title={`Saved ${k.firstSeen ? fmtDateTime(k.firstSeen) : ""}`}>
        🔒 {k.keyType ? `${k.keyType} ` : ""}{k.fingerprint}
      </div>
      {isAdmin && (
        <button onClick={forget} disabled={busy} className="text-[11px] text-slate-400 hover:text-red-500 underline mt-0.5">
          clear saved key
        </button>
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
                {g.key === "control" && <span className="ml-2 text-[11px] text-[#FF780A]">changes the server</span>}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {list.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => click(a)}
                    disabled={!credsReady || !a.allowed || running !== null}
                    title={!a.allowed ? "Admin only" : !credsReady ? "Enter the username and password first" : a.description}
                    className={`text-left px-3 py-2 rounded-sm border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                      g.key === "control"
                        ? "border-[#FF780A]/40 hover:bg-[#FF780A]/10"
                        : "border-slate-200 dark:border-white/[0.1] hover:bg-slate-100 dark:hover:bg-white/[0.05]"
                    }`}
                  >
                    <div className="text-[13px] text-slate-800 dark:text-slate-100 flex items-center gap-2">
                      {running === a.id && <Spinner />}
                      {a.label}
                      {!a.allowed && <span className="text-[10px] uppercase text-slate-400">admin</span>}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">{a.description}</div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {!credsReady && <div className="text-[12px] text-slate-400">Enter the SSH username and password above to enable the buttons.</div>}
      </div>

      {error && <div className={`${PANEL} p-3 text-[13px] text-red-500 border-red-300 dark:border-red-900/50`}>{error}</div>}

      {result && <OutputPanel result={result} onClear={() => setResult(null)} />}

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
      <pre className="m-0 p-4 max-h-[480px] overflow-auto text-[12px] leading-[1.45] font-mono bg-[#0b0e14] text-slate-200 whitespace-pre">
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
          <button className={`${BTN} bg-[#E02F44] border-[#E02F44] text-white hover:bg-[#c42639]`} onClick={onConfirm} autoFocus>
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
