// THE MODEL SEAM — §60 (routing law), §5 (may not counterfeit source), §81 (zero-LLM).
//
// A foundation model is an *escalation*, never the substrate. The motor answers
// what it can by lookup, rule, graph traversal and solver; it escalates only the
// two jobs those genuinely cannot do:
//
//   1. PARSE  — turn a sentence the deterministic front end failed on into
//               candidate semantic IR. Enters as GENERATED, cites its passage,
//               and must pass admission before it counts for anything.
//   2. VOICE  — say a compiled, boundary-checked answer in a person's own words.
//               The *content* is chosen by the motor from situated knowledge;
//               the model only phrases it, and the phrasing is re-checked.
//
// Provider-agnostic on purpose: Anthropic, any OpenAI-compatible endpoint
// (OpenAI, OpenRouter, vLLM, LM Studio), or a local Ollama. No key, no problem —
// the motor runs its deterministic path, which is the whole point of §81.

let ADAPTER = null;
const usage = { calls: 0, escalations: {}, tokensIn: 0, tokensOut: 0, failures: 0 };

export function setModel(adapter) { ADAPTER = adapter; return ADAPTER; }
export function getModel() { return ADAPTER; }
export function modelUsage() { return { ...usage, adapter: ADAPTER?.name || null }; }
export function clearModel() { ADAPTER = null; }

/**
 * Pick an adapter from the environment. Nothing here is required; a world with
 * no key is a world that runs.
 *
 *   ANTHROPIC_API_KEY   → Anthropic Messages API
 *   OPENAI_API_KEY      → OpenAI-compatible chat completions
 *   OPENAI_BASE_URL     → point the above at OpenRouter / vLLM / LM Studio
 *   OLLAMA_HOST         → local models, no key at all
 */
export function fromEnv(env = process.env) {
  if (env.ANTHROPIC_API_KEY) {
    return setModel(anthropic({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || 'claude-sonnet-5' }));
  }
  if (env.OPENAI_API_KEY || env.OPENAI_BASE_URL) {
    return setModel(openAICompatible({
      apiKey: env.OPENAI_API_KEY || 'none',
      baseURL: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      model: env.OPENAI_MODEL || 'gpt-4o-mini',
    }));
  }
  if (env.OLLAMA_HOST) {
    return setModel(openAICompatible({
      apiKey: 'none',
      baseURL: `${env.OLLAMA_HOST.replace(/\/$/, '')}/v1`,
      model: env.OLLAMA_MODEL || 'llama3.1',
    }));
  }
  return null;
}

// ------------------------------------------------------------- adapters -----
export function anthropic({ apiKey, model = 'claude-sonnet-5', maxTokens = 1024 }) {
  return {
    name: `anthropic:${model}`,
    model,
    async listModels() {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      });
      if (!res.ok) throw new Error(`models ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      return (j.data || []).map((m) => m.id).sort();
    },
    async complete({ system, prompt, temperature = 0 }) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model, max_tokens: maxTokens, temperature, system,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      usage.tokensIn += j.usage?.input_tokens || 0;
      usage.tokensOut += j.usage?.output_tokens || 0;
      return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    },
  };
}

export function openAICompatible({ apiKey, baseURL, model, maxTokens = 1024 }) {
  return {
    name: `openai-compatible:${model}`,
    model,
    baseURL,
    /** Ask the endpoint what it actually serves, so a model id is never a guess. */
    async listModels() {
      const res = await fetch(`${baseURL.replace(/\/$/, '')}/models`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`models ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      return (j.data || []).map((m) => m.id).sort();
    },
    async complete({ system, prompt, temperature = 0 }) {
      const res = await fetch(`${baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model, temperature, max_tokens: maxTokens,
          messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`model ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      usage.tokensIn += j.usage?.prompt_tokens || 0;
      usage.tokensOut += j.usage?.completion_tokens || 0;
      return j.choices?.[0]?.message?.content || '';
    },
  };
}

/**
 * Check the configured model really exists and really answers. Run this before
 * trusting a run: a mistyped model id otherwise shows up as an escalation that
 * quietly does nothing.
 */
export async function checkModel() {
  const adapter = ADAPTER;
  if (!adapter) return { ok: false, why: 'no model configured' };
  try {
    const text = await adapter.complete({ system: 'Reply with the single word: ready', prompt: 'ready?' });
    return { ok: true, adapter: adapter.name, replied: String(text).trim().slice(0, 40) };
  } catch (err) {
    let available = null;
    try { available = adapter.listModels ? (await adapter.listModels()).slice(0, 40) : null; } catch { /* endpoint may not list */ }
    return { ok: false, adapter: adapter.name, why: String(err.message || err), available };
  }
}

/** For tests: a deterministic stand-in that can be told exactly what to say. */
export function scriptedModel(script) {
  let i = 0;
  return {
    name: 'scripted',
    async complete() { return typeof script === 'function' ? script() : script[i++ % script.length]; },
  };
}

// ----------------------------------------------------------- escalations ----
const PARSE_SYSTEM = `You are the escalation path of a deterministic world compiler.
You will be given ONE sentence from a source document and the vocabulary of predicates the world already uses.
Return ONLY a JSON array of candidate statements. No prose, no markdown fence.
Each statement: {"subject":"<surface name>","predicate":"<UPPER_SNAKE>","object":"<surface name or literal>","holder":<null or surface name>,"kind":"claim|relation|memory|schedule","confidence":0..1}
Rules you must obey:
- Use ONLY what this sentence states. Do not add world knowledge, do not infer motives, do not invent names.
- If the sentence asserts nothing about the world, return [].
- Prefer an existing predicate from the list over inventing a new one.
- A belief or report must carry its holder; do not flatten it into a fact.`;

/**
 * Escalate one unparsed sentence. Returns *candidates*, not statements: nothing
 * enters the world until `admit()` in continuity.js accepts it, and even then it
 * enters as GENERATED with the model named in its provenance.
 */
export async function escalateParse(world, passage, { predicates = [] } = {}) {
  // Hold the adapter for the duration: swapping or clearing the model while a
  // call is in flight must not strand it half-way through.
  const adapter = ADAPTER;
  if (!adapter) return { candidates: [], skipped: 'no model configured' };
  usage.calls++;
  usage.escalations.parse = (usage.escalations.parse || 0) + 1;
  const prompt = [
    `Known predicates: ${predicates.join(', ') || '(none yet)'}`,
    `Document: ${world.corpus.doc(passage.docId)?.title || 'untitled'} (${world.corpus.doc(passage.docId)?.kind})`,
    passage.speaker ? `Spoken by: ${passage.speaker}` : 'Narration (no speaker).',
    `Sentence: ${passage.text}`,
  ].join('\n');
  let raw;
  try {
    raw = await adapter.complete({ system: PARSE_SYSTEM, prompt });
  } catch (err) {
    usage.failures++;
    return { candidates: [], error: String(err.message || err) };
  }
  const candidates = safeJSON(raw);
  if (!Array.isArray(candidates)) return { candidates: [], error: 'model did not return an array', raw };
  return {
    candidates: candidates.filter((c) => c && c.subject && c.predicate).map((c) => ({
      ...c,
      passageId: passage.id,
      modelId: adapter.name,
    })),
    raw,
  };
}

const VOICE_SYSTEM = `You are giving voice to one character in a world.
You will be given: the character's name, the situation, and THE COMPLETE LIST of things this character is entitled to say, already selected by the world engine.
Write their reply in one or two sentences, first person, in their own register.
Absolute rules:
- Use ONLY the supplied material. Introduce no fact, name, place, date or event that is not in it.
- If the material is empty, say plainly that they do not know.
- Do not narrate, do not add stage directions, do not speak for anyone else.
- Never reveal anything listed under WITHHELD.`;

/**
 * Escalate phrasing only. The motor has already decided *what* may be said; the
 * model chooses the words, and `admit()` re-checks the result against the same
 * knowledge boundary before it can become an utterance (§17, §68).
 */
export async function escalateVoice(world, context, answer, question) {
  const adapter = ADAPTER;
  if (!adapter) return { text: answer.text, phrased: false };
  usage.calls++;
  usage.escalations.voice = (usage.escalations.voice || 0) + 1;
  const material = answer.basis.map((b) => {
    const st = world.statements.get(b.statement);
    const src = st?.provenance.passageId ? world.corpus.quote(st.provenance.passageId) : null;
    return `- ${src ? `“${src.text}”` : st?.raw || ''} [${b.as}, known by: ${b.path}]`;
  }).join('\n');
  const withheld = answer.withheld ? `WITHHELD (never reveal): ${world.statements.get(answer.withheld.statement)?.object}` : 'WITHHELD: nothing';
  const prompt = [
    `Character: ${context.person.name}`,
    `Situation: ${context.situation.place ? `at ${context.situation.place}` : 'unspecified place'}${context.situation.occasion ? `, ${context.situation.occasion}` : ''}`,
    `Question put to them: ${question}`,
    `MATERIAL THEY MAY DRAW ON:\n${material || '(nothing)'}`,
    withheld,
  ].join('\n');
  try {
    const text = (await adapter.complete({ system: VOICE_SYSTEM, prompt, temperature: 0.4 })).trim();
    return { text, phrased: true, modelId: adapter.name };
  } catch (err) {
    usage.failures++;
    return { text: answer.text, phrased: false, error: String(err.message || err) };
  }
}

function safeJSON(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(cleaned); } catch { /* fall through */ }
  const m = /\[[\s\S]*\]/.exec(cleaned);
  if (m) { try { return JSON.parse(m[0]); } catch { /* give up honestly */ } }
  return null;
}
