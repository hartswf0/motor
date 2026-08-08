// THE FRONT END — source language → semantic IR.
//
// A deterministic compiler pass, not a prompt. It runs with no foundation model,
// it can be read and argued with, and — crucially — it is honest: a sentence it
// does not understand is not silently dropped or hallucinated into structure. It
// remains exact source, queryable and quotable, marked unparsed.
//
// Everything it emits carries the passage it came from and the rule that fired,
// so §41 (source-to-event trace) is satisfiable by construction.

import { EPISTEMIC } from './worldtext.js';
import { escalateParse, getModel } from './model.js';
import { admitParse, commitParse, VERDICT } from './continuity.js';

// ------------------------------------------------------------- vocabulary ---
const PLACE_WORDS = /\b(mill|river|bridge|crossing|kiosk|field|school|station|market|church|road|street|square|hall|dam|channel|bend|shop|house|yard|well|quarry|pier|harbour|harbor|forest|orchard|cemetery|graveyard|ferry|junction|bakery|clinic|library|works|factory|warehouse|lane|path|gate|tower|chapel|bank)\b/i;
const GROUP_WORDS = /\b(residents|children|villagers|neighbours|neighbors|council|committee|families|workers|elders|fishermen|farmers|women|men|students|congregation)\b/i;

const STOP_CAPS = new Set(['The', 'A', 'An', 'It', 'He', 'She', 'They', 'We', 'I', 'His', 'Her', 'Their', 'This', 'That', 'These', 'Those', 'There', 'When', 'After', 'Before', 'Since', 'But', 'And', 'If', 'No', 'Not', 'Some', 'Every', 'One', 'Two', 'Three', 'Only', 'Both', 'Nobody', 'Everyone', 'Someone', 'What', 'Who', 'Where', 'Why', 'How', 'By', 'On', 'In', 'At', 'For', 'From', 'To', 'Of', 'With', 'Without', 'During', 'Until', 'Because', 'Although', 'Though', 'While', 'Then', 'Now', 'Later', 'Once']);

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';

/**
 * "the river ceremony every year" names the ceremony, not a different ceremony.
 * A trailing temporal adverbial must not become part of an entity's identity —
 * it silently created a second, unrelated place.
 */
export function stripTrailingTime(phrase) {
  return String(phrase)
    .replace(new RegExp(`\\s+(every|each)\\s+(year|month|week|day|morning|evening|summer|winter|spring|autumn|${MONTHS})$`, 'i'), '')
    .replace(/\s+(after|before|during)\s+(school|work|dark|dusk|dawn|the service|the ceremony)$/i, '')
    .replace(/\s+(tomorrow|yesterday|today|tonight)$/i, '')
    .replace(new RegExp(`\\s+(in|on|since|from|by)\\s+(\\d{4}|${MONTHS})$`, 'i'), '')
    .trim();
}

// ------------------------------------------------------------------ time ----
export function parseTime(text) {
  const t = text.toLowerCase();
  let m;
  if ((m = /\b(in|since|by|before|after|from)\s+(\d{4})\b/.exec(t))) {
    return { kind: 'year', year: +m[2], relation: m[1], raw: m[0] };
  }
  if ((m = /\b(\d{4})\b/.exec(t))) return { kind: 'year', year: +m[1], relation: 'in', raw: m[1] };
  if ((m = new RegExp(`\\b(${MONTHS})\\b`, 'i').exec(t))) return { kind: 'month', month: m[1], raw: m[0] };
  if (/\bevery (year|month|week|day|morning|evening|summer|winter)\b/.test(t)) {
    return { kind: 'recurring', period: /every (\w+)/.exec(t)[1], raw: /every \w+/.exec(t)[0] };
  }
  if ((m = /\bsince\s+(the\s+)?([a-z' ]+?)(?:[,.]|$)/.exec(t))) {
    return { kind: 'since-event', anchor: m[2].trim(), raw: m[0].trim() };
  }
  if ((m = /\bafter\s+(the\s+)?([a-z' ]+?)(?:[,.]|$)/.exec(t))) {
    return { kind: 'after-event', anchor: m[2].trim(), raw: m[0].trim() };
  }
  if (/\btomorrow\b/.test(t)) return { kind: 'relative', offset: 1, unit: 'day', raw: 'tomorrow' };
  if (/\byesterday\b/.test(t)) return { kind: 'relative', offset: -1, unit: 'day', raw: 'yesterday' };
  if (/\bfor years\b|\bfor a long time\b/.test(t)) return { kind: 'vague-duration', raw: 'for years' };
  return null;
}

// ------------------------------------------------------------ name finding --
/**
 * First pass over the whole corpus: who and what is named. Proper names are
 * capitalised tokens that are not merely sentence-initial; places are also
 * recognised from definite descriptions ("the old crossing") because most
 * worlds name their places that way rather than with capitals.
 */
export function gazetteer(corpus) {
  const proper = new Map();     // surface -> count
  const definite = new Map();
  for (const p of corpus.all()) {
    const words = p.text.split(/\s+/);
    words.forEach((w, i) => {
      // Keep digits: "Resident0" and "Resident1" are two people, not one
      // person named "Resident" mentioned ten thousand times.
      const clean = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, '');
      if (!/^[A-Z][\p{L}\p{N}']+$/u.test(clean)) return;
      if (i === 0 && STOP_CAPS.has(clean)) return;
      if (STOP_CAPS.has(clean) && i !== 0) return;
      if (i === 0) {
        // Sentence-initial: only trust it if it appears capitalised elsewhere too.
        proper.set(clean, (proper.get(clean) || 0) + 0.4);
      } else {
        proper.set(clean, (proper.get(clean) || 0) + 1);
      }
    });
    const re = /\b(?:the|The)\s+((?:[a-z]+\s+){0,2}(?:mill|river|bridge|crossing|kiosk|field|school|station|market|church|road|street|square|hall|dam|channel|bend|shop|yard|well|quarry|pier|forest|orchard|cemetery|ferry|junction|bakery|clinic|library|works|factory|warehouse|lane|path|gate|tower|chapel|bank))\b/g;
    let m;
    while ((m = re.exec(p.text))) {
      const key = m[1].toLowerCase().trim();
      definite.set(key, (definite.get(key) || 0) + 1);
    }
    if (p.speaker) proper.set(p.speaker, (proper.get(p.speaker) || 0) + 2);
  }
  return {
    // A name that only ever appears at the start of a sentence is still a name.
    // Requiring a mid-sentence occurrence silently erased every person in a
    // register or census, which is exactly the shape of a real archive.
    people: [...proper.entries()].filter(([, n]) => n >= 0.4).map(([n]) => n),
    places: [...definite.entries()].map(([n]) => n),
    weak: [...proper.entries()].filter(([, n]) => n < 1).map(([n]) => n),
  };
}

// ------------------------------------------------------------------ rules ---
/**
 * Each rule is a named pattern with an explicit emitter. The rule name travels
 * with every statement it produces, so "why does the motor believe this?" always
 * has an answer that is not "the model said so".
 */
const RULES = [
  {
    name: 'estrangement',
    re: /^(.+?) (?:has|have|had) not (?:spoken|talked|been in touch) (?:to|with) (.+?)(?: since (.+?))?[.]?$/i,
    emit: (m, c) => [
      c.rel(m[1], 'ESTRANGED_FROM', m[2], { time: m[3] ? parseTime(`since ${m[3]}`) : null, symmetric: true }),
    ],
  },
  {
    name: 'avoidance',
    re: /^(.+?) (?:has|have) avoided (.+?)(?: since (.+?))?[.]?$/i,
    emit: (m, c) => [c.rel(m[1], 'AVOIDS', m[2], { time: m[3] ? parseTime(`since ${m[3]}`) : null })],
  },
  {
    name: 'refusal',
    re: /^(.+?) (?:will not|won't|refuses to|refused to) (.+?)[.]?$/i,
    emit: (m, c) => [c.claim(m[1], 'REFUSES', m[2].trim())],
  },
  {
    name: 'occupation',
    re: /^(.+?) (runs|owns|keeps|manages|works at|works for|works in|teaches at|drives) (?:the |a )?(.+?)[.]?$/i,
    emit: (m, c) => {
      const verb = m[2].toLowerCase();
      const pred = verb === 'owns' ? 'OWNS' : /works|teaches/.test(verb) ? 'WORKS_AT' : 'RUNS';
      return [c.rel(m[1], pred, m[3], { objectKind: 'place' })];
    },
  },
  {
    name: 'spatial',
    // an optional direction adverb: "the river bends east below the old crossing"
    re: /^(?:the )?(.+?) (stands|sits|lies|runs|bends|flows|is|are)(?:\s+(?:east|west|north|south|left|right|inland|seaward))?\s+(beside|next to|behind|above|below|under|beneath|near|across from|opposite|at|on|by|along|from)\s+(?:the |a )?(.+?)[.]?$/i,
    emit: (m, c) => [c.rel(m[1], 'SPATIAL', m[4], { relation: m[3].toLowerCase(), subjectKind: 'place', objectKind: 'place' })],
  },
  {
    name: 'belief',
    re: /^(.+?) (believes|thinks|is convinced|maintains|insists|says|claims|reckons) (?:that )?(.+?)[.]?$/i,
    emit: (m, c) => [c.belief(m[1], m[3], /says|claims|insists/i.test(m[2]) ? 'stated' : 'held')],
  },
  {
    name: 'differing-memory',
    re: /^(.+?) remembers? (.+?) differently (?:from|than) (.+?)[.]?$/i,
    emit: (m, c) => [c.dispute([m[1], m[3]], m[2])],
  },
  {
    name: 'disagreement',
    re: /^(.+?)(?:,)? (?:though|although|but) (.+?) disagree(?:s)? about (.+?)[.]?$/i,
    emit: (m, c) => [...c.parseInner(m[1]), c.dispute([m[2]], m[3], { open: true })],
  },
  {
    name: 'memory',
    re: /^(.+?) remembers? (?:the )?(.+?)[.]?$/i,
    emit: (m, c) => [c.memory(m[1], m[2])],
  },
  {
    name: 'fear-desire',
    re: /^(.+?) (fears|is afraid of|wants|needs|hopes for|longs for|dreads) (?:the |a )?(.+?)[.]?$/i,
    emit: (m, c) => {
      const v = m[2].toLowerCase();
      return [c.claim(m[1], /fear|afraid|dread/.test(v) ? 'FEARS' : 'WANTS', m[3])];
    },
  },
  {
    name: 'promise',
    re: /^(.+?) (?:promised|swore to|agreed with) (.+?) (?:that |to )(.+?)[.]?$/i,
    emit: (m, c) => [c.rel(m[1], 'PROMISED', m[2], { content: m[3] })],
  },
  {
    name: 'transmission',
    re: /^(.+?) told (.+?) (?:that |about )(.+?)[.]?$/i,
    emit: (m, c) => [c.transmission(m[1], m[2], m[3])],
  },
  {
    name: 'secret',
    re: /^(?:only |no one but )(.+?) knows (?:that |about )?(.+?)[.]?$/i,
    emit: (m, c) => [c.secret(m[1], m[2])],
  },
  {
    name: 'secret-negative',
    re: /^(.+?) (?:has|have) never told anyone (?:that |about )?(.+?)[.]?$/i,
    emit: (m, c) => [c.secret(m[1], m[2])],
  },
  {
    name: 'closure',
    re: /^(?:the )?(.+?) (?:has been |was |is )?(closed|shut|abandoned|demolished|opened|reopened|built)(?: (?:down|up))?(?: (?:in|since) (\d{4}|.+?))?[.]?$/i,
    emit: (m, c) => [c.claim(m[1], m[2].toUpperCase().replace(/SHUT/, 'CLOSED'), true, {
      time: m[3] ? parseTime(m[3]) : parseTime(c.sentence), subjectKind: 'place',
    })],
  },
  {
    name: 'life-event',
    re: /^(.+?) (?:was )?(born|died|disappeared|left|returned|arrived)(?: in| on| at)? ?(.*?)[.]?$/i,
    emit: (m, c) => [c.claim(m[1], m[2].toUpperCase(), m[3] || true, { time: parseTime(c.sentence) })],
  },
  {
    name: 'habitual',
    re: /^(.+?) (cross|crosses|walk|walks|gather|gathers|meet|meets|pass|passes|come|comes|go|goes) (?:the |to the |through the |across the )?(.+?) (after|before|every|each|on) (.+?)[.]?$/i,
    emit: (m, c) => [c.schedule(m[1], m[3], `${m[4]} ${m[5]}`)],
  },
  {
    name: 'attendance',
    re: /^(?:both )?(.+?) and (.+?) (?:will )?(?:attend|come to|go to|are at) (?:the )?(.+?)[.]?$/i,
    emit: (m, c) => [c.schedule(m[1], m[3], parseTime(c.sentence)?.raw || 'unspecified'),
                     c.schedule(m[2], m[3], parseTime(c.sentence)?.raw || 'unspecified')],
  },
  {
    name: 'copula',
    re: /^(?:the )?(.+?) (?:is|was|are|were) (?:a |an |the )?(.+?)[.]?$/i,
    emit: (m, c) => [c.claim(m[1], 'IS', m[2])],
  },
];

// --------------------------------------------------------------- the pass ---
/**
 * Index a corpus into WorldText. Returns a report — including, importantly, what
 * it failed to understand.
 */
export function index(world, { branch = 'CANON' } = {}) {
  const gaz = gazetteer(world.corpus);
  const weak = new Set(gaz.weak || []);
  for (const name of gaz.people) {
    // "Children" is a group, "Mill" is a place, "Miriam" is a person.
    const kind = GROUP_WORDS.test(name) ? 'group' : PLACE_WORDS.test(name) ? 'place' : 'person';
    const e = world.ensureEntity(name, kind);
    if (weak.has(name)) e.namedOnlyAtSentenceStart = true;
  }
  for (const place of gaz.places) world.ensureEntity(place, 'place');

  const report = { parsed: 0, unparsed: 0, statements: 0, byRule: {}, unparsedSamples: [] };

  for (const passage of world.corpus.all()) {
    const ctx = makeContext(world, passage, branch, gaz);
    const sentence = stripLead(passage.text);
    let fired = null;

    for (const rule of RULES) {
      const m = rule.re.exec(sentence);
      if (!m) continue;
      ctx.rule = rule.name;
      ctx.sentence = passage.text;
      const produced = rule.emit(m, ctx).flat().filter(Boolean);
      if (!produced.length) continue;
      fired = rule.name;
      report.statements += produced.length;
      report.byRule[rule.name] = (report.byRule[rule.name] || 0) + produced.length;
      break;
    }

    // Mentions are recorded whether or not a rule fired: the corpus is sacred,
    // and an unparsed sentence still tells us who is spoken of (§3).
    for (const e of ctx.mentioned()) {
      if (!e.mentions.includes(passage.id)) e.mentions.push(passage.id);
    }

    if (fired) report.parsed++;
    else {
      report.unparsed++;
      if (report.unparsedSamples.length < 12) report.unparsedSamples.push(passage.text);
    }
    passage.parsedBy = fired;
  }

  world.note('index', { report });
  return report;
}

function stripLead(text) {
  return text.replace(/^(?:and|but|then|so|yet)\s+/i, '').trim();
}

/** The emitter API each rule uses. Everything it makes is provenance-bearing. */
function makeContext(world, passage, branch, gaz) {
  const speaker = passage.speaker ? world.ensureEntity(passage.speaker, 'person') : null;
  const seen = new Set();

  const resolve = (phrase, kindHint = null) => {
    const raw = stripTrailingTime(String(phrase).trim().replace(/^(the|a|an)\s+/i, '').replace(/[.,;:]$/, ''));
    if (!raw) return null;
    const existing = world.entity(raw);
    if (existing) { seen.add(existing.id); return existing.id; }
    let kind = kindHint;
    if (!kind) {
      if (GROUP_WORDS.test(raw)) kind = 'group';
      else if (PLACE_WORDS.test(raw)) kind = 'place';
      else if (/^[A-Z]/.test(raw.trim()) && raw.split(/\s+/).length <= 3) kind = 'person';
      else kind = 'thing';
    }
    const e = world.ensureEntity(raw, kind);
    seen.add(e.id);
    return e.id;
  };

  const base = (extra = {}) => ({
    branch,
    raw: passage.text,
    provenance: { passageId: passage.id, rule: ctx.rule },
    epistemic: speaker ? EPISTEMIC.BELIEF : EPISTEMIC.SOURCE,
    holder: speaker ? speaker.id : null,
    ...extra,
  });

  const ctx = {
    rule: null,
    sentence: passage.text,
    speaker,
    mentioned: () => [...seen].map((id) => world.entities.get(id)).filter(Boolean),

    claim(subject, predicate, object, extra = {}) {
      const s = resolve(subject, extra.subjectKind);
      if (!s) return null;
      return world.assert(base({
        kind: 'claim', subject: s, predicate,
        object: typeof object === 'string' ? (resolve(object, extra.objectKind) || object) : object,
        time: extra.time || parseTime(passage.text), ...strip(extra),
      }));
    },

    rel(subject, predicate, object, extra = {}) {
      const s = resolve(subject, extra.subjectKind);
      const o = resolve(object, extra.objectKind);
      if (!s || !o) return null;
      const out = [world.assert(base({
        kind: 'relation', subject: s, predicate, object: o,
        time: extra.time || parseTime(passage.text),
        tags: extra.relation ? [extra.relation] : [], ...strip(extra),
      }))];
      if (extra.symmetric) {
        out.push(world.assert(base({
          kind: 'relation', subject: o, predicate, object: s,
          time: extra.time || parseTime(passage.text),
          epistemic: EPISTEMIC.INFERRED,
          provenance: { passageId: passage.id, rule: `${ctx.rule}:symmetry`, derivedFrom: [out[0].id] },
        })));
      }
      return out;
    },

    belief(holderName, content, mode) {
      const h = resolve(holderName, 'person');
      if (!h) return null;
      // A belief is not a fact. It is stored with its holder, and the thing
      // believed is parsed as far as it can be without being promoted.
      const inner = ctx.parseInner(content, { epistemic: EPISTEMIC.BELIEF, holder: h });
      const st = world.assert(base({
        kind: 'claim', epistemic: EPISTEMIC.BELIEF, holder: h,
        subject: h, predicate: mode === 'stated' ? 'STATES' : 'BELIEVES', object: content.trim(),
        tags: inner.map((s) => s.id),
      }));
      return [st, ...inner];
    },

    memory(holderName, content) {
      const h = resolve(holderName, 'person');
      if (!h) return null;
      return world.assert(base({
        kind: 'memory', epistemic: EPISTEMIC.MEMORY, holder: h,
        subject: h, predicate: 'REMEMBERS', object: content.trim(),
      }));
    },

    dispute(holderNames, topic, extra = {}) {
      const holders = holderNames.map((n) => resolve(n, GROUP_WORDS.test(n) ? 'group' : 'person')).filter(Boolean);
      return world.assert(base({
        kind: 'claim', epistemic: EPISTEMIC.SOURCE,
        subject: holders[0] || null, predicate: 'DISPUTES', object: topic.trim(),
        tags: ['contradiction', ...holders], ...extra,
      }));
    },

    transmission(fromName, toName, content) {
      const f = resolve(fromName, 'person');
      const t = resolve(toName, 'person');
      if (!f || !t) return null;
      return [
        world.assert(base({ kind: 'relation', subject: f, predicate: 'TOLD', object: t, tags: [content.trim()] })),
        // Being told is a knowledge path — this is what makes the secret test work.
        world.assert(base({
          kind: 'claim', epistemic: EPISTEMIC.RUMOUR, holder: t,
          subject: t, predicate: 'KNOWS', object: content.trim(),
          provenance: { passageId: passage.id, rule: `${ctx.rule}:transmission` },
        })),
      ];
    },

    secret(holderName, content) {
      const h = resolve(holderName, 'person');
      if (!h) return null;
      return [
        world.assert(base({ kind: 'claim', epistemic: EPISTEMIC.SOURCE, subject: h, predicate: 'KNOWS_SECRET', object: content.trim(), tags: ['secret'] })),
        world.assert(base({ kind: 'claim', epistemic: EPISTEMIC.SOURCE, subject: null, predicate: 'SECRET', object: content.trim(), tags: ['secret', h] })),
      ];
    },

    schedule(whoName, whereName, when) {
      const who = resolve(whoName, GROUP_WORDS.test(whoName) ? 'group' : 'person');
      const where = resolve(whereName, 'place');
      if (!who) return null;
      return world.assert(base({
        kind: 'schedule', subject: who, predicate: 'ATTENDS', object: where || String(whereName).trim(),
        time: typeof when === 'string' ? { kind: 'recurring', raw: when } : when,
      }));
    },

    /** Parse a clause found inside another sentence, without promoting it. */
    parseInner(clause, extra = {}) {
      const inner = stripLead(String(clause));
      for (const rule of RULES) {
        const m = rule.re.exec(inner);
        if (!m) continue;
        const prevRule = ctx.rule;
        ctx.rule = `${prevRule}>${rule.name}`;
        const produced = rule.emit(m, { ...ctx, ...extra }).flat().filter(Boolean);
        ctx.rule = prevRule;
        if (produced.length) {
          for (const st of produced) {
            if (extra.epistemic) st.epistemic = extra.epistemic;
            if (extra.holder) st.holder = extra.holder;
          }
          return produced;
        }
      }
      return [];
    },
  };
  return ctx;
}

function strip(extra) {
  const { subjectKind, objectKind, symmetric, relation, content, ...rest } = extra;
  if (content) rest.tags = [...(rest.tags || []), content];
  return rest;
}


/**
 * ESCALATION PASS (§60). Runs only over the sentences the deterministic rules
 * failed on, only if a model is configured, and only through the continuity
 * certificate. With no model this is a no-op and the world is unchanged — which
 * is the zero-LLM test passing rather than a degraded mode.
 */
export async function indexWithModel(world, { branch = 'CANON', limit = 200, allowInvention = false } = {}) {
  const report = { attempted: 0, admitted: 0, refused: 0, byVerdict: {}, refusals: [] };
  if (!getModel()) return { ...report, skipped: 'no model configured' };

  const predicates = [...new Set([...world.statements.values()].map((s) => s.predicate))];
  const unparsed = world.corpus.all().filter((p) => !p.parsedBy).slice(0, limit);

  for (const passage of unparsed) {
    report.attempted++;
    const { candidates, error } = await escalateParse(world, passage, { predicates });
    if (error) { report.refusals.push({ passage: passage.id, why: error }); continue; }
    for (const c of candidates) {
      const verdict = admitParse(world, c, passage, { branch, allowInvention });
      report.byVerdict[verdict.verdict] = (report.byVerdict[verdict.verdict] || 0) + 1;
      if (verdict.verdict === VERDICT.ADMISSIBLE) {
        commitParse(world, verdict, passage, { branch });
        report.admitted++;
        passage.parsedBy = 'model-escalation';
      } else {
        report.refused++;
        if (report.refusals.length < 20) {
          report.refusals.push({ passage: passage.id, text: passage.text, verdict: verdict.verdict, why: verdict.reasons[0] });
        }
      }
    }
  }
  world.note('index:model', { report });
  return report;
}
