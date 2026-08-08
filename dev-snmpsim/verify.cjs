// Quick check that the snmpsim fake devices answer the exact OIDs the poller reads.
// Run:  node verify.cjs        (after `npm install` here and starting the responder)
const snmp = require("net-snmp");

function getAll(host, port, community, oids) {
  return new Promise((resolve, reject) => {
    const session = snmp.createSession(host, community, {
      port, version: snmp.Version2c, timeout: 4000, retries: 1, transport: "udp4",
    });
    session.get(oids, (err, vbs) => {
      session.close();
      if (err) return reject(err);
      const out = {};
      for (const vb of vbs) {
        if (snmp.isVarbindError(vb)) { out[vb.oid] = "<no such OID>"; continue; }
        const v = vb.value;
        if (Buffer.isBuffer(v)) {
          // printable bytes → text (sysDescr/ifName); otherwise a binary 64-bit counter → decimal
          const printable = v.length > 0 && v.every((b) => b >= 32 && b < 127);
          out[vb.oid] = printable ? v.toString() : BigInt("0x" + (v.toString("hex") || "0")).toString();
        } else {
          out[vb.oid] = String(v);
        }
      }
      resolve(out);
    });
  });
}

(async () => {
  const HOST = "127.0.0.1", PORT = 1161;

  console.log("=== ROUTER  (community: dev-router) ===");
  const r1 = await getAll(HOST, PORT, "dev-router", [
    "1.3.6.1.2.1.1.1.0",            // sysDescr
    "1.3.6.1.2.1.1.5.0",            // sysName
    "1.3.6.1.2.1.31.1.1.1.1.1",     // ifName.1
    "1.3.6.1.2.1.31.1.1.1.6.1",     // ifHCInOctets.1
    "1.3.6.1.2.1.31.1.1.1.15.1",    // ifHighSpeed.1
  ]);
  console.log(r1);
  await new Promise((r) => setTimeout(r, 2500));
  const r2 = await getAll(HOST, PORT, "dev-router", ["1.3.6.1.2.1.31.1.1.1.6.1"]);
  console.log("ifHCInOctets.1 after 2.5s :", r2["1.3.6.1.2.1.31.1.1.1.6.1"], "(should be LARGER → counter is ticking → live throughput)");

  console.log("\n=== UPS  (community: dev-ups) ===");
  const u = await getAll(HOST, PORT, "dev-ups", [
    "1.3.6.1.2.1.33.1.2.4.0",       // charge %
    "1.3.6.1.2.1.33.1.2.3.0",       // minutes remaining
    "1.3.6.1.2.1.33.1.4.1.0",       // output source (3=mains, 5=battery)
    "1.3.6.1.2.1.33.1.4.4.1.5.1",   // load %
  ]);
  console.log(u);

  console.log("\nOK — the simulator is answering. You can now point the backend at it.");
  process.exit(0);
})().catch((e) => {
  console.error("VERIFY FAILED:", e.message, "\n(Is the responder running on 127.0.0.1:1161?)");
  process.exit(1);
});
