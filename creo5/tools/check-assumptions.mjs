// Does the Henry House's assumed site match the ground it is going on?
//
// geometry.mjs is explicit: the long axis bears N70°E "chosen to lie along the
// assumed contour", the cross slope is 30% and the long slope 8%, and every
// site elevation is "ASSUMED PENDING SURVEY". CREO has the real terrain for
// parcel 064.03. So it can check — which is the whole reason a place model
// exists: not to draw the house, but to tell it what it is standing on.
import { readFileSync } from 'node:fs';
import { World } from '../src/core/world.js';
import * as G from '../src/core/geom.js';

const w = World.load(readFileSync('places/hwy-321-johnson-064-03.json', 'utf8'));
const parcel = w.entities().find((e) => e.type === 'parcel');
const ring = w.ringOf(parcel);
const ground = (x, y) => w.place.groundAt(x, y);

// the house: 72 ft x 26 ft, and the slope it expects
const HOUSE = { long: 72 * 0.3048, deep: 26 * 0.3048 };
const ASSUMED = { azimuth: 70, cross: 30, long: 8 };

// Walk the parcel and measure, at house scale, what the ground actually does.
const b = G.bbox(ring);
const step = 20;
const spots = [];
for (let y = b[1]; y <= b[3]; y += step) {
  for (let x = b[0]; x <= b[2]; x += step) {
    if (!G.pointInRing([x, y], ring)) continue;
    const s = w.place.terrain.slopeAt(x, y);
    // the contour bearing is perpendicular to the fall line
    const fall = (Math.atan2(-s.dzdx, -s.dzdy) * 180) / Math.PI;
    const contour = ((fall + 90) % 180 + 180) % 180;
    spots.push({ at: [x, y], grade: s.grade * 100, contour, z: ground(x, y) });
  }
}
spots.sort((a, c) => a.grade - c.grade);

const median = (a) => a[Math.floor(a.length / 2)];
const gentle = spots.filter((s) => s.grade <= 30);
console.log(`\nPARCEL 064.03 — ${spots.length} points at ${step} m, inside the boundary\n`);
console.log(`  the house assumes a ${ASSUMED.cross}% cross slope`);
console.log(`  the parcel actually runs ${spots[0].grade.toFixed(0)}% to ${spots[spots.length - 1].grade.toFixed(0)}%,`
  + ` median ${median(spots).grade.toFixed(0)}%`);
console.log(`  ground at or under 30%: ${gentle.length} of ${spots.length} points`
  + ` (${Math.round((100 * gentle.length) / spots.length)}% of the parcel)\n`);

// where the house could actually sit, and how the contour runs there
console.log(`  the house assumes its long axis at N${ASSUMED.azimuth}°E, along the contour`);
const buildable = gentle.slice(0, 40);
if (buildable.length) {
  const bearings = buildable.map((s) => s.contour).sort((a, c) => a - c);
  const mid = median(bearings);
  const off = Math.min(Math.abs(mid - ASSUMED.azimuth), 180 - Math.abs(mid - ASSUMED.azimuth));
  console.log(`  on the flattest ground the contour runs about N${mid.toFixed(0)}°E`);
  console.log(`  the assumption is ${off.toFixed(0)}° off ${off < 20 ? '— close' : '— NOT along the contour there'}\n`);
}

// the flattest real place to put a 72 x 26 ft house
let best = null;
for (const s of gentle) {
  const sp = G.groundSpan(G.circleRing(s.at[0], s.at[1], HOUSE.long / 2, 16), ground, 6);
  if (!sp) continue;
  const fall = sp.hi - sp.lo;
  if (!best || fall < best.fall) best = { ...s, fall, sp };
}
if (best) {
  console.log(`  the flattest ${Math.round(HOUSE.long)} m circle inside the boundary:`);
  console.log(`    ${best.fall.toFixed(1)} m of fall, at ${best.z.toFixed(0)} m elevation,`
    + ` on ground of ${best.grade.toFixed(0)}%`);
  console.log(`    contour there runs N${best.contour.toFixed(0)}°E\n`);
} else {
  console.log('  no ground gentle enough for the house was found inside the boundary\n');
}
