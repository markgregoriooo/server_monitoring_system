# Backblaze Setup on Windows — Step-by-Step

This is the beginner-friendly walkthrough for putting a copy of your backups in the
cloud (Backblaze). For the deeper technical reference, see
[`offsite-backup/README.md`](offsite-backup/README.md).

**What we're doing, in one sentence:** every night your system already saves backup
files to a local folder — this guide sends an *extra copy* of those files up to
Backblaze (an online storage company) so your data survives even if the whole
building is lost. The files are **locked/encrypted** before they leave, so nobody at
Backblaze can read them.

> This is the **"1 offsite" copy** of the classic **3-2-1 backup rule**: 3 copies, on
> 2 kinds of storage, 1 of them off-site.

> **Which parts apply to you:**
> - **"Which Backblaze product?" and Part A** are done in a **web browser** — same on every
>   OS. Read them whichever machine you are deploying to.
> - **Parts B–F are Windows commands.** ICTU's server runs Linux, so for the real
>   deployment follow **[`backup-setup-linux.md`](backup-setup-linux.md)** from its Step 6
>   onward instead. The Windows parts here are for trying the whole thing out on a laptop.

**Run every command on the machine the backend runs on.** The scripts read *that*
machine's `backend\.env`, dump *its* MySQL, and upload *its* backup folder. Running them
from somewhere else backs up the wrong computer.

---

## First: which Backblaze product?

When you sign up, Backblaze asks you to choose. **Pick "Application storage"
(B2 Cloud Storage).**

| Option | What it is | Use this? |
|---|---|---|
| **Application storage (B2 Cloud Storage)** | Cloud storage that tools like rclone upload files into. | ✅ **Yes** |
| **Systems backup and recovery (Computer Backup)** | A separate app that backs up a whole personal PC for a flat fee. | ❌ No |

Cost is tiny — the monitoring data is only ~15–30 MB per day, and B2 is about
**$6 per TB per month**, so this costs a few cents.

---

## Part A — Make the account, bucket, and key (in your web browser)

1. Go to **backblaze.com** → **Sign Up** (free). Verify your email.
2. Left menu → **B2 Cloud Storage** → **Buckets** → **Create a Bucket**.
   - Name: `cspc-monitoring-backup` (if the name is taken, add a number).
   - **Files in Bucket are: Private.**
   - Click **Create a Bucket**.
3. Left menu → **Application Keys** → **Add a New Application Key**.
   - Name: `monitoring-backup-key`
   - **Allow access to Bucket:** pick the bucket you just made (not "All").
   - Type: **Read and Write**.
   - Click **Create New Key**.
4. **⚠️ Copy these two values immediately** (the second one is shown only ONCE):
   - **keyID** — looks like `005abc...`
   - **applicationKey** — a longer string.

   Paste them into Notepad for the next steps.

---

## Part B — Install rclone (the upload tool)

rclone is the small free program that does the uploading.

- Download the ZIP from **rclone.org/downloads** → *"Windows / Intel/AMD - 64 Bit."*
- Unzip it, and copy `rclone.exe` into a folder such as `C:\rclone\`.
- (Optional) Add `C:\rclone\` to your PATH so you can type `rclone` from anywhere.

Check it works — open PowerShell and run:
```powershell
C:\rclone\rclone.exe version
```

---

## Part C — Connect rclone to Backblaze

rclone needs a small settings file that holds your keys plus **one passphrase you
choose** to encrypt the backups.

- **Pick a strong passphrase and write it down somewhere safe and OFFLINE.**
  Without it, the cloud copy can never be unlocked — that's the whole point of the
  encryption.

The settings file lives here on Windows:
```
C:\ProgramData\rclone\rclone.conf
```

You have two ways to create it:

**Option 1 — the wizard (your key never leaves your PC):**
```powershell
C:\rclone\rclone.exe config
```
Create a remote named `b2` (type: **b2**) with your keyID/applicationKey, then a
second remote named `b2crypt` (type: **crypt**) pointing at
`b2:cspc-monitoring-backup/offsite`.

**Option 2 — fill in the template:** copy
[`offsite-backup/rclone.conf.example`](offsite-backup/rclone.conf.example) to the path
above and replace the `<...>` placeholders. Turn your passphrase into the obscured
form it expects with:
```powershell
C:\rclone\rclone.exe obscure "your-strong-passphrase"
```

---

## Part D — Test the connection

```powershell
C:\rclone\rclone.exe --config C:\ProgramData\rclone\rclone.conf ls b2crypt:cspc-monitoring-backup/offsite
```
Returns **nothing** and **no error** = connected. (It's empty because nothing has been
uploaded yet.)

---

## Part E — Turn it on and run every night

Your project already has the scripts. First, run each once by hand to make sure they
work, then schedule them.

**1. Point them at your backup folder.** By default the system saves backups to the
`backend\backups` folder inside the project. For real safety point `BACKUP_DIR` at a USB
stick or SD card. Set it in `backend\.env` — **once**. Both scripts read it from there, so
the scheduled task does not have to repeat the path:
```
BACKUP_DIR=D:/backups
```

**2. Run the two jobs once by hand.** Do not schedule anything until both work:
```powershell
# saves a copy of the database
powershell -ExecutionPolicy Bypass -File .\ops\db-backup\dump-mysql.ps1

# uploads everything in the backup folder to Backblaze
powershell -ExecutionPolicy Bypass -File .\ops\offsite-backup\sync-offsite.ps1
```
Then check the Backblaze website — you should see files in your bucket (their names
will look scrambled — that's the encryption working, and it's expected).

> **If the dump says `mysqldump` is not found:** MySQL's client tools are not on your
> PATH. XAMPP in particular never adds them. Rather than editing the system PATH, point
> at the binary in `backend\.env`:
> ```
> MYSQLDUMP=C:/xampp/mysql/bin/mysqldump.exe
> ```

**3. Schedule them** so they run automatically each night (database dump at 2:15 AM,
upload at 2:30 AM). In an **Administrator** PowerShell:
```powershell
# nightly database dump — 2:15 AM
$act = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\path\to\project\ops\db-backup\dump-mysql.ps1"
$trg = New-ScheduledTaskTrigger -Daily -At 2:15AM
Register-ScheduledTask -TaskName "MonitoringDbDump" -Action $act -Trigger $trg -RunLevel Highest

# nightly offsite upload — 2:30 AM
$act = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File C:\path\to\project\ops\offsite-backup\sync-offsite.ps1"
$trg = New-ScheduledTaskTrigger -Daily -At 2:30AM
Register-ScheduledTask -TaskName "OffsiteBackupSync" -Action $act -Trigger $trg -RunLevel Highest
```
(Replace `C:\path\to\project` with the real folder path of this project.)

> ⚠️ **A Scheduled Task does not inherit your PATH.** Setting `$env:Path` in your
> PowerShell window only lasts for that window, so a script that works when you run it can
> still fail at 2 AM because it cannot find `mysqldump` or `rclone`. Either put those on
> the **system** PATH, or set `MYSQLDUMP` in `backend\.env` as above. This is the most
> common reason these jobs "work but don't run".

**4. Check it the next morning.** Both scripts log every run into the backup folder:
```powershell
Get-Content D:\backups\offsite-sync.log -Tail 10
Get-Content D:\backups\db-backup.log   -Tail 10
```
An `OK` line means it worked. A `FAILED` line means it ran but could not finish — rclone
logs the reason just above it. **No line at all** for last night means the task never
ran: the machine was off or asleep, or the task is disabled.

---

## Part F — Let the dashboard watch it

So your dashboard warns you if a nightly upload ever fails, add these to `backend\.env`:
```
BACKUP_OFFSITE_ENABLED=true
BACKUP_OFFSITE_MAX_AGE_HOURS=26
BACKUP_OFFSITE_CRITICAL_HOURS=72
```
Restart the backend. Now, if no successful upload happens within ~26 hours, you get a
**backup warning** on the bell; after ~72 hours it becomes **critical** and is emailed too.
Either clears itself once a fresh upload lands.

> Leave `BACKUP_OFFSITE_ENABLED` unset (or `false`) until the nightly upload is actually
> running, so it doesn't warn you before there's anything to warn about.

---

## How to get your data back (restore)

```powershell
C:\rclone\rclone.exe --config C:\ProgramData\rclone\rclone.conf copy b2crypt:cspc-monitoring-backup/offsite E:\restore
```
Files come back **decrypted automatically** (rclone unlocks them with your passphrase).
Then, to restore the database:
```powershell
# decompress the .sql.gz, then load it into MySQL
```

---

## Things to keep safe (NOT in Backblaze)

These aren't in the cloud copy — keep an **encrypted, offline** copy yourself:
- `backend\.env` — your passwords and keys (DB, JWT, Google, Resend, `DEVICE_SECRET`,
  `MIKROTIK_ENC_KEY`).
- `rclone.conf` — your Backblaze keys + encryption passphrase.
- Your **encryption passphrase** — without it the cloud backup can't be unlocked.

---

## Quick checklist

- [ ] Backblaze account made, chose **Application storage**
- [ ] Bucket `cspc-monitoring-backup` created (Private)
- [ ] Application key created — keyID + applicationKey saved
- [ ] rclone installed
- [ ] `rclone.conf` created (with encryption passphrase saved offline)
- [ ] Test `ls` command connects with no error
- [ ] Ran both scripts once by hand — files appear in the bucket
- [ ] Scheduled both nightly tasks
- [ ] Next morning: `offsite-sync.log` shows an `OK` line
- [ ] Added the two `BACKUP_OFFSITE_*` lines to `backend\.env` and restarted the backend

---

## Related

| Doc | For |
|---|---|
| [`backup-setup-linux.md`](backup-setup-linux.md) | **The same thing on Linux — use this for the ICTU server** |
| [`../backup-storage.md`](../backup-storage.md) | Why the backup system is designed this way |
| [`db-backup/README.md`](db-backup/README.md) | The dump script in detail |
| [`offsite-backup/README.md`](offsite-backup/README.md) | The upload script in detail |
| [`../deployment-guide.md`](../deployment-guide.md) | Deploying the rest of the system |
