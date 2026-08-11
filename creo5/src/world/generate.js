// WORLD QUERY → PLAN.
//
// Generation never invents a scene. It asks the place where something can go:
// terrain, structures, paths, water, access, existing observations, previous
// proposals, available space — and then produces ordinary world geometry that
// generation 50 will still understand.

import * as G from '../core/geom.js';
import { stream } from '../core/rng.js';

/** Orientation taken from the place itself: the nearest road, edge or wall. */
export function alignmentAt(world, pt, radius = 30) {
  let best = null;
  for (const hit of world.nearby(pt, radius)) {
    const e = hit.entity;
    if (!['road', 'path', 'structure', 'wall', 'parcel'].includes(e.type)) continue;
    const ring = world.ringOf(e);
    if (!ring) continue;
    if (e.path) {
      const c = G.closestOnRing(pt, e.path, false);
      const i = Math.min(c.i ?? 0, e.path.length - 2);
      const d = G.norm(G.sub(e.path[i + 1], e.path[i]));
      const score = hit.d + (e.type === 'road' ? 0 : 4);
      if (!best || score < best.score) best = { angle: Math.atan2(d[1], d[0]), score, from: e.id };
    } else {
      const ob = G.orientedBounds(ring);
      const score = hit.d + (e.type === 'structure' ? 1 : 6);
      if (!best || score < best.score) best = { angle: ob.angle, score, from: e.id };
    }
  }
  return best || { angle: 0, score: Infinity, from: null };
}

/**
 * Search the place for somewhere a footprint of this size actually fits.
 * Returns ranked candidates — never a silently nudged single answer.
 */
export function findPlacement(world, {
  region = null, point = null, size = [4, 4], zBase = 0,
  avoidTypes = ['structure', 'wall', 'water', 'tree'],
  keepClearOf = [], corridors = [], prefer = 'open', samples = 14, seedName = 'placement',
}) {
  const index = world.reindex();
  const rnd = stream(seedName, world.place.seed);
  const bb = region ? G.bbox(region) : [point[0] - 25, point[1] - 25, point[0] + 25, point[1] + 25];
  const align = alignmentAt(world, point || G.centroid(region));
  const candidates = [];

  const nx = samples, ny = samples;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const jitter = (rnd() - 0.5) * 0.6;
      const x = bb[0] + ((i + 0.5) / nx) * (bb[2] - bb[0]) + jitter;
      const y = bb[1] + ((j + 0.5) / ny) * (bb[3] - bb[1]) + jitter;
      if (region && !G.pointInRing([x, y], region)) continue;
      for (const angle of [align.angle, align.angle + Math.PI / 2]) {
        const ring = G.rectRing(x, y, size[0], size[1], angle);
        // Test in a z-window around the ground here, not around the datum: an
        // absolute 0–0.5 m window saw nothing on any terrain above half a metre,
        // which is most terrain.
        const zHere = zBase || world.place.groundAt(x, y);
        const hits = index.overlapping(ring, zHere - 1.5, zHere + 2.5);
        let blocked = false, penalty = 0;
        for (const id of hits) {
          const e = world.get(id);
          if (!e) continue;
          if (avoidTypes.includes(e.type)) { blocked = true; break; }
          if (e.type === 'road' || e.type === 'path' || e.type === 'drain') { blocked = true; break; }
          penalty += 2;
        }
        if (blocked) continue;
        if (keepClearOf.some((kid) => {
          const k = world.get(kid); if (!k) return false;
          const kr = world.ringOf(k); return kr && G.ringsIntersect(ring, kr);
        })) continue;
        if (corridors.some((c) => G.ringsIntersect(ring, c.ring))) continue;

        const c = [x, y];
        const slope = world.place.terrain ? world.place.terrain.slopeAt(x, y).grade : 0;
        const near = index.near(c, 18);
        let dStruct = 18, dNet = 18;
        for (const h of near) {
          const e = world.get(h.id);
          if (!e) continue;
          if (e.type === 'structure') dStruct = Math.min(dStruct, h.d);
          if (e.type === 'road' || e.type === 'path') dNet = Math.min(dNet, h.d);
        }
        let score = 0;
        score += Math.min(dStruct, 10) * 1.2;          // breathing room
        score += (18 - Math.min(dNet, 18)) * 0.8;      // but reachable
        score -= slope * 40;
        score -= penalty;
        if (prefer === 'downhill' && world.place.terrain) score -= world.place.terrain.heightAt(x, y) * 3;
        if (prefer === 'center' && region) score -= G.dist(c, G.centroid(region)) * 0.6;
        if (prefer === 'edge' && region) score += G.closestOnRing(c, region).d * -0.4;
        candidates.push({ center: c, angle, ring, score, slope, dStruct, dNet });
      }
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

/** Light/air corridors in front of openings — what "don't block those windows" means. */
export function windowCorridors(world, ids, depth = 6) {
  const out = [];
  for (const id of ids) {
    const e = world.get(id);
    if (!e || e.type !== 'opening') continue;
    const ring = world.ringOf(e);
    if (!ring) continue;
    const c = G.centroid(ring);
    const n = e.props?.normal || [0, 1];
    const w = e.props?.width || 1.2;
    const t = G.perp(n);
    const corridor = [
      [c[0] - t[0] * w, c[1] - t[1] * w],
      [c[0] + t[0] * w, c[1] + t[1] * w],
      [c[0] + t[0] * w + n[0] * depth, c[1] + t[1] * w + n[1] * depth],
      [c[0] - t[0] * w + n[0] * depth, c[1] - t[1] * w + n[1] * depth],
    ];
    out.push({ ring: corridor, ownerId: id, label: `daylight to ${e.name || id}`, zBase: e.zBase, zTop: e.zTop });
  }
  return out;
}

// ------------------------------------------------------------- generators ---
// Each returns partial entity specs. They are ordinary entities the moment they
// are committed — no separate class of "AI object" exists.

export const GENERATORS = {
  greenhouse(world, ctx) {
    const size = ctx.dimensions ? [ctx.dimensions.width, ctx.dimensions.depth || ctx.dimensions.width * 0.6] : [6, 3.5];
    return placeBox(world, ctx, {
      size, height: 2.6, type: 'structure', subtype: 'greenhouse',
      name: 'Greenhouse', material: 'glass', use: 'growing',
      sim: { permeability: 0, roughness: 0.02 },
    });
  },
  building(world, ctx) {
    const size = ctx.dimensions ? [ctx.dimensions.width, ctx.dimensions.depth || ctx.dimensions.width] : [7, 6];
    return placeBox(world, ctx, { size, height: ctx.dimensions?.height || 3.2, type: 'structure', name: 'New structure', material: 'block' });
  },
  bench(world, ctx) { return placeBox(world, ctx, { size: [1.8, 0.5], height: 0.45, type: 'bench', name: 'Bench', collision: 'soft' }); },
  light(world, ctx) { return placeBox(world, ctx, { size: [0.3, 0.3], height: 5, type: 'light', name: 'Street light', collision: 'soft', props: { lumens: 6000, radius: 9 } }); },
  market(world, ctx) { return placeBox(world, ctx, { size: [3, 2.4], height: 2.4, type: 'market', name: 'Stall', use: 'trade' }); },
  wall(world, ctx) { return placeBox(world, ctx, { size: [6, 0.3], height: 2.2, type: 'wall', name: 'Wall' }); },

  tree(world, ctx) {
    const n = Math.max(1, Math.min(60, ctx.count || 5));
    const region = ctx.region || G.circleRing(ctx.point[0], ctx.point[1], 8, 20);
    const rnd = stream(`trees:${ctx.seed}`, world.place.seed);
    const out = [];
    const placed = [];
    const bb = G.bbox(region);
    let guard = 0;
    while (out.length < n && guard++ < n * 120) {
      const x = bb[0] + rnd() * (bb[2] - bb[0]);
      const y = bb[1] + rnd() * (bb[3] - bb[1]);
      if (!G.pointInRing([x, y], region)) continue;
      if (placed.some((p) => G.dist(p, [x, y]) < 3.2)) continue;
      const canopy = 2.2 + rnd() * 1.4;
      const ring = G.circleRing(x, y, canopy, 12);
      const blocked = world.index.overlapping(ring, 0, 6).some((id) => {
        const e = world.get(id);
        return e && ['structure', 'wall', 'road', 'path', 'drain', 'water', 'tree'].includes(e.type);
      });
      if (blocked) continue;
      placed.push([x, y]);
      out.push({
        type: 'tree', name: 'Tree', footprint: ring,
        zBase: world.place.groundAt(x, y), zTop: world.place.groundAt(x, y) + 4 + rnd() * 3,
        collision: 'soft', sim: { canopy: Math.PI * canopy * canopy, permeability: 0.7 },
        props: { canopyRadius: canopy, planted: true },
      });
    }
    return out;
  },

  garden(world, ctx) {
    const region = ctx.region || G.circleRing(ctx.point[0], ctx.point[1], 7, 24);
    // Prefer the whole area if it is free; otherwise fit the largest clear
    // rectangle inside it rather than reporting that nothing is possible.
    let ring = shrinkToFree(world, region, ['structure', 'wall', 'road', 'water']);
    if (!ring) {
      const bb = G.bbox(region);
      const w = (bb[2] - bb[0]), d = (bb[3] - bb[1]);
      for (const f of [0.6, 0.45, 0.3, 0.2]) {
        const cand = findPlacement(world, {
          region, point: G.centroid(region), size: [w * f, d * f],
          seedName: `garden:${ctx.seed}`, prefer: 'center', samples: 10,
        })[0];
        if (cand) { ring = cand.ring; break; }
      }
    }
    if (!ring) return [];
    const z = world.place.groundAt(...G.centroid(ring));
    return [{
      type: 'surface', subtype: 'garden', name: 'Community garden', footprint: ring,
      zBase: z, zTop: z + 0.15, collision: 'none', use: 'growing',
      sim: { permeability: 0.85, roughness: 0.3 },
    }];
  },

  swale(world, ctx) {
    return trench(world, ctx, { name: 'Swale', subtype: 'swale', width: ctx.dimensions?.width || 2.4, depth: 0.45, permeability: 0.9, roughness: 0.25, reach: 60, infiltrate: true });
  },

  drain(world, ctx) {
    return trench(world, ctx, { name: 'Drain', subtype: null, width: ctx.dimensions?.width || 1.2, depth: ctx.dimensions?.height || 1.0, permeability: 0.05, roughness: 0.012, reach: 140 });
  },

  path(world, ctx) {
    const width = ctx.dimensions?.width || 1.5;
    const line = ctx.line || walkableLine(world, ctx.point, ctx.region, width / 2 + 0.3);
    const z = world.place.groundAt(...line[0]);
    return [{
      type: 'path', name: 'Path', network: 'paths', path: line, width,
      zBase: z, zTop: z + 0.05, collision: 'none',
      sim: { permeability: 0.2, roughness: 0.02 },
    }];
  },

  bridge(world, ctx) {
    const [aId, bId] = ctx.ids || [];
    const a = world.get(aId), b = world.get(bId);
    if (!a || !b) return [];
    const ca = G.centroid(world.ringOf(a)), cb = G.centroid(world.ringOf(b));
    // Meet the two facades rather than centre-to-centre: connect what is nearest.
    const pa = G.closestOnRing(cb, world.ringOf(a)).point;
    const pb = G.closestOnRing(ca, world.ringOf(b)).point;
    const width = ctx.dimensions?.width || 1.8;
    const deck = Math.min(a.zTop, b.zTop) - 0.15;
    return [{
      type: 'bridge', name: 'Connection', network: 'paths',
      path: [pa, pb], width,
      zBase: deck, zTop: deck + 1.1,
      collision: 'soft', needsSupport: false,
      sim: { roughness: 0.02 },
      props: { ends: [a.id, b.id], span: G.dist(pa, pb) },
    }];
  },
};
GENERATORS.greenhouse.onRoof = true;

// ------------------------------------------------------------------ trench --
/**
 * Drainage is not a decorative line downhill. It runs from where the water is
 * to somewhere the water can go, it is routed around what is already built, and
 * its invert is graded — so the certificate can check it and the water model can
 * feel it.
 */
function trench(world, ctx, spec) {
  // If the indicated point falls on a building, begin at the nearest open
  // ground inside the area indicated. Choosing where a line starts is not the
  // same as sliding a conflicting object out of sight.
  const start = ctx.line ? ctx.line[0] : freeStart(world, ctx.point, spec.width / 2 + 0.4, ctx.region);
  const zGround = world.place.groundAt(start[0], start[1]);
  let line = ctx.line;
  let outfall = null;

  const clearance = spec.width / 2 + 0.4;
  if (!line) {
    outfall = findOutfall(world, start, spec.reach, zGround);
    if (outfall) line = routeAcross(world, start, outfall.point, { clearance });
    else if (spec.infiltrate) line = contourLine(world, start, 30, clearance);   // a soakaway holds water; it does not convey it
    else line = downhillLine(world, start, Math.min(spec.reach, 30));
  }
  const zEndGround = world.place.groundAt(line[line.length - 1][0], line[line.length - 1][1]);
  const invertStart = zGround - spec.depth;
  // Fall to the outfall if there is one, otherwise a workable 1:200 gradient.
  const invertEnd = outfall
    ? Math.min(outfall.z, invertStart - 0.05)
    : Math.min(zEndGround - spec.depth, invertStart - G.perimeter(line, false) * 0.005);

  return [{
    type: 'drain', subtype: spec.subtype, name: spec.name, network: 'drainage',
    path: line, width: spec.width,
    zBase: Math.min(invertStart, invertEnd), zTop: Math.max(zGround, zEndGround),
    collision: 'none',
    sim: { capacity: spec.width * spec.depth, permeability: spec.permeability, roughness: spec.roughness },
    props: { depth: spec.depth, invert: [invertStart, invertEnd], outfall: outfall?.id || null },
  }];
}

/**
 * A swale sits across the slope, not down it — that is how it holds water long
 * enough to soak away. Laid on the contour through the indicated point, routed
 * around anything already built.
 */
export function contourLine(world, at, length, clearance = 0) {
  const t = world.place.terrain;
  let dir = [1, 0];
  if (t) {
    const s = t.slopeAt(at[0], at[1]);
    if (s.grade > 1e-4) dir = G.norm(G.perp([s.dzdx / s.grade, s.dzdy / s.grade]));
  }
  // Both ends must stand on open ground, or the route starts inside a wall and
  // the certificate correctly refuses the whole idea.
  const a = freeStart(world, [at[0] - dir[0] * length / 2, at[1] - dir[1] * length / 2], clearance);
  const b = freeStart(world, [at[0] + dir[0] * length / 2, at[1] + dir[1] * length / 2], clearance);
  return routeAcross(world, a, b, { climbPenalty: 2, clearance });
}

/** The nearest open ground to a point, searched outward. */
function freeStart(world, at, clearance, region = null) {
  const occupied = (p) => {
    const z = world.place.groundAt(p[0], p[1]);
    const probe = G.circleRing(p[0], p[1], Math.max(0.6, clearance), 10);
    return world.index.overlapping(probe, z - 1.5, z + 3).some((id) => {
      const e = world.get(id);
      return e && e.collision === 'solid';
    });
  };
  if (!occupied(at)) return at.slice();
  for (let r = 2; r <= 24; r += 2) {
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const p = [at[0] + Math.cos(ang) * r, at[1] + Math.sin(ang) * r];
      if (region && !G.pointInRing(p, region)) continue;
      if (!occupied(p)) return p;
    }
  }
  return at.slice();
}

/** Somewhere the water can actually go: an existing channel, drain or water body. */
export function findOutfall(world, from, reach, zHere) {
  let best = null;
  for (const e of world.entities()) {
    if (!['drain', 'stream', 'water'].includes(e.type)) continue;
    const ring = world.ringOf(e);
    if (!ring) continue;
    const c = e.path ? G.closestOnRing(from, e.path, false) : G.closestOnRing(from, ring);
    if (c.d > reach) continue;
    const z = e.props?.invert ? Math.min(...e.props.invert) : e.zBase;
    if (z > zHere - 0.15) continue;                       // not actually lower: no use
    const score = c.d + (z - zHere) * 6;                  // near and deep wins
    if (!best || score < best.score) best = { id: e.id, point: c.point, z, d: c.d, score };
  }
  return best;
}

/**
 * A* over a coarse grid: route between two points around what is already built,
 * preferring to descend. Used for drains and for paths, so infrastructure joins
 * the world instead of being drawn through it.
 */
export function routeAcross(world, start, goal, opts = {}) {
  // Try to keep a comfortable margin; if the place is too tight for that, take
  // the tighter route rather than the straight line — a straight line through
  // three houses is not a route, it is a failure pretending to be one.
  const want = opts.clearance || 0;
  for (const clearance of [want, want * 0.5, 0]) {
    const r = routeOnce(world, start, goal, { ...opts, clearance });
    if (r) return r;
  }
  return [start.slice(), goal.slice()];
}

function routeOnce(world, start, goal, { cell = 2.5, avoid = ['structure', 'wall'], climbPenalty = 14, clearance = 0 } = {}) {
  const b = world.place.bounds();
  const x0 = Math.min(b[0], start[0], goal[0]) - cell, y0 = Math.min(b[1], start[1], goal[1]) - cell;
  const nx = Math.ceil((Math.max(b[2], start[0], goal[0]) + cell - x0) / cell);
  const ny = Math.ceil((Math.max(b[3], start[1], goal[1]) + cell - y0) / cell);
  const cx = (i) => x0 + (i + 0.5) * cell, cy = (j) => y0 + (j + 0.5) * cell;
  const idx = (i, j) => j * nx + i;
  const blocked = new Uint8Array(nx * ny);
  for (const e of world.entities()) {
    if (!avoid.includes(e.type)) continue;
    const ring = world.ringOf(e);
    if (!ring) continue;
    // The route is a centreline for something with width. Blocking only the
    // cells whose centre lies inside a building let a 1.2 m trench clip its
    // corner — which the certificate then, rightly, refused.
    const pad = clearance + cell * 0.5;
    const rb = G.bbox(ring);
    for (let j = Math.max(0, Math.floor((rb[1] - pad - y0) / cell)); j <= Math.min(ny - 1, Math.ceil((rb[3] + pad - y0) / cell)); j++) {
      for (let i = Math.max(0, Math.floor((rb[0] - pad - x0) / cell)); i <= Math.min(nx - 1, Math.ceil((rb[2] + pad - x0) / cell)); i++) {
        const p = [cx(i), cy(j)];
        if (G.pointInRing(p, ring) || G.closestOnRing(p, ring).d <= pad) blocked[idx(i, j)] = 1;
      }
    }
  }
  const si = Math.max(0, Math.min(nx - 1, Math.floor((start[0] - x0) / cell)));
  const sj = Math.max(0, Math.min(ny - 1, Math.floor((start[1] - y0) / cell)));
  const gi = Math.max(0, Math.min(nx - 1, Math.floor((goal[0] - x0) / cell)));
  const gj = Math.max(0, Math.min(ny - 1, Math.floor((goal[1] - y0) / cell)));
  blocked[idx(si, sj)] = 0; blocked[idx(gi, gj)] = 0;

  const h = (i, j) => Math.hypot(cx(i) - goal[0], cy(j) - goal[1]);
  const g = new Float64Array(nx * ny).fill(Infinity);
  const from = new Int32Array(nx * ny).fill(-1);
  const open = new MinHeap();
  open.push(h(si, sj), idx(si, sj));
  g[idx(si, sj)] = 0;
  const closed = new Uint8Array(nx * ny);
  let found = false;
  let guard = 0;
  while (open.size && guard++ < nx * ny * 8) {
    const u = open.pop();
    if (closed[u]) continue;
    closed[u] = 1;
    if (u === idx(gi, gj)) { found = true; break; }
    const ui = u % nx, uj = (u - ui) / nx;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const vi = ui + di, vj = uj + dj;
      if (vi < 0 || vj < 0 || vi >= nx || vj >= ny) continue;
      const v = idx(vi, vj);
      if (blocked[v] || closed[v]) continue;
      const step = Math.hypot(di, dj) * cell;
      const climb = Math.max(0, world.place.groundAt(cx(vi), cy(vj)) - world.place.groundAt(cx(ui), cy(uj)));
      const ng = g[u] + step + climb * climbPenalty;
      if (ng < g[v]) { g[v] = ng; from[v] = u; open.push(ng + h(vi, vj), v); }
    }
  }
  if (!found) return null;
  const pts = [];
  let cur = idx(gi, gj);
  while (cur !== -1) { const i = cur % nx, j = (cur - i) / nx; pts.unshift([cx(i), cy(j)]); cur = from[cur]; }
  pts[0] = start.slice();
  pts[pts.length - 1] = goal.slice();
  // Straightening must not undo the avoidance: a shortcut between two kept
  // points may pass straight through the building the search went around.
  const clear = (a, b) => {
    const n = Math.max(2, Math.ceil(G.dist(a, b) / (cell * 0.5)));
    for (let s = 0; s <= n; s++) {
      const p = G.lerp2(a, b, s / n);
      const i = Math.floor((p[0] - x0) / cell), j = Math.floor((p[1] - y0) / cell);
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      if (blocked[idx(i, j)]) return false;
    }
    return true;
  };
  return simplifyRoute(pts, cell * 0.6, clear);
}

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.v.length; }
  push(key, val) {
    this.k.push(key); this.v.push(val);
    let i = this.v.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= this.k[i]) break;
      [this.k[p], this.k[i]] = [this.k[i], this.k[p]];
      [this.v[p], this.v[i]] = [this.v[i], this.v[p]];
      i = p;
    }
  }
  pop() {
    const top = this.v[0];
    const lk = this.k.pop(), lv = this.v.pop();
    if (this.v.length) {
      this.k[0] = lk; this.v[0] = lv;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < this.v.length && this.k[l] < this.k[m]) m = l;
        if (r < this.v.length && this.k[r] < this.k[m]) m = r;
        if (m === i) break;
        [this.k[m], this.k[i]] = [this.k[i], this.k[m]];
        [this.v[m], this.v[i]] = [this.v[i], this.v[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Drop collinear intermediate points so the result reads as drawn, not as a raster. */
function simplifyRoute(pts, tol, clear = () => true) {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    const d = Math.abs(G.cross(G.sub(b, a), G.sub(c, a))) / Math.max(1e-6, G.dist(a, c));
    if (d > tol || !clear(a, c)) out.push(b);
  }
  const last = pts[pts.length - 1];
  if (!clear(out[out.length - 1], last)) out.push(pts[pts.length - 2]);
  out.push(last);
  return out;
}

// ------------------------------------------------------------------ helpers --
function placeBox(world, ctx, spec) {
  const onRoof = ctx.onRoof && ctx.roofOf;
  if (onRoof) {
    const host = world.get(ctx.roofOf);
    const roof = world.ringOf(host);
    const inner = G.offsetRing(roof, -0.6);
    const cands = findPlacement(world, {
      region: inner, point: ctx.point || G.centroid(inner), size: spec.size,
      zBase: host.zTop, avoidTypes: ['structure'], corridors: ctx.corridors || [],
      keepClearOf: ctx.keepClearOf || [], seedName: `roof:${ctx.seed}`, prefer: 'center',
    });
    const pick = cands[0];
    const ring = pick ? pick.ring : G.rectRing(...G.centroid(inner), spec.size[0], spec.size[1], G.orientedBounds(roof).angle);
    return [{
      ...spec, footprint: ring, zBase: host.zTop, zTop: host.zTop + spec.height,
      parent: host.id, props: { ...(spec.props || {}), onRoofOf: host.id },
      alternatives: cands.slice(1, 4).map((c) => c.ring),
    }];
  }
  // Pointing is precise; circling is "somewhere in here". When a person points
  // at an occupied spot we build there and let the certificate say so — we do
  // not quietly slide the proposal to nicer ground (§12).
  const exact = !ctx.region && ctx.point;
  const cands = exact ? [] : findPlacement(world, {
    region: ctx.region, point: ctx.point, size: spec.size, zBase: ctx.zBase ?? 0,
    corridors: ctx.corridors || [], keepClearOf: ctx.keepClearOf || [],
    seedName: `place:${ctx.seed}`, prefer: ctx.prefer || 'open',
  });
  const pick = cands[0];
  const center = pick ? pick.center : (ctx.point || G.centroid(ctx.region));
  const angle = pick ? pick.angle : alignmentAt(world, center).angle;
  const ring = pick ? pick.ring : G.rectRing(center[0], center[1], spec.size[0], spec.size[1], angle);
  const z = ctx.zBase ?? world.place.groundAt(center[0], center[1]);
  return [{
    ...spec, footprint: ring, zBase: z, zTop: z + spec.height,
    alternatives: cands.slice(1, 4).map((c) => c.ring),
    placementScore: pick?.score ?? null,
  }];
}

/**
 * Follow the actual terrain gradient — water is not a matter of opinion.
 * The walk carries momentum so it does not chatter between two cells, and it
 * refuses to climb: a drain that would run uphill is not silently drawn anyway.
 */
export function downhillLine(world, start, length, step = 3) {
  const t = world.place.terrain;
  if (!t) return [start.slice(), [start[0] + length, start[1]]];
  const pts = [start.slice()];
  let p = start.slice();
  let h = t.heightAt(p[0], p[1]);
  let dir = null;
  for (let i = 0; i < Math.round(length / step); i++) {
    const s = t.slopeAt(p[0], p[1]);
    if (s.grade < 1e-5) break;
    const grad = [-s.dzdx / s.grade, -s.dzdy / s.grade];
    let d = dir ? G.norm([grad[0] * 0.45 + dir[0] * 0.55, grad[1] * 0.45 + dir[1] * 0.55]) : grad;
    let q = [p[0] + d[0] * step, p[1] + d[1] * step];
    let hq = t.heightAt(q[0], q[1]);
    if (hq >= h - 1e-4) {                       // momentum overshot — try the raw gradient
      d = grad;
      q = [p[0] + d[0] * step, p[1] + d[1] * step];
      hq = t.heightAt(q[0], q[1]);
      if (hq >= h - 1e-4) break;                // genuinely a local low point
    }
    dir = d; p = q; h = hq;
    pts.push(p.slice());
  }
  if (pts.length >= 2) return pts;
  // Flat or pooled: aim at the lowest ground within reach rather than inventing a direction.
  let best = null;
  for (let a = 0; a < 24; a++) {
    const ang = (a / 24) * Math.PI * 2;
    const q = [start[0] + Math.cos(ang) * length, start[1] + Math.sin(ang) * length];
    const hq = t.heightAt(q[0], q[1]);
    if (!best || hq < best.h) best = { q, h: hq };
  }
  return [start.slice(), best.q];
}

/** A path that goes somewhere, around what is already built rather than through it. */
function walkableLine(world, start, region, clearance) {
  const a = alignmentAt(world, start).angle;
  // Stay inside the area that was indicated: a path proposed for "here" that
  // runs out of "here" reads as the system ignoring the gesture.
  const bb = region ? G.bbox(region) : null;
  const half = bb ? Math.max(6, Math.min(bb[2] - bb[0], bb[3] - bb[1]) * 0.36) : 9;
  const from = freeStart(world, [start[0] - Math.cos(a) * half, start[1] - Math.sin(a) * half], clearance, region);
  const to = freeStart(world, [start[0] + Math.cos(a) * half, start[1] + Math.sin(a) * half], clearance, region);
  return routeAcross(world, from, to, { clearance, climbPenalty: 4 });
}

/**
 * Shrink a drawn region until it stops overlapping solid things. Honest, not magic.
 * The z-window is taken from the ground under the region, not from the absolute
 * datum — a hardcoded 0–3 m missed every building standing on terrain above 3 m,
 * which on sloping ground is most of them.
 */
function shrinkToFree(world, region, avoid) {
  const c = G.centroid(region);
  const ground = world.place.groundAt(c[0], c[1]);
  for (const inset of [0, 0.5, 1.5, 3]) {
    const ring = inset ? G.offsetRing(region, -inset) : region;
    if (G.area(ring) < 2) continue;
    const bad = world.index.overlapping(ring, ground - 2, ground + 4).some((id) => {
      const e = world.get(id);
      return e && avoid.includes(e.type);
    });
    if (!bad) return ring;
  }
  return null;
}
