// Hand the site-fit page an ANSWER, not a slider.
//
// The page positions the house with root.position.set(east, H(east,north) - modelGround, -north):
// it moves the BUILDING to the ground at one point. On a 30% slope a 72-foot bar
// pinned by its centre has one end buried and the other in the air, and no
// amount of nudging fixes that — because the thing that has to move is the
// GROUND. This emits what CREO measured: where, which way, the finished floor,
// the earthwork, and the pad to cut.
import { readFileSync, writeFileSync } from 'node:fs';
import { World } from '../src/core/world.js';
import * as G from '../src/core/geom.js';
import { bodyFromDesign } from '../src/world/design.js';
import { planSeat } from '../src/world/seat.js';
import { footprintAt } from '../src/world/body.js';

const M_TO_FT = 3.280839895;
const mod = await import('../designs/henry-house/geometry.mjs');
const body = bodyFromDesign(mod, { name: 'Henry House' });
const ob = G.orientedBounds(body.footprint);
const w = World.load(readFileSync('places/hwy-321-johnson-064-03.json', 'utf8'));
const parcel = w.entities().find((e) => e.type === 'parcel');
const ring = w.ringOf(parcel);
const anchor = w.place.meta.anchor;

const candidates = [];
const bb = G.bbox(ring);
for (let y = bb[1]; y <= bb[3]; y += 20) {
  for (let x = bb[0]; x <= bb[2]; x += 20) {
    if (!G.pointInRing([x, y], ring)) continue;
    if (!footprintAt(body, [x, y], 0).every((p) => G.pointInRing(p, ring))) continue;
    let cheap = null;
    for (let deg = 0; deg < 180; deg += 15) {
      const s = planSeat(w, body, [x, y], { rotation: (deg * Math.PI) / 180, level: 'balanced' });
      const earth = s.cut + s.fill;
      if (!cheap || earth < cheap.earth) cheap = { deg, earth, seat: s };
    }
    const sp = G.groundSpan(G.circleRing(x, y, ob.width / 2, 14), (a, c) => w.place.groundAt(a, c), 6);
    candidates.push({
      // metres east/north of the anchor, which is what the page's lonLatToLocalFt expects in feet
      east_ft: +(x * M_TO_FT).toFixed(1),
      north_ft: +(y * M_TO_FT).toFixed(1),
      lon: +(anchor[1] + x / (111320 * Math.cos((anchor[0] * Math.PI) / 180))).toFixed(7),
      lat: +(anchor[0] + y / 111320).toFixed(7),
      bearing_deg: cheap.deg,
      finishedFloor_ft: +(cheap.seat.floor * M_TO_FT).toFixed(1),
      cut_m3: Math.round(cheap.seat.cut),
      fill_m3: Math.round(cheap.seat.fill),
      naturalFall_ft: +((sp.hi - sp.lo) * M_TO_FT).toFixed(1),
      // the pad to cut, in the page's own feet, so it can shape the ground
      pad_ft: cheap.seat.pad.map((p) => [+(p[0] * M_TO_FT).toFixed(1), +(p[1] * M_TO_FT).toFixed(1)]),
      disturbed_ft: cheap.seat.outer.map((p) => [+(p[0] * M_TO_FT).toFixed(1), +(p[1] * M_TO_FT).toFixed(1)]),
    });
  }
}
candidates.sort((a, b) => (a.cut_m3 + a.fill_m3) - (b.cut_m3 + b.fill_m3));

const out = {
  parcel: { id: parcel.props.parcelId, owner: parcel.props.owner, deedAcres: parcel.props.deedAcres },
  anchor: { lat: anchor[0], lon: anchor[1] },
  house_ft: { long: +(ob.width * M_TO_FT).toFixed(1), deep: +(ob.depth * M_TO_FT).toFixed(1),
    tall: +(body.height * M_TO_FT).toFixed(1), levels: body.levels.length },
  assumed: { bearing_deg: body.assumes.azimuth, crossSlopePct: body.assumes.crossSlopePercent },
  fits: candidates.length,
  best: candidates.slice(0, 12),
  caution: 'public elevation interpolated to building scale; the parcel boundary is the '
    + 'assessor\'s, not a surveyor\'s. Nothing here substitutes for a survey.',
};
writeFileSync('site-fit.json', JSON.stringify(out, null, 1));

console.log(`\nHOUSE  ${out.house_ft.long} × ${out.house_ft.deep} ft, ${out.house_ft.tall} ft tall, ${out.house_ft.levels} levels`);
console.log(`       (if your page shows it a different size, the model is in INCHES and your site is in FEET)\n`);
console.log(`${candidates.length} placements fit wholly inside the boundary. Cheapest earthwork:\n`);
console.log(`  ${'lat, lon'.padEnd(26)} ${'bear'.padStart(5)} ${'FFE'.padStart(7)} ${'cut'.padStart(6)} ${'fill'.padStart(6)}  natural fall`);
for (const c of out.best.slice(0, 6)) {
  console.log(`  ${(c.lat.toFixed(5) + ', ' + c.lon.toFixed(5)).padEnd(26)}`
    + ` ${(c.bearing_deg + '°').padStart(5)} ${(c.finishedFloor_ft + 'ft').padStart(7)}`
    + ` ${(c.cut_m3 + 'm³').padStart(6)} ${(c.fill_m3 + 'm³').padStart(6)}  ${c.naturalFall_ft} ft`);
}
console.log(`\n  → site-fit.json — position, bearing, finished floor, and the pad polygon to cut\n`);
