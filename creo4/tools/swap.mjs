// Put a design on the site and let the ground answer it.
//   node tools/swap.mjs designs/henry-house/geometry.mjs "Henry House"
import { readFileSync } from 'node:fs';
import { World } from '../src/core/world.js';
import * as G from '../src/core/geom.js';
import { bodyFromDesign, checkAgainstGround } from '../src/world/design.js';
import { planSeat, refineTerrain } from '../src/world/seat.js';

const [path, name = 'design'] = process.argv.slice(2);
const mod = await import(new URL(`../${path}`, import.meta.url));
const body = bodyFromDesign(mod, { name });
const ob = G.orientedBounds(body.footprint);

console.log(`\n${name.toUpperCase()} — read from ${path.split('/').pop()}, not from a mesh`);
console.log(`  ${ob.width.toFixed(1)} × ${ob.depth.toFixed(1)} m, ${body.height.toFixed(1)} m tall`
  + `, ${body.levels.length} levels`);
console.log(`  assumes: long axis N${body.assumes.azimuth}°E, ${body.assumes.crossSlopePercent}% cross slope`);

const w = World.load(readFileSync('places/hwy-321-johnson-064-03.json', 'utf8'));
const parcel = w.entities().find((e) => e.type === 'parcel');
const ring = w.ringOf(parcel);

const check = checkAgainstGround(body, w, ring);
console.log(`\nWHAT THE GROUND SAYS`);
for (const r of check.rows) {
  console.log(`  ${r.of}`);
  console.log(`    assumed ${r.assumed}  ·  measured ${r.measured}  ·  ${r.by}`);
  console.log(`    ${r.easy}`);
}
console.log(`\n  ${check.caution}`);

// seat it on the flattest ground inside the boundary, at the assumed bearing
// and at the measured one, and let the earthwork decide
const b = G.bbox(ring);
let best = null;
for (let y = b[1]; y <= b[3]; y += 25) {
  for (let x = b[0]; x <= b[2]; x += 25) {
    if (!G.pointInRing([x, y], ring)) continue;
    const sp = G.groundSpan(G.circleRing(x, y, ob.width / 2, 14), (a, c) => w.place.groundAt(a, c), 6);
    if (!sp) continue;
    const fall = sp.hi - sp.lo;
    if (!best || fall < best.fall) best = { at: [x, y], fall };
  }
}
if (!best) { console.log('\n  no ground inside the boundary could hold it\n'); process.exit(0); }

refineTerrain(w.place, 3, best.at, 120);
console.log(`\nSEATED on the flattest ground inside the boundary (${best.fall.toFixed(1)} m of fall)`);
const tries = [];
for (const deg of [body.assumes.azimuth, 0, 30, 60, 90, 120, 150]) {
  if (deg == null) continue;
  const s = planSeat(w, body, best.at, { rotation: (deg * Math.PI) / 180, level: 'balanced' });
  tries.push({ deg, earth: s.cut + s.fill, cut: s.cut, fill: s.fill, floor: s.floor });
}
tries.sort((a, c) => a.earth - c.earth);
for (const t of tries) {
  const tag = t.deg === body.assumes.azimuth ? '  <- as the design assumes' : '';
  console.log(`  N${String(t.deg).padStart(3)}°E   ${Math.round(t.earth).toString().padStart(6)} m³ moved`
    + `   (${Math.round(t.cut)} cut, ${Math.round(t.fill)} fill)${tag}`);
}
const assumed = tries.find((t) => t.deg === body.assumes.azimuth);
if (assumed && tries[0].deg !== assumed.deg) {
  console.log(`\n  turning it to N${tries[0].deg}°E saves ${Math.round(assumed.earth - tries[0].earth)} m³`
    + ` against the assumed bearing.`);
}
console.log('');
