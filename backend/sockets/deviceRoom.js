// ─── "Is the ESP32 actually there?" ──────────────────────────────────────────
//
// Every command the backend sends the hardware — IR on/off, gas calibration — is a
// Socket.IO emit into the `devices` room. An emit into an EMPTY room is silently
// discarded: no error, no return value, nothing to check.
//
// That is fine for CONFIG pushes (`irConfig`, `envConfig`, `acConfig`) because the
// firmware re-reads them on connect, so a missed one is picked up later. It is not fine
// for a one-shot ACTION. `PATCH /aircon/:id/toggle` wrote `aircon_state.is_on`, stamped
// an "Manually turned ON by <user>" row into `aircon_logs`, told every dashboard the
// unit was on, and emitted `irCommand` into nowhere — so the record said a thing had
// happened that physically had not, in the very table the Aircon Activity report is
// built from.
//
// `routes/environment.js` already guarded `calibrate-gas` this way. This is that check,
// in one place, so the two cannot drift apart.
//
// ⚠️ Deliberately room membership, NOT esp32Monitor liveness. They answer different
// questions: esp32Monitor asks "has a reading arrived in the last 30s" (what the UI
// badge shows), this asks "is there a socket to deliver to right now" — which is
// precisely what an emit needs. A box that connected two seconds ago can take a command
// before its first reading lands, and one whose socket just dropped cannot take one even
// though its last reading is fresh.

/** Socket.IO room every authenticated ESP32 joins — see sockets/connectionHandler.js. */
export const DEVICE_ROOM = "devices";

/**
 * How many device sockets are connected right now.
 *
 * Total by design: a missing `io` (server still starting, or a unit test) reads as zero
 * rather than throwing, so a caller's guard fails CLOSED — it refuses the command
 * instead of letting it through unchecked.
 *
 * @param {import("socket.io").Server | null | undefined} io
 * @returns {number}
 */
export function deviceCount(io) {
  try {
    return io?.sockets?.adapter?.rooms?.get(DEVICE_ROOM)?.size ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Can a command reach the hardware at this instant?
 * @param {import("socket.io").Server | null | undefined} io
 * @returns {boolean}
 */
export function isDeviceConnected(io) {
  return deviceCount(io) > 0;
}

/**
 * The one message shown when it cannot. Shared so the aircon and calibration routes say
 * the same thing — a user who sees two different wordings for one condition assumes
 * they are two different faults.
 */
export const NO_DEVICE_MESSAGE =
  "The ESP32 is not connected, so the command cannot reach the air conditioner. Nothing was changed.";

export default { DEVICE_ROOM, deviceCount, isDeviceConnected, NO_DEVICE_MESSAGE };
