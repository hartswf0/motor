// Put the house on the site as the volumes it actually is, and keep the ground.
import { readFileSync, writeFileSync } from 'node:fs';
import { World } from '../src/core/world.js';
import * as G from '../src/core/geom.js';
import { bodyFromDesign } from '../src/world/design.js';
import { planSeat, settleGround, refineTerrain } from '../src/world/seat.js';
import { footprintAt, boxBody } from '../src/world/body.js';

const IN = 0.0254;
const mod = await import('../designs/henry-house/geometry.mjs');
const body = bodyFromDesign(mod, { name: 'Henry House' });
const ob = G.orientedBounds(body.footprint);

const file = 'places/hwy-321-johnson-064-03.json';
const w = World.load(readFileSync(file, 'utf8'));
const before = w.place.terrain.bounds[2] - w.place.terrain.bounds[0];
const parcel = w.entities().find((e) => e.type === 'parcel');
const ring = w.ringOf(parcel);

// flattest ground the whole house fits on, inside the boundary
const bb = G.bbox(ring);
let best = null;
for (let y = bb[1]; y <= bb[3]; y += 15) {
  for (let x = bb[0]; x <= bb[2]; x += 15) {
    if (!G.pointInRing([x, y], ring)) continue;
    if (!footprintAt(body, [x, y], 0).every((p) => G.pointInRing(p, ring))) continue;
    const sp = G.groundSpan(G.circleRing(x, y, ob.width / 2, 14), (a, c) => w.place.groundAt(a, c), 6);
    if (!sp) continue;
    if (!best || sp.hi - sp.lo < best.fall) best = { at: [x, y], fall: sp.hi - sp.lo };
  }
}
refineTerrain(w.place, 3, best.at, 140);

let pick = null;
for (let deg = 0; deg < 180; deg += 10) {
  const s = planSeat(w, body, best.at, { rotation: (deg * Math.PI) / 180, level: 'balanced' });
  if (!pick || s.cut + s.fill < pick.earth) pick = { deg, earth: s.cut + s.fill, seat: s };
}
settleGround(w, pick.seat);
const floor = pick.seat.floor, rot = (pick.deg * Math.PI) / 180;

// THE ACTUAL VOLUMES. The module computes a stepped bar with a garage and a
// link; drawing one bounding box threw all of that away. Each part is placed in
// the house's own coordinates, turned with it, and stood at its own level.
const centre = [(mod.BAR.x0 + mod.BAR.x1) / 2, (mod.BAR.y0 + mod.BAR.y1) / 2];
const lvl = Object.fromEntries((mod.LEVELS || []).map((l) => [l.id, (l.ffe ?? 0) * IN]));
const PARTS = [
  ['L0', mod.FOOTPRINTS?.L0, lvl.L0 ?? 0, (lvl.L1 ?? 3) - (lvl.L0 ?? 0), 'lower level'],
  ['L1', mod.FOOTPRINTS?.L1, lvl.L1 ?? 3, (lvl.L2 ?? 6.1) - (lvl.L1 ?? 3), 'main level'],
  ['L2', mod.FOOTPRINTS?.L2, lvl.L2 ?? 6.1, 3.0, 'upper level'],
  ['garage', mod.GARAGE, 0, 3.4, 'garage'],
  ['link', mod.LINK, 0, 3.0, 'link'],
];
let n = 0;
for (const [id, box, base, tall, label] of PARTS) {
  if (!box || !Number.isFinite(box.x1)) continue;
  const local = [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]]
    .map(([x, y]) => [(x - centre[0]) * IN, (y - centre[1]) * IN]);
  const part = { ...boxBody({ width: 1, depth: 1, height: tall }), footprint: local };
  w.place.put({
    id: `henry-house-${id}`,
    type: 'structure',
    name: `Henry House · ${label}`,
    footprint: footprintAt(part, best.at, rot),
    zBase: floor + base,
    zTop: floor + base + tall,
    epistemic: 'PROPOSED',
    collision: 'solid',
    material: id === 'garage' ? 'concrete' : 'timber',
    sim: { permeability: 0, roughness: 0.02 },
    provenance: { author: 'Henry House · geometry.mjs', how: `${label}, read from the design module`, when: new Date().toISOString() },
    props: { part: id, level_m: +base.toFixed(2), turnedTo: `N${pick.deg}°E`, assumed: `N${body.assumes.azimuth}°E` },
  });
  n++;
}
writeFileSync(file, w.save());
const after = w.place.terrain.bounds[2] - w.place.terrain.bounds[0];
console.log(`\nHENRY HOUSE — ${n} real volumes, not a box`);
for (const [id, box, base, tall, label] of PARTS) {
  if (!box || !Number.isFinite(box.x1)) continue;
  console.log(`  ${label.padEnd(12)} ${((box.x1 - box.x0) * IN).toFixed(1)}×${((box.y1 - box.y0) * IN).toFixed(1)} m`
    + `  floor +${base.toFixed(1)} m  ${tall.toFixed(1)} m tall`);
}
console.log(`\n  turned N${pick.deg}°E · ${Math.round(pick.seat.cut)} m³ cut, ${Math.round(pick.seat.fill)} m³ fill`);
console.log(`  TOPOGRAPHY KEPT: ${(before / 1000).toFixed(1)} km before, ${(after / 1000).toFixed(1)} km after\n`);
