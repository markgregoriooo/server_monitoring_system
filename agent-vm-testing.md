# Testing the Agent in a Virtual Machine

A VirtualBox VM running Ubuntu Server is the cheapest way to exercise the **whole**
Linux path — binary, `install.sh`, the systemd unit, enrollment, approval and live
metrics — without touching a machine anyone depends on. It is the same procedure a
real server gets; only the "how do I reach it" plumbing differs.

> Installing on a **real** server? Use `agent/dist/cspc-agent-linux/RUN-ME.txt`.
> This file is the dev/test wrapper around it.
> Feature internals → `server-metrics.md`. Agent build/ship model → `agent/README.md`.

---

## 1. What you need

| | |
|---|---|
| VirtualBox | with a VM running **Ubuntu Server 22.04** (no desktop needed) |
| The backend | running on your PC — `cd backend && node src/server.js` |
| An install key | dashboard → **Server Metrics → Agent install keys → + New key** |
| The hand-off folder | `agent/dist/cspc-agent-linux/` (build it with `make package`) |

Find your PC's LAN address first — it is what the VM will post to:

```powershell
ipconfig            # or: Get-NetIPAddress -AddressFamily IPv4
```

Examples used below: backend `192.168.100.9`, VM `192.168.100.47`, user `markgregorio`.

---

## 2. Network: pick one

### Bridged (recommended)

The VM gets its own LAN address and looks like a real server on the dashboard —
its own IP, its own MAC, reachable from your PC for `scp`.

**VM must be powered off** (not saved state), then:

```
Settings → Network → Adapter 1
  Attached to : Bridged Adapter
  Name        : <your Wi-Fi or Ethernet card, e.g. "Intel(R) Wi-Fi 6E AX211 160MHz">
  Adapter Type: Intel PRO/1000 MT Desktop (82540EM)   (default — Ubuntu has this driver)
  Promiscuous : Deny  (default)
```

Boot the VM and check it got a LAN address:

```bash
ip a | grep "inet "        # expect 192.168.100.x
```

### NAT (fallback)

Use this if *Bridged Adapter* is missing from the dropdown, or if your Wi-Fi router
isolates clients from each other. Under NAT the VM reaches your PC at the fixed
alias **`10.0.2.2`**, so the backend URL becomes `http://10.0.2.2:3000`.

NAT is one-way — your PC cannot reach the VM — so add a port forward if you want
SSH/`scp`:

```
Settings → Network → Adapter 1 → Advanced → Port Forwarding → +
  Name: ssh   Protocol: TCP   Host Port: 2222   Guest Port: 22
```

Then `ssh -p 2222 user@127.0.0.1` and `scp -P 2222 …` from your PC.

> The dashboard will show every NAT VM as `10.0.2.15`. Harmless for a test — device
> identity is keyed on MAC/hostname, not IP — but bridged reads better.

---

## 3. Prove the VM can reach the backend

**Do this before anything else.** Nothing works until it returns JSON:

```bash
curl http://192.168.100.9:3000
# {"error":"Route not found"}      ← correct: the backend answered
```

| Symptom | Cause |
|---|---|
| Hangs, no output | Backend not running, or the host firewall drops port 3000, or the router isolates clients (switch to NAT + `10.0.2.2`) |
| `Connection refused` | You reached the PC but nothing is listening — start the backend |
| `Could not resolve host` | You pasted a placeholder like `<domain>` instead of the real IP |

Windows firewall needs an inbound allow rule for TCP 3000 (this repo's is named
*Node SocketIO*).

---

## 4. Get the folder into the VM

Ubuntu Server has no desktop and the VirtualBox console window has **no clipboard**,
so do everything over SSH — then pasting a 50-character install key is trivial.

```bash
# in the VM (console)
sudo apt update
sudo apt install openssh-server
whoami                                  # note the username
```

> `install: invalid option --y` means the word `apt` was missing — `install` on its
> own is a different Linux program.

```bash
# on your PC (Git Bash), bridged:
cd "…/server-infrastructure-monitoring-system-webSystem/agent"
scp -r dist/cspc-agent-linux markgregorio@192.168.100.47:~/

# …or NAT with the port forward from §2:
scp -P 2222 -r dist/cspc-agent-linux markgregorio@127.0.0.1:~/
```

First connection asks to trust the host key — type `yes`. Then work inside the VM
over SSH from here on:

```bash
ssh markgregorio@192.168.100.47
```

**From a USB stick instead** (no network path): `lsblk` → `sudo mount /dev/sdb1
/mnt/usb` → `cp -r /mnt/usb/cspc-agent-linux ~/` → `sudo umount /mnt/usb`. The same
steps are in the shipped `RUN-ME.txt`.

---

## 5. Install and approve

```bash
cd ~/cspc-agent-linux
sudo bash install.sh http://192.168.100.9:3000 AIK-your-key-here
```

It installs to `/opt/cspc-agent`, registers, and blocks on:

```
registered as device_id=N — waiting for admin approval...
```

Approve it on the dashboard as an **admin**:

**Server Metrics → Pending agent approvals → Approve**

The command then finishes on its own, writes the systemd unit and starts it.

```bash
systemctl status cspc-agent
journalctl -u cspc-agent -f     # "metrics sent (cpu=… mem=… disk=…)" every 10s
```

The VM appears Online on Server Metrics within ~10 seconds, with every mounted
filesystem in its Volumes panel.

---

## 6. Worth testing while you have a disposable server

The VM is the only place you can break things freely — use it for the paths that are
hard to demonstrate otherwise:

| Test | How | Expected |
|---|---|---|
| **Outage backfill** | Stop the backend (Ctrl-C), wait a few minutes, start it again | Agent logs `send attempt 1/3 failed` then buffers; on recovery `backfilled N buffered sample(s)`. The chart shows a gap in the live view but the history fills in |
| **Offline detection** | `sudo systemctl stop cspc-agent` | Server flips **Offline** within ~30 s, raises an alert, and auto-resolves when you start it again |
| **Maintenance mode** | Park it on the dashboard, then stop the agent | Stays **blue/Maintenance**, no alert, no bell |
| **Threshold alerts** | `sudo apt install stress-ng && stress-ng --cpu 4 --timeout 120s` | CPU alert fires at the configured rule, auto-resolves after recovery |
| **Per-volume disk** | Attach a second virtual disk, mount it, fill it | The Volumes panel lists it; disk alerting uses the **worst** volume, not `/` |
| **Revoke** | Revoke the install key with *revoke agents* | Next POST 403s, the agent deletes its own `agent.conf` and exits; the server drops off the list |

---

## 7. Reset / clean up

Remove the test server so it does not sit in the dashboard as a ghost:

```bash
# in the VM
sudo systemctl disable --now cspc-agent
sudo rm -rf /opt/cspc-agent /etc/systemd/system/cspc-agent.service
sudo systemctl daemon-reload
```

Then on the dashboard: **Server Metrics → (the VM) → Remove**, which revokes its
token. InfluxDB history is deliberately kept.

**Revoke the test install key** when you are done — especially if it was pasted into
a chat, a document or a screenshot. Dashboard → *Agent install keys* → **Revoke**.

To re-run the whole test from scratch, snapshot the VM *before* installing and roll
back to it.

---

## 8. What this does and does not prove

**Covered:** the Linux binary on real hardware-ish, `install.sh`, the systemd unit,
enrollment → approval → metrics, per-volume reporting, and the alerting paths above.

**Not covered:** the **Windows** installer (`install.ps1`, Scheduled Task,
`-ReEnroll`, the pre-rename migration), which needs a Windows machine or a Windows
VM to exercise; and anything to do with the production backend address or HTTPS.

⚠️ The backend URL is written into `agent.conf` on every machine at install time. A
VM test uses your laptop's address — before a real rollout, settle on a **stable**
backend address (static IP, DHCP reservation or DNS name), or every agent will need
re-pointing by hand later.
