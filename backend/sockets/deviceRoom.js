// ─── Is the ESP32 connected? ─────────────────────────────────────────────────
// Commands to the hardware (IR on/off, gas calibration) are emits into the
// `devices` room, and an emit into an empty room is silently dropped. Config pushes
// are re-sent on connect, but a one-shot action is not, so the aircon toggle and
// gas calibration check this first instead of recording something that never
// happened. This checks for a connected socket, not recent readings (esp32Monitor).

/** Socket.IO room every authenticated ESP32 joins — see sockets/connectionHandler.js. */
export const DEVICE_ROOM = "devices";

/**
 * Number of device sockets connected right now. Returns 0 when `io` is missing,
 * so callers refuse the command instead of letting it through.
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
 * The message shown when the device is not connected, shared by the aircon and
 * calibration routes.
 */
export const NO_DEVICE_MESSAGE =
  "The ESP32 is not connected, so the command cannot reach the air conditioner. Nothing was changed.";

export default { DEVICE_ROOM, deviceCount, isDeviceConnected, NO_DEVICE_MESSAGE };
