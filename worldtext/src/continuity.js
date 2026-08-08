// THE CONTINUITY CERTIFICATE (§68) — the gate every generated thing must pass.
//
// This is the enforcement point for §5: a model-generated invention may not
// silently become established source truth. Nothing produced by a model enters
// the world without a verdict here, and an admitted statement is stamped
// GENERATED with the model named in its provenance — permanently distinguishable
// from what the corpus actually said.

import { EPISTEMIC } from './worldtext.js';

export const VERDICT = {
  ADMISSIBLE: 'ADMISSIBLE',
  CONTRADICTORY: 'CONTRADICTORY',       // conflicts with established world state
  IMPOSSIBLE: 'IMPOSSIBLE',             // knowledge, place or time forbids it
  UNDERDETERMINED: 'UNDERDETERMINED',   // nothing supports it either way
  REQUIRES_INVENTION: 'REQUIRES_INVENTION', // only an explicit invention mode allows it
  REQUIRES_BRANCH: 'REQUIRES_BRANCH',   // admissible, but not on this worldline
};

/**
 * Admit (or refuse) a parse candidate produced by a model.
 * The central check is anti-fabrication: every name the model used must actually
 * occur in the sentence it was given, or already exist in the world. A model that
 * invents a character while "parsing" is caught here, not downstream.
 */
export function admitParse(world, candidate, passage, { branch = 'CANON', allowInvention = false } = {}) {
  const reasons = [];
  const text = passage.text.toLowerCase();

  const grounded = (surface) => {
    if (surface === null || surface === undefined) return true;
    const s = String(surface).toLowerCase().trim();
    if (!s) return true;
    if (text.includes(s)) return true;                       // it is in the sentence
    if (world.entity(s)) return true;                        // or already in the world
    // allow a possessive/plural difference, nothing looser
    const stem = s.replace(/'s$/, '').replace(/s$/, '');
    return stem.length > 2 && (text.includes(stem) || !!world.entity(stem));
  };

  for (const [field, value] of [['subject', candidate.subject], ['object', candidate.object], ['holder', candidate.holder]]) {
    if (!grounded(value)) reasons.push(`${field} “${value}” does not occur in the passage and is not an existing entity`);
  }
  if (!/^[A-Z][A-Z_]*$/.test(String(candidate.predicate || ''))) {
    reasons.push(`predicate “${candidate.predicate}” is not a canonical form`);
  }
  if (reasons.length) {
    return { verdict: VERDICT.IMPOSSIBLE, reasons, candidate };
  }

  // Does it contradict something the source already established?
  const subjectId = world.entity(candidate.subject)?.id;
  if (subjectId) {
    const existing = world.accounts(subjectId, candidate.predicate, { branch })
      .filter((s) => s.epistemic === EPISTEMIC.SOURCE && !s.holder);
    for (const s of existing) {
      const a = String(s.object).toLowerCase();
      const b = String(candidate.object).toLowerCase();
      if (a && b && a !== b && !a.includes(b) && !b.includes(a)) {
        return {
          verdict: VERDICT.CONTRADICTORY,
          reasons: [`the source already says ${candidate.subject} ${candidate.predicate} ${s.object}`],
          conflictsWith: [s.id], candidate,
        };
      }
    }
  }

  return { verdict: VERDICT.ADMISSIBLE, reasons: [], candidate };
}

/**
 * Turn an admitted candidate into a statement. Note the epistemic status: a model
 * reading of a sentence is GENERATED, not SOURCE, even though it is *about* a
 * source passage. Only an explicit human operation may promote it.
 */
export function commitParse(world, verdictResult, passage, { branch = 'CANON' } = {}) {
  if (verdictResult.verdict !== VERDICT.ADMISSIBLE) return null;
  const c = verdictResult.candidate;
  const subject = world.ensureEntity(String(c.subject).trim(), guessKind(c.subject));
  const objectEntity = c.object && typeof c.object === 'string' ? world.entity(String(c.object).trim()) : null;
  const holder = c.holder ? world.ensureEntity(String(c.holder).trim(), 'person') : null;
  return world.assert({
    kind: c.kind || 'claim',
    epistemic: EPISTEMIC.GENERATED,
    holder: holder?.id || null,
    subject: subject.id,
    predicate: c.predicate,
    object: objectEntity ? objectEntity.id : c.object,
    confidence: Math.min(0.7, c.confidence ?? 0.5),   // a reading is never certain
    branch,
    raw: passage.text,
    provenance: { passageId: passage.id, modelId: c.modelId, rule: 'model-escalation' },
    tags: ['model-read'],
  });
}

const guessKind = (s) => (/^[A-Z]/.test(String(s)) && String(s).split(/\s+/).length <= 3 ? 'person' : 'thing');

/**
 * Admit a *phrasing*. The motor already chose the content; this checks that the
 * model did not smuggle anything in while wording it — the knowledge boundary
 * applies to the sentence that finally gets said, not only to the plan for it.
 */
export function admitVoice(world, context, answer, phrased) {
  const reasons = [];
  const allowed = new Set();
  for (const row of [...context.known, ...context.beliefs, ...context.memories]) {
    for (const tok of tokens(`${row.statement.raw || ''} ${row.statement.object || ''}`)) allowed.add(tok);
  }
  for (const n of [context.person.name, ...(context.situation.present || [])]) for (const tok of tokens(String(n))) allowed.add(tok);
  for (const e of world.entities.values()) {
    if (!context.situation.present?.includes(e.id) && e.id !== context.person.id) continue;
    for (const tok of tokens(e.names.join(' '))) allowed.add(tok);
  }

  // Proper nouns and years are where fabrication shows up first.
  for (const word of String(phrased).split(/\s+/)) {
    const clean = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, '');
    if (!clean) continue;
    if (/^\d{4}$/.test(clean) && !allowed.has(clean)) { reasons.push(`invented a date: ${clean}`); continue; }
    if (/^[A-Z][\p{L}']{2,}$/u.test(clean) && !allowed.has(clean.toLowerCase()) && !SAFE_CAPS.has(clean)) {
      reasons.push(`invented a proper name: ${clean}`);
    }
  }
  if (answer.withheld) {
    const secret = world.statements.get(answer.withheld.statement);
    const secretTokens = tokens(String(secret?.object || '')).filter((t) => t.length > 4);
    const leaked = secretTokens.filter((t) => phrased.toLowerCase().includes(t));
    if (secretTokens.length && leaked.length >= Math.max(2, Math.ceil(secretTokens.length * 0.5))) {
      reasons.push('leaked the withheld material');
    }
  }
  return reasons.length
    ? { verdict: VERDICT.IMPOSSIBLE, reasons, text: answer.text, usedFallback: true }
    : { verdict: VERDICT.ADMISSIBLE, reasons: [], text: phrased, usedFallback: false };
}

const SAFE_CAPS = new Set(['I', 'I\'m', 'I\'ve', 'The', 'A', 'An', 'It', 'They', 'We', 'He', 'She', 'That', 'This', 'There', 'But', 'And', 'No', 'Yes', 'Not', 'My', 'You', 'Your', 'What', 'When', 'Where', 'Why', 'Who', 'How', 'If', 'So', 'Then', 'Nobody', 'Nothing', 'Never', 'Once', 'After', 'Before', 'Since']);

const tokens = (s) => (String(s).toLowerCase().match(/[\p{L}\p{N}']+/gu) || []);
