// POTENTIAL — the first-class primitive (§9).
//
// A potential is a world difference that could produce an event if conditions
// align. It is not a quest, not a scripted trigger, and not an invitation for a
// generative model to invent drama. It is a structured affordance derived from
// established WorldText, and it must be able to say which differences created it,
// what has to be true for it to activate, and what kinds of consequence follow.
//
// Discovery is not enactment (§10). Discovered potentials are indexed and left
// dormant. Most will never fire, and that is what makes this a world rather than
// a screenplay (§71).

import { EPISTEMIC } from './worldtext.js';

let pseq = 0;
const pid = () => `pot_${(++pseq).toString(36)}`;
export const resetPotentialIds = () => { pseq = 0; };

function make(world, p) {
  const potential = {
    id: pid(),
    kind: p.kind,
    epistemic: EPISTEMIC.INFERRED,          // never SOURCE: the corpus did not say this
    participants: p.participants || [],
    place: p.place || null,
    from: p.from || [],                     // the established statements that created it
    because: p.because,                     // one sentence a person can read
    conditions: p.conditions || [],
    consequences: p.consequences || [],     // classes, not scripts
    pressure: p.pressure ?? 0.5,            // how hard the difference pushes
    status: 'dormant',
    firedAs: [],                            // event ids, if it ever becomes event
    branch: p.branch || 'CANON',
  };
  world.potentials.set(potential.id, potential);
  return potential;
}

// ---------------------------------------------------------------- discovery -
/**
 * Read the world for unresolved differences (§58). Each detector is a named rule
 * over established statements — no generation, no model.
 */
export function discover(world, { branch = 'CANON' } = {}) {
  const found = [];
  const S = [...world.statements.values()].filter((s) => world.chain(branch).includes(s.branch));
  const by = (pred) => S.filter((s) => s.predicate === pred);
  const nameOf = (id) => world.entities.get(id)?.names[0] || id;

  // --- estrangement + a shared appointment is the classic latent encounter ---
  const schedules = S.filter((s) => s.kind === 'schedule');
  const pairSeen = new Set();
  for (const est of by('ESTRANGED_FROM')) {
    if (est.epistemic === EPISTEMIC.INFERRED) continue;          // use one direction only
    // Estrangement is mutual; the corpus may state it from both sides. One
    // potential per pair, not one per sentence.
    const pairKey = [est.subject, est.object].sort().join('|');
    if (pairSeen.has(pairKey)) continue;
    pairSeen.add(pairKey);
    const a = est.subject, b = est.object;
    const sharedPlaces = new Map();
    for (const sc of schedules) {
      if (sc.subject !== a && sc.subject !== b) continue;
      const key = String(sc.object);
      if (!sharedPlaces.has(key)) sharedPlaces.set(key, new Set());
      sharedPlaces.get(key).add(sc.subject);
    }
    for (const [place, who] of sharedPlaces) {
      if (!(who.has(a) && who.has(b))) continue;
      const when = schedules.find((sc) => String(sc.object) === place)?.time || null;
      found.push(make(world, {
        kind: 'encounter',
        participants: [a, b],
        place: world.entities.has(place) ? place : null,
        from: [est.id, ...schedules.filter((sc) => String(sc.object) === place && who.has(sc.subject)).map((s) => s.id)],
        because: `${nameOf(a)} and ${nameOf(b)} are estranged, and both attend ${nameOf(place)}.`,
        conditions: [
          { kind: 'co-presence', who: [a, b], where: place },
          { kind: 'time', spec: when },
        ],
        consequences: ['meeting', 'refusal to speak', 'partial reconciliation', 'public avoidance'],
        pressure: 0.85,
      }));
    }
  }

  // --- avoidance is a standing refusal; the place keeps its charge ------------
  for (const av of by('AVOIDS')) {
    found.push(make(world, {
      kind: 'return',
      participants: [av.subject],
      place: av.object,
      from: [av.id],
      because: `${nameOf(av.subject)} avoids ${nameOf(av.object)}${av.time?.raw ? ` (${av.time.raw})` : ''}.`,
      conditions: [
        { kind: 'presence', who: [av.subject], where: av.object },
        { kind: 'compulsion', note: 'something must be worth the cost of going' },
      ],
      consequences: ['return', 'refusal at the threshold', 'discovery', 'confrontation'],
      pressure: 0.7,
    }));
  }

  // --- a secret is a difference between what one person knows and everyone else
  for (const sec of S.filter((s) => s.predicate === 'KNOWS_SECRET')) {
    const holder = sec.subject;
    const interested = S.filter((s) => s.predicate === 'WANTS' || s.predicate === 'DISPUTES')
      .map((s) => s.subject).filter((x) => x && x !== holder);
    found.push(make(world, {
      kind: 'revelation',
      participants: [holder, ...new Set(interested)].slice(0, 4),
      place: null,
      from: [sec.id],
      because: `${nameOf(holder)} alone knows: ${sec.object}`,
      conditions: [
        { kind: 'pressure-on', who: [holder] },
        { kind: 'audience', note: 'someone present for whom it matters' },
      ],
      consequences: ['disclosure', 'denial', 'partial admission', 'transmission as rumour'],
      pressure: 0.8,
    }));
  }

  // --- a promise unfulfilled ------------------------------------------------
  for (const pr of by('PROMISED')) {
    found.push(make(world, {
      kind: 'obligation',
      participants: [pr.subject, pr.object],
      from: [pr.id],
      because: `${nameOf(pr.subject)} promised ${nameOf(pr.object)}: ${pr.tags.filter((t) => !world.entities.has(t)).join('; ')}`,
      conditions: [{ kind: 'occasion', note: 'the occasion the promise named must arrive' }],
      consequences: ['fulfilment', 'default', 'renegotiation'],
      pressure: 0.6,
    }));
  }

  // --- incompatible accounts of the same thing ------------------------------
  for (const c of contradictions(world, branch)) {
    found.push(make(world, {
      kind: 'dispute',
      participants: c.holders,
      place: c.subject && world.entities.get(c.subject)?.kind === 'place' ? c.subject : null,
      from: c.statements,
      because: c.because,
      conditions: [{ kind: 'inquiry', note: 'someone must ask, or evidence must surface' }],
      consequences: ['argument', 'evidence produced', 'one account revised', 'the disagreement hardens'],
      pressure: 0.65,
    }));
  }

  // --- desire against condition ---------------------------------------------
  for (const w of by('WANTS')) {
    found.push(make(world, {
      kind: 'pursuit',
      participants: [w.subject],
      place: world.entities.get(w.object)?.kind === 'place' ? w.object : null,
      from: [w.id],
      because: `${nameOf(w.subject)} wants ${typeof w.object === 'string' && world.entities.has(w.object) ? nameOf(w.object) : w.object}.`,
      conditions: [{ kind: 'opportunity', note: 'a forum or means must exist' }],
      consequences: ['proposal', 'alliance', 'conflict with an interest'],
      pressure: 0.55,
    }));
  }
  for (const f of by('FEARS')) {
    found.push(make(world, {
      kind: 'dread',
      participants: [f.subject],
      place: world.entities.get(f.object)?.kind === 'place' ? f.object : null,
      from: [f.id],
      because: `${nameOf(f.subject)} fears ${world.entities.has(f.object) ? nameOf(f.object) : f.object}.`,
      conditions: [{ kind: 'approach', note: 'the feared thing must come near' }],
      consequences: ['flight', 'paralysis', 'unexpected courage'],
      pressure: 0.5,
    }));
  }

  // --- mundane causality is potential too (§59) ------------------------------
  for (const sc of schedules) {
    found.push(make(world, {
      kind: 'routine',
      participants: [sc.subject],
      place: world.entities.has(sc.object) ? sc.object : null,
      from: [sc.id],
      because: `${nameOf(sc.subject)} ${sc.time?.raw ? sc.time.raw : 'regularly'} at ${world.entities.has(sc.object) ? nameOf(sc.object) : sc.object}.`,
      conditions: [{ kind: 'time', spec: sc.time }],
      consequences: ['ordinary presence'],
      pressure: 0.15,
    }));
  }

  world.note('discover', { count: found.length });
  return found;
}

/**
 * Contradiction is world material (§8): find incompatible accounts and keep them
 * incompatible. Nothing here computes a winner.
 */
export function contradictions(world, branch = 'CANON') {
  const visible = new Set(world.chain(branch));
  const S = [...world.statements.values()].filter((s) => visible.has(s.branch));
  const out = [];
  const nameOf = (id) => world.entities.get(id)?.names[0] || id;

  // 1. explicit dispute markers from the source
  for (const d of S.filter((s) => s.predicate === 'DISPUTES')) {
    const holders = d.tags.filter((t) => world.entities.has(t));
    out.push({
      kind: 'stated', subject: null, topic: d.object, holders,
      statements: [d.id],
      because: `The source records disagreement about ${d.object}.`,
    });
  }

  // 2. same subject and predicate, incompatible values, different holders
  const groups = new Map();
  for (const s of S) {
    if (!s.subject || s.object === null || s.object === undefined) continue;
    if (['REMEMBERS', 'BELIEVES', 'STATES', 'DISPUTES'].includes(s.predicate)) continue;
    const key = `${s.subject}|${s.predicate}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const times = list.filter((s) => s.time && s.time.kind === 'year');
    const years = new Set(times.map((s) => s.time.year));
    if (years.size > 1) {
      const [subject, predicate] = key.split('|');
      out.push({
        kind: 'dated', subject, predicate,
        holders: [...new Set(times.map((s) => s.holder).filter(Boolean))],
        statements: times.map((s) => s.id),
        because: `${nameOf(subject)} ${predicate.toLowerCase()}: ${[...years].sort().join(' vs ')} — the accounts do not agree.`,
        values: [...years],
      });
    }
  }

  // 3. beliefs about a topic that different people hold differently
  const topics = new Map();
  for (const s of S.filter((x) => x.predicate === 'BELIEVES' || x.predicate === 'STATES')) {
    const t = String(s.object).toLowerCase();
    const key = t.split(/\s+/).filter((w) => w.length > 4).slice(0, 2).join(' ');
    if (!key) continue;
    if (!topics.has(key)) topics.set(key, []);
    topics.get(key).push(s);
  }
  for (const [key, list] of topics) {
    const holders = [...new Set(list.map((s) => s.holder).filter(Boolean))];
    if (holders.length < 2) continue;
    out.push({
      kind: 'belief', subject: null, topic: key, holders,
      statements: list.map((s) => s.id),
      because: `${holders.map(nameOf).join(' and ')} hold different positions on ${key}.`,
    });
  }

  return out;
}

// --------------------------------------------------------------- activation -
/**
 * Evaluate a potential against a situation. Returns how close it is to firing and
 * exactly which conditions are unmet — the potential explains itself (§63).
 */
export function evaluate(world, potential, situation) {
  const present = new Set(situation.present || []);
  const where = situation.place || null;
  const met = [];
  const unmet = [];

  for (const c of potential.conditions) {
    switch (c.kind) {
      case 'co-presence': {
        const all = c.who.every((w) => present.has(w));
        const here = !c.where || !world.entities.has(c.where) || c.where === where;
        (all && here ? met : unmet).push({ ...c, why: all ? (here ? 'satisfied' : 'not at this place') : 'not all present' });
        break;
      }
      case 'presence': {
        const ok = c.who.every((w) => present.has(w)) && (!c.where || c.where === where);
        (ok ? met : unmet).push({ ...c, why: ok ? 'satisfied' : 'the person is not here' });
        break;
      }
      case 'time': {
        const ok = !c.spec || matchTime(c.spec, situation.time);
        (ok ? met : unmet).push({ ...c, why: ok ? 'satisfied' : `wrong time (${c.spec?.raw || 'unspecified'})` });
        break;
      }
      case 'audience': {
        const ok = present.size > 1;
        (ok ? met : unmet).push({ ...c, why: ok ? 'someone is here' : 'nobody to hear it' });
        break;
      }
      case 'inquiry': {
        const ok = !!situation.question;
        (ok ? met : unmet).push({ ...c, why: ok ? 'a question was asked' : 'nobody has asked' });
        break;
      }
      case 'pressure-on': {
        const ok = c.who.some((w) => present.has(w)) && (situation.pressure || 0) > 0.3;
        (ok ? met : unmet).push({ ...c, why: ok ? 'under pressure' : 'no pressure on the holder' });
        break;
      }
      default:
        // occasion / compulsion / opportunity / approach are narrative conditions:
        // they are satisfied by an explicit operation, never by the motor alone.
        (situation.allow?.includes(c.kind) ? met : unmet).push({ ...c, why: situation.allow?.includes(c.kind) ? 'granted' : 'awaiting an occasion' });
    }
  }

  const readiness = potential.conditions.length ? met.length / potential.conditions.length : 0;
  return {
    potential, met, unmet,
    readiness,
    ripe: unmet.length === 0,
    score: readiness * potential.pressure,
  };
}

function matchTime(spec, now) {
  if (!spec || !now) return true;
  if (spec.kind === 'recurring') return !!now.occasion && String(now.occasion).toLowerCase().includes(String(spec.period || spec.raw || '').toLowerCase().replace('every ', ''));
  if (spec.kind === 'year') return now.year === spec.year;
  return true;
}

/** Rank what could matter now, cheaply, without waking anything (§31). */
export function field(world, situation, { limit = 10, branch = 'CANON' } = {}) {
  const out = [];
  for (const p of world.potentials.values()) {
    if (!world.chain(branch).includes(p.branch)) continue;
    if (p.status === 'spent') continue;
    const ev = evaluate(world, p, situation);
    if (ev.score <= 0 && !ev.ripe) continue;
    out.push(ev);
  }
  return out.sort((a, b) => b.score - a.score || b.readiness - a.readiness).slice(0, limit);
}
