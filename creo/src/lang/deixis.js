// DEIXIS (§9). If "here" is unreliable, CREO is not CREO.
//
// Reference is resolved from every channel at once — selection, gesture, camera,
// cursor, touch, GPS, recent utterances, participant position, the scene graph
// and named landmarks — and the resolution always reports the basis it used so a
// person can see *why* the system thought they meant that. When nothing
// resolves, the answer is AMBIGUOUS_REFERENCE, never a guess.

import * as G from '../core/geom.js';

const TYPE_FOR_THING = {
  tree: ['tree'], building: ['structure'], room: ['room'], road: ['road'], path: ['path'],
  drain: ['drain'], water: ['water', 'stream'], wall: ['wall'], market: ['market'],
  garden: ['garden', 'surface'], bench: ['bench'], light: ['light'], car: ['car'],
  roof: ['roof'], window: ['opening'], people: ['person'], greenhouse: ['structure'],
  bridge: ['bridge'], swale: ['swale'], floor: ['structure'],
};

export function makeContext(world, overrides = {}) {
  return {
    world,
    selection: { ids: [], ring: null, stroke: null, points: [] },
    pointer: null,          // last tapped world point [x,y]
    camera: null,           // { eye:[x,y,z], target:[x,y,z] }
    participant: null,      // { id, position:[x,y] } — GPS / avatar
    utterances: [],         // most recent last
    ...overrides,
  };
}

/** Unit vector on the ground plane pointing away from the viewer. */
function viewDir(ctx) {
  const c = ctx.camera;
  if (!c) return [0, 1];
  const d = [c.target[0] - c.eye[0], c.target[1] - c.eye[1]];
  return G.len(d) < 1e-6 ? [0, 1] : G.norm(d);
}

function anchorOf(world, e) {
  const ring = world.ringOf(e);
  return ring ? G.centroid(ring) : [0, 0];
}

function radiusOf(world, e) {
  const ring = world.ringOf(e);
  if (!ring) return 1;
  const c = G.centroid(ring);
  return Math.max(...ring.map((p) => G.dist(p, c)));
}

const has = (tagged, t) => tagged.tokens.some((h) => h.token === t);

/**
 * @returns {{kind:string, ids:string[], point:number[]|null, ring:number[][]|null,
 *            line:number[][]|null, basis:string[], confidence:number,
 *            ambiguity:null|{reason:string,candidates:string[],question:string}}}
 */
export function resolveReference(tagged, ctx) {
  const w = ctx.world;
  const sel = ctx.selection || {};
  const basis = [];
  const none = (reason, candidates = [], question = 'Which one do you mean?') => ({
    kind: 'none', ids: [], point: null, ring: null, line: null, basis,
    confidence: 0, ambiguity: { reason, candidates, question },
  });

  const selEntities = (sel.ids || []).map((id) => w.get(id)).filter(Boolean);
  const lastResolved = [...(ctx.utterances || [])].reverse().find((u) => u.resolved && u.resolved.kind !== 'none')?.resolved || null;

  // -- "where we were before" ------------------------------------------------
  if (has(tagged, 'DEIXIS.before') && lastResolved) {
    basis.push('utterance-history');
    return { ...lastResolved, basis, confidence: 0.8, ambiguity: null };
  }

  // -- "between those" -------------------------------------------------------
  if (has(tagged, 'DEIXIS.between')) {
    const pair = selEntities.length >= 2 ? selEntities.slice(0, 2)
      : (lastResolved?.ids || []).map((id) => w.get(id)).filter(Boolean).slice(0, 2);
    if (pair.length === 2) {
      basis.push(selEntities.length >= 2 ? 'selection' : 'utterance-history');
      const a = anchorOf(w, pair[0]), b = anchorOf(w, pair[1]);
      const mid = G.lerp2(a, b, 0.5);
      const gap = G.dist(a, b);
      const dir = G.norm(G.sub(b, a));
      const p = G.perp(dir);
      const halfW = Math.max(2, gap / 2 - Math.max(radiusOf(w, pair[0]), radiusOf(w, pair[1])) * 0.4);
      const halfD = Math.max(3, (radiusOf(w, pair[0]) + radiusOf(w, pair[1])) / 2);
      const ring = [
        [mid[0] - dir[0] * halfW - p[0] * halfD, mid[1] - dir[1] * halfW - p[1] * halfD],
        [mid[0] + dir[0] * halfW - p[0] * halfD, mid[1] + dir[1] * halfW - p[1] * halfD],
        [mid[0] + dir[0] * halfW + p[0] * halfD, mid[1] + dir[1] * halfW + p[1] * halfD],
        [mid[0] - dir[0] * halfW + p[0] * halfD, mid[1] - dir[1] * halfW + p[1] * halfD],
      ];
      return { kind: 'region', ids: pair.map((e) => e.id), point: mid, ring, line: null, basis, confidence: 0.85, ambiguity: null };
    }
    return none('between needs two referents', (sel.ids || []), 'Between which two things?');
  }

  // -- "behind this" / "in front of this" ------------------------------------
  if (has(tagged, 'DEIXIS.behind') || has(tagged, 'DEIXIS.front')) {
    const ref = selEntities[0] || (ctx.pointer ? w.entityAt(ctx.pointer) : null)
      || (lastResolved?.ids?.[0] ? w.get(lastResolved.ids[0]) : null);
    if (!ref) return none('behind/in-front needs a referent', [], 'Behind what?');
    basis.push(selEntities[0] ? 'selection' : 'pointer', 'camera');
    const c = anchorOf(w, ref);
    const away = viewDir(ctx);                        // camera → world
    const sign = has(tagged, 'DEIXIS.behind') ? 1 : -1;
    const r = radiusOf(w, ref);
    const p = [c[0] + away[0] * sign * (r + 4), c[1] + away[1] * sign * (r + 4)];
    return { kind: 'point', ids: [ref.id], point: p, ring: G.circleRing(p[0], p[1], Math.max(4, r * 0.8), 20), line: null, basis, confidence: 0.75, ambiguity: null };
  }

  // -- "along here" ----------------------------------------------------------
  if (has(tagged, 'DEIXIS.along')) {
    if (sel.stroke && sel.stroke.length >= 2) {
      basis.push('gesture-stroke');
      return { kind: 'polyline', ids: [], point: G.centroid(sel.stroke), ring: null, line: sel.stroke, basis, confidence: 0.9, ambiguity: null };
    }
    const ref = selEntities.find((e) => e.path) || null;
    if (ref) { basis.push('selection'); return { kind: 'polyline', ids: [ref.id], point: anchorOf(w, ref), ring: null, line: ref.path, basis, confidence: 0.8, ambiguity: null }; }
    return none('along needs a drawn line or a linear referent', [], 'Along where? Draw the line.');
  }

  // -- "around that" ---------------------------------------------------------
  if (has(tagged, 'DEIXIS.around')) {
    const ref = selEntities[0] || (ctx.pointer ? w.entityAt(ctx.pointer) : null);
    if (ref) {
      basis.push(selEntities[0] ? 'selection' : 'pointer');
      const c = anchorOf(w, ref);
      const r = radiusOf(w, ref);
      return { kind: 'region', ids: [ref.id], point: c, ring: G.circleRing(c[0], c[1], r + 6, 28), line: null, basis, confidence: 0.8, ambiguity: null };
    }
    return none('around needs a referent', [], 'Around what?');
  }

  // -- "the one next to it" --------------------------------------------------
  if (has(tagged, 'DEIXIS.next')) {
    const refId = selEntities[0]?.id || lastResolved?.ids?.[0];
    const ref = refId ? w.get(refId) : null;
    if (ref) {
      basis.push('scene-graph', refId === selEntities[0]?.id ? 'selection' : 'utterance-history');
      const c = anchorOf(w, ref);
      const near = w.nearby(c, 25).filter((h) => h.entity.id !== ref.id && h.entity.type === ref.type);
      if (near.length) {
        const pick = near[0].entity;
        return { kind: 'entities', ids: [pick.id], point: anchorOf(w, pick), ring: w.ringOf(pick), line: null, basis, confidence: 0.65, ambiguity: null };
      }
    }
    return none('next-to has no anchor', [], 'Next to which one?');
  }

  // -- "toward the river" / named landmark -----------------------------------
  if (has(tagged, 'DEIXIS.toward')) {
    const name = [...w.place.landmarks.keys()].find((k) => tagged.norm.includes(k.toLowerCase()));
    if (name) {
      basis.push('landmark');
      const p = w.place.landmarks.get(name);
      const from = selEntities[0] ? anchorOf(w, selEntities[0]) : (ctx.pointer || ctx.participant?.position || [0, 0]);
      const dir = G.norm(G.sub(p, from));
      const at = [from[0] + dir[0] * 12, from[1] + dir[1] * 12];
      return { kind: 'point', ids: selEntities.map((e) => e.id), point: at, ring: G.circleRing(at[0], at[1], 6, 20), line: [from, p], basis, confidence: 0.7, ambiguity: null, landmark: name };
    }
  }

  // -- "the far corner" ------------------------------------------------------
  if (has(tagged, 'DEIXIS.far') && has(tagged, 'DEIXIS.corner')) {
    const ring = sel.ring || (selEntities[0] ? w.ringOf(selEntities[0]) : null);
    if (ring && ctx.camera) {
      basis.push('camera', sel.ring ? 'gesture-region' : 'selection');
      const eye = [ctx.camera.eye[0], ctx.camera.eye[1]];
      let far = ring[0], bestD = -1;
      for (const p of ring) { const d = G.dist(p, eye); if (d > bestD) { bestD = d; far = p; } }
      return { kind: 'point', ids: [], point: far, ring: G.circleRing(far[0], far[1], 4, 16), line: null, basis, confidence: 0.7, ambiguity: null };
    }
  }

  // -- plural "these / those" ------------------------------------------------
  if (has(tagged, 'DEIXIS.these')) {
    if (selEntities.length >= 1) {
      basis.push('selection');
      return { kind: 'entities', ids: selEntities.map((e) => e.id), point: G.centroid(selEntities.map((e) => anchorOf(w, e))), ring: null, line: null, basis, confidence: selEntities.length >= 2 ? 0.95 : 0.6, ambiguity: null };
    }
    if (sel.ring) {
      basis.push('gesture-region');
      const ids = w.index.within(sel.ring);
      return { kind: 'region', ids, point: G.centroid(sel.ring), ring: sel.ring, line: null, basis, confidence: 0.85, ambiguity: null };
    }
    return none('plural reference with nothing selected', [], 'Which ones? Tap or circle them.');
  }

  // -- singular "this / that / it" -------------------------------------------
  if (has(tagged, 'DEIXIS.this')) {
    if (selEntities.length === 1) {
      basis.push('selection');
      const e = selEntities[0];
      return { kind: 'entities', ids: [e.id], point: anchorOf(w, e), ring: w.ringOf(e), line: null, basis, confidence: 0.95, ambiguity: null };
    }
    if (selEntities.length > 1) {
      basis.push('selection');
      return { kind: 'entities', ids: selEntities.map((e) => e.id), point: G.centroid(selEntities.map((e) => anchorOf(w, e))), ring: null, line: null, basis, confidence: 0.6, ambiguity: null };
    }
    if (ctx.pointer) {
      const e = w.entityAt(ctx.pointer);
      basis.push('pointer');
      if (e) return { kind: 'entities', ids: [e.id], point: anchorOf(w, e), ring: w.ringOf(e), line: null, basis, confidence: 0.85, ambiguity: null };
      return { kind: 'point', ids: [], point: ctx.pointer, ring: G.circleRing(ctx.pointer[0], ctx.pointer[1], 4, 16), line: null, basis, confidence: 0.6, ambiguity: null };
    }
    // If they drew a shape and then said "this", the shape is what they mean.
    if (sel.ring) {
      basis.push('gesture-region');
      return { kind: 'region', ids: w.index.within(sel.ring), point: G.centroid(sel.ring), ring: sel.ring, line: null, basis, confidence: 0.8, ambiguity: null };
    }
    if (sel.stroke && sel.stroke.length >= 2) {
      basis.push('gesture-stroke');
      return { kind: 'polyline', ids: [], point: G.centroid(sel.stroke), ring: null, line: sel.stroke, basis, confidence: 0.75, ambiguity: null };
    }
    return none('"this" with nothing selected and nothing pointed at', [], 'Tap the thing you mean.');
  }

  // -- "here" / "there" ------------------------------------------------------
  if (has(tagged, 'DEIXIS.here') || has(tagged, 'DEIXIS.there')) {
    const distal = has(tagged, 'DEIXIS.there') && !has(tagged, 'DEIXIS.here');
    if (sel.ring) {
      basis.push('gesture-region');
      return { kind: 'region', ids: w.index.within(sel.ring), point: G.centroid(sel.ring), ring: sel.ring, line: null, basis, confidence: 0.9, ambiguity: null };
    }
    if (sel.stroke && sel.stroke.length >= 2) {
      basis.push('gesture-stroke');
      return { kind: 'polyline', ids: [], point: G.centroid(sel.stroke), ring: null, line: sel.stroke, basis, confidence: 0.85, ambiguity: null };
    }
    if (ctx.pointer) {
      basis.push('pointer');
      const r = distal ? 8 : 5;
      // Carry whatever is under or selected at that point. The same tap that
      // sets the pointer usually also selects something, and dropping it made
      // "why are you here?" — which contains the word "here" — answer that
      // nothing had been indicated.
      const under = w.entityAt(ctx.pointer);
      const ids = selEntities.length ? selEntities.map((e) => e.id) : (under ? [under.id] : []);
      if (ids.length) basis.push(selEntities.length ? 'selection' : 'entity-under-pointer');
      return { kind: 'point', ids, point: ctx.pointer, ring: G.circleRing(ctx.pointer[0], ctx.pointer[1], r, 20), line: null, basis, confidence: 0.8, ambiguity: null };
    }
    if (selEntities.length) {
      basis.push('selection');
      const c = G.centroid(selEntities.map((e) => anchorOf(w, e)));
      return { kind: 'point', ids: selEntities.map((e) => e.id), point: c, ring: G.circleRing(c[0], c[1], 6, 20), line: null, basis, confidence: 0.7, ambiguity: null };
    }
    if (!distal && ctx.participant) {
      basis.push('gps');
      const p = ctx.participant.position;
      return { kind: 'point', ids: [], point: p, ring: G.circleRing(p[0], p[1], 6, 20), line: null, basis, confidence: 0.6, ambiguity: null };
    }
    return none('"here" with no gesture, selection or position', [], 'Where? Tap the map.');
  }

  // -- no explicit deixis: fall back to what is already indicated ------------
  if (selEntities.length) {
    basis.push('selection');
    return { kind: 'entities', ids: selEntities.map((e) => e.id), point: G.centroid(selEntities.map((e) => anchorOf(w, e))), ring: selEntities.length === 1 ? w.ringOf(selEntities[0]) : null, line: null, basis, confidence: 0.7, ambiguity: null };
  }
  if (sel.ring) {
    basis.push('gesture-region');
    return { kind: 'region', ids: w.index.within(sel.ring), point: G.centroid(sel.ring), ring: sel.ring, line: null, basis, confidence: 0.8, ambiguity: null };
  }
  if (sel.stroke && sel.stroke.length >= 2) {
    basis.push('gesture-stroke');
    return { kind: 'polyline', ids: [], point: G.centroid(sel.stroke), ring: null, line: sel.stroke, basis, confidence: 0.8, ambiguity: null };
  }
  if (ctx.pointer) {
    basis.push('pointer');
    const e = w.entityAt(ctx.pointer);
    if (e) return { kind: 'entities', ids: [e.id], point: anchorOf(w, e), ring: w.ringOf(e), line: null, basis, confidence: 0.6, ambiguity: null };
    return { kind: 'point', ids: [], point: ctx.pointer, ring: G.circleRing(ctx.pointer[0], ctx.pointer[1], 5, 16), line: null, basis, confidence: 0.5, ambiguity: null };
  }
  return none('nothing indicated', [], 'Tap, draw, or circle the part of the place you mean.');
}

/**
 * Narrow a resolved reference by the noun that was actually said.
 * "circle trees / keep these" must keep the trees, not the ground under them.
 */
export function filterByThing(ref, thing, ctx) {
  if (!thing) return ref;
  const types = TYPE_FOR_THING[thing];
  if (!types) return ref;
  const w = ctx.world;
  let pool = ref.ids;
  if ((ref.kind === 'region' || ref.kind === 'point') && ref.ring) pool = w.index.within(ref.ring).concat(w.index.overlapping(ref.ring));
  const ids = [...new Set(pool)].filter((id) => {
    const e = w.get(id);
    return e && (types.includes(e.type) || (e.subtype && types.includes(e.subtype)));
  });
  if (!ids.length) return ref;
  return { ...ref, kind: 'entities', ids, thingFiltered: thing };
}

/** Human-readable account of how the reference was decided. Shown, not hidden. */
export function explainReference(ref, world) {
  const names = ref.ids.map((id) => world.get(id)?.name || id);
  const basis = ref.basis.join(' + ') || 'nothing';
  if (ref.kind === 'none') return `couldn't tell what you meant — ${ref.ambiguity.reason}`;
  if (ref.kind === 'entities') return `${names.join(', ')} — from ${basis}`;
  if (ref.kind === 'region') return `an area of ${G.area(ref.ring).toFixed(0)} m² — from ${basis}`;
  if (ref.kind === 'polyline') return `a ${G.perimeter(ref.line, false).toFixed(1)} m line — from ${basis}`;
  return `a point at ${ref.point.map((v) => v.toFixed(1)).join(', ')} — from ${basis}`;
}
