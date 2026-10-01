# ESP32 WiFi provisioning (captive portal)

**Asked for by:** client + consultant.
**Problem:** WiFi credentials are compiled into `secrets.h`. ICTU staff can't use the Arduino IDE,
so every SSID change or redeployment needs us.
**Fix:** on first boot the ESP32 becomes a WiFi hotspot. The user joins it, a setup page opens,
they pick their network and type the password. Saved to flash. No reflash, ever again.

> **Status: BUILT 2026-09-17.** All nine build-order steps are done and the sketch compiles at
> **44 %** of program storage on Huge APP. The test checklist at the bottom is the part still
> outstanding — it needs the hardware.

---

## User flow

1. Power on with no saved config
2. ESP32 broadcasts an open AP — `CSPC-ICTU-Sensor-A4C1` (the suffix is the chip's MAC)
3. User connects from a phone; the setup page opens by itself (captive portal)
4. Page lists nearby networks → user picks one, types the password, also sets the backend IP
5. Saved to NVS → joins normally, portal gone
6. The box then **TCP-probes the backend address it was just given**, and re-opens the portal
   with the failure named on the form if nothing answers

---

## The library

**One library, and it is already installed on this machine.**

| | |
|---|---|
| **Name** | **WiFiManager** |
| **Author** | **tzapu** (maintainer: tablatronix) |
| **Version built against** | **2.0.17** |
| **Where** | Arduino IDE ▸ **Tools ▸ Manage Libraries…** ▸ search `WiFiManager` ▸ pick the one by **tzapu** ▸ Install |
| **Installed to** | `C:\Users\<you>\Documents\Arduino\libraries\WiFiManager` |

⚠️ **The Library Manager lists several things called "…WiFiManager".** The right one says
*"WiFi Configuration manager with web configuration portal for Espressif ESPx boards, by tzapu"*.
`AsyncWiFiManagerSimple`, `AyresWiFiManager` and the ESP8266-only forks are **not** it, and the
sketch will not compile against them — the parameter API is different.

It brings its own dependencies (`WebServer`, `DNSServer`) from the ESP32 core — nothing else to
install. Everything else the sketch needs is unchanged: DHT sensor library, Adafruit Unified
Sensor, ArduinoJson v6, WebSockets (Markus Sattler), RTClib, Adafruit NeoPixel, IRremoteESP8266.

Don't hand-roll this. It's a DNS hijack plus a web server plus per-platform captive-portal
quirks, all of which are solved.

---

## ⚠️ Board settings that are NOT stored in the sketch

Set these in the Arduino IDE **before** flashing. They are per-machine IDE settings, so anyone
who builds this on another PC has to set them again.

| Tools ▸ | Set to |
|---|---|
| Board | **ESP32 Dev Module** |
| **Partition Scheme** | **Huge APP (3MB No OTA/1MB SPIFFS)** ← **required** |
| Upload Speed | 921600 (or 115200 if uploads fail) |

**On the default partition scheme this will not fit.** The sketch was at ~94 % *before*
WiFiManager. The failure presents as a flashing error and reads like a code fault.

---

## ⚠️ Risks, worst first

**1. ~~Flash space~~ — RESOLVED. ✅**
Measured on **Huge APP (3MB No OTA / 1MB SPIFFS)**:

| | Flash | % | RAM |
|---|---|---|---|
| Before (step-1 gate, 2026-09-16) | 1,288,536 | 40 % | 52,008 (15 %) |
| **After (2026-09-17, feature complete)** | **1,415,844** | **45 %** | **52,296 (15 %)** |

WiFiManager plus the result page cost **+127 KB of flash and +288 bytes of RAM**. 1.73 MB still free. The sketch uses
no OTA and no SPIFFS, so the partition scheme costs nothing.

**2. Never block the sensor loop at runtime. — HONOURED.**
The portal is opened from `setupNetwork()`, called from `setup()`, and from nowhere else.

- Blocking at **first boot** is fine — nothing to monitor yet, no backend to reach.
- On a **runtime WiFi drop** the portal is *not* opened. The existing `WIFI_RETRY_MS` reconnect
  in `loop()` still owns that path, now reading `netSsid`/`netPass` instead of the `secrets.h`
  constants. Dropping into a blocking portal mid-operation stops sensor reads, the buzzer and
  IR — during a fire, that's the failure mode that matters.
- A **configured** box whose network is simply absent at boot does **not** open the portal
  either, for the same reason: that is a runtime condition that happened to occur at boot, and
  a three-minute AP would mean three minutes of a server room going unwatched.

**3. Open AP = anyone nearby can configure it.**
**Client's answer: open.** The window is small — it closes as soon as credentials are saved.
`AP_PASSWORD` in the sketch turns it into WPA2 in one line if that ever changes (≥ 8 chars,
print it on the enclosure).

**4. A wiped configuration with nothing to replace it.**
An earlier cut of this erased the stored credentials *before* opening the forced portal. An
admin who pressed BOOT and then got called away would have left a box that was offline until the
next power cycle. The old configuration is now only ever **replaced**, after a new one is proven
to associate — `runPortalRound` never erases on the way in.

---

## What gets stored

NVS, same mechanism as the MQ-2 baseline (`loadRo()` / `saveRo()`).
**Separate namespace** so a WiFi change can't wipe the gas calibration:

```cpp
#define NVS_NAMESPACE     "mq2cal"   // existing — untouched
#define NVS_NET_NAMESPACE "netcfg"   // new
```

| Key | Value | Why |
|---|---|---|
| `ssid` | WiFi SSID | user-set |
| `pass` | WiFi password | user-set |
| `host` | backend IP | LAN IP changes; used to be another reflash |
| `port` | backend port | rarely changes, but free to include |

The SSID and password are written from the **live connection** (`WiFi.SSID()` / `WiFi.psk()`),
not from the form, so what is stored cannot disagree with what actually associated.

---

## What moved out of `secrets.h`

| Constant | After | Reason |
|---|---|---|
| `WIFI_SSID` | → NVS, user-set | the point of the feature |
| `WIFI_PASSWORD` | → NVS, user-set | **also a security win** — the real one was committed at `5f5a084` and is still in git history. This stops WiFi passwords entering the repo at all. |
| `BACKEND_HOST` | → NVS, user-set | LAN IP changes |
| `BACKEND_PORT` | → NVS, user-set | same |
| `DEVICE_SECRET` | **stays compiled in** | must match `backend/.env` exactly. Not the user's to set, and a wrong value silently means the box never connects. |

`secrets.h.example` now ships `DEVICE_SECRET` only; the other four are **commented out** and
documented as optional fallbacks. The sketch `#ifndef`s each of them, so a `secrets.h` holding
nothing but `DEVICE_SECRET` compiles.

**The fallbacks are what keeps an already-flashed box working after the update** — nothing is in
NVS, so it comes up on the compiled-in network exactly as it used to instead of turning into an
access point the day it is updated. Anything saved through the portal wins over them
permanently, including across a reflash: NVS survives an upload.

> **Your own `secrets.h` was updated to the new shape on 2026-09-17.** `WIFI_SSID` /
> `WIFI_PASSWORD` are commented out (both pairs, values preserved in the comment), so a bench
> box behaves like one handed to ICTU: no saved network → the portal opens on first boot.
> `BACKEND_HOST` / `BACKEND_PORT` are left **defined** deliberately — with no WiFi fallback the
> portal opens with your backend IP already filled into the form, which is one less thing to
> retype every test. Un-comment a WiFi pair to go back to joining straight away.

---

## Integration points in `env_monitor_v2.ino`

| Was | Now |
|---|---|
| `const char* ssid/password/host/port` | `String netSsid/netPass/netHost` + `uint16_t netPort`, seeded from the `secrets.h` fallbacks |
| `WiFi.begin(ssid, password)` + 20-attempt loop in `setup()` | `setupNetwork()` — NVS → join, else portal |
| `socketIO.begin(host, port, …)` | `socketIO.begin(netHost.c_str(), netPort, …)`, **skipped entirely** when no backend address is configured (`socketConfigured`) |
| `loop()` edge detection + `WIFI_RETRY_MS` reconnect | **unchanged in shape**, now on `netSsid`/`netPass` and skipped when no SSID is set |
| `WIFI_RETRY_MS 15000` | unchanged |

New functions, all above `setup()`: `netUnset`, `loadNetConfig`, `saveNetConfig`,
`backendReachable`, `buildStatusBanner`, `portalButtonPressed`, `joinWiFi`, `portalApName`,
`runPortalRound`, `runProvisioningPortal`, `setupNetwork`.

---

## Re-configuring later

Once credentials are saved the portal never appears again — so there must be a way back.

### ⚠️ The plan originally said "hold BOOT during power-up". That does not work.

GPIO 0 is a **strapping pin**: held low at reset, the ESP32 ROM enters serial download mode and
the sketch never runs at all. The gesture is therefore:

> **Power the box on, wait for the LED to turn MAGENTA (~4 s), then press BOOT.**

```cpp
#define PORTAL_BUTTON_PIN       0
#define PORTAL_BUTTON_WINDOW_MS 4000
```

The LED cue exists so there is a moment to press *at* rather than a gesture to time blind. The
window is the only cost this adds to a normal boot, and boot already spends 20 s on the MQ-2
warm-up.

Portal timeout is **180 s** (`PORTAL_TIMEOUT_S`) so a box that boots with no one around gives up
and carries on with the saved network instead of sitting as an AP forever.

---

## The status page (client asked for it — answer: yes)

Two parts, both free of extra HTTP handlers:

1. **A status banner inside the setup form** (`buildStatusBanner`) — which network it is on, the
   IP it was given, the backend address, and whether that backend **answered**. Green border when
   healthy, red when the backend is silent. It is added as the FIRST `WiFiManagerParameter`, and
   `_paramsInWifi` is left at its default, so it renders on the **Configure WiFi** page directly
   above the *Backend IP* field — i.e. attached to the thing it is a verdict on.
2. **WiFiManager's built-in Info page**, enabled via `setMenu` — SSID, IP, signal, MAC, free
   heap.

On a BOOT-forced portal the box **joins the saved network and probes the backend before the
form is shown**, so the first thing on screen is a verdict on the configuration already
stored. It costs up to 10 s on a gesture somebody is standing there having made, and without
it the panel could only ever say "not connected" — useless for the one job it was asked to do.

And the part that makes it worth having: after each successful save the box **TCP-connects to
the backend address it was just given** (`backendReachable`, 3 s). If nothing answers it
**re-opens the portal** with the reason on the form, up to `PORTAL_BACKEND_ROUNDS` (2) extra
times, then carries on regardless — "the server is off right now" is a legitimate answer and
must not trap an installer in a loop. Dismissing the portal deliberately also ends the loop
(`PORTAL_UNCHANGED`).

A mistyped backend IP is otherwise **indistinguishable from a working install**: the box joins
WiFi, the LED goes green, and the readings go nowhere until somebody checks the dashboard.

---

## Client answers (2026-09-17)

| Question | Answer | Where it lives |
|---|---|---|
| Open AP or WPA2? | **Open** | `#define AP_PASSWORD ""` |
| AP name? | **`CSPC-ICTU-Sensor` + chip ID** | `AP_SSID_PREFIX` + `AP_SSID_UNIQUE 1` |
| Status page after setup? | **Yes** | banner + Info page + backend probe, above |

---

## Build order — all done

1. ✅ Switch to **Huge APP** partition scheme, rebuild unchanged, confirm it flashes — 2026-09-16
2. ✅ Install WiFiManager 2.0.17 (tzapu)
3. ✅ `netcfg` NVS namespace + `loadNetConfig`/`saveNetConfig` (mirroring `loadRo`/`saveRo`)
4. ✅ `setup()` WiFi block replaced by `setupNetwork()` + `secrets.h` fallback
5. ✅ Backend host + port as custom portal fields
6. ✅ `socketIO.begin()` on the NVS values
7. ✅ BOOT-button window + 180 s portal timeout
8. ✅ `secrets.h.example` — `DEVICE_SECRET` only, the rest documented as fallbacks
9. ✅ One-page setup sheet for ICTU — `iot/esp32/SENSOR-SETUP-SHEET.md`

---

# Testing it

Nothing below has been run — it all needs the hardware.

## Before you flash

1. **Arduino IDE ▸ Tools ▸ Partition Scheme ▸ "Huge APP (3MB No OTA/1MB SPIFFS)".**
   Without this the upload fails and it looks like a code error.
2. **Tools ▸ Manage Libraries ▸ `WiFiManager` by tzapu** — already installed here (2.0.17).
3. Open the **Serial Monitor at 115200**. Every step below prints a `[NET]` or `[WiFi]` line;
   the serial log is the fastest way to tell which branch the box took.
4. Have the backend running (`cd backend && nodemon src/server.js`) and know its **LAN IP** —
   `ipconfig` on the backend PC, the `IPv4 Address` of the adapter on the same network as the
   ESP32. Not `127.0.0.1`.

### To see first-boot behaviour on a box you have flashed before

NVS survives a reflash, so an already-provisioned box will *not* show the portal. Either:

- **press BOOT** during the magenta window (works always, changes nothing else), or
- **Tools ▸ Erase All Flash Before Sketch Upload ▸ Enabled**, flash once, then set it back to
  Disabled. ⚠️ This also erases the **MQ-2 clean-air baseline** — re-run Recalibrate from the
  dashboard afterwards. Pressing BOOT does not.

`WIFI_SSID` is already commented out of your `secrets.h`, so the fallback will not fire and the
box has no network to fall back to — which is what makes test 1 reproduce. Un-comment a WiFi
pair there if you want it to join straight away instead.

---

## The checklist

| # | Test | Do this | Expect |
|---|---|---|---|
| 1 | **Blank box** | Erase flash, flash, power on | Serial: `Nothing provisioned` → `Setup portal open`. AP **`CSPC-ICTU-Sensor-XXXX`** appears in the phone's WiFi list |
| 2 | **Captive portal** | Join that AP from a phone | The setup page opens by itself. If not, `http://192.168.4.1` |
| 3 | **Status banner** | Tap **Configure WiFi** | An amber-bordered *Sensor status* box at the top of the form: `WiFi: not connected`, `Backend: not set` |
| 4 | **Wrong WiFi password** | Pick your network, type a wrong password, Save, then **do nothing** | A countdown appears on the save page; after ~11 s a red panel replaces it **on that same page** — **"Not connected — The WiFi password is wrong"**. No navigation, no scrolling. Nothing saved; retry works |
| 4b | **5 GHz / absent network** | In the portal type an SSID that is not in range, Save, wait | `/sensorstate` says **"That network was not found"** and names 2.4 GHz as the likely cause |
| 4c | **Result page reachable directly** | While the portal is up, open `http://192.168.4.1/sensorstate` | The same verdict as a full standalone page — the recovery path when a phone gets knocked off the AP mid-attempt. `?raw=1` on the end returns the bare panel the script uses |
| 5 | **Correct password + backend IP** | Pick the network, right password, Backend IP = the backend PC's LAN IP, port `3001`, Save | Serial: `Saved to flash` → `[WiFi] IP: …` → **`Backend <ip>:3001 answered.`** The sensor appears on the dashboard within ~30 s |
| 6 | **Bad backend IP is caught** | Redo 5 with a deliberately wrong IP (e.g. `192.168.1.222`) | Serial: `did not answer — reopening the portal`. **The portal comes back with a RED banner** naming the address. Fix it, Save, and it goes through |
| 7 | **Power-cycle** | Unplug, plug in | Serial: `Provisioned: SSID "…"` → connects. **No AP.** Dashboard picks it up again |
| 8 | **Reflash keeps the config** | Upload the sketch again (Erase Flash **Disabled**) | Still connects on its own. NVS survived |
| 9 | **BOOT re-opens the portal** | Power on, wait for **magenta**, press BOOT | Serial: `PRESSED` → it joins the saved network first, prints `Current backend … answered.`, **then** opens the portal — pre-filled with the current backend IP and a **green** banner naming the network and IP it is on. That ~10 s join is deliberate: it is what lets the status panel say anything about the backend |
| 10 | **Dismissing the portal is safe** | Do 9, then let it time out (3 min) or tap **Exit** | Serial: `Portal closed without changes — the previous network is still up`. **The box keeps working** — it must not be left offline |
| 11 | ⭐ **Router pulled while running** | With the box running and sensing, power off the AP | **Buzzer, LED, sensor reads and IR all keep going. NO portal.** Serial: `[WiFi] Link lost` then `Down — retrying SSID: …` every 15 s. Rows go to the SD card |
| 12 | **Router back** | Power the AP on again | Reconnects on its own, `[SD]` replay lines, the gap fills in on the Environment chart |
| 13 | **Change the backend IP** | Move the backend to another PC, then do 9 and enter the new IP | Readings land on the new backend |
| 14 | **Gas calibration survives** | After 9, trigger **Recalibrate** history check — or just watch boot | Serial at boot: `[CAL] Loaded stored baseline: Ro1 … Ro2 …`, **not** `No stored baseline`. Separate NVS namespaces |
| 15 | **Two boxes at once** | Power up two blank boxes side by side | Two differently-suffixed APs, `CSPC-ICTU-Sensor-XXXX` / `-YYYY` |

**Test 11 is the important one.** It's the fire scenario: a blocking portal there would stop the
buzzer and the sensor reads.

### The `/sensorstate` result page — why it had to be written

**The problem.** `handleWifiSave()` answers with a fixed string — *"Saving Credentials. Trying to
connect ESP to network. If it fails reconnect to AP to try again"* — and only **then** attempts
the join, back in the portal loop. The page the installer is left staring at was written before
the result existed, so it structurally cannot contain it.

The verdict *is* rendered, by `reportStatus()`, but only on `/`, `/wifi`, `/param` and `/info`,
and on each of those it is appended **LAST** — below the menu buttons, or below the form and the
Scan link. On a phone that is off the bottom of the screen, on a page you first have to navigate
back to.

Net effect: **typing the password wrong looked exactly like typing it right.** For a feature
whose whole point is that one staff member can commission a box alone, that is the failure mode,
not a cosmetic gap.

**The fix**, entirely outside the library — nothing in `libraries/WiFiManager` is patched, so a
Library Manager update cannot silently revert it:

| Piece | How |
|---|---|
| `PORTAL_HEAD_SCRIPT` | Injected via `setCustomHeadElement`, which puts it in the head of every portal page. The script returns immediately unless `location.pathname` contains `wifisave`; there it appends a countdown, then `XMLHttpRequest`s `/sensorstate?raw=1` and drops the answer **into that same page**. No navigation — an automatic redirect is still a page changing under someone who is reading it. XHR, not `fetch`, because a captive-portal mini-browser is not a browser worth assuming much about. |
| Polling | The fragment is prefixed `P` (pending) or `D` (done), so the script re-polls every 3 s without parsing anything. A failed or timed-out XHR prints *"Lost contact with the sensor…"* with a link — words, where a redirect would have produced a browser error page. |
| `/sensorstate` | Our own route, registered on `wm.server` (it is **public**) from `setWebServerCallback`, which fires *after* the web server is created and *before* the library's routes — so this adds a path rather than shadowing one. `?raw=1` returns the bare panel for the in-page update; without it, a full standalone page — the recovery path when the phone loses the AP mid-attempt and the script cannot reach the box. |
| `sensorStatePage()` | A full page: connected/not, the SSID and IP, **and the backend TCP probe result**, with *Back to WiFi setup* / *Setup home* buttons. Self-refreshes every 3 s while the attempt is still running (`WL_IDLE_STATUS`). |

⚠️ The countdown is `PORTAL_CONNECT_TIMEOUT_S + 1`. **Change one and change the other**, or the
result page loads while the attempt is still in flight and reports *"Still trying…"* instead of
the answer.

⚠️ `res == 7` is WiFiManager's own `WL_STATION_WRONG_PASSWORD` kludge — the value is repeated
rather than referenced because the member is `protected`, and the ESP32 SDK has no
wrong-password status of its own (the library synthesises it from `WIFI_REASON_AUTH_FAIL` /
`AUTH_EXPIRE`). Where the SDK says nothing more specific the page says *Could not connect* and
points at the password first, because that is what it usually is.

**Not done:** `setBreakAfterConfig(true)`. It would close the portal on a failed attempt and
strand the installer with no AP to go back to. It stays at its default `false`.

**The countdown can still be beaten by the radio.** The ESP32 has one radio, so the soft AP
follows the STA to the target network's channel during a join — a phone can get knocked off
mid-attempt, and then the redirect fails. The result page is reachable directly at
`http://192.168.4.1/sensorstate` after rejoining, which is what §2b of the setup sheet tells
staff to do.

**Fastest check while testing is still serial** — WiFiManager's debug defaults to on
(`_debug = true`), so the `*wm:` lines report the result with no phone involved at all.

---

## Reading the serial log

| Line | Means |
|---|---|
| `[NET] Nothing provisioned — using the secrets.h defaults.` | NVS is empty. Either the fallbacks take over or the portal opens |
| `[NET] Provisioned: SSID "x"  backend 10.0.0.5:3001` | Read back from NVS — this is a configured box |
| `[NET] Press BOOT within 4s to re-run WiFi setup — no.` | The window passed unpressed. Normal |
| `[NET] Setup portal opening — join WiFi "CSPC-ICTU-Sensor-A4C1" (no password)` | The AP is coming up now (BOOT-forced, or a later round) |
| `[NET] Trying any stored credentials; failing that, the setup portal opens as …` | First-boot path. An AP appears only if the stored credentials do not work |
| `[NET] Current backend 10.0.0.5:3001 answered.` | Probed before the form was shown — this is what colours the banner |
| `[NET] Saved to flash: …` | The portal committed a configuration |
| `[NET] Backend 10.0.0.5:3001 answered.` | Something is listening. The address is right |
| `[NET] Backend … did not answer — reopening the portal to correct it.` | Wrong IP, wrong port, backend down, or a firewall |
| `[WiFi] Saved network unreachable — offline mode, loop() keeps retrying.` | Configured, but the AP is not there. **Deliberately not a portal** |
| `[NET] No backend address set — readings buffer to the SD card.` | Portal timed out on a blank box. `socketIO` was never begun |

---

## Still open

- **Nothing here has run on hardware.** The 15 tests above are the acceptance run.
- The AP is **open** per the client's answer. If ICTU later wants it locked, set `AP_PASSWORD`
  to ≥ 8 characters and print it on the enclosure — one line, no other change.
- `CLAUDE.md`'s ESP32 Firmware Notes section still describes `secrets.h` as holding
  `WIFI_SSID`/`WIFI_PASSWORD`/`BACKEND_HOST`/`BACKEND_PORT`. Update it once this is signed off
  on hardware.
