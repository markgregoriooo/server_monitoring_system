# Report body font — Arimo

Embedded into every generated PDF by `services/reportRenderer.js`.

## Why Arimo and not Arial

ICTU asked for **Arial 11/12** (`reports-client-questionnaire.md`, section A).

Arial cannot be committed here. Embedding it into a *generated* PDF is ordinary and
permitted — that is what Word does — but shipping `arial.ttf` in a repository is
**redistribution of licensed Monotype font software**, which the Windows EULA does not
grant. Loading it from the operating system at runtime is not an option either: the
backend deploys to Linux (`ops/systemd/`), which has no Arial unless someone installs
`ttf-mscorefonts-installer` and accepts its own click-through EULA.

**Arimo is metrically compatible with Arial** — same advance width for every glyph, so
line breaks, column fits and page counts are identical. It was commissioned by Google as
exactly this kind of drop-in, and it is licensed under the SIL Open Font License 1.1
(`OFL.txt`), which permits redistribution.

Verified rather than assumed — a 46-character string at 11 pt:

| Font | Width |
|---|---|
| Arimo | 248.83 pt |
| Arial (from `C:\Windows\Fonts`) | 248.83 pt |
| Helvetica (pdfkit built-in, the previous font) | 248.41 pt |

**Zero difference against Arial.** If anyone at ICTU asks, the honest description is
"a metric-compatible Arial substitute", not "we used something else".

## Files

| File | What it is |
|---|---|
| `Arimo-Regular.ttf` | Body text — weight 400 |
| `Arimo-Bold.ttf` | Headings, table headers — weight 700 |
| `OFL.txt` | SIL Open Font License 1.1. **Must ship with the fonts.** |

Both are the **Latin subset** as served by `fonts.gstatic.com` (~21 KB each rather than
~1 MB). Provenance: the static TTF URLs published by the Google Fonts API, resolved
through `gwfh.mranftl.com/api/fonts/arimo`. The upstream repository
(`google/fonts/ofl/arimo`) now ships only a **variable** font (`Arimo[wght].ttf`), which
pdfkit cannot instance — it would embed the 400 weight and have no way to reach 700 — so
the static cuts are used instead.

## ⚠️ The subset does not cover everything

Measured coverage of `Arimo-Regular.ttf`:

| Range | Coverage |
|---|---|
| ASCII printable | 95/95 ✅ |
| Latin-1 accents (`U+00A0`–`U+00FF`) | 96/96 ✅ |
| Typographic (curly quotes, en/em dash, bullet, ellipsis, €) | 9/10 — missing `‰` |
| Arrows and maths (`→ ← ≤ ≥ ≠ ≈ ✓ ✗`) | **3/11 — missing all the arrows** |

This is why `reportRenderer.js` still filters text through `renderable()`. That function
used to fold text to WinAnsi because pdfkit's built-in fonts are single-byte; it now asks
the **embedded font** whether it has a glyph, and transliterates (`→` becomes `->`) or
falls back to `?` when it does not. The check is font-driven, so replacing these files
with a fuller cut automatically widens what renders — nothing in the code needs editing.

## Replacing these

Any metric-compatible cut works: **Liberation Sans** is the same design by the same
designer and is equally safe to ship. Drop in a regular and a bold under these exact
filenames.

If ICTU later confirms a licence covering Arial redistribution, drop `arial.ttf` and
`arialbd.ttf` in under these names instead — nothing else changes, because the widths are
already identical.
