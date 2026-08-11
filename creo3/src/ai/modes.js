// HOW HARD TO THINK — not which model to buy.
//
// A person asking about a place does not want to choose an endpoint, a model id,
// a reasoning effort and a vision setting before being understood. They want to
// say how much of a commitment this question is:
//
//   FAST      answer from what is already in view
//   THINK     look at the world first
//   DEEP      investigate: trace what connects to what, and simulate it
//   GAUNTLET  build it, test it, let a fresh critic attack it, revise
//
// Those are four different relationships with the world, not four quality
// levels. GAUNTLET especially is not "more reasoning" — it is another program,
// with an adversary in it.
//
// Model, effort and vision are how these are implemented today. They are behind
// a long press, where implementation details belong.

export const MODES = {
  fast: {
    key: 'fast', label: 'Fast', hint: 'answer from what is in view',
    effort: 'low', vision: 'never', investigate: false, gauntlet: false,
  },
  think: {
    key: 'think', label: 'Think', hint: 'look at the world first',
    effort: 'medium', vision: 'auto', investigate: false, gauntlet: false,
  },
  deep: {
    key: 'deep', label: 'Deep', hint: 'trace what connects to what, and simulate',
    effort: 'high', vision: 'auto', investigate: true, gauntlet: false,
  },
  gauntlet: {
    key: 'gauntlet', label: 'Gauntlet', hint: 'build it, test it, let a critic attack it',
    effort: 'high', vision: 'always', investigate: true, gauntlet: true,
    critic: { effort: 'max', vision: 'always' },
  },
};

export const MODE_ORDER = ['fast', 'think', 'deep', 'gauntlet'];

/**
 * Most of the time there should be no choice at all. CREO already parsed the
 * sentence into an operation, so route on that structure rather than on
 * keywords — "why does this flood" is an ASK about causation whatever words
 * carry it.
 */
export function routeMode(intent, { hasCompetingConstraints = false } = {}) {
  const text = String(intent.original || '').toLowerCase();

  // An explicit ask for the hard version wins, before anything else.
  // Two things wanted at once is the shape that needs an adversary: solve it,
  // then have something check the solution did not quietly break the other half.
  if (/\b(best|optimal|figure out|work out)\b/.test(text)
      || /\bwithout (?:losing|removing|touching|changing|affecting)\b/.test(text)
      || /\b(but|while|and) (?:still )?(?:keep|keeping|preserve|preserving|leave|leaving)\b/.test(text)
      || /\binstead of\b/.test(text)
      || hasCompetingConstraints
      || (intent.constraints || []).length > 1) {
    return 'gauntlet';
  }

  // Working the interface is not a world edit, and CREO's grammar has no verb
  // for it — "select that building" parses as a proposal to build one. This must
  // not swallow "show heavy rain", which is a simulation wearing the same verb.
  if (!['SIMULATE', 'BRANCH', 'MERGE'].includes(intent.operation)
      && /^(select|choose|pick|hide|zoom|go to|take me|look at|centre|center|focus on)\b/.test(text)) {
    return 'fast';
  }

  switch (intent.operation) {
    case 'ASK':
      return ['why', 'why-not', 'what-blocks', 'where-fit', 'compare'].includes(intent.question?.kind)
        ? 'deep' : 'fast';
    case 'SIMULATE':
    case 'BRANCH':
    case 'MERGE':
      return 'deep';
    case 'PROPOSE':
    case 'MODIFY':
    case 'RELATE':
      return 'think';
    case 'OBSERVE':
    case 'MEASURE':
    case 'PRESERVE':
    case 'REMOVE':
      return 'fast';
    default:
      return 'think';
  }
}

/** What the mode line should say while it is working. */
export const STEP_LABELS = {
  reading: 'reading the place',
  terrain: 'looking at the ground',
  water: 'following the water',
  drains: 'checking the drains',
  routes: 'checking who walks here',
  relations: 'tracing what connects to what',
  rain: 'testing heavy rain',
  asking: 'thinking it through',
  building: 'making a proposal',
  rendering: 'looking at the result',
  critic: 'challenging it',
  revising: 'trying again',
};
