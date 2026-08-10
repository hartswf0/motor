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

export function getConfig() {
  try { return { key: localStorage.getItem(KEY_STORE) || '', ...JSON.parse(localStorage.getItem(CFG_STORE) || '{}') }; }
  catch { return { key: '' }; }
}
export function setConfig({ key, baseURL, model, provider }) {
  if (key !== undefined) localStorage.setItem(KEY_STORE, key);
  const cfg = getConfig();
  localStorage.setItem(CFG_STORE, JSON.stringify({
    baseURL: baseURL ?? cfg.baseURL ?? 'https://api.openai.com/v1',
    model: model ?? cfg.model ?? 'gpt-4o-mini',
    provider: provider ?? cfg.provider ?? 'openai',
  }));
}
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

async function complete({ system, prompt }) {
  const { key, baseURL, model, provider } = getConfig();
  if (!key) throw new Error('no API key configured');
  if (provider === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: model || 'claude-sonnet-5', max_tokens: 1200, temperature: 0, system, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return j.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  }
  const r = await fetch(`${(baseURL || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: model || 'gpt-4o-mini', temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).choices[0].message.content;
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
export async function proposeOperations(world, request, view) {
  const d = digest(world, view);
  const prompt = [
    `Request: ${request}`,
    '',
    'What is in view:',
    JSON.stringify(d, null, 1),
  ].join('\n');
  const raw = await complete({ system: SYSTEM, prompt });
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
