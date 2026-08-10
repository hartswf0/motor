// THE SPATIAL CONSTITUTION (§11–12).
//
// Prompts may propose. Geometry decides.
//
// A certificate says exactly what is wrong, names the entity it is wrong with,
// and measures it. It never quietly moves a conflicting thing twenty metres away
// — conflict is design information, and erasing it computationally is a lie.

import * as G from '../core/geom.js';
import { supportFor } from '../core/relations.js';

export const FINDINGS = [
  'VALID', 'COLLISION', 'UNSUPPORTED', 'BLOCKS_ACCESS', 'DISCONNECTED',
  'INSUFFICIENT_CLEARANCE', 'WATER_CONFLICT', 'ROUTE_CONFLICT', 'RIGHT_OF_WAY_CONFLICT',
  'AIRSPACE_CONFLICT', 'OUTSIDE_REGION', 'REQUIRES_REMOVAL', 'REQUIRES_RELOCATION',
  'AMBIGUOUS_REFERENCE',
];

const NETWORK_TYPES = new Set(['road', 'path', 'drain', 'stream']);
const MIN_CLEARANCE = { path: 1.2, road: 2.5, drain: 0.6, door: 0.9 };
const HEAD_CLEARANCE = 2.2;   // metres under a bridge or overhang

/**
 * Certify a set of ghost entities against the committed world.
 * @returns {{valid:boolean, findings:Array, ghosts:Array}}
 */
export function certify(world, ghosts, opts = {}) {
  const findings = [];
  const ignore = new Set(opts.ignore || []);
  const ghostIds = new Set(ghosts.map((g) => g.id));
  const index = world.reindex();

  for (const g of ghosts) {
    const ring = world.place.ringOf(g);
    if (!ring || ring.length < 3) {
      findings.push(f('AMBIGUOUS_REFERENCE', 'error', g.id, [], 'This proposal has no usable footprint.'));
      continue;
    }
    if (G.area(ring) < 0.05) {
      findings.push(f('AMBIGUOUS_REFERENCE', 'error', g.id, [], 'Footprint is degenerate (< 0.05 m²).'));
      continue;
    }

    // --- region containment ------------------------------------------------
    if (opts.region) {
      const outside = ring.filter((p) => !G.pointInRing(p, opts.region)).length;
      if (outside === ring.length) {
        findings.push(f('OUTSIDE_REGION', 'error', g.id, [], 'Falls entirely outside the area you indicated.'));
      } else if (outside > 0) {
        findings.push(f('OUTSIDE_REGION', 'warning', g.id, [], `${outside} of ${ring.length} corners fall outside the area you indicated.`));
      }
    }

    // --- occupation of ground already in use --------------------------------
    // This check used to be skipped entirely for anything with collision:'none',
    // which meant a garden could be proposed with a footprint identical to a
    // house and certify as VALID. A surface does not pass through a building
    // just because you cannot bump into the surface.
    {
      const hits = index.overlapping(ring, g.zBase - 0.4, Math.max(g.zTop, g.zBase + 0.4), new Set([...ghostIds, ...ignore]));
      for (const id of hits) {
        const other = world.get(id);
        if (!other || other.collision === 'none') continue;
        if (NETWORK_TYPES.has(other.type)) continue;               // handled as route conflict
        if (other.type === 'surface' || other.type === 'region' || other.type === 'observation') continue;
        const otherRing = world.ringOf(other);
        const overlapArea = approxOverlapArea(ring, otherRing);
        if (other.type === 'tree') {
          findings.push(f('REQUIRES_REMOVAL', 'warning', g.id, [id],
            `Requires removal of ${label(other)}.`, { area: overlapArea }));
          continue;
        }
        if (g.collision === 'none') {
          // A surface laid across a building is a real conflict; a surface that
          // clips its corner by a fraction of a square metre is a note. Reporting
          // both as fatal makes the system look like it is refusing everything.
          const ghostArea = G.area(ring);
          const serious = overlapArea > 2 || overlapArea > ghostArea * 0.08;
          findings.push(f('REQUIRES_REMOVAL', serious ? 'error' : 'warning', g.id, [id],
            serious
              ? `That ground is occupied by ${label(other)} — ${overlapArea.toFixed(1)} m² of this lies on top of a building.`
              : `Clips the corner of ${label(other)} by ${overlapArea.toFixed(2)} m² — worth adjusting on site.`,
            { area: overlapArea }));
        } else {
          findings.push(f('COLLISION', 'error', g.id, [id],
            `Intersects existing structure ${label(other)} over ${overlapArea.toFixed(1)} m².`, { area: overlapArea }));
        }
      }
    }

    // --- vertical support ---------------------------------------------------
    if (g.zBase > 0.31 && g.type !== 'bridge' && g.needsSupport !== false) {
      const sup = supportFor(world.place, index, ring, g.zBase, g.id, world.branch);
      if (!sup.supported) {
        findings.push(f('UNSUPPORTED', 'error', g.id, [],
          `Base sits ${sup.gap.toFixed(2)} m above the ground with nothing under it.`, { gap: sup.gap }));
      }
    }
    if (g.type === 'bridge') {
      const ends = g.props?.ends || [];
      const missing = ends.filter((id) => !world.get(id));
      if (missing.length) findings.push(f('UNSUPPORTED', 'error', g.id, missing, 'One end of this connection lands on nothing.'));
    }

    // --- routes: blocking and head clearance --------------------------------
    for (const other of world.entities()) {
      if (ghostIds.has(other.id) || ignore.has(other.id)) continue;
      if (!NETWORK_TYPES.has(other.type)) continue;
      const otherRing = world.ringOf(other);
      if (!otherRing || !G.ringsIntersect(ring, otherRing)) continue;
      // Evaluate height AT THE CROSSING, not globally. A graded trench is one
      // entity with one [zBase, zTop] pair, but its bed falls along its length:
      // comparing a 100 m drain's far-end invert against a lane sitting on high
      // ground concluded the trench passed underneath, and said nothing.
      const at = crossingPoint(world, ring, otherRing);
      const gz = zSpanAt(world, g, at);
      const oz = zSpanAt(world, other, at);
      const clearsOver = gz[0] >= oz[1] + HEAD_CLEARANCE;
      const clearsUnder = gz[1] <= oz[0] - 0.05;
      if (clearsOver || clearsUnder) {
        if (clearsOver && g.zBase < other.zTop + HEAD_CLEARANCE + 0.4) {
          findings.push(f('INSUFFICIENT_CLEARANCE', 'warning', g.id, [other.id],
            `Only ${(g.zBase - other.zTop).toFixed(2)} m of headroom over ${label(other)}.`, { clearance: g.zBase - other.zTop }));
        }
        continue;
      }
      // Two things on the same network meeting each other is a junction, not a
      // blockage — that is how infrastructure is supposed to join.
      if (g.network && g.network === other.network) continue;
      // Something you can walk over or through does not sever a route; an open
      // trench across a lane still needs a crossing, and says so.
      if (g.collision === 'none') {
        if (g.type === 'drain' && (other.type === 'road' || other.type === 'path')) {
          findings.push(f('ROUTE_CONFLICT', 'warning', g.id, [other.id],
            `Crosses ${label(other)} — needs a culvert or a crossing here.`));
        }
        continue;
      }
      const used = other.props?.usedBy || other.use;
      findings.push(f(other.type === 'drain' || other.type === 'stream' ? 'WATER_CONFLICT' : 'BLOCKS_ACCESS',
        'error', g.id, [other.id],
        other.type === 'drain' || other.type === 'stream'
          ? `Blocks ${label(other)} — water arriving here has nowhere to go.`
          : `Blocks ${label(other)}${used ? ` used by ${used}` : ''}.`));
    }

    // --- lateral clearance on networks -------------------------------------
    for (const hit of index.near(G.centroid(ring), 12)) {
      if (ghostIds.has(hit.id) || ignore.has(hit.id)) continue;
      const other = world.get(hit.id);
      if (!other || !NETWORK_TYPES.has(other.type)) continue;
      const otherRing = world.ringOf(other);
      const d = G.ringDistance(ring, otherRing);
      const need = MIN_CLEARANCE[other.type] ?? 1;
      if (d > 0 && d < need) {
        findings.push(f('INSUFFICIENT_CLEARANCE', 'warning', g.id, [other.id],
          `Leaves only ${d.toFixed(2)} m beside ${label(other)} (${need} m needed).`, { clearance: d, need }));
      }
    }

    // --- airspace / right of way -------------------------------------------
    for (const other of world.entities()) {
      if (ghostIds.has(other.id) || ignore.has(other.id)) continue;
      if (other.type !== 'parcel' && other.type !== 'region') continue;
      const otherRing = world.ringOf(other);
      if (!otherRing || !G.ringsIntersect(ring, otherRing)) continue;
      const claimed = world.place.relations.find((r) => r.to === other.id && (r.kind === 'claimedBy' || r.kind === 'ownedBy'));
      if (claimed && g.author && claimed.from !== g.author) {
        findings.push(f('RIGHT_OF_WAY_CONFLICT', 'warning', g.id, [other.id],
          `Extends into ${label(other)}, claimed by ${claimed.from}.`));
      }
      if (other.props?.airspace && g.zTop > (other.props.airspaceLimit ?? 0)) {
        findings.push(f('AIRSPACE_CONFLICT', 'warning', g.id, [other.id],
          `Rises ${(g.zTop - other.props.airspaceLimit).toFixed(1)} m above the height limit for ${label(other)}.`));
      }
    }

    // --- explicit constraints carried from the utterance --------------------
    for (const c of opts.constraints || []) {
      if (c.kind === 'DONT_BLOCK' && c.corridors) {
        for (const corr of c.corridors) {
          if (G.ringsIntersect(ring, corr.ring) && g.zTop > corr.zBase && g.zBase < corr.zTop) {
            findings.push(f('BLOCKS_ACCESS', 'error', g.id, [corr.ownerId],
              `Blocks ${corr.label} — you asked for that to stay clear.`, { constraint: true }));
          }
        }
      }
      if (c.kind === 'PRESERVE' && c.ids) {
        for (const id of c.ids) {
          const keep = world.get(id);
          if (!keep) continue;
          const kr = world.ringOf(keep);
          if (kr && G.ringsIntersect(ring, kr)) {
            findings.push(f('REQUIRES_REMOVAL', 'error', g.id, [id],
              `Would remove ${label(keep)}, which you asked to keep.`, { constraint: true }));
          }
        }
      }
    }

    // --- network connectivity ----------------------------------------------
    if (NETWORK_TYPES.has(g.type)) {
      const touching = world.entities().filter((o) => {
        if (ghostIds.has(o.id) || !NETWORK_TYPES.has(o.type)) return false;
        const or = world.ringOf(o);
        return or && G.ringDistance(ring, or) < 1.0;
      });
      if (!touching.length) {
        findings.push(f('DISCONNECTED', 'warning', g.id, [],
          `This ${g.type} does not meet any existing ${g.network || 'network'} — it would be decoration, not infrastructure.`));
      }
      if (g.type === 'drain' && g.path) {
        // Judge the trench bed, not the ground over it — a drain is dug.
        const t = world.place.terrain;
        const inv = g.props?.invert
          || (t ? [t.heightAt(...g.path[0]) - (g.props?.depth ?? 0), t.heightAt(...g.path[g.path.length - 1]) - (g.props?.depth ?? 0)] : null);
        if (inv && inv[1] > inv[0] + 0.02) {
          findings.push(f('WATER_CONFLICT', 'error', g.id, [],
            `Runs uphill: the outlet invert is ${(inv[1] - inv[0]).toFixed(2)} m above the inlet.`, { rise: inv[1] - inv[0] }));
        }
        // A swale is meant to hold water and let it soak; a drain that holds
        // water is a puddle with ambitions.
        if (inv && !g.props?.outfall && g.subtype !== 'swale') {
          findings.push(f('WATER_CONFLICT', 'warning', g.id, [],
            'No outfall found within reach — this collects water but does not take it anywhere.'));
        }
      }
    }
  }

  if (!findings.length) findings.push(f('VALID', 'info', ghosts[0]?.id || null, [], 'Spatially valid: no collision, supported, nothing blocked.'));
  const valid = !findings.some((x) => x.severity === 'error');
  return { valid, findings, ghosts };
}

function f(code, severity, entity, others, message, measure = null) {
  return { code, severity, entity, others, message, measure };
}

/** A representative point where two footprints actually meet. */
function crossingPoint(world, a, b) {
  for (let i = 0, n = a.length; i < n; i++) {
    for (let j = 0, m = b.length; j < m; j++) {
      const hit = G.segIntersect(a[i], a[(i + 1) % n], b[j], b[(j + 1) % m]);
      if (hit) return hit.point;
    }
  }
  // fully contained: the centre of the smaller one is representative
  return G.area(a) <= G.area(b) ? G.centroid(a) : G.centroid(b);
}

/**
 * The vertical interval an entity actually occupies at a given point.
 * For a graded linear feature this interpolates its invert along the line and
 * sits it under the terrain there; for everything else the stored interval is
 * already the truth.
 */
function zSpanAt(world, e, point) {
  if (!e.path || e.path.length < 2) return [e.zBase, e.zTop];
  const inv = e.props?.invert;
  const ground = world.place.terrain ? world.place.groundAt(point[0], point[1]) : e.zTop;
  if (!inv) return [Math.min(e.zBase, ground), Math.max(e.zTop, ground)];
  let total = 0;
  const segs = [];
  for (let i = 0; i < e.path.length - 1; i++) { const d = G.dist(e.path[i], e.path[i + 1]); segs.push(d); total += d; }
  const c = G.closestOnRing(point, e.path, false);
  let before = 0;
  for (let i = 0; i < (c.i ?? 0); i++) before += segs[i];
  const along = before + (segs[c.i ?? 0] || 0) * (c.t ?? 0);
  const frac = total > 0 ? Math.max(0, Math.min(1, along / total)) : 0;
  const bed = inv[0] + (inv[1] - inv[0]) * frac;
  return [bed, ground];                     // an open trench reaches the surface
}

export function label(e) {
  if (!e) return 'something';
  return e.name ? `${e.name} (${e.id})` : `${e.type} ${e.id}`;
}

/** Monte-Carlo-free overlap estimate: clip by sampling the smaller bbox on a grid. */
function approxOverlapArea(a, b) {
  const bb = [
    Math.max(G.bbox(a)[0], G.bbox(b)[0]), Math.max(G.bbox(a)[1], G.bbox(b)[1]),
    Math.min(G.bbox(a)[2], G.bbox(b)[2]), Math.min(G.bbox(a)[3], G.bbox(b)[3]),
  ];
  if (bb[2] <= bb[0] || bb[3] <= bb[1]) return 0;
  const n = 24;
  const dx = (bb[2] - bb[0]) / n, dy = (bb[3] - bb[1]) / n;
  let hits = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const p = [bb[0] + (i + 0.5) * dx, bb[1] + (j + 0.5) * dy];
      if (G.pointInRing(p, a) && G.pointInRing(p, b)) hits++;
    }
  }
  return (hits / (n * n)) * (bb[2] - bb[0]) * (bb[3] - bb[1]);
}

/** Group findings for display: errors first, then warnings, then the good news. */
export function summarize(cert) {
  const order = { error: 0, warning: 1, info: 2 };
  return cert.findings.slice().sort((a, b) => order[a.severity] - order[b.severity]);
}
