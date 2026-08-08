// WATER (§20). The place answers back, and the answer is computed.
//
// A shallow-water routing model on the terrain grid: rain falls, structures
// displace it, permeable surfaces absorb it, drains carry it away up to their
// real cross-section, and the rest ponds where the ground actually dips.
//
// Every assumption is named in `model` so a simulation engineer can argue with
// it. The language layer may narrate this result. It may never invent one.

import * as G from '../core/geom.js';

export const WATER_MODEL = {
  name: 'shallow routing v2',
  assumptions: {
    rainfall_mm: { light: 12, heavy: 45, extreme: 90 },
    duration_min: 60,
    infiltration_mm_per_h_default: 6,
    infiltration_mm_per_h_permeable: 60,
    steps: 120,
    cell_m: 1.5,
    reports: 'peak depth during the event, not the steady state after it',
    note: 'A rainfall EVENT, not an equilibrium. Rain is applied over the stated duration and '
        + 'routed by steepest descent each step; what is reported is the worst moment, because '
        + 'that is what "it fills with water" describes. Steady state is the wrong question here: '
        + 'this ground drains eventually, and the complaint is about the hour it takes. '
        + 'No momentum, no pipe hydraulics. Comparative, not absolute: the direction of a change '
        + 'is robust, its magnitude is resolution-dependent. Always compare two runs on one grid.',
  },
};

/**
 * A grid frame both runs of a before/after comparison must share.
 * Deriving the grid from place.bounds() on each call meant a proposal whose
 * footprint poked outside the current bounds shifted the origin and column count
 * for the whole place — so a shed on dry ground 80 m from any puddle could move
 * the reported flood area. The frame is now computed once and passed in.
 */
export function waterFrame(world, extraRings = [], cell = 1.5, pad = 6) {
  const bb = world.place.bounds().slice();
  for (const ring of extraRings) {
    if (!ring || !ring.length) continue;
    const r = G.bbox(ring);
    bb[0] = Math.min(bb[0], r[0]); bb[1] = Math.min(bb[1], r[1]);
    bb[2] = Math.max(bb[2], r[2]); bb[3] = Math.max(bb[3], r[3]);
  }
  const x0 = Math.floor((bb[0] - pad) / cell) * cell;
  const y0 = Math.floor((bb[1] - pad) / cell) * cell;
  return {
    cell, x0, y0,
    nx: Math.max(8, Math.ceil((bb[2] + pad - x0) / cell)),
    ny: Math.max(8, Math.ceil((bb[3] + pad - y0) / cell)),
  };
}

export function runWater(world, { rain = 'heavy', cell = 1.5, steps = null, frame = null } = {}) {
  const place = world.place;
  const grid = frame || waterFrame(world, [], cell);
  cell = grid.cell;
  const x0 = grid.x0, y0 = grid.y0, nx = grid.nx, ny = grid.ny;
  const nSteps = steps || WATER_MODEL.assumptions.steps;
  const n = nx * ny;

  const elev = new Float32Array(n);
  const perm = new Float32Array(n).fill(WATER_MODEL.assumptions.infiltration_mm_per_h_default);
  const solid = new Uint8Array(n);
  const sink = new Float32Array(n);          // drain capacity, m³/step
  const sinkId = new Array(n).fill(null);

  const at = (i, j) => j * nx + i;
  const cx = (i) => x0 + (i + 0.5) * cell;
  const cy = (j) => y0 + (j + 0.5) * cell;

  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) elev[at(i, j)] = place.groundAt(cx(i), cy(j));
  }

  // Stamp entities into the field — this is why a proposal changes the answer.
  for (const e of world.entities()) {
    const ring = world.ringOf(e);
    if (!ring) continue;
    // A 1.2 m trench on a 1.5 m grid must still exist. Linear features are
    // stamped by distance to their centreline, not by cell-centre containment.
    const halfW = e.path ? Math.max((e.width || 1) / 2, cell * 0.55) : 0;
    const covers = e.path
      ? (p) => G.closestOnRing(p, e.path, false).d <= halfW
      : (p) => G.pointInRing(p, ring);
    const rb = G.bbox(ring);
    const i0 = Math.max(0, Math.floor((rb[0] - x0 - halfW) / cell)), i1 = Math.min(nx - 1, Math.ceil((rb[2] - x0 + halfW) / cell));
    const j0 = Math.max(0, Math.floor((rb[1] - y0 - halfW) / cell)), j1 = Math.min(ny - 1, Math.ceil((rb[3] - y0 + halfW) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const p = [cx(i), cy(j)];
        if (!covers(p)) continue;
        const k = at(i, j);
        if (e.type === 'structure' || e.type === 'wall') {
          solid[k] = 1;
          elev[k] = Math.max(elev[k], e.zTop);
        } else if (e.type === 'drain' || e.type === 'stream') {
          elev[k] = Math.min(elev[k], invertAt(e, p));
          sink[k] = (e.sim?.capacity ?? 0.4) * cell * 0.12;
          sinkId[k] = e.id;
          perm[k] = Math.max(perm[k], (e.sim?.permeability ?? 0.1) * 100);
        } else if (e.type === 'water') {
          sink[k] = 99;
          sinkId[k] = e.id;
        } else if (e.sim?.permeability != null) {
          perm[k] = Math.max(perm[k], e.sim.permeability * WATER_MODEL.assumptions.infiltration_mm_per_h_permeable);
        }
      }
    }
  }

  const mm = WATER_MODEL.assumptions.rainfall_mm[rain] ?? WATER_MODEL.assumptions.rainfall_mm.heavy;
  const hours = WATER_MODEL.assumptions.duration_min / 60;
  const depth = new Float32Array(n);
  const infiltrated = new Float32Array(n);
  const peak = new Float32Array(n);
  const rainPerStep = mm / 1000 / nSteps;      // the storm arrives over time, not at once

  const absorbedBy = new Map();
  const flux = new Float32Array(n);

  for (let it = 0; it < nSteps; it++) {
    // rainfall
    for (let k = 0; k < n; k++) if (!solid[k]) depth[k] += rainPerStep;
    // infiltration
    for (let k = 0; k < n; k++) {
      if (depth[k] <= 0) continue;
      const cap = (perm[k] / 1000) * (hours / nSteps);
      const take = Math.min(depth[k], cap);
      depth[k] -= take;
      infiltrated[k] += take;
    }
    // drains remove water at their capacity
    for (let k = 0; k < n; k++) {
      if (sink[k] > 0 && depth[k] > 0) {
        const take = Math.min(depth[k], sink[k]);
        depth[k] -= take;
        if (sinkId[k]) absorbedBy.set(sinkId[k], (absorbedBy.get(sinkId[k]) || 0) + take * cell * cell);
      }
    }
    // routing: send water to the lowest neighbouring water surface
    const next = Float32Array.from(depth);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = at(i, j);
        const d = depth[k];
        if (d <= 1e-5 || solid[k]) continue;
        const h = elev[k] + d;
        let bestK = -1, bestDrop = 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const k2 = at(ii, jj);
          if (solid[k2]) continue;
          const h2 = elev[k2] + depth[k2];
          const drop = h - h2;
          if (drop > bestDrop) { bestDrop = drop; bestK = k2; }
        }
        if (bestK >= 0) {
          const move = Math.min(d, bestDrop / 2) * 0.55;
          next[k] -= move;
          next[bestK] += move;
          flux[k] += move;
        }
      }
    }
    depth.set(next);
    // The complaint is about the worst moment of the storm, so that is what is kept.
    for (let k = 0; k < n; k++) if (depth[k] > peak[k]) peak[k] = depth[k];
  }
  const residual = Float32Array.from(depth);
  depth.set(peak);

  // summarise
  let maxDepth = 0, floodedArea = 0, volume = 0;
  const cellArea = cell * cell;
  for (let k = 0; k < n; k++) {
    if (depth[k] > maxDepth) maxDepth = depth[k];
    if (depth[k] > 0.05) floodedArea += cellArea;
    volume += depth[k] * cellArea;
  }
  const ponds = findPonds(depth, nx, ny, 0.05);

  // per-entity exposure — "which of my houses gets wet?"
  const exposure = new Map();
  for (const e of world.entities()) {
    if (e.type !== 'structure' && e.type !== 'market' && e.type !== 'path' && e.type !== 'road') continue;
    const ring = world.ringOf(e);
    if (!ring) continue;
    let worst = 0, wet = 0, cells = 0;
    const rb = G.bbox(ring);
    const i0 = Math.max(0, Math.floor((rb[0] - x0) / cell) - 1), i1 = Math.min(nx - 1, Math.ceil((rb[2] - x0) / cell) + 1);
    const j0 = Math.max(0, Math.floor((rb[1] - y0) / cell) - 1), j1 = Math.min(ny - 1, Math.ceil((rb[3] - y0) / cell) + 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const p = [cx(i), cy(j)];
      if (!G.pointInRing(p, ring)) continue;
      cells++;
      const d = depth[at(i, j)];
      worst = Math.max(worst, d);
      if (d > 0.05) wet++;
    }
    if (cells) exposure.set(e.id, { maxDepth: worst, wetFraction: wet / cells });
  }

  return {
    model: WATER_MODEL, rain, cell, frame: grid,
    bounds: [x0, y0, x0 + nx * cell, y0 + ny * cell],
    steps: nSteps, residual,
    nx, ny, depth, flux, elev, solid,
    maxDepth, floodedArea, volume,
    pondCount: ponds.length, ponds,
    absorbedBy: [...absorbedBy.entries()].map(([id, v]) => ({ id, m3: v })),
    exposure,
    depthAt(x, y) {
      const i = Math.floor((x - x0) / cell), j = Math.floor((y - y0) / cell);
      if (i < 0 || j < 0 || i >= nx || j >= ny) return 0;
      return depth[j * nx + i];
    },
  };
}

/** A trench bed falls along its length. Interpolate the invert at a point. */
function invertAt(e, p) {
  const inv = e.props?.invert;
  if (!inv || !e.path || e.path.length < 2) return e.zBase;
  let total = 0;
  const segs = [];
  for (let i = 0; i < e.path.length - 1; i++) {
    const d = G.dist(e.path[i], e.path[i + 1]);
    segs.push(d); total += d;
  }
  const c = G.closestOnRing(p, e.path, false);
  let before = 0;
  for (let i = 0; i < (c.i ?? 0); i++) before += segs[i];
  const along = before + (segs[c.i ?? 0] || 0) * (c.t ?? 0);
  const f = total > 0 ? Math.max(0, Math.min(1, along / total)) : 0;
  return inv[0] + (inv[1] - inv[0]) * f;
}

function findPonds(depth, nx, ny, threshold) {
  const seen = new Uint8Array(nx * ny);
  const ponds = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (seen[k] || depth[k] <= threshold) continue;
      const stack = [k];
      seen[k] = 1;
      let cells = 0, max = 0, sx = 0, sy = 0;
      while (stack.length) {
        const c = stack.pop();
        const ci = c % nx, cj = (c - ci) / nx;
        cells++; sx += ci; sy += cj;
        if (depth[c] > max) max = depth[c];
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = ci + di, jj = cj + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const k2 = jj * nx + ii;
          if (seen[k2] || depth[k2] <= threshold) continue;
          seen[k2] = 1; stack.push(k2);
        }
      }
      if (cells >= 3) ponds.push({ cells, maxDepth: max, i: sx / cells, j: sy / cells });
    }
  }
  return ponds.sort((a, b) => b.cells - a.cells);
}

/** Compare two water runs — the honest basis for "78% improvement". */
export function compareWater(a, b) {
  // Two runs on different grids are not comparable, and quietly differencing
  // them would manufacture an improvement out of a change of resolution.
  if (a.cell !== b.cell || a.nx !== b.nx || a.ny !== b.ny
      || Math.abs(a.bounds[0] - b.bounds[0]) > 1e-9 || Math.abs(a.bounds[1] - b.bounds[1]) > 1e-9) {
    throw new Error('compareWater: runs are on different grids — pass a shared frame to runWater()');
  }
  return {
    floodedAreaDelta: b.floodedArea - a.floodedArea,
    floodedAreaPct: a.floodedArea > 0 ? ((a.floodedArea - b.floodedArea) / a.floodedArea) * 100 : 0,
    maxDepthDelta: b.maxDepth - a.maxDepth,
    volumeDelta: b.volume - a.volume,
  };
}
