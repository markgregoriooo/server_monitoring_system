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
  /**
   * The ADC pin as reported by the ESP32 (`gasSensorMap`); null until it connects.
   * Not a frontend constant, since the pins are defined in the firmware.
   */
  gpio?: number | null;
  updatedAt?: string | null;
  updatedByName?: string | null;
}

/**
 * The MQ-2 sensors: which channels are wired and where each one is. Follows the
 * update broadcast (like useRoomThresholds), so a renamed sensor updates everyone's
 * chart legend. Starts empty; callers show `MQ2-<n>` for anything without a label.
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
