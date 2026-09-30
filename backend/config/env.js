import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// ─── Paths ─────────────────────────────────────────────────────────────────────
// Resolved from this module, not process.cwd(). A service manager may start the
// backend from another folder, and then ./.env, ./reports and ./backups would all
// point at the wrong place. If .env is still missing, the error names the path tried.
export const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ENV_PATH = path.join(BACKEND_ROOT, ".env");
const loaded = dotenv.config({ path: ENV_PATH });

// Refuse to start with a missing or short JWT secret: with HS256 a weak secret
// makes tokens forgeable.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  // Name the file first. If .env could not be read at all, every other setting is
  // missing too and JWT_SECRET is just the first check to notice.
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

// ─── DEVICE_SECRET: minimum length and a list of leaked values ─────────────────
// This is the ESP32's only credential. Whoever presents it can write environment
// readings, replay backfill and drive the IR, so it gets the same checks as
// JWT_SECRET. The original value was committed in the .ino (5f5a084) and is
// refused at boot. Rotating it means changing backend/.env and secrets.h together
// and reflashing the ESP32.
const DEVICE_SECRET_MIN_LEN = 24;

// Leaked values, stored as SHA-256 hashes so this file does not republish them.
// One entry: the secret committed at 5f5a084 and removed from history on 2026-08-26.
const LEAKED_DEVICE_SECRET_HASHES = new Set([
  "67de28a37d17cc99b4bd6ad48cda76f2406f070d7b330c836ebc856145d53d98",
]);

const deviceSecret = (process.env.DEVICE_SECRET ?? "").trim();
const deviceSecretHash = deviceSecret
  ? crypto.createHash("sha256").update(deviceSecret, "utf8").digest("hex")
  : "";

if (deviceSecret && LEAKED_DEVICE_SECRET_HASHES.has(deviceSecretHash)) {
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

// Unset is allowed (a deployment without an ESP32); every device handshake is then
// refused. Log it once so a box that will not connect is explained in the log.
if (!deviceSecret) {
  console.warn(
    "[CONFIG] DEVICE_SECRET is not set — ESP32 device handshakes will all be rejected. " +
      "Set it in backend/.env and in iot/esp32/env_monitor_v2/secrets.h if a sensor box is deployed.",
  );
}
