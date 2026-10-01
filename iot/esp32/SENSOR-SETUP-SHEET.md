# CSPC-ICTU Server Room Sensor — setup sheet

**For:** whoever installs or moves the sensor box.
**You need:** a phone, and the backend server's IP address. No laptop, no Arduino IDE.

---

## 1. Set it up (first time)

1. **Plug the box in.** The LED goes blue, then **magenta**, then blue again.
2. Wait about 20 seconds. When the box has no WiFi saved it turns itself into a WiFi
   hotspot called:

   > **`CSPC-ICTU-Sensor-XXXX`**
   > (`XXXX` is different on each box — that is how you tell two of them apart.)

3. **On your phone, join that WiFi.** It has no password.
4. A setup page **opens by itself**. If it does not, open a browser and go to
   **`http://192.168.4.1`**.
5. Tap **Configure WiFi**. You get:

   | Field | What to put in it |
   |---|---|
   | (network list) | Tap the server room's WiFi — **2.4 GHz only**, the box cannot see 5 GHz networks |
   | Password | That network's password |
   | **Backend IP** | The IP of the PC running the monitoring server, e.g. `192.168.1.10` |
   | **Backend port** | `3001` unless ICTU has changed it |

6. Tap **Save**. The hotspot disappears and the box joins the network.
7. Open the dashboard. The sensor should appear within about a minute.

**That's it — it never asks again.** It reconnects on its own after a power cut.

---

## 2. If the backend IP was wrong

The box checks it for you. If nothing answers at the address you typed, **the setup page
comes straight back**. Tap **Configure WiFi**: a red-edged *Sensor status* panel sits
**directly above the Backend IP box**, saying so:

> **Sensor status**
> WiFi: GREGORIO WIFI 2.4G — 192.168.100.55
> Backend: 192.168.1.10:3001 — **NO ANSWER**. Check the IP, and that the dashboard server
> is running.

Correct the address and save again. You get two tries; after that the box carries on
anyway (readings are kept on its memory card meanwhile) and you can come back to it with
step 3.

The same panel shows a green line when everything is right — which network it joined, the
IP it was given, and that the backend answered.

---

## 2b. After you tap Save — the result page

The page says *"Saving Credentials — Trying to connect…"* and starts a **countdown**. Leave
it alone. After about 10 seconds the answer appears **on that same page**, in plain words.
You do not have to go back, reload, or look anywhere else.

| Result page says | It means | What to do |
|---|---|---|
| ✅ **Connected to <network>** — *Backend … answered. This sensor is ready* | Everything worked | Nothing. Check the dashboard |
| ⚠️ **Connected**, but *Backend … did not answer* | WiFi is fine, the **backend IP is wrong** or the server is off | Tap **Back to WiFi setup**, fix the Backend IP |
| ❌ **Not connected** — *The WiFi password is wrong* | Password typo | Tap **Back to WiFi setup**, retype it |
| ❌ **Not connected** — *That network was not found* | Out of range, or it is a **5 GHz** network | Pick a 2.4 GHz network, or move the box closer |
| ❌ **Not connected** — *Could not connect* | The box could not tell which | Try the password first |
| 🔵 **Still trying…** | Not finished yet | Nothing — the page refreshes itself |

**Nothing is saved when it fails**, so you can retry as many times as you like. Two buttons
at the bottom of that page: **Back to WiFi setup** and **Setup home**.

> If it says **"Lost contact with the sensor while it was connecting"**, your phone dropped
> the sensor's WiFi while the box was busy. That is normal and nothing is broken — rejoin
> `CSPC-ICTU-Sensor-XXXX` and tap the link, or open **`http://192.168.4.1/sensorstate`**.
> Same answer, on its own page.

---

## 3. Change the WiFi or the backend IP later

1. **Plug the box in** — do **not** hold any button yet.
2. Watch the LED. After about 4 seconds it turns **MAGENTA**.
3. **While it is magenta, press the BOOT button** (the small button marked `BOOT` or
   `IO0`).
4. The setup page comes back. Carry on from step 1.4 above.

> ⚠️ **Do not hold BOOT while plugging the box in.** That puts the ESP32 into programming
> mode and it stops running altogether — nothing will happen until you unplug it and try
> again properly.

---

## 4. What the LED is telling you

**While it is starting up or being set up:**

| Colour | Meaning |
|---|---|
| **Blue** (dim) | Starting up |
| **Magenta** | Press BOOT *now* to change the WiFi — or the setup page is open and it is still trying |
| **Red** | Setup failed — wrong WiFi password, or that network was not found |
| **Orange** | On WiFi, but the backend did not answer — check the Backend IP |
| **Green** | Connected and the backend answered |

> The setup colours only update while the setup page is open on a phone. If you saved and
> walked away, the light stays magenta — that does not mean it failed. Serial, or the
> dashboard, is the check.

**Once it is running and watching the room:**

| Colour | Meaning |
|---|---|
| **Green** | Everything normal |
| **Green with a short blue blink every 5 s** | The room is fine, but **readings are not reaching the dashboard** — WiFi or the server is down. Nothing is lost; readings are kept on the memory card and sent when the link is back |
| **Blue** (bright, steady) | Room is too cold |
| **Yellow** | Warning — temperature, humidity or gas is climbing |
| **Orange** | Humidity is critical |
| **Red** | Critical — heat or smoke. The buzzer is on. |

> ⚠️ The blink **never** interrupts a warning or a critical colour. If the room needs
> attention the light stays solid on its own colour, so a connection problem can never hide
> a fire.

---

## 5. If it will not connect

| What you see | What it means | What to do |
|---|---|---|
| Hotspot never appears | The box already has WiFi saved | Use section 3 (BOOT button) |
| Hotspot appears every time you power it on | Nothing was saved | Re-run section 1 and make sure you tap **Save** |
| Your network is not in the list | It is 5 GHz, or out of range | Use a 2.4 GHz network; move the box closer to the AP |
| Saved, but the sensor never shows on the dashboard | Wrong backend IP, or the server is off | Section 3, then re-enter the Backend IP |
| Setup page does not open by itself | Phone is not following the redirect | Open `http://192.168.4.1` in a browser |

Nothing is lost while it is offline: readings are written to the box's memory card and
sent up as soon as the link is back.

---

## 6. What the box never asks you for

The **device secret** — the value that proves this box is ours to the server — is built
into the firmware and is not on this page. If it is ever changed on the server, the box
has to be re-flashed by the development team. Everything else on this sheet is yours to
change.
