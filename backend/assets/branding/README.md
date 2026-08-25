# Report branding assets

Images and fonts used by the generated PDF reports (`services/reportRenderer.js`).

These are **committed to git on purpose.** Unlike `backend/reports/` (generated output,
gitignored) and `backend/backups/` (runtime data), these are source material — the report
cannot be produced without them, so a fresh clone must have them.

## Expected files

| File | What it is |
|------|-----------|
| `cspc-logo.png` | Camarines Sur Polytechnic Colleges seal |
| `ictu-logo.jpg` | ICTU logo. **JPEG, so no transparency** — it prints with its background baked in (fine on a white page, visible on a coloured band). Converting it to PNG would NOT restore transparency; that needs the original from ICTU. |

Lowercase filenames, matched exactly in code — the deploy target is Linux and is
case-sensitive.

## Format rules (pdfkit 0.19)

- **PNG or JPEG only. SVG is NOT supported** — pdfkit cannot rasterise vectors. If ICTU
  supplies an SVG or EPS, export it to PNG first.
- **PNG with transparency** for a logo, so it sits on the letterhead without a white box
  around it. JPEG has no alpha channel.
- Around **400-600px wide** is plenty. The mark prints at 46pt on an A4 page, and pdfkit
  embeds the file at its full pixel size in **every** PDF it generates. `cspc-logo.png`
  was downscaled 1258px -> 420px on 2026-08-25 for exactly this reason: it took a sample
  report from 370 KB to 125 KB with no visible difference in the letterhead. The
  full-resolution original is still at `frontend/public/Camarines_Sur_Polytechnic_Colleges_Logo.png`.
- Keep the original high-resolution/vector copy somewhere outside the repo; this folder
  holds the print-ready export.

## Using one in the PDF

`reportRenderer.js` is ESM, so resolve the path from the module rather than from
`process.cwd()` — that way it works no matter which directory the backend was started in:

```js
import path from "node:path";
import { fileURLToPath } from "node:url";

const BRANDING = path.join(path.dirname(fileURLToPath(import.meta.url)), "../assets/branding");

// inside toPDFBuffer(), in the header block:
doc.image(path.join(BRANDING, "cspc-logo.png"), 40, 36, { height: 44 });
doc.image(path.join(BRANDING, "ictu-logo.jpg"), 92, 36, { height: 44 });
```

⚠️ `doc.image()` **throws** if the file is missing, and `build()` in reportService is
fire-and-forget — a throw there flips the report to `failed` with no obvious cause. Guard
with `fs.existsSync()` if the logo is ever optional.
