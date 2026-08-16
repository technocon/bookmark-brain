// One-off icon generator — no image deps (avoids the native-module build
// issues this project already hit with better-sqlite3). Draws a simple
// rounded-square + bookmark-ribbon glyph directly to raw PNG bytes using
// only Node's built-in zlib for compression.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ACCENT = hexToRgb('#8b7cf6');
const GLYPH = [245, 243, 255];

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  const ihdr = chunk('IHDR', ihdrData);

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = chunk('IDAT', zlib.deflateSync(raw));
  const iend = chunk('IEND', Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

// Signed distance function for a rounded box, centered coordinates.
function roundedBoxSDF(px, py, halfSize, radius) {
  const qx = Math.abs(px) - (halfSize - radius);
  const qy = Math.abs(py) - (halfSize - radius);
  const outside = Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2);
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const cornerRadius = size * 0.22;
  const half = size / 2;

  // Ribbon (bookmark tag) geometry.
  const left = size * 0.3;
  const right = size * 0.7;
  const top = size * 0.22;
  const bottomOuter = size * 0.8;
  const notchTopY = size * 0.6;
  const cx = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const sdf = roundedBoxSDF(x + 0.5 - half, y + 0.5 - half, half, cornerRadius);

      if (sdf > 0) {
        buf[idx + 3] = 0; // transparent outside the rounded square
        continue;
      }

      buf[idx] = ACCENT[0];
      buf[idx + 1] = ACCENT[1];
      buf[idx + 2] = ACCENT[2];
      buf[idx + 3] = 255;

      const inRibbonBounds = x >= left && x <= right && y >= top && y <= bottomOuter;
      if (inRibbonBounds) {
        let inNotch = false;
        if (y >= notchTopY) {
          const t = (y - notchTopY) / (bottomOuter - notchTopY);
          const leftEdge = left + (cx - left) * t;
          const rightEdge = right - (right - cx) * t;
          inNotch = x >= leftEdge && x <= rightEdge;
        }
        if (!inNotch) {
          buf[idx] = GLYPH[0];
          buf[idx + 1] = GLYPH[1];
          buf[idx + 2] = GLYPH[2];
        }
      }
    }
  }

  return buf;
}

const outDir = path.join(__dirname, 'icons');
fs.mkdirSync(outDir, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const png = encodePNG(size, size, drawIcon(size));
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), png);
  console.log(`wrote icons/icon${size}.png`);
}
