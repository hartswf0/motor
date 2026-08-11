// PICKING. What a person means when they touch the screen.
//
// Rays are tested against real geometry — the top face of every entity and the
// terrain — so tapping a roof selects the roof, not the ground beneath it. That
// distinction is the whole of MAGIC TEST A.

import * as G from '../core/geom.js';

/** Where a ray meets the terrain (or z=0 if there is none). */
export function rayToGround(world, ray, maxDist = 4000) {
  const t = world.place.terrain;
  if (!t) {
    if (Math.abs(ray.dir[2]) < 1e-6) return null;
    const s = -ray.origin[2] / ray.dir[2];
    return s > 0 ? [ray.origin[0] + ray.dir[0] * s, ray.origin[1] + ray.dir[1] * s] : null;
  }
  // March until we drop below the heightfield, then bisect.
  let prev = 0, prevH = ray.origin[2] - t.heightAt(ray.origin[0], ray.origin[1]);
  const step = 2.5;
  for (let s = step; s < maxDist; s += step) {
    const p = [ray.origin[0] + ray.dir[0] * s, ray.origin[1] + ray.dir[1] * s, ray.origin[2] + ray.dir[2] * s];
    const h = p[2] - t.heightAt(p[0], p[1]);
    if (h <= 0 && prevH > 0) {
      let lo = prev, hi = s;
      for (let k = 0; k < 24; k++) {
        const m = (lo + hi) / 2;
        const q = [ray.origin[0] + ray.dir[0] * m, ray.origin[1] + ray.dir[1] * m, ray.origin[2] + ray.dir[2] * m];
        if (q[2] - t.heightAt(q[0], q[1]) > 0) lo = m; else hi = m;
      }
      const m = (lo + hi) / 2;
      return [ray.origin[0] + ray.dir[0] * m, ray.origin[1] + ray.dir[1] * m];
    }
    prev = s; prevH = h;
  }
  return null;
}

/**
 * @returns {{entity:object|null, point:number[]|null, onRoof:boolean, distance:number}}
 */
export function pick(world, ray, { fidelity = 'high' } = {}) {
  const ground = rayToGround(world, ray);
  let best = null;

  for (const e of world.entities()) {
    if (e.type === 'opening' && fidelity !== 'high') continue;
    const ring = world.ringOf(e);
    if (!ring || ring.length < 3) continue;
    // top face
    for (const z of [e.zTop, e.zBase]) {
      if (Math.abs(ray.dir[2]) < 1e-9) continue;
      const s = (z - ray.origin[2]) / ray.dir[2];
      if (s <= 0.1) continue;
      const p = [ray.origin[0] + ray.dir[0] * s, ray.origin[1] + ray.dir[1] * s];
      if (!G.pointInRing(p, ring)) continue;
      if (!best || s < best.distance) best = { entity: e, point: p, distance: s, onRoof: z === e.zTop && e.zTop > e.zBase + 0.5 };
      break;
    }
  }

  if (ground) {
    const gz = world.place.groundAt(ground[0], ground[1]);
    const gs = Math.hypot(ground[0] - ray.origin[0], ground[1] - ray.origin[1], gz - ray.origin[2]);
    if (!best || gs < best.distance) {
      // ground level: whatever flat thing is painted there
      const flat = world.index.atPoint(ground)
        .map((id) => world.get(id))
        .filter((e) => e && (e.zTop - e.zBase) < 0.6)
        .sort((a, b) => b.zTop - a.zTop)[0] || null;
      best = { entity: flat, point: ground, distance: gs, onRoof: false };
    }
  }
  return best || { entity: null, point: null, onRoof: false, distance: Infinity };
}
