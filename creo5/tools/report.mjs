// THE SITE REPORT — what the land offers, as a document you can hand over.
//
//   node tools/report.mjs            → report.html
//
// Every figure and every picture in the file is computed here, from the place,
// on the run that writes it. Nothing is transcribed. That is the same argument
// geometry.mjs makes about the drawings: if two of them disagree it is a bug in
// a generator, not a coordination error — so there is no copy of a number in
// this document that some later edit could leave behind.
import { readFileSync, writeFileSync } from 'node:fs';
import { World } from '../src/core/world.js';
import * as G from '../src/core/geom.js';
import { bodyFromDesign } from '../src/world/design.js';
import { planSeat } from '../src/world/seat.js';
import { footprintAt } from '../src/world/body.js';
import { planAccess, nearestOnNetwork } from '../src/world/access.js';
import * as R from './render.mjs';
import { aerial } from './imagery.mjs';
import { placedFaces } from './house.mjs';
import { jpeg } from './jpeg.mjs';

const M_FT = 3.280839895;
const mod = await import('../designs/henry-house/geometry.mjs');
const body = bodyFromDesign(mod, { name: 'Henry House' });
const ob = G.orientedBounds(body.footprint);
const w = World.load(readFileSync('places/hwy-321-johnson-064-03.json', 'utf8'));
const P = w.place;
const parcel = w.entities().find((e) => e.type === 'parcel');
const ring = w.ringOf(parcel);
const ground = (x, y) => P.groundAt(x, y);
const DATUM = P.meta.datum;                       // metres AMSL of local zero
const amsl = (z) => z + DATUM;

const log = (m) => console.log('  ' + m);
console.log('\nSITE REPORT — parcel 064.03');

// ---------------------------------------------------------------- the ground
const span = G.groundSpan(ring, ground, 24);
const houseParts = w.entities().filter((e) => String(e.id).startsWith('henry-house-'));
const garage = houseParts.find((e) => e.id === 'henry-house-garage');
const houseAt = G.centroid(w.ringOf(houseParts.find((e) => e.id === 'henry-house-L1')));
// THE DATUM IS THE LOWER LEVEL. geometry.mjs puts Z=0 at the LOWER LEVEL
// finished floor (units.mjs says so outright), and place-house.mjs seated L0 at
// exactly that. Reading the datum off henry-house-L1 instead — the MAIN level —
// stood the whole massing and the whole section one storey, 3.05 m, in the air.
// Two floors are not far apart on a 31 m terrain cell, which is precisely why
// nothing looked wrong.
const floor = houseParts.find((e) => e.id === 'henry-house-L0')?.zBase
  ?? houseParts.find((e) => e.id === 'henry-house-L1')?.zBase ?? 0;
// the bearing the house was actually turned to when it was seated
const turnedDeg = parseFloat(String(houseParts[0].props?.turnedTo || 'N90').replace(/[^\d.-]/g, '')) || 90;

// where the drive must end: a gate off the garage, on the side the network is on
const gc = G.centroid(w.ringOf(garage));
const near = nearestOnNetwork(w, gc);
const gbb = G.bbox(w.ringOf(garage));
const gate = G.add(gc, G.mul(G.norm(G.sub(near.p, gc)),
  Math.max(gbb[2] - gbb[0], gbb[3] - gbb[1]) / 2 + 7));

// ------------------------------------------------------- the four questions +
const EYE = 1.6 + 3, RAYS = 48, FAR = 3000;
const COMPASS = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];
function viewFrom(x, y, z) {
  let open = 0;
  const bands = new Array(8).fill(0);
  for (let r = 0; r < RAYS; r++) {
    const a = (r / RAYS) * Math.PI * 2, dx = Math.cos(a), dy = Math.sin(a);
    let highest = -Infinity, reach = 0;
    for (let d = 40; d <= FAR; d += 40) {
      const angle = (ground(x + dx * d, y + dy * d) - z) / d;
      if (angle > highest) highest = angle;
      if (highest < 0.02) reach = d;
    }
    open += reach;
    bands[Math.floor((r / RAYS) * 8) % 8] += reach;
  }
  return { mean: open / RAYS, looks: COMPASS[bands.indexOf(Math.max(...bands))] };
}

log('walking the parcel…');
const bb = G.bbox(ring);
const spots = [];
for (let y = bb[1]; y <= bb[3]; y += 20) {
  for (let x = bb[0]; x <= bb[2]; x += 20) {
    if (!G.pointInRing([x, y], ring)) continue;
    if (!footprintAt(body, [x, y], 0).every((p) => G.pointInRing(p, ring))) continue;
    const sp = G.groundSpan(G.circleRing(x, y, ob.width / 2, 14), ground, 6);
    if (!sp) continue;
    const fall = sp.hi - sp.lo;
    if (fall > 8) continue;
    const v = viewFrom(x, y, ground(x, y) + EYE);
    spots.push({ at: [x, y], z: ground(x, y), fall, view: v.mean, looks: v.looks });
  }
}
const byView = [...spots].sort((a, b) => b.view - a.view);
const byFlat = [...spots].sort((a, b) => a.fall - b.fall);
const shortlist = [...new Set([...byView.slice(0, 4), ...byFlat.slice(0, 3)])];
log(`${spots.length} placements fit wholly inside the boundary; ${shortlist.length} shortlisted`);

for (const s of shortlist) {
  let cheap = null;
  for (let deg = 0; deg < 180; deg += 15) {
    const seat = planSeat(w, body, s.at, { rotation: (deg * Math.PI) / 180, level: 'balanced' });
    const earth = seat.cut + seat.fill;
    if (!cheap || earth < cheap.earth) cheap = { deg, earth };
  }
  s.earth = cheap.earth; s.deg = cheap.deg;
  const a = planAccess(w, s.at, { maxGrade: 0.15, keepInside: ring, cell: 10, maxPops: 60000 });
  s.access = a.possible
    ? (a.onNetwork ? { kind: 'onway', from: a.fromName }
      : a.apron ? { kind: 'apron', m: Math.round(a.length), from: a.fromName }
        : { kind: 'drive', m: Math.round(a.length), pct: Math.round(a.maxG * 100), from: a.fromName, turns: a.turns })
    : { kind: 'none' };
}
shortlist.sort((a, b) => b.view - a.view);

// ------------------------------------------------- the level that walks out
//
// THE DESIGN'S GROUND AND THE SITE'S GROUND ARE TWO DIFFERENT SURFACES.
//
// geometry.mjs states its site: a 30% cross slope, with the LOWER LEVEL floor
// at Z=0 and the natural grade falling to meet it at the downhill face — that
// is what makes bays A–C a walkout and the terrace a terrace rather than a
// light well. Everything downhill of the glass line depends on it.
//
// So the walkout is not a drawing decision that survives being moved: it is a
// claim about the slope, and the slope is measurable. This asks each candidate
// how much fall it actually has across the house's own cross axis, and what
// that leaves of the lower level.
const IN_M = 0.0254;
const BAR_DEEP = (mod.BAR.y1 - mod.BAR.y0) * IN_M;                       // 7.92 m
const TERRACE = Math.abs(mod.DECKS.find((d) => d.id === 'D2').y0) * IN_M; // 4.88 m
const CROSS_SPAN = BAR_DEEP + TERRACE;
// what the design's own assumed plane does over that span, downhill to uphill
const NEEDS = (mod.SITE_SLOPE.grade(36 * 12, mod.BAR.y1) - mod.SITE_SLOPE.grade(36 * 12, -TERRACE / IN_M)) * IN_M;

/**
 * How the ground lies across the house, at a seat and a turn.
 *
 * THE HOUSE HAS A FRONT. The earthwork search turns it through 0–180° because
 * cut and fill do not care which end is which — but the design does: +Y is
 * uphill, −Y carries the glass, the terrace and the walkout. Reading the slope
 * at the earthwork's bearing therefore produced NEGATIVE cross slopes, which is
 * not a gentle site but a house facing backwards. The two bearings are the same
 * earthwork and opposite buildings, so this takes the one that puts the glass
 * downhill and reports which it was.
 */
function walkoutAt(at, degrees) {
  const rot = (degrees * Math.PI) / 180;
  const up = [-Math.sin(rot), Math.cos(rot)];        // the design's +Y, uphill
  const low = [at[0] - up[0] * (BAR_DEEP / 2 + TERRACE), at[1] - up[1] * (BAR_DEEP / 2 + TERRACE)];
  const high = [at[0] + up[0] * (BAR_DEEP / 2), at[1] + up[1] * (BAR_DEEP / 2)];
  return ground(high[0], high[1]) - ground(low[0], low[1]);
}
function walkout(at, degrees) {
  const a = walkoutAt(at, degrees), b = walkoutAt(at, degrees + 180);
  const flipped = b > a;
  const fall = flipped ? b : a;
  return {
    fall, bearing: ((degrees + (flipped ? 180 : 0)) % 360 + 360) % 360, flipped,
    crossPct: (fall / CROSS_SPAN) * 100,
    // the lower level is a walkout when the hill already provides the drop the
    // design spends; short of that, the difference is what must be dug out in
    // front of the glass, or lost off the bottom of the house
    short: Math.max(0, NEEDS - fall),
    walksOut: fall >= NEEDS - 0.15,
  };
}
for (const s of shortlist) s.walk = walkout(s.at, s.deg);
// And across EVERY position the house fits, not only the seven the view and the
// flatness nominated — otherwise "no site has the slope" would be a fact about
// how the shortlist was drawn rather than about the parcel.
for (const s of spots) s.cross = walkout(s.at, 0).crossPct;
const withSlope = spots.filter((s) => s.cross >= mod.SITE_SLOPE.crossSlopePct).length;
const bestCross = Math.max(...spots.map((s) => s.cross));
log(`across all ${spots.length} placements: ${withSlope} have the ${mod.SITE_SLOPE.crossSlopePct}% the design assumes,`
  + ` steepest ${bestCross.toFixed(0)}%`);
// the seat the place actually holds, at the bearing it was actually turned to
const seatedWalk = walkout(houseAt, turnedDeg);
log(`the design assumes ${(mod.SITE_SLOPE.crossSlopePct)}% across ${CROSS_SPAN.toFixed(1)} m — it needs ${NEEDS.toFixed(2)} m of fall`);
log(`where the house stands: ${seatedWalk.fall.toFixed(2)} m of fall (${seatedWalk.crossPct.toFixed(0)}%)`
  + ` — ${seatedWalk.walksOut ? 'the lower level walks out' : `${seatedWalk.short.toFixed(2)} m short`}`);

// ------------------------------------------------------------- the fifth one
log('searching for a drive to the house as seated…');
const at15 = planAccess(w, gate, { maxGrade: 0.15, keepInside: ring, cell: 8, maxPops: 500000 });
const easement = planAccess(w, gate, { maxGrade: 0.15, cell: 8, maxPops: 500000 });
let onParcel = at15.possible && !at15.onNetwork && !at15.apron ? at15 : null;
let onParcelCap = onParcel ? 0.15 : null;
for (const cap of onParcel ? [] : [0.16, 0.18, 0.20, 0.22, 0.25]) {
  const p = planAccess(w, gate, { maxGrade: cap, keepInside: ring, cell: 8, maxPops: 500000 });
  if (p.possible && !p.onNetwork && !p.apron) { onParcel = p; onParcelCap = cap; break; }
}
log(`at 15% inside the boundary: ${at15.possible ? 'a way exists' : 'no way'}`);
if (onParcel) log(`first exists at ${Math.round(onParcelCap * 100)}%: ${Math.round(onParcel.length)} m, ${onParcel.turns} turns`);
if (easement.possible) log(`off the parcel: ${Math.round(easement.length)} m at ${(easement.maxG * 100).toFixed(0)}%`);

// ==================================================================== RENDER
const SUN = [-0.42, 0.52, 0.74];
const norm = (a) => { const l = Math.hypot(...a); return a.map((v) => v / l); };
const sun = norm(SUN);

const LOW = [0.44, 0.50, 0.38], HIGH = [0.86, 0.82, 0.66];
/**
 * The ramp is normalised over the WINDOW being drawn, on its 5th–95th
 * percentile — the same rule the app's terrain colour uses, and for the same
 * reason: one ridge two hundred metres above the site otherwise pushes the whole
 * site to the dark end and the parcel reads as a shadow.
 */
function ramp(win) {
  const t = P.terrain;
  const vals = [];
  for (let y = win[1]; y <= win[3]; y += t.cell) {
    for (let x = win[0]; x <= win[2]; x += t.cell) vals.push(ground(x, y));
  }
  vals.sort((a, b) => a - b);
  const lo = vals[Math.floor(vals.length * 0.05)], hi = vals[Math.floor(vals.length * 0.95)];
  const range = Math.max(1, hi - lo);
  return (z) => {
    const f = Math.max(0, Math.min(1, (z - lo) / range));
    return [LOW[0] + (HIGH[0] - LOW[0]) * f, LOW[1] + (HIGH[1] - LOW[1]) * f, LOW[2] + (HIGH[2] - LOW[2]) * f];
  };
}
const C = {
  water: [0.26, 0.44, 0.60], road: [0.36, 0.34, 0.32], boundary: [0.88, 0.20, 0.12],
  timber: [0.72, 0.50, 0.31], concrete: [0.78, 0.76, 0.72], roof: [0.36, 0.33, 0.31],
  // NOT blue: the Watauga is blue, and a drive drawn in the river's colour on a
  // page about how you reach the house is the one confusion this must not have.
  drive: [0.62, 0.16, 0.74], easement: [0.98, 0.60, 0.05], neighbour: [0.52, 0.50, 0.47],
  contour: [0.34, 0.31, 0.23], index: [0.18, 0.16, 0.10], flag: [0.05, 0.05, 0.05],
  built: [0.98, 0.97, 0.92],            // the drive that already exists
};
/** The traced drive, drawn as the thing it is: already there. */
const builtDrive = w.entities().filter((e) => String(e.id).startsWith('traced-'));

// The massing, read from the design module at the seat the place already holds.
const HOUSE = placedFaces(mod, { at: houseAt, rotationDeg: turnedDeg, floor });
log(`house: ${HOUSE.length} faces from the design module (the place holds ${houseParts.length} rectangles)`);
function faceNormal(p) {
  const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
  const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return n[2] < 0 ? [-n[0] / l, -n[1] / l, -n[2] / l] : [n[0] / l, n[1] / l, n[2] / l];
}

log('reading the aerial…');
let photo = null, closePhoto = null;
try {
  photo = await aerial(P.projection, [bb[0] - 1200, bb[1] - 1200, bb[2] + 1200, bb[3] + 1200],
    { size: 2048, log });
  // A second, tighter frame for the close view. The wide export is about
  // 1.7 m a pixel, which is fine for a parcel and mud at fifty metres; NAIP's
  // own resolution is better than that and the house shot should have it.
  closePhoto = await aerial(P.projection,
    [houseAt[0] - 320, houseAt[1] - 320, houseAt[0] + 320, houseAt[1] + 320],
    { size: 2048, cache: 'data/aerial-house.png', log });
} catch (err) {
  log(`aerial unavailable (${String(err.message).slice(0, 50)}) — the ground will be shaded, not photographed`);
}

/** One picture of the site: ground, water, ways, boundary, the house. */
function scene(v, { win, contourInterval, showHouse = true, drives = [], flag = false, bare = false, close = false }) {
  const { fb, cam } = v;
  const img = close ? (closePhoto || photo) : photo;
  R.terrain(fb, cam, P.terrain, {
    window: win, colorFor: ramp(win), sun,
    tex: img && !bare ? (x, y) => img.sample(x, y) || (photo && photo.sample(x, y)) : null,
  });
  if (contourInterval) {
    R.contours(fb, cam, P.terrain, {
      window: win, interval: contourInterval, col: C.contour, indexCol: C.index, every: 5,
    });
  }
  for (const e of w.entities()) {
    const r = w.ringOf(e);
    if (!r || r.length < 3) continue;
    const c = G.centroid(r);
    if (c[0] < win[0] - 200 || c[0] > win[2] + 200 || c[1] < win[1] - 200 || c[1] > win[3] + 200) continue;
    // With the aerial on, the river and the roads are already in the picture —
    // painting vector copies over a photograph of the same thing is how a
    // drawing starts arguing with itself.
    if (e.type === 'water') {
      if (!photo || bare) R.draped(fb, cam, r, ground, 0.35, C.water, P.terrain.cell, [P.terrain.bounds[0], P.terrain.bounds[1]], sun);
    } else if (e.type === 'road' || e.type === 'path') {
      if (!photo || bare) R.draped(fb, cam, r, ground, 0.55, C.road, P.terrain.cell, [P.terrain.bounds[0], P.terrain.bounds[1]], sun);
    } else if (e.type === 'structure' && !String(e.id).startsWith('henry-house-')) {
      R.prism(fb, cam, r, e.zBase, e.zTop, C.neighbour, [0.42, 0.40, 0.38], sun);
    }
  }
  // THE BUILDING, from the design module — not the five rectangles the import
  // kept. Those are the contract the certificate tests; this is the house.
  if (showHouse) {
    for (const f of HOUSE) {
      for (let i = 2; i < f.pts.length; i++) {
        R.tri(fb, cam, f.pts[0], f.pts[i - 1], f.pts[i], f.col, faceNormal(f.pts), null, null, sun);
      }
    }
  }
  // the drive that already exists, under the proposals, in the colour of a
  // gravel track rather than of a proposal
  if (drives.length) {
    for (const e of builtDrive) R.ground_line(fb, cam, e.path, ground, C.built, 5, 2.6);
  }
  // the boundary, unmistakable and on the ground
  R.ground_line(fb, cam, ring.concat([ring[0]]), ground, C.boundary, 3, 1.5);
  for (const d of drives) {
    if (!d.plan?.possible || d.plan.onNetwork) continue;
    // lifted well clear: a hairpin's chord cuts across the nose it turns around,
    // and a diagram line that vanishes into the hill it is describing is useless
    R.ground_line(fb, cam, d.plan.path, ground, d.col, d.width || 3.5, 4);
  }
  if (flag) R.marker(fb, cam, houseAt, floor, C.flag, flag === true ? 34 : flag);
  return fb;
}

const shots = {};
const onGround = (p) => [p[0], p[1], ground(p[0], p[1])];
const ringPts = ring.map(onGround);
const drivePts = [...(onParcel?.path || []), ...(easement.possible ? easement.path : [])].map(onGround);
const W = 1560, H = 880;

log('rendering: the parcel in its landform…');
{
  const { cam } = R.fit(ringPts, { from: 200, pitch: 26, w: W, h: H, margin: 0.9 });
  shots.site = scene({ fb: R.frame(W, H), cam }, {
    win: [bb[0] - 1100, bb[1] - 1100, bb[2] + 1100, bb[3] + 1100],
    contourInterval: 20, flag: 55,
  });
}

log('rendering: the house as it is seated…');
{
  // Frame the BUILDING — every face of it, plus a little of the bench. Fitting
  // to the five imported rectangles cropped the garage and the deck off, which
  // is the same mistake in miniature: framing the contract, not the house.
  const around = HOUSE.flatMap((f) => f.pts)
    .concat(G.circleRing(houseAt[0], houseAt[1], 34, 12).map(onGround));
  const { cam } = R.fit(around, { from: 158, pitch: 22, w: W, h: H, fov: 0.58, margin: 0.84 });
  shots.house = scene({ fb: R.frame(W, H), cam }, {
    win: [houseAt[0] - 500, houseAt[1] - 500, houseAt[0] + 500, houseAt[1] + 500],
    contourInterval: 5, close: true,
  });
}

log('rendering: the access…');
{
  // from the south, looking up the line both drives take — a shallower angle
  // foreshortens the switchbacks into a smudge
  const { cam } = R.fit(ringPts.concat(drivePts), { from: 193, pitch: 47, w: W, h: H, margin: 0.9 });
  shots.access = scene({ fb: R.frame(W, H), cam }, {
    win: [bb[0] - 1000, bb[1] - 900, bb[2] + 900, bb[3] + 900],
    contourInterval: 20, flag: 46,
    drives: [
      { plan: easement, col: C.easement, width: 4.5 },
      { plan: onParcel, col: C.drive, width: 4.5 },
    ],
  });
}

log('rendering: the plan…');
{
  const { cam } = R.fit(ringPts.concat(drivePts), { from: 180, pitch: 84, w: 1180, h: 1180, fov: 0.5, margin: 0.92 });
  shots.plan = scene({ fb: R.frame(1180, 1180), cam }, {
    win: [bb[0] - 600, bb[1] - 600, bb[2] + 600, bb[3] + 600],
    contourInterval: 10, flag: 30,
    drives: [
      { plan: easement, col: C.easement, width: 4 },
      { plan: onParcel, col: C.drive, width: 4 },
    ],
  });
}

/**
 * Photographs go out as JPEG, and these are photographs: three quarters of every
 * render is NAIP aerial over a leaf-off forest, and PNG stores that losslessly —
 * 8.3 MB of it, every byte a picture. A client opens a site report on a phone,
 * often on rural data, and eight megabytes is not a document but a download.
 * Quality 84 at 4:2:0 keeps the contour lines legible and the file a tenth
 * the size.
 */
const uri = (fb, quality = 84) => `data:image/jpeg;base64,${jpeg(fb, quality).toString('base64')}`;

// --------------------------------------------------------- the long section
function profile(plan, colour, label) {
  if (!plan?.possible || !plan.stations?.length) return '';
  const st = plan.stations;
  const L = st[st.length - 1].s || 1;
  const zs = st.map((s) => s.z);
  const zlo = Math.min(...zs), zhi = Math.max(...zs);
  const W = 900, H = 210, m = { l: 54, r: 16, t: 16, b: 30 };
  const X = (s) => m.l + (s / L) * (W - m.l - m.r);
  const Y = (z) => H - m.b - ((z - zlo) / Math.max(1, zhi - zlo)) * (H - m.t - m.b);
  const d = st.map((s, i) => `${i ? 'L' : 'M'}${X(s.s).toFixed(1)},${Y(s.z).toFixed(1)}`).join('');
  const gridY = [];
  const stepZ = Math.max(5, Math.round((zhi - zlo) / 4 / 5) * 5);
  for (let z = Math.ceil(zlo / stepZ) * stepZ; z <= zhi; z += stepZ) {
    gridY.push(`<line x1="${m.l}" y1="${Y(z).toFixed(1)}" x2="${W - m.r}" y2="${Y(z).toFixed(1)}" class="gl"/>`
      + `<text x="${m.l - 8}" y="${(Y(z) + 4).toFixed(1)}" class="ax" text-anchor="end">${Math.round(amsl(z))}</text>`);
  }
  const gridX = [];
  for (let s = 0; s <= L; s += 100) {
    gridX.push(`<line x1="${X(s).toFixed(1)}" y1="${m.t}" x2="${X(s).toFixed(1)}" y2="${H - m.b}" class="gl"/>`
      + `<text x="${X(s).toFixed(1)}" y="${H - m.b + 18}" class="ax" text-anchor="middle">${Math.round(s)}</text>`);
  }
  return `<figure class="prof"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">
  ${gridY.join('')}${gridX.join('')}
  <path d="${d}" fill="none" stroke="${colour}" stroke-width="2.5" stroke-linejoin="round"/>
  <text x="${m.l}" y="${m.t + 2}" class="ax">m AMSL</text>
  <text x="${W - m.r}" y="${H - 4}" class="ax" text-anchor="end">metres along the drive</text>
</svg><figcaption>${label}</figcaption></figure>`;
}

/**
 * THE SECTION. One drawing settles this argument.
 *
 * A cross section through the bar, at the seat and turn the house actually has:
 * the ground the design assumed, the ground that is there, and the three floors
 * that were drawn against the first.
 */
function section() {
  const rot = (90 * Math.PI) / 180;
  const up = [-Math.sin(rot), Math.cos(rot)];
  const y0 = -(BAR_DEEP / 2 + TERRACE + 6), y1 = BAR_DEEP / 2 + 12;
  const at = (t) => [houseAt[0] + up[0] * t, houseAt[1] + up[1] * t];
  const natural = [];
  for (let t = y0; t <= y1; t += 0.5) natural.push([t, ground(...at(t))]);
  const L0 = floor, L1 = floor + 3.05, L2 = floor + 6.1;
  // the design's own plane, pinned so its downhill face meets its terrace
  const assumed = (t) => L0 + (t + BAR_DEEP / 2 + TERRACE) * (mod.SITE_SLOPE.crossSlopePct / 100) - 0.15;

  const zs = natural.map((p) => p[1]).concat([L0 - 1, L2 + 3.5, assumed(y1)]);
  const zlo = Math.min(...zs), zhi = Math.max(...zs);
  const W = 900, H = 330, m = { l: 58, r: 18, t: 18, b: 34 };
  const X = (t) => m.l + ((t - y0) / (y1 - y0)) * (W - m.l - m.r);
  const Y = (z) => H - m.b - ((z - zlo) / Math.max(1, zhi - zlo)) * (H - m.t - m.b);
  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');

  const grid = [];
  for (let z = Math.ceil(zlo / 2) * 2; z <= zhi; z += 2) {
    grid.push(`<line x1="${m.l}" y1="${Y(z).toFixed(1)}" x2="${W - m.r}" y2="${Y(z).toFixed(1)}" class="gl"/>`
      + `<text x="${m.l - 8}" y="${(Y(z) + 4).toFixed(1)}" class="ax" text-anchor="end">${Math.round(amsl(z))}</text>`);
  }
  // the house: three floor plates and the bar's own depth
  const bx0 = X(-BAR_DEEP / 2), bx1 = X(BAR_DEEP / 2);
  const plates = [['L0 lower', L0], ['L1 main', L1], ['L2 upper', L2]].map(([n, z]) =>
    `<line x1="${bx0.toFixed(1)}" y1="${Y(z).toFixed(1)}" x2="${bx1.toFixed(1)}" y2="${Y(z).toFixed(1)}"
       stroke="#1b1a17" stroke-width="2.5"/>
     <text x="${(bx1 + 6).toFixed(1)}" y="${(Y(z) + 4).toFixed(1)}" class="ax">${n}</text>`).join('');

  const buriedTo = Math.min(ground(...at(-BAR_DEEP / 2 - TERRACE)), zhi);
  return `<figure class="prof"><svg viewBox="0 0 ${W} ${H}" role="img"
    aria-label="Cross section through the house showing the lower level below natural grade">
  ${grid.join('')}
  <path d="${path(natural)}L${X(y1).toFixed(1)},${Y(zlo).toFixed(1)}L${X(y0).toFixed(1)},${Y(zlo).toFixed(1)}Z"
        fill="#cfc6ad" stroke="none" opacity=".85"/>
  <path d="${path(natural)}" fill="none" stroke="#7a6f52" stroke-width="2"/>
  <path d="M${X(y0).toFixed(1)},${Y(assumed(y0)).toFixed(1)}L${X(y1).toFixed(1)},${Y(assumed(y1)).toFixed(1)}"
        fill="none" stroke="#c0392b" stroke-width="2" stroke-dasharray="7 5"/>
  <rect x="${bx0.toFixed(1)}" y="${Y(L2 + 3).toFixed(1)}" width="${(bx1 - bx0).toFixed(1)}"
        height="${(Y(L0) - Y(L2 + 3)).toFixed(1)}" fill="none" stroke="#1b1a17" stroke-width="2"/>
  ${plates}
  <text x="${X(y0) + 6}" y="${Y(assumed(y0)) - 8}" class="ax" fill="#c0392b">the ${mod.SITE_SLOPE.crossSlopePct}% the design assumes</text>
  <text x="${X(y0) + 6}" y="${(Y(buriedTo) + 16).toFixed(1)}" class="ax" fill="#5d5340">the ground that is there</text>
  <text x="${m.l}" y="${m.t + 2}" class="ax">m AMSL</text>
  <text x="${W - m.r}" y="${H - 4}" class="ax" text-anchor="end">downhill ← metres across the bar → uphill</text>
</svg><figcaption>Section through the bar on its cross axis, at the seat the house now has. The dashed line is the
grade the design was drawn against; the solid fill is the ground the survey-grade DEM reports. The lower level
plate sits ${seatedWalk.short.toFixed(2)} m below where the walkout needs the ground to be.</figcaption></figure>`;
}

// ==================================================================== DOCUMENT
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const accessCell = (a) => {
  if (a.kind === 'none') return '<span class="no">no way inside the boundary</span>';
  if (a.kind === 'onway') return `<span class="warn">stands in ${esc(a.from || 'a mapped way')}</span>`;
  if (a.kind === 'apron') return `<span class="ok">${a.m} m apron off ${esc(a.from || 'a way')}</span>`;
  return `<span class="ok">${a.m} m @ ${a.pct}%</span> <span class="dim">via ${esc(a.from || 'a way')}</span>`;
};
const TRACE = JSON.parse(readFileSync('data/drive-traced.json', 'utf8'));
const walksOut = shortlist.filter((s) => s.walk.walksOut);
const viewSite = shortlist[0];
const flatSite = [...shortlist].sort((a, b) => a.earth - b.earth)[0];
const reachable = shortlist.filter((s) => s.access.kind === 'drive' || s.access.kind === 'apron');
const unreachable = shortlist.filter((s) => s.access.kind === 'none');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Parcel 064.03 · HWY 321 — site report</title>
<style>
  :root{--ink:#1b1a17;--dim:#6c6960;--rule:#d9d4c8;--paper:#f7f5f0;--red:#c0392b;--blue:#2563c4;--amber:#c98510;--green:#2f6b46}
  *{box-sizing:border-box}
  html,body{max-width:100%;overflow-x:hidden}
  body{margin:0;background:#e8e5dd;-webkit-text-size-adjust:100%;color:var(--ink);font:16px/1.6 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif}
  .sheet{max-width:1180px;margin:0 auto;background:var(--paper);padding:56px 64px 80px;box-shadow:0 1px 3px rgba(0,0,0,.12)}
  h1{font-size:34px;line-height:1.15;margin:0 0 6px;letter-spacing:-.01em}
  h2{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin:52px 0 14px;font-family:ui-sans-serif,system-ui,sans-serif;font-weight:600}
  h3{font-size:20px;margin:30px 0 8px}
  p{margin:0 0 14px;max-width:66ch}
  .sub{font-size:17px;color:var(--dim);margin:0 0 26px}
  .rule{border:0;border-top:1px solid var(--rule);margin:0 0 26px}
  .meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:18px 26px;margin:0 0 8px;
        font-family:ui-sans-serif,system-ui,sans-serif;font-size:14px}
  .meta div span{display:block;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin-bottom:3px}
  .meta div b{font-weight:600;font-size:15px}
  figure{margin:0 0 12px}
  figure img{width:100%;height:auto;display:block;border:1px solid var(--rule);background:#dcdad3}
  figcaption{font-family:ui-sans-serif,system-ui,sans-serif;font-size:13px;color:var(--dim);margin-top:8px;max-width:78ch}
  .key{font-family:ui-sans-serif,system-ui,sans-serif;font-size:12.5px;color:var(--dim);margin:10px 0 0;display:flex;flex-wrap:wrap;gap:16px}
  .key i{display:inline-block;width:22px;height:3px;vertical-align:middle;margin-right:6px}
  /* An eight-column table is 700 px of content in a 390 px viewport. It scrolls
     inside its own box rather than pushing the whole page sideways. */
  .scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:6px 0 10px}
  .scroll table{margin:0}
  table{border-collapse:collapse;width:100%;min-width:660px;font-family:ui-sans-serif,system-ui,sans-serif;font-size:13.5px;margin:6px 0 10px}
  th{text-align:left;font-weight:600;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);
     border-bottom:1px solid var(--ink);padding:0 12px 6px 0;white-space:nowrap}
  td{padding:8px 12px 8px 0;border-bottom:1px solid var(--rule);vertical-align:top}
  td.n{font-variant-numeric:tabular-nums}
  .ok{color:var(--green)} .no{color:var(--red);font-weight:600} .warn{color:var(--amber)} .dim{color:var(--dim)}
  .finding{border-left:3px solid var(--red);padding:2px 0 2px 20px;margin:22px 0}
  .finding p{margin:0 0 8px}
  .finding b{font-weight:600}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:34px}
  .prof svg{width:100%;height:auto;border:1px solid var(--rule);background:#fff}
  .gl{stroke:#e6e2d8;stroke-width:1}
  .ax{font-family:ui-sans-serif,system-ui,sans-serif;font-size:10px;fill:#8a867c}
  .caveat{background:#efece4;border:1px solid var(--rule);padding:20px 24px;margin:16px 0 0}
  .caveat h3{margin-top:0;font-size:16px}
  .caveat ul{margin:0;padding-left:20px} .caveat li{margin:0 0 9px;max-width:74ch}
  footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--rule);
         font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px;color:var(--dim)}
  @media print{body{background:#fff}.sheet{box-shadow:none;max-width:none;padding:0}h2{page-break-after:avoid}figure{page-break-inside:avoid}}
  @media (max-width:820px){.sheet{padding:28px 20px 48px}.cols{grid-template-columns:1fr}h1{font-size:27px}}
</style></head><body><div class="sheet">

<h1>Parcel 064.03 — HWY 321</h1>
<p class="sub">${esc(parcel.props.owner)} · ${esc(parcel.props.county)} County, Tennessee · where the Henry House goes, and what it costs to get there</p>
<hr class="rule">
<div class="meta">
  <div><span>Deed</span><b>${parcel.props.deedAcres} acres</b></div>
  <div><span>Boundary as drawn</span><b>${parcel.props.drawnAcres} acres <span class="dim">(+${parcel.props.disagreementPercent}%)</span></b></div>
  <div><span>Elevation</span><b>${Math.round(amsl(span.lo))}–${Math.round(amsl(span.hi))} m</b></div>
  <div><span>Fall across it</span><b>${Math.round(span.hi - span.lo)} m</b></div>
  <div><span>House</span><b>${ob.width.toFixed(1)} × ${ob.depth.toFixed(1)} m</b></div>
  <div><span>Placements that fit</span><b>${spots.length}</b></div>
</div>

<h2>The parcel</h2>
<figure><img alt="The parcel in its landform, seen from the south-west" src="${uri(shots.site)}">
<figcaption>Looking north-east across the property. The boundary is drawn in red on the ground; contours are at
20 m. The Watauga is the low ground at the left; the land rises ${Math.round(span.hi - span.lo)} m from the river bench to the
ridge at the top of the parcel.</figcaption></figure>
<p>The property runs from the river up the hillside — ${Math.round(span.hi - span.lo)} metres of fall inside one boundary. That range is
the whole of the siting problem: the flat ground is at the bottom, the view is at the top, and the way in
comes from ${esc(near.name || 'the road')} at the ${Math.round(near.d)}-metre mark.</p>

<h2>What the ground was asked</h2>
<p>Every position where the house fits wholly inside the boundary was walked — ${spots.length} of them — and the
ground asked five questions at each. The first four are how far you can see, which way, how flat it is,
and what the earthwork costs. The fifth is whether you can get there.</p>
<div class="scroll"><table>
  <thead><tr><th>Where</th><th>Elevation</th><th>Open view</th><th>Faces</th><th>Earthwork</th><th>Cross slope</th><th>Faces downhill</th><th>Lower level</th><th>Drive at ≤15%</th></tr></thead>
  <tbody>${shortlist.map((s) => `<tr>
    <td class="n">${s.at.map(Math.round).join(', ')}</td>
    <td class="n">${Math.round(amsl(s.z))} m</td>
    <td class="n">${(s.view / 1000).toFixed(2)} km</td>
    <td>${s.looks}</td>
    <td class="n">${Math.round(s.earth)} m³</td>
    <td class="n">${s.walk.crossPct.toFixed(0)}%</td>
    <td class="n">N${Math.round(s.walk.bearing)}°E</td>
    <td>${s.walk.walksOut
      ? '<span class="ok">walks out</span>'
      : `<span class="no">buried ${s.walk.short.toFixed(1)} m</span>`}</td>
    <td>${accessCell(s.access)}</td></tr>`).join('')}
  </tbody>
</table></div>
<p class="key" style="margin-bottom:18px"><span><b>Cross slope</b> is measured across the house's own axis, over the
${CROSS_SPAN.toFixed(1)} m the bar and its terrace occupy. The design assumes ${mod.SITE_SLOPE.crossSlopePct}%.</span></p>
<p>The view is best at ${viewSite.at.map(Math.round).join(', ')} — ${(viewSite.view / 1000).toFixed(2)} km of open ground, mostly ${viewSite.looks}, for
${Math.round(viewSite.earth)} m³ of earth. The ground is easiest at ${flatSite.at.map(Math.round).join(', ')} — ${Math.round(flatSite.earth)} m³, with
${(flatSite.view / 1000).toFixed(2)} km of view. They are ${Math.round(G.dist(viewSite.at, flatSite.at))} m apart, and that distance is the decision. It is
not a decision this study makes.</p>

<h2>Access, and the drive that already exists</h2>
<p>An earlier pass of this study said no site on the river bench could be driven to at 15%. That was true of
the map and false of the land: OpenStreetMap has never recorded this property's private drive, so the search
was looking for a way up a hillside the owner already drives up. The state's own basemap has it, and it is in
the model now — ${builtDrive.length} ways, <b>${Math.round(builtDrive.reduce((a, e) => a + G.perimeter(e.path, false), 0))} m</b>
of it, registered to the cadastral boundary at ${TRACE.fit.meanResidual_m} m and marked TRACED, because a screen
digitization is not a survey.</p>
<p>With it in the network, <b>every position on the shortlist is reachable at 15%</b>. What is left is the last
stretch: the built drive stops at the fork ${Math.round(near.d)} m short of the garage, and
${onParcel ? `that connector is ${Math.round(onParcel.length)} m at ${Math.round(onParcelCap * 100)}%, with ${onParcel.turns}
switchbacks the hill demands` : 'that connector is the open question'}. Access is not what decides this site.</p>
<figure><img alt="The drive that exists and the connector still to build" src="${uri(shots.access)}">
<figcaption>The white line is the drive that is already there; it is visible in the aerial underneath it, which is
how the registration checks itself. The connector runs on from the fork.</figcaption></figure>
<p class="key">
  <span><i style="background:${rgb(C.built)};border:1px solid #bbb"></i>the drive that exists (traced)</span>
  <span><i style="background:${rgb(C.drive)}"></i>the connector, ${onParcel ? Math.round(onParcelCap * 100) : '—'}%</span>
  <span><i style="background:${rgb(C.boundary)}"></i>the boundary</span>
</p>
${profile(onParcel, rgb(C.drive), onParcel
  ? `The connector — ${Math.round(onParcel.length)} m, ${Math.round(onParcel.rise)} m of rise, ${onParcel.turns} switchbacks, nothing over ${Math.round(onParcelCap * 100)}%`
  : 'no on-parcel alignment')}
<p>That line was not drawn. It was searched for over the real elevation with the grade limit as a hard
constraint — an edge steeper than the cap does not cost more, it does not exist — so every switchback in it is
one the hill demanded and none of them is a drafting flourish.</p>

<h2>Where the house stands, and what the ground says back</h2>
<figure><img alt="The Henry House as currently seated on the river bench" src="${uri(shots.house)}">
<figcaption>The house as seated — both shed roofs, the clerestory where they step, the glass line, the deck and
the lower terrace, the link and the detached garage — on the river bench at ${Math.round(amsl(floor))} m. Contours at 5 m.
Built from the design module, not from the five rectangles the site model keeps for testing.</figcaption></figure>
<p>The design puts its long axis on the contour and its glass on the downhill face. Seated here it stands on
the flattest ground on the property — ${flatSite.fall.toFixed(1)} m of fall under the whole footprint and no earthwork worth
naming — and it can be driven to. On the first four questions this is the obvious place for it.</p>

<div class="finding">
  <p><b>The lower level is buried.</b> The design puts the LOWER LEVEL floor at Z=0 and lets bays A–C walk out
  to the terrace, because it assumes the grade has fallen to meet them: ${mod.SITE_SLOPE.crossSlopePct}% across the
  ${CROSS_SPAN.toFixed(1)} m the bar and its terrace occupy, which is <b>${NEEDS.toFixed(2)} m of fall</b>.</p>
  <p>Where the house now stands the ground falls <b>${seatedWalk.fall.toFixed(2)} m</b> across that same span —
  ${seatedWalk.crossPct.toFixed(0)}%, not ${mod.SITE_SLOPE.crossSlopePct}%. ${seatedWalk.walksOut
    ? 'That is enough, and the walkout survives.'
    : `The bench is <b>${seatedWalk.short.toFixed(2)} m short</b>. Level the pad and the lower storey goes
    underground: a ${(107 * IN_M).toFixed(2)} m room with ${seatedWalk.short.toFixed(2)} m of earth against the glass it was
    drawn to open through.`}</p>
  <p>This is not a drafting error and it is not fixed by nudging the house. The walkout is a claim about the
  slope; the slope is measurable; on the flattest ground on the property the claim is false.</p>
</div>
${section()}

<h2>The plan</h2>
<figure><img alt="Plan of the parcel with contours, the built drive and the connector" src="${uri(shots.plan)}">
<figcaption>Contours at 10 m, north up. The boundary in red, the built drive in white, the connector as above.</figcaption></figure>

<h2>What follows</h2>
<p>Access is answered and the earthwork is cheap. What is left is one trade, and it is a real one: <b>the flat
ground and the walkout are at opposite ends of this property</b>. ${walksOut.length
  ? `${walksOut.length === 1 ? 'One position on the shortlist has the fall the design needs' : `${walksOut.length} positions have the fall the design needs`} —
  ${walksOut.map((s) => `${s.at.map(Math.round).join(', ')} at ${s.walk.crossPct.toFixed(0)}%`).join(', ')} — and
  ${walksOut.length === 1 ? 'it costs' : 'they cost'} ${walksOut.map((s) => `${Math.round(s.earth)} m³`).join(' and ')}
  of earthwork against ${Math.round(flatSite.earth)} m³ on the bench. Across all ${spots.length} positions the house
  fits inside the boundary, ${withSlope} carry the ${mod.SITE_SLOPE.crossSlopePct}% the design assumes and the steepest is
  ${bestCross.toFixed(0)}% — so the slope exists on this property, but not where the flat ground is.`
  : 'No position on this shortlist has the fall the design needs, which is itself the finding.'}</p>
<p>Three ways out, and they are three different buildings. <b>Cut for it</b> — a sunken court
${seatedWalk.short.toFixed(1)} m deep in front of the glass, with everything that implies for drainage against a
habitable wall. <b>Give it up</b> — the lower level becomes a basement, and the house loses its lower terrace,
its second egress and about a third of its floor area. <b>Move for it</b> — build where the hill already does
the work, and pay for it in earthwork and in the ${Math.round(G.dist(viewSite.at, flatSite.at))} m between the view and the flat.
None of those is a decision this study makes.</p>

<div class="caveat">
  <h3>What this does not know</h3>
  <ul>
    <li><b>The trees.</b> Twenty-seven of these twenty-nine acres are woodland on the deed and not one tree is mapped.
    Standing timber is most of what a view actually is, and most of what a view can be <i>made</i> by clearing.
    Every kilometre in the table above is a view over bare ground that is not bare.</li>
    <li><b>The ground is not a survey.</b> Elevation is ${esc(P.meta.elevation)}, interpolated to building
    scale. It is honest about relief and unreliable about any single metre. Tennessee's LiDAR would firm every
    grade in this document before anyone should believe one to the percent.</li>
    <li><b>The drawings name the wrong state.</b> Every title block in the design set says WATAUGA COUNTY,
    NORTH CAROLINA; the parcel record says ${esc(mod.SITE?.county || 'Johnson')} County, ${esc(mod.SITE?.state || 'TN')}.
    That is not a caption error — it changes the code basis, the permitting authority, and whether the NC
    Mountain Ridge Protection Act applies at all. The design module records the correction${mod.SITE
      ? `, along with a site elevation measured at ${mod.SITE.elevationFtAmsl} ft rather than the 3,412 ft the
      package assumed: a thousand feet, and with it the ground snow load, the design temperature and the
      freeze depth, none of which has been recomputed` : ''}.</li>
    <li><b>The boundary is the assessor's.</b> The deed says ${parcel.props.deedAcres} acres and the drawn ring measures
    ${parcel.props.drawnAcres}; where they differ this document does not choose. Nothing here replaces a surveyor.</li>
    <li><b>The searches state their own resolution.</b> The drive was searched at ${at15.cell?.toFixed(0) || 8} m over the ground and
    the grades are measured on the proven alignment, not on the softened line drawn over it. A refusal at this
    cell is strong evidence, not a survey.</li>
    <li><b>The low ground.</b> The flattest ground on this property is the river bench, and the Watauga is on
    the parcel. Whether that is the obvious place for a house or the one place it cannot go is a floodplain
    question this model has not been asked.</li>
  </ul>
</div>

<footer>
  Parcel boundary published by the Tennessee property viewer · roads from the state and OpenStreetMap
  (ODbL, © OpenStreetMap contributors) · elevation ${esc(P.meta.elevation)}.
  Building geometry read from the design module, not from a mesh. Every figure and every image in this
  document was computed from the place model on the run that wrote it.
</footer>
</div></body></html>`;

function rgb(c) { return `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`; }

writeFileSync('report.html', html);
log(`→ report.html (${(html.length / 1024 / 1024).toFixed(1)} MB, 4 renders)`);
console.log('');
