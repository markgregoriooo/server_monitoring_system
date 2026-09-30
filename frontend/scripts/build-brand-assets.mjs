// Generate the served logo files from the full-resolution source.
//
//   npm run brand:assets
//
// The original 1258x1305 logo (413 KB) was served as both favicon and UI mark. The
// source is kept in brand/, not public/ (everything in public/ ships with the build).
//
// Sizes come from where the logo is used:
//   Login topbar     LogoMark size={36}   <- the largest
//   Sidebar          w-7  = 28px
//   PrivacyTerms     w-7  = 28px
//   Login footer     LogoMark size={22}
// 128px covers the largest at 3x pixel density. If the logo is ever shown larger than
// ~42px, regenerate bigger. The favicon is a single 32px image (covers 16 and 32).

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
      // `contain` with a transparent background: the logo is not square, and `cover` would
      // crop it. Matches how every call site shows it (`object-contain`).
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
