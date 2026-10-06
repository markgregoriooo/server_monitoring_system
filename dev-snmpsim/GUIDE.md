# How to Use the SNMP Simulator (Fake Router & UPS) — Step-by-Step Guide

This guide is for **developing and testing the Router & UPS monitoring without the real
hardware**. The real router and UPS are on campus; this lets you build and test everything
at home.

**The idea in one line:** a small program (`snmpsim`) runs on your PC and *pretends to be*
a router and a UPS. It answers the exact same questions the monitoring system asks a real
device, so the system can't tell the difference. You see live graphs, battery %, and alerts
— all fake, all on your laptop.

---

## Before you start (already installed once)

You need these on your PC. They are already set up on this machine:

| Tool | Check it's there | If missing |
|------|------------------|------------|
| Python | `python --version` | install from python.org |
| The simulator | `snmpsim-command-responder --help` | `pip install snmpsim-lextudio` |
| Node.js | `node --version` | install from nodejs.org |
| MySQL + InfluxDB | running locally | needed by the backend |

All the simulator files live in the **`dev-snmpsim/`** folder of the project.

---

## The 4 steps to get live data on the dashboard

### Step 1 — Start the simulator

Open a terminal **in the project folder** and run this. Leave the terminal open — the
simulator keeps running here.

**PowerShell (Windows):**
```powershell
snmpsim-command-responder --data-dir="dev-snmpsim\data" --agent-udpv4-endpoint=127.0.0.1:1161 --log-level=error
```

> ⚠️ **On Windows use BACK-slashes** (`dev-snmpsim\data`), not forward slashes. With a
> forward slash, snmpsim tries to put its index cache in a folder that doesn't exist and
> crashes with a `dbm`/`Flag must be one of 'r','w','c','n'` error.

✅ **Success looks like:** a line saying
`Listening at UDP/IPv4 endpoint 127.0.0.1:1161`.
It then just sits there (that's correct — it's waiting for the monitoring system to ask it
questions).

> You may see two red `redis`/`sql` "load FAILED" lines. **Ignore them** — those are optional
> features we don't use. As long as you see the "Listening…" line, it's working.

> **Why port 1161 and not 161?** Port 161 (the real SNMP port) needs administrator rights on
> Windows. 1161 works without admin and is otherwise identical.

---

### Step 2 — Tell the monitoring system the fake devices exist (first time only)

The system doesn't know about these fake devices yet. Add them to the database **once**, in
a **new** PowerShell window (the simulator is still running in the other one).

> ⚠️ The classic `mysql ... < file.sql` form does **not** work in PowerShell (no `<` redirect),
> and `mysql` is often not on your PATH. Use the full path + `-e "source ..."` instead.

**PowerShell + XAMPP** (root password blank by default):
```powershell
& "C:\xampp\mysql\bin\mysql.exe" -u root "cspc-ictu-monitoring-system" -e "source dev-snmpsim/seed-dev-devices.sql"
```
*(Adjust the path/user/db name if your MySQL lives elsewhere — check `backend/.env` for
`DB_USER` / `DB_NAME` / `DB_PASSWORD`. If a password is set, add `-p` and type it at the prompt.)*

**Or via phpMyAdmin** (http://localhost/phpmyadmin): select the `cspc-ictu-monitoring-system`
database → **Import** tab → choose `dev-snmpsim/seed-dev-devices.sql` → **Go**.

This adds two devices, both pointing at the simulator (`127.0.0.1`):
- **DEV Router (sim)** — with two ports, ether1 and ether2
- **DEV UPS (sim)**

> To undo this later: `DELETE FROM devices WHERE location = 'DEV - snmpsim';`

---

### Step 3 — Start the backend and frontend

In **separate** terminals:

```powershell
# Backend  (npm install first — the net-snmp library may be missing)
cd backend
npm install
nodemon src/server.js
```

```powershell
# Frontend
cd frontend
npm run dev
```

---

### Step 4 — Open the dashboard

Go to the **Network** page and the **UPS** page.

✅ **Within about 60 seconds** (one poll cycle) you should see:
- **Network page:** the DEV Router online, ether1/ether2 up, and **throughput graphs that
  actually move** (the fake traffic counter keeps climbing).
- **UPS page:** the DEV UPS online, **100% battery**, ~45 min runtime, **42% load**, on mains.

If it still says Offline after a minute or two, see **Troubleshooting** below.

---

## Optional — quick check the simulator works (without the backend)

If you just want to confirm the simulator itself is answering, run the included test:

```powershell
cd dev-snmpsim
npm install
node verify.cjs
```

It prints the router and UPS values and shows the traffic counter increasing.

---

## Testing alerts and failures (the useful part)

Open the files in `dev-snmpsim/data/` in any text editor and change a number.
**No restart needed** — the simulator re-reads the file on every request, so just save and
wait for the next poll (~60s).

| You want to test… | Open this file | Find this line | Change it to |
|-------------------|----------------|----------------|--------------|
| 🔴 **UPS on battery** (critical alert) | `data/dev-ups.snmprec` | `...33.1.4.1.0\|2\|3` | `3` → `5` |
| 🟡 **UPS low battery** (warning alert) | `data/dev-ups.snmprec` | `...33.1.2.4.0\|2\|100` | `100` → `15` |
| 🔴 **Router port goes down** | `data/dev-router.snmprec` | `...2.2.1.8.2\|2\|1` | `1` → `2` |
| ⚫ **Device unreachable / offline** | — | (nothing to edit) | just **stop the simulator** (Ctrl-C) |
| 📈 **Heavier traffic** | `data/dev-router.snmprec` | the `...1.1.6.x` / `...1.1.10.x` lines | raise the `rate=` number (bytes/sec) |

After you finish testing, change the numbers back to their healthy values (`3`, `100`, `1`).

---

## How to stop everything

- **Simulator:** press `Ctrl-C` in its terminal.
- **Backend / frontend:** `Ctrl-C` in their terminals.
- **Remove the fake devices from the DB:** `DELETE FROM devices WHERE location = 'DEV - snmpsim';`

---

## Troubleshooting

| Problem | Likely cause | Fix |
|---------|--------------|-----|
| Device shows **Offline** on the dashboard | simulator not running, or wrong port | make sure Step 1 is running and shows "Listening… 127.0.0.1:1161" |
| Backend **crashes on startup** with "Cannot find module 'net-snmp'" | backend dependency missing | run `npm install` inside `backend/` |
| `snmpsim-command-responder` **not found** | simulator not installed / PATH issue | `pip install snmpsim-lextudio` |
| Simulator **crashes with a `dbm` / "Flag must be one of 'r','w','c','n'"** error | used a forward slash in `--data-dir` on Windows | use a **back**slash: `--data-dir="dev-snmpsim\data"` |
| Dashboard device **online but no numbers** | community string mismatch | the DB community must be `dev-router` / `dev-ups` (see `seed-dev-devices.sql`) |
| `node verify.cjs` says **VERIFY FAILED** | simulator not running | start Step 1 first |
| Graphs are **flat (no movement)** | counters not increasing | normal right after start — wait 2–3 poll cycles for the rate to show |

---

## When you finally get to campus (switch to real devices)

1. Remove the fakes: `DELETE FROM devices WHERE location = 'DEV - snmpsim';`
2. Register the real devices from the dashboard (**Add router** / **Add UPS**, admin) with
   their IP, SNMP community and port **161**. **Test connection** checks them first.
3. **Nothing else changes** — the poller, dashboard pages, and alerts are identical. Only the
   device rows in the database are different.

That's the whole point of the simulator: by the time you reach campus, everything is already
built and tested, and you just swap fake devices for real ones.
