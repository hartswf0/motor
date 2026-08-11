// The theory, checked. Run: node ground.test.js
//
// Every test here corresponds to an invariant in THEORY.md, and every one was
// learned from a defect that shipped green. A test that has never been seen to
// fail on the real code is not evidence — so the central case deliberately
// reintroduces the historical bug and requires the harness to catch it.

import { Ground, conformance, MEASURED } from './ground.js';

let pass = 0, fail = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  \x1b[32m✓\x1b[0m ${name}`); pass++; }
  catch (e) { console.log(`  \x1b[31m✗ ${name}\x1b[0m\n      ${e.message}`); fail++; }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || ''}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

/**
 * A hillside that can actually fail the test.
 *
 * The first version of this was `f(x) + g(y)` — a slope plus a fold — and it
 * quietly made the central test impossible to fail: for a SEPARABLE surface the
 * bilinear twist term (h00 - h10 - h01 + h11) is exactly zero, so bilinear and
 * planar interpolation are identically equal and the historical bug is
 * invisible. The fixture was incapable of exposing the defect it existed for.
 *
 * Real terrain is not separable. Neither is this: the cross term is what makes
 * a saddle a saddle, and a saddle is precisely where a curved surface and a
 * faceted one part company.
 */
function hillside({ cell = 10, size = 400, fall = 40 } = {}) {
  const g = new Ground([-size / 2, -size / 2, size / 2, size / 2], cell);
  for (let j = 0; j < g.ny; j++) {
    for (let i = 0; i < g.nx; i++) {
      const x = g.bounds[0] + i * cell, y = g.bounds[1] + j * cell;
      g.h[j * g.nx + i] = 100
        + (x / size) * fall
        + Math.cos((y / size) * Math.PI * 3) * fall * 0.3
        + Math.sin((x / size) * Math.PI * 2.5) * Math.cos((y / size) * Math.PI * 2.5) * fall * 0.45;
    }
  }
  return g;
}

console.log('\n\x1b[1mI1 — one ground\x1b[0m');

test('the mesh IS the height function, not a resemblance of it', () => {
  const r = conformance(hillside(), []);
  assert(r.conforms, r.reads);
});

test('a bilinear reader — the actual historical bug — is caught', () => {
  // This is what CREO-01 shipped for months: groundAt interpolated bilinearly
  // while the renderer drew flat triangles. It cost 20.8% of road vertices at
  // full detail and 56.3% zoomed out, worst 9.7 m. The harness must see it.
  const g = hillside();
  const bilinear = {
    name: 'the old groundAt (bilinear)',
    heightAt(x, y) {
      const { i, j, u, v } = g.cellOf(x, y);
      const h00 = g.at(i, j), h10 = g.at(i + 1, j), h01 = g.at(i, j + 1), h11 = g.at(i + 1, j + 1);
      return (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
    },
  };
  const r = conformance(g, [bilinear]);
  assert(!r.conforms, 'the harness did not notice a second surface');
  assert(/second surface/.test(r.reads), r.reads);

  // Not "bigger than some number I chose". The largest possible disagreement
  // between a bilinear surface and the two flat triangles over it is |twist|/4
  // at the cell centre, where twist = h00 - h10 - h01 + h11. Compute what the
  // fixture makes possible, and require the harness to have found nearly all
  // of it — that tests its SENSITIVITY, which is the property that matters.
  let maxTwist = 0;
  for (let j = 0; j + 1 < g.ny; j++) {
    for (let i = 0; i + 1 < g.nx; i++) {
      const twist = g.at(i, j) - g.at(i + 1, j) - g.at(i, j + 1) + g.at(i + 1, j + 1);
      maxTwist = Math.max(maxTwist, Math.abs(twist));
    }
  }
  const possible = maxTwist / 4;
  assert(possible > 0.01, `the fixture cannot express the bug at all (twist ${maxTwist.toFixed(4)})`);
  assert(r.worst.by >= possible * 0.9,
    `found only ${r.worst.by.toFixed(3)} m of a possible ${possible.toFixed(3)} m — the harness samples where agreement is easy`);
  console.log(`      (found ${r.worst.by.toFixed(3)} m of a theoretical ${possible.toFixed(3)} m — ${(100 * r.worst.by / possible).toFixed(0)}% sensitive, over ${r.disagreements} points)`);
});

test('a reader that samples the same lattice a different way is still caught', () => {
  // The tempting "display-only" surface: same data, coarser, for speed. This is
  // exactly the optimisation that would reintroduce Class A.
  const g = hillside({ cell: 10 });
  const coarse = new Ground(g.bounds, 20);
  for (let j = 0; j < coarse.ny; j++) {
    for (let i = 0; i < coarse.nx; i++) {
      coarse.h[j * coarse.nx + i] = g.heightAt(coarse.bounds[0] + i * 20, coarse.bounds[1] + j * 20);
    }
  }
  const r = conformance(g, [{ name: 'a display-only surface', heightAt: (x, y) => coarse.heightAt(x, y) }]);
  assert(!r.conforms, 'a coarser copy of the same data passed as the same ground');
});

console.log('\n\x1b[1mI2 — resolution is declared and sufficient\x1b[0m');

test('a ground says what it can record, not what it can compute', () => {
  const g = hillside({ cell: 30 });
  eq(g.finestRepresentable(), 60, 'a 30 m lattice cannot record a 60 m thing in less than two cells');
  assert(g.finestRepresentable() > 12, 'this is the 30 m DEM that could not hold a 12 m house');
});

test('an intervention finer than the ground refines it, and says by how much', () => {
  const g = hillside({ cell: 30 });
  const r = g.refineFor(12);
  assert(r.refined, `refused when it should have refined: ${r.reason}`);
  assert(r.ground.finestRepresentable() <= 12, `still cannot hold a 12 m house: ${r.ground.finestRepresentable()}`);
  console.log(`      (${r.from} m → ${r.cell} m, ${r.samples} samples)`);
});

test('an intervention it cannot afford is refused, not silently approximated', () => {
  const big = new Ground([-20000, -20000, 20000, 20000], 30);
  const r = big.refineFor(0.05);
  assert(r.refused, 'it tried to record 5 cm detail over 40 km');
  assert(/samples/.test(r.reason), r.reason);
});

test('refining does not invent agreement: the refined ground still conforms', () => {
  const { ground } = hillside({ cell: 30 }).refineFor(12);
  assert(conformance(ground, []).conforms, 'a refined ground disagreed with its own mesh');
});

console.log('\n\x1b[1mI3 — invention is labelled\x1b[0m');

test('what is measured says measured', () => {
  const g = hillside({ cell: 10 });
  eq(g.provenanceAt(0, 0), 'measured');
  assert(g.isMeasured(0, 0), 'a real sample denied being one');
});

test('what is interpolated never reports itself as survey', () => {
  const { ground } = hillside({ cell: 30 }).refineFor(12);
  // a point off the original 30 m lattice cannot be survey
  const off = ground.bounds[0] + 37;
  eq(ground.provenanceAt(off, off), 'interpolated', 'invention was reported as measurement');
  assert(!ground.isMeasured(off, off), 'refinement laundered interpolation into survey');
});

test('settled ground says it was settled, and goes back exactly', () => {
  const g = hillside({ cell: 5 });
  const before = g.heightAt(0, 0);
  const inside = (x, y) => Math.hypot(x, y) < 30;
  const undo = g.settle(inside, () => 120);
  assert(undo.changed > 20, `only ${undo.changed} samples could change`);
  eq(g.provenanceAt(0, 0), 'settled', 'reshaped ground pretended to be found');
  assert(Math.abs(g.heightAt(0, 0) - 120) < 1e-6, 'the settle did not take');
  undo.restore();
  assert(Math.abs(g.heightAt(0, 0) - before) < 1e-9, 'the ground did not go back');
  eq(g.provenanceAt(0, 0), 'measured', 'the provenance did not go back');
});

test('settling does not break I1', () => {
  const g = hillside({ cell: 5 });
  g.settle((x, y) => Math.hypot(x, y) < 30, () => 120);
  assert(conformance(g, []).conforms, 'a settled ground disagreed with its own mesh');
});

console.log('\n\x1b[1mrefusals\x1b[0m');

test('a ground refuses to exist without a resolution', () => {
  let threw = false;
  try { new Ground([0, 0, 100, 100], 0); } catch { threw = true; }
  assert(threw, 'a ground with no cell size was allowed');
  threw = false;
  try { new Ground([0, 0, NaN, 100], 10); } catch { threw = true; }
  assert(threw, 'a ground with unknown bounds was allowed');
});

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
if (fail) process.exit(1);
