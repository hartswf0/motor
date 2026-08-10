#!/usr/bin/env node
// Import a real place into CREO.
//
//   node import.js --bbox=-1.2380,36.8760,-1.2340,36.8820 --name="Baba Dogo" --key=babadogo
//   node import.js --preset=babadogo
//
// Writes places/<key>.json — after which the place works entirely offline, and
// the test suite still runs with no network. Data © OpenStreetMap contributors
// (ODbL); elevation from opentopodata.org.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchOSM, osmToPlace } from './src/import/osm.js';
import { fetchElevation } from './src/import/elevation.js';

const here = dirname(fileURLToPath(import.meta.url));
const PLACES_DIR = join(here, 'places');

// bbox is [south, west, north, east]
export const PRESETS = {
  babadogo:  { name: 'Baba Dogo, Nairobi',      bbox: [-1.2395, 36.8745, -1.2325, 36.8835] },
  kibera:    { name: 'Kibera, Nairobi',          bbox: [-1.3155, 36.7830, -1.3085, 36.7920] },
  soho:      { name: 'SoHo, New York',           bbox: [40.7215, -74.0045, 40.7265, -73.9975] },
  venice:    { name: 'Cannaregio, Venice',       bbox: [45.4425, 12.3245, 45.4475, 12.3315] },
  amsterdam: { name: 'Jordaan, Amsterdam',       bbox: [52.3735, 4.8790, 52.3785, 4.8860] },
};

const args = Object.fromEntries(process.argv.slice(2)
  .filter((a) => a.startsWith('--'))
  .map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || true]; }));

const preset = args.preset ? PRESETS[args.preset] : null;
if (args.preset && !preset) {
  console.error(`unknown preset. try: ${Object.keys(PRESETS).join(', ')}`);
  process.exit(1);
}
const bbox = preset ? preset.bbox : String(args.bbox || '').split(',').map(Number);
const name = preset ? preset.name : (args.name || 'Imported place');
const key = args.key || args.preset || 'imported';

if (bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) {
  console.error('need --bbox=south,west,north,east  or  --preset=<name>');
  console.error(`presets: ${Object.keys(PRESETS).join(', ')}`);
  process.exit(1);
}

const [s, w, n, e] = bbox;
const spanM = Math.round((n - s) * 111320);
const spanE = Math.round((e - w) * 111320 * Math.cos(((s + n) / 2 * Math.PI) / 180));
console.log(`\n${name}`);
console.log(`  bbox ${bbox.join(', ')}  (~${spanE} × ${spanM} m)`);

const t0 = Date.now();
console.log('  fetching OpenStreetMap…');
const { json, mirror } = await fetchOSM(bbox, { log: (m) => console.log(`    ${m}`) });
console.log(`  ${json.elements.length} OSM elements from ${new URL(mirror).host}`);

let elevation = null;
if (args.flat) {
  console.log('  --flat: skipping elevation, terrain will be level');
} else {
  try {
    elevation = await fetchElevation(bbox, { log: (m) => process.stdout.write(`\r  ${m}   `) });
    console.log(`\r  elevation: ${elevation.points.length} samples, ${elevation.dataset}, relief ${elevation.relief} m      `);
  } catch (err) {
    console.log(`\r  elevation unavailable (${err.message.slice(0, 80)}) — terrain will be level`);
  }
}

const fetchedAt = new Date().toISOString();
const { world, stats } = osmToPlace(json, { key, name, bbox, elevation, fetchedAt, mirror });

console.log(`  built: ${Object.entries(stats).map(([k, v]) => `${v} ${k}`).join(', ')}`);

mkdirSync(PLACES_DIR, { recursive: true });
const out = join(PLACES_DIR, `${key}.json`);
const payload = world.save();
writeFileSync(out, payload);

// keep an index so the app can list what has been imported
const indexPath = join(PLACES_DIR, 'index.json');
const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : [];
const entry = {
  key, name, bbox, fetchedAt,
  scale: spanE > 1200 ? 'district' : 'neighbourhood',
  counts: stats,
  relief: elevation ? elevation.relief : 0,
  source: 'OpenStreetMap (ODbL)',
};
writeFileSync(indexPath, JSON.stringify([...index.filter((x) => x.key !== key), entry], null, 2));

console.log(`  → ${out}  (${(payload.length / 1024).toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log('  © OpenStreetMap contributors, ODbL\n');
