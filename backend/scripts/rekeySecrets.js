#!/usr/bin/env node
// ─── Encryption-key rotation for every reversibly-stored secret ─────────────────
//
// THE GAP THIS CLOSES. Four columns hold AES-256-GCM ciphertext, and until now the
// documented answer to "how do I change the key?" was: you don't. CLAUDE.md says of
// MIKROTIK_ENC_KEY, in bold, "NEVER change this once MikroTik credentials are saved",
// and secretCrypto.js explains why a caller with stored data pins one variable name.
// Both are accurate descriptions of the code — and together they meant the system had
// no way to respond to the one event key management exists for: a key being exposed.
// A key you cannot rotate is a key you must never lose, which is not a security
// property, it is a hope.
//
// What actually needs re-encrypting (everything reversible; the hashes are one-way and
// are untouched by design):
//   mikrotik_devices.api_password        RouterOS login          MIKROTIK_ENC_KEY (pinned)
//   agent_install_keys.key_cipher        AIK- key, re-displayed  SECRET_ENC_KEY → MIKROTIK_ENC_KEY
//   agent_tokens.approved_token_cipher   AGT- token, re-delivery SECRET_ENC_KEY → MIKROTIK_ENC_KEY
//   device_network.snmp_community        SNMPv2c community       SECRET_ENC_KEY → MIKROTIK_ENC_KEY
//
// ⚠️ mikrotik_devices.api_password is PINNED to MIKROTIK_ENC_KEY by mikrotikCrypto.js,
// so rotating THAT variable and rotating SECRET_ENC_KEY are two different operations on
// two different sets of rows. `--suite` selects which, and defaults to both, because the
// common case — one deployment, both variables holding the same value or only
// MIKROTIK_ENC_KEY set at all — is the case where doing one and forgetting the other
// leaves half the database unopenable.
//
// USAGE
//   npm run rekey                                  # report only: what is encrypted, what is not
//   npm run rekey -- --encrypt-plaintext           # encrypt values still stored in the clear
//   npm run rekey -- --from-key <64hex> [--suite general|mikrotik|both] [--apply]
//
//   Rotation is a DRY RUN unless --apply is passed. The dry run decrypts every row under
//   the old key and re-encrypts it in memory, so "it would work" is proven against the
//   real data before a single row is written.
//
// ROTATION PROCEDURE (the order matters)
//   1. Generate the new key:
//        node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//   2. Back up the database first. This rewrites credential columns in place.
//   3. Put the NEW key in backend/.env, keep the OLD one to hand.
//   4. Stop the backend — the pollers decrypt on every cycle and would read rows
//      mid-rotation under the wrong key.
//   5. npm run rekey -- --from-key <OLD KEY>            (dry run — read the report)
//   6. npm run rekey -- --from-key <OLD KEY> --apply
//   7. Start the backend. Nothing needs re-entering; the AGT-/AIK- credentials
//      themselves are unchanged, only the key they are wrapped under.
//
// The script reads the NEW key from the environment exactly as the application does, so
// step 5 failing is the check that step 3 was done right.

import "../config/env.js";
import db from "../config/mysql.js";
import { createCipherSuite } from "../services/secretCrypto.js";
import { isEncrypted, PREFIX } from "../services/communityCrypto.js";
import { describeError } from "../utils/httpError.js";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
};
const dim = (s) => `${C.dim}${s}${C.reset}`;
const ok = (s) => `${C.green}${s}${C.reset}`;
const warn = (s) => `${C.yellow}${s}${C.reset}`;
const bad = (s) => `${C.red}${s}${C.reset}`;

// ─── Arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const fromKey = valueOf("--from-key");
const apply = has("--apply");
const encryptPlaintext = has("--encrypt-plaintext");
const suiteArg = valueOf("--suite") ?? "both";

if (!["general", "mikrotik", "both"].includes(suiteArg)) {
  console.error(bad(`--suite must be general|mikrotik|both (got "${suiteArg}")`));
  process.exit(1);
}
if (fromKey !== undefined && !/^[0-9a-fA-F]{64}$/.test(fromKey)) {
  console.error(bad("--from-key must be 64 hex characters (32 bytes)."));
  process.exit(1);
}

// ─── Targets ──────────────────────────────────────────────────────────────────
//
// `prefixed` marks the one column that carries a format marker. snmp_community was
// migrated IN PLACE on a live table and so has to tell ciphertext from a legacy
// plaintext value; the other three were encrypted from the day they existed and hold
// bare base64. Getting this wrong in either direction corrupts data, so it is a
// declared property of the target rather than a guess made per row.
const TARGETS = [
  {
    name: "mikrotik_devices.api_password",
    suite: "mikrotik",
    table: "mikrotik_devices",
    idCol: "mikrotik_id",
    col: "api_password",
    prefixed: false,
    what: "RouterOS API password",
  },
  {
    name: "agent_install_keys.key_cipher",
    suite: "general",
    table: "agent_install_keys",
    idCol: "install_key_id",
    col: "key_cipher",
    prefixed: false,
    what: "AIK- install key (re-display copy)",
  },
  {
    name: "agent_tokens.approved_token_cipher",
    suite: "general",
    table: "agent_tokens",
    idCol: "id",
    col: "approved_token_cipher",
    prefixed: false,
    what: "AGT- agent token (re-delivery copy)",
  },
  {
    name: "device_network.snmp_community",
    suite: "general",
    table: "device_network",
    idCol: "device_id",
    col: "snmp_community",
    prefixed: true,
    what: "SNMPv2c community string",
  },
];

const selected = TARGETS.filter((t) => suiteArg === "both" || t.suite === suiteArg);

// The suite each target's CURRENT key comes from, resolved exactly as the app resolves
// it — so a mismatch here is the same mismatch the poller would hit at runtime.
const newSuites = {
  mikrotik: createCipherSuite(["MIKROTIK_ENC_KEY"]),
  general: createCipherSuite(["SECRET_ENC_KEY", "MIKROTIK_ENC_KEY"]),
};

// The OLD key is supplied on the command line, so it is one suite regardless of which
// variable used to hold it. Passed through the environment rather than as a literal
// because createCipherSuite reads env names by contract.
let oldSuite = null;
if (fromKey !== undefined) {
  process.env.__REKEY_OLD_KEY = fromKey;
  oldSuite = createCipherSuite(["__REKEY_OLD_KEY"]);
}

const strip = (t, v) => (t.prefixed && v.startsWith(PREFIX) ? v.slice(PREFIX.length) : v);
const wrap = (t, v) => (t.prefixed ? PREFIX + v : v);

// "Is this row already ciphertext?" — by marker where there is one, and otherwise by
// whether the configured key can actually open it. Trial decryption is the honest test
// for an unmarked column: GCM authenticates, so a value that decrypts IS ciphertext.
const looksEncrypted = (t, v, suite) => {
  if (t.prefixed) return isEncrypted(v);
  try {
    suite.decrypt(v);
    return true;
  } catch {
    return false;
  }
};

async function rows(t) {
  const [r] = await db.query(
    `SELECT \`${t.idCol}\` AS id, \`${t.col}\` AS val FROM \`${t.table}\`
      WHERE \`${t.col}\` IS NOT NULL AND \`${t.col}\` <> ''`,
  );
  return r;
}

// ─── Mode 1: report ───────────────────────────────────────────────────────────

async function report() {
  console.log(`\n${C.bold}Reversibly-stored secrets${C.reset}\n`);
  console.log(
    dim(
      `  SECRET_ENC_KEY   ${process.env.SECRET_ENC_KEY ? "set" : "not set (general suite falls back to MIKROTIK_ENC_KEY)"}`,
    ),
  );
  console.log(dim(`  MIKROTIK_ENC_KEY ${process.env.MIKROTIK_ENC_KEY ? "set" : "not set"}\n`));

  let plaintextTotal = 0;
  for (const t of selected) {
    const suite = newSuites[t.suite];
    let r;
    try {
      r = await rows(t);
    } catch (err) {
      console.log(`  ${warn("skip")}  ${t.name} — ${describeError(err)}`);
      continue;
    }
    if (!suite.isConfigured()) {
      console.log(`  ${bad("no key")}  ${t.name} — ${r.length} row(s), cannot be read`);
      continue;
    }
    let enc = 0;
    let plain = 0;
    for (const row of r) {
      if (looksEncrypted(t, String(row.val), suite)) enc++;
      else plain++;
    }
    plaintextTotal += plain;
    const verdict = plain === 0 ? ok("all encrypted") : bad(`${plain} PLAINTEXT`);
    console.log(
      `  ${verdict}  ${t.name}  ${dim(`(${enc} encrypted of ${r.length} — ${t.what})`)}`,
    );
  }

  console.log();
  if (plaintextTotal > 0) {
    console.log(warn(`  ${plaintextTotal} value(s) are stored in the clear, and the nightly`));
    console.log(warn("  mysqldump carries them offsite. Encrypt them with:"));
    console.log(warn("      npm run rekey -- --encrypt-plaintext\n"));
  }
  console.log(dim("  To rotate a key:  npm run rekey -- --from-key <old 64-hex key>\n"));
}

// ─── Mode 2: encrypt values still stored in the clear ─────────────────────────

async function doEncryptPlaintext() {
  console.log(`\n${C.bold}Encrypting values stored in the clear${C.reset}\n`);
  let total = 0;
  for (const t of selected) {
    const suite = newSuites[t.suite];
    if (!suite.isConfigured()) {
      console.log(`  ${bad("no key")}  ${t.name} — skipped`);
      continue;
    }
    let r;
    try {
      r = await rows(t);
    } catch (err) {
      console.log(`  ${warn("skip")}  ${t.name} — ${describeError(err)}`);
      continue;
    }
    let n = 0;
    for (const row of r) {
      const val = String(row.val);
      if (looksEncrypted(t, val, suite)) continue;
      await db.query(`UPDATE \`${t.table}\` SET \`${t.col}\` = ? WHERE \`${t.idCol}\` = ?`, [
        wrap(t, suite.encrypt(val)),
        row.id,
      ]);
      n++;
    }
    total += n;
    console.log(`  ${n > 0 ? ok(`${n} encrypted`) : dim("nothing to do")}  ${t.name}`);
  }
  console.log(
    `\n  ${total > 0 ? ok(`${total} value(s) encrypted.`) : dim("Nothing was stored in the clear.")}\n`,
  );
}

// ─── Mode 3: rotate ───────────────────────────────────────────────────────────

async function rotate() {
  console.log(
    `\n${C.bold}Re-encrypting under the key currently in backend/.env${C.reset}  ` +
      (apply ? bad("[APPLY — rows will be written]") : warn("[DRY RUN — nothing is written]")) +
      "\n",
  );

  // Everything is decrypted and re-encrypted in memory FIRST. A rotation that fails
  // halfway leaves some rows under the old key and some under the new one, and then
  // neither key opens the whole table — so the failure has to happen before any write.
  const planned = [];
  let failures = 0;

  for (const t of selected) {
    const suite = newSuites[t.suite];
    if (!suite.isConfigured()) {
      console.log(`  ${bad("no new key")}  ${t.name} — cannot rotate`);
      failures++;
      continue;
    }
    let r;
    try {
      r = await rows(t);
    } catch (err) {
      console.log(`  ${warn("skip")}  ${t.name} — ${describeError(err)}`);
      continue;
    }
    let queued = 0;
    let already = 0;
    let failed = 0;
    for (const row of r) {
      const body = strip(t, String(row.val));
      let plaintext;
      try {
        plaintext = oldSuite.decrypt(body);
      } catch {
        // Not openable by the old key. Either it is already under the new key (a
        // resumed rotation) or it is plaintext — both mean "leave it alone".
        try {
          suite.decrypt(body);
          already++;
        } catch {
          failed++;
          console.log(
            `  ${bad("cannot decrypt")}  ${t.name} ${t.idCol}=${row.id} — ` +
              "readable under neither the old key nor the new one",
          );
        }
        continue;
      }
      planned.push({ t, id: row.id, next: wrap(t, suite.encrypt(plaintext)) });
      queued++;
    }
    failures += failed;
    console.log(
      `  ${queued > 0 ? ok(`${queued} to re-encrypt`) : dim("nothing to do")}  ${t.name}  ` +
        dim(`(${already} already on the new key, ${failed} unreadable)`),
    );
  }

  if (failures > 0) {
    console.log(`\n  ${bad("Refusing to write.")} ${failures} value(s) could not be decrypted.`);
    console.log(dim("  Check --from-key is the key those rows were encrypted under, and that"));
    console.log(dim("  backend/.env now holds the new one. Nothing has been changed.\n"));
    return 1;
  }
  if (!apply) {
    console.log(`\n  ${ok("Dry run succeeded")} — every value opened under the old key.`);
    console.log(dim("  Re-run with --apply to write. Back up the database first.\n"));
    return 0;
  }
  for (const p of planned) {
    await db.query(`UPDATE \`${p.t.table}\` SET \`${p.t.col}\` = ? WHERE \`${p.t.idCol}\` = ?`, [
      p.next,
      p.id,
    ]);
  }
  console.log(`\n  ${ok(`${planned.length} value(s) re-encrypted under the new key.`)}`);
  console.log(dim("  Start the backend. No credential changed — only the key wrapping it.\n"));
  return 0;
}

// ─── Entry ────────────────────────────────────────────────────────────────────

// Preflight. Without it an unreachable database reports as four identical per-table
// "skip" lines — which reads as "those tables do not exist", i.e. as a schema problem,
// and sends the operator to the wrong place entirely.
async function assertDbReachable() {
  try {
    await db.query("SELECT 1");
  } catch (err) {
    throw new Error(
      `Cannot reach MySQL at ${process.env.DB_HOST || "localhost"}:${process.env.DB_PORT || 3306} ` +
        `— ${describeError(err)}. Start the database and try again; nothing has been changed.`,
    );
  }
}

let code = 0;
try {
  await assertDbReachable();
  if (fromKey !== undefined) code = await rotate();
  else if (encryptPlaintext) await doEncryptPlaintext();
  else await report();
} catch (err) {
  console.error(bad(`\n  ${err.message}\n`));
  code = 1;
} finally {
  await db.end().catch(() => {});
}
process.exit(code);
