import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BackupSchedule, type BackupStatus, type SystemBackup } from "../api/api";
import { socket } from "../socket/socket";
import { GF as gf, STATUS } from "../theme/gf";

const { green: GREEN, orange: ORANGE, red: RED, blue: BLUE } = STATUS;

// Backups — admin only (panel RSC #2: "a backup server module to manage and secure
// system backups; FOD: present the system weekly backup").
//
// Everything the system already did about backups (the live NDJSON copy, the host's
// nightly dump, the Backblaze upload) plus the new weekly encrypted archive, in one
// place. The data and every action come from /api/backups
// (backend/services/systemBackupService.js). There is deliberately NO restore button:
// restoring replaces the live database, so it is a documented command (the guide at
// the bottom), not a click.

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const fmtPH = (iso: string | null | undefined, withTime = true) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "short",
    day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  });
};

const fmtBytes = (b: number | null | undefined) => {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
  return `${(b / 1073741824).toFixed(2)} GB`;
};

const ago = (iso: string | null | undefined) => {
  if (!iso) return null;
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
};

const fmtDay = (ymd: string | null) => {
  if (!ymd) return "—";
  const d = new Date(`${ymd}T00:00:00+08:00`);
  return d.toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" });
};

const VERIFY: Record<string, { label: string; color: string }> = {
  ok: { label: "Verified", color: GREEN },
  mismatch: { label: "Checksum mismatch", color: RED },
  missing: { label: "File missing", color: RED },
  undecryptable: { label: "Cannot decrypt", color: RED },
};

// ─── Small pieces ────────────────────────────────────────────────────────────

function Panel({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-[2px]" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
      <header
        className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
        style={{ borderBottom: `1px solid ${gf.divider}` }}
      >
        <h2 className="text-[13px] font-semibold" style={{ color: gf.textPrimary }}>
          {title}
        </h2>
        {right}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

function StatusCard({
  title,
  color,
  state,
  lines,
}: {
  title: string;
  color: string;
  state: string;
  lines: (string | null | false)[];
}) {
  return (
    <div
      className="relative overflow-hidden rounded-[2px] flex flex-col"
      style={{ background: gf.panel, border: `1px solid ${gf.border}`, minHeight: 118 }}
    >
      <div className="flex items-center justify-between gap-2 px-4 pt-3">
        <span className="text-[11px] tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>
          {title}
        </span>
      </div>
      <div className="px-4 pt-1.5 text-[17px] font-bold" style={{ color }}>
        {state}
      </div>
      <div className="px-4 pt-1 pb-3 flex flex-col gap-0.5">
        {lines.filter(Boolean).map((l, i) => (
          <span key={i} className="text-[12px]" style={{ color: gf.textMuted }}>
            {l}
          </span>
        ))}
      </div>
    </div>
  );
}

// Same box as User Management's StatusBadge: neutral face, the dot carries the colour.
function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[2px] text-[12px] font-semibold whitespace-nowrap"
      style={{ color: gf.textPrimary, background: gf.hover, border: `1px solid ${gf.border}` }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      {children}
    </span>
  );
}

function statusPill(b: SystemBackup) {
  if (b.status === "running") return <Pill color={BLUE}>Running…</Pill>;
  if (b.status === "failed") return <Pill color={RED}>Failed</Pill>;
  if (b.purgedAt) return <Pill color={gf.textDim as string}>Removed</Pill>;
  const v = b.verifyStatus ? VERIFY[b.verifyStatus] : null;
  return v ? <Pill color={v.color}>{v.label}</Pill> : <Pill color={ORANGE}>Not verified</Pill>;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Backups() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [backups, setBackups] = useState<SystemBackup[]>([]);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // "run" | "verify-all" | `verify-<id>` | `dl-<id>`
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [form, setForm] = useState<BackupSchedule | null>(null);
  const [saving, setSaving] = useState(false);
  const formDirty = useRef(false);

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3500);
  };

  const load = useCallback(async () => {
    const res = await api.getBackups();
    if (res.success && res.data) {
      setStatus(res.data.status);
      setBackups(res.data.backups);
      setLoadError("");
      // Follow the saved schedule unless the admin is part-way through editing it.
      if (!formDirty.current) setForm(res.data.status.weekly.schedule);
    } else setLoadError(res.error ?? "Could not load backups.");
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // A backup runs in the background; the backend says when anything changes.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const onUpdate = () => {
      if (t) clearTimeout(t);
      t = setTimeout(load, 250);
    };
    socket.on("backupUpdated", onUpdate);
    return () => {
      socket.off("backupUpdated", onUpdate);
      if (t) clearTimeout(t);
    };
  }, [load]);

  const runNow = async () => {
    setBusy("run");
    const res = await api.runBackupNow();
    setBusy(null);
    if (res.success) showToast("Backup started. It appears in the list when it finishes.");
    else showToast(res.error || "Could not start the backup.", false);
    load();
  };

  const verifyAll = async () => {
    setBusy("verify-all");
    const res = await api.verifyAllBackups();
    setBusy(null);
    if (res.success && res.data) {
      showToast(
        res.data.failed ? `${res.data.failed} backup(s) FAILED verification.` : `All ${res.data.ok} backup(s) verified.`,
        !res.data.failed,
      );
    } else showToast(res.error || "Verification failed to run.", false);
    load();
  };

  const verifyOne = async (b: SystemBackup) => {
    setBusy(`verify-${b.id}`);
    const res = await api.verifyBackup(b.id);
    setBusy(null);
    if (res.success && res.data) {
      const ok = res.data.verifyStatus === "ok";
      showToast(ok ? `${b.fileName} verified.` : `${b.fileName}: ${VERIFY[res.data.verifyStatus ?? ""]?.label ?? "failed"}.`, ok);
    } else showToast(res.error || "Could not verify.", false);
    load();
  };

  const download = async (b: SystemBackup) => {
    if (!b.fileName) return;
    setBusy(`dl-${b.id}`);
    const res = await api.downloadBackup(b.id, b.fileName);
    setBusy(null);
    if (!res.success) showToast(res.error || "Download failed.", false);
  };

  const remove = async (b: SystemBackup) => {
    if (!window.confirm(`Delete the manual backup ${b.fileName ?? `#${b.id}`}? This cannot be undone.`)) return;
    setBusy(`del-${b.id}`);
    const res = await api.deleteBackup(b.id);
    setBusy(null);
    if (res.success) showToast("Backup deleted.");
    else showToast(res.error || "Could not delete the backup.", false);
    load();
  };

  const saveSchedule = async () => {
    if (!form) return;
    setSaving(true);
    const res = await api.saveBackupSchedule(form);
    setSaving(false);
    if (res.success && res.data) {
      formDirty.current = false;
      setForm(res.data.schedule);
      showToast(`Weekly backup: every ${DAYS[res.data.schedule.day]} at ${res.data.schedule.time}, keeping ${res.data.schedule.keepWeeks} weeks.`);
      load();
    } else showToast(res.error || "Could not save the schedule.", false);
  };

  const editForm = (patch: Partial<BackupSchedule>) => {
    formDirty.current = true;
    setForm((f) => (f ? { ...f, ...patch } : f));
  };

  if (loadError) {
    return (
      <div className="p-4 lg:p-6 text-[13px]" style={{ color: RED, fontFamily: "'JetBrains Mono', monospace" }}>
        {loadError}
      </div>
    );
  }
  if (!status) {
    return (
      <div className="p-4 lg:p-6 text-[13px]" style={{ color: gf.textMuted, fontFamily: "'JetBrains Mono', monospace" }}>
        Loading backups…
      </div>
    );
  }

  const w = status.weekly;
  const running = w.running;
  const weeklyColor = !w.encryption.configured || !w.dumpTool.found ? RED : w.lastOk ? GREEN : ORANGE;
  const liveColor = !status.live.enabled ? (gf.textDim as string) : status.live.healthy ? GREEN : RED;
  const dumpAge = status.nightlyDump.latest ? Date.now() - new Date(status.nightlyDump.latest.modifiedAt).getTime() : null;
  const dumpColor = dumpAge == null ? ORANGE : dumpAge > 48 * 3600e3 ? ORANGE : GREEN;
  const off = status.offsite;
  const offColor = !off.enabled ? (gf.textDim as string) : off.severity === "ok" ? GREEN : off.severity === "warning" ? ORANGE : RED;
  const savedSchedule = w.schedule;
  const scheduleChanged =
    form != null &&
    (form.day !== savedSchedule.day || form.time !== savedSchedule.time || form.keepWeeks !== savedSchedule.keepWeeks);

  return (
    <div className="p-4 lg:p-6 flex flex-col gap-4" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h1 className="text-[16px] font-bold" style={{ color: gf.textPrimary }}>
            Backups
          </h1>
          <p className="text-[13px] mt-1 max-w-2xl" style={{ color: gf.textMuted }}>
            Encrypted weekly backups of this system's database and data.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button
            className="gf-btn text-[13px] font-medium px-3"
            style={{ height: 32, color: gf.textPrimary }}
            onClick={verifyAll}
            disabled={busy != null || Boolean(running)}
          >
            {busy === "verify-all" ? "Verifying…" : "Verify all"}
          </button>
          <button
            className="gf-btn text-[13px] font-semibold px-3"
            style={{ height: 32, color: gf.accentText }}
            onClick={runNow}
            disabled={busy != null || Boolean(running) || !w.encryption.configured}
            title={!w.encryption.configured ? "No encryption key configured" : undefined}
          >
            {running ? "Backing up…" : "Back up now"}
          </button>
        </div>
      </div>

      {running && (
        <div
          className="flex items-center gap-3 px-4 py-2.5 rounded-[2px] text-[13px]"
          style={{ color: gf.textPrimary, background: gf.accentDim, border: `1px solid ${gf.border}` }}
        >
          <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" style={{ color: BLUE }} />
          {running.kind === "weekly" ? "The weekly backup" : "A backup"} is being made — started {fmtPH(running.startedAt)}.
        </div>
      )}

      {(!w.encryption.configured || !w.dumpTool.found) && (
        <div
          className="px-4 py-2.5 rounded-[2px] text-[13px]"
          style={{ color: RED, background: `${RED}12`, border: `1px solid ${RED}55` }}
        >
          {!w.encryption.configured &&
            "No encryption key — set BACKUP_ENC_KEY in backend/.env. "}
          {!w.dumpTool.found &&
            "Database dump tool not found — rebuild the backend image."}
        </div>
      )}

      {/* Status cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <StatusCard
          title="Weekly backup"
          color={weeklyColor}
          state={w.lastOk ? `Last: ${w.lastOk.week}` : "No backup yet"}
          lines={[
            w.lastOk && `${fmtPH(w.lastOk.finishedAt)} · ${fmtBytes(w.lastOk.sizeBytes)}`,
            w.nextRunAt && `Next: ${fmtPH(w.nextRunAt)}`,
          ]}
        />
        <StatusCard
          title="On-site live copy"
          color={liveColor}
          state={!status.live.enabled ? "Disabled" : status.live.healthy ? "Writing" : "Not writing"}
          lines={[
            status.live.latest && `Last write ${ago(status.live.latest.modifiedAt)}`,
            status.disk && `${fmtBytes(status.disk.freeBytes)} free`,
          ]}
        />
        <StatusCard
          title="Nightly database dump"
          color={dumpColor}
          state={status.nightlyDump.latest ? fmtPH(status.nightlyDump.latest.modifiedAt, false) : "None found"}
          lines={[
            status.nightlyDump.latest
              ? `${fmtBytes(status.nightlyDump.latest.bytes)} · ${ago(status.nightlyDump.latest.modifiedAt)}`
              : "Runs nightly at 2:15 AM",
          ]}
        />
        <StatusCard
          title="Offsite (cloud)"
          color={offColor}
          state={!off.enabled ? "Not set up" : off.lastSyncAt ? (off.severity === "ok" ? "Up to date" : "Stale") : "Never synced"}
          lines={[off.lastSyncAt && `Last upload ${ago(off.lastSyncAt)}`, "Backblaze B2"]}
        />
      </div>

      {/* Backups list */}
      <Panel
        title={`Backups (${backups.length})`}>
        {backups.length === 0 ? (
          <div className="text-[13px] py-6 text-center" style={{ color: gf.textMuted }}>
            No backups yet. First one: {fmtPH(w.nextRunAt)}.
          </div>
        ) : (
          <>
            {/* Desktop table. Rows outlive their files (a removed week stays as history),
                so a year of weekly runs is 52+ rows: the list scrolls inside its own box,
                with the header pinned, instead of pushing the schedule off the page. */}
            <div className="hidden md:block overflow-auto max-h-[480px] -mx-4">
              <table className="w-full text-[12px]" style={{ color: gf.textPrimary }}>
                <thead className="sticky top-0 z-[1]" style={{ background: gf.panel }}>
                  <tr style={{ color: gf.textMuted, boxShadow: `inset 0 -1px 0 ${gf.divider}` }}>
                    {["Week", "Type", "Made (PHT)", "Covers", "Size", "Contents", "Status", ""].map((h) => (
                      <th key={h} className="text-left font-medium px-4 py-2 whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {backups.map((b) => (
                    <tr key={b.id} style={{ borderBottom: `1px solid ${gf.divider}`, opacity: b.purgedAt ? 0.55 : 1 }}>
                      <td className="px-4 py-2.5 font-semibold whitespace-nowrap">{b.week ?? "—"}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: gf.textMuted }}>
                        {b.kind === "weekly" ? "Weekly" : `Manual${b.createdBy ? ` · ${b.createdBy}` : ""}`}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">{fmtPH(b.finishedAt ?? b.startedAt)}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap" style={{ color: gf.textMuted }}>
                        {b.coverageFrom ? `${fmtDay(b.coverageFrom)} – ${fmtDay(b.coverageTo)}` : "—"}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">{fmtBytes(b.sizeBytes)}</td>
                      <td className="px-4 py-2.5" style={{ color: gf.textMuted }}>
                        {b.status === "failed" ? (
                          <span style={{ color: RED }} title={b.error ?? ""}>
                            {(b.error ?? "Failed").slice(0, 70)}
                            {(b.error?.length ?? 0) > 70 ? "…" : ""}
                          </span>
                        ) : b.status === "ok" ? (
                          `DB ${fmtBytes(b.dbBytes)} + ${b.dataFiles ?? 0} files`
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <span title={b.verifiedAt ? `Checked ${fmtPH(b.verifiedAt)}` : undefined}>{statusPill(b)}</span>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex justify-end gap-1.5">
                          {b.downloadable && (
                            <>
                            <button
                              className="gf-btn text-[12px] px-2.5"
                              style={{ height: 26, color: gf.textPrimary }}
                              onClick={() => verifyOne(b)}
                              disabled={busy != null}
                            >
                              {busy === `verify-${b.id}` ? "…" : "Verify"}
                            </button>
                            <button
                              className="gf-btn text-[12px] px-2.5"
                              style={{ height: 26, color: gf.textPrimary }}
                              onClick={() => download(b)}
                              disabled={busy != null}
                              title="Downloads the encrypted archive"
                            >
                              {busy === `dl-${b.id}` ? "…" : "Download"}
                            </button>
                            </>
                          )}
                          {b.kind === "manual" && b.status !== "running" && (
                            <button
                              className="gf-btn gf-btn-danger text-[12px] px-2.5"
                              style={{ height: 26 }}
                              onClick={() => remove(b)}
                              disabled={busy != null}
                              title="Delete this manual backup"
                            >
                              {busy === `del-${b.id}` ? "…" : "Delete"}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden flex flex-col gap-2.5 overflow-y-auto max-h-[70vh] pr-0.5">
              {backups.map((b) => (
                <div
                  key={b.id}
                  className="rounded-[2px] p-3 flex flex-col gap-1.5"
                  style={{ border: `1px solid ${gf.border}`, background: gf.bg, opacity: b.purgedAt ? 0.6 : 1 }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[14px] font-bold" style={{ color: gf.textPrimary }}>
                      {b.week ?? "—"}
                    </span>
                    {statusPill(b)}
                  </div>
                  <div className="text-[12px]" style={{ color: gf.textMuted }}>
                    {b.kind === "weekly" ? "Weekly" : `Manual${b.createdBy ? ` · ${b.createdBy}` : ""}`} ·{" "}
                    {fmtPH(b.finishedAt ?? b.startedAt)}
                  </div>
                  {b.status === "ok" && (
                    <div className="text-[12px]" style={{ color: gf.textMuted }}>
                      {fmtBytes(b.sizeBytes)} · {fmtDay(b.coverageFrom)} – {fmtDay(b.coverageTo)}
                    </div>
                  )}
                  {b.status === "failed" && (
                    <div className="text-[12px] break-words" style={{ color: RED }}>
                      {b.error}
                    </div>
                  )}
                  {(b.downloadable || (b.kind === "manual" && b.status !== "running")) && (
                    <div className="flex gap-2 pt-1">
                      {b.downloadable && (
                        <>
                      <button
                        className="gf-btn flex-1 text-[12px]"
                        style={{ height: 30, color: gf.textPrimary }}
                        onClick={() => verifyOne(b)}
                        disabled={busy != null}
                      >
                        {busy === `verify-${b.id}` ? "Verifying…" : "Verify"}
                      </button>
                      <button
                        className="gf-btn flex-1 text-[12px]"
                        style={{ height: 30, color: gf.textPrimary }}
                        onClick={() => download(b)}
                        disabled={busy != null}
                      >
                        {busy === `dl-${b.id}` ? "Downloading…" : "Download"}
                      </button>
                        </>
                      )}
                      {b.kind === "manual" && b.status !== "running" && (
                        <button
                          className="gf-btn gf-btn-danger flex-1 text-[12px]"
                          style={{ height: 30 }}
                          onClick={() => remove(b)}
                          disabled={busy != null}
                        >
                          {busy === `del-${b.id}` ? "Deleting…" : "Delete"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </Panel>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Schedule */}
        <Panel title="Weekly schedule">
          {form && (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px]" style={{ color: gf.textMuted }}>
                    Day
                  </span>
                  <select
                    className="text-[13px] px-2 py-1.5 rounded-[2px] outline-none"
                    style={{ background: gf.bg, color: gf.textPrimary, border: `1px solid ${gf.border}` }}
                    value={form.day}
                    onChange={(e) => editForm({ day: Number(e.target.value) })}
                  >
                    {DAYS.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px]" style={{ color: gf.textMuted }}>
                    Time (PHT)
                  </span>
                  <input
                    type="time"
                    className="text-[13px] px-2 py-1.5 rounded-[2px] outline-none"
                    style={{ background: gf.bg, color: gf.textPrimary, border: `1px solid ${gf.border}`, colorScheme: "dark" }}
                    value={form.time}
                    onChange={(e) => editForm({ time: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1.5">
                  <span className="text-[12px]" style={{ color: gf.textMuted }}>
                    Weeks to keep
                  </span>
                  <input
                    type="number"
                    min={1}
                    max={52}
                    className="text-[13px] px-2 py-1.5 rounded-[2px] outline-none"
                    style={{ background: gf.bg, color: gf.textPrimary, border: `1px solid ${gf.border}` }}
                    value={form.keepWeeks}
                    onChange={(e) => editForm({ keepWeeks: Number(e.target.value) })}
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12px]" style={{ color: gf.textMuted }}>
                  Older ones are removed automatically.
                </span>
                <button
                  className="gf-btn-primary text-[13px] font-semibold px-3 rounded-[3px]"
                  style={{ height: 30 }}
                  onClick={saveSchedule}
                  disabled={!scheduleChanged || saving}
                >
                  {saving ? "Saving…" : "Save schedule"}
                </button>
              </div>
            </div>
          )}
        </Panel>

        {/* Security — one line per measure */}
        <Panel title="Security">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px]">
            {(
              [
                [
                  "Encryption",
                  w.encryption.configured ? "AES-256-GCM" : "No key — backups off",
                  w.encryption.configured ? GREEN : RED,
                  w.encryption.configured ? `Key from ${w.encryption.source}, id ${w.encryption.keyId}` : undefined,
                ],
                ["Integrity", "SHA-256 + test decrypt"],
                ["Copies", "Server · USB drive · Backblaze"],
                ["Access", "Admins only, logged in History"],
                ["Restore", "By command only"],
                [
                  "Dump tool",
                  w.dumpTool.found ? "Ready" : "Not found",
                  w.dumpTool.found ? GREEN : RED,
                  w.dumpTool.version ?? undefined,
                ],
              ] as [string, string, string?, string?][]
            ).map(([k, v, color, title]) => (
              <div key={k} className="contents">
                <dt style={{ color: gf.textMuted }}>{k}</dt>
                <dd title={title} style={{ color: color ?? gf.textPrimary }}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        </Panel>
      </div>

      {/* Restore guide */}
      <details className="rounded-[2px] px-4 py-3" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
        <summary className="cursor-pointer text-[13px] font-semibold" style={{ color: gf.textPrimary }}>
          How to restore
        </summary>
        <ol className="mt-3 flex flex-col gap-2 text-[12px] list-decimal pl-5" style={{ color: gf.textMuted }}>
          <li>
            Unlock it (in <code>backend/</code>):
            <pre className="mt-1.5 p-2.5 rounded-[2px] overflow-x-auto" style={{ background: gf.bg, color: GREEN }}>
              npm run backup:decrypt -- weekly-2026-W41.tar.gz.enc
            </pre>
          </li>
          <li>
            Unpack: <code>tar -xzf weekly-2026-W41.tar.gz</code>
          </li>
          <li>
            Load <code>database.sql</code> with the backend <b style={{ color: ORANGE }}>stopped</b>:
            <pre className="mt-1.5 p-2.5 rounded-[2px] overflow-x-auto" style={{ background: gf.bg, color: GREEN }}>
              {`docker compose stop backend
docker compose exec -T db sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -u root "$MARIADB_DATABASE"' < database.sql
docker compose up -d backend`}
            </pre>
          </li>
        </ol>
      </details>

      {toast && (
        <div
          className="fixed top-5 right-5 z-[100] flex items-center gap-2 px-4 py-3 rounded-[2px] border text-xs shadow-xl max-w-[90vw]"
          style={{
            color: toast.ok ? GREEN : RED,
            background: toast.ok ? `${GREEN}14` : `${RED}14`,
            borderColor: toast.ok ? `${GREEN}40` : `${RED}40`,
          }}
        >
          <span>{toast.ok ? "✓" : "✕"}</span> {toast.msg}
        </div>
      )}
    </div>
  );
}
