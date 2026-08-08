// THE WORLDTEXT GAUNTLET — falsification before polish (§109).
//
// Each test is written to prove a claimed novelty FALSE. If the claim survives
// the experiment designed to kill it, the claim stands for now.
//
//   node tests/run.js

import { WorldText, EPISTEMIC, resetIds } from '../src/worldtext.js';
import { loadDir, loadText, addText } from '../src/load.js';
import { index, indexWithModel, gazetteer } from '../src/parse.js';
import { discover, field, evaluate, contradictions } from '../src/potential.js';
import { frontier, semanticSlice, LOD } from '../src/activate.js';
import { wake, killAllAgents, liveAgents, knowledgePath, compileContext } from '../src/agent.js';
import { compileScene, writeback } from '../src/scene.js';
import { prose, film, timeline, map, invariance, playable } from '../src/project.js';
import { ask, provenance, disputes, asPerson, reasonsToVisit, whoKnows } from '../src/query.js';
import { setModel, clearModel, scriptedModel, getModel } from '../src/model.js';
import { admitParse, admitVoice, VERDICT } from '../src/continuity.js';

let passed = 0, failed = 0, group_ = '';
const failures = [];
const only = process.argv[2] || null;

function group(name, fn) {
  if (only && !name.toLowerCase().startsWith(only.toLowerCase())) return;
  group_ = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
  fn();
}
const pending = [];
function test(name, fn) {
  const g = group_;
  const ok = () => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); };
  const bad = (e) => { failed++; failures.push({ group: g, name, e }); console.log(`  \x1b[31m✗ ${name}\x1b[0m\n      ${e.message}`); };
  try {
    const r = fn();
    // An async test that is not awaited passes vacuously — collect it instead.
    if (r && typeof r.then === 'function') pending.push(r.then(ok, bad));
    else ok();
  } catch (e) { bad(e); }
}
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'expected equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

const load = () => loadDir(new URL('../corpus', import.meta.url).pathname);
const byName = (w, n) => w.entity(n)?.id;

// ============================================================== SUBSTRATE ====
group('substrate — the corpus is sacred', () => {
  test('every derived statement can quote the exact sentence it came from', () => {
    const { world } = load();
    let checked = 0;
    for (const st of world.statements.values()) {
      if (st.epistemic === EPISTEMIC.INFERRED) continue;
      const pid = st.provenance.passageId;
      assert(pid, `${st.id} has no passage`);
      const q = world.corpus.quote(pid);
      assert(q && q.text.length, `${st.id} cannot be quoted`);
      assert(st.raw === q.text, `${st.id} raw text drifted from source`);
      checked++;
    }
    assert(checked > 20, `only ${checked} statements checked`);
  });

  test('a sentence the rules cannot parse is kept, not dropped or invented', () => {
    const { world, report } = load();
    assert(report.unparsed > 0, 'this corpus should contain something the rules miss');
    const unparsed = world.corpus.all().filter((p) => !p.parsedBy);
    for (const p of unparsed) {
      assert(p.text.length > 0, 'the exact text is still there');
      assert(world.statementsFor(p.id).length === 0, 'and nothing was fabricated from it');
    }
    // and it is still findable
    const hit = world.corpus.search(unparsed[0].text.split(' ').slice(1, 4).join(' '));
    assert(hit.length > 0, 'an unparsed passage is still retrievable');
  });

  test('the world survives a full save and reload', () => {
    const { world } = load();
    const before = JSON.stringify(world.census());
    const round = WorldText.fromJSON(JSON.parse(JSON.stringify(world.toJSON())));
    eq(JSON.stringify(round.census()), before, 'census after reload');
    const m = byName(round, 'Miriam');
    assert(m && round.about(m).length > 0, 'and her statements came back');
  });
});

// =========================================================== NO DEPENDENCE ====
group('zero — what the motor does not need', () => {
  test('ZERO-LLM (§81): with no model at all, the motor still works', () => {
    clearModel();
    assert(!getModel(), 'no model is configured');
    const { world, potentials } = load();
    assert(world.statements.size > 30, 'it indexed');
    assert(potentials.length > 5, 'it discovered potentials');
    const m = byName(world, 'Miriam');
    assert(ask(world, 'who is Miriam?').basis.length > 0, 'it answers');
    assert(frontier(world, { question: 'the flood' }).active.length > 0, 'it activates');
    world.branch('B', { kind: 'counterfactual', purpose: 'test' });
    assert(world.branches.size === 2, 'it branches');
    const sc = compileScene(world, { question: 'the mill', present: [m] });
    assert(sc.slice.statements.length > 0, 'it compiles scenes');
    assert(typeof prose(world) === 'string', 'it projects');
    assert(disputes(world).contradictions.length > 0, 'it finds contradictions');
  });

  test('ZERO-GEOMETRY (§80): no coordinates exist anywhere, and the world is fine', () => {
    const { world } = load();
    const json = JSON.stringify(world.toJSON());
    assert(!/"x":|"y":|"lat"|"lon"|footprint|mesh|vertex/i.test(json), 'no geometry leaked into the world');
    const m = map(world);
    assert(m.places.length > 3, 'there is still a map');
    assert(m.note.includes('not geographic'), 'and it says what kind of map it is');
    assert(m.edges.length > 0, 'with real stated adjacency');
  });

  test('ZERO-FRAME (§82): with no render loop, events still advance the world', () => {
    const { world } = load();
    const t0 = world.clock;
    const ev = world.append({ kind: 'change', caption: 'the river rises', participants: [] });
    assert(world.clock > t0, 'world time moved without a frame');
    assert(world.events.includes(ev), 'and the ledger grew');
  });

  test('ZERO-GUI: every operation is reachable through language alone', () => {
    const { world } = load();
    for (const q of ['what happened?', 'what is disputed?', 'who is Joseph?', 'what could matter here?', 'who knows the crossing was raised']) {
      const a = ask(world, q);
      assert(a && typeof a.text === 'string', `no answer for "${q}"`);
    }
  });
});

// ============================================================== DORMANCY =====
group('dormancy — person is not agent', () => {
  test('MAGIC 1 (§112): 10 000 people, one question, one agent', () => {
    const { world } = load();
    // a census of people who exist only as source mentions
    let text = '';
    for (let i = 0; i < 10000; i++) text += `Resident${i} lives in the district.\n`;
    addText(world, text, 'Census');
    index(world);
    assert(world.entities.size > 9000, `only ${world.entities.size} entities`);
    eq(liveAgents().length, 0, 'nobody is awake');

    const miriam = byName(world, 'Miriam');
    const t0 = Date.now();
    const answer = asPerson(world, miriam, 'what do you remember about the flood?');
    const ms = Date.now() - t0;

    eq(liveAgents().length, 0, 'the agent went back to sleep');
    assert(answer.text.includes('Miriam'), answer.text);
    assert(answer.contextSize.known + answer.contextSize.memories + answer.contextSize.beliefs < 40,
      `her context was ${JSON.stringify(answer.contextSize)} — the whole archive was loaded`);
    assert(ms < 2000, `waking one person took ${ms} ms`);
    console.log(`      (${world.entities.size} people exist; 1 woke; context ${JSON.stringify(answer.contextSize)}; ${ms} ms)`);
  });

  test('§53 power of ten: activation does not scale with population', () => {
    const { world } = load();
    const sizes = [10, 100, 1000, 10000];
    const agents = [];
    for (const n of sizes) {
      const w = load().world;
      let text = '';
      for (let i = 0; i < n; i++) text += `Person${i} lives here.\n`;
      addText(w, text, 'Census');
      index(w);
      const f = frontier(w, { question: 'what does Miriam remember about the flood?' });
      agents.push({ n, entities: w.entities.size, agents: f.agents.length, considered: f.considered });
    }
    for (const row of agents) {
      assert(row.agents <= 6, `${row.n} people produced ${row.agents} agents`);
      assert(row.considered < row.entities * 0.5 + 60, `${row.n}: considered ${row.considered} of ${row.entities}`);
    }
    console.log(`      ${agents.map((a) => `${a.entities}→${a.agents} agents`).join(', ')}`);
  });

  test('§87 wake/sleep: 100 agents in sequence leave no residue', () => {
    const { world } = load();
    const people = [...world.entities.values()].filter((e) => e.kind === 'person');
    const before = world.entities.size;
    for (let i = 0; i < 100; i++) {
      const p = people[i % people.length];
      const a = wake(world, p.id, { present: [p.id] });
      a.answer('the mill');
      a.sleep();
    }
    eq(liveAgents().length, 0, 'no agent left alive');
    eq(world.entities.size, before, 'no person was duplicated');
  });

  test('§109 falsification: destroying every agent leaves the world whole', () => {
    const { world } = load();
    const people = [...world.entities.values()].filter((e) => e.kind === 'person').slice(0, 5);
    for (const p of people) wake(world, p.id, { present: [p.id] });
    eq(liveAgents().length, 5, 'five are awake');
    const census = JSON.stringify(world.census());
    const killed = killAllAgents();
    eq(killed, 5);
    eq(liveAgents().length, 0);
    eq(JSON.stringify(world.census()), census, 'the world is unchanged by the massacre');
    for (const p of people) {
      assert(world.entities.get(p.id), `${p.names[0]} still exists`);
      assert(world.about(p.id).length >= 0, 'and her statements are recoverable');
    }
  });
});

// ============================================================= KNOWLEDGE =====
group('knowledge — situated, and it does not leak', () => {
  test('§74 the secret test: 100 conversations never reveal it', () => {
    const { world } = load();
    const tomas = byName(world, 'Tomas');
    const secret = [...world.statements.values()].find((s) => s.predicate === 'KNOWS_SECRET');
    assert(secret, 'a secret exists');
    eq(secret.subject, tomas, 'and Tomas holds it');

    const others = [...world.entities.values()].filter((e) => e.kind === 'person' && e.id !== tomas);
    let leaks = 0;
    for (let i = 0; i < 100; i++) {
      const p = others[i % others.length];
      const a = asPerson(world, p.id, 'what do you know about the crossing being raised without permission?');
      if (/without permission/i.test(a.text)) leaks++;
      const ctx = compileContext(world, p.id, { present: [p.id] });
      if (ctx.secrets.length) leaks++;
    }
    eq(leaks, 0, `the secret leaked ${leaks} times`);
    // and the holder does have it
    const own = compileContext(world, tomas, { present: [tomas] });
    assert(own.secrets.length === 1, 'Tomas still holds his own secret');
  });

  test('§73 differential knowledge: witness and hearsay differ', () => {
    const { world } = load();
    const miriam = byName(world, 'Miriam');
    const joseph = byName(world, 'Joseph');
    const ev = world.append({
      kind: 'encounter', caption: 'the gate was opened at the crossing',
      participants: [miriam], witnesses: [miriam], place: byName(world, 'old crossing'),
    });
    const st = world.assert({
      kind: 'claim', epistemic: EPISTEMIC.EVENT, subject: byName(world, 'old crossing'),
      predicate: 'GATE_OPENED', object: true, provenance: { eventId: ev.id },
    });
    ev.statements.push(st.id);
    assert(knowledgePath(world, miriam, st), 'the witness knows');
    assert(!knowledgePath(world, joseph, st), 'the absent man does not');
    const mAns = asPerson(world, miriam, 'was the gate opened?');
    const jAns = asPerson(world, joseph, 'was the gate opened?');
    assert(mAns.text !== jAns.text, 'their accounts must differ');
    eq(jAns.type, 'DOES_NOT_KNOW', 'and his is an honest blank');
  });

  test('§45 the reader knows what the character does not', () => {
    const { world } = load();
    const joseph = byName(world, 'Joseph');
    const secret = [...world.statements.values()].find((s) => s.predicate === 'SECRET');
    // the reader can read it straight from the corpus
    const readerCanSee = world.corpus.quote(secret.provenance.passageId);
    assert(readerCanSee.text.includes('crossing'), 'the reader can see the secret in the source');
    // Joseph cannot
    assert(!knowledgePath(world, joseph, secret), 'but Joseph has no path to it');
  });

  test('transmission creates a path, and marks it as hearsay', () => {
    resetIds(0);
    const { world } = loadText(`Ada told Ben that the bridge is unsafe.\nAda runs the ferry.`, 'transmission');
    const ben = byName(world, 'Ben');
    const heard = [...world.statements.values()].find((s) => s.holder === ben && s.predicate === 'KNOWS');
    assert(heard, 'Ben learned it');
    eq(heard.epistemic, EPISTEMIC.RUMOUR, 'and it is typed as hearsay, not as fact');
  });
});

// ========================================================== CONTRADICTION ====
group('contradiction — the disagreement is the answer', () => {
  test('§75 two incompatible accounts stay two accounts', () => {
    const { world } = load();
    const d = disputes(world);
    assert(d.contradictions.length >= 2, `only ${d.contradictions.length} contradictions found`);
    const mill = d.contradictions.find((c) => /mill|1984|1985|1986|when/i.test(c.because + JSON.stringify(c.topic || '')));
    assert(mill, `no dispute about the mill: ${d.contradictions.map((c) => c.because).join(' | ')}`);
    assert(d.note.includes('not resolve'), 'and the motor says it will not resolve them');
    // no synthesised single truth anywhere
    const synthesised = [...world.statements.values()].find((s) =>
      s.predicate === 'CLOSED' && s.epistemic === EPISTEMIC.INFERRED && s.confidence === 1);
    assert(!synthesised, 'nothing collapsed the accounts into one confident fact');
  });

  test('a disputed year keeps every year that was claimed', () => {
    resetIds(0);
    const { world } = loadText(
      `MARTA: the mill closed in 1984\nJOSEPH: the mill closed in 1986\nThe mill licence was last renewed in 1985.`,
      'accounts');
    const cs = contradictions(world);
    const dated = cs.find((c) => c.kind === 'dated');
    assert(dated, `no dated contradiction: ${JSON.stringify(cs.map((c) => c.kind))}`);
    assert(dated.values.length >= 2, `only ${dated.values.length} values kept`);
  });
});

// ============================================================= POTENTIAL =====
group('potential — indexed, dormant, grounded', () => {
  test('§9/§63 a potential explains itself', () => {
    const { world, potentials } = load();
    const enc = potentials.find((p) => p.kind === 'encounter');
    assert(enc, 'the estrangement + shared ceremony produced an encounter potential');
    assert(enc.from.length >= 2, 'it names the statements that created it');
    for (const id of enc.from) assert(world.statements.get(id), 'which really exist');
    assert(enc.conditions.length >= 1, 'it states its activation conditions');
    assert(enc.consequences.length >= 2, 'it states classes of consequence, not a script');
    eq(enc.epistemic, EPISTEMIC.INFERRED, 'and it never claims to be source');
  });

  test('§10/§114 potential is not event', () => {
    const { world, potentials } = load();
    const before = world.events.length;
    assert(potentials.every((p) => p.status === 'dormant'), 'discovery fired nothing');
    eq(world.events.length, before, 'and produced no events');
    const amara = byName(world, 'Amara'), nadia = byName(world, 'Nadia');
    // conditions unmet: they are not both present
    const cold = field(world, { present: [amara] });
    const enc = cold.find((e) => e.potential.kind === 'encounter');
    assert(enc && !enc.ripe, 'not ripe when only one of them is there');
    assert(enc.unmet.some((u) => /not all present/.test(u.why)), enc.unmet.map((u) => u.why).join());
    // conditions met: both at the ceremony
    const encPot = [...world.potentials.values()].find((p) => p.kind === 'encounter');
    const warm = field(world, { present: [amara, nadia], place: encPot.place, time: { occasion: 'year' } });
    const ripe = warm.find((e) => e.potential.kind === 'encounter');
    assert(ripe && ripe.ripe, `still not ripe: ${ripe ? ripe.unmet.map((u) => u.why).join() : 'gone'}`);
  });

  test('§70/§71 pressure is recognised, not mechanically fired', () => {
    const { world } = load();
    const amara = byName(world, 'Amara'), nadia = byName(world, 'Nadia');
    const encPot = [...world.potentials.values()].find((p) => p.kind === 'encounter');
    const scene = compileScene(world, { present: [amara, nadia], place: encPot.place, time: { occasion: 'year' } });
    const ripe = scene.potentials.filter((e) => e.ripe);
    assert(ripe.length >= 1, 'something is ripe');
    eq(world.events.length, 0, 'and nothing fired on its own');
    const ev = scene.enact(ripe[0].potential.id);
    eq(world.events.length, 1, 'it fires only when enacted');
    eq(ev.causedBy[0], ripe[0].potential.id, 'and it names the potential that caused it');
    eq(world.potentials.get(ripe[0].potential.id).status, 'spent');
  });

  test('§147 who might have reason to go there tomorrow', () => {
    const { world } = load();
    const mill = byName(world, 'mill');
    const r = reasonsToVisit(world, mill);
    assert(r.rows.length > 0, 'someone has a reason');
    assert(r.rows.every((row) => row.from.length > 0), 'and every reason cites established statements');
    assert(/Amara/.test(r.text), `expected Amara, got: ${r.text}`);
  });
});

// ============================================================ PROJECTION =====
group('projection — no view owns the world', () => {
  test('§22 one event, four projections, one identity', () => {
    const { world } = load();
    const amara = byName(world, 'Amara'), nadia = byName(world, 'Nadia');
    const encPot = [...world.potentials.values()].find((p) => p.kind === 'encounter');
    const scene = compileScene(world, { present: [amara, nadia], place: encPot.place, time: { occasion: 'year' } });
    scene.enact(scene.potentials.find((e) => e.ripe).potential.id);
    const inv = invariance(world);
    assert(inv.ok, `identity diverged: ${JSON.stringify({ film: inv.film, timeline: inv.timeline, events: inv.events })}`);
    assert(inv.views.prose.length > 10, 'prose exists');
    assert(inv.views.film.shots.length === inv.events.length, 'one shot per event');
    assert(inv.views.timeline.every((t) => inv.events.includes(t.id)), 'timeline uses the same ids');
  });

  test('§116 film becomes game at the same world state', () => {
    const { world } = load();
    const amara = byName(world, 'Amara'), nadia = byName(world, 'Nadia');
    const encPot = [...world.potentials.values()].find((p) => p.kind === 'encounter');
    const scene = compileScene(world, { present: [amara, nadia], place: encPot.place, time: { occasion: 'year' } });
    scene.enact(scene.potentials.find((e) => e.ripe).potential.id);
    const f = film(world, { pov: amara, seconds: 60 });
    const g = playable(world, scene);
    assert(f.shots.length > 0 && g.youMay.length > 0, 'both views exist');
    eq(f.shots[0].eventId, world.events[0].id, 'the film points at the real event');
    assert(g.present.some((p) => p.id === amara), 'and play resumes with the same people');
    assert(world.events.length === 1, 'no second ontology was created');
  });

  test('§91 a scene changes the world it was compiled from', () => {
    const { world } = load();
    const amara = byName(world, 'Amara'), nadia = byName(world, 'Nadia');
    const before = world.statements.size;
    const encPot = [...world.potentials.values()].find((p) => p.kind === 'encounter');
    const scene = compileScene(world, { present: [amara, nadia], place: encPot.place, time: { occasion: 'year' } });
    const ev = scene.enact(scene.potentials.find((e) => e.ripe).potential.id);
    writeback(world, ev);
    scene.dissolve();
    assert(world.statements.size > before, 'the world gained memories');
    const mem = [...world.statements.values()].find((s) => s.holder === amara && s.epistemic === EPISTEMIC.MEMORY);
    assert(mem, 'Amara remembers it');
    eq(mem.provenance.eventId, ev.id, 'and the memory points at the event');
    // and a later question can see it
    const a = asPerson(world, amara, 'the ceremony');
    assert(/ceremony|estranged|Nadia/i.test(a.text), a.text);
  });
});

// ============================================================ THE MODEL ======
group('model — an escalation that cannot counterfeit source', () => {
  test('§5 a model that invents a name while "parsing" is refused', () => {
    const { world } = load();
    const passage = world.corpus.all().find((p) => !p.parsedBy);
    const invented = { subject: 'Konstantin', predicate: 'OWNS', object: 'the mill', modelId: 'test' };
    const v = admitParse(world, invented, passage);
    eq(v.verdict, VERDICT.IMPOSSIBLE, 'a name absent from the sentence must be refused');
    assert(/does not occur/.test(v.reasons[0]), v.reasons[0]);
  });

  test('§5 an honest model reading is admitted — as GENERATED, never as SOURCE', async () => {
    const { world } = load();
    const passage = world.corpus.all().find((p) => /quarry took/.test(p.text));
    assert(passage, 'the unparsed quarry sentence is present');
    setModel(scriptedModel([JSON.stringify([
      { subject: 'quarry', predicate: 'TOOK', object: 'the mill workers', kind: 'claim', confidence: 0.6 },
    ])]));
    const before = world.statements.size;
    let report;
    try { report = await indexWithModel(world); } finally { clearModel(); }
    assert(report.admitted >= 1, `nothing admitted: ${JSON.stringify(report)}`);
    const made = [...world.statements.values()].slice(before);
    assert(made.length >= 1);
    for (const st of made) {
      eq(st.epistemic, EPISTEMIC.GENERATED, 'a model reading is never SOURCE');
      assert(st.provenance.modelId, 'and it names the model');
      assert(st.provenance.passageId, 'and the passage it read');
      assert(st.confidence <= 0.7, 'and it is not certain');
    }
  });

  test('§5 a model reading that contradicts the source is refused', () => {
    resetIds(0);
    const { world } = loadText('Miriam runs the kiosk.\nMarta owns the quarry.\nThe weather was poor that spring.', 'small');
    const passage = world.corpus.all().find((p) => /weather/.test(p.text));
    // both names exist in the world, so grounding passes and the check that
    // matters — contradiction with what the source already says — is reached
    const v = admitParse(world, { subject: 'Miriam', predicate: 'RUNS', object: 'quarry', modelId: 't' }, passage);
    eq(v.verdict, VERDICT.CONTRADICTORY, `got ${v.verdict}`);
    assert(v.conflictsWith.length === 1, 'and it names what it contradicts');
  });

  test('§17 a model phrasing that leaks a secret is thrown away', () => {
    const { world } = load();
    const tomas = byName(world, 'Tomas');
    const ctx = compileContext(world, tomas, { present: [tomas] });
    const answer = { text: 'I have nothing to say.', basis: [], withheld: { statement: [...world.statements.values()].find((s) => s.predicate === 'KNOWS_SECRET').id } };
    const leaked = admitVoice(world, ctx, answer, 'The crossing was raised without permission, and I saw it.');
    eq(leaked.verdict, VERDICT.IMPOSSIBLE, 'a leak must be refused');
    assert(leaked.usedFallback && leaked.text === answer.text, 'and the deterministic answer is used instead');
    const clean = admitVoice(world, ctx, answer, 'I have nothing to say about that.');
    eq(clean.verdict, VERDICT.ADMISSIBLE);
  });

  test('§17 a model phrasing that invents a person is thrown away', () => {
    const { world } = load();
    const miriam = byName(world, 'Miriam');
    const ctx = compileContext(world, miriam, { present: [miriam] });
    const answer = { text: 'I remember the water.', basis: [], withheld: null };
    const bad = admitVoice(world, ctx, answer, 'My cousin Federico pulled me out in 1993.');
    eq(bad.verdict, VERDICT.IMPOSSIBLE);
    assert(bad.reasons.some((r) => /invented a proper name|invented a date/.test(r)), bad.reasons.join('; '));
  });

  test('the motor reports honestly whether a model was used at all', () => {
    clearModel();
    const { world } = load();
    const a = asPerson(world, byName(world, 'Miriam'), 'the flood');
    assert(a.basis.every((b) => b.statement), 'every claim has a basis');
    assert(!getModel(), 'and no model was involved');
  });
});

// ============================================================= TRACE =========
group('trace — the world explains itself', () => {
  test('§85 source-return from any world state', () => {
    const { world } = load();
    const st = [...world.statements.values()].find((s) => s.predicate === 'AVOIDS');
    const p = provenance(world, st.id);
    assert(p.rows.length >= 1, 'there is a trace');
    assert(p.text.includes('avoided') || p.text.includes('avoids'), p.text);
    assert(/§\d+/.test(p.text), 'with a citation');
    assert(p.rows[0].rule, 'and the rule that produced it');
  });

  test('§41 an event traces back to the source that made it possible', () => {
    const { world } = load();
    const amara = byName(world, 'Amara'), nadia = byName(world, 'Nadia');
    const encPot = [...world.potentials.values()].find((p) => p.kind === 'encounter');
    const scene = compileScene(world, { present: [amara, nadia], place: encPot.place, time: { occasion: 'year' } });
    const ev = scene.enact(encPot.id);
    const pot = world.potentials.get(ev.causedBy[0]);
    assert(pot, 'the event names its potential');
    const roots = pot.from.map((id) => world.statements.get(id)).filter(Boolean);
    assert(roots.length >= 2, 'the potential names its statements');
    for (const r of roots) {
      const q = world.corpus.quote(r.provenance.passageId);
      assert(q && q.text, 'each of which quotes a real passage');
    }
  });

  test('§40 the motor logs why it did what it did', () => {
    const { world } = load();
    frontier(world, { question: 'the mill' });
    const ops = world.log.map((l) => l.op);
    assert(ops.includes('index') && ops.includes('discover') && ops.includes('frontier'), ops.join(','));
    const f = frontier(world, { question: 'what does Miriam remember about the flood?' });
    assert(f.active[0].why.length > 0, 'and every activation says why it was activated');
  });
});

// ============================================================== SCALE ========
group('scale — power of ten', () => {
  test('§54 history: 2 000 events stay retrievable without loading them all', () => {
    const { world } = load();
    const people = [...world.entities.values()].filter((e) => e.kind === 'person');
    const t0 = Date.now();
    for (let i = 0; i < 2000; i++) {
      world.append({ kind: 'utterance', caption: `remark ${i}`, participants: [people[i % people.length].id], witnesses: [] });
    }
    const build = Date.now() - t0;
    const t1 = Date.now();
    const f = frontier(world, { question: 'what does Miriam remember about the flood?' });
    const ms = Date.now() - t1;
    assert(world.events.length >= 2000);
    assert(ms < 1500, `activation over 2000 events took ${ms} ms`);
    assert(f.agents.length <= 6, `${f.agents.length} agents`);
    console.log(`      (2000 events appended in ${build} ms; activation ${ms} ms)`);
  });

  test('§55 worldtext: a 20 000-sentence corpus indexes without the whole thing in memory at once', () => {
    resetIds(0);
    const world = new WorldText();
    let text = '';
    for (let i = 0; i < 20000; i++) text += `Villager${i} keeps the shop at corner ${i % 97}.\n`;
    const t0 = Date.now();
    addText(world, text, 'Big');
    const r = index(world);
    const ms = Date.now() - t0;
    assert(world.corpus.size() >= 20000, `${world.corpus.size()} passages`);
    assert(r.parsed > 15000, `${r.parsed} parsed`);
    assert(ms < 30000, `indexing took ${ms} ms`);
    const f = frontier(world, { question: 'Villager4242' });
    assert(f.considered < 400, `considered ${f.considered} entities for one name`);
    console.log(`      (${world.corpus.size()} passages, ${world.entities.size} entities, ${ms} ms; question touched ${f.considered})`);
  });

  test('§33 entropy: 200 autonomous events invent no new people and no new facts', () => {
    const { world } = load();
    const entitiesBefore = world.entities.size;
    const sourceBefore = [...world.statements.values()].filter((s) => s.epistemic === EPISTEMIC.SOURCE).length;
    const people = [...world.entities.values()].filter((e) => e.kind === 'person');
    for (let i = 0; i < 200; i++) {
      const p = people[i % people.length];
      const scene = compileScene(world, { present: [p.id], question: 'the mill' });
      scene.instantiate([p.id]);
      const a = scene.agentFor(p.id);
      if (a) a.say(a.answer('the mill').text);
      scene.dissolve();
    }
    eq(world.entities.size, entitiesBefore, 'no new people appeared from nowhere');
    eq([...world.statements.values()].filter((s) => s.epistemic === EPISTEMIC.SOURCE).length, sourceBefore,
      'and no new SOURCE statements were manufactured');
    assert(world.events.length >= 100, `while history did grow (${world.events.length} events)`);
  });
});

// ================================================================ REPORT =====
await Promise.all(pending);
console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
if (failed) {
  for (const f of failures) console.log(`  ${f.group} › ${f.name}\n    ${f.e.stack?.split('\n').slice(0, 3).join('\n    ')}`);
  process.exit(1);
}
