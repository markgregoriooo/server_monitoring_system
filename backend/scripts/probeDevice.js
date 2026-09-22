import { probe } from "../services/deviceProbe.js";
import { PROBE_CODE } from "../services/deviceProbeVerdict.js";

// ─── npm run probe -- <ip> [community] [port] ─────────────────────────────────
//
// Answers the one question you must settle before registering ANY device:
// "can this box be monitored, and how?"
//
// It is the `snmpwalk` step from router-ups-monitoring.md §9 — except snmpwalk is
// a net-snmp CLI tool that does not ship with Windows, which is what every dev on
// this project is using. This runs the SAME code the poller runs (services/
// snmpClient.js + services/icmpPing.js) against one address and prints the verdict,
// so there is nothing to install and no second implementation to drift.
//
// Since 2026-09-21 the measuring and the verdict both live in services/deviceProbe.js
// + services/deviceProbeVerdict.js, because the dashboard's **Test connection** button
// on the Add router / Add UPS forms asks exactly this question and must not answer it
// differently. This file is now the PRESENTATION of that probe and nothing else.
//
// Deliberately touches NO database and NO InfluxDB: the chain imports only snmpClient
// (net-snmp + the pure snmpUtils) and icmpPing, so it runs before anything is
// configured — which is exactly when you need it.
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

// The CLI defaults the community to "public" where the FORM deliberately does not: here
// you are exploring an unknown address, there a blank community is an explicit choice to
// register the device for ICMP monitoring. See deviceProbe.probe().
const community = communityArg || "public";
const port = Number(portArg) || 161;

console.log(`\n${C.bold}Probing ${C.cyan}${ipArg}${C.reset}${C.bold}${C.reset}  ${dim(`(SNMP community "${community}", UDP ${port})`)}\n`);

// `expect: "router"` only steers the wording of the verdict line; every MIB is asked
// and reported regardless, which is the whole point of an exploratory probe. The UPS
// case is still called out below off `ups.isUps`, not off what was expected.
// 4 echoes rather than the form's 2 — nobody is watching a spinner here.
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
// The point of the whole script: say what to DO, not just what was seen. The decision
// itself is deviceProbeVerdict.verdictFor — the same one the Add form shows — so this
// block only chooses the colour and appends the concrete form fields to type in.
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
