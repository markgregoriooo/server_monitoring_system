-- Configurable auto-cooling IR zone boundaries for the ESP32.
--
-- The firmware's getIRZone() compares the live room temperature against these
-- boundaries to decide which AC setting to fire. Each zone maps to a FIXED captured
-- IR code / target temp in the firmware (28/26/24/22/20 °C), so only the BOUNDARIES
-- (when IR fires) are configurable here, not the target temps.
--
-- A single global row (one server room / one ESP32). Pushed to the device live via the
-- "acConfig" socket event (on connect + after any change) — mirrors envConfig / alert_rules.

CREATE TABLE IF NOT EXISTS aircon_ir_config (
  id             TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  cold_below     DECIMAL(4,1) NOT NULL DEFAULT 22.0,  -- <  this → TOO_COLD   (28 C Auto)
  normal_max     DECIMAL(4,1) NOT NULL DEFAULT 24.0,  -- <= this → NORMAL     (26 C Auto)
  acceptable_max DECIMAL(4,1) NOT NULL DEFAULT 27.0,  -- <= this → ACCEPTABLE (24 C Auto)
  near_crit_max  DECIMAL(4,1) NOT NULL DEFAULT 29.0,  -- <= this → NEAR_CRIT  (22 C High); above → CRITICAL (20 C High)
  updated_by     INT NULL,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_aircon_ir_config_user FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL
);

-- Seed the single row with the firmware's original hardcoded defaults so behavior is
-- identical day one. Idempotent.
INSERT INTO aircon_ir_config (id, cold_below, normal_max, acceptable_max, near_crit_max)
VALUES (1, 22.0, 24.0, 27.0, 29.0)
ON DUPLICATE KEY UPDATE id = id;
