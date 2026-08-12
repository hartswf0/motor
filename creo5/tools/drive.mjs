// THE DRIVE — from the network the parcel already has to the house it now holds.
//
// place-house.mjs seats the volumes; nothing yet lets a car arrive. This asks
// access.js for a way from the nearest existing road to a gate beside the
// garage, at a hard grade limit, over the settled ground — and prints what the
// land answered. `--commit` makes the way real: the bed is settled into the one
// Ground and the drive becomes a road entity with its provenance attached.
//
//   node tools/drive.mjs                 plan and report
//   node tools/drive.mjs --commit        also settle the bed and save the place
//   node tools/drive.mjs --grade 12      a different hard limit, in percent
import { readFileSync, writeFileSync } from 'node:fs';
import { World } from '../src/core/world.js';
import * as G from '../src/core/geom.js';
import { refineTerrain } from '../src/world/seat.js';
import { nearestOnNetwork, planAccess, driveEntity, settleDriveBed } from '../src/world/access.js';

const file = 'places/hwy-321-johnson-064-03.json';
const w = World.load(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const commit = args.includes('--commit');
const gi = args.indexOf('--grade');
const maxGrade = gi >= 0 ? parseFloat(args[gi + 1]) / 100 : 0.15;

// WHERE THE CAR MUST END. The house is in the world as its real volumes; the
// garage is the part a drive exists for. The gate stands off its footprint,
// on the side the network is on.
const parts = w.entities().filter((e) => String(e.id || '').startsWith('henry-house-'));
if (!parts.length) {
  console.error('The house is not in this place yet — run tools/place-house.mjs first.');
  process.exit(1);
}
const garage = parts.find((e) => e.id === 'henry-house-garage') || parts[0];
const gc = G.centroid(w.ringOf(garage));
const near = nearestOnNetwork(w, gc);
if (!near) { console.error('No way network exists in this place.'); process.exit(1); }
const dir = G.norm(G.sub(near.p, gc));
const ob = G.bbox(w.ringOf(garage));
const standoff = Math.max(ob[2] - ob[0], ob[3] - ob[1]) / 2 + 7;
const gate = G.add(gc, G.mul(dir, standoff));

// The search deserves better ground than 30 m cells. Refine the corridor once;
// the refinement is the same one seating uses, so there is still one Ground.
refineTerrain(w.place, 8, G.lerp2(near.p, gate, 0.5), G.dist(near.p, gate) / 2 + 160);

// The question is asked of the WHOLE network, not the nearest point of it —
// the nearest way as the crow flies is often the worst way as the car climbs.
const parcel = w.entities().find((e) => e.type === 'parcel');
const drive = planAccess(w, gate, { maxGrade, keepInside: parcel ? w.ringOf(parcel) : null });

console.log(`\nTHE DRIVE — from the network to the garage gate`);
console.log(`  gate at ${gate.map((v) => Math.round(v)).join(', ')} · limit ${Math.round(maxGrade * 100)}% · nearest way "${near.name}" at ${Math.round(near.d)} m`);
if (drive.possible) console.log(`  the search left from: ${drive.fromName || 'an unnamed way'}\n`); else console.log('');
console.log('  ' + drive.reads + '\n');

// When the answer is no, the refusal names its choices — so measure them.
if (!drive.possible) {
  const free = planAccess(w, gate, { maxGrade });
  if (free.possible) {
    console.log(`  · Off the parcel it exists: ${Math.round(free.length)} m at ${(free.maxG * 100).toFixed(0)}%`
      + ` from ${free.fromName || 'an unnamed way'} — an easement across a neighbour, which is a conversation, not a design.`);
  }
  for (const g2 of [0.18, 0.2, 0.25]) {
    const alt = planAccess(w, gate, { maxGrade: g2, keepInside: parcel ? w.ringOf(parcel) : null });
    if (alt.possible && !alt.onNetwork) {
      console.log(`  · Inside the boundary it first exists at ${Math.round(g2 * 100)}%:`
        + ` ${Math.round(alt.length)} m from ${alt.fromName || 'an unnamed way'}, steepest ${(alt.maxG * 100).toFixed(0)}%.`);
      break;
    }
  }
  console.log('  · Or the house moves to ground the network can reach — the study now measures that per site.\n');
}

if (drive.possible) {
  // the profile, as stations a person can read
  const rows = [];
  for (let i = 0; i < drive.stations.length; i += Math.max(1, Math.floor(drive.stations.length / 9))) {
    const s = drive.stations[i];
    const prev = drive.stations[Math.max(0, i - 1)];
    const run = s.s - prev.s;
    const g = run > 0.5 ? Math.abs(s.z - prev.z) / run * 100 : 0;
    rows.push(`  ${String(Math.round(s.s)).padStart(5)} m   ${s.z.toFixed(1).padStart(7)} m   ${g.toFixed(0).padStart(3)}%`);
  }
  console.log('  station     elev      grade');
  console.log(rows.join('\n'));
}

if (commit && drive.possible) {
  const settled = settleDriveBed(w, drive);
  w.place.put(driveEntity(drive));
  writeFileSync(file, w.save());
  console.log(`\n  COMMITTED — bed settled into the ground (${settled.changed} samples now answer to it), drive saved as a road entity.`);
} else if (commit) {
  console.log('\n  Nothing committed — there is no way to commit.');
} else if (drive.possible) {
  console.log('\n  Planned only. --commit settles the bed and saves the place.');
}
console.log();
