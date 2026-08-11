// Build a place around a real parcel: the boundary, the ground it sits on, and
// the road that reaches it.  node tools/site.mjs JOHNSON 100 064.03
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { findParcel, addParcel } from '../src/import/parcel.js';
import { importPlace, slug } from '../src/import/place.js';
import { makeProjection } from '../src/core/geom.js';
import * as G from '../src/core/geom.js';

const [county, map, parcel] = process.argv.slice(2);
const log = (m) => console.log('  ' + m);

console.log(`\nFINDING ${county} ${map} ${parcel}`);
const found = await findParcel({ county, map, parcel });
const a = found.attrs;
console.log(`  ${a.OWNER} · ${a.ADDRESS} · ${found.deedAcres} deed acres`);
console.log(`  boundary: ${found.ring.length} vertices, ${found.acres.toFixed(2)} acres drawn`
  + ` (${found.disagreement > 0 ? '+' : ''}${found.disagreement}% against the deed)`);
console.log(`  centre  : ${found.centre[0].toFixed(5)}, ${found.centre[1].toFixed(5)}`);

// a window that holds the whole parcel with room to see what it adjoins
const lat = found.centre[0], lon = found.centre[1];
const mLat = 111320, mLon = 111320 * Math.cos(lat * Math.PI / 180);
const xs = found.ring.map((p) => (p[1] - lon) * mLon), ys = found.ring.map((p) => (p[0] - lat) * mLat);
const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
const metres = Math.ceil((span * 1.6) / 100) * 100;
console.log(`\nOPENING ${metres} m around it`);

const dLat = metres / 2 / mLat, dLon = metres / 2 / mLon;
const { world, key, stats } = await importPlace({
  bbox: [lat - dLat, lon - dLon, lat + dLat, lon + dLon],
  name: `${a.ADDRESS || parcel} · ${county} ${parcel}`,
  metres, log,
});

const projection = makeProjection(lat, lon);
const id = addParcel(world, found, projection);
const ring = world.ringOf(world.get(id));
console.log(`\nTHE SITE`);
console.log(`  parcel drawn over ${Math.round(Math.abs(G.area(ring)))} m² of the model`);

// what the parcel actually touches
const ways = world.entities().filter((e) => ['road', 'path'].includes(e.type));
const touching = ways.filter((w) => {
  const r = world.ringOf(w);
  return r && r.some((p) => G.pointInRing(p, ring)) === false
    && r.some((p) => G.ringDistance(ring, G.circleRing(p[0], p[1], 1, 4)) < 25);
});
const inside = world.entities().filter((e) => {
  if (e.type === 'parcel') return false;
  const r = world.ringOf(e);
  return r && G.pointInRing(G.centroid(r), ring);
});
const sp = G.groundSpan(ring, (x, y) => world.place.groundAt(x, y), 12);
console.log(`  ground    : ${sp.lo.toFixed(0)}–${sp.hi.toFixed(0)} m, ${(sp.hi - sp.lo).toFixed(0)} m of fall across the parcel`);
console.log(`  on it     : ${inside.length ? inside.map((e) => e.name || e.type).slice(0, 6).join(', ') : 'nothing recorded'}`);
console.log(`  reached by: ${touching.length ? [...new Set(touching.map((w) => w.name || w.type))].slice(0, 5).join(', ') : 'no way within 25 m — check the frontage'}`);

writeFileSync(`places/${key}.json`, world.save());
const idxPath = 'places/index.json';
const idx = existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, 'utf8')) : [];
if (!idx.some((p) => p.key === key)) idx.push({ key, name: `${a.ADDRESS} · ${a.OWNER}` });
writeFileSync(idxPath, JSON.stringify(idx, null, 2));
console.log(`\n  → places/${key}.json\n`);
