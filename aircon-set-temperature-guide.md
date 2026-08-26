   # Changing the AC Set Temperatures — Practical Guide

**Audience:** whoever has to answer "the client wants the aircon set to different
temperatures". Written to be followed step by step without reading the rest of the codebase.

---

## Read this first: two different settings people confuse

The AirConditioner page has **two** sets of temperature numbers, and only one of them is
what this guide is about.

| | What it is | Where you change it | Reflash? |
|---|---|---|---|
| **Room-temperature boundaries** — 22 / 24 / 27 / 29 °C | *When* the AC is re-targeted | **Dashboard** → AirConditioner → Auto-Cooling Thresholds (admin) | ❌ No |
| **Set temperatures** — 28 / 26 / 24 / 22 / 20 °C | *What the AC is set to* | Firmware + backend (this guide) | ✅ Yes |

If the client says *"start cooling harder earlier"*, that is the **first** row — an admin
edits it in the dashboard and it takes effect immediately. No developer needed.

Only if they say *"when it's hot, set the AC to 18 instead of 20"* do you need this guide.

### The current mapping

| Room temp | Zone | Set temp | Fan | IR array |
|---|---|---|---|---|
| < 22 °C | TOO_COLD (0) | **28 °C** | Auto | `IR_28C_AUTO` |
| 22–24 °C | NORMAL (1) | **26 °C** | Auto | `IR_26C_AUTO` |
| 25–27 °C | ACCEPTABLE (2) | **24 °C** | Auto | `IR_24C_AUTO` |
| 28–29 °C | NEAR_CRIT (3) | **22 °C** | High | `IR_22C_HIGH` |
| > 29 °C | CRITICAL (4) | **20 °C** | High | `IR_20C_HIGH` |

---

## Why you can't just edit a number

**Each set temperature *is* a recorded infrared waveform**, not a setting.

The AC's protocol decodes as `UNKNOWN` — no library can generate a command for it — so
every value is a real button-press captured off the Carrier remote and replayed verbatim
with `sendRaw()`. `IR_26C_AUTO` is 131 timing values that mean "26 °C, cool, auto fan" to
that specific unit. There is no arithmetic that turns it into 25 °C.

So the honest answer to "can we change it to 25?" is: **only if someone points the physical
remote at the receiver and records the 25 °C button.** That is Case B below.

> **Fan speed is baked in too.** `IR_22C_HIGH` means 22 °C *and* High fan — one button
> press, one waveform. You cannot change fan speed without a new capture either.

---

## Case A — re-point a zone at a temperature you already have

**Use when:** the client wants a zone to use one of the five temperatures already captured.
*Example: "in the CRITICAL zone set 22 instead of 20."*

No hardware, no remote, no capture. Two files, then reflash.

### A1. Firmware — `iot/esp32/env_monitor_v2/env_monitor_v2.ino`

In `zoneIRData()` (~line 643), point the zone at a different array. All three lines in the
`case` must change together — the array, the `sizeof`, and the label:

```c
    case IR_ZONE_CRITICAL:
      *irData = IR_22C_HIGH;                                   // was IR_20C_HIGH
      *irLen  = sizeof(IR_22C_HIGH) / sizeof(IR_22C_HIGH[0]);  // was IR_20C_HIGH
      *irLabel = "22C_HIGH";                                   // was "20C_HIGH"
      return true;
```

> The label is not cosmetic — it is what gets logged and shown in the aircon history
> ("Auto IR fired: 22C_HIGH (22°C)"). A stale label makes the log lie.

Also update the zone comment (~lines 267–271) so the file documents itself:

```c
#define IR_ZONE_CRITICAL 4    // > 29°C  → 22°C High
```

### A2. Backend — `backend/services/airconService.js` line 282

```js
const ZONE_TEMP = { 0: 28, 1: 26, 2: 24, 3: 22, 4: 22 };  // zone 4 was 20
```

> ⚠️ **This is the step people forget, and it fails silently.** The ESP32 decides what to
> transmit; the backend decides what to *write into the database and show on screen*. They
> are two independent copies of the same table. Get them out of sync and the dashboard
> reports "Set to 20 °C" while the unit is actually on 22 °C — and nothing anywhere errors.

### A3. Reflash the ESP32, restart the backend

Backend changes need a restart (`npm run dev` picks it up automatically).

---

## Case B — a temperature with no captured code

**Use when:** the client wants a value that isn't one of the five.
*Example: "set 18 °C in the critical zone."*

You need the **physical Carrier remote** and the ESP32 with an IR receiver.

### B1. Wire up and flash the learner

1. Open `IRLearner.ino` (repo root) and flash it to the ESP32.
   **Wiring:** IR receiver **GPIO 15** · IR LED **GPIO 19** · push button **GPIO 4**
   (to GND — it uses `INPUT_PULLUP`) · buzzer **GPIO 2**.
2. Open Serial Monitor at **115200**. You should see `FLIPPER STYLE AC IR TOOL READY`.

### B2. Capture — you must HOLD the button the whole time

⚠️ **This is the step that catches people out.** The capture code sits *inside* the
"button is currently held down" branch (`IRLearner.ino:224`), so learning mode being ON is
not enough — the button has to still be **pressed** when the remote fires. Let go and
nothing is captured, with no error to tell you why.

1. On the remote, set **exactly** the state you want: temperature, **Cool**, and fan speed.
2. **Press and hold** the button. After ~0.7 s it beeps and prints
   `=== LEARNING MODE ON ===` / `Waiting for IR signal...`.
3. **Still holding**, point the remote at the receiver (~10 cm) and press the button on the
   remote that transmits that state.
4. It beeps again and prints `IR SIGNAL RECEIVED!` followed by a `uint16_t rawData[] = {…}`
   block. Copy that block.
5. Release the button.

**Do the capture in a dim room.** Sunlight and fluorescent lamps flood the receiver at
mains frequency (~60 Hz) and corrupt the timings. Two earlier capture attempts failed for
exactly this reason.

### B3. Replay it at the AC before you touch any code

This is the whole reason the learner has a replay function, and it saves a wasted
reflash — you find out *now* whether the capture actually drives the unit.

- With a code captured, give the button a **short press** (under 0.7 s). The serial log
  prints `REPLAYING SIGNAL...` and the IR LED on **GPIO 19** transmits it.
- **Watch the AC.** Its display should change to the temperature and fan you recorded.

If the AC does not react:
- Try `detectedFrequency = 36;` at the top of `IRLearner.ino` (a few units use 36 kHz).
- Re-capture in darker conditions.
- Check the IR LED is on GPIO 19 and actually lit (phone cameras see IR — point one at it).

**Do not proceed until the replay works.** A capture that does not drive the AC from the
learner will not drive it from the firmware either.

### B4. Verify the numbers before pasting

A bad capture is silent — the firmware transmits it happily and the AC ignores it.

- **Exactly 131 values.** All seven existing codes have exactly 131 (verified). A different
  count means ambient IR corrupted the frame — recapture, don't "fix" it by hand.
- **Header ≈ `9000, 4500`** as the first two values.
- **Structural check (optional):** all seven existing frames satisfy the same invariant —
  bits 61–63 are the complement of bits 53–55. `ir_analyze.py` in the repo root is the
  helper used to work that out; run your new frame through it if you want extra confidence.

### B5. Add the array

In `env_monitor_v2.ino`, next to the others (~lines 355–480):

```c
// 18°C Cool High fan  (Critical zone)
const uint16_t IR_18C_HIGH[] = {
  9000, 4500, 550, 600, ...   // your 131 values
};
```

### B6. Point the zone at it

Same as **A1**, using your new array name and label (`"18C_HIGH"`).

### B7. Update `ZONE_TEMP`

Same as **A2** — `{ 0: 28, 1: 26, 2: 24, 3: 22, 4: 18 }`.

### B8. If you can't capture it yet

Do **not** leave a placeholder array in place — the firmware would transmit a meaningless
waveform. Use the pattern already in the file for this exact situation:

```c
#define IR_18C_HIGH_CAPTURED 0   // flip to 1 once a clean 131-value capture is pasted
```

`zoneIRData()` returns `false` when the flag is 0, and the unit simply **holds its previous
setting** instead of receiving noise. See the `IR_ZONE_CRITICAL` case for the working
example.

---

## Also update (so the system stops contradicting itself)

These don't affect behaviour, but leaving them stale means the UI and the docs tell the
client something untrue.

| File | What to change |
|---|---|
| `frontend/src/pages/AirConditioner.tsx` ~line 922 | The help text lists `(28 / 26 / 24 / 22 / 20°C)` to users |
| `CLAUDE.md` | The **IR Zone → Set Temperature** table |
| `Environment.md` §5 | If it repeats the table |

---

## Checklist

```
[ ] Decided: Case A (re-point) or Case B (new capture)?
[ ] Case B only: captured while HOLDING the button, in a dim room
[ ] Case B only: short-press replay actually drove the AC
[ ] Case B only: exactly 131 values, header 9000/4500
[ ] env_monitor_v2.ino — array added (Case B)
[ ] env_monitor_v2.ino — zoneIRData(): array + sizeof + label all updated
[ ] env_monitor_v2.ino — IR_ZONE_* comment updated
[ ] airconService.js:282 — ZONE_TEMP matches the firmware exactly
[ ] AirConditioner.tsx help text updated
[ ] CLAUDE.md table updated
[ ] ESP32 reflashed
[ ] Backend restarted
[ ] Tested (below)
```

---

## Testing without waiting for the weather

You do not need the room to actually reach 30 °C.

1. Open the **AirConditioner** page as admin.
2. In **Auto-Cooling Thresholds**, temporarily drag the boundaries so the *current* room
   temperature falls in the zone you changed. (This is a dashboard setting — it pushes to
   the ESP32 instantly, no reflash.)
3. Watch:
   - **Serial Monitor** → `[IR] Sent 22C_HIGH to N enabled channel(s).`
   - **Dashboard** → the unit's *Set Temp* tile shows your new value.
   - **The AC itself** → its display shows the new temperature.
4. **Put the boundaries back.**

If the serial line and the dashboard disagree, `ZONE_TEMP` and `zoneIRData()` are out of
sync — go back to A2.

> **IR fires only on a zone *change*.** Nudging the boundary within the same zone does
> nothing. Cross a boundary to trigger it.

---

## Gotchas

**The sketch is at ~94 % of program storage.** Each new 131-value array is ~262 bytes of
flash. If it stops fitting: Arduino IDE → **Tools ▸ Partition Scheme ▸ "Huge APP (3MB No
OTA)"**, or set `SD_ENABLED 0` to compile out the offline buffer.

**Power is manual-only.** Auto IR only re-targets units that are already **ON**. A unit
someone switched off stays off — `applyAutoIR` never changes `is_on`.

**Switching a unit back on re-sends the current zone's code.** `zoneIRData()` is shared by
both the auto path and the power-on re-sync, so fixing it in one place fixes both. Nothing
extra to do.

**Keep set temps at or below the alert thresholds.** If the temperature *warning* rule is
30 °C and the hottest zone sets the AC to 28 °C, the room can sit in a permanent alert the
cooling can never clear.

**The ESP32 currently needs reflashing anyway.** `DEVICE_SECRET` was rotated on 2026-08-26
and `iot/esp32/env_monitor_v2/secrets.h` already holds the new value — the board is still
carrying the old one and cannot connect until it is flashed. Fold that into whichever
reflash you do next.

---

## If the client wants this without a developer

There is a written design for making set temperatures admin-configurable from the
dashboard: **`aircon-configurable-targets.md`** (Approach A). It turns the five constants
into a *library* of captured codes indexed by `(temp, fan)`, and lets the dashboard pick
which entry each zone points at.

It is **deliberately not built**. It does not remove the capture requirement — you still
need a recording per temperature you want to offer — it only moves the *choice* into the
UI. Worth doing if the client expects to retune this repeatedly; not worth it for a
one-off change, which is what Case A and Case B above are for.
