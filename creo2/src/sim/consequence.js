// CONSEQUENCE CHECK.
//
// A proposal is evaluated by running the same systems twice: once on the world
// as it is, once on the world with the ghosts in it. The difference is the
// consequence. Nothing here is narrated by a language model.

import * as G from '../core/geom.js';
import { makeBranch } from '../core/place.js';
import { runWater, compareWater, waterFrame } from './water.js';
import { reachability } from './movement.js';
import { shadeCoverage } from './shade.js';

let scratchSeq = 0;

/** Run `fn` against a world that temporarily contains the ghosts. Never journalled. */
export function withGhosts(world, ghosts, removals, fn) {
  const place = world.place;
  const prev = place.activeBranch;
  const sid = `__scratch_${++scratchSeq}`;
  place.branches.set(sid, makeBranch(sid, { name: 'scratch', parent: prev }));
  place.overlays.set(sid, new Map());
  place.activeBranch = sid;
  for (const g of ghosts || []) place.put({ ...g, status: 'ACTIVE' }, sid);
  for (const id of removals || []) place.remove(id, sid);
  world.dirty = true;
  world.reindex();
  try {
    return fn(world);
  } finally {
    place.activeBranch = prev;
    place.branches.delete(sid);
    place.overlays.delete(sid);
    world.dirty = true;
    world.reindex();
  }
}

/**
 * @returns {{metrics:Array, quantities:Object, water:Object|null, access:Object|null}}
 */
export function consequenceOf(world, plan, opts = {}) {
  const ghosts = plan.ghosts || [];
  const removals = plan.removals || [];
  const patches = plan.patches || [];
  const effective = ghosts.filter((g) => !g.props?.modifies)
    .concat(patches.map((p) => ({ ...world.get(p.id), ...p.patch })));
  const effectiveRemovals = removals.concat(patches.map((p) => p.id));

  if (!effective.length && !removals.length) return { metrics: [], quantities: {}, water: null, access: null };

  const region = plan.region || regionAround(world, effective, removals);
  const seed = seedPoint(world);

  // --- water ---------------------------------------------------------------
  // One grid frame, computed from the union of the world and everything
  // proposed, so before and after are measured with the same instrument.
  const ghostRings = effective.map((g) => world.place.ringOf(g)).filter(Boolean);
  const frame = waterFrame(world, ghostRings, opts.cell || 1.5);
  const before = runWater(world, { rain: opts.rain || 'heavy', frame });
  const after = withGhosts(world, effective, effectiveRemovals, (w) => runWater(w, { rain: opts.rain || 'heavy', frame }));
  const dw = compareWater(before, after);

  // --- access --------------------------------------------------------------
  const accessBefore = reachability(world, seed);
  const accessAfter = withGhosts(world, effective, effectiveRemovals, (w) => reachability(w, seed));

  // --- shade ---------------------------------------------------------------
  let shade = null;
  if (region) {
    const sb = shadeCoverage(world, region, opts.hour ?? 14);
    const sa = withGhosts(world, effective, effectiveRemovals, (w) => shadeCoverage(w, region, opts.hour ?? 14));
    shade = { before: sb.fraction, after: sa.fraction };
  }

  // --- what it costs the place --------------------------------------------
  const cert = plan.certificate || { findings: [] };
  const removedTrees = new Set();
  const affectedStructures = new Set();
  for (const f of cert.findings) {
    for (const id of f.others || []) {
      const e = world.get(id);
      if (!e) continue;
      if (e.type === 'tree' && (f.code === 'REQUIRES_REMOVAL' || f.code === 'COLLISION')) removedTrees.add(id);
      if (e.type === 'structure' && (f.code === 'COLLISION' || f.code === 'REQUIRES_REMOVAL')) affectedStructures.add(id);
    }
  }
  for (const id of removals) {
    const e = world.get(id);
    if (e?.type === 'tree') removedTrees.add(id);
    if (e?.type === 'structure') affectedStructures.add(id);
  }

  const metrics = [];
  if (before.floodedArea > 0 || after.floodedArea > 0) {
    metrics.push({
      key: 'flooding',
      label: 'Flooded area (> 5 cm)',
      before: `${before.floodedArea.toFixed(0)} m²`,
      after: `${after.floodedArea.toFixed(0)} m²`,
      delta: dw.floodedAreaPct,
      good: dw.floodedAreaPct > 1,
      bad: dw.floodedAreaPct < -1,
      basis: `${before.model.name}, ${before.model.assumptions.rainfall_mm[opts.rain || 'heavy']} mm over `
           + `${before.model.assumptions.duration_min} min, peak depth, ${frame.cell} m grid, ${before.steps} steps`
           + ' — direction is robust, magnitude is resolution-dependent',
    });
    metrics.push({
      key: 'depth', label: 'Deepest water',
      before: `${before.maxDepth.toFixed(2)} m`, after: `${after.maxDepth.toFixed(2)} m`,
      delta: -dw.maxDepthDelta * 100, good: dw.maxDepthDelta < -0.005, bad: dw.maxDepthDelta > 0.005,
      basis: 'same run',
    });
  }
  metrics.push({
    key: 'access', label: 'Path connectivity',
    before: `${(accessBefore.fraction * 100).toFixed(0)}%`,
    after: `${(accessAfter.fraction * 100).toFixed(0)}%`,
    delta: (accessAfter.fraction - accessBefore.fraction) * 100,
    good: accessAfter.fraction >= accessBefore.fraction - 1e-6,
    bad: accessAfter.fraction < accessBefore.fraction - 1e-6,
    basis: 'network graph from the same seed point',
  });
  if (shade) {
    metrics.push({
      key: 'shade', label: 'Shade at 2pm',
      before: `${(shade.before * 100).toFixed(0)}%`, after: `${(shade.after * 100).toFixed(0)}%`,
      delta: (shade.after - shade.before) * 100,
      good: shade.after > shade.before, bad: false, basis: 'hard shadow projection',
    });
  }
  if (affectedStructures.size) {
    metrics.push({ key: 'structures', label: 'Structures affected', before: '0', after: String(affectedStructures.size), delta: -affectedStructures.size, bad: true, basis: 'certificate' });
  }
  if (removedTrees.size) {
    metrics.push({ key: 'trees', label: 'Trees removed', before: '0', after: String(removedTrees.size), delta: -removedTrees.size, bad: true, basis: 'certificate' });
  }

  return {
    metrics,
    quantities: quantitiesFor(world, effective),
    water: { before, after, delta: dw },
    access: { before: accessBefore.fraction, after: accessAfter.fraction, newlyUnreachable: accessAfter.unreachable },
    affected: { structures: [...affectedStructures], trees: [...removedTrees] },
  };
}

/** Take-it-outside numbers: what would actually have to be dug, laid and planted. */
export function quantitiesFor(world, ghosts) {
  let earthwork = 0, gravel = 0, plants = 0, length = 0, footprint = 0, glazing = 0, wallArea = 0;
  for (const g of ghosts) {
    const ring = world.place.ringOf(g);
    if (!ring) continue;
    const a = G.area(ring);
    footprint += a;
    if (g.type === 'drain') {
      const L = g.path ? G.perimeter(g.path, false) : G.perimeter(ring) / 2;
      const depth = g.props?.depth ?? (g.zTop - g.zBase);
      length += L;
      earthwork += L * (g.width || 1) * depth;
      gravel += L * (g.width || 1) * 0.15;
    } else if (g.type === 'path' || g.type === 'road') {
      const L = g.path ? G.perimeter(g.path, false) : G.perimeter(ring) / 2;
      length += L;
      gravel += L * (g.width || 1.5) * 0.12;
      earthwork += L * (g.width || 1.5) * 0.1;
    } else if (g.type === 'tree') {
      plants += 1;
    } else if (g.subtype === 'garden') {
      plants += Math.round(a / 1.5);
      earthwork += a * 0.15;
    } else if (g.type === 'structure') {
      const h = g.zTop - g.zBase;
      wallArea += G.perimeter(ring) * h;
      if (g.material === 'glass') glazing += G.perimeter(ring) * h + a;
      earthwork += a * 0.3;
    }
  }
  const round = (v, p = 1) => +v.toFixed(p);
  return {
    earthwork_m3: round(earthwork), gravel_m3: round(gravel), plants,
    length_m: round(length), footprint_m2: round(footprint),
    glazing_m2: round(glazing), wall_m2: round(wallArea),
  };
}

function regionAround(world, ghosts, removals) {
  const rings = [];
  for (const g of ghosts) { const r = world.place.ringOf(g); if (r) rings.push(r); }
  for (const id of removals) { const e = world.get(id); const r = e && world.ringOf(e); if (r) rings.push(r); }
  if (!rings.length) return null;
  const pts = rings.flat();
  const bb = G.bbox(pts);
  const pad = 12;
  return [[bb[0] - pad, bb[1] - pad], [bb[2] + pad, bb[1] - pad], [bb[2] + pad, bb[3] + pad], [bb[0] - pad, bb[3] + pad]];
}

function seedPoint(world) {
  const net = world.entities().find((e) => (e.type === 'road' || e.type === 'path') && e.path);
  if (net) return net.path[0];
  const b = world.place.bounds();
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}
