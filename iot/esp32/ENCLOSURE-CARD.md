# SENSOR BOX — QUICK GUIDE

Keep this card on the box. Everything here is done from the **dashboard** or with a
**screwdriver**. No laptop, no programming. Full setup: `SENSOR-SETUP-SHEET.md`.

---

## 1. What the light means

**Starting up (first 30 seconds)**

| Light | Meaning |
|---|---|
| Blue, dim | Booting. Wait about 20 seconds |
| **Magenta** | Press **BOOT** now if you want to change the WiFi — 4 seconds only |
| Red | WiFi failed — wrong password, or network not found |
| Orange | On WiFi, but the server did not answer — Backend IP is wrong |
| Green | Connected. Nothing to do |

**Running**

| Light | Meaning |
|---|---|
| Green | Normal |
| Green + blue blink every 5 s | Readings are not reaching the dashboard. Nothing is lost — they are saved on the memory card |
| Blue, bright | Room too cold |
| Yellow | Warning — heat, humidity or gas rising |
| Orange | Humidity critical |
| **Red** | **Critical — heat or smoke.** Buzzer is on |

**Buzzer:** one continuous tone = smoke. Fast beeping = heat or humidity critical.
Slow beeping = warning. The blue blink never covers an alarm.

---

## 2. Add a smoke sensor (MQ-2)

4 channels, 2 are fitted. **CH is what the dashboard calls them** — the GPIO column is only for whoever wires it.

| CH | Wire AOUT to | Printed on the board |
|---|---|---|
| 1 | GPIO 34 | `34` — fitted |
| 2 | GPIO 35 | `35` — fitted |
| 3 | GPIO 36 | `VP` |
| 4 | GPIO 39 | `VN` |

1. **Unplug the box.**
2. Wire it: `VCC → 5V`, `GND → GND`, `AOUT → that CH's pin` **through the 10k / 20k divider**.
3. Plug in, wait for green.
4. Dashboard → **Environment → Add smoke sensor** (admin).
5. Pick the CH you wired, give it a location name, save.
6. Press **Recalibrate gas** — only when the air is clean.

> ⚠️ Never wire AOUT straight to the board. The sensor puts out 5 V, the pin takes 3.3 V.
> The channel stays off until step 5 — an empty pin picks up noise that can read as smoke.
> To remove: same screen → **Remove sensor**.

---

## 3. Add an IR transmitter (aircon)

4 channels, 2 are fitted. **CH is what the dashboard calls them.**

| CH | Wire the signal pin to | |
|---|---|---|
| 1 | GPIO 25 | fitted |
| 2 | GPIO 33 | fitted |
| 3 | GPIO 32 | free |
| 4 | GPIO 15 | free |

1. **Unplug the box.**
2. Wire it: `VCC → 5V`, `GND → GND`, `DATA → that CH's GPIO`.
3. Aim it at the aircon's remote sensor — clear line of sight, like pointing a remote.
4. Plug in, wait for green.
5. Dashboard → **Air Conditioner → Add Aircon** (admin).
6. Pick the CH you wired, name the unit, save.

> The transmitter does nothing until step 6.

---

## 4. Change a setting

| What | Where |
|---|---|
| WiFi / Backend IP | On the box — section 5 |
| Alarm levels (temp, humidity, gas) | Dashboard → **Alert Rules** (admin) |
| When the aircon kicks in | Dashboard → **Air Conditioner → Auto-Cooling Thresholds** (admin) |
| Smoke baseline, after moving the box | Dashboard → **Environment → Recalibrate gas** |
| Device secret | Firmware — call the dev team |

No reflash needed except the last one. Changes reach the box in seconds.

---

## 5. Change the WiFi or server address

1. Plug the box in — **do not touch any button yet**.
2. After about 4 seconds the light turns **magenta**.
3. While it is magenta, **press BOOT once** (marked `BOOT` or `IO0`).
4. On your phone, join the WiFi `CSPC-ICTU-Sensor-XXXX` (no password). The setup page opens
   by itself — if not, go to `http://192.168.4.1`.
5. **Configure WiFi** → pick the network (**2.4 GHz only**), type the password, enter the
   **Backend IP** and port `3000`.
6. **Save**, and wait for the page to say *Connected*.

> ⚠️ Do **not** hold BOOT while plugging in. That puts the chip in programming mode and it
> stops running. Unplug and start again.

---

## 6. Never

- Wire anything while the box is plugged in.
- Wire an MQ-2 AOUT straight to the board — use the divider.
- Hold BOOT while powering on.
- Remove the coin cell from the clock module.
- Use a 5 GHz WiFi network.
- Use any pin not listed on this card.

---

## 7. If something is wrong

| You see | Do this |
|---|---|
| Orange at startup | Backend IP wrong → section 5 |
| Red at startup | Wrong password, or a 5 GHz network → section 5 |
| Blue blink for a long time | Server or network is down. Readings are safe on the card |
| New sensor reads nothing | Not added on the dashboard → section 2, step 4 |
| New sensor reads a strange high value | **Recalibrate gas** in clean air |
| Aircon does not respond | Check the aim, and that the unit is registered → section 3 |
| Box never appears on the dashboard | Section 5, and check the server is running |

Anything else — contact ICTU or the development team.
