import { probe } from "../services/deviceProbe.js";
import { PROBE_CODE } from "../services/deviceProbeVerdict.js";

// ─── npm run probe -- <ip> [community] [port] ─────────────────────────────────
// "Can this device be monitored, and how?" Run it before registering a device.
// Replaces the `snmpwalk` step in router-ups-monitoring.md §9 (snmpwalk does not come
// with Windows). Uses services/deviceProbe.js and deviceProbeVerdict.js, the same code
// as the Test connection button, so both give the same answer. No database or
// InfluxDB needed.
//
//   cd backend
//   npm run probe -- 192.168.1.1              # is my router SNMP or ping-only?
//   npm run probe -- 10.233.200.18 public     # try a specific community
//   npm run probe -- 127.0.0.1 dev-ups 1161   # the dev simulator

const [, , ipArg, communityArg, portArg] = process.argv;

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
const ok = (s) => `${C.green}${s}${C.reset}`;
const bad = (s) => `${C.red}${s}${C.reset}`;
const warn = (s) => `${C.yellow}${s}${C.reset}`;
const dim = (s) => `${C.dim}${s}${C.reset}`;

if (!ipArg) {
  console.log(`
${C.bold}Usage:${C.reset} npm run probe -- <ip> [community] [port]

  npm run probe -- 192.168.1.1                ${dim("# ping + try community 'public'")}
  npm run probe -- 10.233.200.18 cspc-ro      ${dim("# try a specific community")}
  npm run probe -- 127.0.0.1 dev-ups 1161     ${dim("# the dev simulator")}
`);
  process.exit(1);
}

// The CLI defaults the community to "public"; the form does not, because there a blank
// community means ICMP monitoring. See deviceProbe.probe().
const community = communityArg || "public";
const port = Number(portArg) || 161;

console.log(`\n${C.bold}Probing ${C.cyan}${ipArg}${C.reset}${C.bold}${C.reset}  ${dim(`(SNMP community "${community}", UDP ${port})`)}\n`);

// `expect: "router"` only affects the verdict wording; every MIB is still checked and
// reported. 4 pings rather than the form's 2.
const r = await probe(ipArg, { community, port, expect: "router", pingCount: 4 });

if (!r.ok) {
  console.error(bad(`\n${r.error}`));
  console.error(dim("The dashboard validates the same way, so this would be rejected there too.\n"));
  process.exit(1);
}

// ── 1. ICMP ───────────────────────────────────────────────────────────────────
process.stdout.write("  ICMP ping        … ");
if (r.icmp.reachable) {
  console.log(
    ok("REACHABLE") +
      `  ${r.icmp.latencyMs} ms avg` +
      (r.icmp.packetLossPct > 0 ? warn(`  ${r.icmp.packetLossPct}% packet loss`) : dim("  0% loss")),
  );
} else {
  console.log(bad("NO REPLY") + dim("  (wrong IP, host down, or ICMP filtered)"));
}

// ── 2. SNMP: does it answer at all? ───────────────────────────────────────────
process.stdout.write("  SNMP sysDescr    … ");
if (!r.snmp.answered) {
  console.log(bad("NO ANSWER") + dim(`  (${r.snmp.error ?? "no response"})`));
} else if (r.snmp.sysDescr != null || r.snmp.sysName != null) {
  console.log(ok("ANSWERS"));
  if (r.snmp.sysName) console.log(`      name         ${r.snmp.sysName}`);
  if (r.snmp.sysDescr) console.log(`      description  ${r.snmp.sysDescr.slice(0, 120)}`);
  if (r.snmp.uptimeSeconds != null) {
    const up = r.snmp.uptimeSeconds;
    console.log(`      uptime       ${Math.floor(up / 86400)}d ${Math.floor((up % 86400) / 3600)}h`);
  }
} else {
  console.log(warn("ANSWERS, no system group") + dim("  (SNMP works — this device just omits MIB-II)"));
}

// ── 3. IF-MIB — the interfaces a ROUTER is monitored for ──────────────────────
if (r.snmp.answered) {
  process.stdout.write("  IF-MIB interfaces… ");
  if (r.ifCount) {
    const shown = r.ifNames.slice(0, 6).join(", ");
    console.log(ok(`${r.ifCount} port${r.ifCount === 1 ? "" : "s"}`) + dim(`  ${shown}${r.ifCount > 6 ? " …" : ""}`));
  } else {
    console.log(dim("none") + dim("  (no ifName column — not a router, or it hides them)"));
  }
}

// ── 4. UPS-MIB ────────────────────────────────────────────────────────────────
if (r.snmp.answered) {
  process.stdout.write("  UPS-MIB (RFC1628)… ");
  if (r.ups.isUps) {
    console.log(ok("ANSWERS") + "  this is a monitorable UPS");
    if (r.ups.chargePct != null) console.log(`      battery      ${r.ups.chargePct}%`);
    if (r.ups.runtimeMin != null) console.log(`      runtime      ${r.ups.runtimeMin} min`);
    if (r.ups.outputState) {
      const line = `      output       ${r.ups.outputState}`;
      console.log(r.ups.outputState === "normal" ? line : warn(`${line} NOT on mains-through-inverter`));
    }
  } else {
    console.log(dim("no") + dim("  (not a UPS, or it doesn't implement RFC 1628)"));
  }
}

// ── Verdict ───────────────────────────────────────────────────────────────────
// Says what to do next. The decision is deviceProbeVerdict.verdictFor (same as the
// Add form); this only picks the colour and adds the form fields to fill in.
console.log(`\n${C.bold}Verdict${C.reset}`);

const v = r.verdict;
const paint = v.code === PROBE_CODE.UNREACHABLE ? bad : v.ok ? ok : warn;
console.log(`  ${paint(v.title)}`);
console.log(dim(`  ${v.detail}`));

if (v.code === PROBE_CODE.UPS) {
  console.log(dim(`  Add UPS → IP ${r.ip}, community "${community}", port ${port}.`));
} else if (v.code === PROBE_CODE.SNMP_ROUTER) {
  console.log(dim(`  Add router → IP ${r.ip}, community "${community}", port ${port}.`));
} else if (v.code === PROBE_CODE.PING_ONLY) {
  console.log(dim(`  Add router → IP ${r.ip}, ${C.bold}leave the community BLANK${C.reset}${C.dim}.${C.reset}`));
  console.log(dim(`  If you believe it SHOULD do SNMP, re-run with the real community: npm run probe -- ${r.ip} <community>`));
}
console.log("");
process.exit(0);
