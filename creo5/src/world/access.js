// ACCESS — the fifth question.
//
// The study asks the ground four things: how far you can see, which way, how
// flat it is, and what the earthwork costs. It never asks whether you can GET
// there, and that omission has history. The design package answered access with
// five switchbacks at 11% — derived honestly from an assumed 30% plane, and
// therefore fiction twice over: the plane was invented, and the parcel already
// carries a built drive whose deeded tail is the reason the boundary has a
// tail at all.
//
// So the drive is not drawn here. It is SEARCHED FOR, over the one Ground, with
// the grade limit as a hard constraint. Where the land offers a straight way,
// the search finds a straight way; where it does not, the path lengthens along
// the contours and turns back on itself — a switchback that appears in the
// result is one the land demanded, not one a plane implied. And where no way
// exists inside the limit, that is the answer, said plainly, because "you
// cannot drive to this site at 15%" is exactly the kind of fact a person
// should hear before they fall in love with a view.
//
// Nothing here is Henry-House-specific. From, to, a grade limit, a width:
// any building on any parcel with any network asks the same question.

import * as G from '../core/geom.js';

/** Closest point on the existing way network to a point, with its way. */
export function nearestOnNetwork(world, pt, kinds = new Set(['road', 'path'])) {
  let best = null;
  for (const e of world.entities()) {
    if (!kinds.has(e.type) || !Array.isArray(e.path) || e.path.length < 2) continue;
    for (let i = 1; i < e.path.length; i++) {
      const c = G.closestPointOnSeg(pt, e.path[i - 1], e.path[i]);
      if (!best || c.d < best.d) best = { p: c.point, d: c.d, entity: e, name: e.name || e.use || e.type };
    }
  }
  return best;
}

/**
 * Search for a drivable alignment from A to B over the real ground.
 *
 * A* on a corridor grid. An edge steeper than `maxGrade` does not cost more —
 * it does not exist, which is what a limit means. Gentle edges are preferred
 * quadratically, so the result hugs contours instead of flirting with the cap.
 *
 * @param {World} world
 * @param {number[]} from   [x, y] in the place's metres — usually on the network
 * @param {number[]} to     [x, y] — the gate the drive must reach
 * @param {object} opts
 * @param {number} opts.maxGrade   hard limit, rise/run (0.15 = 15%)
 * @param {number} opts.sustained  comfort limit reported against (0.12)
 * @param {number} opts.cell       search resolution in metres
 * @param {number[][]} opts.keepInside  optional ring the way must stay within
 */
export function planDrive(world, from, to, {
  maxGrade = 0.15, sustained = 0.12, cell = 0, width = 3.6, keepInside = null,
} = {}) {
  return search(world, { froms: [{ p: from, name: null }], to, maxGrade, sustained, cell, width, keepInside });
}

/**
 * The better question: not "from the nearest point" but FROM THE NETWORK.
 * Every existing way seeds the search at once, so the answer is the cheapest
 * feasible approach the place offers — and it names the way it left from.
 */
export function planAccess(world, to, {
  kinds = new Set(['road', 'path']), maxGrade = 0.15, sustained = 0.12,
  cell = 0, width = 3.6, keepInside = null, maxPops = 90000,
} = {}) {
  const froms = [];
  for (const e of world.entities()) {
    if (!kinds.has(e.type) || !Array.isArray(e.path) || e.path.length < 2) continue;
    for (let i = 1; i < e.path.length; i++) {
      const a = e.path[i - 1], b = e.path[i];
      const n = Math.max(1, Math.ceil(G.dist(a, b) / 25));
      for (let k = 0; k <= n; k++) froms.push({ p: G.lerp2(a, b, k / n), name: e.name || e.use || e.type });
    }
  }
  if (!froms.length) return { possible: false, reads: 'No way network exists in this place.' };
  return search(world, { froms, to, maxGrade, sustained, cell, width, keepInside, maxPops });
}

function search(world, { froms, to, maxGrade, sustained, cell, width, keepInside, maxPops = 90000 }) {
  const t = world.place.terrain;
  if (!t) throw new Error('there is no ground here to drive on');
  const g = (x, y) => world.place.groundAt(x, y);
  let nearestD = Infinity;
  for (const f of froms) nearestD = Math.min(nearestD, G.dist(f.p, to));
  const D = nearestD;
  if (!cell) cell = Math.max(4, Math.min(12, D / 70));

  // The corridor: wide enough that the way may wander, small enough to search.
  //
  // THE CORRIDOR IS SIZED BY THE PROBLEM, NOT BY THE MAP. It used to be the
  // bounding box of EVERY seed on every way, and this parcel's frontage is
  // US-321, whose centreline runs 23 km across the imported ground. So the box
  // came out 23.4 × 5.0 km, the coarsening rule below then forced a 107 m cell
  // whatever was asked for — 8× to 27× coarser — and every number downstream was
  // a fact about that grid rather than about the site:
  //
  //   · one cell was 11,533 m², so the whole 29-acre parcel was TEN CELLS. A
  //     switchback cannot be expressed in ten cells; `turns` came back 0 where
  //     the same search at 8 m finds 22.
  //   · `keepInside` stopped binding: its destination exemption is 2.5 cells,
  //     which became 268 m across a parcel 459 m wide. The drive reported as
  //     "413 m at 8%, inside the boundary" ran 285 m across the neighbour.
  //   · "a way already crosses here" is `length < 2 cells`, which became "within
  //     215 m of any way", so a house 6.8 m clear of a farm track was reported
  //     as standing in the road.
  //
  // A drive is not twenty kilometres long. Seeds further from the gate than any
  // drive could plausibly run are not candidates, and letting them set the scale
  // of the search was letting the map decide the resolution of the answer.
  const reach = Math.max(400, D * 3);
  const near = froms.filter((f) => G.dist(f.p, to) <= reach);
  const seeds = near.length ? near : froms;
  const pad = Math.max(60, D * 0.55);
  const xs = seeds.map((f) => f.p[0]).concat(to[0]), ys = seeds.map((f) => f.p[1]).concat(to[1]);
  const b = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad];
  // The grid must COVER the corridor. A silent cap that truncated coverage
  // turned reachable ground into a wall once; now the cell coarsens instead,
  // and says nothing false — a coarser search is still a search of everywhere.
  // It is REPORTED, because a resolution nobody was told about is how the above
  // went unnoticed: every number below is only as fine as this.
  const asked = cell;
  cell = Math.max(cell, (b[2] - b[0]) / 218, (b[3] - b[1]) / 218);
  const nx = Math.ceil((b[2] - b[0]) / cell) + 1;
  const ny = Math.ceil((b[3] - b[1]) / cell) + 1;
  const X = (i) => b[0] + i * cell, Y = (j) => b[1] + j * cell;
  const id = (i, j) => j * nx + i;
  const zs = new Float32Array(nx * ny);
  const ok = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = X(i), y = Y(j);
    zs[id(i, j)] = g(x, y);
    ok[id(i, j)] = keepInside && !G.pointInRing([x, y], keepInside)
      // the destination approach may leave the ring; the middle may not.
      // Seeds get their own exemption when they are planted below.
      && G.dist([x, y], to) > cell * 2.5 ? 0 : 1;
  }
  const goal = [Math.round((to[0] - b[0]) / cell), Math.round((to[1] - b[1]) / cell)];

  // THE GOAL CELL IS THE GATE, not the cell centre nearest it.
  //
  // The walk-back used to overwrite its last point with `to`, which replaced a
  // proven grid point with one the search had never checked: the final segment
  // carried whatever grade the ground happened to have there. Measured on this
  // parcel, a drive planned at a 10% cap reported 11.7%, all of it in that one
  // unchecked hop — the reported steepest grade contradicting the limit that
  // produced it, which is the one thing this search promises cannot happen.
  //
  // So the goal cell carries the GATE's height and the real run to it, and the
  // cap below covers the last hop like every other.
  const gid = id(goal[0], goal[1]);
  zs[gid] = g(to[0], to[1]);
  const goalRunFrom = (ci, cj) => Math.max(0.5, G.dist([X(ci), Y(cj)], to));

  // A*, 8-connected, grade-capped.
  const N8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
              [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
  const INF = Infinity;
  const gs = new Float64Array(nx * ny).fill(INF);
  const came = new Int32Array(nx * ny).fill(-1);
  const seedName = new Map();
  const open = [];
  for (const f of seeds) {
    const i = Math.round((f.p[0] - b[0]) / cell), j = Math.round((f.p[1] - b[1]) / cell);
    if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
    const k = id(i, j);
    ok[k] = 1;                                        // the doorstep is always standable
    if (gs[k] === INF) {
      gs[k] = 0;
      seedName.set(k, f.name);
      open.push([Math.hypot((goal[0] - i) * cell, (goal[1] - j) * cell), k]);
    }
  }
  let found = false, popped = 0;
  while (open.length) {
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (open[k][0] < open[bi][0]) bi = k;
    const [, cur] = open.splice(bi, 1)[0];
    if (cur === gid) { found = true; break; }
    if (++popped > maxPops) break;
    const ci = cur % nx, cj = (cur / nx) | 0, cz = zs[cur], cg = gs[cur];
    for (const [di, dj, m] of N8) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const k = id(i, j);
      if (!ok[k]) continue;
      const run = k === gid ? goalRunFrom(ci, cj) : m * cell;
      const grade = Math.abs(zs[k] - cz) / run;
      if (grade > maxGrade) continue;                       // the limit is a limit
      const w = run * (1 + 4 * (grade / maxGrade) ** 2);    // prefer gentle, quadratically
      const cand = cg + w;
      if (cand < gs[k]) {
        gs[k] = cand; came[k] = cur;
        open.push([cand + Math.hypot((goal[0] - i) * cell, (goal[1] - j) * cell), k]);
      }
    }
  }

  if (!found) {
    return {
      possible: false, to, maxGrade, cell, cellAsked: asked,
      reads: `No way from here to there stays inside ${Math.round(maxGrade * 100)}% on this ground, `
        + `searched at ${cell.toFixed(0)} m. `
        + `That is not a routing failure — it is a fact about the site, and the choices it leaves `
        + `are a steeper limit, a longer approach from elsewhere on the network, or a different site.`
        + (cell > asked * 1.5
          ? ` (The search asked for ${asked.toFixed(0)} m and got ${cell.toFixed(0)} m — a refusal at this `
            + `cell is coarse evidence, not a survey.)`
          : ''),
    };
  }

  // Walk back, simplify, soften. Chaikin twice keeps every point on or near
  // searched cells, so the smoothed way cannot quietly cross ground the search
  // never approved.
  let raw = [];
  let head = gid;
  for (let k = gid; k !== -1; k = came[k]) { raw.push([X(k % nx), Y((k / nx) | 0)]); head = k; }
  const fromName = seedName.get(head) || null;
  raw.reverse();
  // Exact, not a re-write: the goal cell already carries the gate's height and
  // the edge into it was capped over the real run to this point.
  raw[raw.length - 1] = to.slice();

  // THE GATE SHARES A CELL WITH THE NETWORK. The walk-back terminated at the
  // goal itself, so there is no searched path to measure — and reporting that as
  // "0 m of drive at 0%" states a certainty the search never established. What
  // is true is the distance to the way, so say that instead.
  if (raw.length < 2) {
    const n = nearestOnNetwork(world, to);
    const rise = n ? Math.abs(g(n.p[0], n.p[1]) - g(to[0], to[1])) : 0;
    return {
      possible: true, apron: true, to, fromName: n?.name || fromName, width, maxGrade, sustained,
      cell, cellAsked: asked,
      path: n ? [n.p.slice(), to.slice()] : [to.slice()],
      stations: n
        ? [{ p: n.p.slice(), s: 0, z: g(n.p[0], n.p[1]) }, { p: to.slice(), s: n.d, z: g(to[0], to[1]) }]
        : [{ p: to.slice(), s: 0, z: g(to[0], to[1]) }],
      length: n ? n.d : 0, rise,
      maxG: n && n.d > 0.5 ? rise / n.d : 0,
      overSustained: 0, turns: 0,
      reads: n
        ? `The gate stands ${n.d.toFixed(0)} m off ${n.name || 'a mapped way'} — one search cell (${cell.toFixed(0)} m), `
          + `so this is an apron rather than a drive. It is ${(rise / Math.max(0.5, n.d) * 100).toFixed(0)}% across those `
          + `${n.d.toFixed(0)} m; a finer search would be needed to call that a grade.`
        : `The gate is already on the network.`,
    };
  }

  // THE NUMBERS COME FROM THE SEARCHED PATH. Every edge of it was individually
  // proven ≤ maxGrade; smoothing is presentation and cuts corners across ground
  // the search never approved, so nothing is measured off it. This is why the
  // reported steepest grade can never contradict the limit that produced it.
  const rawStations = [{ p: raw[0], s: 0, z: g(raw[0][0], raw[0][1]) }];
  for (let i = 1; i < raw.length; i++) {
    rawStations.push({ p: raw[i],
      s: rawStations[i - 1].s + G.dist(raw[i - 1], raw[i]),
      z: g(raw[i][0], raw[i][1]) });
  }

  // The drawn way: softened once, then stationed, with heights carried over
  // from the raw profile by arc length so the bed follows proven grades.
  let path = raw.slice();
  for (let pass = 0; pass < 2; pass++) {
    const out = [path[0]];
    for (let i = 0; i < path.length - 1; i++) {
      out.push(G.lerp2(path[i], path[i + 1], 0.25), G.lerp2(path[i], path[i + 1], 0.75));
    }
    out.push(path[path.length - 1]);
    path = out;
  }
  const rawLen = rawStations[rawStations.length - 1].s;
  const zOnRaw = (frac) => {
    const sv = frac * rawLen;
    for (let i = 1; i < rawStations.length; i++) {
      if (rawStations[i].s >= sv) {
        const a = rawStations[i - 1], c = rawStations[i];
        return a.z + (c.z - a.z) * ((sv - a.s) / Math.max(1e-6, c.s - a.s));
      }
    }
    return rawStations[rawStations.length - 1].z;
  };
  const step = Math.max(3, cell * 0.7);
  let acc = 0, total = 0;
  for (let i = 1; i < path.length; i++) total += G.dist(path[i - 1], path[i]);
  const stations = [{ p: path[0], s: 0, z: rawStations[0].z }];
  for (let i = 1; i < path.length; i++) {
    acc += G.dist(path[i - 1], path[i]);
    if (acc - stations[stations.length - 1].s >= step || i === path.length - 1) {
      stations.push({ p: path[i], s: acc, z: zOnRaw(acc / Math.max(1e-6, total)) });
    }
  }
  // Grade is judged over a car length of travel, not between adjacent samples:
  // an 18 m window is what a drive climbing "at 12%" means on the ground.
  const WIN = 18;
  const zAtS = (sv) => {
    for (let i = 1; i < rawStations.length; i++) {
      if (rawStations[i].s >= sv) {
        const a = rawStations[i - 1], c = rawStations[i];
        return a.z + (c.z - a.z) * ((sv - a.s) / Math.max(1e-6, c.s - a.s));
      }
    }
    return rawStations[rawStations.length - 1].z;
  };
  let maxG = 0, overSustained = 0, turns = 0;
  for (let i = 1; i < rawStations.length; i++) {
    const run = rawStations[i].s - rawStations[i - 1].s;
    const s1 = Math.min(rawStations[i].s + WIN / 2, rawLen);
    const s0 = Math.max(0, s1 - WIN);
    const gr = Math.abs(zAtS(s1) - zAtS(s0)) / Math.max(1, s1 - s0);
    if (gr > maxG) maxG = gr;
    if (gr > sustained) overSustained += run;
    if (i > 1) {
      const a = G.sub(rawStations[i - 1].p, rawStations[i - 2].p), c = G.sub(rawStations[i].p, rawStations[i - 1].p);
      const ang = Math.acos(Math.max(-1, Math.min(1, G.dot(G.norm(a), G.norm(c)))));
      if (ang > Math.PI / 3) turns++;
    }
  }
  const length = rawLen;
  const rise = Math.abs(rawStations[rawStations.length - 1].z - rawStations[0].z);

  // THE WAY THAT GETS BUILT MUST BE THE WAY THAT WAS PROVEN.
  //
  // The comment above says smoothing is presentation and nothing is measured off
  // it — but `stations` is what `driveEntity` publishes as the road's path and
  // what `settleDriveBed` carves into the Ground, so it is not presentation at
  // all: it is the thing that gets built. And Chaikin cuts corners, which on a
  // switchback route removes a quarter of the length while the profile heights
  // are draped on by arc-length FRACTION — so the same rise is compressed into a
  // shorter run. Measured on this parcel: a plan reporting 19% over 704 m drew a
  // 519 m way reaching 31%. Two accounts of one road, disagreeing, in the module
  // whose whole promise is that the reported grade cannot contradict the limit.
  //
  // So: measure the drawn way, and where smoothing has changed it into something
  // the search never approved, publish the searched alignment instead. A blockier
  // line is a smaller price than a bed carved at half again the stated grade.
  let drawnMax = 0, drawnLen = 0;
  for (let i = 1; i < stations.length; i++) {
    const run = G.dist(stations[i - 1].p, stations[i].p);
    drawnLen += run;
    if (run > 0.5) drawnMax = Math.max(drawnMax, Math.abs(stations[i].z - stations[i - 1].z) / run);
  }
  // Length as well as grade. A softened line that is eight per cent shorter than
  // the one that was proven is still a different road, and `length` is the
  // number a client reads — smoothing is only presentation while it leaves the
  // measurements alone. Where it does not, the proven alignment is published.
  const smoothed = drawnMax <= maxGrade && Math.abs(drawnLen - rawLen) <= rawLen * 0.02;
  const outStations = smoothed ? stations : rawStations;

  // STANDING IN THE ROAD IS A FACT ABOUT THE CARRIAGEWAY, NOT ABOUT THE GRID.
  //
  // This was `length < cell * 2`, so it inherited whatever resolution the search
  // happened to run at — at a 107 m cell it meant "within 215 m of any way", and
  // four candidate sites 5 to 9 m from the centreline of a 4 m farm track were
  // reported as having the house IN the road and struck off. Six metres clear of
  // a service track is not a house in the road; it is a house with a short apron.
  //
  // So ask the geometry: does the gate lie within the mapped carriageway?
  const onWay = nearestOnNetwork(world, to);
  if (onWay && onWay.d <= (onWay.entity.width || 4) / 2) {
    return {
      possible: true, onNetwork: true, to, fromName: onWay.name, width, maxGrade, sustained,
      cell, cellAsked: asked,
      path: raw, stations: rawStations, length, rise: 0, maxG: 0, overSustained: 0, turns: 0,
      reads: `A mapped way (${onWay.name || 'unnamed'}) already passes through this spot — `
        + `${onWay.d.toFixed(1)} m from its centreline, inside a ${onWay.entity.width || 4} m carriageway. `
        + `There is no drive to build — and no house to build either, until the way is moved or the site is.`,
    };
  }
  return {
    possible: true, to, fromName, width, maxGrade, sustained,
    // The resolution every number below was measured at. A search cell nobody
    // was told about is how a 107 m grid passed for a driveway alignment.
    cell, cellAsked: asked,
    path: outStations.map((s) => s.p), stations: outStations,
    smoothed, drawnMax,
    length, rise, maxG, overSustained, turns,
    straightness: D / Math.max(D, length),
    reads: `A ${Math.round(length)} m way exists: ${rise.toFixed(1)} m of rise, `
      + `steepest ${(maxG * 100).toFixed(0)}%, ${Math.round(overSustained)} m over ${Math.round(sustained * 100)}%`
      + (turns ? `, ${turns} hard turn${turns > 1 ? 's' : ''} the land demanded` : ', no turn the land did not ask for')
      + `. The straight line is ${Math.round(D)} m; the ground charges ${Math.round(length - D)} m for the grade.`
      + ` Searched at ${cell.toFixed(0)} m.`
      + (smoothed ? '' : ` The softened line reached ${(drawnMax * 100).toFixed(0)}%, so the searched`
        + ` alignment is the one published — this way is drawn as it was proven, not as it would look best.`),
  };
}

/** The drive as an entity, in exactly the schema the imported ways use. */
export function driveEntity(plan, { name = 'The drive', id = 'drive-planned' } = {}) {
  if (!plan.possible) throw new Error('cannot commit a drive that does not exist');
  return {
    id, type: 'road', name,
    path: plan.path, width: plan.width,
    zBase: plan.stations[0].z, zTop: plan.stations[0].z + 0.05,
    network: 'streets', use: 'driveway', collision: 'none',
    epistemic: 'PROPOSED',
    sim: { permeability: 0.4, roughness: 0.02 },
    provenance: {
      author: 'CREO access', when: new Date().toISOString(),
      how: `searched over the ground at ≤${Math.round(plan.maxGrade * 100)}%; ${plan.reads}`,
    },
  };
}

/**
 * Settle the ground into a drive bed: level across the running surface,
 * battered back to natural at the shoulders. SETTLED, not measured — the
 * Ground records that this shape is a claim, exactly as seating does.
 */
export function settleDriveBed(world, plan, { shoulder = 1.0, batter = 0.5 } = {}) {
  if (!plan.possible) return { changed: 0, restore: () => {} };
  const half = plan.width / 2 + shoulder;
  const st = plan.stations;
  const bedAt = (x, y) => {                                  // nearest station height + distance
    let bd = Infinity, bz = 0;
    for (let i = 1; i < st.length; i++) {
      const c = G.closestPointOnSeg([x, y], st[i - 1].p, st[i].p);
      if (c.d < bd) { bd = c.d; bz = st[i - 1].z + (st[i].z - st[i - 1].z) * c.t; }
    }
    return { d: bd, z: bz };
  };
  const bb = G.bbox(plan.path);
  const reach = half + 8;
  const inside = (x, y) => x >= bb[0] - reach && x <= bb[2] + reach
                        && y >= bb[1] - reach && y <= bb[3] + reach;
  return world.place.terrain.settle(inside, (x, y, natural) => {
    const { d, z } = bedAt(x, y);
    if (d > reach) return null;
    if (d <= half) return z;
    const blended = z + (natural > z ? (d - half) * batter : -(d - half) * batter);
    return natural > z ? Math.min(natural, blended) : Math.max(natural, blended);
  });
}
