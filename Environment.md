# Environment Monitoring & Aircon Control — System Guide

End-to-end reference for the **environment subsystem** of the CSPC-ICTU server-room
monitor: temperature, humidity, smoke (MQ-2), and the IR-based air-conditioner control.

> Scope: this document covers the sensor pipeline (DHT11 + 2×MQ-2 → InfluxDB → dashboard)
> and the IR/Aircon control loop (auto + manual). For users/auth/server-metrics, see
> `CLAUDE.md`.

---

## 1. Hardware overview

One **ESP32** is the only edge device. It reads the environment and is the only thing
with IR transmitters, so **every physical AC action happens on the ESP32**.

| Component | GPIO | Role |
|-----------|------|------|
| DHT11 | 4 | Temperature + humidity |
| MQ-2 #1 | 34 (ADC) | Smoke/gas PPM (sensor 1) |
| MQ-2 #2 | 35 (ADC) | Smoke/gas PPM (sensor 2) |
| Piezo buzzer | 26 | Audible alarm (priority-based) |
| WS2812B RGB ×20 | 27 | Status color |
| IR TX #1 | 25 | AC channel 1 |
| IR TX #2 | 33 | AC channel 2 |
| DS3231 RTC | SDA 21 / SCL 22 | Timestamp source (optional) |
| SD card | SPI (CS 5) | Offline buffer (`SD_ENABLED` flag) |

Firmware: `iot/esp32/env_monitor_v2.ino`. Reads every loop tick; logs/sends every
`LOG_INTERVAL` (3 s).

---

## 2. Data flow (high level)

```
            ┌──────────────────────── ESP32 (env_monitor_v2.ino) ───────────────────────┐
            │  DHT11 + 2×MQ-2  ──read every loop──►  status calc  ──►  buzzer + RGB LED   │
            │        │                                    │                               │
            │        │ every 3s                           │ on temp ZONE change           │
            │        ▼                                    ▼                               │
            │   "sensorData"                         handleIR() → IR LEDs → physical AC   │
            │        │                                    │                               │
            │        │                                    ▼                               │
            │        │                               "irFired"                            │
            └────────┼────────────────────────────────────┼───────────────────────────── ┘
                     │ Socket.IO                           │ Socket.IO
                     ▼                                     ▼
            ┌─────────────────────────── Node.js + Socket.IO backend ───────────────────┐
            │  sensorHandler          connectionHandler          airconService           │
            │  - validate             - irFired → applyAutoIR()  - MySQL aircon_state     │
            │  - write InfluxDB       - irChannelMap → setMap    - MySQL aircon_logs      │
            │  - broadcast            - irCommand / irConfig out                          │
            └────────┬───────────────────────────┬────────────────────────────────────── ┘
                     │ "sensorData" / "sensorHistory"     │ "airconStatus"/"airconAutoUpdate"
                     ▼                                     ▼
            ┌──────────────────────────── React dashboard ──────────────────────────────┐
            │  Environment.tsx (live temp/humid/smoke)     AirConditioner.tsx (AC units) │
            └────────────────────────────────────────────────────────────────────────────┘
```

Two data stores:
- **InfluxDB** — all time-series sensor readings (measurement `sensor_environment`).
- **MySQL** — aircon units (`devices`, `aircon_state`, `aircon_logs`).

---

## 3. Sensor reading & status logic (firmware)

### 3.1 Smoke (MQ-2)
Raw ADC → resistance → PPM using the calibrated curve:
- `adcToRs()` converts ADC value to sensor resistance Rs (kΩ), accounting for the
  10k/20k voltage divider (`DIVIDER_RATIO = 0.6667`).
- `rsToPPM()` applies `PPM = 30000 · (Rs/Ro)^-2.95`, clamped to 0–9999.
- `Ro` is the clean-air baseline, **auto-calibrated at boot** after a 20 s warmup
  (`calibrateRo()`), seeded from `RO_CLEAN_AIR_1/2`.
- Final smoke value = **max** of the two sensors.

| Smoke status | Condition |
|--------------|-----------|
| `NORMAL` | max PPM < 150 |
| `WARNING` | 150 ≤ PPM < 300 |
| `DANGER` | PPM ≥ 300 |

### 3.2 Temperature (DHT11)
| Temp status | Condition |
|-------------|-----------|
| `TOO_COLD` | < 22 °C |
| `NORMAL` | 22–28.9 °C |
| `WARNING` | ≥ 29 °C |
| `DANGER` | ≥ 32 °C |
| `CRITICAL` | ≥ 35 °C |

### 3.3 Humidity (DHT11)
Used only inside the combined environment status:
- `WARNING` if ≥ 85 %, `DANGER` if ≥ 95 %.

### 3.4 Heat index
`calcHeatIndex()` (Steadman formula) — **display only**, not used for any threshold.

### 3.5 Combined environment status
`calcEnvironmentStatus()` rolls temp + smoke + humidity into one of
`NORMAL / WARNING / DANGER / CRITICAL` (worst-case wins).

### 3.6 Local feedback (no server needed)
- **Buzzer** (`handleBuzzer`): priority ladder — smoke DANGER (5) > temp CRITICAL (4)
  > env DANGER (3) > smoke WARNING (2) > env WARNING (1). Each priority has a distinct
  tone/pattern. `ledcWrite(pin, 0)` silences (not `ledcWriteTone(pin, 0)`).
- **RGB LED** (`setStatusColor`): Red = smoke DANGER / temp CRITICAL, Orange = env DANGER,
  Yellow = WARNING, Blue = TOO_COLD, Green = NORMAL.

---

## 4. Sensor → server pipeline

### 4.1 Live data (`sensorData`)
ESP32 emits every 3 s when WiFi + socket are up. Backend `sensorHandler.js`:
1. **Throttles** to ≤ 1 write/sec per socket.
2. **Validates** payload types (rejects silently on bad shape).
3. **Writes InfluxDB** point `sensor_environment`:
   - float fields: `temperature`, `humidity`, `mq2_1_ppm`, `mq2_2_ppm`, `heat_index`
   - tags: `smoke_status`, `temp_status`, `environment_status`
   - **timestamp = server `new Date()`** (ms precision) — ESP32's own time is ignored for live data.
4. **Broadcasts** `sensorData` to all *other* browsers (`socket.broadcast.volatile.emit`).

### 4.2 Offline replay (`offlineData`)
If WiFi drops and `SD_ENABLED=true`, the ESP32 buffers rows to `/log.csv`. On reconnect
it flushes each row as `offlineData`. Backend `offlineDataHandler.js`:
- Same InfluxDB fields **but uses the ESP32 RTC timestamp** (historical, not now).
- **No broadcast** (it's backfill, not live) and **no throttle**.

### 4.3 History queries (`changeRange` → `sensorHistory`)
Browser sends a range; backend `querySensorHistoryHandler.js` runs two Flux queries:
- **Numeric query** — pivots temp/humidity/ppm/heat_index, aggregated with `mean` over a
  window that scales with range (`-30m`→10s … `-30d`→3h).
- **Tag query** — re-fetches `smoke_status/temp_status/environment_status` with `fn: last`
  (tags can't be mean-aggregated) and merges them by `_time`.
- Result emitted back as `sensorHistory` (array, oldest → newest).

**Security:** quick ranges are whitelisted (`VALID_QUICK_RANGES`); custom ranges must match a
strict ISO-8601 UTC regex — this prevents Flux injection.

> Both the write path (`influx.js`) and the history path now read the bucket from
> `INFLUX_BUCKET` (`.env`). `influx.js` exports `bucket`, and `querySensorHistoryHandler.js`
> interpolates it into the Flux `from(bucket: "${bucket}")`, so reads and writes always
> target the same bucket.

---

## 5. IR / Aircon control

The AC can be driven two ways; both end with the ESP32 firing IR, and both mirror state
into MySQL + broadcast to browsers.

### 5.1 Concept: channels
A "channel" = one AC unit's IR transmitter.

| Layer | Representation |
|-------|----------------|
| Firmware array | `IR_CHANNEL_PINS[] = {25,33}` (0-based) — **2 transmitters wired** |
| Firmware runtime | `enabledChannels[]` — patched live via `irConfig` |
| MySQL | `aircon_state.ir_channel` — **1-based** |

Mapping: `ir_channel = N` (DB) → `IR_CHANNEL_PINS[N-1]` (firmware). Every channel value
crossing the socket is `-1`/`+1` converted accordingly.

### 5.2 FLOW A — AUTO (temperature-driven)
ESP32 decides; backend learns after the fact.

```
loop() → handleIR(temp) → getIRZone(temp)
   zone == lastIRZone ?  → skip   (fires ONLY on zone change)
   zone changed:
     send IR raw array on every enabledChannels[i]  ← physical AC changes
     emit "irFired" {zone, label}   (queued if socket down → pendingIRFired)
        │
        ▼ backend connectionHandler "irFired"
     airconService.applyAutoIR()
        - zone → set_temperature (ZONE_TEMP {0:28,1:26,2:24,3:22,4:20})
        - UPDATE aircon_state: is_on=1, last_trigger='auto', triggered_by_user_id=NULL
        - INSERT aircon_logs (trigger_type='auto')
     io.emit("airconAutoUpdate", {setTemp, action})  → all browsers
```

IR zone table:

| Room temp | Zone | Set temp | Fan |
|-----------|------|----------|-----|
| < 22 °C | TOO_COLD (0) | 28 °C | Auto |
| 22–24 °C | NORMAL (1) | 26 °C | Auto |
| 25–27 °C | ACCEPTABLE (2) | 24 °C | Auto |
| 28–29 °C | NEAR_CRIT (3) | 22 °C | High |
| > 29 °C | CRITICAL (4) | 20 °C | High |

> Fires **only on zone change**, not every tick — prevents AC/DB spam.

### 5.3 FLOW B — MANUAL (dashboard-driven)
Backend initiates; ESP32 obeys.

```
PATCH /api/aircon/:id/toggle  (JWT, role admin|it_staff)
   airconService.toggle() → flip is_on, last_trigger='manual',
                            triggered_by_user_id=userId, log it
   route fans out:
     io.emit("airconStatus", …)               → all browsers
     pushIRConfig(io) → "irConfig" to devices  → ESP32 syncs enabledChannels[]
     io.to("devices").emit("irCommand",
            {channel, action:"on"|"off"})       → ESP32 fires IR_POWER_ON/OFF
```

**On/off is the ONLY manual control.** `PATCH /:id/mode` and `/:id/temp` were removed
(2026-07-31): nothing in the dashboard ever called them, and they could not have worked —
the firmware has no per-degree or per-mode IR code, so they only wrote to MySQL, and
`applyAutoIR` overwrites `set_temperature` on every unit that is ON at the next zone
change. A manual value was silently discarded minutes later.

`mode` / `set_temperature` / `fan_mode` are **read-only status** on the card, showing what
auto-cooling chose. Real manual override would need captured codes per temperature *and* a
per-unit "manual" mode that suspends auto-cooling, with a rule for when auto resumes.

**Power-on re-sync.** Auto IR fires only on a zone *change* (§5.2), and a unit that is OFF
at that moment is skipped by both `applyAutoIR` and the firmware blast — so it would come
back with a stale setting and never catch up while the room stays in that zone. Turning a
unit ON therefore re-applies the current zone: the firmware follows `IR_POWER_ON` with the
zone's code (shared `zoneIRData()`), and `airconService.toggle` writes the matching
`set_temperature` plus an `auto` log row. The backend's zone comes from an in-memory
`lastZone` cached on `irFired`; after a backend restart it is null, so only the hardware
re-syncs until the next zone change.

### 5.4 `aircon_state` semantics

| Scenario | `last_trigger` | `triggered_by_user_id` |
|----------|---------------|------------------------|
| Unit registered | `NULL` | `NULL` |
| Staff toggle | `manual` | user ID |
| Auto IR zone change | `auto` | `NULL` |

### 5.5 Config sync (keeping firmware ↔ DB in agreement)
- **`irChannelMap`** (ESP32 → server, on every connect): "here are my GPIOs"
  → `airconService.setChannelMap()` (in-memory) → re-broadcast to browsers (Add-Aircon modal).
- **`irConfig`** (server → ESP32, on connect + after add/remove/toggle): "which channels are
  enabled" → firmware updates `enabledChannels[]` at runtime. **No reflash needed** to add or
  disable an AC unit.

### 5.6 The "devices" room
On connect, if `socket.isDevice`, the ESP32 `socket.join("devices")`. All backend→ESP32
pushes use `io.to("devices").emit(...)`, so the backend never tracks the volatile socket ID.

---

## 6. Socket.IO event reference (environment subset)

| Event | Direction | Purpose |
|-------|-----------|---------|
| `sensorData` | ESP32 → server | Live reading → InfluxDB write + broadcast |
| `sensorData` | server → browsers | Live reading fan-out |
| `offlineData` | ESP32 → server | SD replay → InfluxDB (RTC time, no broadcast) |
| `changeRange` | browser → server | Request history for a range |
| `sensorHistory` | server → browser | History response (array) |
| `irFired` | ESP32 → server | Auto IR fired → `applyAutoIR()` |
| `irChannelMap` | ESP32 → server | GPIO map on connect → stored + forwarded |
| `irConfig` | server → ESP32 | Enabled-channel list (connect + on change) |
| `irCommand` | server → ESP32 | Manual ON/OFF on a channel |
| `airconStatus` | server → browsers | Manual on/off toggle, rename, or power-on re-sync |
| `airconAutoUpdate` | server → browsers | Auto IR zone change |

Auth: browsers send JWT in `handshake.auth.token`; ESP32 sends `DEVICE_SECRET` in
`handshake.query.deviceKey`. `socket.isDevice` gates every device-only handler.

---

## 7. Key files

| File | Responsibility |
|------|----------------|
| `iot/esp32/env_monitor_v2.ino` | Firmware: read sensors, status, buzzer/LED, IR send |
| `backend/handlers/sensorHandler.js` | Validate + write live reading + broadcast |
| `backend/handlers/offlineDataHandler.js` | Write SD-buffered historical rows |
| `backend/handlers/querySensorHistoryHandler.js` | Flux history queries |
| `backend/config/influx.js` | InfluxDB write/query clients (ms precision) |
| `backend/sockets/connectionHandler.js` | Socket events, device vs browser routing |
| `backend/services/airconService.js` | All aircon MySQL logic + channel map |
| `backend/routes/aircon.js` | REST API for aircon CRUD + manual control |
| `frontend/src/pages/Environment.tsx` | Live temp/humidity/smoke UI |
| `frontend/src/pages/AirConditioner.tsx` | AC units UI + manual controls |

---

## 8. Developer guide — common tasks

### Add a new AC unit
1. Wire its IR TX to a free GPIO; add the pin to `IR_CHANNEL_PINS[]` and bump
   `MAX_IR_CHANNELS` in the firmware; reflash (only needed for *new GPIO wiring*).
2. In the dashboard, **Add Aircon** with an unused `ir_channel` (**1–2**, matching
   `MAX_IR_CHANNELS`). This inserts
   `devices` + `aircon_state` rows and pushes `irConfig` to the ESP32.
3. Enabling/disabling an existing channel afterward needs **no reflash** — it flows via
   `irConfig`.

### Capture real IR codes (replace the mock NEC data)
All `IR_*` arrays in the firmware are **placeholder NEC**. Use the `IRrecvDumpV2` sketch with
the Carrier remote to capture real raw timings, then replace:
`IR_28C_AUTO`, `IR_26C_AUTO`, `IR_24C_AUTO`, `IR_22C_HIGH`, `IR_20C_HIGH`,
`IR_POWER_ON`, `IR_POWER_OFF`.

### Change a sensor threshold
Edit the `#define`s in the firmware (`WARNING_PPM`, `DANGER_PPM`, `TEMP_*`, `HUM_*`) and the
zone bounds in `getIRZone()`. Status strings are computed on-device, so no backend change
is needed.

### Add a new sensor field to InfluxDB
1. Firmware: add the field to the `sensorData` JSON.
2. `sensorHandler.js` **and** `offlineDataHandler.js`: validate it + `.floatField(...)`.
3. `querySensorHistoryHandler.js`: add it to the numeric filter + the row mapper.

### Move to a new network
Update both hardcoded endpoints **and** the firmware:
- `frontend/src/api/client.ts` (Axios baseURL)
- `frontend/src/socket/socket.ts` (Socket.IO URL)
- `iot/esp32/env_monitor_v2.ino` — `host`, `port`, `ssid`, `password`, `deviceSecret`

---

## 9. Gotchas / known issues

- **Bucket name** — both read and write paths now derive the bucket from `INFLUX_BUCKET`
  (`.env`) via the exported `bucket` in `influx.js`; no longer hardcoded (§4.3).
- **Mock IR data** — nothing physically controls a real Carrier AC until the raw codes are
  replaced (§8).
- **On/off is the only manual control** — the mode/temp endpoints were removed (§5.3).
- **Live timestamps are server-side** — InfluxDB live points use `new Date()`, so ESP32
  clock drift doesn't matter for live data; only offline replay uses the RTC time.
- **SD buffering is off by default** — `#define SD_ENABLED false`; offline rows are dropped
  unless the SD module is connected and the flag is set.
- **DHT11 is low-resolution** (±1 °C / integer-ish humidity) — fine for zone logic, not for
  precise readings.
