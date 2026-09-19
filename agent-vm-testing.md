# Testing the Agent in a VM

Install the Linux agent on a throwaway VirtualBox VM. Same steps as a real server.

Uses a **host-only** adapter: a private wire between your laptop and the VM. It works on
campus Wi-Fi, at home, or with no internet at all — the VM only ever needs a path to your
laptop, never to the internet. Both ends can open connections to the other, so no port
forwarding is involved anywhere in this guide.

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

Both machines hold a real address on the host-only network, and neither changes when
your laptop moves between networks:

| Typing on | To reach | Use |
|---|---|---|
| Laptop (Git Bash) | the VM | the VM's host-only address, e.g. `192.168.56.101`, port `22` |
| VM | your laptop | the host's end of the wire, `192.168.56.1`, port `3000` |

VirtualBox's default host-only network is `192.168.56.0/24`, with **the host itself on
`.1`** and DHCP handing guests `.101` upward. Confirm both rather than assuming — §3 for
the host end, §4 for the VM's.

⚠️ **The trade against NAT: this network routes nowhere else.** The VM can reach your
laptop and nothing besides — no campus Wi-Fi, no internet, no `apt install`. For a
throwaway test box that is the point, but it has to be true *before* you need a package
rather than after. §4 is written around that.

---

## 3. Set up the network

**Settings → Network → Adapter 1 → Attached to: Host-only Adapter**, then pick the
adapter itself (`VirtualBox Host-Only Ethernet Adapter`). One adapter is all this needs.

Then confirm the network has a DHCP server, or the VM boots with no address at all:
**File → Tools → Network Manager → Host-only Networks** → select the network →
**DHCP Server** tab → *Enable Server*.

| Setting | Default | What it is |
|---|---|---|
| Address | `192.168.56.1` | your laptop's end of the wire — the address the agent posts to |
| Mask | `255.255.255.0` | |
| DHCP range | from `192.168.56.101` | what the VM is handed |

The **Address** field is the number you need: it is what goes in the install command in
§6. If yours is not `192.168.56.1`, use what this dialog says throughout.

> Why not NAT: NAT gives the VM internet, but hides it behind the host — so reaching the
> VM at all needs a port-forward per service, and the addresses on both ends are
> VirtualBox aliases rather than real ones. Host-only inverts that trade: direct
> addressing in both directions, no internet.
>
> Why not Bridged: it puts the VM's own MAC on the wireless network as a second device,
> and campus Wi-Fi authenticates per device against your school account — so the VM
> gets no usable address.

---

## 4. In the VM — enable SSH

⚠️ **Order matters here.** A host-only VM has no internet, so `apt install
openssh-server` cannot work from inside it. Either:

- **Tick "Install OpenSSH server"** during the Ubuntu Server install — the easy path, and
  the reason most VMs already have it; or
- if the VM is already built without it: temporarily add **Adapter 2 → NAT**, boot,
  `sudo apt update && sudo apt install openssh-server`, shut down, remove Adapter 2.

Then, in the VM:

```bash
sudo systemctl enable --now ssh
ip -4 addr show | grep inet | grep -v 127.0.0.1   # the VM's host-only address
whoami                                            # note the username
```

| Result | Fix |
|---|---|
| `Unit ssh.service not found` | openssh-server isn't installed — see above |
| No address on the adapter | DHCP server not enabled on the host-only network (§3) |

Check it can reach the backend — the address is the **host's** end of the wire from §3:

```bash
curl http://192.168.56.1:3000
# {"error":"Route not found"}    ← correct
```

| Result | Fix |
|---|---|
| Hangs | **Windows Firewall.** The host-only adapter is usually classified *Public*, and the backend listening on `0.0.0.0:3000` is still subject to the host firewall — allow inbound 3000 on that adapter |
| `Connection refused` | Backend not started |
| `No route to host` | Wrong host address — use what §3's Address field says |
| `Could not resolve host` | You pasted `<domain>` instead of the real address |

---

## 5. On your laptop — copy the folder in

```bash
cd "/c/Users/Mark Angelo/Documents/server-infrastructure-monitoring-system-webSystem/agent"
scp -r dist/cspc-agent-linux youruser@192.168.56.101:~/
```

Type `yes` at the host-key prompt. Then SSH in — pasting works here, unlike the
VirtualBox console window:

```bash
ssh youruser@192.168.56.101
```

> No `-P` / `-p` flags: host-only reaches port 22 directly, so the port-forward that NAT
> needed is gone along with the two flags that were easy to mix up. Substitute the
> address §4 printed and the username `whoami` gave.

---

## 6. Install

```bash
cd ~/cspc-agent-linux
sudo bash install.sh http://192.168.56.1:3000 AIK-your-key
```

It waits. Approve it: dashboard → **Server Metrics → Pending agent approvals → Approve**.

Then check:

```bash
systemctl status cspc-agent
journalctl -u cspc-agent -f     # "metrics sent" every 10s
```

The VM shows Online with its volumes within ~10 seconds. Its IP reads its host-only
address (`192.168.56.101`) on the dashboard — which, unlike NAT's `10.0.2.15`, is an
address you can actually SSH to.

---

## 7. Things worth testing here

| Test | How | Expected |
|---|---|---|
| Outage backfill | Stop the backend, wait, start it | Buffers, then `backfilled N sample(s)` — history fills in |
| Offline alert | `sudo systemctl stop cspc-agent` | Offline in ~30s; auto-resolves on restart |
| Maintenance mode | Park it, then stop the agent | Stays blue, no alert |
| CPU alert | `ops/stress-test/cpu-stress.sh -d 4m` | Alert fires, resolves ~30s after it ends |
| Memory / disk / network | the matching script in `ops/stress-test/` | See that folder's README |
| Extra volume | Add a virtual disk, mount, fill it | Listed in Volumes; alerts on the worst volume |
| Key revoke | Revoke key with *revoke agents* | Agent 403s, deletes `agent.conf`, exits |

> The load tests used to read `sudo apt install stress-ng`, which **cannot work here** —
> a host-only VM has no internet. `ops/stress-test/` needs nothing installed (bash +
> coreutils, with the `python3` Ubuntu Server already ships), and each script says which
> alert rule it is about to cross. Copy it in the same way as §5:
> `scp -r ops/stress-test youruser@192.168.56.101:~/` then `chmod +x ~/stress-test/*.sh`.

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
