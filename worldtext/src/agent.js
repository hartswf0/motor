// AGENT IS A PROCESS, NOT A PERSON (§15).
//
// A person persists in WorldText. An agent is a temporary process that wakes
// around a person, receives a *situated* projection of the shared world, acts,
// writes back, and is destroyed. Destroying every agent must leave every person,
// history and relationship intact — that is the invariant this file exists to
// keep, and `tests/run.js` checks it by killing them all.

import { EPISTEMIC } from './worldtext.js';
import { escalateVoice, getModel } from './model.js';
import { admitVoice } from './continuity.js';

/** Predicates that the district as a whole can be expected to know. */
const PUBLIC = new Set(['SPATIAL', 'RUNS', 'OWNS', 'WORKS_AT', 'IS', 'CLOSED', 'OPENED', 'BUILT', 'ATTENDS', 'REBUILT', 'WIDENED']);
/** Predicates that are the private business of the people they name. */
const PRIVATE = new Set(['KNOWS_SECRET', 'SECRET', 'REMEMBERS', 'BELIEVES', 'STATES', 'FEARS', 'WANTS', 'REFUSES']);
/** Predicates known to the parties they relate, and not automatically beyond them. */
const RELATIONAL = new Set(['ESTRANGED_FROM', 'AVOIDS', 'PROMISED', 'TOLD']);

/**
 * KNOWLEDGE BOUNDARY (§17). Can this person know this statement, and by what
 * path? Returns null when there is no path — the caller must then refuse, guess
 * or lie, and say which.
 */
export function knowledgePath(world, personId, statement) {
  const st = typeof statement === 'string' ? world.statements.get(statement) : statement;
  if (!st) return null;

  if (st.holder === personId) return { path: 'own', epistemic: st.epistemic };
  if (st.epistemic === EPISTEMIC.BELIEF || st.epistemic === EPISTEMIC.MEMORY) {
    return null;                                  // another person's interior is not public
  }
  if (PRIVATE.has(st.predicate)) {
    if (st.subject === personId) return { path: 'own', epistemic: st.epistemic };
    if (st.tags?.includes(personId)) return { path: 'own', epistemic: st.epistemic };
    // Was it transmitted?
    const told = [...world.statements.values()].find((t) =>
      t.predicate === 'KNOWS' && t.holder === personId && sameContent(t.object, st.object));
    if (told) return { path: 'told', epistemic: EPISTEMIC.RUMOUR, via: told.id };
    return null;
  }
  if (RELATIONAL.has(st.predicate)) {
    if (st.subject === personId || st.object === personId) return { path: 'party', epistemic: st.epistemic };
    return null;
  }
  if (PUBLIC.has(st.predicate)) return { path: 'common', epistemic: st.epistemic };

  // Witnessed events are known to their witnesses, and to nobody else by default.
  if (st.provenance.eventId) {
    const ev = world.events.find((e) => e.id === st.provenance.eventId);
    if (ev && (ev.witnesses.includes(personId) || ev.participants.includes(personId))) {
      return { path: 'witnessed', epistemic: EPISTEMIC.MEMORY, via: ev.id };
    }
    return null;
  }
  // Anything else stated by the source about this person, they know about themselves.
  if (st.subject === personId) return { path: 'own', epistemic: st.epistemic };
  return null;
}

const sameContent = (a, b) => String(a).toLowerCase().trim() === String(b).toLowerCase().trim();

/**
 * THE CONTEXT COMPILER (§139). A deliberately compiled, bounded, auditable
 * projection of the shared world for one person — never a dump of retrieval
 * chunks, and never the whole world.
 */
export function compileContext(world, personId, situation = {}) {
  const person = world.entities.get(personId);
  if (!person) throw new Error(`no such person: ${personId}`);
  const branch = situation.branch || 'CANON';

  const known = [];
  const beliefs = [];
  const memories = [];
  const secrets = [];
  const omitted = [];

  for (const st of world.about(personId, { branch })) {
    const path = knowledgePath(world, personId, st);
    if (!path) { omitted.push({ id: st.id, why: 'no knowledge path' }); continue; }
    const row = { statement: st, path: path.path, as: path.epistemic };
    if (st.predicate === 'KNOWS_SECRET') secrets.push(row);
    else if (st.epistemic === EPISTEMIC.MEMORY) memories.push(row);
    else if (st.epistemic === EPISTEMIC.BELIEF) beliefs.push(row);
    else known.push(row);
  }

  // What they know about the others who are here — bounded to the situation.
  for (const other of situation.present || []) {
    if (other === personId) continue;
    for (const st of world.about(other, { branch })) {
      const path = knowledgePath(world, personId, st);
      if (!path) { omitted.push({ id: st.id, why: `private to ${other}` }); continue; }
      known.push({ statement: st, path: path.path, as: path.epistemic });
    }
  }

  const uncertainties = [];
  for (const p of world.potentials.values()) {
    if (p.kind !== 'dispute') continue;
    if (!p.participants.includes(personId)) continue;
    uncertainties.push({ potential: p.id, because: p.because });
  }

  return {
    task: situation.task || 'answer',
    person: { id: personId, name: person.names[0] },
    situation: { place: situation.place || null, present: situation.present || [], time: situation.time || null, occasion: situation.occasion || null },
    known, beliefs, memories, secrets, uncertainties,
    boundary: { omitted, rule: 'a person may state only what a path lets them know' },
    allowedOperations: ['answer', 'refuse', 'guess', 'lie', 'ask'],
    provenanceHooks: known.concat(beliefs, memories).map((r) => r.statement.provenance.passageId).filter(Boolean),
  };
}

let live = new Set();

/**
 * Wake an agent around a person. The process holds no world state of its own —
 * only a compiled projection — so destroying it cannot damage the world (§16).
 */
export function wake(world, personId, situation = {}) {
  const context = compileContext(world, personId, situation);
  const agent = {
    id: `agent_${personId}_${world.clock}`,
    personId,
    context,
    alive: true,

    /** Answer from situated knowledge, and type the answer honestly (§18). */
    answer(question) {
      if (!agent.alive) throw new Error('agent is asleep');
      return answerFrom(world, context, question);
    },

    /**
     * The same answer, phrased by a model if one is configured. The motor still
     * chooses the content; the model only chooses the words, and the words are
     * re-checked against the knowledge boundary before they can be said.
     */
    async answerVoiced(question) {
      const answer = agent.answer(question);
      if (!getModel()) return { ...answer, phrased: false };
      const { text, phrased, modelId } = await escalateVoice(world, context, answer, question);
      if (!phrased) return { ...answer, phrased: false };
      const check = admitVoice(world, context, answer, text);
      return {
        ...answer,
        text: check.text,
        phrased: !check.usedFallback,
        modelId,
        refusedPhrasing: check.usedFallback ? check.reasons : null,
      };
    },

    /** Everything the agent says enters the world as an event with provenance. */
    say(text, { kind = 'utterance', epistemic = EPISTEMIC.EVENT, about = [] } = {}) {
      const ev = world.append({
        kind, place: situation.place || null,
        participants: [personId, ...(situation.present || []).filter((p) => p !== personId)],
        witnesses: situation.present || [personId],
        branch: situation.branch || 'CANON',
        caption: `${context.person.name}: ${text}`,
        provenance: { agent: agent.id, personId },
      });
      const st = world.assert({
        kind: 'claim', epistemic, holder: personId, subject: personId,
        predicate: 'SAID', object: text, branch: situation.branch || 'CANON',
        provenance: { eventId: ev.id, derivedFrom: about },
      });
      ev.statements.push(st.id);
      return { event: ev, statement: st };
    },

    sleep() {
      agent.alive = false;
      agent.context = null;              // the projection is temporary; the person is not
      live.delete(agent);
      return { slept: personId };
    },
  };
  live.add(agent);
  world.note('wake', { personId, known: context.known.length, omitted: context.boundary.omitted.length });
  return agent;
}

export function liveAgents() { return [...live]; }
export function killAllAgents() {
  const n = live.size;
  for (const a of [...live]) a.sleep();
  live = new Set();
  return n;
}

/**
 * Deterministic answering from a situated context. There is no language model in
 * this build; the answer is assembled from what this person is entitled to know,
 * and its epistemic type is stated rather than smoothed away.
 */
function answerFrom(world, context, question) {
  const q = String(question).toLowerCase();
  const nameOf = (id) => world.entities.get(id)?.names[0] || id;
  const terms = (q.match(/[\p{L}\p{N}']+/gu) || []).filter((w) => w.length > 3);
  const scoreRow = (r) => {
    const hay = `${r.statement.predicate} ${r.statement.object} ${r.statement.raw || ''}`.toLowerCase();
    return terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
  };

  const pool = [...context.memories, ...context.beliefs, ...context.known];
  // The same statement can reach a person by more than one path; they should
  // still only say it once.
  const seenText = new Set();
  const hits = pool.map((r) => ({ r, s: scoreRow(r) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .filter((x) => {
      const key = `${x.r.statement.predicate}|${x.r.statement.object}`;
      if (seenText.has(key)) return false;
      seenText.add(key);
      return true;
    })
    .slice(0, 3);

  // A secret is only volunteered under direct pressure, and never by accident.
  const secretHit = context.secrets.find((r) => scoreRow(r) > 0);

  if (!hits.length && !secretHit) {
    return {
      type: 'DOES_NOT_KNOW',
      text: `${context.person.name} has nothing to say about that.`,
      basis: [],
      boundary: context.boundary.omitted.slice(0, 3),
    };
  }

  const lines = [];
  const basis = [];
  for (const { r } of hits) {
    lines.push(render(world, r, nameOf));
    basis.push({ statement: r.statement.id, path: r.path, as: r.as, passage: r.statement.provenance.passageId });
  }
  const type = hits.length && hits[0].r.as === EPISTEMIC.MEMORY ? 'MEMORY'
    : hits.length && hits[0].r.as === EPISTEMIC.BELIEF ? 'BELIEF'
    : hits.length ? 'KNOWS' : 'WITHHOLDS';

  return {
    type,
    text: lines.join(' '),
    basis,
    withheld: secretHit ? { statement: secretHit.statement.id, note: 'holds a secret bearing on this' } : null,
    boundary: context.boundary.omitted.slice(0, 3),
  };
}

function render(world, row, nameOf) {
  const st = row.statement;
  const obj = typeof st.object === 'string' && world.entities.has(st.object) ? nameOf(st.object) : st.object;
  switch (st.predicate) {
    case 'REMEMBERS': return `I remember ${obj}.`;
    case 'BELIEVES': case 'STATES': return `${obj}.`;
    case 'SAID': return `${obj}`;
    case 'ESTRANGED_FROM': return `I have not spoken to ${obj}${st.time?.raw ? ` ${st.time.raw}` : ''}.`;
    case 'AVOIDS': return `I do not go to ${obj}${st.time?.raw ? ` ${st.time.raw}` : ''}.`;
    case 'FEARS': return `I am afraid of ${obj}.`;
    case 'WANTS': return `I want ${obj}.`;
    case 'RUNS': case 'OWNS': case 'WORKS_AT': return `I ${st.predicate === 'WORKS_AT' ? 'work at' : st.predicate.toLowerCase()} ${obj}.`;
    case 'CLOSED': return `It closed${st.time?.year ? ` in ${st.time.year}` : ''}.`;
    default: return st.raw || `${st.predicate.toLowerCase().replace(/_/g, ' ')} ${obj}.`;
  }
}
