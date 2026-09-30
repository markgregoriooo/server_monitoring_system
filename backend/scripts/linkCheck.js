// npm run link:check ─ why each port is alerting or not.
//
// Interface-down alerting is mostly silent (empty sockets are always down), so this
// prints every port's live state next to the rule that decided it. Read-only: polls
// the devices and reads network_interfaces, but raises and writes nothing.

import "../config/env.js";
import db from "../config/mysql.js";
import mikrotikPoller from "../services/mikrotikPollerService.js";
import { linkAlertReason, LINK_REASON_TEXT } from "../services/linkAlertPolicy.js";

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

const TINT = {
  down: C.red,
  up: C.green,
  disabled: C.dim,
  silenced: C.dim,
  "never-connected": C.dim,
  unknown: C.yellow,
};

async function gateFor(deviceId) {
  const [rows] = await db.query(
    `SELECT interface_name, location_label, ever_up, monitor_link
       FROM network_interfaces WHERE device_id = ?`,
    [deviceId],
  );
  const m = new Map();
  for (const r of rows) {
    m.set(r.interface_name, {
      label: r.location_label ?? "",
      everUp: Boolean(r.ever_up),
      monitored: r.monitor_link !== 0,
    });
  }
  return m;
}

async function main() {
  const devices = await mikrotikPoller.loadDevices();
  if (!devices.length) {
    console.log(C.yellow("No pollable MikroTik devices (need an IP + API username)."));
    return;
  }

  for (const d of devices) {
    console.log(`\n${C.bold(d.name)} ${C.dim(`(${d.ip}, device_id ${d.id})`)}`);

    let sample;
    try {
      sample = await mikrotikPoller.collect(d, {});
    } catch (err) {
      console.log(`  ${C.red("unreachable")} — ${err.message}`);
      continue;
    }

    const gate = await gateFor(d.id);
    let alerting = 0;

    for (const i of sample.interfaces) {
      const g = gate.get(i.name) ?? { label: "", everUp: false, monitored: true };
      const reason = linkAlertReason({
        adminUp: i.adminUp,
        linkUp: i.linkUp,
        everUp: g.everUp,
        monitored: g.monitored,
      });
      if (reason === "down") alerting++;
      const tint = TINT[reason] ?? ((s) => s);
      const name = i.name.padEnd(10);
      const label = g.label ? C.dim(` ${g.label}`) : "";
      console.log(`  ${name} ${tint(LINK_REASON_TEXT[reason])}${label}`);
    }

    const empty = sample.interfaces.filter(
      (i) => !(gate.get(i.name)?.everUp) && i.linkUp !== true,
    ).length;
    console.log(
      C.dim(
        `  → ${alerting} port(s) would alert; ` +
          `${empty} down but never connected (see migration 2026-08-09_link_alert_gate.sql)`,
      ),
    );
  }
}

main()
  .catch((err) => {
    console.error(C.red("link:check failed:"), err.message);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
