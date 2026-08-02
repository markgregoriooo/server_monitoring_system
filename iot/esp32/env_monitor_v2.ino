/*
 * ============================================================
 *  ESP32 Environment & Smoke Monitoring System v2
 *  Components: 2x MQ-2, DHT11, Piezo Buzzer, WS2812B RGB LED,
 *              RTC (DS3231), 2x IR Transmitter
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
 *  Orange = DANGER
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

/* =================== PINS =================== */
#define MQ2_PIN_1  34
#define MQ2_PIN_2  35
#define BUZZER_PIN 26
#define DHTPIN      4
#define RGB_PIN    27    // WS2812B data

/* =========== IR CHANNEL ARRAY ===============
 * Each index = ir_channel value stored in DB (0-based here).
 * TWO IR transmitters are physically wired: GPIO 25 (AC unit 1) and
 * GPIO 33 (AC unit 2). Channels 3-4 (GPIO 32/15) were declared here
 * but never populated in hardware, so the DB and dashboard could
 * accept a channel that could never actuate anything — removed.
 * To add a third unit: wire its IR TX to a free GPIO, append the pin
 * to IR_CHANNEL_PINS, bump MAX_IR_CHANNELS, add an IRsend entry to
 * irChannels[] below, and widen the ir_channel guard in
 * backend/routes/aircon.js to match.
 * enabledChannels[] is updated at runtime via "irConfig" socket event.
 * ============================================ */
#define MAX_IR_CHANNELS 2
const uint8_t IR_CHANNEL_PINS[MAX_IR_CHANNELS] = { 25, 33 };
bool enabledChannels[MAX_IR_CHANNELS] = { true, true };

/* =================== DHT ==================== */
#define DHTTYPE DHT11

/* =================== RGB LED ================ */
#define NUM_PIXELS 20

/* ================ LEDC (Buzzer) ============= */
#define FREQ_SMOKE_DANGER 2500
#define FREQ_TEMP_CRITICAL 2200
#define FREQ_ENV_DANGER 2000
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
const char* ssid = "GREGORIO WIFI 2.4G";
const char* password = "REDACTED-ROTATED-WIFI-PASSWORD";

/* ================= Socket.IO ================ */
const char* host = "192.168.100.39";
const uint16_t port = 3000;
// Must match DEVICE_SECRET in backend/.env
const char* deviceSecret = "REDACTED-ROTATED-DEVICE-SECRET";

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
 * ⚠️ Deliberately NOT recalibrated on every boot. Ro means "clean air" — if the ESP32
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
//   NOTE: alert_rules has warning+critical per metric, while this firmware also has a
//   middle "DANGER" temp band. On envConfig we set TEMP_DANGER = TEMP_CRITICAL so the
//   temp bands collapse to warning→critical, matching the dashboard's two severities.
//   TEMP_COLD has no alert_rules equivalent, so it keeps this default (LED "too cold").
//   IR/AC comfort zones (getIRZone) are a separate concept and are NOT driven here.
float WARNING_PPM   = 150.0;
float DANGER_PPM    = 300.0;
float TEMP_COLD     = 22.0;
float TEMP_WARNING  = 29.0;
float TEMP_DANGER   = 32.0;
float TEMP_CRITICAL = 35.0;
float HUM_DANGER    = 95.0;
float HUM_WARNING   = 85.0;

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
// ⚠️ What the data CANNOT confirm is that this is the right BUTTON. Bits 53-55 differ
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
  // Priority: Smoke DANGER or Temp CRITICAL → Red
  if (smokeStatus == "DANGER" || tempStatus == "CRITICAL") {
    setRGB(255, 0, 0);  // Red
  } else if (envStatus == "DANGER") {
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
String calcSmokeStatus(float ppm1, float ppm2) {
  float ppmMax = max(ppm1, ppm2);
  if (ppmMax >= DANGER_PPM) return "DANGER";
  if (ppmMax >= WARNING_PPM) return "WARNING";
  return "NORMAL";
}

String calcTempStatus(float t) {
  if (t >= TEMP_CRITICAL) return "CRITICAL";
  if (t >= TEMP_DANGER) return "DANGER";
  if (t >= TEMP_WARNING) return "WARNING";
  if (t < TEMP_COLD) return "TOO_COLD";
  return "NORMAL";
}

String calcEnvironmentStatus(float ppm1, float ppm2, float t, float h) {
  float ppmMax = max(ppm1, ppm2);
  if (t >= TEMP_CRITICAL) return "CRITICAL";
  if (t >= TEMP_DANGER || ppmMax >= DANGER_PPM || h >= HUM_DANGER) return "DANGER";
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

/* ─────────────────────────────────────────────
 *  BUZZER PATTERN HANDLER (unchanged logic)
 * ─────────────────────────────────────────────*/
void handleBuzzer(const String& smokeStatus, const String& tempStatus,
                  const String& envStatus, unsigned long now_ms) {
  int priority = 0;
  if (smokeStatus == "DANGER") priority = 5;
  else if (tempStatus == "CRITICAL") priority = 4;
  else if (envStatus == "DANGER") priority = 3;
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
    buzzerTone(FREQ_SMOKE_DANGER);
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
      buzzerTone(FREQ_ENV_DANGER);
      if (now_ms - lastBeepTime >= FAST_PULSE_ON) {
        buzzerOff();
        beepOn = false;
        lastBeepTime = now_ms;
      }
    } else {
      if (now_ms - lastBeepTime >= FAST_PULSE_OFF) {
        buzzerTone(FREQ_ENV_DANGER);
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
      // tempCrit drives BOTH TEMP_DANGER and TEMP_CRITICAL → temp bands collapse to
      // warning/critical, matching the dashboard's two severities.
      if (strcmp(eventName, "envConfig") == 0) {
        JsonObject cfg = doc[1];
        if (cfg.containsKey("tempWarn")) TEMP_WARNING = cfg["tempWarn"].as<float>();
        if (cfg.containsKey("tempCrit")) {
          TEMP_CRITICAL = cfg["tempCrit"].as<float>();
          TEMP_DANGER   = TEMP_CRITICAL;
        }
        if (cfg.containsKey("gasWarn")) WARNING_PPM = cfg["gasWarn"].as<float>();
        if (cfg.containsKey("gasCrit")) DANGER_PPM  = cfg["gasCrit"].as<float>();
        if (cfg.containsKey("humWarn")) HUM_WARNING = cfg["humWarn"].as<float>();
        if (cfg.containsKey("humCrit")) HUM_DANGER  = cfg["humCrit"].as<float>();
        Serial.printf("[ENV] Thresholds: tempW=%.1f tempC=%.1f gasW=%.1f gasC=%.1f humW=%.1f humC=%.1f\n",
                      TEMP_WARNING, TEMP_CRITICAL, WARNING_PPM, DANGER_PPM, HUM_WARNING, HUM_DANGER);
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

  /* WiFi */
  Serial.print("[WiFi] Connecting");
  WiFi.begin(ssid, password);
  int wifiAttempts = 0;
  while (WiFi.status() != WL_CONNECTED && wifiAttempts < 20) {
    delay(500);
    Serial.print(".");
    wifiAttempts++;
  }
  if (WiFi.status() == WL_CONNECTED) {
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

  /* Socket.IO — pass device key as query param for server auth */
  char socketUrl[128];
  snprintf(socketUrl, sizeof(socketUrl),
    "/socket.io/?EIO=3&transport=websocket&deviceKey=%s", deviceSecret);
  socketIO.begin(host, port, socketUrl);
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
        Serial.println("[WARN] WiFi down — reading not sent (offline).");
      }
    }
  }
}
