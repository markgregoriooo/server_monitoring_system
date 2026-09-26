# Backup Setup on Linux — Step-by-Step

Everything needed to get **nightly backups** running on the ICTU Linux server: the
database dump, the local copy, and the encrypted cloud copy.

> **Linux only.** For a Windows dev machine, follow [`backblaze-setup-guide.md`](backblaze-setup-guide.md)
> instead. Both do the same thing — this one is just Linux, so nothing has to be filtered
> out while you work.

**Run every command on the server the backend runs on.** The scripts read *that* machine's
`backend/.env`, dump *its* MySQL, and upload *its* backup folder. Running them from a
laptop backs up the laptop.

---

## What you end up with

```
   ALL DAY   backend writes sensor readings ─────►  /mnt/backup/backups
   2:15 AM   dump-mysql.sh saves the database ────►  /mnt/backup/backups
   2:30 AM   sync-offsite.sh uploads everything ──►  ☁  Backblaze (encrypted)
```

Three copies — the classic **3-2-1 rule**:

| Copy | Where | Protects against |
|---|---|---|
| 1 | InfluxDB + MySQL on the server disk | — |
| 2 | USB / SD drive (`BACKUP_DIR`) | the server's disk dying |
| 3 | Backblaze B2 | fire, theft, flood |

**Time needed:** about 45 minutes, most of it waiting on the Backblaze signup.

---

## Before you start

- `sudo` on the server
- The backend already deployed and running (see `../deployment-guide.md`)
- A USB stick or SD card plugged into the server
- An email address for the Backblaze account — use an **ICTU** address, not a personal
  one. Whoever owns that inbox owns the backups and the billing.

> This guide writes the project path as `/opt/cspc`, matching `../deployment-guide.md`.
> Change it to wherever the project actually lives.

---

## Running under Docker? (the ICTU deployment) — read this first

With `docker compose`, three things are different, and the plain steps below would
quietly back up nothing:

- the backend writes its backups **inside its container** (`/app/backups`), by default
  into a Docker volume on the main disk, where the host scripts cannot find it;
- MariaDB is the `db` container and is **not published to the host**, so a host
  `mysqldump` has nothing to connect to;
- `BACKUP_DIR` in `backend/.env` is **ignored** — compose pins it to `/app/backups`.

The scripts already handle all three. They switch to Docker mode on their own when the
**root** `.env` (the one next to `docker-compose.yml`) sets `BACKUP_HOST_DIR`. Follow the
numbered steps with these substitutions:

| Step | Under Docker, do this instead |
|---|---|
| 1, 2 | Same. For **Step 2's `chown`** use uid 1000, the container's user: `sudo chown -R 1000:1000 /mnt/backup/backups`. (A FAT32/exFAT stick has no owners — mount it with `uid=1000,gid=1000` in `/etc/fstab` instead.) |
| 3 | See **Step 3 (Docker)** below. |
| 4 | **Skip.** The dump runs `mariadb-dump` inside the `db` container. No client tools are needed on the host. |
| 5 | Same commands, run with `sudo` (the script calls `docker`). |
| 6–9 | Same. |
| 10 | Use **root's** crontab (`sudo crontab -e`): the jobs need `docker`, and `/etc/rclone/rclone.conf` is root-only. `/usr/bin` must be on the `PATH=` line — that is where `docker` lives. |
| 11 | Edit `backend/.env` as shown, then `docker compose up -d backend` — **not** `restart` (see `docker-compose.yml`). |
| Restoring | See **Restoring (Docker)** at the end. |

### Step 3 (Docker) — point the backend at the drive

In the **root** `.env`, not `backend/.env`:

```bash
cd /opt/cspc
nano .env
```

```ini
BACKUP_HOST_DIR=/mnt/backup/backups
```

Recreate the backend so it picks up the new mount:

```bash
docker compose up -d backend
docker compose logs backend | grep BACKUP
# expect: [BACKUP] on-site backup → /app/backups (...)   ← the path INSIDE the container
ls -lh /mnt/backup/backups/                               # files appear here within ~10 s
```

If the log says `NOT RUNNING — cannot write to /app/backups`, the folder is not owned by
uid 1000. Fix the `chown` from Step 2 and run `up -d backend` again.

> **Already running on the Docker volume?** Moving to the drive does not bring the old
> files with it. Copy them over once, **before** the `up -d` above:
> ```bash
> docker run --rm -v cspc_backend-backups:/from -v /mnt/backup/backups:/to alpine cp -a /from/. /to/
> ```
> (`docker volume ls` shows the real volume name — it is prefixed with the project folder's name.)

---

## Step 1 — Check the server's clock

Do this first. Backups are named by date, cron fires on local time, and the ESP32's
buffered readings are stored under **Philippine time**.

```bash
timedatectl
# if it is not Asia/Manila:
sudo timedatectl set-timezone Asia/Manila
```

---

## Step 2 — Mount the backup drive

Find the drive:

```bash
lsblk -f
```

Look for your USB stick (e.g. `sdb1`) and note its **UUID**.

Create the mount point and mount it:

```bash
sudo mkdir -p /mnt/backup
sudo mount /dev/sdb1 /mnt/backup
```

Make it survive a reboot — add one line to `/etc/fstab`:

```bash
sudo nano /etc/fstab
```

```fstab
UUID=1234-ABCD  /mnt/backup  ext4  defaults,nofail  0  2
```

Use `vfat` instead of `ext4` if the stick is FAT32. **`nofail` matters** — without it, a
missing USB stick stops the server from booting.

Test it:

```bash
sudo umount /mnt/backup && sudo mount -a && df -h /mnt/backup
```

> ⚠️ **The quiet failure to avoid.** If the drive is *not* mounted, `/mnt/backup/backups`
> still exists as an ordinary empty folder on the root disk. Backups keep writing, with no
> error — straight onto the disk you were trying to protect against. `df -h /mnt/backup`
> should name the USB device, not `/dev/sda1`.

Let the backend write to it:

```bash
sudo mkdir -p /mnt/backup/backups
sudo chown -R $USER:$USER /mnt/backup/backups
```

---

## Step 3 — Point the backend at it

```bash
sudo nano /opt/cspc/backend/.env
```

```ini
BACKUP_DIR=/mnt/backup/backups
```

Restart the backend, then confirm:

```bash
# expect: [BACKUP] on-site backup → /mnt/backup/backups (flush 5000ms, retain 30d)
```

After ~10 seconds, files should appear:

```bash
ls -lh /mnt/backup/backups/
```

---

## Step 4 — Install the MySQL client tools

The dump needs `mysqldump`:

```bash
sudo apt install mariadb-client     # or: mysql-client
mysqldump --version
```

If it prints a version, you are done. If not, set the full path in `backend/.env`:

```ini
MYSQLDUMP=/usr/bin/mysqldump
```

---

## Step 5 — Test the database dump

```bash
chmod +x /opt/cspc/ops/db-backup/dump-mysql.sh
/opt/cspc/ops/db-backup/dump-mysql.sh
```

Check it worked:

```bash
ls -lh /mnt/backup/backups/mysql-*.sql.gz
tail -5 /mnt/backup/backups/db-backup.log
```

You want a `.sql.gz` file of a few hundred KB and an `OK` line in the log.

**Do not continue until this works.**

---

## Step 6 — Install rclone

```bash
sudo apt install rclone
rclone version
which rclone          # note this path — Step 10 needs it
```

`apt` installs to `/usr/bin/rclone`. The official installer
(`curl https://rclone.org/install.sh | sudo bash`) gives a newer version but puts it in
`/usr/local/bin/rclone`. Either is fine — just remember which.

---

## Step 7 — Create the Backblaze bucket and key

This part is done in a **web browser**, so it is the same on any OS.

> **Screenshots and the longer explanation** — including which Backblaze product to pick
> and why — are in
> [`backblaze-setup-guide.md`](backblaze-setup-guide.md#first-which-backblaze-product):
> read **"Which Backblaze product?"** and **Part A**, then come back here for Step 8.
> (Skip its Parts B–F — those are the Windows versions of Steps 6, 8, 9 and 10 below.)

The short version:

1. Sign up at **backblaze.com** — choose **"Application storage" (B2)**, *not* Computer Backup.
2. **Buckets → Create a Bucket** → name it `cspc-monitoring-backup`, set **Private**.
3. **Application Keys → Add a New Application Key** — restrict it to that one bucket.
4. **Copy the `keyID` and `applicationKey` now.** The applicationKey is shown **once**.

Free tier covers 10 GB, which is well beyond what this system produces.

---

## Step 8 — Connect rclone to Backblaze

**Choose an encryption passphrase and write it down somewhere offline.** Without it the
cloud copy can never be unlocked — that is the point of encrypting it.

```bash
sudo mkdir -p /etc/rclone
sudo rclone config --config /etc/rclone/rclone.conf
```

Create **two** remotes:

| Remote | Type | Settings |
|---|---|---|
| `b2` | `b2` | your keyID + applicationKey |
| `b2crypt` | `crypt` | remote = `b2:cspc-monitoring-backup/offsite`, encrypt filenames, your passphrase |

`b2crypt` wraps `b2` — the scripts upload through `b2crypt`, so data *and* filenames are
encrypted before they leave campus.

Lock the file down; it holds your keys:

```bash
sudo chmod 600 /etc/rclone/rclone.conf
```

---

## Step 9 — Test the upload

Connection first:

```bash
rclone --config /etc/rclone/rclone.conf ls b2crypt:cspc-monitoring-backup/offsite
```

No output and no error = connected (it is empty so far).

Now a real run:

```bash
chmod +x /opt/cspc/ops/offsite-backup/sync-offsite.sh
/opt/cspc/ops/offsite-backup/sync-offsite.sh
```

Check all three:

```bash
tail -5 /mnt/backup/backups/offsite-sync.log      # expect "offsite sync OK"
ls -l  /mnt/backup/backups/.last_offsite_sync     # the success marker
```

And look at the Backblaze bucket in your browser — files should be there with
**scrambled names**. That is the encryption working, and it is expected.

**Do not continue until this works.**

---

## Step 10 — Schedule both jobs

```bash
crontab -e
```

Add these three lines:

```cron
PATH=/usr/local/bin:/usr/bin:/bin
15 2 * * *  /opt/cspc/ops/db-backup/dump-mysql.sh
30 2 * * *  /opt/cspc/ops/offsite-backup/sync-offsite.sh
```

Dump at 2:15, upload at 2:30 — in that order, so the fresh database file ships the same
night.

> ⚠️ **Do not drop the `PATH=` line.** cron runs with a nearly empty PATH — usually just
> `/usr/bin:/bin`. An rclone installed to `/usr/local/bin` is invisible to it, and the
> symptom is the worst kind: **both scripts work perfectly by hand and silently do nothing
> at 2 AM.** Make the `PATH=` line include whatever `which rclone` printed in Step 6.

Confirm cron accepted it:

```bash
crontab -l
```

---

## Step 11 — Let the dashboard watch it

Only now that uploads actually work. In `backend/.env`:

```ini
BACKUP_OFFSITE_ENABLED=true
BACKUP_OFFSITE_MAX_AGE_HOURS=26
BACKUP_OFFSITE_CRITICAL_HOURS=72
```

Restart the backend.

| No successful upload for | What happens |
|---|---|
| 26 hours (one missed night) | **Warning** on the bell. Usually an internet blip — the next night catches up. |
| 72 hours (three missed nights) | **Critical** — also **emailed** to everyone with alert email on. Something is broken. |

Both clear by themselves once a fresh upload arrives. Set `BACKUP_OFFSITE_CRITICAL_HOURS=0`
to keep it bell-only.

> Turning this on **before** uploads work gives you a permanent false alarm, which is why
> it is the last step.

---

## Step 12 — Check it the next morning

```bash
tail -20 /mnt/backup/backups/offsite-sync.log
```

| What you see | Meaning |
|---|---|
| `offsite sync OK` | Working. Done. |
| `offsite sync FAILED` | It ran but could not finish — rclone logs the reason just above |
| **nothing for last night** | The job never ran — see Troubleshooting |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Works by hand, nothing at 2 AM | cron's PATH | Add/extend the `PATH=` line (Step 10) |
| `mysqldump: not found` | Client tools missing | Step 4, or set `MYSQLDUMP` in `.env` |
| Backups on the wrong disk | Drive not mounted | `df -h /mnt/backup` should name the USB device |
| `Permission denied` writing | Folder owned by root | `sudo chown -R $USER:$USER /mnt/backup/backups` |
| Upload "succeeds" but bucket is empty | Wrong `BACKUP_DIR` | Check `.env`; rclone exits 0 on an empty folder |
| Dashboard warns despite uploads working | Marker unreadable | Check `.last_offsite_sync` exists and the backend can read it |

Read the logs in this order — they are all in the backup folder:

```bash
tail -20 /mnt/backup/backups/db-backup.log
tail -20 /mnt/backup/backups/offsite-sync.log
```

---

## Restoring

**Pull the cloud copy back** (rclone decrypts automatically with your passphrase):

```bash
rclone --config /etc/rclone/rclone.conf copy \
  b2crypt:cspc-monitoring-backup/offsite /tmp/restore
```

**Load the database back:**

```bash
gunzip -c /tmp/restore/mysql-2026-08-21.sql.gz \
  | mysql -u root -p cspc-ictu-monitoring-system
```

**Read a sensor backup file** — one JSON object per line:

```bash
head -3 /tmp/restore/env-2026-08-21.ndjson
```

### Restoring (Docker)

The pull from Backblaze is the same. Loading the database goes **into the `db`
container**, using the root password from the root `.env`:

```bash
cd /opt/cspc
gunzip -c /tmp/restore/mysql-2026-08-21.sql.gz \
  | docker compose exec -T db sh -c 'MYSQL_PWD="$MARIADB_ROOT_PASSWORD" exec mariadb -u root "$MARIADB_DATABASE"'
docker compose up -d --force-recreate backend    # reload its in-memory caches (alert rules, gas sensors, …)
```

---

## ⚠️ Not in the cloud backup — keep these yourself

Encrypted and offline. Without them the cloud copy is not enough:

- **`backend/.env`** — DB password, `JWT_SECRET`, Google keys, `DEVICE_SECRET`,
  `MIKROTIK_ENC_KEY`
- **The root `.env`** (Docker) — the MariaDB root/user passwords and `INFLUX_TOKEN`
- **`/etc/rclone/rclone.conf`** — Backblaze keys + obscured passphrase
- **The encryption passphrase itself** — lose it and the cloud copy is permanently unreadable

> `MIKROTIK_ENC_KEY` deserves its own mention: the database dump contains MikroTik router
> passwords encrypted with it. The dump alone cannot decrypt them.

---

## Checklist

- [ ] Timezone is `Asia/Manila`
- [ ] Drive mounted, in `/etc/fstab` with `nofail`, and `df -h` names the USB device
- [ ] `BACKUP_DIR` set in `backend/.env`, backend restarted, files appearing
      — **Docker:** `BACKUP_HOST_DIR` in the root `.env`, folder owned by uid 1000, `docker compose up -d backend`
- [ ] `mysqldump --version` works (**Docker:** skip)
- [ ] `dump-mysql.sh` run by hand → `.sql.gz` created
- [ ] rclone installed; noted whether it is in `/usr/bin` or `/usr/local/bin`
- [ ] Backblaze bucket + application key created (key saved)
- [ ] `rclone.conf` created with both remotes, `chmod 600`
- [ ] Passphrase written down **offline**
- [ ] `sync-offsite.sh` run by hand → files in the bucket, marker file created
- [ ] Both cron lines added — **including `PATH=`**
- [ ] `BACKUP_OFFSITE_ENABLED=true`, backend restarted
- [ ] Next morning: `offsite-sync.log` shows `OK`
- [ ] `.env`, `rclone.conf` and the passphrase saved somewhere encrypted and offline

---

## Related

| Doc | For |
|---|---|
| [`backblaze-setup-guide.md`](backblaze-setup-guide.md) | The same thing on Windows |
| [`../backup-storage.md`](../backup-storage.md) | Why the backup system is designed this way |
| [`db-backup/README.md`](db-backup/README.md) | The dump script in detail |
| [`offsite-backup/README.md`](offsite-backup/README.md) | The upload script in detail |
| [`../deployment-guide.md`](../deployment-guide.md) | Deploying the rest of the system |
