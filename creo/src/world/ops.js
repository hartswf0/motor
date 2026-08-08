// PROPOSAL BEFORE COMMIT (§10).
//
// EXPRESSION → REFERENCE → INTENT → WORLD QUERY → PLAN → GHOST → CERTIFICATE →
// CONSEQUENCE → COMMIT.
//
// Nothing substantial mutates the world until a person accepts it, and what they
// accept is exactly what they were shown.

import * as G from '../core/geom.js';

import { certify } from './certificate.js';
import { GENERATORS, windowCorridors } from './generate.js';
import { runWater } from '../sim/water.js';

let planSeq = 0;

/**
 * Compile an intent into a reviewable plan against the current world.
 * @returns {Plan}
 */
export function plan(world, intent, ctx = {}) {
  const id = `plan_${++planSeq}`;
  const base = {
    id, intent, kind: intent.operation, title: '', summary: '',
    ghosts: [], removals: [], relations: [], branchOps: [],
    region: intent.reference.ring || null,
    corridors: [], alternatives: [], answer: null, simulation: null,
    autoCommit: false, needs: intent.needs.slice(),
  };

  // ASK, SIMULATE, MERGE and BRANCH can legitimately address the whole place;
  // everything that puts geometry into the ground must know where.
  if (intent.reference.kind === 'none' && !['ASK', 'SIMULATE', 'MERGE', 'BRANCH'].includes(intent.operation)) {
    return {
      ...base,
      title: 'Which part of the place do you mean?',
      summary: intent.reference.ambiguity.question,
      certificate: { valid: false, findings: [{ code: 'AMBIGUOUS_REFERENCE', severity: 'error', entity: null, others: [], message: intent.reference.ambiguity.reason }] },
    };
  }

  switch (intent.operation) {
    case 'OBSERVE':  return finish(world, planObserve(world, intent, base, ctx));
    case 'PROPOSE':  return finish(world, planPropose(world, intent, base, ctx));
    case 'MODIFY':   return finish(world, planModify(world, intent, base, ctx));
    case 'RELATE':   return finish(world, planRelate(world, intent, base, ctx));
    case 'PRESERVE': return finish(world, planPreserve(world, intent, base, ctx));
    case 'REMOVE':   return finish(world, planRemove(world, intent, base, ctx));
    case 'BRANCH':   return finish(world, planBranch(world, intent, base, ctx));
    case 'MERGE':    return finish(world, planMerge(world, intent, base, ctx));
    case 'SIMULATE': return finish(world, planSimulate(world, intent, base, ctx));
    case 'MEASURE':  return finish(world, planMeasure(world, intent, base, ctx));
    default:         return finish(world, { ...base, title: 'Not understood', summary: intent.original });
  }
}

function finish(world, p) {
  if (!p.certificate) {
    p.certificate = p.ghosts.length
      ? certify(world, p.ghosts, { region: p.region, constraints: p.constraints || [] })
      : { valid: true, findings: [] };
  }
  return p;
}

// ------------------------------------------------------------------ OBSERVE --
function planObserve(world, intent, base) {
  const ref = intent.reference;
  const author = intent.author || 'you';

  if (intent.secondary === 'ROUTE' && (ref.line || ref.kind === 'polyline')) {
    const line = ref.line;
    const id = world.place.newId('route');
    return {
      ...base,
      title: 'People actually walk here',
      summary: `A ${G.perimeter(line, false).toFixed(0)} m desire line recorded as observed movement.`,
      autoCommit: true,
      ghosts: [{
        id, type: 'path', subtype: 'desire-line', name: 'Observed route',
        network: 'paths', path: line, width: 1.1,
        zBase: world.place.groundAt(...line[0]), zTop: world.place.groundAt(...line[0]) + 0.02,
        collision: 'none', epistemic: 'OBSERVED', certainty: 0.7, author,
        evidence: [{ kind: 'utterance', text: intent.original, lang: intent.lang }],
        sim: { desire: 1 },
      }],
    };
  }

  const ring = ref.ring || (ref.point ? G.circleRing(ref.point[0], ref.point[1], 4, 20) : null);
  const anchor = ref.point || G.centroid(ring);
  const id = world.place.newId('obs');
  const about = ref.ids.slice();
  return {
    ...base,
    title: `Observation: ${intent.condition || 'about this place'}`,
    summary: `"${intent.original}" recorded here${about.length ? `, about ${about.join(', ')}` : ''}.`,
    autoCommit: true,
    ghosts: [{
      id, type: 'observation', name: intent.original.slice(0, 60),
      footprint: ring, zBase: world.place.groundAt(...anchor), zTop: world.place.groundAt(...anchor) + 0.02,
      collision: 'none', epistemic: 'OBSERVED', certainty: 0.8, author,
      subtype: intent.condition,
      evidence: [{ kind: 'utterance', text: intent.original, lang: intent.lang, basis: ref.basis }],
      props: { condition: intent.condition, about },
    }],
    relations: about.map((t) => ({ from: id, kind: 'usedBy', to: t })),
  };
}

// ------------------------------------------------------------------ PROPOSE --
function planPropose(world, intent, base, ctx) {
  const ref = intent.reference;
  const thing = intent.thing || 'building';
  const gen = GENERATORS[thing] || GENERATORS.building;
  const author = intent.author || 'you';

  // Constraints stated in the same breath must bind the generator, not just warn.
  const corridors = [];
  const keepClearOf = [];
  for (const c of intent.constraints) {
    if (c.kind === 'DONT_BLOCK') {
      const targets = resolveConstraintTargets(world, c, ref);
      corridors.push(...windowCorridors(world, targets.filter((id) => world.get(id)?.type === 'opening')));
      keepClearOf.push(...targets.filter((id) => world.get(id)?.type !== 'opening'));
    }
    if (c.kind === 'PRESERVE') keepClearOf.push(...resolveConstraintTargets(world, c, ref));
  }

  // Pointing at a roof means the roof, not the ground under it.
  const host = ref.ids.map((i) => world.get(i)).find((e) => e && e.type === 'structure');
  const onRoof = !!host && (gen.onRoof || /roof|rooftop|paa|techo|telhado|toit/.test(intent.norm));

  // A circled area is a search space; a tap is a location. Keep them distinct.
  const searchRegion = ref.kind === 'region' ? ref.ring : null;
  const genCtx = {
    region: searchRegion, point: ref.point, ids: ref.ids, line: ref.line,
    count: intent.count, dimensions: intent.dimensions,
    corridors, keepClearOf, onRoof, roofOf: host?.id,
    seed: `${intent.norm}|${world.place.tick}`,
    zBase: onRoof ? host.zTop : undefined,
  };
  const specs = gen(world, genCtx);
  if (!specs.length) {
    return { ...base, title: `Nowhere for a ${thing} here`, summary: 'The area you indicated is fully occupied by things that would have to be removed first.',
      certificate: { valid: false, findings: [{ code: 'REQUIRES_RELOCATION', severity: 'error', entity: null, others: ref.ids, message: 'No free ground in the indicated area.' }] } };
  }

  const ghosts = specs.map((s, i) => ({
    ...s,
    id: s.id || world.place.newId(s.type),
    status: 'GHOST', epistemic: 'PROPOSED', certainty: 0.6, author,
    evidence: [{ kind: 'utterance', text: intent.original, lang: intent.lang, basis: ref.basis }],
    props: { ...(s.props || {}), proposalIndex: i },
  }));

  const constraints = intent.constraints.map((c) => ({
    ...c,
    corridors: c.kind === 'DONT_BLOCK' ? corridors : undefined,
    ids: c.kind === 'PRESERVE' ? keepClearOf : undefined,
  }));

  const cert = certify(world, ghosts, { region: searchRegion, constraints });

  // Alternatives: same intent, other viable placements the place offered.
  const alternatives = [];
  const alt = ghosts[0]?.alternatives || [];
  alt.slice(0, 2).forEach((ring, i) => {
    const g = { ...ghosts[0], id: world.place.newId(ghosts[0].type), footprint: ring };
    alternatives.push({ id: `alt_${i}`, label: `Alternative ${String.fromCharCode(66 + i)}`, ghosts: [g], certificate: certify(world, [g], { region: searchRegion, constraints }) });
  });

  return {
    ...base,
    title: `Proposed: ${ghosts.length > 1 ? `${ghosts.length} ${thing}s` : (ghosts[0].name || thing)}`,
    summary: describeGhosts(world, ghosts, onRoof ? `on the roof of ${host.name || host.id}` : null),
    ghosts, certificate: cert, alternatives, constraints, corridors,
  };
}

function resolveConstraintTargets(world, c, ref) {
  const wanted = c.thing;
  const pool = new Set();
  for (const id of ref.ids) {
    const e = world.get(id);
    if (!e) continue;
    pool.add(id);
    for (const child of world.entities()) if (child.parent === id) pool.add(child.id);
  }
  if (!wanted) return [...pool];
  const typeMap = { window: 'opening', roof: 'roof', tree: 'tree', path: 'path', road: 'road', people: 'path', door: 'opening' };
  const t = typeMap[wanted] || wanted;
  const filtered = [...pool].filter((id) => world.get(id)?.type === t);
  if (filtered.length) return filtered;
  // widen the net to the neighbourhood of the reference
  const near = ref.point ? world.nearby(ref.point, 25) : [];
  return near.filter((h) => h.entity.type === t).map((h) => h.entity.id);
}

// ------------------------------------------------------------------- MODIFY --
function planModify(world, intent, base) {
  const ids = intent.reference.ids;
  if (!ids.length) return { ...base, title: 'Nothing to change', summary: 'Select the thing you want to change.' };
  const mag = intent.magnitude || { kind: 'step', step: 1 };
  const ghosts = [];
  const patches = [];
  // A dimension is a claim about a place, and places have a size. Asking for
  // 9 999 999 m used to produce a "spatially valid" proposal with a footprint
  // larger than a country, which then took the spatial index down with it.
  const b = world.place.bounds();
  const extent = Math.max(b[2] - b[0], b[3] - b[1]);
  const maxDim = Math.max(120, extent * 3);
  const clamps = [];
  const limit = (v, what) => {
    const c = Math.max(0.05, Math.min(maxDim, v));
    if (Math.abs(c - v) > 1e-6) clamps.push({ what, asked: v, used: c });
    return c;
  };

  for (const id of ids) {
    const e = world.get(id);
    if (!e) continue;
    const ring = world.ringOf(e);
    const height = e.zTop - e.zBase;
    let patch = null;

    if (intent.secondary === 'EXTRUDE') {
      let newH = height;
      if (mag.kind === 'absolute') newH = mag.metres;
      else if (mag.kind === 'delta') newH = height + mag.metres;
      else if (mag.kind === 'factor') newH = height * mag.factor;
      else if (mag.kind === 'floors') newH = height + mag.floors * 3.0;
      else newH = height + (mag.step || 1) * 3.0;
      patch = { zTop: e.zBase + limit(Math.max(0.3, newH), 'height') };
    } else if (intent.secondary === 'WIDEN') {
      if (e.path) {
        const w = mag.kind === 'absolute' ? mag.metres : mag.kind === 'delta' ? (e.width || 1) + mag.metres : (mag.kind === 'factor' ? (e.width || 1) * mag.factor : (e.width || 1) + 0.5 * (mag.step || 1));
        patch = { width: limit(Math.max(0.2, w), 'width') };
      } else {
        const ob = G.orientedBounds(ring);
        const target = limit(mag.kind === 'absolute' ? mag.metres : mag.kind === 'delta' ? ob.width + mag.metres : (mag.kind === 'factor' ? ob.width * mag.factor : ob.width + 1), 'width');
        const s = target / Math.max(0.001, ob.width);
        patch = { footprint: G.scaleInFrame(ring, ob.angle, s, 1, ob.center) };
      }
    } else if (intent.secondary === 'DEEPEN') {
      const d = limit(mag.kind === 'absolute' ? mag.metres : mag.kind === 'delta' ? (e.zTop - e.zBase) + mag.metres : (e.zTop - e.zBase) + 0.3, 'depth');
      patch = { zBase: e.zTop - Math.max(0.05, d), props: { ...(e.props || {}), depth: d } };
    } else if (intent.secondary === 'MOVE') {
      const to = intent.reference.point;
      if (to) {
        const c = G.centroid(ring);
        const delta = G.sub(to, c);
        patch = e.path
          ? { path: e.path.map((p) => G.add(p, delta)) }
          : { footprint: ring.map((p) => G.add(p, delta)) };
      }
    } else if (intent.secondary === 'CONTINUE') {
      // MAGIC TEST G — continue from the CURRENT geometry, including manual edits.
      const ob = G.orientedBounds(ring);
      const dir = [Math.cos(ob.angle), Math.sin(ob.angle)];
      const n = intent.count || 2;
      for (let i = 1; i <= n; i++) {
        const off = G.mul(dir, (ob.width + 1.5) * i);
        ghosts.push({
          ...structuredCloneLite(e),
          id: world.place.newId(e.type),
          name: `${e.name || e.type} (continued ${i})`,
          footprint: ring.map((p) => G.add(p, off)),
          status: 'GHOST', epistemic: 'PROPOSED',
          evidence: [{ kind: 'utterance', text: intent.original, basis: ['current-geometry', ...intent.reference.basis] }],
          props: { ...(e.props || {}), continuedFrom: e.id },
        });
      }
      continue;
    } else if (mag.kind === 'absolute' || mag.kind === 'delta') {
      // PRO TEST A — "5.25 m" means 5.25 m, on the dominant dimension.
      if (e.path) patch = { width: limit(mag.metres, 'width') };
      else {
        const ob = G.orientedBounds(ring);
        const s = limit(mag.metres, 'size') / Math.max(0.001, ob.width);
        patch = { footprint: G.scaleInFrame(ring, ob.angle, s, s, ob.center) };
      }
    } else {
      patch = { zTop: e.zBase + limit(Math.max(0.3, height * (mag.factor || (1 + 0.25 * (mag.step || 1)))), 'height') };
    }

    if (patch) {
      patches.push({ id, patch });
      ghosts.push({ ...structuredCloneLite(e), ...patch, status: 'GHOST', epistemic: 'PROPOSED', props: { ...(e.props || {}), modifies: id } });
    }
  }

  const cert = certify(world, ghosts, { ignore: patches.map((p) => p.id) });
  for (const c of clamps) {
    cert.findings.unshift({
      code: 'REQUIRES_RELOCATION', severity: 'warning', entity: ids[0], others: [],
      message: `You asked for ${c.asked.toLocaleString()} m of ${c.what}; this place is about ${Math.round(extent)} m across, so it was capped at ${c.used.toFixed(1)} m.`,
    });
  }
  return {
    ...base,
    title: modifyTitle(intent, ghosts.length),
    summary: describeGhosts(world, ghosts),
    ghosts, patches, certificate: cert, clamps,
  };
}

function modifyTitle(intent, n) {
  const m = intent.magnitude;
  if (m?.kind === 'absolute') return `Set to ${m.raw}`;
  if (m?.kind === 'factor') return `${m.factor === 2 ? 'Double' : `×${m.factor}`} — ${n} thing${n === 1 ? '' : 's'}`;
  if (m?.kind === 'floors') return `Add ${m.floors} floor${m.floors === 1 ? '' : 's'}`;
  if (intent.secondary === 'CONTINUE') return 'Continue the pattern';
  return 'Change';
}

// ------------------------------------------------------------------- RELATE --
function planRelate(world, intent, base) {
  const ids = intent.reference.ids.slice(0, 2);
  if (ids.length < 2) return { ...base, title: 'Connect what to what?', summary: 'Select two things, then say "connect these".' };
  const specs = GENERATORS.bridge(world, { ids, dimensions: intent.dimensions });
  const ghosts = specs.map((s) => ({
    ...s, id: world.place.newId('bridge'), status: 'GHOST', epistemic: 'PROPOSED', author: intent.author || 'you',
    evidence: [{ kind: 'utterance', text: intent.original, basis: intent.reference.basis }],
  }));
  const cert = certify(world, ghosts);
  return {
    ...base,
    title: 'Connection proposed',
    summary: `${ghosts[0].props.span.toFixed(1)} m span at ${ghosts[0].zBase.toFixed(2)} m, ${ghosts[0].width} m wide.`,
    ghosts, certificate: cert,
    relations: [
      { from: ghosts[0].id, kind: 'connectedTo', to: ids[0] },
      { from: ghosts[0].id, kind: 'connectedTo', to: ids[1] },
    ],
  };
}

// ----------------------------------------------------------------- PRESERVE --
function planPreserve(world, intent, base) {
  const ref = intent.reference;
  let keep = ref.ids.slice();
  if (!keep.length && ref.ring) keep = world.index.within(ref.ring);
  const removals = [];

  if (intent.secondary === 'REMOVE') {
    // "keep everything except this wall" — the exception is what the pointer says.
    const exceptIds = ref.ids.length ? ref.ids : [];
    removals.push(...exceptIds);
    keep = world.entities().filter((e) => !exceptIds.includes(e.id) && e.type !== 'observation').map((e) => e.id);
  }

  return {
    ...base,
    title: removals.length ? `Keep everything except ${removals.length} thing${removals.length === 1 ? '' : 's'}` : `Keep ${keep.length} thing${keep.length === 1 ? '' : 's'}`,
    summary: removals.length
      ? `${removals.map((id) => world.get(id)?.name || id).join(', ')} would be removed. Everything else becomes protected.`
      : 'These become protected: later proposals that would remove them will be refused, not silently moved.',
    removals,
    preserve: keep,
    relations: keep.map((id) => ({ from: 'preservation', kind: 'preserves', to: id })),
    certificate: removals.length
      ? { valid: true, findings: removals.map((id) => ({ code: 'REQUIRES_REMOVAL', severity: 'warning', entity: id, others: [], message: `Removes ${world.get(id)?.name || id}.` })) }
      : { valid: true, findings: [{ code: 'VALID', severity: 'info', entity: null, others: [], message: `${keep.length} entities protected.` }] },
  };
}

// -------------------------------------------------------------------- REMOVE --
function planRemove(world, intent, base) {
  let ids = intent.reference.ids.slice();
  if (intent.thing && intent.reference.ring) {
    const typeMap = { car: 'car', tree: 'tree', wall: 'wall', building: 'structure', market: 'market' };
    const t = typeMap[intent.thing];
    ids = world.index.within(intent.reference.ring).filter((id) => world.get(id)?.type === t);
  }
  if (!ids.length) return { ...base, title: 'Remove what?', summary: 'Select what should go.' };
  const protectedIds = ids.filter((id) => world.place.relations.some((r) => r.kind === 'preserves' && r.to === id));
  const findings = ids.map((id) => ({
    code: 'REQUIRES_REMOVAL',
    severity: protectedIds.includes(id) ? 'error' : 'warning',
    entity: id, others: [],
    message: protectedIds.includes(id)
      ? `${world.get(id)?.name || id} is protected — someone asked to keep it.`
      : `Removes ${world.get(id)?.name || id}.`,
  }));
  return {
    ...base,
    title: `Remove ${ids.length} thing${ids.length === 1 ? '' : 's'}`,
    summary: ids.map((id) => world.get(id)?.name || id).join(', '),
    removals: ids,
    certificate: { valid: protectedIds.length === 0, findings },
  };
}

// -------------------------------------------------------------------- BRANCH --
const STRATEGIES = [
  { key: 'drain',  label: 'Drainage first',  thing: 'drain',  note: 'Move the water out fast along the steepest line.' },
  { key: 'absorb', label: 'Absorb it here',  thing: 'swale',  note: 'Slow and soak: a swale and planting instead of a pipe.' },
  { key: 'shift',  label: 'Move what floods', thing: 'garden', note: 'Leave the low ground to the water and re-use it.' },
  { key: 'connect',label: 'Reorganise movement', thing: 'path', note: 'Keep people out of the water rather than water out of people.' },
];

/** For ground with no water problem, offering three drainage schemes is a fixture. */
const DRY_STRATEGIES = [
  { key: 'shade',   label: 'Shade and planting', thing: 'tree',   note: 'Trees first: cooler ground, slower runoff, somewhere to stand.' },
  { key: 'access',  label: 'Better ways through', thing: 'path',  note: 'A route where people already want to walk.' },
  { key: 'commons', label: 'Common ground',      thing: 'garden', note: 'Hold the open space as something shared before it is taken.' },
  { key: 'build',   label: 'Build on it',        thing: 'building', note: 'Use the space: one more structure, placed where it fits.' },
];

function planBranch(world, intent, base) {
  const ref = intent.reference;
  const count = Math.max(1, Math.min(4, intent.count || 1));
  const branchOps = [];

  if (intent.secondary === 'TRANSFORM') {
    // "show this without cars"
    const thing = intent.removeThing || intent.thing;
    const typeMap = { car: 'car', tree: 'tree', wall: 'wall', building: 'structure', market: 'market' };
    const t = typeMap[thing] || thing;
    const region = ref.ring || world.place.bounds();
    const ids = world.entities().filter((e) => e.type === t &&
      (!ref.ring || G.pointInRing(G.centroid(world.ringOf(e) || [[0, 0]]), ref.ring))).map((e) => e.id);
    const bid = `AS_IF_no_${t}_${world.place.tick}`;
    branchOps.push({ kind: 'create', id: bid, name: `Without ${thing}`, note: intent.original, removals: ids });
    return {
      ...base,
      title: `As-if: without ${thing}`,
      summary: `${ids.length} ${thing}${ids.length === 1 ? '' : 's'} set aside in a new branch. The current place is untouched.`,
      branchOps,
      certificate: { valid: true, findings: [{ code: 'VALID', severity: 'info', entity: null, others: ids, message: `${ids.length} entities differ from ${world.branch}.` }] },
    };
  }

  // "show three radically different futures for this"
  const region = ref.ring || (ref.point ? G.circleRing(ref.point[0], ref.point[1], 18, 24) : boundsRing(world));
  // Strategies are chosen by what this ground actually does, not from a fixture.
  const ordered = strategiesFor(world, region);
  const picks = [];
  const rejected = [];
  for (const s of ordered) {
    if (picks.length >= count) break;
    const gen = GENERATORS[s.thing];
    // No pre-drawn line: the generator must find a real outfall for itself,
    // otherwise every "future" is a stub that changes nothing.
    const ctx2 = {
      region, point: ref.point || G.centroid(region),
      count: s.thing === 'tree' ? 8 : 1, seed: `${s.key}|${intent.norm}`,
    };
    const specs = gen(world, ctx2).map((sp) => ({
      ...sp, id: world.place.newId(sp.type), status: 'GHOST', epistemic: 'PROPOSED',
      author: intent.author || 'you',
      evidence: [{ kind: 'utterance', text: intent.original, basis: ref.basis }],
      props: { ...(sp.props || {}), strategy: s.key },
    }));
    if (!specs.length) { rejected.push({ s, why: 'nothing could be placed in the area you indicated' }); continue; }
    // Every strategy is certified like any other proposal. A branch whose own
    // geometry is invalid would show up in the comparison as "changes nothing",
    // which reads as a verdict on the idea rather than on the placement.
    const cert = certify(world, specs, { region });
    if (!cert.valid) {
      rejected.push({ s, why: cert.findings.find((x) => x.severity === 'error').message });
      continue;
    }
    const bid = `AS_IF_${s.key}_${world.place.tick}_${picks.length}`;
    picks.push(s);
    branchOps.push({ kind: 'create', id: bid, name: s.label, note: s.note, ghosts: specs, certificate: cert });
  }

  const findings = picks.length
    ? [{ code: 'VALID', severity: 'info', entity: null, others: [], message: `${picks.length} branches will coexist with ${world.branch}.` }]
    : [{ code: 'REQUIRES_RELOCATION', severity: 'error', entity: null, others: [], message: 'No strategy could be placed here without removing something.' }];
  for (const r of rejected) {
    findings.push({ code: 'REQUIRES_RELOCATION', severity: 'warning', entity: null, others: [], message: `"${r.s.label}" was not offered: ${r.why}` });
  }

  return {
    ...base,
    title: picks.length ? `${picks.length} futures for this place` : 'No future fits here yet',
    summary: picks.map((s) => `${s.label}: ${s.note}`).join('  ·  '),
    branchOps, region,
    certificate: { valid: picks.length > 0, findings },
  };
}

/**
 * Ask the ground what its problem is before offering solutions to it.
 * Drainage strategies for ground that actually ponds; space and movement
 * strategies for ground that does not.
 */
function strategiesFor(world, region) {
  let wet = false;
  try {
    const w = runWater(world, { rain: 'heavy' });
    const c = G.centroid(region);
    const r = Math.max(...region.map((p) => G.dist(p, c)));
    for (const pond of w.ponds) {
      const px = w.bounds[0] + pond.i * w.cell, py = w.bounds[1] + pond.j * w.cell;
      if (G.dist([px, py], c) <= r + 6 && pond.maxDepth > 0.06) { wet = true; break; }
    }
  } catch { /* no terrain: fall through to the dry set */ }
  const testimony = world.entities().some((e) => e.type === 'observation'
    && e.props?.condition === 'flooding'
    && G.pointInRing(G.centroid(world.ringOf(e) || [[1e9, 1e9]]), region));
  return (wet || testimony) ? STRATEGIES : DRY_STRATEGIES;
}

// --------------------------------------------------------------------- MERGE --
function planMerge(world, intent, base) {
  const grafts = [];
  const typeMap = { tree: 'tree', building: 'structure', path: 'path', drain: 'drain', garden: 'surface', swale: 'drain', bench: 'bench' };
  for (const g of intent.grafts || []) {
    const branch = matchBranch(world, g.branchHint);
    if (!branch) continue;
    const t = typeMap[g.thing] || g.thing;
    const view = world.view(branch.id);
    const baseIds = new Set(world.view('AS_IS').entities.map((e) => e.id));
    const ids = view.entities.filter((e) => e.type === t && !baseIds.has(e.id)).map((e) => e.id);
    grafts.push({ branch: branch.id, branchName: branch.name, thing: g.thing, type: t, ids });
  }
  if (!grafts.length) {
    return { ...base, title: 'Which branches?', summary: 'Name the options to combine, e.g. "combine the trees from A and the drain from B".',
      certificate: { valid: false, findings: [{ code: 'AMBIGUOUS_REFERENCE', severity: 'error', entity: null, others: [], message: 'No branch matched.' }] } };
  }
  const bid = `MERGED_${world.place.tick}`;
  return {
    ...base,
    title: 'Merged branch',
    summary: grafts.map((g) => `${g.ids.length} ${g.thing}${g.ids.length === 1 ? '' : 's'} from ${g.branchName}`).join(' + '),
    branchOps: [{ kind: 'create', id: bid, name: 'Merged option', note: intent.original, grafts }],
    certificate: { valid: true, findings: [{ code: 'VALID', severity: 'info', entity: null, others: [], message: `Grafts ${grafts.reduce((n, g) => n + g.ids.length, 0)} entities.` }] },
  };
}

function matchBranch(world, hint) {
  const h = (hint || '').trim().toLowerCase();
  if (!h) return null;
  const all = [...world.place.branches.values()];
  return all.find((b) => b.name.toLowerCase() === h)
    || all.find((b) => b.id.toLowerCase() === h)
    || all.find((b) => b.name.toLowerCase().includes(h) || h.includes(b.name.toLowerCase()))
    || all.find((b) => b.id.toLowerCase().endsWith(`_${h}`) || b.name.toLowerCase().endsWith(` ${h}`))
    || null;
}

// ------------------------------------------------------------------ SIMULATE --
function planSimulate(world, intent, base) {
  const scenario = intent.scenario || {};
  const sim = {};
  if (scenario.rain || intent.secondary === 'WATER') sim.water = runWater(world, { rain: scenario.rain || 'heavy' });
  if (intent.secondary === 'TEMPORAL') sim.years = scenario.years || 1;
  if (scenario.night || intent.secondary === 'LIGHT') sim.night = true;
  return {
    ...base,
    title: intent.secondary === 'TEMPORAL' ? `${sim.years} year${sim.years === 1 ? '' : 's'} pass` : (sim.night ? 'At night' : 'Heavy rain'),
    summary: sim.water
      ? `${sim.water.pondCount} places hold water; deepest ${sim.water.maxDepth.toFixed(2)} m; ${sim.water.floodedArea.toFixed(0)} m² over 5 cm.`
      : 'Scenario applied to the current branch.',
    simulation: sim, autoCommit: false,
    certificate: { valid: true, findings: [{ code: 'VALID', severity: 'info', entity: null, others: [], message: 'Simulation does not change the world.' }] },
  };
}

// ------------------------------------------------------------------- MEASURE --
function planMeasure(world, intent, base) {
  const ref = intent.reference;
  const parts = [];
  for (const id of ref.ids) {
    const e = world.get(id);
    if (!e) continue;
    const ring = world.ringOf(e);
    const ob = G.orientedBounds(ring);
    parts.push({
      id, name: e.name || id,
      area: G.area(ring), width: ob.width, depth: ob.depth,
      height: e.zTop - e.zBase,
      length: e.path ? G.perimeter(e.path, false) : G.perimeter(ring),
    });
  }
  if (ref.ring && !parts.length) parts.push({ id: null, name: 'area', area: G.area(ref.ring), perimeter: G.perimeter(ref.ring) });
  if (ref.line) parts.push({ id: null, name: 'line', length: G.perimeter(ref.line, false) });
  return {
    ...base,
    title: 'Measurement',
    summary: parts.map((p) => [
      p.area != null ? `${p.name}: ${p.area.toFixed(1)} m²` : null,
      p.width != null ? `${p.width.toFixed(2)} × ${p.depth.toFixed(2)} m` : null,
      p.height ? `${p.height.toFixed(2)} m high` : null,
      p.length ? `${p.length.toFixed(1)} m long` : null,
    ].filter(Boolean).join(', ')).join(' · ') || 'Nothing measurable selected.',
    answer: { kind: 'measure', parts },
    certificate: { valid: true, findings: [] },
  };
}

// -------------------------------------------------------------------- COMMIT --
/** Apply a plan. Everything lands in one transaction so one undo reverses it. */
export function commitPlan(world, p, meta = {}) {
  const author = meta.author || p.intent?.author || 'you';
  const label = p.title || 'change';
  let createdBranches = [];

  const out = world.transact({
    label, author,
    intent: p.intent ? { operation: p.intent.operation, secondary: p.intent.secondary, thing: p.intent.thing, confidence: p.intent.confidence } : null,
    utterance: p.intent ? { text: p.intent.original, lang: p.intent.lang } : null,
  }, (j) => {
    // branch operations first — they define where the rest lands
    for (const op of p.branchOps || []) {
      if (op.kind !== 'create') continue;
      j.mutate({ op: 'branch', branchId: op.id, name: op.name, parent: world.branch, note: op.note, author });
      createdBranches.push(op.id);
      for (const g of op.ghosts || []) {
        j.mutate({ op: 'add', branch: op.id, entity: { ...stripGhost(g), createdBy: j.open.id } });
      }
      for (const id of op.removals || []) j.mutate({ op: 'remove', branch: op.id, id });
      for (const graft of op.grafts || []) {
        for (const id of graft.ids) {
          const e = world.place.get(id, graft.branch);
          if (e) j.mutate({ op: 'add', branch: op.id, entity: { ...e, props: { ...(e.props || {}), graftedFrom: graft.branch } } });
        }
      }
    }
    // entity changes on the current branch
    for (const g of p.ghosts || []) {
      if (p.patches?.some((x) => x.id === g.props?.modifies)) continue;   // handled below
      j.mutate({ op: 'add', entity: { ...stripGhost(g), createdBy: j.open.id } });
    }
    for (const patch of p.patches || []) j.mutate({ op: 'update', id: patch.id, patch: patch.patch });
    for (const id of p.removals || []) j.mutate({ op: 'remove', id });
    for (const r of p.relations || []) if (world.get(r.to)) j.mutate({ op: 'relate', from: r.from, kind: r.kind, to: r.to, author });
    for (const id of p.preserve || []) j.mutate({ op: 'relate', from: author, kind: 'preserves', to: id, author });
  });

  return { ...out, branches: createdBranches };
}

function stripGhost(g) {
  const { alternatives, placementScore, needsSupport, ...rest } = g;
  return { ...rest, status: 'ACTIVE' };
}

function structuredCloneLite(o) { return JSON.parse(JSON.stringify(o)); }

function boundsRing(world) {
  const b = world.place.bounds();
  return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
}

function describeGhosts(world, ghosts, where) {
  if (!ghosts.length) return '';
  const g = ghosts[0];
  const ring = world.place.ringOf(g);
  const parts = [];
  if (ghosts.length > 1) parts.push(`${ghosts.length} items`);
  if (ring) {
    const ob = G.orientedBounds(ring);
    parts.push(`${ob.width.toFixed(1)} × ${ob.depth.toFixed(1)} m`);
    parts.push(`${G.area(ring).toFixed(0)} m²`);
  }
  if (g.zTop - g.zBase > 0.05) parts.push(`${(g.zTop - g.zBase).toFixed(2)} m high`);
  if (g.path) parts.push(`${G.perimeter(g.path, false).toFixed(1)} m long`);
  if (where) parts.push(where);
  return parts.join(' · ');
}
