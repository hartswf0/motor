// SEMANTIC ACTIVATION — what matters now (§11–13).
//
// The runtime question is not "what ticks?" but "what does this situation make
// consequential?" Everything else stays dormant and costs nothing. This is the
// culling pass, and it is more important than any render LOD.

/** LOD for mind (§14). Identity is continuous across all six. */
export const LOD = {
  MENTION: 0,      // recoverable from source; nothing else
  RECORD: 1,       // identity, relations, location, known claims
  DISPOSITION: 2,  // goals, habits, commitments
  ACTOR: 3,        // currently relevant; rules and state run
  AGENT: 4,        // interaction requires situated reasoning
  PROTAGONIST: 5,  // deep retrieval, long horizon, rich memory
};

export const LOD_NAME = ['MENTION', 'RECORD', 'DISPOSITION', 'ACTOR', 'AGENT', 'PROTAGONIST'];

/**
 * Compute the activation frontier for a situation.
 *
 * @param {WorldText} world
 * @param {{place?:string, present?:string[], focus?:string[], question?:string,
 *          time?:object, branch?:string, budget?:number}} situation
 */
export function frontier(world, situation = {}) {
  const branch = situation.branch || 'CANON';
  const visible = new Set(world.chain(branch));
  const scores = new Map();
  const why = new Map();

  const bump = (id, amount, reason) => {
    if (!id || !world.entities.has(id)) return;
    scores.set(id, (scores.get(id) || 0) + amount);
    if (!why.has(id)) why.set(id, []);
    if (why.get(id).length < 4) why.get(id).push(reason);
  };

  // 1. whoever the situation names is already relevant
  for (const id of situation.focus || []) bump(id, 10, 'in focus');
  for (const id of situation.present || []) bump(id, 8, 'present');
  if (situation.place) bump(situation.place, 6, 'the place itself');

  // 2. the question is a streaming source (§52): meaning loads around it
  if (situation.question) {
    for (const hit of world.corpus.search(situation.question, 20)) {
      for (const st of world.statementsFor(hit.passage.id)) {
        bump(st.subject, 2 * hit.score, 'named in a passage matching the question');
        bump(st.object, 1.2 * hit.score, 'named in a passage matching the question');
        bump(st.holder, 1.5 * hit.score, 'speaks in a passage matching the question');
      }
      for (const e of world.entities.values()) {
        if (e.mentions.includes(hit.passage.id)) bump(e.id, 1.4 * hit.score, 'mentioned in a matching passage');
      }
    }
    const named = matchNames(world, situation.question);
    for (const id of named) bump(id, 9, 'named in the question');
  }

  // 3. one step out along established relations — locality, not the whole graph
  const seeds = [...scores.keys()];
  for (const id of seeds) {
    const base = scores.get(id);
    if (base < 3) continue;
    for (const st of world.about(id, { branch })) {
      const other = st.subject === id ? st.object : st.subject;
      if (typeof other !== 'string') continue;
      bump(other, Math.min(2.5, base * 0.25), `related to ${world.entities.get(id)?.names[0] || id}`);
    }
  }

  // 4. recent events pull their participants forward
  const recent = world.eventsIn(branch).slice(-8);
  for (const ev of recent) for (const p of ev.participants) bump(p, 2, 'in a recent event');

  // 5. ripe potentials raise their participants
  for (const p of world.potentials.values()) {
    if (!visible.has(p.branch) || p.status === 'spent') continue;
    const touches = p.participants.some((x) => scores.has(x)) || (p.place && scores.has(p.place));
    if (!touches) continue;
    for (const x of p.participants) bump(x, 2 * p.pressure, `party to a ${p.kind} potential`);
    if (p.place) bump(p.place, 1.5 * p.pressure, `where a ${p.kind} potential sits`);
  }

  // Assign computational agency in proportion to relevance, and to nothing else.
  const budget = situation.budget ?? 6;
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const active = [];
  ranked.forEach(([id, score], i) => {
    const e = world.entities.get(id);
    let lod = LOD.RECORD;
    if (e.kind === 'person' || e.kind === 'group') {
      if (i === 0 && score >= 9) lod = LOD.PROTAGONIST;
      else if (i < budget && score >= 7) lod = LOD.AGENT;
      else if (i < budget * 2 && score >= 4) lod = LOD.ACTOR;
      else if (score >= 2) lod = LOD.DISPOSITION;
    }
    active.push({ id, name: e.names[0], kind: e.kind, score: +score.toFixed(2), lod, lodName: LOD_NAME[lod], why: why.get(id) });
  });

  const result = {
    situation,
    active: active.slice(0, Math.max(24, budget * 4)),
    considered: scores.size,
    dormant: world.entities.size - scores.size,
    agents: active.filter((a) => a.lod >= LOD.AGENT).map((a) => a.id),
  };
  world.note('frontier', { question: situation.question || null, considered: result.considered, agents: result.agents.length });
  return result;
}

function matchNames(world, text) {
  const t = String(text).toLowerCase();
  const out = [];
  for (const [key, id] of world.byName) {
    if (key.length < 3) continue;
    if (new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) out.push(id);
  }
  return out;
}

/**
 * Semantic LOD for knowledge (§51): the slice of WorldText this situation needs.
 * Bounded by construction — the whole corpus is never assembled.
 */
export function semanticSlice(world, frontierResult, { branch = 'CANON', perEntity = 8 } = {}) {
  const out = { statements: [], passages: new Set(), potentials: [] };
  const seen = new Set();
  for (const a of frontierResult.active) {
    if (a.lod < LOD.DISPOSITION && a.kind === 'person') continue;
    const sts = world.about(a.id, { branch }).slice(0, perEntity);
    for (const st of sts) {
      if (seen.has(st.id)) continue;
      seen.add(st.id);
      out.statements.push(st);
      if (st.provenance.passageId) out.passages.add(st.provenance.passageId);
    }
  }
  const ids = new Set(frontierResult.active.map((a) => a.id));
  for (const p of world.potentials.values()) {
    if (p.status === 'spent') continue;
    if (p.participants.some((x) => ids.has(x)) || (p.place && ids.has(p.place))) out.potentials.push(p);
  }
  out.passages = [...out.passages];
  return out;
}
