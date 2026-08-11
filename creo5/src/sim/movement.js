// MOVEMENT (§20). Routing, reachability and obstruction on the real network.
//
// A road or path here is not decoration: it is a graph built from the actual
// geometry, and a proposal that lands on it really does disconnect the places
// it used to join. That is what makes BLOCKS_ACCESS a fact rather than a mood.

import * as G from '../core/geom.js';

const NETWORK_TYPES = new Set(['road', 'path', 'drain', 'bridge', 'stream']);
const SNAP = 2.6;      // metres — two network samples this close are one junction

/** Build a walkable graph from the branch's network entities. */
export function buildGraph(world, { include = ['road', 'path', 'bridge'], blockers = null } = {}) {
  const nodes = [];      // {p:[x,y], z, ownerId}
  const edges = [];      // {a, b, w, ownerId}
  const byOwner = new Map();

  const solids = (blockers || world.entities().filter((e) => e.collision === 'solid' && e.type !== 'terrain'))
    .map((e) => ({ id: e.id, ring: world.ringOf(e), zBase: e.zBase, zTop: e.zTop }))
    .filter((s) => s.ring);

  for (const e of world.entities()) {
    if (!include.includes(e.type)) continue;
    const line = e.path || spineOf(world.ringOf(e));
    if (!line || line.length < 2) continue;
    const pts = G.resample(line, 2.2);
    const ids = [];
    for (const p of pts) {
      // Ground-level networks follow the terrain; only a deck carries its own
      // height. Using the entity's zBase everywhere made two lanes that plainly
      // cross fail to form a junction on sloping ground.
      const z = e.type === 'bridge' ? e.zBase : world.place.groundAt(p[0], p[1]);
      ids.push(nodes.push({ p, z, ownerId: e.id }) - 1);
    }
    byOwner.set(e.id, ids);
    for (let i = 0; i < ids.length - 1; i++) {
      const a = nodes[ids[i]], b = nodes[ids[i + 1]];
      const seg = [a.p, b.p];
      const blockedBy = solids.find((s) =>
        Math.abs(s.zBase - a.z) < 2.2 && s.zTop > a.z && G.polylineCrossesRing(seg, s.ring));
      edges.push({ a: ids[i], b: ids[i + 1], w: G.dist(a.p, b.p), ownerId: e.id, blockedBy: blockedBy?.id || null });
    }
  }

  // Junctions: two networks meet where their surfaces meet, not only where their
  // centrelines happen to sample close together. A 1.8 m lane touching a 7 m road
  // is a junction even though the centrelines are 4 m apart.
  const widthOf = new Map();
  for (const e of world.entities()) if (include.includes(e.type)) widthOf.set(e.id, (e.width || 2) / 2);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[i].ownerId === nodes[j].ownerId) continue;
      const d = G.dist(nodes[i].p, nodes[j].p);
      const reach = SNAP + (widthOf.get(nodes[i].ownerId) || 0) + (widthOf.get(nodes[j].ownerId) || 0);
      if (d > reach) continue;
      if (Math.abs(nodes[i].z - nodes[j].z) > 1.6) continue;   // a bridge over a road is not a junction
      edges.push({ a: i, b: j, w: d, ownerId: null, blockedBy: null, junction: true });
    }
  }

  const adj = new Map();
  for (const [k, e] of edges.entries()) {
    if (e.blockedBy) continue;
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push({ to: e.b, w: e.w, edge: k });
    adj.get(e.b).push({ to: e.a, w: e.w, edge: k });
  }
  return { nodes, edges, adj, byOwner, nearest: (p) => nearestNode(nodes, p) };
}

function spineOf(ring) {
  if (!ring) return null;
  const ob = G.orientedBounds(ring);
  const d = [Math.cos(ob.angle), Math.sin(ob.angle)];
  const h = ob.width / 2;
  return [[ob.center[0] - d[0] * h, ob.center[1] - d[1] * h], [ob.center[0] + d[0] * h, ob.center[1] + d[1] * h]];
}

function nearestNode(nodes, p) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const d = G.dist(nodes[i].p, p);
    if (d < bd) { bd = d; best = i; }
  }
  return { index: best, d: bd };
}

/** Dijkstra. Returns the polyline and its length, or null when disconnected. */
export function route(graph, from, to) {
  const a = graph.nearest(from), b = graph.nearest(to);
  if (a.index < 0 || b.index < 0) return null;
  const dist = new Map([[a.index, 0]]);
  const prev = new Map();
  const q = [[0, a.index]];
  const done = new Set();
  while (q.length) {
    q.sort((x, y) => x[0] - y[0]);
    const [d, u] = q.shift();
    if (done.has(u)) continue;
    done.add(u);
    if (u === b.index) break;
    for (const nb of graph.adj.get(u) || []) {
      const nd = d + nb.w;
      if (nd < (dist.get(nb.to) ?? Infinity)) {
        dist.set(nb.to, nd);
        prev.set(nb.to, u);
        q.push([nd, nb.to]);
      }
    }
  }
  if (!dist.has(b.index)) return null;
  const path = [];
  let cur = b.index;
  while (cur !== undefined) { path.unshift(graph.nodes[cur].p); cur = prev.get(cur); }
  return { path, length: dist.get(b.index), detour: dist.get(b.index) / Math.max(0.1, G.dist(from, to)) };
}

/** How much of the network can still be reached from a seed point? */
export function reachability(world, seed, opts = {}) {
  const graph = opts.graph || buildGraph(world, opts);
  const start = graph.nearest(seed);
  if (start.index < 0) return { reached: 0, total: graph.nodes.length, fraction: 0, graph, unreachable: [] };
  const seen = new Set([start.index]);
  const stack = [start.index];
  while (stack.length) {
    const u = stack.pop();
    for (const nb of graph.adj.get(u) || []) if (!seen.has(nb.to)) { seen.add(nb.to); stack.push(nb.to); }
  }
  const unreachable = new Map();
  graph.nodes.forEach((nd, i) => {
    if (!seen.has(i) && nd.ownerId) unreachable.set(nd.ownerId, (unreachable.get(nd.ownerId) || 0) + 1);
  });
  return {
    reached: seen.size, total: graph.nodes.length,
    fraction: graph.nodes.length ? seen.size / graph.nodes.length : 0,
    graph, seen,
    unreachable: [...unreachable.entries()].map(([id, n]) => ({ id, nodes: n })),
  };
}

/** Which network entities does this geometry actually obstruct, and by how much? */
export function obstruction(world, ring, zBase, zTop) {
  const out = [];
  for (const e of world.entities()) {
    if (!NETWORK_TYPES.has(e.type)) continue;
    const r = world.ringOf(e);
    if (!r || !G.ringsIntersect(ring, r)) continue;
    if (zBase >= e.zTop + 2.2 || zTop <= e.zBase) continue;
    const line = e.path || spineOf(r);
    const crossed = line ? G.polylineCrossesRing(line, ring) : true;
    out.push({ id: e.id, name: e.name || e.id, type: e.type, severed: crossed });
  }
  return out;
}

/** Before/after connectivity for a proposal — a consequence, not a claim. */
export function connectivityImpact(world, ghosts, seed) {
  const before = reachability(world, seed);
  const blockers = world.entities()
    .filter((e) => e.collision === 'solid')
    .concat(ghosts.filter((g) => g.collision !== 'none').map((g) => ({ ...g, id: g.id })));
  const after = reachability(world, seed, { blockers });
  return {
    before: before.fraction, after: after.fraction,
    lost: Math.max(0, before.reached - after.reached),
    newlyUnreachable: after.unreachable.filter((u) => !before.unreachable.some((b) => b.id === u.id)),
  };
}
