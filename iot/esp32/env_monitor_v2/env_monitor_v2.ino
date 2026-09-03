/*
 * ============================================================
 *  ESP32 Environment & Smoke Monitoring System v2
 *  Components: 2x MQ-2, DHT11, Piezo Buzzer, WS2812B RGB LED,
 *              RTC (DS3231), micro SD (SPI), 2x IR Transmitter
 *  
 *  ─── PIN ASSIGNMENTS ────────────────────────────────────────
 *  MQ-2 #1 AOUT  : GPIO 34  (ADC, via 10kΩ/20kΩ divider)
 *  MQ-2 #2 AOUT  : GPIO 35  (ADC, via 10kΩ/20kΩ divider)
 *  DHT11         : GPIO  4
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
 * ─────────────────────────────────────────────────────────── */

#include <DHT.h>
#include <WiFi.h>
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
#define MQ2_PIN_1  34
#define MQ2_PIN_2  35
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
#define DHTTYPE DHT11

/* =================== RGB LED ================ */
#define NUM_PIXELS 140

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
/* Values come from secrets.h, which is gitignored — copy secrets.h.example to
   secrets.h and fill it in. They used to be literals here, which put a real WiFi
   password and the real DEVICE_SECRET into every clone of the repository. */
const char* ssid = WIFI_SSID;
const char* password = WIFI_PASSWORD;

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
const char* host = BACKEND_HOST;
const uint16_t port = BACKEND_PORT;
// Must match DEVICE_SECRET in backend/.env
const char* deviceSecret = DEVICE_SECRET;

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
float roClean1 = 9.15;   // fallback until calibrated
float roClean2 = 7.28;

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
float sdLastTemp = 0, sdLastHum = 0, sdLastPpm1 = 0, sdLastPpm2 = 0;
String sdLastSmoke = "", sdLastTempSt = "", sdLastEnvSt = "";
#endif

/* MQ-2 clean-air baseline persistence + deferred calibration. Scheduling rather than
 * calibrating inline keeps loop() non-blocking — a 3-minute settle must not stall
 * sensor reads, the socket, or the IR loop. */
Preferences prefs;
#define NVS_NAMESPACE "mq2cal"
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
String calcSmokeStatus(float ppm1, float ppm2) {
  float ppmMax = max(ppm1, ppm2);
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
String calcEnvironmentStatus(float ppm1, float ppm2, float t, float h) {
  float ppmMax = max(ppm1, ppm2);
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
bool sdShouldBuffer(unsigned long now_ms, float temp, float hum, float ppm1, float ppm2,
                    const String& smokeSt, const String& tempSt, const String& envSt) {
  if (!sdHaveLast) return true;                                   // first row of the outage
  if (now_ms - sdLastAt >= SD_HEARTBEAT_MS) return true;          // heartbeat
  if (smokeSt != sdLastSmoke) return true;                        // band transitions -
  if (tempSt  != sdLastTempSt) return true;                       // never smooth one away
  if (envSt   != sdLastEnvSt) return true;
  if (fabs(ppm1 - sdLastPpm1) >= SD_DEADBAND_GAS) return true;    // per sensor, not the max
  if (fabs(ppm2 - sdLastPpm2) >= SD_DEADBAND_GAS) return true;
  if (fabs(temp - sdLastTemp) >= SD_DEADBAND_TEMP) return true;
  if (fabs(hum  - sdLastHum)  >= SD_DEADBAND_HUM) return true;
  return false;
}

void sdAppendRow(const String& ts, float temp, float hum, float ppm1, float ppm2,
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

  if (!sdShouldBuffer(now_ms, temp, hum, ppm1, ppm2, smokeSt, tempSt, envSt)) return;

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
  if (f.size() == 0) {
    f.println("timestamp,temperature,humidity,ppm1,ppm2,"
              "smoke_status,temp_status,env_status,heat_index");
  }
  f.printf("%s,%.1f,%.1f,%.1f,%.1f,%s,%s,%s,%.1f\n",
           ts.c_str(), temp, hum, ppm1, ppm2,
           smokeSt.c_str(), tempSt.c_str(), envSt.c_str(), heatIndex);
  f.close();

  sdHaveLast   = true;
  sdLastAt     = now_ms;
  sdLastTemp   = temp; sdLastHum = hum; sdLastPpm1 = ppm1; sdLastPpm2 = ppm2;
  sdLastSmoke  = smokeSt; sdLastTempSt = tempSt; sdLastEnvSt = envSt;
  sdLogDirty   = true;
  sdWarnedFull = false;

  Serial.println("[SD] Buffered (offline) " + ts);
}

/* One buffered CSV row -> one "offlineData" event. Field order must match the header
   written above. */
bool sdSendRow(const String& line) {
  String fields[9];
  int fi = 0, start = 0;
  for (int i = 0; i <= (int)line.length(); i++) {
    if (i == (int)line.length() || line.charAt(i) == ',') {
      if (fi < 9) fields[fi++] = line.substring(start, i);
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
  p["mq2_1_ppm"]          = fields[3].toFloat();
  p["mq2_2_ppm"]          = fields[4].toFloat();
  p["smoke_status"]       = fields[5];
  p["temp_status"]        = fields[6];
  p["environment_status"] = fields[7];
  p["heat_index"]         = fields[8].toFloat();

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
bool loadRo() {
  prefs.begin(NVS_NAMESPACE, true); // read-only
  float r1 = prefs.getFloat("ro1", 0.0f);
  float r2 = prefs.getFloat("ro2", 0.0f);
  prefs.end();

  bool ok = r1 >= RO_MIN_VALID && r1 <= RO_MAX_VALID &&
            r2 >= RO_MIN_VALID && r2 <= RO_MAX_VALID;
  if (!ok) {
    Serial.println("[CAL] No stored baseline — will calibrate once the sensor settles.");
    return false;
  }
  roClean1 = r1;
  roClean2 = r2;
  Serial.printf("[CAL] Loaded stored baseline: Ro1 %.2f kΩ  Ro2 %.2f kΩ\n", roClean1, roClean2);
  return true;
}

void saveRo() {
  prefs.begin(NVS_NAMESPACE, false); // read-write
  prefs.putFloat("ro1", roClean1);
  prefs.putFloat("ro2", roClean2);
  prefs.end();
  Serial.printf("[CAL] Baseline saved to flash: Ro1 %.2f kΩ  Ro2 %.2f kΩ\n", roClean1, roClean2);
}

// Measure the clean-air baseline and STORE it. Only meaningful when the air is actually
// clean — a bad result is rejected rather than written, so one dubious calibration can't
// silently blind the smoke detector.
bool calibrateRo() {
  const int samples = 50;
  float rsSum1 = 0, rsSum2 = 0;
  for (int i = 0; i < samples; i++) {
    rsSum1 += adcToRs(analogRead(MQ2_PIN_1));
    rsSum2 += adcToRs(analogRead(MQ2_PIN_2));
    delay(50);
  }
  float avgRs1 = rsSum1 / samples, ro1 = avgRs1 / MQ2_CLEAN_AIR_RATIO;
  float avgRs2 = rsSum2 / samples, ro2 = avgRs2 / MQ2_CLEAN_AIR_RATIO;

  bool ok1 = ro1 >= RO_MIN_VALID && ro1 <= RO_MAX_VALID;
  bool ok2 = ro2 >= RO_MIN_VALID && ro2 <= RO_MAX_VALID;
  if (!ok1 || !ok2) {
    Serial.printf("[CAL] REJECTED — Ro1 %.2f%s  Ro2 %.2f%s (valid %.1f–%.1f kΩ). "
                  "Check the wiring, or the air was not clean. Keeping the previous baseline.\n",
                  ro1, ok1 ? "" : " BAD", ro2, ok2 ? "" : " BAD",
                  (double)RO_MIN_VALID, (double)RO_MAX_VALID);
    return false;
  }

  Serial.printf("[CAL] Sensor 1 → Avg Rs %.2f kΩ  Ro %.2f kΩ\n", avgRs1, ro1);
  Serial.printf("[CAL] Sensor 2 → Avg Rs %.2f kΩ  Ro %.2f kΩ\n", avgRs2, ro2);
  roClean1 = ro1;
  roClean2 = ro2;
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

  /* DHT11 */
  dht.begin();
  Serial.println("[OK] DHT11 ready.");

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

  /* WiFi */
  Serial.print("[WiFi] Connecting");
  WiFi.mode(WIFI_STA);          // never leave a stale AP / AP+STA mode from NVS active
  WiFi.setAutoReconnect(true);  // let the SDK re-associate after a brief drop
  WiFi.begin(ssid, password);
  int wifiAttempts = 0;
  while (WiFi.status() != WL_CONNECTED && wifiAttempts < 20) {
    delay(500);
    Serial.print(".");
    wifiAttempts++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    wifiWasUp = true;
    Serial.print("\n[WiFi] IP: ");
    Serial.println(WiFi.localIP());

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
    Serial.println("\n[WiFi] Not connected — offline mode.");
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
  socketIO.begin(host, port, "/socket.io/?EIO=3&transport=websocket");
  socketIO.onEvent(socketIOEvent);
  socketIO.setReconnectInterval(5000);

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
  socketIO.loop();
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
  if (!wifiNow && (now_ms - lastWifiRetry) >= WIFI_RETRY_MS) {
    lastWifiRetry = now_ms;
    Serial.print("[WiFi] Down — retrying SSID: ");
    Serial.println(ssid);
    WiFi.disconnect();
    WiFi.begin(ssid, password);
  }

  /* ── SD backfill ──
     Sits ahead of the warmup early-return: rows buffered before a reboot are already
     complete and have nothing to do with this boot's MQ-2 heater settling. Both calls
     are no-ops in the common case (nothing buffered, or not connected). */
  if (sdPendingFlush() && wifiNow && socketIO.isConnected()) sdBeginFlush();
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
  int rawSmoke1 = analogRead(MQ2_PIN_1);
  int rawSmoke2 = analogRead(MQ2_PIN_2);
  float ppm1 = rsToPPM(adcToRs(rawSmoke1), roClean1);
  float ppm2 = rsToPPM(adcToRs(rawSmoke2), roClean2);
  String smokeStatus = calcSmokeStatus(ppm1, ppm2);

  /* ── Read DHT11 (every loop tick, cached internally) ── */
  float tempLive = dht.readTemperature();
  float humLive = dht.readHumidity();
  bool dhtLive = !isnan(tempLive) && !isnan(humLive);

  if (dhtLive) {
    lastTempStatus = calcTempStatus(tempLive);
    lastEnvStatus = calcEnvironmentStatus(ppm1, ppm2, tempLive, humLive);
  }

  /* ── Buzzer ── */
  handleBuzzer(smokeStatus, lastTempStatus, lastEnvStatus, now_ms);

  /* ── RGB LED ── */
  setStatusColor(lastEnvStatus, lastTempStatus, smokeStatus);

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
    Serial.printf("Smoke Status:       %s\n", smokeStatus.c_str());
    Serial.printf("Env Status:         %s\n", envStatus.c_str());
    if (dhtOk) {
      Serial.printf("Temperature:        %.1f °C\n", temperature);
      Serial.printf("Temp Status:        %s\n", tempStatus.c_str());
      Serial.printf("Humidity:           %.1f %%\n", humidity);
      Serial.printf("Heat Index:         %.1f °C (display only)\n", heatIndex);
    } else {
      Serial.println("[WARN] DHT11 read failed.");
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
        p["mq2_1_ppm"] = round(ppm1 * 10) / 10.0;
        p["mq2_2_ppm"] = round(ppm2 * 10) / 10.0;
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
        sdAppendRow(timestamp, temperature, humidity, ppm1, ppm2,
                    smokeStatus, tempStatus, envStatus, heatIndex, now_ms);
      }
    }
  }
}
