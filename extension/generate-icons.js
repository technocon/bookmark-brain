// Regenerates icons/icon{16,32,48,128}.png from icons/brain-master.png --
// the real brand brain glyph (transparent background, padded to a square),
// exported once at 512x512 from the logo source files. Downscales with
// macOS's built-in `sips` -- no image-processing dependency (no
// sharp/canvas), same reasoning as this project avoiding native modules
// elsewhere (the better-sqlite3 build issues early on).
//
// History: this used to draw the 🧠 emoji on a solid black square (an SVG
// per size, rasterized with sips); before that, an even earlier version
// hand-drew a synthetic bookmark-ribbon glyph via raw pixel math. Worth
// knowing if you're looking at old history, since neither approach used
// the actual brand mark.
//
// macOS-only (sips isn't available elsewhere) -- there's no CI/build step
// depending on this, it's a one-off run-by-hand generator. To update the
// icon art itself, replace icons/brain-master.png (keep it square, padded,
// transparent background) and rerun this script.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIZES = [16, 32, 48, 128];
const outDir = path.join(__dirname, 'icons');
const masterPath = path.join(outDir, 'brain-master.png');

for (const size of SIZES) {
  const pngPath = path.join(outDir, `icon${size}.png`);
  execFileSync('sips', ['-z', String(size), String(size), masterPath, '--out', pngPath], { stdio: 'ignore' });
  console.log(`wrote icons/icon${size}.png (${size}x${size})`);
}
