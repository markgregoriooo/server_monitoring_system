import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/api";
import type { PaperSizeKey, PaperSizeOption, ReportTemplate, Signatory } from "../api/api";
import { MAX_SIGNATORIES } from "../api/api";
import { socket } from "../socket/socket";
import { useAuth } from "../context/AuthContext";
import { GF as gf, STATUS } from "../theme/gf";
import { Field } from "../components/ui/primitives";
const { green: GREEN, red: RED } = STATUS;

// Reports are real now: MySQL `reports` + an on-disk CSV/PDF per report, built on
// generate from the live stores (InfluxDB sensor_environment / server_metrics /
// router_metrics + network_traffic / ups_metrics, MySQL alerts / aircon_logs).
// Backend: services/reportService.js + routes/reports.js.

interface Report {
  id: number;
  title: string;
  type: string; // environment | server | network | ups | alerts | aircon
  status: string; // pending | generated | failed
  generatedBy: number | null;
  generatedByName: string | null;
  deviceId: number | null; // null = campus-wide
  deviceName: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string | null;
  // Assigned when the build succeeds, so it is null while pending and on a failed row.
  referenceNo: string | null;
  paperSize: PaperSizeKey;
  hasFile: boolean;
}

interface TypeMeta {
  value: string;
  label: string;
  desc: string;
  color: string;
}

// A device a report can be scoped to. The backend decides which types are scopeable
// (GET /reports/scope-options) from the same map it validates against, so this page
// never hardcodes "network means routers".
interface ScopeDevice {
  // Usually a device_id. The Alert History list also offers the literal "room", which is
  // the server room itself — environment alerts carry no device_id, so the one scope that
  // matters most on that report is the one that cannot be a number.
  id: number | string;
  name: string;
  type: string;
  location: string | null;
}

// Device CLASS, shown beside each name in the scope picker. It answers the question the
// list actually raises — "which of these is the router?" — where a location does not: most
// devices here share one server room, so the location repeated on every row distinguished
// nothing while making the names harder to scan.
const DEVICE_TYPE_LABEL: Record<string, string> = {
  server: "Server",
  router: "Router",
  mikrotik: "MikroTik",
  ups: "UPS",
  aircon: "Aircon",
  esp32: "Sensor",
};
const deviceTypeLabel = (t: string): string => DEVICE_TYPE_LABEL[t] ?? t;

const TYPES: TypeMeta[] = [
  { value: "environment", label: "Environment", desc: "Temperature, humidity & gas — daily min / max / avg from the sensor.", color: "#FF6B6B" },
  { value: "server", label: "Server Metrics", desc: "CPU, memory & disk per server — average & peak over the period.", color: "#5794F2" },
  { value: "network", label: "Network Traffic", desc: "Routers & the MikroTik — traffic per port, peak utilization, link errors.", color: "#73BF69" },
  { value: "ups", label: "UPS Power", desc: "Battery charge, runtime & load, plus on-battery and offline events.", color: "#B877D9" },
  { value: "alerts", label: "Alert History", desc: "Every alert raised in the window, counted by severity.", color: "#FF780A" },
  { value: "aircon", label: "Aircon Activity", desc: "Manual & auto IR triggers — who acted, when and why.", color: "#3CC8E8" },
  // The one FORWARD-looking report: the period is used as the regression's lookback
  // rather than as the window being summarised. See predictive-analytics.md §18.
  { value: "forecast", label: "Capacity Forecast", desc: "What runs out and when — disk, UPS battery & link projections, with their measured accuracy.", color: "#E8C33C" },
];

const RANGES = [
  { value: "24h", label: "Last 24h", ms: 24 * 3600 * 1000 },
  { value: "7d", label: "Last 7 days", ms: 7 * 24 * 3600 * 1000 },
  { value: "30d", label: "Last 30 days", ms: 30 * 24 * 3600 * 1000 },
  { value: "custom", label: "Custom", ms: 0 },
];

const AMBER = "#FF780A";
const ACCENT = "#5794F2";


const inputStyle: React.CSSProperties = {
  background: gf.bg,
  border: `1px solid ${gf.border}`,
  color: gf.textPrimary,
  fontFamily: "'JetBrains Mono', monospace",
};

const STATUS_COLOR: Record<string, string> = { generated: GREEN, pending: AMBER, failed: RED };
const typeMeta = (v: string): TypeMeta =>
  TYPES.find((t) => t.value === v) ?? { value: v, label: v, desc: "", color: gf.textMuted };

const fmtDateTime = (iso?: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-PH", {
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Manila",
  });
};

const fmtDay = (iso?: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-PH", { month: "short", day: "2-digit", timeZone: "Asia/Manila" });
};

const fmtPeriod = (r: Report): string =>
  r.periodStart && r.periodEnd ? `${fmtDay(r.periodStart)} – ${fmtDay(r.periodEnd)}` : "—";

// Download filename = "<title> <start> to <end>.<fmt>", sanitized for the filesystem.
const downloadName = (r: Report, format: string): string => {
  const dayIso = (iso?: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  };
  const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  const period = r.periodStart && r.periodEnd ? `_${dayIso(r.periodStart)}_to_${dayIso(r.periodEnd)}` : "";
  return `${safe(r.title || "report") || "report"}${period}.${format}`;
};

const todayStr = () => new Date().toISOString().slice(0, 10);
const daysAgoStr = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString().slice(0, 10);

// ─── Expandable detail row ────────────────────────────────────────────────────
//
// Same pattern as the servers table (ServerMetrics.tsx `ServerDrawerRow`): a full-width
// row under the one that was clicked, animated by max-height so it does not jump.
//
// It exists because everything that DECIDED what the PDF looks like was invisible once
// the report existed. The row shows a title, a period and a status; it could not tell
// you which page size the file was rendered at, whether it covered one device or the
// whole campus, or what control number it was filed under — and those are exactly the
// questions someone asks when they have the printed copy in front of them.
function ReportDrawerRow({ report, isOpen, paperSizes }: {
  report: Report; isOpen: boolean; paperSizes: Record<string, PaperSizeOption>;
}) {
  return (
    <tr>
      <td colSpan={7} className="p-0">
        <ReportDrawerBody report={report} isOpen={isOpen} paperSizes={paperSizes} max={320} />
      </td>
    </tr>
  );
}

// The drawer's CONTENT, split from the <tr> above so the phone card can open the very
// same panel: a <tr> cannot live inside a card, and a second copy of these fields would
// be a second place to edit every time a report gains one.
//
// `max` is the collapsed/expanded max-height. It is a prop because the field grid is
// four columns on a desktop and ONE on a phone, so the same seven fields are roughly
// twice as tall there — a single constant would either clip the card or leave a gap
// under the table.
function ReportDrawerBody({ report: r, isOpen, paperSizes, max }: {
  report: Report; isOpen: boolean; paperSizes: Record<string, PaperSizeOption>; max: number;
}) {
  const paper = paperSizes[r.paperSize];
  const rows: { label: string; value: string; mono?: boolean }[] = [
    // Null until the build succeeds, so a pending row says so rather than showing a
    // blank where a filed document's number belongs.
    {
      label: "Reference No.",
      value: r.referenceNo ?? (r.status === "failed" ? "not assigned — build failed" : "pending"),
      mono: true,
    },
    { label: "Report type", value: typeMeta(r.type).label },
    { label: "Scope", value: r.deviceName ?? "All devices (campus-wide)" },
    {
      label: "Paper size",
      value: paper ? `${paper.label} — ${paper.inches}` : r.paperSize,
    },
    {
      label: "Monitoring period",
      value:
        r.periodStart && r.periodEnd
          ? `${fmtDateTime(r.periodStart)}  →  ${fmtDateTime(r.periodEnd)}`
          : "—",
      mono: true,
    },
    { label: "Date created", value: fmtDateTime(r.createdAt), mono: true },
    { label: "Responsible", value: r.generatedByName ?? `user #${r.generatedBy ?? "?"}` },
    {
      label: "Files",
      value: r.hasFile ? "CSV and PDF saved on the server" : "no file yet",
    },
  ];

  return (
    <div
      className="overflow-hidden transition-all duration-300 ease-in-out"
      style={{ maxHeight: isOpen ? max : 0, borderTop: isOpen ? `1px solid ${gf.divider}` : "none" }}
    >
      <div className="p-3.5" style={{ background: gf.bg }}>
        <div className="text-[11px] tracking-wider uppercase mb-2.5" style={{ color: gf.textDim }}>
          How this report was generated
        </div>
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
          {rows.map((f) => (
            <div key={f.label}>
              <div className="text-[11px]" style={{ color: gf.textDim }}>{f.label}</div>
              <div
                className={`text-[13px] mt-0.5 break-words ${f.mono ? "font-mono" : ""}`}
                style={{ color: gf.textPrimary }}
              >
                {f.value}
              </div>
            </div>
          ))}
        </div>
        {/* The template is frozen per report at generate time, so an admin who
            changes the letterhead later does not silently restate what an already
            filed document looks like. Worth saying once, here. */}
        <div className="text-[11px] mt-3" style={{ color: gf.textDim }}>
          The letterhead and page size were frozen when this report was built — changing
          the template later does not alter it.
        </div>
      </div>
    </div>
  );
}

export default function Reports() {
  const { user } = useAuth();
  const role = String(user?.role ?? "");
  const canGenerate = ["admin", "it_staff"].includes(role);
  const canDelete = role === "admin";

  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // filters
  const [typeFilter, setTypeFilter] = useState("all");
  const [search, setSearch] = useState("");

  // generate modal
  const [modalOpen, setModalOpen] = useState(false);
  // The template settings live in this modal rather than on the page, so the page
  // stays what it is for — a list of generated reports.
  const [modalTab, setModalTab] = useState<"generate" | "template">("generate");
  const [genType, setGenType] = useState("environment");
  const [genTitle, setGenTitle] = useState("");
  const [genDevice, setGenDevice] = useState(""); // "" = all devices
  const [scopeDevices, setScopeDevices] = useState<ScopeDevice[]>([]);
  const [rangeMode, setRangeMode] = useState("7d");
  const [customStart, setCustomStart] = useState(daysAgoStr(7));
  const [customEnd, setCustomEnd] = useState(todayStr());
  const [generating, setGenerating] = useState(false);
  const [formError, setFormError] = useState("");

  // ── Report template (ICTU branding) ──
  // `genPaper` starts empty and is seeded from the admin's default once the template
  // loads, so opening the modal before that request lands does not lock in "a4" as a
  // deliberate choice. An empty value is sent as omitted, letting the server apply
  // the same default it just told us about.
  const [template, setTemplate] = useState<ReportTemplate | null>(null);
  const [paperSizes, setPaperSizes] = useState<Record<string, PaperSizeOption>>({});
  const [genPaper, setGenPaper] = useState<PaperSizeKey | "">("");
  // Whether the operator has deliberately picked a size for THIS report. Until they
  // do, the picker follows the admin default live; once they have, it is their choice
  // and a template change must not silently overwrite it.
  //
  // A REF, not state: nothing renders from it, and it is read inside loadTemplate —
  // a useCallback with no deps, which would capture the state value as false forever.
  const paperTouched = useRef(false);
  const [templateBusy, setTemplateBusy] = useState("");
  const logoInput = useRef<Record<string, HTMLInputElement | null>>({});
  // Held separately from `template` so typing doesn't fight the loaded value; committed
  // on blur or Enter rather than per keystroke, which would be one PUT per character.
  const [unitDraft, setUnitDraft] = useState("");
  // Edited as a whole and saved on an explicit press: a signature block is a set of
  // related lines, and autosaving each keystroke would push half-typed roles into
  // documents generated in the meantime.
  const [sigDraft, setSigDraft] = useState<Signatory[]>([]);
  const sigDirty =
    !!template && JSON.stringify(sigDraft) !== JSON.stringify(template.signatories);

  // per-row busy state (download / delete)
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [confirmId, setConfirmId] = useState<number | null>(null);
  // Which row is expanded. One at a time, like the servers table: two open drawers
  // push everything below them off screen and neither is easier to read for it.
  const [openId, setOpenId] = useState<number | null>(null);

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3000);
  };

  const load = async () => {
    const res = await api.getReports();
    if (res.success && res.data) setReports(res.data.reports ?? []);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  // ── Report template ──
  // Loaded once. The default page size seeds the Generate modal, and the logo state
  // drives the admin panel below the list.
  const loadTemplate = useCallback(async () => {
    const res = await api.getReportTemplate();
    if (!res.success || !res.data?.template) return;
    setTemplate(res.data.template as ReportTemplate);
    setPaperSizes((res.data.paperSizes ?? {}) as Record<string, PaperSizeOption>);
    setUnitDraft(res.data.template.unitName ?? "");
    setSigDraft((res.data.template.signatories ?? []) as Signatory[]);
    // Follows the default until the operator picks something themselves; after that
    // it is their choice and a template change must not overwrite it.
    if (!paperTouched.current) setGenPaper(res.data.template.paperSize as PaperSizeKey);
  }, []);

  useEffect(() => {
    loadTemplate();
  }, [loadTemplate]);

  const changePaperDefault = async (size: PaperSizeKey) => {
    setTemplateBusy("paper");
    const res = await api.setReportPaperSize(size);
    setTemplateBusy("");
    if (res.success) {
      setTemplate((t) => (t ? { ...t, paperSize: size } : t));
      // The Generate tab is one click away, so it follows straight away rather than
      // waiting for the socket to come back around.
      if (!paperTouched.current) setGenPaper(size);
      showToast(`Default paper size is now ${paperSizes[size]?.label ?? size}.`);
    } else {
      showToast(res.error || "Could not change the paper size.", false);
    }
  };

  const commitUnitName = async () => {
    const next = unitDraft.trim();
    if (!template || next === template.unitName) return; // nothing to save
    setTemplateBusy("unit");
    const res = await api.setReportUnitName(next);
    setTemplateBusy("");
    if (res.success) {
      const saved = res.data?.unitName ?? next;
      setTemplate((t) => (t ? { ...t, unitName: saved } : t));
      setUnitDraft(saved);
      showToast("Letterhead updated. New reports will use it.");
    } else {
      setUnitDraft(template.unitName); // put the field back to the saved truth
      showToast(res.error || "Could not update the letterhead.", false);
    }
  };

  const commitSignatories = async () => {
    setTemplateBusy("sig");
    const res = await api.setReportSignatories(sigDraft);
    setTemplateBusy("");
    if (res.success) {
      const saved = (res.data?.signatories ?? sigDraft) as Signatory[];
      setTemplate((t) => (t ? { ...t, signatories: saved } : t));
      // Re-seed from the SERVER copy: it trims and drops lines, so the editor should
      // show what will actually print, not what was typed.
      setSigDraft(saved);
      showToast("Signature block updated.");
    } else {
      showToast(res.error || "Could not update the signature block.", false);
    }
  };

  const uploadLogo = async (slot: "cspc" | "ictu", file: File | null) => {
    if (!file) return;
    setTemplateBusy(`logo-${slot}`);
    const res = await api.uploadReportLogo(slot, file);
    setTemplateBusy("");
    // Re-read rather than patching state locally: the server decides the stored
    // filename and the timestamp, and it may have rejected the image on content even
    // though the browser was willing to send it.
    if (res.success) {
      await loadTemplate();
      showToast(`${slot.toUpperCase()} logo updated. New reports will use it.`);
    } else {
      showToast(res.error || "Could not upload the logo.", false);
    }
  };

  const removeLogo = async (slot: "cspc" | "ictu") => {
    setTemplateBusy(`logo-${slot}`);
    const res = await api.clearReportLogo(slot);
    setTemplateBusy("");
    if (res.success) {
      await loadTemplate();
      showToast(`${slot.toUpperCase()} logo reverted to the bundled mark.`);
    } else {
      showToast(res.error || "Could not remove the logo.", false);
    }
  };

  // Insert-or-replace by id. EVERY path that adds a row must go through this — the
  // socket handlers below AND the Generate response.
  //
  // The two race, and the socket usually wins: the backend emits `reportCreated`
  // inside create(), then the route awaits an audit-log write before sending its
  // 202. So by the time the HTTP response resolves the row is normally already in
  // state, and an unconditional prepend there duplicated it.
  const upsertReport = useCallback((r: Report) => {
    setReports((prev) => {
      const i = prev.findIndex((x) => x.id === r.id);
      if (i === -1) return [r, ...prev];
      const next = [...prev];
      next[i] = r;
      return next;
    });
  }, []);

  // Live lifecycle. Reports are a SHARED list — everyone sees every row — so the
  // backend broadcasts all three events to every dashboard: an admin watching this
  // page sees a colleague's report appear as `pending`, then flip to generated or
  // failed, then vanish if it's deleted. No refresh anywhere.
  useEffect(() => {
    const onCreated = (r: Report) => upsertReport(r);

    const onUpdated = (r: Report) => {
      upsertReport(r);
      // Toast only for the person who asked for it — otherwise every user gets a
      // popup every time anyone anywhere generates a report.
      if (user && r.generatedBy === user.id) {
        if (r.status === "failed") showToast(`"${r.title}" failed to generate.`, false);
        else if (r.status === "generated") showToast(`"${r.title}" is ready.`);
      }
    };

    const onDeleted = ({ id }: { id: number }) => {
      setReports((prev) => prev.filter((x) => x.id !== id));
      setConfirmId((c) => (c === id ? null : c)); // don't strand an open confirm
    };

    // An admin changed the letterhead, the default page size or the signature block.
    // Broadcast to every dashboard for the same reason `envConfigUpdated` is: the person
    // who made the change is standing on the settings tab and is the least likely to
    // notice that everyone else's Generate dialog still offers the old default.
    const onTemplate = (next: ReportTemplate) => {
      setTemplate(next);
      // The picker follows the new default only while this operator has not chosen a
      // size for the report they are in the middle of setting up.
      if (!paperTouched.current) setGenPaper(next.paperSize);
      // Drafts are only re-seeded when they are NOT being edited here — otherwise a
      // colleague's save would wipe half-typed text out from under someone.
      setUnitDraft((cur) => (cur === template?.unitName ? next.unitName : cur));
      setSigDraft((cur) =>
        JSON.stringify(cur) === JSON.stringify(template?.signatories) ? next.signatories : cur,
      );
    };

    socket.on("reportCreated", onCreated);
    socket.on("reportUpdated", onUpdated);
    socket.on("reportDeleted", onDeleted);
    socket.on("reportTemplateUpdated", onTemplate);
    return () => {
      socket.off("reportCreated", onCreated);
      socket.off("reportUpdated", onUpdated);
      socket.off("reportDeleted", onDeleted);
      socket.off("reportTemplateUpdated", onTemplate);
    };
  }, [user, upsertReport, template]);

  // Escape closes the modal
  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setModalOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen]);

  // Which devices the chosen type can be scoped to. Refetched on every type change —
  // switching from Network to UPS must not leave a router selected.
  useEffect(() => {
    if (!modalOpen) return;
    let cancelled = false;
    setGenDevice("");
    api.getReportScopeOptions(genType).then((res) => {
      if (cancelled) return;
      setScopeDevices(res.success && res.data ? (res.data.devices ?? []) : []);
    });
    return () => {
      cancelled = true;
    };
  }, [genType, modalOpen]);

  const openModal = () => {
    setGenType("environment");
    setGenTitle("");
    setGenDevice("");
    setRangeMode("7d");
    setCustomStart(daysAgoStr(7));
    setCustomEnd(todayStr());
    setFormError("");
    // Always opens on Generate, even if the last visit ended on Template — the button
    // that opened this says "Generate report".
    setModalTab("generate");
    paperTouched.current = false;
    setModalOpen(true);
  };

  const handleGenerate = async () => {
    let periodStart: string;
    let periodEnd: string;
    if (rangeMode === "custom") {
      if (!customStart || !customEnd) {
        setFormError("Pick a start and end date.");
        return;
      }
      if (customStart > customEnd) {
        setFormError("Start date must be on or before the end date.");
        return;
      }
      periodStart = new Date(`${customStart}T00:00:00`).toISOString();
      periodEnd = new Date(`${customEnd}T23:59:59`).toISOString();
    } else {
      const ms = RANGES.find((r) => r.value === rangeMode)?.ms ?? 7 * 24 * 3600 * 1000;
      periodEnd = new Date().toISOString();
      periodStart = new Date(Date.now() - ms).toISOString();
    }

    setGenerating(true);
    setFormError("");
    const title = genTitle.trim();
    const res = await api.generateReport({
      type: genType,
      periodStart,
      periodEnd,
      ...(title ? { title } : {}),
      // NOT Number(): the room scope submits the string "room", and Number("room") is
      // NaN — which serialises to null and silently generates a campus-wide report
      // instead of the one that was asked for.
      ...(genDevice ? { deviceId: /^\d+$/.test(genDevice) ? Number(genDevice) : genDevice } : {}),
      // Omitted rather than guessed when the template hasn't loaded — the server's
      // default is the authority, and sending a wrong size would print the document
      // on a page nobody chose.
      ...(genPaper ? { paperSize: genPaper } : {}),
    });
    setGenerating(false);
    if (res.success && res.data?.report) {
      // 202: the row comes back `pending` and the backend builds it in the
      // background, flipping to generated (or failed) when `reportUpdated` arrives.
      //
      // upsert, NOT a prepend: `reportCreated` has almost certainly delivered this
      // same row over the socket already (see upsertReport). Still done here so the
      // row appears even if the socket is down.
      upsertReport(res.data.report as Report);
      setModalOpen(false);
      showToast("Generating report…");
    } else {
      setFormError(res.error || "Could not generate the report.");
    }
  };

  const download = async (r: Report, format: "csv" | "pdf") => {
    const key = `${r.id}-${format}`;
    setBusy((b) => ({ ...b, [key]: true }));
    const res = await api.downloadReport(r.id, format, downloadName(r, format));
    setBusy((b) => ({ ...b, [key]: false }));
    if (!res.success) showToast(res.error || "Download failed.", false);
  };

  const emailReport = async (r: Report) => {
    const key = `mail-${r.id}`;
    setBusy((b) => ({ ...b, [key]: true }));
    const res = await api.emailReport(r.id);
    setBusy((b) => ({ ...b, [key]: false }));
    if (res.success) showToast(`Sent to ${res.data?.sentTo ?? "your inbox"}.`);
    else showToast(res.error || "Could not send the email.", false);
  };

  const remove = async (id: number) => {
    setConfirmId(null);
    setBusy((b) => ({ ...b, [`del-${id}`]: true }));
    const res = await api.deleteReport(id);
    setBusy((b) => ({ ...b, [`del-${id}`]: false }));
    if (res.success) {
      setReports((p) => p.filter((r) => r.id !== id));
      showToast("Report deleted.");
    } else {
      showToast(res.error || "Delete failed.", false);
    }
  };

  // ─── derived ────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const total = reports.length;
    const generated = reports.filter((r) => r.status === "generated").length;
    const issues = reports.filter((r) => r.status !== "generated").length;
    const latest = reports.reduce<string | null>(
      (m, r) => (r.createdAt && (!m || r.createdAt > m) ? r.createdAt : m),
      null,
    );
    return { total, generated, issues, latest };
  }, [reports]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return reports.filter((r) => {
      if (typeFilter !== "all" && r.type !== typeFilter) return false;
      if (q) {
        // The control number is searchable: somebody reading a number off a printed
        // copy needs to be able to find that copy here.
        const hay = `${r.title} ${typeMeta(r.type).label} ${r.generatedByName ?? ""} ${r.referenceNo ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [reports, typeFilter, search]);

  const filtersActive = typeFilter !== "all" || search.trim() !== "";

  const selectCls = "text-[13px] px-2 py-1.5 rounded-[2px] outline-none cursor-pointer";

  // Row actions (CSV / PDF / email / delete), defined once and rendered by both the
  // table cell and the phone card, so a report cannot offer a different set of actions
  // depending on screen width.
  //
  // ⚠️ EVERY control here calls stopPropagation. Both layouts toggle the detail drawer
  // on click, so without it downloading a report would also open its drawer — and the
  // delete confirmation would reopen the row it is asking about.
  const reportActions = (r: Report) => {
    const ready = r.status === "generated";
    if (confirmId === r.id) {
      return (
        <span className="inline-flex items-center gap-1.5">
          <span className="text-[12px]" style={{ color: gf.textMuted }}>Delete?</span>
          <button onClick={(e) => { e.stopPropagation(); remove(r.id); }} className="gf-raise px-2 py-1 rounded-md text-[12px] font-medium" style={{ color: "#fff", background: RED }}>Yes</button>
          <button onClick={(e) => { e.stopPropagation(); setConfirmId(null); }} className="px-2 py-1 rounded-md text-[12px]" style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}>No</button>
        </span>
      );
    }
    return (
      <>
        <DownloadBtn label="CSV" disabled={!ready || !!busy[`${r.id}-csv`]} onClick={(e) => { e.stopPropagation(); download(r, "csv"); }} />
        <DownloadBtn label="PDF" disabled={!ready || !!busy[`${r.id}-pdf`]} onClick={(e) => { e.stopPropagation(); download(r, "pdf"); }} />
        {/* Mails the PDF to the signed-in user. Disabled until the background build has
            produced a file. Same raised/recessed rule as the download buttons beside it
            — a mixed row would read as three unrelated controls. */}
        <button
          onClick={(e) => { e.stopPropagation(); emailReport(r); }}
          disabled={!ready || !!busy[`mail-${r.id}`]}
          className={`grid place-items-center w-8 h-8 rounded-[3px] transition-all disabled:cursor-not-allowed ${ready ? "gf-btn" : ""}`}
          style={
            ready
              ? { color: gf.textPrimary }
              : {
                  color: gf.textDim,
                  background: gf.bg,
                  border: `1px solid ${gf.border}`,
                  boxShadow: "var(--gf-btn-shadow-active)",
                  opacity: 0.6,
                }
          }
          title={ready ? "Email this report to me (PDF)" : "Not ready to email yet"}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6.5h18v11H3zM3 7l9 6 9-6" />
          </svg>
        </button>
        {canDelete && (
          <button
            onClick={(e) => { e.stopPropagation(); setConfirmId(r.id); }}
            className="grid place-items-center w-7 h-7 rounded-md transition-colors"
            style={{ color: gf.textMuted }}
            title="Delete report"
            onMouseEnter={(e) => { e.currentTarget.style.background = `${RED}1f`; e.currentTarget.style.color = RED; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = gf.textMuted; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
            </svg>
          </button>
        )}
      </>
    );
  };

  return (
    <div className="p-4 lg:p-6" style={{ fontFamily: "'JetBrains Mono', monospace" }}>
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-[16px] font-bold" style={{ color: gf.textPrimary }}>
            Reports
          </h1>
          <p className="text-[13px] mt-1 max-w-2xl" style={{ color: gf.textMuted }}>
            Generate summaries from live monitoring data and download them as{" "}
            <b style={{ color: gf.textPrimary }}>CSV</b> or <b style={{ color: gf.textPrimary }}>PDF</b>.
            Each report is saved and stays available for later.
          </p>
        </div>
        {canGenerate && (
          <button
            onClick={openModal}
            /* basis-full below `sm`: the button is ~160px of non-shrinking
               whitespace-nowrap, which on a 390px screen leaves the heading and its
               paragraph about 190px to wrap inside. Its own row reads better. */
            className="gf-btn inline-flex items-center gap-2 text-[14px] font-medium whitespace-nowrap basis-full justify-center sm:basis-auto sm:justify-start"
            style={{ height: 32, padding: "0 12px", color: "var(--gf-text-primary)" }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Generate report
          </button>
        )}
      </div>

      {/* Stat panels */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <StatCard label="Total reports" value={stats.total} color={gf.accent} />
        <StatCard label="Generated" value={stats.generated} color={GREEN} sub="ready to download" />
        <StatCard label="Pending / failed" value={stats.issues} color={stats.issues ? AMBER : gf.textDim} />
        <StatCard label="Last generated" text={fmtDateTime(stats.latest)} color={gf.accent} />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative flex-1 min-w-[180px]">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={gf.textDim} strokeWidth="2" strokeLinecap="round" className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input name="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by title, type or author…"
            className="w-full text-[13px] pl-8 pr-2 py-1.5 rounded-[2px] outline-none"
            style={inputStyle}
          />
        </div>
        <select name="typeFilter" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={selectCls} style={inputStyle}>
          <option value="all">All types</option>
          {TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        {filtersActive && (
          <button
            onClick={() => {
              setTypeFilter("all");
              setSearch("");
            }}
            className="text-[12px] px-2.5 py-1.5 rounded-[2px] transition-colors"
            style={{ color: gf.textMuted, border: `1px solid ${gf.border}`, background: "transparent" }}
          >
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      {loading ? (
        <div className="rounded-lg px-3 py-10 text-center text-[14px]" style={{ background: gf.panel, border: `1px solid ${gf.border}`, color: gf.textDim }}>
          Loading…
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState filtered={filtersActive} canGenerate={canGenerate} onGenerate={openModal} onClear={() => { setTypeFilter("all"); setSearch(""); }} />
      ) : (
        <div className="rounded-lg overflow-hidden" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
          {/* Phone: seven columns — four of them action buttons — is a sideways scroll,
              and CSV / PDF / email / delete are exactly what ends up off the right edge.
              Cards below `md`, the table unchanged from `md` up. The card opens the SAME
              drawer the row does, via the shared ReportDrawerBody. */}
          <div className="md:hidden">
            {filtered.map((r, i) => {
              const meta = typeMeta(r.type);
              const sc = STATUS_COLOR[r.status] ?? gf.textMuted;
              const open = openId === r.id;
              return (
                <div
                  key={r.id}
                  style={{
                    borderTop: i === 0 ? "none" : `1px solid ${gf.divider}`,
                    background: open ? gf.hover : "transparent",
                  }}
                >
                  {/* The toggle is on this inner block, not the whole card — tapping
                      inside an OPEN drawer must not close the thing you just opened. */}
                  <div
                    onClick={() => setOpenId((prev) => (prev === r.id ? null : r.id))}
                    className="flex flex-col gap-2 px-3 py-3 cursor-pointer"
                  >
                    <div className="flex items-start gap-2.5">
                      <span className="grid place-items-center rounded-md shrink-0" style={{ width: 28, height: 28, background: `${meta.color}1f`, color: meta.color }}>
                        <TypeIcon type={r.type} />
                      </span>
                      {/* break-words, not the table's `truncate max-w-[240px]`: the title
                          is what someone is scanning for, and a phone has no hover. */}
                      <span className="font-medium break-words flex-1 min-w-0" style={{ color: gf.textPrimary }}>
                        {r.title}
                      </span>
                      <span className="text-[12px] shrink-0 transition-transform" style={{ color: gf.textDim, transform: open ? "rotate(180deg)" : "none" }}>
                        ▾
                      </span>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[2px] text-[11px] tracking-wider uppercase font-semibold" style={{ color: meta.color, background: `${meta.color}1f` }}>
                        {meta.label}
                      </span>
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[2px] text-[11px] tracking-wider uppercase font-semibold" style={{ color: sc, background: `${sc}1f` }}>
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: sc }} />
                        {r.status}
                      </span>
                      {/* The control number stays on the collapsed card: searching this
                          page for a number read off a printout has to work on a phone
                          too, and it is the one field that identifies the filed copy. */}
                      {r.referenceNo && (
                        <span className="text-[11px] tracking-wider" style={{ color: gf.textDim }}>{r.referenceNo}</span>
                      )}
                    </div>

                    <div className="text-[11px] break-words" style={{ color: gf.textMuted }}>
                      {fmtPeriod(r)}
                      {r.deviceName ? ` · ${r.deviceName}` : ""}
                    </div>
                    <div className="text-[11px]" style={{ color: gf.textDim }}>
                      {fmtDateTime(r.createdAt)} · {r.generatedByName ?? "—"}
                    </div>

                    {/* flex-wrap: the four buttons fit a 390px card, but the delete
                        CONFIRMATION ("Delete?" / Yes / No) that replaces them does not. */}
                    <div className="flex items-center gap-1.5 flex-wrap pt-0.5">{reportActions(r)}</div>
                  </div>

                  <ReportDrawerBody report={r} isOpen={open} paperSizes={paperSizes} max={620} />
                </div>
              );
            })}
          </div>

          <div className="hidden md:block overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr style={{ background: gf.header }}>
                  {["Report", "Type", "Period", "Generated by", "Created", "Status", ""].map((h) => (
                    <th key={h} className="text-left px-3 py-2.5 text-[11px] tracking-widest uppercase font-semibold whitespace-nowrap" style={{ color: gf.textMuted, borderBottom: `1px solid ${gf.divider}` }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => {
                  const meta = typeMeta(r.type);
                  const sc = STATUS_COLOR[r.status] ?? gf.textMuted;
                  return (
                    <Fragment key={r.id}>
                    <tr
                      onClick={() => setOpenId((prev) => (prev === r.id ? null : r.id))}
                      className="cursor-pointer transition-colors"
                      style={{ borderTop: i === 0 ? "none" : `1px solid ${gf.divider}`, background: openId === r.id ? gf.hover : "transparent" }}
                    >
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <span className="grid place-items-center rounded-md shrink-0" style={{ width: 28, height: 28, background: `${meta.color}1f`, color: meta.color }}>
                            <TypeIcon type={r.type} />
                          </span>
                          <span className="font-medium truncate max-w-[240px]" style={{ color: gf.textPrimary }}>
                            {r.title}
                          </span>
                          {/* Same affordance as the servers table — without it there is
                              nothing to suggest the row does anything when clicked. */}
                          <span
                            className="text-[12px] shrink-0 transition-transform"
                            style={{ color: gf.textDim, transform: openId === r.id ? "rotate(180deg)" : "none" }}
                          >
                            ▾
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[2px] text-[11px] tracking-wider uppercase font-semibold" style={{ color: meta.color, background: `${meta.color}1f` }}>
                          {meta.label}
                        </span>
                        {/* Scope. A device deleted after the fact leaves deviceId set
                            but deviceName null (FK ON DELETE SET NULL clears the id) —
                            either way, absent means campus-wide. */}
                        {r.deviceName && (
                          <span className="block text-[11px] mt-1 truncate max-w-[150px]" style={{ color: gf.textDim }}>
                            {r.deviceName}
                          </span>
                        )}
                        {/* Control number. Shown under the title because this is what
                            ICTU will file and quote the document by — searching this
                            page for a number somebody read off a printout has to work. */}
                        {r.referenceNo && (
                          <span className="block text-[11px] mt-1 tracking-wider" style={{ color: gf.textDim }}>
                            {r.referenceNo}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: gf.textMuted }}>
                        {fmtPeriod(r)}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap truncate max-w-[140px]" style={{ color: gf.textMuted }}>
                        {r.generatedByName ?? "—"}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap" style={{ color: gf.textMuted }}>
                        {fmtDateTime(r.createdAt)}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[2px] text-[11px] tracking-wider uppercase font-semibold" style={{ color: sc, background: `${sc}1f` }}>
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: sc }} />
                          {r.status}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center justify-end gap-1.5">{reportActions(r)}</div>
                      </td>
                    </tr>
                    <ReportDrawerRow report={r} isOpen={openId === r.id} paperSizes={paperSizes} />
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Generate modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }} onClick={() => setModalOpen(false)}>
          {/* Wide and HORIZONTAL. Seven type cards stacked above the options made this
              taller than a laptop viewport, so the Generate button sat below the fold on
              the one screen whose whole purpose is pressing it. Side by side, the entire
              form is visible at once and the footer is pinned. */}
          <div onClick={(e) => e.stopPropagation()} className="w-full max-w-5xl max-h-[90vh] flex flex-col rounded-[2px] overflow-hidden" style={{ background: gf.panel, border: `1px solid ${gf.border}`, boxShadow: "var(--gf-shadow)" }}>
            <div className="flex items-center justify-between px-3 shrink-0" style={{ height: 44, borderBottom: `1px solid ${gf.divider}`, background: gf.header }}>
              {/* Tabs. The template settings used to be a panel under the report list,
                  which put configuration that changes a few times a year permanently
                  below the thing people come here to read. Behind a tab, the page is
                  what its name says: a list of generated reports. */}
              {/* min-w-0 + overflow-x-auto, and the close button below is shrink-0: the
                  two tab labels come to ~265px, which on a 360px phone leaves almost
                  nothing for the X. Squeezing it out of a modal that also closes on Esc
                  and on a backdrop tap would still be a dead end on a touch screen,
                  where neither exists. The tabs scroll instead. */}
              <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
                {(
                  [
                    ["generate", "Generate report"],
                    ...(role === "admin" ? [["template", "Report template"]] : []),
                  ] as [string, string][]
                ).map(([id, label]) => {
                  const on = modalTab === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setModalTab(id as "generate" | "template")}
                      className="text-[13px] font-semibold tracking-wide px-3 py-1.5 rounded-[3px] transition-all whitespace-nowrap shrink-0"
                      style={
                        on
                          ? { color: gf.textPrimary, background: gf.hover, boxShadow: `inset 0 -2px 0 ${gf.accent}` }
                          : { color: gf.textMuted, background: "transparent" }
                      }
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
              <button onClick={() => setModalOpen(false)} className="grid place-items-center w-7 h-7 rounded-md shrink-0 ml-2" style={{ color: gf.textMuted }} title="Close (Esc)">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-4 overflow-y-auto flex-1">
            {modalTab === "generate" ? (
              <div className="grid gap-5 lg:grid-cols-[1.15fr_1fr] items-start">
              {/* ── Left: what kind of report ── */}
              <div>
              {/* Type cards */}
              <div className="text-[11px] tracking-wider uppercase mb-1.5" style={{ color: gf.textDim }}>Report type</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
                {TYPES.map((t) => {
                  const on = genType === t.value;
                  return (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => setGenType(t.value)}
                      className={`flex items-start gap-2.5 text-left px-3 py-2.5 rounded-[3px] transition-all ${on ? "gf-btn" : ""}`}
                      style={
                        on
                          // The type's own colour still tints the chosen card, but the
                          // RAISED surface is what makes the selection legible without it.
                          ? { borderColor: t.color, boxShadow: `var(--gf-btn-shadow), inset 0 0 0 1px ${t.color}55` }
                          : { background: gf.bg, border: `1px solid ${gf.border}`, boxShadow: "var(--gf-btn-shadow-active)" }
                      }
                    >
                      <span className="grid place-items-center rounded-md shrink-0 mt-0.5" style={{ width: 30, height: 30, background: `${t.color}1f`, color: t.color }}>
                        <TypeIcon type={t.value} />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[14px] font-semibold" style={{ color: on ? t.color : gf.textPrimary }}>{t.label}</span>
                        <span className="block text-[12px] leading-snug mt-0.5" style={{ color: gf.textMuted }}>{t.desc}</span>
                      </span>
                    </button>
                  );
                })}
              </div>

              </div>

              {/* ── Right: what it should cover ── */}
              <div>
              {/* Device scope — only rendered for types the backend says are
                  scopeable. Environment returns no options (one server room), so the
                  control disappears rather than offering a meaningless choice. */}
              {scopeDevices.length > 0 && (
                <div className="mb-3">
                  <Field label="Device (optional)">
                    <select name="genDevice"
                      value={genDevice}
                      onChange={(e) => setGenDevice(e.target.value)}
                      className={selectCls}
                      style={{ ...inputStyle, width: "100%" }}
                    >
                      <option value="">All devices</option>
                      {scopeDevices.map((d) => (
                        <option key={d.id} value={String(d.id)}>
                          {d.name} — {deviceTypeLabel(d.type)}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              )}

              {/* Title */}
              <Field label="Title (optional)">
                <input name="genTitle"
                  value={genTitle}
                  onChange={(e) => setGenTitle(e.target.value)}
                  placeholder={`${typeMeta(genType).label} Report${
                    genDevice ? ` — ${scopeDevices.find((d) => String(d.id) === genDevice)?.name ?? ""}` : ""
                  }`}
                  className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none"
                  style={inputStyle}
                />
              </Field>

              {/* Date range */}
              <div className="mt-3">
                <div className="text-[11px] tracking-wider uppercase mb-1.5" style={{ color: gf.textDim }}>Period</div>
                <div className="flex flex-wrap gap-1.5">
                  {RANGES.map((r) => {
                    const on = rangeMode === r.value;
                    return (
                      <button
                        key={r.value}
                        type="button"
                        onClick={() => setRangeMode(r.value)}
                        className={`text-[12px] px-3 py-1.5 rounded-[3px] transition-all ${on ? "gf-btn" : ""}`}
                        style={
                          on
                            // Neutral, not accent: a period is a filter, not an action, and
                            // it should not compete with Generate for the eye.
                            ? { color: gf.textPrimary, fontWeight: 700 }
                            : { color: gf.textMuted, background: gf.bg, border: `1px solid ${gf.border}`, boxShadow: "var(--gf-btn-shadow-active)" }
                        }
                      >
                        {r.label}
                      </button>
                    );
                  })}
                </div>
                {rangeMode === "custom" && (
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <Field label="Start">
                      <input name="customStart" type="date" value={customStart} max={customEnd || todayStr()} onChange={(e) => setCustomStart(e.target.value)} className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                    </Field>
                    <Field label="End">
                      <input name="customEnd" type="date" value={customEnd} min={customStart} max={todayStr()} onChange={(e) => setCustomEnd(e.target.value)} className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none" style={inputStyle} />
                    </Field>
                  </div>
                )}
              </div>

              {/* Paper size — per report, because ICTU asked to choose it rather than
                  have one baked in. Defaults to whatever an admin set (Folio out of
                  the box), so the common case is still one click. */}
              <div className="mt-3">
                <Field label="Paper size">
                  <select
                    name="genPaper"
                    value={genPaper}
                    onChange={(e) => { setGenPaper(e.target.value as PaperSizeKey); paperTouched.current = true; }}
                    className={selectCls}
                    style={{ ...inputStyle, width: "100%" }}
                  >
                    {Object.entries(paperSizes).map(([key, meta]) => (
                      <option key={key} value={key}>
                        {meta.label} — {meta.inches}
                        {template?.paperSize === key ? " (default)" : ""}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>

              {formError && (
                <div className="text-[12px] mt-3" style={{ color: RED }}>{formError}</div>
              )}
              </div>
              </div>
            ) : (
              /* ── Report template ── */
              // Two siblings — the settings grid and the signature block — so the
              // branch needs a fragment root.
              <>
              <div className="grid gap-5 md:grid-cols-3 items-start">
                {/* Paper size + letterhead wording */}
                <div>
                  <div className="text-[11px] tracking-wider uppercase mb-1.5" style={{ color: gf.textDim }}>
                    Paper size
                  </div>
                  <select
                    name="defaultPaper"
                    value={template?.paperSize ?? ""}
                    disabled={!template || templateBusy === "paper"}
                    onChange={(e) => changePaperDefault(e.target.value as PaperSizeKey)}
                    className={`${selectCls} gf-btn`}
                    style={{ width: "100%", color: gf.textPrimary, fontFamily: "'JetBrains Mono', monospace" }}
                  >
                    {Object.entries(paperSizes).map(([key, meta]) => (
                      <option key={key} value={key}>
                        {meta.label} — {meta.inches}
                      </option>
                    ))}
                  </select>

                  {/* The placeholder carries the default, so "clear to restore it"
                      needs no caption of its own. */}
                  <div className="text-[11px] tracking-wider uppercase mt-4 mb-1.5" style={{ color: gf.textDim }}>
                    Letterhead line
                  </div>
                  <input
                    name="unitName"
                    value={unitDraft}
                    disabled={!template || templateBusy === "unit"}
                    onChange={(e) => setUnitDraft(e.target.value)}
                    onBlur={commitUnitName}
                    onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    placeholder={template?.unitNameDefault ?? ""}
                    maxLength={120}
                    className="w-full text-[13px] px-2 py-1.5 rounded-[2px] outline-none"
                    style={inputStyle}
                  />
                </div>

                {/* Logos */}
                {(["cspc", "ictu"] as const).map((slot) => {
                  const info = template?.logos?.[slot];
                  const busy = templateBusy === `logo-${slot}`;
                  return (
                    <div key={slot}>
                      <div className="text-[11px] tracking-wider uppercase mb-1.5" style={{ color: gf.textDim }}>
                        {slot.toUpperCase()} logo
                      </div>
                      {/* One line, not three: a filename and a date already say "this is
                          yours and it is current" without a sentence saying so. */}
                      <div
                        className="text-[12px] px-2.5 py-2 rounded-[2px] mb-2 truncate"
                        style={{ background: gf.bg, border: `1px solid ${gf.border}`, color: gf.textMuted }}
                        title={info?.uploaded ? `${info.originalName ?? info.file} · stored as ${info.file} · ${fmtDateTime(info.updatedAt)}` : "Bundled placeholder"}
                      >
                        {info?.uploaded ? (
                          <>
                            {/* The name the admin uploaded, not the fixed name it is
                                stored under — "cspc-logo.png" is a name nobody chose,
                                and made two different seals look identical. Hover for
                                the stored name and the time. */}
                            <span style={{ color: GREEN }}>●</span> {info.originalName ?? info.file}
                            <span style={{ color: gf.textDim }}> · {fmtDateTime(info.updatedAt)}</span>
                          </>
                        ) : (
                          <span style={{ color: gf.textDim }}>Bundled placeholder</span>
                        )}
                      </div>

                      {/* accept= is a convenience only — the backend identifies the file
                          by its leading bytes, so a renamed .exe is refused regardless. */}
                      <input
                        ref={(el) => { logoInput.current[slot] = el; }}
                        type="file"
                        accept="image/png,image/jpeg"
                        className="hidden"
                        onChange={(e) => {
                          uploadLogo(slot, e.target.files?.[0] ?? null);
                          e.target.value = ""; // re-selecting the same file must still fire
                        }}
                      />
                      {/* flex-wrap: Replace + Remove + the "PNG / JPEG · 2 MB" hint come
                          to ~260px, and once the grid collapses to ONE column on a phone
                          the hint is what gets pushed out — the line that says which
                          files will be accepted, next to the button that accepts them. */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => logoInput.current[slot]?.click()}
                          className="gf-btn text-[12px] px-3 py-1.5 rounded-[3px]"
                          style={{ color: gf.textPrimary, opacity: busy ? 0.6 : 1 }}
                        >
                          {busy ? "Working…" : info?.uploaded ? "Replace" : "Upload"}
                        </button>
                        {info?.uploaded && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => removeLogo(slot)}
                            className="gf-btn text-[12px] px-3 py-1.5 rounded-[3px]"
                            style={{ color: RED, opacity: busy ? 0.6 : 1 }}
                          >
                            Remove
                          </button>
                        )}
                        <span className="text-[11px] ml-auto" style={{ color: gf.textDim }}>PNG / JPEG · 2 MB</span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* ── Signature block ── */}
              <div className="mt-5 pt-4" style={{ borderTop: `1px solid ${gf.divider}` }}>
                <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                  <span className="text-[11px] tracking-wider uppercase" style={{ color: gf.textDim }}>
                    Signature lines
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={sigDraft.length >= MAX_SIGNATORIES}
                      onClick={() => setSigDraft((d) => [...d, { role: "", name: "", auto: false }])}
                      className="gf-btn text-[12px] px-3 py-1.5 rounded-[3px] disabled:opacity-40"
                      style={{ color: gf.textPrimary }}
                      title={sigDraft.length >= MAX_SIGNATORIES ? `Maximum ${MAX_SIGNATORIES} lines` : "Add a signature line"}
                    >
                      + Add line
                    </button>
                    {/* Only offered once something has actually changed, so the
                        block cannot be re-saved by accident. */}
                    {sigDirty && (
                      <button
                        type="button"
                        disabled={templateBusy === "sig"}
                        onClick={commitSignatories}
                        className="gf-raise text-[12px] font-bold px-3 py-1.5 rounded-[3px] disabled:opacity-50"
                        style={{ color: "#fff", background: gf.accent, border: `1px solid ${gf.accent}` }}
                      >
                        {templateBusy === "sig" ? "Saving…" : "Save"}
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid gap-2">
                  {sigDraft.map((sig, i) => {
                    const set = (patch: Partial<Signatory>) =>
                      setSigDraft((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                    return (
                      // ⚠️ flex-wrap + a real min-width on both inputs. This row was two
                      // `flex-1 min-w-0` fields beside a fixed ~90px of Auto checkbox and
                      // ✕ button: inside the modal on a 390px phone that left each field
                      // about 105px, so "Name (blank = sign by hand)" showed as roughly
                      // "Name (blank…" and the field you type a person's title into could
                      // not display the title. min-w-[180px] makes them wrap to their own
                      // lines there while staying on one row from tablet up, where the
                      // modal is wide enough that nothing changes.
                      <div key={i} className="flex flex-wrap items-center gap-2">
                        <input
                          value={sig.role}
                          onChange={(e) => set({ role: e.target.value })}
                          placeholder="Prepared by:"
                          maxLength={60}
                          className="text-[13px] px-2 py-1.5 rounded-[2px] outline-none flex-1 min-w-[180px]"
                          style={inputStyle}
                        />
                        {/* Disabled rather than hidden when auto is on, so the row
                            keeps its shape — and the placeholder says WHOSE name will
                            print. Showing the current admin's name here would be wrong:
                            it is filled per report, from whoever generates that one. */}
                        <input
                          value={sig.auto ? "" : sig.name}
                          onChange={(e) => set({ name: e.target.value })}
                          disabled={sig.auto}
                          placeholder={sig.auto ? "Whoever generates the report" : "Name (blank = sign by hand)"}
                          maxLength={60}
                          className="text-[13px] px-2 py-1.5 rounded-[2px] outline-none flex-1 min-w-[180px] disabled:opacity-60"
                          style={inputStyle}
                        />
                        <label className="flex items-center gap-1.5 text-[12px] shrink-0 cursor-pointer" style={{ color: gf.textMuted }} title="Print the name of whoever generated the report">
                          <input
                            type="checkbox"
                            checked={sig.auto}
                            onChange={(e) => set({ auto: e.target.checked })}
                          />
                          Auto
                        </label>
                        <button
                          type="button"
                          disabled={sigDraft.length <= 1}
                          onClick={() => setSigDraft((d) => d.filter((_, j) => j !== i))}
                          className="gf-btn text-[12px] px-2.5 py-1.5 rounded-[3px] shrink-0 disabled:opacity-40"
                          style={{ color: RED }}
                          title={sigDraft.length <= 1 ? "At least one line is required" : "Remove this line"}
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
              </>
            )}
            </div>

            {/* Footer — outside the scroll area, so the primary action is reachable
                whatever the body's height. */}
            <div className="flex gap-2 px-4 py-3 shrink-0" style={{ borderTop: `1px solid ${gf.divider}`, background: gf.header }}>
              {modalTab === "generate" ? (
                <>
                  <button
                    onClick={handleGenerate}
                    disabled={generating}
                    className="gf-raise inline-flex items-center gap-2 text-[13px] font-bold px-5 py-2.5 rounded-[3px] transition-all active:scale-95 disabled:opacity-50"
                    // The one primary action on the page, so it keeps the accent AND the
                    // strongest lift — everything around it is now neutral by design.
                    style={{
                      color: "#fff",
                      background: gf.accent,
                      border: `1px solid ${gf.accent}`,
                      boxShadow: "0 2px 6px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.25)",
                    }}
                  >
                    {generating && (
                      <svg width="13" height="13" viewBox="0 0 24 24" className="animate-spin" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                        <path d="M12 3a9 9 0 1 0 9 9" />
                      </svg>
                    )}
                    {generating ? "Generating…" : "Generate"}
                  </button>
                  <button
                    onClick={() => setModalOpen(false)}
                    className="text-[13px] font-medium px-5 py-2.5 rounded-[3px] transition-all active:scale-95"
                    // Recessed on purpose: the way out, not a peer of the action that does
                    // the work. Raising both would make the pair ambiguous.
                    style={{
                      color: gf.textMuted,
                      border: `1px solid ${gf.border}`,
                      background: gf.bg,
                      boxShadow: "var(--gf-btn-shadow-active)",
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                // Template changes save as they are made (a select, a blur, an upload),
                // so there is nothing here to confirm — only a way out.
                <button
                  onClick={() => setModalOpen(false)}
                  className="text-[13px] font-medium px-5 py-2.5 rounded-[3px] transition-all active:scale-95"
                  style={{
                    color: gf.textMuted,
                    border: `1px solid ${gf.border}`,
                    background: gf.bg,
                    boxShadow: "var(--gf-btn-shadow-active)",
                  }}
                >
                  Done
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div
          className="fixed top-5 right-5 z-[100] flex items-center gap-2 px-4 py-3 rounded-[2px] border text-xs shadow-xl"
          style={{
            color: toast.ok ? GREEN : RED,
            background: toast.ok ? `${GREEN}14` : `${RED}14`,
            borderColor: toast.ok ? `${GREEN}40` : `${RED}40`,
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          <span>{toast.ok ? "✓" : "✕"}</span> {toast.msg}
        </div>
      )}
    </div>
  );
}

// ─── small components ─────────────────────────────────────────────────────────
function StatCard({ label, value, text, color, sub }: { label: string; value?: number; text?: string; color: string; sub?: string }) {
  return (
    <div className="relative overflow-hidden rounded-lg flex flex-col" style={{ background: gf.panel, border: `1px solid ${gf.border}`, minHeight: 84 }}>
      <div className="flex items-center justify-between px-3 pt-2.5">
        <span className="text-[12px] tracking-widest uppercase truncate" style={{ color: gf.textMuted }}>{label}</span>
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
      </div>
      <div className="px-3 pt-1.5 pb-3">
        {text !== undefined ? (
          <span className="text-[14px] font-bold leading-tight" style={{ color }}>{text}</span>
        ) : (
          <span className="text-[28px] font-bold leading-none" style={{ color }}>{value}</span>
        )}
        {sub && <div className="text-[11px] mt-1.5 tracking-widest uppercase" style={{ color: gf.textDim }}>{sub}</div>}
      </div>
    </div>
  );
}

// Raised while the file exists, recessed while it does not — the same rule the rest of the
// UI follows: a raised surface means "this will do something". A report still building has
// nothing to download, and a flat, sunken button says that before the cursor gets there.
//
// The hover/press states come from .gf-btn's own CSS (already scoped to :not(:disabled)),
// which replaces the hand-rolled onMouseEnter/onMouseLeave handlers this had — those also
// hardcoded the accent, so they fought the theme in light mode.
// onClick takes the EVENT: the row it sits in is now a click target that toggles the
// detail drawer, so every action inside it has to be able to stop the propagation.
function DownloadBtn({ label, disabled, onClick }: {
  label: string;
  disabled?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[3px] text-[12px] font-semibold transition-all disabled:cursor-not-allowed ${disabled ? "" : "gf-btn"}`}
      style={
        disabled
          ? {
              color: gf.textDim,
              background: gf.bg,
              border: `1px solid ${gf.border}`,
              boxShadow: "var(--gf-btn-shadow-active)",
              opacity: 0.6,
            }
          : { color: gf.textPrimary }
      }
      title={disabled ? `${label} not ready yet` : `Download ${label}`}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
      </svg>
      {label}
    </button>
  );
}

function EmptyState({ filtered, canGenerate, onGenerate, onClear }: { filtered: boolean; canGenerate: boolean; onGenerate: () => void; onClear: () => void }) {
  return (
    <div className="rounded-lg px-4 py-12 flex flex-col items-center text-center" style={{ background: gf.panel, border: `1px solid ${gf.border}` }}>
      <span className="grid place-items-center rounded-full mb-3" style={{ width: 44, height: 44, background: gf.accentDim, color: gf.accent }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6M9 13h6M9 17h6M9 9h1" />
        </svg>
      </span>
      {filtered ? (
        <>
          <div className="text-[15px] font-semibold mb-1" style={{ color: gf.textPrimary }}>No reports match your filters</div>
          <div className="text-[13px] mb-4" style={{ color: gf.textMuted }}>Try a different search or clear the filters.</div>
          <button onClick={onClear} className="text-[13px] font-medium px-3 py-1.5 rounded-md" style={{ color: gf.textMuted, border: `1px solid ${gf.border}` }}>Clear filters</button>
        </>
      ) : (
        <>
          <div className="text-[15px] font-semibold mb-1" style={{ color: gf.textPrimary }}>No reports yet</div>
          <div className="text-[13px] mb-4 max-w-sm" style={{ color: gf.textMuted }}>
            {canGenerate ? "Summarise environment, server, network, UPS, alert or aircon activity for any window — or project what runs out next with a capacity forecast." : "No reports have been generated yet."}
          </div>
          {canGenerate && (
            <button onClick={onGenerate} className="gf-btn text-[13px] font-semibold px-3 py-1.5" style={{ color: gf.textPrimary }}>+ Generate your first report</button>
          )}
        </>
      )}
    </div>
  );
}

function TypeIcon({ type, size = 15 }: { type: string; size?: number }) {
  const p = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (type) {
    case "environment":
      return (
        <svg {...p}>
          <path d="M14 14.76V5a2 2 0 0 0-4 0v9.76a4 4 0 1 0 4 0z" />
        </svg>
      );
    case "server":
      return (
        <svg {...p}>
          <rect x="3" y="4" width="18" height="7" rx="1" />
          <rect x="3" y="13" width="18" height="7" rx="1" />
          <path d="M7 7.5h.01M7 16.5h.01" />
        </svg>
      );
    // Stacked switch + link — matches the Network nav icon in the sidebar.
    case "network":
      return (
        <svg {...p}>
          <rect x="2" y="3" width="20" height="6" rx="1.5" />
          <rect x="2" y="15" width="20" height="6" rx="1.5" />
          <path d="M12 9v6M5.5 6h.01M5.5 18h.01" />
        </svg>
      );
    // Battery + bolt — matches the UPS nav icon.
    case "ups":
      return (
        <svg {...p}>
          <rect x="2" y="5" width="19" height="14" rx="2" />
          <path d="M13 8.5 9.5 12.5h3L11 15.5" />
        </svg>
      );
    case "alerts":
      return (
        <svg {...p}>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
      );
    case "aircon":
      return (
        <svg {...p}>
          <path d="M12 2v20M2 12h20M5 5l14 14M19 5 5 19" />
        </svg>
      );
    // Rising trend + arrow — matches the Analytics nav icon.
    case "forecast":
      return (
        <svg {...p}>
          <path d="M3 20V4M3 20h18" />
          <path d="M6 15l4-4 3 3 6-6" />
          <path d="M15 8h4v4" />
        </svg>
      );
    default:
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
  }
}
