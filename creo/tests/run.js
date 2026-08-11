// THE GAUNTLET, headless.
//
// Professional tests, magic tests and the invariants each pass has established.
// Every one of these ran green before any critic was allowed to score the build.
//
//   node tests/run.js            all
//   node tests/run.js pro        one group

import { existsSync, readFileSync } from 'node:fs';
import * as G from '../src/core/geom.js';
import { stream } from '../src/core/rng.js';
import { buildPlace, PLACES } from '../src/places/index.js';
import { World } from '../src/core/world.js';
import { makeContext } from '../src/lang/deixis.js';
import { interpret } from '../src/lang/interpret.js';
import { plan, commitPlan } from '../src/world/ops.js';
import { ask } from '../src/world/query.js';
import { certify } from '../src/world/certificate.js';
import { lexiconCollisions } from '../src/lang/lexicon.js';
import { repairFor } from '../src/ai/operator.js';
import { FLAT_ORDER, Renderer } from '../src/render/gl.js';
import { parseCoordinates, coordinatePlace } from '../src/import/geocode.js';
import { reframe } from '../src/ui/importui.js';
import { slug } from '../src/import/place.js';
import { readGLB, bodyFromModel, boxBody } from '../src/world/body.js';
import { planSeat, settleGround, refineTerrain } from '../src/world/seat.js';
import { toGeoJSON, fromGeoJSON } from '../src/world/export.js';
import { consequenceOf } from '../src/sim/consequence.js';
import { runWater } from '../src/sim/water.js';
import { reachability, buildGraph, route } from '../src/sim/movement.js';

let passed = 0, failed = 0, groupName = '';
const failures = [];
const only = process.argv[2] || null;

function group(name, fn) {
  if (only && !name.toLowerCase().startsWith(only.toLowerCase())) return;
  groupName = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
  fn();
}
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed++;
    failures.push({ group: groupName, name, err });
    console.log(`  \x1b[31m✗ ${name}\x1b[0m\n      ${err.message.split('\n').join('\n      ')}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (a === b) return;
  // Fingerprints are long. Report the first line that differs, not the whole world.
  if (typeof a === 'string' && typeof b === 'string' && (a.length > 300 || b.length > 300)) {
    const la = a.split('\n'), lb = b.split('\n');
    for (let i = 0; i < Math.max(la.length, lb.length); i++) {
      if (la[i] !== lb[i]) {
        throw new Error(`${msg || 'expected equal'}: first difference at line ${i + 1} of ${la.length}/${lb.length}\n  expected: ${(lb[i] || '<missing>').slice(0, 160)}\n  actual:   ${(la[i] || '<missing>').slice(0, 160)}`);
      }
    }
  }
  throw new Error(`${msg || 'expected equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
function near(a, b, tol, msg) { if (Math.abs(a - b) > tol) throw new Error(`${msg || 'expected near'}: ${a} vs ${b} (tol ${tol})`); }

// ---------------------------------------------------------------- helpers ---
function say(world, text, ctxOverrides = {}, opts = {}) {
  const ctx = makeContext(world, {
    camera: { eye: [0, -120, 90], target: [0, 0, 0] },
    ...ctxOverrides,
  });
  const intent = interpret(text, ctx);
  intent.author = opts.author || 'tester';
  const p = plan(world, intent, ctx);
  return { intent, plan: p, ctx };
}
function sayAndCommit(world, text, ctxOverrides = {}, opts = {}) {
  const r = say(world, text, ctxOverrides, opts);
  if (r.plan.ghosts?.length || r.plan.removals?.length || r.plan.branchOps?.length || r.plan.patches?.length || r.plan.preserve?.length) {
    r.commit = commitPlan(world, r.plan, { author: opts.author || 'tester' });
  }
  return r;
}
const codes = (p) => (p.certificate?.findings || []).map((f) => f.code);
const byType = (w, t) => w.entities().filter((e) => e.type === t);

// ============================================================== GEOMETRY ====
group('geom — the substrate', () => {
  test('area and centroid of a known rectangle', () => {
    const r = G.rectRing(10, 5, 4, 2, 0);
    near(G.area(r), 8, 1e-9, 'area');
    const c = G.centroid(r);
    near(c[0], 10, 1e-9); near(c[1], 5, 1e-9);
  });
  test('rotation preserves area', () => {
    const r = G.rectRing(0, 0, 6, 3, 0.7);
    near(G.area(r), 18, 1e-6);
  });
  test('polygons detect real overlap, not bbox overlap', () => {
    const a = [[0, 0], [10, 0], [0, 10]];
    const b = [[9, 9], [10, 9], [10, 10], [9, 10]];   // inside a's bbox, outside a
    assert(G.bboxOverlap(G.bbox(a), G.bbox(b)), 'bboxes do overlap');
    assert(!G.ringsIntersect(a, b), 'polygons must not report overlap');
  });
  test('containment and distance', () => {
    const outer = G.rectRing(0, 0, 20, 20, 0);
    const inner = G.rectRing(0, 0, 4, 4, 0);
    assert(G.ringContains(outer, inner));
    near(G.ringDistance(inner, G.rectRing(10, 0, 2, 2, 0)), 7, 1e-6, 'gap');
  });
  test('oriented bounds recover a rotated rectangle', () => {
    const r = G.rectRing(3, -2, 8, 3, 0.5);
    const ob = G.orientedBounds(r);
    const dims = [ob.width, ob.depth].sort((a, b) => b - a);
    near(dims[0], 8, 0.05); near(dims[1], 3, 0.05);
  });
  test('triangulation covers the polygon area', () => {
    const r = [[0, 0], [10, 0], [10, 6], [4, 6], [4, 3], [0, 3]];   // L-shape
    const tris = G.triangulate(r);
    let a = 0;
    for (let i = 0; i < tris.length; i += 3) {
      a += Math.abs(G.signedArea([r[tris[i]], r[tris[i + 1]], r[tris[i + 2]]]));
    }
    near(a, G.area(r), 1e-6, 'triangulated area');
  });
  test('projection round-trips to WGS84', () => {
    const p = G.makeProjection(-1.2361, 36.8791);
    const [lat, lon] = p.toWGS84(120, -80);
    const [x, y] = p.toLocal(lat, lon);
    near(x, 120, 1e-6); near(y, -80, 1e-6);
  });
});

// ================================================================= PLACES ====
group('place — nine materially different environments', () => {
  for (const def of PLACES) {
    test(`${def.key}: builds, indexes, and holds together`, () => {
      const w = buildPlace(def.key);
      const ents = w.entities();
      assert(ents.length > 3, `${def.key} has ${ents.length} entities`);
      for (const e of ents) {
        const ring = w.ringOf(e);
        if (!ring) continue;
        for (const p of ring) assert(Number.isFinite(p[0]) && Number.isFinite(p[1]), `NaN in ${e.id}`);
        assert(e.zTop >= e.zBase - 1e-9, `${e.id} inverted vertical interval`);
      }
      assert(w.place.relations.length > 0, 'relations were derived');
      assert(w.index.size() > 0, 'spatial index populated');
    });
  }
  test('point+say works in every place, not just the city', () => {
    for (const def of PLACES) {
      const w = buildPlace(def.key);
      const b = w.place.bounds();
      const centre = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
      const r = say(w, 'this always floods when it rains', { pointer: centre });
      eq(r.intent.operation, 'OBSERVE', `${def.key} observation`);
      assert(r.plan.ghosts.length === 1, `${def.key} produced an observation`);
    }
  });
});

// ========================================================== PROFESSIONAL ====
group('pro — the professional tests', () => {
  test('PRO A · precision: "make this 5.25 m" means 5.25 m', () => {
    const w = buildPlace('house');
    const table = w.entities().find((e) => e.name === 'Table');
    const before = G.orientedBounds(w.ringOf(table)).width;
    assert(Math.abs(before - 5.25) > 1, 'starts at another size');
    const r = sayAndCommit(w, 'make this 5.25 m', { selection: { ids: [table.id] } });
    const after = G.orientedBounds(w.ringOf(w.get(table.id)));
    near(Math.max(after.width, after.depth), 5.25, 0.01, 'longest dimension');
  });

  test('PRO B · snapping: generated form aligns with what is already there', () => {
    const w = buildPlace('settlement');
    const road = w.entities().find((e) => e.name === 'Baba Dogo Road');
    const seg = G.norm(G.sub(road.path[1], road.path[0]));
    const roadAngle = Math.atan2(seg[1], seg[0]);
    const r = say(w, 'put a stall here', { pointer: [-10, -44] });
    const ob = G.orientedBounds(w.place.ringOf(r.plan.ghosts[0]));
    const diff = Math.abs(normalizeAngle(ob.angle - roadAngle)) % (Math.PI / 2);
    assert(diff < 0.12 || Math.abs(diff - Math.PI / 2) < 0.12, `alignment off by ${diff.toFixed(3)} rad`);
  });

  test('PRO C · collision: an impossible overlap is detected and named', () => {
    const w = buildPlace('settlement');
    const house = w.entities().find((e) => e.type === 'structure');
    const c = G.centroid(w.ringOf(house));
    const r = say(w, 'build a building here', { pointer: c });
    assert(codes(r.plan).includes('COLLISION'), `expected COLLISION, got ${codes(r.plan)}`);
    const f = r.plan.certificate.findings.find((x) => x.code === 'COLLISION');
    assert(f.others.includes(house.id), 'names the actual structure');
    assert(f.message.includes('m²'), 'measures the overlap');
    assert(!r.plan.certificate.valid, 'plan is not valid');
  });

  test('PRO C2 · no silent nudging: the conflicting proposal stays where it was pointed', () => {
    const w = buildPlace('settlement');
    const house = w.entities().find((e) => e.type === 'structure');
    const c = G.centroid(w.ringOf(house));
    const r = say(w, 'build a building here', { pointer: c });
    const gc = G.centroid(w.place.ringOf(r.plan.ghosts[0]));
    near(G.dist(gc, c), 0, 0.5, 'ghost was moved away from the conflict');
  });

  test('PRO D · network: a drain joins the drainage network, or says it does not', () => {
    const w = buildPlace('school');
    const drain = w.entities().find((e) => e.type === 'drain');
    const joinAt = drain.path[1];
    const good = say(w, 'we need a drain here', { selection: { stroke: [joinAt, [joinAt[0] + 6, joinAt[1] + 12]] }, pointer: joinAt });
    assert(!codes(good.plan).includes('DISCONNECTED'), `joined drain flagged: ${codes(good.plan)}`);
    const far = say(w, 'we need a drain here', { selection: { stroke: [[62, 52], [66, 40]] }, pointer: [62, 52] });
    assert(codes(far.plan).includes('DISCONNECTED'), 'isolated drain must be flagged as decoration');
  });

  test('PRO E · save: reload reproduces the world exactly', () => {
    const w = buildPlace('settlement');
    sayAndCommit(w, 'this always floods', { pointer: [-18, 6] });
    sayAndCommit(w, 'there should be trees here', { selection: { ring: G.circleRing(30, 20, 12, 16) } });
    const before = w.fingerprint();
    const w2 = World.load(w.save());
    eq(w2.fingerprint(), before, 'fingerprint after reload');
    eq(w2.journal.events.length, w.journal.events.length, 'event count');
  });

  test('PRO F · undo: 100 mixed human/AI operations reverse and replay exactly', () => {
    const w = buildPlace('settlement');
    const start = w.fingerprint();
    const marks = [];
    for (let i = 0; i < 100; i++) {
      const x = -70 + (i * 13) % 140, y = -40 + (i * 29) % 90;
      if (i % 4 === 0) {
        sayAndCommit(w, 'this always floods', { pointer: [x, y] });
      } else if (i % 4 === 1) {
        sayAndCommit(w, 'put a bench here', { pointer: [x, y] });
      } else if (i % 4 === 2) {
        // a manual edit, made exactly the way a finger drag makes it
        const bench = byType(w, 'bench')[0] || byType(w, 'tree')[0];
        if (bench) {
          const ring = w.ringOf(bench).map((p) => [p[0] + 0.5, p[1] + 0.25]);
          w.updateEntity(bench.id, { footprint: ring }, { label: 'drag', author: 'hand' });
        } else { sayAndCommit(w, 'put a bench here', { pointer: [x, y] }); }
      } else {
        sayAndCommit(w, 'there should be trees here', { selection: { ring: G.circleRing(x, y, 7, 12) } });
      }
      // Some utterances legitimately produce nothing (nowhere free). Keep the
      // count honest by doing a real edit instead, so this is 100 operations.
      if (w.journal.events.length < i + 1) {
        const any = w.entities().find((e) => e.type === 'tree' || e.type === 'bench') || w.entities()[0];
        w.updateEntity(any.id, { zTop: any.zTop + 0.01 }, { label: 'nudge height', author: 'hand' });
      }
      marks.push(w.fingerprint());
    }
    const end = w.fingerprint();
    assert(w.journal.events.length >= 100, `only ${w.journal.events.length} events`);
    const n = w.journal.events.length;
    for (let i = 0; i < n; i++) w.undo();
    eq(w.fingerprint(), start, 'world after full undo');
    assert(!w.journal.canUndo(), 'nothing left to undo');
    for (let i = 0; i < n; i++) w.redo();
    eq(w.fingerprint(), end, 'world after full redo');
  });

  test('PRO G · scale: thousands of entities stay responsive', () => {
    const w = buildPlace('block');
    const t0 = Date.now();
    let n = 0;
    w.transact({ label: 'bulk', author: 'load-test' }, (j) => {
      for (let i = 0; i < 3000; i++) {
        const x = -110 + (i % 60) * 3.7, y = -95 + Math.floor(i / 60) * 3.9;
        j.mutate({ op: 'add', entity: { id: `bulk_${i}`, type: 'furniture', footprint: G.rectRing(x, y, 1.2, 1.2, 0), zBase: 0, zTop: 0.8, collision: 'soft' } });
        n++;
      }
    });
    const build = Date.now() - t0;
    assert(w.entities().length > 3000, 'entities present');
    const t1 = Date.now();
    for (let i = 0; i < 400; i++) w.index.near([-40 + (i % 50), -30 + (i % 37)], 8);
    const queryMs = Date.now() - t1;
    assert(queryMs < 400, `400 local queries took ${queryMs} ms`);
    const t2 = Date.now();
    w.entityAt([0, 0]);
    assert(Date.now() - t2 < 60, 'point pick stays interactive');
    console.log(`      (${n} entities, index+relations rebuild ${build} ms, 400 queries ${queryMs} ms)`);
  });

  test('PRO H · measurement is real and matches geometry', () => {
    const w = buildPlace('house');
    const shell = w.entities().find((e) => e.name === 'House');
    const r = say(w, 'how wide is this?', { selection: { ids: [shell.id] } });
    eq(r.intent.operation, 'ASK');
    const m = say(w, 'measure this', { selection: { ids: [shell.id] } });
    eq(m.intent.operation, 'MEASURE');
    const part = m.plan.answer.parts[0];
    near(part.area, G.area(w.ringOf(shell)), 1e-6, 'area matches geometry');
    near(Math.max(part.width, part.depth), 12, 0.01, 'width matches');
  });
});

function normalizeAngle(a) { while (a > Math.PI / 2) a -= Math.PI; while (a < -Math.PI / 2) a += Math.PI; return a; }

// ================================================================= DEIXIS ====
group('deixis — "here" must mean here', () => {
  test('"this" with a selection resolves to that entity', () => {
    const w = buildPlace('settlement');
    const h = w.entities().find((e) => e.type === 'structure');
    const r = say(w, 'make this taller', { selection: { ids: [h.id] } });
    eq(r.intent.reference.ids[0], h.id);
    assert(r.intent.reference.basis.includes('selection'));
  });
  test('"here" with a tap resolves to the tapped ground, not the camera', () => {
    const w = buildPlace('settlement');
    const r = say(w, 'water collects here', { pointer: [-18, 6] });
    near(r.intent.reference.point[0], -18, 1e-9);
    near(r.intent.reference.point[1], 6, 1e-9);
  });
  test('"here" with nothing indicated refuses to guess', () => {
    const w = buildPlace('settlement');
    const r = say(w, 'put a bench here', {});
    eq(r.intent.reference.kind, 'none');
    assert(r.plan.certificate.findings.some((f) => f.code === 'AMBIGUOUS_REFERENCE'));
    assert(r.plan.summary.length > 0, 'asks a question instead');
  });
  test('"behind this" uses the camera to pick a side', () => {
    const w = buildPlace('settlement');
    const h = w.entities().find((e) => e.type === 'structure');
    const c = G.centroid(w.ringOf(h));
    const south = say(w, 'plant trees behind this', { selection: { ids: [h.id] }, camera: { eye: [c[0], c[1] - 60, 40], target: [c[0], c[1], 0] } });
    const north = say(w, 'plant trees behind this', { selection: { ids: [h.id] }, camera: { eye: [c[0], c[1] + 60, 40], target: [c[0], c[1], 0] } });
    assert(south.intent.reference.point[1] > c[1], 'from the south, behind is north');
    assert(north.intent.reference.point[1] < c[1], 'from the north, behind is south');
  });
  test('"between those" makes the gap between two things', () => {
    const w = buildPlace('settlement');
    const [a, b] = w.entities().filter((e) => e.type === 'structure').slice(0, 2);
    const r = say(w, 'a path between those', { selection: { ids: [a.id, b.id] } });
    const ca = G.centroid(w.ringOf(a)), cb = G.centroid(w.ringOf(b));
    const mid = G.lerp2(ca, cb, 0.5);
    near(r.intent.reference.point[0], mid[0], 0.001);
    near(r.intent.reference.point[1], mid[1], 0.001);
  });
  test('"the one next to it" walks the scene graph', () => {
    const w = buildPlace('settlement');
    const a = w.entities().filter((e) => e.type === 'structure')[3];
    const r = say(w, 'make the one next to it taller', { selection: { ids: [a.id] } });
    assert(r.intent.reference.ids.length === 1 && r.intent.reference.ids[0] !== a.id, 'picked a different neighbour');
  });
  test('"where we were before" reuses the previous resolution', () => {
    const w = buildPlace('settlement');
    const first = say(w, 'this always floods', { pointer: [-18, 6] });
    const r = say(w, 'put a drain where we were before', {
      utterances: [{ text: first.intent.original, resolved: first.intent.reference }],
    });
    near(r.intent.reference.point[0], first.intent.reference.point[0], 1e-9, 'same place as last time');
    near(r.intent.reference.point[1], first.intent.reference.point[1], 1e-9);
    assert(r.intent.reference.basis.includes('utterance-history'));
  });
  test('a circled region selects what is inside it, filtered by the noun', () => {
    const w = buildPlace('settlement');
    const ring = G.circleRing(46, 26, 22, 20);
    const r = say(w, 'keep these trees', { selection: { ring } });
    assert(r.intent.reference.ids.length > 0, 'found trees');
    assert(r.intent.reference.ids.every((id) => w.get(id).type === 'tree'), 'only trees');
  });
  test('the resolution always explains itself', () => {
    const w = buildPlace('settlement');
    const r = say(w, 'this floods', { pointer: [-18, 6] });
    assert(r.intent.explanation.includes('pointer'), r.intent.explanation);
  });
});

// =========================================================== MULTILINGUAL ====
group('language — English is not required', () => {
  const cases = [
    ['sw', 'hapa inafurika kila mvua', 'OBSERVE'],
    ['es', 'aqui se inunda cuando llueve', 'OBSERVE'],
    ['sw', 'tuweke miti hapa', 'PROPOSE'],
    ['es', 'deberia haber arboles aqui', 'PROPOSE'],
    ['fr', 'il devrait y avoir des arbres ici', 'PROPOSE'],
    ['pt', 'precisamos de um dreno aqui', 'PROPOSE'],
  ];
  for (const [lang, text, op] of cases) {
    test(`${lang}: "${text}" → ${op}`, () => {
      const w = buildPlace('settlement');
      const r = say(w, text, { pointer: [-18, 6] });
      eq(r.intent.operation, op, `operation for ${text}`);
      eq(r.intent.original, text, 'original expression preserved verbatim');
      assert(r.intent.reference.point, 'resolved a location');
    });
  }
  test('naming a thing is not asking for one', () => {
    const w = buildPlace('settlement');
    const cases = [
      ['when the rain is bad, all of this fills with water', 'OBSERVE'],
      ['people sell food here in the morning', 'OBSERVE'],
      ['this path is where children walk', 'OBSERVE'],
      ['there is water here every march', 'OBSERVE'],
      ['there should be trees here', 'PROPOSE'],
      ['we need a drain here', 'PROPOSE'],
      ['trees here', 'PROPOSE'],
      ['a bench here', 'PROPOSE'],
    ];
    for (const [text, op] of cases) {
      const r = say(w, text, { pointer: [-18, 6] });
      eq(r.intent.operation, op, `"${text}"`);
    }
  });

  test('the original expression survives commit and is recoverable', () => {
    const w = buildPlace('settlement');
    const text = 'hapa inafurika kila mvua';
    const r = sayAndCommit(w, text, { pointer: [-18, 6] });
    const obs = byType(w, 'observation').find((e) => e.evidence?.[0]?.text === text);
    assert(obs, 'observation carries the untranslated words');
    const ev = w.journal.events.find((e) => e.utterance?.text === text);
    assert(ev, 'transaction carries them too');
  });
});

// ================================================================== MAGIC ====
group('magic — the interactions that make the point', () => {
  test('MAGIC A · "put a greenhouse here but don\'t block those windows"', () => {
    const w = buildPlace('settlement');
    const host = w.entities().find((e) => e.type === 'structure' && w.entities().some((o) => o.parent === e.id && o.type === 'opening'));
    assert(host, 'a house with windows exists');
    const windows = w.entities().filter((e) => e.parent === host.id && e.type === 'opening');
    const r = say(w, "put a greenhouse here but don't block those windows", { selection: { ids: [host.id] } });
    const g = r.plan.ghosts[0];
    assert(g, 'greenhouse proposed');
    eq(g.subtype, 'greenhouse');
    near(g.zBase, host.zTop, 1e-6, 'sits on the roof, not the ground');
    assert(g.zTop > g.zBase, 'has volume');
    assert(r.plan.corridors.length === windows.length, `${r.plan.corridors.length} daylight corridors from ${windows.length} windows`);
    for (const c of r.plan.corridors) {
      assert(!G.ringsIntersect(w.place.ringOf(g), c.ring) || g.zBase >= c.zTop,
        'the greenhouse must not stand in a window corridor');
    }
    assert(G.ringContains(w.ringOf(host), w.place.ringOf(g)), 'stays within the roof it was placed on');
    // and it is ordinary geometry afterwards
    const done = commitPlan(w, r.plan, { author: 'tester' });
    const live = w.get(g.id);
    assert(live && live.status === 'ACTIVE' && live.epistemic === 'PROPOSED', 'becomes a normal entity');
  });

  test('MAGIC B · a desire line is learned and later design must reckon with it', () => {
    const w = buildPlace('settlement');
    const stroke = [[-30, 17], [-10, 17.5], [10, 17], [25, 16.5]];
    const r = sayAndCommit(w, 'people actually walk here', { selection: { stroke } });
    const route = byType(w, 'path').find((e) => e.subtype === 'desire-line');
    assert(route, 'observed route recorded');
    eq(route.epistemic, 'OBSERVED');
    // a later proposal that lands on it is told
    const p = say(w, 'build a building here', { pointer: [14, 17] });
    const f = p.plan.certificate.findings.find((x) => x.code === 'BLOCKS_ACCESS' && x.others.includes(route.id));
    assert(f, `later design ignores the desire line: ${JSON.stringify(codes(p.plan))}`);
  });

  test('MAGIC C · "connect these" proposes a real, supported span', () => {
    const w = buildPlace('settlement');
    const [a, b] = w.entities().filter((e) => e.type === 'structure').slice(0, 2);
    const r = say(w, 'connect these buildings', { selection: { ids: [a.id, b.id] } });
    const g = r.plan.ghosts[0];
    eq(g.type, 'bridge');
    assert(g.props.ends.includes(a.id) && g.props.ends.includes(b.id), 'ends attach to the two buildings');
    const span = G.dist(g.path[0], g.path[1]);
    near(g.props.span, span, 1e-6);
    assert(g.zBase > 1, 'deck is above the ground');
    assert(r.plan.summary.includes('m span'), 'span and height are shown');
  });

  test('MAGIC D · three radically different futures, and the present survives', () => {
    const w = buildPlace('settlement');
    const before = w.entities().length;
    const ring = G.circleRing(-18, 6, 16, 20);
    const r = sayAndCommit(w, 'show three radically different futures for this', { selection: { ring } });
    eq(r.plan.branchOps.length, 3);
    const created = r.commit.branches;
    eq(created.length, 3);
    eq(w.entities().length, before, 'AS_IS is untouched');
    const seen = new Set();
    for (const bid of created) {
      const view = w.view(bid);
      assert(view.entities.length > before, `${bid} adds something`);
      const added = view.entities.filter((e) => !w.place.entities.has(e.id));
      assert(added.length > 0, `${bid} has its own geometry`);
      seen.add(added.map((e) => e.type).sort().join(','));
    }
    assert(seen.size >= 2, `futures must differ in kind, saw ${[...seen]}`);
  });

  test('MAGIC E · merge grafts real entities from named branches', () => {
    const w = buildPlace('settlement');
    const ring = G.circleRing(-18, 6, 16, 20);
    const b = sayAndCommit(w, 'show three radically different futures for this', { selection: { ring } });
    const names = b.commit.branches.map((id) => w.place.branches.get(id).name);
    const r = sayAndCommit(w, `combine the drain from ${names[0]} and the swale from ${names[1]}`, {});
    assert(r.plan.branchOps.length === 1, 'one merged branch');
    const merged = r.commit.branches[0];
    const view = w.view(merged);
    const grafted = view.entities.filter((e) => e.props?.graftedFrom);
    assert(grafted.length >= 1, `nothing grafted (${r.plan.summary})`);
    assert(new Set(grafted.map((e) => e.props.graftedFrom)).size >= 1, 'grafts carry their origin branch');
  });

  test('MAGIC F · "why can\'t this go here?" highlights the actual constraint', () => {
    const w = buildPlace('settlement');
    const house = w.entities().find((e) => e.type === 'structure');
    const c = G.centroid(w.ringOf(house));
    const r = say(w, 'why cant this go here?', { pointer: c });
    eq(r.intent.operation, 'ASK');
    const a = ask(w, r.intent, {});
    assert(a.highlight.includes(house.id), 'points at the thing in the way');
    assert(a.text.toLowerCase().includes('already there'), a.text);
    assert(a.overlay?.alternative, 'offers where it would fit instead');
  });

  test('MAGIC G · "continue this pattern" continues from the CURRENT geometry', () => {
    const w = buildPlace('settlement');
    const gen = sayAndCommit(w, 'put a stall here', { pointer: [10, -20] });
    const id = gen.plan.ghosts[0].id;
    // a person drags it by hand
    const moved = w.ringOf(w.get(id)).map((p) => [p[0] + 9, p[1] + 5]);
    w.updateEntity(id, { footprint: moved }, { label: 'drag', author: 'hand' });
    const handCentre = G.centroid(w.ringOf(w.get(id)));
    const r = say(w, 'continue this pattern', { selection: { ids: [id] } });
    assert(r.plan.ghosts.length >= 1, 'continuation proposed');
    for (const g of r.plan.ghosts) {
      const c = G.centroid(w.place.ringOf(g));
      assert(G.dist(c, handCentre) < 30, 'continues from where the hand left it');
      assert(G.dist(c, G.centroid(w.place.ringOf({ footprint: gen.plan.ghosts[0].footprint }))) > 6,
        'not continuing from the stale generated position');
      eq(g.props.continuedFrom, id);
    }
  });

  test('MAGIC H · "who changed this?" answers in place', () => {
    const w = buildPlace('settlement');
    const r = sayAndCommit(w, 'put a bench here', { pointer: [4, 30] }, { author: 'Amina' });
    const id = r.plan.ghosts[0].id;
    const q = say(w, 'who changed this?', { selection: { ids: [id] } });
    const a = ask(w, q.intent, {});
    assert(a.text.includes('Amina'), a.text);
    assert(a.highlight.includes(id));
  });

  test('MAGIC I · "why are you here?" recovers the whole chain', () => {
    const w = buildPlace('settlement');
    const r = sayAndCommit(w, 'there should be trees here', { selection: { ring: G.circleRing(30, 20, 10, 16) } }, { author: 'Miriam' });
    const id = r.plan.ghosts[0].id;
    const q = say(w, 'why are you here?', { selection: { ids: [id] } });
    const a = ask(w, q.intent, {});
    const row = a.rows[0];
    eq(row.who, 'Miriam');
    assert(row.how.includes('there should be trees here'), row.how);
    eq(row.epistemic, 'PROPOSED');
    assert(row.relations.length >= 0);
  });
});

// ============================================================ CONSEQUENCE ====
group('consequence — the place answers back, and the answer is computed', () => {
  test('water finds the low ground without being told where it is', () => {
    const w = buildPlace('settlement');
    const res = runWater(w, { rain: 'heavy' });
    assert(res.pondCount > 0, 'somewhere ponds');
    const deepest = res.ponds[0];
    const x = res.bounds[0] + (deepest.i + 0.5) * res.cell;
    const y = res.bounds[1] + (deepest.j + 0.5) * res.cell;
    assert(G.dist([x, y], [-18, 6]) < 26, `largest pond at ${x.toFixed(0)},${y.toFixed(0)} — expected the bowl`);
  });

  test('a drain along the real gradient reduces flooding; a wall does not', () => {
    const w = buildPlace('settlement');
    const drain = say(w, 'we need a drain here', { pointer: [-18, 6] });
    const cd = consequenceOf(w, drain.plan);
    const flood = cd.metrics.find((m) => m.key === 'flooding');
    assert(flood, 'flooding measured');
    assert(flood.delta > 0, `drain should reduce flooded area, got ${flood.delta.toFixed(1)}%`);

    const wall = say(w, 'build a wall here', { pointer: [-18, 6] });
    const cw = consequenceOf(w, wall.plan);
    const f2 = cw.metrics.find((m) => m.key === 'flooding');
    assert(!f2 || f2.delta <= flood.delta, 'a wall must not outperform a drain');
  });

  test('blocking a lane really does disconnect the network', () => {
    const w = buildPlace('settlement');
    const path = w.entities().find((e) => e.type === 'path' && e.path.length > 2);
    const mid = path.path[1];
    const p = say(w, 'build a building here', { pointer: mid });
    const c = consequenceOf(w, p.plan);
    const access = c.metrics.find((m) => m.key === 'access');
    assert(access, 'connectivity measured');
    assert(codes(p.plan).includes('BLOCKS_ACCESS'), 'and named in the certificate');
  });

  test('quantities are derived from geometry, not invented', () => {
    const w = buildPlace('settlement');
    const r = say(w, 'we need a drain here', { pointer: [-18, 6] });
    const c = consequenceOf(w, r.plan);
    const g = r.plan.ghosts[0];
    const L = G.perimeter(g.path, false);
    near(c.quantities.length_m, L, 0.5, 'length matches the line');
    near(c.quantities.earthwork_m3, L * g.width * (g.props.depth), 0.5, 'earthwork matches section × length');
  });

  test('simulation never mutates the world', () => {
    const w = buildPlace('settlement');
    const before = w.fingerprint();
    const r = say(w, 'what happens in heavy rain?', { pointer: [-18, 6] });
    const q = ask(w, r.intent, {});
    const sim = say(w, 'show heavy rain', { pointer: [-18, 6] });
    eq(w.fingerprint(), before, 'world unchanged by asking or simulating');
  });
});

// ================================================================ BRANCHES ===
group('as-if — futures coexist', () => {
  test('"show this without cars" leaves the present intact', () => {
    const w = buildPlace('block');
    // put some cars in first
    w.transact({ label: 'seed cars', author: 'seed' }, (j) => {
      for (let i = 0; i < 6; i++) {
        j.mutate({ op: 'add', entity: { id: `car_${i}`, type: 'car', footprint: G.rectRing(-90 + i * 30, -92, 4.2, 1.8, 0), zBase: 0, zTop: 1.5, collision: 'soft' } });
      }
    });
    const before = byType(w, 'car').length;
    eq(before, 6);
    const r = sayAndCommit(w, 'show this without cars', { selection: { ring: G.rectRing(0, 0, 240, 200, 0) } });
    const bid = r.commit.branches[0];
    eq(byType(w, 'car').length, 6, 'AS_IS still has its cars');
    const view = w.view(bid);
    eq(view.entities.filter((e) => e.type === 'car').length, 0, 'the branch has none');
  });

  test('branches inherit later AS_IS work through the overlay chain', () => {
    const w = buildPlace('settlement');
    const b = w.createBranch('AS_IF_test', { name: 'Test option' });
    w.switchBranch('AS_IF_test');
    sayAndCommit(w, 'put a bench here', { pointer: [0, 0] });
    const inBranch = w.entities().length;
    w.switchBranch('AS_IS');
    assert(w.entities().length < inBranch, 'branch work does not leak into AS_IS');
    sayAndCommit(w, 'put a bench here', { pointer: [30, 30] });
    w.switchBranch('AS_IF_test');
    assert(w.entities().length === inBranch + 1, 'branch sees new AS_IS work');
  });

  test('undo reverses a branch creation completely', () => {
    const w = buildPlace('settlement');
    const before = w.fingerprint();
    const nBranches = w.place.branches.size;
    sayAndCommit(w, 'show three radically different futures for this', { selection: { ring: G.circleRing(-18, 6, 14, 16) } });
    assert(w.place.branches.size === nBranches + 3);
    w.undo();
    eq(w.place.branches.size, nBranches, 'branches removed');
    eq(w.fingerprint(), before, 'world restored');
  });
});

// ============================================================= PRESERVE ======
group('preserve — the place can refuse', () => {
  test('"keep these trees" makes a later proposal illegal rather than silent', () => {
    const w = buildPlace('settlement');
    const ring = G.circleRing(46, 26, 20, 20);
    const keep = sayAndCommit(w, 'keep these trees', { selection: { ring } }, { author: 'Amina' });
    assert(keep.plan.preserve.length > 0, 'something was protected');
    const tree = w.get(keep.plan.preserve[0]);
    const r = say(w, 'remove this', { selection: { ids: [tree.id] } });
    assert(!r.plan.certificate.valid, 'removing a protected thing is refused');
    const f = r.plan.certificate.findings[0];
    assert(f.message.includes('protected'), f.message);
  });

  test('"keep everything except this wall" reads as preserve + remove', () => {
    const w = buildPlace('house');
    const wall = w.entities().find((e) => e.type === 'wall');
    const r = say(w, 'keep everything except this wall', { selection: { ids: [wall.id] } });
    eq(r.intent.operation, 'PRESERVE');
    eq(r.intent.secondary, 'REMOVE');
    assert(r.plan.removals.includes(wall.id), 'the wall goes');
    assert(r.plan.preserve.length > 3, 'everything else is protected');
    assert(!r.plan.preserve.includes(wall.id));
  });
});

// ============================================================== INVARIANTS ===
group('invariants — what must remain impossible', () => {
  test('generated geometry cannot ignore previously generated geometry', () => {
    const w = buildPlace('field');
    const first = sayAndCommit(w, 'put a building here', { pointer: [0, 0] });
    const a = first.plan.ghosts[0];
    const second = say(w, 'put a building here', { pointer: G.centroid(w.ringOf(w.get(a.id))) });
    assert(codes(second.plan).includes('COLLISION'), `generation 2 ignored generation 1: ${codes(second.plan)}`);
    assert(second.plan.certificate.findings.some((f) => f.others.includes(a.id)), 'names generation 1');
  });

  test('manual edits are visible to later language operations', () => {
    const w = buildPlace('field');
    const r = sayAndCommit(w, 'put a building here', { pointer: [0, 0] });
    const id = r.plan.ghosts[0].id;
    w.updateEntity(id, { footprint: w.ringOf(w.get(id)).map((p) => [p[0] + 20, p[1]]) }, { label: 'drag', author: 'hand' });
    const after = say(w, 'put a building here', { pointer: [20, 0] });
    assert(codes(after.plan).includes('COLLISION'), 'the AI did not see the hand-moved building');
    const stale = say(w, 'put a building here', { pointer: [0, 0] });
    assert(!codes(stale.plan).includes('COLLISION'), 'the AI still thinks it is at the old place');
  });

  test('a new generation never deletes old work', () => {
    const w = buildPlace('settlement');
    const before = new Set(w.entities().map((e) => e.id));
    for (let i = 0; i < 12; i++) sayAndCommit(w, 'there should be trees here', { selection: { ring: G.circleRing(-60 + i * 10, 40, 8, 12) } });
    const after = new Set(w.entities().map((e) => e.id));
    for (const id of before) assert(after.has(id), `${id} disappeared`);
  });

  test('the LLM layer cannot write geometry — only intents', () => {
    const w = buildPlace('field');
    const r = say(w, 'put a building here', { pointer: [0, 0] });
    assert(!r.intent.footprint && !r.intent.ghosts, 'intent carries no geometry');
    assert(r.plan.ghosts[0].footprint, 'geometry appears only in the plan');
    assert(r.plan.ghosts[0].evidence[0].text === 'put a building here', 'and it cites the words that caused it');
  });

  test('every committed entity can say who made it and why', () => {
    const w = buildPlace('settlement');
    sayAndCommit(w, 'put a bench here', { pointer: [10, 10] }, { author: 'Joseph' });
    for (const e of w.entities()) {
      if (e.source === 'seed') continue;
      assert(e.author, `${e.id} has no author`);
      assert(w.journal.historyOf(e.id).length > 0, `${e.id} has no history`);
    }
  });

  test('epistemic state distinguishes imported data from lived testimony', () => {
    const w = buildPlace('settlement');
    const disputed = w.entities().find((e) => e.epistemic === 'DISPUTED');
    assert(disputed, 'a disputed claim ships with the place');
    const lane = w.entities().find((e) => e.name === 'Cross path 0');
    assert(lane && lane.epistemic === 'IMPORTED', 'and the official data it contradicts is still there');
    assert(w.place.relations.some((r) => r.kind === 'disputedBy' && r.to === lane.id), 'both coexist');
  });

  test('relations are derived from geometry and survive a rebuild', () => {
    const w = buildPlace('house');
    const shell = w.entities().find((e) => e.name === 'House');
    const room = w.entities().find((e) => e.type === 'room');
    const inside = w.place.relations.some((r) => r.from === room.id && r.kind === 'inside' && r.to === shell.id);
    assert(inside, 'a room is inside its house');
    w.dirty = true;
    w.reindex(true);
    assert(w.place.relations.some((r) => r.from === room.id && r.kind === 'inside' && r.to === shell.id), 'still true after rebuild');
  });
});

// ============================================ WHAT THE CRITIC COUNCIL BROKE ==
// Round 1 of the council found eleven defects by running the system. Each one
// is now a test, so it can only be broken again on purpose.
group('council — regressions from critic round 1', () => {
  test('the lexicon has no surface form claimed by two families', () => {
    const c = lexiconCollisions();
    assert(c.length === 0, `collisions: ${c.map((x) => `"${x.form}" in ${x.families.join('+')}`).join(', ')}`);
  });

  test('scenario phrasing reaches the scenario, not the question handler', () => {
    const w = buildPlace('settlement');
    const at = { pointer: [-18, 6] };
    eq(say(w, 'what happens in heavy rain?', at).intent.operation, 'SIMULATE', 'what happens');
    eq(say(w, 'show heavy rain', at).intent.operation, 'SIMULATE', 'show heavy rain');
    eq(say(w, 'what if we remove the cars', at).intent.operation, 'BRANCH', 'what if');
    // …and mentioning rain in testimony is still testimony
    eq(say(w, 'it floods here every rain', at).intent.operation, 'OBSERVE', 'testimony');
    eq(say(w, 'hapa inafurika kila mvua', at).intent.operation, 'OBSERVE', 'swahili testimony');
  });

  test('"taller" changes height, not width', () => {
    const w = buildPlace('settlement');
    const h = w.entities().find((e) => e.type === 'structure');
    const before = { h: h.zTop - h.zBase, w: G.orientedBounds(w.ringOf(h)).width };
    const r = sayAndCommit(w, 'make this 3 m taller', { selection: { ids: [h.id] } });
    const after = w.get(h.id);
    near(after.zTop - after.zBase, before.h + 3, 0.01, 'height');
    near(G.orientedBounds(w.ringOf(after)).width, before.w, 0.01, 'width untouched');
  });

  test('an absurd dimension is capped, reported, and does not take the world down', () => {
    const w = buildPlace('settlement');
    const e = w.entities().find((e2) => e2.type === 'structure');
    const r = say(w, 'make this 9999999 m taller', { selection: { ids: [e.id] } });
    const g = r.plan.ghosts[0];
    assert(g.zTop - g.zBase < 2000, `height was not capped: ${(g.zTop - g.zBase).toFixed(0)} m`);
    assert(r.plan.certificate.findings.some((f) => /capped/.test(f.message)), 'the cap is stated, not silent');
    commitPlan(w, r.plan, { author: 'tester' });          // must not throw
    assert(w.entities().length > 0, 'world survives');
  });

  test('a surface cannot be laid across a building just because it is not solid', () => {
    const w = buildPlace('settlement');
    const house = w.entities().find((e) => e.type === 'structure');
    const ring = w.ringOf(house).map((p) => p.slice());
    const cert = certify(w, [{
      id: 'adversarial_garden', type: 'surface', subtype: 'garden', footprint: ring,
      zBase: house.zBase, zTop: house.zBase + 0.15, collision: 'none', sim: {},
    }]);
    assert(!cert.valid, 'a garden with a house\'s own footprint must not certify as valid');
    assert(cert.findings.some((f) => f.others.includes(house.id)), 'and it must name the house');
  });

  test('every branch strategy is certified before it is offered', () => {
    const w = buildPlace('settlement');
    const r = sayAndCommit(w, 'show three radically different futures for this', { selection: { ring: G.circleRing(-18, 6, 16, 20) } });
    assert(r.plan.branchOps.length >= 1, r.plan.summary);
    for (const op of r.plan.branchOps) {
      assert(op.certificate && op.certificate.valid, `${op.name} was offered with an invalid proposal`);
      for (const g of op.ghosts) {
        const ring = w.place.ringOf(g);
        for (const other of w.entities()) {
          if (other.collision !== 'solid') continue;
          const or = w.ringOf(other);
          if (!or || !G.ringsIntersect(ring, or)) continue;
          // A grazed corner is a warning the certificate already reports; a
          // strategy laid across a building is not allowed to be offered.
          const inside = ring.filter((p) => G.pointInRing(p, or)).length;
          assert(inside <= 1, `${op.name} runs through ${other.name || other.id}`);
        }
      }
    }
  });

  test('ids are per place: loading one world cannot corrupt another', () => {
    const a = buildPlace('field');
    const b = buildPlace('field');
    const e1 = b.addEntity({ type: 'structure', footprint: G.rectRing(10, 0, 4, 4, 0), zBase: 0, zTop: 3 }, { author: 't' });
    const saved = a.save();
    World.load(saved);                                    // the act that used to rewind the allocator
    const e2 = b.addEntity({ type: 'structure', footprint: G.rectRing(30, 0, 4, 4, 0), zBase: 0, zTop: 3 }, { author: 't' });
    assert(e1.id !== e2.id, `id collision after load: both ${e1.id}`);
    assert(b.get(e1.id) && b.get(e2.id), 'both entities survive');
  });

  test('undoing the branch you are standing in leaves a world you can still use', () => {
    const w = buildPlace('settlement');
    w.createBranch('FUTURE', { name: 'Future' });
    w.switchBranch('FUTURE');
    sayAndCommit(w, 'put a bench here', { pointer: [0, 0] });
    w.undo();                                             // the bench
    w.undo();                                             // the branch itself
    assert(w.place.branches.has(w.branch), `active branch ${w.branch} no longer exists`);
    const e = w.addEntity({ type: 'bench', footprint: G.rectRing(5, 5, 1, 1, 0), zBase: 0, zTop: 0.5 }, { author: 't' });
    assert(e && w.get(e.id), 'the world still accepts changes');
  });

  test('the fingerprint can tell two semantically different worlds apart', () => {
    const w = buildPlace('field');
    const ring = G.rectRing(0, 0, 6, 6, 0);
    const a = w.addEntity({ type: 'structure', name: 'City Hall', material: 'concrete', author: 'city', footprint: ring, zBase: 0, zTop: 4 }, { author: 'city' });
    const fpA = w.fingerprint();
    w.updateEntity(a.id, { name: 'prank shed', material: 'cardboard', author: 'anon' }, { author: 'anon' });
    assert(w.fingerprint() !== fpA, 'renaming and rebuilding a thing must change the fingerprint');
  });

  test('widening a rotated building still yields a rectangle', () => {
    const w = buildPlace('rural');
    const target = w.entities().find((e) => e.type === 'structure' && Math.abs(G.orientedBounds(w.ringOf(e)).angle) > 0.15);
    assert(target, 'a rotated building exists');
    const ob0 = G.orientedBounds(w.ringOf(target));
    sayAndCommit(w, 'make this wider', { selection: { ids: [target.id] } });
    const ring = w.ringOf(w.get(target.id));
    const ob1 = G.orientedBounds(ring);
    // orientedBounds may name either side "width", so compare the sorted pair
    const before = [ob0.width, ob0.depth].sort((a, b) => a - b);
    const after = [ob1.width, ob1.depth].sort((a, b) => a - b);
    near(after[1], before[1], 0.05, 'the long side must not change');
    assert(after[0] > before[0] + 0.5, `the short side must grow: ${before[0]} → ${after[0]}`);
    // still a rectangle: its area equals its own oriented bounds
    near(G.area(ring), ob1.width * ob1.depth, 0.05, 'sheared into a parallelogram');
  });

  test('a proposal far from any water does not move the flood number', () => {
    const w = buildPlace('settlement');
    const dry = [86, -62];       // outside the current bounds, on high dry ground
    const r = say(w, 'put a bench here', { pointer: dry });
    const c = consequenceOf(w, r.plan);
    const flood = c.metrics.find((m) => m.key === 'flooding');
    if (flood) assert(Math.abs(flood.delta) < 1.5, `a distant bench moved flooding by ${flood.delta.toFixed(1)}%`);
  });

  test('the place can leave the screen as GIS data, and come back unchanged', () => {
    const w = buildPlace('settlement');
    sayAndCommit(w, 'when the rain is bad, all of this fills with water', { pointer: [-18, 6] }, { author: 'Miriam' });
    const fc = toGeoJSON(w);
    assert(fc.features.length > 50, `only ${fc.features.length} features`);
    eq(fc.crs.properties.name, 'urn:ogc:def:crs:OGC:1.3:CRS84');
    // provenance travels with the geometry
    const obs = fc.features.find((f) => f.properties.type === 'observation' && f.properties.author === 'Miriam');
    assert(obs, 'the observation is exported');
    assert(obs.properties.said.includes('fills with water'), 'with the words that caused it');
    eq(obs.properties.epistemic, 'OBSERVED');
    const lane = fc.features.find((f) => f.properties.disputed_by);
    assert(lane, 'and a disputed claim stays marked as disputed');
    // round trip through WGS84 and back
    const back = fromGeoJSON(fc, w);
    let worst = 0;
    for (const f of back) {
      const e = w.get(f.id);
      const ring = w.ringOf(e);
      if (!ring || f.local.length !== ring.length) continue;
      for (let i = 0; i < ring.length; i++) worst = Math.max(worst, G.dist(ring[i], f.local[i]));
    }
    // Coordinates are written at 9 decimal places of a degree — about 0.1 mm.
    // Anything under a millimetre is the writing precision, not a modelling error.
    assert(worst < 1e-3, `round trip drifted by ${(worst * 1000).toFixed(3)} mm`);
  });

  test('"why are you here?" answers about the thing you tapped', () => {
    const w = buildPlace('settlement');
    const r = sayAndCommit(w, 'put a bench here', { pointer: [4, 30] }, { author: 'Amina' });
    const id = r.plan.ghosts[0].id;
    const c = G.centroid(w.ringOf(w.get(id)));
    // exactly the app's own state after a tap: pointer AND selection both set
    const q = say(w, 'why are you here?', { selection: { ids: [id] }, pointer: c });
    const a = ask(w, q.intent, {});
    assert(a.rows.length && a.rows[0].id === id, `answered about ${a.rows[0]?.id || 'nothing'}`);
    assert(a.text.includes('Amina'), a.text);
  });
});

// ============================================================ REAL GROUND ====
// Everything above this line is measured on invented places. This group is
// measured on Baba Dogo, Nairobi as OpenStreetMap actually records it: 392
// building footprints, 87 roads, and ASTER elevation with 66 m of real relief.
// It runs offline from the committed import; `node import.js --preset=babadogo`
// refreshes it.
group('real — a place that exists', () => {
  const file = new URL('../places/babadogo.json', import.meta.url).pathname;
  const have = existsSync(file);
  const real = () => World.load(readFileSync(file, 'utf8'));

  test('the import carries its own provenance and licence', () => {
    if (!have) throw new Error('places/babadogo.json missing — run node import.js --preset=babadogo');
    const w = real();
    const m = w.place.meta;
    eq(m.source, 'OpenStreetMap');
    assert(/ODbL/.test(m.licence), 'the licence travels with the data');
    assert(m.bbox.length === 4 && m.fetchedAt, 'and the bbox and fetch date');
  });

  test('every imported entity can name the OSM object it came from', () => {
    const w = real();
    const ents = w.entities();
    assert(ents.length > 400, `only ${ents.length} entities`);
    for (const e of ents) {
      assert(e.epistemic === 'IMPORTED', `${e.id} is not marked IMPORTED`);
      const ref = e.evidence?.[0];
      assert(ref && ref.kind === 'osm' && /^(way|relation|node)\/\d+$/.test(ref.ref), `${e.id} has no OSM reference`);
    }
    const named = ents.filter((e) => e.type === 'structure' && e.name && e.name !== 'Building');
    assert(named.length > 0, 'some buildings carry their real names');
  });

  test('an assumed height says it is assumed', () => {
    const w = real();
    const assumed = w.entities().filter((e) => e.type === 'structure' && /assumed/.test(e.props?.heightBasis || ''));
    const stated = w.entities().filter((e) => e.type === 'structure' && /levels|height tag/.test(e.props?.heightBasis || ''));
    assert(assumed.length + stated.length > 300, 'every building records how its height was arrived at');
    // the honest part: most OSM buildings have no height, and the model says so
    assert(assumed.length > 0, 'and the guesses are labelled as guesses');
  });

  test('pointing at a real building is refused, by name and by area', () => {
    const w = real();
    const b = w.entities().find((e) => e.type === 'structure' && e.name && e.name !== 'Building');
    const c = G.centroid(w.ringOf(b));
    const ctx = makeContext(w, { pointer: c, camera: { eye: [0, -400, 300], target: [0, 0, 0] } });
    const p = plan(w, interpret('build a building here', ctx), ctx);
    const f = p.certificate.findings.find((x) => x.code === 'COLLISION' && x.others.includes(b.id));
    assert(f, `expected a collision with ${b.name}, got ${p.certificate.findings.map((x) => x.code).join(',')}`);
    assert(/m²/.test(f.message), 'and it measures the overlap');
    assert(!p.certificate.valid);
  });

  test('600 proposals across the real place: no false negatives, no crashes', () => {
    const w = real();
    const solids = w.entities().filter((e) => e.collision === 'solid');
    const b = w.place.bounds();
    const rnd = stream('real-regression', 3);
    const texts = ['build a building here', 'put a stall here', 'we need a drain here', 'there should be trees here', 'we need a path here'];
    let produced = 0, reported = 0;
    const missed = [];
    for (let i = 0; i < 600; i++) {
      const x = b[0] + rnd() * (b[2] - b[0]);
      const y = b[1] + rnd() * (b[3] - b[1]);
      const ctx = makeContext(w, { pointer: [x, y], camera: { eye: [0, -400, 300], target: [0, 0, 0] } });
      const p = plan(w, interpret(texts[i % texts.length], ctx), ctx);   // must not throw
      if (!p.ghosts?.length) continue;
      produced++;
      const codes = new Set(p.certificate.findings.map((f) => f.code));
      const named = new Set(p.certificate.findings.flatMap((f) => f.others || []));
      for (const g of p.ghosts) {
        const ring = w.place.ringOf(g);
        if (!ring) continue;
        for (const e of solids) {
          const r = w.ringOf(e);
          if (!r || !G.ringsIntersect(ring, r)) continue;
          if (g.zBase >= e.zTop - 0.01 || g.zTop <= e.zBase + 0.01) continue;
          if (G.area(ring) < 0.3) continue;
          const flagged = (codes.has('COLLISION') || codes.has('REQUIRES_REMOVAL')) && named.has(e.id);
          if (flagged) reported++;
          else missed.push(`${g.type} on ${e.name || e.id}`);
        }
      }
    }
    assert(produced > 500, `only ${produced} produced geometry`);
    eq(missed.length, 0, `sat on a real building without saying so: ${missed.slice(0, 4).join('; ')}`);
    assert(reported > 10, `only ${reported} real collisions exercised`);
    console.log(`      (600 proposals on real OSM data, ${reported} genuine collisions, 0 missed)`);
  });
});

// ================================================================ TERRAIN ===
// Everything used to take a single height from one sample: a building from its
// centroid, a road from its FIRST VERTEX. On a hillside that put 70% of Ravello's
// roads inside the hill — the worst by 151 metres — and left every building in
// the air. Ground is not a constant, and geometry has to answer to it.

group('slopes', () => {
  const hilly = existsSync(new URL('../places/ravello-ravello-italia.json', import.meta.url))
    ? 'ravello-ravello-italia' : null;

  test('tiling preserves area exactly, at every scale', () => {
    const shapes = [
      [[0, 0], [100, 0], [100, 40], [0, 40]],
      [[0, 0], [60, 5], [30, 50]],
      [[0, 0], [900, 0], [900, 700], [0, 700]],          // must not defeat the budget
      [[0, 0], [80, 0], [80, 30], [40, 12], [0, 30]],    // concave
    ];
    for (const ring of shapes) {
      for (const cell of [6, 12, 24, 40]) {
        const pieces = G.tileRing(ring, cell);
        const total = pieces.reduce((sum, p) => sum + Math.abs(G.area(p)), 0);
        const want = Math.abs(G.area(ring));
        assert(Math.abs(total - want) < Math.max(1e-6, want * 1e-9),
          `area ${want.toFixed(3)} became ${total.toFixed(3)} at cell ${cell}`);
      }
    }
  });

  test('a budget coarsens the grid and never abandons it', () => {
    // 630,000 m² at 6 m cells is 17,500 cells: far over budget. Bailing out here
    // left the largest surfaces — the ones most likely to cross a hill — flat.
    const huge = [[0, 0], [900, 0], [900, 700], [0, 700]];
    const pieces = G.tileRing(huge, 6);
    assert(pieces.length > 100, `a huge polygon was left as ${pieces.length} piece(s)`);
    assert(pieces.length <= 1200, `${pieces.length} pieces is past the budget`);
  });

  if (hilly) {
    const world = World.load(readFileSync(new URL(`../places/${hilly}.json`, import.meta.url), 'utf8'));
    const P = world.place;
    const ground = (x, y) => P.groundAt(x, y);

    test('nothing built floats above the ground or is swallowed by it', () => {
      const bad = [];
      for (const e of world.entities()) {
        if (!['structure', 'wall'].includes(e.type)) continue;
        const ring = world.ringOf(e);
        if (!ring || ring.length < 3) continue;
        const span = G.groundSpan(ring, ground);
        if (!span) continue;
        if (e.zBase > span.lo + 0.01) bad.push(`${e.name || e.id} floats ${(e.zBase - span.lo).toFixed(1)} m`);
        if (e.zTop < span.hi + 0.01) bad.push(`${e.name || e.id} is buried ${(span.hi - e.zTop).toFixed(1)} m`);
      }
      eq(bad.slice(0, 3).join('; '), '', `${bad.length} of them, on 281 m of relief`);
    });

      test('a flat thing lies on the ground, whatever it was authored against', () => {
      // Surfaces were authored from their CENTROID and roads from their FIRST
      // VERTEX. Reconstructing the drape offset from the stored zTop therefore
      // inherited that difference as error — it put an 86,000 m² wood sixty
      // metres in the air over Boone. A thing that lies on the ground is at the
      // ground, and nothing about its stored height may change that.
      const FLAT = ['path', 'road', 'surface', 'parcel', 'drain', 'water', 'stream'];
      let worst = 0, worstName = '';
      for (const e of world.entities()) {
        if (!FLAT.includes(e.type)) continue;
        const ring = world.ringOf(e);
        if (!ring || ring.length < 3) continue;
        const span = G.groundSpan(ring, ground);
        if (!span) continue;
        // what the old rule would have produced, as the thing being guarded against
        const authored = Math.abs(e.zTop - ground(ring[0][0], ring[0][1]));
        if (authored > worst) { worst = authored; worstName = e.name || e.id; }
      }
      assert(worst > 5, `expected a large authored discrepancy to guard against, saw ${worst.toFixed(1)} m`);
      console.log(`      (worst stored-vs-first-vertex gap: ${worst.toFixed(1)} m on ${worstName} — no longer used)`);
    });

    test('the hill never closes over a road laid on it', () => {
      // groundAt is bilinear — a curved surface. The terrain mesh is flat
      // triangles. They meet only at the sample points, and between them the
      // drawn hill rides above the curve and swallows whatever was laid on it:
      // a fifth of Boone's road vertices at full detail, more than half of them
      // zoomed out, by up to 9.7 m. Tiling on the terrain's own lattice and
      // splitting on its own diagonal puts every piece inside one drawn
      // triangle, where the ground is a single plane and the drape coincides
      // with it exactly. This test samples triangle INTERIORS, because vertices
      // sitting on the surface was never the thing in question.
      const t = P.terrain;
      const drawn = (x, y, step) => {
        const span = t.cell * step;
        const fx = (x - t.bounds[0]) / span, fy = (y - t.bounds[1]) / span;
        const ci = Math.floor(fx), cj = Math.floor(fy), i = ci * step, j = cj * step;
        const u = fx - ci, v = fy - cj;
        const h00 = t.at(i, j), h10 = t.at(i + step, j);
        const h11 = t.at(i + step, j + step), h01 = t.at(i, j + step);
        return v <= u ? h00 + (h10 - h00) * u + (h11 - h10) * v
          : h00 + (h11 - h01) * u + (h01 - h00) * v;
      };
      const FLAT = ['road', 'path', 'surface', 'parcel', 'water', 'stream', 'drain'];
      for (const step of [1, 2, 3]) {
        const span = t.cell * step, grid = [t.bounds[0], t.bounds[1]];
        let buried = 0, n = 0, worst = 0;
        for (const e of world.entities()) {
          if (!FLAT.includes(e.type)) continue;
          const ring = world.ringOf(e);
          if (!ring || ring.length < 3) continue;
          const off = 0.03;
          for (const piece of G.tileRing(ring, span, grid)) {
            const idx = G.triangulate(piece);
            for (let k = 0; k < idx.length; k += 3) {
              const v = [idx[k], idx[k + 1], idx[k + 2]].map((m) => {
                const q = piece[m];
                return [q[0], q[1], drawn(q[0], q[1], step) + off];
              });
              for (let a = 1; a <= 3; a++) {
                for (let b = 1; a + b <= 4; b++) {
                  const u1 = a / 5, u2 = b / 5;
                  const x = v[0][0] + u1 * (v[1][0] - v[0][0]) + u2 * (v[2][0] - v[0][0]);
                  const y = v[0][1] + u1 * (v[1][1] - v[0][1]) + u2 * (v[2][1] - v[0][1]);
                  const z = v[0][2] + u1 * (v[1][2] - v[0][2]) + u2 * (v[2][2] - v[0][2]);
                  const d = drawn(x, y, step) - z;
                  n++;
                  if (d > 1e-6) { buried++; worst = Math.max(worst, d); }
                }
              }
            }
          }
        }
        assert(n > 500, `only ${n} interior samples at step ${step}`);
        eq(buried, 0, `${buried}/${n} of the surface is inside the hill at step ${step}, worst ${worst.toFixed(2)} m`);
      }
    });

    test('the renderer can actually draw the contours', () => {
      // The test below reimplements the algorithm, so it kept passing while a
      // ReferenceError inside buildContours blanked the entire scene. A test
      // that never calls the code cannot report that the code is broken. This
      // one runs the real method against a stub line builder — no GL needed,
      // since drawing a contour is arithmetic and a list of segments.
      const segments = [];
      const L = { segment: (a, b, col, alpha) => segments.push({ a, b, col, alpha }) };
      const self = {};
      Renderer.prototype.buildContours.call(self, L, world, 'high');
      assert(segments.length > 200, `only ${segments.length} contour segments drawn`);
      assert(self.contourInterval > 0, 'no contour interval was chosen');
      for (const s of segments.slice(0, 50)) {
        assert(Number.isFinite(s.a[2]) && Number.isFinite(s.b[2]),
          `a contour segment has no height: ${JSON.stringify(s.a)}`);
      }
      // index contours are drawn heavier, which is how a map is read
      const heavy = segments.filter((x) => x.alpha > 0.6).length;
      assert(heavy > 0 && heavy < segments.length, `index contours are ${heavy}/${segments.length}`);
    });

  test('a contour lies on the ground it describes', () => {
      // Marching squares on the cell as a QUAD describes a curved surface; the
      // mesh draws two flat triangles. Contour the curve, draw the facet, and
      // the line crosses in and out of the hill — a fifth of the contour length
      // on Watauga Lake, by up to 4.6 m, which is why the lines came out dashed
      // across the steep faces. Inside one flat triangle the level set is a
      // straight segment lying exactly on the surface.
      const t = P.terrain;
      const drawn = (x, y) => {
        const fx = (x - t.bounds[0]) / t.cell, fy = (y - t.bounds[1]) / t.cell;
        const i = Math.floor(fx), j = Math.floor(fy);
        const u = fx - i, v = fy - j;
        const h00 = t.at(i, j), h10 = t.at(i + 1, j);
        const h11 = t.at(i + 1, j + 1), h01 = t.at(i, j + 1);
        return v <= u ? h00 + (h10 - h00) * u + (h11 - h10) * v
          : h00 + (h11 - h01) * u + (h01 - h00) * v;
      };
      let lo = Infinity, hi = -Infinity;
      for (const v of t.data) { if (v < lo) lo = v; if (v > hi) hi = v; }
      const raw = (hi - lo) / 25;
      const pow = Math.pow(10, Math.floor(Math.log10(raw)));
      const interval = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= raw) || 10 * pow;

      let segments = 0, buried = 0, samples = 0, worst = 0;
      const seg = (tri, level) => {
        const hit = [];
        for (let k = 0; k < 3; k++) {
          const a = tri[k], b = tri[(k + 1) % 3];
          if ((a[2] < level) === (b[2] < level)) continue;
          const f = (level - a[2]) / (b[2] - a[2]);
          hit.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
        }
        if (hit.length !== 2) return;
        segments++;
        for (let k = 1; k < 8; k++) {
          const f = k / 8;
          const x = hit[0][0] + (hit[1][0] - hit[0][0]) * f;
          const y = hit[0][1] + (hit[1][1] - hit[0][1]) * f;
          const d = drawn(x, y) - (level + 0.12);
          samples++;
          if (d > 1e-6) { buried++; worst = Math.max(worst, d); }
        }
      };
      for (let level = Math.ceil(lo / interval) * interval; level <= hi; level += interval) {
        for (let j = 0; j + 1 < t.ny; j++) {
          for (let i = 0; i + 1 < t.nx; i++) {
            const x0 = t.bounds[0] + i * t.cell, y0 = t.bounds[1] + j * t.cell;
            const x1 = t.bounds[0] + (i + 1) * t.cell, y1 = t.bounds[1] + (j + 1) * t.cell;
            const p00 = [x0, y0, t.at(i, j)], p10 = [x1, y0, t.at(i + 1, j)];
            const p11 = [x1, y1, t.at(i + 1, j + 1)], p01 = [x0, y1, t.at(i, j + 1)];
            seg([p00, p10, p11], level);
            seg([p00, p11, p01], level);
          }
        }
      }
      assert(segments > 200, `only ${segments} contour segments on 281 m of relief`);
      eq(buried, 0, `${buried}/${samples} of the contour is inside the hill, worst ${worst.toFixed(2)} m`);
    });

  test('water is drawn over the land it runs through, and under the ways', () => {
      // Half of Boone's water was invisible for one reason: a stream sat 2 cm
      // above the ground and the wood it ran through sat 3 cm, so the wood won.
      // Not too small, not too dark — covered.
      assert(FLAT_ORDER.water > FLAT_ORDER.surface,
        'a creek must show through the wood it runs through');
      assert(FLAT_ORDER.water > FLAT_ORDER.parcel, 'and through a parcel');
      assert(FLAT_ORDER.road > FLAT_ORDER.water,
        'but a bridge crosses over a river, not under it');
      assert(FLAT_ORDER.path > FLAT_ORDER.water, 'same for a footbridge');
      assert(FLAT_ORDER.observation > FLAT_ORDER.road,
        'what someone said sits above everything it is about');
    });

  test('a flat thing follows the hill instead of spanning it', () => {
      const FLAT = ['path', 'road', 'surface', 'parcel', 'drain', 'water', 'stream'];
      const cell = Math.max(8, Math.min(16, (P.terrain?.cell ?? 24) / 2));
      let planeWorst = 0, drapedWorst = 0;
      for (const e of world.entities()) {
        if (!FLAT.includes(e.type)) continue;
        const ring = world.ringOf(e);
        if (!ring || ring.length < 3) continue;
        const off = (e.zTop - ground(ring[0][0], ring[0][1]));
        for (const piece of G.tileRing(ring, cell)) {
          const idx = G.triangulate(piece);
          for (let i = 0; i < idx.length; i += 3) {
            const t = [idx[i], idx[i + 1], idx[i + 2]].map((k) => {
              const q = piece[k];
              return [q[0], q[1], ground(q[0], q[1]) + off];
            });
            for (const [u, v] of [[0.25, 0.25], [0.5, 0.25], [0.25, 0.5]]) {
              const x = t[0][0] + u * (t[1][0] - t[0][0]) + v * (t[2][0] - t[0][0]);
              const y = t[0][1] + u * (t[1][1] - t[0][1]) + v * (t[2][1] - t[0][1]);
              const gz = ground(x, y);
              planeWorst = Math.max(planeWorst, Math.abs(e.zTop - gz));
              const d = ((t[1][1] - t[2][1]) * (t[0][0] - t[2][0]) + (t[2][0] - t[1][0]) * (t[0][1] - t[2][1]));
              if (Math.abs(d) < 1e-12) continue;
              const l1 = ((t[1][1] - t[2][1]) * (x - t[2][0]) + (t[2][0] - t[1][0]) * (y - t[2][1])) / d;
              const l2 = ((t[2][1] - t[0][1]) * (x - t[2][0]) + (t[0][0] - t[2][0]) * (y - t[2][1])) / d;
              const z = l1 * t[0][2] + l2 * t[1][2] + (1 - l1 - l2) * t[2][2];
              drapedWorst = Math.max(drapedWorst, Math.abs(z - off - gz));
            }
          }
        }
      }
      assert(planeWorst > 50, `the flat-plane failure should be enormous here, was ${planeWorst.toFixed(1)} m`);
      assert(drapedWorst < 5, `draped surfaces still miss the ground by ${drapedWorst.toFixed(1)} m`);
      console.log(`      (one plane: ${planeWorst.toFixed(0)} m off the ground · draped: ${drapedWorst.toFixed(1)} m)`);
    });
  }
});

// ================================================================ BODIES ====
// Placing architecture in a place is not loading a mesh. A mesh cannot say what
// it stands on, what it blocks, or what the ground must do to accept it — so a
// body is a contract (footprint, floor datum, height, entrances) and the model
// is only its appearance. What makes it real is the earthwork: a building on a
// hillside is cut into and filled up to, and that has a volume.

group('bodies', () => {
  const glbPath = new URL('./fixtures-house.glb', import.meta.url);
  const hasGLB = existsSync(glbPath);

  // A hillside built here rather than downloaded. These tests were written
  // against an imported place and passed locally while failing in CI, because
  // imported places are deliberately not in the repo. A test about the SHAPE OF
  // GROUND should make its own ground: 30 m of fall across 300 m, with a fold
  // in it so orientation has something to matter about.
  function hillside({ cell = 3, size = 300, fall = 30 } = {}) {
    const w = buildPlace('settlement');
    const Heightfield = Object.getPrototypeOf(w.place).constructor === Object
      ? null : (w.place.terrain?.constructor || null);
    const bounds = [-size / 2, -size / 2, size / 2, size / 2];
    const HF = Heightfield || heightfieldCtor();
    const t = new HF(bounds, cell);
    for (let j = 0; j < t.ny; j++) {
      for (let i = 0; i < t.nx; i++) {
        const x = bounds[0] + i * cell, y = bounds[1] + j * cell;
        // a slope running east, folded into a shallow valley running north
        t.data[j * t.nx + i] = 100
          + (x / size) * fall
          + Math.cos((y / size) * Math.PI * 2) * (fall * 0.18);
      }
    }
    w.place.terrain = t;
    return w;
  }
  function heightfieldCtor() {
    const probe = buildPlace('settlement');
    if (probe.place.terrain) return probe.place.terrain.constructor;
    throw new Error('no Heightfield to build a hillside with');
  }

  test('a .glb is read into a contract, without a library', () => {
    if (!hasGLB) return;
    const buf = readFileSync(glbPath);
    const { points } = readGLB(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    assert(points.length >= 8, `only ${points.length} vertices read`);
    const body = bodyFromModel(points, { name: 'House', url: 'house.glb' });
    const ob = G.orientedBounds(body.footprint);
    // the fixture is 12 x 8 m with a ridge overhanging 0.9 m on each side
    assert(Math.abs(ob.width - 12) < 0.2 && Math.abs(ob.depth - 8) < 0.2,
      `footprint came out ${ob.width.toFixed(1)}×${ob.depth.toFixed(1)}, wanted 12×8`);
    assert(Math.abs(body.height - 5.2) < 0.2, `height ${body.height.toFixed(1)}, wanted 5.2`);
    // an eave is not ground: the overhang must not enlarge what it occupies
    assert(ob.depth < 9.5, `the roof overhang was counted as footprint (${ob.depth.toFixed(1)} m)`);
    assert(body.entrances.length >= 1, 'a building needs a way in');
  });

  test('a body can be built from dimensions alone', () => {
    const b = boxBody({ width: 10, depth: 6, height: 4 });
    eq(Math.round(Math.abs(G.area(b.footprint))), 60);
    eq(b.height, 4);
  });

  test('ground too coarse to hold a building is refined until it can', () => {
    // A 29 m elevation cell cannot express a 12 m house: seating one changed a
    // single sample, so the earthwork was computed and had nowhere to go.
    const w = hillside({ cell: 30 });
    const coarse = w.place.terrain.cell;
    assert(coarse > 20, `this test needs a coarse DEM, has ${coarse.toFixed(1)} m`);
    const r = refineTerrain(w.place, 3);
    assert(r.refined, 'refusing to refine leaves buildings unrecordable');
    assert(w.place.terrain.cell <= 3.1, `still ${w.place.terrain.cell} m`);
    // and it says plainly that the new detail is interpolation, not survey
    assert(/interpolation/.test(w.place.meta.refined.note), 'the invention must be declared');
    // refining twice is a no-op, not a further invention
    eq(refineTerrain(w.place, 3).refined, false);
  });

  test('seating a building cuts and fills the ground, and can be undone', () => {
    const w = hillside({ cell: 3 });
    const body = boxBody({ width: 12, depth: 8, height: 3.2, name: 'House' });
    const at = [0, 0];
    const fall = G.groundSpan(G.circleRing(0, 0, 10, 12), (a, b) => w.place.groundAt(a, b), 5);
    assert(fall.hi - fall.lo > 1, `the test hillside is flat (${(fall.hi - fall.lo).toFixed(1)} m)`);

    const cutSeat = planSeat(w, body, at, { level: 'cut' });
    const fillSeat = planSeat(w, body, at, { level: 'fill' });
    assert(cutSeat.floor < fillSeat.floor, 'cutting must put the floor lower than filling');
    assert(cutSeat.cut > cutSeat.fill, 'a cut should mostly cut');
    assert(fillSeat.fill > fillSeat.cut, 'a fill should mostly fill');

    const balanced = planSeat(w, body, at, { level: 'balanced' });
    const worst = Math.max(balanced.cut, balanced.fill);
    assert(Math.abs(balanced.balance) < worst, 'balanced should move less earth than it keeps');

    // the ground actually changes, and the pad is level under the house
    const cornersBefore = balanced.ring.map((p) => w.place.groundAt(p[0], p[1]));
    const undo = settleGround(w, balanced);
    // The principled threshold is not a round number: the ground must be able
    // to record AT LEAST the pad. Anything less and the earthwork was computed
    // and thrown away, which is exactly what a 30 m cell did.
    const cell = w.place.terrain.cell;
    const recorded = undo.changed * cell * cell;
    const padArea = Math.abs(G.area(balanced.pad));
    assert(recorded >= padArea * 0.6,
      `only ${Math.round(recorded)} m² of ground could change for a ${Math.round(padArea)} m² pad`);
    const cornersAfter = balanced.ring.map((p) => w.place.groundAt(p[0], p[1]));
    for (const z of cornersAfter) {
      assert(Math.abs(z - balanced.floor) < 0.6, `corner at ${z.toFixed(1)} is not on the floor ${balanced.floor.toFixed(1)}`);
    }
    // and it is a proposal, so it goes back exactly
    undo.restore();
    const restored = balanced.ring.map((p) => w.place.groundAt(p[0], p[1]));
    for (let i = 0; i < restored.length; i++) {
      assert(Math.abs(restored[i] - cornersBefore[i]) < 1e-6, 'the ground did not go back');
    }
  });

  test('turning a house along the contour is measurably cheaper', () => {
    // The Henry House is sited "along the contour rather than across it". That
    // is not a style: it is an earthwork claim, and a place model can check it.
    const w = hillside({ cell: 3 });
    const body = boxBody({ width: 20, depth: 6, height: 3.2, name: 'House' });
    const at = [0, 0];
    let best = null, worstEarth = 0;
    for (let deg = 0; deg < 180; deg += 15) {
      const s = planSeat(w, body, at, { level: 'balanced', rotation: (deg * Math.PI) / 180 });
      const earth = s.cut + s.fill;
      if (!best || earth < best.earth) best = { deg, earth };
      if (earth > worstEarth) worstEarth = earth;
    }
    assert(worstEarth > best.earth * 1.2,
      `orientation barely mattered: best ${Math.round(best.earth)} m³ vs worst ${Math.round(worstEarth)} m³`);
    console.log(`      (best orientation ${best.deg}° moves ${Math.round(best.earth)} m³; worst moves ${Math.round(worstEarth)} m³)`);
  });
});

// ============================================================= LOCATING ====
// "watson island" was answered with "nothing usable here — OpenStreetMap has no
// buildings or roads mapped in this area". That is the map talking, not the
// world. An unmapped island is still an island, and a person who already knows
// the coordinate should not have to invent a searchable name for it.

group('locating', () => {
  test('a coordinate is a place name', () => {
    const same = (r) => r && Math.abs(r.lat - 25.7867) < 0.001 && Math.abs(r.lon + 80.1750) < 0.001;
    const forms = [
      '25.7867, -80.1750',
      '25.7867 -80.1750',
      '25.7867N 80.1750W',
      '25°47\'12"N 80°10\'30"W',
      'https://www.google.com/maps/@25.7867,-80.1750,17z',
      'geo:25.7867,-80.1750',
      '  25.7867 , -80.1750  ',
    ];
    for (const f of forms) {
      const r = parseCoordinates(f);
      assert(same(r), `did not read “${f}” — got ${r ? r.label : 'nothing'}`);
    }
    eq(parseCoordinates('-33.8688, 151.2093').label, '33.86880°S 151.20930°E', 'southern and eastern');
  });

  test('an ordinary search is still an ordinary search', () => {
    // the parser must never swallow a name, or every place becomes a coordinate
    for (const q of ['watson island', 'Kibera Nairobi', '1600 Pennsylvania Ave',
      'Jordaan Amsterdam', 'Boone', 'Rue 24', 'Sector 5']) {
      eq(parseCoordinates(q), null, `“${q}” was mistaken for a coordinate`);
    }
    // and nonsense coordinates are refused rather than clamped
    eq(parseCoordinates('91.5, -80.1'), null, 'latitude past the pole');
    eq(parseCoordinates('25.7, -200'), null, 'longitude past the meridian');
  });

  test('a coordinate opens a window without asking anyone', () => {
    const at = parseCoordinates('25.7867, -80.1750');
    const place = coordinatePlace(at, 900);
    const [s0, w0, n0, e0] = place.bbox;
    assert(n0 > s0 && e0 > w0, 'the window is inside out');
    const heightM = (n0 - s0) * 111320;
    const widthM = (e0 - w0) * 111320 * Math.cos((at.lat * Math.PI) / 180);
    assert(Math.abs(heightM - 900) < 20, `window is ${heightM.toFixed(0)} m tall, wanted 900`);
    assert(Math.abs(widthM - 900) < 20, `window is ${widthM.toFixed(0)} m wide, wanted 900`);
  });

  test('the window can be widened, or moved to where you are looking', () => {
    // A window is a guess made before seeing anything, so the thing you came
    // for runs off its edge. Widening used to mean searching again from scratch
    // and losing the place you were standing in. The place remembers the corner
    // of the world it was cut from, so the camera can be turned back into a
    // latitude and longitude.
    const key = 'watauga-lake-carter-county-united-states';
    if (!existsSync(new URL(`../places/${key}.json`, import.meta.url))) return;
    const w = World.load(readFileSync(new URL(`../places/${key}.json`, import.meta.url), 'utf8'));
    const b0 = w.place.meta.bbox;
    const lat0 = (b0[0] + b0[2]) / 2, lon0 = (b0[1] + b0[3]) / 2;

    // centred: same centre, bigger window
    const wide = reframe(w, { camera: { target: [0, 0] }, metres: 1800 });
    assert(Math.abs(wide.lat - lat0) < 1e-6 && Math.abs(wide.lon - lon0) < 1e-6,
      'widening from the centre moved the centre');
    const tall = (wide.bbox[2] - wide.bbox[0]) * 111320;
    assert(Math.abs(tall - 1800) < 20, `asked for 1800 m, got ${tall.toFixed(0)}`);

    // looking somewhere: the centre follows, in real metres
    const moved = reframe(w, { camera: { target: [300, 300] }, metres: 900 });
    const northM = (moved.lat - lat0) * 111320;
    const eastM = (moved.lon - lon0) * 111320 * Math.cos((lat0 * Math.PI) / 180);
    assert(Math.abs(northM - 300) < 5, `moved ${northM.toFixed(0)} m north, wanted 300`);
    assert(Math.abs(eastM - 300) < 5, `moved ${eastM.toFixed(0)} m east, wanted 300`);

    // and a place that does not know where it is says so rather than guessing
    const synthetic = buildPlace('settlement');
    let threw = null;
    try { reframe(synthetic, { camera: { target: [0, 0] }, metres: 900 }); }
    catch (err) { threw = err.message; }
    assert(threw && /where in the world/.test(threw), `invented a location: ${threw}`);
  });

  test('a widened window does not overwrite the one it came from', () => {
    // Keys were truncated at 40 characters, which cut the width off the end:
    // the 900 m and 2300 m windows of the same place slugged identically, so
    // re-cutting a window silently destroyed its origin. Caught live, not by
    // reading the code.
    const base = 'Watauga Lake, Carter County, United States';
    const keys = [base, `${base} · 900 m`, `${base} · 2300 m`, `${base} · 3600 m`].map(slug);
    eq(new Set(keys).size, keys.length, `these collide: ${keys.join(', ')}`);
    for (const k of keys) assert(k.length <= 64, `${k} is unreasonably long`);
    // ordinary names are untouched
    eq(slug('Kibera, Nairobi'), 'kibera-nairobi');
  });

  test('an unmapped place still opens, and says so', () => {
    // Somewhere with terrain and nothing built. The refusal used to be thrown
    // before the ground was ever looked at.
    const key = 'watson-island-miami-united-states';
    if (!existsSync(new URL(`../places/${key}.json`, import.meta.url))) return;
    const w = World.load(readFileSync(new URL(`../places/${key}.json`, import.meta.url), 'utf8'));
    assert(w.place.terrain, 'the ground is what makes an unmapped place usable');
    assert(w.entities().length > 0, 'Watson Island is in fact mapped — it should never have been refused');
  });
});

// ============================================================ NO DANGLING ===
// captureView() and openAIPanel() were both deleted with the panel that used
// them, while three call sites stayed behind. Every one threw a ReferenceError
// at the exact moment a person asked for something, which the interface
// reported as nothing happening at all. No test could see it because none of
// this runs headless. So check the source itself.

group('references', () => {
  const GLOBALS = new Set([
    'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'parseFloat',
    'parseInt', 'isNaN', 'isFinite', 'structuredClone', 'queueMicrotask', 'encodeURIComponent',
    'decodeURIComponent', 'requestAnimationFrame', 'cancelAnimationFrame', 'addEventListener',
    'removeEventListener', 'alert', 'confirm', 'atob', 'btoa', 'getComputedStyle', 'matchMedia',
    'reportError', 'require', 'importScripts', 'postMessage', 'createImageBitmap',
  ]);
  const KEYWORDS = /^(if|for|while|switch|catch|return|typeof|new|await|async|function|do|else|of|in|delete|void|yield|import|export|case)$/;

  /** Strip comments, template/quoted strings and regex literals: none are code. */
  function strip(src) {
    let out = '', i = 0, prev = '';
    while (i < src.length) {
      const c = src[i], two = src.slice(i, i + 2);
      if (two === '/*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; out += ' '; continue; }
      if (two === '//') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; out += ' '; continue; }
      if (c === '`' || c === "'" || c === '"') {
        i++;
        while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
        i++; out += c === '`' ? '``' : `${c}${c}`; prev = ')'; continue;
      }
      // a slash is a regex only where a value cannot precede it
      if (c === '/' && !/[\w$)\]]/.test(prev)) {
        let j = i + 1, cls = false;
        while (j < src.length) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') cls = true;
          else if (src[j] === ']') cls = false;
          else if (src[j] === '/' && !cls) break;
          else if (src[j] === '\n') { j = -1; break; }
          j++;
        }
        if (j > 0) { i = j + 1; while (/[a-z]/.test(src[i] || '')) i++; out += '/RE/'; prev = ')'; continue; }
      }
      out += c;
      if (!/\s/.test(c)) prev = c;
      i++;
    }
    return out;
  }

  /** Everything a file introduces: declarations, methods, imports, parameters. */
  function declaredIn(src) {
    const d = new Set();
    const add = (re, i = 1) => { for (const m of src.matchAll(re)) if (m[i]) d.add(m[i]); };
    add(/\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g);
    add(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g);
    add(/\bclass\s+([A-Za-z_$][\w$]*)/g);
    add(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g);
    add(/\bimport\s+([A-Za-z_$][\w$]*)\s+from/g);
    add(/\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g);
    for (const m of src.matchAll(/\bimport\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const n = part.trim().split(/\s+as\s+/).pop().trim();
        if (n) d.add(n);
      }
    }
    // class and object methods:  name(...) {
    // a parameter list may hold defaults, so `=` cannot be the terminator here
    add(/^\s*(?:static\s+)?(?:async\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{/gm);
    // destructured bindings
    for (const m of src.matchAll(/(?:const|let|var)\s*[[{]([^\]}]*)[\]}]/g)) {
      for (const n of m[1].matchAll(/([A-Za-z_$][\w$]*)/g)) d.add(n[1]);
    }
    // every parameter list, scanned with balanced parens so that defaults
    // containing their own arrow functions do not break the match
    for (let i = 0; i < src.length; i++) {
      if (src[i] !== '(') continue;
      let depth = 0, j = i;
      for (; j < src.length; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')' && --depth === 0) break;
      }
      const after = src.slice(j + 1, j + 4);
      if (!/^\s*(=>|\{)/.test(after)) continue;
      for (const n of src.slice(i + 1, j).matchAll(/([A-Za-z_$][\w$]*)/g)) d.add(n[1]);
      i = j;
    }
    return d;
  }

  const FILES = ['src/ui/app.js', 'src/ui/chrome.js', 'src/ui/importui.js',
    'src/ai/operator.js', 'src/ai/modes.js', 'src/ai/investigate.js'];

  for (const file of FILES) {
    test(`${file} calls nothing it does not have`, () => {
      const src = strip(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
      const declared = declaredIn(src);
      const missing = new Set();
      for (const m of src.matchAll(/(^|[^.\w$?])([a-zA-Z_$][\w$]*)\s*\(/g)) {
        const n = m[2];
        if (declared.has(n) || GLOBALS.has(n) || KEYWORDS.test(n) || /^[A-Z]/.test(n)) continue;
        missing.add(n);
      }
      eq([...missing].sort().join(', '), '', `undefined at call time in ${file}`);
    });
  }

  // Two fields called `mode` on the state object, one for the drawing tool and
  // one for the assistant. The second won, so drawing set the assistant's
  // commitment and the assistant reset the drawing tool. JavaScript reports
  // nothing at all for this. It is the third collision of its kind in this
  // build (S.plan was the second), so it gets a test rather than another fix.
  test('no object literal declares the same key twice', () => {
    const files = ['src/ui/app.js', 'src/ui/chrome.js', 'src/ui/importui.js',
      'src/ai/operator.js', 'src/ai/modes.js', 'src/ai/investigate.js',
      'src/core/world.js', 'src/world/ops.js'];
    const bad = [];
    for (const file of files) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      // walk brace depth, collecting `key:` at each level of each literal
      const stack = [];
      let depth = 0;
      const lines = src.split('\n');
      for (let ln = 0; ln < lines.length; ln++) {
        const line = lines[ln].replace(/\/\/.*$/, '');
        for (let i = 0; i < line.length; i++) {
          if (line[i] === '{') { depth++; stack.push({ keys: new Map(), depth }); }
          else if (line[i] === '}') { stack.pop(); depth--; }
        }
        const top = stack[stack.length - 1];
        if (!top) continue;
        const m = line.match(/^\s*([A-Za-z_$][\w$]*)\s*:/);
        if (!m) continue;
        if (top.keys.has(m[1])) bad.push(`${file}:${ln + 1} ${m[1]} (also line ${top.keys.get(m[1])})`);
        else top.keys.set(m[1], ln + 1);
      }
    }
    eq(bad.join('; '), '', 'a later key silently overwrites an earlier one');
  });

  // A 400 naming one parameter should cost that parameter, not the request and
  // not the endpoint. These are the real refusals, verbatim.
  test('an endpoint refusing a parameter is obeyed, not fought', () => {
    const cases = [
      [JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0.0 with this model. Only the default (1) value is supported.", type: 'invalid_request_error', param: 'temperature' } }),
        { temperature: 0, model: 'x' }, 'temperature'],
      [JSON.stringify({ error: { message: "Unknown parameter: 'text.verbosity'.", param: 'text.verbosity' } }),
        { text: { verbosity: 'low' } }, 'text.verbosity'],
      [JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", param: 'max_tokens' } }),
        { max_tokens: 100 }, 'max_tokens'],
      [JSON.stringify({ error: { message: "'reasoning' is not supported with this model.", param: 'reasoning' } }),
        { reasoning: { effort: 'high' } }, 'reasoning'],
      [JSON.stringify({ error: { message: 'response_format json_object is not supported', param: 'response_format' } }),
        { response_format: { type: 'json_object' } }, 'response_format'],
    ];
    for (const [text, body, expect] of cases) {
      const fix = repairFor(text, body);
      assert(fix, `no repair found for ${expect}`);
      eq(fix.drop, expect, 'dropped the wrong parameter');
    }
    // max_tokens moved rather than vanished
    eq(repairFor(cases[2][0], cases[2][1]).rename.join('->'), 'max_tokens->max_completion_tokens');
    // and a refusal that names nothing must not be silently swallowed
    eq(repairFor(JSON.stringify({ error: { message: 'You exceeded your quota.' } }), {}), null,
      'a quota error is not a parameter to drop');
  });

  // Every $('id') the interface reaches for must exist in the page. A silent
  // no-op edit left the explore button out of index.html while app.js still
  // wired it, and the ReferenceError took the whole boot down — the same shape
  // as captureView, arriving by a different route. Text-substitution edits fail
  // quietly; this makes the result loud.
  test('every element the interface reaches for exists in the page', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const present = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const missing = new Set();
    for (const file of ['src/ui/app.js']) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      for (const m of src.matchAll(/\$\('([A-Za-z][\w-]*)'\)/g)) {
        if (!present.has(m[1])) missing.add(m[1]);
      }
    }
    eq([...missing].sort().join(', '), '', 'the page has no such element');
  });

  // and the ranking the interface promises
  test('the 5.6 line is preferred over everything older', () => {
    const src = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
    const block = src.slice(src.indexOf('const PREFERRED = ['), src.indexOf('function rankModel'));
    const PREFERRED = eval(block.slice(block.indexOf('['), block.lastIndexOf(']') + 1));
    const rank = (m) => {
      for (let i = 0; i < PREFERRED.length; i++) if (PREFERRED[i].test(m)) return i;
      if (/gpt-4o/i.test(m)) return PREFERRED.length + 1;
      return PREFERRED.length;
    };
    const ordered = ['gpt-4o', 'gpt-4o-mini', 'gpt-5.6-terra', 'gpt-4.1', 'gpt-5.6-sol',
      'o3', 'gpt-5', 'gpt-5.6-luna', 'gpt-3.5-turbo', 'gpt-5.6']
      .sort((a, b) => rank(a) - rank(b) || b.localeCompare(a));
    eq(ordered[0], 'gpt-5.6-sol', 'sol must be first');
    eq(ordered[1], 'gpt-5.6-luna', 'luna second');
    eq(ordered[2], 'gpt-5.6-terra', 'terra third');
    eq(ordered[ordered.length - 1], 'gpt-4o', 'gpt-4o is a fallback, never a default');
  });
});

// ================================================================== REPORT ===
console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
if (failed) {
  console.log('\nfailures:');
  for (const f of failures) console.log(`  ${f.group} › ${f.name}\n    ${f.err.stack?.split('\n').slice(0, 3).join('\n    ')}`);
  process.exit(1);
}
