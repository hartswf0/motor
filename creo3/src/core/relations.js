// RELATIONSHIPS ARE FIRST-CLASS.
//
// The question CREO must answer is not "what objects exist?" but "how does this
// place hold together?" Derived relations are recomputed from geometry after
// every commit; asserted relations (claimedBy, disputedBy, preserves…) are
// authored by people and never overwritten by the deriver.

import * as G from './geom.js';

const NETWORK_TYPES = new Set(['road', 'path', 'drain', 'stream']);
const TOUCH_TOL = 0.35;      // metres
const BESIDE_TOL = 6;        // metres

export function deriveRelations(place, index, branchId = place.activeBranch) {
  place.clearDerivedRelations();
  const ents = place.all(branchId);
  const ringOf = new Map();
  for (const e of ents) {
    const r = place.ringOf(e);
    if (r && r.length >= 3) ringOf.set(e.id, r);
  }
  const push = (from, kind, to, extra = {}) =>
    place.relations.push({ from, kind, to, derived: true, ...extra });

  for (const a of ents) {
    const ra = ringOf.get(a.id);
    if (!ra) continue;
    const bbA = G.bbox(ra);
    const pad = [bbA[0] - BESIDE_TOL, bbA[1] - BESIDE_TOL, bbA[2] + BESIDE_TOL, bbA[3] + BESIDE_TOL];
    for (const bid of index.candidates(pad)) {
      if (bid === a.id) continue;
      const b = place.get(bid, branchId);
      if (!b) continue;
      const rb = ringOf.get(bid);
      if (!rb) continue;
      if (a.id > b.id && !NETWORK_TYPES.has(a.type)) continue;  // do each unordered pair once

      const overlaps = G.ringsIntersect(ra, rb);
      const d = overlaps ? 0 : G.ringDistance(ra, rb);

      if (overlaps) {
        if (G.ringContains(rb, ra) && a.zBase >= b.zBase - 0.01 && a.zTop <= b.zTop + 0.01) {
          push(a.id, 'inside', b.id); push(b.id, 'contains', a.id);
        } else if (G.ringContains(ra, rb) && b.zBase >= a.zBase - 0.01 && b.zTop <= a.zTop + 0.01) {
          push(b.id, 'inside', a.id); push(a.id, 'contains', b.id);
        }
        // vertical stacking
        if (Math.abs(a.zBase - b.zTop) < 0.2) {
          push(a.id, 'above', b.id); push(b.id, 'below', a.id);
          push(b.id, 'supports', a.id); push(a.id, 'supportedBy', b.id);
        } else if (Math.abs(b.zBase - a.zTop) < 0.2) {
          push(b.id, 'above', a.id); push(a.id, 'below', b.id);
          push(a.id, 'supports', b.id); push(b.id, 'supportedBy', a.id);
        } else if (a.zBase > b.zTop) { push(a.id, 'above', b.id); push(b.id, 'below', a.id); }
        else if (b.zBase > a.zTop) { push(b.id, 'above', a.id); push(a.id, 'below', b.id); }

        // A solid thing overlapping a circulation network blocks it.
        if (NETWORK_TYPES.has(b.type) && a.collision === 'solid' && a.zBase < b.zTop + 2 && a.zTop > b.zBase) {
          push(a.id, 'blocks', b.id);
        }
        if (NETWORK_TYPES.has(a.type) && b.collision === 'solid' && b.zBase < a.zTop + 2 && b.zTop > a.zBase) {
          push(b.id, 'blocks', a.id);
        }
        if (NETWORK_TYPES.has(a.type) && NETWORK_TYPES.has(b.type)) {
          if (a.network === b.network) { push(a.id, 'connectedTo', b.id); push(b.id, 'connectedTo', a.id); }
          else { push(a.id, 'crosses', b.id); push(b.id, 'crosses', a.id); }
        }
      } else if (d <= TOUCH_TOL) {
        push(a.id, 'touches', b.id); push(b.id, 'touches', a.id);
        if (Math.abs(a.zBase - b.zTop) < 0.2) { push(b.id, 'supports', a.id); push(a.id, 'supportedBy', b.id); }
        if (Math.abs(b.zBase - a.zTop) < 0.2) { push(a.id, 'supports', b.id); push(b.id, 'supportedBy', a.id); }
      } else if (d <= BESIDE_TOL) {
        push(a.id, 'beside', b.id, { distance: +d.toFixed(2) });
        push(b.id, 'beside', a.id, { distance: +d.toFixed(2) });
      }
    }

    // Ground support: an entity sitting on terrain is supported by the ground.
    if (place.terrain && a.zBase <= place.groundAt(...G.centroid(ra)) + 0.25 && a.type !== 'terrain') {
      push(a.id, 'supportedBy', 'terrain');
    }
    // Drainage: water follows the actual slope, so drainsTo is geometry, not opinion.
    if (place.terrain && (a.type === 'surface' || a.type === 'road' || a.type === 'path' || a.type === 'region')) {
      const c = G.centroid(ra);
      const s = place.terrain.slopeAt(c[0], c[1]);
      if (s.grade > 0.002) {
        const step = 3;
        const target = [c[0] - (s.dzdx / s.grade) * step, c[1] - (s.dzdy / s.grade) * step];
        for (const hit of index.near(target, 1.5)) {
          if (hit.id === a.id) continue;
          const t = place.get(hit.id, branchId);
          if (t && (t.type === 'drain' || t.type === 'water' || t.type === 'stream')) {
            push(a.id, 'drainsTo', hit.id);
            break;
          }
        }
      }
    }
  }
  return place.relations;
}

/** "how does this place hold together?" — a readable local answer. */
export function describeRelations(place, id, limit = 12) {
  const rels = place.relationsOf(id);
  const byKind = new Map();
  for (const r of rels) {
    const outgoing = r.from === id;
    const kind = outgoing ? r.kind : inverseOf(r.kind);
    const other = outgoing ? r.to : r.from;
    if (!byKind.has(kind)) byKind.set(kind, new Set());
    byKind.get(kind).add(other);
  }
  const out = [];
  for (const [kind, set] of byKind) {
    out.push({ kind, ids: [...set].slice(0, limit) });
  }
  return out;
}

const INVERSE = {
  inside: 'contains', contains: 'inside', above: 'below', below: 'above',
  supports: 'supportedBy', supportedBy: 'supports', blocks: 'blockedBy',
  drainsTo: 'drainedFrom', proposedBy: 'proposed', derivedFrom: 'derived',
};
export const inverseOf = (k) => INVERSE[k] || k;

/**
 * Support check used by the certificate: is this entity's base resting on
 * terrain or on something that can carry it?
 */
export function supportFor(place, index, ring, zBase, excludeId = null, branchId = place.activeBranch) {
  const c = G.centroid(ring);
  const ground = place.groundAt(c[0], c[1]);
  if (zBase <= ground + 0.3) return { supported: true, by: 'terrain', gap: 0 };
  let best = null;
  for (const id of index.overlapping(ring, zBase - 0.6, zBase + 0.01, new Set([excludeId].filter(Boolean)))) {
    const e = place.get(id, branchId);
    if (!e || e.collision === 'none') continue;
    const gap = zBase - e.zTop;
    if (gap >= -0.05 && gap < 0.6 && (!best || gap < best.gap)) best = { supported: true, by: id, gap };
  }
  return best || { supported: false, by: null, gap: zBase - ground };
}
