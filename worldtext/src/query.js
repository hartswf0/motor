// LANGUAGE IS THE UNIVERSAL INSPECTOR — and the debugger (§39–41, §85).
//
// The world explains itself in the same language it was made of. Every answer
// here carries its basis: the passages, statements, events and rules it came
// from. Nothing is generated; everything is retrieved, resolved and cited.

import { EPISTEMIC } from './worldtext.js';
import { contradictions, field } from './potential.js';
import { frontier } from './activate.js';
import { compileScene } from './scene.js';
import { wake, knowledgePath } from './agent.js';
import { prose, timeline, map as mapView } from './project.js';

const nameOf = (w, id) => w.entities.get(id)?.names[0] || id;

export function ask(world, question, opts = {}) {
  const q = String(question).trim();
  const lower = q.toLowerCase();
  const branch = opts.branch || 'CANON';
  const named = namesIn(world, q);

  // — where did this come from? (the source-return test) ---------------------
  if (/^(why is (this|that)|where did (this|that) come from|show me the source|why do you (think|say|believe))/.test(lower)) {
    return provenance(world, opts.subject || named[0], { branch });
  }
  // — what is disputed? -----------------------------------------------------
  if (/(disputed|disagree|contradict|conflicting)/.test(lower)) {
    return disputes(world, { branch, about: named[0] });
  }
  // — what happened? --------------------------------------------------------
  if (/^what (has )?happened/.test(lower) || /^what changed/.test(lower)) {
    return {
      kind: 'history',
      text: prose(world, { branch }),
      timeline: timeline(world, { branch }),
      basis: world.eventsIn(branch).map((e) => e.id),
    };
  }
  // — who might have reason to…? --------------------------------------------
  if (/(who might|who would have reason|who could have reason|anyone with reason)/.test(lower)) {
    return reasonsToVisit(world, named.find((id) => world.entities.get(id)?.kind === 'place') || null, { branch, question: q });
  }
  // — what could matter? ----------------------------------------------------
  if (/(what could (matter|happen)|what might (matter|happen)|what is latent|possibilities)/.test(lower)) {
    const situation = { branch, question: q, place: named.find((id) => world.entities.get(id)?.kind === 'place') || null, present: named.filter((id) => world.entities.get(id)?.kind === 'person') };
    const f = field(world, situation, { branch, limit: 8 });
    return {
      kind: 'field',
      text: f.length ? f.map((e) => `· ${e.potential.because}${e.ripe ? '  [ripe]' : `  [waiting: ${e.unmet.map((u) => u.why).join(', ')}]`}`).join('\n') : 'Nothing is pressing here.',
      potentials: f,
      basis: f.flatMap((e) => e.potential.from),
    };
  }
  // — who knows X? ----------------------------------------------------------
  if (/^who knows/.test(lower)) {
    return whoKnows(world, q.replace(/^who knows\s*/i, ''), { branch });
  }
  // — what does N remember / think / know about …? --------------------------
  const person = named.find((id) => world.entities.get(id)?.kind === 'person');
  if (person && /(remember|think|know|say|believe|feel)/.test(lower)) {
    return asPerson(world, person, q, { branch, ...opts });
  }
  // — who/what is N? --------------------------------------------------------
  if (person || named.length) {
    return dossier(world, named[0], { branch });
  }
  // — fall back to the corpus itself, exactly quoted -------------------------
  const hits = world.corpus.search(q, 6);
  return {
    kind: 'passages',
    text: hits.length ? hits.map((h) => `“${h.passage.text}”  — ${world.corpus.quote(h.passage.id).citation}`).join('\n') : 'The corpus does not speak of that.',
    basis: hits.map((h) => h.passage.id),
  };
}

// ------------------------------------------------------------------ pieces --
export function dossier(world, entityId, { branch = 'CANON' } = {}) {
  const e = world.entities.get(entityId);
  if (!e) return { kind: 'none', text: 'No such person or place is named in the corpus.', basis: [] };
  const sts = world.about(entityId, { branch });
  const lines = [`${e.names[0]} — ${e.kind}, named in ${e.mentions.length} passage${e.mentions.length === 1 ? '' : 's'}.`];
  for (const st of sts.slice(0, 10)) {
    lines.push(`  ${st.epistemic === EPISTEMIC.SOURCE ? '·' : '~'} ${describe(world, st)}`);
  }
  const quotes = e.mentions.slice(0, 3).map((p) => world.corpus.quote(p));
  return {
    kind: 'dossier', entity: e,
    text: lines.join('\n'),
    quotes,
    basis: sts.map((s) => s.id),
  };
}

export function describe(world, st) {
  const obj = typeof st.object === 'string' && world.entities.has(st.object) ? nameOf(world, st.object) : st.object;
  const holder = st.holder ? `${nameOf(world, st.holder)}: ` : '';
  const time = st.time?.raw ? ` (${st.time.raw})` : '';
  return `${holder}${nameOf(world, st.subject)} ${st.predicate.toLowerCase().replace(/_/g, ' ')} ${obj}${time} [${st.epistemic}]`;
}

/**
 * THE SOURCE-RETURN TEST (§85). From any world state, recover the language it
 * came from — passage, rule, derivation, event, model.
 */
export function provenance(world, target, { branch = 'CANON' } = {}) {
  const st = world.statements.get(target);
  const entity = world.entities.get(target);
  const rows = [];

  const trace = (statement, depth = 0) => {
    if (!statement || depth > 4) return;
    const p = statement.provenance;
    const row = { depth, statement: statement.id, said: describe(world, statement), epistemic: statement.epistemic, rule: p.rule };
    if (p.passageId) {
      row.source = world.corpus.quote(p.passageId);
    }
    if (p.eventId) {
      const ev = world.events.find((e) => e.id === p.eventId);
      row.event = ev ? { id: ev.id, caption: ev.caption, time: ev.time, branch: ev.branch, causedBy: ev.causedBy } : p.eventId;
    }
    if (p.modelId) row.model = p.modelId;
    rows.push(row);
    for (const d of p.derivedFrom || []) trace(world.statements.get(d), depth + 1);
  };

  if (st) trace(st);
  else if (entity) {
    for (const s of world.about(target, { branch }).slice(0, 6)) trace(s);
    for (const m of entity.mentions.slice(0, 4)) rows.push({ depth: 0, mention: true, source: world.corpus.quote(m) });
  } else {
    return { kind: 'provenance', text: 'Nothing to trace.', rows: [], basis: [] };
  }

  const text = rows.map((r) => {
    const indent = '  '.repeat(r.depth);
    if (r.mention) return `${indent}“${r.source.text}”  — ${r.source.citation}`;
    const bits = [`${indent}${r.said}`];
    if (r.rule) bits.push(`${indent}  by rule: ${r.rule}`);
    if (r.source) bits.push(`${indent}  from: “${r.source.text}”  — ${r.source.citation}${r.source.speaker ? ` (spoken by ${r.source.speaker})` : ''}`);
    if (r.event) bits.push(`${indent}  from event ${r.event.id}: ${r.event.caption}`);
    if (r.model) bits.push(`${indent}  from model: ${r.model}`);
    return bits.join('\n');
  }).join('\n');

  return { kind: 'provenance', text, rows, basis: rows.map((r) => r.statement).filter(Boolean) };
}

export function disputes(world, { branch = 'CANON', about = null } = {}) {
  const all = contradictions(world, branch);
  const list = about ? all.filter((c) => c.subject === about || c.holders.includes(about) || String(c.topic).includes(String(about))) : all;
  const lines = [];
  for (const c of list) {
    lines.push(`— ${c.because}`);
    for (const sid of c.statements) {
      const st = world.statements.get(sid);
      if (!st) continue;
      const src = st.provenance.passageId ? world.corpus.quote(st.provenance.passageId) : null;
      lines.push(`    ${st.holder ? nameOf(world, st.holder) : 'the record'}: “${src ? src.text : st.raw}”${src ? `  — ${src.citation}` : ''}`);
    }
  }
  return {
    kind: 'dispute',
    text: lines.length ? lines.join('\n') : 'Nothing here is disputed.',
    contradictions: list,
    basis: list.flatMap((c) => c.statements),
    note: 'The motor does not resolve these. Both accounts remain.',
  };
}

export function whoKnows(world, topic, { branch = 'CANON' } = {}) {
  const t = String(topic).toLowerCase().replace(/[?.]$/, '').trim();
  const rows = [];
  for (const st of world.statements.values()) {
    if (!world.chain(branch).includes(st.branch)) continue;
    const hay = `${st.object} ${st.raw || ''}`.toLowerCase();
    if (!hay.includes(t.split(/\s+/).filter((w) => w.length > 3)[0] || t)) continue;
    for (const person of world.entities.values()) {
      if (person.kind !== 'person') continue;
      const path = knowledgePath(world, person.id, st);
      if (!path) continue;
      rows.push({ person: person.names[0], personId: person.id, path: path.path, as: path.epistemic, statement: st.id });
    }
  }
  const uniq = new Map();
  for (const r of rows) if (!uniq.has(r.personId)) uniq.set(r.personId, r);
  return {
    kind: 'knows',
    text: uniq.size
      ? [...uniq.values()].map((r) => `${r.person} — ${r.path} (${r.as})`).join('\n')
      : 'Nobody in this world has a path to that.',
    rows: [...uniq.values()],
    basis: [...uniq.values()].map((r) => r.statement),
  };
}

/** Wake one person, ask, write nothing, let them sleep. §112. */
export function asPerson(world, personId, question, opts = {}) {
  const situation = { branch: opts.branch || 'CANON', place: opts.place || null, present: opts.present || [personId], question };
  const agent = wake(world, personId, situation);
  const answer = agent.answer(question);
  const context = agent.context;
  const summary = {
    kind: 'testimony',
    person: nameOf(world, personId),
    type: answer.type,
    text: `${nameOf(world, personId)}: ${answer.text}`,
    withheld: answer.withheld,
    basis: answer.basis,
    contextSize: { known: context.known.length, memories: context.memories.length, beliefs: context.beliefs.length, omitted: context.boundary.omitted.length },
  };
  agent.sleep();
  return summary;
}

/**
 * "Who might have reason to visit the abandoned station tomorrow?" (§147)
 * Answered from obligation, memory, schedule, avoidance and unfinished relation
 * — not from a generative guess.
 */
export function reasonsToVisit(world, placeId, { branch = 'CANON', question = '' } = {}) {
  const rows = [];
  const place = placeId ? world.entities.get(placeId) : null;
  for (const p of world.potentials.values()) {
    if (!world.chain(branch).includes(p.branch) || p.status === 'spent') continue;
    if (placeId && p.place !== placeId) continue;
    for (const who of p.participants) {
      const e = world.entities.get(who);
      if (!e || e.kind !== 'person') continue;
      rows.push({ person: e.names[0], personId: who, reason: p.because, potential: p.id, kind: p.kind, pressure: p.pressure, from: p.from });
    }
  }
  // people whose established routine already brings them there
  for (const st of world.statements.values()) {
    if (st.kind !== 'schedule' || st.object !== placeId) continue;
    const e = world.entities.get(st.subject);
    if (!e) continue;
    rows.push({ person: e.names[0], personId: st.subject, reason: `${e.names[0]} comes here ${st.time?.raw || 'regularly'}.`, kind: 'routine', pressure: 0.2, from: [st.id] });
  }
  rows.sort((a, b) => b.pressure - a.pressure);
  return {
    kind: 'reasons',
    place: place ? place.names[0] : null,
    text: rows.length
      ? rows.map((r) => `${r.person} — ${r.reason}  [${r.kind}]`).join('\n')
      : `Nothing established gives anyone a reason to go${place ? ` to the ${place.names[0]}` : ''}.`,
    rows,
    basis: rows.flatMap((r) => r.from),
  };
}

export function namesIn(world, text) {
  const t = String(text).toLowerCase();
  const out = [];
  for (const [key, id] of world.byName) {
    if (key.length < 3) continue;
    const re = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (re.test(t)) out.push(id);
  }
  // longest names first: "old crossing" should beat "crossing"
  return out.sort((a, b) => (nameOf(world, b).length - nameOf(world, a).length));
}

export { compileScene, frontier, mapView };
