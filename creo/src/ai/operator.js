// THE ASSISTANT AS AN OPERATOR OF THE INTERFACE.
//
// A model here does not draw geometry and does not decide what is true. It does
// what a person does with their hands: looks at what is in view, points, circles
// an area, traces a line, selects things, and says an ordinary sentence. Those
// operations then run through the identical pipeline a human tap produces —
// deixis, intent, world query, ghost, certificate — so everything the assistant
// proposes still has to survive the place's own objections, and still waits for
// a person to accept it.
//
// This is the point of §7 taken seriously: the model interprets, the world
// engine executes. Nothing it returns can bypass the certificate, invent an
// entity id, or place a point outside the place.

import * as G from '../core/geom.js';

// ------------------------------------------------------------------ model ---
const KEY_STORE = 'creo.ai.key';
const CFG_STORE = 'creo.ai.config';

// Defaults CREO used to ship. If one of these is still sitting in a browser it
// is a leftover, not a choice, and it is why an old model looked like the only
// option — clear it so the endpoint gets asked instead.
const STALE_DEFAULTS = new Set(['gpt-4o-mini', 'gpt-4o', 'gpt-4', 'gpt-3.5-turbo']);

export function getConfig() {
  try {
    const cfg = { key: localStorage.getItem(KEY_STORE) || '', ...JSON.parse(localStorage.getItem(CFG_STORE) || '{}') };
    if (cfg.model && STALE_DEFAULTS.has(cfg.model) && !cfg.modelChosen) cfg.model = '';
    return cfg;
  } catch { return { key: '' }; }
}
export function setConfig(patch = {}) {
  if (patch.key !== undefined) localStorage.setItem(KEY_STORE, patch.key);
  const cfg = getConfig();
  const next = {
    baseURL: patch.baseURL ?? cfg.baseURL ?? 'https://api.openai.com/v1',
    // No hardcoded default model. Whatever the endpoint reports is the truth;
    // shipping a stale id was why an old model was the only thing on offer.
    model: patch.model ?? cfg.model ?? '',
    // once a model is picked from the endpoint's own list it is a real choice
    modelChosen: patch.model ? true : (cfg.modelChosen ?? false),
    provider: patch.provider ?? cfg.provider ?? 'openai',
    effort: patch.effort ?? cfg.effort ?? 'medium',
    vision: patch.vision ?? cfg.vision ?? 'auto',
    api: patch.api ?? cfg.api ?? 'auto',
  };
  localStorage.setItem(CFG_STORE, JSON.stringify(next));
  return next;
}

/**
 * Profiles are (model × reasoning effort × how much it sees). The model is
 * whichever id you chose from your own endpoint — CREO does not decide which
 * models exist, it asks.
 */
export const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
export const PROFILES = [
  { key: 'fast', label: 'Fast', effort: 'low', vision: 'never', note: 'interface commands, no screenshot' },
  { key: 'normal', label: 'Normal', effort: 'medium', vision: 'auto', note: 'the everyday world agent' },
  { key: 'deep', label: 'Deep', effort: 'high', vision: 'auto', note: 'diagnosis and why-questions' },
  { key: 'max', label: 'Exhaustive', effort: 'max', vision: 'always', note: 'slow, for hard spatial problems' },
];

/** Route by what was asked, rather than paying for maximum reasoning always. */
export function effortFor(text, fallback = 'medium') {
  const t = String(text).toLowerCase();
  if (/^(select|show|hide|zoom|go to|take me|look)/.test(t)) return 'low';
  if (/(why|what happens|compare|best|solve|flood|instead|without)/.test(t)) return 'high';
  if (/(build|move|plant|drain|connect|remove|put|add)/.test(t)) return 'medium';
  return fallback;
}

/** Every call records what it cost, so profiles can be compared rather than felt. */
export const telemetry = [];
export function lastCalls(n = 12) { return telemetry.slice(-n); }
export const hasKey = () => !!getConfig().key;

/** Ask the endpoint what it serves, so a model id is never a guess. */
export async function listModels() {
  const { key, baseURL, provider } = getConfig();
  if (!key) throw new Error('no key configured');
  if (provider === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    });
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 120)}`);
    return (await r.json()).data.map((m) => m.id).sort();
  }
  const r = await fetch(`${(baseURL || 'https://api.openai.com/v1').replace(/\/$/, '')}/models`, {
    headers: { authorization: `Bearer ${key}` },
  });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 120)}`);
  return (await r.json()).data.map((m) => m.id).sort();
}

async function complete({ system, prompt, image = null, effort = null }) {
  const cfg = getConfig();
  const { key, baseURL, model, provider } = cfg;
  if (!key) throw new Error('no API key configured');
  if (!model) throw new Error('no model chosen — open the panel and pick one from your endpoint');
  const started = performance.now();
  const record = (api, usage) => {
    telemetry.push({
      at: Date.now(), model, api, effort: effort || cfg.effort,
      ms: Math.round(performance.now() - started),
      inTokens: usage?.input_tokens ?? usage?.prompt_tokens ?? null,
      outTokens: usage?.output_tokens ?? usage?.completion_tokens ?? null,
      vision: !!image,
    });
  };

  if (provider === 'anthropic') {
    const content = [{ type: 'text', text: prompt }];
    if (image) content.unshift({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.split(',')[1] } });
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model, max_tokens: 2000, temperature: 0, system, messages: [{ role: 'user', content }] }),
    });
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    record('messages', j.usage);
    return j.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  }

  const base = (baseURL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const content = [{ type: 'input_text', text: prompt }];
  if (image) content.push({ type: 'input_image', image_url: image, detail: 'low' });

  // The reasoning/responses surface where it exists, chat completions where it
  // does not. Which one worked is remembered so the fallback is paid for once.
  if (cfg.api !== 'chat') {
    try {
      const r = await fetch(`${base}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          instructions: system,
          input: [{ role: 'user', content }],
          ...(effort || cfg.effort ? { reasoning: { effort: effort || cfg.effort } } : {}),
          text: { verbosity: 'low' },
        }),
      });
      if (r.ok) {
        const j = await r.json();
        record('responses', j.usage);
        if (cfg.api !== 'responses') setConfig({ api: 'responses' });
        const text = j.output_text
          ?? (j.output || []).flatMap((o) => (o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text)).join('');
        if (text) return text;
      } else if (r.status !== 404 && r.status !== 400) {
        throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
      } else {
        setConfig({ api: 'chat' });
      }
    } catch (err) {
      if (!/fetch|404|400/i.test(String(err.message))) throw err;
      setConfig({ api: 'chat' });
    }
  }

  const msgContent = image
    ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image, detail: 'low' } }]
    : prompt;
  const r2 = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: msgContent }],
    }),
  });
  if (!r2.ok) throw new Error(`${r2.status}: ${(await r2.text()).slice(0, 200)}`);
  const j2 = await r2.json();
  record('chat', j2.usage);
  return j2.choices[0].message.content;
}

// ----------------------------------------------------------------- digest ---
/**
 * What the assistant is allowed to see: the place around the camera, bounded.
 * Not the whole world — a dense quarter is thousands of buildings, and a model
 * given all of them will reason about the wrong ones.
 */
export function digest(world, { camera, selection = [], pointer = null, limit = 90 }) {
  const focus = [camera.target[0], camera.target[1]];
  const radius = Math.max(80, camera.dist * 0.9);
  const near = world.index.near(focus, radius);
  const seen = new Set();
  const rows = [];

  for (const hit of near) {
    if (rows.length >= limit) break;
    const e = world.get(hit.id);
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    if (['opening', 'furniture', 'room'].includes(e.type)) continue;
    const ring = world.ringOf(e);
    if (!ring) continue;
    const c = G.centroid(ring);
    const ob = G.orientedBounds(ring);
    rows.push({
      id: e.id,
      type: e.type + (e.subtype ? `/${e.subtype}` : ''),
      name: e.name && e.name !== 'Building' ? e.name : undefined,
      use: e.use || undefined,
      at: [Math.round(c[0]), Math.round(c[1])],
      size: `${ob.width.toFixed(0)}x${ob.depth.toFixed(0)}m`,
      height: e.zTop - e.zBase > 0.4 ? `${(e.zTop - e.zBase).toFixed(0)}m` : undefined,
      said: e.type === 'observation' ? (e.evidence?.[0]?.text || e.name) : undefined,
    });
  }

  const b = world.place.bounds();
  return {
    place: world.place.name,
    bounds: { x: [Math.round(b[0]), Math.round(b[2])], y: [Math.round(b[1]), Math.round(b[3])] },
    units: 'metres, local grid; +x is east, +y is north',
    camera: { looking_at: [Math.round(focus[0]), Math.round(focus[1])], height_of_view: Math.round(camera.dist) },
    selection,
    pointer: pointer ? [Math.round(pointer[0]), Math.round(pointer[1])] : null,
    ground: world.place.terrain ? { relief_m: +(Math.max(...world.place.terrain.data)).toFixed(1) } : null,
    nearby: rows,
    truncated: near.length > rows.length ? `${near.length - rows.length} more things not listed` : undefined,
  };
}

// -------------------------------------------------------------- the prompt --
const SYSTEM = `You operate a spatial design tool called CREO. You are not drawing geometry and you are not deciding what is true about the place — you are working the interface the way a person works it with their hands.

You will be given the user's request and a digest of what is currently in view: named things with ids, positions in metres on a local grid, and sizes.

Return ONLY a JSON object of this shape:
{"reasoning":"<one short sentence>","operations":[ ... ]}

Each operation is one of:
  {"op":"look","at":[x,y],"distance":<metres>}          move the view
  {"op":"point","at":[x,y]}                              tap a location
  {"op":"select","ids":["..."]}                          select existing things by id
  {"op":"circle","points":[[x,y],[x,y],...]}             draw a closed area (4-12 points)
  {"op":"line","points":[[x,y],[x,y],...]}               trace a route (2-12 points)
  {"op":"say","text":"<an ordinary sentence>"}           speak to the place
  {"op":"note","at":[x,y],"text":"<what you observed>"}  leave an observation

Rules you must follow:
- Every id must appear in the digest. Never invent one.
- Every coordinate must lie inside the stated bounds.
- Prefer selecting a named thing over circling near it.
- A "circle" is for an AREA the request is about; a "line" is for a ROUTE.
- Put the gesture BEFORE the sentence: circle or select first, then say. The tool resolves "this" and "here" from what you just indicated.
- Sentences must be plain English of the kind a resident would use: "this floods when it rains", "we need a drain here", "there should be trees here", "connect these", "why is this here?".
- Do not propose more than one intervention per request.
- If the request cannot be grounded in what is in view, return an empty operations list and say why in reasoning.`;

// -------------------------------------------------------------- validation --
const OPS = new Set(['look', 'point', 'select', 'circle', 'line', 'say', 'note']);

/** Nothing reaches the world until it has been checked against the world. */
export function validate(world, ops, digestObj) {
  const known = new Set(digestObj.nearby.map((r) => r.id));
  const b = world.place.bounds();
  const inBounds = ([x, y]) => Number.isFinite(x) && Number.isFinite(y)
    && x >= b[0] - 50 && x <= b[2] + 50 && y >= b[1] - 50 && y <= b[3] + 50;

  const ok = [];
  const refused = [];
  for (const raw of ops || []) {
    const op = raw && raw.op;
    if (!OPS.has(op)) { refused.push({ raw, why: `unknown operation "${op}"` }); continue; }
    if (op === 'select') {
      const ids = (raw.ids || []).filter((id) => world.get(id));
      const bad = (raw.ids || []).filter((id) => !world.get(id));
      if (bad.length) refused.push({ raw, why: `no such thing: ${bad.join(', ')}` });
      if (!ids.length) continue;
      if (ids.some((id) => !known.has(id))) refused.push({ raw, why: 'selected something that was not in view' });
      ok.push({ op: 'select', ids });
      continue;
    }
    if (op === 'point' || op === 'note' || op === 'look') {
      if (!Array.isArray(raw.at) || !inBounds(raw.at)) { refused.push({ raw, why: 'point is outside this place' }); continue; }
      ok.push({ ...raw, at: [Number(raw.at[0]), Number(raw.at[1])] });
      continue;
    }
    if (op === 'circle' || op === 'line') {
      const pts = (raw.points || []).filter((p) => Array.isArray(p) && inBounds(p)).map((p) => [Number(p[0]), Number(p[1])]);
      if (pts.length < (op === 'circle' ? 3 : 2)) { refused.push({ raw, why: 'not enough points inside this place' }); continue; }
      if (op === 'circle' && G.area(pts) < 4) { refused.push({ raw, why: 'that area is too small to mean anything' }); continue; }
      ok.push({ op, points: pts.slice(0, 12) });
      continue;
    }
    if (op === 'say') {
      const text = String(raw.text || '').trim();
      if (!text) { refused.push({ raw, why: 'empty sentence' }); continue; }
      if (text.length > 200) { refused.push({ raw, why: 'sentence too long to be an utterance' }); continue; }
      ok.push({ op: 'say', text });
    }
  }
  return { operations: ok, refused };
}

// ------------------------------------------------------------------- entry --
/**
 * @returns {{reasoning, operations, refused, digest, raw}}
 */
export async function proposeOperations(world, request, view, opts = {}) {
  const cfg = getConfig();
  const d = digest(world, view);
  const visionMode = opts.vision || cfg.vision;
  const wantsVision = visionMode === 'always'
    || (visionMode === 'auto' && (view.selection?.length || view.pointer
        || /\b(this|that|here|there|looks|see|behind|beside|left|right)\b/i.test(request)));
  const prompt = [
    `Request: ${request}`,
    opts.findings ? `\nWhat CREO has already established by looking:\n${opts.findings}` : '',
    opts.critique ? `\nA previous attempt was rejected. The single largest problem was:\n${opts.critique}\nAddress that.` : '',
    '',
    'What is in view:',
    JSON.stringify(d, null, 1),
  ].filter(Boolean).join('\n');
  const raw = await complete({
    system: SYSTEM, prompt,
    image: wantsVision ? view.image || null : null,
    effort: opts.effort || effortFor(request, cfg.effort),
  });
  let parsed;
  try {
    parsed = JSON.parse(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  } catch {
    const m = /\{[\s\S]*\}/.exec(raw);
    if (!m) throw new Error('the model did not return JSON');
    parsed = JSON.parse(m[0]);
  }
  const { operations, refused } = validate(world, parsed.operations, d);
  return { reasoning: String(parsed.reasoning || '').slice(0, 240), operations, refused, digest: d, raw };
}


// ------------------------------------------------------------------ critic ---
const CRITIC_SYSTEM = `You are an independent reviewer of a proposed change to a real place.

You did not make this proposal and you must not assume it is good. You are shown the goal, the hard constraints, what the world's own models measured, and an image of the result as a participant would see it.

Judge only what is in front of you. You have not been told the proposer's reasoning and must not imagine it.

Return ONLY JSON:
{"verdict":"PASS"|"FAIL","largestProblem":"<one sentence, or empty if PASS>","whatAParticipantWouldSee":"<one sentence>"}

FAIL if any hard constraint is broken, if a measured consequence got worse, or if a participant looking at the image could not tell what changed or why. Say the single largest problem, not a list.`;

/**
 * A fresh judgement, with no memory of how the thing was made (§107). The
 * builder does not get to grade itself, and it does not get to explain itself
 * to the grader either.
 */
export async function critique({ goal, constraints = [], metrics = [], image = null, effort = 'max' }) {
  const prompt = [
    `Goal: ${goal}`,
    constraints.length ? `Hard constraints:\n${constraints.map((c) => `- ${c}`).join('\n')}` : 'Hard constraints: none stated.',
    metrics.length ? `What the world's models measured:\n${metrics.map((m) => `- ${m.label}: ${m.before} → ${m.after}`).join('\n')}` : 'No measurements available.',
    image ? 'An image of the result is attached.' : 'No image is available; judge on the measurements alone.',
  ].join('\n\n');
  const raw = await complete({ system: CRITIC_SYSTEM, prompt, image, effort });
  try {
    return JSON.parse(String(raw).replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  } catch {
    const m = /\{[\s\S]*\}/.exec(raw);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
    return { verdict: 'FAIL', largestProblem: 'the reviewer did not return a usable judgement', whatAParticipantWouldSee: '' };
  }
}
