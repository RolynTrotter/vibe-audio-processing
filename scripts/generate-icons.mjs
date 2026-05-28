// Generate the PWA icons as PNGs with zero dependencies (pure zlib).
// Draws two overlapping translucent circles on a dark gradient — a nod to the
// "A ✻ B" convolution idea. Run with: npm run icons

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  // Each row is prefixed with a filter byte (0 = none).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function draw(size, { maskable = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const r1 = { x: size * 0.40, y: size * 0.42, rad: size * 0.26, col: [124, 92, 255] };
  const r2 = { x: size * 0.60, y: size * 0.58, rad: size * 0.26, col: [0, 212, 200] };
  const safe = maskable ? size * 0.45 : size; // keep art inside maskable safe zone

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Dark vertical gradient background.
      const t = y / size;
      let r = Math.round(15 + 18 * t);
      let g = Math.round(16 + 14 * t);
      let b = Math.round(32 + 30 * t);

      const inSafe = Math.hypot(x - cx, y - cy) <= safe;
      if (inSafe) {
        for (const c of [r1, r2]) {
          const d = Math.hypot(x - c.x, y - c.y);
          if (d < c.rad) {
            const a = 0.7 * (1 - d / c.rad) + 0.2; // soft, additive
            r = Math.min(255, Math.round(r * (1 - a) + c.col[0] * a));
            g = Math.min(255, Math.round(g * (1 - a) + c.col[1] * a));
            b = Math.min(255, Math.round(b * (1 - a) + c.col[2] * a));
          }
        }
      }
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
    }
  }
  return encodePng(size, rgba);
}

writeFileSync(join(outDir, 'icon-192.png'), draw(192));
writeFileSync(join(outDir, 'icon-512.png'), draw(512));
writeFileSync(join(outDir, 'icon-maskable-512.png'), draw(512, { maskable: true }));
console.log('Wrote icon-192.png, icon-512.png, icon-maskable-512.png');
