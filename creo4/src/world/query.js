// ASK PLACE (§21).
//
// The world itself is queryable, and it prefers to answer spatially — highlight,
// isolate, trace, overlay, compare — with prose as the caption rather than the
// substance.

import * as G from '../core/geom.js';
import { describeRelations } from '../core/relations.js';
import { label } from './certificate.js';
import { runWater } from '../sim/water.js';
import { shadeCoverage, nightCoverage } from '../sim/shade.js';
import { buildGraph, reachability, obstruction } from '../sim/movement.js';
import { findPlacement } from './generate.js';

/**
 * @returns {{text:string, highlight:string[], trace:number[][][], rows:Array,
 *            overlay:Object|null, compare:Object|null}}
 */
export function ask(world, intent, ctx = {}) {
  const q = intent.question || { kind: 'what' };
  const ref = intent.reference;
  const ids = ref.ids || [];
  const empty = { text: '', highlight: [], trace: [], rows: [], overlay: null, compare: null };

  switch (q.kind) {
    // ---------------------------------------------------------------- why ---
    case 'why': {
      if (!ids.length && ref.point) {
        const under = world.entityAt(ref.point);
        if (under) ids.push(under.id);
      }
      if (!ids.length) return { ...empty, text: 'Point at something and ask again — "why are you here?" is a question to an object.' };
      const rows = [];
      const highlight = [...ids];
      for (const id of ids) {
        const e = world.get(id);
        if (!e) continue;
        const hist = world.journal.historyOf(id);
        const first = hist[0];
        rows.push({
          id, name: label(e),
          who: e.author || 'unknown',
          when: first ? `tick ${first.event.tick}` : 'seeded with the place',
          how: first?.event.utterance ? `"${first.event.utterance.text}"` : (first?.event.label || 'imported'),
          source: e.source, epistemic: e.epistemic, certainty: e.certainty,
          branch: first?.event.branch || e.branch,
          evidence: (e.evidence || []).map((v) => v.kind).join(', ') || 'none',
          relations: describeRelations(world.place, id).map((r) => `${r.kind} ${r.ids.join(', ')}`),
          changes: hist.length,
        });
        for (const r of describeRelations(world.place, id)) highlight.push(...r.ids);
      }
      return {
        ...empty,
        text: rows.map((r) => `${r.name} — ${r.epistemic.toLowerCase()}, by ${r.who}, ${r.when}. ${r.how}. ${r.changes} change${r.changes === 1 ? '' : 's'} since.`).join('\n'),
        rows, highlight: [...new Set(highlight)],
      };
    }

    // ------------------------------------------------------------ why-not ---
    case 'why-not': {
      // "why can't this go here?" — show the actual constraint, highlighted.
      const point = ref.point || (ids[0] ? G.centroid(world.ringOf(world.get(ids[0]))) : null);
      if (!point) return { ...empty, text: 'Point where you wanted it.' };
      const probe = ctx.probeSize || [5, 4];
      const cands = findPlacement(world, { point, size: probe, samples: 6, seedName: 'why-not' });
      const ring = G.rectRing(point[0], point[1], probe[0], probe[1], 0);
      const ground = world.place.groundAt(point[0], point[1]);
      const blockers = world.index.overlapping(ring, ground - 0.5, ground + 4).map((id) => world.get(id)).filter(Boolean);
      const blocked = obstruction(world, ring, ground - 0.5, ground + 3);
      const reasons = [];
      for (const b of blockers) reasons.push(`${label(b)} is already there (${b.type})`);
      for (const b of blocked) reasons.push(`it would ${b.severed ? 'sever' : 'narrow'} ${b.name}`);
      if (world.place.terrain) {
        const s = world.place.terrain.slopeAt(point[0], point[1]);
        if (s.grade > 0.18) reasons.push(`the ground falls ${(s.grade * 100).toFixed(0)}% here`);
      }
      return {
        ...empty,
        text: reasons.length
          ? `Because ${reasons.join('; and ')}.${cands[0] ? ` The nearest place it does fit is ${G.dist(cands[0].center, point).toFixed(1)} m away.` : ''}`
          : 'Nothing stops it — that spot is clear.',
        highlight: blockers.map((b) => b.id).concat(blocked.map((b) => b.id)),
        trace: cands[0] ? [[point, cands[0].center]] : [],
        overlay: { kind: 'probe', ring, ok: !reasons.length, alternative: cands[0]?.ring || null },
      };
    }

    // ---------------------------------------------------------------- who ---
    case 'who': {
      const targets = ids.length ? ids : world.journal.changedSince(Math.max(0, world.place.tick - 12));
      const byAuthor = new Map();
      for (const id of targets) {
        const hist = world.journal.historyOf(id);
        for (const h of hist) {
          const a = h.event.author;
          if (!byAuthor.has(a)) byAuthor.set(a, []);
          byAuthor.get(a).push({ id, label: h.event.label, utterance: h.event.utterance?.text || null, tick: h.event.tick });
        }
      }
      return {
        ...empty,
        text: byAuthor.size
          ? [...byAuthor.entries()].map(([a, list]) => `${a}: ${list.length} change${list.length === 1 ? '' : 's'} — ${[...new Set(list.map((l) => l.label))].slice(0, 3).join('; ')}`).join('\n')
          : 'Nobody has changed this yet — it came with the place.',
        rows: [...byAuthor.entries()].map(([a, list]) => ({ author: a, changes: list })),
        highlight: targets,
      };
    }

    // ------------------------------------------------------------ changed ---
    case 'changed': {
      const since = ctx.sinceTick ?? Math.max(0, world.place.tick - 10);
      const changed = world.journal.changedSince(since, world.branch);
      return {
        ...empty,
        text: changed.length ? `${changed.length} things changed since tick ${since}.` : 'Nothing has changed here.',
        highlight: changed,
        rows: changed.map((id) => {
          const h = world.journal.historyOf(id).slice(-1)[0];
          return { id, name: label(world.get(id)), by: h?.event.author, what: h?.event.label, said: h?.event.utterance?.text || null };
        }),
      };
    }

    // ---------------------------------------------------------- what-blocks --
    case 'what-blocks': {
      const target = ids[0] ? world.get(ids[0]) : null;
      if (!target) return { ...empty, text: 'Select the path you mean.' };
      const blockers = world.place.relations.filter((r) => r.kind === 'blocks' && r.to === target.id).map((r) => r.from);
      const graph = buildGraph(world);
      const severed = graph.edges.filter((e) => e.ownerId === target.id && e.blockedBy);
      const ids2 = [...new Set(blockers.concat(severed.map((s) => s.blockedBy)))];
      return {
        ...empty,
        text: ids2.length
          ? `${ids2.map((id) => label(world.get(id))).join(', ')} ${ids2.length === 1 ? 'blocks' : 'block'} ${label(target)}.`
          : `Nothing blocks ${label(target)} — it runs clear.`,
        highlight: ids2.concat([target.id]),
        trace: severed.map((s) => [graph.nodes[s.a].p, graph.nodes[s.b].p]),
      };
    }

    // ---------------------------------------------------------- where-fit ---
    case 'where-fit': {
      const size = ctx.probeSize || (intent.dimensions ? [intent.dimensions.width, intent.dimensions.depth || intent.dimensions.width] : [5, 4]);
      const region = ref.ring || null;
      const point = ref.point || (region ? G.centroid(region) : G.centroid([[0, 0]]));
      const cands = findPlacement(world, { region, point, size, samples: 18, seedName: 'where-fit' }).slice(0, 12);
      return {
        ...empty,
        text: cands.length ? `${cands.length} places where ${size[0]} × ${size[1]} m fits without removing anything.` : `Nowhere here fits ${size[0]} × ${size[1]} m without removing something.`,
        overlay: { kind: 'fits', rings: cands.map((c) => c.ring) },
        highlight: [],
      };
    }

    // -------------------------------------------------------- what-removes ---
    case 'what-removes': {
      const ring = ref.ring || (ids[0] ? world.ringOf(world.get(ids[0])) : null);
      if (!ring) return { ...empty, text: 'Circle the area you mean.' };
      const hit = world.index.overlapping(ring, -1, 99).map((id) => world.get(id)).filter((e) => e && e.type !== 'observation' && e.type !== 'surface');
      return {
        ...empty,
        text: hit.length ? `It would remove ${hit.map((e) => label(e)).join(', ')}.` : 'It would remove nothing.',
        highlight: hit.map((e) => e.id),
        rows: hit.map((e) => ({ id: e.id, name: label(e), type: e.type, area: G.area(world.ringOf(e)).toFixed(1) })),
      };
    }

    // --------------------------------------------------------------- which ---
    case 'which': {
      const norm = q.raw;
      if (/flood|water|maji|inunda/.test(norm)) {
        const w = runWater(world, { rain: 'heavy' });
        const wet = [...w.exposure.entries()].filter(([, v]) => v.maxDepth > 0.05);
        return {
          ...empty,
          text: `${w.pondCount} places hold water in ${w.model.assumptions.rainfall_mm.heavy} mm rain; ${wet.length} built things get wet; deepest ${w.maxDepth.toFixed(2)} m.`,
          highlight: wet.map(([id]) => id),
          overlay: { kind: 'water', water: w },
          rows: wet.map(([id, v]) => ({ id, name: label(world.get(id)), depth: `${v.maxDepth.toFixed(2)} m`, wet: `${(v.wetFraction * 100).toFixed(0)}%` })),
        };
      }
      if (/shade|shadow|sun|hot/.test(norm)) {
        const region = ref.ring || boundsRing(world);
        const s = shadeCoverage(world, region, 14);
        return { ...empty, text: `${(s.fraction * 100).toFixed(0)}% of this area is shaded at 2pm.`, overlay: { kind: 'shade', hour: 14, unshaded: s.unshaded } };
      }
      if (/dark|night|light/.test(norm)) {
        const n = nightCoverage(world);
        return { ...empty, text: `${(n.fraction * 100).toFixed(0)}% of the walkable network is lit at night.`, overlay: { kind: 'dark', points: n.dark.map((d) => d.p) } };
      }
      if (/disputed|contested|argu/.test(norm)) {
        const disputed = world.entities().filter((e) => e.epistemic === 'DISPUTED')
          .concat(world.place.relations.filter((r) => r.kind === 'disputedBy').map((r) => world.get(r.to)).filter(Boolean));
        return { ...empty, text: disputed.length ? `${disputed.length} things are disputed here.` : 'Nothing is currently disputed.', highlight: disputed.map((e) => e.id) };
      }
      return whatIsHere(world, ref, empty);
    }

    // ------------------------------------------------------------ how-many ---
    case 'how-many': {
      const pool = ref.ring ? world.index.within(ref.ring).map((id) => world.get(id)) : world.entities();
      const counts = new Map();
      for (const e of pool) if (e) counts.set(e.type, (counts.get(e.type) || 0) + 1);
      return {
        ...empty,
        text: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${t}${n === 1 ? '' : 's'}`).join(', '),
        rows: [...counts.entries()].map(([type, n]) => ({ type, n })),
        highlight: pool.filter(Boolean).map((e) => e.id),
      };
    }

    // ------------------------------------------------------------- compare ---
    case 'compare': {
      const branches = ctx.compareBranches || [...world.place.branches.keys()].slice(0, 6);
      const rows = branches.map((bid) => {
        const view = world.view(bid);
        const prev = world.place.activeBranch;
        world.place.activeBranch = bid;
        world.dirty = true; world.reindex();
        const w = runWater(world, { rain: 'heavy' });
        const acc = reachability(world, seedOf(world));
        world.place.activeBranch = prev;
        world.dirty = true; world.reindex();
        return {
          branch: bid, name: world.place.branches.get(bid)?.name || bid,
          entities: view.entities.length,
          flooded: `${w.floodedArea.toFixed(0)} m²`,
          maxDepth: `${w.maxDepth.toFixed(2)} m`,
          connectivity: `${(acc.fraction * 100).toFixed(0)}%`,
        };
      });
      return { ...empty, text: rows.map((r) => `${r.name}: ${r.flooded} flooded, ${r.maxDepth} deepest, ${r.connectivity} connected`).join('\n'), rows, compare: { branches, rows } };
    }

    case 'where': {
      const thing = intent.thing;
      const pool = world.entities().filter((e) => !thing || e.type === thing || e.subtype === thing);
      return { ...empty, text: `${pool.length} found.`, highlight: pool.map((e) => e.id) };
    }

    default:
      return whatIsHere(world, ref, empty);
  }
}

function whatIsHere(world, ref, empty) {
  const ids = ref.ids?.length ? ref.ids : (ref.ring ? world.index.within(ref.ring) : (ref.point ? world.index.near(ref.point, 10).map((h) => h.id) : []));
  const ents = ids.map((id) => world.get(id)).filter(Boolean);
  if (!ents.length) return { ...empty, text: 'Nothing is recorded there yet. Say something about it and there will be.' };
  const obs = ents.filter((e) => e.type === 'observation');
  const rest = ents.filter((e) => e.type !== 'observation');
  const lines = [];
  if (rest.length) lines.push(rest.map((e) => label(e)).join(', '));
  for (const o of obs) lines.push(`someone said: "${o.evidence?.[0]?.text || o.name}" (${o.author})`);
  return { ...empty, text: lines.join('\n'), highlight: ents.map((e) => e.id), rows: ents.map((e) => ({ id: e.id, type: e.type, epistemic: e.epistemic, author: e.author })) };
}

function boundsRing(world) {
  const b = world.place.bounds();
  return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
}

function seedOf(world) {
  const net = world.entities().find((e) => (e.type === 'road' || e.type === 'path') && e.path);
  if (net) return net.path[0];
  const b = world.place.bounds();
  return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
}
