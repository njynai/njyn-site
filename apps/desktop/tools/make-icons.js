#!/usr/bin/env node
/**
 * Generates the njyn tray/app icons with zero dependencies.
 *
 * The mark is the njyn.ai logo: a hexagon outline with a solid core.
 *   idle      - parchment hexagon, gold core
 *   recording - gold hexagon, red core
 *
 * Rendered by 4x supersampled signed-distance rasterisation, then encoded to
 * PNG by hand (IHDR/IDAT/IEND + CRC32) so the build needs no image library.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PALETTE = {
  parchment: [232, 228, 240],
  gold: [201, 169, 110],
  red: [232, 74, 74],
};

/* ---------------------------------------------------------------- geometry */

// Distance from point p to the segment ab.
function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const len2 = abx * abx + aby * aby;
  let t = len2 === 0 ? 0 : (apx * abx + apy * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (ax + t * abx);
  const dy = py - (ay + t * aby);
  return Math.sqrt(dx * dx + dy * dy);
}

// Hexagon vertices matching the site logo's polygon, normalised to 0..1.
const HEX = [
  [0.5, 0.04],
  [0.9, 0.27],
  [0.9, 0.73],
  [0.5, 0.96],
  [0.1, 0.73],
  [0.1, 0.27],
];

function distToHexOutline(x, y) {
  let best = Infinity;
  for (let i = 0; i < HEX.length; i++) {
    const a = HEX[i];
    const b = HEX[(i + 1) % HEX.length];
    best = Math.min(best, distToSegment(x, y, a[0], a[1], b[0], b[1]));
  }
  return best;
}

/* --------------------------------------------------------------- rasteriser */

/**
 * @param {number} size    output edge length in pixels
 * @param {number[]} ring   RGB of the hexagon outline
 * @param {number[]} core   RGB of the centre dot
 * @returns {Buffer} RGBA pixel data, size * size * 4
 */
function renderMark(size, ring, core) {
  const SS = 4; // supersample factor
  const px = Buffer.alloc(size * size * 4);

  // Stroke width and core radius in normalised units, nudged up at tiny sizes
  // so a 16px tray icon stays legible.
  const stroke = size <= 20 ? 0.055 : 0.038;
  const coreR = size <= 20 ? 0.15 : 0.115;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rAcc = 0;
      let gAcc = 0;
      let bAcc = 0;
      let aAcc = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;

          // Core wins over the ring where they overlap (they do not, but be safe).
          const dCore = Math.sqrt((u - 0.5) ** 2 + (v - 0.5) ** 2);
          if (dCore <= coreR) {
            rAcc += core[0];
            gAcc += core[1];
            bAcc += core[2];
            aAcc += 255;
            continue;
          }

          const dRing = distToHexOutline(u, v);
          if (dRing <= stroke / 2) {
            rAcc += ring[0];
            gAcc += ring[1];
            bAcc += ring[2];
            aAcc += 255;
          }
        }
      }

      const samples = SS * SS;
      const alpha = aAcc / samples;
      const i = (y * size + x) * 4;
      if (alpha > 0) {
        // Un-premultiply: the accumulated colour only counted covered samples.
        const covered = aAcc / 255;
        px[i] = Math.round(rAcc / covered);
        px[i + 1] = Math.round(gAcc / covered);
        px[i + 2] = Math.round(bAcc / covered);
        px[i + 3] = Math.round(alpha);
      }
    }
  }
  return px;
}

/* --------------------------------------------------------------- PNG output */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const src = y * size * 4;
    const dst = y * (size * 4 + 1);
    raw[dst] = 0;
    rgba.copy(raw, dst + 1, src, src + size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Windows .ico container holding PNG-compressed entries. */
function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);

  const entries = [];
  let offset = 6 + pngs.length * 16;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 means 256
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; // palette size
    e[3] = 0; // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32BE(0, 8);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

/* ------------------------------------------------------------------- driver */

const outDir = path.join(__dirname, "..", "assets");
fs.mkdirSync(outDir, { recursive: true });

const VARIANTS = {
  idle: { ring: PALETTE.parchment, core: PALETTE.gold },
  rec: { ring: PALETTE.gold, core: PALETTE.red },
};

// Tray icons: small, and @2x for HiDPI displays.
for (const [name, colors] of Object.entries(VARIANTS)) {
  for (const [suffix, size] of [["", 16], ["@2x", 32], ["@3x", 48]]) {
    const png = encodePng(size, renderMark(size, colors.ring, colors.core));
    fs.writeFileSync(path.join(outDir, `tray-${name}${suffix}.png`), png);
  }
}

// Application icon: 256px PNG for Linux/macOS, multi-size .ico for Windows.
const appPng = encodePng(256, renderMark(256, PALETTE.parchment, PALETTE.gold));
fs.writeFileSync(path.join(outDir, "icon.png"), appPng);

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
fs.writeFileSync(
  path.join(outDir, "icon.ico"),
  encodeIco(
    icoSizes.map((size) => ({
      size,
      data: encodePng(size, renderMark(size, PALETTE.parchment, PALETTE.gold)),
    })),
  ),
);

console.log(`Wrote icons to ${outDir}`);
