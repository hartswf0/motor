// PLACES (§36). CREO must not only feel intelligent in cities.
//
// Nine materially different places, all expressed in the same PlaceModel with the
// same interaction. Each is seeded deterministically so tests and demos reproduce
// exactly. Coordinates are metres on a local tangent plane anchored to real
// latitude/longitude, so any of them can be exported as GeoJSON.

import { Place, Heightfield, makeEntity } from '../core/place.js';
import { World } from '../core/world.js';
import * as G from '../core/geom.js';
import { stream } from '../core/rng.js';
import { routeAcross } from '../world/generate.js';

export const PLACES = [
  { key: 'settlement', name: 'Baba Dogo — dense settlement', scale: 'neighbourhood', anchor: [-1.2361, 36.8791] },
  { key: 'house',      name: 'One house — rooms and openings', scale: 'building',     anchor: [-1.2360, 36.8780] },
  { key: 'block',      name: 'City block', scale: 'district', anchor: [40.7128, -74.0060] },
  { key: 'school',     name: 'School and its yard', scale: 'campus', anchor: [-1.2900, 36.8200] },
  { key: 'rural',      name: 'Rural road and farms', scale: 'landscape', anchor: [-0.6000, 37.2000] },
  { key: 'forest',     name: 'Forest and clearing', scale: 'landscape', anchor: [45.5000, -122.6000] },
  { key: 'coast',      name: 'Coastline', scale: 'landscape', anchor: [-4.0400, 39.6700] },
  { key: 'field',      name: 'Empty field', scale: 'landscape', anchor: [52.3700, 4.9000] },
  { key: 'fiction',    name: 'A place that does not exist', scale: 'invented', anchor: [0, 0] },
];

export function buildPlace(key = 'settlement') {
  const def = PLACES.find((p) => p.key === key) || PLACES[0];

  const place = new Place({ id: def.key, name: def.name, anchor: def.anchor, seed: hash(def.key) });
  const rnd = stream(`terrain:${def.key}`, place.seed);
  const builders = { settlement, house, block, school, rural, forest, coast, field, fiction };
  const world = builders[def.key](place, rnd);
  world.reindex(true);
  return world;
}

const hash = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

// ---------------------------------------------------------------- terrain ---
function terrainFor(place, bounds, cell, fn) {
  const hf = new Heightfield(bounds, cell);
  for (let j = 0; j < hf.ny; j++) {
    for (let i = 0; i < hf.nx; i++) {
      const x = bounds[0] + i * cell, y = bounds[1] + j * cell;
      hf.data[hf.idx(i, j)] = fn(x, y);
    }
  }
  place.terrain = hf;
  return hf;
}

function smoothNoise(rnd, octaves = 3) {
  const grids = [];
  for (let o = 0; o < octaves; o++) {
    const n = 4 << o;
    const g = new Float32Array(n * n);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    grids.push({ n, g });
  }
  return (u, v) => {
    let sum = 0, amp = 1, norm = 0;
    for (const { n, g } of grids) {
      const x = u * (n - 1), y = v * (n - 1);
      const i = Math.max(0, Math.min(n - 2, Math.floor(x))), j = Math.max(0, Math.min(n - 2, Math.floor(y)));
      const tx = x - i, ty = y - j;
      const s = (t) => t * t * (3 - 2 * t);
      const a = g[j * n + i], b = g[j * n + i + 1], c = g[(j + 1) * n + i], d = g[(j + 1) * n + i + 1];
      const v1 = a + (b - a) * s(tx), v2 = c + (d - c) * s(tx);
      sum += (v1 + (v2 - v1) * s(ty)) * amp;
      norm += amp;
      amp *= 0.45;
    }
    return sum / norm;
  };
}

// ------------------------------------------------------------- helpers ------
function add(world, spec) {
  const e = makeEntity({ id: spec.id || world.place.newId(spec.type), source: 'seed', epistemic: spec.epistemic || 'IMPORTED', ...spec });
  world.place.put(e, 'AS_IS');
  return e;
}

function structure(world, cx, cy, w, d, angle, h, extra = {}) {
  const ring = G.rectRing(cx, cy, w, d, angle);
  const z = world.place.groundAt(cx, cy);
  return add(world, {
    type: 'structure', footprint: ring, zBase: z, zTop: z + h,
    material: 'block', collision: 'solid', sim: { permeability: 0, roughness: 0.02 },
    ...extra,
  });
}

function line(world, type, pts, width, extra = {}) {
  const z = world.place.groundAt(pts[0][0], pts[0][1]);
  return add(world, {
    type, path: pts, width, zBase: z, zTop: z + (type === 'drain' ? 0 : 0.05),
    network: type === 'drain' ? 'drainage' : (type === 'road' ? 'streets' : 'paths'),
    collision: 'none', sim: { permeability: type === 'drain' ? 0.05 : 0.2, roughness: 0.02, capacity: type === 'drain' ? width * 0.8 : 0 },
    ...extra,
  });
}

function trees(world, region, n, seedName, minGap = 4) {
  const rnd = stream(seedName, world.place.seed);
  const bb = G.bbox(region);
  const placed = [];
  let guard = 0;
  while (placed.length < n && guard++ < n * 200) {
    const x = bb[0] + rnd() * (bb[2] - bb[0]);
    const y = bb[1] + rnd() * (bb[3] - bb[1]);
    if (!G.pointInRing([x, y], region)) continue;
    if (placed.some((p) => G.dist(p, [x, y]) < minGap)) continue;
    const r = 2 + rnd() * 2;
    const z = world.place.groundAt(x, y);
    add(world, {
      type: 'tree', name: 'Tree', footprint: G.circleRing(x, y, r, 12),
      zBase: z, zTop: z + 5 + rnd() * 5, collision: 'soft',
      sim: { canopy: Math.PI * r * r, permeability: 0.7 }, props: { canopyRadius: r },
    });
    placed.push([x, y]);
  }
  return placed;
}

/** Windows as real entities with an outward normal — "don't block those windows" needs them. */
function windowsOn(world, host, sides = [0, 2], perSide = 2) {
  const ring = world.place.ringOf(host);
  const out = [];
  for (const s of sides) {
    const a = ring[s % ring.length], b = ring[(s + 1) % ring.length];
    const dir = G.norm(G.sub(b, a));
    const n = G.norm(G.perp(dir));
    const outward = pointsOutward(ring, G.lerp2(a, b, 0.5), n) ? n : G.mul(n, -1);
    for (let k = 1; k <= perSide; k++) {
      const t = k / (perSide + 1);
      const c = G.lerp2(a, b, t);
      const w = 1.1;
      const wr = [
        [c[0] - dir[0] * w / 2, c[1] - dir[1] * w / 2],
        [c[0] + dir[0] * w / 2, c[1] + dir[1] * w / 2],
        [c[0] + dir[0] * w / 2 + outward[0] * 0.15, c[1] + dir[1] * w / 2 + outward[1] * 0.15],
        [c[0] - dir[0] * w / 2 + outward[0] * 0.15, c[1] - dir[1] * w / 2 + outward[1] * 0.15],
      ];
      out.push(add(world, {
        type: 'opening', subtype: 'window', name: `Window`, footprint: wr,
        zBase: host.zTop - 1.6, zTop: host.zTop - 0.4, parent: host.id, collision: 'none',
        props: { normal: outward, width: w },
      }));
    }
  }
  return out;
}

function pointsOutward(ring, from, n) {
  const probe = [from[0] + n[0] * 0.4, from[1] + n[1] * 0.4];
  return !G.pointInRing(probe, ring);
}

// =============================================================== settlement ==
function settlement(place, rnd) {
  const B = [-90, -70, 90, 70];
  const noise = smoothNoise(rnd, 3);
  // A shallow bowl draining east into a channel: the reason this place floods.
  terrainFor(place, B, 2, (x, y) => {
    const u = (x - B[0]) / (B[2] - B[0]), v = (y - B[1]) / (B[3] - B[1]);
    const bowl = 0.9 * Math.exp(-(((x + 18) ** 2) / 900 + ((y - 6) ** 2) / 700));
    const fall = (B[2] - x) / (B[2] - B[0]) * 1.8;
    return 3.2 + fall - bowl * 1.6 + noise(u, v) * 0.5;
  });
  const world = new World(place);
  place.landmarks.set('river', [86, 10]);
  place.landmarks.set('main road', [0, -58]);

  // main road along the south, lane north, channel east
  line(world, 'road', [[-88, -56], [-20, -54], [30, -52], [88, -50]], 7, { name: 'Baba Dogo Road', use: 'through traffic' });
  line(world, 'road', [[-60, -53], [-58, -10], [-56, 34]], 5, { name: 'Side lane' });
  add(world, {
    type: 'stream', name: 'Drainage channel', network: 'drainage',
    path: [[84, -46], [86, 0], [88, 44]], width: 5,
    zBase: 1.2, zTop: 2.2, collision: 'none', sim: { capacity: 4, permeability: 0.1 },
  });
  line(world, 'drain', [[30, -50], [46, -34], [62, -20], [80, -6]], 1.2, { name: 'Roadside drain', props: { depth: 0.8 } });

  // rows of houses with real gaps between them
  const rows = [
    { y: -34, n: 9, x0: -76, gap: 15, d: 7, h: 3.0 },
    { y: -16, n: 9, x0: -72, gap: 15, d: 7, h: 3.2 },
    { y: 4,   n: 8, x0: -66, gap: 16, d: 8, h: 3.4 },
    { y: 24,  n: 8, x0: -70, gap: 16, d: 7, h: 3.0 },
    { y: 44,  n: 7, x0: -62, gap: 17, d: 7, h: 3.1 },
  ];
  let houseIdx = 0;
  const houses = [];
  for (const r of rows) {
    for (let i = 0; i < r.n; i++) {
      const x = r.x0 + i * r.gap + (rnd() - 0.5) * 2.2;
      const y = r.y + (rnd() - 0.5) * 2.0;
      const w = 8 + rnd() * 3;
      const s = structure(world, x, y, w, r.d, (rnd() - 0.5) * 0.08, r.h + rnd() * 0.5, {
        name: `House ${++houseIdx}`, use: 'dwelling', material: rnd() > 0.5 ? 'iron sheet' : 'block',
      });
      houses.push(s);
    }
    // the lane between rows — the paths people actually use
    line(world, 'path', [[-80, r.y + 9], [-20, r.y + 10], [40, r.y + 9], [80, r.y + 8]], 2.2, { name: `Lane ${r.y}` });
  }
  // Cross paths are routed by the same A* the design tools use, so they weave
  // between the houses instead of being drawn through them.
  for (const x of [-40, 0, 40]) {
    const pts = routeAcross(world, [x, -52], [x + 1, 56], { cell: 2.5 });
    line(world, 'path', pts, 1.8, { name: `Cross path ${x}` });
  }

  // the low ground that floods, as an unbuilt surface
  add(world, {
    type: 'surface', subtype: 'open ground', name: 'Open ground',
    footprint: G.circleRing(-18, 6, 16, 20), zBase: place.groundAt(-18, 6) - 0.05, zTop: place.groundAt(-18, 6),
    collision: 'none', sim: { permeability: 0.25, roughness: 0.05 }, use: 'informal market on Saturdays',
  });
  for (let i = 0; i < 6; i++) {
    structure(world, -34 + i * 5.5, -44 + (i % 2) * 2, 3, 2.4, 0, 2.4, { type: 'market', name: `Stall ${i + 1}`, use: 'trade' });
  }
  trees(world, G.circleRing(46, 26, 26, 16), 14, 'settlement:trees', 6);
  trees(world, G.rectRing(-70, 50, 40, 20, 0), 6, 'settlement:trees2', 6);

  // windows on a few houses, so daylight can be argued about
  for (const h of [houses[13], houses[14], houses[22]]) if (h) windowsOn(world, h, [0, 2], 2);

  // a claim that contradicts the imported data (§18)
  const lane = world.entities().find((e) => e.name === 'Cross path 0');
  if (lane) {
    add(world, {
      type: 'observation', name: 'This has not been passable for two years',
      footprint: G.circleRing(1, 20, 5, 16), zBase: place.groundAt(1, 20), zTop: place.groundAt(1, 20) + 0.02,
      collision: 'none', epistemic: 'DISPUTED', author: 'Joseph', certainty: 0.9,
      evidence: [{ kind: 'utterance', text: 'that hasn’t been passable for years', lang: 'en' }],
      props: { about: [lane.id], condition: 'movement' },
    });
    place.relations.push({ from: 'Joseph', kind: 'disputedBy', to: lane.id, derived: false });
  }
  return world;
}

// ===================================================================== house ==
function house(place, rnd) {
  const B = [-14, -12, 14, 12];
  terrainFor(place, B, 1, () => 0);
  const world = new World(place);
  const shell = structure(world, 0, 0, 12, 9, 0, 3.0, { name: 'House', use: 'dwelling' });
  const rooms = [
    { n: 'Main room', x: -2.6, y: 1.4, w: 6.4, d: 5.6 },
    { n: 'Kitchen',   x: 3.6,  y: 2.2, w: 4.2, d: 4.0 },
    { n: 'Bedroom',   x: 3.4,  y: -2.6, w: 4.6, d: 3.6 },
    { n: 'Store',     x: -3.8, y: -3.0, w: 3.6, d: 2.8 },
  ];
  for (const r of rooms) {
    add(world, {
      type: 'room', name: r.n, footprint: G.rectRing(r.x, r.y, r.w, r.d, 0),
      zBase: 0.05, zTop: 2.7, parent: shell.id, collision: 'none', use: r.n.toLowerCase(),
    });
  }
  add(world, { type: 'wall', name: 'Partition', footprint: G.rectRing(0.9, 0, 0.2, 8.4, 0), zBase: 0, zTop: 2.7, parent: shell.id, collision: 'solid' });
  windowsOn(world, shell, [0, 1, 2], 2);
  add(world, { type: 'opening', subtype: 'door', name: 'Front door', footprint: G.rectRing(-4, -4.5, 1.0, 0.25, 0), zBase: 0, zTop: 2.1, parent: shell.id, collision: 'none', props: { normal: [0, -1], width: 1.0 } });
  for (const f of [
    { n: 'Table', x: -2.4, y: 1.2, w: 1.6, d: 0.9, h: 0.75 },
    { n: 'Bed', x: 3.4, y: -2.6, w: 1.9, d: 1.4, h: 0.5 },
    { n: 'Stove', x: 4.8, y: 3.4, w: 0.7, d: 0.6, h: 0.9 },
  ]) {
    add(world, { type: 'furniture', name: f.n, footprint: G.rectRing(f.x, f.y, f.w, f.d, 0), zBase: 0.05, zTop: 0.05 + f.h, collision: 'soft', parent: shell.id });
  }
  line(world, 'path', [[-4, -6], [-4, -11]], 1.1, { name: 'Front path' });
  trees(world, G.circleRing(8, -7, 4, 12), 2, 'house:trees', 3);
  return world;
}

// ==================================================================== block ==
function block(place, rnd) {
  const B = [-120, -100, 120, 100];
  const noise = smoothNoise(rnd, 2);
  terrainFor(place, B, 3, (x, y) => 8 + noise((x - B[0]) / 240, (y - B[1]) / 200) * 1.2 - x * 0.004);
  const world = new World(place);
  place.landmarks.set('avenue', [0, -92]);
  for (const y of [-92, -20, 52]) line(world, 'road', [[-118, y], [0, y + 2], [118, y]], 12, { name: `Street ${y}`, use: 'traffic' });
  for (const x of [-96, -30, 36, 100]) line(world, 'road', [[x, -98], [x + 2, 0], [x, 98]], 9, { name: `Avenue ${x}` });
  let n = 0;
  for (const [cx, cy] of [[-63, -56], [3, -56], [68, -56], [-63, 16], [3, 16], [68, 16], [-63, 76], [3, 76]]) {
    const w = 44 + rnd() * 10, d = 40 + rnd() * 8;
    const s = structure(world, cx, cy, w, d, 0, 12 + rnd() * 28, { name: `Block ${++n}`, use: n % 3 === 0 ? 'commercial' : 'residential' });
    add(world, { type: 'parcel', name: `Parcel ${n}`, footprint: G.rectRing(cx, cy, w + 8, d + 8, 0), zBase: 0, zTop: 0.01, collision: 'none', props: { airspace: true, airspaceLimit: 45 } });
    if (n <= 2) windowsOn(world, s, [0, 2], 3);
  }
  for (const y of [-84, -12, 60]) line(world, 'path', [[-116, y], [116, y - 1]], 3.5, { name: `Sidewalk ${y}` });
  trees(world, G.rectRing(0, -84, 220, 6, 0), 18, 'block:trees', 9);
  return world;
}

// =================================================================== school ==
function school(place, rnd) {
  const B = [-70, -60, 70, 60];
  const noise = smoothNoise(rnd, 2);
  terrainFor(place, B, 2, (x, y) => 2 + noise((x + 70) / 140, (y + 60) / 120) * 0.8 + y * 0.006);
  const world = new World(place);
  for (let i = 0; i < 3; i++) {
    const s = structure(world, -34 + i * 26, 28, 22, 9, 0, 3.6, { name: `Classroom block ${i + 1}`, use: 'teaching' });
    windowsOn(world, s, [0, 2], 3);
  }
  structure(world, 34, -4, 14, 10, 0, 4.2, { name: 'Hall', use: 'assembly' });
  add(world, { type: 'surface', subtype: 'yard', name: 'Yard', footprint: G.rectRing(-8, -18, 78, 40, 0), zBase: 1.6, zTop: 1.62, collision: 'none', sim: { permeability: 0.15, roughness: 0.03 }, use: 'play' });
  line(world, 'road', [[-68, -52], [68, -50]], 7, { name: 'School road' });
  line(world, 'path', [[-34, 22], [-30, -6], [-28, -46]], 2.2, { name: 'Main walk' });
  line(world, 'path', [[-14, 22], [10, 0], [34, -10]], 1.6, { name: 'Yard path' });
  line(world, 'drain', [[-60, -40], [-20, -44], [30, -47], [66, -49]], 0.9, { name: 'Yard drain', props: { depth: 0.6 } });
  trees(world, G.rectRing(0, -44, 100, 10, 0), 10, 'school:trees', 7);
  return world;
}

// ==================================================================== rural ==
function rural(place, rnd) {
  const B = [-200, -160, 200, 160];
  const noise = smoothNoise(rnd, 3);
  terrainFor(place, B, 5, (x, y) => 40 + noise((x + 200) / 400, (y + 160) / 320) * 14 - Math.abs(y + 40) * 0.02);
  const world = new World(place);
  place.landmarks.set('river', [0, -140]);
  line(world, 'road', [[-198, 30], [-60, 12], [70, -8], [198, -26]], 6, { name: 'Rural road', material: 'murram' });
  add(world, { type: 'stream', name: 'River', network: 'drainage', path: [[-198, -140], [-40, -128], [90, -136], [198, -150]], width: 12, zBase: 20, zTop: 22, collision: 'none', sim: { capacity: 12 } });
  for (let i = 0; i < 5; i++) {
    const x = -150 + i * 70 + rnd() * 20, y = 60 + rnd() * 50;
    structure(world, x, y, 10, 8, rnd() * 0.4, 3.2, { name: `Farmhouse ${i + 1}`, use: 'dwelling' });
    add(world, { type: 'parcel', name: `Field ${i + 1}`, footprint: G.rectRing(x, y - 46, 62, 62, 0), zBase: 0, zTop: 0.01, collision: 'none', use: 'cultivation' });
    line(world, 'path', [[x, y - 6], [x + 4, 20]], 2.5, { name: `Farm track ${i + 1}` });
  }
  trees(world, G.rectRing(-40, -100, 260, 40, 0), 26, 'rural:trees', 12);
  return world;
}

// =================================================================== forest ==
function forest(place, rnd) {
  const B = [-120, -120, 120, 120];
  const noise = smoothNoise(rnd, 4);
  terrainFor(place, B, 3, (x, y) => 200 + noise((x + 120) / 240, (y + 120) / 240) * 26 - Math.hypot(x + 30, y - 20) * 0.05);
  const world = new World(place);
  place.landmarks.set('creek', [-30, 100]);
  add(world, { type: 'stream', name: 'Creek', network: 'drainage', path: [[-100, 108], [-30, 96], [40, 104], [110, 92]], width: 3, zBase: 196, zTop: 197, collision: 'none', sim: { capacity: 2.5 } });
  line(world, 'path', [[-110, -60], [-40, -20], [20, 20], [90, 70]], 1.2, { name: 'Trail', material: 'dirt' });
  add(world, { type: 'surface', subtype: 'clearing', name: 'Clearing', footprint: G.circleRing(-30, 20, 26, 24), zBase: 198, zTop: 198.02, collision: 'none', sim: { permeability: 0.8, roughness: 0.4 } });
  trees(world, G.rectRing(0, 0, 230, 230, 0), 130, 'forest:trees', 8);
  structure(world, -28, 18, 4, 3, 0.3, 2.4, { name: 'Shelter', material: 'timber', use: 'shelter' });
  return world;
}

// ==================================================================== coast ==
function coast(place, rnd) {
  const B = [-160, -120, 160, 120];
  const noise = smoothNoise(rnd, 3);
  terrainFor(place, B, 3, (x, y) => {
    const shore = y * 0.06 + Math.sin(x / 40) * 3;
    return Math.max(-2, shore + noise((x + 160) / 320, (y + 120) / 240) * 2.4);
  });
  const world = new World(place);
  place.landmarks.set('sea', [0, -110]);
  add(world, { type: 'water', name: 'Sea', footprint: [[-160, -120], [160, -120], [160, -34], [-160, -46]], zBase: -2, zTop: 0, collision: 'none', sim: { capacity: 999 } });
  line(world, 'road', [[-158, 44], [0, 36], [158, 42]], 6, { name: 'Coast road' });
  line(world, 'path', [[-120, 8], [-20, -2], [90, 6]], 1.6, { name: 'Beach path' });
  for (let i = 0; i < 7; i++) {
    const x = -120 + i * 38 + rnd() * 10;
    structure(world, x, 58 + rnd() * 16, 9, 7, rnd() * 0.3, 3.2, { name: `Beach house ${i + 1}`, use: 'dwelling' });
  }
  trees(world, G.rectRing(0, 20, 280, 26, 0), 22, 'coast:trees', 10);
  return world;
}

// ==================================================================== field ==
function field(place, rnd) {
  const B = [-80, -80, 80, 80];
  const noise = smoothNoise(rnd, 2);
  terrainFor(place, B, 3, (x, y) => 12 + noise((x + 80) / 160, (y + 80) / 160) * 1.4 - y * 0.01);
  const world = new World(place);
  line(world, 'road', [[-78, -72], [78, -70]], 5, { name: 'Field road' });
  add(world, { type: 'parcel', name: 'The field', footprint: G.rectRing(0, 4, 140, 120, 0), zBase: 0, zTop: 0.01, collision: 'none', use: 'unbuilt' });
  trees(world, G.circleRing(-58, 56, 10, 14), 3, 'field:trees', 6);
  return world;
}

// ================================================================== fiction ==
function fiction(place, rnd) {
  const B = [-100, -100, 100, 100];
  const noise = smoothNoise(rnd, 4);
  terrainFor(place, B, 2.5, (x, y) => {
    const r = Math.hypot(x, y);
    return 20 + Math.sin(r / 9) * 4 * Math.exp(-r / 90) + noise((x + 100) / 200, (y + 100) / 200) * 6;
  });
  const world = new World(place);
  place.landmarks.set('the well', [0, 0]);
  add(world, { type: 'water', name: 'The well', footprint: G.circleRing(0, 0, 6, 24), zBase: 14, zTop: 18, collision: 'none', sim: { capacity: 20 } });
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const r = 34 + (i % 3) * 12;
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    structure(world, x, y, 7 + (i % 3) * 2, 7, a, 4 + (i % 4) * 2.5, { name: `Tower ${i + 1}`, material: 'stone', use: 'unknown' });
    line(world, 'path', [[Math.cos(a) * 8, Math.sin(a) * 8], [x, y]], 1.6, { name: `Spoke ${i + 1}` });
  }
  add(world, { type: 'path', name: 'Ring walk', network: 'paths', path: G.circleRing(0, 0, 46, 28).concat([G.circleRing(0, 0, 46, 28)[0]]), width: 2, zBase: place.groundAt(46, 0), zTop: place.groundAt(46, 0) + 0.05, collision: 'none' });
  trees(world, G.circleRing(0, 0, 90, 24), 30, 'fiction:trees', 9);
  return world;
}
