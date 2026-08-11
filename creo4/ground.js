// GROUND — the one surface.
//
// This file exists because of a measured fact: half of every defect in a long
// session on CREO-01 was the same defect. The system held TWO ANSWERS to one
// question — the height of the ground at a point — and nothing forced them to
// agree.
//
//   roads      20.8% of vertices buried, 56.3% zoomed out, worst 9.7 m
//   contours   19.8% of contour length inside the hill, worst 4.6 m
//   regions    a drawn circle 15.9 m off across 31 m of fall
//   woods      an 86,000 m² polygon floating 60.7 m in the air
//
// Each was fixed correctly and separately. None of the fixes addressed the
// class, and I reintroduced the same disagreement three times without
// recognising it, because the disagreement was structurally available: one
// module interpolated bilinearly, another drew flat triangles, and both were
// "the ground".
//
// So: a Ground is a single object that is simultaneously WHAT IS DRAWN, WHAT IS
// MEASURED and WHAT IS SIMULATED. There is one height function. The mesh is
// derived from it rather than parallel to it. A second means of obtaining a
// height is a defect whether or not it currently agrees — and `conformance()`
// below turns that sentence into a test.
//
// Invariants realised here:
//   I1  one ground             — heightAt is the only height, triangles() derives from it
//   I2  resolution declared    — finestRepresentable(), refineFor(), and refusal
//   I3  invention labelled     — MEASURED | INTERPOLATED | SETTLED, per sample

export const MEASURED = 0;      // a real sample from a real source
export const INTERPOLATED = 1;  // invented between samples, and saying so
export const SETTLED = 2;       // deliberately reshaped by an accepted claim

const NAMES = ['measured', 'interpolated', 'settled'];

export class Ground {
  /**
   * @param {number[]} bounds  [minX, minY, maxX, maxY] in metres
   * @param {number} cell      metres between samples
   * @param {Float32Array} [heights]
   * @param {Uint8Array} [provenance]
   */
  constructor(bounds, cell, heights = null, provenance = null) {
    if (!(cell > 0) || !Number.isFinite(cell)) throw new Error('a ground needs a positive cell size');
    if (!bounds || bounds.length !== 4 || !bounds.every(Number.isFinite)) throw new Error('a ground needs finite bounds');
    this.bounds = bounds.slice();
    this.cell = cell;
    this.nx = Math.max(2, Math.round((bounds[2] - bounds[0]) / cell) + 1);
    this.ny = Math.max(2, Math.round((bounds[3] - bounds[1]) / cell) + 1);
    this.h = heights || new Float32Array(this.nx * this.ny);
    this.p = provenance || new Uint8Array(this.nx * this.ny).fill(MEASURED);
    if (this.h.length !== this.nx * this.ny) throw new Error('heights do not match the lattice');
  }

  // ------------------------------------------------------------ the lattice --
  // Everything below is expressed in terms of these three, so that no caller can
  // form its own opinion about where a sample is.

  at(i, j) {
    const ci = i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i;
    const cj = j < 0 ? 0 : j >= this.ny ? this.ny - 1 : j;
    return this.h[cj * this.nx + ci];
  }

  cellOf(x, y) {
    const fx = (x - this.bounds[0]) / this.cell;
    const fy = (y - this.bounds[1]) / this.cell;
    const i = Math.floor(fx), j = Math.floor(fy);
    return { i, j, u: fx - i, v: fy - j };
  }

  /**
   * THE ONLY HEIGHT FUNCTION.
   *
   * Planar within a triangle, and the triangles are the ones `triangles()`
   * emits — the diagonal runs from the (i, j) corner to (i+1, j+1), and the
   * quad is split (00,10,11) then (00,11,01). Bilinear interpolation was the
   * original sin: it describes a curved surface that no renderer can draw, so
   * everything laid on the ground crossed in and out of the ground that was
   * shown. Flat here, flat there, identical.
   */
  heightAt(x, y) {
    const { i, j, u, v } = this.cellOf(x, y);
    const h00 = this.at(i, j), h10 = this.at(i + 1, j);
    const h11 = this.at(i + 1, j + 1), h01 = this.at(i, j + 1);
    return v <= u
      ? h00 + (h10 - h00) * u + (h11 - h10) * v
      : h00 + (h11 - h01) * u + (h01 - h00) * v;
  }

  /** The surface as drawn. Derived from heightAt's own rule, never beside it. */
  * triangles() {
    for (let j = 0; j + 1 < this.ny; j++) {
      for (let i = 0; i + 1 < this.nx; i++) {
        const x0 = this.bounds[0] + i * this.cell, y0 = this.bounds[1] + j * this.cell;
        const x1 = x0 + this.cell, y1 = y0 + this.cell;
        const a = [x0, y0, this.at(i, j)];
        const b = [x1, y0, this.at(i + 1, j)];
        const c = [x1, y1, this.at(i + 1, j + 1)];
        const d = [x0, y1, this.at(i, j + 1)];
        yield [a, b, c];
        yield [a, c, d];
      }
    }
  }

  /** The normal of the surface as drawn, for shading that matches the shape. */
  normalAt(x, y) {
    const d = this.cell * 0.5;
    const dzdx = (this.heightAt(x + d, y) - this.heightAt(x - d, y)) / (2 * d);
    const dzdy = (this.heightAt(x, y + d) - this.heightAt(x, y - d)) / (2 * d);
    const len = Math.hypot(dzdx, dzdy, 1);
    return [-dzdx / len, -dzdy / len, 1 / len];
  }

  // --------------------------------------------------------- I3: provenance --

  provenanceAt(x, y) {
    const { i, j } = this.cellOf(x, y);
    const corners = [this.pAt(i, j), this.pAt(i + 1, j), this.pAt(i + 1, j + 1), this.pAt(i, j + 1)];
    // the weakest claim wins: a point is only measured if everything around it is
    return NAMES[Math.max(...corners)];
  }

  pAt(i, j) {
    const ci = i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i;
    const cj = j < 0 ? 0 : j >= this.ny ? this.ny - 1 : j;
    return this.p[cj * this.nx + ci];
  }

  /** Can anything here be reported as survey? */
  isMeasured(x, y) { return this.provenanceAt(x, y) === 'measured'; }

  // --------------------------------------------------------- I2: resolution --

  /** The smallest thing this ground can record, as opposed to compute. */
  finestRepresentable() { return this.cell * 2; }

  /**
   * Make the ground fine enough for an intervention of a given size, or refuse.
   *
   * A 30 m cell cannot hold a 12 m house: the earthwork computes correctly and
   * changes ONE sample. Refinement adds no information — every new value is
   * interpolation of the same public data — but it adds the CAPACITY to be
   * changed, which is what makes a pad representable at all. Hence I3: the new
   * samples are labelled, permanently, as invention.
   */
  refineFor(sizeM, { maxSamples = 4e6 } = {}) {
    const want = sizeM / 4;
    if (this.finestRepresentable() <= sizeM) return { refined: false, reason: 'already fine enough', cell: this.cell };
    const nx = Math.round((this.bounds[2] - this.bounds[0]) / want) + 1;
    const ny = Math.round((this.bounds[3] - this.bounds[1]) / want) + 1;
    if (nx * ny > maxSamples) {
      return {
        refined: false,
        refused: true,
        reason: `recording ${sizeM} m detail over this extent needs ${(nx * ny / 1e6).toFixed(1)}M samples`,
        cell: this.cell,
      };
    }
    const fine = new Ground(this.bounds, want);
    for (let j = 0; j < fine.ny; j++) {
      for (let i = 0; i < fine.nx; i++) {
        const x = fine.bounds[0] + i * fine.cell, y = fine.bounds[1] + j * fine.cell;
        const k = j * fine.nx + i;
        fine.h[k] = this.heightAt(x, y);
        // a refined sample is only measured where it lands on an original one
        const onLattice = Math.abs((x - this.bounds[0]) / this.cell % 1) < 1e-9
          && Math.abs((y - this.bounds[1]) / this.cell % 1) < 1e-9;
        fine.p[k] = onLattice ? this.provenanceAt(x, y) === 'measured' ? MEASURED : INTERPOLATED : INTERPOLATED;
      }
    }
    return { refined: true, ground: fine, from: this.cell, cell: fine.cell, samples: fine.h.length };
  }

  /** Reshape the ground, and record that it was reshaped rather than found. */
  settle(inside, heightFor) {
    let changed = 0;
    const before = [];
    for (let j = 0; j < this.ny; j++) {
      for (let i = 0; i < this.nx; i++) {
        const x = this.bounds[0] + i * this.cell, y = this.bounds[1] + j * this.cell;
        if (!inside(x, y)) continue;
        const k = j * this.nx + i;
        const target = heightFor(x, y, this.h[k]);
        if (target === null || Math.abs(target - this.h[k]) < 1e-4) continue;
        before.push([k, this.h[k], this.p[k]]);
        this.h[k] = target;
        this.p[k] = SETTLED;
        changed++;
      }
    }
    return {
      changed,
      restore: () => { for (const [k, z, prov] of before) { this.h[k] = z; this.p[k] = prov; } },
    };
  }
}

// ---------------------------------------------------------------------------
// CONFORMANCE — the theory's teeth.
//
// The invariant is not "the readers happen to agree today". It is "there is no
// second way to obtain a height". This enumerates every reader and requires
// them BIT-IDENTICAL, so that adding a display-only surface for performance —
// the exact temptation that produced Class A — fails here rather than in a
// screenshot three weeks later.
// ---------------------------------------------------------------------------

/**
 * @param {Ground} ground
 * @param {{name:string, heightAt:(x:number,y:number)=>number}[]} readers
 *        every module that believes it knows the height of the ground
 */
export function conformance(ground, readers = [], { samples = 4000, keep = 8 } = {}) {
  // Count every disagreement and keep the WORST, but store only a few examples.
  //
  // The first version of this stopped scanning after nine disagreements and
  // then reported "the worst" — which was merely the worst of the first nine.
  // It caught the historical bilinear bug and described it as 0.000 m out. A
  // truncated number presented as authoritative is the same failure this whole
  // theory is against, arriving inside the instrument built to detect it.
  const examples = [];
  let count = 0, worst = null;
  const note = (d) => {
    count++;
    if (!worst || d.by > worst.by) worst = d;
    if (examples.length < keep) examples.push(d);
  };
  const [x0, y0, x1, y1] = ground.bounds;
  const n = Math.max(2, Math.floor(Math.sqrt(samples)));

  // 1. the mesh must BE the height function, not resemble it
  for (const [a, b, c] of ground.triangles()) {
    for (const [u, v] of [[0.25, 0.25], [0.5, 0.25], [0.25, 0.5], [1 / 3, 1 / 3]]) {
      const x = a[0] + u * (b[0] - a[0]) + v * (c[0] - a[0]);
      const y = a[1] + u * (b[1] - a[1]) + v * (c[1] - a[1]);
      const onMesh = a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]);
      const asked = ground.heightAt(x, y);
      if (Math.abs(onMesh - asked) > 1e-6) {
        note({ reader: 'the drawn mesh', at: [x, y], drew: onMesh, said: asked, by: Math.abs(onMesh - asked) });
      }
    }
  }

  // 2. every other reader must return exactly what the ground returns.
  //
  // Sampled ADVERSARIALLY, not on a convenient grid. A regular grid can march
  // in step with the lattice and systematically miss the places where surfaces
  // part company — which for the bilinear-versus-planar disagreement is exactly
  // the cell centre, where the deviation is |twist|/4 and nowhere else is it
  // larger. A conformance check that samples where agreement is easiest is a
  // check that reports what it was built to hope.
  const probe = (x, y) => {
    const truth = ground.heightAt(x, y);
    for (const r of readers) {
      const theirs = r.heightAt(x, y);
      if (!(Math.abs(theirs - truth) <= 1e-6)) {
        note({ reader: r.name, at: [x, y], drew: theirs, said: truth, by: Math.abs(theirs - truth) });
      }
    }
  };
  if (readers.length) {
    // every cell centre, and the centroid of each of its two triangles
    for (let j = 0; j + 1 < ground.ny; j++) {
      for (let i = 0; i + 1 < ground.nx; i++) {
        const cx = ground.bounds[0] + (i + 0.5) * ground.cell;
        const cy = ground.bounds[1] + (j + 0.5) * ground.cell;
        probe(cx, cy);
        probe(ground.bounds[0] + (i + 2 / 3) * ground.cell, ground.bounds[1] + (j + 1 / 3) * ground.cell);
        probe(ground.bounds[0] + (i + 1 / 3) * ground.cell, ground.bounds[1] + (j + 2 / 3) * ground.cell);
      }
    }
    // and a plain grid as well, in case a reader is wrong somewhere unexpected
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        probe(x0 + ((x1 - x0) * i) / (n - 1), y0 + ((y1 - y0) * j) / (n - 1));
      }
    }
  }
  return {
    conforms: count === 0,
    disagreements: count,
    worst,
    examples,
    reads: count === 0
      ? 'one ground: every reader agrees exactly'
      : `${count} disagreements — "${worst.reader}" is ${worst.by.toFixed(3)} m out at `
        + `[${worst.at.map((v) => v.toFixed(0)).join(', ')}]. There is a second surface in this program.`,
  };
}
