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
| DS3231 RTC | SDA 21 / SCL 22 | Timestamp source — **fit the coin cell**, see §9 |
| micro SD | SCK 18 / MISO 19 / MOSI 23 / CS 5 | Offline buffer (§4.2) |

Firmware: `iot/esp32/env_monitor_v2/env_monitor_v2.ino`. Reads every loop tick; logs/sends every
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
- `Ro` is the clean-air baseline. It is **measured once per location and stored in NVS
  flash**, then reused on every subsequent boot (`loadRo` / `calibrateRo` / `saveRo`).
  - **First boot in a new place** → no stored value → the firmware waits `CAL_SETTLE_MS`
    (3 min, for the heater to stabilise), measures, validates and saves. The air must be
    clean during that window.
  - **Every boot after** → the stored value is loaded. Ro is deliberately **not**
    re-measured each boot: a reboot during a gas event would record polluted air as the
    baseline and then under-report smoke permanently.
  - **Moved location** → send the **`calibrateGas`** socket event; no reflash needed.
  - A result outside `RO_MIN_VALID … RO_MAX_VALID` (1–50 kΩ) is **rejected**, not stored,
    so a bad reading (open circuit, shorted sensor, smoky air) can't blind the detector.
  > Before 2026-07-31 `calibrateRo()` only *printed* a suggested value and told you to
  > edit `RO_CLEAN_AIR_1/2` by hand and reflash — the measurement was never applied.
- Final smoke value = **max** of the two sensors.

> **Vocabulary.** All three statuses report `NORMAL / WARNING / CRITICAL`, the same three
> severities as `alert_rules`; `temp_status` adds `TOO_COLD`, which is an axis rather than a
> severity (no rule backs it). The thresholds below are the *compiled fallbacks* — the live
> numbers come from the Alert Rules page via `envConfig` (§ "Change a sensor threshold").
>
> ⚠️ Until **2026-08-15** there was a fourth, middle **`DANGER`** band. These statuses are
> InfluxDB **tags**, so points written before that date keep it and any range reaching back
> that far returns both spellings — permanently, not for a migration window. The dashboard
> folds it forward with `utils/envThresholds.normalizeStatus`.

| Smoke status | Condition |
|--------------|-----------|
| `NORMAL` | max PPM < 150 |
| `WARNING` | 150 ≤ PPM < 300 |
| `CRITICAL` | PPM ≥ 300 |

### 3.2 Temperature (DHT11)
| Temp status | Condition |
|-------------|-----------|
| `TOO_COLD` | < 22 °C |
| `NORMAL` | 22–28.9 °C |
| `WARNING` | ≥ 29 °C |
| `CRITICAL` | ≥ 35 °C |

### 3.3 Humidity (DHT11)
Used only inside the combined environment status:
- `WARNING` if ≥ 85 %, `CRITICAL` if ≥ 95 %.

### 3.4 Heat index
`calcHeatIndex()` (Steadman formula) — **display only**, not used for any threshold.

### 3.5 Combined environment status
`calcEnvironmentStatus()` rolls temp + smoke + humidity into one of
`NORMAL / WARNING / CRITICAL` (worst-case wins) — a metric at its critical threshold makes
the room critical, whichever metric it is. It previously returned CRITICAL for a hot room
but DANGER for critical gas or humidity, which ranked a smoke event *below* a warm room.

### 3.6 Local feedback (no server needed)
- **Buzzer** (`handleBuzzer`): priority ladder — smoke CRITICAL (5) > temp CRITICAL (4)
  > env CRITICAL (3) > smoke WARNING (2) > env WARNING (1). Each priority has a distinct
  tone/pattern. The order is load-bearing: `envStatus` is CRITICAL whenever gas or temp is,
  so the specific conditions must be tested before the aggregate. `ledcWrite(pin, 0)`
  silences (not `ledcWriteTone(pin, 0)`).
- **RGB LED** (`setStatusColor`): Red = smoke / temp CRITICAL, Orange = env CRITICAL (which
  at that point means **humidity** alone — gas and temp are caught above), Yellow = WARNING,
  Blue = TOO_COLD, Green = NORMAL.
  > ⚠️ **Byte order.** `RGB_COLOR_ORDER` (top of the sketch) is `NEO_RGB`. Genuine WS2812B
  > is GRB, but RGB-ordered clones are physically identical and common. A mismatch swaps
  > **red and green** and leaves **blue** correct — so a normal room glows red while the
  > boot flash still looks right. `RGB_SELFTEST 1` flashes R/G/B at boot with a serial
  > commentary to settle it; set it to 0 once confirmed.

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

### 4.2 Offline buffer + replay (`offlineData`) — LIVE again since 2026-08-21

The ESP32 buffers to a micro SD whenever the socket is down, and replays the file once
the backend is reachable. This was removed in July 2026 on the reasoning that every
monitored link sits on a UPS, so the device never disconnects — which covers a *power*
outage and not the other ways the link dies: the AP rebooting, the backend restarting
for a deploy, a cable pulled, WiFi simply not associating at boot. Those leave the room
unmonitored with no record that it was, which is the one gap the environment subsystem
cannot argue away: it is the fire alarm.

**Firmware side** (`sdAppendRow` / `sdFlushStep`):
- Socket **down** → append the reading to `/log.csv`.
- Socket **back** → replay each row as an `offlineData` event, **`SD_FLUSH_BATCH` (5) rows
  per loop tick**, then delete the file.
- Rows are written **report-by-exception**, mirroring `services/envPersistPolicy.js` gate
  for gate: a 30 s heartbeat plus an immediate row on a gas move past 15 ppm, any status
  transition, or a real temperature/humidity excursion. Buffering all 20 readings a
  minute would replay ten times what a *connected* device stores, and the outage would
  come back as the best-sampled stretch of the day.
- A row the device cannot **date** is refused rather than buffered — see §9.

> ⚠️ **The replay is a state machine, not a loop, and must stay that way.** The pre-2026-07
> implementation streamed the whole file in one `while` with a `delay(30)` per row: an hour
> of buffer meant a **36-second blocking stall** with no sensor read, no buzzer update and
> no IR in it. During a fire. `sdFlushStep()` sends a few rows and returns to `loop()`.

**Backend side** (`offlineDataHandler.js`) — same InfluxDB fields as the live path, and
three deliberate differences:
- **The sender's timestamp**, not `new Date()`. Parsed as UTC+8 (the firmware's compiled
  `configTime` offset) rather than the backend's local zone, and gated for plausibility by
  the pure, unit-tested `services/backfillTime.js`.
- **No broadcast and no alert evaluation.** This is history, not news: redrawing the live
  tiles from the middle of a finished outage would be wrong, and raising a smoke alert for
  air that cleared an hour ago would be a false alarm with a real siren on it.
- **No re-gating by `envPersistPolicy`** — the firmware already applied the same rules, so
  every row arriving is one a connected device would have stored anyway.
- **Mirrored into the on-site NDJSON backup** (`backupService`), so the backup does not
  carry a hole exactly across the outage the buffer exists to cover. The line's `ts` is
  when the reading was *taken*; the file it lands in is today's, which is when the backend
  learned of it.
- Writes are **batched** — one debounced flush per burst, not the old flush-per-row.

**Idempotence.** InfluxDB overwrites a point with the same measurement, tag set and
timestamp, so replaying a row twice is harmless. That is what lets the firmware keep the
file when a replay is interrupted, and why no read offset is persisted across reboots.

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
| `offlineData` | ESP32 → server | SD replay → InfluxDB (device RTC time, no broadcast, no alerting) |
| `changeRange` | browser → server | Request history for a range |
| `sensorHistory` | server → browser | History response (array) |
| `irFired` | ESP32 → server | Auto IR fired → `applyAutoIR()` |
| `irChannelMap` | ESP32 → server | GPIO map on connect → stored + forwarded |
| `irConfig` | server → ESP32 | Enabled-channel list (connect + on change) |
| `irCommand` | server → ESP32 | Manual ON/OFF on a channel |
| `calibrateGas` | server → ESP32 | Re-measure the MQ-2 clean-air baseline and save it to flash. Use after moving the box — the air must be clean. Replaces editing `RO_CLEAN_AIR_*` and reflashing |
| `airconStatus` | server → browsers | Manual on/off toggle, rename, or power-on re-sync |
| `airconAutoUpdate` | server → browsers | Auto IR zone change |

Auth: browsers send JWT in `handshake.auth.token`; ESP32 sends `DEVICE_SECRET` in
`handshake.query.deviceKey`. `socket.isDevice` gates every device-only handler.

---

## 7. Key files

| File | Responsibility |
|------|----------------|
| `iot/esp32/env_monitor_v2/env_monitor_v2.ino` | Firmware: read sensors, status, buzzer/LED, IR send |
| `backend/handlers/sensorHandler.js` | Validate + write live reading + broadcast |
| `backend/handlers/offlineDataHandler.js` | Write SD-buffered historical rows (+ backup mirror) |
| `backend/services/backfillTime.js` | PURE: parse + sanity-check a device timestamp (tested) |
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

### Re-capture an IR code
All seven `IR_*` arrays are already real Carrier captures (2026-07-31 / 2026-08-01) — this is
the procedure if one ever needs replacing. Use `IRLearner.ino`, not `IRrecvDumpV2`.

**Capture conditions matter more than anything else.** Both failed attempts at `IR_20C_HIGH`
were killed by ambient light, not by the remote or the sketch: one came back 133 values with
stray edges, the other 223 values of pure 60 Hz mains flicker off a lamp with no remote frame
in it at all. So: room lights **off** (fluorescent and cheap LED are the usual culprits), away
from sunlight and screens, remote 3–10 cm and pointed straight at the receiver. If IRLearner
prints anything while you are *not* pressing a button, the environment is still too noisy —
fix that first, because every capture will fail the same way.

**Validate before pasting it in.** A good capture is **exactly 131 values** (leader pair + 64
bit-pairs + stop mark), starts ~`9000, 4500`, and decodes to exactly 64 bits with marks around
450–600 µs and two clearly separated space populations (~600 = zero, ~1750 = one). Cross-check
it against the existing arrays: bits 0–9 and the all-zero bits 16–39 should match the other
temperature frames, and bits 61–63 must be the exact complement of bits 53–55 — an invariant
all seven satisfy. If you get 133 or 223 values, **recapture; do not trim**, because you
cannot tell which entries are the intruders.

### Change a sensor threshold
**No reflash, and no code edit.** Both threshold families are runtime-configurable from the
dashboard, and the firmware applies them live:
- **Alarm thresholds** (LED / buzzer / reported status) — the admin **Alert Rules** page.
  Saving pushes `envConfig` to the ESP32, which updates `WARNING_PPM`, `CRITICAL_PPM`, `TEMP_*`
  and `HUM_*` — these are mutable globals now, not `#define`s. A metric with no rule keeps its
  compiled default on the device.
- **Auto-cooling zone boundaries** (when IR fires) — the **Auto-Cooling Thresholds** card on
  the AirConditioner page, admin-edit. Saving pushes `acConfig`, which updates the bounds
  `getIRZone()` reads. The per-zone target temps stay fixed: each is a captured raw IR code.

These are deliberately separate — cooling should ramp *before* the alarm fires.

### Add a new sensor field to InfluxDB
1. Firmware: add the field to the `sensorData` JSON.
2. `sensorHandler.js` **and** `offlineDataHandler.js`: validate it + `.floatField(...)`.
3. `querySensorHistoryHandler.js`: add it to the numeric filter + the row mapper.
4. Firmware again: add it to the SD CSV **header and row** in `sdAppendRow()` and to the
   parser in `sdSendRow()` — the two must stay in the same column order, or a replayed
   row silently lands its fields one column across.

### Move to a new network
Update both hardcoded endpoints **and** the firmware:
- `frontend/src/api/client.ts` (Axios baseURL)
- `frontend/src/socket/socket.ts` (Socket.IO URL)
- `iot/esp32/env_monitor_v2/env_monitor_v2.ino` — `host`, `port`, `ssid`, `password`, `deviceSecret`

---

## 9. Gotchas / known issues

- **Bucket name** — both read and write paths now derive the bucket from `INFLUX_BUCKET`
  (`.env`) via the exported `bucket` in `influx.js`; no longer hardcoded (§4.3).
- **IR data is real, but unproven against the AC** — all seven arrays are genuine Carrier
  captures (§8), so the mock-data caveat is gone. What remains is that no code here has ever
  driven a physical unit: verify `IR_20C_HIGH` really is 20 °C / fan High, and give
  `IR_POWER_OFF` a deliberate test (§8).
- **On/off is the only manual control** — the mode/temp endpoints were removed (§5.3).
- **Live timestamps are server-side** — InfluxDB live points use `new Date()`, so ESP32
  clock drift doesn't matter for live data; only offline replay uses the RTC time.
- **The on-device buffer is back** (§4.2) — a reading taken while the socket is down goes
  to `/log.csv` on the micro SD and is replayed on reconnect. The backend's `backupService`
  is still the primary on-site copy; the card covers the window where the backend cannot be
  reached at all.
- **⚠️ Fit the DS3231's coin cell, and check what kind the module wants.** Backfilled rows
  are stored under the **device's** clock (live ones are stamped by the backend, so they
  never depended on it). A DS3231 with no battery reports `lostPower()` after any cut and
  the firmware answers with `rtc.adjust(compile time)` — a *well-formed* date attached to
  readings never taken then, which is worse than losing them because it reads as history.
  Two guards, because neither alone is enough: the firmware refuses to buffer a row it
  cannot date (`sdClockIsReal` catches the `UP HH:MM:SS` fallback), and the backend refuses
  one dated more than 90 days back or 5 minutes ahead (`backfillTime.js` — the only thing
  that catches the build-date case, since that string parses fine).
  > **Hardware note:** the common ZS-042 DS3231 board has a trickle-charge circuit (a diode
  > + a `201` resistor) meant for a **rechargeable LIR2032**. A non-rechargeable **CR2032**
  > — which is what "CMOS battery" usually means — must **not** be charged: remove the
  > diode or the `201` resistor first, or fit an LIR2032. Boards sold as "DS3231 for
  > Raspberry Pi" usually have this circuit already omitted.
- **⚠️ Program storage.** The sketch was already at ~94 % of the default partition before
  the SD code went back in. If it no longer fits, set Arduino IDE ▸ Tools ▸ **Partition
  Scheme → "Huge APP (3MB No OTA/1MB SPIFFS)"** rather than dropping the buffer;
  `SD_ENABLED 0` compiles the whole feature out if you need the space some other way.
- **DHT11 is low-resolution** (±1 °C / integer-ish humidity) — fine for zone logic, not for
  precise readings.
