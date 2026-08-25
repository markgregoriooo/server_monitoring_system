import { ping } from "../services/icmpPing.js";
import client, { SYS_OID, IF_OID, UPS_OID, upsOutputState } from "../services/snmpClient.js";
import { isValidIp } from "../services/snmpUtils.js";

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
// Deliberately touches NO database and NO InfluxDB: it imports only snmpClient
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

if (!isValidIp(ipArg)) {
  console.error(bad(`\n"${ipArg}" is not a valid IPv4 address.`));
  console.error(dim("The dashboard validates the same way, so this would be rejected there too.\n"));
  process.exit(1);
}

const community = communityArg || "public";
const port = Number(portArg) || 161;

console.log(`\n${C.bold}Probing ${C.cyan}${ipArg}${C.reset}${C.bold}${C.reset}  ${dim(`(SNMP community "${community}", UDP ${port})`)}\n`);

// ── 1. ICMP ───────────────────────────────────────────────────────────────────
// First because nothing can refuse a ping, so a failure here means the address is
// wrong or the host is down — and every SNMP result below would then be noise.
process.stdout.write("  ICMP ping        … ");
const icmp = await ping(ipArg, { count: 4 });
if (icmp.reachable) {
  console.log(
    ok("REACHABLE") +
      `  ${icmp.latencyMs} ms avg` +
      (icmp.packetLossPct > 0 ? warn(`  ${icmp.packetLossPct}% packet loss`) : dim("  0% loss")),
  );
} else {
  console.log(bad("NO REPLY") + dim("  (wrong IP, host down, or ICMP filtered)"));
}

// ── 2. SNMP: does it answer at all? ───────────────────────────────────────────
//
// `snmpReachable` means the transport worked — the GET did not time out. That is a
// SEPARATE question from whether the system group has anything in it, and the two
// were conflated in the first version of this script: the dev UPS implements only
// UPS-MIB, so its empty system group was read as "SNMP failed" and the script told
// you to register a perfectly monitorable UPS in ping mode. A device may implement
// any subset of MIBs, so each one is now asked independently.
process.stdout.write("  SNMP sysDescr    … ");
let snmpReachable = false;
let sysDescr = null;
let sysName = null;
const session = client.openSession({ host: ipArg, community, port, timeout: 4000, retries: 1 });
try {
  const sys = await client.get(session, [SYS_OID.sysDescr, SYS_OID.sysName, SYS_OID.sysUpTime]);
  snmpReachable = true; // it answered; the contents are a separate matter
  sysDescr = sys[SYS_OID.sysDescr];
  sysName = sys[SYS_OID.sysName];
  if (sysDescr != null || sysName != null) {
    console.log(ok("ANSWERS"));
    if (sysName) console.log(`      name         ${sysName}`);
    if (sysDescr) console.log(`      description  ${String(sysDescr).replace(/\s+/g, " ").slice(0, 120)}`);
    if (sys[SYS_OID.sysUpTime] != null) {
      const up = Number(sys[SYS_OID.sysUpTime]) / 100;
      console.log(`      uptime       ${Math.floor(up / 86400)}d ${Math.floor((up % 86400) / 3600)}h`);
    }
  } else {
    console.log(warn("ANSWERS, no system group") + dim("  (SNMP works — this device just omits MIB-II)"));
  }
} catch (err) {
  console.log(bad("NO ANSWER") + dim(`  (${err.message})`));
} finally {
  client.closeSession(session);
}

// ── 3. IF-MIB — the interfaces a ROUTER is monitored for ──────────────────────
let ifCount = 0;
if (snmpReachable) {
  process.stdout.write("  IF-MIB interfaces… ");
  const s3 = client.openSession({ host: ipArg, community, port, timeout: 4000, retries: 1 });
  try {
    const names = await client.walkColumn(s3, IF_OID.ifName);
    ifCount = Object.keys(names).length;
    if (ifCount) {
      const shown = Object.values(names).slice(0, 6).join(", ");
      console.log(ok(`${ifCount} port${ifCount === 1 ? "" : "s"}`) + dim(`  ${shown}${ifCount > 6 ? " …" : ""}`));
    } else {
      console.log(dim("none") + dim("  (no ifName column — not a router, or it hides them)"));
    }
  } catch {
    console.log(dim("none"));
  } finally {
    client.closeSession(s3);
  }
}

// ── 4. UPS-MIB ────────────────────────────────────────────────────────────────
// Asked whenever SNMP answered at all, NOT only when the system group did. This is
// what separates "a UPS on the network" from "a UPS we can actually read" — a unit
// whose network card speaks only its vendor's cloud app answers step 2 and fails here.
let isUps = false;
if (snmpReachable) {
  process.stdout.write("  UPS-MIB (RFC1628)… ");
  const s2 = client.openSession({ host: ipArg, community, port, timeout: 4000, retries: 1 });
  try {
    const u = await client.get(s2, [
      UPS_OID.upsEstimatedChargeRemaining,
      UPS_OID.upsEstimatedMinutesRemaining,
      UPS_OID.upsOutputSource,
    ]);
    const charge = u[UPS_OID.upsEstimatedChargeRemaining];
    const src = u[UPS_OID.upsOutputSource];
    isUps = charge != null || src != null;
    if (isUps) {
      console.log(ok("ANSWERS") + "  this is a monitorable UPS");
      if (charge != null) console.log(`      battery      ${charge}%`);
      if (u[UPS_OID.upsEstimatedMinutesRemaining] != null) {
        console.log(`      runtime      ${u[UPS_OID.upsEstimatedMinutesRemaining]} min`);
      }
      if (src != null) {
        const state = upsOutputState(src);
        const line = `      output       ${state}`;
        console.log(state === "normal" ? line : warn(`${line} NOT on mains-through-inverter`));
      }
    } else {
      console.log(dim("no") + dim("  (not a UPS, or it doesn't implement RFC 1628)"));
    }
  } catch {
    console.log(dim("no"));
  } finally {
    client.closeSession(s2);
  }
}

// ── Verdict ───────────────────────────────────────────────────────────────────
// The point of the whole script: say what to DO, not just what was seen.
console.log(`\n${C.bold}Verdict${C.reset}`);

if (isUps) {
  console.log(`  ${ok("Register as a UPS.")} Add UPS → IP ${ipArg}, community "${community}", port ${port}.`);
} else if (snmpReachable && ifCount > 0) {
  console.log(`  ${ok("Register as a router, SNMP mode.")} Add router → IP ${ipArg}, community "${community}", port ${port}.`);
  console.log(dim(`  You get per-port traffic, link up/down and uptime across ${ifCount} port${ifCount === 1 ? "" : "s"}.`));
} else if (snmpReachable) {
  // Answered SNMP but exposes neither interfaces nor a battery. Registering it as a
  // router would poll it forever and store nothing worth charting.
  console.log(`  ${warn("SNMP works, but this device exposes nothing we monitor.")}`);
  console.log(dim("  No IF-MIB interfaces and no UPS-MIB battery. Register with a BLANK community to"));
  console.log(dim("  track reachability, or check whether another community string exposes more."));
} else if (icmp.reachable) {
  console.log(`  ${warn("Register as a router, PING mode.")} Add router → IP ${ipArg}, ${C.bold}leave the community BLANK${C.reset}.`);
  console.log(dim("  The host is alive but did not answer SNMP with this community."));
  console.log(dim("  Typical for ISP-owned CPE. You get up/down, latency and packet loss — no per-port data."));
  console.log(dim(`  If you believe it SHOULD do SNMP, re-run with the real community: npm run probe -- ${ipArg} <community>`));
} else {
  console.log(`  ${bad("Do not register this yet.")} Nothing answered at ${ipArg}.`);
  console.log(dim("  Check the IP is right and the host is powered. A device registered now would"));
  console.log(dim("  simply sit Offline forever with nothing on screen explaining why."));
}
console.log("");
process.exit(0);
