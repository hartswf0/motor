// RENDERING THE PLACE, OFFLINE.
//
// The browser has a WebGL renderer and this is not a second one: it is the same
// surface, read the same way. `surfaceHeight` is not reimplemented here — the
// ground is drawn as `Heightfield.triangles()` emits it, which is what heightAt
// evaluates, so a render and a measurement cannot disagree (THEORY.md I1).
//
// What this adds is a z-buffer and a PNG, because a client is handed a document
// rather than a tab, and a document needs a picture that is true.
//
// No dependency: zlib is in the standard library and a PNG is a header, a
// filtered scanline per row, and a deflate.

import { deflateSync } from 'node:zlib';
import * as G from '../src/core/geom.js';

// ---------------------------------------------------------------- framebuffer
export function frame(w, h, sky = [0.86, 0.88, 0.90]) {
  const px = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    // a plain vertical gradient: a horizon a person can read the land against
    const t = Math.floor(i / w) / h;
    px[i * 3] = sky[0] * (0.82 + 0.18 * t);
    px[i * 3 + 1] = sky[1] * (0.84 + 0.16 * t);
    px[i * 3 + 2] = sky[2] * (0.90 + 0.10 * t);
  }
  return { w, h, px, z: new Float32Array(w * h).fill(Infinity) };
}

// -------------------------------------------------------------------- camera
export function camera({ eye, target, up = [0, 0, 1], fov = 0.62, w, h, near = 1 }) {
  const f = norm3(sub3(target, eye));
  const r = norm3(cross3(f, up));
  const u = cross3(r, f);
  const aspect = w / h;
  const tan = Math.tan(fov / 2);
  return {
    eye, f, r, u, near,
    /** world → {x, y, depth}; depth is metres along the view axis */
    project(p) {
      const d = sub3(p, eye);
      const z = dot3(d, f);
      if (z <= near) return null;
      const x = dot3(d, r) / (z * tan * aspect);
      const y = dot3(d, u) / (z * tan);
      return { x: (x * 0.5 + 0.5) * w, y: (0.5 - y * 0.5) * h, z };
    },
  };
}

// ------------------------------------------------------------------ geometry
/**
 * A shaded triangle, depth-tested per pixel. Gouraud when three normals given.
 *
 * `tex` turns the flat colour into a lookup: the world position is interpolated
 * per pixel from the same barycentric weights the depth uses, so an aerial is
 * draped by the projection rather than by a texture matrix that could disagree
 * with it. The shading still multiplies through, which is the point — a
 * photograph tells you what is growing there and relief shading tells you the
 * shape it is growing on, and neither says the other on its own.
 */
export function tri(fb, cam, a, b, c, col, na, nb, nc, sun, tex = null) {
  const A = cam.project(a), B = cam.project(b), C = cam.project(c);
  if (!A || !B || !C) return;
  const area = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y);
  if (area === 0) return;
  const minX = Math.max(0, Math.floor(Math.min(A.x, B.x, C.x)));
  const maxX = Math.min(fb.w - 1, Math.ceil(Math.max(A.x, B.x, C.x)));
  const minY = Math.max(0, Math.floor(Math.min(A.y, B.y, C.y)));
  const maxY = Math.min(fb.h - 1, Math.ceil(Math.max(A.y, B.y, C.y)));
  if (minX > maxX || minY > maxY) return;
  const shade = (n) => {
    const l = Math.max(0, dot3(n, sun));
    // ambient rises with the normal's z: a slope in shadow still reads as ground
    return 0.52 + 0.16 * Math.max(0, n[2]) + 0.46 * l;
  };
  const sa = shade(na), sb = shade(nb || na), sc = shade(nc || na);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      let w0 = ((B.x - A.x) * (py - A.y) - (px - A.x) * (B.y - A.y)) / area;
      let w1 = ((px - A.x) * (C.y - A.y) - (C.x - A.x) * (py - A.y)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      // perspective-correct enough for depth ordering at these scales
      const z = w2 * A.z + w1 * B.z + w0 * C.z;
      const k = y * fb.w + x;
      if (z >= fb.z[k]) continue;
      fb.z[k] = z;
      const s = w2 * sa + w1 * sb + w0 * sc;
      let base = col;
      if (tex) {
        const wx = w2 * a[0] + w1 * b[0] + w0 * c[0];
        const wy = w2 * a[1] + w1 * b[1] + w0 * c[1];
        base = tex(wx, wy) || col;
      }
      fb.px[k * 3] = Math.min(1, base[0] * s);
      fb.px[k * 3 + 1] = Math.min(1, base[1] * s);
      fb.px[k * 3 + 2] = Math.min(1, base[2] * s);
    }
  }
}

/**
 * A 3D line, depth-tested, pulled toward the eye by a FIXED distance in metres.
 *
 * This bias used to be multiplicative — 0.3% of the depth — which is a different
 * quantity at every range and was wrong at both ends: at a kilometre it pulled
 * the line three and a half metres forward, so the parcel boundary showed
 * straight through the hillside in front of it, while up close it was too small
 * to stop a drive alignment from flickering in and out of the ground it lies on.
 * Half a metre is half a metre wherever you are standing.
 */
export function line(fb, cam, a, b, col, width = 1.6, bias = 0.5) {
  const A = cam.project(a), B = cam.project(b);
  if (!A || !B) return;
  const n = Math.max(1, Math.ceil(Math.hypot(B.x - A.x, B.y - A.y)));
  const half = width / 2;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = A.x + (B.x - A.x) * t, y = A.y + (B.y - A.y) * t;
    const z = (A.z + (B.z - A.z) * t) - bias;
    for (let dy = -half; dy <= half; dy += 0.5) {
      for (let dx = -half; dx <= half; dx += 0.5) {
        const xi = Math.round(x + dx), yi = Math.round(y + dy);
        if (xi < 0 || yi < 0 || xi >= fb.w || yi >= fb.h) continue;
        const k = yi * fb.w + xi;
        if (z >= fb.z[k]) continue;
        fb.z[k] = z;
        fb.px[k * 3] = col[0]; fb.px[k * 3 + 1] = col[1]; fb.px[k * 3 + 2] = col[2];
      }
    }
  }
}

/**
 * A polyline on the ground, lifted clear of it.
 *
 * Sampled every three metres, not every eight: the chord between two samples is
 * straight and the ground under it is not, so on a steep face a long chord dives
 * below the surface and the line comes out dotted. Three metres and a two-metre
 * lift keeps it above ground on everything this parcel does.
 */
export function ground_line(fb, cam, pts, groundAt, col, width = 2, lift = 2) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const steps = Math.max(1, Math.ceil(G.dist(a, b) / 3));
    for (let s = 0; s < steps; s++) {
      const p = G.lerp2(a, b, s / steps), q = G.lerp2(a, b, (s + 1) / steps);
      line(fb, cam, [p[0], p[1], groundAt(p[0], p[1]) + lift],
        [q[0], q[1], groundAt(q[0], q[1]) + lift], col, width);
    }
  }
}

/**
 * FRAME WHAT THE PICTURE IS ABOUT.
 *
 * A distance chosen by eye is a distance that is wrong the moment the parcel
 * changes, and the first four renders of this site all cut the boundary off at
 * an edge. Given the points that must be in shot, this pulls back until they
 * are — so the framing is derived from the geometry like everything else.
 */
export function fit(points, { from, pitch, w, h, fov = 0.6, margin = 0.88, lift = 0 }) {
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
  const cz = points.reduce((s, p) => s + (p[2] || 0), 0) / points.length;
  const at = [cx, cy, cz + lift];
  const a = (from * Math.PI) / 180, pi = (pitch * Math.PI) / 180;
  let dist = 600;
  for (let iter = 0; iter < 24; iter++) {
    const eye = [
      at[0] + Math.sin(a) * Math.cos(pi) * dist,
      at[1] + Math.cos(a) * Math.cos(pi) * dist,
      at[2] + Math.sin(pi) * dist,
    ];
    const cam = camera({ eye, target: at, fov, w, h });
    let worst = 0;
    for (const p of points) {
      const q = cam.project([p[0], p[1], p[2] || 0]);
      if (!q) { worst = Math.max(worst, 4); continue; }
      worst = Math.max(worst, Math.abs(q.x / w - 0.5) * 2, Math.abs(q.y / h - 0.5) * 2);
    }
    if (Math.abs(worst - margin) < 0.02) break;
    dist *= Math.max(0.55, Math.min(1.8, worst / margin));
  }
  const eye = [
    at[0] + Math.sin(a) * Math.cos(pi) * dist,
    at[1] + Math.cos(a) * Math.cos(pi) * dist,
    at[2] + Math.sin(pi) * dist,
  ];
  return { cam: camera({ eye, target: at, fov, w, h }), dist, at };
}

/** A surveyor's flag: a post you can find a small building by from a kilometre. */
export function marker(fb, cam, at, z, col, height = 34) {
  const top = [at[0], at[1], z + height];
  line(fb, cam, [at[0], at[1], z], top, col, 2.4, 0.5);
  const q = cam.project(top);
  if (!q) return;
  // the flag is drawn in screen space so it stays legible at any distance
  const s = 9;
  for (let dy = 0; dy < s; dy++) {
    for (let dx = 0; dx < s * 1.6 * (1 - dy / s / 1.4); dx++) {
      const xi = Math.round(q.x + dx + 1), yi = Math.round(q.y + dy - s / 2);
      if (xi < 0 || yi < 0 || xi >= fb.w || yi >= fb.h) continue;
      const k = yi * fb.w + xi;
      if (q.z - 1 >= fb.z[k]) continue;
      fb.z[k] = q.z - 1;
      fb.px[k * 3] = col[0]; fb.px[k * 3 + 1] = col[1]; fb.px[k * 3 + 2] = col[2];
    }
  }
}

// -------------------------------------------------------------------- ground
/**
 * The ground, exactly as `triangles()` emits it — same lattice, same diagonal.
 * Normals come from the heightfield's own slope, so a hillside shades as a
 * surface rather than as crazy paving.
 */
export function terrain(fb, cam, t, { window: win, colorFor, sun, tex = null }) {
  const i0 = Math.max(1, Math.floor((win[0] - t.bounds[0]) / t.cell));
  const i1 = Math.min(t.nx - 2, Math.ceil((win[2] - t.bounds[0]) / t.cell));
  const j0 = Math.max(1, Math.floor((win[1] - t.bounds[1]) / t.cell));
  const j1 = Math.min(t.ny - 2, Math.ceil((win[3] - t.bounds[1]) / t.cell));
  const nrm = (i, j) => {
    const d = t.cell;
    const dzdx = (t.at(i + 1, j) - t.at(i - 1, j)) / (2 * d);
    const dzdy = (t.at(i, j + 1) - t.at(i, j - 1)) / (2 * d);
    const l = Math.hypot(dzdx, dzdy, 1);
    return [-dzdx / l, -dzdy / l, 1 / l];
  };
  for (let j = j0; j < j1; j++) {
    for (let i = i0; i < i1; i++) {
      const x0 = t.bounds[0] + i * t.cell, y0 = t.bounds[1] + j * t.cell;
      const x1 = x0 + t.cell, y1 = y0 + t.cell;
      const h00 = t.at(i, j), h10 = t.at(i + 1, j), h11 = t.at(i + 1, j + 1), h01 = t.at(i, j + 1);
      const n00 = nrm(i, j), n10 = nrm(i + 1, j), n11 = nrm(i + 1, j + 1), n01 = nrm(i, j + 1);
      const c = colorFor((h00 + h10 + h11 + h01) / 4, (x0 + x1) / 2, (y0 + y1) / 2);
      tri(fb, cam, [x0, y0, h00], [x1, y0, h10], [x1, y1, h11], c, n00, n10, n11, sun, tex);
      tri(fb, cam, [x0, y0, h00], [x1, y1, h11], [x0, y1, h01], c, n00, n11, n01, sun, tex);
    }
  }
}

/** Contours, cut on the triangles the ground is drawn as — so they lie on it. */
export function contours(fb, cam, t, { window: win, interval, col, indexCol, every = 5 }) {
  const i0 = Math.max(0, Math.floor((win[0] - t.bounds[0]) / t.cell));
  const i1 = Math.min(t.nx - 2, Math.ceil((win[2] - t.bounds[0]) / t.cell));
  const j0 = Math.max(0, Math.floor((win[1] - t.bounds[1]) / t.cell));
  const j1 = Math.min(t.ny - 2, Math.ceil((win[3] - t.bounds[1]) / t.cell));
  let lo = Infinity, hi = -Infinity;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) { const v = t.at(i, j); if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  const seg = (a, b, c, level, colour) => {
    const hit = [];
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      if ((p[2] < level) === (q[2] < level)) continue;
      const f = (level - p[2]) / (q[2] - p[2]);
      hit.push([p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f, level]);
    }
    if (hit.length === 2) line(fb, cam, hit[0], hit[1], colour, 1, 0.9985);
  };
  for (let level = Math.ceil(lo / interval) * interval; level <= hi; level += interval) {
    const isIndex = Math.abs((level / interval) % every) < 1e-6;
    const colour = isIndex ? indexCol : col;
    for (let j = j0; j < j1; j++) {
      for (let i = i0; i < i1; i++) {
        const x0 = t.bounds[0] + i * t.cell, y0 = t.bounds[1] + j * t.cell;
        const x1 = x0 + t.cell, y1 = y0 + t.cell;
        const p00 = [x0, y0, t.at(i, j)], p10 = [x1, y0, t.at(i + 1, j)];
        const p11 = [x1, y1, t.at(i + 1, j + 1)], p01 = [x0, y1, t.at(i, j + 1)];
        seg(p00, p10, p11, level, colour);
        seg(p00, p11, p01, level, colour);
      }
    }
  }
}

// -------------------------------------------------------------------- solids
/** A footprint extruded between two heights: walls and a roof. */
export function prism(fb, cam, ring, zBase, zTop, side, top, sun) {
  const ccw = G.ensureCCW(ring);
  for (let i = 0, n = ccw.length; i < n; i++) {
    const a = ccw[i], b = ccw[(i + 1) % n];
    const e = G.norm(G.sub(b, a));
    const nrm = [e[1], -e[0], 0];
    const A = [a[0], a[1], zBase], B = [b[0], b[1], zBase];
    const C = [b[0], b[1], zTop], D = [a[0], a[1], zTop];
    tri(fb, cam, A, B, C, side, nrm, nrm, nrm, sun);
    tri(fb, cam, A, C, D, side, nrm, nrm, nrm, sun);
  }
  const idx = G.triangulate(ccw);
  for (let i = 0; i < idx.length; i += 3) {
    tri(fb, cam,
      [ccw[idx[i]][0], ccw[idx[i]][1], zTop],
      [ccw[idx[i + 1]][0], ccw[idx[i + 1]][1], zTop],
      [ccw[idx[i + 2]][0], ccw[idx[i + 2]][1], zTop],
      top, [0, 0, 1], [0, 0, 1], [0, 0, 1], sun);
  }
}

/** A flat thing lying on the ground, tiled so it follows the hill. */
export function draped(fb, cam, ring, groundAt, lift, col, cell, grid, sun) {
  for (const piece of G.tileRing(ring, cell, grid)) {
    const idx = G.triangulate(piece);
    for (let i = 0; i < idx.length; i += 3) {
      const v = [idx[i], idx[i + 1], idx[i + 2]].map((k) => {
        const q = piece[k];
        return [q[0], q[1], groundAt(q[0], q[1]) + lift];
      });
      tri(fb, cam, v[0], v[1], v[2], col, normalOf(v[0], v[1], v[2]), null, null, sun);
    }
  }
}

// ----------------------------------------------------------------------- png
export function png(fb) {
  const { w, h, px } = fb;
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                    // filter: none
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 3, o = y * (stride + 1) + 1 + x * 3;
      raw[o] = clamp255(px[k] * 255);
      raw[o + 1] = clamp255(px[k + 1] * 255);
      raw[o + 2] = clamp255(px[k + 2] * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
function normalOf(a, b, c) {
  const n = cross3(sub3(b, a), sub3(c, a));
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}
