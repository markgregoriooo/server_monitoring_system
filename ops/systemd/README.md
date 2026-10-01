# Running the backend under systemd

**Why:** so the backend starts on boot, restarts if it crashes, and — the reason this was
added — so its log output is **captured, rotated, and kept across restarts** instead of
scrolling past in a terminal that eventually closes.
See `audits/logging-monitoring-2026-08-25.md` §8.

**Linux only.** On Windows there is no systemd; use `npm run dev` (nodemon) for development.

---

## 1. Install

```bash
# A dedicated non-root account
sudo useradd --system --home /opt/cspc --shell /usr/sbin/nologin cspc
sudo chown -R cspc:cspc /opt/cspc/backend

# .env holds every secret — nobody but the service account should read it
sudo chmod 600 /opt/cspc/backend/.env
sudo chown cspc:cspc /opt/cspc/backend/.env

# reports/ and the backup drive must be writable BY THAT ACCOUNT
sudo mkdir -p /opt/cspc/backend/reports
sudo chown cspc:cspc /opt/cspc/backend/reports
sudo chown cspc:cspc /mnt/backup            # or whatever BACKUP_DIR points at

sudo cp ops/systemd/cspc-monitoring.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cspc-monitoring
```

## 2. Verify — four checks, in this order

```bash
# 1. It is running
systemctl status cspc-monitoring          # expect: active (running)

# 2. It found its config and started cleanly
journalctl -u cspc-monitoring -n 30 | grep -i "CONFIG\|injecting env\|Server running"
#    want:  injecting env (30) from /opt/cspc/backend/.env
#           Server running on port 3001
#    NOT:   [CONFIG] Missing in backend/.env: GOOGLE_CLIENT_ID …

# 3. It answers
curl -sI http://127.0.0.1:3001/api/policy/version | head -1     # HTTP/1.1 200 OK

# 4. ICMP still works (see the NoNewPrivileges warning in the unit file)
sudo -u cspc bash -c 'cd /opt/cspc/backend && npm run probe -- <a-router-ip>'
```

> **Check #2 confirms `.env` was actually read**, not merely that the process started. The
> `injecting env (N)` line names the file and the count — `N` should match the number of
> settings you have. `.env` is located from the code's own directory (`BACKEND_ROOT`), so a
> wrong `WorkingDirectory` no longer breaks it, but a missing or unreadable file still will —
> and then the error names the path it tried.

## 3. Reading the logs

```bash
journalctl -u cspc-monitoring -f                 # follow live
journalctl -u cspc-monitoring --since "1 hour ago"
journalctl -u cspc-monitoring -p err             # errors only
journalctl -u cspc-monitoring -b                 # since last boot
```

The application tags its own lines, so the security-relevant ones are greppable:

| Tag | What it records |
|---|---|
| `[AUTH]` | Rejected tokens, socket handshake failures — with the real reason |
| `[AUTHZ]` | **403s** — an authenticated user reaching above their role |
| `[RATE]` | Rate-limit 429s, with the key that hit the limit |
| `[POLICY]` | A write blocked because the Privacy Notice was not accepted |
| `[GOOGLE_AUTH]` | Sign-in verification failures |
| `[FATAL]` | Uncaught exception / unhandled rejection, immediately before exit |

```bash
# Everything security-relevant, last 24h
journalctl -u cspc-monitoring --since "24 hours ago" \
  | grep -E '\[AUTH\]|\[AUTHZ\]|\[RATE\]|\[POLICY\]|\[FATAL\]'
```

## 4. Bound the journal

journald rotates automatically, but the default cap is a percentage of the disk. On a
campus server that also holds InfluxDB, set an explicit ceiling:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/cspc.conf >/dev/null <<'EOF'
[Journal]
SystemMaxUse=500M
MaxRetentionSec=30day
EOF
sudo systemctl restart systemd-journald
```

> **Note the mismatch, and that it is intentional.** The journal keeps 30 days;
> `system_logs` (the audit trail, in MariaDB) keeps **365**. They are different things:
> the journal is operational noise for debugging, the audit trail is the compliance record
> the Privacy Notice commits to. Do not treat the journal as the audit trail.

## 5. Day-to-day

```bash
sudo systemctl restart cspc-monitoring    # after changing .env — the app does NOT reload it
sudo systemctl stop cspc-monitoring
sudo systemctl disable cspc-monitoring    # stop starting at boot
```

⚠️ **`.env` changes need a restart.** `dotenv` reads the file once at startup; nothing
watches it. This is the most common "I changed the setting and nothing happened".

## 6. If it will not start

| Symptom (`journalctl -u cspc-monitoring -n 50`) | Cause |
|---|---|
| `[CONFIG] Missing in backend/.env: …` | `.env` is missing those keys, or is unreadable by `cspc` (`chmod 600` + `chown` — §1) |
| `Error: listen EADDRINUSE … 0.0.0.0:3001` | Something else holds the port — `sudo ss -lptn 'sport = :3001'` |
| `Could not read /opt/cspc/backend/.env (ENOENT)` | The file is not there. The error names the exact path tried — no guessing |
| `EACCES` writing `reports/` or `backups/` | `chown` step in §1 missed |
| `[ICMP] ping could not be started` in the journal | `NoNewPrivileges=true` blocked `ping`, or no `ping` binary. Latency/loss are reported as **null** (not a false outage) — read the ⚠️ block in the unit file |
| Restarts every 5s then stops | Hit `StartLimitBurst`. The real error is in the journal above the restart lines |
