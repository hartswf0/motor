#!/usr/bin/env node
// Import any location into CREO.
//
//   node import.js "Kibera, Nairobi"
//   node import.js "Jordaan, Amsterdam" --metres=700
//   node import.js --bbox=52.3735,4.8790,52.3785,4.8860 --name="Jordaan"
//   node import.js --list
//
// No API key: Nominatim, Overpass and the terrarium tiles are all public.
// After an import the place is a file, and everything — including the test
// suite — runs offline. Data © OpenStreetMap contributors (ODbL).

import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importPlace, slug } from './src/import/place.js';
import { geocode } from './src/import/geocode.js';

const here = dirname(fileURLToPath(import.meta.url));
const PLACES = join(here, 'places');

const argv = process.argv.slice(2);
const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--'))
  .map((a) => { const [k, ...v] = a.slice(2).split('='); return [k, v.join('=') || true]; }));
const query = argv.filter((a) => !a.startsWith('--')).join(' ').trim();

if (flags.list) {
  const idx = existsSync(join(PLACES, 'index.json')) ? JSON.parse(readFileSync(join(PLACES, 'index.json'), 'utf8')) : [];
  if (!idx.length) console.log('no places imported yet');
  for (const p of idx) console.log(`  ${p.key.padEnd(16)} ${p.name}  (${p.counts.buildings} buildings, ${p.counts.roads} roads, ${p.relief} m relief)`);
  process.exit(0);
}

if (flags.search) {
  for (const h of await geocode(String(flags.search))) {
    console.log(`  ${h.short}\n    ${h.kind} · ${h.span.width}×${h.span.height} m · ${h.bbox.map((n) => n.toFixed(4)).join(',')}`);
  }
  process.exit(0);
}

if (!query && !flags.bbox) {
  console.log('usage:\n  node import.js "Kibera, Nairobi"\n  node import.js --bbox=S,W,N,E --name="..."\n  node import.js --search="springfield"\n  node import.js --list');
  process.exit(1);
}

const t0 = Date.now();
let result;
try {
  result = await importPlace({
    query: query || undefined,
    bbox: flags.bbox ? String(flags.bbox).split(',').map(Number) : undefined,
    name: flags.name,
    key: flags.key,
    metres: flags.metres ? Number(flags.metres) : undefined,
    terrain: !flags.flat,
    log: (m) => console.log(`  ${m}`),
  });
} catch (err) {
  console.error(`\n  ${err.message}\n`);
  process.exit(1);
}

const { world, stats, bbox, key, name, span } = result;
mkdirSync(PLACES, { recursive: true });
const payload = world.save();
writeFileSync(join(PLACES, `${key}.json`), payload);

const indexPath = join(PLACES, 'index.json');
const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : [];
writeFileSync(indexPath, JSON.stringify([...index.filter((x) => x.key !== key), {
  key, name, bbox, fetchedAt: result.fetchedAt,
  scale: span.width > 1200 ? 'district' : 'neighbourhood',
  counts: stats, relief: world.place.meta.relief || 0,
  source: 'OpenStreetMap (ODbL)',
}], null, 2));

console.log(`  → places/${key}.json  (${(payload.length / 1024).toFixed(0)} KB, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log('  © OpenStreetMap contributors, ODbL\n');
