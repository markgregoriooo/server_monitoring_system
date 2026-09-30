-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1
-- Generation Time: Aug 10, 2026 at 04:01 AM
-- Server version: 10.4.32-MariaDB
-- PHP Version: 8.2.12

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `cspc-ictu-monitoring-system`
--

-- --------------------------------------------------------

--
-- Table structure for table `agent_install_keys`
--
-- Enrollment keys managed from the dashboard (replacing AGENT_INSTALL_KEY in
-- backend/.env). Only the SHA-256 hash (for lookup) and a short prefix (for display)
-- are stored, never the key. Revoking a key does not revoke enrolled agents: they use
-- their own AGT- token in agent_tokens.

CREATE TABLE `agent_install_keys` (
  `install_key_id` int(11) NOT NULL,
  `key_hash` char(64) NOT NULL COMMENT 'SHA-256 hex of the plaintext key — the lookup path at enrollment',
  `key_cipher` varchar(255) DEFAULT NULL COMMENT 'AES-256-GCM of the plaintext key, for re-displaying the install command; NULL = not recoverable',
  `key_prefix` varchar(16) NOT NULL COMMENT 'Leading chars, shown in the UI to identify a key that can no longer be read',
  `label` varchar(100) NOT NULL,
  `created_by` int(11) DEFAULT NULL,
  `revoked_by` int(11) DEFAULT NULL,
  `expires_at` timestamp NULL DEFAULT NULL COMMENT 'NULL = never expires',
  `revoked_at` timestamp NULL DEFAULT NULL COMMENT 'NULL = still valid',
  `last_used_at` timestamp NULL DEFAULT NULL,
  `use_count` int(11) NOT NULL DEFAULT 0 COMMENT 'How many agents enrolled with this key',
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `agent_tokens`
--

-- No readable credential is stored in this table. The pending token is stored as a
-- SHA-256 hash (`pending_token_hash`), since POST /agents/status exchanges it for the
-- permanent token. The permanent AGT- token is stored as a hash for lookup
-- (`approved_token_hash`) plus an encrypted copy (`approved_token_cipher`) so an agent
-- that loses agent.conf can collect it again. See
-- migrations/2026-08-25_agent_token_hash.sql and audits/api-infra-security-2026-08-25.md A-05.

CREATE TABLE `agent_tokens` (
  `id` int(11) NOT NULL,
  `device_id` int(11) NOT NULL,
  `install_key_id` int(11) DEFAULT NULL COMMENT 'Which install key enrolled this agent; NULL = legacy/.env enrollment',
  `pending_token_hash` char(64) DEFAULT NULL COMMENT 'SHA-256 hex of the pending enrollment token — the lookup path for POST /agents/status',
  `approved_token_hash` char(64) DEFAULT NULL COMMENT 'SHA-256 hex of the AGT- token — the lookup path for every metric POST',
  `approved_token_cipher` varchar(255) DEFAULT NULL COMMENT 'AES-256-GCM of the token, for re-delivery to an agent that lost agent.conf. NULL = not recoverable',
  `status` enum('pending','approved','rejected','revoked') DEFAULT NULL COMMENT 'revoked = authorisation withdrawn by revoking the install key; row kept so the device and its history survive',
  `created_at` datetime NOT NULL DEFAULT current_timestamp(),
  `last_used_at` datetime NOT NULL,
  `approved_at` datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `aircon_ir_config`
--

CREATE TABLE `aircon_ir_config` (
  `id` tinyint(3) UNSIGNED NOT NULL,
  `cold_below` decimal(4,1) NOT NULL DEFAULT 22.0,
  `normal_max` decimal(4,1) NOT NULL DEFAULT 24.0,
  `acceptable_max` decimal(4,1) NOT NULL DEFAULT 27.0,
  `near_crit_max` decimal(4,1) NOT NULL DEFAULT 29.0,
  `updated_by` int(11) DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

--
-- Dumping data for table `aircon_ir_config`
--

INSERT INTO `aircon_ir_config` (`id`, `cold_below`, `normal_max`, `acceptable_max`, `near_crit_max`, `updated_by`, `updated_at`) VALUES
(1, 22.0, 24.0, 27.0, 29.0, NULL, '2026-08-09 12:46:11');

-- --------------------------------------------------------

--
-- Table structure for table `aircon_logs`
--

CREATE TABLE `aircon_logs` (
  `id` int(11) NOT NULL,
  `device_id` int(11) NOT NULL,
  `user_id` int(11) DEFAULT NULL,
  `action` varchar(255) NOT NULL,
  `reason` varchar(255) NOT NULL,
  `trigger_type` enum('manual','auto','schedule') NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `aircon_state`
--

CREATE TABLE `aircon_state` (
  `aircon_state_id` int(11) NOT NULL,
  `device_id` int(11) NOT NULL,
  `ir_channel` tinyint(3) UNSIGNED NOT NULL DEFAULT 1 COMMENT 'ESP32 IR transmitter slot (1-based). Must match IR_CHANNEL_PINS[] index in firmware.',
  `triggered_by_user_id` int(11) DEFAULT NULL,
  `mode` enum('cool','auto','fan') DEFAULT NULL,
  `set_temperature` int(11) DEFAULT NULL,
  `fan_mode` varchar(45) DEFAULT NULL,
  `is_on` tinyint(4) DEFAULT NULL,
  `last_trigger` enum('manual','auto','schedule') DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `alerts`
--

CREATE TABLE `alerts` (
  `alert_id` int(11) NOT NULL,
  `device_id` int(11) DEFAULT NULL,
  `alert_rule_id` int(11) DEFAULT NULL,
  `acknowledged_by` int(11) DEFAULT NULL,
  `resolved_by` int(11) DEFAULT NULL,
  `metric_value` float DEFAULT NULL,
  `type` varchar(100) NOT NULL,
  `title` varchar(100) NOT NULL,
  `message` text NOT NULL,
  `severity` enum('critical','warning','info') NOT NULL,
  `status` enum('active','acknowledged','resolved') NOT NULL DEFAULT 'active',
  `acknowledged_at` timestamp NULL DEFAULT NULL,
  `resolved_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `alert_notifications`
--

CREATE TABLE `alert_notifications` (
  `id` int(11) NOT NULL,
  `alert_id` int(11) NOT NULL,
  `user_id` int(11) NOT NULL,
  `is_read` tinyint(4) NOT NULL DEFAULT 0,
  `emailed` tinyint(4) NOT NULL DEFAULT 0,
  `sent_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `read_at` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `alert_rules`
--

CREATE TABLE `alert_rules` (
  `alert_rule_id` int(11) NOT NULL,
  `device_id` int(11) DEFAULT NULL,
  `interface_name` varchar(50) DEFAULT NULL,
  `metric_name` varchar(50) NOT NULL,
  `threshold_value` float NOT NULL,
  `comparison` enum('>','<','>=','<=','=') NOT NULL,
  `severity` enum('critical','warning','info') NOT NULL,
  `is_active` tinyint(4) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_by` int(11) DEFAULT NULL,
  -- Derived scope keys, never written directly. They let the unique index below compare
  -- rules where device_id / interface_name are NULL (every global rule has device_id NULL),
  -- because a UNIQUE index treats NULLs as distinct.
  -- -1 is safe: device_id is an AUTO_INCREMENT key, never negative.
  -- '' is safe: alertRuleValidation's nullableStr() stores an empty port name as NULL.
  `scope_device` int(11) AS (IFNULL(`device_id`, -1)) PERSISTENT COMMENT 'Derived. NULL device_id folded to -1 for uq_alert_rules_scope_severity.',
  `scope_iface` varchar(50) AS (IFNULL(`interface_name`, '')) PERSISTENT COMMENT 'Derived. NULL interface_name folded to an empty string, same reason.'
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

--
-- Dumping data for table `alert_rules`
--

INSERT INTO `alert_rules` (`alert_rule_id`, `device_id`, `interface_name`, `metric_name`, `threshold_value`, `comparison`, `severity`, `is_active`, `created_at`, `updated_at`, `updated_by`) VALUES
(1, NULL, NULL, 'cpu', 80, '>=', 'warning', 1, '2026-06-14 06:02:06', '2026-06-14 06:02:06', NULL),
(2, NULL, NULL, 'cpu', 90, '>=', 'critical', 1, '2026-06-14 06:02:06', '2026-06-14 06:02:06', NULL),
(3, NULL, NULL, 'mem', 80, '>=', 'warning', 1, '2026-06-14 06:02:06', '2026-06-14 06:02:06', NULL),
(4, NULL, NULL, 'mem', 95, '>=', 'critical', 1, '2026-06-14 06:02:06', '2026-06-14 14:10:26', NULL),
(5, NULL, NULL, 'disk', 80, '>=', 'warning', 1, '2026-06-14 06:02:06', '2026-06-14 06:02:06', NULL),
(6, NULL, NULL, 'disk', 90, '>=', 'critical', 1, '2026-06-14 06:02:06', '2026-06-14 06:02:06', NULL),
-- temperature + humidity follow ASHRAE TC 9.9 (Thermal Guidelines, 5th ed.): warning at the
-- edge of the recommended envelope (27 °C), critical at the Class A1 allowable limit
-- (32 °C / 80 %RH). Changed from 30/34 °C and 70 %RH on 2026-09-25, see
-- migrations/2026-09-25_ashrae_env_thresholds.sql
(8, NULL, NULL, 'temperature', 32, '>=', 'critical', 1, '2026-06-14 06:02:06', '2026-07-23 10:23:05', NULL),
(9, NULL, NULL, 'gas', 150, '>=', 'warning', 1, '2026-06-14 06:02:06', '2026-07-23 10:20:16', NULL),
(10, NULL, NULL, 'gas', 300, '>=', 'critical', 1, '2026-06-14 06:02:06', '2026-07-23 10:21:50', NULL),
(11, NULL, NULL, 'humidity', 60, '>=', 'warning', 1, '2026-06-14 06:02:06', '2026-07-31 04:55:21', NULL),
(12, NULL, NULL, 'humidity', 80, '>=', 'critical', 1, '2026-06-14 06:02:06', '2026-07-31 04:55:29', NULL),
(16, NULL, NULL, 'temperature', 27, '>=', 'warning', 1, '2026-06-15 03:42:28', '2026-07-23 10:20:29', NULL),
(17, NULL, NULL, 'router_cpu', 85, '>=', 'warning', 1, '2026-07-01 02:48:11', '2026-07-01 02:48:11', NULL),
(18, NULL, NULL, 'router_cpu', 95, '>=', 'critical', 1, '2026-07-01 02:48:11', '2026-07-01 02:48:11', NULL),
(19, NULL, NULL, 'router_mem', 85, '>=', 'warning', 1, '2026-07-01 02:48:11', '2026-07-01 02:48:11', NULL),
(20, NULL, NULL, 'router_mem', 95, '>=', 'critical', 1, '2026-07-01 02:48:11', '2026-07-01 02:48:11', NULL),
(21, NULL, NULL, 'link_util', 80, '>=', 'warning', 1, '2026-07-01 02:48:11', '2026-07-01 02:48:11', NULL),
(22, NULL, NULL, 'link_util', 95, '>=', 'critical', 1, '2026-07-01 02:48:11', '2026-07-01 02:48:11', NULL),
(23, NULL, NULL, 'ups_charge', 50, '<=', 'warning', 1, '2026-07-01 02:48:11', '2026-07-01 02:48:11', NULL),
(24, NULL, NULL, 'ups_charge', 20, '<=', 'critical', 1, '2026-07-01 02:48:11', '2026-07-01 02:48:11', NULL),
(25, NULL, NULL, 'ups_runtime', 10, '<=', 'warning', 1, '2026-07-01 02:48:11', '2026-07-01 02:48:11', NULL),
(26, NULL, NULL, 'ups_runtime', 5, '<=', 'critical', 1, '2026-07-01 02:48:11', '2026-07-01 02:48:11', NULL),
(28, NULL, NULL, 'link_errors', 10, '>=', 'warning', 1, '2026-07-31 07:08:15', '2026-07-31 07:08:15', NULL),
(29, NULL, NULL, 'link_errors', 100, '>=', 'critical', 1, '2026-07-31 07:08:15', '2026-07-31 07:08:15', NULL),
-- ups_load and router_clients rules (no rule means no alert). router_clients is inactive:
-- the right number depends on the site, so an admin sets it.
-- See migrations/2026-08-16_missing_alert_rules.sql
(30, NULL, NULL, 'ups_load', 80, '>=', 'warning', 1, '2026-08-16 00:00:00', '2026-08-16 00:00:00', NULL),
(31, NULL, NULL, 'ups_load', 90, '>=', 'critical', 1, '2026-08-16 00:00:00', '2026-08-16 00:00:00', NULL),
(32, NULL, NULL, 'router_clients', 200, '>=', 'warning', 0, '2026-08-16 00:00:00', '2026-08-16 00:00:00', NULL),
(33, NULL, NULL, 'router_clients', 300, '>=', 'critical', 0, '2026-08-16 00:00:00', '2026-08-16 00:00:00', NULL),
-- ICMP link quality (deviceAlerts.checkRouter): what SNMP cannot report, and the only
-- numeric metrics a ping-only router has. See migrations/2026-08-22_icmp_alert_rules.sql
-- router_loss is active: 0% loss is healthy everywhere.
-- With PING_COUNT=3 loss can only be 0/33/67/100, so both bands trip on the first lost
-- echo. Raise PING_COUNT to 10 for 10% steps.
(34, NULL, NULL, 'router_loss', 5, '>=', 'warning', 1, '2026-08-22 00:00:00', '2026-08-22 00:00:00', NULL),
(35, NULL, NULL, 'router_loss', 20, '>=', 'critical', 1, '2026-08-22 00:00:00', '2026-08-22 00:00:00', NULL),
-- router_latency is inactive: normal latency depends on the link (<1 ms for a rack
-- switch, 20-40 ms for ISP equipment). Watch a device's real value, then set a
-- per-device rule at about 2-3x it and enable it.
(36, NULL, NULL, 'router_latency', 100, '>=', 'warning', 0, '2026-08-22 00:00:00', '2026-08-22 00:00:00', NULL),
(37, NULL, NULL, 'router_latency', 300, '>=', 'critical', 0, '2026-08-22 00:00:00', '2026-08-22 00:00:00', NULL);

-- --------------------------------------------------------

--
-- Table structure for table `devices`
--

CREATE TABLE `devices` (
  `device_id` int(11) NOT NULL,
  `ip_address` varchar(100) DEFAULT NULL,
  `device_name` varchar(100) NOT NULL,
  `display_name` varchar(100) DEFAULT NULL,
  `device_type` enum('aircon','server','ups','router','esp32','mikrotik') NOT NULL,
  `status` enum('online','offline','warning','maintenance') DEFAULT NULL,
  `location` varchar(100) NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `device_logs`
--

CREATE TABLE `device_logs` (
  `device_log_id` int(11) NOT NULL,
  `device_id` int(11) NOT NULL,
  `log_level` enum('info','warning','critical','error') DEFAULT NULL,
  `message` text DEFAULT NULL,
  `recorded_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `device_metrics_config`
--

CREATE TABLE `device_metrics_config` (
  `metric_config_id` int(11) NOT NULL,
  `device_id` int(11) NOT NULL,
  `metric_name` varchar(100) NOT NULL,
  `unit` varchar(100) DEFAULT NULL,
  `threshold_max` float DEFAULT NULL,
  `threshold_min` float DEFAULT NULL,
  `polling_interval_sec` int(11) DEFAULT NULL,
  `is_enabled` tinyint(4) DEFAULT NULL,
  `description` varchar(255) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `device_network`
--

CREATE TABLE `device_network` (
  `network_id` int(11) NOT NULL,
  `device_id` int(11) NOT NULL,
  `gateway` varchar(100) NOT NULL,
  `dns` varchar(100) NOT NULL,
  `network_segment` varchar(100) NOT NULL,
  `mac_address` varchar(255) DEFAULT NULL,
  `snmp_port` int(11) DEFAULT NULL,
  `snmp_community` varchar(255) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `gas_sensors`
--
-- One row per MQ-2 channel. `channel` is 1-based and maps to the firmware's
-- MQ2_PINS[channel-1], like aircon_state.ir_channel. The ESP32 reports its pins; this
-- table records which have a sensor wired and where it is. The limit of four is the
-- hardware (ADC2 is unusable with WiFi on, GPIO 32/33 are for IR), not the schema.
-- See migrations/2026-09-17_gas_sensors.sql

CREATE TABLE `gas_sensors` (
  `channel` tinyint(3) UNSIGNED NOT NULL,
  -- The pin the ESP32 reported for this channel on its last connect, kept so the "wire a
  -- sensor" dialog can show it before the ESP32 connects. The firmware remains the source.
  `gpio` tinyint(3) UNSIGNED DEFAULT NULL,
  -- Where this sensor physically IS. NULL until somebody says, and the UI falls back to
  -- "MQ2-<channel>" — the same COALESCE-to-a-technical-name pattern as devices.display_name.
  `location_label` varchar(100) DEFAULT NULL,
  -- Is a sensor wired to this pin? An unwired ADC pin reads noise that can look like smoke,
  -- so a channel is ignored until enabled (like unwired IR pins).
  `enabled` tinyint(1) NOT NULL DEFAULT 0,
  `updated_by` int(11) DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

--
-- Dumping data for table `gas_sensors`
--
-- Channels 1 and 2 (the sensors already wired) start enabled, so smoke detection is on
-- after a fresh install. Channels 3 and 4 start disabled until sensors are fitted.

INSERT INTO `gas_sensors` (`channel`, `gpio`, `location_label`, `enabled`) VALUES
(1, 34, NULL, 1),
(2, 35, NULL, 1),
(3, 36, NULL, 0),
(4, 39, NULL, 0);

-- --------------------------------------------------------

--
-- Table structure for table `ir_commands`
--

CREATE TABLE `ir_commands` (
  `ir_command_id` int(11) NOT NULL,
  `device_id` int(11) NOT NULL,
  `command_name` varchar(50) NOT NULL,
  `raw_signal` varchar(255) NOT NULL,
  `description` varchar(100) NOT NULL,
  `status` enum('active','inactive') DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `mikrotik_devices`
--

CREATE TABLE `mikrotik_devices` (
  `mikrotik_id` int(11) NOT NULL,
  `device_id` int(11) NOT NULL,
  `routeros_version` varchar(50) DEFAULT NULL,
  `board_model` varchar(100) DEFAULT NULL,
  `api_port` int(11) DEFAULT 8728,
  `use_tls` tinyint(4) NOT NULL DEFAULT 0,
  `api_username` varchar(100) DEFAULT NULL,
  `api_password` varchar(255) DEFAULT NULL,
  `api_enabled` tinyint(4) DEFAULT 1,
  `last_seen` timestamp NULL DEFAULT current_timestamp(),
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `network_interfaces`
--

CREATE TABLE `network_interfaces` (
  `id` int(11) NOT NULL,
  `device_id` int(11) NOT NULL,
  `interface_name` varchar(50) DEFAULT NULL,
  `location_label` varchar(100) DEFAULT NULL,
  `is_active` tinyint(4) DEFAULT NULL,
  `ever_up` tinyint(1) NOT NULL DEFAULT 0 COMMENT 'Port has carried a link at least once — gates interface-down alerting',
  `monitor_link` tinyint(1) NOT NULL DEFAULT 1 COMMENT 'Admin opt-out: 0 silences interface-down alerts for this port',
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `notification_prefs`
--

CREATE TABLE `notification_prefs` (
  `user_id` int(11) NOT NULL,
  -- Alert email is opt-in (default 0): email is the only channel that reaches someone who
  -- has never signed in or seen the Privacy Notice. Matches
  -- notificationService.PREF_DEFAULTS, which registerGoogleUser uses to create the row.
  -- See migrations/2026-09-18_notification_prefs_default_off.sql
  `email_enabled` tinyint(4) NOT NULL DEFAULT 0,
  `popup_enabled` tinyint(4) NOT NULL DEFAULT 1,
  `min_email_severity` enum('info','warning','critical') NOT NULL DEFAULT 'critical',
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `reports`
--

CREATE TABLE `reports` (
  `report_id` int(11) NOT NULL,
  `generated_by` int(11) NOT NULL,
  `title` varchar(100) DEFAULT NULL,
  `type` enum('environment','server','alerts','aircon','network','ups','forecast') DEFAULT NULL,
  `paper_size` enum('a4','letter','folio') NOT NULL DEFAULT 'folio' COMMENT 'Page size the PDF was rendered at; folio = long bond, 8.5x13in',
  `reference_no` varchar(40) DEFAULT NULL COMMENT 'Assigned at build time, e.g. ICTU-SRV-2026-001. NULL until generated.',
  `device_id` int(11) DEFAULT NULL,
  -- Second scope column. device_id is a foreign key to devices, so no id can mean "the
  -- server room" (ESP32 alerts have device_id NULL). NULL here means campus-wide, as
  -- before. The two are never both set. See migrations/2026-09-18_report_room_scope.sql
  `scope_kind` varchar(16) DEFAULT NULL COMMENT 'NULL = campus-wide, ''room'' = room-level alerts only (device_id IS NULL)',
  `status` enum('pending','generated','failed') DEFAULT NULL,
  `file_path` varchar(255) DEFAULT NULL,
  `period_start` timestamp NULL DEFAULT current_timestamp(),
  `period_end` timestamp NULL DEFAULT current_timestamp(),
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `sensor_backup_batches`
--

CREATE TABLE `sensor_backup_batches` (
  `id` int(11) NOT NULL,
  `device_id` int(11) NOT NULL,
  `total_rows` int(11) DEFAULT NULL,
  `period_start` timestamp NULL DEFAULT current_timestamp(),
  `period_end` timestamp NULL DEFAULT current_timestamp(),
  `status` enum('received','processed','failed') DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `server_specs`
--

CREATE TABLE `server_specs` (
  `server_spec_id` int(11) NOT NULL,
  `device_id` int(11) NOT NULL,
  `os` varchar(100) NOT NULL,
  `kernel` varchar(100) NOT NULL,
  `cores` int(11) NOT NULL,
  `architecture` varchar(100) NOT NULL,
  `memory_total_mb` bigint(20) DEFAULT NULL,
  `disk_total_gb` bigint(20) DEFAULT NULL,
  `uptime` varchar(50) DEFAULT NULL,
  `agent_version` varchar(20) NOT NULL,
  `metric_interval_sec` smallint(5) UNSIGNED DEFAULT NULL COMMENT 'Agent posting cadence in seconds; NULL = unknown, readers assume 10',
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp(),
  `last_seen` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `settings`
--

CREATE TABLE `settings` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `updated_by` int(11) DEFAULT NULL,
  `setting_key` varchar(255) DEFAULT NULL,
  `setting_value` text DEFAULT NULL,
  `description` varchar(255) DEFAULT NULL,
  `updated_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

--
-- Dumping data for table `settings`
--
-- Report template defaults. `folio` (long bond) is ICTU's default page size; blank logo
-- file names mean "use the logos in backend/assets/branding".
-- See migrations/2026-08-28_report_template.sql and reports-client-questionnaire.md.

INSERT INTO `settings` (`setting_key`, `setting_value`, `description`) VALUES
('report.paper_size', 'folio', 'Default page size for generated PDF reports: a4 | letter | folio (long bond).'),
('report.logo_ictu', '', 'Filename under backend/branding/ of the ICTU letterhead mark. Blank = use the bundled assets/branding/ictu-logo.jpg.'),
('report.logo_cspc', '', 'Filename under backend/branding/ of the CSPC seal. Blank = use the bundled assets/branding/cspc-logo.png.'),
('report.unit_name', '', 'Large line on the report letterhead. Blank = INFORMATION AND COMMUNICATIONS TECHNOLOGY UNIT.'),
('report.signatories', '[{"role":"Prepared by:","name":"","auto":true},{"role":"Approved by:","name":"","auto":false}]', 'Report signature block as JSON: [{role,name,auto}]. auto = fill with the report generator.');

-- --------------------------------------------------------

--
-- Table structure for table `suggestions`
--

CREATE TABLE `suggestions` (
  `id` int(11) NOT NULL,
  `device_id` int(11) DEFAULT NULL,
  `dismissed_by` int(11) DEFAULT NULL,
  `domain` enum('environment','server','network','ups') NOT NULL,
  `title` varchar(150) NOT NULL,
  `message` text DEFAULT NULL,
  `trigger_metric` varchar(100) NOT NULL,
  `trigger_value` float NOT NULL,
  `priority` enum('high','medium','low') NOT NULL,
  `status` enum('open','dismissed','acted') NOT NULL,
  `dismissed_at` timestamp NULL DEFAULT current_timestamp(),
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `system_logs`
--

CREATE TABLE `system_logs` (
  `system_log_id` int(11) NOT NULL,
  `user_id` int(11) DEFAULT NULL,
  `action` varchar(255) NOT NULL,
  `description` text NOT NULL,
  `ip_address` varchar(255) DEFAULT NULL,
  `module` enum('auth','aircon','users','alerts','reports','devices','network') DEFAULT NULL,
  `user_agent` varchar(255) DEFAULT NULL,
  `log_level` enum('info','warning','error') DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `ups_details`
--

CREATE TABLE `ups_details` (
  `ups_detail_id` int(11) NOT NULL,
  `device_id` int(11) NOT NULL,
  `brand` varchar(100) DEFAULT NULL,
  `model` varchar(100) DEFAULT NULL,
  `battery_capacity` varchar(50) DEFAULT NULL,
  `communication_type` enum('usb','snmp','serial','network') DEFAULT NULL,
  `serial_number` varchar(100) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

CREATE TABLE `users` (
  `user_id` int(11) NOT NULL,
  `name` varchar(100) NOT NULL,
  `username` varchar(50) NOT NULL,
  `email` varchar(255) NOT NULL,
  `google_sub` varchar(64) DEFAULT NULL,
  `auth_provider` enum('local','google') NOT NULL DEFAULT 'google',
  `avatar` varchar(10) DEFAULT NULL,
  `hash_password` varchar(255) DEFAULT NULL,
  `role` enum('admin','it_staff') NOT NULL,
  `profile_image` varchar(255) DEFAULT NULL,
  `status` enum('pending','active','inactive','rejected') DEFAULT 'pending',
  `token_version` int(11) NOT NULL DEFAULT 0,
  `policy_version` varchar(20) DEFAULT NULL,
  `policy_accepted_at` timestamp NULL DEFAULT NULL,
  `last_login` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

-- --------------------------------------------------------

--
-- Table structure for table `widget_prefs`
--

CREATE TABLE `widget_prefs` (
  `user_id` int(11) NOT NULL,
  `layout_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`layout_json`)),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

--
-- Indexes for dumped tables
--

--
-- Indexes for table `agent_install_keys`
--
ALTER TABLE `agent_install_keys`
  ADD PRIMARY KEY (`install_key_id`),
  ADD UNIQUE KEY `uq_install_key_hash` (`key_hash`),
  ADD KEY `idx_install_key_created_by` (`created_by`),
  ADD KEY `idx_install_key_revoked_by` (`revoked_by`);

--
-- Indexes for table `agent_tokens`
--
ALTER TABLE `agent_tokens`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_agent_tokens_pending_hash` (`pending_token_hash`),
  ADD UNIQUE KEY `uq_agent_tokens_approved_hash` (`approved_token_hash`),
  ADD KEY `fk_agent_tokens_devices1_idx` (`device_id`),
  ADD KEY `idx_agent_tokens_install_key` (`install_key_id`);

--
-- Indexes for table `aircon_ir_config`
--
ALTER TABLE `aircon_ir_config`
  ADD PRIMARY KEY (`id`),
  ADD KEY `fk_aircon_ir_config_user` (`updated_by`);

--
-- Indexes for table `aircon_logs`
--
ALTER TABLE `aircon_logs`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_aircon_logs_device` (`device_id`),
  ADD KEY `idx_aircon_logs_created` (`created_at`),
  ADD KEY `fk_aircon_logs_users1_idx` (`user_id`);

--
-- Indexes for table `aircon_state`
--
ALTER TABLE `aircon_state`
  ADD PRIMARY KEY (`aircon_state_id`),
  ADD UNIQUE KEY `idx_aircon_state_device` (`device_id`),
  ADD UNIQUE KEY `idx_aircon_ir_channel` (`ir_channel`),
  ADD KEY `fk_aircon_state_users1_idx` (`triggered_by_user_id`);

--
-- Indexes for table `alerts`
--
ALTER TABLE `alerts`
  ADD PRIMARY KEY (`alert_id`),
  ADD KEY `fk_alerts_alert_rules1_idx` (`alert_rule_id`),
  ADD KEY `idx_alerts_device` (`device_id`),
  ADD KEY `fk_alerts_users1_idx` (`acknowledged_by`),
  ADD KEY `idx_alerts_status` (`status`),
  ADD KEY `idx_alerts_severity` (`severity`),
  ADD KEY `idx_alerts_created` (`created_at`),
  ADD KEY `idx_alerts_dev_stat` (`device_id`,`status`),
  ADD KEY `fk_alerts_resolved_by_idx` (`resolved_by`);

--
-- Indexes for table `alert_notifications`
--
ALTER TABLE `alert_notifications`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_notif_alert` (`alert_id`),
  ADD KEY `idx_notif_user` (`user_id`),
  ADD KEY `idx_notif_user_read` (`user_id`,`is_read`);

--
-- Indexes for table `alert_rules`
--
ALTER TABLE `alert_rules`
  ADD PRIMARY KEY (`alert_rule_id`),
  ADD KEY `idx_rules_device` (`device_id`),
  ADD KEY `idx_rules_active` (`is_active`),
  ADD KEY `idx_rules_dev_active` (`device_id`,`is_active`),
  ADD KEY `idx_rules_updated_by` (`updated_by`),
  ADD KEY `idx_rules_dev_iface_metric` (`device_id`,`interface_name`,`metric_name`,`is_active`),
  -- One rule per (scope, metric, severity). Two `temperature`/`warning` rows in one scope
  -- are not combined (getRoomThresholds takes the first it finds). The app checks this too
  -- (alertRuleValidation.duplicateSeverityError); this also covers rows edited in SQL.
  -- Built on the scope_* columns (see the note on the table above).
  -- See migrations/2026-08-26_alert_rule_scope_uniqueness.sql
  ADD UNIQUE KEY `uq_alert_rules_scope_severity` (`scope_device`,`scope_iface`,`metric_name`,`severity`);

--
-- Indexes for table `devices`
--
ALTER TABLE `devices`
  ADD PRIMARY KEY (`device_id`),
  ADD KEY `idx_devices_status` (`status`),
  ADD KEY `idx_devices_type` (`device_type`);

--
-- Indexes for table `device_logs`
--
ALTER TABLE `device_logs`
  ADD PRIMARY KEY (`device_log_id`),
  ADD KEY `fk_device_logs_devices1_idx` (`device_id`);

--
-- Indexes for table `device_metrics_config`
--
ALTER TABLE `device_metrics_config`
  ADD PRIMARY KEY (`metric_config_id`),
  ADD KEY `idx_metrics_cfg_device` (`device_id`),
  ADD KEY `idx_metrics_cfg_enabled` (`is_enabled`);

--
-- Indexes for table `device_network`
--
ALTER TABLE `device_network`
  ADD PRIMARY KEY (`network_id`),
  ADD UNIQUE KEY `devices_id_UNIQUE` (`device_id`),
  ADD KEY `fk_device_network_devices1_idx` (`device_id`);

--
-- Indexes for table `gas_sensors`
--
ALTER TABLE `gas_sensors`
  ADD PRIMARY KEY (`channel`),
  ADD KEY `fk_gas_sensors_user` (`updated_by`);

--
-- Indexes for table `ir_commands`
--
ALTER TABLE `ir_commands`
  ADD PRIMARY KEY (`ir_command_id`),
  ADD UNIQUE KEY `idx_ir_cmd_device_name` (`device_id`,`command_name`),
  ADD KEY `fk_ir_commands_devices_idx` (`device_id`);

--
-- Indexes for table `mikrotik_devices`
--
ALTER TABLE `mikrotik_devices`
  ADD PRIMARY KEY (`mikrotik_id`),
  ADD UNIQUE KEY `devices_id_UNIQUE` (`device_id`),
  ADD KEY `fk_mikrotik_devices_devices1_idx` (`device_id`);

--
-- Indexes for table `network_interfaces`
--
ALTER TABLE `network_interfaces`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uq_network_interfaces_device_iface` (`device_id`,`interface_name`),
  ADD KEY `fk_network_interfaces_devices1_idx` (`device_id`);

--
-- Indexes for table `notification_prefs`
--
ALTER TABLE `notification_prefs`
  ADD PRIMARY KEY (`user_id`);

--
-- Indexes for table `reports`
--
ALTER TABLE `reports`
  ADD PRIMARY KEY (`report_id`),
  ADD UNIQUE KEY `uq_reports_reference` (`reference_no`),
  ADD KEY `idx_reports_by` (`generated_by`),
  ADD KEY `idx_reports_status` (`status`),
  ADD KEY `idx_reports_created` (`created_at`),
  ADD KEY `idx_reports_device` (`device_id`);

--
-- Indexes for table `sensor_backup_batches`
--
ALTER TABLE `sensor_backup_batches`
  ADD PRIMARY KEY (`id`),
  ADD KEY `fk_sensor_backup_batches_devices1_idx` (`device_id`);

--
-- Indexes for table `server_specs`
--
ALTER TABLE `server_specs`
  ADD PRIMARY KEY (`server_spec_id`),
  ADD UNIQUE KEY `devices_id_UNIQUE` (`device_id`),
  ADD KEY `idx_server_specs_device` (`device_id`);

--
-- Indexes for table `settings`
--
ALTER TABLE `settings`
  ADD UNIQUE KEY `idx_settings_key` (`setting_key`),
  ADD KEY `fk_settings_users1_idx` (`updated_by`);

--
-- Indexes for table `suggestions`
--
ALTER TABLE `suggestions`
  ADD PRIMARY KEY (`id`),
  ADD KEY `fk_suggestions_devices1_idx` (`device_id`),
  ADD KEY `fk_suggestions_users1_idx` (`dismissed_by`);

--
-- Indexes for table `system_logs`
--
ALTER TABLE `system_logs`
  ADD PRIMARY KEY (`system_log_id`),
  ADD KEY `idx_syslogs_user` (`user_id`),
  ADD KEY `idx_syslogs_created` (`created_at`),
  ADD KEY `idx_syslogs_module` (`module`);

--
-- Indexes for table `ups_details`
--
ALTER TABLE `ups_details`
  ADD PRIMARY KEY (`ups_detail_id`),
  ADD UNIQUE KEY `devices_id_UNIQUE` (`device_id`),
  ADD KEY `fk_ups_details_devices1_idx` (`device_id`);

--
-- Indexes for table `users`
--
ALTER TABLE `users`
  ADD PRIMARY KEY (`user_id`),
  ADD UNIQUE KEY `idx_users_email` (`email`),
  ADD UNIQUE KEY `idx_users_username` (`username`),
  ADD UNIQUE KEY `idx_users_google_sub` (`google_sub`),
  ADD KEY `idx_user_role` (`role`);

--
-- Indexes for table `widget_prefs`
--
ALTER TABLE `widget_prefs`
  ADD PRIMARY KEY (`user_id`);

--
-- AUTO_INCREMENT for dumped tables
--

--
-- AUTO_INCREMENT for table `agent_install_keys`
--
ALTER TABLE `agent_install_keys`
  MODIFY `install_key_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `agent_tokens`
--
ALTER TABLE `agent_tokens`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `aircon_logs`
--
ALTER TABLE `aircon_logs`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `aircon_state`
--
ALTER TABLE `aircon_state`
  MODIFY `aircon_state_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `alerts`
--
ALTER TABLE `alerts`
  MODIFY `alert_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `alert_notifications`
--
ALTER TABLE `alert_notifications`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `alert_rules`
--
ALTER TABLE `alert_rules`
  MODIFY `alert_rule_id` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=34;

--
-- AUTO_INCREMENT for table `devices`
--
ALTER TABLE `devices`
  MODIFY `device_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `device_logs`
--
ALTER TABLE `device_logs`
  MODIFY `device_log_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `device_metrics_config`
--
ALTER TABLE `device_metrics_config`
  MODIFY `metric_config_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `device_network`
--
ALTER TABLE `device_network`
  MODIFY `network_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `ir_commands`
--
ALTER TABLE `ir_commands`
  MODIFY `ir_command_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `mikrotik_devices`
--
ALTER TABLE `mikrotik_devices`
  MODIFY `mikrotik_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `network_interfaces`
--
ALTER TABLE `network_interfaces`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `reports`
--
ALTER TABLE `reports`
  MODIFY `report_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `sensor_backup_batches`
--
ALTER TABLE `sensor_backup_batches`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `server_specs`
--
ALTER TABLE `server_specs`
  MODIFY `server_spec_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `settings`
--
ALTER TABLE `settings`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `suggestions`
--
ALTER TABLE `suggestions`
  MODIFY `id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `system_logs`
--
ALTER TABLE `system_logs`
  MODIFY `system_log_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `ups_details`
--
ALTER TABLE `ups_details`
  MODIFY `ups_detail_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- AUTO_INCREMENT for table `users`
--
ALTER TABLE `users`
  MODIFY `user_id` int(11) NOT NULL AUTO_INCREMENT;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `agent_install_keys`
--
-- SET NULL, not CASCADE: deleting the admin who created a key must not delete the key.
ALTER TABLE `agent_install_keys`
  ADD CONSTRAINT `fk_install_keys_created_by` FOREIGN KEY (`created_by`) REFERENCES `users` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_install_keys_revoked_by` FOREIGN KEY (`revoked_by`) REFERENCES `users` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE;

--
-- Constraints for table `agent_tokens`
--
ALTER TABLE `agent_tokens`
  ADD CONSTRAINT `fk_agent_tokens_devices1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`) ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT `fk_agent_tokens_install_key` FOREIGN KEY (`install_key_id`) REFERENCES `agent_install_keys` (`install_key_id`) ON DELETE SET NULL ON UPDATE CASCADE;

--
-- Constraints for table `aircon_ir_config`
--
ALTER TABLE `aircon_ir_config`
  ADD CONSTRAINT `fk_aircon_ir_config_user` FOREIGN KEY (`updated_by`) REFERENCES `users` (`user_id`) ON DELETE SET NULL;

--
-- Constraints for table `aircon_logs`
--
ALTER TABLE `aircon_logs`
  ADD CONSTRAINT `fk_aircon_logs_devices1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_aircon_logs_users1` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

--
-- Constraints for table `aircon_state`
--
ALTER TABLE `aircon_state`
  ADD CONSTRAINT `fk_aircon_state_devices1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_aircon_state_users1` FOREIGN KEY (`triggered_by_user_id`) REFERENCES `users` (`user_id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

--
-- Constraints for table `alerts`
--
ALTER TABLE `alerts`
  ADD CONSTRAINT `fk_alerts_alert_rules1` FOREIGN KEY (`alert_rule_id`) REFERENCES `alert_rules` (`alert_rule_id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_alerts_devices2` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_alerts_resolved_by` FOREIGN KEY (`resolved_by`) REFERENCES `users` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE,
  -- SET NULL, not CASCADE: deleting a user keeps the alerts they acknowledged; only the name
  -- is removed.
  ADD CONSTRAINT `fk_alerts_users1` FOREIGN KEY (`acknowledged_by`) REFERENCES `users` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE;

--
-- Constraints for table `alert_notifications`
--
ALTER TABLE `alert_notifications`
  ADD CONSTRAINT `fk_alert_notifications_alerts1` FOREIGN KEY (`alert_id`) REFERENCES `alerts` (`alert_id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_alert_notifications_users1` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `alert_rules`
--
ALTER TABLE `alert_rules`
  -- No ON UPDATE CASCADE here, unlike the other FKs: device_id feeds the generated column
  -- `scope_device`, and MariaDB 10.11 refuses a cascading update on it:
  --   ERROR 1901: Function or expression 'device_id' cannot be used in the
  --               GENERATED ALWAYS AS clause of `scope_device`
  -- With it, the import stopped at this line and skipped every constraint below. device_id
  -- is an AUTO_INCREMENT key that is never updated, so nothing is lost.
  ADD CONSTRAINT `fk_alert_rules_devices2` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`) ON DELETE CASCADE,
  ADD CONSTRAINT `fk_alert_rules_updated_by` FOREIGN KEY (`updated_by`) REFERENCES `users` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE;

--
-- Constraints for table `device_logs`
--
ALTER TABLE `device_logs`
  ADD CONSTRAINT `fk_device_logs_devices1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`) ON DELETE CASCADE ON UPDATE NO ACTION;

--
-- Constraints for table `device_metrics_config`
--
ALTER TABLE `device_metrics_config`
  ADD CONSTRAINT `fk_device_metrics_config_devices2` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `device_network`
--
ALTER TABLE `device_network`
  ADD CONSTRAINT `fk_device_network_devices1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `gas_sensors`
--
ALTER TABLE `gas_sensors`
  ADD CONSTRAINT `fk_gas_sensors_user` FOREIGN KEY (`updated_by`) REFERENCES `users` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE;

--
-- Constraints for table `ir_commands`
--
ALTER TABLE `ir_commands`
  ADD CONSTRAINT `fk_ir_commands_devices1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

--
-- Constraints for table `mikrotik_devices`
--
ALTER TABLE `mikrotik_devices`
  ADD CONSTRAINT `fk_mikrotik_devices_devices1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `network_interfaces`
--
ALTER TABLE `network_interfaces`
  ADD CONSTRAINT `fk_network_interfaces_devices1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `notification_prefs`
--
ALTER TABLE `notification_prefs`
  ADD CONSTRAINT `fk_notification_prefs_users1` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `reports`
--
ALTER TABLE `reports`
  ADD CONSTRAINT `fk_reports_devices1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_reports_users1` FOREIGN KEY (`generated_by`) REFERENCES `users` (`user_id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

--
-- Constraints for table `sensor_backup_batches`
--
ALTER TABLE `sensor_backup_batches`
  ADD CONSTRAINT `fk_sensor_backup_batches_devices1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`) ON DELETE CASCADE ON UPDATE NO ACTION;

--
-- Constraints for table `server_specs`
--
ALTER TABLE `server_specs`
  ADD CONSTRAINT `fk_server_specs_devices1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `settings`
--
ALTER TABLE `settings`
  ADD CONSTRAINT `fk_settings_users1` FOREIGN KEY (`updated_by`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `suggestions`
--
ALTER TABLE `suggestions`
  ADD CONSTRAINT `fk_suggestions_devices1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`) ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT `fk_suggestions_users1` FOREIGN KEY (`dismissed_by`) REFERENCES `users` (`user_id`) ON DELETE NO ACTION ON UPDATE NO ACTION;

--
-- Constraints for table `system_logs`
--
-- SET NULL, not CASCADE: deleting a user keeps their audit trail (including policy
-- acceptance records), which the Privacy Notice keeps for 365 days. user_id NULL already
-- means "system action" to readers.
ALTER TABLE `system_logs`
  ADD CONSTRAINT `fk_system_logs_users` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE SET NULL ON UPDATE CASCADE;

--
-- Constraints for table `ups_details`
--
ALTER TABLE `ups_details`
  ADD CONSTRAINT `fk_ups_details_devices1` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `widget_prefs`
--
ALTER TABLE `widget_prefs`
  ADD CONSTRAINT `fk_widget_prefs_users1` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
