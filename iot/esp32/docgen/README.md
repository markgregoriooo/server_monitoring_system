# Enclosure doc generators

The two Word files handed to ICTU are **generated**, not hand-edited — edit these scripts (or
the paired `.md` text) and rebuild, or the next change starts from scratch in Word.

```bash
npm install docx          # one dependency, not part of backend/ or frontend/
node build-card.js    ../ENCLOSURE-CARD.docx      # A4,  3 pages — for whoever wires it
node build-sticker.js ../ENCLOSURE-STICKER.docx   # A5,  1 page  — goes on the box
```

| Output | Audience | Rule |
|---|---|---|
| `ENCLOSURE-CARD.docx` | installer / technician | CH **and** GPIO. Wiring, dividers, dashboard steps |
| `ENCLOSURE-STICKER.docx` | everyone | CH only. No GPIO, no wiring, no jargon |

Two things that are load-bearing:

- **CH numbers, not GPIO, on the sticker.** The dashboard registers a smoke sensor or an
  aircon against a *channel* (`gas_sensors.channel`, `aircon_state.ir_channel`, both 1-based).
  A GPIO number is meaningless to the person reading the box and belongs only on the card.
- **The sticker must print in colour.** The swatch beside each row is the information; in
  greyscale the light table becomes eleven identical grey blocks.

No LibreOffice or pandoc on the dev machine. To check a build visually, Word converts:

```powershell
$w = New-Object -ComObject Word.Application; $w.Visible = $false
$d = $w.Documents.Open("<abs .docx>", $false, $true)
$d.ExportAsFixedFormat("<abs .pdf>", 17); $d.Close($false); $w.Quit()
```
