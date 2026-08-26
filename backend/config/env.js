import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// ─── Where the backend's files actually live ──────────────────────────────────
//
// Resolved from THIS MODULE, never from process.cwd(). The distinction is invisible
// in development — `npm run dev` is always run from `backend/` — and load-bearing
// everywhere else, because a service manager sets the working directory and can set
// it wrong. `reportRenderer.js` already resolves its letterhead assets this way for
// the same reason.
//
// What used to depend on cwd:
//   dotenv.config()        read ./.env         ← the whole configuration
//   reportService.js       cwd + /reports
//   backupService.js       cwd + /backups      (when BACKUP_DIR is unset)
//
// A wrong cwd therefore did not degrade the service, it stopped it: with no .env,
// JWT_SECRET is unset and the check below throws at import time. That is the right
// FAILURE, but the wrong MESSAGE — "JWT_SECRET must be set and at least 32
// characters" sends an operator to inspect a variable that is present and correct in
// a file the process never opened. Now the path is fixed, and if the file is still
// missing the error says which path was tried.
export const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ENV_PATH = path.join(BACKEND_ROOT, ".env");
const loaded = dotenv.config({ path: ENV_PATH });

// Fail fast on a missing/weak signing secret rather than limping until the first
// jwt.sign/verify throws at runtime. HS256 security rests entirely on this secret:
// a short or unset value makes the JWT forgeable / brute-forceable offline.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  // Name the file BEFORE the variable. If .env could not be read at all then every
  // other setting is missing too, and JWT_SECRET is merely the first check to notice —
  // reporting it alone has sent people looking in the right file on the wrong machine.
  const why = loaded.error
    ? `Could not read ${ENV_PATH} (${loaded.error.code ?? loaded.error.message}). ` +
      "Every setting is therefore missing, not just this one — check the file exists " +
      "and is readable by the account running the service."
    : `JWT_SECRET is missing or shorter than 32 characters in ${ENV_PATH}.`;

  throw new Error(
    `${why} Generate one with: ` +
      `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`,
  );
}

// ─── DEVICE_SECRET: length floor + a denylist of values that are already public ──
//
// This is the ESP32's ONLY credential. A caller that presents it on the Socket.IO
// handshake is `socket.isDevice = true`, which is the authority to write environment
// readings, replay arbitrary backfill under its own timestamps, and drive the IR
// state — i.e. to fabricate the record this system exists to keep, or to bury a real
// smoke event under readings that say the room is fine.
//
// It had NO validation at all, while JWT_SECRET above has had a length check since it
// was written. The two are the same kind of value and deserve the same treatment.
//
// ⚠️ The denylist is not hypothetical hygiene. `REDACTED-ROTATED-DEVICE-SECRET` was
// committed verbatim in `iot/esp32/env_monitor_v2.ino` at 5f5a084 (2026-06-09) and
// removed at 219f36e (2026-08-16) — the split stops NEW exposure, it does not undo the
// old one, and the value stayed reachable in the history of a pushed remote the entire
// time. Refusing to boot on it is deliberate: a warning on a published credential is a
// warning nobody acts on, and this one is two `git log -S` away from anybody who has
// ever cloned the repository.
//
// Rotating it is a TWO-SIDED change — backend/.env and iot/esp32/<sketch>/secrets.h
// must carry the same new value, and the ESP32 must be reflashed for it to take
// effect. That is why the message names both files.
const DEVICE_SECRET_MIN_LEN = 24;

// Values known to have been published. Compared case-sensitively and verbatim; this is
// a list of specific leaked strings, not a weak-password heuristic.
const LEAKED_DEVICE_SECRETS = new Set([
  "REDACTED-ROTATED-DEVICE-SECRET", // iot/esp32/env_monitor_v2.ino, 5f5a084 → 219f36e
]);

const deviceSecret = (process.env.DEVICE_SECRET ?? "").trim();

if (deviceSecret && LEAKED_DEVICE_SECRETS.has(deviceSecret)) {
  throw new Error(
    `DEVICE_SECRET in ${ENV_PATH} is a value that was committed to this repository and is ` +
      "still readable in its git history, so it authenticates nobody. Rotate it on BOTH " +
      "sides — set the same new value in backend/.env and in " +
      "iot/esp32/env_monitor_v2/secrets.h, then reflash the ESP32 (until the reflash the " +
      "box cannot connect, which is the intended state for a published credential). " +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"',
  );
}

if (deviceSecret && deviceSecret.length < DEVICE_SECRET_MIN_LEN) {
  throw new Error(
    `DEVICE_SECRET in ${ENV_PATH} is ${deviceSecret.length} characters; at least ` +
      `${DEVICE_SECRET_MIN_LEN} are required. It is a static shared secret with no ` +
      "rotation and no per-device identity, so its length is the whole of its strength. " +
      "Remember to set the same value in iot/esp32/env_monitor_v2/secrets.h and reflash. " +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"',
  );
}

// Absent is allowed and is NOT the same as weak: a deployment with no ESP32 has no
// device to authenticate, and src/server.js already refuses every device handshake
// when the variable is unset (`secret && deviceKey === secret`). Say so once at boot
// so "the sensor box will not connect" is answerable from the log.
if (!deviceSecret) {
  console.warn(
    "[CONFIG] DEVICE_SECRET is not set — ESP32 device handshakes will all be rejected. " +
      "Set it in backend/.env and in iot/esp32/env_monitor_v2/secrets.h if a sensor box is deployed.",
  );
}
