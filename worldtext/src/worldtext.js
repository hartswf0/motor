// THE WORLDTEXT STORE — the dormant world.
//
// Canonical substrate: source passages, statements about the world, and an event
// ledger, all branch-scoped and all carrying provenance. Nothing here renders,
// ticks, or thinks. Existence is semantic; activation is computational (§1).

import { Corpus } from './source.js';

/**
 * Epistemic status (§5). A statement's status says what kind of thing it is, and
 * only an explicit operation may change it. Generated invention can never
 * silently become source truth.
 */
export const EPISTEMIC = {
  SOURCE: 'SOURCE',         // exact language entered the motor from outside
  INFERRED: 'INFERRED',     // the motor derived it from other statements, by rule
  BELIEF: 'BELIEF',         // a character holds it
  MEMORY: 'MEMORY',         // a character remembers it (a projection of an event)
  RUMOUR: 'RUMOUR',         // transmitted; the path is recorded
  MODEL: 'MODEL',           // a causal solver produced it, with assumptions
  PROPOSED: 'PROPOSED',     // a participant proposed it
  EVENT: 'EVENT',           // it occurred, in some branch
  GENERATED: 'GENERATED',   // invented by a generative process
  GUESS: 'GUESS',           // a character's unsupported inference (§18)
  LIE: 'LIE',               // a character's knowing falsehood
};

/** Which statuses may ground a claim about what is true in the world. */
export const GROUNDING = new Set([EPISTEMIC.SOURCE, EPISTEMIC.EVENT, EPISTEMIC.INFERRED, EPISTEMIC.MODEL]);

/** Title case beats SHOUTING beats lower case, when the same name appears several ways. */
function score(n) {
  if (/^[A-Z][a-z]/.test(n)) return 3;
  if (/^[a-z]/.test(n)) return 2;
  return 1;
}

let seq = 0;
const nextId = (p) => `${p}_${(++seq).toString(36)}`;
export const resetIds = (n = 0) => { seq = n; };

/** Entities are semantic identities, not runtime objects. */
export function makeEntity(kind, name, extra = {}) {
  return {
    id: extra.id || nextId(kind === 'person' ? 'per' : kind === 'place' ? 'plc' : kind.slice(0, 3)),
    kind,                                  // person | place | thing | institution | group | event | time
    names: [name],
    mentions: [],                          // passageIds — where the corpus speaks of them
    lod: 0,                                // 0 = mention only; raised only by activation
    ...extra,
  };
}

/**
 * A statement is the atom of WorldText. It is deliberately not "entity.property =
 * value": knowledge has a knower, and the same sentence may be a claim, a
 * relation and a memory at once.
 */
export function makeStatement(s) {
  return {
    id: s.id || nextId('st'),
    kind: s.kind || 'claim',               // claim | relation | memory | rule | schedule | trait
    epistemic: s.epistemic || EPISTEMIC.SOURCE,
    holder: s.holder || null,              // who believes/remembers/says it (§7)
    subject: s.subject || null,
    predicate: s.predicate,
    object: s.object ?? null,
    polarity: s.polarity !== false,
    time: s.time || null,                  // {kind:'year'|'interval'|'relative'|'unknown', ...}
    place: s.place || null,
    confidence: s.confidence ?? 1,
    branch: s.branch || 'CANON',
    raw: s.raw || null,                    // the exact sentence this came from
    provenance: {
      passageId: s.provenance?.passageId || null,
      eventId: s.provenance?.eventId || null,
      modelId: s.provenance?.modelId || null,
      derivedFrom: s.provenance?.derivedFrom || [],
      rule: s.provenance?.rule || null,
      version: s.provenance?.version || 1,
    },
    tags: s.tags || [],
  };
}

/** An event happened. Events are the only way world time advances (§28). */
export function makeEvent(e) {
  return {
    id: e.id || nextId('ev'),
    kind: e.kind,                          // encounter | utterance | movement | change | model-run | authorial
    time: e.time,                          // world clock value
    place: e.place || null,
    participants: e.participants || [],
    branch: e.branch || 'CANON',
    caption: e.caption || '',
    statements: e.statements || [],        // statement ids this event produced
    causedBy: e.causedBy || [],            // event ids / potential ids / operation ids
    provenance: e.provenance || {},
    witnesses: e.witnesses || [],          // who could perceive it — the basis of knowledge transmission
  };
}

/** Branches are experiments, and they are not all equally factual (§65). */
export function makeBranch(id, o = {}) {
  return {
    id,
    parent: o.parent ?? null,
    kind: o.kind || 'canon',               // canon | proposal | simulation | dream | film | counterfactual
    purpose: o.purpose || '',
    createdAt: o.createdAt ?? 0,
    author: o.author || 'system',
  };
}

export class WorldText {
  constructor() {
    this.corpus = new Corpus();
    this.entities = new Map();
    this.statements = new Map();
    this.events = [];                      // append-only ledger, ordered
    this.branches = new Map([['CANON', makeBranch('CANON', { kind: 'canon', purpose: 'what the sources establish' })]]);
    this.potentials = new Map();
    this.byName = new Map();               // normalised name -> entityId
    this.bySubject = new Map();            // entityId -> statementIds
    this.byPassage = new Map();            // passageId -> statementIds
    this.clock = 0;                        // world time, advanced only by events
    this.log = [];                         // motor operations, for the debugger (§40)
  }

  // ------------------------------------------------------------- entities ---
  nameKey(n) { return String(n).toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/[^\p{L}\p{N} ]/gu, '').trim(); }

  entity(nameOrId) {
    if (this.entities.has(nameOrId)) return this.entities.get(nameOrId);
    const id = this.byName.get(this.nameKey(nameOrId));
    return id ? this.entities.get(id) : null;
  }

  ensureEntity(name, kind = 'person', extra = {}) {
    const existing = this.entity(name);
    if (existing) {
      if (!existing.names.includes(name)) existing.names.push(name);
      if (existing.kind === 'thing' && kind !== 'thing') existing.kind = kind;
      // Prefer the best-cased surface form: a transcript's "MARTA:" should not
      // become the name the world calls her by.
      const best = existing.names.slice().sort((a, b) => score(b) - score(a))[0];
      if (best !== existing.names[0]) {
        existing.names = [best, ...existing.names.filter((n) => n !== best)];
      }
      return existing;
    }
    const e = makeEntity(kind, name, extra);
    this.entities.set(e.id, e);
    this.byName.set(this.nameKey(name), e.id);
    return e;
  }

  alias(entityId, name) {
    const e = this.entities.get(entityId);
    if (!e) return;
    if (!e.names.includes(name)) e.names.push(name);
    this.byName.set(this.nameKey(name), entityId);
  }

  // ----------------------------------------------------------- statements ---
  assert(s) {
    const st = makeStatement(s);
    this.statements.set(st.id, st);
    for (const key of [st.subject, st.object, st.holder]) {
      if (typeof key !== 'string' || !this.entities.has(key)) continue;
      if (!this.bySubject.has(key)) this.bySubject.set(key, []);
      this.bySubject.get(key).push(st.id);
    }
    const pid = st.provenance.passageId;
    if (pid) {
      if (!this.byPassage.has(pid)) this.byPassage.set(pid, []);
      this.byPassage.get(pid).push(st.id);
    }
    return st;
  }

  /** Statements visible from a branch: the branch chain, nearest first. */
  chain(branch = 'CANON') {
    const out = [];
    let b = this.branches.get(branch);
    while (b) { out.unshift(b.id); b = b.parent ? this.branches.get(b.parent) : null; }
    return out;
  }

  about(entityId, { branch = 'CANON', kinds = null, epistemic = null } = {}) {
    const visible = new Set(this.chain(branch));
    return (this.bySubject.get(entityId) || [])
      .map((id) => this.statements.get(id))
      .filter((st) => st && visible.has(st.branch)
        && (!kinds || kinds.includes(st.kind))
        && (!epistemic || epistemic.includes(st.epistemic)));
  }

  statementsFor(passageId) {
    return (this.byPassage.get(passageId) || []).map((id) => this.statements.get(id));
  }

  /**
   * Everything asserted about a predicate across holders — the raw material of
   * contradiction (§8). No resolution is performed here on purpose.
   */
  accounts(subject, predicate, { branch = 'CANON' } = {}) {
    const visible = new Set(this.chain(branch));
    return [...this.statements.values()].filter((st) =>
      visible.has(st.branch) && st.subject === subject && st.predicate === predicate);
  }

  // --------------------------------------------------------------- events ---
  append(e) {
    const ev = makeEvent({ ...e, time: e.time ?? ++this.clock });
    this.clock = Math.max(this.clock, ev.time);
    this.events.push(ev);
    return ev;
  }

  eventsIn(branch = 'CANON') {
    const visible = new Set(this.chain(branch));
    return this.events.filter((e) => visible.has(e.branch));
  }

  branch(id, opts) {
    const b = makeBranch(id, { parent: opts.parent ?? 'CANON', createdAt: this.clock, ...opts });
    this.branches.set(id, b);
    return b;
  }

  // ---------------------------------------------------------- observability -
  note(op, detail) { this.log.push({ at: this.clock, op, ...detail }); return detail; }

  /**
   * §146 — if every viewport closed and every agent were terminated right now,
   * this is what would still exist.
   */
  census() {
    const byKind = {};
    for (const e of this.entities.values()) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    const byEpistemic = {};
    for (const s of this.statements.values()) byEpistemic[s.epistemic] = (byEpistemic[s.epistemic] || 0) + 1;
    return {
      passages: this.corpus.size(),
      entities: this.entities.size, byKind,
      statements: this.statements.size, byEpistemic,
      events: this.events.length,
      potentials: this.potentials.size,
      branches: this.branches.size,
      clock: this.clock,
    };
  }

  toJSON() {
    return {
      corpus: this.corpus.toJSON(),
      entities: [...this.entities.values()],
      statements: [...this.statements.values()],
      events: this.events,
      branches: [...this.branches.values()],
      potentials: [...this.potentials.values()],
      clock: this.clock,
      seq,
    };
  }

  static fromJSON(j) {
    const w = new WorldText();
    w.corpus = Corpus.fromJSON(j.corpus);
    for (const e of j.entities) {
      w.entities.set(e.id, e);
      for (const n of e.names) w.byName.set(w.nameKey(n), e.id);
    }
    for (const s of j.statements) {
      w.statements.set(s.id, s);
      for (const key of [s.subject, s.object, s.holder]) {
        if (typeof key !== 'string' || !w.entities.has(key)) continue;
        if (!w.bySubject.has(key)) w.bySubject.set(key, []);
        w.bySubject.get(key).push(s.id);
      }
      if (s.provenance.passageId) {
        if (!w.byPassage.has(s.provenance.passageId)) w.byPassage.set(s.provenance.passageId, []);
        w.byPassage.get(s.provenance.passageId).push(s.id);
      }
    }
    w.events = j.events;
    w.branches = new Map(j.branches.map((b) => [b.id, b]));
    w.potentials = new Map(j.potentials.map((p) => [p.id, p]));
    w.clock = j.clock;
    resetIds(j.seq || 0);
    return w;
  }
}
