/*
 * ============================================================
 *  ESP32 Environment & Smoke Monitoring System v2
 *  Components: 2x MQ-2, DHT22, Piezo Buzzer, WS2812B RGB LED,
 *              RTC (DS3231), micro SD (SPI), 2x IR Transmitter
 *  
 *  ─── PIN ASSIGNMENTS ────────────────────────────────────────
 *  MQ-2 #1 AOUT  : GPIO 34  (ADC, via 10kΩ/20kΩ divider)
 *  MQ-2 #2 AOUT  : GPIO 35  (ADC, via 10kΩ/20kΩ divider)
 *  DHT22         : GPIO  4
 *  Buzzer        : GPIO 26
 *  WS2812B DIN   : GPIO 27  ← NEW (1-wire, direct 3.3V signal OK)
 *  IR TX #1      : GPIO 25  ← NEW (AC unit 1)
 *  IR TX #2      : GPIO 33  ← NEW (AC unit 2)
 *  RTC DS3231    : SDA=21, SCL=22  (I2C, shared bus OK)
 *  micro SD      : SCK=18, MISO=19, MOSI=23, CS=5  (VSPI default)
 *
 *  --- SD CARD OFFLINE BUFFER ---
 *  The card is a SAFETY NET for the minutes the backend cannot be
 *  reached, not a second copy of everything: while the socket is up the
 *  backend stores and backs up each reading itself, so the card is only
 *  written when the reading has nowhere else to go.
 *
 *    socket DOWN  -> append the reading to /log.csv
 *    socket BACK  -> replay the file to the server as "offlineData"
 *                    events, a few rows per loop tick, then delete it
 *
 *  WARNING: the RTC's coin cell is what makes this worth having.
 *  "offlineData" is stored under the TIMESTAMP THE DEVICE SENDS -- unlike
 *  live data, which the backend stamps itself -- and a DS3231 with no
 *  battery comes back from a power cut with no idea what time it is. A row
 *  the device cannot date is refused rather than buffered (sdAppendRow), so
 *  an unbatteried RTC does not corrupt history; it just means an outage
 *  records nothing. Fit the cell.
 *
 *  ─── IR TRANSMITTER LOGIC ────────────────────────────────────
 *  Both transmitters send identical signals simultaneously.
 *  Temperature zone → AC action (mock NEC raw data):
 *   < 22°C  TOO_COLD  → Cool 28°C, Auto fan
 *   22–24°C NORMAL    → Cool 26°C, Auto fan
 *   25–27°C ACCEPTABLE→ Cool 24°C, Auto fan
 *   28–29°C NEAR_CRIT → Cool 22°C, High fan
 *   > 29°C  CRITICAL  → Cool 20°C, High fan
 *  IR is resent only when zone CHANGES (not every loop tick).
 *
 *  ─── RGB LED STATUS ──────────────────────────────────────────
 *  Green  = NORMAL
 *  Blue   = TOO_COLD
 *  Yellow = WARNING
 *  Orange = CRITICAL by humidity alone
 *  Red    = CRITICAL (Temp or Smoke)
 *
 *  ─── CALIBRATION (self-calibrating since 2026-07-31) ─────────
 *  The MQ-2 clean-air baseline (Ro) is measured on the FIRST boot in a
 *  location and saved to NVS flash, then reused on every boot after.
 *  Moving the box to a new room no longer needs a code edit + reflash —
 *  send the "calibrateGas" socket event from the dashboard instead.
 *  Ro is NOT re-measured on every boot on purpose: a reboot during a gas
 *  event would otherwise record polluted air as "clean" and permanently
 *  under-report smoke.
 * ============================================================
 */

/* ── Required Libraries ──────────────────────────────────────
 *  Install via Arduino Library Manager or PlatformIO:
 *  - DHT sensor library       (Adafruit)
 *  - Adafruit Unified Sensor  (Adafruit)
 *  - ArduinoJson              (Benoit Blanchon) v6
 *  - WebSockets               (Markus Sattler)  — provides SocketIOclient
 *  - RTClib                   (Adafruit)
 *  - SD                       (built-in ESP32 core) - only when SD_ENABLED
 *  - Adafruit NeoPixel        (Adafruit)
 *  - IRremoteESP8266          (crankyoldgit) — IRsend
 *  - WiFiManager              (tzapu) — captive-portal WiFi provisioning
 *
 *  ⚠️ Tools ▸ Partition Scheme ▸ "Huge APP (3MB No OTA/1MB SPIFFS)" is REQUIRED.
 *  It is a per-machine Arduino IDE setting and is NOT stored in the sketch, so anyone
 *  building this on another PC must set it too. On the default scheme the sketch was
 *  already at ~94% before WiFiManager and will not fit — which presents as a flashing
 *  failure and reads like a code fault. This sketch uses neither OTA nor SPIFFS, so
 *  the scheme costs nothing.
 * ─────────────────────────────────────────────────────────── */

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
/* ---- MQ-2 GAS SENSOR POOL -----------------------------------------------------
 * The POOL of ADC pins this board can read, not the number of sensors fitted — the
 * same arrangement as IR_CHANNEL_PINS, and for the same reason: adding a sensor
 * should be soldering one on and ticking a box, not a reflash by us.
 *
 * ⚠️ FOUR IS THE HARDWARE CEILING, and it is ADC2's fault. ADC2 cannot be read at all
 * while WiFi is on — the WiFi driver owns it — which rules out GPIO 0/2/4/12/13/14/
 * 15/25/26/27 outright. That leaves ADC1: GPIO 32/33/34/35/36/39, and 32/33 are
 * already spoken for by IR channels 3 and 4. So: 34, 35, 36, 39.
 *
 * ⚠️ GPIO 36 and 39 are INPUT-ONLY (VP/VN). Fine for an analog sensor, useless for
 * anything that has to drive a line — do not repurpose them for IR.
 *
 * gasEnabled[] is set at runtime by the "gasConfig" socket event. A channel with
 * nothing soldered to it starts FALSE and stays dark, because an unconnected ADC pin
 * does not read zero — it FLOATS, and floating noise pushed through the MQ-2's
 * exponential curve is a believable ppm that can trip the smoke alarm.
 * -------------------------------------------------------------------------------- */
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

/* =========== IR CHANNEL ARRAY ===============
 * Each index = ir_channel value stored in DB (0-based here).
 *
 * This is the POOL of pins this board can drive, not the number of AC
 * units. Two transmitters are wired today (GPIO 25, 33); GPIO 32 and 15
 * are declared and ready so a third or fourth can be added by SOLDERING
 * ONLY — no reflash, no code. sendChannelMap() reports the whole pool to
 * the backend, which sizes its own limit from it, and enabledChannels[]
 * keeps an unwired pin dark until a unit is registered against it.
 *
 * Growing the pool beyond four is the only case that still needs an edit
 * here: add the pin, bump MAX_IR_CHANNELS, add an IRsend entry below.
 * enabledChannels[] is updated at runtime via the "irConfig" socket event.
 * ============================================ */
#define MAX_IR_CHANNELS 4
const uint8_t IR_CHANNEL_PINS[MAX_IR_CHANNELS] = { 25, 33, 32, 15 };
// Channels with no transmitter soldered start DISABLED, so an unwired pin cannot be
// driven by a stale irConfig. The backend enables a channel only once a unit is
// registered against it, so wiring GPIO 32 and registering AC Unit 3 is all it takes.
bool enabledChannels[MAX_IR_CHANNELS] = { true, true, false, false };

/* =================== DHT ==================== */
#define DHTTYPE DHT22

/* =================== RGB LED ================ */
#define NUM_PIXELS 140

/* "Nothing is reaching the dashboard" blink. A short blue pulse interrupting the steady green,
   never a colour of its own: the LED's job is the ROOM, and a fifth steady colour next to the
   existing yellow/orange/red is one more thing to misread in the second somebody glances at it.

   ⚠️ It is suppressed the moment the room has anything to say — see paintStatusLED(). An alarm
   colour is never interrupted, because a fire is not a good moment to be told about the WiFi. */
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
/* The SSID, the password and the backend address are PROVISIONED, not compiled in.
   They live in NVS flash (namespace "netcfg") and are set from a phone through the
   captive portal on first boot — see setupNetwork(). ICTU staff have no Arduino IDE,
   so before this an SSID change or a backend IP change meant a reflash by us.

   secrets.h now supplies FALLBACK defaults only, used while NVS is empty. That is what
   keeps a box flashed BEFORE this change working after it: nothing is provisioned, so
   it comes up on the compiled-in network exactly as it used to. Define them and a dev
   box still joins its own WiFi with no portal; leave them out — which is what
   secrets.h.example now ships — and a blank box opens the portal instead.

   DEVICE_SECRET is the one value that stays compiled in: it must match backend/.env
   exactly, it is not the installer's to choose, and a wrong one fails silently. */
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
#define BACKEND_PORT 3000
#endif

/* The live configuration. Seeded from the secrets.h fallbacks above, overwritten by
   loadNetConfig() when NVS holds a provisioned one. Strings rather than const char*
   because they are now read out of flash at runtime. */
String   netSsid = WIFI_SSID;
String   netPass = WIFI_PASSWORD;
String   netHost = BACKEND_HOST;
uint16_t netPort = BACKEND_PORT;

/* ---- Captive portal ----------------------------------------------------------
   AP_PASSWORD "" leaves the setup AP OPEN, which is the easy thing for staff and the
   reason the window is kept short — it closes the moment credentials are saved. Put a
   WPA2 password here (>= 8 chars) and print it on the enclosure if a passer-by being
   able to reconfigure the box during that window is not acceptable.

   AP_SSID_UNIQUE appends the last two bytes of the MAC (CSPC-ICTU-Sensor-A4C1) so two
   boxes being commissioned on the same bench are told apart. 0 gives the plain name. */
#define AP_SSID_PREFIX  "CSPC-ICTU-Sensor"
#define AP_SSID_UNIQUE  1
#define AP_PASSWORD     ""

/* After the portal saves, the box TESTS the backend address it was just given and, if
   nothing answers, re-opens the portal with the failure named on the form. A mistyped
   backend IP is otherwise indistinguishable from a working install until somebody checks
   the dashboard — the box joins WiFi, the LED goes green, and the readings go nowhere.
   Bounded, because "the server is down right now" is a legitimate answer too: after this
   many extra rounds the box carries on, buffering to the SD card. */
#define PORTAL_BACKEND_ROUNDS  2
#define BACKEND_PROBE_MS       3000

/* The portal gives up after this and the box carries on with whatever it already has,
   so one powered up in an empty server room does not sit as an AP forever. */
#define PORTAL_TIMEOUT_S 180

/* Seconds one join attempt made from inside the portal is given before it is called a
   failure. ⚠️ The /wifisave countdown in PORTAL_HEAD_SCRIPT is this + 1 — change both. */
#define PORTAL_CONNECT_TIMEOUT_S 10

/* How long the setup page is kept alive AFTER a successful join, so the phone can read the
   result before the access point goes away. Must outlast the countdown above with margin —
   the join can succeed in 2 s while the page is still counting to 11 — and it ends early
   the moment the phone actually fetches the verdict. See holdPortalForResult(). */
#define PORTAL_CONFIRM_MS 15000

/* And how long it is held when the join worked but the BACKEND did not answer — long enough
   to tap back, retype the address and save again without the access point ever going away.
   Only ever reached when somebody has actually loaded the page, so a box commissioned and
   walked away from still closes on PORTAL_CONFIRM_MS. See holdPortalForResult(). */
#define PORTAL_FIX_MS 90000

/* ⚠️ Press BOOT *after* power-up, inside the window below — NOT while powering up.
   GPIO 0 is a strapping pin: held low at reset, the ROM enters serial download mode and
   this sketch never runs at all. The window is announced on the RGB LED (magenta) and on
   serial, so there is a moment to press *at* rather than a gesture to time blind. */
#define PORTAL_BUTTON_PIN       0
#define PORTAL_BUTTON_WINDOW_MS 4000

/* How long the boot-time join is given before the box carries on into offline mode.
   Same budget as the old 20 x 500 ms wait it replaces. */
#define WIFI_JOIN_TIMEOUT_MS 10000

/* How often to re-attempt the join while the radio is down. WiFi.begin() is
   non-blocking, so this costs the loop nothing — it only stops retries from
   stacking up faster than an association can complete. */
#define WIFI_RETRY_MS 15000
bool wifiWasUp = false;   // last known link state, for edge detection in loop()

/* ================= SD CARD OFFLINE BUFFER ==================
   0 removes the feature outright - includes, globals and all - which is worth
   knowing because this sketch compiles at ~94% of program storage on the default
   partition scheme. If it no longer fits, set Tools > Partition Scheme to
   "Huge APP (3MB No OTA/1MB SPIFFS)" rather than dropping the buffer.        */
#define SD_ENABLED 1

#if SD_ENABLED
#include <SD.h>
#include <SPI.h>

#define LOG_FILE "/env_backup.csv"

/* A long outage must not fill the card, and a box that never reconnects must not
   write until it dies. 8 MB is weeks of buffering at the cadence below; past it the
   sketch stops appending and says so, rather than silently wrapping. */
#define SD_MAX_LOG_BYTES (8UL * 1024UL * 1024UL)

/* Replay pacing. The OLD implementation of this feature streamed the whole file in
   one while-loop with a delay(30) per row - an hour of buffer meant a 36-SECOND
   blocking stall with no sensor read, no buzzer update and no IR in it. During a
   fire. So the replay is a state machine that hands control back to loop() after a
   few rows and resumes on the next tick. */
#define SD_FLUSH_BATCH 5
#define SD_FLUSH_GAP_MS 40

/* Report-by-exception, mirroring backend services/envPersistPolicy.js - the same
   gates, the same numbers. Buffering all 20 readings a minute would replay ten
   times what a CONNECTED device would have stored, so the chart would gain
   resolution across the outage: the gap would come back as the best-sampled
   stretch of the day. Matching the backend's policy keeps buffered history and
   live history the same shape, and cuts card wear and replay time by the same 10x.
   Change one of these and change the other side with it.                      */
#define SD_HEARTBEAT_MS 30000UL
#define SD_DEADBAND_GAS 15.0
#define SD_DEADBAND_TEMP 0.5
#define SD_DEADBAND_HUM 2.0
#endif  // SD_ENABLED

/* ================= Socket.IO ================ */
// The address is netHost / netPort above — provisioned in NVS, not compiled in.
// Must match DEVICE_SECRET in backend/.env
const char* deviceSecret = DEVICE_SECRET;
// False until socketIO.begin() has been given a real address. A box can now boot with no
// backend configured at all, which was impossible when the address was a compile-time
// constant, and every socket call has to tolerate that.
bool socketConfigured = false;

/* ================= MQ-2 CONFIG ============== */
#define RL_VALUE 10.0

/* ---- Clean-air baseline (Ro) — SELF-CALIBRATING, stored in flash -------------
 * Ro is what the sensor reads in CLEAN air. It differs per sensor AND per location
 * (temperature, humidity, altitude, sensor age), which is why it used to need a manual
 * edit + reflash every time the box moved.
 *
 * These are now MUTABLE fallbacks, used only until a baseline is loaded or measured:
 *   • boot  → loadRo() restores the stored baseline from NVS flash
 *   • none stored → calibrateRo() measures one after a settle period, and SAVES it
 *   • moved location → trigger the "calibrateGas" socket event; no reflash needed
 *
 * Deliberately NOT recalibrated on every boot. Ro means "clean air" — if the ESP32
 * rebooted during a gas event (brownout, power blip) it would record polluted air as
 * the baseline and then under-report smoke permanently. Stored once, reused after that.
 * ---------------------------------------------------------------------------- */
/* One baseline PER SENSOR. Ro is a property of the individual sensor AND of the air it
   sits in, so four sensors spread around a room have four genuinely different values —
   sharing one would mis-scale three of them. Stored under NVS keys ro1..ro4. */
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

// The heater must settle before Ro means anything. 20s (WARMUP_DURATION) is fine for
// readings against a KNOWN baseline, but not for establishing one.
// NOTE: a brand-new MQ-2 also wants a 24–48 h burn-in per the datasheet. That is a
// one-off per sensor and no amount of firmware delay substitutes for it.
#define CAL_SETTLE_MS 180000UL   // 3 min settle before measuring a first baseline

#define ADC_MAX 4095.0
#define ADC_VREF 3.3
#define MQ2_VCC 5.0
#define DIVIDER_RATIO 0.6667
#define SMOKE_A 30000.0
#define SMOKE_B -2.95

/* ================= THRESHOLDS =============== */
// Runtime-configurable from the dashboard's Alert Rules page — the backend pushes
// these live via the "envConfig" socket event (room-level alert_rules), so an admin
// can retune the LED/buzzer/status bands WITHOUT reflashing. The values below are
// only the fallback defaults used until the first envConfig arrives. The status
// calculators, RGB LED and buzzer all derive from these, so the device's alarms stay
// in sync with the dashboard's alerts.
//   NOTE: one WARNING + one CRITICAL bound per metric, matching alert_rules exactly —
//   every threshold here is set from the rule of the same name (gasWarn/gasCrit/…), so
//   the name says which rule fills it. There used to be a third, middle "DANGER" band;
//   it was neutralised at runtime (TEMP_DANGER = TEMP_CRITICAL) rather than removed,
//   which left the device reporting a band the dashboard had no severity for.
//   TEMP_COLD has no alert_rules equivalent, so it keeps this default (LED "too cold").
//   IR/AC comfort zones (getIRZone) are a separate concept and are NOT driven here.
float WARNING_PPM   = 150.0;
float CRITICAL_PPM  = 300.0;
float TEMP_COLD     = 22.0;
float TEMP_WARNING  = 29.0;
float TEMP_CRITICAL = 32.0;
float HUM_WARNING   = 85.0;
float HUM_CRITICAL  = 95.0;

/* ================= IR ZONES ================= */
// Zone IDs for change detection
#define IR_ZONE_NONE -1
#define IR_ZONE_TOO_COLD 0    // < 22°C  → 28°C Auto
#define IR_ZONE_NORMAL 1      // 22–24°C → 26°C Auto
#define IR_ZONE_ACCEPTABLE 2  // 25–27°C → 24°C Auto
#define IR_ZONE_NEAR_CRIT 3   // 28–29°C → 22°C High
#define IR_ZONE_CRITICAL 4    // > 29°C  → 20°C High

// Auto-cooling zone BOUNDARIES (°C) — mutable so the dashboard's Aircon threshold config
// can retune WHEN IR fires, pushed via the "acConfig" socket event (no reflash). The
// target temp per zone is fixed (tied to the captured IR codes below); only these
// boundaries change. Must stay ascending. Defaults match the original hardcoded zones.
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

/* The last row actually WRITTEN to the card - the deadband baseline. Kept separately
   from anything the live path uses: what matters here is how far the room has moved
   since the last row that made it onto the card, not since the last reading. */
bool sdHaveLast = false;
unsigned long sdLastAt = 0;
float sdLastTemp = 0, sdLastHum = 0;
float sdLastPpm[MAX_MQ2_SENSORS] = { 0, 0, 0, 0 };
String sdLastSmoke = "", sdLastTempSt = "", sdLastEnvSt = "";
#endif

/* MQ-2 clean-air baseline persistence + deferred calibration. Scheduling rather than
 * calibrating inline keeps loop() non-blocking — a 3-minute settle must not stall
 * sensor reads, the socket, or the IR loop. */
Preferences prefs;
#define NVS_NAMESPACE "mq2cal"

/* The network configuration gets its OWN namespace. A WiFi reset has to be able to clear
   the credentials without touching the MQ-2 clean-air baseline: Ro is measured once per
   location over three minutes of genuinely clean air, and losing it because somebody
   retyped a WiFi password would silently blind the smoke detector until the next
   calibration. Separate namespaces make that impossible rather than unlikely. */
#define NVS_NET_NAMESPACE "netcfg"
bool pendingCalibration = false;
unsigned long calibrationDueAt = 0;

/* ─────────────────────────────────────────────────────────────
 *  CAPTURED RAW IR DATA  (Carrier remote, 38 kHz)
 *  Captured 2026-07-31 with IRLearner.ino. Protocol decodes as
 *  UNKNOWN, so these are replayed verbatim with sendRaw() — there
 *  is no library encoder for this remote.
 *
 *  Each array is 131 values: leader pair + 64 bit-pairs + stop mark.
 *  If you ever recapture, verify the length is EXACTLY 131 before
 *  pasting — a different count means the capture was corrupted by
 *  ambient IR, and the frame will not decode to 64 bits.
 * ─────────────────────────────────────────────────────────────*/
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
// Replaces the mock NEC data that stood here through two failed captures, both killed by
// ambient light rather than the remote or the sketch:
//   2026-07-31 — 133 values / 65 bits. Ambient-IR glitches inserted extra edges.
//   2026-08-01 — 223 values, every one 7000-9500us, alternating ~7700/~9000. That pair
//                sums to ~16.7ms = 60Hz, i.e. mains frequency: an LED/fluorescent lamp
//                was saturating the receiver and the remote's frame never got through.
// Kept here because it is the failure mode any RE-capture will hit: lights OFF, away from
// sunlight and screens, remote 3-10cm and pointed at the receiver. If IRLearner prints
// anything while you are NOT pressing a button, the environment is still too noisy.
//
// This capture verifies clean: exactly 131 values, 8950/4500 leader, decodes to exactly
// 64 bits, marks 450-550us, and the two space populations are 600-650 (zero) vs
// 1750-1800 (one) — an 1100us gap, so no bit is a judgement call. Header bits 0-9 and the
// all-zero bits 16-39 match the other four temperature frames, and it obeys the
// structural invariant every verified frame obeys (bits 61-63 are the exact complement of
// bits 53-55). Nothing here looks like contamination.
//
// What the data CANNOT confirm is that this is the right BUTTON. Bits 53-55 differ
// between this frame (010) and 22C_HIGH (000); if that field were purely fan speed the
// two High-fan frames would agree. It may not be fan (POWER ON/OFF carry 001 there and
// have no fan meaning, and no checksum scheme fits all six frames), but the only
// conclusive test is the unit itself: drive the CRITICAL zone and confirm the AC's own
// display reads 20°C with the fan on High. If it shows a different fan speed, recapture
// with the remote set to Cool / 20°C / fan HIGH and check bits 53-55 move to 000.
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
/* One place decides what the LED shows once the box is sensing, so the precedence is visible
   rather than spread across call sites: the ROOM always wins, and the offline blink only gets
   the gaps.

   `reporting` is deliberately "the socket is up", not "WiFi is up" — the question the blink
   answers is whether readings are actually reaching the dashboard, and a box associated to an
   access point that cannot route to the backend is just as blind as one with no WiFi at all.

   Stateless on purpose: setStatusColor() already runs on every loop tick, so the tick after the
   pulse window repaints the real colour by itself. Nothing to restore, nothing to get stuck on
   if a reading is ever missed. (millis() rollover at 49 days costs one mistimed pulse.) */
void paintStatusLED(unsigned long now_ms, bool reporting,
                    const String& envStatus, const String& tempStatus, const String& smokeStatus) {
  bool quiet = envStatus == "NORMAL" && tempStatus != "CRITICAL" && smokeStatus != "CRITICAL";
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
// All three report the SAME three-band vocabulary as alert_rules: NORMAL / WARNING /
// CRITICAL. temp adds TOO_COLD, which is not a severity but a separate axis (there is no
// alert_rules equivalent — see TEMP_COLD).
/* The highest reading across the sensors that are actually fitted.
   MAX, never a mean: two sensors are only worth having if they are in DIFFERENT places,
   and the question is then "does any of them see smoke", not "how smoky is the room on
   average". Averaging four would let one sit in a fire while the other three dilute it
   below the threshold. Disabled channels are excluded, so an unwired floating pin cannot
   decide the room's status. */
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

// The worst band any one metric is in. A metric at its CRITICAL rule makes the room
// critical, whichever metric it is — previously temperature returned CRITICAL while gas
// and humidity returned DANGER, which ranked a smoke event BELOW a hot room.
String calcEnvironmentStatus(float t, float h) {
  float ppmMax = worstGasPpm();
  if (t >= TEMP_CRITICAL || ppmMax >= CRITICAL_PPM || h >= HUM_CRITICAL) return "CRITICAL";
  if (t >= TEMP_WARNING || ppmMax >= WARNING_PPM || h >= HUM_WARNING
      || t < TEMP_COLD) return "WARNING";
  return "NORMAL";
}

/* ─────────────────────────────────────────────
 *  IR ZONE HELPER
 *  Returns zone ID based on temperature.
 * ─────────────────────────────────────────────*/
int getIRZone(float t) {
  if (t <  IR_TEMP_COLD_BELOW)   return IR_ZONE_TOO_COLD;
  if (t <= IR_TEMP_NORMAL_MAX)   return IR_ZONE_NORMAL;
  if (t <= IR_TEMP_ACCEPT_MAX)   return IR_ZONE_ACCEPTABLE;
  if (t <= IR_TEMP_NEARCRIT_MAX) return IR_ZONE_NEAR_CRIT;
  return IR_ZONE_CRITICAL;
}

/* ─────────────────────────────────────────────
 *  SEND IR TO BOTH AC UNITS
 *  Only fires when zone changes.
 * ─────────────────────────────────────────────*/
/* Map an IR zone → its captured raw code. Shared by handleIR (auto, all enabled
 * channels) and the "irCommand" on-handler (re-sync one unit that was switched back
 * on). Returns false when the zone has no code (IR_ZONE_NONE). */
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
      // Still mock data — firing it would transmit a meaningless waveform. Refuse, so
      // the unit holds the NEAR_CRIT setting (22°C High) instead. Flip
      // IR_20C_HIGH_CAPTURED to 1 once a clean 131-value capture is pasted above.
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

/* ─────────────────────────────────────────────
 *  RTC — get timestamp string
 * ─────────────────────────────────────────────*/
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

/* =============================================
 *  SD CARD - offline buffer
 *
 *  Only ever touched while the socket is DOWN (append) or has just come
 *  back (replay), so it never competes with the live send path.
 * =============================================*/
#if SD_ENABLED

/* getTimestamp() falls back to "UP HH:MM:SS" when neither the RTC nor NTP can say
   what time it is. That string is not a date, and the backend refuses it - so a row
   carrying one could never be backfilled and would only wear the card out. Buffering
   is therefore gated on having a REAL clock, which during an outage means the DS3231
   and its coin cell: WiFi is down, so there is no NTP to fall back to. */
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

  /* A log left over from before a reboot is still worth sending: the rows in it ARE
     the outage. Marking it dirty here is what makes the buffer survive a power cut,
     which is the failure this whole feature exists for. */
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
  // ⚠️ ppm3/ppm4 are APPENDED AFTER heat_index, not inserted next to ppm1/ppm2. A card can
  // hold rows written by the previous firmware, and a mid-row insertion would silently
  // re-interpret every one of them — smoke_status read as a number, heat index read as a
  // status. Extra trailing columns are simply absent in an old row, which the replay parser
  // treats as "not reported" rather than as a parse failure.
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
  // 9 fields is a row from the two-sensor firmware; 11 adds ppm3/ppm4 on the end. Both are
  // accepted for as long as a card can still be holding the older shape — which is until
  // every box has been reflashed AND replayed, not until this code ships.
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

  /* The link went away again mid-replay. KEEP the file: the tail has not been sent.
     Re-sending the head on the next attempt is harmless - InfluxDB overwrites a point
     with the same measurement, tag set and timestamp, so a replayed row is idempotent.
     That property is also why no read offset is persisted across reboots. */
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

/* ─────────────────────────────────────────────
 *  BUZZER PATTERN HANDLER (unchanged logic)
 * ─────────────────────────────────────────────*/
void handleBuzzer(const String& smokeStatus, const String& tempStatus,
                  const String& envStatus, unsigned long now_ms) {
  // Ladder order is load-bearing: envStatus is CRITICAL whenever gas or temperature is,
  // so the two specific conditions must be tested before the aggregate or every critical
  // reading would collapse to priority 3.
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

/* ─────────────────────────────────────────────
 *  MQ-2 clean-air baseline (Ro) — persisted in NVS
 * ─────────────────────────────────────────────*/

// Restore a previously measured baseline. Returns false when nothing valid is stored,
// which is the signal to measure one (first boot, or first boot in a new location).
// Key per sensor: "ro1".."ro4". Adding a fifth would be a new key, not a migration —
// the old ones keep their meaning, which is why this is indexed rather than packed.
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

  // Only the sensors that are FITTED have to have a stored baseline. A channel nobody has
  // wired yet has no clean-air reading to have taken, and demanding one would make every
  // box with a spare slot look permanently uncalibrated — and re-run a 3-minute
  // calibration on every boot.
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

// Measure the clean-air baseline and STORE it. Only meaningful when the air is actually
// clean — a bad result is rejected rather than written, so one dubious calibration can't
// silently blind the smoke detector.
bool calibrateRo() {
  const int samples = 50;
  float rsSum[MAX_MQ2_SENSORS] = { 0, 0, 0, 0 };
  for (int n = 0; n < samples; n++) {
    for (int i = 0; i < MAX_MQ2_SENSORS; i++) {
      if (gasEnabled[i]) rsSum[i] += adcToRs(analogRead(MQ2_PINS[i]));
    }
    delay(50);
  }

  // ⚠️ ALL-OR-NOTHING across the fitted sensors. Storing the ones that passed and leaving
  // the rest on a fallback would give a box a silently mixed baseline — some sensors
  // scaled to this room, some to a factory guess — and there would be nothing on screen
  // to say which. A rejection is loud and keeps every previous value; a partial success
  // is quiet and keeps neither.
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

/* Report the outcome back to the dashboard. Without this the Recalibrate button would be
 * fire-and-forget — you'd have no way to know whether the new baseline was accepted, or
 * silently rejected for being out of range. Payload: ["gasCalibrated", {ok, ro1, ro2}] */
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

/* ─────────────────────────────────────────────
 *  SEND irFired EVENT
 * ─────────────────────────────────────────────*/
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

/* ─────────────────────────────────────────────
 *  SEND CHANNEL MAP TO SERVER
 *  Fires on every socket connect so the server
 *  always knows which GPIO each channel uses.
 *  Payload: ["irChannelMap", {channels:[{channel,gpio}, ...]}]
 * ─────────────────────────────────────────────*/
/* Which ADC pin each gas channel is on. The DEVICE is the only thing that knows this, so it
   reports it rather than the dashboard keeping a second copy that can go stale the moment
   MQ2_PINS[] changes. Exactly what sendChannelMap() does for the IR pool, and it exists for
   the same reason: a staff member wiring sensor 3 needs to be told WHICH PIN, on screen,
   without opening the sketch. */
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

          // Re-sync a unit that was just switched back ON. Auto IR fires only on a
          // ZONE CHANGE, and a unit that was off at that moment is skipped entirely
          // (its channel is disabled) — so without this it keeps whatever setting it
          // had before, possibly for hours, until the room crosses into another zone.
          // Power-on only carries IR_POWER_ON, so follow it with the current zone's code.
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

      /* Which ADC pins actually have a sensor on them. Mirrors "irConfig" deliberately —
         one boolean per channel, 1-based in the DB, 0-based here — so this is the same
         parse the firmware already does rather than a second shape to keep in step.

         ⚠️ Disabling a channel ZEROES it immediately. Leaving the last reading in gasPpm[]
         would let a stale number keep feeding worstGasPpm() forever, so a sensor that was
         reading 400 ppm when it was unplugged would hold the room in alarm with nothing
         attached. */
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

      // Configurable alarm thresholds from the dashboard (Alert Rules → room-level
      // rules). Only present fields are applied, so unset metrics keep their default.
      // One rule → one threshold, no derived bands.
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

      // Auto-cooling IR zone boundaries from the dashboard (Aircon thresholds). Target
      // temps per zone stay fixed (captured IR codes); only the boundaries change here.
      // Re-measure the MQ-2 clean-air baseline on demand — this is what replaces
      // editing RO_CLEAN_AIR_* and reflashing when the box moves to a new room.
      // A short settle is enough here: the heater has been running since boot.
      // The air MUST be clean when this is triggered.
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

/* ─────────────────────────────────────────────
 *  Network provisioning — WiFi + backend address, stored in NVS
 *
 *  Everything here runs in setup() and NOWHERE ELSE. The portal blocks, and blocking is
 *  only ever acceptable at boot: there is nothing to monitor yet and no backend to reach.
 *  A WiFi drop at RUNTIME is handled by the non-blocking retry at the top of loop() — see
 *  the note there for why it has to stay that way.
 * ─────────────────────────────────────────────*/

// A value nobody ever set. Covers both an absent secrets.h define (the #ifndef "" fallbacks)
// and the placeholders secrets.h.example used to ship, which are the real trap: they LOOK
// configured, so a fresh box would spend every boot failing to join a network called
// YOUR_WIFI_SSID instead of asking somebody what the network is.
bool netUnset(const String& v) {
  return v.length() == 0 || v.startsWith("YOUR_");
}

// Restore a provisioned configuration. Returns false when nothing usable is stored, which
// is the signal to fall back to the secrets.h defaults — and, if those are empty too, to
// open the portal.
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
   handshake: the question here is "did somebody type the right IP", and a refused or timed
   out connection is the only part of that a phone in a server room can act on. */
bool backendReachable() {
  if (netUnset(netHost) || WiFi.status() != WL_CONNECTED) return false;
  WiFiClient probe;
  bool ok = probe.connect(netHost.c_str(), netPort, BACKEND_PROBE_MS) == 1;
  probe.stop();
  return ok;
}

/* The status block the portal shows — the client asked for one, and it is the only way to
   tell a mistyped backend IP from a working install without a laptop. Rendered as a custom
   WiFiManagerParameter so it sits at the top of the form the installer is already on,
   rather than behind another tap. ⚠️ WiFiManagerParameter STORES THE POINTER it is given,
   so this buffer is a global and must outlive the portal — building it in a local String
   would hand the form a dangling pointer. */
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

/* Watch GPIO 0 for a few seconds so an installed box can be re-provisioned with no laptop
   and no Arduino IDE. Deliberately a WINDOW AFTER boot rather than a level at reset:
   GPIO 0 is a strapping pin, so "hold BOOT while powering on" — the obvious gesture, and
   the one the plan originally called for — puts the ROM into serial download mode and this
   sketch never runs at all. The LED turning magenta is the cue to press. */
bool portalButtonPressed() {
  pinMode(PORTAL_BUTTON_PIN, INPUT_PULLUP);
  setRGB(60, 0, 60);   // magenta = press BOOT now to change the WiFi
  Serial.printf("[NET] Press BOOT within %lus to re-run WiFi setup",
                (unsigned long)(PORTAL_BUTTON_WINDOW_MS / 1000));
  unsigned long start = millis();
  bool pressed = false;
  while (millis() - start < PORTAL_BUTTON_WINDOW_MS) {
    if (digitalRead(PORTAL_BUTTON_PIN) == LOW) { pressed = true; break; }
    delay(10);
  }
  Serial.println(pressed ? " — PRESSED." : " — no.");
  if (pressed) {
    /* Confirm the press, then HOLD magenta all the way into the portal. Dropping back to the
       boot blue here meant "pressed" and "not pressed" looked identical for the ten seconds the
       box then spends joining the saved network — and the only way to find out which had
       happened was to wait and see whether an access point appeared. Somebody standing at a
       rack with a phone will press it again in that gap, which reboots the box and starts the
       whole thing over. */
    setRGB(0, 255, 0);   // green blip — the button registered
    delay(250);
    setRGB(60, 0, 60);   // and stay magenta until the setup page is up
  } else {
    setRGB(0, 0, 50);    // back to the boot blue
  }
  return pressed;
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

/* WiFiManager answers /wifisave with a FIXED string — "Saving Credentials. Trying to connect
   ESP to network. If it fails reconnect to AP to try again" — and only THEN attempts the join,
   back in the portal loop. So the page the installer is left looking at cannot contain the
   result: it was written before the result existed. The verdict does get rendered, by
   reportStatus(), but only on /, /wifi, /param and /info, and on every one of those it is
   appended LAST — off the bottom of a phone screen, on a page you have to navigate back to.

   Net effect: typing the WiFi password wrong looks exactly like typing it right. For a feature
   whose entire purpose is that a staff member can set this up alone, that is the failure.

   So: a script in the page head (setCustomHeadElement) notices it is on /wifisave, counts the
   connect attempt down, and then sends the browser to /sensorstate — a page of ours, served off
   WiFiManager's own web server, that says in full what happened and what to do about it. The
   div it adds also CONTAINS a link to /sensorstate, so a browser that ignores the timer still
   leaves a way through; a captive-portal mini-browser is not a browser you get to assume much
   about. Nothing here modifies the library. */
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
  /* Not the save page: the only job here is the SSID box. WiFiManager fills its placeholder
     with WiFi_SSID() — the network the box is CURRENTLY on — so the setup form was showing a
     staff member the name of whatever WiFi it was last joined to. Nobody asked for that to be
     published on an open access point, and on a form whose whole purpose is to pick a
     DIFFERENT network it is misleading as well. Rewritten here rather than in the library so a
     Library Manager update cannot quietly bring it back. */
  "if(!W){var e=document.getElementById('s');if(e)e.placeholder='SSID name';return;}"
  "d=document.createElement('div');"
  "d.id='cspcw';document.body.appendChild(d);t();});"
  "})();</script>";

/* Set by the /sensorstate handler once it has served a FINISHED verdict to the page. It is
   what lets the confirmation window below close as soon as the phone has actually read the
   result, instead of always burning the full timeout. */
bool portalResultSeen = false;
/* Distinct from the above: somebody has fetched the verdict at all, whatever it said. It is
   what separates "the installer is standing here reading a problem" from "this box was
   powered on in an empty room", and only the first earns the long window. */
bool portalClientSeen = false;

/* What actually happened, in words.

   Two shapes from one builder. `fragment` returns just the panel, for the script above to drop
   into the /wifisave page the installer is already looking at — asked for explicitly, because
   even an automatic redirect is a page change, and a page that changes under you while you are
   reading it is its own kind of confusing. The full page is what /sensorstate serves on its own,
   which is the recovery path when the phone loses the AP mid-attempt and the script cannot.

   A fragment is prefixed with one character, P (pending) or D (done), so the script knows
   whether to poll again without parsing anything. */
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
    // 7 is WiFiManager's own WL_STATION_WRONG_PASSWORD kludge. The value is repeated rather
    // than referenced because the member is protected — and the ESP32 SDK has no
    // wrong-password status of its own, which is why the library invents one.
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

  /* The LED follows the verdict, in the same colours as the panel above. It is set HERE, in
     what is otherwise a page builder, because this is the only code of ours that runs while
     WiFiManager's portal has the CPU — a failed join never returns control to runPortalRound(),
     it just loops inside the library. Without this the box shows portal-magenta whether the
     password was right or wrong.

     Safe to own the LED at this point and only at this point: sensing has not started, so
     nothing here can paint over a smoke or heat alarm. Once warmupDone is set, setStatusColor()
     is the only thing that touches it — see the note in loop(). */
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

/* Take the backend address out of the portal form. Called from the save callback — BEFORE the
   result page is built — because otherwise the success panel would report the address the box
   had when it booted rather than the one just typed into the form above it. Also called again
   after the portal returns; it is idempotent. */
void applyPortalParams(WiFiManagerParameter& pHost, WiFiManagerParameter& pPort) {
  String host = String(pHost.getValue());
  host.trim();
  if (!netUnset(host)) netHost = host;
  long p = String(pPort.getValue()).toInt();
  if (p >= 1 && p <= 65535) netPort = (uint16_t)p;   // junk keeps the previous port rather
                                                     // than storing 0 and never connecting
}

/* ⚠️ THE SUCCESS CASE IS THE ONE THAT NEEDED HELP, not the failure.

   On a FAILED join WiFiManager returns to its portal loop and keeps serving pages, so the
   result is there to be read. On a SUCCESSFUL one it calls shutdownConfigPortal() the instant
   the link comes up (`_disableConfigPortal` defaults true) — the soft AP disappears, the phone
   drops back to its own network or mobile data, and the page reporting success dies with the
   network it was served from. So the one outcome an installer most wants confirmed was the one
   they could never see.

   This runs from setSaveConfigCallback, which WiFiManager invokes on the success path BEFORE
   that shutdown, with WiFi up and the web server still alive. Pumping the server here keeps the
   page reachable for a few more seconds; returning hands WiFiManager back its normal teardown,
   so nothing here owns the AP's lifetime or has to take it down by hand.

   Deliberately NOT setDisableConfigPortal(false): that leaves the portal up with no one
   servicing it once startConfigPortal() returns, and makes tearing down the AP, the web server
   and the DNS socket this sketch's problem. */
void holdPortalForResult(WiFiManager& wm) {
  portalResultSeen = false;
  portalClientSeen = false;
  Serial.println("[NET] Connected — holding the setup page open so the result can be read.");

  unsigned long start = millis();
  unsigned long limit = PORTAL_CONFIRM_MS;
  while (millis() - start < limit && !portalResultSeen) {
    wm.server->handleClient();
    /* Somebody is on the page. If they are reading a good result they will have released the
       loop already, so reaching here means they are looking at a problem — give them room to
       fix it in place. Correcting a backend IP after the AP has gone means rejoining the AP
       from a phone that has already fallen back to its own network, which is the difference
       between a 10-second fix and a support call. */
    if (portalClientSeen) limit = PORTAL_FIX_MS;
    delay(5);
  }

  if (portalResultSeen)      Serial.println("[NET] Result read — closing the setup page.");
  else if (portalClientSeen) Serial.println("[NET] Setup page still showing a problem when the "
                                            "window expired — closing it.");
  else                       Serial.println("[NET] Nobody read the result — closing the setup page.");
}

/* Three outcomes, not two. "Closed without saving, and the old network is still up" has to
   be distinguishable from "saved a new one", or an installer who deliberately dismisses the
   portal gets shown it again on the next round.

   #define rather than an enum on purpose: the Arduino builder auto-generates a prototype
   for every function and inserts them ABOVE the sketch body, so a return type declared
   here would not exist yet at the prototype -- "'PortalResult' does not name a type", on a
   file that is perfectly valid C++. */
#define PORTAL_OFFLINE   0
#define PORTAL_SAVED     1
#define PORTAL_UNCHANGED 2

/* ONE round of the portal. Reached only at boot, and only when the box has no usable
   configuration or somebody asked for it with the BOOT button. WiFiManager is local so the
   web server and the DNS server it owns are freed the moment the portal closes. */
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
  // Injected into the head of EVERY portal page; the script itself does nothing unless it is
  // on /wifisave. A string literal has static storage, which matters — setCustomHeadElement
  // keeps the pointer rather than copying.
  wm.setCustomHeadElement(PORTAL_HEAD_SCRIPT);
  // Fires after the web server is created and BEFORE the library's own routes go on, so this
  // adds a path rather than shadowing one. `wm` outlives the server it owns, so capturing it
  // by reference here is safe for as long as the handler can be called.
  wm.setWebServerCallback([&wm, &pHost, &pPort]() {
    wm.server->on("/sensorstate", [&wm, &pHost, &pPort]() {
      // ?raw=1 -> just the panel, for the in-page update on /wifisave. No arg -> the full page,
      // which is what a human typing the address gets.
      bool raw = wm.server->hasArg("raw");
      /* Re-read the form every time rather than trusting what was parsed at save. During the
         hold window the installer can correct the Backend IP and save again, and the probe
         below has to aim at what the form says NOW or the page would keep reporting the old
         address as unreachable after they had already fixed it. */
      applyPortalParams(pHost, pPort);
      String body = sensorStatePage(wm, raw);
      wm.server->send(200, raw ? "text/plain" : "text/html", body);
      if (raw && body.length()) {
        portalClientSeen = true;
        // ONLY an all-clear releases the hold. 'F' is settled too, but it is settled ON A
        // PROBLEM — letting go there would take the access point away at the exact moment
        // the installer needs it to fix the address.
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
  /* How long one join attempt from inside the portal is given. 10 s is comfortably past a
     normal association + DHCP (2-5 s) and it is what the /wifisave countdown is sized from —
     ⚠️ raise one and raise the other, or the result page loads while the attempt is still
     running and reports "Still trying…" instead of the answer. A wrong password usually fails
     well before the timeout anyway; this bounds the case where the AP simply never replies. */
  wm.setConnectTimeout(PORTAL_CONNECT_TIMEOUT_S);
  wm.setRemoveDuplicateAPs(true);
  // "info" is the built-in page — SSID, IP, signal, MAC, free heap. Together with the
  // banner above it is the status page the client asked for, at no flash cost.
  const char* menu[] = { "wifi", "info", "sep", "restart", "exit" };
  wm.setMenu(menu, 5);

  String apName = portalApName();
  const char* apPass = (strlen(AP_PASSWORD) >= 8) ? AP_PASSWORD : NULL;  // NULL = open AP
  // Two different things happen below, so the log says which. The autoConnect path may join
  // a stored network and never raise an AP at all, and a line promising a portal that then
  // does not appear is the kind of thing somebody debugs for an hour.
  if (forceOpen) {
    Serial.printf("[NET] Setup portal opening — join WiFi \"%s\" %s; the page opens itself.\n",
                  apName.c_str(), apPass ? "(password is on the enclosure)" : "(no password)");
  } else {
    Serial.printf("[NET] Trying any stored credentials; failing that, the setup portal opens "
                  "as \"%s\" %s.\n",
                  apName.c_str(), apPass ? "(password on the enclosure)" : "(no password)");
  }
  setRGB(60, 0, 60);

  /* forceOpen -> startConfigPortal, which ALWAYS shows the form; autoConnect would try the
     stored credentials first and, on a box whose WiFi still works, silently connect and
     never show anybody anything — which is not what pressing BOOT asked for.

     ⚠️ Nothing is erased on the way in. An earlier cut wiped the credentials before opening
     the forced portal, so an admin who pressed BOOT and then got called away left a box that
     was offline until the next power cycle: the portal timed out with nothing to fall back
     to. The old configuration is only ever REPLACED, after a new one is proven to associate. */
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

/* Provision, then CHECK. A portal that only collects an address cannot tell a typo from a
   working install — both end with the box joined to WiFi and the LED green. So each round
   is followed by a TCP probe of the address just entered, and a failure re-opens the portal
   with the reason on the form. Bounded by PORTAL_BACKEND_ROUNDS, because "the server is off
   right now" is a legitimate answer and must not trap an installer in a loop. */
bool runProvisioningPortal(bool forced) {
  bool probed = false, backendOk = false;

  /* If the radio is already up — a BOOT-forced portal on a box that still works — probe
     BEFORE showing the form, so the first thing the admin sees is a verdict on the address
     already stored rather than a blank panel. Diagnosing a wrong backend IP without a laptop
     is the whole point of the status page, and it cannot say anything useful about an
     address it has not tried. */
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
      // Dismissed on purpose. Re-opening it would be arguing with the person holding the box.
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

  /* The join runs even when BOOT was pressed. It costs up to WIFI_JOIN_TIMEOUT_MS on a
     gesture somebody is standing there having made, and it buys the portal a status panel
     that can actually answer "is the backend reachable from here" — see runProvisioningPortal. */
  bool joined = configured && joinWiFi(WIFI_JOIN_TIMEOUT_MS);

  if (joined && !forced)      return true;
  if (forced || !configured)  return runProvisioningPortal(forced);

  /* Configured, but that network was not there. NOT a reason to open the portal: this is
     the same condition as a runtime drop — an AP rebooting, a cable pulled, the box powered
     up before the switch — and the non-blocking retry in loop() already owns it. A
     three-minute AP here would mean a server room going unwatched for three minutes every
     time the WiFi happens to be down at boot. */
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

  /* micro SD - before WiFi on purpose. If the access point is down at boot, the very
     first readings are already offline ones, and the buffer has to exist to catch them. */
  sdInit();

  /* WiFi — PROVISIONED, not compiled in: NVS first, secrets.h as the fallback, and the
     captive portal when there is neither. This is the one place allowed to block, and
     setupNetwork() is the one place that may ever open the portal. */
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
    } else {
      Serial.println("\n[NTP] Sync failed — will retry from getTimestamp().");
    }
  } else {
    Serial.println("[WiFi] Offline mode — readings buffer to the SD card until the link is back.");
  }

  /* Socket.IO — the device key travels in an HTTP HEADER on the WebSocket upgrade,
     not in the URL. A query string is written verbatim into proxy and web-server
     access logs, so the shared secret ended up in every log line the handshake
     touched; a request header is not logged by default.
     (Socket.IO's `auth` payload would be the usual place, but that arrived in v3 and
     this client speaks EIO3 — a header is the equivalent here. The backend reads
     auth → x-device-key → query, in that order; see backend/src/server.js.)
     `static` because setExtraHeaders keeps the buffer, which must outlive setup(). */
  static char deviceKeyHeader[128];
  snprintf(deviceKeyHeader, sizeof(deviceKeyHeader), "X-Device-Key: %s", deviceSecret);
  socketIO.setExtraHeaders(deviceKeyHeader);
  /* The address comes from NVS. It can legitimately be EMPTY — a blank box whose portal
     timed out with nobody around — and begin()-ing on an empty host would leave the client
     retrying a nameless address every 5s forever. Left un-begun instead, which the guard in
     loop() reads as "no backend configured": the room is still sensed, alarmed and buffered
     to the SD card, and the next boot's portal is what fixes it. */
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

  /* MQ-2 clean-air baseline: reuse the stored one, or schedule a first calibration.
     Deliberately NOT recalibrated every boot — see the note at RO_MIN_VALID. */
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

  bool wifiNow = (WiFi.status() == WL_CONNECTED);

  /* ── WiFi keep-alive ──
     WiFi.begin() used to run ONCE, in setup(), inside a 10-second window. If the
     access point was not up yet at boot — a phone hotspot switched on after the
     ESP32, say — or if it dropped later, the box stayed offline until somebody
     pressed RESET: every reading logged as offline while Socket.IO kept retrying a
     network the radio was not even on, which reads as a BACKEND fault when it is a
     WiFi one. Retry on a slow timer instead. Sits BEFORE the warmup early-return so
     it runs from the first tick, and is non-blocking, so the sensor / LED / buzzer /
     IR cadence is unaffected while the radio re-associates. */
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
  /* ⚠️ A retry, never the setup portal. WiFiManager's portal BLOCKS, and this is the
     runtime path: an AP reboot or a pulled cable would stop the sensor reads, the buzzer
     and the IR for as long as it stayed open. During a fire that is the failure mode that
     matters, so re-provisioning is a boot-time act only — the BOOT button, see
     portalButtonPressed(). The SSID guard covers the blank box whose portal timed out;
     WiFi.begin("") is not a thing worth doing every 15 seconds. */
  if (!wifiNow && !netUnset(netSsid) && (now_ms - lastWifiRetry) >= WIFI_RETRY_MS) {
    lastWifiRetry = now_ms;
    Serial.print("[WiFi] Down — retrying SSID: ");
    Serial.println(netSsid);
    WiFi.disconnect();
    WiFi.begin(netSsid.c_str(), netPass.c_str());
  }

  /* ── SD backfill ──
     Sits ahead of the warmup early-return: rows buffered before a reboot are already
     complete and have nothing to do with this boot's MQ-2 heater settling. Both calls
     are no-ops in the common case (nothing buffered, or not connected). */
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

  /* ── Deferred clean-air calibration ──
     Runs once its settle window elapses, without blocking the loop. Triggered either by
     a first boot with no stored baseline, or on demand via the "calibrateGas" event. */
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
        // The legacy pair is STILL SENT. A backend that has not been updated reads only
        // these, and a monitoring system must not go blind during its own upgrade — same
        // reasoning as the deprecated deviceKey query fallback in the handshake. Drop them
        // once every backend is current.
        p["mq2_1_ppm"] = round(ppm1 * 10) / 10.0;
        p["mq2_2_ppm"] = round(ppm2 * 10) / 10.0;
        // The canonical form: one entry per channel, index+1 = channel. Sent for EVERY slot
        // in the pool so index and channel can never drift; the backend drops the ones no
        // admin has confirmed are wired.
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
