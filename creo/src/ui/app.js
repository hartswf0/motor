// THE INTERFACE.
//
// One invitation: say something about this place. Everything else appears only
// when the world has something to show — a proposal, a conflict, an answer, a
// future. Every path through language has a wordless equivalent, because
// language must not become a new gatekeeper (§23).

import * as G from '../core/geom.js';
import { buildPlace, PLACES } from '../places/index.js';
import { World } from '../core/world.js';
import { makeContext } from '../lang/deixis.js';
import { interpret } from '../lang/interpret.js';
import { plan, commitPlan } from '../world/ops.js';
import { ask } from '../world/query.js';
import { consequenceOf } from '../sim/consequence.js';
import { summarize } from '../world/certificate.js';
import { Renderer, perspective, lookAt, multiply, screenRay } from '../render/gl.js';
import { pick, rayToGround } from '../render/pick.js';

const $ = (id) => document.getElementById(id);
const canvas = $('world');

// ------------------------------------------------------------------- state --
const S = {
  world: null,
  placeKey: 'settlement',
  author: localStorage.getItem('creo.author') || '',
  gps: null,
  selection: new Set(),
  highlight: new Set(),
  preserved: new Set(),
  pointer: null,
  stroke: null,
  strokeClosed: false,
  mode: 'select',                 // select | draw
  plan: null,
  altIndex: -1,
  overlay: null,
  utterances: [],
  cam: { target: [0, 0, 0], dist: 150, yaw: -Math.PI / 2, pitch: 0.72 },
  fidelity: 'high',
  dragging: null,
  dirty: true,
  compare: false,
};

const renderer = new Renderer(canvas);

// ------------------------------------------------------------------ camera --
function eye() {
  const { target, dist, yaw, pitch } = S.cam;
  return [
    target[0] + Math.cos(yaw) * Math.cos(pitch) * dist,
    target[1] + Math.sin(yaw) * Math.cos(pitch) * dist,
    target[2] + Math.sin(pitch) * dist,
  ];
}
const FOV = 0.85;
function viewProj() {
  const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  return multiply(perspective(FOV, aspect, 0.5, 6000), lookAt(eye(), S.cam.target));
}
function rayAt(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return screenRay(clientX - r.left, clientY - r.top, r.width, r.height, eye(), S.cam.target, FOV, r.width / r.height);
}
function project(p) {
  const m = viewProj();
  const v = [p[0], p[1], p[2] ?? 0, 1];
  const o = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) o[i] = m[i] * v[0] + m[4 + i] * v[1] + m[8 + i] * v[2] + m[12 + i] * v[3];
  if (o[3] <= 0.01) return null;
  const r = canvas.getBoundingClientRect();
  return [(o[0] / o[3] * 0.5 + 0.5) * r.width, (1 - (o[1] / o[3] * 0.5 + 0.5)) * r.height];
}

function frameWorld() {
  const b = S.world.place.bounds();
  S.cam.target = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2, S.world.place.groundAt((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)];
  S.cam.dist = Math.max(45, Math.hypot(b[2] - b[0], b[3] - b[1]) * 0.75);
  S.cam.yaw = -Math.PI / 2.1;
  S.cam.pitch = 0.66;
  updateFidelity();
}

/** ADAPTIVE FIDELITY (§26): graphics degrade, world integrity does not. */
function updateFidelity() {
  const n = S.world.entities().length;
  const d = S.cam.dist;
  let f = 'high';
  if (d > 260 || n > 2500) f = 'medium';
  if (d > 700 || n > 8000) f = 'low';
  if (d > 1800) f = 'symbolic';
  if (f !== S.fidelity) { S.fidelity = f; S.dirty = true; }
}

// ------------------------------------------------------------------- render --
function rebuild() {
  const changed = new Set(S.world.journal.changedSince(Math.max(0, S.world.place.tick - 2)));
  const ghosts = currentGhosts();
  renderer.build(S.world, {
    ghosts,
    selection: S.selection,
    highlight: S.highlight,
    preserved: S.preserved,
    changed,
    fidelity: S.fidelity,
    // Close in on a building and its roof comes off, so the rooms inside are
    // the thing you are working with.
    cutawayAt: S.cam.dist < 45 ? [S.cam.target[0], S.cam.target[1]] : null,
    overlay: {
      ...(S.overlay || {}),
      kind: S.overlay?.kind,
      stroke: S.stroke,
      strokeClosed: S.strokeClosed,
      corridors: S.plan?.corridors || [],
      trace: S.overlay?.trace || [],
    },
  });
  S.dirty = false;
}

function currentGhosts() {
  if (!S.plan) return [];
  const src = S.altIndex >= 0 ? S.plan.alternatives[S.altIndex] : S.plan;
  const cert = src.certificate;
  const bad = new Set((cert?.findings || []).filter((f) => f.severity === 'error').map((f) => f.entity));
  return (src.ghosts || []).map((g) => ({ ...g, __invalid: bad.has(g.id) }));
}

function frame() {
  if (S.dirty) rebuild();
  renderer.draw(viewProj());
  drawLabels();
  requestAnimationFrame(frame);
}

/** Labels live in the DOM: real text, selectable, readable by a screen reader. */
function drawLabels() {
  const host = $('labels');
  const wanted = [];
  const w = S.world;
  if (S.fidelity !== 'symbolic') {
    for (const e of w.entities()) {
      if (e.type === 'observation') wanted.push({ id: e.id, text: e.evidence?.[0]?.text || e.name, at: [...G.centroid(w.ringOf(e)), e.zTop + 3.6], cls: 'obs' });
    }
  }
  for (const id of S.selection) {
    const e = w.get(id);
    if (!e) continue;
    const ring = w.ringOf(e);
    if (!ring) continue;
    wanted.push({ id: `sel_${id}`, text: labelFor(e), at: [...G.centroid(ring), e.zTop + 1.2], cls: 'sel' });
  }
  // Two people who spoke about the same spot must both stay readable.
  const placed = [];
  host.replaceChildren(...wanted.map((l) => {
    const p = project(l.at);
    if (!p || p[0] < -100 || p[0] > innerWidth + 100 || p[1] < 0 || p[1] > innerHeight) return document.createTextNode('');
    let y = p[1];
    for (let guard = 0; guard < 12; guard++) {
      const clash = placed.find((q) => Math.abs(q[0] - p[0]) < 150 && Math.abs(q[1] - y) < 22);
      if (!clash) break;
      y -= 24;
    }
    placed.push([p[0], y]);
    const d = document.createElement('div');
    d.className = `label ${l.cls}`;
    d.style.left = `${p[0]}px`;
    d.style.top = `${y}px`;
    d.textContent = l.text;
    return d;
  }));
}

function labelFor(e) {
  const ring = S.world.ringOf(e);
  const bits = [e.name || e.type];
  if (ring) {
    const ob = G.orientedBounds(ring);
    bits.push(`${ob.width.toFixed(1)}×${ob.depth.toFixed(1)} m`);
  }
  if (e.zTop - e.zBase > 0.2) bits.push(`${(e.zTop - e.zBase).toFixed(1)} m high`);
  return bits.join(' · ');
}

// -------------------------------------------------------------- interaction --
let pointers = new Map();
let gesture = null;

canvas.addEventListener('pointerdown', (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, x0: ev.clientX, y0: ev.clientY, t: Date.now() });
  if (pointers.size === 1) {
    if (S.mode === 'draw') {
      const p = rayToGround(S.world, rayAt(ev.clientX, ev.clientY));
      if (p) { S.stroke = [p]; S.strokeClosed = false; gesture = 'draw'; S.dirty = true; }
    } else {
      const hit = pick(S.world, rayAt(ev.clientX, ev.clientY), { fidelity: S.fidelity });
      if (hit.entity && S.selection.has(hit.entity.id)) {
        gesture = 'move';
        S.dragging = { id: hit.entity.id, from: hit.point, ring0: S.world.ringOf(hit.entity), path0: hit.entity.path };
      } else gesture = 'orbit';
    }
  } else if (pointers.size === 2) {
    gesture = 'pinch';
    const [a, b] = [...pointers.values()];
    gesture = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), dist0: S.cam.dist, mid: [(a.x + b.x) / 2, (a.y + b.y) / 2] };
  }
});

canvas.addEventListener('pointermove', (ev) => {
  const pt = pointers.get(ev.pointerId);
  if (!pt) return;
  const dx = ev.clientX - pt.x, dy = ev.clientY - pt.y;
  pt.x = ev.clientX; pt.y = ev.clientY;

  if (gesture === 'draw' && S.stroke) {
    const p = rayToGround(S.world, rayAt(ev.clientX, ev.clientY));
    if (p && G.dist(p, S.stroke[S.stroke.length - 1]) > 0.8) { S.stroke.push(p); S.dirty = true; }
    return;
  }
  if (gesture === 'move' && S.dragging) {
    const p = rayToGround(S.world, rayAt(ev.clientX, ev.clientY));
    if (p) dragTo(p);
    return;
  }
  if (gesture === 'orbit' && pointers.size === 1) {
    S.cam.yaw -= dx * 0.006;
    S.cam.pitch = Math.max(0.12, Math.min(1.45, S.cam.pitch + dy * 0.005));
    return;
  }
  if (gesture && gesture.kind === 'pinch' && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    S.cam.dist = Math.max(8, Math.min(4000, gesture.dist0 * (gesture.d0 / Math.max(1, d))));
    const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
    panBy(mid[0] - gesture.mid[0], mid[1] - gesture.mid[1]);
    gesture.mid = mid;
    updateFidelity();
  }
});

canvas.addEventListener('pointerup', (ev) => {
  const pt = pointers.get(ev.pointerId);
  pointers.delete(ev.pointerId);
  if (!pt) return;
  const moved = Math.hypot(ev.clientX - pt.x0, ev.clientY - pt.y0);

  if (gesture === 'draw' && S.stroke) {
    if (S.stroke.length > 3 && G.dist(S.stroke[0], S.stroke[S.stroke.length - 1]) < Math.max(6, G.perimeter(S.stroke, false) * 0.22)) {
      S.strokeClosed = true;                 // a loop is an area
      toast(`Area: ${G.area(S.stroke).toFixed(0)} m². Now say what about it.`);
    } else {
      S.strokeClosed = false;
      toast(`Line: ${G.perimeter(S.stroke, false).toFixed(0)} m. Now say what about it.`);
    }
    setMode('select');
    S.dirty = true;
    showTools();
  } else if (gesture === 'move' && S.dragging) {
    commitDrag();
  } else if (moved < 6 && pointers.size === 0) {
    tap(ev.clientX, ev.clientY, ev.shiftKey);
  }
  if (pointers.size === 0) gesture = null;
});

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  S.cam.dist = Math.max(8, Math.min(4000, S.cam.dist * (1 + Math.sign(ev.deltaY) * 0.11)));
  updateFidelity();
}, { passive: false });

function panBy(dx, dy) {
  const scale = S.cam.dist * 0.0022;
  const yaw = S.cam.yaw;
  S.cam.target[0] += (Math.sin(yaw) * dx + Math.cos(yaw) * dy) * scale;
  S.cam.target[1] += (-Math.cos(yaw) * dx + Math.sin(yaw) * dy) * scale;
}

function tap(x, y, additive) {
  const hit = pick(S.world, rayAt(x, y), { fidelity: S.fidelity });
  S.pointer = hit.point;
  if (hit.entity) {
    if (additive) { S.selection.has(hit.entity.id) ? S.selection.delete(hit.entity.id) : S.selection.add(hit.entity.id); }
    else S.selection = new Set([hit.entity.id]);
  } else if (!additive) {
    S.selection.clear();
  }
  S.dirty = true;
  showTools();
}

// ------------------------------------------------- direct manipulation -------
function dragTo(p) {
  const d = S.dragging;
  const delta = G.sub(p, d.from);
  const e = S.world.get(d.id);
  if (!e) return;
  const patch = d.path0
    ? { path: d.path0.map((q) => G.add(q, delta)) }
    : { footprint: snapRing(d.ring0.map((q) => G.add(q, delta)), d.id) };
  S.world.place.put({ ...e, ...patch }, S.world.branch);   // live preview, not journalled
  S.world.dirty = true;
  S.world.reindex();
  S.dirty = true;
}

/** Alignment is how new form joins committed form (PRO TEST B). */
function snapRing(ring, excludeId) {
  const near = [];
  for (const other of S.world.entities()) {
    if (other.id === excludeId) continue;
    const r = S.world.ringOf(other);
    if (!r) continue;
    if (G.ringDistance(ring, r) > 4) continue;
    near.push({ id: other.id, ring: r, closed: !other.path });
  }
  if (!near.length) return ring;
  let bestDelta = null, bestD = Infinity;
  for (const p of ring) {
    const s = G.snapPoint(p, near, 1.1);
    if (s && s.d < bestD) { bestD = s.d; bestDelta = G.sub(s.point, p); }
  }
  return bestDelta ? ring.map((p) => G.add(p, bestDelta)) : ring;
}

function commitDrag() {
  const d = S.dragging;
  S.dragging = null;
  if (!d) return;
  const e = S.world.get(d.id);
  const patch = e.path ? { path: e.path } : { footprint: e.footprint };
  // restore, then apply through the journal so undo can reverse it exactly
  S.world.place.put({ ...e, ...(d.path0 ? { path: d.path0 } : { footprint: d.ring0 }) }, S.world.branch);
  S.world.updateEntity(d.id, patch, { label: `move ${e.name || e.type}`, author: S.author || 'unsigned' });
  refreshChrome();
  showTools();
}

// ------------------------------------------------------------------- saying --
function context() {
  return makeContext(S.world, {
    selection: {
      ids: [...S.selection],
      ring: S.strokeClosed ? S.stroke : null,
      stroke: S.strokeClosed ? null : S.stroke,
    },
    pointer: S.pointer,
    camera: { eye: eye(), target: S.cam.target },
    // Only a real position counts as one. Passing the camera target here meant
    // "here" silently resolved to wherever the view happened to be pointing,
    // and put a bench inside somebody's bedroom.
    participant: S.gps ? { id: S.author, position: S.gps } : null,
    utterances: S.utterances,
  });
}

function saySomething(text) {
  if (!text.trim()) return;
  const ctx = context();
  const intent = interpret(text, ctx);
  intent.author = S.author || 'unsigned';
  S.utterances.push({ text, resolved: intent.reference, tick: S.world.place.tick });

  if (intent.operation === 'ASK') {
    const answer = ask(S.world, intent, {});
    showAnswer(intent, answer);
    return;
  }

  const p = plan(S.world, intent, ctx);
  S.plan = p;
  S.altIndex = -1;

  if (p.simulation) {
    S.overlay = p.simulation.water ? { kind: 'water', water: p.simulation.water } : (p.simulation.night ? { kind: 'dark', points: [] } : null);
    toast(`${p.title} — ${p.summary}`);
    S.plan = null;
    S.dirty = true;
    return;
  }
  if (p.certificate && !p.certificate.valid && !p.ghosts?.length && !p.branchOps?.length) {
    toast(p.summary || 'Not sure what you meant — tap or draw first.');
    S.plan = null;
    return;
  }
  // An observation is testimony, not an intervention: it lands immediately.
  if (p.autoCommit) {
    commitPlan(S.world, p, { author: S.author || 'unsigned' });
    S.plan = null;
    S.stroke = null;
    toast(intent.secondary === 'ROUTE' ? 'Route recorded where people walk.' : 'Recorded here.');
    refreshChrome();
    S.dirty = true;
    return;
  }
  showProposal(p);
}

$('sayInput').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') {
    const v = ev.target.value;
    ev.target.value = '';
    saySomething(v);
  }
});

// speech, where it exists — never required
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
$('micBtn').addEventListener('click', () => {
  if (!SR) { toast('No speech here — type it, or draw it.'); $('sayInput').focus(); return; }
  if (recog) { recog.stop(); return; }
  recog = new SR();
  recog.lang = navigator.language || 'en-US';
  recog.interimResults = false;
  recog.onresult = (e) => { const t = e.results[0][0].transcript; $('sayInput').value = t; saySomething(t); };
  recog.onend = () => { recog = null; $('micBtn').classList.remove('on'); };
  recog.start();
  $('micBtn').classList.add('on');
});

// ---------------------------------------------------------------- proposal --
function showProposal(p) {
  const src = S.altIndex >= 0 ? p.alternatives[S.altIndex] : p;
  $('propTitle').textContent = p.title;
  $('propSummary').textContent = p.summary;

  const cert = src.certificate || { findings: [] };
  $('propCert').replaceChildren(...summarize(cert).map((f) => {
    const row = document.createElement('div');
    row.className = `finding ${f.severity}`;
    const code = document.createElement('span');
    code.className = 'code';
    code.textContent = f.code.replace(/_/g, ' ');
    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = f.message;
    row.append(code, msg);
    if (f.others?.length) {
      const b = document.createElement('button');
      b.textContent = 'show';
      b.onclick = () => { S.highlight = new Set(f.others); S.dirty = true; };
      row.append(b);
    }
    return row;
  }));

  $('propImpact').replaceChildren();
  $('propAlts').replaceChildren();
  if (p.alternatives?.length) {
    const mk = (label, i) => {
      const b = document.createElement('button');
      b.className = `tool${S.altIndex === i ? ' on' : ''}`;
      b.textContent = label;
      b.onclick = () => { S.altIndex = i; S.dirty = true; showProposal(p); };
      return b;
    };
    $('propAlts').append(mk('Where it landed', -1), ...p.alternatives.map((a, i) => mk(a.label, i)));
  }

  // The place is allowed to be overruled — §11 says a proposal may remain
  // intentionally in conflict — but never by accident. An invalid proposal
  // takes two deliberate taps and says what it is doing.
  const btn = $('propCommit');
  btn.disabled = false;
  btn.dataset.armed = '';
  btn.classList.toggle('danger', !cert.valid);
  btn.textContent = p.branchOps?.length ? 'Create these futures'
    : cert.valid ? 'Put it in the world' : 'Put it in anyway — it conflicts';
  hide('answer'); hide('branches'); hide('tools');
  show('proposal');
  S.dirty = true;

  // consequence is computed, so it arrives a beat later
  if ((src.ghosts?.length || p.removals?.length) && !p.branchOps?.length) {
    setTimeout(() => {
      const c = consequenceOf(S.world, { ...src, region: p.region, removals: p.removals, patches: p.patches });
      if (S.plan !== p) return;
      $('propImpact').replaceChildren(...c.metrics.map(metricRow), quantitiesRow(c.quantities));
    }, 16);
  }
}

function metricRow(m) {
  const d = document.createElement('div');
  d.className = 'metric';
  const l = document.createElement('span'); l.className = 'label'; l.textContent = m.label;
  const v = document.createElement('span'); v.className = 'val'; v.textContent = `${m.before} → ${m.after}`;
  const delta = document.createElement('span');
  delta.className = `d ${m.good ? 'good' : m.bad ? 'bad' : ''}`;
  delta.textContent = m.delta > 0.5 ? `+${m.delta.toFixed(0)}` : m.delta < -0.5 ? m.delta.toFixed(0) : '·';
  const b = document.createElement('span'); b.className = 'basis'; b.textContent = m.basis;
  d.append(l, v, delta, b);
  return d;
}

function quantitiesRow(q) {
  const d = document.createElement('div');
  d.className = 'metric';
  const bits = [];
  if (q.earthwork_m3) bits.push(`${q.earthwork_m3} m³ dug`);
  if (q.gravel_m3) bits.push(`${q.gravel_m3} m³ gravel`);
  if (q.plants) bits.push(`${q.plants} plants`);
  if (q.length_m) bits.push(`${q.length_m} m long`);
  if (q.footprint_m2) bits.push(`${q.footprint_m2} m² footprint`);
  if (q.glazing_m2) bits.push(`${q.glazing_m2} m² glazing`);
  const l = document.createElement('span'); l.className = 'label'; l.textContent = 'To build it';
  const v = document.createElement('span'); v.className = 'val'; v.textContent = bits.join(', ') || '—';
  d.append(l, v);
  return d;
}

$('propCommit').onclick = () => {
  const p = S.plan;
  if (!p) return;
  const btn = $('propCommit');
  const src0 = S.altIndex >= 0 ? p.alternatives[S.altIndex] : p;
  if (!src0.certificate?.valid && !btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = 'Tap again to overrule the place';
    toast('This conflicts with what is already there. Tap again if you mean it.');
    return;
  }
  const src = S.altIndex >= 0 ? { ...p, ghosts: p.alternatives[S.altIndex].ghosts } : p;
  const out = commitPlan(S.world, src, { author: S.author || 'unsigned' });
  S.plan = null; S.altIndex = -1; S.stroke = null; S.highlight.clear();
  hide('proposal');
  if (out.branches?.length) {
    toast(`${out.branches.length} future${out.branches.length === 1 ? '' : 's'} created. The place as it is is untouched.`);
    showBranches();
  } else {
    toast('In the world. Undo if you want it back.');
    S.selection = new Set((src.ghosts || []).map((g) => g.id));
  }
  refreshChrome();
  S.dirty = true;
  showTools();
};
$('propDiscard').onclick = $('propClose').onclick = () => {
  S.plan = null; S.altIndex = -1; S.highlight.clear();
  hide('proposal');
  S.dirty = true;
};

// ------------------------------------------------------------------ answer --
function showAnswer(intent, a) {
  $('ansTitle').textContent = intent.question?.kind === 'why' ? 'Why it is here' : 'The place says';
  const body = $('ansBody');
  body.replaceChildren();
  const p = document.createElement('div');
  p.textContent = a.text || '—';
  body.append(p);

  if (a.rows?.length && a.rows[0].who) {
    for (const r of a.rows) {
      const box = document.createElement('div');
      box.className = 'why';
      box.textContent = [
        `${r.name}`,
        `made by ${r.who} · ${r.when} · ${r.epistemic.toLowerCase()} (certainty ${Math.round((r.certainty ?? 1) * 100)}%)`,
        `because: ${r.how}`,
        `evidence: ${r.evidence}`,
        r.relations.length ? `holds together by: ${r.relations.slice(0, 4).join('; ')}` : null,
        `${r.changes} change${r.changes === 1 ? '' : 's'} since`,
      ].filter(Boolean).join('\n');
      body.append(box);
    }
  } else if (a.rows?.length) {
    const t = document.createElement('table');
    const keys = Object.keys(a.rows[0]).slice(0, 5);
    const head = document.createElement('tr');
    for (const k of keys) { const th = document.createElement('th'); th.textContent = k; head.append(th); }
    t.append(head);
    for (const r of a.rows.slice(0, 24)) {
      const tr = document.createElement('tr');
      for (const k of keys) { const td = document.createElement('td'); td.textContent = String(r[k] ?? ''); tr.append(td); }
      t.append(tr);
    }
    body.append(t);
  }

  S.highlight = new Set(a.highlight || []);
  S.overlay = a.overlay ? { ...a.overlay, trace: a.trace } : (a.trace?.length ? { trace: a.trace } : null);
  hide('proposal'); hide('branches');
  show('answer');
  S.dirty = true;
}
$('ansClose').onclick = () => { hide('answer'); S.highlight.clear(); S.overlay = null; S.dirty = true; };

// ---------------------------------------------------------------- branches --
function showBranches() {
  const list = $('branchList');
  list.replaceChildren(...[...S.world.place.branches.values()].map((b) => {
    const row = document.createElement('div');
    row.className = `branchRow${b.id === S.world.branch ? ' on' : ''}`;
    const left = document.createElement('div');
    const n = document.createElement('div'); n.className = 'n'; n.textContent = b.name;
    const note = document.createElement('div'); note.className = 'note'; note.textContent = b.note || (b.id === 'AS_IS' ? 'the place as it is' : '');
    left.append(n, note);
    const stat = document.createElement('div');
    stat.className = 'stat';
    stat.textContent = `${S.world.view(b.id).entities.length} things`;
    row.append(left, stat);
    row.onclick = () => {
      S.world.switchBranch(b.id);
      refreshChrome(); showBranches(); S.dirty = true;
      toast(`Now in “${b.name}”. Nothing else was lost.`);
    };
    return row;
  }));
  hide('proposal'); hide('answer');
  show('branches');
}
$('brClose').onclick = () => hide('branches');
$('branchChip').onclick = showBranches;
$('compareBtn').onclick = () => {
  const intent = { operation: 'ASK', question: { kind: 'compare' }, reference: { ids: [], kind: 'none', basis: [] } };
  showAnswer(intent, ask(S.world, intent, { compareBranches: [...S.world.place.branches.keys()] }));
};

// ------------------------------------------------------------------- tools --
function showTools() {
  const ids = [...S.selection];
  const row = $('toolRow');
  const title = $('toolTitle');
  row.replaceChildren();

  if (!ids.length && !S.stroke) { hide('tools'); return; }

  const mk = (text, fn, cls = '') => {
    const b = document.createElement('button');
    b.className = `tool ${cls}`;
    b.textContent = text;
    b.onclick = fn;
    return b;
  };

  if (S.stroke && !ids.length) {
    title.textContent = S.strokeClosed
      ? `${G.area(S.stroke).toFixed(0)} m² drawn — say what belongs here, or:`
      : `${G.perimeter(S.stroke, false).toFixed(0)} m drawn — say what this is, or:`;
    row.append(
      mk(S.strokeClosed ? 'Trees here' : 'People walk here', () => saySomething(S.strokeClosed ? 'there should be trees here' : 'people actually walk here')),
      mk(S.strokeClosed ? 'It floods here' : 'A path here', () => saySomething(S.strokeClosed ? 'this always floods' : 'we need a path here')),
      mk('Clear', () => { S.stroke = null; S.dirty = true; showTools(); }),
    );
    show('tools');
    return;
  }

  const e = S.world.get(ids[0]);
  title.textContent = ids.length === 1 ? labelFor(e) : `${ids.length} things selected`;

  if (ids.length === 1 && e) {
    const h = e.zTop - e.zBase;
    row.append(
      mk('Taller', () => quickEdit({ zTop: e.zBase + h + 1 }, 'raise')),
      mk('Shorter', () => quickEdit({ zTop: e.zBase + Math.max(0.3, h - 1) }, 'lower')),
    );
    // precision, without a keyboard-only path
    const num = document.createElement('label');
    num.className = 'tool num';
    num.textContent = 'Set width';
    const inp = document.createElement('input');
    inp.type = 'number'; inp.step = '0.05'; inp.inputMode = 'decimal';
    const ring = S.world.ringOf(e);
    inp.value = ring ? G.orientedBounds(ring).width.toFixed(2) : '';
    inp.onchange = () => saySomething(`make this ${inp.value} m`);
    num.append(inp);
    row.append(num);
  }
  row.append(
    mk('Keep', () => saySomething('keep these'), 'keep'),
    mk('Remove', () => saySomething('remove this')),
    mk('Why is it here?', () => saySomething('why are you here?')),
    mk('Who changed it?', () => saySomething('who changed this?')),
  );
  if (ids.length === 2) row.append(mk('Connect these', () => saySomething('connect these')));
  row.append(mk('Three futures', () => saySomething('show three radically different futures for this')));
  show('tools');
}

function quickEdit(patch, label) {
  for (const id of S.selection) S.world.updateEntity(id, patch, { label, author: S.author || 'unsigned' });
  refreshChrome();
  S.dirty = true;
  showTools();
}

// -------------------------------------------------------------------- misc --
function setMode(m) {
  S.mode = m;
  $('modeDraw').classList.toggle('on', m === 'draw');
  if (m === 'draw') toast('Draw a line, or a loop for an area.');
}
$('modeDraw').onclick = () => setMode(S.mode === 'draw' ? 'select' : 'draw');

$('undoBtn').onclick = () => { const e = S.world.undo(); if (e) toast(`Undone: ${e.label}`); refreshChrome(); S.dirty = true; };
$('redoBtn').onclick = () => { const e = S.world.redo(); if (e) toast(`Redone: ${e.label}`); refreshChrome(); S.dirty = true; };

$('placeChip').onclick = (ev) => {
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.style.left = '12px';
  menu.style.top = `${ev.currentTarget.getBoundingClientRect().bottom + 8}px`;
  for (const p of PLACES) {
    const b = document.createElement('button');
    b.className = p.key === S.placeKey ? 'on' : '';
    b.innerHTML = `${p.name}<span class="sub">${p.scale}</span>`;
    b.onclick = () => { menu.remove(); loadPlace(p.key); };
    menu.append(b);
  }
  document.body.append(menu);
  setTimeout(() => document.addEventListener('pointerdown', function off(e) {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', off); }
  }), 0);
};

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
}
const show = (id) => { $(id).hidden = false; };
const hide = (id) => { $(id).hidden = true; };

function setAuthor(name) {
  S.author = (name || '').trim();
  if (S.author) localStorage.setItem('creo.author', S.author);
  $('authorName').textContent = S.author || 'add your name';
  $('authorChip').classList.toggle('unset', !S.author);
}

/**
 * Authorship is modelled all the way down — every entity and every transaction
 * carries an author — but until this existed nobody could say who they were,
 * so "who changed this?" always answered "you".
 */
$('authorChip').onclick = (ev) => {
  const menu = document.createElement('div');
  menu.className = 'menu';
  const r = ev.currentTarget.getBoundingClientRect();
  menu.style.left = `${Math.max(8, r.left)}px`;
  menu.style.top = `${r.bottom + 8}px`;
  const label = document.createElement('div');
  label.className = 'menuLabel';
  label.textContent = 'Who is making these changes?';
  const input = document.createElement('input');
  input.className = 'nameInput';
  input.value = S.author;
  input.placeholder = 'your name';
  input.setAttribute('aria-label', 'Your name');
  const done = () => { setAuthor(input.value); menu.remove(); toast(S.author ? `Changes will be signed ${S.author}.` : 'Changes will be unsigned.'); };
  input.onkeydown = (e) => { if (e.key === 'Enter') done(); };
  const ok = document.createElement('button');
  ok.textContent = 'That\'s me';
  ok.onclick = done;
  menu.append(label, input, ok);
  document.body.append(menu);
  input.focus();
  setTimeout(() => document.addEventListener('pointerdown', function off(e) {
    if (!menu.contains(e.target)) { done(); document.removeEventListener('pointerdown', off); }
  }), 0);
};

function refreshChrome() {
  $('undoBtn').disabled = !S.world.journal.canUndo();
  $('redoBtn').disabled = !S.world.journal.canRedo();
  const multi = S.world.place.branches.size > 1;
  $('branchChip').hidden = !multi;
  $('branchName').textContent = S.world.place.branches.get(S.world.branch)?.name || 'As it is';
  S.preserved = new Set(S.world.place.relations.filter((r) => r.kind === 'preserves').map((r) => r.to));
  save();
}

// persistence — a place that forgets is not a place
function save() {
  try { localStorage.setItem(`creo.save.${S.placeKey}`, S.world.save()); } catch { /* quota */ }
}
function loadPlace(key) {
  S.placeKey = key;
  const saved = localStorage.getItem(`creo.save.${key}`);
  try {
    S.world = saved ? World.load(saved) : buildPlace(key);
  } catch {
    S.world = buildPlace(key);
  }
  S.selection.clear(); S.highlight.clear(); S.stroke = null; S.plan = null; S.overlay = null; S.utterances = [];
  $('placeName').textContent = PLACES.find((p) => p.key === key).name.split(' — ')[0];
  hide('proposal'); hide('answer'); hide('branches'); hide('tools');
  frameWorld();
  refreshChrome();
  S.dirty = true;
  localStorage.setItem('creo.place', key);
}

// keyboard: every gesture has a key, because not everyone has a steady hand
addEventListener('keydown', (ev) => {
  if (ev.target.tagName === 'INPUT') return;
  const k = ev.key.toLowerCase();
  if (k === 'z' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); ev.shiftKey ? $('redoBtn').click() : $('undoBtn').click(); }
  else if (k === 'd') setMode(S.mode === 'draw' ? 'select' : 'draw');
  else if (k === 'b') showBranches();
  else if (k === '/') { ev.preventDefault(); $('sayInput').focus(); }
  else if (k === 'escape') { S.selection.clear(); S.stroke = null; hide('tools'); hide('proposal'); S.plan = null; S.dirty = true; }
  else if (k === 'arrowleft') { S.cam.yaw -= 0.12; }
  else if (k === 'arrowright') { S.cam.yaw += 0.12; }
  else if (k === 'arrowup') { S.cam.dist *= 0.9; updateFidelity(); }
  else if (k === 'arrowdown') { S.cam.dist *= 1.1; updateFidelity(); }
  // Without these, a keyboard user could act on exactly one point — wherever
  // the view happened to open — for the whole session.
  else if ('wasd'.includes(k)) {
    const step = S.cam.dist * 0.06;
    const dx = k === 'a' ? -step : k === 'd' ? step : 0;
    const dy = k === 'w' ? step : k === 's' ? -step : 0;
    const yaw = S.cam.yaw;
    S.cam.target[0] += Math.cos(yaw) * dy - Math.sin(yaw) * dx;
    S.cam.target[1] += Math.sin(yaw) * dy + Math.cos(yaw) * dx;
    S.cam.target[2] = S.world.place.groundAt(S.cam.target[0], S.cam.target[1]);
    setCrosshair(true);
  } else if (k === 'enter' || k === ' ') {
    ev.preventDefault();
    setCrosshair(true);
    const r = canvas.getBoundingClientRect();
    tap(r.left + r.width / 2, r.top + r.height / 2, ev.shiftKey);
    const e = [...S.selection].map((id) => S.world.get(id)).filter(Boolean)[0];
    toast(e ? `Selected ${labelFor(e)}` : 'Nothing there — move with W A S D and try again.');
  }
});

/** A visible aiming point, so "here" means something without a pointing device. */
function setCrosshair(on) {
  const el = $('crosshair');
  if (!el) return;
  el.hidden = !on;
  if (on) {
    clearTimeout(setCrosshair._t);
    setCrosshair._t = setTimeout(() => { el.hidden = true; }, 9000);
    const p = rayToGround(S.world, rayAt(innerWidth / 2, innerHeight / 2));
    if (p) S.pointer = p;
  }
}

// ------------------------------------------------------------------- boot ---
setAuthor(localStorage.getItem('creo.author') || '');
loadPlace(localStorage.getItem('creo.place') || 'settlement');
if (!S.author) setTimeout(() => toast('Tap “add your name” at the top so the place can remember who changed what.'), 900);
requestAnimationFrame(frame);
addEventListener('resize', () => { S.dirty = true; });

// expose for the browser-side test harness (§29: the builder does not grade itself)
window.CREO = {
  S, saySomething, context,
  world: () => S.world,
  interpret: (t) => interpret(t, context()),
  plan: (t) => { const c = context(); return plan(S.world, interpret(t, c), c); },
  select: (ids) => { S.selection = new Set(ids); S.dirty = true; showTools(); },
  pointAt: (p) => { S.pointer = p; },
  draw: (pts, closed) => { S.stroke = pts; S.strokeClosed = closed; S.dirty = true; },
  commit: () => $('propCommit').click(),
  loadPlace,
};
