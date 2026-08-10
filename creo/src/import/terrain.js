// REAL GROUND, ANYWHERE.
//
// Elevation from the public terrarium tile set (AWS open data, no key, CORS
// enabled). Each tile is a 256×256 PNG in which every pixel encodes a height:
//
//     metres = (R × 256 + G + B / 256) − 32768
//
// A raster beats point sampling: no rate limit, no daily budget, and the
// resolution is the DEM's own rather than whatever grid we could afford to ask
// for. The same decoder runs in the browser (canvas) and in Node (zlib), so a
// place imported in the app and a place imported from the CLI get identical
// terrain.

import { Heightfield } from '../core/place.js';

const TILE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const SIZE = 256;

const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z;
const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const y2lat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

/** Ground resolution of a tile pixel, in metres, at this latitude and zoom. */
export const pixelMetres = (lat, z) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

/**
 * Choose the zoom whose pixels are about `targetM` metres. Terrarium data is
 * only genuinely detailed to about z14 in most of the world; asking for z16
 * returns upsampled values and would invent relief that is not measured.
 */
export function chooseZoom(lat, targetM = 20, max = 14) {
  for (let z = max; z >= 8; z--) if (pixelMetres(lat, z) >= targetM) return z;
  return max;
}

/**
 * @param {[number,number,number,number]} bbox [south, west, north, east]
 * @returns {Promise<{heightfield:Heightfield, datum:number, relief:number, attribution:string}>}
 */
export async function sampleTerrain(bbox, projection, bounds, {
  zoom = null, fetchImpl = fetch, decode = null, log = () => {}, maxTiles = 16,
} = {}) {
  const [s, w, n, e] = bbox;
  const midLat = (s + n) / 2;
  let z = zoom ?? chooseZoom(midLat, 20);

  let x0, x1, y0, y1;
  for (;;) {
    x0 = Math.floor(lon2x(w, z)); x1 = Math.floor(lon2x(e, z));
    y0 = Math.floor(lat2y(n, z)); y1 = Math.floor(lat2y(s, z));
    const count = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (count <= maxTiles || z <= 8) break;
    z--;                                    // a wide area gets coarser ground, not more requests
  }

  const decoder = decode || (typeof document !== 'undefined' ? decodeInBrowser : await nodeDecoder());
  const tiles = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      log(`terrain tile ${tiles.length + 1}/${(x1 - x0 + 1) * (y1 - y0 + 1)} (z${z})`);
      try {
        tiles.push({ tx, ty, px: await decoder(`${TILE}/${z}/${tx}/${ty}.png`, fetchImpl) });
      } catch (err) {
        log(`tile ${tx},${ty} unavailable (${String(err.message).slice(0, 40)}) — treated as flat`);
      }
    }
  }
  if (!tiles.length) throw new Error('no terrain tiles could be read');

  /** Height in metres at a geographic point, bilinear across the tile grid. */
  const heightAtLatLon = (lat, lon) => {
    const fx = lon2x(lon, z), fy = lat2y(lat, z);
    const tx = Math.floor(fx), ty = Math.floor(fy);
    const tile = tiles.find((t) => t.tx === tx && t.ty === ty);
    if (!tile) return null;
    const u = (fx - tx) * SIZE, v = (fy - ty) * SIZE;
    const i0 = Math.max(0, Math.min(SIZE - 1, Math.floor(u)));
    const j0 = Math.max(0, Math.min(SIZE - 1, Math.floor(v)));
    const i1 = Math.min(SIZE - 1, i0 + 1), j1 = Math.min(SIZE - 1, j0 + 1);
    const du = u - i0, dv = v - j0;
    const at = (i, j) => tile.px[j * SIZE + i];
    const a = at(i0, j0), b = at(i1, j0), c = at(i0, j1), d = at(i1, j1);
    return (a * (1 - du) + b * du) * (1 - dv) + (c * (1 - du) + d * du) * dv;
  };

  // Build the heightfield in local metres, at the DEM's own resolution.
  const cell = Math.max(6, pixelMetres(midLat, z));
  const hf = new Heightfield(bounds, cell);
  const raw = new Float32Array(hf.nx * hf.ny);
  let lo = Infinity, hi = -Infinity, missing = 0;
  for (let j = 0; j < hf.ny; j++) {
    for (let i = 0; i < hf.nx; i++) {
      const x = bounds[0] + i * cell, y = bounds[1] + j * cell;
      const [lat, lon] = projection.toWGS84(x, y);
      const h = heightAtLatLon(lat, lon);
      if (h === null) { missing++; raw[hf.idx(i, j)] = NaN; continue; }
      raw[hf.idx(i, j)] = h;
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  }
  if (!isFinite(lo)) throw new Error('terrain tiles covered none of this place');
  // Relief above the lowest point is what the water model needs; absolute
  // altitude would only add a constant.
  for (let k = 0; k < raw.length; k++) hf.data[k] = Number.isNaN(raw[k]) ? 0 : raw[k] - lo;

  return {
    heightfield: hf,
    datum: lo,
    relief: +(hi - lo).toFixed(1),
    zoom: z,
    tiles: tiles.length,
    attribution: `terrarium z${z} (~${pixelMetres(midLat, z).toFixed(0)} m/px) via AWS open data — relief ${(hi - lo).toFixed(1)} m${missing ? `, ${missing} cells outside tile coverage` : ''}`,
  };
}

// --------------------------------------------------------------- decoders ---
/** Browser: let the platform decode the PNG. */
async function decodeInBrowser(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error('tile load failed'));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = SIZE; canvas.height = SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, SIZE, SIZE);
  const d = ctx.getImageData(0, 0, SIZE, SIZE).data;
  const out = new Float32Array(SIZE * SIZE);
  for (let k = 0, p = 0; k < out.length; k++, p += 4) {
    out[k] = d[p] * 256 + d[p + 1] + d[p + 2] / 256 - 32768;
  }
  return out;
}

/** Node: a minimal PNG reader. No dependency — zlib is in the standard library. */
async function nodeDecoder() {
  const { inflateSync } = await import('node:zlib');
  return async (url, fetchImpl) => {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`tile ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return decodePNGHeights(buf, inflateSync);
  };
}

export function decodePNGHeights(buf, inflateSync) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0, depth = 0, colour = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colour = data[9];
      if (depth !== 8 || (colour !== 2 && colour !== 6)) throw new Error(`unsupported PNG (depth ${depth}, colour ${colour})`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = colour === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(height * stride);

  // Undo PNG's per-scanline filters.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
  }

  const out = new Float32Array(width * height);
  for (let k = 0; k < out.length; k++) {
    const p = k * channels;
    out[k] = px[p] * 256 + px[p + 1] + px[p + 2] / 256 - 32768;
  }
  return out;
}
