-- ─────────────────────────────────────────────────────────────────────────────
--  Gas (MQ-2) sensors become MANAGED DATA, not two hardcoded fields.
--
--  WHY
--  Two MQ-2s were `mq2_1_ppm` / `mq2_2_ppm`: a pair of field names repeated across
--  the firmware payload, sensorHandler's validation, the InfluxDB write, the SD
--  card's CSV, the backup NDJSON and three frontend pages. Adding a third sensor
--  meant editing every one of them, which is exactly the reflash-and-redeploy the
--  IR channel pool was built to avoid.
--
--  It also left the sensors ANONYMOUS. Once they are placed apart — one over the
--  rack, one over the UPS cabinet, which is the only placement that makes two
--  sensors worth having — "MQ2-2 is critical" does not tell anyone which end of the
--  room to run to. The label is the point of the feature, not decoration.
--
--  SHAPE
--  One row per physical channel, mirroring `network_interfaces.location_label` and
--  the IR channel pool: the DEVICE reports which pins it has, the DATABASE says
--  which are wired up and what each one is called. Adding a sensor is then wiring
--  it and ticking a box.
--
--  ⚠️ CHANNEL IS 1-BASED and maps to the firmware's MQ2_PINS[channel-1], the same
--  convention `aircon_state.ir_channel` already uses. Keeping the two consistent
--  matters because both are edited by the same person on the same hardware.
--
--  ⚠️ THE CAP IS HARDWARE, NOT SCHEMA. The ESP32 can drive at most four of these:
--  ADC2 is unusable whenever WiFi is on (the WiFi driver owns it), which leaves
--  ADC1's GPIO 32/33/34/35/36/39, and 32/33 are already reserved for IR channels 3
--  and 4. Nothing here enforces 4 — a second ESP32 would raise the ceiling without
--  a schema change, which is the whole reason this is a table.
--
--  Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `gas_sensors` (
  `channel` tinyint(3) UNSIGNED NOT NULL,
  -- Where this sensor physically IS. NULL until somebody says, and the UI then
  -- falls back to "MQ2-<channel>" — the same COALESCE-to-a-technical-name pattern
  -- as devices.display_name, so an unlabelled sensor is never a blank space.
  `location_label` varchar(100) DEFAULT NULL,
  -- Is a sensor actually soldered to this pin? An unwired ADC input FLOATS: it does
  -- not read zero, it reads noise, and noise through the MQ-2 curve is a plausible
  -- looking ppm that can trip a smoke alarm. So a channel is silent until somebody
  -- asserts the hardware exists — the same reason enabledChannels[] starts false for
  -- unwired IR pins.
  `enabled` tinyint(1) NOT NULL DEFAULT 0,
  `updated_by` int(11) DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`channel`),
  KEY `fk_gas_sensors_user` (`updated_by`),
  CONSTRAINT `fk_gas_sensors_user` FOREIGN KEY (`updated_by`) REFERENCES `users` (`user_id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- Seed the four channels the current board can reach. 1 and 2 are the sensors that
-- have always existed, so they arrive ENABLED — a migration must not silently turn
-- off the smoke detection that was already running. 3 and 4 are the free ADC1 pins
-- (GPIO 36 / 39), present so an admin can enable one the moment it is wired, and
-- disabled until then.
INSERT IGNORE INTO `gas_sensors` (`channel`, `location_label`, `enabled`) VALUES
  (1, NULL, 1),
  (2, NULL, 1),
  (3, NULL, 0),
  (4, NULL, 0);

-- ─────────────────────────────────────────────────────────────────────────────
--  Remember the ADC pin each channel sits on.
--
--  The DEVICE is authoritative: the ESP32 sends `gasSensorMap` on every connect and
--  overwrites these. But holding that only in memory meant the "Add smoke sensor"
--  dialog showed "GPIO — sensor offline" for the one audience it exists for — somebody
--  standing at the box, before it is wired, asking which pin to solder to. It also went
--  blank on every backend restart until the ESP32 happened to reconnect.
--
--  So it is REMEMBERED here rather than re-asked. Seeded with the pins the current
--  firmware uses so the dialog is useful on day one; the device corrects them the moment
--  it connects, which is what makes this a cache rather than a second source of truth.
--
--  ⚠️ ADC1 ONLY. ADC2 cannot be read while WiFi is on — the WiFi driver owns it — and
--  GPIO 32/33 are reserved for IR channels 3 and 4. That leaves 34, 35, 36, 39.
--  36 and 39 are INPUT-ONLY (VP/VN): fine for an analog sensor, useless for anything
--  that has to drive a line.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE `gas_sensors`
  ADD COLUMN IF NOT EXISTS `gpio` tinyint(3) UNSIGNED DEFAULT NULL AFTER `channel`;

UPDATE `gas_sensors` SET `gpio` = 34 WHERE `channel` = 1 AND `gpio` IS NULL;
UPDATE `gas_sensors` SET `gpio` = 35 WHERE `channel` = 2 AND `gpio` IS NULL;
UPDATE `gas_sensors` SET `gpio` = 36 WHERE `channel` = 3 AND `gpio` IS NULL;
UPDATE `gas_sensors` SET `gpio` = 39 WHERE `channel` = 4 AND `gpio` IS NULL;
