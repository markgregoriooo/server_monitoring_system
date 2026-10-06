/*
 * ============================================================
 *  ESP32 Environment & Smoke Monitoring System v2
 *  Components: up to 4x MQ-2, DHT22, Piezo Buzzer, WS2812B RGB LED,
 *              RTC (DS3231), micro SD (SPI), 2x IR Transmitter
 *
 *  ─── PIN ASSIGNMENTS ────────────────────────────────────────
 *  MQ-2 #1 AOUT  : GPIO 34  (ADC, via 10kΩ/20kΩ divider)
 *  MQ-2 #2 AOUT  : GPIO 35  (ADC, via 10kΩ/20kΩ divider)
 *  DHT22         : GPIO  4
 *  Buzzer        : GPIO 26
 *  WS2812B DIN   : GPIO 27  (1-wire, direct 3.3V signal OK)
 *  IR TX #1      : GPIO 25  (AC unit 1)
 *  IR TX #2      : GPIO 33  (AC unit 2)
 *  RTC DS3231    : SDA=21, SCL=22  (I2C, shared bus OK)
 *  micro SD      : SCK=18, MISO=19, MOSI=23, CS=5  (VSPI default)
 *  Setup button  : GPIO 13 → button → GND  (INPUT_PULLUP, no resistor)
 *                  Hold 3 s at any time to reboot into the WiFi setup
 *                  portal. Optional; BOOT still works. See PORTAL_BUTTON_PIN2.
 *
 *  --- SD CARD OFFLINE BUFFER ---
 *  Only used while the backend cannot be reached; while the socket is
 *  up the backend stores and backs up each reading itself.
 *
 *    socket DOWN  -> append the reading to /log.csv
 *    socket BACK  -> replay the file to the server as "offlineData"
 *                    events, a few rows per loop tick, then delete it
 *
 *  Fit the RTC coin cell. "offlineData" is stored under the timestamp the
 *  device sends (live data is stamped by the backend), and a DS3231 without
 *  a battery loses the time on a power cut. Rows that cannot be dated are
 *  not buffered (sdAppendRow), so without the cell an outage records nothing.
 *
 *  ─── IR TRANSMITTER LOGIC ────────────────────────────────────
 *  Both transmitters send the same signal at the same time.
 *  Temperature zone → AC setting (captured raw IR codes):
 *   < 22°C  TOO_COLD  → Cool 28°C, Auto fan
 *   22–24°C NORMAL    → Cool 26°C, Auto fan
 *   25–27°C ACCEPTABLE→ Cool 24°C, Auto fan
 *   28–29°C NEAR_CRIT → Cool 22°C, High fan
 *   > 29°C  CRITICAL  → Cool 20°C, High fan
 *  IR is only sent when the zone changes.
 *
 *  ─── RGB LED STATUS ──────────────────────────────────────────
 *  Green  = NORMAL
 *  Blue   = TOO_COLD
 *  Yellow = WARNING
 *  Orange = CRITICAL by humidity alone
 *  Red    = CRITICAL (Temp or Smoke)
 *
 *  ─── CALIBRATION ─────────
 *  The MQ-2 clean-air baseline (Ro) is measured on the first boot in a
 *  location, saved to NVS flash and reused after that. After moving the
 *  box, send the "calibrateGas" socket event from the dashboard. Ro is not
 *  measured on every boot: a reboot during a gas event would save smoky
 *  air as "clean" and under-report smoke from then on.
 * ============================================================
 */

/*
 * ── Required Libraries ──────────────────────────────────────
 *  Install via Arduino Library Manager or PlatformIO:
 *  - DHT sensor library       (Adafruit)
 *  - Adafruit Unified Sensor  (Adafruit)
 *  - ArduinoJson              (Benoit Blanchon) v6
 *  - WebSockets               (Markus Sattler)  — provides SocketIOclient
 *  - RTClib                   (Adafruit)
 *  - SD                       (built-in ESP32 core) - only when SD_ENABLED
 *  - Adafruit NeoPixel        (Adafruit)
 *  - IRremoteESP8266          (crankyoldgit) — IRsend
 *  - WiFiManager              (tzapu) — captive-portal WiFi setup
 *
 *  Tools ▸ Partition Scheme ▸ "Huge APP (3MB No OTA/1MB SPIFFS)" is required.
 *  It is an Arduino IDE setting, not saved in the sketch, so set it on every PC
 *  that builds this. On the default scheme the sketch does not fit (it shows as
 *  an upload failure). The sketch uses neither OTA nor SPIFFS.
 * ───────────────────────────────────────────────────────────
 */

#include <DHT.h>
#include <WiFi.h>
#include <WiFiManager.h>   // tzapu — captive portal: the AP, DNS hijack, scan and HTML
#include <SocketIOclient.h>
#include <ArduinoJson.h>
#include <math.h>
#include <RTClib.h>
#include <Adafruit_NeoPixel.h>
#include <IRremoteESP8266.h>
#include <IRsend.h>
#include <time.h>          // NTP via ESP32 built-in
#include <Preferences.h>   // NVS flash — persists the MQ-2 clean-air baseline
#include "secrets.h"       // WiFi + backend + DEVICE_SECRET — gitignored, see secrets.h.example

/* =================== PINS =================== */
/*
 * ---- MQ-2 GAS SENSOR POOL -----------------------------------------------------
 * The ADC pins this board can read, not the number of sensors fitted (like
 * IR_CHANNEL_PINS), so adding a sensor is soldering it on and enabling it.
 *
 * Four is the hardware limit: ADC2 cannot be read while WiFi is on, which rules out
 * GPIO 0/2/4/12/13/14/15/25/26/27. That leaves ADC1 (32/33/34/35/36/39), and 32/33 are
 * reserved for IR channels 3 and 4. So: 34, 35, 36, 39.
 *
 * GPIO 36 and 39 are input-only (VP/VN): fine for a sensor, not usable for IR.
 *
 * gasEnabled[] is set at runtime by the "gasConfig" socket event. Unwired channels
 * start false, because an unconnected ADC pin floats and its noise can look like a real
 * ppm and trigger the smoke alarm.
 * --------------------------------------------------------------------------------
 */
#define MAX_MQ2_SENSORS 4
const uint8_t MQ2_PINS[MAX_MQ2_SENSORS] = { 34, 35, 36, 39 };
bool gasEnabled[MAX_MQ2_SENSORS] = { true, true, false, false };

// Kept so the old two-sensor code reads naturally where it is still one-per-line.
#define MQ2_PIN_1  (MQ2_PINS[0])
#define MQ2_PIN_2  (MQ2_PINS[1])
#define BUZZER_PIN 26
#define DHTPIN      4
#define RGB_PIN    27    // WS2812B data
#define SD_CS_PIN   5    // micro SD chip select (SPI: SCK 18 / MISO 19 / MOSI 23)

/*
 * =========== IR CHANNEL ARRAY ===============
 * Each index = ir_channel value stored in DB (0-based here).
 *
 * The pins this board can drive, not the number of AC units. Two transmitters are
 * wired (GPIO 25, 33); GPIO 32 and 15 are ready, so a third or fourth only needs
 * soldering, no code change. sendChannelMap() reports all of them to the backend, and
 * enabledChannels[] keeps a pin off until a unit is registered on it.
 *
 * More than four needs an edit here: add the pin, raise MAX_IR_CHANNELS, and add an
 * IRsend entry below. enabledChannels[] is updated by the "irConfig" socket event.
 * ============================================
 */
#define MAX_IR_CHANNELS 4
const uint8_t IR_CHANNEL_PINS[MAX_IR_CHANNELS] = { 25, 33, 32, 15 };
// Channels without a transmitter start disabled. The backend enables a channel once a
// unit is registered on it, so wiring GPIO 32 and registering AC Unit 3 is all it takes.
bool enabledChannels[MAX_IR_CHANNELS] = { true, true, false, false };

/* =================== DHT ==================== */
#define DHTTYPE DHT22

/* =================== RGB LED ================ */
#define NUM_PIXELS 16

/* "Nothing is reaching the dashboard" blink: a short blue pulse in the steady green,
   not a colour of its own. Suppressed whenever the room has a warning or alarm (see
   paintStatusLED()). */
#define OFFLINE_BLINK_PERIOD_MS 5000UL
#define OFFLINE_BLINK_ON_MS      120UL

/* ================ LEDC (Buzzer) ============= */
#define FREQ_SMOKE_CRITICAL 2500
#define FREQ_TEMP_CRITICAL 2200
#define FREQ_ENV_CRITICAL 2000
#define FREQ_SMOKE_WARN 1000
#define FREQ_ENV_WARN 1200

/* ================= INTERVALS ================ */
#define LOG_INTERVAL 3000
#define WARMUP_DURATION 20000

/* Beep timing */
#define SMOKE_WARN_ON 200
#define SMOKE_WARN_OFF 800
#define ENV_WARN_BEEP 150
#define ENV_WARN_GAP 150
#define ENV_WARN_PAUSE 1700
#define FAST_PULSE_ON 100
#define FAST_PULSE_OFF 100

/* =================== WiFi =================== */
/* The SSID, password and backend address are set up from a phone through the captive
   portal on first boot and stored in NVS flash (namespace "netcfg"), see setupNetwork().
   So ICTU staff can change them without the Arduino IDE.

   secrets.h only provides fallback defaults for when NVS is empty; a box flashed before
   this keeps using them. Leave them out (as secrets.h.example does) and a blank box
   opens the portal.

   DEVICE_SECRET stays compiled in: it must match backend/.env exactly. */
#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif
#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD ""
#endif
#ifndef BACKEND_HOST
#define BACKEND_HOST ""
#endif
#ifndef BACKEND_PORT
#define BACKEND_PORT 3001
#endif

/* The live configuration: starts from the secrets.h fallbacks and is replaced by
   loadNetConfig() when NVS has a saved one. Strings, since they are read from flash at
   runtime. */
String   netSsid = WIFI_SSID;
String   netPass = WIFI_PASSWORD;
String   netHost = BACKEND_HOST;
uint16_t netPort = BACKEND_PORT;

/* ---- Captive portal ----------------------------------------------------------
   AP_PASSWORD "" leaves the setup access point open, which is why it closes as soon as
   settings are saved. Set a WPA2 password (>= 8 chars) and print it on the enclosure if
   that is not acceptable.

   AP_SSID_UNIQUE adds the last two MAC bytes (CSPC-ICTU-Sensor-A4C1) so two boxes set up
   side by side can be told apart. 0 gives the plain name. */
#define AP_SSID_PREFIX  "CSPC-ICTU-Sensor"
#define AP_SSID_UNIQUE  1
#define AP_PASSWORD     ""

/* After the portal saves, the box tests the backend address it was given and, if nothing
   answers, reopens the portal with the error shown. Otherwise a mistyped backend IP looks
   like a working install. Limited to this many extra rounds, because the server may just
   be down; after that the box carries on and buffers to the SD card. */
#define PORTAL_BACKEND_ROUNDS  2
#define BACKEND_PROBE_MS       3000

/* The portal gives up after this and the box carries on with whatever it already has,
   so one powered up in an empty server room does not sit as an AP forever. */
#define PORTAL_TIMEOUT_S 180

/* Seconds a join attempt from the portal gets before it counts as failed. The /wifisave
   countdown in PORTAL_HEAD_SCRIPT is this + 1; change both. */
#define PORTAL_CONNECT_TIMEOUT_S 10

/* How long the setup page stays up after a successful join, so the phone can read the
   result before the access point closes. Must be longer than the countdown above; ends
   early once the phone fetches the result. See holdPortalForResult(). */
#define PORTAL_CONFIRM_MS 15000

/* How long it stays up when WiFi worked but the backend did not answer, so the address
   can be corrected without the access point going away. Only used when someone has
   opened the page. See holdPortalForResult(). */
#define PORTAL_FIX_MS 90000

/* Press BOOT after power-up, during the window below, not while powering up: GPIO 0 is a
   strapping pin, and held low at reset the chip enters download mode and this sketch
   never runs. The window is shown on the LED (magenta) and on serial. This is the
   fallback for boxes without the external button below. */
#define PORTAL_BUTTON_PIN       0
#define PORTAL_BUTTON_WINDOW_MS 4000

/* The external setup button: a momentary switch from this pin to GND, read with
   INPUT_PULLUP (the pull-up is inside the chip, no resistor). Held for PORTAL_HOLD_MS at
   any time, it reboots into the setup portal; simpler than the BOOT window above.

   Why GPIO 13: GPIO 12 is a strapping pin that must be LOW at reset, GPIO 2 is a strapping
   pin with the onboard LED, and 16/17 are PSRAM lines on WROVER modules. 13 and 14 are
   free (unused JTAG). It is read digitally, so the ADC2/WiFi limit does not apply.

   The hold works as debounce: it needs PORTAL_HOLD_MS of continuous LOW, so a bouncing
   contact just restarts the count. */
#define PORTAL_BUTTON_PIN2 13
#define PORTAL_HOLD_MS     3000

/* Set while the button is held and counting, so paintStatusLED() does not repaint the
   room colour over the hold feedback. See checkPortalButton(). */
bool portalHoldActive = false;

/* How long the boot-time join is given before the box carries on into offline mode.
   Same budget as the old 20 x 500 ms wait it replaces. */
#define WIFI_JOIN_TIMEOUT_MS 10000

/* How often to retry joining while WiFi is down. WiFi.begin() does not block; this just
   spaces the attempts out. */
#define WIFI_RETRY_MS 15000
bool wifiWasUp = false;   // last known link state, for edge detection in loop()

/* ================= SD CARD OFFLINE BUFFER ==================
   0 removes the feature entirely. If the sketch no longer fits, set Tools > Partition
   Scheme to "Huge APP (3MB No OTA/1MB SPIFFS)" rather than dropping the buffer. */
#define SD_ENABLED 1

#if SD_ENABLED
#include <SD.h>
#include <SPI.h>

#define LOG_FILE "/env_backup.csv"

/* Maximum buffer size, so a long outage cannot fill the card. 8 MB is weeks of rows at
   the rate below; past it the sketch stops appending and logs it. */
#define SD_MAX_LOG_BYTES (8UL * 1024UL * 1024UL)

/* Replay pace. The replay is a state machine that sends a few rows per loop tick, so
   sensor reads, the buzzer and IR keep running. (An earlier version sent everything in
   one loop with delay(30) per row and blocked for 36 seconds per hour of buffer.) */
#define SD_FLUSH_BATCH 5
#define SD_FLUSH_GAP_MS 40

/* Only store readings that matter, using the same rules and numbers as backend
   services/envPersistPolicy.js, so buffered history looks like live history (and the
   card wears less). Change both sides together. */
#define SD_HEARTBEAT_MS 30000UL
#define SD_DEADBAND_GAS 15.0
#define SD_DEADBAND_TEMP 0.5
#define SD_DEADBAND_HUM 2.0
#endif  // SD_ENABLED

/* ================= Socket.IO ================ */
// The address is netHost / netPort above — provisioned in NVS, not compiled in.
// Must match DEVICE_SECRET in backend/.env
const char* deviceSecret = DEVICE_SECRET;
// False until socketIO.begin() has a real address. A box can boot with no backend
// configured, so every socket call must allow for that.
bool socketConfigured = false;

/* ================= MQ-2 CONFIG ============== */
// Load resistor ON THE MQ-2 MODULE, in kΩ — read the SMD code beside the AO pin
// (102 = 1 kΩ, the usual one; 103 = 10 kΩ). Must match the board: with 10.0 on a 1 kΩ
// module, clean air computed as Rs ≈ 1000 kΩ → 0.0 ppm, and calibration was rejected.
// ⚠️ Changing it invalidates a stored baseline — press Recalibrate after reflashing.
#define RL_VALUE 1.0

/*
 * ---- Clean-air baseline (Ro), stored in flash -------------
 * Ro is what the sensor reads in clean air; it differs per sensor and per location.
 * These values are only fallbacks until a baseline is loaded or measured:
 *   • boot           → loadRo() restores the saved baseline from NVS
 *   • none saved     → calibrateRo() measures one after a settle period and saves it
 *   • moved location → send the "calibrateGas" socket event; no reflash needed
 *
 * Not recalibrated on every boot: a reboot during a gas event would save smoky air as
 * the baseline and under-report smoke from then on.
 * ----------------------------------------------------------------------------
 */
/* One baseline per sensor, since each sensor and spot differs. Stored under NVS keys
   ro1..ro4. */
float roClean[MAX_MQ2_SENSORS] = { 9.15, 7.28, 9.15, 9.15 };   // fallbacks until calibrated

// The latest ppm per sensor, refreshed every loop tick. Index = channel-1.
float gasPpm[MAX_MQ2_SENSORS] = { 0, 0, 0, 0 };

#define roClean1 (roClean[0])
#define roClean2 (roClean[1])

#define MQ2_CLEAN_AIR_RATIO 9.83  // Rs/Ro in clean air, from the MQ-2 datasheet curve

// A result outside this window is REJECTED rather than stored — an open circuit, a
// shorted sensor, or calibrating in smoky air would otherwise poison the baseline for good.
#define RO_MIN_VALID 1.0
#define RO_MAX_VALID 50.0

// The heater must settle before Ro means anything. 20s (WARMUP_DURATION) is enough for
// readings against a known baseline, not for measuring one.
// A brand-new MQ-2 also needs a 24–48 h burn-in (datasheet); no firmware delay replaces it.
#define CAL_SETTLE_MS 180000UL   // 3 min settle before measuring a first baseline

#define ADC_MAX 4095.0
#define ADC_VREF 3.3
#define MQ2_VCC 5.0
#define DIVIDER_RATIO 0.6667
#define SMOKE_A 30000.0
#define SMOKE_B -2.95

/* ================= THRESHOLDS =============== */
// Alarm thresholds, set live from the dashboard's Alert Rules via the "envConfig" socket
// event (room-level alert_rules), so the LED, buzzer and status follow the dashboard
// without reflashing. These values are only defaults until the first envConfig arrives.
//   One WARNING and one CRITICAL bound per metric, each set from the rule of the same
//   name (gasWarn/gasCrit/…). TEMP_COLD has no rule and keeps this default (LED "too
//   cold"). The IR/AC zones (getIRZone) are separate and not set here.
float WARNING_PPM   = 150.0;
float CRITICAL_PPM  = 300.0;
float TEMP_COLD     = 22.0;
float TEMP_WARNING  = 27.0;   // ASHRAE recommended ceiling — same as the v13 seed
float TEMP_CRITICAL = 32.0;   // ASHRAE Class A1 allowable ceiling
float HUM_WARNING   = 60.0;
float HUM_CRITICAL  = 80.0;   // ASHRAE Class A1 allowable ceiling

/* ================= IR ZONES ================= */
// Zone IDs for change detection
#define IR_ZONE_NONE -1
#define IR_ZONE_TOO_COLD 0    // < 22°C  → 28°C Auto
#define IR_ZONE_NORMAL 1      // 22–24°C → 26°C Auto
#define IR_ZONE_ACCEPTABLE 2  // 25–27°C → 24°C Auto
#define IR_ZONE_NEAR_CRIT 3   // 28–29°C → 22°C High
#define IR_ZONE_CRITICAL 4    // > 29°C  → 20°C High

// Auto-cooling zone boundaries (°C), set from the dashboard's Aircon thresholds via the
// "acConfig" socket event (no reflash). The target per zone is fixed (the captured IR
// codes below). Must stay ascending. Defaults are the original values.
float IR_TEMP_COLD_BELOW   = 22.0;  // <  this → TOO_COLD   (28°C Auto)
float IR_TEMP_NORMAL_MAX   = 24.0;  // <= this → NORMAL     (26°C Auto)
float IR_TEMP_ACCEPT_MAX   = 27.0;  // <= this → ACCEPTABLE (24°C Auto)
float IR_TEMP_NEARCRIT_MAX = 29.0;  // <= this → NEAR_CRIT  (22°C High); above → CRITICAL (20°C High)

/* ================= OBJECTS ================== */
DHT dht(DHTPIN, DHTTYPE);
SocketIOclient socketIO;
RTC_DS3231 rtc;
Adafruit_NeoPixel rgb(NUM_PIXELS, RGB_PIN, NEO_GRB + NEO_KHZ800);
IRsend irChannels[MAX_IR_CHANNELS] = {
  IRsend(IR_CHANNEL_PINS[0]),
  IRsend(IR_CHANNEL_PINS[1]),
  IRsend(IR_CHANNEL_PINS[2]),
  IRsend(IR_CHANNEL_PINS[3]),
};

/* ================= GLOBALS ================== */
unsigned long lastLogTime = 0;
unsigned long lastBeepTime = 0;

// Pending irFired event — sent on next successful socket connect
// if the socket was down when IR fired.
bool     pendingIRFired       = false;
int      pendingIRZone        = -1;
String   pendingIRLabel       = "";
int beepPhase = 0;
bool beepOn = false;
String lastEnvStatus = "NORMAL";
String lastTempStatus = "NORMAL";
int lastBuzzerPriority = -1;
bool warmupDone = false;
unsigned long warmupStart = 0;
bool rtcAvailable = false;
int lastIRZone = IR_ZONE_NONE;

#if SD_ENABLED
/* ===== SD buffer state ===== */
bool sdAvailable   = false;   // module answered at boot
bool sdLogDirty    = false;   // rows are sitting on the card, unsent
bool sdWarnedClock = false;   // "no trustworthy clock" is logged once, not every 3s
bool sdWarnedFull  = false;   // ditto for the size cap

/* Replay state machine (see SD_FLUSH_BATCH). */
bool sdFlushing = false;
File sdFlushFile;
unsigned long sdFlushSent = 0;
unsigned long sdLastFlushStep = 0;

/* The last row written to the card: the baseline for deciding if the next reading has
   changed enough to be stored. */
bool sdHaveLast = false;
unsigned long sdLastAt = 0;
float sdLastTemp = 0, sdLastHum = 0;
float sdLastPpm[MAX_MQ2_SENSORS] = { 0, 0, 0, 0 };
String sdLastSmoke = "", sdLastTempSt = "", sdLastEnvSt = "";
#endif

/*
 * MQ-2 baseline storage and scheduled calibration. Scheduled rather than run inline so a
 * 3-minute settle does not block sensor reads, the socket or IR.
 */
Preferences prefs;
#define NVS_NAMESPACE "mq2cal"

/* Network settings have their own NVS namespace, so resetting WiFi can never erase the
   MQ-2 baseline (which takes three minutes of clean air to measure). */
#define NVS_NET_NAMESPACE "netcfg"
bool pendingCalibration = false;
unsigned long calibrationDueAt = 0;

/*
 * ─────────────────────────────────────────────────────────────
 *  CAPTURED RAW IR DATA  (Carrier remote, 38 kHz)
 *  Captured 2026-07-31 with IRLearner.ino. The protocol decodes as
 *  UNKNOWN, so these are sent as-is with sendRaw().
 *
 *  Each array is 131 values: leader pair + 64 bit-pairs + stop mark.
 *  If you recapture, check the length is exactly 131; any other count
 *  means ambient IR corrupted the capture.
 * ─────────────────────────────────────────────────────────────
 */
// 28°C Cool Auto fan  (Too Cold zone)
const uint16_t IR_28C_AUTO[] = {
  9000, 4500, 550, 600, 550, 550, 550, 1750,
  550, 600, 550, 1750, 550, 550, 550, 600,
  550, 600, 550, 600, 500, 1750, 550, 600,
  550, 600, 550, 1750, 550, 1750, 550, 600,
  550, 1750, 550, 650, 500, 600, 550, 600,
  550, 550, 550, 550, 550, 600, 550, 600,
  550, 650, 500, 650, 550, 600, 550, 600,
  550, 550, 550, 550, 550, 600, 550, 600,
  550, 650, 550, 600, 500, 600, 550, 600,
  550, 600, 550, 600, 500, 600, 500, 600,
  550, 650, 500, 650, 500, 1750, 500, 600,
  550, 600, 500, 600, 550, 600, 550, 600,
  500, 1800, 550, 650, 500, 650, 550, 600,
  500, 600, 500, 650, 500, 1800, 500, 1800,
  450, 1800, 500, 650, 450, 650, 500, 650,
  500, 600, 500, 1800, 500, 600, 500, 600,
  500, 650, 500
};

// 26°C Cool Auto fan  (Normal zone)
const uint16_t IR_26C_AUTO[] = {
  8950, 4550, 500, 650, 500, 650, 500, 1750,
  500, 600, 500, 1750, 500, 600, 500, 600,
  500, 650, 500, 650, 500, 1750, 500, 650,
  500, 650, 500, 1750, 500, 1750, 550, 600,
  500, 650, 450, 650, 500, 600, 500, 650,
  500, 600, 500, 600, 500, 600, 500, 600,
  500, 650, 500, 650, 450, 600, 550, 650,
  500, 650, 500, 600, 500, 600, 500, 600,
  500, 650, 500, 650, 500, 650, 500, 650,
  500, 650, 500, 600, 500, 600, 500, 600,
  500, 650, 500, 650, 450, 1800, 500, 650,
  500, 1750, 500, 600, 500, 600, 550, 600,
  500, 1800, 500, 650, 450, 650, 450, 650,
  500, 650, 500, 650, 500, 1800, 450, 1800,
  450, 1800, 500, 650, 450, 650, 500, 650,
  500, 650, 500, 1750, 500, 650, 500, 600,
  500, 600, 500
};

// 24°C Cool Auto fan  (Acceptable zone)
const uint16_t IR_24C_AUTO[] = {
  8950, 4550, 450, 650, 450, 650, 500, 1750,
  500, 650, 500, 1750, 500, 600, 500, 600,
  500, 650, 500, 650, 500, 1800, 500, 650,
  500, 650, 500, 1750, 500, 600, 500, 1800,
  500, 650, 450, 650, 450, 600, 550, 600,
  500, 600, 500, 650, 500, 600, 500, 650,
  500, 700, 450, 650, 450, 650, 500, 600,
  550, 600, 550, 600, 500, 600, 500, 600,
  500, 650, 450, 650, 450, 650, 500, 650,
  500, 650, 500, 650, 500, 600, 500, 600,
  500, 650, 450, 650, 450, 1800, 500, 1750,
  500, 1750, 500, 600, 500, 650, 500, 600,
  500, 1800, 500, 650, 450, 650, 500, 650,
  500, 650, 500, 600, 500, 1800, 450, 1800,
  500, 1800, 500, 650, 500, 650, 500, 650,
  500, 650, 500, 1800, 500, 600, 500, 650,
  500, 600, 500
};

// 22°C Cool High fan  (Near Critical zone)
const uint16_t IR_22C_HIGH[] = {
  8950, 4550, 450, 700, 450, 650, 500, 1800,
  450, 650, 500, 1750, 500, 650, 500, 600,
  500, 650, 450, 650, 450, 1800, 500, 1800,
  500, 1750, 500, 1750, 500, 650, 500, 600,
  500, 1800, 500, 650, 450, 650, 500, 650,
  450, 650, 500, 650, 450, 700, 450, 650,
  500, 700, 450, 650, 450, 650, 500, 600,
  550, 650, 500, 650, 500, 600, 500, 600,
  500, 650, 450, 650, 450, 650, 500, 650,
  450, 650, 450, 700, 450, 650, 550, 600,
  500, 650, 450, 700, 450, 1800, 450, 650,
  500, 1800, 500, 650, 500, 600, 500, 600,
  450, 1800, 500, 650, 450, 650, 450, 650,
  500, 650, 500, 600, 500, 600, 500, 650,
  500, 650, 450, 650, 450, 650, 450, 650,
  500, 650, 450, 1800, 500, 1800, 450, 1850,
  450, 1800, 400
};

// 20°C Cool High fan  (Critical zone)  (captured 2026-08-01, third attempt)
// Two earlier captures failed because of room lighting: extra edges from ambient IR, and
// then a 60Hz lamp flooding the receiver. For any recapture: lights off, away from
// sunlight and screens, remote 3-10cm from the receiver. If IRLearner prints anything
// while no button is pressed, it is still too noisy.
//
// This capture is clean: 131 values, 8950/4500 leader, exactly 64 bits, and matches the
// structure of the other frames (bits 61-63 are the complement of bits 53-55).
//
// Still to confirm on the unit: bits 53-55 differ from 22C_HIGH (010 vs 000), so check
// the AC shows 20°C with the fan on High when the CRITICAL zone fires. If not, recapture
// with the remote on Cool / 20°C / fan High.
#define IR_20C_HIGH_CAPTURED 1
const uint16_t IR_20C_HIGH[] = {
  8950, 4500, 500, 650, 500, 600, 550, 1750,
  500, 600, 500, 1750, 500, 600, 500, 600,
  550, 650, 500, 650, 500, 1750, 550, 600,
  550, 1750, 500, 600, 500, 1750, 550, 600,
  500, 650, 500, 650, 450, 650, 500, 600,
  500, 650, 500, 600, 500, 600, 500, 600,
  500, 650, 500, 650, 500, 650, 500, 650,
  500, 650, 500, 600, 500, 600, 500, 600,
  500, 650, 450, 650, 450, 650, 500, 650,
  500, 650, 500, 600, 500, 600, 500, 600,
  500, 650, 450, 1800, 500, 1800, 500, 650,
  500, 650, 500, 650, 500, 650, 500, 650,
  500, 1800, 500, 650, 450, 650, 500, 650,
  500, 650, 500, 650, 500, 650, 500, 1800,
  450, 650, 450, 650, 450, 650, 450, 650,
  500, 650, 500, 1750, 500, 1800, 500, 600,
  500, 1800, 450
};

// Power ON  (captured 2026-07-31)
const uint16_t IR_POWER_ON[] = {
  8950, 4500, 500, 650, 500, 600, 550, 1750,
  550, 600, 550, 1750, 550, 600, 550, 600,
  500, 650, 500, 650, 500, 1750, 550, 1750,
  550, 600, 500, 1750, 550, 600, 550, 600,
  500, 650, 500, 600, 500, 600, 550, 600,
  500, 600, 500, 600, 550, 600, 500, 600,
  500, 650, 500, 650, 500, 600, 550, 600,
  500, 600, 500, 1750, 550, 600, 500, 1750,
  500, 650, 500, 1750, 500, 600, 550, 600,
  550, 1750, 500, 600, 500, 1750, 550, 600,
  500, 650, 450, 650, 500, 600, 550, 600,
  500, 600, 500, 600, 500, 600, 500, 600,
  500, 1800, 500, 650, 500, 600, 500, 600,
  500, 600, 550, 600, 500, 600, 500, 600,
  500, 1800, 500, 650, 500, 650, 500, 650,
  500, 650, 500, 1750, 500, 1800, 450, 1800,
  450, 600, 500
};

// Power OFF  (captured 2026-07-31)
const uint16_t IR_POWER_OFF[] = {
  9050, 4400, 550, 600, 550, 550, 600, 1650,
  600, 500, 600, 500, 600, 500, 600, 550,
  550, 600, 500, 600, 500, 1700, 600, 1700,
  600, 550, 550, 1650, 600, 550, 550, 600,
  550, 1700, 550, 600, 500, 600, 550, 600,
  550, 600, 550, 550, 550, 550, 550, 550,
  550, 600, 500, 600, 500, 600, 550, 600,
  550, 600, 550, 1750, 600, 550, 550, 1750,
  500, 650, 500, 1750, 600, 550, 600, 550,
  600, 1700, 600, 1700, 600, 550, 600, 550,
  600, 600, 500, 650, 500, 600, 550, 1700,
  550, 1700, 550, 550, 550, 550, 600, 550,
  600, 1700, 600, 550, 550, 600, 600, 550,
  600, 550, 600, 550, 550, 550, 550, 550,
  550, 1750, 550, 600, 550, 550, 550, 550,
  550, 550, 550, 1700, 550, 1750, 550, 1750,
  550, 550, 550
};

/* =========================================== */

/* ---- Helpers ---- */
void buzzerTone(uint32_t freq) {
  ledcWriteTone(BUZZER_PIN, freq);
}
void buzzerOff() {
  ledcWrite(BUZZER_PIN, 0);
}

/* ---- RGB LED color setter ---- */
void setRGB(uint8_t r, uint8_t g, uint8_t b) {
  for (int i = 0; i < NUM_PIXELS; i++) {
    rgb.setPixelColor(i, rgb.Color(r, g, b));
  }
  rgb.show();
}

void setStatusColor(const String& envStatus, const String& tempStatus, const String& smokeStatus) {
  // Priority: smoke or temperature CRITICAL → Red. Those two are the act-now conditions,
  // so they are named individually rather than read off envStatus.
  if (smokeStatus == "CRITICAL" || tempStatus == "CRITICAL") {
    setRGB(255, 0, 0);  // Red
  } else if (envStatus == "CRITICAL") {
    // Reached by HUMIDITY alone — gas and temperature critical are caught above. Amber,
    // not red: it is a real breach of the critical rule but not an evacuate-now one.
    setRGB(255, 60, 0);  // Orange
  } else if (envStatus == "WARNING") {
    if (tempStatus == "TOO_COLD") {
      setRGB(0, 0, 255);  // Blue — too cold
    } else {
      setRGB(255, 180, 0);  // Yellow — general warning
    }
  } else {
    setRGB(0, 255, 0);  // Green — normal
  }
}

/* ---- ADC → Rs (kΩ) ---- */
/* One place decides what the LED shows once sensing has started: the room always wins,
   and the offline blink only fills the gaps. `reporting` means the socket is up (readings
   reach the dashboard), not just WiFi. No stored state: the next tick repaints the real
   colour after the pulse. */
void paintStatusLED(unsigned long now_ms, bool reporting,
                    const String& envStatus, const String& tempStatus, const String& smokeStatus) {
  bool quiet = envStatus == "NORMAL" && tempStatus != "CRITICAL" && smokeStatus != "CRITICAL";
  /* The setup-button hold outranks the offline blink (someone is holding it and needs to
     see the count), but not the room: an alarm still owns the LED. The confirming green
     blip fires either way, right before the restart. */
  if (portalHoldActive && quiet) {
    setRGB(60, 0, 60);  // magenta — keep holding to re-run WiFi setup
    return;
  }
  if (!reporting && quiet && (now_ms % OFFLINE_BLINK_PERIOD_MS) < OFFLINE_BLINK_ON_MS) {
    setRGB(0, 0, 60);   // dim blue pulse — the room is fine, the reporting is not
    return;
  }
  setStatusColor(envStatus, tempStatus, smokeStatus);
}

float adcToRs(int adcVal) {
  if (adcVal <= 0) adcVal = 1;
  float vPin = (adcVal / ADC_MAX) * ADC_VREF;
  float vAout = vPin / DIVIDER_RATIO;
  if (vAout >= MQ2_VCC) vAout = MQ2_VCC - 0.01;
  return RL_VALUE * (MQ2_VCC - vAout) / vAout;
}

/* ---- Rs → PPM ---- */
float rsToPPM(float rs, float ro) {
  float ratio = rs / ro;
  float ppm = SMOKE_A * pow(ratio, SMOKE_B);
  if (ppm < 0) ppm = 0;
  if (ppm > 9999) ppm = 9999;
  return ppm;
}

/* ---- Heat Index (Steadman, °C) — display only ---- */
float calcHeatIndex(float t, float h) {
  return -8.78469475556
         + 1.61139411 * t
         + 2.33854883889 * h
         - 0.14611605 * t * h
         - 0.01230809850 * t * t
         - 0.01642482778 * h * h
         + 0.00221732600 * t * t * h
         + 0.00072546 * t * h * h
         - 0.00000358 * t * t * h * h;
}

/* ---- Status calculators ---- */
// All three use the same bands as alert_rules: NORMAL / WARNING / CRITICAL. temp also has
// TOO_COLD, which has no rule (see TEMP_COLD).
/* The highest reading across the fitted sensors. The maximum, not the average, so one
   sensor near smoke is not averaged away. Disabled channels are left out, so a floating
   pin cannot set the room status. */
float worstGasPpm() {
  float worst = 0;
  for (int i = 0; i < MAX_MQ2_SENSORS; i++) {
    if (gasEnabled[i] && gasPpm[i] > worst) worst = gasPpm[i];
  }
  return worst;
}

String calcSmokeStatus() {
  float ppmMax = worstGasPpm();
  if (ppmMax >= CRITICAL_PPM) return "CRITICAL";
  if (ppmMax >= WARNING_PPM) return "WARNING";
  return "NORMAL";
}

String calcTempStatus(float t) {
  if (t >= TEMP_CRITICAL) return "CRITICAL";
  if (t >= TEMP_WARNING) return "WARNING";
  if (t < TEMP_COLD) return "TOO_COLD";
  return "NORMAL";
}

// The worst band of any metric: any metric at CRITICAL makes the room critical.
String calcEnvironmentStatus(float t, float h) {
  float ppmMax = worstGasPpm();
  if (t >= TEMP_CRITICAL || ppmMax >= CRITICAL_PPM || h >= HUM_CRITICAL) return "CRITICAL";
  if (t >= TEMP_WARNING || ppmMax >= WARNING_PPM || h >= HUM_WARNING
      || t < TEMP_COLD) return "WARNING";
  return "NORMAL";
}

/*
 * ─────────────────────────────────────────────
 *  IR ZONE HELPER
 *  Returns the zone for a temperature.
 * ─────────────────────────────────────────────
 */
int getIRZone(float t) {
  if (t <  IR_TEMP_COLD_BELOW)   return IR_ZONE_TOO_COLD;
  if (t <= IR_TEMP_NORMAL_MAX)   return IR_ZONE_NORMAL;
  if (t <= IR_TEMP_ACCEPT_MAX)   return IR_ZONE_ACCEPTABLE;
  if (t <= IR_TEMP_NEARCRIT_MAX) return IR_ZONE_NEAR_CRIT;
  return IR_ZONE_CRITICAL;
}

/*
 * ─────────────────────────────────────────────
 *  SEND IR TO BOTH AC UNITS
 *  Only when the zone changes.
 * ─────────────────────────────────────────────
 */
/*
 * Zone → its captured raw code. Used by handleIR (auto, all enabled channels) and the
 * "irCommand" on-handler (re-sync one unit switched back on). Returns false when the
 * zone has no code (IR_ZONE_NONE).
 */
bool zoneIRData(int zone, const uint16_t** irData, uint16_t* irLen, String* irLabel) {
  switch (zone) {
    case IR_ZONE_TOO_COLD:
      *irData = IR_28C_AUTO;
      *irLen = sizeof(IR_28C_AUTO) / sizeof(IR_28C_AUTO[0]);
      *irLabel = "28C_AUTO";
      return true;
    case IR_ZONE_NORMAL:
      *irData = IR_26C_AUTO;
      *irLen = sizeof(IR_26C_AUTO) / sizeof(IR_26C_AUTO[0]);
      *irLabel = "26C_AUTO";
      return true;
    case IR_ZONE_ACCEPTABLE:
      *irData = IR_24C_AUTO;
      *irLen = sizeof(IR_24C_AUTO) / sizeof(IR_24C_AUTO[0]);
      *irLabel = "24C_AUTO";
      return true;
    case IR_ZONE_NEAR_CRIT:
      *irData = IR_22C_HIGH;
      *irLen = sizeof(IR_22C_HIGH) / sizeof(IR_22C_HIGH[0]);
      *irLabel = "22C_HIGH";
      return true;
    case IR_ZONE_CRITICAL:
#if IR_20C_HIGH_CAPTURED
      *irData = IR_20C_HIGH;
      *irLen = sizeof(IR_20C_HIGH) / sizeof(IR_20C_HIGH[0]);
      *irLabel = "20C_HIGH";
      return true;
#else
      // Only compiled when IR_20C_HIGH_CAPTURED is 0 (no capture pasted): refuse to send, so
      // the unit stays on the NEAR_CRIT setting (22°C High).
      Serial.println("[IR] CRITICAL zone skipped — 20C_HIGH not captured yet");
      return false;
#endif
  }
  return false;
}

void handleIR(float temperature) {
  int zone = getIRZone(temperature);
  if (zone == lastIRZone) return;  // no change — skip
  lastIRZone = zone;

  const uint16_t* irData = nullptr;
  uint16_t irLen = 0;
  String irLabel = "";
  zoneIRData(zone, &irData, &irLen, &irLabel);

  if (irData && irLen > 0) {
    int fired = 0;
    for (int i = 0; i < MAX_IR_CHANNELS; i++) {
      if (enabledChannels[i]) {
        irChannels[i].sendRaw(irData, irLen, 38);
        delay(30);
        fired++;
      }
    }
    Serial.printf("[IR] Sent %s to %d enabled channel(s).\n", irLabel.c_str(), fired);

    // Notify backend so aircon_state stays in sync with auto IR actions
    if (fired > 0) {
      if (!socketIO.isConnected()) {
        // Socket down — store and retry on reconnect
        pendingIRFired = true;
        pendingIRZone  = zone;
        pendingIRLabel = irLabel;
        Serial.println("[IO] irFired queued — socket disconnected, will retry on reconnect.");
      } else {
        sendIRFiredEvent(zone, irLabel, fired);
      }
    }
  }
}

/*
 * ─────────────────────────────────────────────
 *  RTC: get timestamp string
 * ─────────────────────────────────────────────
 */
String getTimestamp() {
  // Priority 1: hardware RTC
  if (rtcAvailable) {
    DateTime now = rtc.now();
    char buf[24];
    sprintf(buf, "%04d-%02d-%02d %02d:%02d:%02d",
            now.year(), now.month(), now.day(),
            now.hour(), now.minute(), now.second());
    return String(buf);
  }
  // Priority 2: NTP (available when WiFi is connected)
  struct tm ti;
  if (getLocalTime(&ti, 0)) {   // 0ms timeout — non-blocking
    char buf[24];
    strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &ti);
    return String(buf);
  }
  // Priority 3: uptime since boot (no time source available)
  unsigned long s = millis() / 1000;
  unsigned long m = s / 60; s %= 60;
  unsigned long h = m / 60; m %= 60;
  char buf[16];
  sprintf(buf, "UP %02lu:%02lu:%02lu", h, m, s);
  return String(buf);
}

/*
 * =============================================
 *  SD CARD - offline buffer
 *
 *  Only used while the socket is down (append) or has just come back
 *  (replay), so it never competes with live sending.
 * =============================================
 */
#if SD_ENABLED

/* getTimestamp() falls back to "UP HH:MM:SS" when neither the RTC nor NTP has the time;
   the backend refuses that, so such rows are not buffered. During an outage there is no
   NTP, so buffering depends on the DS3231 and its coin cell. */
bool sdClockIsReal(const String& ts) {
  return ts.length() >= 19 && ts.charAt(4) == '-' && ts.charAt(7) == '-';
}

void sdInit() {
  Serial.println("[SD] Initializing...");
  SPI.begin(18, 19, 23, SD_CS_PIN);

  /* Step down through the speeds rather than failing at the fastest. Cheap cards and
     long dupont leads often refuse 25 MHz and work fine at 4. */
  const uint32_t speeds[] = { 20000000, 4000000, 1000000, 400000 };
  const char* labels[]    = { "20MHz", "4MHz", "1MHz", "400kHz" };
  for (int i = 0; i < 4; i++) {
    SD.end();
    delay(50);
    if (SD.begin(SD_CS_PIN, SPI, speeds[i])) {
      sdAvailable = true;
      Serial.printf("[SD] OK at %s\n", labels[i]);
      break;
    }
    Serial.printf("[SD] Failed at %s\n", labels[i]);
  }

  if (!sdAvailable) {
    Serial.println("[WARN] SD card not found - an outage will record nothing.");
    return;
  }

  /* A log left from before a reboot is still sent: its rows are the outage. This is what
     lets the buffer survive a power cut. */
  if (SD.exists(LOG_FILE)) {
    File f = SD.open(LOG_FILE, FILE_READ);
    unsigned long bytes = f ? f.size() : 0;
    if (f) f.close();
    sdLogDirty = bytes > 0;
    if (sdLogDirty) {
      Serial.printf("[SD] Found %s from a previous run (%lu bytes) - will replay.\n",
                    LOG_FILE, bytes);
    }
  }
}

/* Same gates as envPersistPolicy.shouldPersist, in the same order. */
bool sdShouldBuffer(unsigned long now_ms, float temp, float hum,
                    const String& smokeSt, const String& tempSt, const String& envSt) {
  if (!sdHaveLast) return true;                                   // first row of the outage
  if (now_ms - sdLastAt >= SD_HEARTBEAT_MS) return true;          // heartbeat
  if (smokeSt != sdLastSmoke) return true;                        // band transitions -
  if (tempSt  != sdLastTempSt) return true;                       // never smooth one away
  if (envSt   != sdLastEnvSt) return true;
  // Per sensor, not the max: one rising while the others do not is the whole reason there
  // is more than one, and a max-only test would smooth exactly that away.
  for (int i = 0; i < MAX_MQ2_SENSORS; i++) {
    if (gasEnabled[i] && fabs(gasPpm[i] - sdLastPpm[i]) >= SD_DEADBAND_GAS) return true;
  }
  if (fabs(temp - sdLastTemp) >= SD_DEADBAND_TEMP) return true;
  if (fabs(hum  - sdLastHum)  >= SD_DEADBAND_HUM) return true;
  return false;
}

void sdAppendRow(const String& ts, float temp, float hum,
                 const String& smokeSt, const String& tempSt, const String& envSt,
                 float heatIndex, unsigned long now_ms) {
  if (!sdAvailable) return;

  if (!sdClockIsReal(ts)) {
    if (!sdWarnedClock) {
      sdWarnedClock = true;
      Serial.println("[SD] No real clock (RTC battery dead / never set?) - not buffering. "
                     "A row the backend cannot date is a row it will refuse.");
    }
    return;
  }

  if (!sdShouldBuffer(now_ms, temp, hum, smokeSt, tempSt, envSt)) return;

  File f = SD.open(LOG_FILE, FILE_APPEND);
  if (!f) {
    Serial.println("[SD] Cannot open " LOG_FILE " for append.");
    return;
  }
  if (f.size() >= SD_MAX_LOG_BYTES) {
    f.close();
    if (!sdWarnedFull) {
      sdWarnedFull = true;
      Serial.printf("[SD] %s hit the %lu-byte cap - buffering stopped until it is replayed.\n",
                    LOG_FILE, (unsigned long)SD_MAX_LOG_BYTES);
    }
    return;
  }
  // ppm3/ppm4 are added after heat_index, not next to ppm1/ppm2, so rows written by the
  // older firmware still parse correctly. Missing trailing columns are read as "not reported".
  if (f.size() == 0) {
    f.println("timestamp,temperature,humidity,ppm1,ppm2,"
              "smoke_status,temp_status,env_status,heat_index,ppm3,ppm4");
  }
  f.printf("%s,%.1f,%.1f,%.1f,%.1f,%s,%s,%s,%.1f,%.1f,%.1f\n",
           ts.c_str(), temp, hum, gasPpm[0], gasPpm[1],
           smokeSt.c_str(), tempSt.c_str(), envSt.c_str(), heatIndex,
           gasPpm[2], gasPpm[3]);
  f.close();

  sdHaveLast   = true;
  sdLastAt     = now_ms;
  sdLastTemp   = temp; sdLastHum = hum;
  for (int i = 0; i < MAX_MQ2_SENSORS; i++) sdLastPpm[i] = gasPpm[i];
  sdLastSmoke  = smokeSt; sdLastTempSt = tempSt; sdLastEnvSt = envSt;
  sdLogDirty   = true;
  sdWarnedFull = false;

  Serial.println("[SD] Buffered (offline) " + ts);
}

/* One buffered CSV row -> one "offlineData" event. Field order must match the header
   written above. */
bool sdSendRow(const String& line) {
  // 9 fields = a row from the two-sensor firmware; 11 adds ppm3/ppm4. Both are accepted
  // while cards may still hold older rows.
  const int MAX_FIELDS = 11;
  String fields[MAX_FIELDS];
  int fi = 0, start = 0;
  for (int i = 0; i <= (int)line.length(); i++) {
    if (i == (int)line.length() || line.charAt(i) == ',') {
      if (fi < MAX_FIELDS) fields[fi++] = line.substring(start, i);
      start = i + 1;
    }
  }
  if (fi < 9) return false;   // malformed - e.g. a tail truncated by a power cut mid-write

  StaticJsonDocument<400> doc;
  JsonArray array = doc.to<JsonArray>();
  array.add("offlineData");
  JsonObject p = array.createNestedObject();
  p["timestamp"]          = fields[0];
  p["temperature"]        = fields[1].toFloat();
  p["humidity"]           = fields[2].toFloat();
  p["mq2_1_ppm"]          = fields[3].toFloat();   // legacy pair, still sent
  p["mq2_2_ppm"]          = fields[4].toFloat();
  p["smoke_status"]       = fields[5];
  p["temp_status"]        = fields[6];
  p["environment_status"] = fields[7];
  p["heat_index"]         = fields[8].toFloat();
  // Per-channel array, so a replayed row lands in the same per-sensor series a live one
  // does. A 9-field row simply carries two entries.
  JsonArray g = p.createNestedArray("gas_ppm");
  g.add(fields[3].toFloat());
  g.add(fields[4].toFloat());
  if (fi >= 11) { g.add(fields[9].toFloat()); g.add(fields[10].toFloat()); }

  String output;
  serializeJson(doc, output);
  socketIO.sendEVENT(output);
  return true;
}

bool sdPendingFlush() { return sdAvailable && sdLogDirty && !sdFlushing; }

void sdBeginFlush() {
  sdFlushFile = SD.open(LOG_FILE, FILE_READ);
  if (!sdFlushFile) {
    Serial.println("[SD] Cannot open " LOG_FILE " to replay - clearing the flag.");
    sdLogDirty = false;
    return;
  }
  sdFlushing  = true;
  sdFlushSent = 0;
  Serial.printf("[SD] Backend reachable - replaying %lu bytes of buffered readings.\n",
                (unsigned long)sdFlushFile.size());
}

/* Called every tick. Sends at most SD_FLUSH_BATCH rows and returns, so the sensor,
   buzzer and IR loops keep their cadence while a long buffer drains. */
void sdFlushStep(unsigned long now_ms) {
  if (!sdFlushing) return;

  /* The link dropped again during replay: keep the file, since the rest was not sent.
     Sending the start again is harmless: InfluxDB overwrites a point with the same
     measurement, tags and timestamp. That is also why no read position is saved across
     reboots. */
  if (!socketIO.isConnected()) {
    sdFlushFile.close();
    sdFlushing = false;
    Serial.printf("[SD] Replay interrupted after %lu row(s) - log kept for the next attempt.\n",
                  sdFlushSent);
    return;
  }

  if (now_ms - sdLastFlushStep < SD_FLUSH_GAP_MS) return;
  sdLastFlushStep = now_ms;

  for (int n = 0; n < SD_FLUSH_BATCH && sdFlushFile.available(); n++) {
    String line = sdFlushFile.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) continue;
    if (line.startsWith("timestamp,")) continue;   // CSV header
    if (sdSendRow(line)) sdFlushSent++;
  }

  if (!sdFlushFile.available()) {
    sdFlushFile.close();
    SD.remove(LOG_FILE);
    sdLogDirty = false;
    sdFlushing = false;
    sdHaveLast = false;   // the next outage starts its own deadband baseline
    Serial.printf("[SD] Replay complete - %lu row(s) backfilled, %s deleted.\n",
                  sdFlushSent, LOG_FILE);
  }
}

#else   /* SD_ENABLED == 0 - no-op stubs so the call sites stay readable */
inline void sdInit() { Serial.println("[SD] Compiled out (SD_ENABLED 0) - no offline buffer."); }
inline void sdAppendRow(const String&, float, float, float, float,
                        const String&, const String&, const String&, float, unsigned long) {}
inline bool sdPendingFlush() { return false; }
inline void sdBeginFlush() {}
inline void sdFlushStep(unsigned long) {}
#endif  // SD_ENABLED

/*
 * ─────────────────────────────────────────────
 *  BUZZER PATTERN HANDLER
 * ─────────────────────────────────────────────
 */
void handleBuzzer(const String& smokeStatus, const String& tempStatus,
                  const String& envStatus, unsigned long now_ms) {
  // Order matters: envStatus is CRITICAL whenever gas or temperature is, so those are
  // checked first or every critical reading would become priority 3.
  int priority = 0;
  if (smokeStatus == "CRITICAL") priority = 5;
  else if (tempStatus == "CRITICAL") priority = 4;
  else if (envStatus == "CRITICAL") priority = 3;
  else if (smokeStatus == "WARNING") priority = 2;
  else if (envStatus == "WARNING") priority = 1;

  if (priority != lastBuzzerPriority) {
    buzzerOff();
    beepOn = false;
    beepPhase = 0;
    lastBeepTime = now_ms;
    lastBuzzerPriority = priority;
  }

  if (priority == 5) {
    buzzerTone(FREQ_SMOKE_CRITICAL);
    return;
  }

  if (priority == 4) {
    if (beepOn) {
      buzzerTone(FREQ_TEMP_CRITICAL);
      if (now_ms - lastBeepTime >= FAST_PULSE_ON) {
        buzzerOff();
        beepOn = false;
        lastBeepTime = now_ms;
      }
    } else {
      if (now_ms - lastBeepTime >= FAST_PULSE_OFF) {
        buzzerTone(FREQ_TEMP_CRITICAL);
        beepOn = true;
        lastBeepTime = now_ms;
      }
    }
    return;
  }

  if (priority == 3) {
    if (beepOn) {
      buzzerTone(FREQ_ENV_CRITICAL);
      if (now_ms - lastBeepTime >= FAST_PULSE_ON) {
        buzzerOff();
        beepOn = false;
        lastBeepTime = now_ms;
      }
    } else {
      if (now_ms - lastBeepTime >= FAST_PULSE_OFF) {
        buzzerTone(FREQ_ENV_CRITICAL);
        beepOn = true;
        lastBeepTime = now_ms;
      }
    }
    return;
  }

  if (priority == 2) {
    if (beepOn) {
      buzzerTone(FREQ_SMOKE_WARN);
      if (now_ms - lastBeepTime >= SMOKE_WARN_ON) {
        buzzerOff();
        beepOn = false;
        lastBeepTime = now_ms;
      }
    } else {
      if (now_ms - lastBeepTime >= SMOKE_WARN_OFF) {
        buzzerTone(FREQ_SMOKE_WARN);
        beepOn = true;
        lastBeepTime = now_ms;
      }
    }
    return;
  }

  if (priority == 1) {
    switch (beepPhase) {
      case 0:
        buzzerTone(FREQ_ENV_WARN);
        if (now_ms - lastBeepTime >= ENV_WARN_BEEP) {
          buzzerOff();
          beepPhase = 1;
          lastBeepTime = now_ms;
        }
        break;
      case 1:
        buzzerOff();
        if (now_ms - lastBeepTime >= ENV_WARN_GAP) {
          beepPhase = 2;
          lastBeepTime = now_ms;
        }
        break;
      case 2:
        buzzerTone(FREQ_ENV_WARN);
        if (now_ms - lastBeepTime >= ENV_WARN_BEEP) {
          buzzerOff();
          beepPhase = 3;
          lastBeepTime = now_ms;
        }
        break;
      case 3:
        buzzerOff();
        if (now_ms - lastBeepTime >= ENV_WARN_PAUSE) {
          beepPhase = 0;
          lastBeepTime = now_ms;
        }
        break;
    }
    return;
  }

  buzzerOff();
}

/*
 * ─────────────────────────────────────────────
 *  MQ-2 clean-air baseline (Ro), stored in NVS
 * ─────────────────────────────────────────────
 */

// Restore a saved baseline. Returns false when nothing valid is stored, which means one
// must be measured (first boot, or first boot in a new location). One key per sensor:
// "ro1".."ro4".
static void roKey(int i, char* out, size_t n) { snprintf(out, n, "ro%d", i + 1); }

bool loadRo() {
  prefs.begin(NVS_NAMESPACE, true); // read-only
  float v[MAX_MQ2_SENSORS];
  char key[8];
  for (int i = 0; i < MAX_MQ2_SENSORS; i++) {
    roKey(i, key, sizeof(key));
    v[i] = prefs.getFloat(key, 0.0f);
  }
  prefs.end();

  // Only fitted sensors need a saved baseline; an unwired channel has nothing to measure,
  // and requiring one would re-run calibration on every boot.
  bool ok = true, any = false;
  for (int i = 0; i < MAX_MQ2_SENSORS; i++) {
    if (!gasEnabled[i]) continue;
    any = true;
    if (!(v[i] >= RO_MIN_VALID && v[i] <= RO_MAX_VALID)) ok = false;
  }
  if (!any || !ok) {
    Serial.println("[CAL] No stored baseline — will calibrate once the sensors settle.");
    return false;
  }
  for (int i = 0; i < MAX_MQ2_SENSORS; i++) if (gasEnabled[i]) roClean[i] = v[i];

  Serial.print("[CAL] Loaded stored baseline:");
  for (int i = 0; i < MAX_MQ2_SENSORS; i++) {
    if (gasEnabled[i]) Serial.printf("  Ro%d %.2f kΩ", i + 1, roClean[i]);
  }
  Serial.println();
  return true;
}

void saveRo() {
  prefs.begin(NVS_NAMESPACE, false); // read-write
  char key[8];
  for (int i = 0; i < MAX_MQ2_SENSORS; i++) {
    if (!gasEnabled[i]) continue;   // don't write a fallback over a real stored value
    roKey(i, key, sizeof(key));
    prefs.putFloat(key, roClean[i]);
  }
  prefs.end();
  Serial.print("[CAL] Baseline saved to flash:");
  for (int i = 0; i < MAX_MQ2_SENSORS; i++) {
    if (gasEnabled[i]) Serial.printf("  Ro%d %.2f kΩ", i + 1, roClean[i]);
  }
  Serial.println();
}

// Measure the clean-air baseline and save it. Only valid in clean air; an out-of-range
// result is rejected instead of saved.
bool calibrateRo() {
  const int samples = 50;
  float rsSum[MAX_MQ2_SENSORS] = { 0, 0, 0, 0 };
  for (int n = 0; n < samples; n++) {
    for (int i = 0; i < MAX_MQ2_SENSORS; i++) {
      if (gasEnabled[i]) rsSum[i] += adcToRs(analogRead(MQ2_PINS[i]));
    }
    delay(50);
  }

  // All or nothing across the fitted sensors: either every sensor gets its new baseline or
  // none does, so a box never ends up with a mix of old and new values.
  float cand[MAX_MQ2_SENSORS];
  bool  allOk = true, any = false;
  for (int i = 0; i < MAX_MQ2_SENSORS; i++) {
    if (!gasEnabled[i]) continue;
    any = true;
    cand[i] = (rsSum[i] / samples) / MQ2_CLEAN_AIR_RATIO;
    if (!(cand[i] >= RO_MIN_VALID && cand[i] <= RO_MAX_VALID)) allOk = false;
  }
  if (!any) {
    Serial.println("[CAL] No sensor channels are enabled — nothing to calibrate.");
    return false;
  }
  if (!allOk) {
    Serial.printf("[CAL] REJECTED — reading out of range (valid %.1f–%.1f kΩ). "
                  "Check the wiring, or the air was not clean. Keeping the previous baseline.\n",
                  (double)RO_MIN_VALID, (double)RO_MAX_VALID);
    for (int i = 0; i < MAX_MQ2_SENSORS; i++) {
      if (!gasEnabled[i]) continue;
      bool ok = cand[i] >= RO_MIN_VALID && cand[i] <= RO_MAX_VALID;
      Serial.printf("[CAL]   Sensor %d → Ro %.2f kΩ%s\n", i + 1, cand[i], ok ? "" : "  BAD");
    }
    return false;
  }

  for (int i = 0; i < MAX_MQ2_SENSORS; i++) {
    if (!gasEnabled[i]) continue;
    Serial.printf("[CAL] Sensor %d → Avg Rs %.2f kΩ  Ro %.2f kΩ\n",
                  i + 1, rsSum[i] / samples, cand[i]);
    roClean[i] = cand[i];
  }
  saveRo();
  return true;
}

// Schedule a calibration `settleMs` from now. Used for the first-boot case (long settle)
// and for an on-demand recalibration from the dashboard (short — the heater is already hot).
void scheduleCalibration(unsigned long settleMs) {
  pendingCalibration = true;
  calibrationDueAt = millis() + settleMs;
  Serial.printf("[CAL] Calibration scheduled in %lus — keep the air CLEAN until then.\n",
                settleMs / 1000);
}

/*
 * Report the result to the dashboard, so the Recalibrate button shows whether the new
 * baseline was accepted. Payload: ["gasCalibrated", {ok, ro1, ro2}]
 */
void sendCalibrationResult(bool ok) {
  if (!socketIO.isConnected()) return;
  StaticJsonDocument<192> doc;
  JsonArray arr   = doc.to<JsonArray>();
  arr.add("gasCalibrated");
  JsonObject data = arr.createNestedObject();
  data["ok"]  = ok;
  data["ro1"] = roClean1;
  data["ro2"] = roClean2;
  JsonArray roArr = data.createNestedArray("ro");
  for (int i = 0; i < MAX_MQ2_SENSORS; i++) roArr.add(gasEnabled[i] ? roClean[i] : 0);
  String out;
  serializeJson(doc, out);
  socketIO.sendEVENT(out);
  Serial.printf("[IO] gasCalibrated sent → ok=%d ro1=%.2f ro2=%.2f\n", ok, roClean1, roClean2);
}

/*
 * ─────────────────────────────────────────────
 *  SEND irFired EVENT
 * ─────────────────────────────────────────────
 */
void sendIRFiredEvent(int zone, const String& label, int channels) {
  StaticJsonDocument<256> doc;
  JsonArray arr   = doc.to<JsonArray>();
  arr.add("irFired");
  JsonObject data = arr.createNestedObject();
  data["zone"]     = zone;
  data["label"]    = label;
  data["channels"] = channels;
  String out;
  serializeJson(doc, out);
  socketIO.sendEVENT(out);
  Serial.printf("[IO] irFired sent → zone=%d label=%s\n", zone, label.c_str());
}

/*
 * ─────────────────────────────────────────────
 *  SEND CHANNEL MAP TO SERVER
 *  Sent on every socket connect so the server
 *  knows which GPIO each channel uses.
 *  Payload: ["irChannelMap", {channels:[{channel,gpio}, ...]}]
 * ─────────────────────────────────────────────
 */
/* Which ADC pin each gas channel uses. Only the device knows, so it reports it (like
   sendChannelMap() for IR), and the dashboard can show staff which pin to wire. */
void sendGasSensorMap() {
  DynamicJsonDocument doc(256);
  JsonArray arr  = doc.to<JsonArray>();
  arr.add("gasSensorMap");
  JsonObject data = arr.createNestedObject();
  JsonArray  chs  = data.createNestedArray("sensors");
  for (int i = 0; i < MAX_MQ2_SENSORS; i++) {
    JsonObject ch = chs.createNestedObject();
    ch["channel"] = i + 1;             // 1-based, matches gas_sensors.channel
    ch["gpio"]    = MQ2_PINS[i];
  }
  String output;
  serializeJson(doc, output);
  socketIO.sendEVENT(output);
  Serial.println("[IO] Sent gasSensorMap to server.");
}

void sendChannelMap() {
  DynamicJsonDocument doc(256);
  JsonArray arr  = doc.to<JsonArray>();
  arr.add("irChannelMap");
  JsonObject data = arr.createNestedObject();
  JsonArray  chs  = data.createNestedArray("channels");
  for (int i = 0; i < MAX_IR_CHANNELS; i++) {
    JsonObject ch = chs.createNestedObject();
    ch["channel"] = i + 1;                // 1-based, matches DB ir_channel
    ch["gpio"]    = IR_CHANNEL_PINS[i];
  }
  String output;
  serializeJson(doc, output);
  socketIO.sendEVENT(output);
  Serial.println("[IO] Sent irChannelMap to server.");
}

/* =========================================== */

void socketIOEvent(socketIOmessageType_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case sIOtype_DISCONNECT:
      Serial.println("[IO] Disconnected");
      break;

    case sIOtype_CONNECT:
      Serial.println("[IO] Connected to server");
      sendChannelMap();   // tell server which GPIOs this ESP32 has wired
      sendGasSensorMap(); // ...and which ADC pins the gas channels sit on
      // Flush any irFired event that was queued while socket was down
      if (pendingIRFired) {
        sendIRFiredEvent(pendingIRZone, pendingIRLabel, 0);
        pendingIRFired = false;
        Serial.println("[IO] Queued irFired flushed after reconnect.");
      }
      break;

    case sIOtype_EVENT: {
      // Parse ["eventName", {...}]
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, payload, length);
      if (err) { Serial.printf("[IO] JSON parse error: %s\n", err.c_str()); break; }

      const char* eventName = doc[0];

      // Manual ON/OFF command from dashboard — fire on the specific channel only
      if (strcmp(eventName, "irCommand") == 0) {
        int channel = doc[1]["channel"].as<int>() - 1;  // 1-based → 0-based
        const char* action = doc[1]["action"];
        if (channel >= 0 && channel < MAX_IR_CHANNELS) {
          const uint16_t* irData = nullptr;
          uint16_t irLen = 0;
          if (strcmp(action, "on") == 0) {
            irData = IR_POWER_ON;
            irLen  = sizeof(IR_POWER_ON) / sizeof(IR_POWER_ON[0]);
          } else if (strcmp(action, "off") == 0) {
            irData = IR_POWER_OFF;
            irLen  = sizeof(IR_POWER_OFF) / sizeof(IR_POWER_OFF[0]);
          }
          if (irData && irLen > 0) {
            irChannels[channel].sendRaw(irData, irLen, 38);
            Serial.printf("[IR] Manual %s fired on CH%d (GPIO%d).\n",
                          action, channel + 1, IR_CHANNEL_PINS[channel]);
          }

          // Re-sync a unit that was just switched back on. Auto IR only fires on a zone change and
          // skips units that are off, so without this it would keep its old setting until the next
          // zone change. Power-on only sends IR_POWER_ON, so send the current zone's code after it.
          if (strcmp(action, "on") == 0 && lastIRZone != IR_ZONE_NONE) {
            const uint16_t* zoneData = nullptr;
            uint16_t zoneLen = 0;
            String zoneLabel = "";
            if (zoneIRData(lastIRZone, &zoneData, &zoneLen, &zoneLabel)) {
              delay(300);  // let the unit finish powering on before re-targeting it
              irChannels[channel].sendRaw(zoneData, zoneLen, 38);
              Serial.printf("[IR] Re-synced CH%d to %s (current zone).\n",
                            channel + 1, zoneLabel.c_str());
            }
          }
        }
        break;
      }

      /* Which ADC pins have a sensor. Same format as "irConfig" (one boolean per channel,
         1-based in the DB, 0-based here), so it uses the same parsing.
         Disabling a channel zeroes its reading right away, so an old value cannot keep the room
         in alarm. */
      if (strcmp(eventName, "gasConfig") == 0) {
        JsonArray en = doc[1]["enabled"];
        int i = 0;
        for (JsonVariant v : en) {
          if (i < MAX_MQ2_SENSORS) {
            gasEnabled[i] = v.as<bool>();
            if (!gasEnabled[i]) gasPpm[i] = 0;
          }
          i++;
        }
        Serial.print("[GAS] Sensor channels enabled:");
        for (int k = 0; k < MAX_MQ2_SENSORS; k++) {
          Serial.printf(" %d=%s", k + 1, gasEnabled[k] ? "on" : "off");
        }
        Serial.println();
        break;
      }

      if (strcmp(eventName, "irConfig") == 0) {
        JsonArray channels = doc[1]["channels"];
        for (JsonObject ch : channels) {
          int idx = ch["channel"].as<int>() - 1;  // DB channel is 1-based
          if (idx >= 0 && idx < MAX_IR_CHANNELS) {
            enabledChannels[idx] = ch["enabled"].as<bool>();
          }
        }
        Serial.println("[IR] Channel config updated from server.");
        for (int i = 0; i < MAX_IR_CHANNELS; i++) {
          Serial.printf("  CH%d (GPIO%d): %s\n", i + 1, IR_CHANNEL_PINS[i],
                        enabledChannels[i] ? "enabled" : "disabled");
        }
      }

      // Alarm thresholds from the dashboard (Alert Rules → room-level rules). Only fields that
      // are present are applied; the others keep their default. One rule → one threshold.
      if (strcmp(eventName, "envConfig") == 0) {
        JsonObject cfg = doc[1];
        if (cfg.containsKey("tempWarn")) TEMP_WARNING = cfg["tempWarn"].as<float>();
        if (cfg.containsKey("tempCrit")) TEMP_CRITICAL = cfg["tempCrit"].as<float>();
        if (cfg.containsKey("gasWarn")) WARNING_PPM  = cfg["gasWarn"].as<float>();
        if (cfg.containsKey("gasCrit")) CRITICAL_PPM = cfg["gasCrit"].as<float>();
        if (cfg.containsKey("humWarn")) HUM_WARNING  = cfg["humWarn"].as<float>();
        if (cfg.containsKey("humCrit")) HUM_CRITICAL = cfg["humCrit"].as<float>();
        Serial.printf("[ENV] Thresholds: tempW=%.1f tempC=%.1f gasW=%.1f gasC=%.1f humW=%.1f humC=%.1f\n",
                      TEMP_WARNING, TEMP_CRITICAL, WARNING_PPM, CRITICAL_PPM, HUM_WARNING, HUM_CRITICAL);
      }

      // Auto-cooling zone boundaries from the dashboard (Aircon thresholds). The target per zone
      // is fixed (captured IR codes); only the boundaries change here.
      // Re-measure the MQ-2 clean-air baseline on request (for example after moving the box).
      // A short settle is enough, since the heater has been on since boot. The air must be clean.
      if (strcmp(eventName, "calibrateGas") == 0) {
        Serial.println("[CAL] Recalibration requested from the dashboard.");
        scheduleCalibration(warmupDone ? 5000UL : CAL_SETTLE_MS);
        break;
      }

      if (strcmp(eventName, "acConfig") == 0) {
        JsonObject cfg = doc[1];
        if (cfg.containsKey("coldBelow"))     IR_TEMP_COLD_BELOW   = cfg["coldBelow"].as<float>();
        if (cfg.containsKey("normalMax"))     IR_TEMP_NORMAL_MAX   = cfg["normalMax"].as<float>();
        if (cfg.containsKey("acceptableMax")) IR_TEMP_ACCEPT_MAX   = cfg["acceptableMax"].as<float>();
        if (cfg.containsKey("nearCritMax"))   IR_TEMP_NEARCRIT_MAX = cfg["nearCritMax"].as<float>();
        Serial.printf("[AC] IR zones: cold<%.1f normal<=%.1f accept<=%.1f nearCrit<=%.1f\n",
                      IR_TEMP_COLD_BELOW, IR_TEMP_NORMAL_MAX, IR_TEMP_ACCEPT_MAX, IR_TEMP_NEARCRIT_MAX);
      }
      break;
    }
  }
}

/*
 * ─────────────────────────────────────────────
 *  Network setup: WiFi + backend address, stored in NVS
 *
 *  Runs in setup() only. The portal blocks, which is only acceptable at boot. A WiFi
 *  drop at runtime is handled by the non-blocking retry in loop().
 * ─────────────────────────────────────────────
 */

// A value nobody set: a missing secrets.h define, or one of the placeholders
// secrets.h.example used to ship (like YOUR_WIFI_SSID), which look configured but are not.
bool netUnset(const String& v) {
  return v.length() == 0 || v.startsWith("YOUR_");
}

// Restore a saved configuration. Returns false when nothing usable is stored; then the
// secrets.h defaults are used, and if those are empty too, the portal opens.
bool loadNetConfig() {
  prefs.begin(NVS_NET_NAMESPACE, true);   // read-only
  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");
  String host = prefs.getString("host", "");
  uint16_t p  = prefs.getUShort("port", 0);
  prefs.end();

  if (netUnset(ssid)) {
    Serial.println("[NET] Nothing provisioned — using the secrets.h defaults.");
    return false;
  }
  netSsid = ssid;
  netPass = pass;
  // The backend address is stored with the credentials but is allowed to be missing: a box
  // provisioned by an older build keeps its compiled-in address rather than losing it.
  if (!netUnset(host)) netHost = host;
  if (p > 0)           netPort = p;
  Serial.printf("[NET] Provisioned: SSID \"%s\"  backend %s:%u\n",
                netSsid.c_str(), netHost.c_str(), netPort);
  return true;
}

void saveNetConfig() {
  prefs.begin(NVS_NET_NAMESPACE, false);  // read-write
  prefs.putString("ssid", netSsid);
  prefs.putString("pass", netPass);
  prefs.putString("host", netHost);
  prefs.putUShort("port", netPort);
  prefs.end();
  Serial.printf("[NET] Saved to flash: SSID \"%s\"  backend %s:%u\n",
                netSsid.c_str(), netHost.c_str(), netPort);
}

/* Does anything answer at the backend address? A plain TCP connect, not a Socket.IO
   handshake: the question is whether the right IP was typed. */
bool backendReachable() {
  if (netUnset(netHost) || WiFi.status() != WL_CONNECTED) return false;
  WiFiClient probe;
  bool ok = probe.connect(netHost.c_str(), netPort, BACKEND_PROBE_MS) == 1;
  probe.stop();
  return ok;
}

/* The status block shown in the portal, so a wrong backend IP can be spotted without a
   laptop. A custom WiFiManagerParameter so it sits at the top of the form.
   WiFiManagerParameter keeps the pointer it is given, so this buffer must be a global
   that outlives the portal. */
String netStatusBanner;

void buildStatusBanner(bool probed, bool backendOk) {
  bool wifiOk = (WiFi.status() == WL_CONNECTED);
  netStatusBanner  = F("<div style='padding:8px;border-radius:4px;margin-bottom:10px;"
                       "background:#1b1e23;border-left:4px solid ");
  netStatusBanner += (probed && !backendOk) ? F("#E02F44") : (wifiOk ? F("#73BF69") : F("#FF780A"));
  netStatusBanner += F("'><b>Sensor status</b><br>WiFi: ");
  if (wifiOk) {
    netStatusBanner += WiFi.SSID();
    netStatusBanner += F(" &mdash; ");
    netStatusBanner += WiFi.localIP().toString();
  } else {
    netStatusBanner += F("not connected");
  }
  netStatusBanner += F("<br>Backend: ");
  if (netUnset(netHost)) {
    netStatusBanner += F("not set");
  } else {
    netStatusBanner += netHost + ":" + String(netPort);
    if (probed) netStatusBanner += backendOk ? F(" &mdash; answered ✓")
                                             : F(" &mdash; <b>NO ANSWER</b>. Check the IP, "
                                                 "and that the dashboard server is running.");
  }
  netStatusBanner += F("</div>");
}

/* Did the last run ask for the portal? checkPortalButton() saves the request in NVS and
   restarts, since the portal blocks and running it from loop() would stop sensing, the
   buzzer and IR for minutes. The flag is cleared before the portal opens, so a reset
   inside the portal cannot make it reopen on every boot. */
bool takePortalRequest() {
  prefs.begin(NVS_NET_NAMESPACE, false);
  bool requested = prefs.getBool("portal", false);
  if (requested) prefs.remove("portal");
  prefs.end();
  return requested;
}

/* Watch the buttons for a few seconds after boot so an installed box can be set up again
   without a laptop. A window after boot, not "hold BOOT while powering on" (that puts the
   chip in download mode). The LED turns magenta as the cue. Both pins are read, so the
   same gesture works with or without the external button. */
bool portalButtonPressed() {
  /* Both pins are set up before the early return below. This is the only place they are
     configured; otherwise, after the restart path, GPIO 13 would float, read as pressed,
     and cause a restart loop. */
  pinMode(PORTAL_BUTTON_PIN, INPUT_PULLUP);
  pinMode(PORTAL_BUTTON_PIN2, INPUT_PULLUP);

  /* The normal route in: the button was held during the last run and the box restarted
     itself to get here. No window to catch, nothing to time. */
  if (takePortalRequest()) {
    Serial.println("[NET] Re-provisioning was requested by the button — opening setup.");
    setRGB(60, 0, 60);
    return true;
  }

  setRGB(60, 0, 60);   // magenta = press the button / BOOT now to change the WiFi
  Serial.printf("[NET] Press the setup button or BOOT within %lus to re-run WiFi setup",
                (unsigned long)(PORTAL_BUTTON_WINDOW_MS / 1000));
  unsigned long start = millis();
  bool pressed = false;
  while (millis() - start < PORTAL_BUTTON_WINDOW_MS) {
    if (digitalRead(PORTAL_BUTTON_PIN)  == LOW ||
        digitalRead(PORTAL_BUTTON_PIN2) == LOW) { pressed = true; break; }
    delay(10);
  }
  Serial.println(pressed ? " — PRESSED." : " — no.");
  if (pressed) {
    /* Confirm the press, then keep the LED magenta until the portal opens, so it is clear the
       press worked during the ~10 seconds spent joining WiFi (and nobody presses again and
       restarts it). */
    setRGB(0, 255, 0);   // green blip — the button registered
    delay(250);
    setRGB(60, 0, 60);   // and stay magenta until the setup page is up
  } else {
    setRGB(0, 0, 50);    // back to the boot blue
  }
  return pressed;
}

/* Runtime version of the gesture: hold the external button for PORTAL_HOLD_MS at any time
   and the box reboots into the setup portal, with no reset needed. Non-blocking and
   called before the warmup early return in loop(). It does not open the portal itself
   (see takePortalRequest()). The release latch stops the same hold being counted again
   after the reboot. */
void checkPortalButton() {
  static unsigned long downAt  = 0;
  static bool          latched = false;

  if (digitalRead(PORTAL_BUTTON_PIN2) == LOW) {
    if (!downAt) downAt = millis();
    if (!latched && millis() - downAt >= PORTAL_HOLD_MS) {
      latched = true;
      portalHoldActive = false;
      Serial.println("\n[NET] Setup button held — restarting into WiFi setup.");
      setRGB(0, 255, 0);   // green blip — the hold registered. Fires even mid-alarm, since
      delay(250);          // this is the last feedback before the box goes down.
      prefs.begin(NVS_NET_NAMESPACE, false);
      prefs.putBool("portal", true);
      prefs.end();
      buzzerOff();         // do not leave the piezo driven across the restart
      ESP.restart();
    }
    portalHoldActive = !latched;
  } else {
    downAt  = 0;           // released early — the count starts over next time
    latched = false;
    portalHoldActive = false;
  }
}

// Bounded blocking join with the configuration we already have. Same budget as the
// 20 x 500 ms wait this replaces.
bool joinWiFi(unsigned long timeoutMs) {
  if (netUnset(netSsid)) return false;
  Serial.printf("[WiFi] Connecting to \"%s\"", netSsid.c_str());
  WiFi.begin(netSsid.c_str(), netPass.c_str());
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
    delay(250);
    Serial.print(".");
  }
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println(" failed.");
    return false;
  }
  Serial.print("\n[WiFi] IP: ");
  Serial.println(WiFi.localIP());
  return true;
}

// The AP the installer joins. The MAC suffix is what keeps two boxes commissioned side by
// side from showing up as the same network in the phone's list.
String portalApName() {
#if AP_SSID_UNIQUE
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char suffix[8];
  snprintf(suffix, sizeof(suffix), "-%02X%02X", mac[4], mac[5]);
  return String(AP_SSID_PREFIX) + suffix;
#else
  return String(AP_SSID_PREFIX);
#endif
}

/* WiFiManager answers /wifisave with a fixed "Saving Credentials…" page before it even
   tries to join, so that page cannot show the result, and wrong and right passwords
   looked the same. So a script in the page head (setCustomHeadElement) notices it is on
   /wifisave, counts down the join attempt, then shows /sensorstate: our page, served by
   WiFiManager's web server, saying what happened and what to do. It also contains a link
   to /sensorstate for browsers that ignore the timer. The library itself is not changed. */
const char PORTAL_HEAD_SCRIPT[] PROGMEM =
  "<script>(function(){"
  "var W=location.pathname.indexOf('wifisave')>=0;"
  "var n=11,d;"   // PORTAL_CONNECT_TIMEOUT_S + 1
  "function s(h){d.innerHTML=h;}"
  "function f(){s('<div class=\"msg D\">Lost contact with the sensor while it was connecting."
  "<br>Rejoin its WiFi, then open <a href=\"/sensorstate\">192.168.4.1/sensorstate</a></div>');}"
  "function p(){var x=new XMLHttpRequest();x.open('GET','/sensorstate?raw=1',true);x.timeout=8000;"
  "x.onload=function(){if(x.status!=200){f();return;}var t=x.responseText;s(t.substring(1));"
  "var c=t.charAt(0);"          // P still connecting, F backend unreachable, D all clear
  "if(c=='P')setTimeout(p,3000);else if(c=='F')setTimeout(p,5000);};"
  "x.onerror=f;x.ontimeout=f;x.send();}"
  "function t(){s('Checking the connection… '+n+'s<br><a href=\"/sensorstate\">See the result now</a>');"
  "if(--n<0){s('Checking…');p();return;}setTimeout(t,1000);}"
  "window.addEventListener('load',function(){"
  /* Only for the SSID box: WiFiManager fills its placeholder with the network the box is
     currently on, which should not be shown on an open access point. Rewritten here instead
     of in the library so a library update cannot bring it back. */
  "if(!W){var e=document.getElementById('s');if(e)e.placeholder='SSID name';return;}"
  "d=document.createElement('div');"
  "d.id='cspcw';document.body.appendChild(d);t();});"
  "})();</script>";

/* Set when /sensorstate has served a finished result, so the confirmation window can
   close as soon as the phone has read it. */
bool portalResultSeen = false;
/* Set when anyone has fetched the result at all. Separates "someone is here reading a
   problem" (long window) from "powered on in an empty room". */
bool portalClientSeen = false;

/* The result, in words. `fragment` returns only the panel, for the script to insert into
   the /wifisave page; the full page is what /sensorstate serves when the phone lost the
   access point. A fragment starts with P (pending) or D (done) so the script knows
   whether to poll again. */
String sensorStatePage(WiFiManager& wm, bool fragment) {
  uint8_t res       = wm.getLastConxResult();
  bool    connected = (WiFi.status() == WL_CONNECTED);
  // WiFiManager has not finished (or not started) a join attempt of its own yet.
  bool    pending   = !connected && res == WL_IDLE_STATUS;

  String colour, title, detail;
  bool   backendBad = false;

  if (connected) {
    colour = "#73BF69";
    title  = "Connected to " + WiFi.SSID();
    detail = "IP address " + WiFi.localIP().toString() + "<br>";
    if (netUnset(netHost)) {
      detail += "No backend address is set yet.";
    } else if (backendReachable()) {
      detail += "Backend " + netHost + ":" + String(netPort) +
                " answered. <b>This sensor is ready</b> — it should appear on the dashboard "
                "within a minute.";
    } else {
      colour     = "#FF780A";
      backendBad = true;
      detail    += "<b>Backend " + netHost + ":" + String(netPort) + " did not answer.</b> "
                   "Check the IP, and that the dashboard server is running, then tap "
                   "<b>Back to WiFi setup</b> below, correct the Backend IP and Save again.";
    }
  } else if (pending) {
    colour = "#5794F2";
    title  = "Still trying…";
    detail = "The sensor is connecting. This page refreshes by itself.";
  } else {
    colour = "#E02F44";
    title  = "Not connected";
    // 7 is WiFiManager's own WL_STATION_WRONG_PASSWORD value; repeated here because the member
    // is protected (the ESP32 SDK has no wrong-password status).
    if (res == 7) {
      detail = "<b>The WiFi password is wrong.</b> Nothing was saved — go back and type it again.";
    } else if (res == WL_NO_SSID_AVAIL) {
      detail = "<b>That network was not found.</b> Either it is out of range, or it is a 5 GHz "
               "network — the sensor can only use <b>2.4 GHz</b>.";
    } else {
      detail = "<b>Could not connect.</b> Most often this is a wrong password. Nothing was "
               "saved — go back and try again.";
    }
  }

  /* The LED follows the result, in the same colours as the panel. Set here because this is
     the only code of ours that runs while WiFiManager's portal has control. Safe only here:
     sensing has not started, so this cannot hide an alarm. After warmupDone only
     setStatusColor() touches the LED. */
  if (pending)          setRGB(60, 0, 60);    // magenta — still trying, as during the portal
  else if (!connected)  setRGB(255, 0, 0);    // red     — wrong password / network not found
  else if (backendBad)  setRGB(255, 60, 0);   // orange  — on WiFi, but the backend is silent
  else                  setRGB(0, 255, 0);    // green   — connected and the backend answered

  if (fragment) {
    /* Three states, because the page has three things it might need to do next: P keep waiting,
       F stop waiting but stay open so the address can be corrected, D stop and let go. */
    String f = pending ? F("P") : (backendBad ? F("F") : F("D"));
    f += F("<div style='background:#181B1F;border-left:5px solid ");
    f += colour;
    f += F(";border-radius:3px;padding:14px;margin:14px 0;text-align:left'><b style='font-size:17px'>");
    f += title;
    f += F("</b><br>");
    f += detail;
    f += F("</div>");
    return f;
  }

  String p = F("<!DOCTYPE html><html><head><meta charset='utf-8'>"
               "<meta name='viewport' content='width=device-width,initial-scale=1'>");
  if (pending) p += F("<meta http-equiv='refresh' content='3'>");
  p += F("<title>Sensor setup</title><style>"
         "body{background:#111217;color:#D9D9D9;font-family:system-ui,sans-serif;margin:0;padding:18px}"
         ".c{max-width:420px;margin:0 auto}"
         ".b{background:#181B1F;border-left:5px solid ");
  p += colour;
  p += F(";border-radius:3px;padding:14px;margin-bottom:16px}"
         "h2{margin:0 0 8px;font-size:19px}p{margin:0;line-height:1.5}"
         "a{display:block;text-align:center;background:#1F2429;color:#5794F2;text-decoration:none;"
         "padding:12px;border-radius:3px;margin-top:8px}</style></head><body><div class='c'>"
         "<div class='b'><h2>");
  p += title;
  p += F("</h2><p>");
  p += detail;
  p += F("</p></div><a href='/wifi'>Back to WiFi setup</a>"
         "<a href='/'>Setup home</a></div></body></html>");
  return p;
}

/* Read the backend address from the portal form. Called from the save callback, before
   the result page is built, so the page shows the address just typed. Called again
   after the portal returns; safe to repeat. */
void applyPortalParams(WiFiManagerParameter& pHost, WiFiManagerParameter& pPort) {
  String host = String(pHost.getValue());
  host.trim();
  if (!netUnset(host)) netHost = host;
  long p = String(pPort.getValue()).toInt();
  if (p >= 1 && p <= 65535) netPort = (uint16_t)p;   // junk keeps the previous port rather
                                                     // than storing 0 and never connecting
}

/* Keeps the success page alive. On a successful join WiFiManager shuts the portal down at
   once, so the phone lost the page confirming success. This runs from
   setSaveConfigCallback, which is called before that shutdown, and serves the page for a
   few more seconds; returning lets WiFiManager tear down as usual. Not
   setDisableConfigPortal(false), which would leave the portal running with nothing
   serving it. */
void holdPortalForResult(WiFiManager& wm) {
  portalResultSeen = false;
  portalClientSeen = false;
  Serial.println("[NET] Connected — holding the setup page open so the result can be read.");

  unsigned long start = millis();
  unsigned long limit = PORTAL_CONFIRM_MS;
  while (millis() - start < limit && !portalResultSeen) {
    wm.server->handleClient();
    /* Someone has the page open. If the result were good they would have released the loop
       already, so they are looking at a problem: give them time to fix it before the access
       point closes. */
    if (portalClientSeen) limit = PORTAL_FIX_MS;
    delay(5);
  }

  if (portalResultSeen)      Serial.println("[NET] Result read — closing the setup page.");
  else if (portalClientSeen) Serial.println("[NET] Setup page still showing a problem when the "
                                            "window expired — closing it.");
  else                       Serial.println("[NET] Nobody read the result — closing the setup page.");
}

/* Three outcomes: saved a new network, closed without saving (old network still up), or
   failed. The second must not reopen the portal next round.
   #define instead of an enum: the Arduino builder puts auto-generated prototypes above
   the sketch body, where an enum type would not exist yet. */
#define PORTAL_OFFLINE   0
#define PORTAL_SAVED     1
#define PORTAL_UNCHANGED 2

/* One round of the portal, only at boot, when there is no usable configuration or the
   button asked for it. WiFiManager is local so its web and DNS servers are freed when the
   portal closes. */
int runPortalRound(bool forceOpen, bool probed, bool backendOk) {
  WiFiManager wm;

  buildStatusBanner(probed, backendOk);
  WiFiManagerParameter pStatus(netStatusBanner.c_str());

  char portBuf[8];
  snprintf(portBuf, sizeof(portBuf), "%u", netPort);
  WiFiManagerParameter pHost("host", "Backend IP (the PC running the dashboard server)",
                             netHost.c_str(), 40);
  WiFiManagerParameter pPort("port", "Backend port", portBuf, 6);
  wm.addParameter(&pStatus);
  wm.addParameter(&pHost);
  wm.addParameter(&pPort);

  wm.setTitle("CSPC ICTU Server Room Sensor");
  wm.setDarkMode(true);
  // Added to the head of every portal page; the script only acts on /wifisave. A string
  // literal, because setCustomHeadElement keeps the pointer.
  wm.setCustomHeadElement(PORTAL_HEAD_SCRIPT);
  // Runs after the web server is created and before the library adds its routes, so this
  // adds a path without replacing one. `wm` outlives its server, so capturing it by
  // reference is safe.
  wm.setWebServerCallback([&wm, &pHost, &pPort]() {
    wm.server->on("/sensorstate", [&wm, &pHost, &pPort]() {
      // ?raw=1 -> just the panel, for the in-page update on /wifisave. No arg -> the full page,
      // which is what a human typing the address gets.
      bool raw = wm.server->hasArg("raw");
      /* Re-read the form each time: the backend IP may have been corrected and saved again,
         and the probe must test what the form says now. */
      applyPortalParams(pHost, pPort);
      String body = sensorStatePage(wm, raw);
      wm.server->send(200, raw ? "text/plain" : "text/html", body);
      if (raw && body.length()) {
        portalClientSeen = true;
        // Only a success releases the hold; 'F' is finished but on a problem, and the access
        // point is still needed to fix it.
        if (body[0] == 'D') portalResultSeen = true;
      }
    });
  });
  // Fires on the success path only, while the portal is still up. See holdPortalForResult().
  wm.setSaveConfigCallback([&wm, &pHost, &pPort]() {
    applyPortalParams(pHost, pPort);
    holdPortalForResult(wm);
  });
  wm.setConfigPortalTimeout(PORTAL_TIMEOUT_S);
  /* How long one join attempt from the portal gets. 10 s is well past a normal join + DHCP
     (2-5 s), and the /wifisave countdown is based on it: change both together. */
  wm.setConnectTimeout(PORTAL_CONNECT_TIMEOUT_S);
  wm.setRemoveDuplicateAPs(true);
  // "info" is the built-in page — SSID, IP, signal, MAC, free heap. Together with the
  // banner above it is the status page the client asked for, at no flash cost.
  const char* menu[] = { "wifi", "info", "sep", "restart", "exit" };
  wm.setMenu(menu, 5);

  String apName = portalApName();
  const char* apPass = (strlen(AP_PASSWORD) >= 8) ? AP_PASSWORD : NULL;  // NULL = open AP
  // Log which path is taken: autoConnect may join a saved network without ever showing an
  // access point.
  if (forceOpen) {
    Serial.printf("[NET] Setup portal opening — join WiFi \"%s\" %s; the page opens itself.\n",
                  apName.c_str(), apPass ? "(password is on the enclosure)" : "(no password)");
  } else {
    Serial.printf("[NET] Trying any stored credentials; failing that, the setup portal opens "
                  "as \"%s\" %s.\n",
                  apName.c_str(), apPass ? "(password on the enclosure)" : "(no password)");
  }
  setRGB(60, 0, 60);

  /* forceOpen uses startConfigPortal, which always shows the form (autoConnect would just
     join the saved network). Nothing is erased beforehand: the old settings are only
     replaced once new ones are proven to work, so an abandoned portal leaves the box as it was. */
  bool ok = forceOpen ? wm.startConfigPortal(apName.c_str(), apPass)
                      : wm.autoConnect(apName.c_str(), apPass);

  if (!ok) {
    WiFi.mode(WIFI_STA);   // drop the AP so the radio is free for the retries in loop()
    setRGB(0, 0, 50);
    if (WiFi.status() == WL_CONNECTED) {
      Serial.println("[NET] Portal closed without changes — the previous network is still up.");
      return PORTAL_UNCHANGED;
    }
    Serial.println("[NET] Portal closed with no working network — carrying on offline. "
                   "loop() keeps retrying; press BOOT at the next boot to try again.");
    return PORTAL_OFFLINE;
  }

  // Take the credentials from the LIVE connection rather than from the form: this is what
  // the radio actually associated with, so what gets stored cannot disagree with what works.
  String ssid = WiFi.SSID();
  if (!netUnset(ssid)) {
    netSsid = ssid;
    netPass = WiFi.psk();
  }

  applyPortalParams(pHost, pPort);   // already done in the save callback; harmless to repeat,
                                     // and it covers any path that reaches here without one
  saveNetConfig();
  Serial.print("[WiFi] IP: ");
  Serial.println(WiFi.localIP());
  setRGB(0, 0, 50);
  return PORTAL_SAVED;
}

/* Set up, then check: each portal round is followed by a TCP probe of the entered
   address, and a failure reopens the portal with the reason. Limited to
   PORTAL_BACKEND_ROUNDS, since the server may just be off. */
bool runProvisioningPortal(bool forced) {
  bool probed = false, backendOk = false;

  /* If WiFi is already up (portal opened with the button on a working box), probe first so
     the form opens with a verdict on the saved address. */
  if (WiFi.status() == WL_CONNECTED && !netUnset(netHost)) {
    backendOk = backendReachable();
    probed    = true;
    Serial.printf("[NET] Current backend %s:%u %s\n", netHost.c_str(), netPort,
                  backendOk ? "answered." : "did NOT answer.");
  }

  for (int round = 0; round <= PORTAL_BACKEND_ROUNDS; round++) {
    // Round 0 forces the form open only when BOOT asked for it; every later round always
    // does, since the whole reason for a later round is that an address needs correcting.
    int r = runPortalRound(forced || round > 0, probed, backendOk);
    if (r == PORTAL_OFFLINE) return false;
    if (r == PORTAL_UNCHANGED) {
      // Closed on purpose; do not reopen it.
      Serial.println("[NET] Configuration left as it was.");
      return true;
    }

    probed    = true;
    backendOk = backendReachable();
    if (backendOk) {
      Serial.printf("[NET] Backend %s:%u answered.\n", netHost.c_str(), netPort);
      return true;
    }
    Serial.printf("[NET] Backend %s:%u did not answer%s\n", netHost.c_str(), netPort,
                  round < PORTAL_BACKEND_ROUNDS ? " — reopening the portal to correct it."
                                                : " — carrying on; readings buffer to SD.");
  }
  return true;   // WiFi is up; only the backend is unproven, and loop() keeps trying it
}

/* Called from setup() where the old WiFi.begin() block was. Returns true when the radio is
   associated — which is what gates the NTP sync that follows it. */
bool setupNetwork() {
  WiFi.mode(WIFI_STA);          // never leave a stale AP / AP+STA mode from NVS active
  WiFi.setAutoReconnect(true);  // let the SDK re-associate after a brief drop

  bool stored     = loadNetConfig();
  bool forced     = portalButtonPressed();
  bool configured = stored || !netUnset(netSsid);   // NVS, else the secrets.h fallbacks

  /* The join runs even when BOOT was pressed, so the portal can show whether the backend is
     reachable. See runProvisioningPortal. */
  bool joined = configured && joinWiFi(WIFI_JOIN_TIMEOUT_MS);

  if (joined && !forced)      return true;
  if (forced || !configured)  return runProvisioningPortal(forced);

  /* Configured, but that network was not found. Not a reason to open the portal: it is the
     same as a runtime drop (access point rebooting, cable pulled, box powered up first), and
     the retry in loop() handles it. Opening the portal here would leave the room unwatched
     for minutes. */
  Serial.println("[WiFi] Saved network unreachable — offline mode, loop() keeps retrying. "
                 "Press BOOT early in the next boot to change the WiFi.");
  return false;
}

/* =========================================== */

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== Environment & Smoke Monitor v2 ===");

  /* Buzzer */
  ledcAttach(BUZZER_PIN, FREQ_SMOKE_WARN, 10);
  buzzerOff();

  /* WS2812B RGB LED */
  rgb.begin();
  rgb.setBrightness(80);  // 0–255, keep reasonable for 3.3V pin
  setRGB(0, 0, 50);       // dim blue during boot
  Serial.println("[OK] RGB LED ready.");

  /* DHT22 */
  dht.begin();
  Serial.println("[OK] DHT22 ready.");

  /* IR transmitters — init all channels */
  for (int i = 0; i < MAX_IR_CHANNELS; i++) {
    irChannels[i].begin();
  }
  Serial.printf("[OK] %d IR channel(s) initialised.\n", MAX_IR_CHANNELS);

  /* RTC DS3231 */
  if (rtc.begin()) {
    rtcAvailable = true;
    if (rtc.lostPower()) {
      Serial.println("[RTC] Power lost — setting compile time.");
      rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
    }
    Serial.print("[RTC] Time: ");
    Serial.println(getTimestamp());
  } else {
    Serial.println("[WARN] RTC not found — using uptime fallback.");
    rtcAvailable = false;
  }

  /* micro SD, before WiFi, so readings are buffered from the start if the access point is
     down at boot. */
  sdInit();

  /* WiFi: from NVS first, secrets.h as fallback, and the captive portal when there is
     neither. setupNetwork() is the only place that may open the portal. */
  if (setupNetwork()) {
    wifiWasUp = true;

    // Sync time via NTP — Philippines is UTC+8, no DST
    configTime(8 * 3600, 0, "pool.ntp.org", "time.nist.gov");
    Serial.print("[NTP] Syncing");
    struct tm ti;
    int ntpAttempts = 0;
    while (!getLocalTime(&ti, 1000) && ntpAttempts < 10) {
      Serial.print(".");
      ntpAttempts++;
    }
    if (getLocalTime(&ti, 0)) {
      char buf[32];
      strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &ti);
      Serial.printf("\n[NTP] Time: %s\n", buf);
      /* getTimestamp() uses the DS3231 first, so correct it from NTP when they differ;
         otherwise an RTC set from the compile time stays wrong, and buffered SD rows are stored
         under the device's time. Both clocks are local time (UTC+8). */
      if (rtcAvailable) {
        DateTime ntpNow(ti.tm_year + 1900, ti.tm_mon + 1, ti.tm_mday,
                        ti.tm_hour, ti.tm_min, ti.tm_sec);
        long drift = (long)rtc.now().unixtime() - (long)ntpNow.unixtime();
        if (drift > 2 || drift < -2) {
          rtc.adjust(ntpNow);
          Serial.printf("[RTC] Corrected from NTP (was off by %lds).\n", drift);
        }
      }
    } else {
      Serial.println("\n[NTP] Sync failed — will retry from getTimestamp().");
    }
  } else {
    Serial.println("[WiFi] Offline mode — readings buffer to the SD card until the link is back.");
  }

  /* Socket.IO: the device key is sent as an HTTP header on the WebSocket upgrade, not in
     the URL, since URLs end up in proxy and access logs. (This client speaks EIO3, which
     has no `auth` payload.) The backend reads auth → x-device-key → query, in that order;
     see backend/src/server.js. `static` because setExtraHeaders keeps the buffer. */
  static char deviceKeyHeader[128];
  snprintf(deviceKeyHeader, sizeof(deviceKeyHeader), "X-Device-Key: %s", deviceSecret);
  socketIO.setExtraHeaders(deviceKeyHeader);
  /* The address comes from NVS and may be empty (a blank box whose portal timed out). Then
     begin() is not called; loop() treats it as "no backend configured" and the room is still
     sensed, alarmed and buffered to the SD card until the next boot's portal fixes it. */
  if (netUnset(netHost)) {
    socketConfigured = false;
    Serial.println("[NET] No backend address set — readings buffer to the SD card. "
                   "Press BOOT early in the next boot to set one.");
  } else {
    socketIO.begin(netHost.c_str(), netPort, "/socket.io/?EIO=3&transport=websocket");
    socketIO.onEvent(socketIOEvent);
    socketIO.setReconnectInterval(5000);
    socketConfigured = true;
  }

  /* MQ-2 baseline: reuse the saved one, or schedule a first calibration (see RO_MIN_VALID). */
  if (!loadRo()) {
    Serial.println("[CAL] First run here. Using fallback values until calibration completes.");
    scheduleCalibration(CAL_SETTLE_MS);
  }

  /* MQ-2 warmup */
  Serial.println("[INFO] MQ-2 warming up for 20 seconds...");
  warmupStart = millis();
  warmupDone = false;
  lastLogTime = millis();
  lastBeepTime = millis();
}

/* =========================================== */

void loop() {
  if (socketConfigured) socketIO.loop();
  unsigned long now_ms = millis();

  /* ── Setup button ──
     Checked before the warmup early return, so the button works from the first tick. */
  checkPortalButton();

  bool wifiNow = (WiFi.status() == WL_CONNECTED);

  /* ── WiFi keep-alive ──
     Retry joining on a slow timer, so a box that booted before the access point was up,
     or lost it later, reconnects without a reset. Before the warmup early return and
     non-blocking, so sensing, LED, buzzer and IR keep running. */
  if (wifiNow != wifiWasUp) {
    wifiWasUp = wifiNow;
    if (wifiNow) {
      Serial.print("[WiFi] Connected. IP: ");
      Serial.println(WiFi.localIP());
      /* NTP is configured per connection, so a box that booted with no WiFi never
         got it at all — which is why its timestamps read UP HH:MM:SS. */
      configTime(8 * 3600, 0, "pool.ntp.org", "time.nist.gov");
    } else {
      Serial.println("[WiFi] Link lost — will retry.");
    }
  }
  static unsigned long lastWifiRetry = 0;
  /* A retry, never the setup portal: the portal blocks, and an access point reboot must not
     stop sensing, the buzzer and IR. Re-setup is a boot-time act (checkPortalButton
     restarts into it). The SSID check skips a blank box. */
  if (!wifiNow && !netUnset(netSsid) && (now_ms - lastWifiRetry) >= WIFI_RETRY_MS) {
    lastWifiRetry = now_ms;
    Serial.print("[WiFi] Down — retrying SSID: ");
    Serial.println(netSsid);
    WiFi.disconnect();
    WiFi.begin(netSsid.c_str(), netPass.c_str());
  }

  /* ── SD backfill ──
     Before the warmup early return: buffered rows do not depend on this boot's heater
     warm-up. Both calls do nothing in the common case. */
  if (sdPendingFlush() && wifiNow && socketConfigured && socketIO.isConnected()) sdBeginFlush();
  sdFlushStep(now_ms);

  /* ── Non-blocking warmup ── */
  if (!warmupDone) {
    unsigned long elapsed = now_ms - warmupStart;
    if (elapsed < WARMUP_DURATION) {
      static unsigned long lastWarmupPrint = 0;
      if (now_ms - lastWarmupPrint >= 5000) {
        lastWarmupPrint = now_ms;
        Serial.printf("[WARMUP] %lus remaining...\n", (WARMUP_DURATION - elapsed) / 1000);
      }
      return;
    }
    Serial.println("[OK] Warm-up complete.");
    Serial.printf("[CAL] Active baseline: Ro1 %.2f kΩ  Ro2 %.2f kΩ%s\n",
                  roClean1, roClean2, pendingCalibration ? " (provisional — calibration pending)" : "");
    Serial.println("=== System Ready ===\n");
    warmupDone = true;
    lastLogTime = millis();
    lastBeepTime = millis();
    return;
  }

  /* ── Scheduled clean-air calibration ──
     Runs once its settle time has passed, without blocking. Triggered by a first boot with
     no saved baseline, or by the "calibrateGas" event. */
  if (pendingCalibration && (long)(now_ms - calibrationDueAt) >= 0) {
    pendingCalibration = false;
    Serial.println("[CAL] Measuring clean-air baseline now...");
    sendCalibrationResult(calibrateRo());
  }

  /* ── Read MQ-2 (every loop tick) ── */
  // Every fitted sensor, each against its OWN baseline. A disabled channel is left at 0
  // rather than read: its pin is floating and reading it would feed noise into worstGasPpm().
  int rawSmoke[MAX_MQ2_SENSORS] = { 0, 0, 0, 0 };
  for (int i = 0; i < MAX_MQ2_SENSORS; i++) {
    if (!gasEnabled[i]) { gasPpm[i] = 0; continue; }
    rawSmoke[i] = analogRead(MQ2_PINS[i]);
    gasPpm[i]   = rsToPPM(adcToRs(rawSmoke[i]), roClean[i]);
  }
  int rawSmoke1 = rawSmoke[0], rawSmoke2 = rawSmoke[1];
  float ppm1 = gasPpm[0], ppm2 = gasPpm[1];
  String smokeStatus = calcSmokeStatus();

  /* ── Read DHT22 (every loop tick, cached internally) ── */
  float tempLive = dht.readTemperature();
  float humLive = dht.readHumidity();
  bool dhtLive = !isnan(tempLive) && !isnan(humLive);

  if (dhtLive) {
    lastTempStatus = calcTempStatus(tempLive);
    lastEnvStatus = calcEnvironmentStatus(tempLive, humLive);
  }

  /* ── Buzzer ── */
  handleBuzzer(smokeStatus, lastTempStatus, lastEnvStatus, now_ms);

  /* ── RGB LED ── */
  paintStatusLED(now_ms, socketConfigured && socketIO.isConnected(),
                 lastEnvStatus, lastTempStatus, smokeStatus);

  /* ── IR AC Control (zone-change driven) ── */
  if (dhtLive) handleIR(tempLive);

  /* ── Log + Send every LOG_INTERVAL ── */
  if (now_ms - lastLogTime >= LOG_INTERVAL) {
    lastLogTime = now_ms;

    String timestamp = getTimestamp();
    float temperature = tempLive;
    float humidity = humLive;
    bool dhtOk = dhtLive;
    float heatIndex = dhtOk ? calcHeatIndex(temperature, humidity) : 0.0;
    String tempStatus = lastTempStatus;
    String envStatus = lastEnvStatus;

    /* Serial output */
    Serial.println("-----------------------------");
    Serial.printf("Timestamp:          %s\n", timestamp.c_str());
    Serial.printf("MQ-2 #1 Raw:        %d\n", rawSmoke1);
    Serial.printf("MQ-2 #1 PPM:        %.1f ppm\n", ppm1);
    Serial.printf("MQ-2 #2 Raw:        %d\n", rawSmoke2);
    Serial.printf("MQ-2 #2 PPM:        %.1f ppm\n", ppm2);
    for (int i = 2; i < MAX_MQ2_SENSORS; i++) {
      if (!gasEnabled[i]) continue;
      Serial.printf("MQ-2 #%d Raw:        %d\n", i + 1, rawSmoke[i]);
      Serial.printf("MQ-2 #%d PPM:        %.1f ppm\n", i + 1, gasPpm[i]);
    }
    Serial.printf("Smoke Status:       %s\n", smokeStatus.c_str());
    Serial.printf("Env Status:         %s\n", envStatus.c_str());
    if (dhtOk) {
      Serial.printf("Temperature:        %.1f °C\n", temperature);
      Serial.printf("Temp Status:        %s\n", tempStatus.c_str());
      Serial.printf("Humidity:           %.1f %%\n", humidity);
      Serial.printf("Heat Index:         %.1f °C (display only)\n", heatIndex);
    } else {
      Serial.println("[WARN] DHT22 read failed.");
    }
    Serial.printf("IR Zone:            %d\n", lastIRZone);
    Serial.printf("WiFi:               %s\n", wifiNow ? "Connected" : "Offline");

    if (dhtOk) {
      if (wifiNow && socketIO.isConnected()) {
        /* ── Online: send to server ── */
        StaticJsonDocument<400> doc;
        JsonArray array = doc.to<JsonArray>();
        array.add("sensorData");
        JsonObject p = array.createNestedObject();
        p["timestamp"] = timestamp;
        p["temperature"] = round(temperature * 10) / 10.0;
        p["humidity"] = round(humidity * 10) / 10.0;
        // The legacy pair is still sent for backends that have not been updated. Drop them once
        // every backend is current.
        p["mq2_1_ppm"] = round(ppm1 * 10) / 10.0;
        p["mq2_2_ppm"] = round(ppm2 * 10) / 10.0;
        // The main form: one entry per channel, index+1 = channel, for every slot; the backend
        // ignores channels not marked as wired.
        JsonArray gasArr = p.createNestedArray("gas_ppm");
        for (int i = 0; i < MAX_MQ2_SENSORS; i++) {
          if (gasEnabled[i]) gasArr.add(round(gasPpm[i] * 10) / 10.0);
          else               gasArr.add(nullptr);   // a gap, not a zero
        }
        p["smoke_status"] = smokeStatus;
        p["temp_status"] = tempStatus;
        p["environment_status"] = envStatus;
        p["heat_index"] = round(heatIndex * 10) / 10.0;
        String output;
        serializeJson(doc, output);
        socketIO.sendEVENT(output);
        Serial.println("[IO] Sent: " + output);

      } else {
        /* Offline: buffer to the card instead of dropping the reading. */
        sdAppendRow(timestamp, temperature, humidity,
                    smokeStatus, tempStatus, envStatus, heatIndex, now_ms);
      }
    }
  }
}
