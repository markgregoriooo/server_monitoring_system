import { useEffect, useState } from "react";
import { api } from "../api/api";
import { socket } from "../socket/socket";
import { toRoomThresholds, ROOM_THRESHOLD_FALLBACK } from "../utils/envThresholds";
import type { RoomThresholds } from "../utils/envThresholds";

/**
 * The room-level alert thresholds (`alert_rules`, global scope), kept current.
 *
 * Loads once from GET /api/environment/thresholds (both roles), then follows the
 * `envConfigUpdated` broadcast so an open page re-colours the moment an admin retunes a
 * rule — the admin doing the retuning is on the Alert Rules page and would never see a
 * stale Dashboard, which is exactly why this cannot wait for a reload.
 *
 * Starts on the shipped seed values rather than on `{}`: an empty set means "no rule, no
 * colour", which would paint a smoke reading green for as long as the request takes.
 *
 * Temperature, humidity and gas all colour from this one source, so a reading changes at
 * the same instant the system raises the alert for it.
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
