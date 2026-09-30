// ─────────────────────────────────────────────────────────────────────────────
// Dev only: writes ~30 days of made-up, trending ups_metrics and network_traffic
// into InfluxDB so the UPS battery and link saturation forecasts can be tested
// without hardware (dev-snmpsim only produces flat values).
//
// Run from the backend folder (so .env loads):
//     cd backend
//     node scripts/seed-analytics-history.js [days]     # default 30
//
// Test data only, not a real prediction (predictive-analytics.md §9). Uses device ids
// 9001/9002/9101 so it never collides with real devices.
// ─────────────────────────────────────────────────────────────────────────────

import { writeClient, Point } from "../config/influx.js";

const DAYS = Math.max(7, parseInt(process.argv[2], 10) || 30);
const STEP_MS = 3_600_000;                       // one point per hour
const NOW = Date.now();
const START = NOW - DAYS * 24 * STEP_MS;
const STEPS = Math.floor((NOW - START) / STEP_MS);

const noise = (amp) => (Math.random() - 0.5) * 2 * amp;
const lerp = (a, b, f) => a + (b - a) * f;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const inOutage = (hrs, windows) => windows.some(([s, e]) => hrs >= s && hrs < e);

// ─── UPS: battery aging (declining runtime) + a few short outages ─────────────
function seedUps({ id, name, location, runtimeStart, runtimeEnd, loadStart, loadEnd, outages }) {
  for (let i = 0; i <= STEPS; i++) {
    const f = i / STEPS;
    const ts = new Date(START + i * STEP_MS);
    const onBattery = inOutage(i, outages);

    const runtime = clamp(lerp(runtimeStart, runtimeEnd, f) + noise(1.5), 1, 240);
    const load = clamp(lerp(loadStart, loadEnd, f) + noise(3), 0, 100);
    const charge = onBattery ? clamp(70 - (i % 5) * 8, 10, 95) : clamp(100 + noise(0.3), 95, 100);
    const inputV = onBattery ? 0 : clamp(230 + noise(4), 200, 245);
    const outputV = clamp(230 + noise(2), 220, 240);
    const battV = clamp(27 + noise(0.3), 24, 28);
    const temp = clamp(28 + f * 2 + noise(0.6), 24, 40);

    writeClient.writePoint(
      new Point("ups_metrics")
        .tag("device_id", String(id))
        .tag("device_name", name)
        .tag("location", location)
        .tag("communication_type", "snmp")
        .floatField("battery_charge_pct", charge)
        .floatField("runtime_remaining_min", runtime)
        .floatField("load_pct", load)
        .floatField("input_voltage", inputV)
        .floatField("output_voltage", outputV)
        .floatField("battery_voltage", battV)
        .floatField("temperature", temp)
        .booleanField("on_battery", onBattery)
        .timestamp(ts),
    );
  }
}

// ─── Network: per-interface utilization trend + climbing cumulative counters ──
function seedInterface({ id, name, ifname, label, utilStart, utilEnd, linkMbps = 1000 }) {
  let rx = 5_000_000_000n, tx = 3_000_000_000n;
  const bytesPerSec = (linkMbps * 1_000_000) / 8; // link capacity in bytes/s
  for (let i = 0; i <= STEPS; i++) {
    const f = i / STEPS;
    const ts = new Date(START + i * STEP_MS);
    const util = clamp(lerp(utilStart, utilEnd, f) + noise(4), 0, 100);
    // advance the cumulative counters by this hour's throughput (≈ util of capacity)
    const stepBytes = BigInt(Math.round((util / 100) * bytesPerSec * 3600));
    rx += stepBytes;
    tx += stepBytes / 3n;

    writeClient.writePoint(
      new Point("network_traffic")
        .tag("device_id", String(id))
        .tag("device_name", name)
        .tag("interface_name", ifname)
        .tag("location_label", label)
        .uintField("rx_bytes", rx)
        .uintField("tx_bytes", tx)
        .uintField("rx_errors", 0n)
        .uintField("tx_errors", 0n)
        .booleanField("link_up", true)
        .floatField("utilization_pct", util)
        .timestamp(ts),
    );
  }
}

// ─── Router/MikroTik: device-level CPU / memory / connected-clients (router_metrics) ──
function seedRouterDevice({ id, name, cpuStart, cpuEnd, memStart, memEnd, clientsStart, clientsEnd }) {
  for (let i = 0; i <= STEPS; i++) {
    const f = i / STEPS;
    const ts = new Date(START + i * STEP_MS);
    const cpu = clamp(lerp(cpuStart, cpuEnd, f) + noise(6), 1, 100);   // bursty → more noise
    const mem = clamp(lerp(memStart, memEnd, f) + noise(3), 1, 100);
    const clients = Math.round(clamp(lerp(clientsStart, clientsEnd, f) + noise(6), 0, 5000));

    writeClient.writePoint(
      new Point("router_metrics")
        .tag("device_id", String(id))
        .tag("device_name", name)
        .tag("device_type", "mikrotik")
        .floatField("cpu_percent", cpu)
        .floatField("mem_percent", mem)
        .floatField("uptime_seconds", 86400 + i * 3600)
        .intField("connected_clients", clients)
        .booleanField("reachable", true)
        .timestamp(ts),
    );
  }
}

async function main() {
  console.log(`Seeding ${DAYS} days (${STEPS} hourly points/series) of UPS + network history into InfluxDB...`);

  // Two UPS: A ages gradually; B is near end-of-life (low runtime, falling fast).
  seedUps({ id: 9001, name: "DEV UPS A (sim)", location: "Server Room", runtimeStart: 66, runtimeEnd: 47, loadStart: 42, loadEnd: 52, outages: [[120, 123], [400, 401]] });
  seedUps({ id: 9002, name: "DEV UPS B (sim)", location: "Rack B",      runtimeStart: 40, runtimeEnd: 23, loadStart: 68, loadEnd: 74, outages: [[260, 264]] });

  // One router, two interfaces: the ISP uplink saturating, the rack link steady.
  seedInterface({ id: 9101, name: "DEV Core Router (sim)", ifname: "ether1", label: "ISP Uplink",  utilStart: 26, utilEnd: 88 });
  seedInterface({ id: 9101, name: "DEV Core Router (sim)", ifname: "ether2", label: "Rack switch", utilStart: 14, utilEnd: 18 });

  // The same router's device-level health + total clients (MikroTik fills these; SNMP can't).
  seedRouterDevice({ id: 9101, name: "DEV Core Router (sim)", cpuStart: 22, cpuEnd: 38, memStart: 44, memEnd: 58, clientsStart: 80, clientsEnd: 165 });

  await writeClient.flush();
  await writeClient.close();
  console.log("Done. UPS B and the ISP uplink should now produce ETAs once the analytics functions are added.");
}

main().catch((e) => { console.error("Seed failed:", e); process.exit(1); });
