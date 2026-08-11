// Seat the design on the site ONCE and save it into the place, so that opening
// the site on a phone shows the house — no command line, no build step, nothing
// for anybody to run.
import { readFileSync, writeFileSync } from 'node:fs';
import { World } from '../src/core/world.js';
import * as G from '../src/core/geom.js';
import { bodyFromDesign } from '../src/world/design.js';
import { planSeat, settleGround, refineTerrain } from '../src/world/seat.js';
import { footprintAt } from '../src/world/body.js';

const mod = await import('../designs/henry-house/geometry.mjs');
const body = bodyFromDesign(mod, { name: 'Henry House' });
const ob = G.orientedBounds(body.footprint);

const file = 'places/hwy-321-johnson-064-03.json';
const w = World.load(readFileSync(file, 'utf8'));
const parcel = w.entities().find((e) => e.type === 'parcel');
const ring = w.ringOf(parcel);

// the flattest ground inside the boundary that a 22 m house fits on
const b = G.bbox(ring);
let best = null;
for (let y = b[1]; y <= b[3]; y += 15) {
  for (let x = b[0]; x <= b[2]; x += 15) {
    if (!G.pointInRing([x, y], ring)) continue;
    const sp = G.groundSpan(G.circleRing(x, y, ob.width / 2, 14), (a, c) => w.place.groundAt(a, c), 6);
    if (!sp) continue;
    // it must sit wholly inside the parcel, not merely centre on it
    const fits = footprintAt(body, [x, y], 0).every((p) => G.pointInRing(p, ring));
    if (!fits) continue;
    const fall = sp.hi - sp.lo;
    if (!best || fall < best.fall) best = { at: [x, y], fall };
  }
}
if (!best) throw new Error('the house does not fit inside this boundary anywhere');

refineTerrain(w.place, 3, best.at, 140);

// the cheapest quarter turn, measured rather than assumed
let pick = null;
for (let deg = 0; deg < 180; deg += 10) {
  const s = planSeat(w, body, best.at, { rotation: (deg * Math.PI) / 180, level: 'balanced' });
  if (!pick || s.cut + s.fill < pick.earth) pick = { deg, earth: s.cut + s.fill, seat: s };
}
const seat = pick.seat;
settleGround(w, seat);

w.place.put({
  id: 'henry-house',
  type: 'structure',
  name: 'Henry House',
  footprint: seat.ring,
  zBase: seat.floor,
  zTop: seat.floor + body.height,
  epistemic: 'PROPOSED',
  collision: 'solid',
  material: 'timber',
  sim: { permeability: 0, roughness: 0.02 },
  provenance: { author: 'Henry House · geometry.mjs', how: 'seated on the measured ground', when: new Date().toISOString() },
  props: {
    levels: body.levels.length,
    height_m: +body.height.toFixed(1),
    turnedTo: `N${pick.deg}°E`,
    assumedBearing: `N${body.assumes.azimuth}°E`,
    earthwork_m3: Math.round(pick.earth),
    cut_m3: Math.round(seat.cut), fill_m3: Math.round(seat.fill),
    note: 'seated by CREO on public elevation, not on a survey',
  },
});

writeFileSync(file, w.save());
console.log(`\nHENRY HOUSE seated on parcel 064.03`);
console.log(`  ${ob.width.toFixed(1)} × ${ob.depth.toFixed(1)} m, ${body.height.toFixed(1)} m tall, ${body.levels.length} levels`);
console.log(`  on the flattest ground it fits on: ${best.fall.toFixed(1)} m of fall`);
console.log(`  turned to N${pick.deg}°E (design assumed N${body.assumes.azimuth}°E)`);
console.log(`  ${Math.round(seat.cut)} m³ cut, ${Math.round(seat.fill)} m³ fill, floor at ${seat.floor.toFixed(1)} m`);
console.log(`  → saved into ${file}\n`);
