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
 *  ─── CALIBRATION ─────────────────────────────────────────────
 *  Calibrated: 2026-05-25, clean air, Bicol PH
 *  Sensor 1 Ro = 6.98 kΩ  |  Sensor 2 Ro = 6.76 kΩ
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

/* =================== PINS =================== */
#define MQ2_PIN_1  34
#define MQ2_PIN_2  35
#define BUZZER_PIN 26
#define DHTPIN      4
#define RGB_PIN    27    // WS2812B data

/* =========== IR CHANNEL ARRAY ===============
 * Each index = ir_channel value stored in DB (0-based here).
 * To add a new AC unit: wire its IR TX to a free GPIO, add the
 * pin to IR_CHANNEL_PINS, and increment MAX_IR_CHANNELS.
 * enabledChannels[] is updated at runtime via "irConfig" socket event.
 * ============================================ */
#define MAX_IR_CHANNELS 4
const uint8_t IR_CHANNEL_PINS[MAX_IR_CHANNELS] = { 25, 33, 32, 15 };
bool enabledChannels[MAX_IR_CHANNELS] = { true, true, false, false };

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
const char* password = "SEPT.261976";

/* ================= Socket.IO ================ */
const char* host = "192.168.100.9";
const uint16_t port = 3000;
// Must match DEVICE_SECRET in backend/.env
const char* deviceSecret = "cspc-ictu-esp32-device-2026";

/* ================= MQ-2 CONFIG ============== */
#define RL_VALUE 10.0
#define RO_CLEAN_AIR_1 9.15
#define RO_CLEAN_AIR_2  7.28
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

/* ─────────────────────────────────────────────────────────────
 *  MOCK NEC RAW IR DATA
 *  Replace these uint16_t arrays with real captured values
 *  from your Carrier remote using IRrecvDumpV2 sketch.
 *  Each array: pulse/space pairs in microseconds.
 *  Format: {NEC_HDR_MARK, NEC_HDR_SPACE, bit1_mark, bit1_space, ...}
 * ─────────────────────────────────────────────────────────────*/
// 28°C Cool Auto fan  (Too Cold zone)
const uint16_t IR_28C_AUTO[] = {
  9000, 4500, 560, 560, 560, 1690, 560, 560, 560, 1690,
  560, 1690, 560, 560, 560, 560, 560, 1690, 560, 560,
  560, 1690, 560, 1690, 560, 560, 560, 1690, 560, 560,
  560, 560, 560, 1690, 560, 560, 560, 560, 560, 1690,
  560, 1690, 560, 560, 560, 560, 560, 1690, 560, 560,
  560, 1690, 560, 560, 560, 1690, 560, 560, 560, 560,
  560, 1690, 560, 560, 560, 560, 560, 40000
};

// 26°C Cool Auto fan  (Normal zone)
const uint16_t IR_26C_AUTO[] = {
  9000, 4500, 560, 1690, 560, 560, 560, 1690, 560, 560,
  560, 560, 560, 1690, 560, 560, 560, 1690, 560, 1690,
  560, 560, 560, 560, 560, 1690, 560, 560, 560, 1690,
  560, 1690, 560, 560, 560, 1690, 560, 1690, 560, 560,
  560, 560, 560, 1690, 560, 560, 560, 1690, 560, 560,
  560, 1690, 560, 560, 560, 560, 560, 1690, 560, 1690,
  560, 560, 560, 1690, 560, 560, 560, 40000
};

// 24°C Cool Auto fan  (Acceptable zone)
const uint16_t IR_24C_AUTO[] = {
  9000, 4500, 560, 1690, 560, 1690, 560, 560, 560, 1690,
  560, 560, 560, 560, 560, 1690, 560, 560, 560, 1690,
  560, 560, 560, 1690, 560, 1690, 560, 560, 560, 560,
  560, 1690, 560, 1690, 560, 560, 560, 560, 560, 560,
  560, 1690, 560, 560, 560, 1690, 560, 1690, 560, 560,
  560, 560, 560, 1690, 560, 1690, 560, 560, 560, 560,
  560, 1690, 560, 560, 560, 1690, 560, 40000
};

// 22°C Cool High fan  (Near Critical zone)
const uint16_t IR_22C_HIGH[] = {
  9000, 4500, 560, 560, 560, 560, 560, 1690, 560, 1690,
  560, 560, 560, 560, 560, 1690, 560, 1690, 560, 1690,
  560, 1690, 560, 560, 560, 560, 560, 1690, 560, 1690,
  560, 560, 560, 560, 560, 1690, 560, 560, 560, 1690,
  560, 1690, 560, 1690, 560, 560, 560, 560, 560, 1690,
  560, 1690, 560, 560, 560, 560, 560, 1690, 560, 1690,
  560, 560, 560, 560, 560, 1690, 560, 40000
};

// 20°C Cool High fan  (Critical zone)
const uint16_t IR_20C_HIGH[] = {
  9000, 4500, 560, 1690, 560, 560, 560, 560, 560, 1690,
  560, 1690, 560, 560, 560, 560, 560, 1690, 560, 560,
  560, 1690, 560, 1690, 560, 560, 560, 1690, 560, 560,
  560, 1690, 560, 1690, 560, 560, 560, 1690, 560, 560,
  560, 560, 560, 1690, 560, 1690, 560, 560, 560, 560,
  560, 1690, 560, 1690, 560, 560, 560, 1690, 560, 560,
  560, 1690, 560, 560, 560, 560, 560, 40000
};

// Power ON
const uint16_t IR_POWER_ON[] = {
  9000, 4500, 560, 1690, 560, 560, 560, 560, 560, 1690,
  560, 560, 560, 1690, 560, 1690, 560, 560, 560, 560,
  560, 1690, 560, 560, 560, 1690, 560, 560, 560, 1690,
  560, 560, 560, 1690, 560, 560, 560, 1690, 560, 560,
  560, 560, 560, 1690, 560, 560, 560, 1690, 560, 1690,
  560, 560, 560, 560, 560, 1690, 560, 560, 560, 1690,
  560, 1690, 560, 560, 560, 560, 560, 40000
};

// Power OFF
const uint16_t IR_POWER_OFF[] = {
  9000, 4500, 560, 560, 560, 1690, 560, 1690, 560, 560,
  560, 1690, 560, 560, 560, 560, 560, 1690, 560, 1690,
  560, 560, 560, 1690, 560, 560, 560, 1690, 560, 1690,
  560, 560, 560, 560, 560, 1690, 560, 1690, 560, 1690,
  560, 1690, 560, 560, 560, 1690, 560, 560, 560, 560,
  560, 1690, 560, 1690, 560, 560, 560, 1690, 560, 560,
  560, 560, 560, 1690, 560, 560, 560, 40000
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
void handleIR(float temperature) {
  int zone = getIRZone(temperature);
  if (zone == lastIRZone) return;  // no change — skip
  lastIRZone = zone;

  const uint16_t* irData = nullptr;
  uint16_t irLen = 0;
  String irLabel = "";

  switch (zone) {
    case IR_ZONE_TOO_COLD:
      irData = IR_28C_AUTO;
      irLen = sizeof(IR_28C_AUTO) / sizeof(IR_28C_AUTO[0]);
      irLabel = "28C_AUTO";
      break;
    case IR_ZONE_NORMAL:
      irData = IR_26C_AUTO;
      irLen = sizeof(IR_26C_AUTO) / sizeof(IR_26C_AUTO[0]);
      irLabel = "26C_AUTO";
      break;
    case IR_ZONE_ACCEPTABLE:
      irData = IR_24C_AUTO;
      irLen = sizeof(IR_24C_AUTO) / sizeof(IR_24C_AUTO[0]);
      irLabel = "24C_AUTO";
      break;
    case IR_ZONE_NEAR_CRIT:
      irData = IR_22C_HIGH;
      irLen = sizeof(IR_22C_HIGH) / sizeof(IR_22C_HIGH[0]);
      irLabel = "22C_HIGH";
      break;
    case IR_ZONE_CRITICAL:
      irData = IR_20C_HIGH;
      irLen = sizeof(IR_20C_HIGH) / sizeof(IR_20C_HIGH[0]);
      irLabel = "20C_HIGH";
      break;
  }

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

/* ---- Calibrate Ro ---- */
void calibrateRo() {
  const int samples = 50;
  float rsSum1 = 0, rsSum2 = 0;
  int adcSum1 = 0, adcSum2 = 0;
  for (int i = 0; i < samples; i++) {
    int raw1 = analogRead(MQ2_PIN_1);
    int raw2 = analogRead(MQ2_PIN_2);
    adcSum1 += raw1;
    adcSum2 += raw2;
    rsSum1 += adcToRs(raw1);
    rsSum2 += adcToRs(raw2);
    delay(50);
  }
  float avgRs1 = rsSum1 / samples, ro1 = avgRs1 / 9.83;
  float avgRs2 = rsSum2 / samples, ro2 = avgRs2 / 9.83;
  Serial.printf("[CAL] Sensor 1 → Avg Rs: %.2f kΩ  Ro: %.2f kΩ%s\n",
                avgRs1, ro1, abs(ro1 - RO_CLEAN_AIR_1) > 5.0 ? " *** UPDATE RO_CLEAN_AIR_1 ***" : " (OK)");
  Serial.printf("[CAL] Sensor 2 → Avg Rs: %.2f kΩ  Ro: %.2f kΩ%s\n",
                avgRs2, ro2, abs(ro2 - RO_CLEAN_AIR_2) > 5.0 ? " *** UPDATE RO_CLEAN_AIR_2 ***" : " (OK)");
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
    Serial.println("[OK] Warm-up complete. Calibrating Ro...");
    calibrateRo();
    Serial.println("=== System Ready ===\n");
    warmupDone = true;
    lastLogTime = millis();
    lastBeepTime = millis();
    return;
  }

  /* ── Read MQ-2 (every loop tick) ── */
  int rawSmoke1 = analogRead(MQ2_PIN_1);
  int rawSmoke2 = analogRead(MQ2_PIN_2);
  float ppm1 = rsToPPM(adcToRs(rawSmoke1), RO_CLEAN_AIR_1);
  float ppm2 = rsToPPM(adcToRs(rawSmoke2), RO_CLEAN_AIR_2);
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
