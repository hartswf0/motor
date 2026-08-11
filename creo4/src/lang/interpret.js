// WORD → OPERATION (§7).
//
// Language is never compiled to meshes. It is compiled to INTENT, and the world
// engine decides what that intent can become. The default interpreter here is a
// deterministic grammar over the multilingual lexicon: it runs offline, it can be
// audited, and it is honest about what it did not understand. An LLM can be
// installed in front of it with setInterpreter() — but it may only produce the
// same Intent structure. It never gets to touch geometry.

import { tag, quantities, things, thingOf } from './lexicon.js';
import { resolveReference, filterByThing, explainReference } from './deixis.js';

export const OPERATIONS = ['OBSERVE', 'PROPOSE', 'MODIFY', 'RELATE', 'PRESERVE', 'REMOVE', 'BRANCH', 'MERGE', 'SIMULATE', 'ASK', 'MEASURE'];

let _interpreter = null;
/** Install an alternative front end (e.g. an LLM). It must return an Intent. */
export function setInterpreter(fn) { _interpreter = fn; }

const has = (t, tok) => t.tokens.some((h) => h.token === tok);
const at = (t, tok) => t.tokens.find((h) => h.token === tok)?.at ?? -1;

export function interpret(text, ctx) {
  if (_interpreter) return _interpreter(text, ctx, ruleInterpret);
  return ruleInterpret(text, ctx);
}

export function ruleInterpret(text, ctx) {
  const tagged = tag(text);
  const qty = quantities(text);
  const nouns = things(tagged);
  const thing = thingOf(tagged);
  const norm = tagged.norm;

  let reference = resolveReference(tagged, ctx);
  if (thing && (has(tagged, 'DEIXIS.these') || has(tagged, 'DEIXIS.this') || reference.kind === 'region')) {
    reference = filterByThing(reference, thing, ctx);
  }

  const intent = {
    original: text,                 // never translated, never overwritten (§24)
    lang: tagged.lang,
    norm,
    tagged,
    operation: null,
    secondary: null,
    reference,
    thing,
    things: nouns,
    quantities: qty,
    constraints: [],
    question: null,
    confidence: 0.5,
    needs: [],
    notes: [],
  };

  const isQuestion = /\?\s*$/.test(text.trim())
    || /^(what|why|who|where|which|how|can|is|does|nini|kwanini|nani|wapi|que|qué|por que|quien|donde|cuanto|quoi|pourquoi|combien)\b/.test(norm)
    // Interrogatives without a question mark: people rarely punctuate when speaking.
    || /\b(compare|comparar|difference between|what changed|tell me about|who made)\b/.test(norm);

  // "what happens when it rains" and "what if we remove the cars" are questions
  // in grammar and scenarios in substance. Asking first meant the two headline
  // features could never be reached by the phrasing people actually use.
  const wantsScenario = /\b(what happens|what if|as if|et si|e se|que pasa si|itakuwaje)\b/.test(norm);

  // ---- ASK ------------------------------------------------------------------
  if (isQuestion && !wantsScenario) {
    intent.operation = 'ASK';
    intent.question = classifyQuestion(norm, tagged);
    intent.confidence = 0.8;
    return finish(intent, ctx);
  }

  // ---- MEASURE --------------------------------------------------------------
  if (has(tagged, 'OP.measure')) {
    intent.operation = 'MEASURE';
    intent.confidence = 0.8;
    return finish(intent, ctx);
  }

  // ---- MERGE ("combine the trees from A and the buildings from B") ----------
  if (/\b(combine|merge|mix|take .* from)\b/.test(norm) && /\bfrom\b/.test(norm)) {
    intent.operation = 'MERGE';
    intent.secondary = 'GRAFT';
    intent.grafts = parseGrafts(norm, nouns);
    intent.confidence = intent.grafts.length ? 0.8 : 0.4;
    if (!intent.grafts.length) intent.needs.push('which branches to combine');
    return finish(intent, ctx);
  }

  // ---- SIMULATE / TIME ------------------------------------------------------
  // Mentioning rain is not asking to see it rain. "it floods here every rain" is
  // testimony; "show heavy rain" and "what happens when it rains" are requests.
  // A scenario also needs something to vary: weather, darkness or time. "What if
  // we remove the cars" asks for another world, not another weather.
  const hasScenarioSubject = has(tagged, 'Q.rain') || has(tagged, 'Q.night')
    || /\byears?\b|\bgrow\b|miaka|anos|años|\bans\b|\bsimulate\b|\bsimular\b/.test(norm);
  const scenarioAsk = hasScenarioSubject
    && (wantsScenario || has(tagged, 'OP.simulate')
        || /\b(show|run|simulate|onyesha|mostrar|montre|muestra)\b/.test(norm));
  if (scenarioAsk && !has(tagged, 'OP.observe')) {
    const isTemporal = /\byears?\b|\bgrow\b|\bafter\b|miaka|anos|años|ans/.test(norm);
    // "show this without cars" is a branch, not a simulation, even though it says "show".
    if (!(has(tagged, 'OP.branch') && has(tagged, 'Q.not'))) {
      intent.operation = 'SIMULATE';
      intent.secondary = isTemporal ? 'TEMPORAL' : (has(tagged, 'Q.rain') ? 'WATER' : has(tagged, 'Q.night') ? 'LIGHT' : 'WATER');
      intent.scenario = {
        rain: has(tagged, 'Q.rain') ? 'heavy' : null,
        night: has(tagged, 'Q.night') || null,
        years: isTemporal ? (qty.find((q) => !q.unit)?.value ?? 1) : null,
      };
      intent.confidence = 0.8;
      return finish(intent, ctx);
    }
  }

  // ---- BRANCH ---------------------------------------------------------------
  if ((has(tagged, 'OP.branch') || wantsScenario) && (/\b(what if|as if|option|alternative|futures?|version|without|e se|et si|que pasa si)\b/.test(norm) || has(tagged, 'Q.radical'))) {
    const subtractive = has(tagged, 'Q.not') || has(tagged, 'OP.remove')
      || /\b(without|sin|sem|sans|bila)\b/.test(norm);
    intent.operation = 'BRANCH';
    intent.secondary = subtractive ? 'TRANSFORM' : 'DIVERGE';
    const n = qty.find((q) => !q.unit && q.value >= 2 && q.value <= 8);
    intent.count = n ? Math.round(n.value) : (has(tagged, 'Q.radical') ? 3 : 1);
    if (subtractive && thing) intent.removeThing = thing;
    intent.confidence = 0.8;
    return finish(intent, ctx);
  }

  // ---- PRESERVE (+ REMOVE) --------------------------------------------------
  if (has(tagged, 'OP.preserve')) {
    intent.operation = 'PRESERVE';
    intent.confidence = 0.85;
    // "keep everything except this wall"
    const exceptAt = norm.search(/\b(except|but not|apart from|lakini si|excepto|sauf)\b/);
    if (exceptAt >= 0 || (has(tagged, 'Q.all') && has(tagged, 'Q.not'))) {
      intent.secondary = 'REMOVE';
      intent.scope = has(tagged, 'Q.all') ? 'all' : 'selection';
      intent.exceptFrom = exceptAt;
    }
    return finish(intent, ctx);
  }

  // ---- REMOVE ---------------------------------------------------------------
  if (has(tagged, 'OP.remove') && !has(tagged, 'OP.propose')) {
    intent.operation = 'REMOVE';
    intent.confidence = 0.8;
    return finish(intent, ctx);
  }

  // ---- RELATE ---------------------------------------------------------------
  if (has(tagged, 'OP.relate')) {
    intent.operation = 'RELATE';
    intent.secondary = 'BRIDGE';
    intent.confidence = reference.ids.length >= 2 ? 0.9 : 0.5;
    if (reference.ids.length < 2) intent.needs.push('two things to connect');
    return finish(intent, ctx);
  }

  // ---- OBSERVE (routes and conditions) --------------------------------------
  if (has(tagged, 'OP.walk') && /\b(actually|really|people|children|kids|watu|gente)\b/.test(norm)) {
    intent.operation = 'OBSERVE';
    intent.secondary = 'ROUTE';
    intent.confidence = 0.85;
    return finish(intent, ctx);
  }
  if (has(tagged, 'OP.observe') && !has(tagged, 'OP.propose')) {
    intent.operation = 'OBSERVE';
    intent.secondary = 'CONDITION';
    intent.condition = conditionOf(norm, tagged);
    intent.confidence = 0.85;
    return finish(intent, ctx);
  }

  // ---- MODIFY ---------------------------------------------------------------
  const comparative = has(tagged, 'Q.tall') || has(tagged, 'Q.wide') || has(tagged, 'Q.deep') || has(tagged, 'Q.long')
    || /\b(bigger|smaller|taller|shorter|wider|narrower|higher|lower)\b/.test(norm);
  const explicitDim = qty.some((q) => q.unit === 'm' || q.unit === 'cm' || q.unit === 'ft');
  if ((has(tagged, 'OP.modify') || comparative || explicitDim || /\bcontinue\b/.test(norm)) && reference.ids.length) {
    intent.operation = 'MODIFY';
    if (/\bcontinue\b/.test(norm)) intent.secondary = 'CONTINUE';
    else if (has(tagged, 'Q.tall') || /\bfloor|storey|story|ghorofa|piso|andar|etage\b/.test(norm)) intent.secondary = 'EXTRUDE';
    else if (has(tagged, 'Q.wide')) intent.secondary = 'WIDEN';
    else if (has(tagged, 'Q.deep')) intent.secondary = 'DEEPEN';
    else if (/\bmove|sogeza|mover|deplacer\b/.test(norm)) intent.secondary = 'MOVE';
    else intent.secondary = 'SET';
    intent.magnitude = magnitudeOf(tagged, qty, norm);
    intent.confidence = 0.85;
    return finish(intent, ctx);
  }

  // ---- statement vs. request ------------------------------------------------
  // Naming a thing is not asking for one. "all of this fills with water" is
  // testimony about the place; "we need a drain here" is a request of it. Only
  // an explicit asking verb — or a bare elliptical phrase like "trees here" —
  // may become geometry.
  const declarative = /\b(is|are|was|were|isn't|aren't|fills|filling|floods|gets|got|becomes|comes|goes|stays|stands|always|never|every|when|whenever|because|used to|there is|there are)\b/.test(norm)
    || /\b(kuna|iko|ni|hakuna|hay|está|esta|son|há|ha|il y a|c'est)\b/.test(norm);
  const elliptical = norm.split(' ').length <= 4 && thing && !declarative;

  if (has(tagged, 'OP.propose') || elliptical) {
    intent.operation = 'PROPOSE';
    intent.secondary = thing === 'tree' || thing === 'garden' ? 'PLANT' : 'PLACE';
    intent.count = countOf(qty, thing);
    intent.dimensions = dimensionsOf(qty);
    intent.confidence = thing ? 0.8 : 0.45;
    if (!thing) intent.needs.push('what to put there');
    return finish(intent, ctx);
  }

  // ---- fallback: a statement about the place is an observation --------------
  intent.operation = 'OBSERVE';
  intent.secondary = 'CONDITION';
  intent.condition = conditionOf(norm, tagged);
  intent.confidence = 0.45;
  intent.notes.push('understood as a general observation');
  return finish(intent, ctx);
}

function finish(intent, ctx) {
  // Negative constraints: "…but don't block those windows"
  const norm = intent.norm;
  if (/\b(dont|don't|do not|without|avoid|but not|usiweke|sin|sans|bila)\b/.test(norm) &&
      /\b(block|blocks|blocking|cover|covering|obstruct|shade|ziba|bloquear|tapar|bloquer)\b/.test(norm)) {
    const targetThing = lastThingAfter(norm, /\b(block|blocks|blocking|cover|covering|obstruct|ziba|bloquear|bloquer)\b/, intent.things);
    intent.constraints.push({
      kind: 'DONT_BLOCK',
      thing: targetThing || null,
      raw: norm.slice(norm.search(/\b(dont|don't|do not|without|avoid|but not)\b/)),
    });
  }
  if (/\b(keep|preserve|protect|acha|mantener|garder)\b/.test(norm) && intent.operation !== 'PRESERVE') {
    intent.constraints.push({ kind: 'PRESERVE', thing: lastThingAfter(norm, /\b(keep|preserve|protect)\b/, intent.things) || null });
  }
  if (intent.reference.kind === 'none') {
    intent.needs.push('a reference — ' + intent.reference.ambiguity.question);
    intent.confidence = Math.min(intent.confidence, 0.3);
  }
  intent.explanation = explainReference(intent.reference, ctx.world);
  return intent;
}

function classifyQuestion(norm, tagged) {
  if (/\bwhy\b|kwanini|por que|pourquoi/.test(norm)) {
    if (/\bcan'?t|cannot|can not|no puedo/.test(norm)) return { kind: 'why-not', raw: norm };
    return { kind: 'why', raw: norm };
  }
  if (/\bwho\b|nani|quien|quem|qui\b/.test(norm)) return { kind: 'who', raw: norm };
  if (/\bcompare\b|comparar/.test(norm)) return { kind: 'compare', raw: norm };
  if (/\bwhat changed|what is different|what's different|que cambio/.test(norm)) return { kind: 'changed', raw: norm };
  if (/\bwhere can|where could|fit\b/.test(norm)) return { kind: 'where-fit', raw: norm };
  if (/\bwhat blocks|blocks this|what is blocking/.test(norm)) return { kind: 'what-blocks', raw: norm };
  if (/\bwhat would this remove|what does this remove/.test(norm)) return { kind: 'what-removes', raw: norm };
  if (/\bhow many|how much|ngapi|cuanto|combien/.test(norm)) return { kind: 'how-many', raw: norm };
  if (/\bwhere\b|wapi|donde|où/.test(norm)) return { kind: 'where', raw: norm };
  if (/\bwhich\b|floods?|flood|shade|dark|disputed/.test(norm)) return { kind: 'which', raw: norm };
  return { kind: 'what', raw: norm };
}

function conditionOf(norm, tagged) {
  if (/\bflood|water|maji|inunda|alaga|mafuriko|mvua\b/.test(norm)) return 'flooding';
  if (/\bdark|night|giza|oscuro|noite\b/.test(norm)) return 'darkness';
  if (/\bnoise|noisy|loud\b/.test(norm)) return 'noise';
  if (/\bdust|dusty\b/.test(norm)) return 'dust';
  if (/\bunsafe|danger|hatari|peligroso\b/.test(norm)) return 'safety';
  if (/\bsell|market|trade|soko\b/.test(norm)) return 'use';
  if (/\bwalk|pass|njia|shortcut\b/.test(norm)) return 'movement';
  return 'general';
}

function magnitudeOf(tagged, qty, norm) {
  const abs = qty.find((q) => q.unit === 'm' || q.unit === 'cm' || q.unit === 'ft');
  // "3 m taller" is a change of three metres; "3 m tall" is a height of three.
  const comparative = /\b(taller|shorter|wider|narrower|higher|lower|deeper|longer|bigger|smaller|more|less)\b/.test(norm);
  if (abs && comparative) return { kind: 'delta', metres: abs.metres * (/\b(shorter|narrower|lower|smaller|less)\b/.test(norm) ? -1 : 1), raw: `${abs.value}${abs.unit || ''}` };
  if (abs) return { kind: 'absolute', metres: abs.metres, raw: `${abs.value}${abs.unit || ''}` };
  if (has(tagged, 'Q.twice') || /\bdouble\b/.test(norm)) return { kind: 'factor', factor: 2 };
  if (has(tagged, 'Q.half')) return { kind: 'factor', factor: 0.5 };
  const floors = /\b(\d+)\s*(floor|storey|story|level|ghorofa|piso|andar)/.exec(norm);
  if (floors) return { kind: 'floors', floors: parseInt(floors[1], 10) };
  if (/\banother (floor|storey|story|level)\b|\bone more (floor|storey)\b/.test(norm)) return { kind: 'floors', floors: 1 };
  const n = qty.find((q) => !q.unit);
  if (n && /\btimes\b/.test(norm)) return { kind: 'factor', factor: n.value };
  return { kind: 'step', step: /\bsmaller|shorter|lower|narrow/.test(norm) ? -1 : 1 };
}

function countOf(qty, thing) {
  const n = qty.find((q) => !q.unit && q.value >= 1 && q.value <= 200);
  if (n) return Math.round(n.value);
  return thing === 'tree' ? 5 : 1;
}

function dimensionsOf(qty) {
  const dims = qty.filter((q) => q.unit === 'm' || q.unit === 'cm' || q.unit === 'ft').map((q) => q.metres);
  if (!dims.length) return null;
  return { width: dims[0], depth: dims[1] ?? null, height: dims[2] ?? null, raw: dims };
}

function lastThingAfter(norm, re, nouns) {
  const m = re.exec(norm);
  if (!m) return nouns[nouns.length - 1] || null;
  const tail = norm.slice(m.index);
  for (const n of nouns) if (tail.includes(n) || tail.includes(n + 's')) return n;
  return nouns[nouns.length - 1] || null;
}

/** "combine the trees from A, the buildings from B, and the path from C" */
function parseGrafts(norm, nouns) {
  const out = [];
  const re = /(?:the\s+)?([a-z]+)\s+from\s+([a-z0-9_ ]+?)(?=[,]|\s+and\b|$)/g;
  let m;
  while ((m = re.exec(norm))) {
    out.push({ thing: m[1].replace(/s$/, ''), branchHint: m[2].trim() });
  }
  return out;
}
