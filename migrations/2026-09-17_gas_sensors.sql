-- ─────────────────────────────────────────────────────────────────────────────
--  MQ-2 gas sensors as managed data instead of two fixed fields.
--
--  mq2_1_ppm / mq2_2_ppm were repeated across the firmware, sensorHandler, InfluxDB,
--  the SD card format, the backup and three pages, so adding a sensor meant changing
--  all of them. The sensors also had no names, so "MQ2-2 is critical" did not say where
--  in the room.
--
--  One row per channel, like the IR channels: the ESP32 reports its pins, the database
--  records which are wired and what each is called.
--
--  Channel is 1-based and maps to the firmware's MQ2_PINS[channel-1], like
--  aircon_state.ir_channel.
--
--  The limit of four is the hardware (ADC2 is unusable with WiFi on, and GPIO 32/33 are
--  for IR), not the schema.
--
--  Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `gas_sensors` (
  `channel` tinyint(3) UNSIGNED NOT NULL,
  -- Where this sensor is. NULL until set; the UI then shows "MQ2-<channel>", like
  -- devices.display_name.
  `location_label` varchar(100) DEFAULT NULL,
  -- Is a sensor wired to this pin? An unwired ADC pin reads noise that can look like smoke,
  -- so a channel is ignored until enabled (like unwired IR pins).
  `enabled` tinyint(1) NOT NULL DEFAULT 0,
  `updated_by` int(11) DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`channel`),
  KEY `fk_gas_sensors_user` (`updated_by`),
  CONSTRAINT `fk_gas_sensors_user` FOREIGN KEY (`updated_by`) REFERENCES `users` (`user_id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- Seed the four channels. 1 and 2 are the existing sensors and start enabled, so smoke
-- detection keeps running. 3 and 4 (GPIO 36 / 39) start disabled until wired.
INSERT IGNORE INTO `gas_sensors` (`channel`, `location_label`, `enabled`) VALUES
  (1, NULL, 1),
  (2, NULL, 1),
  (3, NULL, 0),
  (4, NULL, 0);

-- ─────────────────────────────────────────────────────────────────────────────
--  Remember the ADC pin of each channel.
--
--  The ESP32 sends `gasSensorMap` on every connect and overwrites these. Storing them
--  lets the "Add smoke sensor" dialog show the pin before the sensor is wired and after
--  a backend restart. Seeded with the current firmware's pins.
--
--  ADC1 only: ADC2 cannot be read with WiFi on, and GPIO 32/33 are for IR, which leaves
--  34, 35, 36, 39. 36 and 39 are input-only (VP/VN).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE `gas_sensors`
  ADD COLUMN IF NOT EXISTS `gpio` tinyint(3) UNSIGNED DEFAULT NULL AFTER `channel`;

UPDATE `gas_sensors` SET `gpio` = 34 WHERE `channel` = 1 AND `gpio` IS NULL;
UPDATE `gas_sensors` SET `gpio` = 35 WHERE `channel` = 2 AND `gpio` IS NULL;
UPDATE `gas_sensors` SET `gpio` = 36 WHERE `channel` = 3 AND `gpio` IS NULL;
UPDATE `gas_sensors` SET `gpio` = 39 WHERE `channel` = 4 AND `gpio` IS NULL;
