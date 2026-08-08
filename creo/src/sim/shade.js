// LIGHT (§20): shadow coverage and night visibility, computed from real heights.

import * as G from '../core/geom.js';

export const SUN_MODEL = {
  name: 'directional shadow projection v1',
  assumptions: { latitude_note: 'sun altitude/azimuth supplied per run', shadow: 'hard, no diffuse, no reflection', cell_m: 1.5 },
};

/** Sun direction for an hour of day, tuned for equatorial-ish places. */
export function sunFor(hour, latitudeDeg = 0) {
  const h = ((hour - 12) / 12) * Math.PI;            // -π (midnight) … π
  const altitude = Math.max(0, Math.cos(h) * (Math.PI / 2 - Math.abs(latitudeDeg * Math.PI / 180) * 0.6));
  const azimuth = h + Math.PI / 2;
  return { altitude, azimuth, up: Math.sin(altitude), dir: [Math.cos(azimuth), Math.sin(azimuth)] };
}

/** Ground shadow polygons cast by everything with height. */
export function shadows(world, hour = 15) {
  const sun = sunFor(hour);
  if (sun.up <= 0.02) return { sun, polys: [], night: true };
  const polys = [];
  for (const e of world.entities()) {
    const h = e.zTop - e.zBase;
    if (h < 0.6) continue;
    if (!['structure', 'tree', 'wall', 'bridge', 'market'].includes(e.type)) continue;
    const ring = world.ringOf(e);
    if (!ring) continue;
    const L = h / Math.tan(Math.max(0.08, sun.altitude));
    const off = [-sun.dir[0] * L, -sun.dir[1] * L];
    const moved = ring.map((p) => [p[0] + off[0], p[1] + off[1]]);
    polys.push({ id: e.id, ring: G.convexHull(ring.concat(moved)), length: L, opacity: e.type === 'tree' ? 0.55 : 0.85 });
  }
  return { sun, polys, night: false };
}

/** Fraction of a region in shade, and where the unshaded parts are. */
export function shadeCoverage(world, region, hour = 15, cell = 1.5) {
  const { polys } = shadows(world, hour);
  const bb = G.bbox(region);
  let total = 0, shaded = 0;
  const hot = [];
  for (let y = bb[1]; y <= bb[3]; y += cell) {
    for (let x = bb[0]; x <= bb[2]; x += cell) {
      const p = [x, y];
      if (!G.pointInRing(p, region)) continue;
      total++;
      if (polys.some((s) => G.pointInRing(p, s.ring))) shaded++;
      else hot.push(p);
    }
  }
  return { fraction: total ? shaded / total : 0, area: total * cell * cell, unshaded: hot, hour };
}

/** Night: which parts of the walkable network have no lamp within reach? */
export function nightCoverage(world, cell = 3) {
  const lamps = world.entities().filter((e) => e.type === 'light');
  const dark = [];
  let lit = 0, total = 0;
  for (const e of world.entities()) {
    if (e.type !== 'path' && e.type !== 'road') continue;
    const line = e.path || [];
    for (const p of G.resample(line, cell)) {
      total++;
      const near = lamps.some((l) => {
        const c = G.centroid(world.ringOf(l) || [[0, 0]]);
        return G.dist(c, p) <= (l.props?.radius || 9);
      });
      if (near) lit++; else dark.push({ p, ownerId: e.id });
    }
  }
  return { fraction: total ? lit / total : 0, dark, total };
}
