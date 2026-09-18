import { useCallback, useEffect, useState } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";

export interface GasSensor {
  channel: number;
  locationLabel: string | null;
  /** What to print — the location if set, else the technical `MQ2-<n>`. Resolved server-side
   *  so the browser never has to hold a second copy of the fallback rule. */
  label: string;
  enabled: boolean;
  /** The ADC pin, as reported by the ESP32 itself (`gasSensorMap`). null until it connects.
   *  Never a constant in the frontend — MQ2_PINS[] lives in the firmware, and a second copy
   *  here is one that goes stale the day the board is re-pinned. */
  gpio?: number | null;
  updatedAt?: string | null;
  updatedByName?: string | null;
}

/**
 * The MQ-2 sensors: which channels are wired and where each one physically is.
 *
 * Same shape as useRoomThresholds, and for the same reason it follows a broadcast rather
 * than only loading once: the admin who renames "MQ2-3" to "Above UPS cabinet" is standing
 * on the settings card and is the least likely person to notice that everyone else's chart
 * legend and alert list still say MQ2-3.
 *
 * Starts EMPTY rather than on a guessed set of four. A label is a claim about where a
 * physical sensor is pointing, and inventing one — even a placeholder — would put a location
 * on a reading nobody has actually sited yet. Callers fall back to `MQ2-<n>` for anything
 * missing, which is honest about knowing nothing.
 */
export function useGasSensors() {
  const [sensors, setSensors] = useState<GasSensor[]>([]);

  const refresh = useCallback(async () => {
    const res = await api.getGasSensors();
    if (res.success && Array.isArray(res.data?.sensors)) setSensors(res.data.sensors);
  }, []);

  useEffect(() => {
    let alive = true;
    void api.getGasSensors().then((res) => {
      if (alive && res.success && Array.isArray(res.data?.sensors)) setSensors(res.data.sensors);
    });

    const onUpdate = (payload: { sensors?: GasSensor[] }) => {
      if (Array.isArray(payload?.sensors)) setSensors(payload.sensors);
    };
    socket.on("gasSensorsUpdated", onUpdate);
    return () => {
      alive = false;
      socket.off("gasSensorsUpdated", onUpdate);
    };
  }, []);

  /** Channel → what to call it. Falls back to the technical name for an unknown channel. */
  const labelFor = useCallback(
    (channel: number) => sensors.find((s) => s.channel === channel)?.label || `MQ2-${channel}`,
    [sensors],
  );

  const enabled = sensors.filter((s) => s.enabled);

  return { sensors, enabled, labelFor, refresh };
}
