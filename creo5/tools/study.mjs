// WHAT THE LAND OFFERS — a study of every place the house could stand.
//
// "Find the best view" is not a matter of taste that needs a model to guess at.
// It is a ray cast against real elevation, repeated. For every candidate the
// house fits on, this asks the ground four questions and refuses to collapse
// them into one number, because the trade between them is the decision and it
// belongs to a person.
import { readFileSync, writeFileSync } from 'node:fs';
import { World } from '../src/core/world.js';
import * as G from '../src/core/geom.js';
import { bodyFromDesign } from '../src/world/design.js';
import { planSeat } from '../src/world/seat.js';
import { footprintAt } from '../src/world/body.js';
import { planAccess } from '../src/world/access.js';

const mod = await import('../designs/henry-house/geometry.mjs');
const body = bodyFromDesign(mod, { name: 'Henry House' });
const ob = G.orientedBounds(body.footprint);
const w = World.load(readFileSync('places/hwy-321-johnson-064-03.json', 'utf8'));
const parcel = w.entities().find((e) => e.type === 'parcel');
const ring = w.ringOf(parcel);
const ground = (x, y) => w.place.groundAt(x, y);

const EYE = 1.6 + 3;                 // standing on the main floor, above the pad
const RAYS = 48;                     // every 7.5°
const FAR = 3000;                    // how far a view is worth having

/** How much sky-to-ground a viewer sees, and where the open quarters are. */
function viewFrom(x, y, z) {
  let open = 0;
  const bands = new Array(8).fill(0);
  for (let r = 0; r < RAYS; r++) {
    const a = (r / RAYS) * Math.PI * 2;
    const dx = Math.cos(a), dy = Math.sin(a);
    let highest = -Infinity, reach = 0;
    for (let d = 40; d <= FAR; d += 40) {
      const gz = ground(x + dx * d, y + dy * d);
      const angle = (gz - z) / d;            // rise over run from the eye
      if (angle > highest) { highest = angle; }
      // the ray is still clear if nothing yet blocks the horizon below it
      if (highest < 0.02) reach = d;
    }
    open += reach;
    bands[Math.floor((r / RAYS) * 8) % 8] += reach;
  }
  return { mean: open / RAYS, bands };
}

const COMPASS = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];
const b = G.bbox(ring);
const spots = [];
for (let y = b[1]; y <= b[3]; y += 20) {
  for (let x = b[0]; x <= b[2]; x += 20) {
    if (!G.pointInRing([x, y], ring)) continue;
    if (!footprintAt(body, [x, y], 0).every((p) => G.pointInRing(p, ring))) continue;
    const sp = G.groundSpan(G.circleRing(x, y, ob.width / 2, 14), ground, 6);
    if (!sp) continue;
    const fall = sp.hi - sp.lo;
    if (fall > 8) continue;                  // past this it is a retaining wall, not a site
    const z = ground(x, y) + EYE;
    const v = viewFrom(x, y, z);
    const best = v.bands.indexOf(Math.max(...v.bands));
    spots.push({ at: [x, y], z: ground(x, y), fall, view: v.mean, looks: COMPASS[best], bands: v.bands });
  }
}
if (!spots.length) { console.log('nothing inside the boundary holds the house'); process.exit(0); }

// earthwork for the best few, at their cheapest turn
const byView = [...spots].sort((a, c) => c.view - a.view);
const byFlat = [...spots].sort((a, c) => a.fall - c.fall);
const shortlist = [...new Set([...byView.slice(0, 4), ...byFlat.slice(0, 3)])];
for (const s of shortlist) {
  let cheap = null;
  for (let deg = 0; deg < 180; deg += 15) {
    const seat = planSeat(w, body, s.at, { rotation: (deg * Math.PI) / 180, level: 'balanced' });
    const earth = seat.cut + seat.fill;
    if (!cheap || earth < cheap.earth) cheap = { deg, earth };
  }
  s.earth = cheap.earth; s.deg = cheap.deg;

  // THE FIFTH QUESTION — can you get there? A drive is searched for, from the
  // whole existing network, inside the boundary, at a 15% hard limit. "No" is
  // a real answer: a site you cannot legally drive to at a sane grade is a
  // different proposition from one you can, whatever its view.
  const a = planAccess(w, s.at, { maxGrade: 0.15, keepInside: ring, cell: 14, maxPops: 40000 });
  s.drive = a.possible
    ? (a.onNetwork
      ? { onWay: true, from: a.fromName }
      : { m: Math.round(a.length), maxPct: Math.round(a.maxG * 100), from: a.fromName, turns: a.turns })
    : null;
}

console.log(`\nPARCEL 064.03 — ${spots.length} places the house fits wholly inside the boundary\n`);
console.log(`  ${'where'.padEnd(16)} ${'elev'.padStart(5)} ${'fall'.padStart(6)} ${'view'.padStart(7)}  ${'looks'.padEnd(5)} ${'earth'.padStart(8)}  ${'turn'.padEnd(7)} drive ≤15%`);
for (const s of shortlist.sort((a, c) => c.view - a.view)) {
  console.log(`  ${(s.at.map(Math.round).join(', ')).padEnd(16)}`
    + ` ${s.z.toFixed(0).padStart(4)}m ${s.fall.toFixed(1).padStart(5)}m`
    + ` ${(s.view / 1000).toFixed(2).padStart(6)}km  ${s.looks.padEnd(5)}`
    + ` ${Math.round(s.earth).toString().padStart(6)}m³  ${('N' + s.deg + '°E').padEnd(7)}`
    + ` ${!s.drive ? 'no way inside the boundary'
      : s.drive.onWay ? 'a way already crosses here (' + (s.drive.from || 'unnamed') + ')'
      : s.drive.m + 'm @ ' + s.drive.maxPct + '% via ' + (s.drive.from || 'unnamed way')}`);
}

const view = shortlist[0];
const flat = [...shortlist].sort((a, c) => a.earth - c.earth)[0];
console.log(`\n  THE VIEW is best at ${view.at.map(Math.round).join(', ')} — ${(view.view / 1000).toFixed(2)} km of open ground,`
  + ` mostly ${view.looks}, and it costs ${Math.round(view.earth)} m³.`);
console.log(`  THE GROUND is easiest at ${flat.at.map(Math.round).join(', ')} — ${Math.round(flat.earth)} m³,`
  + ` with ${(flat.view / 1000).toFixed(2)} km of view.`);
console.log(view === flat
  ? '  They are the same place, which is rare and worth knowing.'
  : `  They are ${Math.round(Math.hypot(view.at[0] - flat.at[0], view.at[1] - flat.at[1]))} m apart.`
    + ` That distance is the decision, and it is not CREO\\'s to make.`);
const reachable = shortlist.filter((s) => s.drive && !s.drive.onWay);
if (reachable.length) {
  const acc = [...reachable].sort((a, c) => a.drive.m - c.drive.m)[0];
  console.log(`  THE ACCESS is shortest at ${acc.at.map(Math.round).join(', ')} — ${acc.drive.m} m of drive`
    + ` at ${acc.drive.maxPct}% from ${acc.drive.from || 'an unnamed way'}.`);
}
const onWay = shortlist.filter((s) => s.drive && s.drive.onWay);
if (onWay.length) {
  console.log(`  ${onWay.length} of these stand ON a mapped way — the drive is free because the house is in the road.`);
}
const unreachable = shortlist.filter((s) => !s.drive);
if (unreachable.length) {
  console.log(`  ${unreachable.length} of these ${shortlist.length} cannot be driven to inside the boundary at 15%.`
    + ` A view you cannot arrive at is a picture, not a site.`);
}
console.log(`\n  Neither figure is a survey, and the trees are not in this: 27 of the 29`
  + `\n  acres are woodland nobody has mapped, and standing timber is most of what`
  + `\n  a view actually is.\n`);

writeFileSync('study.json', JSON.stringify({ spots: spots.length, shortlist }, null, 1));
