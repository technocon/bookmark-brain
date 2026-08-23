// Regenerates icons/icon{16,32,48,128}.png: the 🧠 emoji on a solid black
// square, matching the brand mark used everywhere else (favicon, the
// og-image). Builds an SVG per size (font-size/baseline tuned per size
// rather than naively downscaling one master, so it stays crisp at 16px)
// and rasterizes with macOS's built-in `sips` -- no image-processing
// dependency (no sharp/canvas), same reasoning as this project avoiding
// native modules elsewhere (the better-sqlite3 build issues early on).
//
// This replaces an earlier version of this script that hand-drew a
// synthetic bookmark-ribbon glyph via raw pixel math -- worth knowing if
// you're looking at old history, since that approach couldn't render an
// actual emoji at all, only simple flat shapes.
//
// macOS-only (sips isn't available elsewhere) -- there's no CI/build step
// depending on this, it's a one-off run-by-hand generator.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SIZES = [16, 32, 48, 128];
const outDir = path.join(__dirname, 'icons');
fs.mkdirSync(outDir, { recursive: true });

function svgFor(size) {
  const fontSize = size * 0.82;
  const y = size * 0.5 + size * 0.3;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#000000"/>
  <text x="${size / 2}" y="${y}" text-anchor="middle" font-size="${fontSize}" font-family="Apple Color Emoji">🧠</text>
</svg>
`;
}

for (const size of SIZES) {
  const svgPath = path.join(outDir, `.icon${size}-tmp.svg`);
  const pngPath = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(svgPath, svgFor(size));
  execFileSync('sips', ['-s', 'format', 'png', svgPath, '--out', pngPath], { stdio: 'ignore' });
  fs.unlinkSync(svgPath);
  console.log(`wrote icons/icon${size}.png`);
}
