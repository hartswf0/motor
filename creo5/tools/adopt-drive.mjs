// ADOPT THE TRACED DRIVE.
//
// The white line in the state's viewer was never in this place, because this
// place came from OpenStreetMap and nobody has mapped a private drive there.
// data/drive-traced.json is that line, digitized off the aerial and registered
// to the official cadastral boundary at ~2.7 m. This puts it into the world as
// way entities — TRACED, with the registration accuracy in the provenance — and
// from that moment every access search seeds from it, because access.js asks
// the network, and now the network includes the drive that actually exists.
//
//   node tools/adopt-drive.mjs            preview what would be added
//   node tools/adopt-drive.mjs --commit   add the ways and save the place
import { readFileSync, writeFileSync } from 'node:fs';
import { World } from '../src/core/world.js';

const file = 'places/hwy-321-johnson-064-03.json';
const data = JSON.parse(readFileSync('data/drive-traced.json', 'utf8'));
const w = World.load(readFileSync(file, 'utf8'));
const commit = process.argv.includes('--commit');

console.log(`\nTHE TRACED DRIVE — ${data.source}`);
console.log(`  registration: ${data.fit.meanResidual_m} m mean against the cadastral boundary · ${data.epistemic}\n`);

let n = 0;
for (const [name, p] of Object.entries(data.paths)) {
  const id = `traced-${name}`;
  const exists = w.entities().some((e) => e.id === id);
  const z = w.place.groundAt(p.local_m[0][0], p.local_m[0][1]);
  console.log(`  ${exists ? 'HAVE ' : commit ? 'ADD  ' : 'WOULD'} ${name.padEnd(18)} ${p.type.padEnd(4)} ${String(p.local_m.length).padStart(2)} pts · ${p.note}`);
  if (exists || !commit) continue;
  w.place.put({
    id, type: p.type, name: name === 'drive-main' ? 'The drive' : null,
    path: p.local_m, width: p.width,
    zBase: z, zTop: z + 0.05,
    network: p.type === 'road' ? 'streets' : 'paths',
    use: p.use, collision: 'none',
    epistemic: 'TRACED',
    sim: { permeability: 0.4, roughness: 0.02 },
    provenance: {
      author: 'CREO adopt-drive', when: new Date().toISOString(),
      how: `${data.method}; mean residual ${data.fit.meanResidual_m} m`,
      source: data.source,
    },
  });
  n++;
}
if (commit) {
  writeFileSync(file, w.save());
  console.log(`\n  COMMITTED — ${n} ways added. The access search now leaves from the drive that exists.\n`);
} else {
  console.log('\n  Preview only. --commit adds them and saves the place.\n');
}
