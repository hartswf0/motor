// BASELINE JPEG, BY HAND.
//
// The report was 8.4 MB and every byte of it was pictures. PNG is lossless and
// that is exactly wrong for these: three of the four renders are photographic
// aerial, where lossless means storing the sensor noise of a leaf-off forest at
// full fidelity. On a phone on a rural connection — which is where a client
// actually opens a site report — 8.4 MB is not a document, it is a download.
//
// So: baseline JPEG, 4:2:0, standard tables. No dependency, for the same reason
// the PNG reader in src/import/terrain.js has none.
//
// The renders that are DRAWINGS rather than photographs still want PNG — a
// contour line is one pixel wide and JPEG rings around it — so this does not
// replace the encoder beside it, it sits next to it and each is used for what
// it is good at.

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

const Q_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const Q_CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

const DC_LUMA_BITS = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_LUMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const DC_CHROMA_BITS = [0, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_CHROMA_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_BITS = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];
const AC_CHROMA_BITS = [0, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALS = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

/**
 * bits[] in the JPEG sense (counts per length) + values → {code, length} per value.
 *
 * The code ADVANCES for every value at a length and only then shifts for the
 * next. Leaving the increment out gives every symbol of the same length the
 * same code, which is not a Huffman table at all — and it survives a solid
 * colour, because a flat block spends two symbols and never collides. It was
 * the first image with any variety in it that came back as green stripes.
 */
function huffTable(bits, vals) {
  const out = new Map();
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len]; i++) out.set(vals[k++], { code: code++, length: len });
    code <<= 1;
  }
  return out;
}

function scaled(table, quality) {
  const q = Math.max(1, Math.min(100, quality));
  const s = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  return table.map((v) => Math.max(1, Math.min(255, Math.floor((v * s + 50) / 100))));
}

class Bits {
  constructor() { this.bytes = []; this.acc = 0; this.n = 0; }
  write(code, length) {
    for (let i = length - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((code >> i) & 1);
      this.n++;
      if (this.n === 8) {
        this.bytes.push(this.acc & 0xff);
        if ((this.acc & 0xff) === 0xff) this.bytes.push(0);   // byte stuffing
        this.acc = 0; this.n = 0;
      }
    }
  }
  flush() { while (this.n) this.write(1, 1); }
}

/** Forward DCT-II on an 8×8 block, separable. */
const COS = (() => {
  const c = new Float64Array(64);
  for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) c[u * 8 + x] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  return c;
})();
function fdct(block, out) {
  const tmp = new Float64Array(64);
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let s = 0;
      for (let x = 0; x < 8; x++) s += block[y * 8 + x] * COS[u * 8 + x];
      tmp[y * 8 + u] = s * (u === 0 ? Math.SQRT1_2 : 1);
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let s = 0;
      for (let y = 0; y < 8; y++) s += tmp[y * 8 + u] * COS[v * 8 + y];
      out[v * 8 + u] = (s * (v === 0 ? Math.SQRT1_2 : 1)) / 4;
    }
  }
}

const magnitude = (v) => { let n = 0; let a = Math.abs(v); while (a) { n++; a >>= 1; } return n; };

/**
 * @param {{w:number,h:number,px:Float32Array}} fb  the framebuffer render.mjs makes
 * @param {number} quality 1..100
 */
export function jpeg(fb, quality = 82) {
  const { w, h, px } = fb;
  const qL = scaled(Q_LUMA, quality), qC = scaled(Q_CHROMA, quality);
  const dcL = huffTable(DC_LUMA_BITS, DC_LUMA_VALS), acL = huffTable(AC_LUMA_BITS, AC_LUMA_VALS);
  const dcC = huffTable(DC_CHROMA_BITS, DC_CHROMA_VALS), acC = huffTable(AC_CHROMA_BITS, AC_CHROMA_VALS);

  // RGB → YCbCr, full frame. Chroma is subsampled 2×2 when it is read.
  const n = w * h;
  const Y = new Float32Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = clamp(px[i * 3] * 255), g = clamp(px[i * 3 + 1] * 255), b = clamp(px[i * 3 + 2] * 255);
    Y[i] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
    Cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
    Cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
  }

  const bits = new Bits();
  const block = new Float64Array(64), coeff = new Float64Array(64);
  const prev = [0, 0, 0];

  const encodeBlock = (fill, q, dcT, acT, ci) => {
    fill(block);
    fdct(block, coeff);
    const zz = new Int32Array(64);
    for (let i = 0; i < 64; i++) {
      const z = ZIGZAG[i];
      zz[i] = Math.round(coeff[z] / q[z]);
    }
    const diff = zz[0] - prev[ci];
    prev[ci] = zz[0];
    const dcSize = magnitude(diff);
    const dcCode = dcT.get(dcSize);
    bits.write(dcCode.code, dcCode.length);
    if (dcSize) bits.write(diff < 0 ? diff + (1 << dcSize) - 1 : diff, dcSize);
    let run = 0;
    for (let i = 1; i < 64; i++) {
      if (zz[i] === 0) { run++; continue; }
      while (run > 15) { const zrl = acT.get(0xf0); bits.write(zrl.code, zrl.length); run -= 16; }
      const size = magnitude(zz[i]);
      const sym = acT.get((run << 4) | size);
      bits.write(sym.code, sym.length);
      bits.write(zz[i] < 0 ? zz[i] + (1 << size) - 1 : zz[i], size);
      run = 0;
    }
    if (run) { const eob = acT.get(0x00); bits.write(eob.code, eob.length); }
  };

  // 4:2:0 — one 16×16 MCU is four luma blocks and one of each chroma
  const mcuX = Math.ceil(w / 16), mcuY = Math.ceil(h / 16);
  const at = (arr, x, y) => arr[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let my = 0; my < mcuY; my++) {
    for (let mx = 0; mx < mcuX; mx++) {
      for (const [bx, by] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        encodeBlock((b) => {
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
            b[y * 8 + x] = at(Y, mx * 16 + bx * 8 + x, my * 16 + by * 8 + y);
          }
        }, qL, dcL, acL, 0);
      }
      for (const [plane, ci] of [[Cb, 1], [Cr, 2]]) {
        encodeBlock((b) => {
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
            // average the 2×2 the subsampling stands for, rather than picking one
            const sx = mx * 16 + x * 2, sy = my * 16 + y * 2;
            b[y * 8 + x] = (at(plane, sx, sy) + at(plane, sx + 1, sy)
              + at(plane, sx, sy + 1) + at(plane, sx + 1, sy + 1)) / 4;
          }
        }, qC, dcC, acC, ci);
      }
    }
  }
  bits.flush();

  // ------------------------------------------------------------------ markers
  const out = [];
  const u8 = (...v) => out.push(...v);
  const u16 = (v) => out.push((v >> 8) & 0xff, v & 0xff);
  u8(0xff, 0xd8);                                                   // SOI
  u8(0xff, 0xe0); u16(16); u8(0x4a, 0x46, 0x49, 0x46, 0);           // APP0 'JFIF'
  u8(1, 1, 0); u16(1); u16(1); u8(0, 0);
  u8(0xff, 0xdb); u16(67); u8(0); for (let i = 0; i < 64; i++) u8(qL[ZIGZAG[i]]);
  u8(0xff, 0xdb); u16(67); u8(1); for (let i = 0; i < 64; i++) u8(qC[ZIGZAG[i]]);
  u8(0xff, 0xc0); u16(17); u8(8); u16(h); u16(w); u8(3);            // SOF0
  u8(1, 0x22, 0); u8(2, 0x11, 1); u8(3, 0x11, 1);                   // 4:2:0
  const dht = (cls, id, bitCounts, vals) => {
    u8(0xff, 0xc4); u16(3 + 16 + vals.length); u8((cls << 4) | id);
    for (let i = 1; i <= 16; i++) u8(bitCounts[i]);
    u8(...vals);
  };
  dht(0, 0, DC_LUMA_BITS, DC_LUMA_VALS);
  dht(1, 0, AC_LUMA_BITS, AC_LUMA_VALS);
  dht(0, 1, DC_CHROMA_BITS, DC_CHROMA_VALS);
  dht(1, 1, AC_CHROMA_BITS, AC_CHROMA_VALS);
  u8(0xff, 0xda); u16(12); u8(3); u8(1, 0x00); u8(2, 0x11); u8(3, 0x11); u8(0, 63, 0);  // SOS
  // NOT `out.push(...bits.bytes)`: a megapixel render is hundreds of thousands
  // of entropy bytes and spreading them into a call blows the argument stack.
  const head = Buffer.from(out);
  return Buffer.concat([head, Buffer.from(bits.bytes), Buffer.from([0xff, 0xd9])]);
}

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
