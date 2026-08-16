# Configurable AC Targets — Implementation Spec (Option A)

Make the **"set AC to"** value of each auto-cooling zone admin-configurable, instead of
being welded to five firmware arrays.

> Scope: the *target* temperature + fan speed per zone. The *room-temperature boundaries*
> are already configurable (`aircon_ir_config`, Auto-Cooling Thresholds card) and are not
> changed here. See `Environment.md` §5 and the Air Conditioner section of `CLAUDE.md`.

---

## 1. Why it's fixed today

`airconService.ZONE_TEMP = { 0:28, 1:26, 2:24, 3:22, 4:20 }` maps 1:1 onto five firmware
arrays (`IR_28C_AUTO` … `IR_20C_HIGH`). There is no waveform for 25 °C, so "set AC to 25"
has nothing to transmit. It's a missing capture, not a policy decision.

**Approach A** removes the limit by turning the firmware's five constants into a *library*
of captured codes indexed by `(temp, fan)`, and letting the dashboard choose which entry
each zone points at. No checksum reverse-engineering required — this is pure raw replay,
the path already proven working.

---

## 2. Capture requirement

One capture per `(temp, fan)` combination you want selectable.

| Coverage | Captures | Gives you |
|----------|----------|-----------|
| 18–30 °C at **Auto** only | 13 | Any target temp, fan always Auto |
| 18–30 °C at **Auto + High** | 26 | **Recommended** — matches today's Auto/High split |
| Add Low / Turbo | +13 each | Full fan control |

Rules from `what_to_learn(guide).docx` still apply: change one setting at a time, label
every capture `MODE TEMP FAN`, verify each array is exactly **131 numbers** before saving.

Memory is a non-issue: 26 × 131 × 2 bytes ≈ **6.8 KB** against 4 MB of flash.

---

## 3. Schema

New table — 5 rows, one per zone. Kept separate from `aircon_ir_config` because that is a
single global row of boundaries, whereas this is per-zone.

```sql
-- migrations/2026-08-XX_aircon_zone_targets.sql
CREATE TABLE IF NOT EXISTS aircon_zone_targets (
  zone        TINYINT UNSIGNED NOT NULL PRIMARY KEY,   -- 0..4, matches firmware IR_ZONE_*
  target_temp TINYINT UNSIGNED NOT NULL,               -- °C the AC is set to
  fan_mode    ENUM('auto','low','high','turbo') NOT NULL DEFAULT 'auto',
  updated_by  INT NULL,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_zone_targets_user
    FOREIGN KEY (updated_by) REFERENCES users(user_id) ON DELETE SET NULL
);

-- Seed with today's hardcoded values so behaviour is IDENTICAL on day one.
INSERT INTO aircon_zone_targets (zone, target_temp, fan_mode) VALUES
  (0, 28, 'auto'),   -- TOO_COLD
  (1, 26, 'auto'),   -- NORMAL
  (2, 24, 'auto'),   -- ACCEPTABLE
  (3, 22, 'high'),   -- NEAR_CRIT
  (4, 20, 'high')    -- CRITICAL
ON DUPLICATE KEY UPDATE zone = zone;
```

---

## 4. Firmware — `iot/esp32/env_monitor_v2/env_monitor_v2.ino`

### 4.1 Replace the five constants with a library

```cpp
enum { FAN_AUTO = 0, FAN_LOW, FAN_HIGH, FAN_TURBO };

struct IRCode {
  uint8_t temp;              // °C
  uint8_t fan;               // FAN_*
  const uint16_t* data;
  uint16_t len;
};

#define IRC(t, f, arr) { t, f, arr, sizeof(arr) / sizeof(arr[0]) }

const IRCode IR_LIBRARY[] = {
  IRC(18, FAN_AUTO, IR_18_AUTO),
  IRC(19, FAN_AUTO, IR_19_AUTO),
  // …
  IRC(30, FAN_HIGH, IR_30_HIGH),
};
const uint8_t IR_LIBRARY_LEN = sizeof(IR_LIBRARY) / sizeof(IR_LIBRARY[0]);

const IRCode* findCode(uint8_t temp, uint8_t fan) {
  for (uint8_t i = 0; i < IR_LIBRARY_LEN; i++)
    if (IR_LIBRARY[i].temp == temp && IR_LIBRARY[i].fan == fan) return &IR_LIBRARY[i];
  return nullptr;   // never fire a wrong code — caller logs and skips
}
```

### 4.2 Per-zone targets, defaulting to today's values

```cpp
struct ZoneTarget { uint8_t temp; uint8_t fan; };
ZoneTarget zoneTargets[5] = {
  {28, FAN_AUTO}, {26, FAN_AUTO}, {24, FAN_AUTO}, {22, FAN_HIGH}, {20, FAN_HIGH}
};
```

### 4.3 `zoneIRData()` becomes a lookup

The function added for the power-on re-sync stays the single mapping point — it just
resolves through `zoneTargets` + `findCode` instead of a `switch`:

```cpp
bool zoneIRData(int zone, const uint16_t** data, uint16_t* len, String* label) {
  if (zone < 0 || zone > 4) return false;
  const ZoneTarget& zt = zoneTargets[zone];
  const IRCode* c = findCode(zt.temp, zt.fan);
  if (!c) {
    Serial.printf("[IR] No captured code for %d°C fan=%d — zone %d skipped\n",
                  zt.temp, zt.fan, zone);
    return false;                     // fail closed
  }
  *data = c->data; *len = c->len;
  *label = String(zt.temp) + "C_" + fanName(zt.fan);
  return true;
}
```

Both callers — `handleIR` (auto) and the `irCommand` on-handler (power-on re-sync) — are
unchanged, since they already go through `zoneIRData`.

### 4.4 Extended `acConfig`

Backwards compatible: the handler already uses `containsKey`, so old payloads keep working.

```jsonc
{
  "coldBelow": 22, "normalMax": 24, "acceptableMax": 27, "nearCritMax": 29,
  "targets": [
    { "zone": 0, "temp": 28, "fan": "auto" },
    { "zone": 3, "temp": 22, "fan": "high" }
  ]
}
```

Applying `targets` must **reset `lastIRZone = IR_ZONE_NONE`**, so the next `handleIR` tick
re-fires with the new target rather than skipping on `zone == lastIRZone`.

### 4.5 New event — firmware reports what it actually has

Mirrors the existing `irChannelMap` pattern (sent on every connect, cached backend-side,
forwarded to browsers). This is what stops an admin selecting a code that doesn't exist.

```jsonc
// ESP32 → server, on connect
["irCodeLibrary", { "codes": [ {"temp":18,"fan":"auto"}, {"temp":18,"fan":"high"} ] }]
```

---

## 5. Backend

| File | Change |
|------|--------|
| `services/airconService.js` | Replace the `ZONE_TEMP` constant with `getZoneTargets()` (DB read + in-memory cache, reloaded on save). Add `saveZoneTargets(rows, userId)`. Add `setCodeLibrary()` / `getCodeLibrary()` alongside the existing channel-map cache. |
| `services/airconService.js` | `applyAutoIR` and `toggle`'s power-on re-sync read the configured target instead of `ZONE_TEMP[zone]`. |
| `services/airconService.js` | `getDeviceIRConfig()` returns `{ coldBelow, normalMax, acceptableMax, nearCritMax, targets }`. |
| `routes/aircon.js` | Extend `GET/PUT /aircon/ir-config` to carry `targets` too — one card, one atomic save. `GET /aircon` additionally returns `codeLibrary`. |
| `sockets/connectionHandler.js` | Handle `irCodeLibrary` from the device → cache + `io.emit` to browsers (copy the `irChannelMap` block). |

### Validation (`saveZoneTargets`)

1. Exactly zones 0–4, `target_temp` 16–30, `fan_mode` in the ENUM.
2. **Non-increasing across zones** — a hotter room must never get a *warmer* AC setting.
   Rejected with `400`, mirroring the ascending-boundaries rule.
3. If a code library has been reported, every `(temp, fan)` must exist in it → else `400`
   naming the missing combination. Skipped when the ESP32 has never connected.

---

## 6. UI — `pages/AirConditioner.tsx`

In the rule ladder, the read-only `set AC to 26°C Auto` becomes two selects:

```
● Normal   comfortable — gentle cooling
  room 22 – 24°C                    set AC to [ 26 °C ▾ ] [ Auto ▾ ]
```

- Options come from `codeLibrary`; the temp list filters by the chosen fan.
- ESP32 offline (no library reported) → render current values read-only with
  *"Connect the ESP32 to change targets"*.
- Admin-only, same gate as the boundaries. Reuses the existing dirty-tracking, the
  unsaved-changes recap, and the single **Save thresholds** button.

---

## 7. Rollout

1. Apply the migration — seeded with current values, so **nothing changes behaviourally**.
2. Ship backend + UI. Old firmware ignores `targets` (it uses `containsKey`), so the
   dashboard keeps working against an un-reflashed board.
3. Capture the codes (§2).
4. Reflash with the library. Configurable targets go live.

Steps 1–2 are safe to ship before any captures exist.

---

## 8. Open decisions

- **Fan per zone, or coupled to temperature?** This spec assumes independent — it costs
  more captures but avoids baking in today's Auto/High split.
- **Include Turbo?** The existing capture is corrupt and would need redoing.
- **Drop `ir_commands`?** Still unused (zero backend references). Approach C would use it
  to hold codes in MySQL and remove reflashing entirely — out of scope here, but this
  spec's `(temp, fan)` library is the natural precursor to it.
