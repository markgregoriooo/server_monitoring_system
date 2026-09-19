# Stress tests for a monitored Linux VM

Scripts that deliberately load CPU, memory, disk and network on a VM running the Go
agent, so you can watch the metric move, the alert fire, the email arrive and the
incident auto-resolve — on demand, instead of waiting for a real one.

Written for a **minimal VM**: pure bash + coreutils, with `python3` used where it is
genuinely better and a fallback for when it is absent. Nothing to `apt install`.

---

## Put it on the VM

The VM has a **host-only adapter**, so it holds its own address on the host-only network
and `scp` reaches it directly — no port forwarding, no `-P`, no `-p`.

First get the address, from inside the VM:

```bash
ip -4 addr show | grep inet | grep -v 127.0.0.1
#   inet 192.168.56.101/24 ... enp0s8     ← the host-only adapter
whoami                                    # the username to scp as
```

Then on your laptop, in **Git Bash** (not PowerShell — `scp` here wants the `/c/...` path):

```bash
cd "/c/Users/Mark Angelo/Documents/server-infrastructure-monitoring-system-webSystem/ops"
scp -r stress-test youruser@192.168.56.101:~/

# then SSH in — pasting works here, unlike the VirtualBox console window
ssh youruser@192.168.56.101
cd ~/stress-test
chmod +x *.sh
./cpu-stress.sh -h
```

Substitute your own username and address. `chmod` is not optional: `core.filemode` is
`false` in this repo, so the executable bit does not survive the copy.

> A host-only network has no route off the host, so the VM has **no internet**. Nothing
> here needs one — the scripts are bash + coreutils, and Ubuntu Server already ships the
> `python3` that the memory and network tests prefer. If a script ever suggests
> `apt install`, that is the fallback advice for an internet-connected host, not a
> requirement here.

> If you copy the folder by hand from Windows rather than over `scp` or `git`, check
> the line endings first: `head -1 cpu-stress.sh | cat -A` should end `$`, not `^M$`.
> A CRLF script fails with `bad interpreter: /bin/bash^M`, which reads like a missing
> file rather than a line-ending problem. `.gitattributes` in this repo already forces
> LF for `*.sh` — this is only a risk if the files travel through something that
> rewrites them. Fix with `sed -i 's/\r$//' *.sh`.

---

## What each script moves

| Script | Agent field | Seeded rule it crosses | Watch it on |
|---|---|---|---|
| `cpu-stress.sh` | `cpu_percent` | `cpu >= 80` warning, `>= 90` critical | Server Metrics → your VM; Dashboard CPU tile |
| `mem-stress.sh` | `mem_percent` | `mem >= 80` warning, `>= 95` critical | Server Metrics → memory tile |
| `disk-stress.sh` | `disk_percent` + per-volume | `disk >= 80` warning, `>= 90` critical | Server Metrics → disk; Analytics → disk forecast |
| `net-stress.sh` | `net_bytes_sent` / `_recv` | **none — see below** | Server Metrics → Network tile |
| `stress-all.sh` | all of the above, in sequence | — | Alerts page, as four separate incidents |

Every script takes `-d` for duration (`90`, `90s`, `5m`, `1h`), `-y` to skip the
confirmation, and `-h` for help.

---

## Five things worth knowing before you run them

**1. Network throughput raises no alert, and that is correct.**
There is no seeded rule for a *server's* network throughput. `link_util` and
`link_errors` belong to router interfaces from SNMP/MikroTik, not to an agent-reported
server. `net-stress.sh` moves the chart and the counters; it will not ring the bell.
If you want an alert out of it, add a rule — but the metric name would have to be one
`deviceAlerts` actually evaluates.

**2. Loopback traffic counts.**
The agent reads `gopsutil.IOCounters(false)` — the sum across *every* interface,
including `lo`. So `net-stress.sh` defaults to 127.0.0.1 and still moves both
counters, twice over (once sent, once received). No switch port, no uplink, no impact
on anyone else. `--target` exists for real traffic; use it only against a host you own.

**3. A "disk" test on `/tmp` is a memory test.**
On most distributions `/tmp`, `/run` and `/dev/shm` are tmpfs — RAM with a filesystem
on it. The agent deliberately excludes tmpfs from its volume list
(`collector.pseudoFS`), so filling one moves `mem_percent` and leaves the disk chart
flat. `disk-stress.sh` refuses a tmpfs target outright and defaults to
`/var/tmp/cspc-stress`, which is on real storage.

**4. The agent reports disk *usage*, not disk *I/O*.**
There is no IOPS or MB/s field in the metric contract. A read/write benchmark would
show up nowhere except indirectly as CPU iowait. `--io` makes the fill do real writes
if you want that, but the number the rules read is percent used.

**5. Too much memory pressure produces the wrong alert.**
Past ~90% the OOM killer starts choosing victims by score, and on a monitoring VM the
fattest processes are often sshd, MySQL or the agent itself. Kill the agent and the
dashboard raises **server offline** instead of **memory critical** — a different
incident, and a VM you may have to reboot from the hypervisor console.
`mem-stress.sh` defaults to 85% and refuses to go past 90% without `-y`.

---

## Timing

The agent posts every **10 seconds** by default (`-interval`, per agent, read from
`agent.conf`). That sets everything else:

- **Alert fires** on the first sample that crosses the threshold — so run for at least
  30s, ideally a few minutes, or the breach may fall between two posts.
- **Alert auto-resolves** after `ALERT_RECOVERY_SAMPLES` consecutive normal readings —
  default 3, so about **30s** after the load stops. That is hysteresis, not a delay
  bug: it stops a metric oscillating around its threshold producing an alert/resolve
  storm.
- **Escalation is instant** — warning → critical does not wait for a streak.
- **Server offline** needs `max(SERVER_OFFLINE_AFTER_SEC, interval × 3)`, so ~30s of
  silence from the agent.

`stress-all.sh` sizes its gaps off this automatically and warns if you make them too
short.

---

## Examples

```bash
# The common one: cross the CPU warning rule for four minutes
./cpu-stress.sh -d 4m

# Sit between the two rules — warning, but never critical
./cpu-stress.sh -l 85 -d 4m

# Memory into the critical band, on purpose, knowing the risk
./mem-stress.sh -p 96 -y -d 2m

# Fill the disk to 92% and hold it
./disk-stress.sh -p 92 -y -d 3m

# Grow the disk slowly for half an hour so Analytics can forecast it
./disk-stress.sh --ramp 30m -p 88 -d 5m

# Loopback traffic, paced so the chart shows a plateau rather than a spike
./net-stress.sh -d 5m -r 50

# The whole demo, ~18 minutes
./stress-all.sh
```

### Feeding the predictive analytics

`--ramp` is the one worth calling out. The Analytics page fits a linear regression
and gates the ETA behind R² ≥ 0.4 — a single instant fill is one step, which the gate
correctly rejects as "Stable". A disk that climbs steadily over 30 minutes gives it a
real trend, so the disk-full ETA becomes an actual forecast, and past
`ANALYTICS_ALERT_WARNING_DAYS` it will raise a forecast alert of its own.

Note the alerting job runs every **6 hours** (`ANALYTICS_ALERT_INTERVAL_H`), so don't
expect a forecast alert during the demo itself. `npm run analytics:check` in
`backend/` does a dry run and prints what it *would* raise, immediately.

---

## Safety

Every script:

- prints exactly what it will do, and what it expects to happen, before doing it
- asks for confirmation (skip with `-y`; a non-interactive shell without `-y` refuses
  rather than hanging)
- keeps a reserve — memory leaves ≥ 5% of RAM free, disk leaves ≥ 1 GB (`--min-free`)
- releases everything on exit, including on **Ctrl+C**, by killing the process group
  rather than just the direct children
- refuses the dangerous band (>90%) unless you pass `-y`

The one thing a trap cannot survive is `kill -9` or a hard power-off, which would
leave the disk ballast behind. That is what `./disk-stress.sh --clean` is for.

### Testing without alerting anyone

Park the server in **maintenance** first — Server Metrics → the server → Maintenance.
The offline sweep skips it, thresholds are suppressed, and the heartbeat won't clobber
the status. Useful if you want to see the charts move without mailing everyone who has
alert email switched on.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `scp`: `No route to host` | Host-only adapter is down, or you used the VM's other address — re-check `ip -4 addr` |
| `scp`: `Connection refused` | sshd isn't running in the VM: `sudo systemctl enable --now ssh` |
| `scp`: `Permission denied` | Wrong username — run `whoami` inside the VM and use that |
| `ssh`: host key warning after a VM rebuild | `ssh-keygen -R 192.168.56.101` then reconnect |
| Nothing moves on the dashboard | Run shorter than one agent interval, or the agent isn't running (`systemctl status cspc-agent`) |
| `bad interpreter: /bin/bash^M` | CRLF line endings — `sed -i 's/\r$//' *.sh` |
| CPU sits at 100% with `-l 85` | bash 4 has no `$EPOCHREALTIME`, so duty cycling is unavailable; the script says so and falls back. Use `-w` to lower the load instead |
| Memory test allocates less than asked | Clamped to keep the reserve free — the script prints the clamp |
| `fallocate not supported` | Some overlay/network filesystems refuse it; the script falls back to `dd` automatically |
| Disk still full after a crash | `./disk-stress.sh --clean` |
| Server flips **Offline** mid-test | The VM got too loaded to POST, or OOM killed the agent. Lower the target |
