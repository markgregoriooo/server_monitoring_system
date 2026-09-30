// ─────────────────────────────────────────────────────────────────────────────
// Dry run of the predictive-alerting job: prints what analyticsAlerts.js would raise
// and raises nothing (no alerts, bell or email). The job runs every 6 hours and
// usually raises nothing, so this tells "broken" apart from "nothing to report".
//
//     cd backend && npm run analytics:check
// ─────────────────────────────────────────────────────────────────────────────

import "../config/env.js";
import analyticsService from "../services/analyticsService.js";

// Kept in step with analyticsAlerts.js — same env vars, same defaults, so the
// thresholds reported here are the ones the real job would apply.
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const CRITICAL_DAYS = num(process.env.ANALYTICS_ALERT_CRITICAL_DAYS, 7);
const WARNING_DAYS = num(process.env.ANALYTICS_ALERT_WARNING_DAYS, 30);
const DISK_DAYS = num(process.env.ANALYTICS_ALERT_DISK_DAYS, 30);
const LINK_DAYS = num(process.env.ANALYTICS_ALERT_LINK_DAYS, 90);
const UPS_DAYS = num(process.env.ANALYTICS_ALERT_UPS_DAYS, 180);

const verdict = (etaDays) => {
  if (etaDays == null) return "—";
  if (etaDays <= CRITICAL_DAYS) return "CRITICAL";
  if (etaDays <= WARNING_DAYS) return "warning";
  return "— (beyond the warning horizon)";
};

const pad = (v, n) => String(v ?? "—").padEnd(n);
const line = (s) => console.log(s);

async function main() {
  line("");
  line(`Predictive alerting — DRY RUN (nothing will be raised)`);
  line(`Thresholds: ETA <= ${CRITICAL_DAYS}d critical, <= ${WARNING_DAYS}d warning`);

  let wouldRaise = 0;

  // ── Disk ──
  line("");
  line("DISK (lookback " + DISK_DAYS + "d)");
  const disks = await analyticsService.forecastDiskFull({ lookbackDays: DISK_DAYS });
  if (!disks.length) line("  (no servers with disk history)");
  for (const d of disks) {
    const v = d.status === "full" ? "CRITICAL" : verdict(d.status === "filling" ? d.etaDays : null);
    if (v === "CRITICAL" || v === "warning") wouldRaise++;
    line(`  ${pad(d.name, 22)} ${pad(d.mount ?? "root", 8)} ${pad(d.currentPercent + "%", 7)} ` +
         `${pad(d.status, 18)} eta=${pad(d.etaDays, 7)} history=${pad(d.historyDays + "d", 8)} -> ${v}`);
  }

  // ── UPS ──
  line("");
  line("UPS BATTERY (lookback " + UPS_DAYS + "d)");
  const upses = await analyticsService.forecastUpsBattery({ lookbackDays: UPS_DAYS });
  if (!upses.length) line("  (no UPS with runtime history)");
  for (const u of upses) {
    const v = u.status === "reached" ? "CRITICAL" : verdict(u.status === "declining" ? u.etaDays : null);
    if (v === "CRITICAL" || v === "warning") wouldRaise++;
    line(`  ${pad(u.name, 22)} runtime=${pad(u.currentRuntimeMin + "min", 8)} ` +
         `${pad(u.status, 18)} eta=${pad(u.etaDays, 7)} history=${pad(u.historyDays + "d", 8)} ` +
         `battery=${pad(u.batteryStatusWorst, 9)} -> ${v}`);
  }

  // ── Link ──
  line("");
  line("LINK SATURATION (lookback " + LINK_DAYS + "d)");
  const links = await analyticsService.forecastLinkSaturation({ lookbackDays: LINK_DAYS });
  if (!links.length) line("  (no interfaces with traffic history)");
  for (const l of links) {
    const v = l.status === "reached" ? "CRITICAL" : verdict(l.status === "rising" ? l.etaDays : null);
    if (v === "CRITICAL" || v === "warning") wouldRaise++;
    line(`  ${pad(l.name, 22)} ${pad(l.interfaceLabel ?? l.interface, 14)} ${pad(l.currentUtil + "%", 7)} ` +
         `${pad(l.status, 18)} eta=${pad(l.etaDays, 7)} history=${pad(l.historyDays + "d", 8)} -> ${v}`);
  }

  line("");
  if (wouldRaise === 0) {
    line("Result: nothing would be raised.");
    line("On a healthy system that is the CORRECT outcome — every series is stable, so");
    line("there is no ETA inside the warning horizon. It does not mean alerting is broken.");
    line("A row reading 'insufficient_data' or a small 'history' means that device simply");
    line("has not reported long enough yet (see predictive-analytics.md sections 4 and 6).");
  } else {
    line(`Result: ${wouldRaise} alert(s) would be raised on the next scheduled pass.`);
  }
  line("");
}

main()
  .catch((e) => { console.error("analytics:check failed:", e.message); process.exitCode = 1; })
  .finally(() => process.exit());
