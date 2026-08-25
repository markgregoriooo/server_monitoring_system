import db from "../config/mysql.js";

// The admin's per-port labels ("Uplink to Library", "AP — 2nd floor"), read from
// `network_interfaces` and keyed by interface name.
//
// Both pollers need this and both had a byte-identical private copy
// (snmpPollerService.js:257, mikrotikPollerService.js:50). They are the two halves of
// one feature — a port's label has to read the same whether the device is walked over
// SNMP or read over the RouterOS API — so two copies could only ever be identical or
// wrong. See audits/code-duplication-report.md — R-02.
//
// Returns a plain object rather than a Map because every call site does
// `labels[iface.name] ?? ""` on it.
export async function loadInterfaceLabels(deviceId) {
  const [rows] = await db.query(
    `SELECT interface_name, location_label FROM network_interfaces WHERE device_id = ?`,
    [deviceId],
  );
  const m = {};
  for (const r of rows) m[r.interface_name] = r.location_label ?? "";
  return m;
}

export default { loadInterfaceLabels };
