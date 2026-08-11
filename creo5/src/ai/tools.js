// TOOLS — what the assistant may actually do, and how the world answers.
//
// Until now the model got one shot: a paragraph describing what was near the
// camera, and a demand for a finished proposal. That is not how anyone decides
// anything about a place. You look, you measure, you test, and only then do you
// say what should happen — and if the measurement surprises you, you look again.
//
// So the model does not receive a description of the world. It receives a set of
// things it may ASK the world, and the world answers with numbers it did not
// invent. Three rules hold this together:
//
//   1. Every tool is READ-ONLY except `propose`, which produces a proposal that
//      still has to pass the certificate and still has to be accepted by a
//      person. Nothing here can change a place on its own.
//   2. Every answer is computed, never recalled. `flood` runs the water model.
//      `seat` runs the earthwork. If CREO cannot compute it, the tool says so
//      rather than guessing.
//   3. Every answer carries its own units and its own provenance, so an
//      assistant that is about to say something false has to work at it.

import * as G from '../core/geom.js';
import { runWater } from '../sim/water.js';
import { obstruction } from '../sim/movement.js';
import { describeRelations } from '../core/relations.js';
import { ask } from '../world/query.js';
import { boxBody } from '../world/body.js';
import { planSeat } from '../world/seat.js';

/** The catalogue, in the shape the /responses and /chat APIs both accept. */
export const TOOLS = [
  {
    name: 'look',
    description: 'What is at or near a point. Returns things with their kind, size, height and the ground they stand on. Use this before saying anything about somewhere.',
    parameters: {
      type: 'object',
      properties: {
        at: { type: 'array', items: { type: 'number' }, description: '[x, y] in metres' },
        radius: { type: 'number', description: 'metres, default 60' },
      },
      required: ['at'],
    },
  },
  {
    name: 'ground',
    description: 'The shape of the land at a point: height, slope, which way it falls, and the lowest ground nearby. Ask this before proposing anything that sits on the ground.',
    parameters: {
      type: 'object',
      properties: { at: { type: 'array', items: { type: 'number' } }, radius: { type: 'number' } },
      required: ['at'],
    },
  },
  {
    name: 'measure',
    description: 'Exact dimensions, area, height, material and provenance of specific things, by id.',
    parameters: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } } },
      required: ['ids'],
    },
  },
  {
    name: 'relations',
    description: 'What a thing is connected to, holds up, is held up by, or sits beside.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'flood',
    description: 'Run the rainfall model and report what gets wet, how deep, and where the water goes. Real simulation, not an estimate.',
    parameters: {
      type: 'object',
      properties: {
        rain: { type: 'string', enum: ['light', 'heavy', 'extreme'] },
        near: { type: 'array', items: { type: 'number' }, description: 'optional [x, y] to report around' },
      },
    },
  },
  {
    name: 'blocked',
    description: 'Whether something built at a point would stand in the way of a road, path or building, and what exactly it would meet.',
    parameters: {
      type: 'object',
      properties: {
        at: { type: 'array', items: { type: 'number' } },
        width: { type: 'number' }, depth: { type: 'number' },
      },
      required: ['at'],
    },
  },
  {
    name: 'seat',
    description: 'What it would cost the ground to accept a building of a given size at a point: cut and fill in cubic metres, the floor level, and which orientation moves least earth. Does not build anything.',
    parameters: {
      type: 'object',
      properties: {
        at: { type: 'array', items: { type: 'number' } },
        width: { type: 'number' }, depth: { type: 'number' }, height: { type: 'number' },
        rotation: { type: 'number', description: 'degrees; omit to be told the cheapest' },
      },
      required: ['at', 'width', 'depth'],
    },
  },
  {
    name: 'why',
    description: 'The place’s own account of why something is there: who made it, when, on what evidence, and what has changed since.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'propose',
    description: 'Say what should happen, in ordinary language, once you have looked. This is the only tool that produces an answer for the person; everything else is you finding out.',
    parameters: {
      type: 'object',
      properties: {
        sentence: { type: 'string', description: 'what to do, as a person would say it' },
        because: { type: 'string', description: 'the measured reason, citing the numbers you were given' },
        operations: {
          type: 'array',
          description: 'optional interface actions: look, point, select, circle, line, note, say',
          items: { type: 'object' },
        },
      },
      required: ['sentence', 'because'],
    },
  },
];

/**
 * Run one tool call against the world.
 *
 * Errors are returned rather than thrown: a model that asks a bad question
 * should be told what was wrong with the question and get another turn, not
 * have the whole conversation collapse.
 */
export function runTool(world, name, args = {}) {
  try {
    const fn = RUNNERS[name];
    if (!fn) return { error: `there is no tool called "${name}". There are: ${TOOLS.map((t) => t.name).join(', ')}` };
    return fn(world, args);
  } catch (err) {
    return { error: String(err.message || err).slice(0, 200) };
  }
}

const at2 = (a) => (Array.isArray(a) && a.length >= 2 && a.every(Number.isFinite) ? [a[0], a[1]] : null);

const RUNNERS = {
  look(world, { at, radius = 60 }) {
    const p = at2(at);
    if (!p) return { error: 'look needs `at` as [x, y] in metres' };
    const near = world.nearby(p, radius).filter((h) => !['opening', 'furniture', 'room'].includes(h.entity.type));
    return {
      at: p,
      radius,
      found: near.length,
      things: near.slice(0, 24).map((h) => {
        const e = h.entity;
        const ring = world.ringOf(e);
        const ob = ring ? G.orientedBounds(ring) : null;
        return {
          id: e.id,
          kind: e.use || e.subtype || e.type,
          name: e.name || null,
          metres: ob ? `${ob.width.toFixed(1)}×${ob.depth.toFixed(1)}` : null,
          area_m2: ring ? Math.round(Math.abs(G.area(ring))) : null,
          height_m: +(e.zTop - e.zBase).toFixed(1),
          away_m: Math.round(h.dist ?? G.dist(p, ring ? G.centroid(ring) : p)),
          epistemic: e.epistemic || 'MODEL',
        };
      }),
    };
  },

  ground(world, { at, radius = 60 }) {
    const p = at2(at);
    if (!p) return { error: 'ground needs `at` as [x, y] in metres' };
    if (!world.place.terrain) return { error: 'this place has no elevation data — the ground is level and unknown' };
    const slope = world.place.terrain.slopeAt(p[0], p[1]);
    const here = world.place.groundAt(p[0], p[1]);
    let low = { z: Infinity, at: null }, high = { z: -Infinity, at: null };
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const q = [p[0] + Math.cos(ang) * radius, p[1] + Math.sin(ang) * radius];
      const z = world.place.groundAt(q[0], q[1]);
      if (z < low.z) low = { z, at: q.map(Math.round) };
      if (z > high.z) high = { z, at: q.map(Math.round) };
    }
    const downhill = Math.atan2(-slope.dzdy, -slope.dzdx) * (180 / Math.PI);
    return {
      at: p,
      height_m: +here.toFixed(2),
      slope_percent: +(slope.grade * 100).toFixed(1),
      falls_towards_degrees: Math.round((downhill + 360) % 360),
      lowest_within_radius: { height_m: +low.z.toFixed(2), at: low.at, below_by_m: +(here - low.z).toFixed(2) },
      highest_within_radius: { height_m: +high.z.toFixed(2), at: high.at, above_by_m: +(high.z - here).toFixed(2) },
      note: world.place.meta?.refined
        ? 'this ground has been read finer than its source samples; between them it is interpolation, not survey'
        : null,
    };
  },

  measure(world, { ids }) {
    if (!Array.isArray(ids) || !ids.length) return { error: 'measure needs `ids`' };
    const out = [], missing = [];
    for (const id of ids.slice(0, 20)) {
      const e = world.get(id);
      if (!e) { missing.push(id); continue; }
      const ring = world.ringOf(e);
      const ob = ring ? G.orientedBounds(ring) : null;
      const span = ring && world.place.terrain
        ? G.groundSpan(ring, (x, y) => world.place.groundAt(x, y)) : null;
      out.push({
        id, name: e.name || null, kind: e.use || e.subtype || e.type,
        width_m: ob ? +ob.width.toFixed(2) : null,
        depth_m: ob ? +ob.depth.toFixed(2) : null,
        area_m2: ring ? +Math.abs(G.area(ring)).toFixed(1) : null,
        height_above_ground_m: span ? +(e.zTop - span.hi).toFixed(2) : +(e.zTop - e.zBase).toFixed(2),
        ground_falls_across_it_m: span ? +(span.hi - span.lo).toFixed(2) : null,
        material: e.material || null,
        epistemic: e.epistemic || 'MODEL',
        made_by: e.provenance?.author || 'unknown',
      });
    }
    return { measured: out, not_found: missing };
  },

  relations(world, { id }) {
    if (!world.get(id)) return { error: `no such thing: ${id}` };
    const rels = describeRelations(world.place, id).filter((r) => r.ids.length);
    return {
      id,
      relations: rels.map((r) => ({ kind: r.kind, count: r.ids.length, ids: r.ids.slice(0, 12) })),
      none: rels.length === 0 || undefined,
    };
  },

  flood(world, { rain = 'heavy', near = null }) {
    const water = runWater(world, { rain });
    const p = at2(near);
    const wet = [...water.exposure.entries()]
      .filter(([, v]) => v.maxDepth > 0.05)
      .map(([id, v]) => {
        const e = world.get(id);
        const ring = e && world.ringOf(e);
        return { id, name: e?.name || e?.type || id, depth_m: +v.maxDepth.toFixed(2), at: ring ? G.centroid(ring).map(Math.round) : null };
      })
      .filter((w) => !p || !w.at || G.dist(w.at, p) < 200)
      .sort((a, b) => b.depth_m - a.depth_m);
    return {
      rain,
      rainfall_mm: water.model.assumptions.rainfall_mm[rain],
      flooded_area_m2: Math.round(water.floodedArea),
      deepest_m: +water.maxDepth.toFixed(2),
      wet_things: wet.slice(0, 20),
      how: 'shallow-water rainfall over the real heightfield; peak depth during the event, not a steady state',
    };
  },

  blocked(world, { at, width = 8, depth = 6 }) {
    const p = at2(at);
    if (!p) return { error: 'blocked needs `at` as [x, y]' };
    const ring = G.rectRing ? G.rectRing(p[0], p[1], width, depth) : G.circleRing(p[0], p[1], Math.max(width, depth) / 2, 12);
    const base = world.place.groundAt(p[0], p[1]);
    const hit = obstruction(world, ring, base, base + 3);
    return {
      at: p, footprint_m: `${width}×${depth}`,
      clear: hit.length === 0,
      meets: hit.map((b) => ({ id: b.id, name: b.name, kind: b.type })),
    };
  },

  seat(world, { at, width, depth, height = 3.2, rotation = null }) {
    const p = at2(at);
    if (!p) return { error: 'seat needs `at` as [x, y]' };
    if (!(width > 0 && depth > 0)) return { error: 'seat needs `width` and `depth` in metres' };
    if (!world.place.terrain) return { error: 'no ground here to seat anything on' };
    const body = boxBody({ width, depth, height, name: 'proposed building' });
    const one = (deg) => {
      const s = planSeat(world, body, p, { rotation: (deg * Math.PI) / 180, level: 'balanced' });
      return { degrees: deg, cut_m3: Math.round(s.cut), fill_m3: Math.round(s.fill), earth_m3: Math.round(s.cut + s.fill), floor_m: +s.floor.toFixed(2), disturbs_m2: Math.round(s.disturbedArea), retaining_wall_m: s.retained ? +s.retained.toFixed(1) : 0 };
    };
    if (rotation !== null && Number.isFinite(rotation)) return { at: p, ...one(rotation), note: 'as asked' };
    const tried = [];
    for (let deg = 0; deg < 180; deg += 15) tried.push(one(deg));
    tried.sort((a, b) => a.earth_m3 - b.earth_m3);
    return {
      at: p,
      cheapest: tried[0],
      most_expensive: tried[tried.length - 1],
      saving_m3: tried[tried.length - 1].earth_m3 - tried[0].earth_m3,
      note: 'orientation on a slope is an earthwork decision, not a style one',
    };
  },

  why(world, { id }) {
    if (!world.get(id)) return { error: `no such thing: ${id}` };
    const a = ask(world, { operation: 'ASK', question: { kind: 'why' }, reference: { ids: [id], kind: 'explicit', basis: [] } }, {});
    return { id, account: a.text, rows: (a.rows || []).slice(0, 3) };
  },

  propose(world, args) {
    if (!args?.sentence) return { error: 'propose needs a `sentence`' };
    return { accepted_for_review: true, sentence: args.sentence, because: args.because || null, operations: args.operations || [] };
  },
};
