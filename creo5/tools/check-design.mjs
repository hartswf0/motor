// IS THE DESIGN WE HOLD THE DESIGN THAT EXISTS?
//
// designs/henry-house/ is a COPY. The house is authored in another repository
// and CREO reads a vendored snapshot of it, because a place model cannot import
// across repositories and geometry.mjs is the single source of truth for the
// building the way this Ground is the single source of truth for the hill.
//
// A copy is a second representation, which is the fault this whole project is
// organised against — so it needs the thing every other second representation
// here has: something that fails when the two disagree. That copy sat stale long
// enough for the site elevation to be corrected upstream from an assumed
// 3,412 ft to a measured 2,364 ft — a thousand feet, and with it the snow load,
// the design temperature and the freeze depth — while CREO went on reporting the
// old figure and nothing said a word.
//
//   node tools/check-design.mjs           compare against the published source
//   node tools/check-design.mjs --update   take the newer one
//
// Offline this reports what it could not reach and exits clean: a check that
// fails when the network is down teaches people to ignore it.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// The REPOSITORY, not the published site. Pointed at the Pages build first,
// this reported units.mjs as drifted in the wrong direction — ours newer than
// theirs — because hartswf0.github.io is a BUILD of the repo and that build is
// behind it. A check that compares against an artifact tells you about the
// artifact; the design is the source.
const SOURCE = 'https://raw.githubusercontent.com/hartswf0/henry-house/HEAD/model';
const HERE = new URL('../designs/henry-house/', import.meta.url);
const FILES = ['geometry.mjs', 'units.mjs', 'structure.mjs', 'site-context.mjs'];
const update = process.argv.includes('--update');
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

console.log(`\nTHE DESIGN — comparing designs/henry-house against ${SOURCE}\n`);

let drifted = 0, unreachable = 0;
for (const f of FILES) {
  const local = readFileSync(new URL(f, HERE), 'utf8');
  let remote = null;
  try {
    const res = await fetch(`${SOURCE}/${f}`);
    if (res.ok) remote = await res.text();
  } catch { /* offline */ }

  if (remote === null) {
    console.log(`  ?  ${f.padEnd(18)} could not be reached`);
    unreachable++;
    continue;
  }
  if (remote === local) {
    console.log(`  ok ${f.padEnd(18)} ${sha(local)}`);
    continue;
  }
  drifted++;
  const l = local.split('\n'), r = remote.split('\n');
  let first = 0;
  while (first < l.length && first < r.length && l[first] === r[first]) first++;
  console.log(`  !! ${f.padEnd(18)} DRIFTED — ours ${sha(local)}, theirs ${sha(remote)}`);
  console.log(`     first difference at line ${first + 1}:`);
  console.log(`       ours   ${(l[first] ?? '<end of file>').trim().slice(0, 92)}`);
  console.log(`       theirs ${(r[first] ?? '<end of file>').trim().slice(0, 92)}`);
  if (update) {
    writeFileSync(new URL(f, HERE), remote);
    console.log('     updated.');
  }
}

// The numbers the study quotes, checked against the module rather than against
// memory: these are the ones that moved last time and nobody noticed.
const mod = await import('../designs/henry-house/geometry.mjs');
if (mod.SITE) {
  console.log(`\n  the design says: ${mod.SITE.elevationFtAmsl} ft AMSL · ${mod.SITE.county} County, `
    + `${mod.SITE.state} · falls to ${mod.SITE.fallsToAzimuth}° · ${mod.SITE.crossSlopePctMeasured}% measured cross slope`);
  console.log(`  ${mod.SITE.note}`);
} else {
  console.log('\n  !! this copy has no SITE block — it predates the measured coordinate');
  drifted++;
}

console.log(drifted
  ? `\n  ${drifted} file(s) drifted. Run with --update to take the published version,`
    + '\n  then re-run the tests: the study quotes this module and the renders are built from it.\n'
  : `\n  the design we hold is the design that exists${unreachable ? ` (${unreachable} unchecked — offline)` : ''}.\n`);
if (drifted && !update) process.exit(1);
