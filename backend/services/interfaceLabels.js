import db from "../config/mysql.js";

// Per-port labels ("Uplink to Library", "AP — 2nd floor") from network_interfaces,
// keyed by interface name. Shared by the SNMP and MikroTik pollers so a label reads
// the same either way. See audits/code-duplication-report.md (R-02).
// Returns a plain object; callers do `labels[iface.name] ?? ""`.
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
