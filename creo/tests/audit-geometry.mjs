// An independent audit of the claim "it reliably generates geometry in the
// correct place, respecting roads and buildings."
//
// Method: for many random points across all nine places, ask CREO to build
// something there. Then IGNORE the certificate and re-derive the truth directly
// from polygon geometry. Compare. A false negative — the certificate says VALID
// while the thing really does sit on a building — is the failure that would
// matter to a planner.

import * as G from '../src/core/geom.js';
import { buildPlace, PLACES } from '../src/places/index.js';
import { makeContext } from '../src/lang/deixis.js';
import { interpret } from '../src/lang/interpret.js';
import { plan } from '../src/world/ops.js';
import { stream } from '../src/core/rng.js';

const UTTERANCES = [
  'build a building here',
  'put a stall here',
  'we need a drain here',
  'there should be trees here',
  'we need a path here',
];

// Ground truth, computed from polygons alone — no engine code involved.
function trueOverlaps(world, ghost) {
  const ring = world.place.ringOf(ghost);
  if (!ring) return [];
  const out = [];
  for (const e of world.entities()) {
    if (e.id === ghost.id) continue;
    if (e.collision !== 'solid') continue;          // buildings and walls
    const r = world.ringOf(e);
    if (!r) continue;
    if (!G.ringsIntersect(ring, r)) continue;
    // vertical separation is legitimate (a deck over a road)
    if (ghost.zBase >= e.zTop - 0.01 || ghost.zTop <= e.zBase + 0.01) continue;
    out.push({ id: e.id, name: e.name, area: sampleOverlap(ring, r) });
  }
  return out.filter((o) => o.area > 0.25);          // ignore sub-quarter-m² grazes
}

function trueRouteHits(world, ghost) {
  const ring = world.place.ringOf(ghost);
  if (!ring) return [];
  const out = [];
  for (const e of world.entities()) {
    if (!['road', 'path'].includes(e.type)) continue;
    const r = world.ringOf(e);
    if (!r || !G.ringsIntersect(ring, r)) continue;
    if (ghost.zBase >= e.zTop + 2.2) continue;      // clears overhead
    out.push({ id: e.id, name: e.name });
  }
  return out;
}

function sampleOverlap(a, b) {
  const ba = G.bbox(a), bb = G.bbox(b);
  const box = [Math.max(ba[0], bb[0]), Math.max(ba[1], bb[1]), Math.min(ba[2], bb[2]), Math.min(ba[3], bb[3])];
  if (box[2] <= box[0] || box[3] <= box[1]) return 0;
  const n = 32, dx = (box[2] - box[0]) / n, dy = (box[3] - box[1]) / n;
  let hits = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const p = [box[0] + (i + 0.5) * dx, box[1] + (j + 0.5) * dy];
    if (G.pointInRing(p, a) && G.pointInRing(p, b)) hits++;
  }
  return (hits / (n * n)) * (box[2] - box[0]) * (box[3] - box[1]);
}

const results = {
  trials: 0, produced: 0, empty: 0,
  falseNegativeCollision: [], falsePositiveCollision: 0, truePositiveCollision: 0,
  falseNegativeRoute: [], truePositiveRoute: 0,
  offsets: [], byPlace: {},
};

for (const def of PLACES) {
  const world = buildPlace(def.key);
  const b = world.place.bounds();
  const rnd = stream(`audit:${def.key}`, 7);
  const stats = { trials: 0, produced: 0, fnCollision: 0, fnRoute: 0, maxOffset: 0 };

  for (let i = 0; i < 120; i++) {
    const x = b[0] + rnd() * (b[2] - b[0]);
    const y = b[1] + rnd() * (b[3] - b[1]);
    const text = UTTERANCES[i % UTTERANCES.length];
    const ctx = makeContext(world, { pointer: [x, y], camera: { eye: [0, -200, 150], target: [0, 0, 0] } });
    results.trials++; stats.trials++;

    let p;
    try { p = plan(world, interpret(text, ctx), ctx); }
    catch (err) { results.falseNegativeCollision.push({ place: def.key, text, crash: String(err.message) }); continue; }

    const ghosts = p.ghosts || [];
    if (!ghosts.length) { results.empty++; continue; }
    results.produced++; stats.produced++;

    const codes = new Set((p.certificate?.findings || []).map((f) => f.code));
    const named = new Set((p.certificate?.findings || []).flatMap((f) => f.others || []));

    for (const g of ghosts) {
      // 1. did it land where the finger pointed? (only meaningful for single-object placements)
      if (ghosts.length === 1 && g.footprint && !g.props?.onRoofOf) {
        const c = G.centroid(world.place.ringOf(g));
        const off = G.dist(c, [x, y]);
        results.offsets.push(off);
        stats.maxOffset = Math.max(stats.maxOffset, off);
      }

      // 2. does it really sit on a building, and did the certificate say so?
      const real = trueOverlaps(world, g);
      const flagged = codes.has('COLLISION') || codes.has('REQUIRES_REMOVAL');
      if (real.length) {
        const allNamed = real.every((o) => named.has(o.id));
        if (!flagged || !allNamed) {
          results.falseNegativeCollision.push({
            place: def.key, text, ghost: g.type,
            hit: real.map((o) => `${o.name || o.id} (${o.area.toFixed(1)} m²)`),
            said: [...codes].join(',') || 'nothing',
            missing: real.filter((o) => !named.has(o.id)).map((o) => o.name || o.id),
          });
          stats.fnCollision++;
        } else results.truePositiveCollision++;
      } else if (flagged && [...named].some((id) => world.get(id)?.collision === 'solid')) {
        results.falsePositiveCollision++;
      }

      // 3. does it really sit on a road or path, and did the certificate say so?
      const routes = trueRouteHits(world, g);
      const routeFlagged = codes.has('BLOCKS_ACCESS') || codes.has('ROUTE_CONFLICT') || codes.has('WATER_CONFLICT') || codes.has('INSUFFICIENT_CLEARANCE');
      if (routes.length) {
        if (!routeFlagged) {
          results.falseNegativeRoute.push({ place: def.key, text, ghost: g.type, hit: routes.map((r) => r.name || r.id), said: [...codes].join(',') || 'nothing' });
          stats.fnRoute++;
        } else results.truePositiveRoute++;
      }
    }
  }
  results.byPlace[def.key] = stats;
}

const off = results.offsets.sort((a, b) => a - b);
const pct = (a) => (a.length ? a[Math.floor(a.length * 0.99)] : 0);

console.log('\n================ CREO GEOMETRY AUDIT ================');
console.log(`places: ${PLACES.length}   trials: ${results.trials}   produced geometry: ${results.produced}   produced nothing: ${results.empty}`);
console.log('\n-- did it land where the finger pointed? --');
console.log(`  samples ${off.length}   median ${off[Math.floor(off.length / 2)]?.toFixed(4)} m   99th pct ${pct(off).toFixed(4)} m   max ${off[off.length - 1]?.toFixed(4)} m`);
console.log('\n-- collision with buildings (ground truth vs certificate) --');
console.log(`  correctly reported : ${results.truePositiveCollision}`);
console.log(`  FALSE NEGATIVES    : ${results.falseNegativeCollision.length}   <-- sits on a building, certificate did not say so`);
console.log(`  false positives    : ${results.falsePositiveCollision}`);
console.log('\n-- roads and paths --');
console.log(`  correctly reported : ${results.truePositiveRoute}`);
console.log(`  FALSE NEGATIVES    : ${results.falseNegativeRoute.length}`);
for (const f of results.falseNegativeCollision.slice(0, 8)) console.log('   !', JSON.stringify(f));
for (const f of results.falseNegativeRoute.slice(0, 8)) console.log('   ~', JSON.stringify(f));
console.log('\n-- per place --');
for (const [k, s] of Object.entries(results.byPlace)) {
  console.log(`  ${k.padEnd(11)} trials ${String(s.trials).padStart(3)}  geometry ${String(s.produced).padStart(3)}  fn-collision ${s.fnCollision}  fn-route ${s.fnRoute}  max-offset ${s.maxOffset.toFixed(3)} m`);
}
