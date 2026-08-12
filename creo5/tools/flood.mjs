import { readFileSync, writeFileSync } from 'node:fs';
import { World } from '../src/core/world.js';
import * as G from '../src/core/geom.js';
import { findFlood, addFlood, SEVERITY } from '../src/import/flood.js';
import { makeProjection } from '../src/core/geom.js';

const file = 'places/hwy-321-johnson-064-03.json';
const w = World.load(readFileSync(file, 'utf8'));
const a = w.place.meta.anchor;
const parcel = w.entities().find((e) => e.type === 'parcel');
const ring = w.ringOf(parcel);
const b = G.bbox(ring);
const mLat = 111320, mLon = 111320 * Math.cos((a[0] * Math.PI) / 180);
const bbox = [a[0] + b[1] / mLat - 0.002, a[1] + b[0] / mLon - 0.002,
              a[0] + b[3] / mLat + 0.002, a[1] + b[2] / mLon + 0.002];

const zones = await findFlood(bbox);
const ids = addFlood(w, zones, makeProjection(a[0], a[1]));
console.log(`\nFEMA over parcel 064.03 — ${ids.length} zone polygons`);

// how much of the parcel each zone covers
const step = 12, counts = {};
let inside = 0;
for (let y = b[1]; y <= b[3]; y += step) {
  for (let x = b[0]; x <= b[2]; x += step) {
    if (!G.pointInRing([x, y], ring)) continue;
    inside++;
    let worst = 'X';
    for (const id of ids) {
      const e = w.get(id);
      if (G.pointInRing([x, y], w.ringOf(e)) && SEVERITY[e.props.zone] > SEVERITY[worst]) worst = e.props.zone;
    }
    counts[worst] = (counts[worst] || 0) + 1;
  }
}
for (const [z, n] of Object.entries(counts).sort((p, q) => SEVERITY[q[0]] - SEVERITY[p[0]])) {
  console.log(`  ${z.padEnd(12)} ${String(Math.round((100 * n) / inside)).padStart(3)}% of the parcel`);
}

// AND THE QUESTION: are the placements CREO recommended actually buildable?
const fit = JSON.parse(readFileSync('site-fit.json', 'utf8'));
console.log(`\nTHE PLACEMENTS CREO RECOMMENDED, CHECKED AGAINST FEMA\n`);
console.log(`  ${'lat, lon'.padEnd(26)} ${'earth'.padStart(8)}  zone`);
let killed = 0;
for (const c of fit.best.slice(0, 8)) {
  const at = [(c.lon - a[1]) * mLon, (c.lat - a[0]) * mLat];
  let worst = 'X';
  for (const id of ids) {
    const e = w.get(id);
    if (G.pointInRing(at, w.ringOf(e)) && SEVERITY[e.props.zone] > SEVERITY[worst]) worst = e.props.zone;
  }
  const bad = SEVERITY[worst] >= 2;
  if (bad) killed++;
  console.log(`  ${(c.lat.toFixed(5) + ', ' + c.lon.toFixed(5)).padEnd(26)}`
    + ` ${((c.cut_m3 + c.fill_m3) + 'm³').padStart(8)}  ${worst}${bad ? '   <- NOT BUILDABLE' : ''}`);
}
console.log(`\n  ${killed} of ${Math.min(8, fit.best.length)} are in the 1% floodplain or the floodway.`);
writeFileSync(file, w.save());
console.log(`  → saved into ${file}\n`);
