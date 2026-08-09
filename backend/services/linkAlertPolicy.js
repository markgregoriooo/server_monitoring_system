// ─── When is a port with no carrier actually a FAULT? ───────────────────────────
//
// PURE and import-free (like serverMetricUtils / historyRange / analyticsMath) so
// backend/tests can exercise every case with no MySQL, no InfluxDB and no .env.
//
// "No carrier" and "something is wrong" are not the same thing, and conflating them is
// what made interface-down alerting unusable: on a 5-port router with 3 empty sockets,
// three ports are permanently down and none of it is news. The old code alerted on any
// falsy linkUp and then leaned on an in-memory "first sighting" baseline to hide the
// noise — which meant the set of ports that could alert was decided by whatever the
// cables happened to be doing the second the backend last booted, and was silently
// re-rolled on every restart.
//
// Four questions decide it instead, each answerable from data that outlives the process:
//
//   monitored  Has ICTU explicitly silenced this port? (network_interfaces.monitor_link)
//              The escape hatch for a port that legitimately flaps — a lab bench, a
//              spare drop, a desk someone unplugs nightly. Default on: nothing goes
//              quiet unless a human asked for it.
//
//   adminUp    Is the port administratively ENABLED? RouterOS `disabled=yes` (IF-MIB
//              ifAdminStatus=down) is an operator switching a port off on purpose. It
//              used to be the LOUDEST alert in the system, which is backwards — you
//              cannot be paged for the state you deliberately configured. Disabling
//              unused ports is also the standard way to keep a switch quiet, so this
//              is the lever an admin reaches for first.
//
//   linkUp     Is there a carrier right now? `null`/undefined means the poll couldn't
//              tell (a RouterOS field that moved, an SNMP row that didn't answer), and
//              an unknown is never escalated into a fault — a monitoring gap must not
//              masquerade as an outage.
//
//   everUp     Has this port EVER carried a link? (network_interfaces.ever_up, set by
//              the pollers the first time they see it running.) An empty socket that
//              has never had a cable in it is not a fault; a port that used to carry a
//              building and went dark is the entire point of the feature. This is the
//              honest version of the old boot-time baseline: same intent, but it is a
//              fact about the port rather than a fact about when the process started.
//
// A port only alerts when all four line up. Note what this deliberately does NOT do:
// there is no "recently up" window and no flap counter here — damping a bouncing link
// is alertBandState's job (ALERT_RECOVERY_SAMPLES), and duplicating it would give two
// places to look when a link is too quiet.

// True when a port's lack of carrier is a genuine fault worth an alert.
// Anything unknown (null / undefined linkUp) is NOT a fault.
export function isLinkFault({ adminUp, linkUp, everUp, monitored } = {}) {
  if (monitored === false) return false; // silenced by an admin
  if (adminUp === false) return false; // switched off on purpose
  if (linkUp !== false) return false; // up, or the poll couldn't tell
  return everUp === true; // never carried a link ⇒ empty socket, not a fault
}

// Why a port is (or isn't) alerting, for the port editor and for `npm run link:check`.
// Explaining silence matters as much as raising the alert: "ether3 is down and quiet"
// is alarming until you can see it is quiet because it has never had a cable in it.
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
