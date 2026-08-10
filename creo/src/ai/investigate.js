// INVESTIGATION — what CREO finds out before it says anything.
//
// Every step here is a real query against the world, and every step has a
// visible consequence: the drains light up, the causal chain is traced, the rain
// actually runs. That is the difference between showing progress and showing
// work. Nothing in this file needs a model; the findings are what gets handed to
// one afterwards.

import * as G from '../core/geom.js';
import { runWater } from '../sim/water.js';
import { buildGraph, obstruction } from '../sim/movement.js';
import { describeRelations } from '../core/relations.js';

/**
 * @param {World} world
 * @param {{focus:string[], point:number[]|null, question:string}} situation
 * @param {(step:string, visual:object)=>void} onStep  called as each finding lands
 * @returns {Promise<{findings:Array, water:object|null}>}
 */
export async function investigate(world, situation, onStep = () => {}) {
  const findings = [];
  const focus = (situation.focus || []).map((id) => world.get(id)).filter(Boolean);
  const at = situation.point
    || (focus[0] ? G.centroid(world.ringOf(focus[0])) : null);
  const say = (kind, text, visual = {}) => {
    findings.push({ kind, text, ...visual });
    onStep(kind, { text, ...visual });
  };
  const pause = () => new Promise((r) => setTimeout(r, 120));

  // 1. what is actually here
  if (at) {
    const near = world.nearby(at, 60).slice(0, 12);
    const names = near.map((h) => h.entity.name || h.entity.use || h.entity.type);
    say('reading', `${near.length} things within 60 m: ${[...new Set(names)].slice(0, 6).join(', ')}.`, {
      highlight: near.map((h) => h.entity.id),
    });
    await pause();
  }

  // 2. the ground it sits on
  if (at && world.place.terrain) {
    const slope = world.place.terrain.slopeAt(at[0], at[1]);
    const here = world.place.groundAt(at[0], at[1]);
    let lowest = { z: Infinity, p: null };
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const p = [at[0] + Math.cos(ang) * 60, at[1] + Math.sin(ang) * 60];
      const z = world.place.groundAt(p[0], p[1]);
      if (z < lowest.z) lowest = { z, p };
    }
    say('terrain',
      slope.grade < 0.005
        ? `The ground here is almost flat (${(slope.grade * 100).toFixed(1)}%), so nothing drains itself.`
        : `The ground falls ${(slope.grade * 100).toFixed(1)}% and the lowest ground within 60 m is ${(here - lowest.z).toFixed(1)} m below.`,
      { trace: lowest.p ? [[at, lowest.p]] : [] });
    await pause();
  }

  // 3. what water is already here, and where it goes
  const waters = world.entities().filter((e) => ['water', 'stream', 'drain'].includes(e.type));
  if (at && waters.length) {
    const nearWater = waters
      .map((e) => ({ e, d: G.ringDistance(world.ringOf(e), G.circleRing(at[0], at[1], 3, 8)) }))
      .filter((x) => x.d < 250).sort((a, b) => a.d - b.d).slice(0, 4);
    if (nearWater.length) {
      say('water',
        nearWater.map((x) => `${x.e.name || x.e.subtype || x.e.type} ${x.d < 1 ? 'runs through here' : `${x.d.toFixed(0)} m away`}`).join('; ') + '.',
        { highlight: nearWater.map((x) => x.e.id) });
      await pause();
    }
    const drains = waters.filter((e) => e.type === 'drain' || ['drain', 'ditch', 'canal'].includes(e.subtype));
    if (drains.length) {
      say('drains', `${drains.length} constructed drain${drains.length === 1 ? '' : 's'} in this place.`, {
        highlight: drains.map((e) => e.id),
      });
      await pause();
    }
  }

  // 4. what the world says connects to what
  for (const e of focus.slice(0, 2)) {
    const rels = describeRelations(world.place, e.id).filter((r) => r.ids.length);
    if (!rels.length) continue;
    say('relations',
      `${e.name || e.type}: ${rels.slice(0, 4).map((r) => `${r.kind} ${r.ids.length}`).join(', ')}.`,
      { highlight: rels.flatMap((r) => r.ids).slice(0, 30) });
    await pause();
  }

  // 5. who would be cut off
  if (at) {
    const probe = G.circleRing(at[0], at[1], 8, 12);
    const blocked = obstruction(world, probe, world.place.groundAt(at[0], at[1]), world.place.groundAt(at[0], at[1]) + 3);
    if (blocked.length) {
      say('routes', `Anything built here meets ${blocked.map((b) => b.name).join(', ')}.`, {
        highlight: blocked.map((b) => b.id),
      });
      await pause();
    }
  }

  // 6. run the rain, for real
  let water = null;
  try {
    water = runWater(world, { rain: 'heavy' });
    const wet = [...water.exposure.entries()].filter(([, v]) => v.maxDepth > 0.05);
    const nearHere = at
      ? wet.filter(([id]) => {
        const e = world.get(id);
        const r = e && world.ringOf(e);
        return r && G.dist(G.centroid(r), at) < 150;
      }) : wet;
    say('rain',
      `In ${water.model.assumptions.rainfall_mm.heavy} mm of rain: ${water.floodedArea.toFixed(0)} m² over 5 cm, deepest ${(water.maxDepth * 100).toFixed(0)} cm`
      + (nearHere.length ? `, ${nearHere.length} built things wet near here.` : '.'),
      { overlay: { kind: 'water', water }, highlight: nearHere.map(([id]) => id).slice(0, 20) });
  } catch { /* no terrain: nothing to run */ }

  return { findings, water };
}

/** A compact account of the investigation, for the model and for the person. */
export function summarise(findings) {
  return findings.map((f) => `- ${f.text}`).join('\n');
}
