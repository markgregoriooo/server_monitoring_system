// Generate the served logo assets from the full-resolution source.
//
//   npm run brand:assets
//
// WHY THIS EXISTS. The 1258x1305 institutional logo was being served directly as both
// the favicon and the UI mark — 413 KB downloaded by every visitor to draw a 36px
// square and a 16px tab icon, on the critical path for the first paint. Browsers
// downscale happily, so nothing looked wrong; it was simply ~400 KB of waste that no
// one could see.
//
// The source stays in the repo (brand/, NOT public/) because it is what these are
// regenerated from. Anything under public/ is copied verbatim into the build, so
// leaving the original there would keep shipping it even once nothing referenced it.
//
// SIZES ARE DERIVED FROM THE CALL SITES, not guessed:
//   Login topbar     LogoMark size={36}   <- the largest
//   Sidebar          w-7  = 28px
//   PrivacyTerms     w-7  = 28px
//   Login footer     LogoMark size={22}
// 128px covers the largest of those at 3x device-pixel-ratio with headroom, which is
// as far as it is worth going: past 3x the difference stops being visible and the file
// only gets bigger. If a call site ever renders the mark larger than ~42px, revisit.
//
// The favicon is 32px. Browsers ask for 16 or 32; a single 32 covers both, and an .ico
// with multiple frames buys nothing when the artwork is one flat mark.

import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const SOURCE = path.join(root, "brand", "cspc-logo-source.png");
const PUBLIC = path.join(root, "public");

/** [output filename, pixel size] */
const TARGETS = [
  ["favicon.png", 32],
  ["logo-128.png", 128],
];

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

async function main() {
  let src;
  try {
    src = await fs.readFile(SOURCE);
  } catch {
    console.error(
      `Source not found: ${SOURCE}\n` +
        "This script regenerates the served assets from the full-resolution logo.\n" +
        "Put the original there (it is deliberately outside public/ so it is not shipped).",
    );
    process.exit(1);
  }

  const meta = await sharp(src).metadata();
  console.log(`source  ${meta.width}x${meta.height}  ${kb(src.length)}\n`);

  for (const [name, size] of TARGETS) {
    const out = path.join(PUBLIC, name);
    await sharp(src)
      // `contain` + a transparent background: the mark is not square (1258x1305), and
      // `cover` would crop it to fit. Letterboxing into a square keeps the whole logo
      // and matches how every call site renders it (`object-contain`).
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9, palette: true })
      .toFile(out);
    const { size: bytes } = await fs.stat(out);
    console.log(`  ${name.padEnd(16)} ${String(size).padStart(3)}px   ${kb(bytes)}`);
  }

  console.log("\nReferenced by index.html (favicon) and VITE_LOGO_SRC in .env (UI mark).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
