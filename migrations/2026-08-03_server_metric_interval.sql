-- Per-agent posting cadence, so the offline sweep can size its window per server.
--
-- The sweep used a flat 30s while the agent's `-interval` is a settable flag, so
-- installing an agent with `-interval 60` flapped that server Offline→Online
-- forever (and logged a device_logs row plus an alert every cycle). The agent now
-- reports its cadence on every metric POST; the sweep waits three missed posts,
-- floored by SERVER_OFFLINE_AFTER_SEC (default 30s) and capped at 1h.
--
-- NULL = unknown (an agent older than this change, or one that never posted). The
-- readers COALESCE it to 10s, which reproduces the previous 30s behaviour exactly,
-- so applying this migration changes nothing until agents start reporting.
--
-- Safe to re-run: guarded so a second apply is a no-op.

SET @col_exists := (
  SELECT COUNT(*)
    FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'server_specs'
     AND COLUMN_NAME  = 'metric_interval_sec'
);

  SET @ddl := IF(
    @col_exists = 0,
    'ALTER TABLE `server_specs`
      ADD COLUMN `metric_interval_sec` SMALLINT UNSIGNED NULL
      COMMENT ''Agent posting cadence in seconds; NULL = unknown, readers assume 10''
      AFTER `agent_version`',
    'SELECT ''server_specs.metric_interval_sec already exists — skipping'' AS note'
  );

  PREPARE stmt FROM @ddl;
  EXECUTE stmt;
  DEALLOCATE PREPARE stmt;
