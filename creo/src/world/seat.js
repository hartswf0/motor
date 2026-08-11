// SEATING — what it costs the ground to accept a building.
//
// A building put on a hillside does not hover and it does not sink. The ground
// is cut away above it and built up below it until there is something level to
// stand on, and the disturbed earth is battered back to the natural slope
// around the edges. That earthwork is the real content of "placing a building
// on terrain": it has a volume, a price, a visible extent, and consequences for
// where the water goes.
//
// So this does not move a model until it is level. It changes the GROUND, and
// then everything already reading the ground — the contours, the roads and
// surfaces draped on it, the water model, the routes people walk — answers to
// the new shape without being told. That is why the drape had to be exact
// before this could exist.

import * as G from '../core/geom.js';
import { footprintAt, entrancesAt } from './body.js';

/**
 * Work out the earthwork for seating a body, WITHOUT changing anything.
 *
 * @param {World} world
 * @param {Body} body
 * @param {number[]} at            where its centre goes, in the place's metres
 * @param {object} opts
 * @param {number} opts.rotation   radians
 * @param {'balanced'|'cut'|'fill'|number} opts.level  how to choose the floor
 * @param {number} opts.batter     metres of fall per metre out, 0.5 = 1:2
 * @param {number} opts.apron      level ground kept outside the walls
 */
export function planSeat(world, body, at, {
  rotation = 0, level = 'balanced', batter = 0.5, apron = 1.2,
} = {}) {
  const t = world.place.terrain;
  if (!t) throw new Error('there is no ground here to seat anything on');

  const ring = footprintAt(body, at, rotation);
  const pad = apron > 0 ? G.offsetRing(ring, apron) : ring;
  const span = G.groundSpan(pad, (x, y) => world.place.groundAt(x, y), 8);
  if (!span) throw new Error('this footprint does not fall on the ground');

  // WHAT LEVEL. Balanced is the engineer's default — as much cut as fill, so
  // nothing has to be carted in or away — and on a slope it is also the honest
  // one: the building sits IN the hill rather than on a plinth or in a pit.
  const samples = sampleGround(world, pad, t.cell / 2);
  // Naming matters here: to CUT into a hill the floor goes DOWN to the low
  // side, and to FILL you build UP to the high side. I had these the wrong way
  // round, so asking to cut produced nine thousand cubic metres of fill.
  const floor = typeof level === 'number' ? level
    : level === 'cut' ? span.lo
      : level === 'fill' ? span.hi
        : median(samples);

  // WHAT IT COSTS. Every sample inside the pad is either cut down to the floor
  // or filled up to it; outside, the batter blends back to natural ground.
  // The batter cannot run forever. Sited across a cliff the fall is tens of
  // metres and an unbounded slope reached hundreds of metres out, which
  // reported half a million cubic metres — a real signal about the siting,
  // wildly overstated. Past this much earthwork the answer is not a bigger
  // batter, it is a retaining wall or a different site, and it says so.
  const MAX_REACH = 30;
  const want = Math.max(0.5, Math.abs(span.hi - span.lo)) / Math.max(0.05, batter);
  const reach = Math.min(MAX_REACH, want);
  const retained = want > MAX_REACH ? +(want - MAX_REACH).toFixed(1) : 0;
  const outer = G.offsetRing(pad, reach);
  const cellArea = (t.cell / 2) * (t.cell / 2);
  let cut = 0, fill = 0, disturbed = 0;
  for (const s of sampleGround(world, outer, t.cell / 2, true)) {
    const target = targetHeight(s.p, pad, floor, batter, s.z);
    if (target === null) continue;
    const d = target - s.z;
    if (Math.abs(d) < 0.02) continue;
    disturbed += cellArea;
    if (d < 0) cut += -d * cellArea; else fill += d * cellArea;
  }

  const grade = Math.max(0, span.hi - span.lo);
  return {
    body, at, rotation, floor, batter, apron,
    ring, pad, outer,
    ground: span,
    naturalFall: grade,
    cut, fill, balance: fill - cut,
    disturbedArea: disturbed,
    // how much fall the batter could not absorb: what a wall would have to hold
    retained: retained * batter,
    // what a person actually needs told
    reads: `${body.name}: floor at ${floor.toFixed(1)} m on ground falling ${grade.toFixed(1)} m — `
      + `${Math.round(cut)} m³ cut, ${Math.round(fill)} m³ fill, `
      + `${Math.round(disturbed)} m² of ground disturbed.`
      + (retained ? ` The slope cannot absorb ${(retained * batter).toFixed(1)} m of it — that is a retaining wall, or a different site.` : ''),
    entrances: entrancesAt(body, at, rotation),
  };
}

/** The height the ground should become at a point, or null if it is untouched. */
function targetHeight(p, pad, floor, batter, natural) {
  if (G.pointInRing(p, pad)) return floor;
  const d = G.ringDistance(pad, G.circleRing(p[0], p[1], 0.01, 4));
  const blended = floor + (natural > floor ? d * batter : -d * batter);
  // never fight the hill past the point where it has already met the batter
  if (natural > floor) return Math.min(natural, blended);
  return Math.max(natural, blended);
}

function sampleGround(world, ring, step, keepPoints = false) {
  const b = G.bbox(ring);
  const out = [];
  for (let y = b[1]; y <= b[3]; y += step) {
    for (let x = b[0]; x <= b[2]; x += step) {
      if (!G.pointInRing([x, y], ring)) continue;
      const z = world.place.groundAt(x, y);
      out.push(keepPoints ? { p: [x, y], z } : z);
    }
  }
  return out;
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * MAKE THE GROUND FINE ENOUGH TO HOLD A BUILDING.
 *
 * This is the thing that has to happen before any of the above means anything.
 * A 30-metre elevation cell cannot express a 12-metre house: seating one on
 * Ravello changed exactly ONE sample, so the earthwork was computed correctly
 * and then had nowhere to be recorded. The ground was a map, not a model.
 *
 * Resampling to a building-scale cell adds no information — every intermediate
 * height is interpolation of the same public data, and it must not be mistaken
 * for survey — but it adds the CAPACITY to be changed, which is what makes a
 * pad, a batter and a cut road representable at all. What is invented is the
 * detail between the original samples; what becomes real is whatever is then
 * deliberately carved into it.
 */
export function refineTerrain(place, targetCell = 3) {
  const t = place.terrain;
  if (!t) throw new Error('there is no ground here to refine');
  if (t.cell <= targetCell * 1.2) return { refined: false, cell: t.cell, samples: t.data.length };

  const Heightfield = t.constructor;
  const fine = new Heightfield(t.bounds, targetCell);
  for (let j = 0; j < fine.ny; j++) {
    for (let i = 0; i < fine.nx; i++) {
      const x = fine.bounds[0] + i * fine.cell;
      const y = fine.bounds[1] + j * fine.cell;
      fine.data[j * fine.nx + i] = t.heightAt(x, y);
    }
  }
  place.terrain = fine;
  place.meta = place.meta || {};
  place.meta.refined = {
    from: +t.cell.toFixed(1), to: targetCell,
    note: 'heights between the original samples are interpolation, not survey',
  };
  return { refined: true, from: t.cell, cell: fine.cell, samples: fine.data.length };
}

/**
 * Actually settle the ground, and hand back what it was — so this can be
 * undone. A terrain edit that cannot be taken back is not a proposal, and
 * everything in CREO is a proposal until someone accepts it.
 */
export function settleGround(world, seat) {
  const t = world.place.terrain;
  const b = G.bbox(seat.outer);
  const before = [];
  const i0 = Math.max(0, Math.floor((b[0] - t.bounds[0]) / t.cell));
  const i1 = Math.min(t.nx - 1, Math.ceil((b[2] - t.bounds[0]) / t.cell));
  const j0 = Math.max(0, Math.floor((b[1] - t.bounds[1]) / t.cell));
  const j1 = Math.min(t.ny - 1, Math.ceil((b[3] - t.bounds[1]) / t.cell));

  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const x = t.bounds[0] + i * t.cell, y = t.bounds[1] + j * t.cell;
      const k = j * t.nx + i;
      const natural = t.data[k];
      if (!G.pointInRing([x, y], seat.outer)) continue;
      const target = targetHeight([x, y], seat.pad, seat.floor, seat.batter, natural);
      if (target === null || Math.abs(target - natural) < 0.01) continue;
      before.push([k, natural]);
      t.data[k] = target;
    }
  }
  t.__lo = undefined;                 // the colour ramp was cached against the old ground
  return { restore: () => { for (const [k, z] of before) t.data[k] = z; t.__lo = undefined; }, changed: before.length };
}

/**
 * What this seating disturbs that someone already relies on. Not a veto — the
 * builder does not get to decide that a road may not be cut — but it must be
 * said, because the whole point of a place model is that things are already
 * there and answer to each other.
 */
export function disturbances(world, seat) {
  const out = [];
  for (const e of world.entities()) {
    const r = world.ringOf(e);
    if (!r || r.length < 3) continue;
    const c = G.centroid(r);
    const inside = G.pointInRing(c, seat.outer);
    const crosses = inside || r.some((p) => G.pointInRing(p, seat.outer));
    if (!crosses) continue;
    const under = G.pointInRing(c, seat.pad);
    out.push({
      id: e.id,
      name: e.name || e.use || e.type,
      type: e.type,
      how: under ? 'stands where the building goes' : 'is in the disturbed ground around it',
      // for a way, how far its ground moves is the number that matters
      moves: e.type === 'road' || e.type === 'path'
        ? +(targetHeight(c, seat.pad, seat.floor, seat.batter, world.place.groundAt(c[0], c[1]))
          - world.place.groundAt(c[0], c[1])).toFixed(2)
        : null,
    });
  }
  return out.sort((a, b) => Math.abs(b.moves || 0) - Math.abs(a.moves || 0));
}
