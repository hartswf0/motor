// CAD-grade 2.5D geometry substrate.
//
// Everything in CREO is real polygon footprints with vertical intervals in metres
// (local ENU tangent plane). Axis-aligned boxes exist only as broadphase
// acceleration structures — they are never spatial truth.

export const EPS = 1e-9;

// ---------------------------------------------------------------- vectors ---
export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const mul = (a, s) => [a[0] * s, a[1] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
export const len = (a) => Math.hypot(a[0], a[1]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
export const perp = (a) => [-a[1], a[0]];
export const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

// ---------------------------------------------------------------- rings -----
/** Signed area. Positive = counter-clockwise. */
export function signedArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}
export const area = (ring) => Math.abs(signedArea(ring));

export function ensureCCW(ring) {
  return signedArea(ring) < 0 ? ring.slice().reverse() : ring.slice();
}

export function centroid(ring) {
  const a2 = signedArea(ring) * 2;
  if (Math.abs(a2) < 1e-12) {
    // Degenerate: fall back to vertex mean so callers still get a usable anchor.
    let x = 0, y = 0;
    for (const p of ring) { x += p[0]; y += p[1]; }
    return [x / ring.length, y / ring.length];
  }
  let x = 0, y = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    const f = p[0] * q[1] - q[0] * p[1];
    x += (p[0] + q[0]) * f;
    y += (p[1] + q[1]) * f;
  }
  return [x / (3 * a2), y / (3 * a2)];
}

export function perimeter(ring, closed = true) {
  let s = 0;
  const n = ring.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) s += dist(ring[i], ring[(i + 1) % n]);
  return s;
}

export function bbox(ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of ring) {
    if (p[0] < x0) x0 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[0] > x1) x1 = p[0];
    if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
}

export const bboxOverlap = (a, b) => !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);

export function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > pt[1]) !== (b[1] > pt[1]) &&
        pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

// ------------------------------------------------------------- segments -----
export function segIntersect(p1, p2, p3, p4) {
  const d1 = sub(p2, p1), d2 = sub(p4, p3);
  const den = cross(d1, d2);
  const dp = sub(p3, p1);
  if (Math.abs(den) < 1e-12) return null;          // parallel / collinear
  const t = cross(dp, d2) / den;
  const u = cross(dp, d1) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { point: [p1[0] + d1[0] * t, p1[1] + d1[1] * t], t, u };
}

export function closestPointOnSeg(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 < 1e-12) return { point: a.slice(), t: 0, d: dist(p, a) };
  let t = dot(sub(p, a), ab) / l2;
  t = Math.max(0, Math.min(1, t));
  const q = [a[0] + ab[0] * t, a[1] + ab[1] * t];
  return { point: q, t, d: dist(p, q) };
}

/** Closest point on a closed ring or open polyline. */
export function closestOnRing(p, ring, closed = true) {
  let best = { d: Infinity };
  const n = ring.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const r = closestPointOnSeg(p, ring[i], ring[(i + 1) % n]);
    if (r.d < best.d) best = { ...r, i };
  }
  return best;
}

// --------------------------------------------------- polygon relationships --
/** True when two simple polygons share interior area (edges crossing OR containment). */
export function ringsIntersect(A, B) {
  if (!bboxOverlap(bbox(A), bbox(B))) return false;
  for (let i = 0, n = A.length; i < n; i++) {
    for (let j = 0, m = B.length; j < m; j++) {
      if (segIntersect(A[i], A[(i + 1) % n], B[j], B[(j + 1) % m])) return true;
    }
  }
  return pointInRing(A[0], B) || pointInRing(B[0], A);
}

export const ringContains = (outer, inner) => inner.every((p) => pointInRing(p, outer));

/** Minimum distance between two rings. 0 when they touch or overlap. */
export function ringDistance(A, B) {
  if (ringsIntersect(A, B)) return 0;
  let best = Infinity;
  for (const p of A) { const r = closestOnRing(p, B); if (r.d < best) best = r.d; }
  for (const p of B) { const r = closestOnRing(p, A); if (r.d < best) best = r.d; }
  return best;
}

/** Does an open polyline cross a closed ring's boundary or run through it? */
export function polylineCrossesRing(line, ring) {
  for (let i = 0; i < line.length - 1; i++) {
    for (let j = 0, m = ring.length; j < m; j++) {
      if (segIntersect(line[i], line[i + 1], ring[j], ring[(j + 1) % m])) return true;
    }
  }
  return line.some((p) => pointInRing(p, ring));
}

export function polylineRingDistance(line, ring) {
  if (polylineCrossesRing(line, ring)) return 0;
  let best = Infinity;
  for (const p of line) { const r = closestOnRing(p, ring); if (r.d < best) best = r.d; }
  for (const p of ring) { const r = closestOnRing(p, line, false); if (r.d < best) best = r.d; }
  return best;
}

// ------------------------------------------------------------ transforms ----
export function transformRing(ring, { translate = [0, 0], rotate = 0, scale = 1, origin = null }) {
  const o = origin || centroid(ring);
  const c = Math.cos(rotate), s = Math.sin(rotate);
  const sx = Array.isArray(scale) ? scale[0] : scale;
  const sy = Array.isArray(scale) ? scale[1] : scale;
  return ring.map(([x, y]) => {
    let dx = (x - o[0]) * sx, dy = (y - o[1]) * sy;
    const rx = dx * c - dy * s, ry = dx * s + dy * c;
    return [o[0] + rx + translate[0], o[1] + ry + translate[1]];
  });
}

/**
 * Scale a ring along its OWN axes rather than the world's.
 * Widening a building that happens to sit at 31° to north must still produce a
 * rectangle; scaling in world X shears it into a parallelogram.
 */
export function scaleInFrame(ring, angle, sx, sy, origin) {
  const o = origin || centroid(ring);
  const c = Math.cos(-angle), s = Math.sin(-angle);
  const ci = Math.cos(angle), si = Math.sin(angle);
  return ring.map(([x, y]) => {
    const dx = x - o[0], dy = y - o[1];
    const lx = dx * c - dy * s, ly = dx * s + dy * c;   // into the entity's frame
    const px = lx * sx, py = ly * sy;                   // scale on its own axes
    return [o[0] + px * ci - py * si, o[1] + px * si + py * ci];
  });
}

/** Oriented minimum-area bounding rectangle (rotating calipers over the hull). */
export function orientedBounds(ring) {
  const hull = convexHull(ring);
  if (hull.length < 3) {
    const bb = bbox(ring);
    return { angle: 0, width: bb[2] - bb[0], depth: bb[3] - bb[1], center: [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2] };
  }
  let best = null;
  for (let i = 0, n = hull.length; i < n; i++) {
    const e = norm(sub(hull[(i + 1) % n], hull[i]));
    const p = perp(e);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of hull) {
      const u = dot(q, e), v = dot(q, p);
      u0 = Math.min(u0, u); u1 = Math.max(u1, u);
      v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const a = (u1 - u0) * (v1 - v0);
    if (!best || a < best.a) {
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      best = { a, angle: Math.atan2(e[1], e[0]), width: u1 - u0, depth: v1 - v0,
               center: [e[0] * cu + p[0] * cv, e[1] * cu + p[1] * cv] };
    }
  }
  return best;
}

export function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const half = (src) => {
    const out = [];
    for (const p of src) {
      while (out.length >= 2 && cross(sub(out[out.length - 1], out[out.length - 2]), sub(p, out[out.length - 2])) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return half(pts).concat(half(pts.slice().reverse()));
}

/** Naive miter offset. Positive grows the ring, negative shrinks it. */
export function offsetRing(ring, d) {
  const n = ring.length;
  const ccw = ensureCCW(ring);
  const out = [];
  for (let i = 0; i < n; i++) {
    const prev = ccw[(i - 1 + n) % n], cur = ccw[i], next = ccw[(i + 1) % n];
    const n1 = perp(norm(sub(cur, prev)));
    const n2 = perp(norm(sub(next, cur)));
    let m = norm([(n1[0] + n2[0]) / 2, (n1[1] + n2[1]) / 2]);
    const cosHalf = Math.max(0.2, dot(m, n1));   // clamp spikes at sharp corners
    out.push([cur[0] - m[0] * d / cosHalf, cur[1] - m[1] * d / cosHalf]);
  }
  return out;
}

/** Buffer an open polyline into a closed ring of the given half-width. */
export function bufferPolyline(line, halfWidth) {
  const left = [], right = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
    const t = norm(sub(b, a));
    const p = perp(t);
    left.push([line[i][0] + p[0] * halfWidth, line[i][1] + p[1] * halfWidth]);
    right.push([line[i][0] - p[0] * halfWidth, line[i][1] - p[1] * halfWidth]);
  }
  return left.concat(right.reverse());
}

export function rectRing(cx, cy, w, d, angle = 0) {
  const hw = w / 2, hd = d / 2;
  const c = Math.cos(angle), s = Math.sin(angle);
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}

export function circleRing(cx, cy, r, segments = 24) {
  const out = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

export function simplify(ring, tol = 0.25) {
  if (ring.length <= 4) return ring.slice();
  const keep = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    if (dist(ring[i], keep[keep.length - 1]) >= tol) keep.push(ring[i]);
  }
  return keep.length >= 3 ? keep : ring.slice();
}

export function resample(line, step) {
  if (line.length < 2) return line.slice();
  const out = [line[0]];
  let carry = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    let d = dist(a, b);
    let t = carry;
    while (t + step <= d) { t += step; out.push(lerp2(a, b, t / d)); }
    carry = t - d;
  }
  const last = line[line.length - 1];
  if (dist(out[out.length - 1], last) > 1e-6) out.push(last);
  return out;
}

// ---------------------------------------------------------- triangulation ---
/** Ear clipping for simple polygons. Returns flat index triples into `ring`. */
export function triangulate(ring) {
  const n = ring.length;
  if (n < 3) return [];
  const ccw = signedArea(ring) > 0;
  const idx = [];
  for (let i = 0; i < n; i++) idx.push(ccw ? i : n - 1 - i);
  const tris = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n + 64) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const i0 = idx[(i - 1 + idx.length) % idx.length], i1 = idx[i], i2 = idx[(i + 1) % idx.length];
      const a = ring[i0], b = ring[i1], c = ring[i2];
      if (cross(sub(b, a), sub(c, b)) <= 0) continue;         // reflex
      let ok = true;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (pointInTri(ring[j], a, b, c)) { ok = false; break; }
      }
      if (!ok) continue;
      tris.push(i0, i1, i2);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;                                       // self-intersecting input
  }
  if (idx.length === 3) tris.push(idx[0], idx[1], idx[2]);
  return tris;
}

export function pointInTri(p, a, b, c) {
  const d1 = cross(sub(b, a), sub(p, a));
  const d2 = cross(sub(c, b), sub(p, b));
  const d3 = cross(sub(a, c), sub(p, c));
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// --------------------------------------------------------------- snapping ---
/**
 * Snap candidates in priority order: existing vertex → edge midpoint → edge
 * projection → axis extension from the last point. Professional alignment is
 * not decoration; it is how generated form joins committed form.
 */
export function snapPoint(p, rings, tol = 1.2, lastPoint = null) {
  let best = null;
  const consider = (point, kind, meta) => {
    const d = dist(p, point);
    if (d <= tol && (!best || d < best.d)) best = { point, kind, d, ...meta };
  };
  for (const { id, ring, closed = true } of rings) {
    const bb = bbox(ring);
    if (p[0] < bb[0] - tol || p[0] > bb[2] + tol || p[1] < bb[1] - tol || p[1] > bb[3] + tol) continue;
    for (let i = 0, n = ring.length; i < n; i++) consider(ring[i], 'vertex', { id, i });
    const n = ring.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      consider(lerp2(a, b, 0.5), 'midpoint', { id, i });
      const r = closestPointOnSeg(p, a, b);
      if (r.t > 0.02 && r.t < 0.98) consider(r.point, 'edge', { id, i });
    }
  }
  if (lastPoint) {
    if (Math.abs(p[0] - lastPoint[0]) <= tol) consider([lastPoint[0], p[1]], 'axis-y', {});
    if (Math.abs(p[1] - lastPoint[1]) <= tol) consider([p[0], lastPoint[1]], 'axis-x', {});
  }
  return best;
}

// ------------------------------------------------------------ geodetics -----
/**
 * Local ENU tangent plane. CREO stores metres, not degrees — but every place
 * carries an anchor so its geometry can be re-projected to WGS84 on export.
 */
export function makeProjection(anchorLat, anchorLon) {
  const R = 6378137;
  const mPerDegLat = (Math.PI / 180) * R;
  const mPerDegLon = mPerDegLat * Math.cos((anchorLat * Math.PI) / 180);
  return {
    anchor: [anchorLat, anchorLon],
    toLocal: (lat, lon) => [(lon - anchorLon) * mPerDegLon, (lat - anchorLat) * mPerDegLat],
    toWGS84: (x, y) => [anchorLat + y / mPerDegLat, anchorLon + x / mPerDegLon],
  };
}
