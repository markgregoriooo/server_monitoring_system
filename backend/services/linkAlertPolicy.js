// ─── When is a port without a link a fault? ───────────────────────────
// No imports, so backend/tests covers every case.
//
// An empty socket is always down and is not news. A port alerts only when all four
// of these hold, all from data that survives a restart:
//
//   monitored  not muted by ICTU (network_interfaces.monitor_link, on by default),
//              for ports that flap on purpose, like a lab bench.
//   adminUp    enabled; RouterOS `disabled=yes` / ifAdminStatus=down is a port
//              switched off on purpose.
//   linkUp     no carrier right now. null/undefined means the poll could not tell,
//              and an unknown is never treated as an outage.
//   everUp     has carried a link before (network_interfaces.ever_up), so an empty
//              socket is not a fault but a port that went dark is.
//
// Flapping is handled by alertBandState (ALERT_RECOVERY_SAMPLES), not here.

// True when a port's lack of carrier is a genuine fault worth an alert.
// Anything unknown (null / undefined linkUp) is NOT a fault.
export function isLinkFault({ adminUp, linkUp, everUp, monitored } = {}) {
  if (monitored === false) return false; // silenced by an admin
  if (adminUp === false) return false; // switched off on purpose
  if (linkUp !== false) return false; // up, or the poll couldn't tell
  return everUp === true; // never carried a link ⇒ empty socket, not a fault
}

// Why a port is or is not alerting, for the port editor and `npm run link:check`.
export function linkAlertReason({ adminUp, linkUp, everUp, monitored } = {}) {
  if (monitored === false) return "silenced";
  if (adminUp === false) return "disabled";
  if (linkUp === true) return "up";
  if (linkUp !== false) return "unknown";
  if (everUp !== true) return "never-connected";
  return "down";
}

// One-line copy for each reason, shown next to a port so the state is self-explaining.
export const LINK_REASON_TEXT = {
  up: "Link up",
  down: "Link down — alerting",
  disabled: "Disabled in RouterOS — not alerting",
  silenced: "Monitoring off for this port — not alerting",
  "never-connected": "Never connected — not alerting",
  unknown: "Link state unknown — not alerting",
};

export default { isLinkFault, linkAlertReason, LINK_REASON_TEXT };
