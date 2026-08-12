// THE GROUND AS IT LOOKS.
//
// The renders shade the landform, which tells a client the shape of the hill and
// nothing about what is standing on it — and twenty-seven of these twenty-nine
// acres are timber that no vector dataset sees. An aerial does not measure the
// trees, but it shows them, and "the view is over woodland" stops being a
// footnote and becomes something a person can look at.
//
// USGS NAIP, exported as PNG so the PNG reader already in this repo can decode
// it. Cached to data/ on first fetch: an import is a one-off and everything
// after it — including regenerating this report — works offline.
//
// This is imagery, not survey. It is registered by the same projection as
// everything else and it is no better than that projection.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const SERVICE = 'https://imagery.nationalmap.gov/arcgis/rest/services'
  + '/USGSNAIPPlus/ImageServer/exportImage';

/**
 * @param {object} projection  the place's own — so the picture and the model
 *                             are registered by one piece of arithmetic
 * @param {number[]} bounds    [x0, y0, x1, y1] in local metres
 */
export async function aerial(projection, bounds, { size = 2048, cache = 'data/aerial.png', log = () => {} } = {}) {
  const [sw, ne] = [projection.toWGS84(bounds[0], bounds[1]), projection.toWGS84(bounds[2], bounds[3])];
  const meta = `${bounds.map((v) => v.toFixed(1)).join(',')}@${size}`;
  const metaFile = `${cache}.txt`;

  let buf = null;
  if (existsSync(cache) && existsSync(metaFile) && readFileSync(metaFile, 'utf8') === meta) {
    buf = readFileSync(cache);
    log(`aerial: cached (${(buf.length / 1024).toFixed(0)} KB)`);
  } else {
    const url = `${SERVICE}?bbox=${sw[1]},${sw[0]},${ne[1]},${ne[0]}`
      + `&bboxSR=4326&size=${size},${size}&imageSR=4326&format=png&f=image`;
    log('aerial: fetching USGS NAIP…');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`imagery ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(cache.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(cache, buf);
    writeFileSync(metaFile, meta);
    log(`aerial: ${(buf.length / 1024).toFixed(0)} KB fetched and cached`);
  }

  const { width, height, px } = decodePNG(buf);
  // The export is in DEGREES — a square pixel grid over an unequal-area box —
  // so a point is placed by its longitude and latitude, not by its metres.
  const lon0 = sw[1], lon1 = ne[1], lat0 = sw[0], lat1 = ne[0];
  return {
    width, height,
    attribution: 'USGS NAIP (National Map), public domain',
    /** local metres → [r, g, b] in 0..1, or null outside the frame */
    sample(x, y) {
      const [lat, lon] = projection.toWGS84(x, y);
      const u = (lon - lon0) / (lon1 - lon0);
      const v = (lat1 - lat) / (lat1 - lat0);
      if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
      const i = (Math.floor(v * height) * width + Math.floor(u * width)) * 3;
      return [px[i] / 255, px[i + 1] / 255, px[i + 2] / 255];
    },
  };
}

/** Baseline PNG, 8-bit RGB or RGBA. The same shape as the terrarium reader. */
export function decodePNG(buf) {
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
      if (depth !== 8 || (colour !== 2 && colour !== 6)) {
        throw new Error(`unsupported PNG (depth ${depth}, colour ${colour})`);
      }
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const ch = colour === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= ch ? prev[i - ch] : 0;
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
  if (ch === 3) return { width, height, px: out };
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0, j = 0; i < out.length; i += 4, j += 3) {
    rgb[j] = out[i]; rgb[j + 1] = out[i + 1]; rgb[j + 2] = out[i + 2];
  }
  return { width, height, px: rgb };
}
