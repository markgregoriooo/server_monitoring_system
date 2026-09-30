import { useEffect, useState } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import { toRoomThresholds, ROOM_THRESHOLD_FALLBACK } from "../utils/envThresholds";
import type { RoomThresholds } from "../utils/envThresholds";

/**
 * Room alert thresholds (`alert_rules`, global scope), kept up to date. Loads once
 * from GET /api/environment/thresholds, then follows `envConfigUpdated`, so open
 * pages re-colour as soon as an admin changes a rule. Starts on the seeded defaults,
 * not `{}`, so readings are never uncoloured while loading. Temperature, humidity and
 * gas all use this.
 */
export function useRoomThresholds(): RoomThresholds {
  const [thresholds, setThresholds] = useState<RoomThresholds>(ROOM_THRESHOLD_FALLBACK);

  useEffect(() => {
    let alive = true;

    api.getRoomThresholds().then((res) => {
      if (alive && res.success && res.data?.thresholds) {
        setThresholds(toRoomThresholds(res.data.thresholds));
      }
    });

    const onConfig = (payload: { thresholds?: unknown } | unknown) => {
      const raw = (payload as { thresholds?: unknown })?.thresholds ?? payload;
      if (raw) setThresholds(toRoomThresholds(raw as Partial<RoomThresholds>));
    };

    socket.on("envConfigUpdated", onConfig);
    return () => {
      alive = false;
      socket.off("envConfigUpdated", onConfig);
    };
  }, []);

  return thresholds;
}
