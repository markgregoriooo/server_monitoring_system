import { useMemo, useState } from "react";
import { api } from "../../api/api";
import type { GasSensor } from "../../hooks/useGasSensors";

const GREEN = "#73BF69";
const ORANGE = "#FF780A";

/**
 * What the pin is actually PRINTED as on the board.
 *
 * GPIO 36 and 39 are silk-screened `VP` and `VN` (the chip's SENSOR_VP / SENSOR_VN), and no
 * DevKit prints "36" or "39" anywhere. Telling an installer to wire to GPIO 36 sends them
 * looking for a label that does not exist and reads as "this board is missing that pin".
 *
 * Safe as a constant, unlike the pin NUMBERS: this is a fact about the ESP32 die, not about
 * how our board is wired, so it cannot drift the way a hardcoded MQ2_PINS[] copy would.
 */
const SILKSCREEN: Record<number, string> = { 36: "VP", 39: "VN" };

/**
 * "Add smoke sensor" — the same shape as the Add Aircon modal, deliberately.
 *
 * Both answer the identical question for someone standing at the box with a soldering iron:
 * *which pin do I wire this to*. Two different layouts for the same act would be two things
 * to learn, so this mirrors the IR channel picker — a list of slots, each naming its GPIO,
 * with the taken ones greyed out.
 *
 * The GPIO comes from the DEVICE (`gasSensorMap`, sent on every ESP32 connect), never from a
 * constant here: the pin numbers live in the firmware's MQ2_PINS[] and a copy in the
 * dashboard is one that goes stale the day the board is re-pinned. With the ESP32 offline the
 * modal says so rather than showing pins it cannot vouch for — the same warning the Add
 * Aircon modal shows, for the same reason.
 *
 * ⚠️ "Add" here means TWO things at once: mark the channel fitted, and name it. Marking a
 * channel fitted is a hardware claim — an ADC pin with nothing on it floats, reads noise, and
 * MQ-2 noise through an exponential curve is a believable ppm that can raise a false smoke
 * alarm. So the copy tells you to wire it FIRST, and the confirmation step is not decoration.
 */
export default function AddGasSensorModal({
  sensors,
  esp32Online,
  onClose,
}: {
  sensors: GasSensor[];
  esp32Online: boolean;
  onClose: () => void;
}) {
  const free = useMemo(() => sensors.filter((s) => !s.enabled), [sensors]);
  const [channel, setChannel] = useState<number | null>(free[0]?.channel ?? null);
  const selectedSensor = sensors.find((s) => s.channel === channel) ?? null;
  const editing = Boolean(selectedSensor?.enabled);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Picking a row loads its current name, so an edit starts from what is there rather than
  // from an empty box that would silently clear the label on save.
  const pick = (ch: number) => {
    setChannel(ch);
    setError(null);
    setLabel(sensors.find((s) => s.channel === ch)?.locationLabel ?? "");
  };

  const remove = async () => {
    if (channel == null) return;
    setBusy(true);
    setError(null);
    // enabled:false, NOT a delete. The channel is a physical pin on the board — it does not
    // stop existing because a sensor came off it — and keeping the row keeps the name for
    // whoever wires the next one to the same place. Same reasoning as the SOFT revoke on
    // install keys: the history of what was there is the point.
    const res = await api.updateGasSensor(channel, { enabled: false });
    setBusy(false);
    if (!res.success) { setError(res.error || "Could not remove the sensor."); return; }
    onClose();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (channel == null) return;
    setBusy(true);
    setError(null);
    // One call: naming it and marking it fitted are the same act from the operator's side,
    // and splitting them would leave a half-added sensor if the second call failed.
    const res = await api.updateGasSensor(channel, {
      locationLabel: label.trim(),
      enabled: true,
    });
    setBusy(false);
    if (!res.success) {
      setError(res.error || "Could not add the sensor.");
      return;
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      style={{ background: "rgba(8,9,12,0.7)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md"
        style={{
          background: "var(--gf-panel)",
          border: "1px solid var(--gf-panel-border)",
          borderRadius: 2,
          fontFamily: "'JetBrains Mono', monospace",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="px-5 py-3 flex items-center justify-between"
          style={{ borderBottom: "1px solid var(--gf-divider)" }}
        >
          <h3 className="text-[14px] font-semibold" style={{ color: "var(--gf-text-primary)" }}>
            {editing ? "Edit smoke sensor" : "Add smoke sensor"}
          </h3>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ color: "var(--gf-text-dim)" }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <form onSubmit={submit} className="p-5 flex flex-col gap-4">
          {!esp32Online && (
            <div
              className="flex items-start gap-2 px-3 py-2.5"
              style={{
                background: "rgba(255,120,10,0.08)",
                border: "1px solid rgba(255,120,10,0.2)",
                borderRadius: 2,
              }}
            >
              <p className="text-[12px] leading-relaxed" style={{ color: ORANGE }}>
                ESP32 offline — the pins below are the last ones it reported. They are almost
                certainly still right, but confirm against the board before soldering.
              </p>
            </div>
          )}

          {free.length === 0 && (
            <p className="text-[12px] leading-relaxed" style={{ color: "var(--gf-text-muted)" }}>
              All four channels are in use — pick one below to rename or remove it. The ESP32
              cannot drive a fifth: ADC2 is unreadable while WiFi is on, and two of ADC1's
              remaining pins are reserved for IR transmitters. A fifth needs a second ESP32.
            </p>
          )}
          <div className="flex flex-col gap-1.5">
                <label
                  className="text-[11px] tracking-widest uppercase"
                  style={{ color: "var(--gf-text-muted)" }}
                >
                  Sensor channel
                </label>
                <div className="flex flex-col gap-1.5">
                  {sensors.map((s) => {
                    const inUse = s.enabled;
                    const isSel = channel === s.channel;
                    return (
                      <button
                        key={s.channel}
                        type="button"
                        onClick={() => pick(s.channel)}
                        className="flex items-center justify-between px-3 py-2.5 text-left"
                        style={{
                          // In-use rows stay SELECTABLE — this is also where renaming and
                          // removing live — but sit back visually so the free slots still read
                          // as the default action.
                          opacity: inUse && !isSel ? 0.55 : 1,
                          cursor: "pointer",
                          background: isSel ? "var(--gf-accent-dim)" : "var(--gf-hover)",
                          border: `1px solid ${isSel ? "var(--gf-accent)" : "var(--gf-divider)"}`,
                          borderRadius: 2,
                        }}
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className="w-6 h-6 flex items-center justify-center text-[13px] font-bold"
                            style={{
                              background: isSel ? "var(--gf-accent)" : "var(--gf-hover-strong)",
                              color: isSel ? "#fff" : "var(--gf-text-muted)",
                              borderRadius: 2,
                            }}
                          >
                            {s.channel}
                          </span>
                          <div>
                            <div
                              className="text-[13px] font-semibold"
                              style={{ color: "var(--gf-text-primary)" }}
                            >
                              {inUse ? s.label : `Channel ${s.channel}`}
                            </div>
                            {s.gpio != null ? (
                              <div className="text-[12px]" style={{ color: "var(--gf-text-muted)" }}>
                                Wire MQ-2 AOUT →{" "}
                                <span className="font-bold" style={{ color: "var(--gf-accent)" }}>
                                  GPIO {s.gpio}
                                </span>
                                {SILKSCREEN[s.gpio] && (
                                  <>
                                    {" "}
                                    · marked{" "}
                                    <span className="font-bold" style={{ color: "var(--gf-accent)" }}>
                                      {SILKSCREEN[s.gpio]}
                                    </span>{" "}
                                    on the board
                                  </>
                                )}
                              </div>
                            ) : (
                              <div className="text-[12px]" style={{ color: "var(--gf-text-dim)" }}>
                                Pin unknown — the ESP32 has not reported yet
                              </div>
                            )}
                          </div>
                        </div>
                        <span
                          className="text-[11px] font-bold tracking-widest px-2 py-0.5"
                          style={{
                            color: inUse ? "var(--gf-text-dim)" : GREEN,
                            background: inUse ? "var(--gf-hover)" : "rgba(115,191,105,0.1)",
                            borderRadius: 2,
                          }}
                        >
                          {inUse ? "IN USE" : "AVAIL"}
                        </span>
                      </button>
                    );
                  })}
                </div>
          </div>

          <div className="flex flex-col gap-1.5">
                <label
                  className="text-[11px] tracking-widest uppercase"
                  style={{ color: "var(--gf-text-muted)" }}
                >
                  Location
                </label>
                <input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Above UPS cabinet"
                  maxLength={100}
                  className="w-full px-3 py-2 text-[14px] focus:outline-none"
                  style={{
                    background: "var(--gf-hover)",
                    border: "1px solid var(--gf-divider)",
                    color: "var(--gf-text-primary)",
                    borderRadius: 2,
                    fontFamily: "monospace",
                  }}
                />
                <p className="text-[11px] leading-relaxed" style={{ color: "var(--gf-text-dim)" }}>
                  This name is what alerts, the Dashboard and the chart will say instead of
                  "MQ2-{channel ?? "n"}". Optional, but an unnamed sensor cannot tell anyone
                  which end of the room to go to.
                </p>
          </div>

          {!editing && (
            <div
              className="px-3 py-2.5 text-[11px] leading-relaxed"
              style={{
                background: "rgba(255,120,10,0.08)",
                border: "1px solid rgba(255,120,10,0.2)",
                borderRadius: 2,
                color: ORANGE,
              }}
            >
              Wire the sensor first — an empty pin picks up noise that can trigger a false
              alarm. Then run <strong>Recalibrate</strong> in clean air to set its baseline.
            </div>
          )}

          {error && (
            <p className="text-[12px]" style={{ color: "#E02F44" }}>
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            {editing && (
              // Sits apart from the primary action, and says "remove" rather than "delete":
              // the channel and its name survive, only the claim that a sensor is wired to it
              // is withdrawn.
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                className="mr-auto px-3 py-2 text-[13px] disabled:opacity-50"
                style={{
                  background: "transparent",
                  color: "#E02F44",
                  border: "1px solid rgba(224,47,68,0.4)",
                  borderRadius: 2,
                }}
              >
                Remove sensor
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-[13px]"
              style={{
                background: "transparent",
                color: "var(--gf-text-muted)",
                border: "1px solid var(--gf-divider)",
                borderRadius: 2,
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || channel == null}
              className="px-4 py-2 text-[13px] font-semibold disabled:opacity-50"
              style={{ background: "var(--gf-accent)", color: "#fff", borderRadius: 2 }}
            >
              {busy ? "Saving…" : editing ? "Save changes" : "Add sensor"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
