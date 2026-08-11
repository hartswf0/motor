// A BODY — architecture at building scale, brought into a place.
//
// The temptation is to load a model and put a mesh in the world. That would
// break everything CREO does. A mesh is opaque: it cannot say what it stands
// on, what it blocks, where you walk in, or what happens to the water. The
// certificate would have nothing to check and the place would have gained a
// picture rather than a building.
//
// So a body is a CONTRACT, and the mesh is only its appearance:
//
//   footprint   what it occupies on the ground — the thing collision, water,
//               movement and the certificate all reason about
//   datum       which height in the model is its ground floor, so it can be
//               seated on real ground rather than floated at an arbitrary z
//   height      how far it stands above that floor
//   entrances   where it is entered, so a way can be made to reach it
//
// Everything else — a GLB, a procedural module, a box — supplies that contract
// and may then draw itself however it likes. A body whose appearance fails to
// load is still a building; a body without a footprint is not one.

import * as G from '../core/geom.js';

/**
 * @typedef {object} Body
 * @property {string} id
 * @property {string} name
 * @property {number[][]} footprint  ring in metres, origin at the body's own centre
 * @property {number} height         above the finished floor
 * @property {number} datum          height in the SOURCE model that is the ground floor
 * @property {number[][]} entrances  points on or near the footprint
 * @property {object} appearance     how to draw it: {kind:'glb', url} | {kind:'prism'}
 * @property {object} source         where it came from, for provenance
 */

/** A body from nothing but dimensions — the honest fallback, and useful alone. */
export function boxBody({ id = 'box', name = 'Building', width = 8, depth = 6, height = 3 }) {
  const w = width / 2, d = depth / 2;
  return {
    id,
    name,
    footprint: [[-w, -d], [w, -d], [w, d], [-w, d]],
    height,
    datum: 0,
    entrances: [[0, -d]],
    appearance: { kind: 'prism' },
    source: { kind: 'dimensions', width, depth, height },
  };
}

// ------------------------------------------------------------------- glTF ---
// A minimal, dependency-free reader for glTF 2.0 binary. It reads only what a
// contract needs — vertex positions, through the node hierarchy — and ignores
// materials, animations, skins and textures entirely. That is the whole point:
// CREO does not need to understand a model to seat it, only to know the ground
// it covers and the air it fills.

const GLB_MAGIC = 0x46546c67;          // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/**
 * @param {ArrayBuffer} buffer  the .glb file
 * @returns {{positions:Float64Array, count:number, json:object}}
 */
export function readGLB(buffer) {
  const dv = new DataView(buffer);
  if (dv.byteLength < 12 || dv.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error('not a .glb file');
  }
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`glTF version ${version} is not supported — this reads glTF 2.0`);

  let json = null, bin = null;
  let at = 12;
  while (at + 8 <= dv.byteLength) {
    const len = dv.getUint32(at, true);
    const type = dv.getUint32(at + 4, true);
    const start = at + 8;
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, len)));
    else if (type === CHUNK_BIN) bin = new Uint8Array(buffer, start, len);
    at = start + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error('this .glb has no JSON chunk');

  const points = [];
  const scene = json.scenes?.[json.scene ?? 0];
  const roots = scene?.nodes ?? json.nodes?.map((_, i) => i) ?? [];
  for (const n of roots) walkNode(json, bin, n, IDENTITY, points);
  if (!points.length) throw new Error('this model has no geometry to measure');

  return { points, json };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function walkNode(json, bin, index, parent, out) {
  const node = json.nodes?.[index];
  if (!node) return;
  const local = node.matrix ? node.matrix : trs(node);
  const world = multiply(parent, local);
  if (node.mesh !== undefined) {
    for (const prim of json.meshes[node.mesh]?.primitives || []) {
      const acc = prim.attributes?.POSITION;
      if (acc === undefined) continue;
      readPositions(json, bin, acc, world, out);
    }
  }
  for (const child of node.children || []) walkNode(json, bin, child, world, out);
}

function trs(node) {
  const t = node.translation || [0, 0, 0];
  const r = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  const [x, y, z, w] = r;
  const m = [
    (1 - 2 * (y * y + z * z)) * s[0], (2 * (x * y + z * w)) * s[0], (2 * (x * z - y * w)) * s[0], 0,
    (2 * (x * y - z * w)) * s[1], (1 - 2 * (x * x + z * z)) * s[1], (2 * (y * z + x * w)) * s[1], 0,
    (2 * (x * z + y * w)) * s[2], (2 * (y * z - x * w)) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
  return m;
}

function multiply(a, b) {
  const o = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      for (let k = 0; k < 4; k++) o[i * 4 + j] += b[i * 4 + k] * a[k * 4 + j];
    }
  }
  return o;
}

const COMPONENT = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function readPositions(json, bin, accessorIndex, world, out) {
  const acc = json.accessors[accessorIndex];
  if (!acc || acc.type !== 'VEC3') return;
  if (acc.componentType !== 5126) return;          // positions are floats in practice
  const view = json.bufferViews[acc.bufferView];
  if (!view || !bin) return;
  const stride = view.byteStride || 3 * COMPONENT[acc.componentType];
  const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  for (let i = 0; i < acc.count; i++) {
    const o = base + i * stride;
    if (o + 12 > dv.byteLength) break;
    const x = dv.getFloat32(o, true);
    const y = dv.getFloat32(o + 4, true);
    const z = dv.getFloat32(o + 8, true);
    // glTF is Y-up and right-handed; CREO is Z-up, with Y north
    const wx = world[0] * x + world[4] * y + world[8] * z + world[12];
    const wy = world[1] * x + world[5] * y + world[9] * z + world[13];
    const wz = world[2] * x + world[6] * y + world[10] * z + world[14];
    out.push([wx, -wz, wy]);
  }
}

/**
 * Turn a model into a contract.
 *
 * The footprint is the convex hull of everything low enough to be structure
 * rather than roof — an overhanging eave should not enlarge the ground a
 * building is judged to occupy, and a hull of every vertex would make a
 * pitched roof into a bigger house than it is.
 */
export function bodyFromModel(points, { id, name = 'Model', url = null, skirt = 0.6 } = {}) {
  let lo = Infinity, hi = -Infinity;
  for (const p of points) { if (p[2] < lo) lo = p[2]; if (p[2] > hi) hi = p[2]; }
  const height = hi - lo;
  // the lowest tenth is what meets the ground: that is what it stands on
  const cut = lo + Math.max(0.4, height * 0.1);
  const low = points.filter((p) => p[2] <= cut).map((p) => [p[0], p[1]]);
  const ring = G.convexHull(low.length >= 3 ? low : points.map((p) => [p[0], p[1]]));
  if (!ring || ring.length < 3) throw new Error('this model has no footprint to sit on');

  // centre it on its own footprint, so "here" means the middle of the building
  const c = G.centroid(ring);
  const footprint = ring.map((p) => [p[0] - c[0], p[1] - c[1]]);

  return {
    id: id || `model-${Math.abs(hashOf(url || name))}`,
    name,
    footprint,
    height,
    datum: lo,
    // the mid-point of the longest edge, as a first guess at the way in
    entrances: [longestEdgeMid(footprint)],
    appearance: { kind: url ? 'glb' : 'points', url, offset: [-c[0], -c[1], -lo] },
    source: { kind: 'glb', url, vertices: points.length, raw: { lo, hi } },
  };
}

function longestEdgeMid(ring) {
  let best = 0, at = [0, 0];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const d = G.dist(a, b);
    if (d > best) { best = d; at = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
  }
  return at;
}

function hashOf(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619); }
  return h | 0;
}

/** Where a body's footprint lands, once placed at a point and turned. */
export function footprintAt(body, at, rotation = 0) {
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  return body.footprint.map(([x, y]) => [
    at[0] + x * cos - y * sin,
    at[1] + x * sin + y * cos,
  ]);
}

/** The same, for the entrances. */
export function entrancesAt(body, at, rotation = 0) {
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  return (body.entrances || []).map(([x, y]) => [
    at[0] + x * cos - y * sin,
    at[1] + x * sin + y * cos,
  ]);
}
