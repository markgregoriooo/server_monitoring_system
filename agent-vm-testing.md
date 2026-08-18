# Testing the Agent in a VM

Install the Linux agent on a throwaway VirtualBox VM. Same steps as a real server.

Uses **NAT** networking, so it works on campus Wi-Fi, at home, or with no internet at
all — the VM only ever needs a path to your laptop, never to the internet.

> Real server? Use `agent/dist/cspc-agent-linux/RUN-ME.txt`.
> Feature internals → `server-metrics.md`. Build/ship model → `agent/README.md`.

---

## 1. Before you start

- VirtualBox VM running **Ubuntu Server 22.04**
- Backend running on your laptop: `cd backend && node src/server.js`
- An install key: dashboard → **Server Metrics → Agent install keys → + New key**
- The folder `agent/dist/cspc-agent-linux/` (build with `make package`)

---

## 2. Two addresses to remember

Under NAT the two machines reach each other by fixed addresses that never change,
whatever network your laptop is on:

| Typing on | To reach | Use |
|---|---|---|
| Laptop (Git Bash) | the VM | `127.0.0.1` port `2222` |
| VM | your laptop | `10.0.2.2` port `3000` |

Neither is a real IP — they're aliases VirtualBox provides. That's the point: campus
Wi-Fi changes your laptop's real address constantly, and these don't care.

---

## 3. Set up the network

**Settings → Network → Adapter 1 → Attached to: NAT** (the default).

Then **Advanced → Port Forwarding → +** — this is what lets your laptop reach the VM:

| Name | Protocol | Host Port | Guest Port |
|---|---|---|---|
| ssh | TCP | 2222 | 22 |

Leave Host IP and Guest IP blank. It can be added while the VM is running.

> Why not Bridged: it puts the VM's own MAC on the wireless network as a second device,
> and campus Wi-Fi authenticates per device against your school account — so the VM
> gets no usable address. NAT shares your laptop's already-authenticated connection.

---

## 4. In the VM — enable SSH

```bash
sudo apt update
sudo apt install openssh-server
whoami                     # note the username
```

Check it can reach the backend:

```bash
curl http://10.0.2.2:3000
# {"error":"Route not found"}    ← correct
```

| Result | Fix |
|---|---|
| Hangs | Backend not running, or the firewall is blocking port 3000 |
| `Connection refused` | Backend not started |
| `Could not resolve host` | You pasted `<domain>` instead of the real address |

---

## 5. On your laptop — copy the folder in

```bash
cd "/c/Users/Mark Angelo/Documents/Server-Infrastructure-Monitoring-System-WebSystem/agent"
scp -P 2222 -r dist/cspc-agent-linux youruser@127.0.0.1:~/
```

Type `yes` at the host-key prompt. Then SSH in — pasting works here, unlike the
VirtualBox console window:

```bash
ssh -p 2222 youruser@127.0.0.1
```

> Capital `-P` for `scp`, lowercase `-p` for `ssh`.

---

## 6. Install

```bash
cd ~/cspc-agent-linux
sudo bash install.sh http://10.0.2.2:3000 AIK-your-key
```

It waits. Approve it: dashboard → **Server Metrics → Pending agent approvals → Approve**.

Then check:

```bash
systemctl status cspc-agent
journalctl -u cspc-agent -f     # "metrics sent" every 10s
```

The VM shows Online with its volumes within ~10 seconds. Its IP reads `10.0.2.15` on
the dashboard — normal for NAT, and harmless.

---

## 7. Things worth testing here

| Test | How | Expected |
|---|---|---|
| Outage backfill | Stop the backend, wait, start it | Buffers, then `backfilled N sample(s)` — history fills in |
| Offline alert | `sudo systemctl stop cspc-agent` | Offline in ~30s; auto-resolves on restart |
| Maintenance mode | Park it, then stop the agent | Stays blue, no alert |
| CPU alert | `sudo apt install stress-ng && stress-ng --cpu 4 --timeout 120s` | Alert fires, resolves after |
| Extra volume | Add a virtual disk, mount, fill it | Listed in Volumes; alerts on the worst volume |
| Key revoke | Revoke key with *revoke agents* | Agent 403s, deletes `agent.conf`, exits |

Snapshot the VM before installing if you want to re-run from scratch.

---

## 8. Clean up

```bash
# stop the agent now, and stop it starting at boot
sudo systemctl disable --now cspc-agent

# delete the installed program + its enrolment, the service definition,
# and the copy you scp'd in. -rf = delete folders and don't ask
sudo rm -rf /opt/cspc-agent /etc/systemd/system/cspc-agent.service ~/cspc-agent-linux

# tell systemd the service file is gone
sudo systemctl daemon-reload
```

⚠️ `/opt/cspc-agent` holds `agent.conf` — this machine's device token. Deleting it means
the next install enrolls from scratch and needs approving again.

Then dashboard → remove the server. Revoke the test key too.

---

## Notes

- **Not tested by this:** the Windows installer (`install.ps1`, Scheduled Task, `-ReEnroll`).
- Changing the backend address later: edit `API_URL` in `/opt/cspc-agent/agent.conf`,
  then `sudo systemctl restart cspc-agent`. The token and identity survive.
- ⚠️ That address is saved at install time on **every** machine. Settle on a stable
  production one (static IP or DNS name) before a real rollout, or every agent needs
  re-pointing by hand later.
- `install: invalid option --y` means you left out `apt` — `install` is a different command.
